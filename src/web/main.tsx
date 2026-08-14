import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { pruneStaleState } from "./storage";
import "reactflow/dist/style.css";
import "./styles.css";

// Before anything reads it: App restores the layout and viewport inside useState
// initialisers, so state written by an incompatible version has to be gone by
// the time the component exists.
try { pruneStaleState(window.localStorage); } catch { /* private mode */ }

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
