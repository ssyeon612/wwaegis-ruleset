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

// knowledge_ids(JSON) → 배열, semantic_tags 는 rule_tags 조인에서 파생
const tagsOfRule = (rule_id) => db.prepare("SELECT tag_code FROM rule_tags WHERE rule_id = ? ORDER BY tag_code").all(rule_id).map((r) => r.tag_code);
const allRuleTagsMap = () => {
  const m = {};
  for (const rt of db.prepare("SELECT rule_id, tag_code FROM rule_tags").all()) (m[rt.rule_id] ??= []).push(rt.tag_code);
  return m;
};
// 태그 마스터 (tag_code → label)
const tagsMasterMap = () => Object.fromEntries(db.prepare("SELECT tag_code, label FROM tags ORDER BY tag_code").all().map((t) => [t.tag_code, t.label]));
// 룰의 태그 배정 교체 — 마스터(tags)에 없는 코드는 무시
const setRuleTags = (rule_id, codes) => {
  db.prepare("DELETE FROM rule_tags WHERE rule_id = ?").run(rule_id);
  const ins = db.prepare("INSERT OR IGNORE INTO rule_tags (rule_id, tag_code) VALUES (?, ?)");
  for (const code of (Array.isArray(codes) ? codes : [])) {
    if (db.prepare("SELECT 1 FROM tags WHERE tag_code = ?").get(code)) ins.run(rule_id, code);
  }
};

function parseRule(row) {
  if (!row) return row;
  return {
    ...row,
    knowledge_ids: JSON.parse(row.knowledge_ids || "[]"),
    semantic_tags: tagsOfRule(row.rule_id),
  };
}
// products 는 단일 product_category(문자열)만 보유 — 별도 파싱 불필요
const parseProduct = (row) => row;

// 룰셋 = 카테고리. 룰셋 식별정보는 카테고리에서 파생 (별도 rulesets 테이블 없음)
const categoryLabel = (cat) => db.prepare("SELECT label FROM categories WHERE category = ?").get(cat)?.label ?? cat;
const rulesetIdentityOf = (category) => ({ ruleset_id: category, ruleset_category: category, ruleset_name: categoryLabel(category) });

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
  res.json(db.prepare("SELECT * FROM rules ORDER BY rule_id").all().map(parseRule));
});

app.get("/api/rules/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM rules WHERE rule_id = ?").get(req.params.id);
  if (!row) return fail(res, 404, "not_found", "rule not found");
  res.json(parseRule(row));
});

// 룰 추가 (신규 생성) — rule_id 자동 부여 (기존 최대 번호 +1)
app.post("/api/rules", (req, res) => {
  const b = req.body || {};
  const statement = (b.statement || "").trim();
  if (!statement) return fail(res, 400, "bad_request", "statement is required");

  const { m } = db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(rule_id, 6) AS INTEGER)), 0) AS m FROM rules").get();
  let rule_id = (b.rule_id || `RULE_${String(m + 1).padStart(3, "0")}`).trim();
  while (db.prepare("SELECT 1 FROM rules WHERE rule_id = ?").get(rule_id)) rule_id += "_x";

  const arr = (v) => JSON.stringify(Array.isArray(v) ? v : []);
  const now = new Date().toISOString();
  const row = {
    rule_id,
    statement,
    category: b.category || b.ruleset_id || null,
    sales_principle: b.sales_principle || null,
    customer_condition: b.customer_condition || null,
    violation_type: b.violation_type || null,
    knowledge_ids: arr(b.knowledge_ids),
    created_at: now, updated_at: now,
  };

  db.prepare(`INSERT INTO rules
    (rule_id, statement, category,
     sales_principle, customer_condition,
     violation_type, knowledge_ids, created_at, updated_at)
    VALUES
    (@rule_id, @statement, @category,
     @sales_principle, @customer_condition,
     @violation_type, @knowledge_ids, @created_at, @updated_at)`).run(row);
  setRuleTags(rule_id, b.semantic_tags);

  res.status(201).json(parseRule(db.prepare("SELECT * FROM rules WHERE rule_id = ?").get(rule_id)));
});

// 룰 수정 + 변경 이력 append (F4)
// semantic_tags 는 rule_tags 조인으로 별도 처리 (컬럼 아님)
const EDITABLE = ["statement", "sales_principle", "customer_condition", "violation_type", "knowledge_ids"];
const JSON_FIELDS = new Set(["knowledge_ids"]);
app.put("/api/rules/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM rules WHERE rule_id = ?").get(req.params.id);
  if (!existing) return fail(res, 404, "not_found", "rule not found");

  const patch = {};
  for (const key of EDITABLE) {
    if (key in req.body) patch[key] = JSON_FIELDS.has(key) ? JSON.stringify(req.body[key] || []) : req.body[key];
  }
  const hasTags = "semantic_tags" in req.body;
  if (Object.keys(patch).length === 0 && !hasTags) return fail(res, 400, "bad_request", "no editable fields provided");
  patch.updated_at = new Date().toISOString();

  const setClause = Object.keys(patch).map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE rules SET ${setClause} WHERE rule_id = @rule_id`).run({ ...patch, rule_id: req.params.id });
  if (hasTags) setRuleTags(req.params.id, req.body.semantic_tags);

  res.json(parseRule(db.prepare("SELECT * FROM rules WHERE rule_id = ?").get(req.params.id)));
});

// 룰 삭제 — 태그 배정(rule_tags) 먼저 정리 후 룰 삭제
app.delete("/api/rules/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM rules WHERE rule_id = ?").get(req.params.id);
  if (!existing) return fail(res, 404, "not_found", "rule not found");

  db.prepare("DELETE FROM rule_tags WHERE rule_id = ?").run(req.params.id);
  db.prepare("DELETE FROM rules WHERE rule_id = ?").run(req.params.id);
  res.json(ok({ deleted: req.params.id }));
});



// semantic_tags 는 tags 테이블에서, 나머지(speech_acts 등)는 파일에서
app.get("/api/taxonomy", (_req, res) => res.json({ ...TAXONOMY, semantic_tags: tagsMasterMap() }));

// ── 의미태그 추가/수정/삭제 — tags 테이블 영속화 ──
const tagUsage = (code) => db.prepare("SELECT COUNT(*) AS c FROM rule_tags WHERE tag_code = ?").get(code).c;

app.post("/api/taxonomy/tags", (req, res) => {
  const code = (req.body?.code || "").trim();
  const label = (req.body?.label || "").trim();
  if (!code || !label) return fail(res, 400, "bad_request", "code and label are required");
  if (!/^[A-Za-z0-9_]+$/.test(code)) return fail(res, 400, "bad_request", "코드는 영문/숫자/_ 만 사용할 수 있습니다");
  if (db.prepare("SELECT 1 FROM tags WHERE tag_code = ?").get(code)) return fail(res, 409, "conflict", "이미 존재하는 태그 코드입니다");
  db.prepare("INSERT INTO tags (tag_code, label) VALUES (?, ?)").run(code, label);
  res.status(201).json(ok({ code, label }));
});

app.put("/api/taxonomy/tags/:code", (req, res) => {
  const code = req.params.code;
  const label = (req.body?.label || "").trim();
  if (!db.prepare("SELECT 1 FROM tags WHERE tag_code = ?").get(code)) return fail(res, 404, "not_found", "tag not found");
  if (!label) return fail(res, 400, "bad_request", "label is required");
  db.prepare("UPDATE tags SET label = ? WHERE tag_code = ?").run(label, code);
  res.json(ok({ code, label }));
});

app.delete("/api/taxonomy/tags/:code", (req, res) => {
  const code = req.params.code;
  if (!db.prepare("SELECT 1 FROM tags WHERE tag_code = ?").get(code)) return fail(res, 404, "not_found", "tag not found");
  const used = tagUsage(code);
  if (used) return fail(res, 409, "conflict", `이 태그를 사용하는 룰이 ${used}건 있어 삭제할 수 없습니다`);
  db.prepare("DELETE FROM tags WHERE tag_code = ?").run(code);
  res.json(ok({ deleted: code }));
});

app.get("/api/products", (_req, res) => {
  res.json(db.prepare("SELECT * FROM products ORDER BY product_id").all().map(parseProduct));
});

// 카테고리 마스터 — product·ruleset 이 공유하는 사전 등록값(+ 표시명)
app.get("/api/categories", (_req, res) => {
  res.json(db.prepare("SELECT * FROM categories ORDER BY category").all());
});

// 판매원칙 마스터 — code + 근거 조문(article)
app.get("/api/principles", (_req, res) => {
  res.json(db.prepare("SELECT * FROM principles ORDER BY code").all());
});


// ══════════════════════════════════════════════════════════
// ST 모듈 인터페이스 (§4.3·§4.4 · RS-1 / RS-2 / RS-3)
// ══════════════════════════════════════════════════════════

// RS-1 listRuleSets — RuleSet(=카테고리) 식별정보 목록 (옵션 category 필터)
app.get("/api/rulesets", (req, res) => {
  const { ruleset_category } = req.query;
  let rows = db.prepare("SELECT category FROM categories ORDER BY category").all().map((c) => rulesetIdentityOf(c.category));
  if (ruleset_category) rows = rows.filter((r) => r.ruleset_category === ruleset_category);
  res.json(ok({ ruleset_identities: rows }));
});

// 룰셋 신규 생성 = 카테고리 등록 (룰셋은 카테고리 단위)
app.post("/api/rulesets", (req, res) => {
  const b = req.body || {};
  const category = (b.ruleset_category || "").trim();
  if (!category) return fail(res, 400, "bad_request", "ruleset_category is required");
  if (db.prepare("SELECT 1 FROM categories WHERE category = ?").get(category)) return fail(res, 409, "conflict", "이미 존재하는 카테고리입니다");
  db.prepare("INSERT INTO categories (category, label) VALUES (?, ?)").run(category, (b.label || category).trim());
  res.status(201).json(rulesetIdentityOf(category));
});

// 룰 일괄 임포트 (파일 파싱 결과) — 기존/신규 룰셋에 배정 + 트랜잭션 삽입
app.post("/api/rules/import", (req, res) => {
  const b = req.body || {};
  const incoming = Array.isArray(b.rules) ? b.rules : [];
  if (!incoming.length) return fail(res, 400, "bad_request", "no rules to import");

  // 대상 카테고리(=룰셋) 결정 : 신규 등록 or 기존 지정
  let category = null;
  if (b.new_ruleset) {
    category = (b.new_ruleset.ruleset_category || "").trim();
    if (!category) return fail(res, 400, "bad_request", "new_ruleset requires ruleset_category");
    if (!db.prepare("SELECT 1 FROM categories WHERE category = ?").get(category)) db.prepare("INSERT INTO categories (category, label) VALUES (?, ?)").run(category, category);
  } else {
    category = (b.ruleset_id || b.category || "").trim() || null;
    if (category && !db.prepare("SELECT 1 FROM categories WHERE category = ?").get(category)) return fail(res, 400, "bad_request", `unknown category: ${category}`);
  }

  const arr = (v) => JSON.stringify(Array.isArray(v) ? v : []);
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO rules
    (rule_id, statement, category,
     sales_principle, customer_condition,
     violation_type, knowledge_ids, created_at, updated_at)
    VALUES
    (@rule_id, @statement, @category,
     @sales_principle, @customer_condition,
     @violation_type, @knowledge_ids, @created_at, @updated_at)`);

  const created = [];
  let skipped = 0;
  db.transaction(() => {
    let { m } = db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(rule_id, 6) AS INTEGER)), 0) AS m FROM rules").get();
    for (const r of incoming) {
      const statement = (r.statement || "").trim();
      if (!statement) { skipped++; continue; }
      m += 1;
      let rule_id = `RULE_${String(m).padStart(3, "0")}`;
      while (db.prepare("SELECT 1 FROM rules WHERE rule_id = ?").get(rule_id)) rule_id += "_x";
      ins.run({
        rule_id, statement,
        category,
        sales_principle: r.sales_principle || null,
        customer_condition: r.customer_condition || "모든 고객",
        violation_type: r.violation_type || "누락형",
        knowledge_ids: arr(r.knowledge_ids),
        created_at: now, updated_at: now,
      });
      setRuleTags(rule_id, r.semantic_tags);
      created.push(rule_id);
    }
  })();

  res.json(ok({ category, ruleset_id: category, created: created.length, created_ids: created, skipped }));
});

// RS-2 loadRuleSet — 상품 식별자로 룰셋 "본문 전체" 로드 (세션 시작 1회, 고정)
//   product_id → 카테고리 매칭(N:M) 룰셋 전체를 반환. 매칭은 ST(매칭AI)가 이 본문 안에서 수행.
//   각 룰은 iTrix 판정 페이로드(judge_payload)와 그 크기(judge_chars)를 함께 담는다.
//   2000자 예산은 "룰 판정정보 + 대화" 단위 → judge_chars 가 RULE_LIMIT(=2000-대화여유) 이하인지 검증.
const JUDGE_BUDGET = 2000;         // iTrix 판정 입력(룰 판정정보 + 대화) 예산
const DIALOGUE_RESERVE = 500;      // 대화 여유분
const RULE_LIMIT = JUDGE_BUDGET - DIALOGUE_RESERVE; // 룰 판정정보 상한 = 1500

// 판매원칙 조문 — principles 마스터에서 조회 (sales_principle 은 rules 저장값 사용)
const principleArticle = (code) => db.prepare("SELECT article FROM principles WHERE code = ?").get(code)?.article ?? null;

function buildJudge(r, knowledgeFull) {
  const basisIds = JSON.parse(r.knowledge_ids || "[]");
  const basisItems = basisIds.map((pid) => knowledgeFull[pid]).filter(Boolean);
  const basisView = basisItems.map((p) => ({ document_type: p.document_type, title: p.title, gist: gistOf(p.content) }));
  // ST 가 iTrix 에 넘길 "룰 판정정보" (대화는 ST가 붙임)
  const judge_payload =
    `[체크] ${r.statement}\n` +
    `[근거] ${basisView.map((b) => `${b.title}: ${b.gist}`).join(" / ")}`;
  return { basisView, judge_payload };
}

app.get("/api/ruleset/load", (req, res) => {
  const { product_id } = req.query;
  if (!product_id) return fail(res, 400, "bad_request", "product_id is required");

  // ST 가 매칭한 의미태그(선택) — 넘어오면 해당 태그를 요구하는 룰만 필터링
  const reqTags = String(req.query.tags || "").split(",").map((t) => t.trim()).filter(Boolean);

  const product = db.prepare("SELECT * FROM products WHERE product_id = ?").get(product_id);
  if (!product) return fail(res, 404, "not_found", `unknown product_id: ${product_id}`);

  // RS-2 : product_id → product_category → 해당 카테고리(=룰셋) 룰 선택
  //   룰셋 = 카테고리. 공통(common) 카테고리 룰은 전 상품 공통 base 로 항상 병합.
  const category = product.product_category;
  const COMMON_CATEGORY = "common";
  const appliedCats = [...new Set([COMMON_CATEGORY, category].filter(Boolean))];
  const rsIds = appliedCats;
  const version = "1.0.0";
  // 반환 식별정보 : 상품의 카테고리(=룰셋), 상품 식별자·상품명 미포함
  const ruleset_identity = { ...rulesetIdentityOf(category), version };
  const knowledgeFull = Object.fromEntries(db.prepare("SELECT * FROM knowledge").all().map((p) => [p.knowledge_id, p]));
  const rtMap = allRuleTagsMap(); // rule_id → [tag_code]

  const allRows = db.prepare("SELECT * FROM rules ORDER BY rule_id").all().filter((r) => appliedCats.includes(r.category));
  const totalInRuleset = allRows.length;
  const rows = reqTags.length
    ? allRows.filter((r) => (rtMap[r.rule_id] || []).some((t) => reqTags.includes(t)))
    : allRows;
  // 조항(근거 법령) 원문 뷰 — iTrix 위반 판정용
  const knowledgeOf = (r) =>
    JSON.parse(r.knowledge_ids || "[]").map((pid) => knowledgeFull[pid]).filter(Boolean)
      .map((p) => ({ knowledge_id: p.knowledge_id, document_type: p.document_type, title: p.title, content: p.content }));

  const rules = rows.map((r) => {
    const { basisView, judge_payload } = buildJudge(r, knowledgeFull);
    const judge_chars = judge_payload.length;
    const ruleTags = rtMap[r.rule_id] || [];
    return {
      id: r.rule_id.replace(/^RULE_/, ""),
      rule_id: r.rule_id,
      statement: r.statement,
      // 판매원칙 (rules 저장값) + 조문(principles 마스터)
      sales_principle: r.sales_principle,
      principle_article: principleArticle(r.sales_principle),
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
