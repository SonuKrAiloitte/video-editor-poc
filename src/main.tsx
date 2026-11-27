import { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// each screen is its own chunk, so the bundle cost of one never hides inside another
const TwickDemo = lazy(() => import("./twick-demo").then((m) => ({ default: m.TwickDemo })));
const OwnEditor = lazy(() => import("./own/editor").then((m) => ({ default: m.OwnEditor })));
const EasyEditor = lazy(() => import("./own/easy/EasyEditor").then((m) => ({ default: m.EasyEditor })));

type Route = "#easy" | "#own" | "#twick";
const route = (): Route => (location.hash === "#own" || location.hash === "#twick" ? location.hash : "#easy");

function App() {
  const [hash, setHash] = useState<Route>(route);
  useEffect(() => {
    const on = () => setHash(route());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return (
    <div className={`app ${hash === "#easy" ? "dark" : ""}`}>
      <header className="top">
        <strong>Video editor</strong>
        <a href="#easy" className={hash === "#easy" ? "on" : ""}>Easy editor</a>
        <a href="#own" className={hash === "#own" ? "on" : ""}>Advanced editor</a>
        {/* the rejected candidate stays reachable for the comparison, but out of the way */}
        <a href="#twick" className={`compare ${hash === "#twick" ? "on" : ""}`} title="Twick Studio as shipped, kept only to compare against">
          Comparison only: Twick (not chosen)
        </a>
      </header>
      <Suspense fallback={<p className="hint pad">Loading...</p>}>
        {hash === "#twick" ? <TwickDemo /> : hash === "#own" ? <OwnEditor /> : <EasyEditor />}
      </Suspense>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
