import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Plainroot root element is missing");
}
const rootElement = root;

async function bootstrap() {
  if (import.meta.env.MODE === "e2e") {
    await import("@wdio/tauri-plugin");
  }
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
