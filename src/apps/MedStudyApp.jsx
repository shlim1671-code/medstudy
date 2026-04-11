import { useState, useEffect, useContext, createContext } from "react";

// ─────────────────────────────────────────
// Theme Context
// ─────────────────────────────────────────
const ThemeContext = createContext();

const THEME_LIGHT = {
  bg: "#F2F2F7",
  surface: "#FFFFFF",
  surface2: "#F2F2F7",
  border: "#E5E5EA",
  text: "#1C1C1E",
  muted: "#8E8E93",
  accent: "#0EA5E9",
  accentDim: "#E0F2FE",
  accentText: "#0284C7",
  success: "#16A34A",
  successDim: "#DCFCE7",
  danger: "#DC2626",
  dangerDim: "#FEE2E2",
};

const THEME_DARK = {
  bg: "#111111",
  surface: "#1A1A1A",
  surface2: "#222222",
  border: "#2A2A2A",
  text: "#E8E8EC",
  muted: "#6B7280",
  accent: "#0EA5E9",
  accentDim: "rgba(14,165,233,0.15)",
  accentText: "#38BDF8",
  success: "#4ADE80",
  successDim: "rgba(74,222,128,0.12)",
  danger: "#F87171",
  dangerDim: "rgba(248,113,113,0.12)",
};

function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}

function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("medstudy-theme-preference");
    return saved === "dark" ? "dark" : "light";
  });

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    localStorage.setItem("medstudy-theme-preference", theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  };

  const colors = theme === "light" ? THEME_LIGHT : THEME_DARK;

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, colors }}>
      {children}
    </ThemeContext.Provider>
  );
}

// ─────────────────────────────────────────
// Header Component
// ─────────────────────────────────────────
function Header() {
  const { toggleTheme, theme, colors } = useTheme();

  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        background: colors.surface,
        borderBottom: `1px solid ${colors.border}`,
        padding: "12px 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: colors.text }}>
          MedStudy{" "}
          <span style={{ color: colors.accent }}>AI</span>
        </span>
      </div>
      <button
        onClick={toggleTheme}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: 20,
          padding: "6px 8px",
          borderRadius: 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: colors.text,
          transition: "background 0.2s",
        }}
        onMouseEnter={(e) => (e.target.style.background = colors.accentDim)}
        onMouseLeave={(e) => (e.target.style.background = "none")}
      >
        {theme === "light" ? "🌙" : "☀️"}
      </button>
    </header>
  );
}

// ─────────────────────────────────────────
// Tab Navigation Component
// ─────────────────────────────────────────
const TABS = [
  { id: "home", label: "홈" },
  { id: "review", label: "복습" },
  { id: "quiz", label: "퀴즈" },
  { id: "plan", label: "플랜" },
  { id: "stats", label: "통계" },
  { id: "concept", label: "개념" },
  { id: "manage", label: "관리" },
];

function TabNavigation({ activeTab, onTabChange }) {
  const { colors } = useTheme();

  return (
    <nav
      style={{
        display: "flex",
        gap: 0,
        borderBottom: `1px solid ${colors.border}`,
        background: colors.surface,
        overflowX: "auto",
        WebkitOverflowScrolling: "touch",
      }}
    >
      {TABS.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            style={{
              flex: "0 0 auto",
              padding: "12px 16px",
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 500,
              color: isActive ? colors.accent : colors.text,
              borderBottom: isActive ? `3px solid ${colors.accent}` : "none",
              transition: "color 0.2s, border-color 0.2s",
              whiteSpace: "nowrap",
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

// ─────────────────────────────────────────
// Home Page Components
// ─────────────────────────────────────────
function StatCard({ label, value, colors }) {
  return (
    <div
      style={{
        flex: 1,
        textAlign: "center",
        padding: "16px 12px",
        background: colors.surface,
        borderRadius: 12,
        border: `1px solid ${colors.border}`,
      }}
    >
      <div
        style={{
          fontSize: 24,
          fontWeight: 700,
          color: colors.accent,
          marginBottom: 8,
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 12, color: colors.muted, fontWeight: 500 }}>
        {label}
      </div>
    </div>
  );
}

function ReviewCard({ colors }) {
  const progress = 62;
  return (
    <div
      style={{
        background: colors.surface,
        borderRadius: 16,
        border: `1px solid ${colors.border}`,
        padding: "20px 16px",
        marginBottom: 16,
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: colors.accent,
          fontWeight: 600,
          marginBottom: 12,
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}
      >
        오늘 복습
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: colors.text,
          marginBottom: 4,
        }}
      >
        해부학 · 상지
      </div>
      <div
        style={{
          fontSize: 14,
          color: colors.muted,
          marginBottom: 16,
        }}
      >
        24카드 중 15개 완료
      </div>

      {/* Progress Bar */}
      <div
        style={{
          width: "100%",
          height: 8,
          background: colors.surface2,
          borderRadius: 4,
          marginBottom: 16,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${progress}%`,
            height: "100%",
            background: colors.accent,
            borderRadius: 4,
            transition: "width 0.3s ease",
          }}
        />
      </div>

      {/* Badges */}
      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 16,
        }}
      >
        <div
          style={{
            display: "inline-block",
            padding: "6px 12px",
            background: colors.accentDim,
            color: colors.accentText,
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          24 카드
        </div>
        <div
          style={{
            display: "inline-block",
            padding: "6px 12px",
            background: colors.dangerDim,
            color: colors.danger,
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          D-8 본시험
        </div>
      </div>

      {/* Button */}
      <button
        style={{
          width: "100%",
          padding: "14px 16px",
          background: colors.accent,
          color: "#FFFFFF",
          border: "none",
          borderRadius: 12,
          fontSize: 16,
          fontWeight: 600,
          cursor: "pointer",
          transition: "opacity 0.2s",
        }}
        onMouseEnter={(e) => (e.target.style.opacity = 0.9)}
        onMouseLeave={(e) => (e.target.style.opacity = 1)}
      >
        복습 시작 →
      </button>
    </div>
  );
}

function FlashcardCard({ colors }) {
  return (
    <div
      style={{
        background: colors.surface,
        borderRadius: 16,
        border: `1px solid ${colors.border}`,
        padding: "20px 16px",
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: colors.accent,
          fontWeight: 600,
          marginBottom: 16,
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}
      >
        플래시카드
      </div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 500,
          color: colors.text,
          lineHeight: 1.5,
          marginBottom: 20,
        }}
      >
        요골신경이 손상될 때 나타나는 특징적인 자세는?
      </div>

      {/* Action Buttons */}
      <div
        style={{
          display: "flex",
          gap: 12,
        }}
      >
        <button
          style={{
            flex: 1,
            padding: "12px 16px",
            background: colors.dangerDim,
            color: colors.danger,
            border: "none",
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
            transition: "opacity 0.2s",
          }}
          onMouseEnter={(e) => (e.target.style.opacity = 0.8)}
          onMouseLeave={(e) => (e.target.style.opacity = 1)}
        >
          ✕ 모르겠음
        </button>
        <button
          style={{
            flex: 1,
            padding: "12px 16px",
            background: colors.successDim,
            color: colors.success,
            border: "none",
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
            transition: "opacity 0.2s",
          }}
          onMouseEnter={(e) => (e.target.style.opacity = 0.8)}
          onMouseLeave={(e) => (e.target.style.opacity = 1)}
        >
          ✓ 알았음
        </button>
      </div>
    </div>
  );
}

function HomePage({ colors }) {
  return (
    <div>
      {/* Stats Row */}
      <div
        style={{
          display: "flex",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <StatCard label="오늘 복습" value="24" colors={colors} />
        <StatCard label="정답률" value="87%" colors={colors} />
        <StatCard label="연속 일수" value="12" colors={colors} />
      </div>

      {/* Review Card */}
      <ReviewCard colors={colors} />

      {/* Flashcard Card */}
      <FlashcardCard colors={colors} />
    </div>
  );
}

function ReviewPage({ colors }) {
  const [showAnswer, setShowAnswer] = useState(false);

  const currentCard = 3;
  const totalCards = 24;
  const remainingCards = 21;
  const progressPercent = (currentCard / totalCards) * 100;

  return (
    <div>
      {/* Progress Header */}
      <div style={{ marginBottom: 24 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: colors.accent,
              textTransform: "uppercase",
              letterSpacing: "0.5px",
            }}
          >
            복습 중
          </div>
          <div
            style={{
              fontSize: 13,
              color: colors.muted,
              fontWeight: 500,
            }}
          >
            {currentCard} / {totalCards}
          </div>
        </div>

        {/* Progress Bar */}
        <div
          style={{
            width: "100%",
            height: 2,
            background: colors.surface2,
            borderRadius: 1,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${progressPercent}%`,
              height: "100%",
              background: colors.accent,
              borderRadius: 1,
              transition: "width 0.3s ease",
            }}
          />
        </div>
      </div>

      {/* Flashcard */}
      <div
        style={{
          background: colors.surface,
          borderRadius: 20,
          border: `1px solid ${colors.border}`,
          padding: "32px 24px",
          marginBottom: 24,
          minHeight: 400,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          position: "relative",
        }}
      >
        {/* Subject Badge */}
        <div
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            padding: "6px 12px",
            background: colors.accentDim,
            color: colors.accentText,
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          해부학
        </div>

        {/* Card Content */}
        {!showAnswer ? (
          <div
            style={{
              textAlign: "center",
              width: "100%",
            }}
          >
            <div
              style={{
                fontSize: 18,
                fontWeight: 500,
                color: colors.text,
                lineHeight: 1.6,
                marginBottom: 32,
              }}
            >
              요골신경(radial nerve) 손상 시 나타나는 자세는?
            </div>

            {/* Show Answer Button */}
            <button
              onClick={() => setShowAnswer(true)}
              style={{
                padding: "12px 24px",
                background: colors.accent,
                color: "#FFFFFF",
                border: "none",
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                transition: "opacity 0.2s",
              }}
              onMouseEnter={(e) => (e.target.style.opacity = 0.9)}
              onMouseLeave={(e) => (e.target.style.opacity = 1)}
            >
              답 보기
            </button>
          </div>
        ) : (
          <div
            style={{
              width: "100%",
              display: "flex",
              flexDirection: "column",
              gap: 24,
            }}
          >
            <div
              style={{
                fontSize: 18,
                fontWeight: 500,
                color: colors.text,
                lineHeight: 1.6,
                textAlign: "center",
              }}
            >
              수하수(wrist drop) — 손목 신전 불가
            </div>

            {/* Action Buttons */}
            <div
              style={{
                display: "flex",
                gap: 12,
              }}
            >
              <button
                style={{
                  flex: 1,
                  padding: "14px 16px",
                  minHeight: 56,
                  background: colors.dangerDim,
                  color: colors.danger,
                  border: "none",
                  borderRadius: 12,
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "opacity 0.2s",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                onMouseEnter={(e) => (e.target.style.opacity = 0.8)}
                onMouseLeave={(e) => (e.target.style.opacity = 1)}
              >
                ✕ 모르겠음
              </button>
              <button
                style={{
                  flex: 1,
                  padding: "14px 16px",
                  minHeight: 56,
                  background: colors.successDim,
                  color: colors.success,
                  border: "none",
                  borderRadius: 12,
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "opacity 0.2s",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                onMouseEnter={(e) => (e.target.style.opacity = 0.8)}
                onMouseLeave={(e) => (e.target.style.opacity = 1)}
              >
                ✓ 알았음
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Remaining Cards Info */}
      <div
        style={{
          textAlign: "center",
          fontSize: 13,
          color: colors.muted,
          fontWeight: 500,
        }}
      >
        남은 카드 {remainingCards}개
      </div>
    </div>
  );
}

// ─────────────────────────────────────────
// Tab Content Components
// ─────────────────────────────────────────
function TabContent({ tabId }) {
  const { colors } = useTheme();

  const tabNames = {
    review: "복습",
    quiz: "퀴즈",
    plan: "플랜",
    stats: "통계",
    concept: "개념",
    manage: "관리",
  };

  // Home tab
  if (tabId === "home") {
    return (
      <div
        style={{
          padding: "20px 16px",
          maxWidth: 480,
          margin: "0 auto",
        }}
      >
        <HomePage colors={colors} />
      </div>
    );
  }

  // Review tab
  if (tabId === "review") {
    return (
      <div
        style={{
          padding: "20px 16px",
          maxWidth: 480,
          margin: "0 auto",
        }}
      >
        <ReviewPage colors={colors} />
      </div>
    );
  }

  // Other tabs placeholder
  return (
    <div
      style={{
        padding: "20px 16px",
        maxWidth: 480,
        margin: "0 auto",
      }}
    >
      <div
        style={{
          padding: "40px 20px",
          textAlign: "center",
          background: colors.surface,
          borderRadius: 16,
          border: `1px solid ${colors.border}`,
          color: colors.muted,
          fontSize: 14,
        }}
      >
        {tabNames[tabId]} 페이지
      </div>
    </div>
  );
}

// ─────────────────────────────────────────
// Main App Component
// ─────────────────────────────────────────
function MedStudyAppContent() {
  const [activeTab, setActiveTab] = useState("home");
  const { colors } = useTheme();

  return (
    <div
      style={{
        minHeight: "100vh",
        background: colors.bg,
        color: colors.text,
        fontFamily: '"Pretendard", system-ui, -apple-system, sans-serif',
      }}
    >
      <Header />
      <TabNavigation activeTab={activeTab} onTabChange={setActiveTab} />
      <main
        style={{
          background: colors.bg,
        }}
      >
        <TabContent tabId={activeTab} />
      </main>
    </div>
  );
}

export default function MedStudyApp() {
  return (
    <ThemeProvider>
      <MedStudyAppContent />
    </ThemeProvider>
  );
}
