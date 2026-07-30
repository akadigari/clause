import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/bench.css";
import "./styles/layout.css";
import "./styles/landing.css";
import "./styles/panels.css";

import App from "./App";
import { startNetWatch } from "./lib/net";

// Start counting network activity before anything else runs, so the meter
// covers the whole life of the page and not just the part after React boots.
startNetWatch();

const host = document.getElementById("root");
if (!host) throw new Error("Missing #root");

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
