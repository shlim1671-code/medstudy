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
// Tab Content Components
// ─────────────────────────────────────────
function TabContent({ tabId }) {
  const { colors } = useTheme();

  const tabNames = {
    home: "홈",
    review: "복습",
    quiz: "퀴즈",
    plan: "플랜",
    stats: "통계",
    concept: "개념",
    manage: "관리",
  };

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
