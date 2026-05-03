import "./style.css";
import "antd/dist/reset.css";
import * as G6 from "@antv/g6";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_DEBUG_SETTINGS, type DebugSettings, type JunctionInspectorDetails, type Point, type RoadEndMode, type RoadInspectorDetails, type RoadPenScene, type SceneNode, type ToolbarAction, type ToolbarState } from "./types";
import { exportScene, parseRoadPenScene } from "./io/io";
import { exportRoadSvg } from "./io/svgExport";
import { buildRoadBandPolygons, renderRoads } from "./render/roadRenderer";
import { ToolbarApp } from "./ui/ToolbarApp";
import { commitRoadWithTopology, findPathRoadIntersections, findSnapTarget, type DraftAnchor, type SnapTarget } from "./geometry/topology";
import { findRoadAtPoint } from "./geometry/roadPicking";

const CANVAS_BG = "#0a1024";
const SNAP_RADIUS = 12;
const EDGE_SNAP_RADIUS = 16;

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
  draftAnchors: DraftAnchor[];
  draftStartNodeId: string | null;
  snapPreview: SnapTarget | null;
  selectedEndMode: RoadEndMode;
  selectedProfileId: string;
  debug: DebugSettings;
  debugPanelOpen: boolean;
  selectedEdgeId: string | null;
  selectedJunctionBlockId: string | null;
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
  draftAnchors: [],
  draftStartNodeId: null,
  snapPreview: null,
  selectedEndMode: "free",
  selectedProfileId: DEFAULT_PROFILE_ID,
  debug: structuredClone(DEFAULT_DEBUG_SETTINGS),
  debugPanelOpen: false,
  selectedEdgeId: null,
  selectedJunctionBlockId: null,
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

  const model = event?.item?.getModel?.();
  const modelX = parseNumber(model?.x);
  const modelY = parseNumber(model?.y);
  if (modelX !== null && modelY !== null) {
    return { x: modelX, y: modelY };
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

function snapTargetForPoint(point: Point): SnapTarget {
  return findSnapTarget(app.scene, point, {
    nodeRadius: SNAP_RADIUS,
    edgeRadius: EDGE_SNAP_RADIUS,
  });
}

function pushDraftAnchor(anchor: DraftAnchor): void {
  app.draftPoints.push({ ...anchor.point });
  app.draftAnchors.push({
    point: { ...anchor.point },
    snap: anchor.snap,
  });
}

function freeAnchor(point: Point): DraftAnchor {
  return {
    point: { ...point },
    snap: {
      type: "free",
      point: { ...point },
      distance: 0,
    },
  };
}

function anchorFromSnapTarget(target: SnapTarget): DraftAnchor {
  return {
    point: { ...target.point },
    snap: target,
  };
}

function nodeAnchor(nodeId: string, point: Point): DraftAnchor {
  return {
    point: { ...point },
    snap: {
      type: "node",
      point: { ...point },
      distance: 0,
      nodeId,
    },
  };
}

function clearDraft(): void {
  app.draftPoints = [];
  app.draftAnchors = [];
  app.draftStartNodeId = null;
  app.snapPreview = null;
}

function candidatePreviewPath(): Point[] | null {
  if (!app.snapPreview || app.draftPoints.length === 0) {
    return null;
  }
  const path = [...app.draftPoints.map((point) => ({ ...point })), { ...app.snapPreview.point }];
  if (path.length >= 2 && Math.hypot(path[path.length - 1].x - path[path.length - 2].x, path[path.length - 1].y - path[path.length - 2].y) < 1e-6) {
    return null;
  }
  return path;
}

function candidateIntersectionPoints(): Point[] {
  const path = candidatePreviewPath();
  return path ? findPathRoadIntersections(app.scene, path, true).map((hit) => hit.point) : [];
}

function snapStatusText(): string | null {
  if (candidateIntersectionPoints().length > 0) {
    return "检测到十字交叉，将自动生成路口";
  }
  if (!app.snapPreview || app.snapPreview.type === "free") {
    return null;
  }
  if (app.snapPreview.type === "node") {
    return `将连接到节点 ${app.snapPreview.nodeId}`;
  }
  return `将拆分道路 ${app.snapPreview.edgeId} 形成 T 路口`;
}

function polylineLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

function selectedRoadDetails(): RoadInspectorDetails | null {
  if (!app.selectedEdgeId) {
    return null;
  }

  const edge = app.scene.edges.find((item) => item.id === app.selectedEdgeId);
  if (!edge) {
    return null;
  }

  const profile = app.scene.profiles.find((item) => item.id === edge.profileId) ?? null;
  const roadData = buildRoadBandPolygons(app.scene);
  const chain = roadData.edgeCenterlines.find((item) => item.edgeIds.includes(edge.id));
  const endpoints = [edge.from, edge.to].map((nodeId) => {
    const junction = roadData.junctions.find((item) => item.nodeId === nodeId);
    return {
      nodeId,
      junctionType: junction?.type ?? null,
      degree: junction?.degree ?? 0,
    };
  });

  return {
    edge: {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      geomType: edge.geomType,
      endMode: edge.endMode ?? "free",
      profileId: edge.profileId,
      controlPointCount: edge.controlPoints.length,
      controlPoints: edge.controlPoints.map((point) => ({ ...point })),
      length: polylineLength(edge.controlPoints),
    },
    profile: profile ? { ...profile } : null,
    visualChain: chain
      ? {
          id: chain.id,
          edgeIds: [...chain.edgeIds],
          rawPointCount: chain.rawPoints.length,
          sourcePointCount: chain.sourcePoints.length,
          renderPointCount: chain.renderPoints.length,
          turnCount: chain.turns.length,
        }
      : null,
    endpoints,
  };
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  const ring =
    polygon.length > 1 &&
    Math.abs(polygon[0].x - polygon[polygon.length - 1].x) < 1e-6 &&
    Math.abs(polygon[0].y - polygon[polygon.length - 1].y) < 1e-6
      ? polygon.slice(0, -1)
      : polygon;

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-9) + a.x;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function selectedJunctionDetails(): JunctionInspectorDetails | null {
  if (!app.selectedJunctionBlockId) {
    return null;
  }

  const roadData = buildRoadBandPolygons(app.scene);
  const block = roadData.junctionBlocks.find((item) => item.id === app.selectedJunctionBlockId);
  if (!block) {
    return null;
  }

  return {
    id: block.id,
    nodeId: block.nodeId,
    type: block.type,
    degree: block.degree,
    point: { ...block.point },
    branchCount: block.branches.length,
    mouthLineCount: block.mouthLines.length,
    surfacePatchCount: block.surfacePatches.length,
    laneConnectorCount: block.laneConnectorPatches.length,
    laneStopCount: block.laneStops.length,
    virtualBoundary: Boolean(block.virtualBoundary),
    branches: block.branches.map((branch) => ({
      edgeId: branch.edgeId,
      profileId: branch.profileId,
      direction: { ...branch.direction },
    })),
  };
}

function findJunctionBlockAtPoint(point: Point): string | null {
  const roadData = buildRoadBandPolygons(app.scene);
  let nearest: { id: string; distance: number } | null = null;

  for (const block of roadData.junctionBlocks) {
    const hitSurface = [...block.surfacePatches, ...block.laneConnectorPatches].some((patch) => pointInPolygon(point, patch.polygon));
    const centerDistance = Math.hypot(block.point.x - point.x, block.point.y - point.y);
    if (!hitSurface && centerDistance > 22) {
      continue;
    }
    if (!nearest || centerDistance < nearest.distance) {
      nearest = { id: block.id, distance: centerDistance };
    }
  }

  return nearest?.id ?? null;
}

function emitToolbarState(): void {
  const nextState: ToolbarState = {
    mode: app.mode,
    endMode: app.selectedEndMode,
    debug: structuredClone(app.debug),
    debugPanelOpen: app.debugPanelOpen,
    selectedRoad: selectedRoadDetails(),
    selectedJunction: selectedJunctionDetails(),
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
  switch (action.type) {
    case "setMode":
      switchMode(action.mode);
      return;
    case "finish":
      if (app.mode === "draw") {
        finishDraft();
      }
      return;
    case "export":
      exportToFile();
      return;
    case "exportSvg":
      exportSvgToFile();
      return;
    case "import":
      importInput.value = "";
      importInput.click();
      return;
    case "setEndMode":
      app.selectedEndMode = action.endMode;
      requestRender();
      return;
    case "setDebugPanelOpen":
      app.debugPanelOpen = action.open;
      requestRender();
      return;
    case "setDebugEnabled":
      app.debug = { ...app.debug, enabled: action.enabled };
      requestRender();
      return;
    case "setDebugLayer":
      app.debug = {
        ...app.debug,
        layers: {
          ...app.debug.layers,
          [action.layer]: action.enabled,
        },
      };
      requestRender();
      return;
    case "setRoadInspector":
      app.debug = { ...app.debug, roadInspector: action.enabled };
      if (!action.enabled) {
        app.selectedEdgeId = null;
      }
      requestRender();
      return;
    case "setJunctionInspector":
      app.debug = { ...app.debug, junctionInspector: action.enabled };
      if (!action.enabled) {
        app.selectedJunctionBlockId = null;
      }
      requestRender();
      return;
    case "setIsolateSelectedJunction":
      app.debug = { ...app.debug, isolateSelectedJunction: action.enabled };
      requestRender();
      return;
    case "clearJunctionSelection":
      app.selectedJunctionBlockId = null;
      app.debug = { ...app.debug, isolateSelectedJunction: false };
      requestRender();
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

function handleInspectorClick(evt: any): boolean {
  if (app.mode !== "select" || (!app.debug.roadInspector && !app.debug.junctionInspector)) {
    return false;
  }

  const point = getCanvasPointFromEvent(evt);
  const junctionHit = app.debug.junctionInspector ? findJunctionBlockAtPoint(point) : null;
  if (junctionHit) {
    app.selectedJunctionBlockId = junctionHit;
    app.selectedEdgeId = null;
    requestRender();
    return true;
  }

  if (app.debug.roadInspector) {
    const hit = findRoadAtPoint(app.scene, point);
    app.selectedEdgeId = hit?.edgeId ?? null;
    if (hit) {
      app.selectedJunctionBlockId = null;
    }
  } else {
    app.selectedJunctionBlockId = null;
  }

  requestRender();
  return true;
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
    if (app.mode === "select") {
      handleInspectorClick(evt);
      return;
    }
    if (app.mode !== "draw") {
      return;
    }
    if (evt.item) {
      return;
    }
    const point = getCanvasPointFromEvent(evt);
    const snap = snapTargetForPoint(point);
    pushDraftAnchor(anchorFromSnapTarget(snap));
    app.snapPreview = snap;
    requestRender();
  });

  graph.on("node:click", (evt: any) => {
    if (app.mode === "select") {
      handleInspectorClick(evt);
      return;
    }
    if (app.mode !== "draw") {
      return;
    }

    const model = evt.item?.getModel?.();
    if (!model) {
      return;
    }

    const point = { x: model.x, y: model.y };
    pushDraftAnchor(nodeAnchor(model.id, point));
    if (!app.draftStartNodeId) {
      app.draftStartNodeId = model.id;
    }

    requestRender();
  });

  graph.on("edge:click", (evt: any) => {
    if (app.mode === "select") {
      handleInspectorClick(evt);
      return;
    }
    if (app.mode !== "draw") {
      return;
    }
    const point = getCanvasPointFromEvent(evt);
    const snap = snapTargetForPoint(point);
    pushDraftAnchor(anchorFromSnapTarget(snap));
    app.snapPreview = snap;
    requestRender();
  });

  graph.on("canvas:mousemove", (evt: any) => {
    if (app.mode !== "draw") {
      app.snapPreview = null;
      return;
    }
    app.snapPreview = snapTargetForPoint(getCanvasPointFromEvent(evt));
    requestRender();
  });

  graph.on("node:mousemove", (evt: any) => {
    if (app.mode !== "draw") {
      app.snapPreview = null;
      return;
    }
    const model = evt.item?.getModel?.();
    if (!model) {
      return;
    }
    app.snapPreview = {
      type: "node",
      point: { x: model.x, y: model.y },
      distance: 0,
      nodeId: model.id,
    };
    requestRender();
  });

  graph.on("edge:mousemove", (evt: any) => {
    if (app.mode !== "draw") {
      app.snapPreview = null;
      return;
    }
    app.snapPreview = snapTargetForPoint(getCanvasPointFromEvent(evt));
    requestRender();
  });

  addManagedEventListener(graphRoot, "mouseleave", () => {
    app.snapPreview = null;
    requestRender();
  });
}

function addEdgeFromDraft(chain = false): void {
  sceneWarnings = [];
  if (app.draftPoints.length < 2) {
    clearDraft();
    requestRender();
    return;
  }

  const anchors =
    app.draftAnchors.length === app.draftPoints.length
      ? app.draftAnchors
      : app.draftPoints.map((point) => freeAnchor(point));
  const result = commitRoadWithTopology(app.scene, anchors, app.selectedProfileId, nextNodeId, nextEdgeId, app.selectedEndMode);
  if (!result || result.createdEdgeIds.length === 0) {
    if (result?.warnings.length) {
      sceneWarnings = result.warnings;
    }
    clearDraft();
    requestRender();
    return;
  }

  sceneWarnings = result.warnings;
  syncGraph();

  if (chain) {
    const toNode = findNodeById(result.toNodeId);
    if (toNode) {
      const point = { x: toNode.x, y: toNode.y };
      const anchor = nodeAnchor(result.toNodeId, point);
      app.draftPoints = [{ ...point }];
      app.draftAnchors = [anchor];
      app.draftStartNodeId = result.toNodeId;
      app.snapPreview = null;
    } else {
      clearDraft();
    }
  } else {
    clearDraft();
  }

  requestRender();
}

function finishDraft(chain = false): void {
  if (app.draftPoints.length < 2) {
    if (!chain) {
      clearDraft();
    }
    requestRender();
    return;
  }

  addEdgeFromDraft(chain);
  if (!chain) {
    clearDraft();
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
      snapPreview: app.snapPreview,
      intersectionPreview: candidateIntersectionPoints(),
      debug: app.debug,
      selectedEdgeId: app.selectedEdgeId,
      selectedJunctionBlockId: app.selectedJunctionBlockId,
      isolatedJunctionBlockId: app.debug.isolateSelectedJunction ? app.selectedJunctionBlockId : null,
    });
    const allWarnings = [...new Set([...sceneWarnings, ...warnings])];
    updateWarningPanel(allWarnings);

    if (app.mode === "draw") {
      const snapText = snapStatusText();
      statusBar.textContent =
        snapText
          ? `模式：绘制 | ${snapText}`
          : app.draftPoints.length > 0
          ? `模式：绘制 | 草稿点数 ${app.draftPoints.length}`
          : "模式：绘制 | 点击空白或节点添加控制点，继续点击继续，Enter/结束绘制";
    } else {
      statusBar.textContent =
        app.selectedJunctionBlockId
          ? `模式：选择 | 已选路口 ${app.selectedJunctionBlockId}${app.debug.isolateSelectedJunction ? " | 单独展示" : ""}`
          : app.debug.roadInspector || app.debug.junctionInspector
          ? app.selectedEdgeId
            ? `模式：选择 | 已选道路 ${app.selectedEdgeId}`
            : "模式：选择 | 点击道路或路口查看参数"
          : "模式：选择";
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
    clearDraft();
  } else {
    app.selectedEdgeId = null;
    app.selectedJunctionBlockId = null;
    app.debug = { ...app.debug, isolateSelectedJunction: false };
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
    app.selectedEdgeId = null;
    app.selectedJunctionBlockId = null;
    app.debug = { ...app.debug, isolateSelectedJunction: false };
    syncCountersFromScene();
    syncGraph();

    clearDraft();

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
      clearDraft();
      app.selectedEdgeId = null;
      app.selectedJunctionBlockId = null;
      app.debug = { ...app.debug, isolateSelectedJunction: false };
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
