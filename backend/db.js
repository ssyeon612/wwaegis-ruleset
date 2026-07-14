import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "data");
const DB_PATH = path.join(DATA, "rule_mgnt.db");
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));


const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── 스키마 ───────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge (
    knowledge_id   TEXT PRIMARY KEY,
    document_type  TEXT,
    title TEXT, content TEXT,
    created_at TEXT, updated_at TEXT
  );

  -- 카테고리 마스터 : product·ruleset 이 공유하는 사전 등록값(snake_case) + 표시명(label)
  CREATE TABLE IF NOT EXISTS categories (
    category  TEXT PRIMARY KEY,   -- snake_case (예: isa, irp, common)
    label     TEXT               -- 표시명 (예: ISA, IRP, 공통)
  );

  -- 의미태그 마스터 : 코드(대문자·_) + 표시명(label). rule_tags 로 룰과 N:M
  CREATE TABLE IF NOT EXISTS tags (
    tag_code  TEXT PRIMARY KEY,   -- 예: CUST_TYPE
    label     TEXT               -- 표시명 (예: 전문·일반 투자자 구분 확인)
  );

  -- 판매원칙 마스터 : 금소법 6대 원칙 + 절차/사후. rules.sales_principle 이 참조
  CREATE TABLE IF NOT EXISTS principles (
    code     TEXT PRIMARY KEY,   -- 예: 적합성원칙
    article  TEXT                -- 근거 조문 (예: 제17조, 없으면 NULL)
  );

  -- 상품 마스터 : product_category(단일) 로 룰셋(=카테고리)과 매칭 (RS-2)
  --   룰셋은 상품이 아닌 '카테고리' 단위로 정의되며(카테고리 = 룰셋), 상품은 자기 카테고리만 보유하고
  --   RS-2 가 product_id → product_category → 해당 카테고리 룰로 변환한다.
  CREATE TABLE IF NOT EXISTS products (
    product_id       TEXT PRIMARY KEY,
    product_name     TEXT,
    product_category TEXT REFERENCES categories(category)  -- 단일 카테고리 (FK)
  );

  CREATE TABLE IF NOT EXISTS rules (
    rule_id             TEXT PRIMARY KEY,
    statement           TEXT,
    category            TEXT REFERENCES categories(category),  -- 소속 카테고리(=룰셋)
    sales_principle     TEXT REFERENCES principles(code),      -- 판매원칙 (FK) : 룰 분류 1축
    customer_condition      TEXT,
    violation_type      TEXT,
    knowledge_ids               TEXT,   -- JSON array of knowledge_id
    created_at          TEXT,
    updated_at          TEXT
  );

  -- 룰 ↔ 의미태그 (N:M 조인) : 매칭AI 가 대화↔Rule 매칭에 사용
  CREATE TABLE IF NOT EXISTS rule_tags (
    rule_id   TEXT REFERENCES rules(rule_id),
    tag_code  TEXT REFERENCES tags(tag_code),
    PRIMARY KEY (rule_id, tag_code)
  );
`);

// ── 시딩 (최초 1회) ───────────────────────────────────────
function seed() {
  const raw = read("seed.json");
  const tags = read("rule_tags.json");
  const products = read("products.json");
  const taxonomy = read("taxonomy.json");
  const principles = read("principles.json");

  const now = new Date().toISOString();
  const insP = db.prepare(`INSERT INTO knowledge
    (knowledge_id, document_type, title, content, created_at, updated_at)
    VALUES (@knowledge_id, @document_type, @title, @content, @created_at, @updated_at)`);
  const insProduct = db.prepare(`INSERT INTO products (product_id, product_name, product_category)
    VALUES (@product_id, @product_name, @product_category)`);
  const insTag = db.prepare(`INSERT OR IGNORE INTO tags (tag_code, label) VALUES (?, ?)`);
  const insRuleTag = db.prepare(`INSERT OR IGNORE INTO rule_tags (rule_id, tag_code) VALUES (?, ?)`);
  const insPrin = db.prepare(`INSERT OR IGNORE INTO principles (code, article) VALUES (?, ?)`);
  const insR = db.prepare(`INSERT INTO rules
    (rule_id, statement, category,
     sales_principle, customer_condition,
     violation_type, knowledge_ids, created_at, updated_at)
    VALUES
    (@rule_id, @statement, @category,
     @sales_principle, @customer_condition,
     @violation_type, @knowledge_ids, @created_at, @updated_at)`);

  const tx = db.transaction(() => {
    for (const p of Object.values(raw.knowledge)) insP.run({ ...p, created_at: now, updated_at: now });
    for (const pr of Object.values(products)) {
      if (pr.product_id) insProduct.run({ ...pr, product_category: pr.product_category || null });
    }
    // 태그 마스터 (taxonomy.json → tags)
    for (const [code, label] of Object.entries(taxonomy.semantic_tags || {})) insTag.run(code, label);
    // 판매원칙 마스터 (principles.json)
    for (const p of Object.values(principles)) if (p.code) insPrin.run(p.code, p.article ?? null);
    for (const r of raw.rules) {
      insR.run({
        ...r,
        sales_principle: r.sales_principle || null,
        knowledge_ids: JSON.stringify(r.knowledge_ids ?? []),
        created_at: now, updated_at: now,
      });
      // 룰 ↔ 태그 배정 (rule_tags.json)
      const code = (tags[r.rule_id] || {}).semantic_tag;
      if (code) { insTag.run(code, taxonomy.semantic_tags?.[code] || code); insRuleTag.run(r.rule_id, code); }
    }
  });
  tx();
  console.log(`[db] seeded: knowledge=${Object.keys(raw.knowledge).length}, rules=${raw.rules.length}, products=${Object.keys(products).filter((k) => !k.startsWith("_")).length}`);
}

// ── 기존 DB 마이그레이션 (컬럼 보강, 멱등) ────────────────
function ensureCols(table, defs) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, ddl] of defs) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}
// rules: 컬럼명 정비 (구명 → 신명, 멱등) — 데이터에 맞는 이름으로 통일
{
  const cols = new Set(db.prepare("PRAGMA table_info(rules)").all().map((c) => c.name));
  const RENAMES = [
    ["content", "statement"], ["principle", "sales_principle"], ["trigger_state", "sales_stage"],
    ["condition_type", "customer_condition"], ["required_tags", "semantic_tags"], ["basis", "knowledge_ids"],
  ];
  for (const [from, to] of RENAMES) if (cols.has(from) && !cols.has(to)) db.exec(`ALTER TABLE rules RENAME COLUMN ${from} TO ${to}`);
  // rule_seq 제거 (rule_id 숫자부와 중복) — 정렬·채번은 rule_id 기반
  if (new Set(db.prepare("PRAGMA table_info(rules)").all().map((c) => c.name)).has("rule_seq")) {
    db.exec("ALTER TABLE rules DROP COLUMN rule_seq");
  }
  // keywords 제거 (운영 매칭은 semantic_tags 담당, 시뮬레이터 폐기)
  if (new Set(db.prepare("PRAGMA table_info(rules)").all().map((c) => c.name)).has("keywords")) {
    db.exec("ALTER TABLE rules DROP COLUMN keywords");
  }
  // sales_stage 제거 (매칭·판정 미사용, 표시전용 분류축)
  if (new Set(db.prepare("PRAGMA table_info(rules)").all().map((c) => c.name)).has("sales_stage")) {
    db.exec("ALTER TABLE rules DROP COLUMN sales_stage");
  }
}
const tableExists = (t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t);
// created_at / updated_at 컬럼 보강 + 기존 행 백필 (멱등) — knowledge·rules 만 유지
const NOW = new Date().toISOString();
for (const table of ["knowledge", "rules"]) {
  ensureCols(table, [["created_at", "TEXT"], ["updated_at", "TEXT"]]);
  db.prepare(`UPDATE ${table} SET created_at = ? WHERE created_at IS NULL`).run(NOW);
  db.prepare(`UPDATE ${table} SET updated_at = ? WHERE updated_at IS NULL`).run(NOW);
}

// products: product_categories(배열) → product_category(단일) 정규화 (멱등)
{
  const cols = new Set(db.prepare("PRAGMA table_info(products)").all().map((c) => c.name));
  if (!cols.has("product_category")) {
    db.exec("ALTER TABLE products ADD COLUMN product_category TEXT");
    if (cols.has("product_categories")) {
      // 배열에서 '공통'을 제외한 첫 카테고리를 대표 카테고리로 승격
      for (const pr of db.prepare("SELECT product_id, product_categories FROM products").all()) {
        let cat = null;
        try { const arr = JSON.parse(pr.product_categories || "[]"); cat = arr.find((c) => c !== "공통") || arr[0] || null; } catch { /* noop */ }
        db.prepare("UPDATE products SET product_category = ? WHERE product_id = ?").run(cat, pr.product_id);
      }
    }
  }
  if (cols.has("product_categories")) db.exec("ALTER TABLE products DROP COLUMN product_categories");
}

// rulesets: ruleset_name 제거 (categories.label 에서 파생) — 멱등
{
  const cols = new Set(db.prepare("PRAGMA table_info(rulesets)").all().map((c) => c.name));
  if (cols.has("ruleset_name")) db.exec("ALTER TABLE rulesets DROP COLUMN ruleset_name");
}

// ── 카테고리 마스터 정규화 + FK 보강 (멱등) ───────────────
db.pragma("foreign_keys = OFF");
{
  // 1) categories 시드 (사전 등록값)
  const catData = read("categories.json");
  const insCat = db.prepare("INSERT OR IGNORE INTO categories (category, label) VALUES (@category, @label)");
  for (const c of Object.values(catData)) if (c.category) insCat.run({ category: c.category, label: c.label });

  // 2) 기존 카테고리 값 표준화 (대문자/한글 → snake_case)
  const MAP = { "ISA": "isa", "IRP": "irp", "공통": "common" };
  for (const [from, to] of Object.entries(MAP)) {
    db.prepare("UPDATE products SET product_category = ? WHERE product_category = ?").run(to, from);
    if (tableExists("rulesets")) db.prepare("UPDATE rulesets SET ruleset_category = ? WHERE ruleset_category = ?").run(to, from);
  }
  // 표준화 후에도 마스터에 없는 카테고리는 label=코드로 보강 (FK 위반 방지)
  const known = new Set(db.prepare("SELECT category FROM categories").all().map((r) => r.category));
  const used = new Set([
    ...db.prepare("SELECT DISTINCT product_category AS c FROM products WHERE product_category IS NOT NULL").all().map((r) => r.c),
    ...(tableExists("rulesets") ? db.prepare("SELECT DISTINCT ruleset_category AS c FROM rulesets WHERE ruleset_category IS NOT NULL").all().map((r) => r.c) : []),
  ]);
  for (const c of used) if (!known.has(c)) insCat.run({ category: c, label: c });

  // 3) products / rulesets 에 FK 없으면 테이블 재작성으로 추가
  const hasFk = (t) => db.prepare(`PRAGMA foreign_key_list(${t})`).all().length > 0;
  const rebuild = db.transaction((t, createSql) => {
    db.exec(createSql);
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).join(", ");
    db.exec(`INSERT INTO ${t}_new (${cols}) SELECT ${cols} FROM ${t};`);
    db.exec(`DROP TABLE ${t};`);
    db.exec(`ALTER TABLE ${t}_new RENAME TO ${t};`);
  });
  if (!hasFk("products")) rebuild("products", `CREATE TABLE products_new (
    product_id TEXT PRIMARY KEY, product_name TEXT,
    product_category TEXT REFERENCES categories(category),
    created_at TEXT, updated_at TEXT);`);

  // ── 태그 마스터(tags) 시드 + rules.semantic_tags → rule_tags 이관 (멱등) ──
  const taxonomy = read("taxonomy.json");
  const insTag = db.prepare("INSERT OR IGNORE INTO tags (tag_code, label) VALUES (?, ?)");
  for (const [code, label] of Object.entries(taxonomy.semantic_tags || {})) insTag.run(code, label);
  const rcols = new Set(db.prepare("PRAGMA table_info(rules)").all().map((c) => c.name));
  if (rcols.has("semantic_tags")) {
    const insRT = db.prepare("INSERT OR IGNORE INTO rule_tags (rule_id, tag_code) VALUES (?, ?)");
    for (const r of db.prepare("SELECT rule_id, semantic_tags FROM rules").all()) {
      let arr = []; try { arr = JSON.parse(r.semantic_tags || "[]"); } catch { /* noop */ }
      for (const code of arr) { insTag.run(code, taxonomy.semantic_tags?.[code] || code); insRT.run(r.rule_id, code); }
    }
    db.exec("ALTER TABLE rules DROP COLUMN semantic_tags");
  }

  // ── rulesets → categories 병합 : rules.ruleset_id → rules.category, rulesets 테이블 삭제 (멱등) ──
  //   (semantic_tags 이관 이후에 실행 — rules 재작성 시 semantic_tags 가 이미 정리된 상태)
  if (tableExists("rulesets")) {
    const map = {};
    for (const rs of db.prepare("SELECT ruleset_id, ruleset_category FROM rulesets").all()) map[rs.ruleset_id] = rs.ruleset_category;
    const rc = new Set(db.prepare("PRAGMA table_info(rules)").all().map((c) => c.name));
    if (rc.has("ruleset_id")) {
      if (!rc.has("category")) db.exec("ALTER TABLE rules ADD COLUMN category TEXT");
      for (const [rid, cat] of Object.entries(map)) db.prepare("UPDATE rules SET category = ? WHERE ruleset_id = ?").run(cat, rid);
      db.exec(`CREATE TABLE rules_new (
        rule_id TEXT PRIMARY KEY, statement TEXT,
        category TEXT REFERENCES categories(category),
        sales_principle TEXT, customer_condition TEXT, violation_type TEXT,
        knowledge_ids TEXT, created_at TEXT, updated_at TEXT)`);
      db.exec(`INSERT INTO rules_new (rule_id, statement, category, sales_principle, customer_condition, violation_type, knowledge_ids, created_at, updated_at)
               SELECT rule_id, statement, category, sales_principle, customer_condition, violation_type, knowledge_ids, created_at, updated_at FROM rules`);
      db.exec("DROP TABLE rules");
      db.exec("ALTER TABLE rules_new RENAME TO rules");
    }
    db.exec("DROP TABLE rulesets");
  }

  // ── principles 마스터 시드 + rules.sales_principle FK 보강 (멱등) ──
  const princData = read("principles.json");
  const insPrin = db.prepare("INSERT OR IGNORE INTO principles (code, article) VALUES (?, ?)");
  for (const p of Object.values(princData)) if (p.code) insPrin.run(p.code, p.article ?? null);
  // 마스터에 없는 기존 sales_principle 값 보강 (FK 위반 방지)
  for (const row of db.prepare("SELECT DISTINCT sales_principle AS c FROM rules WHERE sales_principle IS NOT NULL").all()) insPrin.run(row.c, null);
  // rules.sales_principle 에 FK 없으면 재작성으로 추가
  if (!db.prepare("PRAGMA foreign_key_list(rules)").all().some((f) => f.from === "sales_principle")) {
    db.exec(`CREATE TABLE rules_new2 (
      rule_id TEXT PRIMARY KEY, statement TEXT,
      category TEXT REFERENCES categories(category),
      sales_principle TEXT REFERENCES principles(code),
      customer_condition TEXT, violation_type TEXT,
      knowledge_ids TEXT, created_at TEXT, updated_at TEXT)`);
    db.exec(`INSERT INTO rules_new2 (rule_id, statement, category, sales_principle, customer_condition, violation_type, knowledge_ids, created_at, updated_at)
             SELECT rule_id, statement, category, sales_principle, customer_condition, violation_type, knowledge_ids, created_at, updated_at FROM rules`);
    db.exec("DROP TABLE rules");
    db.exec("ALTER TABLE rules_new2 RENAME TO rules");
  }
}
db.pragma("foreign_keys = ON");

// tags / rule_tags / products / categories : created_at·updated_at 제거 (테이블 재작성, 멱등)
//   (DROP COLUMN 은 스키마 주석과 충돌하므로 재작성으로 처리)
db.pragma("foreign_keys = OFF");
{
  const rebuildNoTs = db.transaction((t, createSql, cols) => {
    db.exec(createSql);
    db.exec(`INSERT INTO ${t}_new (${cols}) SELECT ${cols} FROM ${t};`);
    db.exec(`DROP TABLE ${t};`);
    db.exec(`ALTER TABLE ${t}_new RENAME TO ${t};`);
  });
  const specs = [
    ["categories", `CREATE TABLE categories_new (category TEXT PRIMARY KEY, label TEXT)`, "category, label"],
    ["tags", `CREATE TABLE tags_new (tag_code TEXT PRIMARY KEY, label TEXT)`, "tag_code, label"],
    ["products", `CREATE TABLE products_new (product_id TEXT PRIMARY KEY, product_name TEXT, product_category TEXT REFERENCES categories(category))`, "product_id, product_name, product_category"],
    ["rule_tags", `CREATE TABLE rule_tags_new (rule_id TEXT REFERENCES rules(rule_id), tag_code TEXT REFERENCES tags(tag_code), PRIMARY KEY (rule_id, tag_code))`, "rule_id, tag_code"],
  ];
  for (const [t, createSql, cols] of specs) {
    const has = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
    if (has.has("created_at") || has.has("updated_at")) rebuildNoTs(t, createSql, cols);
  }
}
db.pragma("foreign_keys = ON");

const { c: ruleCount } = db.prepare("SELECT COUNT(*) AS c FROM rules").get();
if (ruleCount === 0) seed();

export default db;
