import { useEffect, useState } from "react";
import MedStudyApp from "./apps/MedStudyApp";
import CardInjectorApp from "./apps/CardInjectorApp";

const shell = {
  bg: "#0f1724",
  text: "#e4edf8",
};

function resolveViewFromLocation() {
  if (typeof window === "undefined") return "study";

  const { pathname, search, hash } = window.location;
  const queryMode = new URLSearchParams(search).get("mode");
  const hashMode = hash.startsWith("#?") ? new URLSearchParams(hash.slice(2)).get("mode") : null;
  const hashPath = hash.startsWith("#/") ? hash.slice(1) : hash;

  if (
    pathname === "/injector" ||
    pathname.endsWith("/injector") ||
    queryMode === "injector" ||
    hashMode === "injector" ||
    hashPath === "/injector"
  ) {
    return "injector";
  }

  return "study";
}

export default function App() {
  const [view, setView] = useState(resolveViewFromLocation);

  useEffect(() => {
    const handleLocationChange = () => setView(resolveViewFromLocation());
    window.addEventListener("popstate", handleLocationChange);
    window.addEventListener("hashchange", handleLocationChange);
    return () => {
      window.removeEventListener("popstate", handleLocationChange);
      window.removeEventListener("hashchange", handleLocationChange);
    };
  }, []);

  return (
    <div style={{ minHeight: "100vh", background: shell.bg, color: shell.text }}>
      {view === "study" ? <MedStudyApp /> : <CardInjectorApp />}
    </div>
  );
}
