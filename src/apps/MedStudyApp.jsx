import { useState, useEffect } from "react";
import { sGet, sSet } from "../lib/storage";

// ─────────────────────────────────────────
// Storage Keys
// ─────────────────────────────────────────
const SK = {
  cards: "medstudy:cards",
  questions: "medstudy:questions",
  professors: "medstudy:professors",
  srs: "medstudy:srs",
  reviewLog: "medstudy:review-log",
  quizHistory: "medstudy:quiz-history",
  exams: "medstudy:exams",
  concepts: "medstudy:concepts",
  sources: "medstudy:sources",
  legacyQuiz: "medstudy:custom-quiz",
  confusionClusters: "medstudy:confusion-clusters",
};

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─────────────────────────────────────────
// Phase 7A: Standardized 7-Intent System
// ─────────────────────────────────────────
const VALID_INTENTS_7 = [
  "definition","mechanism","symptom_or_result","comparison",
  "location_or_structure","sequence_or_step","identification",
];
const INTENT_LEGACY_MAP_7 = {
  general: "definition", symptom: "symptom_or_result",
  diagnosis: "identification", treatment: "mechanism",
  complication: "symptom_or_result", anatomy: "location_or_structure",
  classification: "comparison", step: "sequence_or_step",
  structure: "location_or_structure",
};
function normalizeIntent(raw) {
  if (!raw) return "definition";
  if (VALID_INTENTS_7.includes(raw)) return raw;
  return INTENT_LEGACY_MAP_7[raw] || "definition";
}

const SOURCE_TYPE_WEIGHTS = {
  past_exam: 5,
  slide: 3,
  note: 2,
  textbook: 1,
  manual: 1,
};
const SOURCE_TYPE_LABELS = {
  past_exam: "기출",
  slide: "슬라이드",
  note: "노트",
  textbook: "교과서",
  manual: "직접입력",
};
const SUBJECT_SLUG_MAP = {
  해부학: "anatomy",
  생리학: "physiology",
  생화학: "biochemistry",
  약리학: "pharmacology",
  병리학: "pathology",
  미생물학: "microbiology",
  기타: "general",
};

const PDF_PARSE_PROMPT = `
You are a strict data extraction engine.
Your ONLY goal is to convert raw exam text into structured JSON.

ABSOLUTE PROHIBITIONS:
- DO NOT explain anything
- DO NOT solve questions
- DO NOT generate reasoning or knowledge
- DO NOT modify wording

For each question extract:
- raw_question: full original text exactly
- options: array of {text, correct} — correct only if answer given
- canonicalAnswer: exact answer text if given, else null
- type: "objective" or "subjective"
- image_present: true if [IMAGE pXXX_iYY] marker exists
- image_ref: marker ID (e.g. "p003_i01"), else null
- confidence: HIGH (explicit answer) / MEDIUM (implied) / NONE (no answer)

SHARED STEM RULE: duplicate full shared stem into EACH question.

Return ONLY valid JSON array. No markdown, no explanation.
`.trim();

function normalizeConfidence(raw) {
  const v = (raw || "").toString().toUpperCase();
  if (v === "HIGH") return "high";
  if (v === "MEDIUM") return "medium";
  return "none";
}

function safeJsonArrayFromText(text) {
  const cleaned = (text || "").trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error("Gemini 응답이 JSON 배열이 아닙니다.");
  return parsed;
}

function inferSourceTypeFromTags(tags = []) {
  const lowered = tags.map(t => (t || "").toLowerCase());
  if (lowered.some(t => t.includes("기출") || t.includes("past"))) return "past_exam";
  if (lowered.some(t => t.includes("슬라이드") || t.includes("slide"))) return "slide";
  if (lowered.some(t => t.includes("노트") || t.includes("note"))) return "note";
  if (lowered.some(t => t.includes("교과서") || t.includes("textbook"))) return "textbook";
  return "manual";
}

function getSourceWeight(card) {
  const explicit = card?.source_type;
  if (explicit && SOURCE_TYPE_WEIGHTS[explicit]) return SOURCE_TYPE_WEIGHTS[explicit];
  const inferred = inferSourceTypeFromTags(card?.tags || []);
  return SOURCE_TYPE_WEIGHTS[inferred] || 1;
}

function daysUntil(dateStr) {
  return Math.ceil((new Date(dateStr) - new Date()) / 86400000);
}

function sm2Update(srs, grade) {
  let { ef = 2.5, interval = 0, repetition = 0 } = (srs || {});
  if (grade < 2) {
    repetition = 0; interval = 1;
  } else {
    interval = repetition === 0 ? 1 : repetition === 1 ? 6 : Math.round(interval * ef);
    repetition += 1;
  }
  ef = Math.max(1.3, ef + 0.1 - (3 - grade) * (0.08 + (3 - grade) * 0.02));
  const next = new Date();
  next.setDate(next.getDate() + interval);
  // Card state: new → learning → reviewing → mastered
  let state = "new";
  if (repetition >= 1 && interval < 7) state = "learning";
  else if (repetition >= 2 && interval < 21) state = "reviewing";
  else if (repetition >= 3 && ef >= 2.5 && interval >= 21) state = "mastered";
  return { ef, interval, repetition, nextReview: next.toISOString(), lastReview: new Date().toISOString(), state };
}

// ─────────────────────────────────────────
// Phase 4: Importance Score Engine
// importance = Base × SourceWeight × Frequency × ErrorWeight × Recency
// ─────────────────────────────────────────

function calcImportance(card, reviewLog, questions = [], confusionClusters = []) {
  const tags = (card.tags || []).map(t => t.toLowerCase());
  const sourceWeight = getSourceWeight(card);

  // Phase 7A — Frequency: count DISTINCT occurrences (different year/exam)
  // - exact_duplicate: do NOT count (same exam, same occurrence_key)
  // - frequent_occurrence: DO count (re-examined in a different year/exam)
  // - Guard: deduplicate by occurrence_key so same-file re-uploads don't inflate
  let distinctOccurrences = 1;
  if (card.primary_concept_id && questions.length > 0) {
    const linked = questions.filter(q =>
      q.primary_concept_id === card.primary_concept_id &&
      q.status === "confirmed" &&
      q.duplicate_level !== "exact_duplicate"         // strip true duplicates
    );
    const occKeys = new Set();
    linked.forEach(q => {
      const key = q.occurrence_key ||
        [q.examYear, q.examId, q.professorId].filter(Boolean).join("|");
      if (key && key !== "unknown" && key !== "manual" && key !== "legacy") {
        occKeys.add(key);
      }
    });
    distinctOccurrences = Math.max(1, occKeys.size || linked.length);
  } else {
    // Legacy fallback: tag-based approximation (no over-counting)
    distinctOccurrences = Math.max(1, tags.filter(t => t.includes("기출")).length + 1);
  }
  const frequency = 1 + 0.5 * (distinctOccurrences - 1);

  // ErrorWeight: 1 + min(0.5 × wrong_count, 2.0)
  const cardLog = reviewLog.filter(l => l.cardId === card.id);
  const wrongCount = cardLog.filter(l => !l.correct).length;
  const errorWeight = 1 + Math.min(0.5 * wrongCount, 2.0);

  // Recency: most recent wrong answer
  const recentWrong = cardLog.filter(l => !l.correct).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
  let recency = 1.0;
  if (recentWrong) {
    const daysAgo = (Date.now() - new Date(recentWrong.timestamp)) / 86400000;
    if (daysAgo <= 3) recency = 1.3;
    else if (daysAgo <= 7) recency = 1.15;
  }

  // Phase 7A — Confusion cluster involvement bonus (+10% per cluster membership, max 1.3×)
  let clusterBonus = 1.0;
  if (confusionClusters && confusionClusters.length > 0) {
    const memberOf = confusionClusters.filter(cl =>
      (cl.card_ids || []).includes(card.id)
    ).length;
    if (memberOf > 0) clusterBonus = Math.min(1.3, 1.0 + memberOf * 0.1);
  }

  return parseFloat((1.0 * sourceWeight * frequency * errorWeight * recency * clusterBonus).toFixed(3));
}

// Priority for hybrid review ordering
// priority = srs_urgency × importance × exam_proximity
function calcPriority(card, srsEntry, importance, nearestExamDays) {
  // SRS urgency: how overdue is the card (1.0 = due today, higher = more overdue)
  let srsUrgency = 1.0;
  if (srsEntry && srsEntry.nextReview) {
    const overdueDays = (Date.now() - new Date(srsEntry.nextReview)) / 86400000;
    srsUrgency = Math.max(1.0, 1 + overdueDays * 0.1);
  } else {
    srsUrgency = 1.5; // New cards get a boost
  }

  // Exam proximity multiplier
  let examProximity = 1.0;
  if (nearestExamDays !== null) {
    if (nearestExamDays <= 1) examProximity = 3.0;
    else if (nearestExamDays <= 3) examProximity = 2.5;
    else if (nearestExamDays <= 7) examProximity = 2.0;
    else if (nearestExamDays <= 14) examProximity = 1.5;
  }

  return srsUrgency * importance * examProximity;
}

// Tier assignment from importance scores
function assignTiers(cards, reviewLog, questions = [], confusionClusters = []) {
  if (cards.length === 0) return {};
  const scored = cards.map(c => ({ id: c.id, score: calcImportance(c, reviewLog, questions, confusionClusters) }))
    .sort((a, b) => b.score - a.score);
  const t1Cutoff = Math.ceil(scored.length * 0.2);
  const t2Cutoff = Math.ceil(scored.length * 0.5);
  const tiers = {};
  scored.forEach((item, i) => {
    tiers[item.id] = i < t1Cutoff ? "T1" : i < t2Cutoff ? "T2" : "T3";
  });
  return tiers;
}

// Last-Mile mode detection
function getLastMileMode(upcomingExams) {
  if (!upcomingExams || upcomingExams.length === 0) return null;
  const days = daysUntil(upcomingExams[0].date);
  if (days <= 1) return "D1";
  if (days <= 3) return "D3";
  if (days <= 7) return "D7";
  return null;
}

function filterByExamScopeTyped(items, exams, examId, scopeType = "all") {
  if (examId === "전체") return items;
  const exam = (exams || []).find(e => e.id === examId);
  if (!exam) return items;

  const directConceptIds = exam.included_concept_ids || [];
  const foundationConceptIds = exam.foundation_concept_ids || [];
  const excludedConceptIds = exam.excluded_concept_ids || [];
  const directTopics = ((exam.directScope && exam.directScope.includedTopics) || []).map(t => t.toLowerCase());
  const foundationTopics = ((exam.foundationScope && exam.foundationScope.topics) || []).map(t => t.toLowerCase());

  const conceptIds =
    scopeType === "direct" ? directConceptIds
      : scopeType === "foundation" ? foundationConceptIds
        : [...new Set([...directConceptIds, ...foundationConceptIds])];

  const topics =
    scopeType === "direct" ? directTopics
      : scopeType === "foundation" ? foundationTopics
        : [...new Set([...directTopics, ...foundationTopics])];

  if (conceptIds.length === 0 && excludedConceptIds.length === 0 && topics.length === 0) return items;

  return items.filter(item => {
    const d = item.data || item;

    if (excludedConceptIds.length > 0 && d.primary_concept_id &&
      excludedConceptIds.includes(d.primary_concept_id)) return false;

    if (conceptIds.length > 0 && d.primary_concept_id && conceptIds.includes(d.primary_concept_id)) return true;

    if (topics.length > 0) {
      const tags = (d.tags || []).map(t => t.toLowerCase());
      const isQuizItem = item && typeof item === "object" && Object.prototype.hasOwnProperty.call(item, "type");
      if (isQuizItem && item.type === "question") {
        const subj = (d.subject || "").toLowerCase();
        return topics.some(t => subj.includes(t) || tags.some(tg => tg.includes(t)));
      }
      const chapter = (d.chapter || "").toLowerCase();
      const subj = (d.subject || "").toLowerCase();
      return topics.some(t => chapter.includes(t) || subj.includes(t) || tags.some(tg => tg.includes(t)));
    }

    if (conceptIds.length > 0) return false;
    return true;
  });
}

// ─────────────────────────────────────────
// Phase 6: Confusion Cluster Engine
// ─────────────────────────────────────────

function shuffleArr(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Auto-infer confusion clusters from wrong-answer patterns
// Groups unstable cards by subject+chapter; cards wrong ≥2 times become a cluster
function inferConfusionClusters(cards, reviewLog, questions) {
  const stats = {};
  (reviewLog || []).forEach(l => {
    if (!l.cardId) return;
    if (!stats[l.cardId]) stats[l.cardId] = { correct: 0, total: 0 };
    stats[l.cardId].total++;
    if (l.correct) stats[l.cardId].correct++;
  });

  const unstable = (cards || []).filter(c => {
    const s = stats[c.id];
    return s && s.total >= 2 && (s.total - s.correct) >= 2;
  });

  if (unstable.length < 2) return [];

  const groups = {};
  unstable.forEach(c => {
    const key = [c.subject, c.chapter].filter(Boolean).join("::");
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  });

  // Pre-index confirmed questions by subject for question_ids population
  const qBySubject = {};
  (questions || []).filter(q => q.status === "confirmed").forEach(q => {
    const k = (q.subject || "").toLowerCase();
    if (!qBySubject[k]) qBySubject[k] = [];
    qBySubject[k].push(q);
  });

  const clusters = [];
  Object.entries(groups).forEach(([key, groupCards]) => {
    if (groupCards.length < 2) return;
    const cardIds = groupCards.map(c => c.id);
    const conceptIds = [...new Set(groupCards.map(c => c.primary_concept_id).filter(Boolean))];
    const avgWrongRate = cardIds.reduce((sum, id) => {
      const s = stats[id];
      return sum + (s ? (s.total - s.correct) / s.total : 0);
    }, 0) / cardIds.length;
    const [subject, chapter] = key.split("::");

    // Populate question_ids: confirmed questions matching subject + (concept_ids or chapter tag)
    const subjKey = (subject || "").toLowerCase();
    const chapterLower = (chapter || "").toLowerCase();
    const linkedQIds = (qBySubject[subjKey] || [])
      .filter(q => {
        if (conceptIds.length > 0 && q.primary_concept_id && conceptIds.includes(q.primary_concept_id)) return true;
        const tags = (q.tags || []).map(t => t.toLowerCase());
        return chapterLower && (tags.some(t => t.includes(chapterLower)) || (q.subject || "").toLowerCase().includes(chapterLower));
      })
      .map(q => q.id);

    clusters.push({
      id: "auto_" + key.replace(/\W+/g, "_").slice(0, 28),
      label: [subject, chapter].filter(Boolean).join(" · "),
      concept_ids: conceptIds,
      card_ids: cardIds,
      question_ids: linkedQIds,
      confusion_score: parseFloat(avgWrongRate.toFixed(3)),
      source_reason: "wrong_answer_pattern",
      updatedAt: new Date().toISOString(),
    });
  });

  return clusters.sort((a, b) => b.confusion_score - a.confusion_score);
}

// Merge auto-inferred clusters with stored manual ones (manual takes precedence by id)
function mergeConfusionClusters(stored, autoInferred) {
  const manual = (stored || []).filter(c => c.source_reason === "manual");
  const manualIds = new Set(manual.map(c => c.id));
  const auto = (autoInferred || []).filter(c => !manualIds.has(c.id));
  return [...manual, ...auto];
}

// Danger card ids: wrong ≥2 of last 3 attempts
function getDangerCardIds(reviewLog) {
  const recent = {};
  [...(reviewLog || [])].reverse().forEach(l => {
    if (!l.cardId) return;
    if (!recent[l.cardId]) recent[l.cardId] = [];
    if (recent[l.cardId].length < 3) recent[l.cardId].push(l.correct);
  });
  return new Set(
    Object.entries(recent)
      .filter(([, attempts]) => attempts.filter(c => !c).length >= 2)
      .map(([id]) => id)
  );
}

// ─────────────────────────────────────────
// Design Tokens — Phase 7B-2
// ─────────────────────────────────────────
const C = {
  bg:       "#141c28",
  surface:  "#1e2d42",   // slightly brighter — better bg/card separation
  surface2: "#263350",   // nested surface
  border:   "#304060",   // brighter border — cards pop more
  text:     "#e4edf8",   // slightly brighter for faster scanning
  muted:    "#92a4be",   // a touch brighter than before
  primary:  "#6aafe6",
  success:  "#5dc87e",
  danger:   "#e07070",
  warning:  "#cdb94a",
};

const S = {
  card: {
    background: C.surface,
    borderRadius: 10,
    border: `1px solid ${C.border}`,
    padding: "16px 18px",
    marginBottom: 12,
  },
  cardInset: {
    background: C.surface2,
    borderRadius: 8,
    border: `1px solid ${C.border}`,
    padding: "10px 14px",
    marginBottom: 8,
  },
  btn: (v = "primary") => ({
    padding: "9px 18px", borderRadius: 8, border: "none", cursor: "pointer",
    fontWeight: 600, fontSize: 13,
    background: v === "primary" ? C.primary
              : v === "success"  ? C.success
              : v === "danger"   ? C.danger
              : C.surface2,
    color: (v === "default" || v === "muted") ? C.text : "#111a28",
  }),
  input: {
    background: C.surface2,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    padding: "8px 12px",
    color: C.text,
    fontSize: 14,
    width: "100%",
    boxSizing: "border-box",
  },
  label: { fontSize: 12, color: C.muted, marginBottom: 4, display: "block", fontWeight: 500 },
  badge: (col = C.primary) => ({
    background: col + "28",
    color: col,
    padding: "2px 8px",
    borderRadius: 9999,
    fontSize: 11,
    fontWeight: 600,
    display: "inline-block",
  }),
  sectionLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: C.muted,
    textTransform: "uppercase",
    letterSpacing: "0.07em",
    marginBottom: 8,
    display: "block",
  },
};

// ─────────────────────────────────────────
// CardImage — 이미지 렌더링 공용 컴포넌트
// Rules:
//   1. image_present=true + image_url → <img>
//   2. image_present=true + no url (or load error) → "[이미지 없음]" fallback
//   3. image_present=false or field absent → nothing
// ─────────────────────────────────────────
function CardImage({ image_url, image_present, image_ref }) {
  const [errored, setErrored] = useState(false);
  // Rule 3
  if (!image_present) return null;
  // Rule 2 fallback
  if (!image_url || errored) {
    return (
      <div style={{
        margin: "10px 0",
        padding: "8px 12px",
        background: "#1e2d42",
        borderRadius: 8,
        textAlign: "center",
        color: "#92a4be",
        fontSize: 12,
        border: "1px dashed #304060",
      }}>
        [이미지 없음{image_ref ? ` — ${image_ref}` : ""}]
      </div>
    );
  }
  // Rule 1
  return (
    <img
      src={image_url}
      alt={image_ref || "이미지"}
      onError={() => setErrored(true)}
      style={{
        maxWidth: "100%",
        maxHeight: 300,
        objectFit: "contain",
        background: "#1e2d42",
        borderRadius: 8,
        margin: "10px 0",
        display: "block",
      }}
    />
  );
}

// ─────────────────────────────────────────
// App Root
// ─────────────────────────────────────────
export default function MedStudyApp() {
  const [page, setPage] = useState("home");
  const [data, setData] = useState({
    cards: [], questions: [], professors: [], srs: {},
    reviewLog: [], exams: [], concepts: [], confusionClusters: [], hasLegacy: false,
  });
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);

  useEffect(() => { init(); }, []);

  async function init() {
    const [cards, questions, professors, srs, reviewLog, exams, concepts, legacy, manualClusters] = await Promise.all([
      sGet(SK.cards), sGet(SK.questions), sGet(SK.professors),
      sGet(SK.srs), sGet(SK.reviewLog), sGet(SK.exams), sGet(SK.concepts),
      sGet(SK.legacyQuiz), sGet(SK.confusionClusters),
    ]);
    const cardsRaw = cards || [];
    const reviewLogArr = reviewLog || [];
    const cardsArr = cardsRaw.map(c => {
      if (c.source_type) return c;
      return { ...c, source_type: inferSourceTypeFromTags(c.tags || []) };
    });
    if (cardsRaw.some((c, i) => c.source_type !== cardsArr[i].source_type)) {
      sSet(SK.cards, cardsArr);
    }
    // Phase 7A: retroactively normalize question_intent + backfill confirmed_source on load
    const questionsArr = (questions || []).map(q => {
      const normalized = normalizeQuestionIntent(q.question_intent);
      const confirmedSource = inferConfirmedSource(q);
      if (q.question_intent === normalized && q.confirmed_source === confirmedSource) return q;
      return { ...q, question_intent: normalized, confirmed_source: confirmedSource };
    });
    // Persist if anything changed (silent background write)
    if ((questions || []).some((q, i) =>
      q.question_intent !== questionsArr[i].question_intent ||
      q.confirmed_source !== questionsArr[i].confirmed_source
    )) {
      sSet(SK.questions, questionsArr);
    }
    const autoClusters = inferConfusionClusters(cardsArr, reviewLogArr, questionsArr);
    const allClusters = mergeConfusionClusters(manualClusters, autoClusters);
    setData({
      cards: cardsArr, questions: questionsArr, professors: professors || [],
      srs: srs || {}, reviewLog: reviewLogArr, exams: exams || [],
      concepts: concepts || [],
      confusionClusters: allClusters,
      hasLegacy: !!(legacy && legacy.length > 0),
    });
    setLoading(false);
  }

  function showToast(msg, type = "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  function updateData(key, value) {
    setData(prev => ({ ...prev, [key]: value }));
    sSet(SK[key] || key, value);
  }

  function logReview(entry) {
    setData(prev => {
      const newEntry = { id: uid(), timestamp: new Date().toISOString(), ...entry };
      const newLog = [...prev.reviewLog, newEntry];
      sSet(SK.reviewLog, newLog);
      return { ...prev, reviewLog: newLog };
    });
  }

  function updateSrs(cardId, grade) {
    setData(prev => {
      const updated = sm2Update(prev.srs[cardId], grade);
      const newSrs = { ...prev.srs, [cardId]: updated };
      sSet(SK.srs, newSrs);
      return { ...prev, srs: newSrs };
    });
  }

  // Phase 6: re-infer confusion clusters after a review session updates reviewLog
  function refreshClusters(currentData) {
    const src = currentData || data;
    const auto = inferConfusionClusters(src.cards, src.reviewLog, src.questions);
    const manual = (src.confusionClusters || []).filter(c => c.source_reason === "manual");
    const merged = mergeConfusionClusters(manual, auto);
    setData(prev => ({ ...prev, confusionClusters: merged }));
  }

  function getDueCards(lastMileMode) {
    const now = new Date();
    const upcoming = getUpcomingExams();
    const nearestDays = upcoming.length > 0 ? daysUntil(upcoming[0].date) : null;
    let pool = data.cards || [];

    // Phase 6: Danger-only mode
    if (lastMileMode === "danger") {
      const dangerIds = getDangerCardIds(data.reviewLog);
      pool = pool.filter(c => dangerIds.has(c.id));
      return pool.sort((a, b) => {
        const impA = calcImportance(a, data.reviewLog, data.questions, data.confusionClusters);
        const impB = calcImportance(b, data.reviewLog, data.questions, data.confusionClusters);
        return impB - impA;
      });
    }

    // Last-Mile filtering
    if (lastMileMode === "D1") {
      const scored = pool.map(c => ({ c, imp: calcImportance(c, data.reviewLog, data.questions, data.confusionClusters) }))
        .sort((a, b) => b.imp - a.imp);
      pool = scored.slice(0, Math.max(1, Math.ceil(scored.length * 0.15))).map(x => x.c);
    } else if (lastMileMode === "D3") {
      const scored = pool.map(c => ({ c, imp: calcImportance(c, data.reviewLog, data.questions, data.confusionClusters) }))
        .sort((a, b) => b.imp - a.imp);
      const recentWrongIds = new Set(
        (data.reviewLog || []).filter(l => l.cardId && !l.correct && (Date.now() - new Date(l.timestamp)) < 3 * 86400000)
          .map(l => l.cardId)
      );
      const top30 = scored.slice(0, Math.ceil(scored.length * 0.3)).map(x => x.c);
      const recentWrong = pool.filter(c => recentWrongIds.has(c.id));
      const combined = [...top30, ...recentWrong];
      pool = combined.filter((c, i, arr) => arr.findIndex(x => x.id === c.id) === i);
    } else if (lastMileMode === "D7") {
      pool = pool.filter(c => {
        const s = data.srs[c.id];
        return !(s && s.state === "mastered");
      });
    }

    const due = pool.filter(c => {
      const s = data.srs[c.id];
      if (!s) return true;
      return new Date(s.nextReview) <= now;
    });

    return due.sort((a, b) => {
      const impA = calcImportance(a, data.reviewLog, data.questions, data.confusionClusters);
      const impB = calcImportance(b, data.reviewLog, data.questions, data.confusionClusters);
      const prioA = calcPriority(a, data.srs[a.id], impA, nearestDays);
      const prioB = calcPriority(b, data.srs[b.id], impB, nearestDays);
      return prioB - prioA;
    });
  }

  function getUpcomingExams() {
    return (data.exams || [])
      .filter(e => daysUntil(e.date) >= 0)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  // Primary = core study actions; secondary = support / management tools
  const navPrimary = [
    { id: "home",     label: "홈"  },
    { id: "review",   label: "복습" },
    { id: "decision", label: "감별" },
    { id: "compress", label: "압축" },
    { id: "quiz",     label: "퀴즈" },
  ];
  const navSecondary = [
    { id: "flashcard", label: "카드" },
    { id: "plan",      label: "플랜" },
    { id: "stats",     label: "통계" },
    { id: "concepts",  label: "개념" },
    { id: "manage",    label: "관리" },
  ];
  const navItems = [...navPrimary, ...navSecondary];

  const upcomingExams = getUpcomingExams();
  const urgentExam = upcomingExams.find(e => daysUntil(e.date) <= 14);
  const lastMileMode = getLastMileMode(upcomingExams);
  const dueCount = getDueCards(lastMileMode).length;

  const pageProps = { data, updateData, logReview, updateSrs, getDueCards, getUpcomingExams, showToast, navigate: setPage, lastMileMode, refreshClusters };

  const Pages = { home: HomePage, review: ReviewPage, quiz: QuizPage, flashcard: FlashcardPage, plan: PlanPage, stats: StatsPage, concepts: ConceptPage, manage: ManagePage, decision: DecisionTrainingPage, compress: CompressionPage };
  const PageComp = Pages[page] || HomePage;

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: C.bg, color: C.muted, fontSize: 16 }}>
        MedStudy AI 로딩 중...
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Inter', system-ui, -apple-system, sans-serif", fontSize: 14 }}>
      {/* Header */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: C.text, letterSpacing: "-0.01em" }}>
          MedStudy <span style={{ color: C.primary }}>AI</span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {dueCount > 0 && (
            <span style={S.badge(C.warning)}>{dueCount} 복습</span>
          )}
          {urgentExam && (
            <span style={S.badge(C.danger)}>D-{daysUntil(urgentExam.date)} {urgentExam.name}</span>
          )}
        </div>
      </div>

      {/* Legacy Banner */}
      {data.hasLegacy && (
        <div style={{ background: "#744210", color: "#fefcbf", padding: "8px 20px", fontSize: 13 }}>
          ⚠️ 구 custom-quiz 데이터 발견 → 관리 탭에서 마이그레이션 실행하세요.
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", top: 60, right: 20, zIndex: 999, padding: "10px 16px", borderRadius: 8, background: toast.type === "error" ? C.danger : C.success, color: "#1a1f2e", fontWeight: 600, fontSize: 14, boxShadow: "0 4px 12px rgba(0,0,0,0.4)" }}>
          {toast.msg}
        </div>
      )}

      {/* Nav — primary actions | secondary tools */}
      <div style={{ display: "flex", overflowX: "auto", background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        {navItems.map((n, i) => {
          const isPrimary = navPrimary.some(p => p.id === n.id);
          const isActive  = page === n.id;
          // separator before first secondary item
          const showSep = i > 0 && !isPrimary && navPrimary.some(p => p.id === navItems[i - 1].id);
          return (
            <div key={n.id} style={{ display: "flex", alignItems: "stretch" }}>
              {showSep && (
                <div style={{ width: 1, background: C.border, margin: "6px 0", alignSelf: "stretch" }} />
              )}
              <button
                onClick={() => setPage(n.id)}
                style={{
                  padding: "10px 14px",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: isActive ? C.primary : isPrimary ? C.text : C.muted,
                  fontWeight: isActive ? 700 : isPrimary ? 500 : 400,
                  borderBottom: `2px solid ${isActive ? C.primary : "transparent"}`,
                  fontSize: isPrimary ? 13 : 12,
                  whiteSpace: "nowrap",
                  opacity: !isPrimary && !isActive ? 0.8 : 1,
                }}>
                {n.label}
              </button>
            </div>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ maxWidth: 800, margin: "0 auto", padding: 20 }}>
        <PageComp {...pageProps} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────
// HomePage — Phase 7B-2
// ─────────────────────────────────────────
function HomePage({ data, getDueCards, getUpcomingExams, navigate, lastMileMode }) {
  const upcomingExams = getUpcomingExams();
  const dueCards      = getDueCards(lastMileMode);
  const dangerIds     = getDangerCardIds(data.reviewLog);
  const clusters      = data.confusionClusters || [];

  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
  const recentLog    = (data.reviewLog || []).filter(l => new Date(l.timestamp) > sevenDaysAgo);
  const recentAcc    = recentLog.length >= 5
    ? Math.round(recentLog.filter(l => l.correct).length / recentLog.length * 100)
    : null;

  const stateCounts = { new: 0, learning: 0, reviewing: 0, mastered: 0 };
  (data.cards || []).forEach(c => {
    const st = (data.srs[c.id] && data.srs[c.id].state) || "new";
    if (stateCounts[st] !== undefined) stateCounts[st]++;
  });

  const lmCfg = {
    D7: { label: "D-7 집중 모드", color: C.warning, desc: "마스터된 카드 제외 · 취약 항목 우선" },
    D3: { label: "D-3 최우선 모드", color: "#e07c30", desc: "고중요도 30% + 최근 오답" },
    D1: { label: "D-1 최종 점검", color: C.danger,  desc: "최고 중요도 상위 15% 출제" },
  };

  const totalCards  = (data.cards || []).length;
  const nearestExam = upcomingExams[0] || null;
  const nearestDays = nearestExam ? daysUntil(nearestExam.date) : null;
  const examUrgent  = nearestDays !== null && nearestDays <= 7;
  const confirmedQ  = (data.questions || []).filter(q => q.status === "confirmed").length;
  const hasDue      = dueCards.length > 0;

  return (
    <div>

      {/* ── Last-Mile banner — only when active ── */}
      {lastMileMode && lmCfg[lastMileMode] && (
        <div style={{
          background: lmCfg[lastMileMode].color + "18",
          border: `1px solid ${lmCfg[lastMileMode].color}`,
          borderRadius: 10, padding: "11px 16px", marginBottom: 12,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <div>
            <div style={{ fontWeight: 700, color: lmCfg[lastMileMode].color, fontSize: 14 }}>
              {lmCfg[lastMileMode].label}
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{lmCfg[lastMileMode].desc}</div>
          </div>
          <button style={{ ...S.btn("success"), fontSize: 12 }} onClick={() => navigate("review")}>
            복습 시작 ({dueCards.length})
          </button>
        </div>
      )}

      {/* ── HERO: Today's review block ── */}
      <div style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderLeft: `4px solid ${hasDue ? C.primary : C.success}`,
        borderRadius: 10,
        padding: "20px 20px 16px",
        marginBottom: 12,
      }}>
        {/* Top row: label + exam countdown */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>
            오늘 복습
          </div>
          {nearestExam && (
            <div style={{
              fontSize: 12, fontWeight: 600,
              color: examUrgent ? C.danger : C.muted,
              background: (examUrgent ? C.danger : C.border) + "28",
              borderRadius: 6, padding: "2px 8px",
            }}>
              {nearestExam.name} · D-{nearestDays}
            </div>
          )}
        </div>

        {/* Count + CTA row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          {/* Big number */}
          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 52, fontWeight: 800, color: hasDue ? C.warning : C.success, lineHeight: 1 }}>
                {dueCards.length}
              </span>
              <span style={{ fontSize: 15, color: C.muted, fontWeight: 500 }}>장 대기</span>
            </div>
            {/* Inline status pills row */}
            {totalCards > 0 && (
              <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                {[
                  ["학습중", stateCounts.learning,  C.warning],
                  ["복습중", stateCounts.reviewing, C.primary],
                  ["완료",   stateCounts.mastered,  C.success],
                  ["신규",   stateCounts.new,        C.muted  ],
                ].map(([label, count, col]) => count > 0 && (
                  <div key={label} style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: col }}>{count}</span>
                    <span style={{ fontSize: 11, color: C.muted }}>{label}</span>
                  </div>
                ))}
                {recentAcc !== null && (
                  <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: recentAcc >= 70 ? C.success : C.warning }}>{recentAcc}%</span>
                    <span style={{ fontSize: 11, color: C.muted }}>7일</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* CTA buttons — clear hierarchy */}
          <div style={{ display: "flex", flexDirection: "column", gap: 7, alignItems: "flex-end", flexShrink: 0 }}>
            {hasDue ? (
              <button
                onClick={() => navigate("review")}
                style={{
                  ...S.btn("success"),
                  fontSize: 14, padding: "10px 22px", fontWeight: 700,
                }}>
                복습 시작
              </button>
            ) : (
              <button
                onClick={() => navigate("flashcard")}
                style={{ ...S.btn("primary"), fontSize: 14, padding: "10px 22px", fontWeight: 700 }}>
                카드 보기
              </button>
            )}
            <button
              onClick={() => navigate("compress")}
              style={{ ...S.btn("default"), fontSize: 12, padding: "5px 14px", color: C.muted }}>
              압축 복습
            </button>
          </div>
        </div>
      </div>

      {/* ── Secondary quick actions — clear subordinate role ── */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <button
          onClick={() => navigate("quiz")}
          style={{ ...S.btn("primary"), fontSize: 13, padding: "8px 16px" }}>
          퀴즈
        </button>
        <button
          onClick={() => navigate("decision")}
          style={{ ...S.btn("default"), fontSize: 13 }}>
          감별 훈련{clusters.length > 0 ? ` (${clusters.length})` : ""}
        </button>
        <button
          onClick={() => navigate("plan")}
          style={{ ...S.btn("default"), fontSize: 13 }}>
          시험 추가
        </button>
      </div>

      {/* ── Danger / Weakness ── */}
      {(dangerIds.size > 0 || clusters.length > 0) && (
        <div style={{
          ...S.card,
          borderLeft: `4px solid ${C.danger}`,
          marginBottom: 12,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.danger, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
                취약 항목
              </div>
              <div style={{ display: "flex", gap: 18, marginBottom: clusters.length > 0 ? 10 : 0 }}>
                {dangerIds.size > 0 && (
                  <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
                    <span style={{ fontSize: 26, fontWeight: 700, color: C.danger }}>{dangerIds.size}</span>
                    <span style={{ fontSize: 12, color: C.muted }}>위험 카드</span>
                  </div>
                )}
                {clusters.length > 0 && (
                  <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
                    <span style={{ fontSize: 26, fontWeight: 700, color: C.warning }}>{clusters.length}</span>
                    <span style={{ fontSize: 12, color: C.muted }}>혼동 클러스터</span>
                  </div>
                )}
              </div>
              {clusters.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {clusters.slice(0, 3).map(cl => (
                    <span key={cl.id} style={S.badge(cl.confusion_score >= 0.7 ? C.danger : C.warning)}>
                      {cl.label}
                    </span>
                  ))}
                  {clusters.length > 3 && <span style={S.badge(C.muted)}>+{clusters.length - 3}</span>}
                </div>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7, alignItems: "flex-end", flexShrink: 0, marginLeft: 12 }}>
              {dangerIds.size > 0 && (
                <button
                  style={{ ...S.btn("danger"), fontSize: 12, padding: "6px 13px" }}
                  onClick={() => navigate("review")}>
                  위험 복습
                </button>
              )}
              {clusters.length > 0 && (
                <button
                  style={{ ...S.btn("default"), fontSize: 12, padding: "6px 13px" }}
                  onClick={() => navigate("decision")}>
                  감별 훈련
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Exam Focus ── */}
      {upcomingExams.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
            다가오는 시험
          </div>
          {upcomingExams.slice(0, 2).map(exam => {
            const days = daysUntil(exam.date);
            const accent = days <= 7 ? C.danger : days <= 14 ? C.warning : C.primary;
            const topics = (exam.directScope && exam.directScope.includedTopics) || [];
            return (
              <div key={exam.id} style={{ ...S.card, borderLeft: `4px solid ${accent}`, marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14, color: C.text }}>{exam.name}</div>
                    <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{exam.subject} · {exam.date}</div>
                    {topics.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                        {topics.slice(0, 4).map((t, i) => <span key={i} style={S.badge(C.primary)}>{t}</span>)}
                        {topics.length > 4 && <span style={S.badge(C.muted)}>+{topics.length - 4}</span>}
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: accent, flexShrink: 0, marginLeft: 12 }}>
                    D-{days}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Confirmed questions count (only if no other content fills bottom) ── */}
      {confirmedQ > 0 && totalCards === 0 && (
        <div style={{ ...S.card }}>
          <span style={{ fontSize: 22, fontWeight: 700, color: C.primary }}>{confirmedQ}</span>
          <span style={{ fontSize: 12, color: C.muted, marginLeft: 6 }}>확인된 문제</span>
        </div>
      )}

    </div>
  );
}

// ─────────────────────────────────────────
// ReviewPage — Phase 4: Hybrid Priority + Last-Mile
// ─────────────────────────────────────────
function ReviewPage({ data, updateSrs, logReview, showToast, getDueCards, getUpcomingExams, lastMileMode, refreshClusters, navigate }) {
  const [sessionCards, setSessionCards] = useState(null);
  const [current, setCurrent] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [startTime, setStartTime] = useState(null);
  const [sessionLog, setSessionLog] = useState([]);
  const [selectedMode, setSelectedMode] = useState(lastMileMode || "normal");
  const upcomingExams = getUpcomingExams();
  const nearestExam = upcomingExams[0] || null;
  const nearestDays = nearestExam ? daysUntil(nearestExam.date) : null;
  const dangerIds = getDangerCardIds(data.reviewLog);
  const modeOptions = [{ id: "normal", label: "일반 복습", desc: "SRS 우선순위 기반" }];
  if (dangerIds.size > 0) modeOptions.push({ id: "danger", label: "⚠️ 위험 카드", desc: "최근 오답 집중 (" + dangerIds.size + "장)" });
  if (nearestDays !== null && nearestDays <= 7) modeOptions.push({ id: "D7", label: "D-7 집중", desc: "마스터 카드 제외" });
  if (nearestDays !== null && nearestDays <= 3) modeOptions.push({ id: "D3", label: "D-3 최우선", desc: "고중요도+오답" });
  if (nearestDays !== null && nearestDays <= 1) modeOptions.push({ id: "D1", label: "D-1 최종", desc: "상위 15%만" });
  function startSession() {
    const mode = selectedMode !== "normal" ? selectedMode : null;
    const due = getDueCards(mode);
    if (due.length === 0) { showToast("복습할 카드 없음", "error"); return; }
    setSessionCards(due); setCurrent(0); setFlipped(false);
    setStartTime(Date.now()); setSessionLog([]);
  }
  function reviewGrade(g) {
    if (!sessionCards || current >= sessionCards.length) return;
    const card = sessionCards[current];
    const responseTimeSec = Math.round((Date.now() - (startTime || Date.now())) / 1000);
    const correct = g >= 2;
    updateSrs(card.id, g);
    logReview({ cardId: card.id, questionId: null, correct, mode: "review", responseTimeSec });
    setSessionLog(prev => [...prev, { card, grade: g, correct }]);
    setCurrent(c => c + 1); setFlipped(false); setStartTime(Date.now());
  }
  const dueCount = getDueCards(selectedMode !== "normal" ? selectedMode : null).length;
  const modeColor = selectedMode === "D1" ? C.danger : selectedMode === "D3" ? "#f97316" : selectedMode === "D7" ? C.warning : selectedMode === "danger" ? C.danger : C.primary;
  const modeDesc = {
    normal: "하이브리드 우선순위 (importance x SRS x 시험근접도)",
    danger: "최근 3회 중 2회 이상 오답 카드 집중 복습",
    D7: "마스터 완료 카드 제외, 중요도 순 정렬",
    D3: "상위 30% 고중요도 + 최근 3일 오답 포함",
    D1: "최고 중요도 상위 15%만 - D-1 최종 점검",
  };
  if (!sessionCards) {
    return (
      <div>
        <h2 style={{ margin: "0 0 16px", color: C.primary }}>복습</h2>
        {modeOptions.length > 1 && (
          <div style={{ ...S.card, marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>복습 모드 선택</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {modeOptions.map(m => (
                <button key={m.id} onClick={() => setSelectedMode(m.id)} style={{ ...S.btn(selectedMode === m.id ? "primary" : "default"), fontSize: 12 }}>{m.label}</button>
              ))}
            </div>
            {selectedMode !== "normal" && (
              <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>{(modeOptions.find(m => m.id === selectedMode) || {}).desc || ""} · {dueCount}장 대기</div>
            )}
          </div>
        )}
        {dueCount === 0 ? (
          <div style={S.card}>
            <div style={{ color: C.success, fontSize: 18, fontWeight: 600, marginBottom: 6 }}>복습 완료!</div>
            <div style={{ color: C.muted, fontSize: 13 }}>이 모드에서 복습할 카드가 없습니다.</div>
          </div>
        ) : (
          <div style={{ ...S.card, borderLeft: "3px solid " + modeColor }}>
            <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 4, color: modeColor }}>{dueCount + "장"}</div>
            <div style={{ color: C.muted, fontSize: 13, marginBottom: 14 }}>{modeDesc[selectedMode] || ""}</div>
            {nearestExam && <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>{ nearestExam.name + " D-" + nearestDays}</div>}
            <button style={S.btn("success")} onClick={startSession}>복습 시작</button>
          </div>
        )}
      </div>
    );
  }
  if (current >= sessionCards.length) {
    const correct = sessionLog.filter(l => l.correct).length;
    const acc = sessionLog.length > 0 ? Math.round(correct / sessionLog.length * 100) : 0;
    const wrongItems = sessionLog.filter(l => !l.correct);
    // Refresh confusion clusters now that reviewLog has new signal
    if (wrongItems.length > 0 && refreshClusters) refreshClusters();
    return (
      <div>
        <h2 style={{ margin: "0 0 16px", color: C.primary }}>복습 완료</h2>
        <div style={S.card}>
          <div style={{ fontSize: 36, fontWeight: 700, color: acc >= 70 ? C.success : C.warning, marginBottom: 4 }}>{acc + "%"}</div>
          <div style={{ color: C.muted }}>{correct + "/" + sessionLog.length + " 정답"}</div>
          {selectedMode !== "normal" && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{selectedMode + " 모드"}</div>}
        </div>
        {wrongItems.length > 0 && (
          <div style={S.card}>
            <div style={{ fontWeight: 600, color: C.danger, marginBottom: 8, fontSize: 14 }}>{"오답 (" + wrongItems.length + ")"}</div>
            {wrongItems.map((l, i) => (
              <div key={i} style={{ padding: "6px 0", borderBottom: "1px solid " + C.border, fontSize: 13 }}>
                <div style={{ color: C.muted, fontSize: 11 }}>{l.card.subject + " · " + l.card.chapter}</div>
                <div>{l.card.front}</div>
                <div style={{ color: C.muted, marginTop: 2 }}>{" " + l.card.back}</div>
              </div>
            ))}
          </div>
        )}
        {/* Next-step navigation — study flow continuity */}
        <div style={{ ...S.card, background: C.surface2 }}>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, fontWeight: 600 }}>다음 단계</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button style={{ ...S.btn("default"), fontSize: 12 }} onClick={() => setSessionCards(null)}>다시 복습</button>
            {dangerIds.size > 0 && (
              <button style={{ ...S.btn("danger"), fontSize: 12 }} onClick={() => { setSelectedMode("danger"); setSessionCards(null); }}>
                위험 카드 ({dangerIds.size})
              </button>
            )}
            <button style={{ ...S.btn("default"), fontSize: 12 }} onClick={() => { if (refreshClusters) refreshClusters(); if (navigate) navigate("decision"); }}>
              감별 훈련
            </button>
            <button style={{ ...S.btn("default"), fontSize: 12 }} onClick={() => { if (navigate) navigate("compress"); }}>
              압축 복습
            </button>
          </div>
        </div>
      </div>
    );
  }
  const card = sessionCards[current];
  const srsEntry = data.srs[card.id];
  const cardState = (srsEntry && srsEntry.state) || "new";
  const importance = calcImportance(card, data.reviewLog, data.questions, data.confusionClusters);
  const stateColors = { new: C.muted, learning: C.warning, reviewing: C.primary, mastered: C.success };
  const isDangerCard = dangerIds.has(card.id);
  return (
    <div>
      {/* Progress + metadata row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, fontSize: 12, color: C.muted }}>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <span style={S.badge(stateColors[cardState] || C.muted)}>{cardState}</span>
          {isDangerCard && <span style={S.badge(C.danger)}>위험</span>}
          <span style={S.badge(importance >= 3 ? C.danger : importance >= 1.5 ? C.warning : C.muted)}>imp {importance.toFixed(1)}</span>
        </div>
        <span style={{ fontWeight: 500 }}>{(current + 1)} / {sessionCards.length}</span>
      </div>
      {/* Progress bar */}
      <div style={{ height: 3, background: C.border, borderRadius: 9999, marginBottom: 16, overflow: "hidden" }}>
        <div style={{ height: "100%", background: modeColor, width: (current / sessionCards.length * 100) + "%", transition: "width 0.3s" }} />
      </div>
      {/* Card face */}
      <div
        onClick={() => { if (!flipped) setFlipped(true); }}
        style={{
          ...S.card,
          minHeight: 200,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          textAlign: "center",
          cursor: flipped ? "default" : "pointer",
          borderLeft: isDangerCard ? `3px solid ${C.danger}` : undefined,
          padding: "24px 20px",
        }}
      >
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 10, letterSpacing: "0.04em" }}>
          {card.subject}{card.chapter ? " · " + card.chapter : ""}
        </div>
        <div style={{ fontSize: flipped ? 17 : 19, fontWeight: 600, lineHeight: 1.65, color: flipped ? C.primary : C.text }}>
          {flipped ? card.back : card.front}
        </div>
        <CardImage image_url={card.image_url} image_present={card.image_present} image_ref={card.image_ref} />
        {flipped && card.explanations && card.explanations.quick && (
          <div style={{ marginTop: 14, fontSize: 12, color: C.muted, maxWidth: 440, lineHeight: 1.6, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
            {card.explanations.quick}
          </div>
        )}
        {!flipped && (
          <div style={{ marginTop: 18, fontSize: 12, color: C.muted, opacity: 0.6 }}>탭하여 답 확인</div>
        )}
      </div>
      {/* Grade buttons — only shown after flip */}
      {flipped && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginTop: 12 }}>
          {[
            { label: "모름",   grade: 0, variant: "danger"  },
            { label: "어려움", grade: 1, variant: "default" },
            { label: "알겠음", grade: 2, variant: "primary" },
            { label: "쉬움",   grade: 3, variant: "success" },
          ].map(({ label, grade, variant }) => (
            <button
              key={grade}
              style={{ ...S.btn(variant), textAlign: "center", padding: "10px 4px" }}
              onClick={() => reviewGrade(grade)}>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────
// FlashcardPage
// ─────────────────────────────────────────
function FlashcardPage({ data, updateSrs, logReview, getUpcomingExams }) {
  const [subject, setSubject] = useState("전체");
  const [examScope, setExamScope] = useState("전체");
  const [current, setCurrent] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [startTime, setStartTime] = useState(Date.now());

  const upcomingExams = getUpcomingExams();
  const subjects = ["전체", ...Array.from(new Set((data.cards || []).map(c => c.subject).filter(Boolean)))];

  function getFiltered() {
    let filtered = data.cards || [];
    if (subject !== "전체") filtered = filtered.filter(c => c.subject === subject);
    if (examScope !== "전체") {
      const exam = (data.exams || []).find(e => e.id === examScope);
      if (exam) {
        const conceptIds = exam.included_concept_ids || [];
        const excludedConceptIds = exam.excluded_concept_ids || [];
        const topics = (exam.directScope && exam.directScope.includedTopics
          ? exam.directScope.includedTopics : []).map(t => t.toLowerCase());

        filtered = filtered.filter(c => {
          // Excluded concept check
          if (excludedConceptIds.length > 0 && c.primary_concept_id &&
              excludedConceptIds.includes(c.primary_concept_id)) return false;

          // Priority 1: concept match
          if (conceptIds.length > 0 && c.primary_concept_id && conceptIds.includes(c.primary_concept_id)) return true;

          // Priority 2: topic/chapter/tag fallback
          if (topics.length > 0) {
            const ch = (c.chapter || "").toLowerCase();
            const tags = (c.tags || []).map(t => t.toLowerCase());
            return topics.some(t => ch.includes(t) || tags.some(tag => tag.includes(t)));
          }

          if (conceptIds.length > 0) return false;
          return true;
        });
      }
    }
    return filtered;
  }

  const filteredCards = getFiltered();

  function grade(g) {
    const card = filteredCards[current % Math.max(filteredCards.length, 1)];
    if (!card) return;
    const responseTimeSec = Math.round((Date.now() - startTime) / 1000);
    updateSrs(card.id, g);
    logReview({ cardId: card.id, questionId: null, correct: g >= 2, mode: "flashcard", responseTimeSec });
    setCurrent(c => c + 1);
    setFlipped(false);
    setStartTime(Date.now());
  }

  if (filteredCards.length === 0) {
    return (
      <div>
        <h2 style={{ margin: "0 0 16px", color: C.primary }}>플래시카드</h2>
        <div style={S.card}><div style={{ color: C.muted }}>카드가 없습니다. 카드 주입기로 추가하세요.</div></div>
      </div>
    );
  }

  const idx = current % filteredCards.length;
  const card = filteredCards[idx];

  return (
    <div>
      <h2 style={{ margin: "0 0 16px", color: C.primary }}>플래시카드</h2>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <select value={subject} onChange={e => { setSubject(e.target.value); setCurrent(0); setFlipped(false); }} style={{ ...S.input, width: "auto" }}>
          {subjects.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {upcomingExams.length > 0 && (
          <select value={examScope} onChange={e => { setExamScope(e.target.value); setCurrent(0); setFlipped(false); }} style={{ ...S.input, width: "auto" }}>
            <option value="전체">시험 범위 전체</option>
            {upcomingExams.map(e => (
              <option key={e.id} value={e.id}>{e.name} (D-{daysUntil(e.date)})</option>
            ))}
          </select>
        )}
        <div style={{ fontSize: 12, color: C.muted, alignSelf: "center" }}>{filteredCards.length}장</div>
      </div>

      <div
        style={{ ...S.card, minHeight: 190, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", cursor: flipped ? "default" : "pointer" }}
        onClick={() => { if (!flipped) setFlipped(true); }}
      >
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>{card.subject} · {card.chapter}</div>
        <div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.6 }}>{flipped ? card.back : card.front}</div>
        <CardImage image_url={card.image_url} image_present={card.image_present} image_ref={card.image_ref} />
        {!flipped && <div style={{ marginTop: 14, fontSize: 12, color: C.muted }}>탭하여 답 확인</div>}
      </div>
      <div style={{ fontSize: 12, color: C.muted, textAlign: "center", margin: "6px 0 10px" }}>{idx + 1} / {filteredCards.length}</div>

      {flipped && (
        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ ...S.btn("danger"), flex: 1 }} onClick={() => grade(0)}>다시</button>
          <button style={{ ...S.btn("default"), flex: 1 }} onClick={() => grade(1)}>어려움</button>
          <button style={{ ...S.btn(), flex: 1 }} onClick={() => grade(2)}>알겠음</button>
          <button style={{ ...S.btn("success"), flex: 1 }} onClick={() => grade(3)}>쉬움</button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────
// QuizPage — Phase 3: 3모드 + review-log
// ─────────────────────────────────────────
function QuizPage({ data, updateSrs, logReview, showToast, getUpcomingExams }) {
  const [phase, setPhase] = useState("setup");
  const [config, setConfig] = useState({ mode: "question", subject: "전체", examScope: "전체", scopeType: "all", count: 10 });
  const [items, setItems] = useState([]);
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [sessionResults, setSessionResults] = useState([]);
  const [startTime, setStartTime] = useState(null);

  const upcomingExams = getUpcomingExams();
  const confirmedQ = (data.questions || []).filter(q =>
    q.status === "confirmed" && q.status !== "archived_reference"
  );
  const allSubjects = ["전체", ...Array.from(new Set([
    ...(data.cards || []).map(c => c.subject),
    ...(data.questions || []).map(q => q.subject),
  ].filter(Boolean)))];

  function buildPool(cfg) {
    // Phase 7A Task 6: foundation (search-only) concepts are excluded from quiz pool
    const foundationIds = getFoundationConceptIds(data.concepts);

    let cards = (data.cards || []).filter(c =>
      !c.primary_concept_id || !foundationIds.has(c.primary_concept_id)
    );
    let qs = confirmedQ.filter(q =>
      !q.primary_concept_id || !foundationIds.has(q.primary_concept_id)
    );
    if (cfg.subject !== "전체") {
      cards = cards.filter(c => c.subject === cfg.subject);
      qs = qs.filter(q => q.subject === cfg.subject);
    }
    let pool = [];
    if (cfg.mode === "card") pool = cards.map(c => ({ type: "card", data: c }));
    else if (cfg.mode === "question") pool = qs.map(q => ({ type: "question", data: q }));
    else pool = [...cards.map(c => ({ type: "card", data: c })), ...qs.map(q => ({ type: "question", data: q }))];
    return filterByExamScopeTyped(pool, data.exams || [], cfg.examScope, cfg.scopeType || "all");
  }

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  function startQuiz() {
    const pool = buildPool(config);
    if (pool.length === 0) { showToast("출제 가능한 항목이 없습니다.", "error"); return; }
    const built = shuffle(pool).slice(0, config.count);
    setItems(built);
    setCurrent(0);
    setSelected(null);
    setRevealed(false);
    setSessionResults([]);
    setStartTime(Date.now());
    setPhase("running");
  }

  function handleCardReveal() {
    if (!revealed) setRevealed(true);
  }

  function handleCardGrade(correct) {
    const item = items[current];
    const responseTimeSec = Math.round((Date.now() - (startTime || Date.now())) / 1000);
    if (correct) updateSrs(item.data.id, 2);
    else updateSrs(item.data.id, 0);
    logReview({ cardId: item.data.id, questionId: null, correct, mode: "quiz", responseTimeSec });
    setSessionResults(prev => [...prev, { item, correct }]);
    nextItem();
  }

  function handleMcqSubmit() {
    if (selected === null) return;
    const item = items[current];
    const options = item.data.options || [];
    const correct = !!(options[selected] && options[selected].correct);
    const responseTimeSec = Math.round((Date.now() - (startTime || Date.now())) / 1000);
    setRevealed(true);
    logReview({ cardId: null, questionId: item.data.id, correct, mode: "quiz", responseTimeSec });
    setSessionResults(prev => [...prev, { item, correct }]);
  }

  function nextItem() {
    if (current + 1 >= items.length) {
      setPhase("results");
    } else {
      setCurrent(c => c + 1);
      setSelected(null);
      setRevealed(false);
      setStartTime(Date.now());
    }
  }

  const previewCount = buildPool(config).length;

  // ── Setup ──
  if (phase === "setup") {
    return (
      <div>
        <h2 style={{ margin: "0 0 16px", color: C.primary }}>퀴즈 설정</h2>
        <div style={S.card}>
          <div style={{ marginBottom: 14 }}>
            <label style={S.label}>퀴즈 모드</label>
            <div style={{ display: "flex", gap: 8 }}>
              {[["card", "🃏 카드 퀴즈"], ["question", "📄 기출 퀴즈"], ["mixed", "🔀 혼합"]].map(([m, label]) => (
                <button key={m} onClick={() => setConfig(c => ({ ...c, mode: m }))} style={{ ...S.btn(config.mode === m ? "primary" : "default"), flex: 1, fontSize: 12 }}>
                  {label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>
              {config.mode === "card" && "플래시카드를 퀴즈 형식으로 학습합니다."}
              {config.mode === "question" && `확인된 기출 문제 ${confirmedQ.length}개에서 출제합니다.`}
              {config.mode === "mixed" && "카드와 기출 문제를 섞어 출제합니다."}
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={S.label}>과목</label>
            <select value={config.subject} onChange={e => setConfig(c => ({ ...c, subject: e.target.value }))} style={S.input}>
              {allSubjects.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {upcomingExams.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <label style={S.label}>시험 범위 필터</label>
              <select value={config.examScope} onChange={e => setConfig(c => ({ ...c, examScope: e.target.value, scopeType: "all" }))} style={S.input}>
                <option value="전체">전체 범위</option>
                {upcomingExams.map(e => (
                  <option key={e.id} value={e.id}>{e.name} (D-{daysUntil(e.date)})</option>
                ))}
              </select>
              {config.examScope !== "전체" && (
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  {[["all", "전체"], ["direct", "직접 출제"], ["foundation", "배경지식"]].map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setConfig(c => ({ ...c, scopeType: key }))}
                      style={{ ...S.btn(config.scopeType === key ? "primary" : "default"), fontSize: 12, padding: "6px 10px" }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{ marginBottom: 16 }}>
            <label style={S.label}>문제 수 (최대 {previewCount})</label>
            <input type="number" value={config.count} min={1} max={Math.max(previewCount, 1)}
              onChange={e => setConfig(c => ({ ...c, count: Math.max(1, Math.min(previewCount, parseInt(e.target.value) || 1)) }))}
              style={S.input}
            />
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ color: C.muted, fontSize: 13 }}>출제 가능: {previewCount}개</div>
            <button style={S.btn("success")} onClick={startQuiz} disabled={previewCount === 0}>퀴즈 시작</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Results ──
  if (phase === "results") {
    const correctCount = sessionResults.filter(r => r.correct).length;
    const acc = sessionResults.length > 0 ? Math.round(correctCount / sessionResults.length * 100) : 0;
    return (
      <div>
        <h2 style={{ margin: "0 0 16px", color: C.primary }}>퀴즈 결과</h2>
        <div style={S.card}>
          <div style={{ fontSize: 40, fontWeight: 700, color: acc >= 70 ? C.success : acc >= 50 ? C.warning : C.danger, marginBottom: 6 }}>{acc}%</div>
          <div style={{ color: C.muted }}>{correctCount} / {sessionResults.length} 정답 · 리뷰 로그에 기록됨</div>
        </div>
        <div style={{ marginTop: 12 }}>
          {sessionResults.map((r, i) => (
            <div key={i} style={{ ...S.card, borderLeft: `3px solid ${r.correct ? C.success : C.danger}`, padding: 10, marginBottom: 6 }}>
              <div style={{ fontSize: 11, color: r.correct ? C.success : C.danger, fontWeight: 600 }}>
                {r.correct ? "✓ 정답" : "✗ 오답"} · {r.item.type === "card" ? "카드" : "기출"}
              </div>
              <div style={{ fontSize: 13, marginTop: 2 }}>
                {r.item.type === "card" ? r.item.data.front : (r.item.data.parsed_question || r.item.data.raw_question || "").slice(0, 90)}
              </div>
            </div>
          ))}
        </div>
        <button style={{ ...S.btn("default"), marginTop: 12 }} onClick={() => setPhase("setup")}>다시 설정</button>
      </div>
    );
  }

  // ── Running ──
  const item = items[current];
  const isCard = item.type === "card";

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, fontSize: 13, color: C.muted }}>
        <span>{isCard ? "🃏 카드" : "📄 기출"}</span>
        <span>{current + 1} / {items.length}</span>
      </div>
      <div style={{ height: 4, background: C.border, borderRadius: 9999, marginBottom: 16, overflow: "hidden" }}>
        <div style={{ height: "100%", background: C.primary, width: `${(current / items.length) * 100}%`, transition: "width 0.2s" }} />
      </div>

      {isCard ? (
        <div>
          <div
            style={{ ...S.card, minHeight: 170, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", cursor: revealed ? "default" : "pointer" }}
            onClick={handleCardReveal}
          >
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>{item.data.subject} · {item.data.chapter}</div>
            <div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.6 }}>{revealed ? item.data.back : item.data.front}</div>
            <CardImage image_url={item.data.image_url} image_present={item.data.image_present} image_ref={item.data.image_ref} />
            {!revealed && <div style={{ marginTop: 14, fontSize: 12, color: C.muted }}>탭하여 답 확인</div>}
          </div>
          {revealed && (
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button style={{ ...S.btn("danger"), flex: 1 }} onClick={() => handleCardGrade(false)}>❌ 몰랐음</button>
              <button style={{ ...S.btn("success"), flex: 1 }} onClick={() => handleCardGrade(true)}>✅ 알았음</button>
            </div>
          )}
        </div>
      ) : (
        <div>
          <div style={S.card}>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>{item.data.subject}</div>
            <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.8, whiteSpace: "pre-wrap", marginBottom: 16 }}>
              {item.data.parsed_question || item.data.raw_question}
            </div>
            <CardImage image_url={item.data.image_url} image_present={item.data.image_present} image_ref={item.data.image_ref} />
            {(item.data.options || []).map((opt, i) => {
              let bg = "transparent";
              let border = C.border;
              if (revealed) {
                if (opt.correct) { bg = C.success + "33"; border = C.success; }
                else if (selected === i) { bg = C.danger + "22"; border = C.danger; }
              } else if (selected === i) {
                bg = C.primary + "22"; border = C.primary;
              }
              return (
                <div key={i} onClick={() => { if (!revealed) setSelected(i); }}
                  style={{ padding: "10px 14px", marginBottom: 8, borderRadius: 8, border: `1px solid ${border}`, cursor: revealed ? "default" : "pointer", background: bg, fontSize: 14, transition: "background 0.15s" }}>
                  <span style={{ fontWeight: 700, marginRight: 8 }}>{["①","②","③","④","⑤"][i]}</span>
                  {opt.text}
                  {revealed && opt.correct && <span style={{ marginLeft: 8, color: C.success, fontWeight: 700 }}>✓</span>}
                  {revealed && selected === i && !opt.correct && <span style={{ marginLeft: 8, color: C.danger, fontWeight: 700 }}>✗</span>}
                </div>
              );
            })}
          </div>

          {revealed && item.data.explanations && (item.data.explanations.quick || item.data.explanations.professor) && (
            <div style={{ ...S.card, borderLeft: `3px solid ${C.primary}`, marginTop: 0 }}>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>해설</div>
              <div style={{ fontSize: 13 }}>{item.data.explanations.quick || item.data.explanations.professor}</div>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            {!revealed ? (
              <button style={{ ...S.btn("success"), flex: 1 }} onClick={handleMcqSubmit} disabled={selected === null}>제출</button>
            ) : (
              <button style={{ ...S.btn(), flex: 1 }} onClick={nextItem}>다음 →</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────
// PlanPage
// ─────────────────────────────────────────
function PlanPage({ data, updateData, showToast }) {
  const [view, setView] = useState("list");
  const [selectedExam, setSelectedExam] = useState(null);
  const [form, setForm] = useState({ name: "", subject: "", date: "", professorId: "", hoursPerDay: 3, directTopics: "", foundationTopics: "", includedConceptIds: "", excludedConceptIds: "", foundationConceptIds: "" });

  function genPlan(exam) {
    const days = daysUntil(exam.date);
    if (days <= 0) return [];
    return [
      { name: "1단계: 전체 복습", days: Math.max(1, Math.round(days * 0.5)) },
      { name: "2단계: 취약점 보강", days: Math.max(1, Math.round(days * 0.3)) },
      { name: "3단계: 최종 점검", days: Math.max(1, Math.round(days * 0.2)) },
    ];
  }

  function saveExam() {
    if (!form.name || !form.date) { showToast("이름과 날짜는 필수입니다.", "error"); return; }
    const exam = {
      id: uid(), name: form.name, subject: form.subject, date: form.date,
      professorId: form.professorId, hoursPerDay: form.hoursPerDay,
      directScope: {
        includedTopics: form.directTopics.split(",").map(t => t.trim()).filter(Boolean),
        excludedTopics: [],
      },
      foundationScope: {
        topics: form.foundationTopics.split(",").map(t => t.trim()).filter(Boolean),
      },
      // Phase 5.5: concept-aware scope
      included_concept_ids: form.includedConceptIds.split(",").map(t => t.trim()).filter(Boolean),
      excluded_concept_ids: form.excludedConceptIds.split(",").map(t => t.trim()).filter(Boolean),
      foundation_concept_ids: form.foundationConceptIds.split(",").map(t => t.trim()).filter(Boolean),
      plan: [], createdAt: new Date().toISOString(),
    };
    exam.plan = genPlan(exam);
    updateData("exams", [...(data.exams || []), exam]);
    showToast("시험 추가됨");
    setView("list");
    setForm({ name: "", subject: "", date: "", professorId: "", hoursPerDay: 3, directTopics: "", foundationTopics: "", includedConceptIds: "", excludedConceptIds: "", foundationConceptIds: "" });
  }

  function deleteExam(id) {
    updateData("exams", (data.exams || []).filter(e => e.id !== id));
    showToast("삭제됨");
  }

  const sorted = [...(data.exams || [])].sort((a, b) => new Date(a.date) - new Date(b.date));

  if (view === "create") {
    return (
      <div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
          <button style={S.btn("default")} onClick={() => setView("list")}>← 뒤로</button>
          <h2 style={{ margin: 0, color: C.primary }}>시험 추가</h2>
        </div>
        <div style={S.card}>
          {[
            ["시험명 *", "name", "text", "예: 해부학 중간고사"],
            ["과목", "subject", "text", "예: 해부학"],
          ].map(([label, key, type, placeholder]) => (
            <div key={key} style={{ marginBottom: 12 }}>
              <label style={S.label}>{label}</label>
              <input type={type} style={S.input} value={form[key]} placeholder={placeholder}
                onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} />
            </div>
          ))}
          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>시험 날짜 *</label>
            <input type="date" style={S.input} value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>교수 프로파일</label>
            <select style={S.input} value={form.professorId} onChange={e => setForm(f => ({ ...f, professorId: e.target.value }))}>
              <option value="">선택 안 함</option>
              {(data.professors || []).map(p => <option key={p.id} value={p.id}>{p.name} ({p.subject})</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>직접 출제 범위 (쉼표 구분)</label>
            <input style={S.input} value={form.directTopics} placeholder="예: 상지, 하지, 신경" onChange={e => setForm(f => ({ ...f, directTopics: e.target.value }))} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>배경지식 범위 · 출제 제외 (쉼표 구분)</label>
            <input style={S.input} value={form.foundationTopics} placeholder="예: 세포생물학 기초" onChange={e => setForm(f => ({ ...f, foundationTopics: e.target.value }))} />
          </div>
          {(data.concepts || []).length > 0 && (
            <details style={{ marginBottom: 12 }}>
              <summary style={{ fontSize: 12, color: C.muted, cursor: "pointer", marginBottom: 6 }}>🧠 개념 범위 필터 (고급)</summary>
              <div style={{ paddingTop: 8 }}>
                <div style={{ marginBottom: 8 }}>
                  <label style={S.label}>포함 개념 ID (쉼표 구분)</label>
                  <input style={S.input} value={form.includedConceptIds} placeholder="예: radial_nerve, brachial_plexus"
                    onChange={e => setForm(f => ({ ...f, includedConceptIds: e.target.value }))} />
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>퀴즈/복습에서 이 개념 카드·문제를 우선 포함합니다.</div>
                </div>
                <div style={{ marginBottom: 8 }}>
                  <label style={S.label}>제외 개념 ID (쉼표 구분)</label>
                  <input style={S.input} value={form.excludedConceptIds} placeholder="예: cell_biology_basics"
                    onChange={e => setForm(f => ({ ...f, excludedConceptIds: e.target.value }))} />
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>이 개념은 퀴즈/복습에서 항상 제외됩니다.</div>
                </div>
                <div>
                  <label style={S.label}>배경지식 개념 ID (쉼표 구분)</label>
                  <input style={S.input} value={form.foundationConceptIds} placeholder="예: basic_histology"
                    onChange={e => setForm(f => ({ ...f, foundationConceptIds: e.target.value }))} />
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>설명/검색에는 표시되나 기본 퀴즈 출제 대상에서 제외됩니다.</div>
                </div>
              </div>
            </details>
          )}
          <div style={{ marginBottom: 16 }}>
            <label style={S.label}>하루 학습 시간</label>
            <input type="number" style={S.input} value={form.hoursPerDay} min={1} max={12} onChange={e => setForm(f => ({ ...f, hoursPerDay: parseInt(e.target.value) || 3 }))} />
          </div>
          <button style={S.btn("success")} onClick={saveExam}>저장</button>
        </div>
      </div>
    );
  }

  if (view === "detail" && selectedExam) {
    const exam = selectedExam;
    const days = daysUntil(exam.date);
    const prof = (data.professors || []).find(p => p.id === exam.professorId);
    const plan = (exam.plan && exam.plan.length > 0) ? exam.plan : genPlan(exam);
    const borderColor = days <= 7 ? C.danger : days <= 14 ? C.warning : C.primary;
    return (
      <div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
          <button style={S.btn("default")} onClick={() => setView("list")}>← 뒤로</button>
          <h2 style={{ margin: 0, color: C.primary }}>{exam.name}</h2>
        </div>

        <div style={{ ...S.card, borderLeft: `3px solid ${borderColor}` }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 600 }}>{exam.date}</div>
              <div style={{ fontSize: 12, color: C.muted }}>{exam.subject}</div>
            </div>
            <div style={{ fontSize: 30, fontWeight: 700, color: borderColor }}>
              {days < 0 ? "종료" : `D-${days}`}
            </div>
          </div>
        </div>

        {exam.directScope && exam.directScope.includedTopics && exam.directScope.includedTopics.length > 0 && (
          <div style={S.card}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>📌 직접 출제 범위</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {exam.directScope.includedTopics.map((t, i) => <span key={i} style={S.badge(C.primary)}>{t}</span>)}
            </div>
          </div>
        )}

        {exam.foundationScope && exam.foundationScope.topics && exam.foundationScope.topics.length > 0 && (
          <div style={S.card}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>📚 배경지식 (출제 제외)</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {exam.foundationScope.topics.map((t, i) => <span key={i} style={S.badge(C.muted)}>{t}</span>)}
            </div>
          </div>
        )}

        {prof && (
          <div style={S.card}>
            <div style={{ fontWeight: 600, marginBottom: 10 }}>👨‍🏫 {prof.name}</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
              <span style={S.badge(C.primary)}>{prof.preset}</span>
              <span style={S.badge(C.warning)}>{prof.focusStyle}</span>
              <span style={S.badge(C.success)}>반복: {prof.repetitionTendency}</span>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {Object.entries(prof.sourceWeights || {}).map(([k, v]) => (
                <span key={k} style={S.badge(C.text)}>{k}: {v}</span>
              ))}
            </div>
            {prof.notes && <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>{prof.notes}</div>}
          </div>
        )}

        <div style={S.card}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>📋 학습 계획 ({days > 0 ? days : 0}일)</div>
          {plan.map((p, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: i < plan.length - 1 ? `1px solid ${C.border}` : "none", fontSize: 14 }}>
              <span>{p.name}</span>
              <span style={{ color: C.primary }}>{p.days}일</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: C.primary }}>시험 플랜</h2>
        <button style={S.btn("success")} onClick={() => setView("create")}>+ 시험 추가</button>
      </div>
      {sorted.length === 0 ? (
        <div style={S.card}><div style={{ color: C.muted }}>등록된 시험이 없습니다.</div></div>
      ) : (
        sorted.map(exam => {
          const days = daysUntil(exam.date);
          const col = days < 0 ? C.muted : days <= 7 ? C.danger : days <= 14 ? C.warning : C.success;
          return (
            <div key={exam.id} style={{ ...S.card, cursor: "pointer" }} onClick={() => { setSelectedExam(exam); setView("detail"); }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{exam.name}</div>
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{exam.date} · {exam.subject}</div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={S.badge(col)}>{days < 0 ? "종료" : `D-${days}`}</span>
                  <button style={S.btn("danger")} onClick={e => { e.stopPropagation(); deleteExam(exam.id); }}>삭제</button>
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ─────────────────────────────────────────
// StatsPage — Phase 3: review-log 기반
// ─────────────────────────────────────────
function StatsPage({ data }) {
  const reviewLog = data.reviewLog || [];

  const cardById = {};
  (data.cards || []).forEach(c => { cardById[c.id] = c; });
  const questionById = {};
  (data.questions || []).forEach(q => { questionById[q.id] = q; });

  const totalAnswers = reviewLog.length;
  const totalCorrect = reviewLog.filter(l => l.correct).length;
  const overallAcc = totalAnswers > 0 ? Math.round(totalCorrect / totalAnswers * 100) : 0;

  // By subject
  const subjectStats = {};
  reviewLog.forEach(l => {
    let subj = "미분류";
    if (l.cardId && cardById[l.cardId]) subj = cardById[l.cardId].subject || "미분류";
    else if (l.questionId && questionById[l.questionId]) subj = questionById[l.questionId].subject || "미분류";
    if (!subjectStats[subj]) subjectStats[subj] = { correct: 0, total: 0 };
    subjectStats[subj].total++;
    if (l.correct) subjectStats[subj].correct++;
  });

  // By mode
  const modeStats = {};
  reviewLog.forEach(l => {
    const mode = l.mode || "unknown";
    if (!modeStats[mode]) modeStats[mode] = { correct: 0, total: 0 };
    modeStats[mode].total++;
    if (l.correct) modeStats[mode].correct++;
  });

  // Daily 7-day
  const dailyStats = {};
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dailyStats[d.toISOString().slice(0, 10)] = { correct: 0, total: 0 };
  }
  reviewLog.forEach(l => {
    const key = l.timestamp ? l.timestamp.slice(0, 10) : null;
    if (key && dailyStats[key]) {
      dailyStats[key].total++;
      if (l.correct) dailyStats[key].correct++;
    }
  });

  // Danger list
  const recentByItem = {};
  [...reviewLog].reverse().forEach(l => {
    const key = l.cardId || l.questionId;
    if (!key) return;
    if (!recentByItem[key]) recentByItem[key] = [];
    if (recentByItem[key].length < 3) recentByItem[key].push(l.correct);
  });
  const dangerItems = Object.entries(recentByItem)
    .filter(([k, attempts]) => attempts.filter(c => !c).length >= 2)
    .map(([k]) => cardById[k] || questionById[k])
    .filter(Boolean);

  const confirmedQ = (data.questions || []).filter(q => q.status === "confirmed").length;
  const unverifiedQ = (data.questions || []).filter(q => q.status !== "confirmed").length;

  const modeLabel = { quiz: "퀴즈", review: "SRS 복습", flashcard: "플래시카드" };

  return (
    <div>
      <h2 style={{ margin: "0 0 16px", color: C.primary }}>학습 통계</h2>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 16 }}>
        <div style={{ ...S.card, marginBottom: 0 }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: C.primary }}>{totalAnswers}</div>
          <div style={{ fontSize: 12, color: C.muted }}>총 응답</div>
        </div>
        <div style={{ ...S.card, marginBottom: 0 }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: overallAcc >= 70 ? C.success : C.warning }}>{overallAcc}%</div>
          <div style={{ fontSize: 12, color: C.muted }}>전체 정확도</div>
        </div>
        <div style={{ ...S.card, marginBottom: 0 }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: C.success }}>{confirmedQ}</div>
          <div style={{ fontSize: 12, color: C.muted }}>문제은행</div>
          {unverifiedQ > 0 && <div style={{ fontSize: 10, color: C.muted }}>+{unverifiedQ} 미확인</div>}
        </div>
      </div>

      {totalAnswers > 0 && (
        <div>
          {/* Daily Chart */}
          <div style={{ ...S.card, marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 12, fontSize: 14 }}>📈 최근 7일</div>
            <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 72 }}>
              {Object.entries(dailyStats).map(([date, stat]) => {
                const pct = stat.total > 0 ? stat.correct / stat.total : 0;
                const h = Math.max(4, Math.round(pct * 56));
                const col = pct >= 0.7 ? C.success : pct >= 0.5 ? C.warning : stat.total > 0 ? C.danger : C.border;
                return (
                  <div key={date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                    <div style={{ width: "100%", height: h, background: col, borderRadius: 3 }} title={`${date}: ${stat.correct}/${stat.total}`} />
                    <div style={{ fontSize: 10, color: C.muted }}>{date.slice(5)}</div>
                    <div style={{ fontSize: 10, color: C.muted }}>{stat.total}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Subject */}
          {Object.keys(subjectStats).length > 0 && (
            <div style={{ ...S.card, marginBottom: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 12, fontSize: 14 }}>📚 과목별</div>
              {Object.entries(subjectStats)
                .sort((a, b) => (a[1].correct / a[1].total) - (b[1].correct / b[1].total))
                .map(([subj, stat]) => {
                  const acc = Math.round(stat.correct / stat.total * 100);
                  return (
                    <div key={subj} style={{ marginBottom: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                        <span>{subj}</span>
                        <span style={{ color: acc >= 70 ? C.success : C.warning }}>{acc}% ({stat.correct}/{stat.total})</span>
                      </div>
                      <div style={{ height: 6, background: C.border, borderRadius: 9999, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${acc}%`, background: acc >= 70 ? C.success : acc >= 50 ? C.warning : C.danger }} />
                      </div>
                    </div>
                  );
                })}
            </div>
          )}

          {/* Mode */}
          {Object.keys(modeStats).length > 0 && (
            <div style={{ ...S.card, marginBottom: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 14 }}>🎯 모드별</div>
              {Object.entries(modeStats).map(([mode, stat]) => {
                const acc = Math.round(stat.correct / stat.total * 100);
                return (
                  <div key={mode} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
                    <span>{modeLabel[mode] || mode}</span>
                    <span style={{ color: acc >= 70 ? C.success : C.warning }}>{acc}% · {stat.total}회</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Danger List */}
          {dangerItems.length > 0 && (
            <div style={S.card}>
              <div style={{ fontWeight: 600, marginBottom: 10, color: C.danger, fontSize: 14 }}>⚠️ 취약 항목 ({dangerItems.length})</div>
              {dangerItems.slice(0, 10).map((item, i) => (
                <div key={i} style={{ padding: "6px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
                  <div style={{ color: C.muted, fontSize: 11 }}>{item.subject || "미분류"} {item.chapter || ""}</div>
                  <div>{(item.front || item.parsed_question || item.raw_question || "항목").slice(0, 80)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {totalAnswers === 0 && (
        <div style={S.card}>
          <div style={{ color: C.muted }}>아직 학습 기록이 없습니다. 복습이나 퀴즈를 시작하세요.</div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────
// ManagePage
// ─────────────────────────────────────────
function ManagePage({ data, updateData, showToast }) {
  const [tab, setTab] = useState("cards");
  const [search, setSearch] = useState("");
  const [profForm, setProfForm] = useState(null);
  const [pdfForm, setPdfForm] = useState({
    subjectKo: "해부학",
    exam_unit: "",
    source_type: "past_exam",
    source_detail: "",
    geminiApiKey: localStorage.getItem("medstudy:gemini-api-key") || import.meta.env.VITE_GEMINI_API_KEY || "",
    file: null,
  });
  const [pdfStatus, setPdfStatus] = useState({ phase: "idle", progress: 0 });
  const [pdfResult, setPdfResult] = useState(null);

  const PRESETS = {
    "past-exam-heavy": { pastExam: 5, slides: 3, textbook: 1, notes: 2 },
    "slide-heavy": { pastExam: 3, slides: 5, textbook: 1, notes: 2 },
    "textbook-heavy": { pastExam: 2, slides: 2, textbook: 5, notes: 1 },
  };

  function confirmQuestion(id) {
    updateData("questions", (data.questions || []).map(q => q.id === id ? { ...q, status: "confirmed" } : q));
    showToast("확인됨");
  }

  function saveProf() {
    if (!profForm.name) { showToast("이름 필수", "error"); return; }
    const prof = { ...profForm, id: profForm.id || uid() };
    const profs = data.professors || [];
    const newProfs = profForm.id ? profs.map(p => p.id === profForm.id ? prof : p) : [...profs, prof];
    updateData("professors", newProfs);
    setProfForm(null);
    showToast("저장됨");
  }

  async function migrateLegacy() {
    try {
      const legacy = await sGet("medstudy:custom-quiz");
      if (!legacy || legacy.length === 0) { showToast("데이터 없음", "error"); return; }
      await sSet("medstudy:backup-custom-quiz", legacy);
      // Phase 7A: single batch ID for the entire migration run
      const batchId = "migrate_" + Date.now().toString(36);
      const migrated = legacy.map(q => {
        const canonicalAnswer = q.answer || q.canonicalAnswer || "";
        const canonicalAnswerKey = canonicalAnswer.toLowerCase().trim().slice(0, 40);
        const occurrenceKey = [q.examYear, q.examId, q.professorId].filter(Boolean).join("|") || "legacy";
        // Phase 7A: normalize intent at migration time — no more "general" written to storage
        const normalizedIntent = normalizeQuestionIntent(q.question_intent || q.questionIntent);
        // Phase 7A: use normalized intent in source_signature (concept||intent||answer)
        const primaryConceptId = q.primary_concept_id || q.conceptId || null;
        const sourceSignature = [primaryConceptId || "", normalizedIntent, canonicalAnswerKey].join("||");
        return {
          id: q.id || uid(), subject: q.subject || "", type: q.type || "mcq",
          raw_question: q.raw_question || q.question || JSON.stringify(q),
          parsed_question: q.question || q.parsed_question || "",
          options: q.options || [], canonicalAnswer,
          acceptedVariants: q.acceptedVariants || [],
          explanations: q.explanations || { quick: q.explanation || "" },
          status: "confirmed", confidence: "medium",
          confirmationSource: "legacy",
          confirmed_source: "official",        // Phase 7A: legacy exam data = official
          confirmationHistory: [], answer_history: [], needs_review: false, review_reason: null,
          primary_concept_id: primaryConceptId,
          tags: q.tags || [], importance: 0,
          // Phase 7A: fully normalized fields
          question_intent: normalizedIntent,
          question_family_id: null,
          duplicate_level: null,
          occurrence_key: occurrenceKey,
          source_signature: sourceSignature,
          ingestion_batch_id: batchId,         // Phase 7A: file-level traceability
          createdAt: q.createdAt || new Date().toISOString(),
        };
      });
      updateData("questions", [...(data.questions || []), ...migrated]);
      showToast(`${migrated.length}개 마이그레이션 완료`);
    } catch(e) { showToast("실패: " + e.message, "error"); }
  }

  async function processPdf() {
    try {
      if (!pdfForm.file) { showToast("PDF 파일을 선택하세요.", "error"); return; }
      if (!pdfForm.exam_unit.trim()) { showToast("시험 단위를 입력하세요.", "error"); return; }
      if (!pdfForm.geminiApiKey.trim()) { showToast("Gemini API 키를 입력하세요.", "error"); return; }
      localStorage.setItem("medstudy:gemini-api-key", pdfForm.geminiApiKey.trim());
      const subjectSlug = SUBJECT_SLUG_MAP[pdfForm.subjectKo] || "general";
      const ingestionBatchId = `pdf_${Date.now().toString(36)}`;

      setPdfStatus({ phase: "텍스트 추출 중...", progress: 15 });
      const formData = new FormData();
      formData.append("file", pdfForm.file);
      formData.append("subject", subjectSlug);
      formData.append("exam_unit", pdfForm.exam_unit.trim());
      formData.append("source_type", pdfForm.source_type);
      if (pdfForm.source_detail.trim()) formData.append("source_detail", pdfForm.source_detail.trim());

      const pdfRes = await fetch("/api/process-pdf", { method: "POST", body: formData });
      const pdfJson = await pdfRes.json();
      if (!pdfRes.ok) throw new Error(pdfJson.error || "PDF 처리 실패");

      setPdfStatus({ phase: "문제 구조화 중...", progress: 55 });
      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(pdfForm.geminiApiKey.trim())}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: `${PDF_PARSE_PROMPT}\n\n=== RAW EXAM TEXT START ===\n${pdfJson.text}\n=== RAW EXAM TEXT END ===` }],
          }],
        }),
      });
      const geminiJson = await geminiRes.json();
      const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
      const parsedItems = safeJsonArrayFromText(rawText);

      setPdfStatus({ phase: "저장 중...", progress: 80 });
      const questions = data.questions || [];
      const cards = data.cards || [];
      const existingQ = new Set(questions.map(q => (q.raw_question || "").trim()));
      const existingC = new Set(cards.map(c => (c.front || "").trim()));
      const newQuestions = [];
      const newCards = [];
      let unresolvedImageRefs = 0;

      parsedItems.forEach(item => {
        const rawQuestion = item.raw_question || "";
        const imageRef = item.image_ref || null;
        const mappedImage = imageRef ? pdfJson.imageMapping?.[imageRef] : null;
        if (imageRef && !mappedImage?.url) unresolvedImageRefs += 1;

        if ((item.type || "").toLowerCase() === "objective") {
          if (!rawQuestion.trim() || existingQ.has(rawQuestion.trim())) return;
          const canonicalAnswer = item.canonicalAnswer ?? null;
          newQuestions.push({
            id: uid(),
            raw_question: rawQuestion,
            parsed_question: rawQuestion,
            options: Array.isArray(item.options) ? item.options : [],
            canonicalAnswer,
            status: normalizeConfidence(item.confidence) === "none" ? "unverified" : "confirmed",
            confidence: normalizeConfidence(item.confidence),
            confirmed_source: "ai_user",
            question_intent: "definition",
            occurrence_key: [subjectSlug, pdfForm.exam_unit.trim(), pdfForm.source_type].join("|"),
            source_signature: ["", "definition", (canonicalAnswer || "").slice(0, 40)].join("||"),
            explanations: { quick: "", professor: null, textbook: null, extra: null },
            image_present: !!item.image_present,
            image_ref: imageRef,
            image_url: mappedImage?.url || null,
            primary_concept_id: null,
            tags: [pdfForm.source_type, subjectSlug],
            source_type: pdfForm.source_type,
            subject: pdfForm.subjectKo,
            ingestion_batch_id: ingestionBatchId,
            createdAt: new Date().toISOString(),
          });
          existingQ.add(rawQuestion.trim());
          return;
        }

        if ((item.type || "").toLowerCase() === "subjective") {
          const front = rawQuestion.trim();
          if (!front || existingC.has(front)) return;
          newCards.push({
            id: uid(),
            front,
            back: item.canonicalAnswer || "",
            subject: pdfForm.subjectKo,
            chapter: "",
            templateType: "general",
            tier: "active",
            source_type: pdfForm.source_type,
            image_present: !!item.image_present,
            image_ref: imageRef,
            image_url: mappedImage?.url || null,
            tags: [pdfForm.source_type, subjectSlug],
            ingestion_batch_id: ingestionBatchId,
            createdAt: new Date().toISOString(),
          });
          existingC.add(front);
        }
      });

      if (newQuestions.length > 0) updateData("questions", [...questions, ...newQuestions]);
      if (newCards.length > 0) updateData("cards", [...cards, ...newCards]);

      setPdfStatus({ phase: "완료", progress: 100 });
      setPdfResult({
        questions: newQuestions.length,
        cards: newCards.length,
        imageCount: pdfJson.imageCount || 0,
        unresolvedImageRefs,
      });
      showToast(`처리 완료: 문제 ${newQuestions.length}개 / 카드 ${newCards.length}개`);
    } catch (e) {
      setPdfStatus({ phase: "오류", progress: 0 });
      showToast(`PDF 처리 실패: ${e.message}`, "error");
    }
  }

  const filteredCards = (data.cards || []).filter(c =>
    !search || (c.front || "").toLowerCase().includes(search.toLowerCase()) || (c.subject || "").toLowerCase().includes(search.toLowerCase())
  );
  const filteredQ = (data.questions || []).filter(q =>
    !search || (q.parsed_question || q.raw_question || "").toLowerCase().includes(search.toLowerCase())
  );

  const reviewQueueQ = (data.questions || []).filter(q =>
    q.needs_review || q.status === "conflict" || q.status === "unstable_parse"
  );
  const tabs = [
    ["cards", `카드 (${(data.cards || []).length})`],
    ["questions", `문제 (${(data.questions || []).length})`],
    ["pdf_process", "PDF 처리"],
    ["review_queue", `검토 대기${reviewQueueQ.length > 0 ? ` (${reviewQueueQ.length})` : ""}`],
    ["professors", `교수 (${(data.professors || []).length})`],
    ["migrate", "마이그레이션"],
  ];

  return (
    <div>
      <h2 style={{ margin: "0 0 16px", color: C.primary }}>관리</h2>

      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {tabs.map(([t, label]) => (
          <button key={t} onClick={() => { setTab(t); setSearch(""); }} style={{ ...S.btn(tab === t ? "primary" : "default"), fontSize: 12 }}>
            {label}
          </button>
        ))}
      </div>

      {(tab === "cards" || tab === "questions") && (
        <input style={{ ...S.input, marginBottom: 12 }} placeholder="검색..." value={search} onChange={e => setSearch(e.target.value)} />
      )}

      {tab === "cards" && (
        <div>
          {filteredCards.length === 0 ? (
            <div style={S.card}><div style={{ color: C.muted }}>카드 없음</div></div>
          ) : filteredCards.map(c => {
            const concept = c.primary_concept_id && (data.concepts || []).find(x => x.id === c.primary_concept_id);
            return (
              <div key={c.id} style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1, marginRight: 8 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 2 }}>
                    <span style={{ fontSize: 11, color: C.muted }}>{c.subject} · {c.chapter} · {c.tier || "active"}</span>
                    <span style={S.badge(C.warning)}>{SOURCE_TYPE_LABELS[c.source_type || "manual"] || (c.source_type || "manual")}</span>
                    {concept && <span style={S.badge(C.primary)}>{concept.primaryLabel || c.primary_concept_id}</span>}
                    {!concept && c.primary_concept_id && <span style={S.badge(C.warning)}>{c.primary_concept_id}</span>}
                  </div>
                  <div style={{ fontSize: 14, marginTop: 2 }}>{c.front}</div>
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{c.back}</div>
                </div>
                <button style={S.btn("danger")} onClick={() => { updateData("cards", (data.cards || []).filter(x => x.id !== c.id)); showToast("삭제됨"); }}>삭제</button>
              </div>
            );
          })}
        </div>
      )}

      {tab === "questions" && (
        <div>
          {filteredQ.length === 0 ? (
            <div style={S.card}><div style={{ color: C.muted }}>문제 없음</div></div>
          ) : filteredQ.map(q => {
            const statusColors = {
              confirmed: C.success, unverified: C.warning,
              conflict: C.danger, unstable_parse: "#f97316", archived_reference: C.muted,
            };
            const sc = statusColors[q.status] || C.warning;
            return (
              <div key={q.id} style={{ ...S.card, borderLeft: `3px solid ${sc}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1, marginRight: 8 }}>
                    <div style={{ display: "flex", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
                      <span style={S.badge(sc)}>{q.status || "unverified"}</span>
                      <span style={S.badge(C.muted)}>{q.subject || "미분류"}</span>
                      {q.duplicate_level && q.duplicate_level !== "distinct_same_concept" && (
                        <span style={S.badge(C.warning)}>{q.duplicate_level}</span>
                      )}
                      {q.question_intent && <span style={S.badge(C.primary)}>{q.question_intent}</span>}
                      {q.needs_review && <span style={S.badge(C.danger)}>검토필요</span>}
                    </div>
                    <div style={{ fontSize: 13 }}>{(q.parsed_question || q.raw_question || "").slice(0, 100)}</div>
                    {q.review_reason && <div style={{ fontSize: 11, color: C.warning, marginTop: 2 }}>{q.review_reason}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 4, flexShrink: 0, flexDirection: "column", alignItems: "flex-end" }}>
                    {q.status !== "confirmed" && (
                      <button style={{ ...S.btn("success"), fontSize: 11 }} onClick={() => confirmQuestion(q.id)}>확인</button>
                    )}
                    {q.status !== "archived_reference" && (
                      <button style={{ ...S.btn("default"), fontSize: 11 }} onClick={() => {
                        updateData("questions", (data.questions || []).map(x => x.id === q.id ? { ...x, status: "archived_reference", needs_review: false } : x));
                        showToast("보관됨");
                      }}>보관</button>
                    )}
                    <button style={{ ...S.btn("danger"), fontSize: 11 }} onClick={() => { updateData("questions", (data.questions || []).filter(x => x.id !== q.id)); showToast("삭제됨"); }}>삭제</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === "pdf_process" && (
        <div style={S.card}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>PDF 자동 처리 파이프라인</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <label style={S.label}>과목</label>
              <select style={S.input} value={pdfForm.subjectKo} onChange={e => setPdfForm(f => ({ ...f, subjectKo: e.target.value }))}>
                {["해부학","생리학","생화학","약리학","병리학","미생물학","기타"].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label style={S.label}>출처 타입</label>
              <select style={S.input} value={pdfForm.source_type} onChange={e => setPdfForm(f => ({ ...f, source_type: e.target.value }))}>
                <option value="past_exam">기출 (past_exam)</option>
                <option value="slide">슬라이드 (slide)</option>
                <option value="note">필기 (note)</option>
                <option value="textbook">교과서 (textbook)</option>
              </select>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <label style={S.label}>시험 단위</label>
              <input style={S.input} value={pdfForm.exam_unit} placeholder="예: 2024_1_mid" onChange={e => setPdfForm(f => ({ ...f, exam_unit: e.target.value }))} />
            </div>
            <div>
              <label style={S.label}>출처 상세 (선택)</label>
              <input style={S.input} value={pdfForm.source_detail} placeholder="예: 2022, lecture3" onChange={e => setPdfForm(f => ({ ...f, source_detail: e.target.value }))} />
            </div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={S.label}>Gemini API Key</label>
            <input style={S.input} type="password" value={pdfForm.geminiApiKey} placeholder="aistudio.google.com에서 발급" onChange={e => setPdfForm(f => ({ ...f, geminiApiKey: e.target.value }))} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>PDF 파일</label>
            <input type="file" accept="application/pdf" onChange={e => setPdfForm(f => ({ ...f, file: e.target.files?.[0] || null }))} />
          </div>
          <button style={S.btn("success")} onClick={processPdf}>처리 시작</button>

          {pdfStatus.phase !== "idle" && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>{pdfStatus.phase}</div>
              <div style={{ width: "100%", height: 8, borderRadius: 999, background: "#2b3b55", overflow: "hidden" }}>
                <div style={{ width: `${pdfStatus.progress}%`, height: "100%", background: C.primary }} />
              </div>
            </div>
          )}

          {pdfResult && (
            <div style={{ marginTop: 12, fontSize: 13 }}>
              <div>문제 {pdfResult.questions}개 저장됨 / 카드 {pdfResult.cards}개 저장됨 / 이미지 {pdfResult.imageCount}개 업로드됨</div>
              {pdfResult.unresolvedImageRefs > 0 && (
                <div style={{ color: C.warning, marginTop: 4 }}>⚠️ 이미지 매핑 실패: {pdfResult.unresolvedImageRefs}건</div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "review_queue" && (
        <div>
          {reviewQueueQ.length === 0 ? (
            <div style={S.card}><div style={{ color: C.muted }}>검토 대기 문제 없음 ✓</div></div>
          ) : reviewQueueQ.map(q => {
            const statusColors = { conflict: C.danger, unstable_parse: "#f97316", unverified: C.warning };
            const sc = statusColors[q.status] || C.warning;
            return (
              <div key={q.id} style={{ ...S.card, borderLeft: `3px solid ${sc}` }}>
                <div style={{ fontWeight: 600, fontSize: 12, color: sc, marginBottom: 4 }}>
                  {q.status === "conflict" ? "⚠️ 충돌" : q.status === "unstable_parse" ? "⚠️ 파싱 불안정" : "⚠️ 미확인"}
                  {q.review_reason && ` — ${q.review_reason}`}
                </div>
                <div style={{ fontSize: 13, marginBottom: 8 }}>{(q.parsed_question || q.raw_question || "").slice(0, 120)}</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button style={{ ...S.btn("success"), fontSize: 11 }} onClick={() => {
                    updateData("questions", (data.questions || []).map(x => x.id === q.id
                      ? { ...x, status: "confirmed", needs_review: false, review_reason: null } : x));
                    showToast("확인됨");
                  }}>✓ 확인</button>
                  <button style={{ ...S.btn("default"), fontSize: 11 }} onClick={() => {
                    updateData("questions", (data.questions || []).map(x => x.id === q.id
                      ? { ...x, status: "archived_reference", needs_review: false } : x));
                    showToast("보관됨");
                  }}>보관</button>
                  <button style={{ ...S.btn("danger"), fontSize: 11 }} onClick={() => {
                    updateData("questions", (data.questions || []).filter(x => x.id !== q.id));
                    showToast("삭제됨");
                  }}>삭제</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === "professors" && (
        profForm ? (
          <div style={S.card}>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>{profForm.id ? "교수 수정" : "교수 추가"}</div>
            {[["이름 *", "name", "text", "교수 이름"], ["과목", "subject", "text", "해부학"]].map(([label, key, type, ph]) => (
              <div key={key} style={{ marginBottom: 10 }}>
                <label style={S.label}>{label}</label>
                <input type={type} style={S.input} value={profForm[key]} placeholder={ph} onChange={e => setProfForm(f => ({ ...f, [key]: e.target.value }))} />
              </div>
            ))}
            <div style={{ marginBottom: 10 }}>
              <label style={S.label}>프리셋</label>
              <select style={S.input} value={profForm.preset} onChange={e => setProfForm(f => ({ ...f, preset: e.target.value, sourceWeights: PRESETS[e.target.value] || f.sourceWeights }))}>
                <option value="past-exam-heavy">기출 중심</option>
                <option value="slide-heavy">슬라이드 중심</option>
                <option value="textbook-heavy">교과서 중심</option>
              </select>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={S.label}>출제 스타일</label>
              <select style={S.input} value={profForm.focusStyle} onChange={e => setProfForm(f => ({ ...f, focusStyle: e.target.value }))}>
                <option value="distinction">감별 (distinction)</option>
                <option value="memorization">암기 (memorization)</option>
                <option value="application">적용 (application)</option>
              </select>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={S.label}>반복 경향</label>
              <select style={S.input} value={profForm.repetitionTendency} onChange={e => setProfForm(f => ({ ...f, repetitionTendency: e.target.value }))}>
                <option value="high">높음</option>
                <option value="medium">보통</option>
                <option value="low">낮음</option>
              </select>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={S.label}>메모</label>
              <textarea style={{ ...S.input, height: 70, resize: "vertical" }} value={profForm.notes} placeholder="출제 경향 메모..." onChange={e => setProfForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={S.btn("success")} onClick={saveProf}>저장</button>
              <button style={S.btn("default")} onClick={() => setProfForm(null)}>취소</button>
            </div>
          </div>
        ) : (
          <div>
            <button style={{ ...S.btn("success"), marginBottom: 12 }} onClick={() => setProfForm({ id: null, name: "", subject: "", preset: "past-exam-heavy", sourceWeights: PRESETS["past-exam-heavy"], focusStyle: "distinction", repetitionTendency: "high", notes: "" })}>
              + 교수 추가
            </button>
            {(data.professors || []).length === 0 ? (
              <div style={S.card}><div style={{ color: C.muted }}>등록된 교수 없음</div></div>
            ) : (data.professors || []).map(p => (
              <div key={p.id} style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    <div style={{ fontSize: 12, color: C.muted }}>{p.subject} · {p.preset}</div>
                    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                      <span style={S.badge(C.primary)}>{p.focusStyle}</span>
                      <span style={S.badge(C.muted)}>반복: {p.repetitionTendency}</span>
                    </div>
                    {p.notes && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{p.notes}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button style={S.btn("default")} onClick={() => setProfForm({ ...p })}>수정</button>
                    <button style={S.btn("danger")} onClick={() => { updateData("professors", (data.professors || []).filter(x => x.id !== p.id)); showToast("삭제됨"); }}>삭제</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === "migrate" && (
        <div>
          <div style={{ ...S.card, marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 10 }}>스토리지 현황</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: C.muted }}>
              <span>카드: {(data.cards || []).length}개</span>
              <span>문제: {(data.questions || []).length}개 (확인: {(data.questions || []).filter(q => q.status === "confirmed").length})</span>
              <span>교수: {(data.professors || []).length}명</span>
              <span>시험: {(data.exams || []).length}개</span>
              <span>리뷰 로그: {(data.reviewLog || []).length}건</span>
            </div>
          </div>
          {data.hasLegacy && (
            <div style={S.card}>
              <div style={{ fontWeight: 600, marginBottom: 6, color: C.warning }}>⚠️ 구 custom-quiz 데이터 발견</div>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>medstudy:questions로 이전합니다. 백업은 medstudy:backup-custom-quiz에 저장됩니다.</div>
              <button style={S.btn("success")} onClick={migrateLegacy}>마이그레이션 실행</button>
            </div>
          )}
          {!data.hasLegacy && (
            <div style={S.card}><div style={{ color: C.muted, fontSize: 13 }}>마이그레이션할 구 데이터가 없습니다.</div></div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────
// Phase 5.5: Question Family / Duplicate Helpers
// ─────────────────────────────────────────

// Build occurrence_key for a question: year|examId|professorId|sourceId
function buildOccurrenceKey(q) {
  return [q.examYear, q.examId, q.professorId, q.sourceId]
    .filter(Boolean).join("|") || "unknown";
}

// Build source_signature: stable fingerprint for deduplication
// Uses concept + intent + canonical answer (NOT raw text)
function buildSourceSignature(q) {
  return [
    q.primary_concept_id || "",
    q.question_intent || "",
    (q.canonicalAnswer || "").toLowerCase().trim().slice(0, 40),
  ].join("||");
}

// Phase 7A: Strict 3-way duplicate classification
//
// A. exact_duplicate  → same occurrence_key + same concept + intent + answer
//                       (same year, same exam_unit — wording variants of same question)
//                       → must be merged / blocked
//
// B. frequent_occurrence → different occurrence_key but same concept + intent + answer
//                          (re-examined across years/exams)
//                          → separate occurrence, but boosts frequency/importance
//
// C. distinct_same_concept → same concept but different intent
//                            → genuinely different questions, keep both
//
// Returns: "exact_duplicate" | "frequent_occurrence" | "near_duplicate" | "distinct_same_concept" | "unrelated"
function classifyDuplicate(q1, q2) {
  if (!q1.primary_concept_id || q1.primary_concept_id !== q2.primary_concept_id) return "unrelated";

  const sig1 = q1.source_signature || buildSourceSignature(q1);
  const sig2 = q2.source_signature || buildSourceSignature(q2);
  const emptySig = "||||";
  const sigMatch = sig1 === sig2 && sig1 !== emptySig && sig1.replace(/\|/g, "").length > 0;

  if (sigMatch) {
    // Same concept + same intent + same canonical answer
    const occ1 = q1.occurrence_key || buildOccurrenceKey(q1);
    const occ2 = q2.occurrence_key || buildOccurrenceKey(q2);
    // Same occurrence_key = same year + exam_unit → TRUE DUPLICATE
    if (occ1 === occ2 && occ1 !== "unknown" && occ1 !== "manual" && occ1 !== "legacy") {
      return "exact_duplicate";
    }
    // Different occurrence = re-examined in another year/exam → FREQUENT OCCURRENCE
    return "frequent_occurrence";
  }

  // Same concept, same intent, but different answer → near variant
  const intent1 = normalizeQuestionIntent(q1.question_intent);
  const intent2 = normalizeQuestionIntent(q2.question_intent);
  if (intent1 === intent2) return "near_duplicate";

  // Same concept, different intent → legitimately different question
  return "distinct_same_concept";
}

// Assign question_family_id by grouping questions with same primary_concept_id + normalized intent
// Mutates the array in-place; call after bulk import
function assignQuestionFamilies(questions) {
  const familyMap = {};
  questions.forEach(q => {
    // Phase 7A: always normalize intent before keying — prevents family fragmentation
    // from legacy intent values landing in different buckets
    const normalizedIntent = normalizeQuestionIntent(q.question_intent);
    if (q.question_intent !== normalizedIntent) q.question_intent = normalizedIntent;
    const familyKey = [
      q.primary_concept_id || "no_concept",
      normalizedIntent,
    ].join(":");
    if (!familyMap[familyKey]) familyMap[familyKey] = uid();
    if (!q.question_family_id) q.question_family_id = familyMap[familyKey];
  });
  return questions;
}

// Phase 7A: Standardized question intents (7 canonical categories)
const QUESTION_INTENTS = [
  "definition",         // What is X?
  "mechanism",          // How does X work?
  "symptom_or_result",  // What does X cause / result in?
  "comparison",         // How is X different from Y? / classification
  "location_or_structure", // Where is X? / anatomy
  "sequence_or_step",   // What is the order/step? / treatment protocol
  "identification",     // Which of the following is X? / diagnosis
];

// Map legacy intent values → canonical intents
const INTENT_NORMALIZATION_MAP = {
  symptom:        "symptom_or_result",
  complication:   "symptom_or_result",
  anatomy:        "location_or_structure",
  diagnosis:      "identification",
  treatment:      "sequence_or_step",
  classification: "comparison",
  general:        "definition", // safe fallback
};

function normalizeQuestionIntent(raw) {
  if (!raw) return "definition";
  if (QUESTION_INTENTS.includes(raw)) return raw;
  return INTENT_NORMALIZATION_MAP[raw] || "definition";
}

// Phase 7A — Task 3: confirmed_source metadata inference
// Values: "official" | "ai_user" | "user"
// Only in metadata layer — no UI impact.
function inferConfirmedSource(q) {
  if (q.confirmed_source) return q.confirmed_source;
  const src = (q.confirmationSource || "").toLowerCase();
  if (src === "legacy" || src === "manual" || src.includes("official")) return "official";
  if (src.includes("ai")) return "ai_user";
  return "user";
}

// Phase 7A — Task 6: collect IDs of concepts in foundation (search-only) scope
// Cards linked to these concepts must NOT enter quiz / decision / compression pools.
function getFoundationConceptIds(concepts) {
  return new Set(
    (concepts || []).filter(c => c.tier === "search-only").map(c => c.id)
  );
}

// ─────────────────────────────────────────
// Phase 5: Concept Data Helpers
// ─────────────────────────────────────────

// Canonical concept schema:
// {
//   id: string (English, snake_case),
//   primaryLabel: string,
//   secondaryLabel: string,
//   aliases: string[],
//   linkedConceptIds: string[],    // related but distinct
//   subject: string,
//   topics: string[],
//   linkedCardIds: string[],       // cards with primary_concept_id = this.id
//   linkedQuestionIds: string[],   // questions with primary_concept_id = this.id
//   explanations: {
//     quick: string,
//     detailed: string,
//     pastExam: string,
//     textbook: string,
//   },
//   tier: "active" | "passive" | "search-only",
//   importance: number,
//   createdAt: string,
// }

function makeBlankConcept(overrides) {
  return {
    id: "", primaryLabel: "", secondaryLabel: "",
    aliases: [], linkedConceptIds: [],
    subject: "", topics: [],
    linkedCardIds: [], linkedQuestionIds: [],
    explanations: { quick: "", detailed: "", pastExam: "", textbook: "" },
    tier: "active", importance: 0,
    // Phase 5.5 fields
    stub: false,
    needs_review: false,
    created_from: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// Rebuild concept link arrays from cards/questions
// Call when saving concept or after bulk card import
function rebuildConceptLinks(concept, cards, questions) {
  const linkedCardIds = (cards || [])
    .filter(c => c.primary_concept_id === concept.id)
    .map(c => c.id);
  const linkedQuestionIds = (questions || [])
    .filter(q => q.primary_concept_id === concept.id)
    .map(q => q.id);
  return { ...concept, linkedCardIds, linkedQuestionIds };
}

// ─────────────────────────────────────────
// ConceptPage — Phase 5
// ─────────────────────────────────────────
function ConceptPage({ data, updateData, showToast }) {
  const [view, setView] = useState("list");          // list | detail | create | edit
  const [selected, setSelected] = useState(null);    // concept id
  const [form, setForm] = useState(null);
  const [search, setSearch] = useState("");
  const [linkTarget, setLinkTarget] = useState("");  // for adding linkedConceptIds

  const concepts = data.concepts || [];
  const cards = data.cards || [];
  const questions = data.questions || [];

  const conceptById = {};
  concepts.forEach(c => { conceptById[c.id] = c; });

  const filtered = concepts.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (c.id || "").toLowerCase().includes(q)
      || (c.primaryLabel || "").toLowerCase().includes(q)
      || (c.secondaryLabel || "").toLowerCase().includes(q)
      || (c.aliases || []).some(a => a.toLowerCase().includes(q));
  });

  function openCreate() {
    setForm(makeBlankConcept());
    setView("create");
  }

  function openEdit(concept) {
    setForm({
      ...concept,
      aliasInput: (concept.aliases || []).join(", "),
      topicsInput: (concept.topics || []).join(", "),
      linkedConceptInput: "",
    });
    setView("edit");
  }

  function saveConcept() {
    if (!form.id.trim()) { showToast("개념 ID 필수 (영문 snake_case)", "error"); return; }
    if (!form.primaryLabel.trim()) { showToast("기본 라벨 필수", "error"); return; }
    const idClean = form.id.trim().replace(/\s+/g, "_");
    // id uniqueness check (on create)
    if (view === "create" && conceptById[idClean]) { showToast("이미 존재하는 ID", "error"); return; }
    const aliases = (form.aliasInput || "").split(",").map(a => a.trim()).filter(Boolean);
    const topics = (form.topicsInput || "").split(",").map(t => t.trim()).filter(Boolean);
    const built = makeBlankConcept({
      ...form,
      id: idClean,
      aliases,
      topics,
    });
    const rebuilt = rebuildConceptLinks(built, cards, questions);
    let newConcepts;
    if (view === "edit") {
      newConcepts = concepts.map(c => c.id === rebuilt.id ? rebuilt : c);
    } else {
      newConcepts = [...concepts, rebuilt];
    }
    updateData("concepts", newConcepts);
    showToast("개념 저장됨");
    setView("list");
    setForm(null);
  }

  function deleteConcept(id) {
    updateData("concepts", concepts.filter(c => c.id !== id));
    showToast("삭제됨");
    setView("list");
  }

  function addLinkedConcept(targetId) {
    if (!targetId || !conceptById[targetId]) { showToast("존재하지 않는 개념 ID", "error"); return; }
    if ((form.linkedConceptIds || []).includes(targetId)) { showToast("이미 연결됨"); return; }
    if (targetId === form.id) { showToast("자기 자신 연결 불가", "error"); return; }
    setForm(f => ({ ...f, linkedConceptIds: [...(f.linkedConceptIds || []), targetId] }));
    setLinkTarget("");
  }

  function removeLinkedConcept(targetId) {
    setForm(f => ({ ...f, linkedConceptIds: (f.linkedConceptIds || []).filter(x => x !== targetId) }));
  }

  // ── List view ──
  if (view === "list") {
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0, color: C.primary }}>개념 허브</h2>
          <button style={S.btn("success")} onClick={openCreate}>+ 개념 추가</button>
        </div>

        <input style={{ ...S.input, marginBottom: 12 }} placeholder="ID / 라벨 / 별칭 검색..." value={search} onChange={e => setSearch(e.target.value)} />

        <div style={{ display: "flex", gap: 10, marginBottom: 14, fontSize: 12, color: C.muted }}>
          <span>총 {concepts.length}개</span>
          <span>Active: {concepts.filter(c => c.tier === "active").length}</span>
          <span>Passive: {concepts.filter(c => c.tier === "passive").length}</span>
        </div>

        {filtered.length === 0 && (
          <div style={S.card}><div style={{ color: C.muted }}>개념이 없습니다. + 개념 추가로 시작하세요.</div></div>
        )}

        {filtered.map(concept => {
          const linkedCards = cards.filter(c => c.primary_concept_id === concept.id);
          const linkedQs = questions.filter(q => q.primary_concept_id === concept.id);
          const tierColor = concept.tier === "active" ? C.success : concept.tier === "passive" ? C.warning : C.muted;
          return (
            <div key={concept.id} style={{ ...S.card, cursor: "pointer", borderLeft: "3px solid " + tierColor }}
              onClick={() => { setSelected(concept.id); setView("detail"); }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{concept.primaryLabel}</div>
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 1 }}>{concept.id} · {concept.subject}</div>
                  {concept.secondaryLabel && <div style={{ fontSize: 12, color: C.muted }}>{concept.secondaryLabel}</div>}
                  <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                    <span style={S.badge(tierColor)}>{concept.tier}</span>
                    <span style={S.badge(C.primary)}>{linkedCards.length}카드</span>
                    <span style={S.badge(C.success)}>{linkedQs.length}문제</span>
                    {(concept.linkedConceptIds || []).length > 0 && (
                      <span style={S.badge(C.muted)}>연결: {concept.linkedConceptIds.length}</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // ── Detail view ──
  if (view === "detail" && selected) {
    const concept = conceptById[selected];
    if (!concept) { setView("list"); return null; }
    const linkedCards  = cards.filter(c => c.primary_concept_id === concept.id);
    const linkedQs     = questions.filter(q => q.primary_concept_id === concept.id);
    const secLinkedCards = cards.filter(c => (c.linked_concepts || []).includes(concept.id));
    const tierColor    = concept.tier === "active" ? C.success : concept.tier === "passive" ? C.warning : C.muted;

    return (
      <div>
        {/* Nav row */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
          <button style={S.btn("default")} onClick={() => setView("list")}>← 목록</button>
          <button style={S.btn("default")} onClick={() => openEdit(concept)}>수정</button>
          <button style={S.btn("danger")} onClick={() => deleteConcept(concept.id)}>삭제</button>
        </div>

        {/* 1. Title / Labels */}
        <div style={{ ...S.card, borderLeft: "3px solid " + tierColor, marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.3 }}>{concept.primaryLabel}</div>
              {concept.secondaryLabel && (
                <div style={{ fontSize: 14, color: C.primary, marginTop: 3 }}>{concept.secondaryLabel}</div>
              )}
              <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{concept.id}</div>
            </div>
            <div style={{ flexShrink: 0 }}>
              <span style={S.badge(tierColor)}>{concept.tier}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 5, marginTop: 8, flexWrap: "wrap" }}>
            <span style={S.badge(C.muted)}>{concept.subject}</span>
            {(concept.topics || []).map((t, i) => (
              <span key={i} style={S.badge(C.primary)}>{t}</span>
            ))}
          </div>
          {(concept.aliases || []).length > 0 && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>
              별칭: {concept.aliases.join(" / ")}
            </div>
          )}
        </div>

        {/* 2. Quick summary (highest-priority explanation) */}
        {concept.explanations && concept.explanations.quick && (
          <div style={{ ...S.card, borderLeft: "3px solid " + C.primary }}>
            <span style={S.sectionLabel}>요약</span>
            <div style={{ fontSize: 14, lineHeight: 1.6 }}>{concept.explanations.quick}</div>
          </div>
        )}

        {/* 3. Active primary-linked cards */}
        <div style={S.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={S.sectionLabel}>연결 카드 ({linkedCards.length})</span>
          </div>
          {linkedCards.length === 0 ? (
            <div style={{ fontSize: 13, color: C.muted }}>연결된 카드 없음</div>
          ) : linkedCards.slice(0, 8).map(c => (
            <div key={c.id} style={{ padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>{c.subject} · {c.chapter}</div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{c.front}</div>
              <div style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>{c.back}</div>
            </div>
          ))}
          {linkedCards.length > 8 && (
            <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>+{linkedCards.length - 8}개 더</div>
          )}
        </div>

        {/* 4. Linked questions */}
        <div style={S.card}>
          <span style={S.sectionLabel}>연결된 문제 ({linkedQs.length})</span>
          {linkedQs.length === 0 ? (
            <div style={{ fontSize: 13, color: C.muted }}>연결된 문제 없음</div>
          ) : linkedQs.slice(0, 5).map(q => (
            <div key={q.id} style={{ padding: "6px 0", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: "flex", gap: 5, marginBottom: 3 }}>
                <span style={S.badge(q.status === "confirmed" ? C.success : C.warning)}>
                  {q.status || "unverified"}
                </span>
                <span style={{ fontSize: 11, color: C.muted }}>{q.subject}</span>
              </div>
              <div style={{ fontSize: 13 }}>{(q.parsed_question || q.raw_question || "").slice(0, 110)}</div>
            </div>
          ))}
          {linkedQs.length > 5 && (
            <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>+{linkedQs.length - 5}개 더</div>
          )}
        </div>

        {/* 5. Detailed / pastExam explanation (expandable) */}
        {concept.explanations && (concept.explanations.detailed || concept.explanations.pastExam) && (
          <div style={S.card}>
            <span style={S.sectionLabel}>상세 설명</span>
            {concept.explanations.pastExam && (
              <div style={{ marginBottom: 10, paddingLeft: 10, borderLeft: `2px solid ${C.warning}` }}>
                <div style={{ fontSize: 11, color: C.warning, fontWeight: 600, marginBottom: 3 }}>기출 설명</div>
                <div style={{ fontSize: 13, lineHeight: 1.6 }}>{concept.explanations.pastExam}</div>
              </div>
            )}
            {concept.explanations.detailed && (
              <details>
                <summary style={{ fontSize: 12, color: C.muted, cursor: "pointer", userSelect: "none" }}>
                  상세 내용 보기
                </summary>
                <div style={{ fontSize: 13, lineHeight: 1.7, marginTop: 8 }}>{concept.explanations.detailed}</div>
              </details>
            )}
          </div>
        )}

        {/* 6. Linked concepts */}
        {(concept.linkedConceptIds || []).length > 0 && (
          <div style={S.card}>
            <span style={S.sectionLabel}>연결 개념</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {concept.linkedConceptIds.map(cid => {
                const linked = conceptById[cid];
                return (
                  <span key={cid} style={{ ...S.badge(C.primary), cursor: "pointer" }}
                    onClick={() => setSelected(cid)}>
                    {linked ? linked.primaryLabel : cid}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* 7. Reference: textbook explanation + secondary cards */}
        {(concept.explanations && concept.explanations.textbook) && (
          <div style={{ ...S.card, opacity: 0.85 }}>
            <span style={S.sectionLabel}>교과서 참조</span>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
              {concept.explanations.textbook}
            </div>
          </div>
        )}
        {secLinkedCards.length > 0 && (
          <div style={{ ...S.card, opacity: 0.8 }}>
            <span style={S.sectionLabel}>2차 연결 카드 ({secLinkedCards.length})</span>
            {secLinkedCards.slice(0, 4).map(c => (
              <div key={c.id} style={{ padding: "5px 0", borderBottom: `1px solid ${C.border}`, fontSize: 12 }}>
                <div style={{ color: C.muted, fontSize: 11 }}>{c.subject}</div>
                <div>{c.front}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Create / Edit form ──
  if ((view === "create" || view === "edit") && form) {
    return (
      <div>
        <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
          <button style={S.btn("default")} onClick={() => { setView("list"); setForm(null); }}>← 취소</button>
          <h2 style={{ margin: 0, color: C.primary }}>{view === "create" ? "개념 추가" : "개념 수정"}</h2>
        </div>

        <div style={S.card}>
          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>개념 ID * (영문 snake_case, 변경 불가)</label>
            <input style={{ ...S.input, opacity: view === "edit" ? 0.5 : 1 }}
              value={form.id} readOnly={view === "edit"}
              placeholder="예: radial_nerve_injury"
              onChange={e => setForm(f => ({ ...f, id: e.target.value.replace(/\s/g, "_") }))} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={S.label}>기본 라벨 (한글) *</label>
              <input style={S.input} value={form.primaryLabel} placeholder="예: 요골신경 손상"
                onChange={e => setForm(f => ({ ...f, primaryLabel: e.target.value }))} />
            </div>
            <div>
              <label style={S.label}>보조 라벨 (영문)</label>
              <input style={S.input} value={form.secondaryLabel} placeholder="예: Radial nerve injury"
                onChange={e => setForm(f => ({ ...f, secondaryLabel: e.target.value }))} />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={S.label}>과목</label>
              <select style={S.input} value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}>
                {["", "해부학","생리학","생화학","약리학","병리학","미생물학","기타"].map(s => <option key={s} value={s}>{s || "선택 안 함"}</option>)}
              </select>
            </div>
            <div>
              <label style={S.label}>Tier</label>
              <select style={S.input} value={form.tier} onChange={e => setForm(f => ({ ...f, tier: e.target.value }))}>
                <option value="active">active (직접 복습)</option>
                <option value="passive">passive (보관)</option>
                <option value="search-only">search-only (참조전용)</option>
              </select>
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>별칭 aliases (쉼표 구분) — 동의어만, 연결 개념 아님</label>
            <input style={S.input} value={form.aliasInput || ""} placeholder="예: radial nerve palsy, 요골신경 마비"
              onChange={e => setForm(f => ({ ...f, aliasInput: e.target.value }))} />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>토픽 (쉼표 구분)</label>
            <input style={S.input} value={form.topicsInput || ""} placeholder="예: 상지, 신경"
              onChange={e => setForm(f => ({ ...f, topicsInput: e.target.value }))} />
          </div>

          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, marginTop: 4 }}>설명 레이어</div>
          {[["quick","Quick 설명 (핵심 1줄)"],["detailed","상세 설명 (메커니즘)"],["pastExam","기출 설명"],["textbook","교과서 설명"]].map(([key, label]) => (
            <div key={key} style={{ marginBottom: 10 }}>
              <label style={S.label}>{label}</label>
              <textarea style={{ ...S.input, height: 56, resize: "vertical" }}
                value={(form.explanations || {})[key] || ""}
                onChange={e => setForm(f => ({ ...f, explanations: { ...f.explanations, [key]: e.target.value } }))} />
            </div>
          ))}

          {/* Linked Concepts */}
          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>연결 개념 (linked_concepts) — 관련 다른 개념, 동의어 아님</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
              {(form.linkedConceptIds || []).map(cid => (
                <span key={cid} style={{ ...S.badge(C.primary), cursor: "pointer" }}
                  onClick={() => removeLinkedConcept(cid)}>
                  {(conceptById[cid] && conceptById[cid].primaryLabel) || cid} ✕
                </span>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input style={{ ...S.input, flex: 1 }} value={linkTarget} placeholder="연결할 개념 ID 입력 후 추가"
                onChange={e => setLinkTarget(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { addLinkedConcept(linkTarget); } }} />
              <button style={S.btn("default")} onClick={() => addLinkedConcept(linkTarget)}>추가</button>
            </div>
            {concepts.length > 0 && (
              <select style={{ ...S.input, marginTop: 6 }} value="" onChange={e => { if (e.target.value) addLinkedConcept(e.target.value); }}>
                <option value="">목록에서 선택...</option>
                {concepts.filter(c => c.id !== form.id).map(c => (
                  <option key={c.id} value={c.id}>{c.primaryLabel} ({c.id})</option>
                ))}
              </select>
            )}
          </div>

          <button style={S.btn("success")} onClick={saveConcept}>저장</button>
        </div>
      </div>
    );
  }

  return null;
}

// ─────────────────────────────────────────
// Phase 6: DecisionTrainingPage
// Confusion-linked MCQ — compare similar cards from the same cluster.
// Distractors are other cards within the same cluster (same subject+chapter, also wrong before).
// After a wrong answer, shows short distinction-focused corrective feedback.
// ─────────────────────────────────────────
function DecisionTrainingPage({ data, logReview, showToast, refreshClusters }) {
  const [clusterId, setClusterId] = useState(null);
  const [session, setSession] = useState(null);
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [results, setResults] = useState([]);

  const clusters = data.confusionClusters || [];
  // Phase 7A Task 6: exclude foundation (search-only) concept cards from decision training
  const foundationIds = getFoundationConceptIds(data.concepts);
  const cardById = {};
  (data.cards || [])
    .filter(c => !c.primary_concept_id || !foundationIds.has(c.primary_concept_id))
    .forEach(c => { cardById[c.id] = c; });

  function buildSession(cid) {
    const cluster = clusters.find(c => c.id === cid);
    if (!cluster) return;
    const clusterCards = (cluster.card_ids || []).map(id => cardById[id]).filter(Boolean);
    if (clusterCards.length < 2) { showToast("감별 훈련에는 카드가 2장 이상 필요합니다.", "error"); return; }

    const items = shuffleArr(clusterCards).map(card => {
      const distractors = clusterCards
        .filter(c => c.id !== card.id)
        .slice(0, 3)
        .map(c => ({ text: c.back, correct: false, cardId: c.id }));
      const correctOpt = { text: card.back, correct: true, cardId: card.id };
      const options = shuffleArr([correctOpt, ...distractors]);
      return { card, options };
    });

    setSession(items);
    setCurrent(0);
    setSelected(null);
    setRevealed(false);
    setResults([]);
    setClusterId(cid);
  }

  function submit() {
    if (selected === null) return;
    const item = session[current];
    const correct = item.options[selected].correct;
    setRevealed(true);
    logReview({ cardId: item.card.id, questionId: null, correct, mode: "decision_training", responseTimeSec: 0 });
    setResults(prev => [...prev, { item, selected, correct }]);
  }

  function next() {
    if (current + 1 >= session.length) {
      if (refreshClusters) refreshClusters();
      setCurrent(session.length);
    } else {
      setCurrent(c => c + 1);
      setSelected(null);
      setRevealed(false);
    }
  }

  // Results screen
  if (session && current >= session.length) {
    const correctCount = results.filter(r => r.correct).length;
    const acc = results.length > 0 ? Math.round(correctCount / results.length * 100) : 0;
    const cluster = clusters.find(c => c.id === clusterId);
    return (
      <div>
        <h2 style={{ margin: "0 0 16px", color: C.primary }}>감별 훈련 완료</h2>
        <div style={S.card}>
          <div style={{ fontSize: 36, fontWeight: 700, color: acc >= 70 ? C.success : C.warning, marginBottom: 4 }}>{acc}%</div>
          <div style={{ color: C.muted }}>{correctCount}/{results.length} 정답 · {cluster ? cluster.label : ""}</div>
        </div>
        {results.filter(r => !r.correct).length > 0 && (
          <div style={S.card}>
            <div style={{ fontWeight: 600, color: C.danger, fontSize: 13, marginBottom: 10 }}>오답 복기</div>
            {results.filter(r => !r.correct).map((r, i) => {
              const chosen = r.item.options[r.selected];
              const correctOpt = r.item.options.find(o => o.correct);
              return (
                <div key={i} style={{ padding: "8px 0", borderBottom: "1px solid " + C.border }}>
                  <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>{r.item.card.subject} · {r.item.card.chapter}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{r.item.card.front}</div>
                  <div style={{ fontSize: 12, color: C.danger }}>❌ 선택: {chosen ? chosen.text : ""}</div>
                  <div style={{ fontSize: 12, color: C.success }}>✓ 정답: {correctOpt ? correctOpt.text : ""}</div>
                </div>
              );
            })}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button style={S.btn("default")} onClick={() => { setSession(null); setCurrent(0); setResults([]); }}>다른 클러스터</button>
          {clusterId && <button style={S.btn("success")} onClick={() => buildSession(clusterId)}>다시 훈련</button>}
        </div>
      </div>
    );
  }

  // Cluster picker screen
  if (!session) {
    if (clusters.length === 0) {
      return (
        <div>
          <h2 style={{ margin: "0 0 16px", color: C.primary }}>감별 훈련</h2>
          <div style={S.card}>
            <div style={{ color: C.muted, fontSize: 14 }}>감별 훈련 클러스터가 없습니다.</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>복습·플래시카드를 진행하면 오답 패턴에서 자동으로 클러스터가 생성됩니다.</div>
          </div>
        </div>
      );
    }
    return (
      <div>
        <h2 style={{ margin: "0 0 16px", color: C.primary }}>감별 훈련</h2>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 14 }}>
          오답이 반복된 개념 그룹에서 유사 선지를 구별하는 훈련입니다.
        </div>
        {clusters.map(cl => {
          const clCards = (cl.card_ids || []).map(id => cardById[id]).filter(Boolean);
          const scoreColor = cl.confusion_score >= 0.7 ? C.danger : cl.confusion_score >= 0.4 ? C.warning : C.muted;
          return (
            <div key={cl.id} style={{ ...S.card, borderLeft: "3px solid " + scoreColor }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{cl.label}</div>
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
                    카드 {clCards.length}장 · 오답률 {Math.round(cl.confusion_score * 100)}%
                    {cl.question_ids && cl.question_ids.length > 0 && " · 연결 문제 " + cl.question_ids.length + "개"}
                  </div>
                </div>
                {clCards.length >= 2
                  ? <button style={S.btn("success")} onClick={() => buildSession(cl.id)}>훈련 시작</button>
                  : <span style={{ fontSize: 12, color: C.muted }}>카드 부족</span>
                }
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Active session
  const item = session[current];
  const correctOpt = item.options.find(o => o.correct);
  const chosenOpt = selected !== null ? item.options[selected] : null;
  const isWrong = revealed && chosenOpt && !chosenOpt.correct;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, fontSize: 13, color: C.muted }}>
        <span>감별 훈련 · {clusters.find(c => c.id === clusterId) ? clusters.find(c => c.id === clusterId).label : ""}</span>
        <span>{current + 1} / {session.length}</span>
      </div>
      <div style={{ height: 4, background: C.border, borderRadius: 9999, marginBottom: 16, overflow: "hidden" }}>
        <div style={{ height: "100%", background: C.warning, width: (current / session.length * 100) + "%", transition: "width 0.2s" }} />
      </div>

      <div style={{ ...S.card, textAlign: "center", paddingTop: 20, paddingBottom: 20 }}>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>{item.card.subject} · {item.card.chapter}</div>
        <div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.6 }}>{item.card.front}</div>
      </div>

      <div style={{ marginBottom: 12 }}>
        {item.options.map((opt, i) => {
          let borderCol = C.border;
          let bgCol = "transparent";
          if (revealed) {
            if (opt.correct) { borderCol = C.success; bgCol = C.success + "22"; }
            else if (selected === i) { borderCol = C.danger; bgCol = C.danger + "22"; }
          } else if (selected === i) {
            borderCol = C.primary; bgCol = C.primary + "22";
          }
          return (
            <div key={i} onClick={() => { if (!revealed) setSelected(i); }}
              style={{ padding: "10px 14px", marginBottom: 8, borderRadius: 8, border: "1px solid " + borderCol, background: bgCol, cursor: revealed ? "default" : "pointer", fontSize: 14, transition: "background 0.15s" }}>
              <span style={{ fontWeight: 700, marginRight: 8, color: C.muted }}>{["①","②","③","④"][i]}</span>
              {opt.text}
              {revealed && opt.correct && <span style={{ marginLeft: 8, color: C.success, fontWeight: 700 }}>✓</span>}
              {revealed && selected === i && !opt.correct && <span style={{ marginLeft: 8, color: C.danger, fontWeight: 700 }}>✗</span>}
            </div>
          );
        })}
      </div>

      {/* Distinction-focused corrective feedback — only shown on wrong answer */}
      {isWrong && (
        <div style={{ ...S.card, borderLeft: "3px solid " + C.warning, padding: "10px 14px", marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: C.warning, fontWeight: 700, marginBottom: 6 }}>구별 포인트</div>
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            <span style={{ color: C.danger }}>선택: </span>{chosenOpt.text}
          </div>
          <div style={{ fontSize: 13 }}>
            <span style={{ color: C.success }}>정답: </span>{correctOpt ? correctOpt.text : ""}
          </div>
          {item.card.explanations && item.card.explanations.quick && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 6, borderTop: "1px solid " + C.border, paddingTop: 6 }}>
              {item.card.explanations.quick}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        {!revealed
          ? <button style={{ ...S.btn("success"), flex: 1 }} onClick={submit} disabled={selected === null}>제출</button>
          : <button style={{ ...S.btn(), flex: 1 }} onClick={next}>다음 →</button>
        }
      </div>
    </div>
  );
}

// ─────────────────────────────────────────
// Phase 6: CompressionPage
// Compressed high-yield scan: danger + high-importance top 25% + confusion cluster cards.
// All content (front + back) visible immediately — no flip.
// Tap "확인" to mark scanned. Tap "해설 보기" for explanation.
// ─────────────────────────────────────────
function CompressionPage({ data, getUpcomingExams }) {
  const [expanded, setExpanded] = useState({});
  const [scanned, setScanned] = useState({});
  const [examScope, setExamScope] = useState("전체");
  const [scopeType, setScopeType] = useState("all");

  const upcomingExams = getUpcomingExams();

  function buildPool() {
    // Phase 7A Task 6: strip foundation (search-only) concept cards from compression pool
    const foundationIds = getFoundationConceptIds(data.concepts);
    let cards = (data.cards || []).filter(c =>
      !c.primary_concept_id || !foundationIds.has(c.primary_concept_id)
    );

    cards = filterByExamScopeTyped(cards, data.exams || [], examScope, scopeType);

    const dangerIds = getDangerCardIds(data.reviewLog);
    const dangerCards = cards.filter(c => dangerIds.has(c.id));

    const scored = cards
      .map(c => ({ c, imp: calcImportance(c, data.reviewLog, data.questions, data.confusionClusters) }))
      .sort((a, b) => b.imp - a.imp);
    const topN = Math.max(1, Math.ceil(scored.length * 0.25));
    const highImpCards = scored.slice(0, topN).map(x => x.c);

    const clusterCardIds = new Set(
      (data.confusionClusters || []).flatMap(cl => cl.card_ids || [])
    );
    const clusterCards = cards.filter(c => clusterCardIds.has(c.id));

    const seen = new Set();
    const pool = [];
    [...dangerCards, ...highImpCards, ...clusterCards].forEach(c => {
      if (!seen.has(c.id)) { seen.add(c.id); pool.push(c); }
    });

    return pool.map(c => ({
      card: c,
      isDanger: dangerIds.has(c.id),
      isCluster: clusterCardIds.has(c.id),
      importance: calcImportance(c, data.reviewLog, data.questions, data.confusionClusters),
    })).sort((a, b) => {
      if (a.isDanger !== b.isDanger) return a.isDanger ? -1 : 1;
      return b.importance - a.importance;
    });
  }

  const pool = buildPool();
  const scannedCount = Object.keys(scanned).length;

  return (
    <div>
      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <h2 style={{ margin: 0, color: C.text, fontWeight: 700, fontSize: 18 }}>압축 복습</h2>
        <span style={{ fontSize: 12, color: scannedCount === pool.length && pool.length > 0 ? C.success : C.muted, fontWeight: 600 }}>
          {scannedCount}/{pool.length}
        </span>
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
        위험 카드 · 고중요도 상위 25% · 혼동 클러스터 — 답이 바로 보입니다.
      </div>

      {upcomingExams.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <select value={examScope} onChange={e => { setExamScope(e.target.value); setScopeType("all"); setScanned({}); }}
            style={{ ...S.input, width: "auto" }}>
            <option value="전체">전체 범위</option>
            {upcomingExams.map(e => (
              <option key={e.id} value={e.id}>{e.name} (D-{daysUntil(e.date)})</option>
            ))}
          </select>
          {examScope !== "전체" && (
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              {[["all", "전체"], ["direct", "직접 출제"], ["foundation", "배경지식"]].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => { setScopeType(key); setScanned({}); }}
                  style={{ ...S.btn(scopeType === key ? "primary" : "default"), fontSize: 12, padding: "6px 10px" }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {pool.length === 0 && (
        <div style={S.card}>
          <div style={{ color: C.muted }}>압축 복습 항목이 없습니다. 복습·퀴즈를 먼저 진행하세요.</div>
        </div>
      )}

      {pool.map(({ card, isDanger, isCluster, importance }) => {
        const isExpanded = !!expanded[card.id];
        const isScanned  = !!scanned[card.id];
        const accentColor = isDanger ? C.danger : isCluster ? C.warning : C.primary;
        return (
          <div key={card.id} style={{
            ...S.card,
            borderLeft: `3px solid ${accentColor}`,
            opacity: isScanned ? 0.45 : 1,
            transition: "opacity 0.2s",
            padding: "10px 14px",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* Labels row — keep minimal */}
                <div style={{ display: "flex", gap: 5, marginBottom: 5, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: C.muted }}>{card.subject}{card.chapter ? " · " + card.chapter : ""}</span>
                  {isDanger  && <span style={S.badge(C.danger)}>위험</span>}
                  {isCluster && !isDanger && <span style={S.badge(C.warning)}>혼동</span>}
                </div>
                {/* Front */}
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 5, lineHeight: 1.5 }}>{card.front}</div>
                <CardImage image_url={card.image_url} image_present={card.image_present} image_ref={card.image_ref} />
                {/* Back — always visible, visually distinct */}
                <div style={{ fontSize: 13, color: C.primary, lineHeight: 1.5 }}>{card.back}</div>
                {/* Explanation toggle */}
                {card.explanations && card.explanations.quick && (
                  <div style={{ marginTop: 6 }}>
                    {isExpanded ? (
                      <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginTop: 2, paddingTop: 6, borderTop: `1px solid ${C.border}` }}>
                        {card.explanations.quick}
                      </div>
                    ) : (
                      <span
                        onClick={() => setExpanded(e => ({ ...e, [card.id]: true }))}
                        style={{ fontSize: 11, color: C.muted, cursor: "pointer", borderBottom: `1px solid ${C.muted}` }}>
                        해설 보기
                      </span>
                    )}
                  </div>
                )}
              </div>
              {/* Check button */}
              <button
                onClick={() => setScanned(s => {
                  if (isScanned) { const n = { ...s }; delete n[card.id]; return n; }
                  return { ...s, [card.id]: true };
                })}
                style={{ ...S.btn(isScanned ? "default" : "success"), fontSize: 11, padding: "5px 10px", flexShrink: 0 }}>
                {isScanned ? "취소" : "확인"}
              </button>
            </div>
          </div>
        );
      })}

      {pool.length > 0 && scannedCount === pool.length && (
        <div style={{ ...S.card, background: C.success + "1a", border: `1px solid ${C.success}`, textAlign: "center", marginTop: 8 }}>
          <div style={{ color: C.success, fontWeight: 700, fontSize: 15 }}>압축 복습 완료</div>
        </div>
      )}
    </div>
  );
}
