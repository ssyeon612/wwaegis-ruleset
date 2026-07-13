import React, { useState, useMemo, useEffect, useRef } from "react";
import { fetchBundle, updateRule, createRule, deleteRule, createProvision, deleteProvision, createTag, updateTag, deleteTag, loadRuleSet, fetchOntology, updateProvision, clearRuleReview, fetchChangelog } from "./api";

// 데이터는 백엔드 API 에서 로드한다. (provisions / rules / vocabulary)

// ─────────────────────────────────────────────
// 테마 (라이트 / 다크) — Context 로 전역 공급
// ─────────────────────────────────────────────
const FONT = "-apple-system, 'Segoe UI', 'Noto Sans KR', system-ui, sans-serif";
const MONO = "'SF Mono', 'JetBrains Mono', Consolas, monospace";
const LIGHT = {
  bg: "#F6F7F9", surface: "#FFFFFF", subtle: "#FAFBFC", chipBg: "#F1F3F6",
  ink: "#1A2332", sub: "#5A6577", faint: "#98A1B0", line: "#E4E7EC",
  accent: "#2D5BE3", accentBg: "#EDF1FD", mono: MONO, font: FONT,
};
const DARK = {
  bg: "#0E131B", surface: "#161D28", subtle: "#1B2430", chipBg: "#232D3B",
  ink: "#E7ECF3", sub: "#9BA6B5", faint: "#66727F", line: "#2A3441",
  accent: "#6E93F7", accentBg: "#1E2A44", mono: MONO, font: FONT,
};
const makeTheme = (mode) => (mode === "dark" ? DARK : LIGHT);
const ThemeCtx = React.createContext(LIGHT);
const useT = () => React.useContext(ThemeCtx);

// 배지 팔레트(자체 배경/글자색 보유 → 라이트·다크 공통)
const METHOD = {
  llm_judgment:  { label: "AI 판정",    fg: "#6D28D9", bg: "#EDE9FE" },
  deterministic: { label: "시스템 판정", fg: "#047857", bg: "#D1FAE5" },
  human_review:  { label: "사람 검토",   fg: "#B45309", bg: "#FEF3C7" },
};
const VIOLATION = {
  "누락형":   { fg: "#1D4ED8", bg: "#DBEAFE" },
  "감점형":   { fg: "#B91C1C", bg: "#FEE2E2" },
  "비계량형": { fg: "#5A6577", bg: "#F1F3F6" },
};
const DOCTYPE_COLOR = { "법률": "#2D5BE3", "가이드라인": "#B45309", "내규": "#5A6577" };

// 룰북 그룹 기준 — 완전판매 6대 판매원칙(금소법) + 사후관리·절차 세분
const PRINCIPLES = [
  // 6대 판매원칙
  { key: "적합성원칙", test: /art_17/, fg: "#1D4ED8", bg: "#DBEAFE" },
  { key: "적정성원칙", test: /art_18/, fg: "#0369A1", bg: "#E0F2FE" },
  { key: "설명의무", test: /art_19/, fg: "#047857", bg: "#D1FAE5" },
  { key: "불공정영업행위 금지", test: /art_20/, fg: "#B45309", bg: "#FEF3C7" },
  { key: "부당권유행위 금지", test: /art_21/, fg: "#BE185D", bg: "#FCE7F3" },
  { key: "광고규제", test: /art_22/, fg: "#6D28D9", bg: "#EDE9FE" },
  // 사후관리·절차 세분 (근거 조항으로 매핑)
  { key: "판매절차(녹취·숙려)", test: /대면녹취|art_44|숙려제도/, fg: "#0F766E", bg: "#CCFBF1" },
  { key: "소비자 권리", test: /art_46|청약철회|art_47|위법계약해지|art_28/, fg: "#0E7490", bg: "#CFFAFE" },
  { key: "고령투자자 보호", test: /고령자/, fg: "#A16207", bg: "#FEF9C3" },
  { key: "사후관리", test: /해피콜|자료보관/, fg: "#475569", bg: "#E2E8F0" },
  { key: "품질 평가(감점)", test: /모니터링기준/, fg: "#9F1239", bg: "#FFE4E6" },
  { key: "기타", test: null, fg: "#5A6577", bg: "#EEF1F5" },
];
const PRINCIPLE_ORDER = PRINCIPLES.map((p) => p.key);
const PRINCIPLE_ART = Object.fromEntries(PRINCIPLES.map((p) => [p.key, p.art]));
const PRINCIPLE_COLOR = Object.fromEntries(PRINCIPLES.map((p) => [p.key, { fg: p.fg, bg: p.bg }]));
const principleBadge = (key) => PRINCIPLE_COLOR[key] || { fg: "#5A6577", bg: "#EEF1F5" };
const principleOf = (r) => {
  if (r.principle && PRINCIPLE_COLOR[r.principle]) return r.principle;
  const b = (r.basis || []).join(" ");
  const hit = PRINCIPLES.find((p) => p.test && p.test.test(b));
  return hit ? hit.key : "기타";
};

const Badge = ({ fg, bg, children }) => (
  <span style={{ background: bg, color: fg, fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 9, whiteSpace: "nowrap" }}>{children}</span>
);
const Chip = ({ children }) => {
  const T = useT();
  return <span style={{ background: T.accentBg, color: T.accent, fontSize: 12, padding: "3px 10px", borderRadius: 10 }}>{children}</span>;
};
const Card = ({ title, right, children, pad = 16 }) => {
  const T = useT();
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 10, padding: pad }}>
      {(title || right) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: T.sub, letterSpacing: 0.3 }}>{title}</span>
          {right}
        </div>
      )}
      {children}
    </div>
  );
};

// 상담 발화 예시 프리셋 — 다양한 케이스를 한 번에 테스트
const SCENARIOS = [
  {
    label: "이상적 상담",
    hint: "누락형 충족 · 서명 기록 확인",
    text: "먼저 일반금융소비자에 해당하시는지 확인하고 투자성향 진단시스템에 입력하겠습니다. 투자성향 분석결과를 설명·교부드리고, 원금손실 가능성과 예금자보호 비대상 상품임을 안내드립니다. 적합한 상품을 권유드리고 설명서를 교부합니다. 마지막으로 가입 상품과 투자위험을 고객과 함께 기재 후 서명 받겠습니다.",
  },
  {
    label: "핵심 누락",
    hint: "필수 안내 대부분 빠짐 → 미충족",
    text: "이 상품 수익률이 요즘 제일 좋아요. 바로 가입 도와드릴게요.",
  },
  {
    label: "부당권유(감점)",
    hint: "금지 발화 감지 → 감점",
    text: "이 상품은 무조건 원금 보장되고 확실하게 수익 납니다. 혹시 손실 나면 제가 손실보전 해드릴게요.",
  },
  {
    label: "온라인 유도(감점)",
    hint: "회피성 비대면 유도 → 감점",
    text: "창구에서 하면 복잡하니까 그냥 앱으로 하세요. 비대면 안내 도와드릴게요. 온라인으로 가입하시는 게 편해요.",
  },
  {
    label: "고령자 상담",
    hint: "고령자 특화 절차·녹취",
    text: "만 65세 이상 고령투자자시라 관리직 지점장 사전확인을 받고, 비상연락용 조력자 연락처를 등록하겠습니다. 판매과정 녹취 동의 부탁드립니다.",
  },
  { label: "빈 발화", hint: "발화 없음 → 판정 경계 확인", text: "" },
];

// verification_method + violation_type 조합에 따라 판정을 다르게 낸다.
function simulate(rule, transcript) {
  const text = transcript || "";
  const keywords = rule.keywords || [];
  const hits = keywords.filter((k) => k && text.includes(k));

  if (rule.verification_method === "human_review") {
    return { verdict: "사람 검토", detail: "비계량(정성) 항목이라 자동 판정 대상이 아닙니다. 검토자 큐로 이관합니다.", score: null };
  }
  if (rule.verification_method === "deterministic") {
    return hits.length
      ? { verdict: "시스템 확인", detail: `판매시스템 기록 대조 → 관련 처리 이력 확인 (근거: ${hits.join(", ")})`, score: 100 }
      : { verdict: "기록 미확인", detail: "판매시스템에서 해당 처리 이력을 찾지 못했습니다. (실서비스에서는 로그 조회로 대체)", score: 0 };
  }
  if (rule.violation_type === "감점형") {
    return hits.length
      ? { verdict: "감점 감지", detail: `부적절·금지 발화 감지: "${hits.join('", "')}" → 감점 사유에 해당`, score: 0 }
      : { verdict: "정상", detail: "감점 대상 발화가 발견되지 않았습니다.", score: 100 };
  }
  const total = keywords.length || 1;
  const ratio = Math.round((hits.length / total) * 100);
  if (hits.length === 0) return { verdict: "미충족", detail: "관련 발화를 찾지 못했습니다 — 누락 가능성", score: 0 };
  return { verdict: "충족", detail: `근거 키워드 ${hits.length}/${total} 매칭: "${hits.join('", "')}"`, score: ratio };
}
const VERDICT_STYLE = {
  "충족": { fg: "#047857", bg: "#D1FAE5" },
  "미충족": { fg: "#B91C1C", bg: "#FEE2E2" },
  "감점 감지": { fg: "#B91C1C", bg: "#FEE2E2" },
  "정상": { fg: "#047857", bg: "#D1FAE5" },
  "시스템 확인": { fg: "#047857", bg: "#D1FAE5" },
  "기록 미확인": { fg: "#B91C1C", bg: "#FEE2E2" },
  "사람 검토": { fg: "#B45309", bg: "#FEF3C7" },
};

// ─────────────────────────────────────────────
// 룰북 — 키워드 검색 + 6대 원칙 그룹 + 인라인 상세 (한 페이지)
//   · 공유 근거 조항은 그룹 헤더에서 1회만 표시(중복 제거)
//   · 룰 클릭 시 인라인으로 펼쳐 체크 내용·태그·키워드·발화행위 표시
// ─────────────────────────────────────────────
function ListView({ rules, provisions, taxonomy, products = [], openId, setOpenId, onUpdate, onPersist, onCreate, onDelete, query, setQuery }) {
  const T = useT();
  const koOf = (c) => taxonomy?.semantic_tags?.[c] || "";
  // 상품 셀렉트 옵션 : 공통 + 등록된 products (조건 옵션은 표준 4분류 + 기존 값)
  const productOptions = [...new Set(["공통", ...products.map((p) => p.product_name)])];
  const conditionOptions = [...new Set(["모든 고객", "고령자(65+)", "초고령자(80+)", ...rules.map((r) => r.condition_type).filter(Boolean)])];
  const fieldLabel = { fontSize: 10.5, fontWeight: 700, color: T.faint, letterSpacing: 0.4, textTransform: "uppercase" };
  const provsOf = (r) => (r.basis || []).map((pid) => provisions[pid]).filter(Boolean);

  const q = query.trim().toLowerCase();
  const matchInfo = (r) => {
    if (!q) return { hit: true, kw: [] };
    const kw = (r.keywords || []).filter((k) => k.toLowerCase().includes(q));
    const tagHit = (r.required_tags || []).some((t) => t.toLowerCase().includes(q));
    const textHit = r.content.toLowerCase().includes(q) || r.meta_title.toLowerCase().includes(q);
    return { hit: kw.length || tagHit || textHit, kw };
  };
  const results = rules.map((r) => ({ r, ...matchInfo(r) })).filter((x) => x.hit)
    .sort((a, b) => b.kw.length - a.kw.length || a.r.rule_seq - b.r.rule_seq);

  const grouped = useMemo(() => {
    const g = {};
    PRINCIPLE_ORDER.forEach((p) => (g[p] = []));
    rules.forEach((r) => g[principleOf(r)].push(r));
    return PRINCIPLE_ORDER.map((p) => [p, g[p]]).filter(([, l]) => l.length);
  }, [rules]);
  // 그룹의 공유 근거 조항 (중복 제거)
  const groupProvs = (list) => {
    const m = {};
    list.forEach((r) => (r.basis || []).forEach((pid) => { if (provisions[pid]) m[pid] = provisions[pid]; }));
    return Object.values(m);
  };

  const [stage, setStage] = useState("all");
  const [openProv, setOpenProv] = useState(() => new Set());
  const [edit, setEdit] = useState(false);
  const [saveState, setSaveState] = useState("idle");
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const toggleGroupProv = (k) => setOpenProv((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const toggleOpen = (id) => { setOpenId(openId === id ? null : id); setEdit(false); setConfirmDel(false); };
  async function doDelete(r) {
    setDeleting(true);
    try { await onDelete(r.rule_id); setConfirmDel(false); }
    catch (e) { setSaveState("error"); }
    finally { setDeleting(false); }
  }

  // 룰 추가 폼
  const EMPTY_NEW = { content: "", product_type: "공통", condition_type: "모든 고객", meta_title: "", required_tags: [], basis: [] };
  const [adding, setAdding] = useState(false);
  const [nf, setNf] = useState(EMPTY_NEW);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState(null);
  const setNfField = (patch) => setNf((f) => ({ ...f, ...patch }));
  const resetNew = () => { setNf(EMPTY_NEW); setCreateErr(null); };
  async function submitNew() {
    if (!nf.content.trim()) { setCreateErr("제목(룰 내용)을 입력하세요"); return; }
    setCreating(true); setCreateErr(null);
    try {
      const saved = await onCreate({ ...nf, content: nf.content.trim() });
      setAdding(false); resetNew();
      setQuery(""); setStage("all"); setOpenId(saved.rule_id);
    } catch (e) { setCreateErr(e?.message || "추가 실패"); }
    finally { setCreating(false); }
  }

  const inputStyle = { padding: "5px 8px", border: `1px solid ${T.line}`, borderRadius: 7, fontSize: 12, fontFamily: T.font, background: T.surface, color: T.ink };
  const SAVE = { idle: "", saving: "저장 중…", saved: "저장됨 ✓", error: "저장 실패" };
  async function persist(next) { setSaveState("saving"); try { await onPersist(next); setSaveState("saved"); setTimeout(() => setSaveState("idle"), 1200); } catch { setSaveState("error"); } }
  const commit = (next) => { onUpdate(next); persist(next); };

  const ProvCard = ({ p }) => (
    <div style={{ borderLeft: `3px solid ${DOCTYPE_COLOR[p.document_type] || T.line}`, padding: "7px 11px", background: T.surface, borderRadius: "0 7px 7px 0", border: `1px solid ${T.line}`, borderLeftWidth: 3 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 2 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: T.ink }}>{p.heading}</span>
        <span style={{ fontSize: 10.5, fontWeight: 600, color: DOCTYPE_COLOR[p.document_type] }}>{p.document_id && p.document_id !== p.document_type ? `${p.document_type} · ${p.document_id}` : p.document_type}</span>
      </div>
      <p style={{ fontSize: 12.5, lineHeight: 1.65, margin: 0, color: T.sub }}>{p.text}</p>
    </div>
  );
  const MetaRow = ({ label, children }) => (
    <div style={{ display: "flex", gap: 10, alignItems: "baseline", marginBottom: 7 }}>
      <span style={{ fontSize: 11, color: T.faint, minWidth: 52 }}>{label}</span>
      <div style={{ flex: 1, fontSize: 13, color: T.ink }}>{children}</div>
    </div>
  );

  // 인라인 상세 패널 (근거 조항은 그룹 헤더에서 1회만 표시 → 검색 모드에서만 showProv)
  const Panel = ({ r, showProv }) => (
    <div style={{ padding: "10px 14px 14px", background: T.bg }}>
      {edit && (
        <MetaRow label="제목">
          <textarea defaultValue={r.content}
            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== r.content) commit({ ...r, content: v }); }}
            style={{ ...inputStyle, width: "100%", boxSizing: "border-box", minHeight: 48, resize: "vertical", lineHeight: 1.5, fontSize: 13 }} />
        </MetaRow>
      )}
      <MetaRow label="고객조건">
        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.sub, background: T.chipBg, borderRadius: 6, padding: "2px 8px" }}>{r.condition_type}</span>
      </MetaRow>
      <MetaRow label="상품">
        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.sub, background: T.chipBg, borderRadius: 6, padding: "2px 8px" }}>{r.product_type}</span>
      </MetaRow>
      <MetaRow label="태그">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
          {(r.required_tags || []).map((code) => (
            <span key={code} title={code} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: T.accentBg, color: T.accent, fontSize: 12, fontWeight: 600, padding: edit ? "3px 6px 3px 9px" : "3px 9px", borderRadius: 8 }}>
              {koOf(code) || code}
              {edit && <button onClick={() => commit({ ...r, required_tags: r.required_tags.filter((t) => t !== code) })} style={{ border: "none", background: "none", color: T.accent, cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}>×</button>}
            </span>
          ))}
          {(r.required_tags || []).length === 0 && !edit && <span style={{ fontSize: 12, color: T.faint }}>태그없음</span>}
          {edit && (
            <select value="" onChange={(e) => { const v = e.target.value; if (!v) return; const cur = r.required_tags || []; if (cur.includes(v)) return; commit({ ...r, required_tags: [...cur, v] }); }} style={{ ...inputStyle, maxWidth: 220 }}>
              <option value="">+ 태그</option>
              {Object.entries(taxonomy?.semantic_tags || {}).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
          )}
        </div>
      </MetaRow>
      {showProv && provsOf(r).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: T.faint, marginBottom: 5 }}>근거 조항</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{provsOf(r).map((p) => <ProvCard key={p.provision_id} p={p} />)}</div>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
        {r.review_status === "pending" && (
          <button onClick={async () => { try { const saved = await clearRuleReview(r.rule_id); onUpdate(saved); } catch {} }}
            style={{ border: "none", background: "#B45309", color: "#fff", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>재검토 완료</button>
        )}
        {confirmDel ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "#DC2626", fontSize: 12, fontWeight: 600 }}>이 룰을 삭제할까요?</span>
            <button onClick={() => doDelete(r)} disabled={deleting}
              style={{ border: "none", background: "#DC2626", color: "#fff", borderRadius: 7, padding: "5px 11px", cursor: deleting ? "default" : "pointer", fontSize: 12, fontWeight: 700, opacity: deleting ? 0.6 : 1 }}>{deleting ? "삭제 중…" : "삭제"}</button>
            <button onClick={() => setConfirmDel(false)} disabled={deleting}
              style={{ border: `1px solid ${T.line}`, background: T.surface, color: T.sub, borderRadius: 7, padding: "5px 11px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>취소</button>
          </span>
        ) : (
          <button onClick={() => setConfirmDel(true)}
            style={{ border: "1px solid #FCA5A5", background: T.surface, color: "#DC2626", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>삭제</button>
        )}
        <span style={{ fontSize: 12, marginLeft: "auto", color: saveState === "error" ? "#DC2626" : saveState === "saved" ? "#059669" : T.faint }}>{SAVE[saveState]}</span>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: edit ? T.accent : T.sub }}>편집</span>
          <button role="switch" aria-checked={edit} onClick={() => { setEdit((v) => !v); setConfirmDel(false); }} style={{ position: "relative", width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer", background: edit ? T.accent : T.line, transition: "background .15s", padding: 0 }}>
            <span style={{ position: "absolute", top: 3, left: edit ? 21 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left .15s", boxShadow: "0 1px 2px rgba(0,0,0,0.25)" }} />
          </button>
        </label>
      </div>
    </div>
  );

  const RuleItem = ({ r, kw = [], showProv }) => {
    const open = openId === r.rule_id;
    const tags = r.required_tags || [];
    return (
      <div>
        <div onClick={() => toggleOpen(r.rule_id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", cursor: "pointer", background: open ? T.accentBg : "transparent" }}
          onMouseEnter={(e) => { if (!open) e.currentTarget.style.background = T.subtle; }}
          onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = "transparent"; }}>
          <span style={{ display: "inline-flex", gap: 4, minWidth: 116, flexShrink: 0 }}>
            {tags.length ? tags.slice(0, 2).map((t) => (<span key={t} style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 600, color: T.accent, background: open ? T.surface : T.accentBg, borderRadius: 6, padding: "2px 7px", whiteSpace: "nowrap" }}>{t}</span>)) : <span style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 600, color: T.faint, background: T.chipBg, borderRadius: 6, padding: "2px 7px", whiteSpace: "nowrap" }}>태그없음</span>}
          </span>
          <span style={{ fontSize: 13, fontWeight: open ? 600 : 400, color: T.ink, flex: 1, overflow: open ? "visible" : "hidden", textOverflow: "ellipsis", whiteSpace: open ? "normal" : "nowrap" }}>{r.content}</span>
          {r.review_status === "pending" && <Badge fg="#B45309" bg="#FEF3C7">재검토</Badge>}
          <span style={{ color: T.faint, fontSize: 12, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>›</span>
        </div>
        {open && <Panel r={r} showProv={showProv} />}
      </div>
    );
  };

  return (
    <div>
      {/* 룰 추가 */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <button onClick={() => { setAdding((v) => !v); setCreateErr(null); }}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, border: `1px solid ${adding ? T.accent : T.line}`, background: adding ? T.accentBg : T.surface, color: adding ? T.accent : T.sub, borderRadius: 9, padding: "8px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
          <span style={{ fontSize: 15, lineHeight: 1 }}>{adding ? "×" : "+"}</span> {adding ? "닫기" : "룰 추가"}
        </button>
      </div>
      {adding && (
        <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderTop: `3px solid ${T.accent}`, borderRadius: 12, marginBottom: 12, overflow: "hidden", boxShadow: "0 6px 20px -12px rgba(0,0,0,0.25)" }}>
          {/* 헤더 */}
          <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "14px 18px", borderBottom: `1px solid ${T.line}`, background: T.subtle }}>
            <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 9, background: T.accentBg, color: T.accent, fontSize: 18, fontWeight: 700, lineHeight: 1 }}>+</span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>새 룰 추가</div>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 18, padding: "18px" }}>
            {/* 룰 내용 */}
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={fieldLabel}>룰 내용 <span style={{ color: T.accent }}>*</span></span>
              <textarea value={nf.content} onChange={(e) => setNfField({ content: e.target.value })}
                placeholder="예: 원금 손실 가능성을 설명하였는가"
                style={{ ...inputStyle, width: "100%", boxSizing: "border-box", minHeight: 60, resize: "vertical", lineHeight: 1.55, fontSize: 13.5 }} />
            </label>

            {/* 분류: 상품 · 조건 */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={fieldLabel}>분류</span>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <span style={{ fontSize: 11.5, color: T.sub, fontWeight: 600 }}>상품</span>
                  <select value={nf.product_type || "공통"} onChange={(e) => setNfField({ product_type: e.target.value })} style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}>
                    {productOptions.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <span style={{ fontSize: 11.5, color: T.sub, fontWeight: 600 }}>고객조건</span>
                  <select value={nf.condition_type || "모든 고객"} onChange={(e) => setNfField({ condition_type: e.target.value })} style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}>
                    {conditionOptions.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
              </div>
            </div>

            {/* 태그 */}
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <span style={fieldLabel}>의미 태그</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", padding: 8, border: `1px solid ${T.line}`, borderRadius: 9, background: T.bg, minHeight: 40, boxSizing: "border-box" }}>
                {nf.required_tags.length === 0 && <span style={{ fontSize: 11.5, color: T.faint, paddingLeft: 3 }}>선택된 태그 없음</span>}
                {nf.required_tags.map((code) => (
                  <span key={code} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: T.accentBg, color: T.accent, fontSize: 12, fontWeight: 600, padding: "3px 6px 3px 9px", borderRadius: 8 }}>
                    {koOf(code) || code}
                    <button onClick={() => setNfField({ required_tags: nf.required_tags.filter((t) => t !== code) })} style={{ border: "none", background: "none", color: T.accent, cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}>×</button>
                  </span>
                ))}
                <select value="" onChange={(e) => { const v = e.target.value; if (v && !nf.required_tags.includes(v)) setNfField({ required_tags: [...nf.required_tags, v] }); }} style={{ ...inputStyle, maxWidth: 200, marginLeft: "auto" }}>
                  <option value="">+ 태그 추가</option>
                  {Object.entries(taxonomy?.semantic_tags || {}).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                </select>
              </div>
            </div>

            {/* 근거 조항 */}
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <span style={fieldLabel}>근거 조항</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", padding: 8, border: `1px solid ${T.line}`, borderRadius: 9, background: T.bg, minHeight: 40, boxSizing: "border-box" }}>
                {nf.basis.length === 0 && <span style={{ fontSize: 11.5, color: T.faint, paddingLeft: 3 }}>연결된 근거 조항 없음</span>}
                {nf.basis.map((pid) => (
                  <span key={pid} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: T.chipBg, color: T.sub, fontSize: 12, fontWeight: 600, padding: "3px 6px 3px 9px", borderRadius: 8 }}>
                    {provisions[pid]?.heading || pid}
                    <button onClick={() => setNfField({ basis: nf.basis.filter((x) => x !== pid) })} style={{ border: "none", background: "none", color: T.sub, cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}>×</button>
                  </span>
                ))}
                <select value="" onChange={(e) => { const v = e.target.value; if (v && !nf.basis.includes(v)) setNfField({ basis: [...nf.basis, v] }); }} style={{ ...inputStyle, maxWidth: 260, marginLeft: "auto" }}>
                  <option value="">+ 근거 조항 추가</option>
                  {Object.values(provisions).map((p) => <option key={p.provision_id} value={p.provision_id}>{p.heading} · {p.document_id && p.document_id !== p.document_type ? `${p.document_type}·${p.document_id}` : p.document_type}</option>)}
                </select>
              </div>
            </div>

            {createErr && <div style={{ color: "#DC2626", fontSize: 12, background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "8px 11px" }}>{createErr}</div>}
          </div>

          {/* 푸터 */}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", padding: "13px 18px", borderTop: `1px solid ${T.line}`, background: T.subtle }}>
            <button onClick={() => { setAdding(false); resetNew(); }} disabled={creating}
              style={{ border: `1px solid ${T.line}`, background: T.surface, color: T.sub, borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>취소</button>
            <button onClick={submitNew} disabled={creating}
              style={{ border: "none", background: T.accent, color: "#fff", borderRadius: 8, padding: "8px 20px", cursor: creating ? "default" : "pointer", fontSize: 13, fontWeight: 700, opacity: creating ? 0.6 : 1 }}>{creating ? "추가 중…" : "룰 추가"}</button>
          </div>
        </div>
      )}
      {/* 키워드 검색 */}
      <div style={{ position: "relative", marginBottom: 6 }}>
        <span style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", color: T.faint }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
        </span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} autoFocus
          placeholder="키워드로 룰 찾기 — 예: 원금손실, 녹취, 청약철회, RSK_LOSS"
          style={{ width: "100%", boxSizing: "border-box", padding: "13px 16px 13px 42px", border: `1px solid ${q ? T.accent : T.line}`, borderRadius: 12, fontSize: 15, fontFamily: T.font, outline: "none", background: T.surface, color: T.ink }} />
        {q && <button onClick={() => setQuery("")} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", border: "none", background: "none", color: T.faint, fontSize: 18, cursor: "pointer" }}>×</button>}
      </div>

      {q ? (
        <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "9px 14px", borderBottom: `1px solid ${T.line}`, fontSize: 12, color: T.sub }}>
            <b style={{ color: T.accent }}>{results.length}건</b> 매칭 · "{query}"
          </div>
          {results.map(({ r, kw }, i) => (<div key={r.rule_id} style={{ borderTop: i ? `1px solid ${T.line}` : "none" }}><RuleItem r={r} kw={kw} showProv /></div>))}
          {results.length === 0 && <div style={{ padding: 40, textAlign: "center", color: T.faint, fontSize: 13 }}>매칭되는 룰이 없습니다</div>}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(0, 9fr)", gap: 12, alignItems: "start" }}>
          {/* 6대 판매원칙 사이드바 */}
          <div style={{ position: "sticky", top: 20, alignSelf: "start", display: "flex", flexDirection: "column", gap: 2, background: T.surface, border: `1px solid ${T.line}`, borderRadius: 10, padding: 6, maxHeight: "calc(100vh - 40px)", overflowY: "auto" }}>
            {[["all", "전체", null, rules.length], ...grouped.map(([s, l]) => [s, s, PRINCIPLE_ART[s], l.length])].map(([key, label, art, n]) => {
              const active = stage === key;
              return (
                <button key={key} onClick={() => setStage(key)}
                  style={{ display: "flex", alignItems: "center", gap: 8, border: "none", background: active ? T.accentBg : "transparent", color: active ? T.accent : T.sub, borderRadius: 7, padding: "8px 10px", cursor: "pointer", fontSize: 12.5, fontWeight: active ? 600 : 400, textAlign: "left" }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
                  {art && <span style={{ fontSize: 10, fontWeight: 600, color: active ? T.accent : T.faint, fontFamily: T.mono, opacity: 0.8 }}>{art}</span>}
                  <span style={{ fontSize: 11, fontWeight: 700, color: active ? T.accent : T.faint }}>{n}</span>
                </button>
              );
            })}
          </div>

          {/* 룰 목록 */}
          <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 10, overflow: "hidden" }}>
            {(stage === "all" ? grouped : grouped.filter(([s]) => s === stage)).map(([state, list], gi) => {
              const provs = groupProvs(list);
              const provOpen = openProv.has(state);
              return (
                <div key={state}>
                  <div style={{ position: "sticky", top: 0, zIndex: 1, background: "#475569", borderTop: gi ? `2px solid ${T.surface}` : "none", padding: "8px 14px", fontSize: 12.5, fontWeight: 700, color: "#fff", display: "flex", alignItems: "center", gap: 8 }}>
                    <span>{state}</span>
                    <span style={{ fontSize: 10.5, fontWeight: 600, color: "#CBD5E1", fontFamily: T.mono }}>{PRINCIPLE_ART[state]}</span>
                    {provs.length > 0 && <button onClick={() => toggleGroupProv(state)} style={{ border: "none", background: "rgba(255,255,255,0.18)", color: "#fff", borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>근거 조항 {provs.length} {provOpen ? "▲" : "▼"}</button>}
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#475569", background: "#fff", borderRadius: 10, padding: "1px 8px", marginLeft: "auto" }}>{list.length}</span>
                  </div>
                  {provOpen && (
                    <div style={{ padding: "10px 14px", background: T.subtle, borderBottom: `1px solid ${T.line}`, display: "flex", flexDirection: "column", gap: 6 }}>
                      {provs.map((p) => <ProvCard key={p.provision_id} p={p} />)}
                    </div>
                  )}
                  {list.map((r, i) => (<div key={r.rule_id} style={{ borderTop: i ? `1px solid ${T.line}` : "none" }}><RuleItem r={r} /></div>))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// ST 연동 — RS-2 loadRuleSet (상품 → 룰셋 본문 전체 + 룰별 판정 페이로드 크기)
// ─────────────────────────────────────────────
function LoadView({ products, taxonomy, form, setForm, result, setResult }) {
  const T = useT();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [viewMode, setViewMode] = useState("list");
  const [copied, setCopied] = useState(false);
  const [openId, setOpenId] = useState(null);
  const productId = form.product_id || "";

  // 의미태그 코드 → 한글 라벨
  const tagLabels = taxonomy?.semantic_tags || {};
  const koOf = (t) => tagLabels[t] || "";
  const [selTags, setSelTags] = useState([]); // 호출 시 함께 보낼 태그
  const toggleSel = (t) => setSelTags((cur) => cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]);
  const [tagQuery, setTagQuery] = useState("");
  const tq = tagQuery.trim().toLowerCase();
  const tagMatches = Object.entries(tagLabels).filter(([code, ko]) =>
    !tq || code.toLowerCase().includes(tq) || ko.toLowerCase().includes(tq));

  async function send() {
    if (!productId) return;
    setLoading(true); setError(null); setOpenId(null);
    try { setResult(await loadRuleSet(productId, selTags)); }
    catch (e) { setError(String(e.message || e)); }
    finally { setLoading(false); }
  }
  const budget = result?.budget;
  const shown = result ? result.rules : [];

  // ST → iTrix 전송 페이로드 (JSON) — RuleSet 은 룰(체크리스트 + 근거 조항)만 내려줌 (위반 판정은 iTrix)
  //  · 태그 → 근거조항·출처·체크리스트 를 6대 원칙 기준으로 묶어 전달
  //  · 대화는 ST 가 별도로 붙임. 2000 − 대화여유 500 = 1500자 예산.
  // ST 응답 페이로드 — 태그/조항/체크리스트를 각각 하나의 문자열로 합침 (구분자 " | ", 콤마 미사용)
  const SEP = " | ";
  const uniqueTags = [...new Set(shown.flatMap((r) => ((r.matched_tags?.length ? r.matched_tags : r.required_tags) || [])))].filter((t) => t && t !== "_no_tag");
  const uniqueChecklist = [...new Set(shown.map((r) => r.content).filter(Boolean))];
  const uniqueTexts = result ? [...new Set(shown.flatMap((r) => (r.provisions || []).map((p) => p.text)))] : [];
  const stPayload = result && {
    count: shown.length,
    tags: uniqueTags.join(SEP),
    provisions: uniqueTexts.join(SEP),
    checklist: uniqueChecklist.join(SEP),
  };
  const copyJson = async () => { try { await navigator.clipboard.writeText(JSON.stringify(stPayload, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch {} };

  const tagLine = selTags.length ? `\n  &tags=${selTags.join(",")}` : "";

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.ink }}>ST ↔ RuleSet</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 4fr) minmax(0, 8fr)", gap: 12, alignItems: "start" }}>
        <Card title="요청 (ST → RuleSet)">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 11, color: T.sub }}>상품</span>
              <select value={productId} onChange={(e) => setForm({ product_id: e.target.value })}
                style={{ padding: "9px 10px", border: `1px solid ${T.line}`, borderRadius: 8, fontSize: 13, fontFamily: T.font, background: T.surface, color: T.ink }}>
                <option value="">— 상품 선택 —</option>
                {products.map((p) => <option key={p.product_id} value={p.product_id}>{p.product_name} · {p.product_categories.join("/")}</option>)}
              </select>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: T.sub }}>태그</span>
                {selTags.length > 0 && <button onClick={() => setSelTags([])} style={{ border: "none", background: "none", color: T.accent, fontSize: 11, cursor: "pointer", padding: 0, marginLeft: "auto" }}>{selTags.length}개 해제</button>}
              </div>

              {/* 선택된 태그 칩 */}
              {selTags.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {selTags.map((code) => (
                    <span key={code} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: T.accent, color: "#fff", borderRadius: 14, padding: "3px 6px 3px 9px", fontSize: 11 }}>
                      <span style={{ fontWeight: 600 }}>{koOf(code) || code}</span>
                      <button onClick={() => toggleSel(code)} title="제거"
                        style={{ border: "none", background: "rgba(255,255,255,0.25)", color: "#fff", borderRadius: "50%", width: 15, height: 15, lineHeight: "13px", cursor: "pointer", fontSize: 11, padding: 0 }}>×</button>
                    </span>
                  ))}
                </div>
              )}

              {/* 검색창 */}
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: T.faint }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                </span>
                <input value={tagQuery} onChange={(e) => setTagQuery(e.target.value)}
                  placeholder="태그 검색 — 한글/코드 (예: 고령, RSK)"
                  style={{ width: "100%", boxSizing: "border-box", padding: "8px 30px 8px 32px", border: `1px solid ${T.line}`, borderRadius: 8, fontSize: 12.5, fontFamily: T.font, outline: "none", background: T.surface, color: T.ink }} />
                {tagQuery && <button onClick={() => setTagQuery("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", border: "none", background: "none", color: T.faint, fontSize: 15, cursor: "pointer" }}>×</button>}
              </div>

              {/* 검색 결과 목록 */}
              <div style={{ display: "flex", flexDirection: "column", maxHeight: 168, overflowY: "auto", border: `1px solid ${T.line}`, borderRadius: 8, background: T.surface }}>
                {tagMatches.length === 0 && <div style={{ padding: "14px 10px", textAlign: "center", color: T.faint, fontSize: 12 }}>일치하는 태그가 없습니다</div>}
                {tagMatches.map(([code, ko], i) => {
                  const on = selTags.includes(code);
                  return (
                    <button key={code} onClick={() => toggleSel(code)}
                      style={{ display: "flex", alignItems: "center", gap: 8, border: "none", borderTop: i ? `1px solid ${T.line}` : "none", background: on ? T.accentBg : "transparent", cursor: "pointer", padding: "7px 10px", textAlign: "left", width: "100%" }}>
                      <span style={{ width: 15, height: 15, flexShrink: 0, borderRadius: 4, border: `1.5px solid ${on ? T.accent : T.line}`, background: on ? T.accent : "transparent", color: "#fff", fontSize: 11, lineHeight: "13px", textAlign: "center" }}>{on ? "✓" : ""}</span>
                      <span style={{ fontSize: 12.5, color: on ? T.accent : T.ink, fontWeight: on ? 600 : 400, flex: 1 }}>{ko}</span>
                      <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.faint }}>{code}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 11, color: T.faint, marginBottom: 4 }}>요청</div>
              <pre style={{ margin: 0, background: T.subtle, border: `1px solid ${T.line}`, borderRadius: 8, padding: "10px 12px", fontSize: 12, fontFamily: T.mono, color: T.ink, overflowX: "auto" }}>{`GET /api/ruleset/load\n  ?product_id=${productId || "…"}${tagLine}`}</pre>
            </div>
            <button onClick={send} disabled={loading || !productId}
              style={{ border: "none", background: T.accent, color: "#fff", borderRadius: 8, padding: "10px 0", cursor: loading || !productId ? "default" : "pointer", fontSize: 14, fontWeight: 600, opacity: loading || !productId ? 0.5 : 1 }}>
              {loading ? "로드 중…" : "loadRuleSet 호출"}
            </button>
          </div>
        </Card>

        <Card title="응답 (RuleSet → ST)"
          right={result && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {viewMode === "json" && (
                <button onClick={copyJson} title="JSON 복사"
                  style={{ display: "inline-flex", alignItems: "center", gap: 5, border: `1px solid ${T.line}`, background: T.surface, color: copied ? "#059669" : T.sub, borderRadius: 7, padding: "5px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
                  {copied ? "복사됨" : "복사"}
                </button>
              )}
              <div style={{ display: "flex", gap: 4, background: T.bg, borderRadius: 8, padding: 3 }}>
                {[["list", "목록"], ["json", "JSON"]].map(([m, label]) => (
                  <button key={m} onClick={() => setViewMode(m)}
                    style={{ border: "none", background: viewMode === m ? T.surface : "transparent", color: viewMode === m ? T.accent : T.sub, boxShadow: viewMode === m ? "0 1px 2px rgba(20,26,38,0.08)" : "none", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: m === "json" ? T.mono : T.font }}>{label}</button>
                ))}
              </div>
            </div>
          )}>
          {error && <div style={{ color: "#DC2626", fontSize: 13, padding: "8px 0" }}>로드 실패: {error}</div>}
          {!result && !error && (
            <div style={{ padding: "48px 16px", textAlign: "center", color: T.faint }}>
              <div style={{ fontSize: 30, marginBottom: 8 }}>⇄</div>
              <div style={{ fontSize: 13 }}>상품을 선택하고 loadRuleSet 을 호출하면<br />룰셋 본문 전체가 여기 표시됩니다.</div>
            </div>
          )}
          {result && (
            <div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
                <Badge fg="#047857" bg="#D1FAE5">{result.product?.product_name} · 룰 {result.count}건</Badge>
                {result.requested_tags?.length > 0 && <Badge fg="#5B21B6" bg="#EDE9FE">태그 매칭 {result.count}/{result.total_in_ruleset}건</Badge>}
              </div>
              {budget && <div style={{ fontSize: 11, color: T.faint, marginBottom: 10 }}>{budget.note}</div>}
              {viewMode === "json" ? (
                <pre style={{ margin: 0, background: T.subtle, border: `1px solid ${T.line}`, borderRadius: 8, padding: "12px 14px", fontSize: 12, lineHeight: 1.55, fontFamily: T.mono, color: T.ink, overflowX: "auto", maxHeight: "56vh", overflowY: "auto", whiteSpace: "pre" }}>{JSON.stringify(stPayload, null, 2)}</pre>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 1, maxHeight: "56vh", overflowY: "auto" }}>
                  {shown.length === 0 && <div style={{ padding: "20px 8px", textAlign: "center", color: T.faint, fontSize: 12 }}>매칭되는 룰이 없습니다</div>}
                  {shown.map((r) => {
                    const key = r.rule_id || r.id;
                    return (
                      <div key={key} style={{ borderTop: `1px solid ${T.line}`, padding: "10px 4px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 12.5, fontWeight: 600, color: T.ink, flex: 1 }}>{r.content}</span>
                          {r.principle && <Badge {...principleBadge(r.principle)}>{r.principle}</Badge>}
                        </div>
                        <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 6 }}>
                          {(r.provisions || []).length === 0 && <div style={{ fontSize: 12, color: T.faint }}>연결된 조항이 없습니다</div>}
                          {(r.provisions || []).map((p) => (
                            <div key={p.provision_id} style={{ borderLeft: `3px solid ${DOCTYPE_COLOR[p.document_type] || T.line}`, padding: "7px 11px", background: T.subtle, borderRadius: "0 7px 7px 0" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 3 }}>
                                <span style={{ fontSize: 12.5, fontWeight: 600, color: T.ink }}>{p.heading}</span>
                                <span style={{ fontSize: 10.5, fontWeight: 600, color: DOCTYPE_COLOR[p.document_type] }}>{p.document_id && p.document_id !== p.document_type ? `${p.document_type} · ${p.document_id}` : p.document_type}</span>
                              </div>
                              <p style={{ fontSize: 12.5, lineHeight: 1.65, margin: 0, color: T.sub }}>{p.text}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// 온톨로지 — 그래프DB 스타일 탐색기 (force-directed) + deontic + Cypher/RDF 내보내기
// ─────────────────────────────────────────────
const NODE_COLOR = { provision: "#2D5BE3", tag: "#6D28D9", ruleset: "#0D9488", category: "#0D9488", jury_panel: "#B45309", product: "#0891B2", document: "#5A6577" };
const MOD_COLOR = { Obligation: "#2D5BE3", Prohibition: "#DC2626", Advisory: "#5A6577" };
const EDGE_KO = { CONTAINS: "포함", BASED_ON: "근거", REQUIRES: "요구태그", IN_RULESET: "소속", HAS_CATEGORY: "카테고리", APPLIES_TO: "적용", JUDGED_BY: "판정" };
const NODE_KO = { rule: "룰", provision: "근거 조항", tag: "의미태그", ruleset: "룰셋", category: "카테고리", jury_panel: "배심원단", product: "상품", document: "문서" };
const R_OF = { rule: 10, ruleset: 13, category: 12, provision: 8, tag: 6, jury_panel: 9, document: 11, product: 11 };

// 룰셋 스코프로 부분그래프 추출 (전체는 노드가 많아 기본은 룰셋 단위)
function subgraphForRuleset(graph, rulesetId) {
  if (!graph) return { nodes: [], edges: [] };
  if (rulesetId === "all") return { nodes: graph.nodes, edges: graph.edges };
  const keep = new Set([`rset:${rulesetId}`]);
  const ruleIds = new Set();
  for (const e of graph.edges) if (e.type === "IN_RULESET" && e.target === `rset:${rulesetId}`) ruleIds.add(e.source);
  ruleIds.forEach((id) => keep.add(id));
  for (const e of graph.edges) if (ruleIds.has(e.source)) keep.add(e.target);
  for (const e of graph.edges) if (e.source === `rset:${rulesetId}`) keep.add(e.target);
  for (const e of graph.edges) if (e.type === "CONTAINS" && keep.has(e.target)) keep.add(e.source);
  return {
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}

// Fruchterman–Reingold 힘-기반 레이아웃 (결정적 시드, 라이브러리 없음)
function forceLayout(sub, W = 780, H = 560, iters = 260) {
  const nodes = sub.nodes, N = nodes.length;
  const idx = Object.fromEntries(nodes.map((n, i) => [n.id, i]));
  const pos = nodes.map((_, i) => ({
    x: W / 2 + Math.cos(i * 2.399) * (40 + (i % 9) * 26),
    y: H / 2 + Math.sin(i * 2.399) * (40 + (i % 9) * 26),
  }));
  if (N < 2) return { pos, idx };
  const k = Math.sqrt((W * H) / N) * 0.55;
  const E = sub.edges.map((e) => [idx[e.source], idx[e.target]]).filter(([a, b]) => a != null && b != null);
  let temp = W / 6;
  for (let it = 0; it < iters; it++) {
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      let dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y, d = Math.hypot(dx, dy) || 0.01;
      const f = (k * k) / d, ux = dx / d, uy = dy / d;
      disp[i].x += ux * f; disp[i].y += uy * f; disp[j].x -= ux * f; disp[j].y -= uy * f;
    }
    for (const [a, b] of E) {
      let dx = pos[a].x - pos[b].x, dy = pos[a].y - pos[b].y, d = Math.hypot(dx, dy) || 0.01;
      const f = (d * d) / k, ux = dx / d, uy = dy / d;
      disp[a].x -= ux * f; disp[a].y -= uy * f; disp[b].x += ux * f; disp[b].y += uy * f;
    }
    for (let i = 0; i < N; i++) { disp[i].x += (W / 2 - pos[i].x) * 0.03; disp[i].y += (H / 2 - pos[i].y) * 0.03; }
    for (let i = 0; i < N; i++) {
      let dx = disp[i].x, dy = disp[i].y, d = Math.hypot(dx, dy) || 0.01;
      const lim = Math.min(d, temp);
      pos[i].x += dx / d * lim; pos[i].y += dy / d * lim;
    }
    temp *= 0.965;
  }
  return { pos, idx };
}

function OntologyView({ form, setForm }) {
  const T = useT();
  const [graph, setGraph] = useState(null);
  const [err, setErr] = useState(null);
  const [selected, setSelected] = useState(null);
  const [view, setView] = useState({ tx: 0, ty: 0, s: 1 });
  const drag = useRef(null);

  useEffect(() => { fetchOntology().then(setGraph).catch((e) => setErr(String(e.message || e))); }, []);

  const rulesets = useMemo(() => graph ? graph.nodes.filter((n) => n.type === "ruleset") : [], [graph]);
  const scope = form.scope || rulesets[0]?.id.replace(/^rset:/, "") || "all";
  const sub = useMemo(() => subgraphForRuleset(graph, scope), [graph, scope]);
  const layout = useMemo(() => forceLayout(sub), [sub]);
  const nodeById = useMemo(() => Object.fromEntries((sub.nodes || []).map((n) => [n.id, n])), [sub]);
  const neighbors = useMemo(() => {
    if (!selected) return null;
    const out = [];
    const seen = new Set();
    sub.edges.forEach((e) => {
      const other = e.source === selected ? e.target : e.target === selected ? e.source : null;
      if (!other || seen.has(other)) return;
      seen.add(other);
      out.push({ id: other, edge: e.type });
    });
    return out;
  }, [selected, sub]);
  const neighborIds = useMemo(() => neighbors ? new Set(neighbors.map((n) => n.id)) : null, [neighbors]);

  if (err) return <Centered>온톨로지 로드 실패: {err}</Centered>;
  if (!graph) return <Centered>지식그래프 생성 중…</Centered>;

  const W = 780, H = 560;
  const colorOf = (n) => n.type === "rule" ? (MOD_COLOR[n.modality] || T.sub) : n.type === "provision" ? (DOCTYPE_COLOR[n.document_type] || NODE_COLOR.provision) : (NODE_COLOR[n.type] || T.sub);
  const shortLabel = (n) => {
    if (n.type === "tag") return n.code || n.label;
    if (n.type === "rule") return (n.rule_id || n.id).replace(/^(rule:)?RULE_/, "");
    if (n.type === "jury_panel") return "5배심원";
    const s = n.label || "";
    return s.length > 14 ? s.slice(0, 14) + "…" : s;
  };
  const showLabel = (n) => ["ruleset", "category", "document"].includes(n.type) || selected === n.id || (neighborIds && neighborIds.has(n.id));
  const opac = (id) => (selected && id !== selected && !(neighborIds && neighborIds.has(id))) ? 0.13 : 1;
  const selNode = selected ? nodeById[selected] : null;

  const onDown = (e) => { drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }; };
  const onMove = (e) => { if (!drag.current) return; setView((v) => ({ ...v, tx: drag.current.tx + (e.clientX - drag.current.x), ty: drag.current.ty + (e.clientY - drag.current.y) })); };
  const onUp = () => { drag.current = null; };
  const onWheel = (e) => { setView((v) => ({ ...v, s: Math.min(2.6, Math.max(0.4, v.s * (e.deltaY < 0 ? 1.12 : 0.89))) })); };
  const changeScope = (s) => { setForm({ scope: s }); setSelected(null); setView({ tx: 0, ty: 0, s: 1 }); };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.ink }}>규정 관계도</div>
          <div style={{ fontSize: 12, color: T.faint, marginTop: 2 }}>전체 노드 {graph.stats.nodes} · 엣지 {graph.stats.edges}</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 8fr) minmax(0, 4fr)", gap: 12, alignItems: "start" }}>
        <Card title={`부분그래프 · ${sub.nodes.length} 노드 / ${sub.edges.length} 관계`}
          right={
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <select value={scope} onChange={(e) => changeScope(e.target.value)}
                style={{ padding: "5px 8px", border: `1px solid ${T.line}`, borderRadius: 7, fontSize: 12, fontFamily: T.font, background: T.surface, color: T.ink }}>
                {rulesets.map((rs) => <option key={rs.id} value={rs.id.replace(/^rset:/, "")}>{rs.label}</option>)}
                <option value="all">전체 그래프</option>
              </select>
              {["-", "＋", "⟲"].map((z, i) => (
                <button key={i} onClick={() => setView((v) => i === 2 ? { tx: 0, ty: 0, s: 1 } : { ...v, s: Math.min(2.6, Math.max(0.4, v.s * (i === 1 ? 1.15 : 0.87))) })}
                  style={{ width: 26, height: 26, border: `1px solid ${T.line}`, background: T.surface, color: T.sub, borderRadius: 6, cursor: "pointer", fontSize: 13 }}>{z}</button>
              ))}
            </div>
          }>
          <div onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onWheel={onWheel}
            style={{ border: `1px solid ${T.line}`, borderRadius: 8, background: T.subtle, overflow: "hidden", cursor: drag.current ? "grabbing" : "grab" }}>
            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
              <g transform={`translate(${view.tx} ${view.ty}) scale(${view.s})`}>
                {sub.edges.map((e, i) => {
                  const a = layout.pos[layout.idx[e.source]], b = layout.pos[layout.idx[e.target]];
                  if (!a || !b) return null;
                  const hot = selected && (e.source === selected || e.target === selected);
                  return (
                    <g key={i} opacity={Math.min(opac(e.source), opac(e.target))}>
                      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={hot ? T.accent : T.line} strokeWidth={hot ? 1.6 : 1} />
                      {hot && <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 2} textAnchor="middle" fontSize="8.5" fill={T.faint} fontFamily={T.mono}>{EDGE_KO[e.type]}</text>}
                    </g>
                  );
                })}
                {sub.nodes.map((n) => {
                  const p = layout.pos[layout.idx[n.id]];
                  if (!p) return null;
                  const r = R_OF[n.type] || 7;
                  return (
                    <g key={n.id} opacity={opac(n.id)} style={{ cursor: "pointer" }}
                      onMouseDown={(ev) => ev.stopPropagation()}
                      onClick={() => setSelected(selected === n.id ? null : n.id)}>
                      <circle cx={p.x} cy={p.y} r={r} fill={colorOf(n)} stroke={selected === n.id ? T.ink : "#fff"} strokeWidth={selected === n.id ? 2.5 : 1} />
                      {showLabel(n) && <text x={p.x + r + 3} y={p.y + 3.5} fontSize="9.5" fill={T.ink} fontFamily={n.type === "tag" ? T.mono : T.font}>{shortLabel(n)}</text>}
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>
        </Card>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {selNode ? (
            <Card title="선택 노드">
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
                <span style={{ width: 11, height: 11, borderRadius: 6, background: colorOf(selNode), flexShrink: 0 }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: colorOf(selNode), background: T.subtle, borderRadius: 6, padding: "2px 8px" }}>{NODE_KO[selNode.type] || selNode.type}</span>
                <button onClick={() => setSelected(null)} style={{ marginLeft: "auto", border: "none", background: "transparent", color: T.faint, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }} title="선택 해제">×</button>
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: T.ink, lineHeight: 1.5, marginBottom: 8 }}>{selNode.label}</div>
              {(selNode.modality_ko || selNode.trigger_state || selNode.document_type) && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
                  {selNode.modality_ko && <span style={{ fontSize: 11, fontWeight: 600, color: MOD_COLOR[selNode.modality], background: T.accentBg, borderRadius: 8, padding: "2px 8px" }}>{selNode.modality_ko}</span>}
                  {selNode.trigger_state && <Chip>{selNode.trigger_state}</Chip>}
                  {selNode.document_type && <span style={{ fontSize: 11, color: DOCTYPE_COLOR[selNode.document_type], fontWeight: 600, alignSelf: "center" }}>{selNode.document_type}</span>}
                </div>
              )}
              <div style={{ fontSize: 11, color: T.faint, marginBottom: 6, borderTop: `1px solid ${T.line}`, paddingTop: 9 }}>연결된 항목 {neighbors ? neighbors.length : 0}개</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: "34vh", overflowY: "auto" }}>
                {neighbors && neighbors.map(({ id, edge }) => {
                  const nn = nodeById[id];
                  if (!nn) return null;
                  return (
                    <button key={id} onClick={() => setSelected(id)}
                      style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", textAlign: "left", border: `1px solid ${T.line}`, background: T.surface, borderRadius: 7, padding: "6px 8px", cursor: "pointer" }}>
                      <span style={{ width: 8, height: 8, borderRadius: 4, background: colorOf(nn), flexShrink: 0 }} />
                      <span style={{ fontSize: 11.5, color: T.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: nn.type === "tag" ? T.mono : T.font }}>{shortLabel(nn)}</span>
                      <span style={{ marginLeft: "auto", fontSize: 10, color: T.faint, background: T.subtle, borderRadius: 5, padding: "1px 6px", flexShrink: 0 }}>{EDGE_KO[edge] || edge}</span>
                    </button>
                  );
                })}
                {neighbors && neighbors.length === 0 && <div style={{ fontSize: 11.5, color: T.faint, padding: "4px 0" }}>연결된 항목이 없습니다</div>}
              </div>
            </Card>
          ) : (
            <Card title="deontic 양상 · 룰 노드 색">
              {Object.entries(graph.meta.modality).map(([vt, m]) => (
                <div key={vt} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0" }}>
                  <span style={{ width: 11, height: 11, borderRadius: 6, background: MOD_COLOR[m.code] }} />
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: T.ink }}>{m.ko}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11, color: T.faint, fontFamily: T.mono }}>{vt}</span>
                </div>
              ))}
              <div style={{ fontSize: 11, color: T.faint, marginTop: 8, borderTop: `1px solid ${T.line}`, paddingTop: 8, lineHeight: 1.5 }}>노드를 클릭하면 상세와 연결된 항목이 여기에 표시됩니다.</div>
            </Card>
          )}
          <Card title="노드 타입">
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {Object.entries(graph.stats.by_node_type).filter(([, n]) => n > 0).map(([t, n]) => (
                <div key={t} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 11, height: 11, borderRadius: 6, background: NODE_COLOR[t] || T.sub }} />
                  <span style={{ fontSize: 12.5, color: T.ink, fontWeight: 500 }}>{NODE_KO[t] || t}</span>
                  <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: T.ink, background: T.subtle, borderRadius: 6, padding: "1px 9px" }}>{n}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// 태그 — 태그 사전 브라우저 (그룹별 정리 + 사용 룰)
// ─────────────────────────────────────────────
const TAG_GROUPS = {
  CUST: "고객·소비자", SUIT: "적합성·투자성향", PROD: "상품 설명", RSK: "위험 고지",
  FEE: "수수료·비용", DOC: "서류·교부", CNST: "동의·녹취", CONF: "확인·서명", CTRT: "계약·철회",
};
const GROUP_COLOR = {
  CUST: "#2D5BE3", SUIT: "#0D9488", PROD: "#0891B2", RSK: "#DC2626", FEE: "#B45309",
  DOC: "#6D28D9", CNST: "#9333EA", CONF: "#059669", CTRT: "#4F46E5",
};

function TagsView({ rules, taxonomy, selected, setSelected, onOpen, onCreateTag, onUpdateTag, onDeleteTag }) {
  const T = useT();
  const sem = taxonomy.semantic_tags || {};
  const [tab, setTab] = useState("전체");
  const inputStyle = { padding: "7px 9px", border: `1px solid ${T.line}`, borderRadius: 7, fontSize: 12.5, fontFamily: T.font, background: T.surface, color: T.ink };

  // 태그 관리 (추가/수정/삭제)
  const [managing, setManaging] = useState(false);
  const [adding, setAdding] = useState(false);
  const [nc, setNc] = useState("");
  const [nl, setNl] = useState("");
  const [tagErr, setTagErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editCode, setEditCode] = useState(null);
  const [editLabel, setEditLabel] = useState("");
  const [delCode, setDelCode] = useState(null);

  async function submitAdd() {
    const code = nc.trim().toUpperCase().replace(/\s+/g, "_");
    const label = nl.trim();
    if (!code || !label) { setTagErr("코드와 라벨을 모두 입력하세요"); return; }
    setBusy(true); setTagErr(null);
    try { await onCreateTag({ code, label }); setNc(""); setNl(""); setAdding(false); }
    catch (e) { setTagErr(e?.message || "태그 추가 실패"); }
    finally { setBusy(false); }
  }
  async function saveEdit() {
    const label = editLabel.trim(); if (!label) return;
    setBusy(true); setTagErr(null);
    try { await onUpdateTag(editCode, label); setEditCode(null); }
    catch (e) { setTagErr(e?.message || "수정 실패"); }
    finally { setBusy(false); }
  }
  async function doDeleteTag(code) {
    setBusy(true); setTagErr(null);
    try { await onDeleteTag(code); setDelCode(null); if (selected === code) setSelected(null); }
    catch (e) { setTagErr(e?.message || "삭제 실패"); }
    finally { setBusy(false); }
  }

  const usage = useMemo(() => {
    const m = {};
    rules.forEach((r) => (r.required_tags || []).forEach((t) => (m[t] = (m[t] || 0) + 1)));
    return m;
  }, [rules]);
  const groups = useMemo(() => {
    const g = {};
    Object.entries(sem).forEach(([code, label]) => { const p = code.split("_")[0]; (g[p] ??= []).push({ code, label }); });
    return g;
  }, [sem]);
  const rulesForTag = selected ? rules.filter((r) => (r.required_tags || []).includes(selected)) : [];

  return (
    <div>
      <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.ink }}>태그 목록</div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button onClick={() => { setAdding((v) => !v); setTagErr(null); }}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, border: `1px solid ${adding ? T.accent : T.line}`, background: adding ? T.accentBg : T.surface, color: adding ? T.accent : T.sub, borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>
            <span style={{ fontSize: 14, lineHeight: 1 }}>{adding ? "×" : "+"}</span> 태그 추가
          </button>
          <button onClick={() => { setManaging((v) => !v); setEditCode(null); setDelCode(null); setTagErr(null); }}
            style={{ border: `1px solid ${managing ? T.accent : T.line}`, background: managing ? T.accentBg : T.surface, color: managing ? T.accent : T.sub, borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>
            {managing ? "완료" : "편집"}
          </button>
        </div>
      </div>

      {adding && (
        <div style={{ background: T.surface, border: `1px solid ${T.accent}`, borderRadius: 10, padding: 14, marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.ink, marginBottom: 10 }}>새 태그 추가</div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, width: 200 }}>
              <span style={{ fontSize: 11, color: T.sub }}>코드</span>
              <input value={nc} onChange={(e) => setNc(e.target.value)} placeholder="RSK_LOSS" style={{ ...inputStyle, fontFamily: T.mono, textTransform: "uppercase" }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 200 }}>
              <span style={{ fontSize: 11, color: T.sub }}>라벨</span>
              <input value={nl} onChange={(e) => setNl(e.target.value)} placeholder="원금손실 가능성 고지" style={{ ...inputStyle }} />
            </div>
            <button onClick={submitAdd} disabled={busy}
              style={{ border: "none", background: T.accent, color: "#fff", borderRadius: 8, padding: "8px 16px", cursor: busy ? "default" : "pointer", fontSize: 13, fontWeight: 700, opacity: busy ? 0.6 : 1 }}>{busy ? "추가 중…" : "추가"}</button>
          </div>
        </div>
      )}
      {tagErr && <div style={{ color: "#DC2626", fontSize: 12, marginBottom: 10 }}>{tagErr}</div>}

      {/* 그룹 탭 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14, borderBottom: `1px solid ${T.line}`, paddingBottom: 10 }}>
        {[["전체", null, Object.keys(sem).length], ...Object.entries(groups).map(([p, ts]) => [TAG_GROUPS[p] || p, p, ts.length])].map(([label, key, n]) => {
          const active = tab === (key ?? "전체");
          const gc = key ? (GROUP_COLOR[key] || T.accent) : T.accent;
          return (
            <button key={key ?? "전체"} onClick={() => setTab(key ?? "전체")}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "none", cursor: "pointer",
                background: active ? gc : T.subtle, color: active ? "#fff" : T.sub,
                borderRadius: 8, padding: "6px 11px", fontSize: 12.5, fontWeight: active ? 700 : 500 }}>
              {key && <span style={{ width: 7, height: 7, borderRadius: 2, background: active ? "#fff" : gc }} />}
              {label}
              <span style={{ fontSize: 11, fontWeight: 700, opacity: active ? 0.85 : 0.6 }}>{n}</span>
            </button>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 8fr) minmax(0, 4fr)", gap: 12, alignItems: "start" }}>
        {/* 태그 그룹 — 섹션별 읽기 리스트 (한글 라벨 우선) */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {Object.entries(groups).filter(([prefix]) => tab === "전체" || tab === prefix).map(([prefix, tags]) => {
            const gc = GROUP_COLOR[prefix] || T.accent;
            const gtot = tags.reduce((a, t) => a + (usage[t.code] || 0), 0);
            return (
              <div key={prefix}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 3, background: gc }} />
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: T.ink }}>{TAG_GROUPS[prefix] || prefix}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.faint }}>{prefix}</span>
                </div>
                <div style={{ border: `1px solid ${T.line}`, borderRadius: 10, overflow: "hidden", background: T.surface }}>
                  {tags.map((t, i) => {
                    const n = usage[t.code] || 0;
                    const active = selected === t.code;
                    const editingThis = editCode === t.code;
                    return (
                      <div key={t.code} onClick={() => { if (!managing) setSelected(active ? null : t.code); }}
                        style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", cursor: managing ? "default" : "pointer",
                          borderTop: i ? `1px solid ${T.line}` : "none",
                          borderLeft: `3px solid ${active && !managing ? gc : "transparent"}`,
                          background: active && !managing ? T.accentBg : "transparent" }}
                        onMouseEnter={(e) => { if (!active && !managing) e.currentTarget.style.background = T.subtle; }}
                        onMouseLeave={(e) => { if (!active && !managing) e.currentTarget.style.background = "transparent"; }}>
                        <span style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
                          {editingThis ? (
                            <input value={editLabel} autoFocus onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setEditLabel(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditCode(null); }}
                              style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
                          ) : (
                            <span style={{ fontSize: 13.5, fontWeight: 600, color: T.ink }}>{t.label}</span>
                          )}
                          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.faint }}>{t.code}</span>
                        </span>
                        {!managing ? (
                          <span style={{ fontSize: 11, fontWeight: 700, color: n ? gc : T.faint, background: n ? T.chipBg : "transparent", borderRadius: 20, padding: "2px 9px", whiteSpace: "nowrap", flexShrink: 0 }}>룰 {n}</span>
                        ) : editingThis ? (
                          <span style={{ display: "inline-flex", gap: 6, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                            <button onClick={saveEdit} disabled={busy} style={{ border: "none", background: T.accent, color: "#fff", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 11.5, fontWeight: 700 }}>저장</button>
                            <button onClick={() => setEditCode(null)} disabled={busy} style={{ border: `1px solid ${T.line}`, background: T.surface, color: T.sub, borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 11.5, fontWeight: 600 }}>취소</button>
                          </span>
                        ) : delCode === t.code ? (
                          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                            <span style={{ color: "#DC2626", fontSize: 11.5, fontWeight: 600 }}>삭제?</span>
                            <button onClick={() => doDeleteTag(t.code)} disabled={busy} style={{ border: "none", background: "#DC2626", color: "#fff", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 11.5, fontWeight: 700 }}>삭제</button>
                            <button onClick={() => setDelCode(null)} disabled={busy} style={{ border: `1px solid ${T.line}`, background: T.surface, color: T.sub, borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 11.5, fontWeight: 600 }}>취소</button>
                          </span>
                        ) : (
                          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                            <span style={{ fontSize: 11, color: T.faint }}>룰 {n}</span>
                            <button onClick={() => { setEditCode(t.code); setEditLabel(t.label); }} style={{ border: `1px solid ${T.line}`, background: T.surface, color: T.sub, borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 11.5, fontWeight: 600 }}>수정</button>
                            <button onClick={() => { setDelCode(t.code); setTagErr(null); }} disabled={n > 0} title={n > 0 ? "이 태그를 쓰는 룰이 있어 삭제할 수 없습니다" : ""}
                              style={{ border: `1px solid ${n > 0 ? T.line : "#FCA5A5"}`, background: T.surface, color: n > 0 ? T.faint : "#DC2626", borderRadius: 6, padding: "4px 10px", cursor: n > 0 ? "not-allowed" : "pointer", fontSize: 11.5, fontWeight: 600 }}>삭제</button>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* 사이드: 선택 태그 사용 룰 / 발화행위·패널 (스크롤 시 따라옴) */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, position: "sticky", top: 20, alignSelf: "start", maxHeight: "calc(100vh - 40px)", overflowY: "auto" }}>
          {selected ? (
            <Card title={`${selected} 사용 룰 · ${rulesForTag.length}건`}
              right={<button onClick={() => setSelected(null)} style={{ border: "none", background: "none", color: T.faint, fontSize: 12, cursor: "pointer" }}>해제</button>}>
              <div style={{ fontSize: 12, color: T.sub, marginBottom: 8 }}>{sem[selected]}</div>
              {rulesForTag.length === 0 && <div style={{ fontSize: 12, color: T.faint }}>사용하는 룰이 없습니다</div>}
              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "62vh", overflowY: "auto" }}>
                {rulesForTag.map((r) => (
                  <div key={r.rule_id} style={{ borderLeft: `3px solid ${T.accent}`, background: T.subtle, borderRadius: "0 7px 7px 0", padding: "8px 11px" }}>
                    <div style={{ fontSize: 12.5, lineHeight: 1.6, color: T.ink }}>{r.content}</div>
                    <div style={{ display: "flex", gap: 6, marginTop: 5, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 10.5, color: T.faint }}>{r.meta_category}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : (
            <Card title="태그 선택">
              <div style={{ fontSize: 12, color: T.faint, lineHeight: 1.6 }}>왼쪽에서 태그를 선택하면 해당 태그가 매칭되는 룰이 표시됩니다.</div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// 변경 이력 — change_log (append-only) 타임라인
// ─────────────────────────────────────────────
const ENTITY_KO = { rule: "룰", provision: "조항" };
const ACTION_META = {
  update: { ko: "수정", fg: "#1D4ED8", bg: "#DBEAFE" },
  amend: { ko: "개정", fg: "#B45309", bg: "#FEF3C7" },
  review_clear: { ko: "재검토 완료", fg: "#047857", bg: "#D1FAE5" },
};

function changeSummary(e) {
  if (e.action === "amend" && e.changes && typeof e.changes === "object")
    return `v${e.changes.from} → v${e.changes.to} · 영향 ${(e.changes.affected || []).length}룰`;
  if (e.action === "update" && e.changes && typeof e.changes === "object")
    return `변경 필드: ${Object.keys(e.changes).join(", ")}`;
  if (e.action === "review_clear") return "재검토 완료 처리";
  return "";
}

function HistoryView({ onOpen }) {
  const T = useT();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [ef, setEf] = useState("all"); // entity filter

  useEffect(() => { fetchChangelog({ limit: 500 }).then(setData).catch((e) => setErr(String(e.message || e))); }, []);

  if (err) return <Centered>이력 로드 실패: {err}</Centered>;
  if (!data) return <Centered>변경 이력 불러오는 중…</Centered>;

  const entries = data.entries.filter((e) => ef === "all" || e.entity_type === ef);
  const FILTERS = [["all", "전체"], ["rule", "룰"], ["provision", "조항"]];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.ink }}>변경 이력</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {FILTERS.map(([k, label]) => (
            <button key={k} onClick={() => setEf(k)}
              style={{ border: `1px solid ${ef === k ? T.accent : T.line}`, background: ef === k ? T.accentBg : T.surface, color: ef === k ? T.accent : T.sub, borderRadius: 20, padding: "5px 13px", cursor: "pointer", fontSize: 12, fontWeight: ef === k ? 600 : 400 }}>{label}</button>
          ))}
        </div>
      </div>

      <Card>
        {entries.length === 0 && <div style={{ padding: 32, textAlign: "center", color: T.faint, fontSize: 13 }}>이력이 없습니다</div>}
        <div style={{ display: "flex", flexDirection: "column" }}>
          {entries.map((e, i) => {
            const am = ACTION_META[e.action] || { ko: e.action, fg: T.sub, bg: T.chipBg };
            const openable = e.entity_type === "rule";
            return (
              <div key={e.log_id} onClick={() => openable && onOpen(e.entity_id)}
                style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "11px 6px", borderTop: i ? `1px solid ${T.line}` : "none", cursor: openable ? "pointer" : "default" }}
                onMouseEnter={(ev) => { if (openable) ev.currentTarget.style.background = T.subtle; }}
                onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.faint, minWidth: 128, paddingTop: 1 }}>{(e.at || "").replace("T", " ").slice(0, 19)}</span>
                <div style={{ display: "flex", gap: 5, alignItems: "center", minWidth: 118 }}>
                  <span style={{ fontSize: 10.5, fontWeight: 600, color: T.sub, background: T.chipBg, borderRadius: 6, padding: "1px 6px" }}>{ENTITY_KO[e.entity_type] || e.entity_type}</span>
                  <Badge fg={am.fg} bg={am.bg}>{am.ko}</Badge>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontFamily: T.mono, fontSize: 12, color: T.ink }}>{e.entity_id}</span>
                  <div style={{ fontSize: 12, color: T.sub, marginTop: 2 }}>
                    {changeSummary(e)}{e.reason ? <span style={{ color: T.faint }}> · 사유: {e.reason}</span> : ""}
                  </div>
                </div>
                <span style={{ fontSize: 11, color: T.faint, whiteSpace: "nowrap" }}>{e.actor}</span>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

const Centered = ({ children }) => {
  const T = useT();
  return <div style={{ padding: "80px 24px", textAlign: "center", color: T.sub, fontSize: 14 }}>{children}</div>;
};

// ─────────────────────────────────────────────
// 근거 조항 관리 — 추가 / 삭제 (룰 추가와 분리된 전용 화면)
// ─────────────────────────────────────────────
function ProvisionsView({ provisions, rules, onCreate, onDelete, onEdit }) {
  const T = useT();
  const list = Object.values(provisions);
  const refCount = (pid) => rules.filter((r) => (r.basis || []).includes(pid)).length;
  const provTypes = [...new Set([...list.map((p) => p.document_type).filter(Boolean), "법률", "가이드라인", "내규"])];
  const inputStyle = { width: "100%", boxSizing: "border-box", padding: "7px 9px", border: `1px solid ${T.line}`, borderRadius: 7, fontSize: 12.5, fontFamily: T.font, background: T.surface, color: T.ink };

  const EMPTY = { document_type: "내규", heading: "", text: "" };
  const [pf, setPf] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [busyDel, setBusyDel] = useState(false);
  const [delErr, setDelErr] = useState(null);
  const [filter, setFilter] = useState("");
  // 조항 수정 (인라인)
  const [editId, setEditId] = useState(null);
  const [ef, setEf] = useState({ heading: "", text: "", document_type: "", document_id: "" });
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState(null);

  async function submit() {
    if (!pf.heading.trim() || !pf.text.trim()) { setErr("조항 제목과 원문을 입력하세요"); return; }
    setSaving(true); setErr(null);
    try { await onCreate({ ...pf, heading: pf.heading.trim(), text: pf.text.trim() }); setPf(EMPTY); }
    catch (e) { setErr(e?.message || "추가 실패"); }
    finally { setSaving(false); }
  }
  async function doDelete(pid) {
    setBusyDel(true); setDelErr(null);
    try { await onDelete(pid); setConfirmId(null); }
    catch (e) { setDelErr(e?.message || "삭제 실패"); }
    finally { setBusyDel(false); }
  }
  function startEdit(p) {
    setEditId(p.provision_id); setEditErr(null); setConfirmId(null);
    setEf({ heading: p.heading || "", text: p.text || "", document_type: p.document_type || "내규", document_id: p.document_id || "" });
  }
  async function saveEdit(pid) {
    if (!ef.heading.trim() || !ef.text.trim()) { setEditErr("제목·원문을 입력하세요"); return; }
    setEditBusy(true); setEditErr(null);
    try {
      await onEdit(pid, { heading: ef.heading.trim(), text: ef.text.trim(), document_type: ef.document_type.trim() || "내규", document_id: ef.document_id.trim() || ef.document_type.trim() || "내규" });
      setEditId(null);
    } catch (e) { setEditErr(e?.message || "수정 실패"); }
    finally { setEditBusy(false); }
  }

  const q = filter.trim().toLowerCase();
  const shown = q ? list.filter((p) => `${p.heading}${p.text}${p.provision_id}`.toLowerCase().includes(q)) : list;

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.ink }}>근거 조항</div>
        <div style={{ fontSize: 12, color: T.faint, marginTop: 2 }}>룰의 근거가 되는 법령·가이드라인·내규 조항을 추가·삭제합니다.</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 5fr) minmax(0, 7fr)", gap: 12, alignItems: "start" }}>
        <Card title="새 근거 조항 추가">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 11, color: T.sub }}>유형</span>
              <select value={pf.document_type} onChange={(e) => setPf((f) => ({ ...f, document_type: e.target.value }))}
                style={{ padding: "9px 10px", border: `1px solid ${T.line}`, borderRadius: 8, fontSize: 13, fontFamily: T.font, background: T.surface, color: T.ink }}>
                {provTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 11, color: T.sub }}>제목</span>
              <input value={pf.heading} onChange={(e) => setPf((f) => ({ ...f, heading: e.target.value }))} placeholder="예: 설명의무"
                style={{ padding: "9px 10px", border: `1px solid ${T.line}`, borderRadius: 8, fontSize: 13, fontFamily: T.font, background: T.surface, color: T.ink }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 11, color: T.sub }}>원문</span>
              <textarea value={pf.text} onChange={(e) => setPf((f) => ({ ...f, text: e.target.value }))} rows={5} placeholder="조항 원문"
                style={{ width: "100%", boxSizing: "border-box", padding: "9px 11px", border: `1px solid ${T.line}`, borderRadius: 8, fontSize: 13, fontFamily: T.font, lineHeight: 1.6, resize: "vertical", background: T.surface, color: T.ink }} />
            </div>
            {err && <div style={{ color: "#DC2626", fontSize: 12 }}>{err}</div>}
            <button onClick={submit} disabled={saving}
              style={{ border: "none", background: T.accent, color: "#fff", borderRadius: 8, padding: "10px 0", cursor: saving ? "default" : "pointer", fontSize: 13, fontWeight: 700, opacity: saving ? 0.6 : 1 }}>{saving ? "추가 중…" : "조항 추가"}</button>
          </div>
        </Card>
        <Card title={`조항 목록 · ${list.length}건`}>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="조항 검색"
            style={{ width: "100%", boxSizing: "border-box", padding: "8px 11px", border: `1px solid ${T.line}`, borderRadius: 8, fontSize: 13, fontFamily: T.font, background: T.surface, color: T.ink, marginBottom: 10 }} />
          {delErr && <div style={{ color: "#DC2626", fontSize: 12, marginBottom: 8 }}>{delErr}</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "62vh", overflowY: "auto" }}>
            {shown.map((p) => {
              const used = refCount(p.provision_id);
              const isEditing = editId === p.provision_id;
              return (
                <div key={p.provision_id} style={{ border: `1px solid ${isEditing ? T.accent : T.line}`, borderLeft: `3px solid ${isEditing ? T.accent : (DOCTYPE_COLOR[p.document_type] || T.line)}`, borderRadius: "0 8px 8px 0", padding: "9px 11px", background: T.surface }}>
                  {isEditing ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <span style={{ fontSize: 11, color: T.sub }}>제목</span>
                        <input value={ef.heading} onChange={(e) => setEf({ ...ef, heading: e.target.value })} style={inputStyle} />
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
                          <span style={{ fontSize: 11, color: T.sub }}>유형</span>
                          <select value={ef.document_type} onChange={(e) => setEf({ ...ef, document_type: e.target.value })} style={inputStyle}>
                            {provTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </div>
                        <div style={{ flex: 1.6, display: "flex", flexDirection: "column", gap: 3 }}>
                          <span style={{ fontSize: 11, color: T.sub }}>문서명(출처)</span>
                          <input value={ef.document_id} onChange={(e) => setEf({ ...ef, document_id: e.target.value })} placeholder="예: 금융소비자보호법 / 내규" style={inputStyle} />
                        </div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <span style={{ fontSize: 11, color: T.sub }}>원문</span>
                        <textarea value={ef.text} onChange={(e) => setEf({ ...ef, text: e.target.value })} rows={4} style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }} />
                      </div>
                      {editErr && <div style={{ color: "#DC2626", fontSize: 11.5 }}>{editErr}</div>}
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <button onClick={() => saveEdit(p.provision_id)} disabled={editBusy}
                          style={{ border: "none", background: T.accent, color: "#fff", borderRadius: 7, padding: "6px 14px", cursor: editBusy ? "default" : "pointer", fontSize: 12.5, fontWeight: 700, opacity: editBusy ? 0.6 : 1 }}>{editBusy ? "저장 중…" : "저장"}</button>
                        <button onClick={() => setEditId(null)} disabled={editBusy}
                          style={{ border: `1px solid ${T.line}`, background: T.surface, color: T.sub, borderRadius: 7, padding: "6px 14px", cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>취소</button>
                        <span style={{ marginLeft: "auto", fontSize: 11, color: T.faint }}>v{p.version || "1.0"} 유지</span>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 3 }}>
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: T.ink }}>{p.heading}</span>
                        <span style={{ fontSize: 10.5, fontWeight: 600, color: DOCTYPE_COLOR[p.document_type] }}>{p.document_id && p.document_id !== p.document_type ? `${p.document_type} · ${p.document_id}` : p.document_type}</span>
                      </div>
                      <p style={{ fontSize: 12, lineHeight: 1.6, margin: "0 0 7px", color: T.sub }}>{p.text}</p>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 11, color: T.faint }}>룰 {used}건에서 사용</span>
                        {confirmId === p.provision_id ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
                            <span style={{ color: "#DC2626", fontSize: 11.5, fontWeight: 600 }}>삭제할까요?</span>
                            <button onClick={() => doDelete(p.provision_id)} disabled={busyDel} style={{ border: "none", background: "#DC2626", color: "#fff", borderRadius: 6, padding: "4px 10px", cursor: busyDel ? "default" : "pointer", fontSize: 11.5, fontWeight: 700, opacity: busyDel ? 0.6 : 1 }}>{busyDel ? "삭제 중…" : "삭제"}</button>
                            <button onClick={() => setConfirmId(null)} disabled={busyDel} style={{ border: `1px solid ${T.line}`, background: T.surface, color: T.sub, borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 11.5, fontWeight: 600 }}>취소</button>
                          </span>
                        ) : (
                          <span style={{ display: "inline-flex", gap: 6, marginLeft: "auto" }}>
                            <button onClick={() => startEdit(p)} style={{ border: `1px solid ${T.line}`, background: T.surface, color: T.sub, borderRadius: 7, padding: "4px 10px", cursor: "pointer", fontSize: 11.5, fontWeight: 600 }}>수정</button>
                            <button onClick={() => { setConfirmId(p.provision_id); setDelErr(null); }} disabled={used > 0}
                              title={used > 0 ? "이 조항을 근거로 쓰는 룰이 있어 삭제할 수 없습니다" : ""}
                              style={{ border: `1px solid ${used > 0 ? T.line : "#FCA5A5"}`, background: T.surface, color: used > 0 ? T.faint : "#DC2626", borderRadius: 7, padding: "4px 10px", cursor: used > 0 ? "not-allowed" : "pointer", fontSize: 11.5, fontWeight: 600 }}>삭제</button>
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
            {shown.length === 0 && <div style={{ padding: "24px 8px", textAlign: "center", color: T.faint, fontSize: 12 }}>조항이 없습니다</div>}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// LNB 아이콘 (인라인 SVG)
// ─────────────────────────────────────────────
const Icon = ({ name, color }) => {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: color, strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" };
  if (name === "list") return (<svg {...common}><line x1="8" y1="6" x2="20" y2="6" /><line x1="8" y1="12" x2="20" y2="12" /><line x1="8" y1="18" x2="20" y2="18" /><circle cx="3.5" cy="6" r="1.2" /><circle cx="3.5" cy="12" r="1.2" /><circle cx="3.5" cy="18" r="1.2" /></svg>);
  if (name === "resolve") return (<svg {...common}><path d="M4 8h13l-3-3M20 16H7l3 3" /></svg>);
  if (name === "search") return (<svg {...common}><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>);
  if (name === "graph") return (<svg {...common}><circle cx="5" cy="6" r="2.2" /><circle cx="19" cy="6" r="2.2" /><circle cx="12" cy="18" r="2.2" /><path d="M6.8 7.2 10.5 16M17.2 7.2 13.5 16M6.7 6h10.6" /></svg>);
  if (name === "tag") return (<svg {...common}><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2a2 2 0 0 1-.6-1.4V4.5a1.5 1.5 0 0 1 1.5-1.5h7.5a2 2 0 0 1 1.4.6l7.4 7.4a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r="1.3" /></svg>);
  if (name === "edit") return (<svg {...common}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>);
  if (name === "doc") return (<svg {...common}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" /></svg>);
  if (name === "history") return (<svg {...common}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 8v4l3 2" /></svg>);
  if (name === "sun") return (<svg {...common}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>);
  return (<svg {...common}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>); // moon
};

// ─────────────────────────────────────────────
// 해시 라우팅 (메뉴별 URL · 새로고침 유지)
// ─────────────────────────────────────────────
const SECTION_HASH = { rules: "rulebook", tags: "tags", provisions: "provisions", history: "history", ontology: "ontology", load: "st" };
const HASH_SECTION = Object.fromEntries(Object.entries(SECTION_HASH).map(([k, v]) => [v, k]));
const readSectionFromHash = () => {
  if (typeof window === "undefined") return "rules";
  return HASH_SECTION[window.location.hash.replace(/^#\/?/, "")] || "rules";
};

// ─────────────────────────────────────────────
// 앱 셸 (LNB + 콘텐츠) — 테마 Provider 내부
// ─────────────────────────────────────────────
function AppShell({ mode, setMode }) {
  const T = useT();
  const [bundle, setBundle] = useState(null);
  const [status, setStatus] = useState("loading");

  // 네비게이션 / 뷰 상태 (최상위 보관 → 이동해도 유지)
  const [section, setSection] = useState(readSectionFromHash); // rules | tags | amend | history | ontology | load
  const [selectedRuleId, setSelectedRuleId] = useState(null);
  const [listQuery, setListQuery] = useState("");
  const [loadForm, setLoadForm] = useState({ product_id: "PRODisa000000001" }); // 기본: ISA 중개형
  const [loadResult, setLoadResult] = useState(null);
  const [ontoForm, setOntoForm] = useState({ ruleId: "" });
  const [tagSel, setTagSel] = useState(null);

  async function load() {
    setStatus("loading");
    try {
      setBundle(await fetchBundle());
      setStatus("ready");
    } catch (e) {
      console.error(e);
      setStatus("error");
    }
  }
  useEffect(() => { load(); }, []);

  // 섹션 → URL 해시 동기화
  useEffect(() => {
    const want = `#/${SECTION_HASH[section] || "rulebook"}`;
    if (window.location.hash !== want) window.location.hash = want;
  }, [section]);

  // URL 해시 변경(뒤로가기·직접 입력) → 섹션 반영
  useEffect(() => {
    const onHash = () => {
      const s = readSectionFromHash();
      setSection((cur) => {
        if (s !== cur) setSelectedRuleId(null);
        return s;
      });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // 페이지 배경(테마) 반영
  useEffect(() => {
    document.body.style.margin = "0";
    document.body.style.background = T.bg;
  }, [T.bg]);

  function updateRuleLocal(next) {
    setBundle((b) => ({ ...b, rules: b.rules.map((r) => (r.rule_id === next.rule_id ? next : r)) }));
  }
  async function persistRule(next) {
    const saved = await updateRule(next.rule_id, {
      verification_method: next.verification_method,
      judge_prompt: next.judge_prompt,
      content: next.content,
      required_tags: next.required_tags ?? [],
      speech_act: next.speech_act ?? null,
      jury_panel_id: next.jury_panel_id ?? null,
      threshold: next.threshold ?? null,
      basis: next.basis ?? [],
    });
    updateRuleLocal(saved);
  }
  async function createRuleLocal(payload) {
    const saved = await createRule(payload);
    setBundle((b) => ({ ...b, rules: [...b.rules, saved] }));
    return saved;
  }
  async function createProvisionLocal(payload) {
    const saved = await createProvision(payload);
    setBundle((b) => ({ ...b, provisions: { ...b.provisions, [saved.provision_id]: saved } }));
    return saved;
  }
  async function deleteRuleLocal(ruleId) {
    await deleteRule(ruleId);
    setBundle((b) => ({ ...b, rules: b.rules.filter((r) => r.rule_id !== ruleId) }));
    setSelectedRuleId((cur) => (cur === ruleId ? null : cur));
  }
  async function deleteProvisionLocal(provisionId) {
    await deleteProvision(provisionId);
    setBundle((b) => { const p = { ...b.provisions }; delete p[provisionId]; return { ...b, provisions: p }; });
  }
  async function updateProvisionLocal(provisionId, patch) {
    const saved = await updateProvision(provisionId, patch);
    setBundle((b) => ({ ...b, provisions: { ...b.provisions, [saved.provision_id]: saved } }));
    return saved;
  }
  const setTagLocal = (code, label) => setBundle((b) => ({ ...b, taxonomy: { ...b.taxonomy, semantic_tags: { ...b.taxonomy.semantic_tags, [code]: label } } }));
  async function createTagLocal({ code, label }) { await createTag({ code, label }); setTagLocal(code, label); }
  async function updateTagLocal(code, label) { await updateTag(code, label); setTagLocal(code, label); }
  async function deleteTagLocal(code) {
    await deleteTag(code);
    setBundle((b) => { const s = { ...b.taxonomy.semantic_tags }; delete s[code]; return { ...b, taxonomy: { ...b.taxonomy, semantic_tags: s } }; });
  }

  const goRules = () => { setSection("rules"); setSelectedRuleId(null); };
  const goLoad = () => setSection("load");
  const goOnto = () => setSection("ontology");
  const goTags = () => setSection("tags");
  const goProv = () => setSection("provisions");
  const goHistory = () => setSection("history");
  const openRule = (id) => { setSelectedRuleId(id); setSection("rules"); };

  const NAV = [
    { key: "rules", label: "룰북", icon: "list", onClick: goRules, active: section === "rules" },
    { key: "tags", label: "태그", icon: "tag", onClick: goTags, active: section === "tags" },
    { key: "provisions", label: "근거 조항", icon: "doc", onClick: goProv, active: section === "provisions" },
    { key: "load", label: "ST 연동", icon: "resolve", onClick: goLoad, active: section === "load" },
    { key: "ontology", label: "규정 관계도", icon: "graph", onClick: goOnto, active: section === "ontology" },
    // { key: "history", label: "변경 이력", icon: "history", onClick: goHistory, active: section === "history" },
  ];

  // ── 콘텐츠 ──
  let content;
  if (status === "loading") content = <Centered>데이터를 불러오는 중…</Centered>;
  else if (status === "error")
    content = (
      <Centered>
        <div style={{ marginBottom: 12 }}>백엔드 API에 연결하지 못했습니다.</div>
        <div style={{ fontSize: 12, color: T.faint, marginBottom: 16 }}>backend 서버(:4000)가 실행 중인지 확인하세요.</div>
        <button onClick={load} style={{ border: "none", background: T.accent, color: "#fff", borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>다시 시도</button>
      </Centered>
    );
  else {
    const { provisions, rules, vocabulary, taxonomy, products } = bundle;
    if (section === "tags") {
      content = <TagsView rules={rules} taxonomy={taxonomy} selected={tagSel} setSelected={setTagSel} onOpen={openRule}
        onCreateTag={createTagLocal} onUpdateTag={updateTagLocal} onDeleteTag={deleteTagLocal} />;
    } else if (section === "provisions") {
      content = <ProvisionsView provisions={provisions} rules={rules} onCreate={createProvisionLocal} onDelete={deleteProvisionLocal} onEdit={updateProvisionLocal} />;
    } else if (section === "history") {
      content = <HistoryView onOpen={openRule} />;
    } else if (section === "ontology") {
      content = <OntologyView rules={rules} form={ontoForm} setForm={setOntoForm} />;
    } else if (section === "load") {
      content = <LoadView products={products} taxonomy={taxonomy} form={loadForm} setForm={setLoadForm} result={loadResult} setResult={setLoadResult} />;
    } else {
      content = (
        <ListView rules={rules} provisions={provisions} taxonomy={taxonomy} products={products}
          openId={selectedRuleId} setOpenId={setSelectedRuleId}
          onUpdate={updateRuleLocal} onPersist={persistRule} onCreate={createRuleLocal} onDelete={deleteRuleLocal}
          query={listQuery} setQuery={setListQuery} />
      );
    }
  }

  const navBtn = (item) => (
    <button key={item.key} onClick={item.onClick}
      style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", border: "none", cursor: "pointer",
        background: item.active ? T.accentBg : "transparent", color: item.active ? T.accent : T.sub,
        borderRadius: 9, padding: "10px 12px", fontSize: 13.5, fontWeight: item.active ? 600 : 500, textAlign: "left" }}>
      <Icon name={item.icon} color={item.active ? T.accent : T.faint} />
      {item.label}
    </button>
  );

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: T.bg, color: T.ink, fontFamily: T.font }}>
      {/* LNB */}
      <aside style={{ width: 224, flexShrink: 0, boxSizing: "border-box", position: "sticky", top: 0, height: "100vh", maxHeight: "100vh", overflowY: "auto", background: T.surface, borderRight: `1px solid ${T.line}`, display: "flex", flexDirection: "column", padding: "18px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "2px 6px 18px" }}>
          <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 8, background: T.accent, color: "#fff", fontSize: 15, fontWeight: 800 }}>W</span>
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
            <span style={{ fontSize: 14.5, fontWeight: 700, color: T.ink }}>WiseAegis</span>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: T.accent, letterSpacing: 0.2 }}>Ruleset</span>
          </div>
        </div>

        <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>{NAV.map(navBtn)}</nav>

        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          <button onClick={() => setMode(mode === "dark" ? "light" : "dark")}
            style={{ display: "flex", alignItems: "center", gap: 8, border: `1px solid ${T.line}`, background: T.subtle, color: T.sub, borderRadius: 9, padding: "9px 12px", cursor: "pointer", fontSize: 13, fontWeight: 500 }}>
            <Icon name={mode === "dark" ? "sun" : "moon"} color={T.sub} />
            {mode === "dark" ? "라이트 모드" : "다크 모드"}
          </button>
        </div>
      </aside>

      {/* 콘텐츠 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <main style={{ maxWidth: 1120, margin: "0 auto", padding: "24px 28px 56px" }}>{content}</main>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// 루트 — 테마 상태 + Provider
// ─────────────────────────────────────────────
export default function RulesetConsole() {
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem("wa-theme") === "dark" ? "dark" : "light"; } catch { return "light"; }
  });
  useEffect(() => {
    try { localStorage.setItem("wa-theme", mode); } catch {}
  }, [mode]);

  return (
    <ThemeCtx.Provider value={makeTheme(mode)}>
      <AppShell mode={mode} setMode={setMode} />
    </ThemeCtx.Provider>
  );
}
