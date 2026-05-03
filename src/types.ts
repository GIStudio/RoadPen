export type Point = {
  x: number;
  y: number;
};

export type Units = "px";

export interface SceneNode {
  id: string;
  x: number;
  y: number;
}

export type GeometryType = "polyline" | "spline";

export type JunctionType = "line" | "curve" | "t" | "cross";

export type RoadEndMode = "free" | "closed";

export interface LaneProfile {
  id: string;
  name: string;
  carriagewayWidth: number;
  facilityWidth: number;
  sidewalkWidth: number;
  clearanceWidth: number;
}

export interface RoadEdge {
  id: string;
  from: string;
  to: string;
  geomType: GeometryType;
  endMode?: RoadEndMode;
  profileId: string;
  controlPoints: Point[];
}

export interface RoadPenScene {
  version: string;
  units: Units;
  scalePxPerM: number;
  nodes: SceneNode[];
  edges: RoadEdge[];
  profiles: LaneProfile[];
}

export interface LaneBand {
  id: string;
  name: string;
  qInner: number;
  qOuter: number;
  color: string;
  zIndex: number;
}

export interface TurnSpec {
  idx: number;
  u: Point;
  v: Point;
  a: Point;
  b: Point;
  delta: number;
  sigma: number;
  radius: number;
  ell: number;
  warning?: string;
}

export const DEBUG_LAYER_KEYS = [
  "junctionSurface",
  "laneConnectors",
  "roadSkeleton",
  "junctionBranches",
  "laneStops",
] as const;

export type DebugLayerKey = typeof DEBUG_LAYER_KEYS[number];

export interface DebugSettings {
  enabled: boolean;
  layers: Record<DebugLayerKey, boolean>;
  roadInspector: boolean;
  junctionInspector: boolean;
  isolateSelectedJunction: boolean;
}

export const DEFAULT_DEBUG_SETTINGS: DebugSettings = {
  enabled: false,
  layers: {
    junctionSurface: true,
    laneConnectors: true,
    roadSkeleton: true,
    junctionBranches: true,
    laneStops: true,
  },
  roadInspector: false,
  junctionInspector: false,
  isolateSelectedJunction: false,
};

export interface RoadInspectorDetails {
  edge: {
    id: string;
    from: string;
    to: string;
    geomType: GeometryType;
    endMode: RoadEndMode;
    profileId: string;
    controlPointCount: number;
    controlPoints: Point[];
    length: number;
  };
  profile: LaneProfile | null;
  visualChain: {
    id: string;
    edgeIds: string[];
    rawPointCount: number;
    sourcePointCount: number;
    renderPointCount: number;
    turnCount: number;
  } | null;
  endpoints: Array<{
    nodeId: string;
    junctionType: JunctionType | null;
    degree: number;
  }>;
}

export interface JunctionInspectorDetails {
  id: string;
  nodeId: string;
  type: JunctionType;
  degree: number;
  point: Point;
  branchCount: number;
  mouthLineCount: number;
  surfacePatchCount: number;
  laneConnectorCount: number;
  laneStopCount: number;
  virtualBoundary: boolean;
  branches: Array<{
    edgeId: string;
    profileId: string;
    direction: Point;
  }>;
}

export type ToolbarAction =
  | { type: "setMode"; mode: "select" | "draw" }
  | { type: "finish" }
  | { type: "export" }
  | { type: "exportSvg" }
  | { type: "import" }
  | { type: "setEndMode"; endMode: RoadEndMode }
  | { type: "setDebugPanelOpen"; open: boolean }
  | { type: "setDebugEnabled"; enabled: boolean }
  | { type: "setDebugLayer"; layer: DebugLayerKey; enabled: boolean }
  | { type: "setRoadInspector"; enabled: boolean }
  | { type: "setJunctionInspector"; enabled: boolean }
  | { type: "setIsolateSelectedJunction"; enabled: boolean }
  | { type: "clearJunctionSelection" };

export interface ToolbarState {
  mode: "select" | "draw";
  endMode: RoadEndMode;
  debug: DebugSettings;
  debugPanelOpen: boolean;
  selectedRoad: RoadInspectorDetails | null;
  selectedJunction: JunctionInspectorDetails | null;
  draftPoints: number;
  warningCount: number;
  canFinish: boolean;
}
