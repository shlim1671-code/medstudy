import { useState } from "react";
import MedStudyApp from "./apps/MedStudyApp";
import CardInjectorApp from "./apps/CardInjectorApp";

const shell = {
  bg: "#0f1724",
  panel: "#1e2d42",
  border: "#304060",
  text: "#e4edf8",
  muted: "#92a4be",
  primary: "#6aafe6",
};

export default function App() {
  const [view, setView] = useState("study");

  return (
    <div style={{ minHeight: "100vh", background: shell.bg, color: shell.text }}>
      <header style={{ padding: "12px 16px", borderBottom: `1px solid ${shell.border}`, background: shell.panel }}>
        <strong style={{ marginRight: 12 }}>MedStudy Web</strong>
        <button
          onClick={() => setView("study")}
          style={{ marginRight: 8, padding: "6px 10px", borderRadius: 6, border: "none", cursor: "pointer", background: view === "study" ? shell.primary : "#263350" }}
        >
          학습 앱
        </button>
        <button
          onClick={() => setView("injector")}
          style={{ padding: "6px 10px", borderRadius: 6, border: "none", cursor: "pointer", background: view === "injector" ? shell.primary : "#263350" }}
        >
          주입기
        </button>
      </header>
      {view === "study" ? <MedStudyApp /> : <CardInjectorApp />}
    </div>
  );
}
