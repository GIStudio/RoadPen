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
  layer?: number;
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

export type TurnFitState = "normal" | "borrowed" | "clustered" | "fallback";
export type TurnClusterType = "short-segment" | "adjacent" | "sequence" | "u-turn";

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
  minStableRadius: number;
  targetRadius: number;
  requiredEll: number;
  availableEll: number;
  fitState: TurnFitState;
  windowStartIndex: number;
  windowEndIndex: number;
  windowStartDistance: number;
  windowEndDistance: number;
  clusterType?: TurnClusterType;
  fallbackResolved?: boolean;
  warning?: string;
}

export const DEBUG_LAYER_KEYS = [
  "junctionSurface",
  "laneConnectors",
  "roadSkeleton",
  "junctionBranches",
  "laneStops",
  "geometryIssues",
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
    geometryIssues: true,
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
    layer: number;
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
  layer: number;
  type: JunctionType;
  degree: number;
  point: Point;
  branchCount: number;
  connectionCount: number;
  mouthLineCount: number;
  surfacePatchCount: number;
  laneConnectorCount: number;
  laneStopCount: number;
  virtualBoundary: boolean;
  branches: Array<{
    edgeId: string;
    profileId: string;
    layer: number;
    direction: Point;
  }>;
}

export const GEOMETRY_ISSUE_TYPES = [
  "crossLayerOverlap",
  "sameLayerUnsplitCrossing",
  "shortEdgeStub",
  "junctionSurfaceGapCandidate",
  "sharpCornerGapCandidate",
  "outerLaneCoverageGap",
  "extremeTurnFallback",
  "selfOverlapCandidate",
  "localZOrderApplied",
] as const;

export type GeometryIssueType = typeof GEOMETRY_ISSUE_TYPES[number];

export interface GeometryIssueMarker {
  type: GeometryIssueType;
  layer: number;
  point: Point;
  message: string;
  edgeIds?: string[];
  junctionBlockId?: string;
}

export interface GeometryIssueReport {
  counts: Record<GeometryIssueType, number>;
  markers: GeometryIssueMarker[];
}

export type ToolbarAction =
  | { type: "setMode"; mode: "select" | "draw" }
  | { type: "finish" }
  | { type: "export" }
  | { type: "exportSvg" }
  | { type: "import" }
  | { type: "loadValidationScene" }
  | { type: "setEndMode"; endMode: RoadEndMode }
  | { type: "setRoadLayer"; layer: number }
  | { type: "setSelectedRoadLayer"; edgeId: string; layer: number }
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
  selectedRoadLayer: number;
  debug: DebugSettings;
  debugPanelOpen: boolean;
  selectedRoad: RoadInspectorDetails | null;
  selectedJunction: JunctionInspectorDetails | null;
  geometryIssues: GeometryIssueReport;
  draftPoints: number;
  warningCount: number;
  canFinish: boolean;
}
