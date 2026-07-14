// 백엔드 REST API 클라이언트 (Vite 프록시로 /api → :4000)
const BASE = "/api";

async function json(res) {
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch {}
    throw new Error(body?.error_message || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

// 관리 데이터 일괄 로드 (knowledge / rules / taxonomy / products / rulesets)
export async function fetchBundle() {
  const [knowledge, rules, taxonomy, products, rulesetsRes, categories, principles] = await Promise.all([
    fetch(`${BASE}/knowledge`).then(json),
    fetch(`${BASE}/rules`).then(json),
    fetch(`${BASE}/taxonomy`).then(json),
    fetch(`${BASE}/products`).then(json),
    fetch(`${BASE}/rulesets`).then(json),
    fetch(`${BASE}/categories`).then(json),
    fetch(`${BASE}/principles`).then(json),
  ]);
  const knowledgeMap = Object.fromEntries(knowledge.map((p) => [p.knowledge_id, p]));
  return { knowledge: knowledgeMap, rules, taxonomy, products, categories, principles, rulesets: rulesetsRes.ruleset_identities || [] };
}

// AI 분석 (Google Gemini) — 파일 텍스트 → 룰 후보 (키 미설정 시 503 → 프론트에서 규칙기반 폴백)
export async function analyzeRulesFile(text) {
  return fetch(`${BASE}/rules/analyze`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
  }).then(json);
}

// 룰 일괄 임포트 (파일 파싱 결과) — { rules, ruleset_id? , new_ruleset? }
export async function importRules(payload) {
  return fetch(`${BASE}/rules/import`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }).then(json);
}

// 룰 추가 (신규 생성)
export async function createRule(payload) {
  return fetch(`${BASE}/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(json);
}

// 근거 조항 추가 (신규 생성)
export async function createKnowledge(payload) {
  return fetch(`${BASE}/knowledge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(json);
}

// 근거 조항 삭제
export async function deleteKnowledge(knowledgeId) {
  return fetch(`${BASE}/knowledge/${encodeURIComponent(knowledgeId)}`, { method: "DELETE" }).then(json);
}

// ── 의미태그(semantic_tags) 추가/수정/삭제 ──
export async function createTag(payload) {
  return fetch(`${BASE}/taxonomy/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }).then(json);
}
export async function updateTag(code, label) {
  return fetch(`${BASE}/taxonomy/tags/${encodeURIComponent(code)}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label }),
  }).then(json);
}
export async function deleteTag(code) {
  return fetch(`${BASE}/taxonomy/tags/${encodeURIComponent(code)}`, { method: "DELETE" }).then(json);
}

// 룰 편집 영속화 (변경 이력 append)
export async function updateRule(ruleId, patch) {
  return fetch(`${BASE}/rules/${encodeURIComponent(ruleId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).then(json);
}

// 룰 삭제
export async function deleteRule(ruleId) {
  return fetch(`${BASE}/rules/${encodeURIComponent(ruleId)}`, { method: "DELETE" }).then(json);
}

// ── ST 인터페이스 (RS-2 loadRuleSet) ─────────────────────
// 상품 식별자(+ ST 가 매칭한 의미태그) → 룰셋 본문. 태그를 보내면 해당 룰만 반환.
export async function loadRuleSet(productId, tags = []) {
  const id = typeof productId === "string" ? productId : productId?.product_id;
  const qs = new URLSearchParams({ product_id: id || "" });
  if (tags.length) qs.set("tags", tags.join(","));
  return fetch(`${BASE}/ruleset/load?${qs.toString()}`).then(json);
}

// 근거 조항 직접 수정 (버전업 없이 제목·원문·출처 in-place)
export async function updateKnowledge(knowledgeId, patch) {
  return fetch(`${BASE}/knowledge/${encodeURIComponent(knowledgeId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).then(json);
}
// RS-1 listRuleSets
export async function listRuleSets(category) {
  const q = category ? `?ruleset_category=${encodeURIComponent(category)}` : "";
  return fetch(`${BASE}/rulesets${q}`).then(json);
}

// 온톨로지 — 지식그래프 + RDF 내보내기
export async function fetchOntology() {
  return fetch(`${BASE}/ontology/graph`).then(json);
}
export async function fetchOntologyExport(format) {
  if (format === "jsonld") {
    const j = await fetch(`${BASE}/ontology/export?format=jsonld`).then((r) => r.json());
    return JSON.stringify(j, null, 2);
  }
  return fetch(`${BASE}/ontology/export?format=turtle`).then((r) => r.text());
}
