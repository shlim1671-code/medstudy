import { useState } from "react";
import MedStudyApp from "./apps/MedStudyApp";
import CardInjectorApp from "./apps/CardInjectorApp";

const shell = {
  bg: "#161210",
  panel: "#161210",
  border: "#3a2e24",
  text: "#e8e0d4",
  muted: "#8a7d70",
  primary: "#a07850",
};

export default function App() {
  const [view, setView] = useState("study");

  return (
    <div style={{ minHeight: "100vh", background: shell.bg, color: shell.text }}>
      <header style={{ padding: "8px 16px", borderBottom: `1px solid ${shell.border}`, background: shell.panel, fontFamily: "'Noto Sans KR', system-ui, sans-serif" }}>
        <strong style={{ marginRight: 12, fontSize: 13, color: shell.muted, fontWeight: 400 }}>MedStudy Web</strong>
        <button
          onClick={() => setView("study")}
          style={{ marginRight: 8, padding: "6px 10px", borderRadius: 0, border: "none", cursor: "pointer", background: "transparent", color: view === "study" ? shell.primary : shell.muted, borderBottom: `2px solid ${view === "study" ? shell.primary : "transparent"}`, fontSize: 13, fontWeight: view === "study" ? 600 : 400, fontFamily: "'Noto Sans KR', system-ui, sans-serif" }}
        >
          학습 앱
        </button>
        <button
          onClick={() => setView("injector")}
          style={{ padding: "6px 10px", borderRadius: 0, border: "none", cursor: "pointer", background: "transparent", color: view === "injector" ? shell.primary : shell.muted, borderBottom: `2px solid ${view === "injector" ? shell.primary : "transparent"}`, fontSize: 13, fontWeight: view === "injector" ? 600 : 400, fontFamily: "'Noto Sans KR', system-ui, sans-serif" }}
        >
          주입기
        </button>
      </header>
      {view === "study" ? <MedStudyApp /> : <CardInjectorApp />}
    </div>
  );
}
