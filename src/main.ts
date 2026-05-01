import "./style.css";
import "antd/dist/reset.css";
import * as G6 from "@antv/g6";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { GeometryType, Point, RoadEdge, RoadPenScene, SceneNode, ToolbarAction, ToolbarState } from "./types";
import { exportScene, parseRoadPenScene } from "./io/io";
import { exportRoadSvg } from "./io/svgExport";
import { renderRoads } from "./render/roadRenderer";
import { ToolbarApp } from "./ui/ToolbarApp";

const CANVAS_BG = "#0a1024";
const SNAP_RADIUS = 12;

const DEFAULT_PROFILE_ID = "default";

type AppMode = "select" | "draw";

declare global {
  interface Window {
    __roadpenDispose?: () => void;
  }
}

interface AppState {
  scene: RoadPenScene;
  mode: AppMode;
  draftPoints: Point[];
  draftStartNodeId: string | null;
  selectedProfileId: string;
}

const emptyScene: RoadPenScene = {
  version: "1.0.0",
  units: "px",
  scalePxPerM: 20,
  nodes: [],
  edges: [],
  profiles: [
    {
      id: "default",
      name: "默认横断面",
      carriagewayWidth: 24,
      facilityWidth: 4,
      sidewalkWidth: 8,
      clearanceWidth: 4,
    },
  ],
};

const app: AppState = {
  scene: structuredClone(emptyScene),
  mode: "select",
  draftPoints: [],
  draftStartNodeId: null,
  selectedProfileId: DEFAULT_PROFILE_ID,
};

let nodeSerial = 0;
let edgeSerial = 0;
const ROADPEN_ACTION_EVENT = "roadpen:action";
const ROADPEN_STATE_EVENT = "roadpen:state";

const importInput = document.getElementById("importInput") as HTMLInputElement;
const statusBar = document.getElementById("statusBar") as HTMLDivElement;
const warningPanel = document.getElementById("warningPanel") as HTMLDivElement;
const warningList = document.getElementById("warningList") as HTMLUListElement;
const graphRoot = document.getElementById("graph") as HTMLDivElement;
const roadCanvas = document.getElementById("roadCanvas") as HTMLCanvasElement;

const ctx = roadCanvas.getContext("2d");

window.__roadpenDispose?.();

let graph: any = null;
let raf = 0;
let sceneWarnings: string[] = [];
const cleanupCallbacks: Array<() => void> = [];

function addManagedEventListener(target: EventTarget, type: string, listener: EventListener): void {
  target.addEventListener(type, listener);
  cleanupCallbacks.push(() => target.removeEventListener(type, listener));
}

function disposeRoadPen(): void {
  if (raf !== 0) {
    window.cancelAnimationFrame(raf);
    raf = 0;
  }

  while (cleanupCallbacks.length > 0) {
    cleanupCallbacks.pop()?.();
  }

  graph?.destroy?.();
  graph = null;
  graphRoot.replaceChildren();
}

window.__roadpenDispose = disposeRoadPen;
if (import.meta.hot) {
  import.meta.hot.dispose(disposeRoadPen);
}

function toGraphData(scene: RoadPenScene): { nodes: object[]; edges: object[] } {
  return {
    nodes: scene.nodes.map((n) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      label: n.id,
      size: 8,
      style: {
        fill: "#f8fafc",
        stroke: "#38bdf8",
        lineWidth: 2,
      },
    })),
    edges: scene.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      label: edge.id,
    })),
  };
}

function parseNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getCanvasPointFromEvent(event: any): Point {
  const canvasPoint = event?.canvas;
  const canvasX = parseNumber(canvasPoint?.x);
  const canvasY = parseNumber(canvasPoint?.y);
  if (canvasX !== null && canvasY !== null) {
    return { x: canvasX, y: canvasY };
  }

  const fromEvent = event?.originalEvent ?? event;
  const offsetX = parseNumber(fromEvent?.offsetX);
  const offsetY = parseNumber(fromEvent?.offsetY);
  if (offsetX !== null && offsetY !== null) {
    return { x: offsetX, y: offsetY };
  }

  const clientX = parseNumber(fromEvent?.clientX);
  const clientY = parseNumber(fromEvent?.clientY);
  if (clientX !== null && clientY !== null && graph) {
    return graph.getCanvasByClient({ x: clientX, y: clientY });
  }

  const fallbackX = parseNumber(event?.x);
  const fallbackY = parseNumber(event?.y);
  if (fallbackX !== null && fallbackY !== null) {
    if (graph && graphRoot) {
      return graph.getCanvasByViewport({ x: fallbackX, y: fallbackY });
    }
    return { x: fallbackX, y: fallbackY };
  }

  return { x: 0, y: 0 };
}

function nextNodeId(): string {
  nodeSerial += 1;
  while (app.scene.nodes.some((n) => n.id === `n-${nodeSerial}`)) {
    nodeSerial += 1;
  }
  return `n-${nodeSerial}`;
}

function nextEdgeId(): string {
  edgeSerial += 1;
  while (app.scene.edges.some((e) => e.id === `e-${edgeSerial}`)) {
    edgeSerial += 1;
  }
  return `e-${edgeSerial}`;
}

function syncCountersFromScene(): void {
  nodeSerial = 0;
  edgeSerial = 0;
  for (const node of app.scene.nodes) {
    const m = /^n-(\d+)$/.exec(node.id);
    if (m) {
      nodeSerial = Math.max(nodeSerial, Number(m[1]));
    }
  }
  for (const edge of app.scene.edges) {
    const m = /^e-(\d+)$/.exec(edge.id);
    if (m) {
      edgeSerial = Math.max(edgeSerial, Number(m[1]));
    }
  }
}

function findNodeById(id: string): SceneNode | undefined {
  return app.scene.nodes.find((node) => node.id === id);
}

function findSnapNode(point: Point, excludeId?: string): { id: string; point: Point } | null {
  let hit: { id: string; point: Point; dist: number } | null = null;
  for (const node of app.scene.nodes) {
    if (excludeId && node.id === excludeId) {
      continue;
    }
    const d = Math.hypot(node.x - point.x, node.y - point.y);
    if (d <= SNAP_RADIUS && (!hit || d < hit.dist)) {
      hit = { id: node.id, point: node, dist: d };
    }
  }
  return hit ? { id: hit.id, point: hit.point } : null;
}

function geometryTypeForControlPoints(controlPoints: Point[]): GeometryType {
  return controlPoints.length === 2 ? "polyline" : "spline";
}

function emitToolbarState(): void {
  const nextState: ToolbarState = {
    mode: app.mode,
    draftPoints: app.draftPoints.length,
    warningCount: sceneWarnings.length,
    canFinish: app.mode === "draw" && app.draftPoints.length >= 2,
  };
  window.dispatchEvent(
    new CustomEvent<ToolbarState>(ROADPEN_STATE_EVENT, {
      detail: nextState,
    })
  );
}

function handleToolbarAction(action: ToolbarAction): void {
  if (action === "select") {
    switchMode("select");
    return;
  }
  if (action === "draw") {
    switchMode("draw");
    return;
  }
  if (action === "finish") {
    if (app.mode === "draw") {
      finishDraft();
    }
    return;
  }
  if (action === "export") {
    exportToFile();
    return;
  }
  if (action === "exportSvg") {
    exportSvgToFile();
    return;
  }
  if (action === "import") {
    importInput.value = "";
    importInput.click();
  }
}

function ensureGraph(): void {
  const width = window.innerWidth;
  const height = window.innerHeight - 56;
  graphRoot.style.width = `${width}px`;
  graphRoot.style.height = `${height}px`;
  graphRoot.replaceChildren();

  graph = new (G6 as any).Graph({
    container: graphRoot,
    width,
    height,
    defaultNode: {
      type: "circle",
      size: 8,
      style: {
        fill: "#f8fafc",
        stroke: "#38bdf8",
        lineWidth: 2,
      },
      labelCfg: {
        style: {
          fill: "#cbd5e1",
          fontSize: 10,
        },
        position: "bottom",
      },
    },
    defaultEdge: {
      type: "line",
      style: {
        stroke: "rgba(148, 163, 184, 0.55)",
        lineWidth: 1.2,
      },
    },
  });

  graph.setData(toGraphData(app.scene));
  graph.render();
  bindGraphEvents();
  requestRender();
}

function bindGraphEvents(): void {
  if (!graph) {
    return;
  }

  graph.on("node:drag", (evt: any) => {
    sceneWarnings = [];
    const model = evt.item?.getModel?.() as { id: string; x: number; y: number } | undefined;
    if (!model) {
      return;
    }

    const targetId = model.id as string;
    const targetNode = findNodeById(targetId);
    if (!targetNode) {
      return;
    }

    targetNode.x = model.x;
    targetNode.y = model.y;

    for (const edge of app.scene.edges) {
      if (edge.from === targetId && edge.controlPoints.length > 0) {
        edge.controlPoints[0] = { x: model.x, y: model.y };
      }
      if (edge.to === targetId && edge.controlPoints.length > 0) {
        edge.controlPoints[edge.controlPoints.length - 1] = { x: model.x, y: model.y };
      }
    }

    requestRender();
  });

  graph.on("node:dragend", (evt: any) => {
    sceneWarnings = [];
    const model = evt.item?.getModel?.() as { id: string; x: number; y: number } | undefined;
    if (!model) {
      return;
    }

    const current = { x: model.x, y: model.y };
    const snapped = findSnapNode(current, model.id);
    if (graph && evt.item) {
      graph.updateItem?.(evt.item, { x: current.x, y: current.y });
    }
    if (snapped) {
      graph?.updateItem?.(evt.item, { x: snapped.point.x, y: snapped.point.y });
      const node = findNodeById(model.id);
      if (node) {
        node.x = snapped.point.x;
        node.y = snapped.point.y;
      }

      for (const edge of app.scene.edges) {
        if (edge.from === model.id && edge.controlPoints.length > 0) {
          edge.controlPoints[0] = { ...snapped.point };
        }
        if (edge.to === model.id && edge.controlPoints.length > 0) {
          edge.controlPoints[edge.controlPoints.length - 1] = { ...snapped.point };
        }
      }
      requestRender();
      return;
    }

    requestRender();
  });

  graph.on("canvas:click", (evt: any) => {
    if (app.mode !== "draw") {
      return;
    }
    if (evt.item) {
      return;
    }
    const point = getCanvasPointFromEvent(evt);
    const snapped = findSnapNode(point);
    const finalPoint = snapped ? { ...snapped.point } : point;
    app.draftPoints.push(finalPoint);
    requestRender();
  });

  graph.on("node:click", (evt: any) => {
    if (app.mode !== "draw") {
      return;
    }

    const model = evt.item?.getModel?.();
    if (!model) {
      return;
    }

    const point = { x: model.x, y: model.y };
    app.draftPoints.push({ ...point });
    if (!app.draftStartNodeId) {
      app.draftStartNodeId = model.id;
    }

    requestRender();
  });
}

function getOrCreateNodeAt(point: Point): string {
  const snapped = findSnapNode(point);
  if (snapped) {
    return snapped.id;
  }

  const id = nextNodeId();
  sceneWarnings = [];
  const node: SceneNode = { id, x: point.x, y: point.y };
  app.scene.nodes.push(node);
  syncGraph();

  return id;
}

function addEdgeFromDraft(chain = false): void {
  sceneWarnings = [];
  if (app.draftPoints.length < 2) {
    app.draftPoints = [];
    app.draftStartNodeId = null;
    requestRender();
    return;
  }

  const from = getOrCreateNodeAt(app.draftPoints[0]);
  const to = getOrCreateNodeAt(app.draftPoints[app.draftPoints.length - 1]);
  if (from === to) {
    app.draftPoints = chain ? [app.draftPoints[app.draftPoints.length - 1]] : [];
    app.draftStartNodeId = chain ? to : null;
    requestRender();
    return;
  }

  const controlPoints = app.draftPoints.map((pt) => ({ ...pt }));
  const edge: RoadEdge = {
    id: nextEdgeId(),
    from,
    to,
    geomType: geometryTypeForControlPoints(controlPoints),
    profileId: app.selectedProfileId,
    controlPoints,
  };

  app.scene.edges.push(edge);
  syncGraph();

  if (chain) {
    app.draftPoints = [app.draftPoints[app.draftPoints.length - 1]];
    app.draftStartNodeId = to;
  } else {
    app.draftPoints = [];
    app.draftStartNodeId = null;
  }

  requestRender();
}

function finishDraft(chain = false): void {
  if (app.draftPoints.length < 2) {
    if (!chain) {
      app.draftPoints = [];
      app.draftStartNodeId = null;
    }
    requestRender();
    return;
  }

  addEdgeFromDraft(chain);
  if (!chain) {
    app.draftPoints = [];
    app.draftStartNodeId = null;
  }
}

function updateWarningPanel(warnings: string[]): void {
  if (!warningList || !warningPanel) {
    return;
  }

  warningList.innerHTML = "";
  if (warnings.length === 0) {
    warningPanel.hidden = true;
    return;
  }

  warningPanel.hidden = false;
  for (const warn of warnings) {
    const item = document.createElement("li");
    item.textContent = warn;
    warningList.appendChild(item);
  }
}

function requestRender(): void {
  emitToolbarState();
  if (raf !== 0) {
    return;
  }

  raf = window.requestAnimationFrame(() => {
    raf = 0;
    if (!ctx) {
      return;
    }

    const width = roadCanvas.clientWidth;
    const height = roadCanvas.clientHeight;
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, width, height);
    const warnings = renderRoads(ctx, app.scene, {
      width,
      height,
      draftPoints: app.draftPoints,
    });
    const allWarnings = [...new Set([...sceneWarnings, ...warnings])];
    updateWarningPanel(allWarnings);

    if (app.mode === "draw") {
      statusBar.textContent =
        app.draftPoints.length > 0
          ? `模式：绘制 | 草稿点数 ${app.draftPoints.length}`
          : "模式：绘制 | 点击空白或节点添加控制点，继续点击继续，Enter/结束绘制";
    } else {
      statusBar.textContent = "模式：选择";
    }
  });
}

function syncGraph(): void {
  if (!graph) {
    return;
  }
  graph.setData(toGraphData(app.scene));
  graph.render();
}

function switchMode(mode: AppMode): void {
  app.mode = mode;
  if (mode === "select") {
    app.draftPoints = [];
    app.draftStartNodeId = null;
  }
  requestRender();
}

function setupCanvasSize(): void {
  const ratio = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight - 56;

  roadCanvas.width = Math.floor(width * ratio);
  roadCanvas.height = Math.floor(height * ratio);
  roadCanvas.style.width = `${width}px`;
  roadCanvas.style.height = `${height}px`;

  if (ctx) {
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.imageSmoothingEnabled = true;
  }

  if (graph) {
    graph.setSize(width, height);
  }

  requestRender();
}

function exportToFile(): void {
  const text = exportScene(app.scene);
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `roadpen-${Date.now()}.roadpen.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function exportSvgToFile(): void {
  const text = exportRoadSvg(app.scene, {
    width: roadCanvas.clientWidth,
    height: roadCanvas.clientHeight,
    draftPoints: app.draftPoints,
  });
  const blob = new Blob([text], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `roadpen-render-${Date.now()}.svg`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function importFromFile(file: File): void {
  const reader = new FileReader();
  reader.onload = (event) => {
    const text = event.target?.result;
    if (typeof text !== "string") {
      return;
    }

    const { scene, warnings } = parseRoadPenScene(text);
    sceneWarnings = warnings;
    app.scene = scene;
    syncCountersFromScene();
    syncGraph();

    app.draftPoints = [];
    app.draftStartNodeId = null;

    requestRender();

    if (warnings.length > 0) {
      updateWarningPanel(warnings);
      statusBar.textContent = app.mode === "draw" ? "模式：绘制 | 存在导入警告" : "模式：选择 | 存在导入警告";
    }

    if (warnings.length === 0) {
      statusBar.textContent = app.mode === "draw" ? "模式：绘制" : "模式：选择";
    }
  };

  reader.onerror = () => {
    alert("导入失败：无法读取文件");
  };
  reader.readAsText(file, "utf-8");
}

function resetStateFromScene(): void {
  syncCountersFromScene();
  syncGraph();
}

function setupListeners(): void {
  addManagedEventListener(window, ROADPEN_ACTION_EVENT, (event: Event) => {
    const action = (event as CustomEvent<ToolbarAction>).detail;
    if (!action) {
      return;
    }
    handleToolbarAction(action);
  });

  addManagedEventListener(importInput, "change", (event) => {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) {
      importFromFile(file);
    }
  });

  addManagedEventListener(window, "keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key === "Escape") {
      app.draftPoints = [];
      app.draftStartNodeId = null;
      requestRender();
      return;
    }

    if (keyboardEvent.key === "Enter" && app.mode === "draw") {
      keyboardEvent.preventDefault();
      finishDraft();
    }
  });

  addManagedEventListener(window, "resize", () => {
    setupCanvasSize();
    syncGraph();
  });

  const toolbarRoot = document.getElementById("toolbar-root");
  if (toolbarRoot) {
    const toolbarElement = React.createElement(ToolbarApp);
    const toolbarAppRoot = createRoot(toolbarRoot);
    cleanupCallbacks.push(() => toolbarAppRoot.unmount());
    toolbarAppRoot.render(toolbarElement);
  }
}

if (!ctx) {
  throw new Error("Canvas context unavailable");
}

setupCanvasSize();
ensureGraph();
setupListeners();
resetStateFromScene();
requestRender();
