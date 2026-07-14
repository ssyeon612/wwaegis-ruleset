import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import db from "./db.js";
import { buildGraph, toTurtle, toJsonLd, toCypher } from "./ontology.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAX_PATH = path.join(__dirname, "data", "taxonomy.json");
const TAXONOMY = JSON.parse(fs.readFileSync(TAX_PATH, "utf8"));
const saveTaxonomy = () => fs.writeFileSync(TAX_PATH, JSON.stringify(TAXONOMY, null, 2) + "\n", "utf8");

const app = express();
const PORT = process.env.PORT || 4000;
const MODULE_ID = "ruleset";

// 근거 요지 자동 생성 (첫 문장, 최대 90자)
const gistOf = (text) => {
  const first = (text || "").split(/[.。]/)[0].trim();
  return first.length > 90 ? first.slice(0, 90) + "…" : (first || text || "");
};

app.use(cors());
app.use(express.json());

// ── 표준 응답 봉투 (공통 §8 / FR §4.4) ──────────────────────
const ok = (extra = {}) => ({ module_id: MODULE_ID, responded_at: new Date().toISOString(), result: "success", ...extra });
const fail = (res, code, category, message) =>
  res.status(code).json({ module_id: MODULE_ID, responded_at: new Date().toISOString(), result: "error", error_category: category, error_message: message });

// keywords / knowledge_ids / semantic_tags(JSON) → 배열 복원
function parseRule(row) {
  if (!row) return row;
  return {
    ...row,
    keywords: JSON.parse(row.keywords || "[]"),
    semantic_tags: JSON.parse(row.semantic_tags || "[]"),
    knowledge_ids: JSON.parse(row.knowledge_ids || "[]"),
  };
}
// products 는 단일 product_category(문자열)만 보유 — 별도 파싱 불필요
const parseProduct = (row) => row;

// 룰셋 표시명은 카테고리 label 에서 파생 (저장하지 않음)
const categoryLabel = (cat) => db.prepare("SELECT label FROM categories WHERE category = ?").get(cat)?.label ?? cat;
const enrichRuleset = (row) => (row ? { ...row, ruleset_name: categoryLabel(row.ruleset_category) } : row);

// ══════════════════════════════════════════════════════════
// 관리 사용자 인터페이스 (§4.1·§4.2)
// ══════════════════════════════════════════════════════════
app.get("/api/knowledge", (_req, res) => {
  res.json(db.prepare("SELECT * FROM knowledge ORDER BY knowledge_id").all());
});

// 근거 조항 추가 (신규 생성) — knowledge_id 자동 부여 + 변경 이력 append
app.post("/api/knowledge", (req, res) => {
  const b = req.body || {};
  const title = (b.title || "").trim();
  const content = (b.content || "").trim();
  if (!title || !content) return fail(res, 400, "bad_request", "title and content are required");

  const { c } = db.prepare("SELECT COUNT(*) AS c FROM knowledge").get();
  let knowledge_id = (b.knowledge_id || `KN_${String(c + 1).padStart(3, "0")}`).trim();
  while (db.prepare("SELECT 1 FROM knowledge WHERE knowledge_id = ?").get(knowledge_id)) knowledge_id += "_x";

  const now = new Date().toISOString();
  const row = {
    knowledge_id,
    document_type: b.document_type || "내규",
    title, content,
    created_at: now, updated_at: now,
  };
  db.prepare(`INSERT INTO knowledge
    (knowledge_id, document_type, title, content, created_at, updated_at)
    VALUES (@knowledge_id, @document_type, @title, @content, @created_at, @updated_at)`).run(row);

  res.status(201).json(row);
});

// 근거 조항 직접 수정 — 제목·원문·출처(문서유형/문서명) in-place (버전업 없음)
const KNOWLEDGE_EDITABLE = ["title", "content", "document_type"];
app.put("/api/knowledge/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM knowledge WHERE knowledge_id = ?").get(req.params.id);
  if (!existing) return fail(res, 404, "not_found", "knowledge not found");

  const b = req.body || {};
  const patch = {};
  for (const key of KNOWLEDGE_EDITABLE) {
    if (key in b) patch[key] = typeof b[key] === "string" ? b[key].trim() : b[key];
  }
  if ("content" in patch && !patch.content) return fail(res, 400, "bad_request", "content cannot be empty");
  if ("title" in patch && !patch.title) return fail(res, 400, "bad_request", "title cannot be empty");
  if (Object.keys(patch).length === 0) return fail(res, 400, "bad_request", "no editable fields provided");
  patch.updated_at = new Date().toISOString();

  const setClause = Object.keys(patch).map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE knowledge SET ${setClause} WHERE knowledge_id = @knowledge_id`).run({ ...patch, knowledge_id: req.params.id });

  res.json(db.prepare("SELECT * FROM knowledge WHERE knowledge_id = ?").get(req.params.id));
});

// 근거 조항 삭제 — 이 조항을 근거(knowledge_ids)로 쓰는 룰이 있으면 차단
app.delete("/api/knowledge/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM knowledge WHERE knowledge_id = ?").get(req.params.id);
  if (!existing) return fail(res, 404, "not_found", "knowledge not found");

  const refs = db.prepare("SELECT knowledge_ids FROM rules").all()
    .filter((r) => { try { return JSON.parse(r.knowledge_ids || "[]").includes(req.params.id); } catch { return false; } });
  if (refs.length) return fail(res, 409, "conflict", `이 조항을 근거로 사용하는 룰이 ${refs.length}건 있어 삭제할 수 없습니다`);

  db.prepare("DELETE FROM knowledge WHERE knowledge_id = ?").run(req.params.id);
  res.json(ok({ deleted: req.params.id }));
});

app.get("/api/rules", (_req, res) => {
  res.json(db.prepare("SELECT * FROM rules ORDER BY rule_seq").all().map(parseRule));
});

app.get("/api/rules/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM rules WHERE rule_id = ?").get(req.params.id);
  if (!row) return fail(res, 404, "not_found", "rule not found");
  res.json(parseRule(row));
});

// 룰 추가 (신규 생성) — rule_id / rule_seq 자동 부여 + 변경 이력 append
app.post("/api/rules", (req, res) => {
  const b = req.body || {};
  const statement = (b.statement || "").trim();
  if (!statement) return fail(res, 400, "bad_request", "statement is required");

  const { m } = db.prepare("SELECT COALESCE(MAX(rule_seq), 0) AS m FROM rules").get();
  const rule_seq = m + 1;
  let rule_id = (b.rule_id || `RULE_${String(rule_seq).padStart(3, "0")}`).trim();
  while (db.prepare("SELECT 1 FROM rules WHERE rule_id = ?").get(rule_id)) rule_id += "_x";

  const arr = (v) => JSON.stringify(Array.isArray(v) ? v : []);
  const now = new Date().toISOString();
  const row = {
    rule_id, rule_seq,
    statement,
    ruleset_id: b.ruleset_id || null,
    sales_principle: b.sales_principle || null,
    sales_stage: b.sales_stage || null,
    customer_condition: b.customer_condition || null,
    keywords: arr(b.keywords),
    semantic_tags: arr(b.semantic_tags),
    violation_type: b.violation_type || null,
    knowledge_ids: arr(b.knowledge_ids),
    created_at: now, updated_at: now,
  };

  db.prepare(`INSERT INTO rules
    (rule_id, rule_seq, statement, ruleset_id,
     sales_principle, sales_stage, customer_condition, keywords, semantic_tags,
     violation_type, knowledge_ids, created_at, updated_at)
    VALUES
    (@rule_id, @rule_seq, @statement, @ruleset_id,
     @sales_principle, @sales_stage, @customer_condition, @keywords, @semantic_tags,
     @violation_type, @knowledge_ids, @created_at, @updated_at)`).run(row);

  res.status(201).json(parseRule(db.prepare("SELECT * FROM rules WHERE rule_id = ?").get(rule_id)));
});

// 룰 수정 + 변경 이력 append (F4)
const EDITABLE = ["statement", "sales_principle", "sales_stage", "customer_condition", "violation_type", "semantic_tags", "knowledge_ids"];
const JSON_FIELDS = new Set(["semantic_tags", "knowledge_ids"]);
app.put("/api/rules/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM rules WHERE rule_id = ?").get(req.params.id);
  if (!existing) return fail(res, 404, "not_found", "rule not found");

  const patch = {};
  for (const key of EDITABLE) {
    if (key in req.body) patch[key] = JSON_FIELDS.has(key) ? JSON.stringify(req.body[key] || []) : req.body[key];
  }
  if (Object.keys(patch).length === 0) return fail(res, 400, "bad_request", "no editable fields provided");
  patch.updated_at = new Date().toISOString();

  const setClause = Object.keys(patch).map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE rules SET ${setClause} WHERE rule_id = @rule_id`).run({ ...patch, rule_id: req.params.id });

  res.json(parseRule(db.prepare("SELECT * FROM rules WHERE rule_id = ?").get(req.params.id)));
});

// 룰 삭제 + 변경 이력 append
app.delete("/api/rules/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM rules WHERE rule_id = ?").get(req.params.id);
  if (!existing) return fail(res, 404, "not_found", "rule not found");

  db.prepare("DELETE FROM rules WHERE rule_id = ?").run(req.params.id);
  res.json(ok({ deleted: req.params.id }));
});



app.get("/api/taxonomy", (_req, res) => res.json(TAXONOMY));

// ── 의미태그(semantic_tags) 추가/수정/삭제 — taxonomy.json 영속화 ──
const tagUsage = (code) => db.prepare("SELECT semantic_tags FROM rules").all()
  .filter((r) => { try { return JSON.parse(r.semantic_tags || "[]").includes(code); } catch { return false; } }).length;

app.post("/api/taxonomy/tags", (req, res) => {
  const code = (req.body?.code || "").trim();
  const label = (req.body?.label || "").trim();
  if (!code || !label) return fail(res, 400, "bad_request", "code and label are required");
  if (!/^[A-Za-z0-9_]+$/.test(code)) return fail(res, 400, "bad_request", "코드는 영문/숫자/_ 만 사용할 수 있습니다");
  TAXONOMY.semantic_tags = TAXONOMY.semantic_tags || {};
  if (TAXONOMY.semantic_tags[code]) return fail(res, 409, "conflict", "이미 존재하는 태그 코드입니다");
  TAXONOMY.semantic_tags[code] = label;
  saveTaxonomy();
  res.status(201).json(ok({ code, label }));
});

app.put("/api/taxonomy/tags/:code", (req, res) => {
  const code = req.params.code;
  const label = (req.body?.label || "").trim();
  if (!TAXONOMY.semantic_tags?.[code]) return fail(res, 404, "not_found", "tag not found");
  if (!label) return fail(res, 400, "bad_request", "label is required");
  TAXONOMY.semantic_tags[code] = label;
  saveTaxonomy();
  res.json(ok({ code, label }));
});

app.delete("/api/taxonomy/tags/:code", (req, res) => {
  const code = req.params.code;
  if (!TAXONOMY.semantic_tags?.[code]) return fail(res, 404, "not_found", "tag not found");
  const used = tagUsage(code);
  if (used) return fail(res, 409, "conflict", `이 태그를 사용하는 룰이 ${used}건 있어 삭제할 수 없습니다`);
  delete TAXONOMY.semantic_tags[code];
  saveTaxonomy();
  res.json(ok({ deleted: code }));
});

app.get("/api/products", (_req, res) => {
  res.json(db.prepare("SELECT * FROM products ORDER BY product_id").all().map(parseProduct));
});

// 카테고리 마스터 — product·ruleset 이 공유하는 사전 등록값(+ 표시명)
app.get("/api/categories", (_req, res) => {
  res.json(db.prepare("SELECT * FROM categories ORDER BY category").all());
});


// ══════════════════════════════════════════════════════════
// ST 모듈 인터페이스 (§4.3·§4.4 · RS-1 / RS-2 / RS-3)
// ══════════════════════════════════════════════════════════

// RS-1 listRuleSets — RuleSet 식별정보 목록 (옵션 category 필터)
app.get("/api/rulesets", (req, res) => {
  const { ruleset_category } = req.query;
  let rows = db.prepare("SELECT * FROM rulesets ORDER BY ruleset_id").all();
  if (ruleset_category) rows = rows.filter((r) => r.ruleset_category === ruleset_category);
  res.json(ok({ ruleset_identities: rows.map(enrichRuleset) }));
});

// 룰셋 신규 생성 (새 상품 룰 배정 대비) — 표시명은 카테고리 label 에서 파생
app.post("/api/rulesets", (req, res) => {
  const b = req.body || {};
  const category = (b.ruleset_category || "").trim();
  if (!category) return fail(res, 400, "bad_request", "ruleset_category is required");
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM rulesets").get();
  let id = (b.ruleset_id || `RSET_${String(c + 1).padStart(3, "0")}`).trim();
  while (db.prepare("SELECT 1 FROM rulesets WHERE ruleset_id = ?").get(id)) id += "_x";
  const now = new Date().toISOString();
  const row = { ruleset_id: id, ruleset_category: category, created_at: now, updated_at: now };
  db.prepare("INSERT INTO rulesets (ruleset_id, ruleset_category, created_at, updated_at) VALUES (@ruleset_id, @ruleset_category, @created_at, @updated_at)").run(row);
  res.status(201).json(enrichRuleset(row));
});

// 룰 일괄 임포트 (파일 파싱 결과) — 기존/신규 룰셋에 배정 + 트랜잭션 삽입
app.post("/api/rules/import", (req, res) => {
  const b = req.body || {};
  const incoming = Array.isArray(b.rules) ? b.rules : [];
  if (!incoming.length) return fail(res, 400, "bad_request", "no rules to import");

  // 룰셋 결정 (신규 생성 or 기존 지정)
  let ruleset_id = (b.ruleset_id || "").trim() || null;
  let createdRuleset = null;
  if (b.new_ruleset) {
    const category = (b.new_ruleset.ruleset_category || "").trim();
    if (!category) return fail(res, 400, "bad_request", "new_ruleset requires ruleset_category");
    const { c } = db.prepare("SELECT COUNT(*) AS c FROM rulesets").get();
    ruleset_id = `RSET_${String(c + 1).padStart(3, "0")}`;
    while (db.prepare("SELECT 1 FROM rulesets WHERE ruleset_id = ?").get(ruleset_id)) ruleset_id += "_x";
    createdRuleset = { ruleset_id, ruleset_category: category };
  } else if (ruleset_id && !db.prepare("SELECT 1 FROM rulesets WHERE ruleset_id = ?").get(ruleset_id)) {
    return fail(res, 400, "bad_request", `unknown ruleset_id: ${ruleset_id}`);
  }

  const arr = (v) => JSON.stringify(Array.isArray(v) ? v : []);
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO rules
    (rule_id, rule_seq, statement, ruleset_id,
     sales_principle, sales_stage, customer_condition, keywords, semantic_tags,
     violation_type, knowledge_ids, created_at, updated_at)
    VALUES
    (@rule_id, @rule_seq, @statement, @ruleset_id,
     @sales_principle, @sales_stage, @customer_condition, @keywords, @semantic_tags,
     @violation_type, @knowledge_ids, @created_at, @updated_at)`);

  const created = [];
  let skipped = 0;
  db.transaction(() => {
    if (createdRuleset) db.prepare("INSERT INTO rulesets (ruleset_id, ruleset_category, created_at, updated_at) VALUES (@ruleset_id, @ruleset_category, @created_at, @updated_at)").run({ ...createdRuleset, created_at: now, updated_at: now });
    let { m } = db.prepare("SELECT COALESCE(MAX(rule_seq), 0) AS m FROM rules").get();
    for (const r of incoming) {
      const statement = (r.statement || "").trim();
      if (!statement) { skipped++; continue; }
      m += 1;
      let rule_id = `RULE_${String(m).padStart(3, "0")}`;
      while (db.prepare("SELECT 1 FROM rules WHERE rule_id = ?").get(rule_id)) rule_id += "_x";
      ins.run({
        rule_id, rule_seq: m, statement,
        ruleset_id,
        sales_principle: r.sales_principle || null,
        sales_stage: r.sales_stage || null,
        customer_condition: r.customer_condition || "모든 고객",
        keywords: arr(r.keywords),
        semantic_tags: arr(r.semantic_tags),
        violation_type: r.violation_type || "누락형",
        knowledge_ids: arr(r.knowledge_ids),
        created_at: now, updated_at: now,
      });
      created.push(rule_id);
    }
  })();

  res.json(ok({ ruleset_id, created_ruleset: createdRuleset, created: created.length, created_ids: created, skipped }));
});

// RS-2 loadRuleSet — 상품 식별자로 룰셋 "본문 전체" 로드 (세션 시작 1회, 고정)
//   product_id → 카테고리 매칭(N:M) 룰셋 전체를 반환. 매칭은 ST(매칭AI)가 이 본문 안에서 수행.
//   각 룰은 iTrix 판정 페이로드(judge_payload)와 그 크기(judge_chars)를 함께 담는다.
//   2000자 예산은 "룰 판정정보 + 대화" 단위 → judge_chars 가 RULE_LIMIT(=2000-대화여유) 이하인지 검증.
const JUDGE_BUDGET = 2000;         // iTrix 판정 입력(룰 판정정보 + 대화) 예산
const DIALOGUE_RESERVE = 500;      // 대화 여유분
const RULE_LIMIT = JUDGE_BUDGET - DIALOGUE_RESERVE; // 룰 판정정보 상한 = 1500

// 룰북 그룹 기준 — 6대 판매원칙(금소법) + 사후관리·절차 세분 — 근거 조항으로 매핑
const PRINCIPLES = [
  { key: "적합성원칙", art: "제17조", test: /art_17/ },
  { key: "적정성원칙", art: "제18조", test: /art_18/ },
  { key: "설명의무", art: "제19조", test: /art_19/ },
  { key: "불공정영업행위 금지", art: "제20조", test: /art_20/ },
  { key: "부당권유행위 금지", art: "제21조", test: /art_21/ },
  { key: "광고규제", art: "제22조", test: /art_22/ },
  { key: "판매절차(녹취·숙려)", art: null, test: /대면녹취|art_44|숙려제도/ },
  { key: "소비자 권리", art: null, test: /art_46|청약철회|art_47|위법계약해지|art_28/ },
  { key: "고령투자자 보호", art: null, test: /고령자/ },
  { key: "사후관리", art: null, test: /해피콜|자료보관/ },
  { key: "품질 평가(감점)", art: null, test: /모니터링기준/ },
];
const principleOf = (basisIds) => {
  const b = (basisIds || []).join(" ");
  const hit = PRINCIPLES.find((p) => p.test.test(b));
  return hit ? { code: hit.key, article: hit.art } : { code: "기타", article: null };
};

function buildJudge(r, knowledgeFull) {
  const basisIds = JSON.parse(r.knowledge_ids || "[]");
  const basisItems = basisIds.map((pid) => knowledgeFull[pid]).filter(Boolean);
  const sales_principle = principleOf(basisIds);
  const basisView = basisItems.map((p) => ({ document_type: p.document_type, title: p.title, gist: gistOf(p.content) }));
  // ST 가 iTrix 에 넘길 "룰 판정정보" (대화는 ST가 붙임)
  const judge_payload =
    `[체크] ${r.statement}\n` +
    `[근거] ${basisView.map((b) => `${b.title}: ${b.gist}`).join(" / ")}`;
  return { basisView, judge_payload, sales_principle };
}

app.get("/api/ruleset/load", (req, res) => {
  const { product_id } = req.query;
  if (!product_id) return fail(res, 400, "bad_request", "product_id is required");

  // ST 가 매칭한 의미태그(선택) — 넘어오면 해당 태그를 요구하는 룰만 필터링
  const reqTags = String(req.query.tags || "").split(",").map((t) => t.trim()).filter(Boolean);

  const product = db.prepare("SELECT * FROM products WHERE product_id = ?").get(product_id);
  if (!product) return fail(res, 404, "not_found", `unknown product_id: ${product_id}`);

  // RS-2 : product_id → product_category → 해당 카테고리의 룰셋 선택
  //   룰셋은 카테고리 단위로 정의(상품 정보 미포함). 공통(common) 룰셋은 전 상품 공통 base 로 항상 병합.
  const category = product.product_category;
  const COMMON_CATEGORY = "common";
  const allRulesets = db.prepare("SELECT * FROM rulesets").all();
  const categoryRuleset = allRulesets.find((rs) => rs.ruleset_category === category) || null;
  const commonRuleset = allRulesets.find((rs) => rs.ruleset_category === COMMON_CATEGORY) || null;
  // 적용 룰셋 = 공통(base) + 상품 카테고리 전용
  const appliedRulesets = [commonRuleset, categoryRuleset].filter(Boolean);
  const rsIds = appliedRulesets.map((rs) => rs.ruleset_id);
  const version = "1.0.0";
  // 반환 식별정보 : 상품의 카테고리 룰셋 (상품 식별자·상품명 미포함)
  const identitySrc = categoryRuleset || commonRuleset;
  const ruleset_identity = identitySrc
    ? { ruleset_id: identitySrc.ruleset_id, ruleset_name: categoryLabel(category), ruleset_category: category, version }
    : { ruleset_id: null, ruleset_name: categoryLabel(category), ruleset_category: category, version };
  const knowledgeFull = Object.fromEntries(db.prepare("SELECT * FROM knowledge").all().map((p) => [p.knowledge_id, p]));

  const allRows = db.prepare("SELECT * FROM rules ORDER BY rule_seq").all().filter((r) => rsIds.includes(r.ruleset_id));
  const totalInRuleset = allRows.length;
  const rows = reqTags.length
    ? allRows.filter((r) => JSON.parse(r.semantic_tags || "[]").some((t) => reqTags.includes(t)))
    : allRows;
  // 조항(근거 법령) 원문 뷰 — iTrix 위반 판정용
  const knowledgeOf = (r) =>
    JSON.parse(r.knowledge_ids || "[]").map((pid) => knowledgeFull[pid]).filter(Boolean)
      .map((p) => ({ knowledge_id: p.knowledge_id, document_type: p.document_type, title: p.title, content: p.content }));

  const rules = rows.map((r) => {
    const { basisView, judge_payload, sales_principle } = buildJudge(r, knowledgeFull);
    const judge_chars = judge_payload.length;
    const ruleTags = JSON.parse(r.semantic_tags || "[]");
    return {
      id: r.rule_id.replace(/^RULE_/, ""),
      rule_id: r.rule_id,
      statement: r.statement,
      // 6대 판매원칙 (근거 조항 기준)
      sales_principle: sales_principle.code,
      principle_article: sales_principle.article,
      sales_stage: r.sales_stage,
      customer_condition: r.customer_condition,
      violation_type: r.violation_type,
      is_deduct: r.violation_type === "감점형" ? 1 : 0,
      // 매칭 메타 (ST 가 대화↔Rule 매칭에 사용)
      semantic_tags: ruleTags,
      matched_tags: reqTags.length ? ruleTags.filter((t) => reqTags.includes(t)) : [],
      basis: basisView, // 근거 요지 뷰 (document_type·title·gist)
      knowledge: knowledgeOf(r), // 조항 (근거 법령 원문) — ST 실제 응답 페이로드용
      // iTrix 판정 페이로드 + 크기 검증 (2000자 = 룰 판정정보 + 대화)
      judge_payload,
      judge_chars,
      within_budget: judge_chars <= RULE_LIMIT,
    };
  });
  const over = rules.filter((r) => !r.within_budget);

  res.json(ok({
    ruleset_identity,
    product_id: product.product_id,
    product_name: product.product_name,
    product_category: category,
    ruleset_ids: rsIds, version,
    requested_tags: reqTags,
    total_in_ruleset: totalInRuleset,
    count: rules.length,
    budget: { total: JUDGE_BUDGET, dialogue_reserve: DIALOGUE_RESERVE, rule_limit: RULE_LIMIT},
    over_budget: over.length,
    over_budget_ids: over.map((r) => r.id),
    rules,
  }));
});

// 온톨로지 — 지식그래프 (노드/엣지) + deontic 양상
app.get("/api/ontology/graph", (_req, res) => {
  res.json(buildGraph(db, TAXONOMY));
});

// 온톨로지 내보내기 — RDF Turtle / JSON-LD / Neo4j Cypher
app.get("/api/ontology/export", (req, res) => {
  const graph = buildGraph(db, TAXONOMY);
  if (req.query.format === "jsonld") return res.json(toJsonLd(graph));
  if (req.query.format === "cypher") return res.type("text/plain").send(toCypher(graph));
  res.type("text/turtle").send(toTurtle(graph));
});

// RS-3 health_check — 표준 상태 체크 응답
app.get("/api/health", (_req, res) => {
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM rules").get();
  res.json(ok({ status: c > 0 ? "healthy" : "degraded", rules: c }));
});

// ── 프로덕션: 빌드된 프론트엔드(dist) 동일 오리진 서빙 ──────
const DIST = path.join(__dirname, "..", "frontend", "dist");
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  // SPA 폴백 (API 경로 제외)
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(DIST, "index.html"));
  });
  console.log(`[server] serving frontend from ${DIST}`);
}

app.listen(PORT, () => {
  console.log(`[server] rule_mgnt (RuleSet) API listening on http://localhost:${PORT}`);
});
