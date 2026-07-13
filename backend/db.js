import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "data");
const DB_PATH = path.join(DATA, "rule_mgnt.db");
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));

// 근거 요지 자동 생성 (첫 문장, 최대 90자)
const gistOf = (text) => {
  const first = (text || "").split(/[.。]/)[0].trim();
  return first.length > 90 ? first.slice(0, 90) + "…" : (first || text || "");
};

// meta_category → 판매원칙(principle) 매핑 : 룰 분류 1축 (프론트 PRINCIPLES 키와 일치)
export const META_TO_PRINCIPLE = {
  "적합성원칙": "적합성원칙",
  "적정성원칙": "적정성원칙",
  "설명의무": "설명의무",
  "불공정영업금지": "불공정영업행위 금지",
  "부당권유금지": "부당권유행위 금지",
  "광고규제": "광고규제",
  "녹취": "판매절차(녹취·숙려)",
  "숙려제도": "판매절차(녹취·숙려)",
  "청약철회권": "소비자 권리",
  "위법계약해지권": "소비자 권리",
  "자료보관": "사후관리",
  "판매후확인콜": "사후관리",
  "고령자": "고령투자자 보호",
  "감점항목": "품질 평가(감점)",
  "비계량": "품질 평가(감점)",
};

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// ── 스키마 ───────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS provisions (
    provision_id   TEXT PRIMARY KEY,
    document_id    TEXT, document_type TEXT, e_id TEXT,
    heading TEXT, text TEXT,
    effective_from TEXT, effective_to TEXT,
    source_system TEXT, source_page TEXT,
    version        TEXT,  -- 조항 버전 (개정 시 증가)
    gist           TEXT   -- 근거 요지 (iTrix 판정 페이로드용 · 전문 대신 짧게)
  );

  -- 조항 버전 이력 (append-only) : 개정 전 스냅샷 보존
  CREATE TABLE IF NOT EXISTS provision_history (
    hist_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    provision_id   TEXT, version TEXT, heading TEXT, text TEXT,
    effective_from TEXT, note TEXT, archived_at TEXT
  );

  -- RuleSet 단위 (식별정보 + 버전 + 카테고리) : F2-3 / F3-3
  CREATE TABLE IF NOT EXISTS rulesets (
    ruleset_id       TEXT PRIMARY KEY,
    ruleset_name     TEXT,
    ruleset_version  TEXT,
    ruleset_category TEXT
  );

  -- 상품 마스터 : product_categories 로 룰셋 카테고리와 N:M 매칭 (F2-3)
  CREATE TABLE IF NOT EXISTS products (
    product_id         TEXT PRIMARY KEY,
    product_name       TEXT,
    product_categories TEXT   -- JSON array
  );

  CREATE TABLE IF NOT EXISTS rules (
    rule_id             TEXT PRIMARY KEY,
    rule_seq            INTEGER,
    parent_seq          TEXT,
    content             TEXT,
    product_type        TEXT,
    is_deduct           INTEGER,
    rule_version        TEXT,
    ruleset_id          TEXT,
    meta_title          TEXT,
    meta_category       TEXT,
    principle           TEXT,   -- 판매원칙 (6대 원칙 + 절차 카테고리) : 룰 분류 1축
    trigger_state       TEXT,
    condition_type      TEXT,
    keywords            TEXT,   -- JSON array (폴백)
    -- 매칭 메타 (ST/매칭AI 가 대화↔Rule 매칭에 사용) : 원칙 1
    required_tags       TEXT,   -- JSON array of 태그 코드 (매칭AI 표준 태그)
    speech_act          TEXT,   -- 발화행위 코드
    -- 판정 메타 (iTrix 배심원 패널) : 원칙 1 / F2-7
    jury_panel_id       TEXT,   -- 판정 패널 식별자
    threshold           INTEGER,-- 위반 인정 배심원 수(5 중)
    judge_prompt        TEXT,
    verification_method TEXT,
    violation_type      TEXT,
    basis               TEXT,   -- JSON array of provision_id
    review_status       TEXT,   -- ok | pending (근거 조항 개정 시 pending)
    review_note         TEXT
  );

  CREATE TABLE IF NOT EXISTS vocabulary (
    category TEXT, value TEXT, PRIMARY KEY (category, value)
  );

  -- 변경 이력 (append-only) : F4
  CREATE TABLE IF NOT EXISTS change_log (
    log_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT, entity_id TEXT, action TEXT,
    changes     TEXT,   -- JSON
    actor       TEXT, reason TEXT, at TEXT
  );
`);

// ── 시딩 (최초 1회) ───────────────────────────────────────
function seed() {
  const raw = read("seed.json");
  const tags = read("rule_tags.json");
  const rulesets = read("rulesets.json");
  const products = read("products.json");
  const DEFAULT_PANEL = "JURY_STD_5";
  const DEFAULT_THRESHOLD = 3;

  const insP = db.prepare(`INSERT INTO provisions
    (provision_id, document_id, document_type, e_id, heading, text, effective_from, effective_to, source_system, source_page, version, gist)
    VALUES (@provision_id, @document_id, @document_type, @e_id, @heading, @text, @effective_from, @effective_to, @source_system, @source_page, @version, @gist)`);
  const insRuleset = db.prepare(`INSERT INTO rulesets (ruleset_id, ruleset_name, ruleset_version, ruleset_category)
    VALUES (@ruleset_id, @ruleset_name, @ruleset_version, @ruleset_category)`);
  const insProduct = db.prepare(`INSERT INTO products (product_id, product_name, product_categories)
    VALUES (@product_id, @product_name, @product_categories)`);
  const insR = db.prepare(`INSERT INTO rules
    (rule_id, rule_seq, parent_seq, content, product_type, is_deduct, rule_version, ruleset_id,
     meta_title, meta_category, principle, trigger_state, condition_type, keywords, required_tags, speech_act,
     jury_panel_id, threshold, judge_prompt, verification_method, violation_type, basis, review_status, review_note)
    VALUES
    (@rule_id, @rule_seq, @parent_seq, @content, @product_type, @is_deduct, @rule_version, @ruleset_id,
     @meta_title, @meta_category, @principle, @trigger_state, @condition_type, @keywords, @required_tags, @speech_act,
     @jury_panel_id, @threshold, @judge_prompt, @verification_method, @violation_type, @basis, @review_status, @review_note)`);
  const insV = db.prepare(`INSERT INTO vocabulary (category, value) VALUES (?, ?)`);

  const tx = db.transaction(() => {
    for (const p of Object.values(raw.provisions)) insP.run({ ...p, version: p.version || "1.0", gist: p.gist || gistOf(p.text) });
    for (const rs of Object.values(rulesets)) insRuleset.run(rs);
    for (const pr of Object.values(products)) {
      if (pr.product_id) insProduct.run({ ...pr, product_categories: JSON.stringify(pr.product_categories || []) });
    }
    for (const r of raw.rules) {
      const t = tags[r.rule_id] || {};
      const reqTags = t.semantic_tag ? [t.semantic_tag] : [];
      insR.run({
        ...r,
        principle: r.principle || META_TO_PRINCIPLE[r.meta_category] || null,
        keywords: JSON.stringify(r.keywords ?? []),
        required_tags: JSON.stringify(reqTags),
        speech_act: t.speech_act || null,
        jury_panel_id: DEFAULT_PANEL,
        threshold: DEFAULT_THRESHOLD,
        basis: JSON.stringify(r.basis ?? []),
        review_status: "ok",
        review_note: null,
      });
    }
    for (const [category, values] of Object.entries(raw.vocabulary)) {
      for (const value of values) insV.run(category, value);
    }
  });
  tx();
  console.log(`[db] seeded: provisions=${Object.keys(raw.provisions).length}, rules=${raw.rules.length}, rulesets=${Object.keys(rulesets).length}, products=${Object.keys(products).filter((k) => !k.startsWith("_")).length}`);
}

// ── 기존 DB 마이그레이션 (컬럼 보강, 멱등) ────────────────
function ensureCols(table, defs) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, ddl] of defs) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}
ensureCols("provisions", [["version", "TEXT"], ["gist", "TEXT"]]);
ensureCols("rules", [["review_status", "TEXT"], ["review_note", "TEXT"], ["principle", "TEXT"]]);
db.prepare("UPDATE provisions SET version = '1.0' WHERE version IS NULL").run();
db.prepare("UPDATE rules SET review_status = 'ok' WHERE review_status IS NULL").run();
// principle 백필 : 기존 룰의 meta_category → 판매원칙 (룰 분류 1축)
for (const r of db.prepare("SELECT rule_id, meta_category FROM rules WHERE principle IS NULL").all())
  db.prepare("UPDATE rules SET principle = ? WHERE rule_id = ?").run(META_TO_PRINCIPLE[r.meta_category] || null, r.rule_id);
for (const p of db.prepare("SELECT provision_id, text FROM provisions WHERE gist IS NULL OR gist = ''").all())
  db.prepare("UPDATE provisions SET gist = ? WHERE provision_id = ?").run(gistOf(p.text), p.provision_id);

const { c: ruleCount } = db.prepare("SELECT COUNT(*) AS c FROM rules").get();
if (ruleCount === 0) seed();

export default db;
