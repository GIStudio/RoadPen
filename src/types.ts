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

export type ToolbarAction =
  | "select"
  | "draw"
  | "finish"
  | "export"
  | "exportSvg"
  | "import"
  | "endFree"
  | "endClosed"
  | "toggleDebug";

export interface ToolbarState {
  mode: "select" | "draw";
  endMode: RoadEndMode;
  debugMode: boolean;
  draftPoints: number;
  warningCount: number;
  canFinish: boolean;
}
