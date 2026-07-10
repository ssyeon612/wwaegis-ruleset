import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import db from "./db.js";
import { buildGraph, toTurtle, toJsonLd, toCypher } from "./ontology.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAXONOMY = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "taxonomy.json"), "utf8"));

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

// keywords / basis / required_tags(JSON) → 배열 복원
function parseRule(row) {
  if (!row) return row;
  return {
    ...row,
    keywords: JSON.parse(row.keywords || "[]"),
    required_tags: JSON.parse(row.required_tags || "[]"),
    basis: JSON.parse(row.basis || "[]"),
  };
}
const parseProduct = (row) => (row ? { ...row, product_categories: JSON.parse(row.product_categories || "[]") } : row);

// ══════════════════════════════════════════════════════════
// 관리 사용자 인터페이스 (§4.1·§4.2)
// ══════════════════════════════════════════════════════════
app.get("/api/provisions", (_req, res) => {
  res.json(db.prepare("SELECT * FROM provisions ORDER BY provision_id").all());
});

app.get("/api/rules", (_req, res) => {
  res.json(db.prepare("SELECT * FROM rules ORDER BY rule_seq").all().map(parseRule));
});

app.get("/api/rules/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM rules WHERE rule_id = ?").get(req.params.id);
  if (!row) return fail(res, 404, "not_found", "rule not found");
  res.json(parseRule(row));
});

// 룰 수정 + 변경 이력 append (F4)
const EDITABLE = ["verification_method", "judge_prompt", "content", "meta_title", "speech_act", "jury_panel_id", "threshold", "required_tags"];
app.put("/api/rules/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM rules WHERE rule_id = ?").get(req.params.id);
  if (!existing) return fail(res, 404, "not_found", "rule not found");

  const patch = {};
  for (const key of EDITABLE) {
    if (key in req.body) patch[key] = key === "required_tags" ? JSON.stringify(req.body[key] || []) : req.body[key];
  }
  if (Object.keys(patch).length === 0) return fail(res, 400, "bad_request", "no editable fields provided");

  const setClause = Object.keys(patch).map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE rules SET ${setClause} WHERE rule_id = @rule_id`).run({ ...patch, rule_id: req.params.id });

  db.prepare(`INSERT INTO change_log (entity_type, entity_id, action, changes, actor, reason, at)
              VALUES ('rule', @id, 'update', @changes, @actor, @reason, @at)`).run({
    id: req.params.id,
    changes: JSON.stringify(patch),
    actor: req.body._actor || "admin",
    reason: req.body._reason || null,
    at: new Date().toISOString(),
  });

  res.json(parseRule(db.prepare("SELECT * FROM rules WHERE rule_id = ?").get(req.params.id)));
});

// 룰 변경 이력 조회 (F4-4)
app.get("/api/rules/:id/history", (req, res) => {
  res.json(db.prepare("SELECT * FROM change_log WHERE entity_type='rule' AND entity_id=? ORDER BY log_id DESC").all(req.params.id));
});

app.get("/api/vocabulary", (_req, res) => {
  const rows = db.prepare("SELECT category, value FROM vocabulary").all();
  const grouped = {};
  for (const { category, value } of rows) (grouped[category] ??= []).push(value);
  res.json(grouped);
});

app.get("/api/taxonomy", (_req, res) => res.json(TAXONOMY));

app.get("/api/products", (_req, res) => {
  res.json(db.prepare("SELECT * FROM products ORDER BY product_id").all().map(parseProduct));
});

// ── 조항 개정 (버전업) — 스냅샷 이력 + 영향 룰 자동 재검토 플래그 (F2-6·F4) ──
app.post("/api/provisions/:id/amend", (req, res) => {
  const { version, text, heading, effective_from, note, dry_run } = req.body || {};
  const prov = db.prepare("SELECT * FROM provisions WHERE provision_id = ?").get(req.params.id);
  if (!prov) return fail(res, 404, "not_found", "provision not found");
  if (!version || !text) return fail(res, 400, "bad_request", "version and text are required");

  const affected = db.prepare("SELECT * FROM rules ORDER BY rule_seq").all()
    .filter((r) => JSON.parse(r.basis || "[]").includes(prov.provision_id));
  const diff = {
    from_version: prov.version, to_version: version,
    old_heading: prov.heading, new_heading: heading ?? prov.heading,
    old_text: prov.text, new_text: text,
  };
  const affected_rules = affected.map((r) => ({ rule_id: r.rule_id, content: r.content, trigger_state: r.trigger_state, review_status: r.review_status }));

  if (dry_run) {
    return res.json(ok({ dry_run: true, provision: prov, diff, affected_rules, affected_count: affected.length }));
  }

  const now = new Date().toISOString();
  const reviewNote = `§${prov.e_id} 개정 (v${prov.version}→v${version})`;
  db.transaction(() => {
    db.prepare(`INSERT INTO provision_history (provision_id, version, heading, text, effective_from, note, archived_at)
                VALUES (@pid, @version, @heading, @text, @eff, @note, @at)`).run({
      pid: prov.provision_id, version: prov.version, heading: prov.heading, text: prov.text, eff: prov.effective_from, note: note || null, at: now,
    });
    db.prepare(`UPDATE provisions SET version=@version, text=@text, heading=@heading, effective_from=@eff, gist=@gist WHERE provision_id=@pid`).run({
      version, text, heading: heading ?? prov.heading, eff: effective_from ?? prov.effective_from, gist: gistOf(text), pid: prov.provision_id,
    });
    const flag = db.prepare("UPDATE rules SET review_status='pending', review_note=@note WHERE rule_id=@id");
    for (const r of affected) flag.run({ id: r.rule_id, note: reviewNote });
    db.prepare(`INSERT INTO change_log (entity_type, entity_id, action, changes, actor, reason, at)
                VALUES ('provision', @id, 'amend', @changes, @actor, @reason, @at)`).run({
      id: prov.provision_id, changes: JSON.stringify({ from: prov.version, to: version, affected: affected.map((r) => r.rule_id) }),
      actor: req.body._actor || "admin", reason: note || null, at: now,
    });
  })();

  const updated = db.prepare("SELECT * FROM provisions WHERE provision_id=?").get(prov.provision_id);
  res.json(ok({ provision: updated, diff, affected_rules, affected_count: affected.length, flagged: affected.length }));
});

// 조항 버전 이력
app.get("/api/provisions/:id/history", (req, res) => {
  res.json(db.prepare("SELECT * FROM provision_history WHERE provision_id=? ORDER BY hist_id DESC").all(req.params.id));
});

// 전체 변경 이력 (append-only) — entity_type/action 필터
app.get("/api/changelog", (req, res) => {
  const { entity_type, action, limit } = req.query;
  let rows = db.prepare("SELECT * FROM change_log ORDER BY log_id DESC").all();
  if (entity_type) rows = rows.filter((r) => r.entity_type === entity_type);
  if (action) rows = rows.filter((r) => r.action === action);
  const lim = Math.min(Number(limit) || 300, 2000);
  const entries = rows.slice(0, lim).map((r) => {
    let changes;
    try { changes = JSON.parse(r.changes); } catch { changes = r.changes; }
    return { ...r, changes };
  });
  res.json(ok({ total: rows.length, count: entries.length, entries }));
});

// 룰 재검토 완료 처리
app.post("/api/rules/:id/review/clear", (req, res) => {
  const r = db.prepare("SELECT * FROM rules WHERE rule_id=?").get(req.params.id);
  if (!r) return fail(res, 404, "not_found", "rule not found");
  db.prepare("UPDATE rules SET review_status='ok', review_note=NULL WHERE rule_id=?").run(req.params.id);
  db.prepare(`INSERT INTO change_log (entity_type, entity_id, action, changes, actor, reason, at)
              VALUES ('rule', @id, 'review_clear', '{}', @actor, @reason, @at)`)
    .run({ id: req.params.id, actor: "admin", reason: req.body?._reason || null, at: new Date().toISOString() });
  res.json(parseRule(db.prepare("SELECT * FROM rules WHERE rule_id=?").get(req.params.id)));
});

// ══════════════════════════════════════════════════════════
// ST 모듈 인터페이스 (§4.3·§4.4 · RS-1 / RS-2 / RS-3)
// ══════════════════════════════════════════════════════════

// RS-1 listRuleSets — RuleSet 식별정보 목록 (옵션 category 필터)
app.get("/api/rulesets", (req, res) => {
  const { ruleset_category } = req.query;
  let rows = db.prepare("SELECT * FROM rulesets ORDER BY ruleset_id").all();
  if (ruleset_category) rows = rows.filter((r) => r.ruleset_category === ruleset_category);
  res.json(ok({ ruleset_identities: rows }));
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

function buildJudge(r, provFull) {
  const basisIds = JSON.parse(r.basis || "[]");
  const basis = basisIds.map((pid) => provFull[pid]).filter(Boolean);
  const principle = principleOf(basisIds);
  const basisView = basis.map((p) => ({ e_id: p.e_id, document_type: p.document_type, document_id: p.document_id, heading: p.heading, gist: p.gist || p.text }));
  // ST 가 iTrix 에 넘길 "룰 판정정보" (대화는 ST가 붙임)
  const judge_payload =
    `[체크] ${r.content}\n` +
    `[기준] ${r.judge_prompt}\n` +
    `[근거] ${basisView.map((b) => `§${b.e_id} ${b.heading}: ${b.gist}`).join(" / ")}`;
  return { basisView, judge_payload, principle };
}

app.get("/api/ruleset/load", (req, res) => {
  const { product_id } = req.query;
  if (!product_id) return fail(res, 400, "bad_request", "product_id is required");

  // ST 가 매칭한 의미태그(선택) — 넘어오면 해당 태그를 요구하는 룰만 필터링
  const reqTags = String(req.query.tags || "").split(",").map((t) => t.trim()).filter(Boolean);

  const product = parseProduct(db.prepare("SELECT * FROM products WHERE product_id = ?").get(product_id));
  if (!product) return fail(res, 404, "not_found", `unknown product_id: ${product_id}`);

  const cats = product.product_categories;
  const rulesets = db.prepare("SELECT * FROM rulesets").all().filter((rs) => cats.includes(rs.ruleset_category));
  const rsIds = rulesets.map((rs) => rs.ruleset_id);
  const version = [...new Set(rulesets.map((rs) => rs.ruleset_version))].join(",") || "1.0.0";
  const provFull = Object.fromEntries(db.prepare("SELECT * FROM provisions").all().map((p) => [p.provision_id, p]));

  const allRows = db.prepare("SELECT * FROM rules ORDER BY rule_seq").all().filter((r) => rsIds.includes(r.ruleset_id));
  const totalInRuleset = allRows.length;
  const rows = reqTags.length
    ? allRows.filter((r) => JSON.parse(r.required_tags || "[]").some((t) => reqTags.includes(t)))
    : allRows;
  // 조항(근거 법령) 원문 뷰 — iTrix 위반 판정용
  const provisionsOf = (r) =>
    JSON.parse(r.basis || "[]").map((pid) => provFull[pid]).filter(Boolean)
      .map((p) => ({ provision_id: p.provision_id, e_id: p.e_id, document_type: p.document_type, document_id: p.document_id, heading: p.heading, text: p.text }));

  const rules = rows.map((r) => {
    const { basisView, judge_payload, principle } = buildJudge(r, provFull);
    const judge_chars = judge_payload.length;
    const ruleTags = JSON.parse(r.required_tags || "[]");
    return {
      id: r.rule_id.replace(/^RULE_/, ""),
      rule_id: r.rule_id,
      content: r.content,
      // 6대 판매원칙 (근거 조항 기준)
      principle: principle.code,
      principle_article: principle.article,
      trigger_state: r.trigger_state,
      condition_type: r.condition_type,
      violation_type: r.violation_type,
      is_deduct: r.is_deduct,
      // 매칭 메타 (ST 가 대화↔Rule 매칭에 사용)
      required_tags: ruleTags,
      matched_tags: reqTags.length ? ruleTags.filter((t) => reqTags.includes(t)) : [],
      speech_act: r.speech_act || null,
      // 판정 메타 (ST → iTrix)
      jury_panel_id: r.jury_panel_id,
      threshold: r.threshold,
      judge_prompt: r.judge_prompt,
      basis: basisView,
      provisions: provisionsOf(r), // 조항 (근거 법령 원문) — ST 실제 응답 페이로드용
      // iTrix 판정 페이로드 + 크기 검증 (2000자 = 룰 판정정보 + 대화)
      judge_payload,
      judge_chars,
      within_budget: judge_chars <= RULE_LIMIT,
    };
  });
  const over = rules.filter((r) => !r.within_budget);

  res.json(ok({
    ruleset_identities: rulesets,
    product: { product_id: product.product_id, product_name: product.product_name, product_categories: cats },
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
