import { useState, useEffect } from "react";
import { sGet, sSet, sDeleteMany } from "../lib/storage";

const SK = {
  cards: "medstudy:cards",
  questions: "medstudy:questions",
  concepts: "medstudy:concepts",
  sources: "medstudy:sources",
  professors: "medstudy:professors",
  exams: "medstudy:exams",
};

const SUBJECT_SUGGESTIONS = [
  "해부학", "생리학", "생화학", "약리학", "병리학",
  "미생물학", "면역학", "예방의학", "내과학", "외과학",
  "산부인과학", "소아과학", "정신건강의학", "신경과학",
  "영상의학", "마취과학", "기타",
];

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ─────────────────────────────────────────
// Phase 7A: Standardized 7-Intent System
// ─────────────────────────────────────────
const VALID_INTENTS = [
  "definition",
  "mechanism",
  "symptom_or_result",
  "comparison",
  "location_or_structure",
  "sequence_or_step",
  "identification",
];

// Map legacy/non-standard intent labels → canonical 7
const INTENT_LEGACY_MAP = {
  general: "definition",
  symptom: "symptom_or_result",
  diagnosis: "identification",
  treatment: "mechanism",
  complication: "symptom_or_result",
  anatomy: "location_or_structure",
  classification: "comparison",
  step: "sequence_or_step",
  structure: "location_or_structure",
};

const SOURCE_TYPE_OPTIONS = [
  { value: "past_exam", label: "기출 문제" },
  { value: "slide", label: "강의 슬라이드" },
  { value: "note", label: "필기 노트" },
  { value: "textbook", label: "교과서" },
  { value: "manual", label: "직접 입력" },
];

const SOURCE_TYPE_WEIGHTS = {
  past_exam: 5,
  slide: 3,
  note: 2,
  textbook: 1,
  manual: 1,
};

function normalizeIntent(raw) {
  if (!raw) return "definition";
  if (VALID_INTENTS.includes(raw)) return raw;
  return INTENT_LEGACY_MAP[raw] || "definition";
}

// Generate ingestion batch ID (shared across a single save session)
const INGESTION_BATCH_ID = uid();

const C = {
  bg:         "#161210",
  surface:    "#1e1c18",
  surface2:   "#252219",
  border:     "#2a2720",
  text:       "#f0ebe0",
  muted:      "#6b6256",
  primary:    "#a07850",
  success:    "#6aac5c",
  danger:     "#d4745a",
  warning:    "#c4963a",
  paper:      "#f8f3ea",
  paperText:  "#2c2520",
  paperMuted: "#8a7f6e",
  dangerBg:   "#3d1f1a",
  successBg:  "#1a2e1c",
  primaryBg:  "#2a2218",
};
const FONT_HEADING = "'Playfair Display', Georgia, serif";
const FONT_BODY    = "'Noto Sans KR', 'Apple SD Gothic Neo', sans-serif";

const S = {
  card: {
    background:   C.surface,
    borderRadius: 14,
    border:       `1px solid ${C.border}`,
    padding:      "18px 20px",
    marginBottom: 10,
  },
  flashcard: {
    background:   C.paper,
    borderRadius: 20,
    border:       "none",
    padding:      "32px 28px 24px",
    marginBottom: 14,
  },
  cardInset: {
    background:   C.surface2,
    borderRadius: 10,
    border:       `1px solid ${C.border}`,
    padding:      "10px 14px",
    marginBottom: 8,
  },
  btn: (v = "primary") => ({
    padding:      "11px 20px",
    borderRadius: 10,
    border:       "none",
    cursor:       "pointer",
    fontWeight:   700,
    fontSize:     13,
    fontFamily:   FONT_BODY,
    letterSpacing:"0.04em",
    transition:   "filter 0.12s, transform 0.06s",
    background:
      v === "primary" ? C.primary :
      v === "success" ? C.successBg :
      v === "danger"  ? C.dangerBg :
      C.surface2,
    color:
      v === "primary" ? "#1a1108" :
      v === "success" ? C.success :
      v === "danger"  ? C.danger  :
      C.text,
  }),
  btnAction: (v = "forgot") => ({
    flex:          1,
    padding:       "16px 8px",
    borderRadius:  14,
    border:        "none",
    cursor:        "pointer",
    fontFamily:    FONT_BODY,
    fontWeight:    700,
    fontSize:      12,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    display:       "flex",
    flexDirection: "column",
    alignItems:    "center",
    gap:           6,
    background:    v === "forgot" ? C.dangerBg  : C.successBg,
    color:         v === "forgot" ? C.danger     : C.success,
  }),
  input: {
    background:  C.surface2,
    border:      `1px solid ${C.border}`,
    borderRadius: 10,
    padding:     "9px 14px",
    color:       C.text,
    fontSize:    14,
    fontFamily:  FONT_BODY,
    width:       "100%",
    boxSizing:   "border-box",
    outline:     "none",
  },
  label: {
    fontSize:      11,
    color:         C.muted,
    marginBottom:  4,
    display:       "block",
    fontWeight:    700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    fontFamily:    FONT_BODY,
  },
  badge: (col = C.primary) => {
    const bg =
      col === C.danger  ? C.dangerBg  :
      col === C.success ? C.successBg :
      col === C.primary ? C.primaryBg :
      col + "22";
    return {
      background:    bg,
      color:         col,
      padding:       "3px 9px",
      borderRadius:  6,
      fontSize:      10,
      fontWeight:    700,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      display:       "inline-block",
      fontFamily:    FONT_BODY,
    };
  },
  badgePaper: (col = "#b84a2e", bg = "#f5e0da") => ({
    background:    bg,
    color:         col,
    padding:       "3px 9px",
    borderRadius:  6,
    fontSize:      10,
    fontWeight:    700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    display:       "inline-block",
    fontFamily:    FONT_BODY,
  }),
  sectionLabel: {
    fontSize:      10,
    fontWeight:    700,
    color:         C.muted,
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    marginBottom:  8,
    display:       "block",
    fontFamily:    FONT_BODY,
  },
};

const TEMPLATE_FIELDS = {
  anatomy: ["structure", "function", "innervation", "bloodSupply", "clinicalCorrelation"],
  physiology: ["concept", "mechanism", "regulation", "clinicalCorrelation"],
  biochemistry: ["pathway", "keyEnzyme", "rateLimitingStep", "regulation", "clinicalCorrelation"],
  pharmacology: ["drug", "mechanism", "indication", "adverseEffects", "contraindications"],
  pathology: ["definition", "cause", "characteristics", "differentiation"],
  general: [],
};

export default function CardInjectorApp() {
  const [tab, setTab] = useState("card");
  const [toast, setToast] = useState(null);
  const [exams, setExams] = useState([]);
  const [professors, setProfessors] = useState([]);

  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Noto+Sans+KR:wght@400;500;700&display=swap";
    document.head.appendChild(link);
  }, []);

  useEffect(() => {
    async function load() {
      const [e, p] = await Promise.all([sGet(SK.exams), sGet(SK.professors)]);
      setExams(e || []);
      setProfessors(p || []);
    }
    load();
  }, []);

  function showToast(msg, type = "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  const navTabs = [["card", "카드 주입"], ["question", "문제 주입"], ["json_bulk", "JSON 일괄입력"], ["image_link", "이미지 URL 연결"], ["migrate", "마이그레이션"]];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: FONT_BODY }}>
      <div style={{ background: "#1f1a16", borderBottom: `1px solid ${C.border}`, padding: "12px 20px" }}>
        <div style={{ fontFamily: FONT_HEADING, fontWeight: 700, fontSize: 17, color: "#e8e0d4" }}>카드/문제 주입기</div>
      </div>

      {toast && (
        <div style={{ position: "fixed", top: 60, right: 20, zIndex: 999, padding: "10px 16px", borderRadius: 10, background: toast.type === "error" ? C.dangerBg : C.successBg, color: toast.type === "error" ? C.danger : C.success, fontWeight: 700, fontSize: 13, border: `1px solid ${toast.type === "error" ? C.danger : C.success}`, fontFamily: FONT_BODY }}>
          {toast.msg}
        </div>
      )}

      <div style={{ display: "flex", overflowX: "auto", background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "0 4px" }}>
        {navTabs.map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={{ padding: "10px 18px", background: "none", border: "none", cursor: "pointer", color: tab === t ? C.primary : C.text, fontWeight: tab === t ? 700 : 500, borderBottom: `2px solid ${tab === t ? C.primary : "transparent"}`, fontSize: 13 }}>
            {label}
          </button>
        ))}
      </div>

      <div style={{ maxWidth: 700, margin: "0 auto", padding: 20 }}>
        {tab === "card" && <CardInjector showToast={showToast} exams={exams} professors={professors} />}
        {tab === "question" && <QuestionInjector showToast={showToast} exams={exams} professors={professors} />}
        {tab === "json_bulk" && <JsonBulkPanel showToast={showToast} />}
        {tab === "image_link" && <ImageLinkPanel showToast={showToast} />}
        {tab === "migrate" && <MigratePanel showToast={showToast} exams={exams} professors={professors} />}
      </div>
    </div>
  );
}

function toSubjectSlug(subject) {
  const map = {
    해부학: "anatomy",
    생리학: "physiology",
    생화학: "biochemistry",
    약리학: "pharmacology",
    병리학: "pathology",
    미생물학: "microbiology",
    기타: "general",
  };
  return map[subject] || "general";
}

function toConfidence(value) {
  const raw = (value || "").toString().toUpperCase();
  if (raw === "HIGH") return "high";
  if (raw === "MEDIUM") return "medium";
  return "none";
}

function JsonBulkPanel({ showToast }) {
  const [jsonText, setJsonText] = useState("");
  const [subject, setSubject] = useState("해부학");
  const [sourceType, setSourceType] = useState("manual");
  const [preview, setPreview] = useState(null);

  function buildPreview() {
    try {
      const parsed = JSON.parse(jsonText || "[]");
      if (!Array.isArray(parsed)) throw new Error("배열(JSON Array) 형식이어야 합니다.");
      const qCount = parsed.filter(x => x.raw_question || x.options).length;
      const cCount = parsed.filter(x => x.front || (x.type === "subjective")).length;
      setPreview({ total: parsed.length, questions: qCount, cards: cCount });
    } catch (e) {
      showToast(`미리보기 실패: ${e.message}`, "error");
    }
  }

  async function saveBulk() {
    try {
      const parsed = JSON.parse(jsonText || "[]");
      if (!Array.isArray(parsed)) throw new Error("배열(JSON Array) 형식이어야 합니다.");
      const batchId = `json_bulk_${Date.now().toString(36)}`;
      const subjectSlug = toSubjectSlug(subject);
      const questions = (await sGet(SK.questions)) || [];
      const cards = (await sGet(SK.cards)) || [];
      const existingQ = new Set(questions.map(q => (q.raw_question || "").trim()));
      const existingC = new Set(cards.map(c => (c.front || "").trim()));
      const newQuestions = [];
      const newCards = [];

      for (const item of parsed) {
        const hasQuestionShape = !!(item.raw_question || item.options || item.type === "objective");
        if (hasQuestionShape) {
          const rawQuestion = item.raw_question || "";
          if (!rawQuestion.trim() || existingQ.has(rawQuestion.trim())) continue;
          const canonicalAnswer = item.canonicalAnswer ?? null;
          const confidence = toConfidence(item.confidence);
          newQuestions.push({
            id: uid(),
            raw_question: rawQuestion,
            parsed_question: rawQuestion,
            options: Array.isArray(item.options) ? item.options : [],
            canonicalAnswer,
            type: "objective",
            status: confidence === "none" ? "unverified" : "confirmed",
            confidence,
            confirmed_source: "ai_user",
            question_intent: "definition",
            occurrence_key: [subjectSlug, "manual_bulk", sourceType].join("|"),
            source_signature: ["", "definition", (canonicalAnswer || "").slice(0, 40)].join("||"),
            explanations: { quick: "", professor: null, textbook: null, extra: null },
            image_present: !!item.image_present,
            image_ref: item.image_ref || null,
            image_url: item.image_url || null,
            primary_concept_id: null,
            tags: [sourceType, subjectSlug],
            source_type: sourceType,
            subject,
            ingestion_batch_id: batchId,
            createdAt: new Date().toISOString(),
          });
          existingQ.add(rawQuestion.trim());
          continue;
        }

        const front = item.front || item.raw_question || "";
        if (!front.trim() || existingC.has(front.trim())) continue;
        newCards.push({
          id: uid(),
          front,
          back: item.back || item.canonicalAnswer || "",
          subject: item.subject || subject,
          chapter: "",
          templateType: "general",
          tier: "active",
          source_type: item.source_type || sourceType,
          image_present: !!item.image_present,
          image_ref: item.image_ref || null,
          image_url: item.image_url || null,
          tags: [item.source_type || sourceType, subjectSlug],
          ingestion_batch_id: batchId,
          createdAt: new Date().toISOString(),
        });
        existingC.add(front.trim());
      }

      if (newQuestions.length > 0) await sSet(SK.questions, [...questions, ...newQuestions]);
      if (newCards.length > 0) await sSet(SK.cards, [...cards, ...newCards]);
      showToast(`저장 완료: 문제 ${newQuestions.length}개 / 카드 ${newCards.length}개`);
    } catch (e) {
      showToast(`저장 실패: ${e.message}`, "error");
    }
  }

  return (
    <div>
      <h3 style={{ margin: "0 0 16px", color: C.primary }}>JSON 일괄입력</h3>
      <div style={S.card}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div>
            <label style={S.label}>과목 override</label>
            <input
              style={S.input}
              list="subject-list-bulk"
              value={subject}
              placeholder="예: 해부학, 내과학, 직접 입력 가능"
              onChange={e => setSubject(e.target.value)}
            />
            <datalist id="subject-list-bulk">
              {SUBJECT_SUGGESTIONS.map(s => <option key={s} value={s} />)}
            </datalist>
          </div>
          <div>
            <label style={S.label}>source_type override</label>
            <select style={S.input} value={sourceType} onChange={e => setSourceType(e.target.value)}>
              {SOURCE_TYPE_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label} ({opt.value})</option>)}
            </select>
          </div>
        </div>
        <label style={S.label}>JSON 입력</label>
        <textarea style={{ ...S.input, height: 220, resize: "vertical", marginBottom: 12 }} value={jsonText} onChange={e => setJsonText(e.target.value)} />
        <div style={{ display: "flex", gap: 8 }}>
          <button style={S.btn("default")} onClick={buildPreview}>미리보기</button>
          <button style={S.btn("success")} onClick={saveBulk}>저장</button>
        </div>
        {preview && <div style={{ marginTop: 10, fontSize: 12, color: C.muted }}>총 {preview.total}건 · 문제 {preview.questions}건 · 카드 {preview.cards}건</div>}
      </div>
    </div>
  );
}

function ImageLinkPanel({ showToast }) {
  const [mappingText, setMappingText] = useState("{\n  \"p003_i01\": \"https://...\"\n}");

  async function connectImages() {
    try {
      const mapping = JSON.parse(mappingText || "{}");
      const questions = (await sGet(SK.questions)) || [];
      const cards = (await sGet(SK.cards)) || [];
      let linked = 0;
      const newQ = questions.map(q => {
        const url = q.image_ref && mapping[q.image_ref];
        if (!url) return q;
        linked += 1;
        return { ...q, image_url: url, image_present: true };
      });
      const newC = cards.map(c => {
        const url = c.image_ref && mapping[c.image_ref];
        if (!url) return c;
        linked += 1;
        return { ...c, image_url: url, image_present: true };
      });
      await sSet(SK.questions, newQ);
      await sSet(SK.cards, newC);
      showToast(`${linked}개 항목에 image_url 연결됨`);
    } catch (e) {
      showToast(`연결 실패: ${e.message}`, "error");
    }
  }

  return (
    <div>
      <h3 style={{ margin: "0 0 16px", color: C.primary }}>이미지 URL 연결</h3>
      <div style={S.card}>
        <label style={S.label}>image_ref → image_url 매핑 JSON</label>
        <textarea style={{ ...S.input, height: 180, resize: "vertical", marginBottom: 12 }} value={mappingText} onChange={e => setMappingText(e.target.value)} />
        <button style={S.btn("success")} onClick={connectImages}>연결 실행</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────
// CardInjector
// ─────────────────────────────────────────
function CardInjector({ showToast, exams, professors }) {
  const blank = {
    subject: "", chapter: "", front: "", back: "",
    templateType: "anatomy", conceptId: "", tier: "active",
    source_type: "manual",
    tags: "", sourceId: "", examId: "", professorId: "",
    templateFields: {},
    image_url: "", image_ref: "",
  };
  const [form, setForm] = useState(blank);
  const fields = TEMPLATE_FIELDS[form.templateType] || [];

  async function save() {
    if (!form.subject.trim()) { showToast("과목명을 입력하세요.", "error"); return; }
    if (!form.front || !form.back) { showToast("앞면과 뒷면은 필수입니다.", "error"); return; }
    const cards = (await sGet(SK.cards)) || [];
    let concepts = (await sGet(SK.concepts)) || [];

    let conceptId = form.conceptId.trim().replace(/\s+/g, "_");
    if (conceptId) {
      const exists = concepts.find(c => c.id === conceptId);
      if (!exists) {
        // Auto-create stub concept
        concepts.push({
          id: conceptId,
          primaryLabel: conceptId,
          secondaryLabel: "",
          aliases: [],
          linkedConceptIds: [],
          subject: form.subject,
          topics: [form.chapter].filter(Boolean),
          linkedCardIds: [],
          linkedQuestionIds: [],
          explanations: { quick: "", detailed: "", pastExam: "", textbook: "" },
          importance: 0,
          tier: form.tier || "active",
          stub: true,
          needs_review: true,
          created_from: "injector",
          createdAt: new Date().toISOString(),
        });
        await sSet(SK.concepts, concepts);
      }
    }

    const card = {
      id: uid(),
      primary_concept_id: conceptId || null,
      conceptId: conceptId || null,  // legacy compat
      linked_concepts: [],
      subject: form.subject,
      chapter: form.chapter,
      front: form.front,
      back: form.back,
      templateType: form.templateType,
      templateFields: form.templateFields,
      source_type: form.source_type || "manual",
      tags: form.tags.split(",").map(t => t.trim()).filter(Boolean),
      tier: form.tier,
      sourceIds: form.sourceId ? [form.sourceId] : [],
      examId: form.examId || null,
      professorId: form.professorId || null,
      image_url: form.image_url.trim() || null,
      image_ref: form.image_ref.trim() || null,
      image_present: !!(form.image_url.trim()),
      importance: SOURCE_TYPE_WEIGHTS[form.source_type] || 1,
      state: "new",
      ingestion_batch_id: INGESTION_BATCH_ID,  // Phase 7A: batch traceability
      createdAt: new Date().toISOString(),
    };

    await sSet(SK.cards, [...cards, card]);
    showToast("카드 저장됨 ✓");
    setForm(blank);
  }

  return (
    <div>
      <h3 style={{ margin: "0 0 16px", color: C.primary }}>카드 주입</h3>
      <div style={S.card}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div>
            <label style={S.label}>과목</label>
            <>
              <input
                style={S.input}
                list="subject-list-card"
                value={form.subject}
                placeholder="예: 해부학, 내과학, 직접 입력 가능"
                onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
              />
              <datalist id="subject-list-card">
                {SUBJECT_SUGGESTIONS.map(s => <option key={s} value={s} />)}
              </datalist>
            </>
          </div>
          <div>
            <label style={S.label}>템플릿</label>
            <select style={S.input} value={form.templateType} onChange={e => setForm(f => ({ ...f, templateType: e.target.value, templateFields: {} }))}>
              {Object.keys(TEMPLATE_FIELDS).map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={S.label}>챕터 / 단원</label>
          <input style={S.input} value={form.chapter} placeholder="예: 상지" onChange={e => setForm(f => ({ ...f, chapter: e.target.value }))} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={S.label}>앞면 (질문) *</label>
          <textarea style={{ ...S.input, height: 70, resize: "vertical" }} value={form.front} onChange={e => setForm(f => ({ ...f, front: e.target.value }))} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={S.label}>뒷면 (정답) *</label>
          <textarea style={{ ...S.input, height: 70, resize: "vertical" }} value={form.back} onChange={e => setForm(f => ({ ...f, back: e.target.value }))} />
        </div>

        {fields.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>템플릿 필드 ({form.templateType})</label>
            {fields.map(field => (
              <div key={field} style={{ marginBottom: 6 }}>
                <label style={{ ...S.label, color: C.muted }}>{field}</label>
                <input style={S.input} value={form.templateFields[field] || ""} onChange={e => setForm(f => ({ ...f, templateFields: { ...f.templateFields, [field]: e.target.value } }))} />
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div>
            <label style={S.label}>Tier</label>
            <select style={S.input} value={form.tier} onChange={e => setForm(f => ({ ...f, tier: e.target.value }))}>
              <option value="active">T1 - Active</option>
              <option value="passive">T2 - Passive</option>
              <option value="search-only">T3 - Search only</option>
            </select>
          </div>
          <div>
            <label style={S.label}>개념 ID (conceptId)</label>
            <input style={S.input} value={form.conceptId} placeholder="예: radial_nerve" onChange={e => setForm(f => ({ ...f, conceptId: e.target.value }))} />
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={S.label}>출처 유형</label>
          <select style={S.input} value={form.source_type} onChange={e => setForm(f => ({ ...f, source_type: e.target.value }))}>
            {SOURCE_TYPE_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label} ({opt.value})</option>)}
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={S.label}>태그 (쉼표 구분)</label>
          <input style={S.input} value={form.tags} placeholder="예: 기출, 중요, 신경" onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} />
        </div>

        {/* Image fields */}
        <div style={{ background: C.surface2, borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: C.primary, fontWeight: 600, marginBottom: 8 }}>🖼️ 이미지 (선택)</div>
          <div style={{ marginBottom: 8 }}>
            <label style={S.label}>이미지 URL (Supabase public URL 붙여넣기)</label>
            <input style={S.input} value={form.image_url} placeholder="https://...supabase.co/storage/v1/object/public/..." onChange={e => setForm(f => ({ ...f, image_url: e.target.value }))} />
          </div>
          <div>
            <label style={S.label}>이미지 참조명 (선택, 예: p003_i01)</label>
            <input style={S.input} value={form.image_ref} placeholder="예: p003_i01" onChange={e => setForm(f => ({ ...f, image_ref: e.target.value }))} />
          </div>
          {form.image_url.trim() && (
            <div style={{ marginTop: 8, fontSize: 11, color: C.success }}>✓ image_present = true 자동 설정됨</div>
          )}
        </div>

        {/* Exam/Professor Connection */}
        {(exams.length > 0 || professors.length > 0) && (
          <div style={{ background: C.surface2, borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: C.warning, fontWeight: 600, marginBottom: 8 }}>📎 시험·교수 연결</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {exams.length > 0 && (
                <div>
                  <label style={S.label}>연결 시험</label>
                  <select style={S.input} value={form.examId} onChange={e => setForm(f => ({ ...f, examId: e.target.value }))}>
                    <option value="">없음</option>
                    {exams.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                </div>
              )}
              {professors.length > 0 && (
                <div>
                  <label style={S.label}>연결 교수</label>
                  <select style={S.input} value={form.professorId} onChange={e => setForm(f => ({ ...f, professorId: e.target.value }))}>
                    <option value="">없음</option>
                    {professors.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              )}
            </div>
          </div>
        )}

        <button style={S.btn("success")} onClick={save}>카드 저장</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────
// QuestionInjector
// ─────────────────────────────────────────
function QuestionInjector({ showToast, exams, professors }) {
  const blank = {
    subject: "", type: "mcq", rawQuestion: "", parsedQuestion: "",
    options: [{ text: "", correct: false }, { text: "", correct: false }, { text: "", correct: false }, { text: "", correct: false }, { text: "", correct: false }],
    explanation: "", status: "confirmed", examId: "", professorId: "",
    examYear: "", isOriginalExam: true, tags: "",
    questionIntent: "definition", conceptId: "",
    source_type: "past_exam",
    sourceExplanation: "",
    image_url: "", image_ref: "",
  };
  const [form, setForm] = useState(blank);

  function setOption(i, field, value) {
    const opts = form.options.map((o, idx) => {
      if (field === "correct") return { ...o, correct: idx === i };
      return idx === i ? { ...o, [field]: value } : o;
    });
    setForm(f => ({ ...f, options: opts }));
  }

  async function save() {
    if (!form.subject.trim()) { showToast("과목명을 입력하세요.", "error"); return; }
    if (!form.rawQuestion) { showToast("원본 문제는 필수입니다.", "error"); return; }
    if (form.type === "mcq") {
      const hasCorrect = form.options.some(o => o.correct);
      if (!hasCorrect) { showToast("정답 선지를 표시하세요.", "error"); return; }
    }
    const questions = (await sGet(SK.questions)) || [];
    const sources = (await sGet(SK.sources)) || [];

    let srcId = null;
    if (form.examYear || form.isOriginalExam) {
      const src = { id: uid(), filename: form.examYear ? `${form.examYear}년 기출` : "기출", type: "past_exam", subject: form.subject, professorId: form.professorId || null, examId: form.examId || null, uploadDate: new Date().toISOString(), parseStatus: "completed", cardGeneration: false, questionGeneration: true, createdAt: new Date().toISOString() };
      srcId = src.id;
      await sSet(SK.sources, [...sources, src]);
    }

    const conceptId = (form.conceptId || "").trim().replace(/\s+/g, "_") || null;

    // Phase 7A: Normalize intent to standard 7-category system
    const normalizedIntent = normalizeIntent(form.questionIntent);

    // Build Phase 5.5 / 7A fields
    const occurrenceKey = [form.examYear, form.examId, form.professorId, srcId].filter(Boolean).join("|") || "manual";
    const canonicalAnswer = form.options.find(o => o.correct) ? (form.options.find(o => o.correct).text) : "";
    const canonicalAnswerKey = canonicalAnswer.toLowerCase().trim().slice(0, 40);

    // Phase 7A: Strict duplicate logic
    // A. TRUE DUPLICATE: same concept + same year + same examId + same intent + same canonicalAnswer
    // B. FREQUENT OCCURRENCE: same concept + same intent + same canonicalAnswer, but different year or examId
    // C. SAME CONCEPT, DIFFERENT INTENT: same concept, different intent → separate question

    const examYear = form.examYear || "";
    const examId = form.examId || "";

    let duplicateLevel = null;
    let familyId = null;

    if (conceptId) {
      const sameConceptQs = questions.filter(q =>
        q.primary_concept_id === conceptId &&
        q.status === "confirmed"
      );

      // Check TRUE DUPLICATE: same year + same examUnit + same intent + same answer
      const trueDup = sameConceptQs.find(q => {
        const sameYear = examYear && (q.examYear || "") === examYear;
        const sameExam = examId && (q.examId || "") === examId;
        const sameIntent = (q.question_intent || "definition") === normalizedIntent;
        const sameAnswer = (q.canonicalAnswer || "").toLowerCase().trim().slice(0, 40) === canonicalAnswerKey;
        return (sameYear || sameExam) && sameIntent && sameAnswer;
      });

      if (trueDup) {
        // Reject: this is a true duplicate (same exam context)
        showToast(`⚠️ 동일 문제 감지 (true_duplicate: 같은 연도·시험 출처). 저장 안 됨.`, "error");
        return;
      }

      // Check FREQUENT OCCURRENCE: different year/exam, but same concept+intent+answer
      const freqOcc = sameConceptQs.find(q => {
        const sameIntent = (q.question_intent || "definition") === normalizedIntent;
        const sameAnswer = (q.canonicalAnswer || "").toLowerCase().trim().slice(0, 40) === canonicalAnswerKey;
        if (!sameIntent || !sameAnswer) return false;
        // Different year OR different exam = frequent occurrence
        const diffYear = !examYear || (q.examYear || "") !== examYear;
        const diffExam = !examId || (q.examId || "") !== examId;
        return diffYear || diffExam;
      });

      if (freqOcc) {
        duplicateLevel = "frequent_occurrence";
        familyId = freqOcc.question_family_id || freqOcc.id;
      } else {
        // Check SAME CONCEPT, DIFFERENT INTENT
        const sameConceptDiffIntent = sameConceptQs.find(q =>
          (q.question_intent || "definition") !== normalizedIntent
        );
        if (sameConceptDiffIntent) {
          duplicateLevel = "same_concept_diff_intent";
          familyId = sameConceptDiffIntent.question_family_id || sameConceptDiffIntent.id;
        }
      }
    }

    // Derive confirmed_source from form context
    const confirmedSource = form.isOriginalExam ? "official" : "user";

    // Source signature: concept + normalized_intent + canonical_answer (for metadata/reference only)
    const sourceSignature = [conceptId || "", normalizedIntent, canonicalAnswerKey].join("||");

    const q = {
      id: uid(), primary_concept_id: conceptId, linked_concepts: [],
      subject: form.subject, type: form.type,
      raw_question: form.rawQuestion,
      parsed_question: form.parsedQuestion || form.rawQuestion,
      options: form.type === "mcq" ? form.options.filter(o => o.text.trim()) : [],
      canonicalAnswer,
      acceptedVariants: [],
      explanations: { quick: form.explanation, source: form.sourceExplanation || "", professor: null, textbook: null, extra: null },
      status: form.status, confidence: form.status === "confirmed" ? "high" : "low",
      confirmationSource: form.status === "confirmed" ? "manual" : "unverified",
      // Phase 7A: confirmed_source metadata (official | user | ai_user)
      confirmed_source: confirmedSource,
      confirmationHistory: [],
      answer_history: [],
      needs_review: false,
      review_reason: null,
      sourceId: srcId,
      isOriginalExam: form.isOriginalExam,
      examYear: form.examYear,
      professorId: form.professorId || null,
      examId: form.examId || null,
      source_type: form.source_type || "past_exam",
      tags: form.tags.split(",").map(t => t.trim()).filter(Boolean),
      importance: SOURCE_TYPE_WEIGHTS[form.source_type || "past_exam"] || 1,
      difficulty: 0,
      parseConfidence: "high", parseStatus: "completed",
      // Phase 5.5 / 7A fields
      question_intent: normalizedIntent,
      question_family_id: familyId,
      duplicate_level: duplicateLevel,
      occurrence_key: occurrenceKey,
      source_signature: sourceSignature,
      // Phase 7A: ingestion tracking
      ingestion_batch_id: INGESTION_BATCH_ID,
      image_url: form.image_url.trim() || null,
      image_ref: form.image_ref.trim() || null,
      image_present: !!(form.image_url.trim()),
      createdAt: new Date().toISOString(),
    };

    await sSet(SK.questions, [...questions, q]);
    const msg = duplicateLevel === "frequent_occurrence"
      ? `문제 저장됨 ✓ (frequent_occurrence: 중요도 반영)`
      : duplicateLevel === "same_concept_diff_intent"
      ? `문제 저장됨 ✓ (같은 개념, 다른 의도)`
      : "문제 저장됨 ✓";
    showToast(msg);
    setForm(blank);
  }

  return (
    <div>
      <h3 style={{ margin: "0 0 16px", color: C.primary }}>문제 주입</h3>
      <div style={S.card}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div>
            <label style={S.label}>과목</label>
            <>
              <input
                style={S.input}
                list="subject-list-question"
                value={form.subject}
                placeholder="예: 해부학, 내과학, 직접 입력 가능"
                onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
              />
              <datalist id="subject-list-question">
                {SUBJECT_SUGGESTIONS.map(s => <option key={s} value={s} />)}
              </datalist>
            </>
          </div>
          <div>
            <label style={S.label}>문제 유형</label>
            <select style={S.input} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
              <option value="mcq">MCQ (객관식)</option>
              <option value="ox">O/X</option>
              <option value="short">단답형</option>
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={S.label}>원본 문제 (raw_question) *</label>
          <textarea style={{ ...S.input, height: 90, resize: "vertical" }} value={form.rawQuestion} placeholder="원본 그대로 붙여넣기" onChange={e => setForm(f => ({ ...f, rawQuestion: e.target.value }))} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={S.label}>정제된 문제 (parsed_question) — 비워두면 원본 사용</label>
          <textarea style={{ ...S.input, height: 70, resize: "vertical" }} value={form.parsedQuestion} placeholder="선택 사항" onChange={e => setForm(f => ({ ...f, parsedQuestion: e.target.value }))} />
        </div>

        {form.type === "mcq" && (
          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>선지 (정답 라디오 선택)</label>
            {form.options.map((opt, i) => (
              <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
                <input type="radio" name="correct" checked={opt.correct} onChange={() => setOption(i, "correct", true)} style={{ cursor: "pointer", accentColor: C.success }} />
                <span style={{ color: C.muted, fontSize: 13, minWidth: 20 }}>{["①","②","③","④","⑤"][i]}</span>
                <input style={{ ...S.input, flex: 1 }} value={opt.text} placeholder={`선지 ${i + 1}`} onChange={e => setOption(i, "text", e.target.value)} />
              </div>
            ))}
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <label style={S.label}>해설 (quick)</label>
          <textarea style={{ ...S.input, height: 60, resize: "vertical" }} value={form.explanation} onChange={e => setForm(f => ({ ...f, explanation: e.target.value }))} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={S.label}>원문 보존 (source explanation)</label>
          <textarea style={{ ...S.input, height: 60, resize: "vertical" }} value={form.sourceExplanation || ""} placeholder="원문 그대로 보존 (선택)" onChange={e => setForm(f => ({ ...f, sourceExplanation: e.target.value }))} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div>
            <label style={S.label}>확인 상태</label>
            <select style={S.input} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
              <option value="confirmed">confirmed (출제 O)</option>
              <option value="unverified">unverified (출제 X)</option>
              <option value="conflict">conflict (충돌)</option>
              <option value="unstable_parse">unstable_parse (파싱불안정)</option>
            </select>
          </div>
          <div>
            <label style={S.label}>출제 연도</label>
            <input style={S.input} value={form.examYear} placeholder="예: 2024" onChange={e => setForm(f => ({ ...f, examYear: e.target.value }))} />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div>
            <label style={S.label}>문제 의도 (question_intent)</label>
            <select style={S.input} value={form.questionIntent} onChange={e => setForm(f => ({ ...f, questionIntent: e.target.value }))}>
              {VALID_INTENTS.map(v => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={S.label}>개념 ID (conceptId)</label>
            <input style={S.input} value={form.conceptId} placeholder="예: radial_nerve" onChange={e => setForm(f => ({ ...f, conceptId: e.target.value }))} />
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={S.label}>출처 유형</label>
          <select style={S.input} value={form.source_type} onChange={e => setForm(f => ({ ...f, source_type: e.target.value }))}>
            {SOURCE_TYPE_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label} ({opt.value})</option>)}
          </select>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={S.label}>태그 (쉼표 구분)</label>
          <input style={S.input} value={form.tags} placeholder="예: 기출, 신경, 중요" onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} />
        </div>

        {/* Image fields */}
        <div style={{ background: C.surface2, borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: C.primary, fontWeight: 600, marginBottom: 8 }}>🖼️ 이미지 (선택)</div>
          <div style={{ marginBottom: 8 }}>
            <label style={S.label}>이미지 URL (Supabase public URL 붙여넣기)</label>
            <input style={S.input} value={form.image_url} placeholder="https://...supabase.co/storage/v1/object/public/..." onChange={e => setForm(f => ({ ...f, image_url: e.target.value }))} />
          </div>
          <div>
            <label style={S.label}>이미지 참조명 (선택, 예: p003_i01)</label>
            <input style={S.input} value={form.image_ref} placeholder="예: p003_i01" onChange={e => setForm(f => ({ ...f, image_ref: e.target.value }))} />
          </div>
          {form.image_url.trim() && (
            <div style={{ marginTop: 8, fontSize: 11, color: C.success }}>✓ image_present = true 자동 설정됨</div>
          )}
        </div>

        {(exams.length > 0 || professors.length > 0) && (
          <div style={{ background: C.surface2, borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: C.warning, fontWeight: 600, marginBottom: 8 }}>📎 시험·교수 연결</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {exams.length > 0 && (
                <div>
                  <label style={S.label}>연결 시험</label>
                  <select style={S.input} value={form.examId} onChange={e => setForm(f => ({ ...f, examId: e.target.value }))}>
                    <option value="">없음</option>
                    {exams.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                </div>
              )}
              {professors.length > 0 && (
                <div>
                  <label style={S.label}>연결 교수</label>
                  <select style={S.input} value={form.professorId} onChange={e => setForm(f => ({ ...f, professorId: e.target.value }))}>
                    <option value="">없음</option>
                    {professors.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              )}
            </div>
          </div>
        )}

        <button style={S.btn("success")} onClick={save}>문제 저장</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────
// MigratePanel
// ─────────────────────────────────────────
function MigratePanel({ showToast, exams, professors }) {
  const [stats, setStats] = useState(null);

  useEffect(() => { loadStats(); }, []);

  async function loadStats() {
    const [cards, questions, legacy, srs, rl] = await Promise.all([
      sGet(SK.cards), sGet(SK.questions), sGet("medstudy:custom-quiz"), sGet("medstudy:srs"), sGet("medstudy:review-log"),
    ]);
    setStats({
      cards: (cards || []).length,
      questions: (questions || []).length,
      confirmed: (questions || []).filter(q => q.status === "confirmed").length,
      legacy: (legacy || []).length,
      srs: Object.keys(srs || {}).length,
      reviewLog: (rl || []).length,
      exams: exams.length,
      professors: professors.length,
    });
  }

  async function migrate() {
    const legacy = await sGet("medstudy:custom-quiz");
    if (!legacy || legacy.length === 0) { showToast("마이그레이션할 데이터 없음", "error"); return; }
    await sSet("medstudy:backup-custom-quiz", legacy);
    const existing = (await sGet(SK.questions)) || [];
    // Phase 7A: single batch ID traces the entire migration run
    const batchId = "injector_migrate_" + Date.now().toString(36);
    const migrated = legacy.map(q => {
      const canonicalAnswer = q.answer || q.canonicalAnswer || "";
      const canonicalAnswerKey = canonicalAnswer.toLowerCase().trim().slice(0, 40);
      const occurrenceKey = [q.examYear, q.examId, q.professorId].filter(Boolean).join("|") || "legacy";
      // Phase 7A: normalize intent at migration time — eliminates "general" writes to storage
      const normalizedIntent = normalizeIntent(q.question_intent || q.questionIntent);
      const primaryConceptId = q.primary_concept_id || q.conceptId || null;
      // Phase 7A: source_signature uses normalized intent so duplicate detection works correctly
      const sourceSignature = [primaryConceptId || "", normalizedIntent, canonicalAnswerKey].join("||");
      return {
        id: q.id || uid(), subject: q.subject || "", type: q.type || "mcq",
        raw_question: q.raw_question || q.question || JSON.stringify(q),
        parsed_question: q.question || q.parsed_question || "",
        options: q.options || [],
        canonicalAnswer,
        acceptedVariants: q.acceptedVariants || [],
        explanations: { quick: q.explanation || "", professor: null, textbook: null, extra: null },
        status: "confirmed", confidence: "medium",
        confirmationSource: "legacy",
        confirmed_source: "official",          // Phase 7A: legacy exam data treated as official
        confirmationHistory: [], answer_history: [], needs_review: false, review_reason: null,
        primary_concept_id: primaryConceptId,
        sourceId: null,
        tags: q.tags || [], importance: 0,
        // Phase 7A: fully normalized fields
        question_intent: normalizedIntent,
        question_family_id: null,
        duplicate_level: null,
        occurrence_key: occurrenceKey,
        source_signature: sourceSignature,
        ingestion_batch_id: batchId,           // Phase 7A: file-level traceability
        createdAt: q.createdAt || new Date().toISOString(),
      };
    });
    await sSet(SK.questions, [...existing, ...migrated]);
    showToast(`${migrated.length}개 마이그레이션 완료`);
    loadStats();
  }

  async function resetAll() {
    if (!window.confirm("모든 데이터를 초기화합니다. 계속하시겠습니까?")) return;
    await sDeleteMany([...Object.values(SK), "medstudy:srs", "medstudy:review-log", "medstudy:quiz-history", "medstudy:custom-quiz"]);
    showToast("초기화 완료");
    loadStats();
  }

  return (
    <div>
      <h3 style={{ margin: "0 0 16px", color: C.primary }}>마이그레이션</h3>
      {stats && (
        <div style={S.card}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>스토리지 현황</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: C.muted }}>
            <span>카드: {stats.cards}개</span>
            <span>문제: {stats.questions}개 (확인: {stats.confirmed})</span>
            <span>SRS 데이터: {stats.srs}개</span>
            <span>리뷰 로그: {stats.reviewLog}건</span>
            <span>시험: {stats.exams}개</span>
            <span>교수: {stats.professors}명</span>
            {stats.legacy > 0 && <span style={{ color: C.warning }}>구 custom-quiz: {stats.legacy}개</span>}
          </div>
        </div>
      )}

      {stats && stats.legacy > 0 && (
        <div style={S.card}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: C.warning }}>⚠️ 구 custom-quiz 데이터 발견</div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>{stats.legacy}개를 medstudy:questions로 이전합니다. 백업은 자동 생성됩니다.</div>
          <button style={S.btn("success")} onClick={migrate}>마이그레이션 실행</button>
        </div>
      )}

      <div style={{ ...S.card, borderLeft: `3px solid ${C.danger}` }}>
        <div style={{ fontWeight: 600, marginBottom: 6, color: C.danger }}>⚠️ 전체 초기화</div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>모든 카드·문제·SRS·로그 데이터를 삭제합니다. 복구 불가.</div>
        <button style={S.btn("danger")} onClick={resetAll}>전체 초기화</button>
      </div>
    </div>
  );
}
