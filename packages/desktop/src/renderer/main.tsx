import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./index.css";
import { App } from "./App.js";

const BlockInspectorWindow = lazy(() =>
  import("./BlockInspectorWindow.js").then((module) => ({
    default: module.BlockInspectorWindow
  }))
);
const TaskInspectorWindow = lazy(() =>
  import("./TaskInspectorWindow.js").then((module) => ({
    default: module.TaskInspectorWindow
  }))
);

const windowMode = new URLSearchParams(window.location.search).get("window");
const Root =
  windowMode === "block-inspector"
    ? BlockInspectorWindow
    : windowMode === "task-inspector"
      ? TaskInspectorWindow
      : App;

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </StrictMode>
);
