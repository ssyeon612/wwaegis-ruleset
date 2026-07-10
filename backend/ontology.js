// 온톨로지 — 관계형 룰셋 데이터를 타입드 지식그래프로 표현하고 RDF(Turtle/JSON-LD)로 내보낸다.
// 노드: document / provision / rule / tag / ruleset / category / product / jury_panel
// 엣지: CONTAINS · BASED_ON · REQUIRES · IN_RULESET · HAS_CATEGORY · APPLIES_TO · JUDGED_BY
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
  provision: (id) => `prov:${id}`,
  rule: (id) => `rule:${id}`,
  tag: (code) => `tag:${code}`,
  ruleset: (id) => `rset:${id}`,
  category: (c) => `cat:${c}`,
  product: (id) => `prod:${id}`,
  jury: (id) => `jury:${id}`,
};

const NODE_TYPES = ["document", "provision", "rule", "tag", "ruleset", "category", "product", "jury_panel"];
const EDGE_TYPES = ["CONTAINS", "BASED_ON", "REQUIRES", "IN_RULESET", "HAS_CATEGORY", "APPLIES_TO", "JUDGED_BY"];

export function buildGraph(db, taxonomy) {
  const nodes = new Map();
  const edges = [];
  const addNode = (id, type, label, props = {}) => { if (!nodes.has(id)) nodes.set(id, { id, type, label, ...props }); };
  const addEdge = (source, target, type) => edges.push({ source, target, type });

  const provisions = db.prepare("SELECT * FROM provisions").all();
  const rules = db.prepare("SELECT * FROM rules ORDER BY rule_seq").all();
  const rulesets = db.prepare("SELECT * FROM rulesets").all();
  const products = db.prepare("SELECT * FROM products").all();
  const semTags = taxonomy.semantic_tags || {};
  const juries = taxonomy.jury_panels || {};

  // documents ← provisions
  const docs = new Set();
  for (const p of provisions) {
    addNode(N.provision(p.provision_id), "provision", p.heading, { e_id: p.e_id, document_type: p.document_type, document_id: p.document_id, text: p.text });
    if (!docs.has(p.document_id)) {
      docs.add(p.document_id);
      addNode(N.document(p.document_id), "document", p.document_id, { document_type: p.document_type });
    }
    addEdge(N.document(p.document_id), N.provision(p.provision_id), "CONTAINS");
  }

  // rulesets ← category
  for (const rs of rulesets) {
    addNode(N.ruleset(rs.ruleset_id), "ruleset", rs.ruleset_name, { ruleset_version: rs.ruleset_version, ruleset_category: rs.ruleset_category });
    addNode(N.category(rs.ruleset_category), "category", rs.ruleset_category);
    addEdge(N.ruleset(rs.ruleset_id), N.category(rs.ruleset_category), "HAS_CATEGORY");
  }

  // products → category (APPLIES_TO)
  for (const pr of products) {
    const cats = JSON.parse(pr.product_categories || "[]");
    addNode(N.product(pr.product_id), "product", pr.product_name);
    for (const c of cats) {
      addNode(N.category(c), "category", c);
      addEdge(N.product(pr.product_id), N.category(c), "APPLIES_TO");
    }
  }

  // rules + relations
  for (const r of rules) {
    const basis = JSON.parse(r.basis || "[]");
    const tags = JSON.parse(r.required_tags || "[]");
    const mod = modalityOf(r.violation_type);
    addNode(N.rule(r.rule_id), "rule", r.content, {
      rule_id: r.rule_id, meta_title: r.meta_title, trigger_state: r.trigger_state,
      condition_type: r.condition_type, violation_type: r.violation_type,
      modality: mod.code, modality_ko: mod.ko, threshold: r.threshold,
    });
    if (r.ruleset_id) { addNode(N.ruleset(r.ruleset_id), "ruleset", r.ruleset_id); addEdge(N.rule(r.rule_id), N.ruleset(r.ruleset_id), "IN_RULESET"); }
    for (const pid of basis) addEdge(N.rule(r.rule_id), N.provision(pid), "BASED_ON");
    for (const t of tags) { addNode(N.tag(t), "tag", semTags[t] || t, { code: t }); addEdge(N.rule(r.rule_id), N.tag(t), "REQUIRES"); }
    if (r.jury_panel_id) { addNode(N.jury(r.jury_panel_id), "jury_panel", juries[r.jury_panel_id]?.name || r.jury_panel_id, { jurors: juries[r.jury_panel_id]?.jurors }); addEdge(N.rule(r.rule_id), N.jury(r.jury_panel_id), "JUDGED_BY"); }
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
const CLASS = { document: "Document", provision: "Provision", rule: "Rule", tag: "SemanticTag", ruleset: "RuleSet", category: "Category", product: "Product", jury_panel: "JuryPanel" };
const PRED = { CONTAINS: "contains", BASED_ON: "basedOn", REQUIRES: "requiresTag", IN_RULESET: "inRuleSet", HAS_CATEGORY: "hasCategory", APPLIES_TO: "appliesTo", JUDGED_BY: "judgedBy" };
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
    if (n.e_id) parts.push(`aegis:eId "${esc(n.e_id)}"`);
    if (n.document_type) parts.push(`aegis:documentType "${esc(n.document_type)}"`);
    if (n.trigger_state) parts.push(`aegis:triggerState "${esc(n.trigger_state)}"`);
    if (n.violation_type) parts.push(`aegis:violationType "${esc(n.violation_type)}"`);
    if (n.ruleset_version) parts.push(`aegis:version "${esc(n.ruleset_version)}"`);
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
    if (n.e_id) props.push(`eId:'${q(n.e_id)}'`);
    if (n.document_type) props.push(`documentType:'${q(n.document_type)}'`);
    if (n.trigger_state) props.push(`triggerState:'${q(n.trigger_state)}'`);
    if (n.violation_type) props.push(`violationType:'${q(n.violation_type)}'`);
    if (n.modality_ko) props.push(`modality:'${q(n.modality_ko)}'`);
    if (n.code) props.push(`tagCode:'${q(n.code)}'`);
    if (n.ruleset_version) props.push(`version:'${q(n.ruleset_version)}'`);
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
