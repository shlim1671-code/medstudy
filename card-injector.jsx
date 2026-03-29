import { useState, useEffect } from "react";

const SK = {
  cards: "medstudy:cards",
  questions: "medstudy:questions",
  concepts: "medstudy:concepts",
  sources: "medstudy:sources",
  professors: "medstudy:professors",
  exams: "medstudy:exams",
};

async function sGet(key) {
  try { const r = await window.storage.get(key); return r ? JSON.parse(r.value) : null; }
  catch(e) { return null; }
}
async function sSet(key, val) {
  try { await window.storage.set(key, JSON.stringify(val)); } catch(e) {}
}
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

function normalizeIntent(raw) {
  if (!raw) return "definition";
  if (VALID_INTENTS.includes(raw)) return raw;
  return INTENT_LEGACY_MAP[raw] || "definition";
}

// Generate ingestion batch ID (shared across a single save session)
const INGESTION_BATCH_ID = uid();

const C = {
  bg: "#141c28", surface: "#1e2d42", border: "#304060",
  text: "#e4edf8", muted: "#92a4be",
  primary: "#6aafe6", success: "#5dc87e", danger: "#e07070", warning: "#cdb94a",
};
const S = {
  card: { background: C.surface, borderRadius: 10, border: `1px solid ${C.border}`, padding: 16, marginBottom: 12 },
  btn: (v = "primary") => ({ padding: "9px 18px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 13, background: v === "primary" ? C.primary : v === "success" ? C.success : v === "danger" ? C.danger : "#263350", color: (v === "default") ? C.text : "#111a28" }),
  input: { background: "#263350", border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 14, width: "100%", boxSizing: "border-box" },
  label: { fontSize: 12, color: C.muted, marginBottom: 4, display: "block", fontWeight: 500 },
};

const TEMPLATE_FIELDS = {
  anatomy: ["structure", "function", "innervation", "bloodSupply", "clinicalCorrelation"],
  physiology: ["concept", "mechanism", "regulation", "clinicalCorrelation"],
  biochemistry: ["pathway", "keyEnzyme", "rateLimitingStep", "regulation", "clinicalCorrelation"],
  pharmacology: ["drug", "mechanism", "indication", "adverseEffects", "contraindications"],
  pathology: ["definition", "cause", "characteristics", "differentiation"],
  general: [],
};

export default function App() {
  const [tab, setTab] = useState("card");
  const [toast, setToast] = useState(null);
  const [exams, setExams] = useState([]);
  const [professors, setProfessors] = useState([]);

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

  const navTabs = [["card", "카드 주입"], ["question", "문제 주입"], ["migrate", "마이그레이션"]];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "12px 20px" }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: C.primary }}>카드/문제 주입기</div>
      </div>

      {toast && (
        <div style={{ position: "fixed", top: 20, right: 20, zIndex: 999, padding: "10px 16px", borderRadius: 8, background: toast.type === "error" ? C.danger : C.success, color: "#1a1f2e", fontWeight: 600, fontSize: 14 }}>
          {toast.msg}
        </div>
      )}

      <div style={{ display: "flex", background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        {navTabs.map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={{ padding: "10px 18px", background: "none", border: "none", cursor: "pointer", color: tab === t ? C.primary : C.muted, fontWeight: tab === t ? 700 : 400, borderBottom: `2px solid ${tab === t ? C.primary : "transparent"}`, fontSize: 13 }}>
            {label}
          </button>
        ))}
      </div>

      <div style={{ maxWidth: 700, margin: "0 auto", padding: 20 }}>
        {tab === "card" && <CardInjector showToast={showToast} exams={exams} professors={professors} />}
        {tab === "question" && <QuestionInjector showToast={showToast} exams={exams} professors={professors} />}
        {tab === "migrate" && <MigratePanel showToast={showToast} exams={exams} professors={professors} />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────
// CardInjector
// ─────────────────────────────────────────
function CardInjector({ showToast, exams, professors }) {
  const blank = {
    subject: "해부학", chapter: "", front: "", back: "",
    templateType: "anatomy", conceptId: "", tier: "active",
    tags: "", sourceId: "", examId: "", professorId: "",
    templateFields: {},
    image_url: "", image_ref: "",
  };
  const [form, setForm] = useState(blank);
  const fields = TEMPLATE_FIELDS[form.templateType] || [];

  async function save() {
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
      tags: form.tags.split(",").map(t => t.trim()).filter(Boolean),
      tier: form.tier,
      sourceIds: form.sourceId ? [form.sourceId] : [],
      examId: form.examId || null,
      professorId: form.professorId || null,
      image_url: form.image_url.trim() || null,
      image_ref: form.image_ref.trim() || null,
      image_present: !!(form.image_url.trim()),
      importance: 0,
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
            <select style={S.input} value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}>
              {["해부학","생리학","생화학","약리학","병리학","미생물학","기타"].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
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
          <label style={S.label}>태그 (쉼표 구분)</label>
          <input style={S.input} value={form.tags} placeholder="예: 기출, 중요, 신경" onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} />
        </div>

        {/* Image fields */}
        <div style={{ background: "#252d3d", borderRadius: 8, padding: 12, marginBottom: 12 }}>
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
          <div style={{ background: "#252d3d", borderRadius: 8, padding: 12, marginBottom: 12 }}>
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
    subject: "해부학", type: "mcq", rawQuestion: "", parsedQuestion: "",
    options: [{ text: "", correct: false }, { text: "", correct: false }, { text: "", correct: false }, { text: "", correct: false }, { text: "", correct: false }],
    explanation: "", status: "confirmed", examId: "", professorId: "",
    examYear: "", isOriginalExam: true, tags: "",
    questionIntent: "definition", conceptId: "",
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
      explanations: { quick: form.explanation, professor: null, textbook: null, extra: null },
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
      tags: form.tags.split(",").map(t => t.trim()).filter(Boolean),
      importance: 0, difficulty: 0,
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
            <select style={S.input} value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}>
              {["해부학","생리학","생화학","약리학","병리학","미생물학","기타"].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
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
          <label style={S.label}>해설</label>
          <textarea style={{ ...S.input, height: 60, resize: "vertical" }} value={form.explanation} onChange={e => setForm(f => ({ ...f, explanation: e.target.value }))} />
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
          <label style={S.label}>태그 (쉼표 구분)</label>
          <input style={S.input} value={form.tags} placeholder="예: 기출, 신경, 중요" onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} />
        </div>

        {/* Image fields */}
        <div style={{ background: "#252d3d", borderRadius: 8, padding: 12, marginBottom: 12 }}>
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
          <div style={{ background: "#252d3d", borderRadius: 8, padding: 12, marginBottom: 12 }}>
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
    await Promise.all(Object.values(SK).map(key => window.storage.delete(key).catch(e => {})));
    await window.storage.delete("medstudy:srs").catch(e => {});
    await window.storage.delete("medstudy:review-log").catch(e => {});
    await window.storage.delete("medstudy:quiz-history").catch(e => {});
    await window.storage.delete("medstudy:custom-quiz").catch(e => {});
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
