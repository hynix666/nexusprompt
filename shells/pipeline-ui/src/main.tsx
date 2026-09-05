import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";

if (import.meta.url === new URL(document.baseURI).href || typeof document !== "undefined") {
  const root = document.getElementById("root");
  if (root) {
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  }
}
