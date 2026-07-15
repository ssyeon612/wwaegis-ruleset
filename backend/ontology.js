// 온톨로지 — 관계형 룰셋 데이터를 타입드 지식그래프로 표현하고 RDF(Turtle/JSON-LD)로 내보낸다.
// 노드: document / knowledge / rule / principle / tag / category(=룰셋) / product
// 엣지: CONTAINS · BASED_ON · REQUIRES · IN_RULESET · APPLIES_TO · HAS_PRINCIPLE
// deontic 양상(의무/금지/권고)은 rule 노드 속성.

const NS = "https://wiseagis.aegis/ontology#";
const DEO = "https://wiseagis.aegis/deontic#";

// 위반유형 → deontic modality
const MODALITY = {
  "누락형": { code: "Obligation", ko: "의무", desc: "상담사가 이행해야 하는 의무" },
  "감점형": { code: "Prohibition", ko: "금지", desc: "해서는 안 되는 금지 행위" },
  "비계량형": { code: "Advisory", ko: "권고", desc: "정성 평가·권고 항목" },
};
export const modalityOf = (violation_type) => MODALITY[violation_type] || MODALITY["비계량형"];

const N = {
  document: (id) => `doc:${id}`,
  knowledge: (id) => `knowledge:${id}`,
  rule: (id) => `rule:${id}`,
  principle: (code) => `prin:${code}`,
  tag: (code) => `tag:${code}`,
  category: (c) => `cat:${c}`,
  product: (id) => `prod:${id}`,
};

const NODE_TYPES = ["document", "knowledge", "rule", "principle", "tag", "category", "product"];
const EDGE_TYPES = ["CONTAINS", "BASED_ON", "REQUIRES", "IN_RULESET", "APPLIES_TO", "HAS_PRINCIPLE"];

export function buildGraph(db, taxonomy) {
  const nodes = new Map();
  const edges = [];
  const addNode = (id, type, label, props = {}) => { if (!nodes.has(id)) nodes.set(id, { id, type, label, ...props }); };
  const addEdge = (source, target, type) => edges.push({ source, target, type });

  const knowledge = db.prepare("SELECT * FROM knowledge").all();
  const rules = db.prepare("SELECT * FROM rules ORDER BY rule_id").all();
  const categoriesTbl = db.prepare("SELECT category, label FROM categories").all();
  const products = db.prepare("SELECT * FROM products").all();
  const catLabel = Object.fromEntries(categoriesTbl.map((c) => [c.category, c.label]));
  const semTags = Object.fromEntries(db.prepare("SELECT tag_code, label FROM tags").all().map((t) => [t.tag_code, t.label]));
  const prinMaster = Object.fromEntries(db.prepare("SELECT code, label, article FROM principles").all().map((p) => [p.code, p]));
  const ruleTagMap = {};
  for (const rt of db.prepare("SELECT rule_id, tag_code FROM rule_tags").all()) (ruleTagMap[rt.rule_id] ??= []).push(rt.tag_code);
  const ruleKnowMap = {};
  for (const rk of db.prepare("SELECT rule_id, knowledge_id FROM rule_knowledge").all()) (ruleKnowMap[rk.rule_id] ??= []).push(rk.knowledge_id);

  // documents ← knowledge
  const docs = new Set();
  for (const p of knowledge) {
    addNode(N.knowledge(p.knowledge_id), "knowledge", p.title, { document_type: p.document_type, content: p.content });
    if (!docs.has(p.document_type)) {
      docs.add(p.document_type);
      addNode(N.document(p.document_type), "document", p.document_type, { document_type: p.document_type });
    }
    addEdge(N.document(p.document_type), N.knowledge(p.knowledge_id), "CONTAINS");
  }

  // 룰셋 = 카테고리 : 카테고리 노드 하나로 표현 (별도 ruleset 노드·HAS_CATEGORY 없음)
  for (const c of categoriesTbl) {
    addNode(N.category(c.category), "category", c.label || c.category, { ruleset_category: c.category });
  }

  // products → category (APPLIES_TO) — 상품은 단일 카테고리 보유
  for (const pr of products) {
    addNode(N.product(pr.product_id), "product", pr.product_name);
    const c = pr.product_category;
    if (c) {
      addNode(N.category(c), "category", catLabel[c] || c);
      addEdge(N.product(pr.product_id), N.category(c), "APPLIES_TO");
    }
  }

  // rules + relations
  for (const r of rules) {
    const knowledge_ids = ruleKnowMap[r.rule_id] || [];
    const tags = ruleTagMap[r.rule_id] || [];
    const mod = modalityOf(r.violation_type);
    const prin = prinMaster[r.sales_principle];
    addNode(N.rule(r.rule_id), "rule", r.statement, {
      rule_id: r.rule_id,
      sales_principle: prin?.label || r.sales_principle || null,
      customer_condition: r.customer_condition, violation_type: r.violation_type,
      modality: mod.code, modality_ko: mod.ko,
    });
    if (r.category) { addNode(N.category(r.category), "category", catLabel[r.category] || r.category); addEdge(N.rule(r.rule_id), N.category(r.category), "IN_RULESET"); }
    // 판매원칙 (principles 마스터)
    if (r.sales_principle) {
      addNode(N.principle(r.sales_principle), "principle", prin?.label || r.sales_principle, { article: prin?.article || null });
      addEdge(N.rule(r.rule_id), N.principle(r.sales_principle), "HAS_PRINCIPLE");
    }
    for (const pid of knowledge_ids) addEdge(N.rule(r.rule_id), N.knowledge(pid), "BASED_ON");
    for (const t of tags) { addNode(N.tag(t), "tag", semTags[t] || t, { code: t }); addEdge(N.rule(r.rule_id), N.tag(t), "REQUIRES"); }
  }

  const nodeList = [...nodes.values()];
  const stats = {
    nodes: nodeList.length, edges: edges.length,
    by_node_type: Object.fromEntries(NODE_TYPES.map((t) => [t, nodeList.filter((n) => n.type === t).length])),
    by_edge_type: Object.fromEntries(EDGE_TYPES.map((t) => [t, edges.filter((e) => e.type === t).length])),
  };
  return { nodes: nodeList, edges, stats, meta: { NODE_TYPES, EDGE_TYPES, modality: MODALITY } };
}

// ── RDF 내보내기 ─────────────────────────────────────────
// IRI 지역명은 노드 인덱스 기반(n0,n1…)으로 고유하게 발급하고, 원본 식별자는 aegis:sourceId 리터럴로 보존한다.
const esc = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
const CLASS = { document: "Document", knowledge: "Knowledge", rule: "Rule", principle: "SalesPrinciple", tag: "SemanticTag", category: "RuleSetCategory", product: "Product" };
const PRED = { CONTAINS: "contains", BASED_ON: "basedOn", REQUIRES: "requiresTag", IN_RULESET: "inRuleSet", APPLIES_TO: "appliesTo", HAS_PRINCIPLE: "hasPrinciple" };
const localName = (graph) => new Map(graph.nodes.map((n, i) => [n.id, `n${i}`]));

export function toTurtle(graph) {
  const lm = localName(graph);
  const iri = (id) => `aegis:${lm.get(id)}`;
  const L = [];
  L.push(`@prefix aegis: <${NS}> .`);
  L.push(`@prefix deontic: <${DEO}> .`);
  L.push(`@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .`);
  L.push(`@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`);
  L.push("");
  L.push(`deontic:Obligation a rdfs:Class ; rdfs:label "의무" .`);
  L.push(`deontic:Prohibition a rdfs:Class ; rdfs:label "금지" .`);
  L.push(`deontic:Advisory a rdfs:Class ; rdfs:label "권고" .`);
  L.push("");

  for (const n of graph.nodes) {
    const parts = [`a aegis:${CLASS[n.type] || "Node"}`, `rdfs:label "${esc(n.label)}"`, `aegis:sourceId "${esc(n.id)}"`];
    if (n.type === "rule" && n.modality) parts.push(`a deontic:${n.modality}`);
    if (n.document_type) parts.push(`aegis:documentType "${esc(n.document_type)}"`);
    if (n.violation_type) parts.push(`aegis:violationType "${esc(n.violation_type)}"`);
    if (n.sales_principle) parts.push(`aegis:salesPrinciple "${esc(n.sales_principle)}"`);
    if (n.article) parts.push(`aegis:article "${esc(n.article)}"`);
    if (n.code) parts.push(`aegis:tagCode "${esc(n.code)}"`);
    L.push(`${iri(n.id)} ${parts.join(" ; ")} .`);
  }
  L.push("");
  for (const e of graph.edges) {
    if (!lm.has(e.source) || !lm.has(e.target)) continue;
    L.push(`${iri(e.source)} aegis:${PRED[e.type]} ${iri(e.target)} .`);
  }
  return L.join("\n");
}

// ── Neo4j Cypher 적재 스크립트 ───────────────────────────
export function toCypher(graph) {
  const q = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, " ");
  const L = [];
  L.push("// Aegis RuleSet 온톨로지 → Neo4j 적재 스크립트");
  L.push("// 실행: cypher-shell < ontology.cypher  (또는 Neo4j Browser 붙여넣기)");
  L.push("CREATE CONSTRAINT node_sourceId IF NOT EXISTS FOR (n:Node) REQUIRE n.sourceId IS UNIQUE;");
  L.push("");
  L.push("// ── 노드 ──");
  for (const n of graph.nodes) {
    const labels = ["Node", CLASS[n.type] || "Entity"];
    if (n.type === "rule" && n.modality) labels.push(n.modality); // deontic 라벨 병기
    const props = [`label:'${q(n.label)}'`, `nodeType:'${q(n.type)}'`];
    if (n.document_type) props.push(`documentType:'${q(n.document_type)}'`);
    if (n.violation_type) props.push(`violationType:'${q(n.violation_type)}'`);
    if (n.sales_principle) props.push(`salesPrinciple:'${q(n.sales_principle)}'`);
    if (n.article) props.push(`article:'${q(n.article)}'`);
    if (n.modality_ko) props.push(`modality:'${q(n.modality_ko)}'`);
    if (n.code) props.push(`tagCode:'${q(n.code)}'`);
    L.push(`MERGE (n:${labels.join(":")} {sourceId:'${q(n.id)}'}) SET n += {${props.join(", ")}};`);
  }
  L.push("");
  L.push("// ── 관계 ──");
  for (const e of graph.edges) {
    L.push(`MATCH (a {sourceId:'${q(e.source)}'}), (b {sourceId:'${q(e.target)}'}) MERGE (a)-[:${e.type}]->(b);`);
  }
  return L.join("\n");
}

export function toJsonLd(graph) {
  const lm = localName(graph);
  const graphArr = graph.nodes.map((n) => {
    const o = { "@id": `aegis:${lm.get(n.id)}`, "@type": [`aegis:${CLASS[n.type] || "Node"}`], "rdfs:label": n.label, "aegis:sourceId": n.id };
    if (n.type === "rule" && n.modality) o["@type"].push(`deontic:${n.modality}`);
    return o;
  });
  const byId = Object.fromEntries(graphArr.map((o, i) => [graph.nodes[i].id, o]));
  for (const e of graph.edges) {
    const s = byId[e.source];
    if (!s || !lm.has(e.target)) continue;
    (s[`aegis:${PRED[e.type]}`] ??= []).push({ "@id": `aegis:${lm.get(e.target)}` });
  }
  return { "@context": { aegis: NS, deontic: DEO, rdfs: "http://www.w3.org/2000/01/rdf-schema#" }, "@graph": graphArr };
}
