import type { GeometryType, LaneProfile, RoadEdge, RoadEndMode, RoadPenScene, SceneNode } from "../types";

export interface ImportResult {
  scene: RoadPenScene;
  warnings: string[];
}

const VERSION = "1.0.0";

const DEFAULT_PROFILE: LaneProfile = {
  id: "default",
  name: "默认横断面",
  carriagewayWidth: 24,
  facilityWidth: 4,
  sidewalkWidth: 8,
  clearanceWidth: 4,
};

const EMPTY_SCENE: RoadPenScene = {
  version: VERSION,
  units: "px",
  scalePxPerM: 20,
  nodes: [],
  edges: [],
  profiles: [DEFAULT_PROFILE],
};

function asPoint(v: unknown): v is { x: number; y: number } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { x?: unknown }).x === "number" &&
    typeof (v as { y?: unknown }).y === "number" &&
    Number.isFinite((v as { x: number }).x) &&
    Number.isFinite((v as { y: number }).y)
  );
}

function asNode(v: unknown): SceneNode | null {
  if (typeof v !== "object" || v === null || !asPoint(v)) {
    return null;
  }
  const raw = v as { id: unknown; x: unknown; y: unknown };
  if (typeof raw.id !== "string") {
    return null;
  }
  if (typeof raw.x !== "number" || typeof raw.y !== "number") {
    return null;
  }
  if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) {
    return null;
  }
  return { id: raw.id, x: raw.x, y: raw.y };
}

function asProfile(v: unknown): LaneProfile | null {
  if (typeof v !== "object" || v === null) {
    return null;
  }
  const raw = v as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.name !== "string") {
    return null;
  }

  if (
    typeof raw.carriagewayWidth !== "number" ||
    typeof raw.facilityWidth !== "number" ||
    typeof raw.sidewalkWidth !== "number" ||
    typeof raw.clearanceWidth !== "number"
  ) {
    return null;
  }

  if (
    !Number.isFinite(raw.carriagewayWidth) ||
    !Number.isFinite(raw.facilityWidth) ||
    !Number.isFinite(raw.sidewalkWidth) ||
    !Number.isFinite(raw.clearanceWidth)
  ) {
    return null;
  }

  return {
    id: raw.id,
    name: raw.name,
    carriagewayWidth: raw.carriagewayWidth,
    facilityWidth: raw.facilityWidth,
    sidewalkWidth: raw.sidewalkWidth,
    clearanceWidth: raw.clearanceWidth,
  };
}

function asGeomType(v: unknown): GeometryType {
  if (v === "polyline") {
    return "polyline";
  }
  return "spline";
}

function asRoadEndMode(v: unknown): RoadEndMode {
  return v === "closed" ? "closed" : "free";
}

function asRoadLayer(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
}

function ensureDefaultProfile(profiles: LaneProfile[]): string {
  const existed = new Set(profiles.map((p) => p.id));
  if (!existed.has("default")) {
    profiles.unshift({ ...DEFAULT_PROFILE });
    existed.add("default");
    return "补充默认横断面 default";
  }
  return "";
}

export function normalizeScene(input: Partial<RoadPenScene>): RoadPenScene {
  const warnings: string[] = [];

  const scene: RoadPenScene = {
    version: VERSION,
    units: "px",
    scalePxPerM: typeof input.scalePxPerM === "number" && input.scalePxPerM > 0 ? input.scalePxPerM : EMPTY_SCENE.scalePxPerM,
    nodes: [],
    edges: [],
    profiles: [],
  };

  const profiles: LaneProfile[] =
    Array.isArray(input.profiles)
      ? input.profiles
          .map(asProfile)
          .filter((v): v is LaneProfile => v !== null)
      : [];

  const profileWarning = ensureDefaultProfile(profiles);
  if (profileWarning) {
    warnings.push(profileWarning);
  }

  const nodeById = new Map<string, SceneNode>();
  if (Array.isArray(input.nodes)) {
    for (const raw of input.nodes) {
      const node = asNode(raw);
      if (node) {
        nodeById.set(node.id, node);
      }
    }
  }
  scene.nodes = [...nodeById.values()];

  const profileIdSet = new Set(profiles.map((profile) => profile.id));
  scene.profiles = [...profiles];

  if (Array.isArray(input.edges)) {
    const nodeSet = new Set(scene.nodes.map((node) => node.id));
    for (const raw of input.edges) {
      if (typeof raw !== "object" || raw === null) {
        continue;
      }
      const edgeRaw = raw as unknown as Record<string, unknown>;
      const id = typeof edgeRaw.id === "string" ? edgeRaw.id : "";
      if (!id) {
        continue;
      }

      const from = typeof edgeRaw.from === "string" ? edgeRaw.from : "";
      const to = typeof edgeRaw.to === "string" ? edgeRaw.to : "";
      if (!from || !to || !nodeSet.has(from) || !nodeSet.has(to)) {
        warnings.push(`忽略边 ${id}（端点不存在）`);
        continue;
      }

      const profileId =
        typeof edgeRaw.profileId === "string" && profileIdSet.has(edgeRaw.profileId)
          ? edgeRaw.profileId
          : "default";

      const controlPoints = Array.isArray(edgeRaw.controlPoints)
        ? edgeRaw.controlPoints
            .map((v) => {
      const point = asPoint(v) ? (v as { x: number; y: number }) : null;
      return point ? { x: point.x, y: point.y } : null;
    })
            .filter((p): p is { x: number; y: number } => p !== null)
        : [];

      if (controlPoints.length < 2) {
        warnings.push(`忽略边 ${id}（控制点不足）`);
        continue;
      }

      scene.edges.push({
        id,
        from,
        to,
        geomType: asGeomType(edgeRaw.geomType),
        endMode: asRoadEndMode(edgeRaw.endMode),
        layer: asRoadLayer(edgeRaw.layer),
        profileId,
        controlPoints,
      });
    }
  }

  if (scene.edges.length === 0) {
    warnings.push("当前场景未包含道路边。请先绘制道路后导出。 ");
  }

  if (typeof input.version !== "string") {
    warnings.push("补齐版本号 1.0.0");
  }

  if (input.units !== "px") {
    warnings.push("单位字段已重置为 px。新版本默认以像素为单位。");
  }

  return scene;
}

export function exportScene(scene: RoadPenScene): string {
  const payload = {
    version: VERSION,
    exportedAt: new Date().toISOString(),
    scene,
    renderer: {
      engine: "canvas-g6",
      includeCurvature: true,
    },
  };
  return JSON.stringify(payload, null, 2);
}

export function parseRoadPenScene(input: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch (err) {
    throw new Error("导入文件不是合法 JSON。\n" + String(err));
  }

  if (typeof raw !== "object" || raw === null) {
    throw new Error("导入文件格式不合法。需要对象结构。");
  }

  const asObj = raw as Record<string, unknown>;
  const candidate: Partial<RoadPenScene> =
    asObj.scene && typeof asObj.scene === "object"
      ? (asObj.scene as Partial<RoadPenScene>)
      : (asObj as unknown as Partial<RoadPenScene>);

  const scene = normalizeScene(candidate);
  const warnings: string[] = [];
  if (asObj.version && typeof asObj.version === "string") {
    // legacy root-level fields are accepted and ignored here
  }

  if (typeof asObj.version === "string" && asObj.version !== VERSION) {
    warnings.push(`检测到不同版本文件 (${asObj.version})，已按当前版本 ${VERSION} 重建。`);
  }

  return { scene, warnings };
}
