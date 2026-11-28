import { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// each candidate is its own chunk, so the bundle cost of one never hides inside another
const TwickDemo = lazy(() => import("./twick-demo").then((m) => ({ default: m.TwickDemo })));
const OwnEditor = lazy(() => import("./own/editor").then((m) => ({ default: m.OwnEditor })));

const TABS = [
  { hash: "#own", label: "B. Own core + FFmpeg" },
  { hash: "#twick", label: "A. Twick Studio" },
];

function App() {
  const [hash, setHash] = useState(location.hash || "#own");
  useEffect(() => {
    const on = () => setHash(location.hash || "#own");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return (
    <div className="app">
      <header className="top">
        <strong>Video editor PoC</strong>
        {TABS.map((t) => (
          <a key={t.hash} href={t.hash} className={hash === t.hash ? "on" : ""}>{t.label}</a>
        ))}
      </header>
      <Suspense fallback={<p className="hint pad">Loading...</p>}>{hash === "#twick" ? <TwickDemo /> : <OwnEditor />}</Suspense>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
