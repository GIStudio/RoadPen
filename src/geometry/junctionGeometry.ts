import type { JunctionType, LaneBand, Point, RoadEdge, RoadPenScene, SceneNode, TurnSpec } from "../types";
import { buildLaneBandsForProfile, sampleOffsetTurnCurve } from "./roadGeometry";

export interface JunctionBranch {
  edgeId: string;
  layer: number;
  direction: Point;
  profileId: string;
}

export interface JunctionAnalysis {
  nodeId: string;
  layer: number;
  point: Point;
  type: JunctionType;
  degree: number;
  branches: JunctionBranch[];
}

export interface JunctionPatch {
  junctionBlockId: string;
  connectionId?: string;
  nodeId: string;
  layer: number;
  type: JunctionType;
  bandId: string;
  kind?: "mouth" | "turn" | "center" | "virtual-boundary" | "corner-closure" | "large-angle-closure";
  fromEdgeId?: string;
  toEdgeId?: string;
  directed?: boolean;
  band: LaneBand;
  polygon: Point[];
}

export interface LaneConnectorPatch {
  junctionBlockId: string;
  connectionId: string;
  nodeId: string;
  layer: number;
  baseLane: "facility" | "sidewalk" | "clearance";
  fromEdgeId: string;
  toEdgeId: string;
  gapRadians: number;
  fromStopPoint: Point;
  toStopPoint: Point;
  band: LaneBand;
  polygon: Point[];
}

export type JunctionConnectionCategory = "carriageway" | "facility" | "sidewalk" | "clearance";
export type JunctionTurnClass = "straight" | "right" | "left" | "u" | "s-curve";

export interface JunctionConnection {
  id: string;
  junctionBlockId: string;
  nodeId: string;
  layer: number;
  type: JunctionType;
  category: JunctionConnectionCategory;
  turnClass: JunctionTurnClass;
  passThrough: boolean;
  fromEdgeId: string;
  toEdgeId: string;
  gapRadians: number;
  fromMouthPoint: Point;
  toMouthPoint: Point;
  centerCurve: Point[];
  leftBoundary: Point[];
  rightBoundary: Point[];
  band: LaneBand;
  sweptPolygon: Point[];
}

export interface CarriagewayVirtualMouthLine {
  junctionBlockId: string;
  nodeId: string;
  layer: number;
  type: JunctionType;
  edgeId: string;
  bandId: "carriageway";
  band: LaneBand;
  direction: Point;
  centerPoint: Point;
  innerPoint: Point;
  outerPoint: Point;
  depth: number;
}

export interface JunctionLaneStop {
  junctionBlockId: string;
  nodeId: string;
  layer: number;
  edgeId: string;
  baseLane: "facility" | "sidewalk" | "clearance";
  side: "left" | "right";
  kind: "connector";
  point: Point;
}

export interface JunctionBlock {
  id: string;
  nodeId: string;
  layer: number;
  point: Point;
  type: JunctionType;
  degree: number;
  branches: JunctionBranch[];
  mouthLines: CarriagewayVirtualMouthLine[];
  connections: JunctionConnection[];
  surfacePatches: JunctionPatch[];
  laneConnectorPatches: LaneConnectorPatch[];
  laneStops: JunctionLaneStop[];
  virtualBoundary: JunctionPatch | null;
}

export interface JunctionGeometry {
  junctions: JunctionAnalysis[];
  junctionBlocks: JunctionBlock[];
  connections: JunctionConnection[];
  patches: JunctionPatch[];
  laneConnectorPatches: LaneConnectorPatch[];
  virtualMouthLines: CarriagewayVirtualMouthLine[];
  warnings: string[];
}

type ProfileMap = Map<string, { carriagewayWidth: number; facilityWidth: number; sidewalkWidth: number; clearanceWidth: number }>;

const EPS = 1e-9;
const MIN_BRANCH_LENGTH = 1e-4;
const DUPLICATE_DIRECTION_DOT = 0.985;
const JUNCTION_LANE_MIN_TURN_RADIUS = 10;
const JUNCTION_LANE_RADIUS_FACTOR = 2.2;
const JUNCTION_LANE_CURVE_SAMPLES = 18;
const PASS_THROUGH_DOT = -0.82;
const PASS_THROUGH_DOMINANCE = 0.08;
const MIN_LANE_CONNECTOR_GAP = Math.PI / 12;
const MAX_LANE_CONNECTOR_GAP = Math.PI * 0.93;
const WIDE_LANE_CONNECTOR_GAP = Math.PI / 2;

function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(point: Point, value: number): Point {
  return { x: point.x * value, y: point.y * value };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalize(point: Point): Point | null {
  const len = Math.hypot(point.x, point.y);
  if (len <= MIN_BRANCH_LENGTH) {
    return null;
  }
  return { x: point.x / len, y: point.y / len };
}

function leftNormal(direction: Point): Point {
  return { x: -direction.y, y: direction.x };
}

function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y;
}

function crossVec(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x;
}

function profileMapFromScene(scene: RoadPenScene): ProfileMap {
  const map: ProfileMap = new Map();
  for (const profile of scene.profiles) {
    map.set(profile.id, {
      carriagewayWidth: profile.carriagewayWidth,
      facilityWidth: profile.facilityWidth,
      sidewalkWidth: profile.sidewalkWidth,
      clearanceWidth: profile.clearanceWidth,
    });
  }
  return map;
}

function roadLayer(edge: RoadEdge): number {
  return typeof edge.layer === "number" && Number.isFinite(edge.layer) ? Math.trunc(edge.layer) : 0;
}

function classifyJunction(vectors: Point[]): JunctionType {
  const n = vectors.length;
  if (n <= 1) {
    return "line";
  }
  if (n === 2) {
    const a = vectors[0];
    const b = vectors[1];
    return a.x * b.x + a.y * b.y < -0.82 ? "line" : "curve";
  }
  if (n === 3) {
    return "t";
  }
  return "cross";
}

function edgeDirectionAtNode(edge: RoadEdge, nodeId: string, node: SceneNode, nodeMap: Map<string, SceneNode>): Point | null {
  const candidates =
    edge.from === nodeId
      ? edge.controlPoints.slice(1)
      : edge.controlPoints.slice(0, Math.max(0, edge.controlPoints.length - 1)).reverse();

  for (const candidate of candidates) {
    const direction = normalize(sub(candidate, node));
    if (direction) {
      return direction;
    }
  }

  const otherNode = nodeMap.get(edge.from === nodeId ? edge.to : edge.from);
  return otherNode ? normalize(sub(otherNode, node)) : null;
}

function pointKey(point: Point): string {
  return `${point.x.toFixed(6)},${point.y.toFixed(6)}`;
}

function junctionBlockIdForNode(nodeId: string, layer: number): string {
  return layer === 0 ? `junction-${nodeId}` : `junction-${nodeId}-layer-${layer}`;
}

function junctionConnectionId(junctionBlockId: string, category: JunctionConnectionCategory, fromEdgeId: string, toEdgeId: string): string {
  return `${junctionBlockId}-connection-${category}-${fromEdgeId}-${toEdgeId}`;
}

function maxProfileOffset(profileMap: ProfileMap, profileId: string): number {
  const bands = buildLaneBandsForProfile(profileId, profileMap);
  return Math.max(
    0,
    ...bands.map((band) => Math.max(Math.abs(band.qInner), Math.abs(band.qOuter))),
  );
}

function carriagewayJunctionDepthForBranch(profileMap: ProfileMap, branch: JunctionBranch, band: LaneBand): number {
  const carriagewayOffset = Math.max(Math.abs(band.qInner), Math.abs(band.qOuter));
  const profileOffset = maxProfileOffset(profileMap, branch.profileId);
  return Math.max(30, carriagewayOffset * 2.4, profileOffset * 1.35);
}

interface JunctionConnectionGeometry {
  turn: TurnSpec;
  centerCurve: Point[];
  leftBoundary: Point[];
  rightBoundary: Point[];
  sweptPolygon: Point[];
}

function junctionTurnClass(turn: TurnSpec): JunctionTurnClass {
  if (turn.delta <= Math.PI / 9) {
    return "straight";
  }
  if (turn.delta >= Math.PI * 0.88) {
    return "u";
  }
  return turn.sigma >= 0 ? "right" : "left";
}

function buildJunctionConnectionGeometry(
  point: Point,
  aDir: Point,
  aBand: LaneBand,
  bDir: Point,
  bBand: LaneBand,
  aReference: LaneBand,
  bReference: LaneBand,
  ellHint: number,
): JunctionConnectionGeometry | null {
  const turn = buildVirtualLaneTurn(point, aDir, bDir, aReference, bReference, ellHint);
  if (!turn) {
    return null;
  }

  const outerQ = virtualLaneBoundaryQ(aBand.qOuter, bBand.qInner);
  const innerQ = virtualLaneBoundaryQ(aBand.qInner, bBand.qOuter);
  const outerCurve = sampleOffsetTurnCurve(turn, outerQ, JUNCTION_LANE_CURVE_SAMPLES);
  const innerCurve = sampleOffsetTurnCurve(turn, innerQ, JUNCTION_LANE_CURVE_SAMPLES);
  if (outerCurve.length < 4 || innerCurve.length < 4) {
    return null;
  }

  const innerBoundary = [...innerCurve];
  const polygon = [...outerCurve, ...[...innerBoundary].reverse()];
  polygon.push({ ...polygon[0] });
  return {
    turn,
    centerCurve: sampleOffsetTurnCurve(turn, 0, JUNCTION_LANE_CURVE_SAMPLES),
    leftBoundary: outerCurve,
    rightBoundary: innerBoundary,
    sweptPolygon: polygon,
  };
}

function buildCarriagewayConnections(
  analysis: JunctionAnalysis,
  profileMap: ProfileMap,
  branchBands: Array<{ branch: JunctionBranch; band: LaneBand }>,
  junctionBlockId: string,
): JunctionConnection[] {
  const branches = sortedBranches(branchBands.map((item) => item.branch));
  const bandByEdge = new Map(branchBands.map((item) => [item.branch.edgeId, item.band]));
  const passThrough = passThroughPairs(branches);
  const connections: JunctionConnection[] = [];

  const addDirectedConnection = (from: JunctionBranch, to: JunctionBranch): void => {
    const fromBand = bandByEdge.get(from.edgeId);
    const toBand = bandByEdge.get(to.edgeId);
    if (!fromBand || !toBand) {
      return;
    }

    const fromReference = outerReferenceBand(profileMap, from, "left") ?? fromBand;
    const toReference = outerReferenceBand(profileMap, to, "right") ?? toBand;
    const gapRadians = ccwGap(from, to);
    const connectorEll =
      gapRadians <= WIDE_LANE_CONNECTOR_GAP
        ? compactConnectorEll(from.direction, to.direction, fromReference, toReference)
        : wideConnectorDepth(profileMap, from, to);
    const mouthEll = Math.max(
      carriagewayJunctionDepthForBranch(profileMap, from, fromBand),
      carriagewayJunctionDepthForBranch(profileMap, to, toBand),
    );
    const geometry = buildJunctionConnectionGeometry(
      analysis.point,
      from.direction,
      fromBand,
      to.direction,
      toBand,
      fromReference,
      toReference,
      Math.max(connectorEll, mouthEll),
    );
    if (!geometry || geometry.sweptPolygon.length < 4) {
      return;
    }

    connections.push({
      id: junctionConnectionId(junctionBlockId, "carriageway", from.edgeId, to.edgeId),
      junctionBlockId,
      nodeId: analysis.nodeId,
      layer: analysis.layer,
      type: analysis.type,
      category: "carriageway",
      turnClass: junctionTurnClass(geometry.turn),
      passThrough: false,
      fromEdgeId: from.edgeId,
      toEdgeId: to.edgeId,
      gapRadians,
      fromMouthPoint: { ...geometry.turn.a },
      toMouthPoint: { ...geometry.turn.b },
      centerCurve: geometry.centerCurve,
      leftBoundary: geometry.leftBoundary,
      rightBoundary: geometry.rightBoundary,
      band: { ...fromBand },
      sweptPolygon: geometry.sweptPolygon,
    });
  };

  for (let i = 0; i < branches.length; i += 1) {
    const a = branches[i];
    const b = branches[(i + 1) % branches.length];
    if (passThrough.has(branchPairKey(a, b)) || !canBuildCollisionCorner(a, b)) {
      continue;
    }

    addDirectedConnection(a, b);
    addDirectedConnection(b, a);
  }

  return connections;
}

function carriagewayPatchFromConnection(connection: JunctionConnection): JunctionPatch {
  return {
    junctionBlockId: connection.junctionBlockId,
    connectionId: connection.id,
    nodeId: connection.nodeId,
    layer: connection.layer,
    type: connection.type,
    bandId: "carriageway",
    kind: "turn",
    fromEdgeId: connection.fromEdgeId,
    toEdgeId: connection.toEdgeId,
    directed: true,
    band: { ...connection.band },
    polygon: connection.sweptPolygon,
  };
}

function buildCarriagewayVirtualMouthLines(
  analysis: JunctionAnalysis,
  profileMap: ProfileMap,
  branchBands: Array<{ branch: JunctionBranch; band: LaneBand }>,
  junctionBlockId: string,
): CarriagewayVirtualMouthLine[] {
  return branchBands.map(({ branch, band }) => {
    const normal = leftNormal(branch.direction);
    const depth = carriagewayJunctionDepthForBranch(profileMap, branch, band);
    const centerPoint = add(analysis.point, scale(branch.direction, depth));
    return {
      junctionBlockId,
      nodeId: analysis.nodeId,
      layer: analysis.layer,
      type: analysis.type,
      edgeId: branch.edgeId,
      bandId: "carriageway",
      band: { ...band },
      direction: { ...branch.direction },
      centerPoint,
      innerPoint: add(centerPoint, scale(normal, band.qInner)),
      outerPoint: add(centerPoint, scale(normal, band.qOuter)),
      depth,
    };
  });
}

function buildCarriagewayMouthPatches(analysis: JunctionAnalysis, mouthLines: CarriagewayVirtualMouthLine[]): JunctionPatch[] {
  return mouthLines.map((line) => {
    const normal = leftNormal(line.direction);
    const polygon = [
      add(analysis.point, scale(normal, line.band.qInner)),
      { ...line.innerPoint },
      { ...line.outerPoint },
      add(analysis.point, scale(normal, line.band.qOuter)),
    ];
    polygon.push({ ...polygon[0] });

    return {
      junctionBlockId: line.junctionBlockId,
      nodeId: analysis.nodeId,
      layer: analysis.layer,
      type: analysis.type,
      bandId: "carriageway",
      kind: "mouth" as const,
      band: { ...line.band },
      polygon,
    };
  });
}

function buildCarriagewayCenterEnvelopePatch(
  analysis: JunctionAnalysis,
  mouthLines: CarriagewayVirtualMouthLine[],
): JunctionPatch | null {
  if (mouthLines.length < 3) {
    return null;
  }

  const referenceBand = mouthLines[0].band;
  const boundaryPoints = mouthLines.flatMap((line) => [{ ...line.innerPoint }, { ...line.outerPoint }]);

  const uniqueBoundaryPoints = new Map<string, Point>();
  for (const point of boundaryPoints) {
    if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
      uniqueBoundaryPoints.set(pointKey(point), point);
    }
  }

  const polygon = [...uniqueBoundaryPoints.values()]
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .sort(
      (a, b) =>
        Math.atan2(a.y - analysis.point.y, a.x - analysis.point.x) -
        Math.atan2(b.y - analysis.point.y, b.x - analysis.point.x),
    );

  if (polygon.length < 3) {
    return null;
  }

  polygon.push({ ...polygon[0] });
  return {
    junctionBlockId: mouthLines[0].junctionBlockId,
    nodeId: analysis.nodeId,
    layer: analysis.layer,
    type: analysis.type,
    bandId: "carriageway",
    kind: "virtual-boundary",
    band: { ...referenceBand },
    polygon,
  };
}

function polygonArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area * 0.5;
}

function buildCarriagewayCornerClosurePatches(
  analysis: JunctionAnalysis,
  mouthLines: CarriagewayVirtualMouthLine[],
): JunctionPatch[] {
  if (analysis.degree < 3 || mouthLines.length < 3) {
    return [];
  }

  const lineByEdgeId = new Map(mouthLines.map((line) => [line.edgeId, line]));
  const branches = sortedBranches(analysis.branches);
  const passThrough = passThroughPairs(branches);
  const patches: JunctionPatch[] = [];

  for (let i = 0; i < branches.length; i += 1) {
    const a = branches[i];
    const b = branches[(i + 1) % branches.length];
    const isPassThrough = passThrough.has(branchPairKey(a, b));
    if (!canBuildCarriagewayClosureCorner(a, b)) {
      continue;
    }

    const aLine = lineByEdgeId.get(a.edgeId);
    const bLine = lineByEdgeId.get(b.edgeId);
    if (!aLine || !bLine) {
      continue;
    }

    const polygon = [
      { ...analysis.point },
      { ...aLine.outerPoint },
      { ...bLine.innerPoint },
      { ...analysis.point },
    ];
    if (Math.abs(polygonArea(polygon)) < 20) {
      continue;
    }

    patches.push({
      junctionBlockId: aLine.junctionBlockId,
      nodeId: analysis.nodeId,
      layer: analysis.layer,
      type: analysis.type,
      bandId: "carriageway",
      kind: isPassThrough || !canBuildCollisionCorner(a, b) ? "large-angle-closure" : "corner-closure",
      fromEdgeId: a.edgeId,
      toEdgeId: b.edgeId,
      band: { ...aLine.band },
      polygon,
    });
  }

  return patches;
}

function branchBand(profileMap: ProfileMap, branch: JunctionBranch, bandId: string): LaneBand | null {
  return buildLaneBandsForProfile(branch.profileId, profileMap).find((band) => band.id === bandId) ?? null;
}

function connectorDepth(aLeft: LaneBand, bRight: LaneBand): number {
  const maxOffset = Math.max(
    Math.abs(aLeft.qInner),
    Math.abs(aLeft.qOuter),
    Math.abs(bRight.qInner),
    Math.abs(bRight.qOuter),
  );
  return clamp(maxOffset * 1.5, 18, 42);
}

function wideConnectorDepth(profileMap: ProfileMap, a: JunctionBranch, b: JunctionBranch): number {
  const maxOffset = Math.max(maxProfileOffset(profileMap, a.profileId), maxProfileOffset(profileMap, b.profileId));
  return clamp(maxOffset * 1.65, 36, 92);
}

function virtualLaneBoundaryQ(leftQ: number, rightQ: number): number {
  return (-leftQ + rightQ) / 2;
}

function compactConnectorEll(aDir: Point, bDir: Point, aReference: LaneBand, bReference: LaneBand): number {
  const u = scale(aDir, -1);
  const v = bDir;
  const delta = Math.acos(clamp(dot(u, v), -1, 1));
  const maxOffset = Math.max(
    Math.abs(aReference.qInner),
    Math.abs(aReference.qOuter),
    Math.abs(bReference.qInner),
    Math.abs(bReference.qOuter),
  );
  const minRadius = maxOffset + JUNCTION_LANE_MIN_TURN_RADIUS * 0.5;
  const desiredRadius = Math.max(maxOffset * 2 * JUNCTION_LANE_RADIUS_FACTOR, JUNCTION_LANE_MIN_TURN_RADIUS);
  const desiredEll = desiredRadius * Math.tan(delta / 2);
  const mouthLimit = connectorDepth(aReference, bReference);
  const minEll = minRadius * Math.tan(delta / 2);
  return clamp(desiredEll, Math.max(JUNCTION_LANE_MIN_TURN_RADIUS * 0.6, minEll), Math.max(mouthLimit, minEll));
}

function buildVirtualLaneTurn(
  point: Point,
  aDir: Point,
  bDir: Point,
  aReference: LaneBand,
  bReference: LaneBand,
  ellHint: number,
): TurnSpec | null {
  const u = scale(aDir, -1);
  const v = bDir;
  const dotValue = clamp(dot(u, v), -1, 1);
  const delta = Math.acos(dotValue);
  const cr = crossVec(u, v);
  if (delta <= Math.PI / 36 || Math.abs(cr) <= EPS) {
    return null;
  }

  const maxOffset = Math.max(
    Math.abs(aReference.qInner),
    Math.abs(aReference.qOuter),
    Math.abs(bReference.qInner),
    Math.abs(bReference.qOuter),
  );
  const minRadius = maxOffset + JUNCTION_LANE_MIN_TURN_RADIUS * 0.5;
  const minEll = minRadius * Math.tan(delta / 2);
  const ell = Math.max(ellHint, JUNCTION_LANE_MIN_TURN_RADIUS * 0.6, minEll);
  const radius = Math.max(ell / Math.tan(delta / 2), JUNCTION_LANE_MIN_TURN_RADIUS);
  const requiredEll = radius * Math.tan(delta / 2);

  return {
    idx: 0,
    u,
    v,
    a: add(point, scale(aDir, ell)),
    b: add(point, scale(bDir, ell)),
    delta,
    sigma: cr >= 0 ? 1 : -1,
    radius,
    ell,
    minStableRadius: minRadius,
    targetRadius: radius,
    requiredEll,
    availableEll: ell,
    fitState: "normal",
    windowStartIndex: 0,
    windowEndIndex: 1,
    windowStartDistance: 0,
    windowEndDistance: ell * 2,
    warning: undefined,
  };
}

function outerReferenceBand(profileMap: ProfileMap, branch: JunctionBranch, side: "left" | "right"): LaneBand | null {
  const bases: Array<"clearance" | "sidewalk" | "facility"> = ["clearance", "sidewalk", "facility"];
  for (const base of bases) {
    const band = branchBand(profileMap, branch, `${base}_${side}`);
    if (band && Math.abs(band.qOuter - band.qInner) > 1e-6) {
      return band;
    }
  }
  return null;
}

function sortedBranches(branches: JunctionBranch[]): JunctionBranch[] {
  return [...branches].sort((a, b) => Math.atan2(a.direction.y, a.direction.x) - Math.atan2(b.direction.y, b.direction.x));
}

function branchGapDot(a: JunctionBranch, b: JunctionBranch): number {
  return dot(a.direction, b.direction);
}

function directionAngle(direction: Point): number {
  return Math.atan2(direction.y, direction.x);
}

function ccwGap(a: JunctionBranch, b: JunctionBranch): number {
  const raw = directionAngle(b.direction) - directionAngle(a.direction);
  return raw >= 0 ? raw : raw + Math.PI * 2;
}

function canBuildCollisionCorner(a: JunctionBranch, b: JunctionBranch): boolean {
  if (a.edgeId === b.edgeId) {
    return false;
  }

  const gap = ccwGap(a, b);
  if (gap <= MIN_LANE_CONNECTOR_GAP || gap >= MAX_LANE_CONNECTOR_GAP) {
    return false;
  }

  const gapDot = branchGapDot(a, b);
  return gapDot > -0.96 && gapDot < Math.cos(MIN_LANE_CONNECTOR_GAP);
}

function canBuildCarriagewayClosureCorner(a: JunctionBranch, b: JunctionBranch): boolean {
  if (a.edgeId === b.edgeId) {
    return false;
  }

  const gap = ccwGap(a, b);
  return gap > MIN_LANE_CONNECTOR_GAP && gap < Math.PI * 0.997;
}

function branchPairKey(a: JunctionBranch, b: JunctionBranch): string {
  return [a.edgeId, b.edgeId].sort().join("::");
}

function passThroughPairs(branches: JunctionBranch[]): Set<string> {
  const candidates: Array<{ a: JunctionBranch; b: JunctionBranch; dot: number }> = [];
  for (let i = 0; i < branches.length; i += 1) {
    for (let j = i + 1; j < branches.length; j += 1) {
      const a = branches[i];
      const b = branches[j];
      if (a.profileId !== b.profileId) {
        continue;
      }
      const value = dot(a.direction, b.direction);
      if (value <= PASS_THROUGH_DOT) {
        candidates.push({ a, b, dot: value });
      }
    }
  }

  candidates.sort((a, b) => a.dot - b.dot);
  if (
    branches.length === 3 &&
    candidates.length >= 2 &&
    candidates[1].dot - candidates[0].dot < PASS_THROUGH_DOMINANCE
  ) {
    return new Set<string>();
  }

  const used = new Set<string>();
  const pairs = new Set<string>();
  for (const candidate of candidates) {
    if (used.has(candidate.a.edgeId) || used.has(candidate.b.edgeId)) {
      continue;
    }
    used.add(candidate.a.edgeId);
    used.add(candidate.b.edgeId);
    pairs.add(branchPairKey(candidate.a, candidate.b));
  }
  return pairs;
}

function buildLaneConnectorConnections(analysis: JunctionAnalysis, profileMap: ProfileMap, junctionBlockId: string): JunctionConnection[] {
  if (analysis.degree < 3) {
    return [];
  }

  const branches = sortedBranches(analysis.branches);
  const passThrough = passThroughPairs(branches);
  const bases: Array<"facility" | "sidewalk" | "clearance"> = ["facility", "sidewalk", "clearance"];
  const connections: JunctionConnection[] = [];

  for (let i = 0; i < branches.length; i += 1) {
    const a = branches[i];
    const b = branches[(i + 1) % branches.length];
    if (passThrough.has(branchPairKey(a, b))) {
      continue;
    }
    if (!canBuildCollisionCorner(a, b)) {
      continue;
    }

    const aReference = outerReferenceBand(profileMap, a, "left");
    const bReference = outerReferenceBand(profileMap, b, "right");
    if (!aReference || !bReference) {
      continue;
    }

    for (const base of bases) {
      const aLeft = branchBand(profileMap, a, `${base}_left`);
      const bRight = branchBand(profileMap, b, `${base}_right`);
      if (!aLeft || !bRight) {
        continue;
      }

      if (Math.abs(aLeft.qOuter - aLeft.qInner) <= 1e-6 || Math.abs(bRight.qOuter - bRight.qInner) <= 1e-6) {
        continue;
      }

      const gapRadians = ccwGap(a, b);
      const ellHint =
        gapRadians <= WIDE_LANE_CONNECTOR_GAP
          ? compactConnectorEll(a.direction, b.direction, aReference, bReference)
          : wideConnectorDepth(profileMap, a, b);
      const geometry = buildJunctionConnectionGeometry(
        analysis.point,
        a.direction,
        aLeft,
        b.direction,
        bRight,
        aReference,
        bReference,
        ellHint,
      );
      if (!geometry || geometry.sweptPolygon.length < 4) {
        continue;
      }

      connections.push({
        id: junctionConnectionId(junctionBlockId, base, a.edgeId, b.edgeId),
        junctionBlockId,
        nodeId: analysis.nodeId,
        layer: analysis.layer,
        type: analysis.type,
        category: base,
        turnClass: junctionTurnClass(geometry.turn),
        passThrough: false,
        fromEdgeId: a.edgeId,
        toEdgeId: b.edgeId,
        gapRadians,
        fromMouthPoint: { ...geometry.turn.a },
        toMouthPoint: { ...geometry.turn.b },
        centerCurve: geometry.centerCurve,
        leftBoundary: geometry.leftBoundary,
        rightBoundary: geometry.rightBoundary,
        band: {
          ...aLeft,
          id: base,
          name: base,
        },
        sweptPolygon: geometry.sweptPolygon,
      });
    }
  }

  return connections;
}

function laneConnectorPatchFromConnection(connection: JunctionConnection): LaneConnectorPatch | null {
  if (connection.category === "carriageway") {
    return null;
  }

  return {
    junctionBlockId: connection.junctionBlockId,
    connectionId: connection.id,
    nodeId: connection.nodeId,
    layer: connection.layer,
    baseLane: connection.category,
    fromEdgeId: connection.fromEdgeId,
    toEdgeId: connection.toEdgeId,
    gapRadians: connection.gapRadians,
    fromStopPoint: { ...connection.fromMouthPoint },
    toStopPoint: { ...connection.toMouthPoint },
    band: { ...connection.band },
    polygon: connection.sweptPolygon,
  };
}

function buildPatchesForJunction(
  analysis: JunctionAnalysis,
  profileMap: ProfileMap,
  junctionBlockId: string,
): { patches: JunctionPatch[]; virtualMouthLines: CarriagewayVirtualMouthLine[]; connections: JunctionConnection[] } {
  const byBand = new Map<string, Array<{ branch: JunctionBranch; band: LaneBand }>>();

  for (const branch of analysis.branches) {
    const bands = buildLaneBandsForProfile(branch.profileId, profileMap);
    for (const band of bands) {
      const items = byBand.get(band.id) ?? [];
      items.push({ branch, band });
      byBand.set(band.id, items);
    }
  }

  const patches: JunctionPatch[] = [];
  const virtualMouthLines: CarriagewayVirtualMouthLine[] = [];
  const connections: JunctionConnection[] = [];
  for (const [bandId, branchBands] of byBand) {
    if (bandId !== "carriageway") {
      continue;
    }
    const mouthLines = buildCarriagewayVirtualMouthLines(analysis, profileMap, branchBands, junctionBlockId);
    virtualMouthLines.push(...mouthLines);
    patches.push(...buildCarriagewayMouthPatches(analysis, mouthLines));
    const carriagewayConnections = buildCarriagewayConnections(analysis, profileMap, branchBands, junctionBlockId);
    connections.push(...carriagewayConnections);
    patches.push(...carriagewayConnections.map(carriagewayPatchFromConnection));
    const centerPatch = buildCarriagewayCenterEnvelopePatch(analysis, mouthLines);
    if (centerPatch) {
      patches.push(centerPatch);
    }
    patches.push(...buildCarriagewayCornerClosurePatches(analysis, mouthLines));
  }

  return { patches, virtualMouthLines, connections };
}

function laneStopsForJunctionBlock(blockId: string, nodeId: string, layer: number, patches: LaneConnectorPatch[]): JunctionLaneStop[] {
  return patches.flatMap((patch) => [
    {
      junctionBlockId: blockId,
      nodeId,
      layer,
      edgeId: patch.fromEdgeId,
      baseLane: patch.baseLane,
      side: "left" as const,
      kind: "connector" as const,
      point: { ...patch.fromStopPoint },
    },
    {
      junctionBlockId: blockId,
      nodeId,
      layer,
      edgeId: patch.toEdgeId,
      baseLane: patch.baseLane,
      side: "right" as const,
      kind: "connector" as const,
      point: { ...patch.toStopPoint },
    },
  ]);
}

function buildJunctionBlock(analysis: JunctionAnalysis, profileMap: ProfileMap): JunctionBlock {
  const id = junctionBlockIdForNode(analysis.nodeId, analysis.layer);
  const { patches, virtualMouthLines, connections: surfaceConnections } = buildPatchesForJunction(analysis, profileMap, id);
  const laneConnectorConnections = buildLaneConnectorConnections(analysis, profileMap, id);
  const laneConnectorPatches = laneConnectorConnections
    .map(laneConnectorPatchFromConnection)
    .filter((patch): patch is LaneConnectorPatch => Boolean(patch));
  const connections = [...surfaceConnections, ...laneConnectorConnections];

  return {
    id,
    nodeId: analysis.nodeId,
    layer: analysis.layer,
    point: { ...analysis.point },
    type: analysis.type,
    degree: analysis.degree,
    branches: analysis.branches.map((branch) => ({
      edgeId: branch.edgeId,
      layer: branch.layer,
      profileId: branch.profileId,
      direction: { ...branch.direction },
    })),
    mouthLines: virtualMouthLines,
    connections,
    surfacePatches: patches,
    laneConnectorPatches,
    laneStops: laneStopsForJunctionBlock(id, analysis.nodeId, analysis.layer, laneConnectorPatches),
    virtualBoundary: patches.find((patch) => patch.kind === "virtual-boundary") ?? null,
  };
}

function duplicateDirectionWarnings(analysis: JunctionAnalysis): string[] {
  const warnings: string[] = [];
  for (let i = 0; i < analysis.branches.length; i += 1) {
    for (let j = i + 1; j < analysis.branches.length; j += 1) {
      const a = analysis.branches[i];
      const b = analysis.branches[j];
      const dot = a.direction.x * b.direction.x + a.direction.y * b.direction.y;
      if (dot > DUPLICATE_DIRECTION_DOT) {
        warnings.push(`路口 ${analysis.nodeId}：道路 ${a.edgeId} 与 ${b.edgeId} 方向过近，可能重叠。`);
      }
    }
  }
  return warnings;
}

export function buildJunctionGeometry(scene: RoadPenScene, profileMap: ProfileMap = profileMapFromScene(scene)): JunctionGeometry {
  const nodeMap = new Map(scene.nodes.map((node) => [node.id, node]));
  const edgesByNode = new Map<string, RoadEdge[]>();
  const warnings: string[] = [];

  for (const edge of scene.edges) {
    edgesByNode.set(edge.from, [...(edgesByNode.get(edge.from) ?? []), edge]);
    edgesByNode.set(edge.to, [...(edgesByNode.get(edge.to) ?? []), edge]);
  }

  const junctions: JunctionAnalysis[] = [];
  const junctionBlocks: JunctionBlock[] = [];
  const patches: JunctionPatch[] = [];
  const connections: JunctionConnection[] = [];
  const laneConnectorPatches: LaneConnectorPatch[] = [];
  const virtualMouthLines: CarriagewayVirtualMouthLine[] = [];

  for (const node of scene.nodes) {
    const edges = edgesByNode.get(node.id) ?? [];
    const branchesByLayer = new Map<number, JunctionBranch[]>();

    for (const edge of edges) {
      const direction = edgeDirectionAtNode(edge, node.id, node, nodeMap);
      if (!direction) {
        warnings.push(`路口 ${node.id}：道路 ${edge.id} 在节点附近方向过短，已跳过该分支。`);
        continue;
      }
      const layer = roadLayer(edge);
      const branches = branchesByLayer.get(layer) ?? [];
      branches.push({
        edgeId: edge.id,
        layer,
        direction,
        profileId: edge.profileId,
      });
      branchesByLayer.set(layer, branches);
    }

    for (const [layer, branches] of [...branchesByLayer.entries()].sort((a, b) => a[0] - b[0])) {
      const type = classifyJunction(branches.map((branch) => branch.direction));
      const analysis: JunctionAnalysis = {
        nodeId: node.id,
        layer,
        point: { x: node.x, y: node.y },
        type,
        degree: branches.length,
        branches,
      };
      junctions.push(analysis);
      warnings.push(...duplicateDirectionWarnings(analysis));

      if (analysis.degree >= 3) {
        const block = buildJunctionBlock(analysis, profileMap);
        if (block.surfacePatches.length === 0) {
          warnings.push(`路口 ${node.id} layer ${layer}：无法生成 ${type.toUpperCase()} 路口补片。`);
        }
        junctionBlocks.push(block);
        connections.push(...block.connections);
        patches.push(...block.surfacePatches);
        virtualMouthLines.push(...block.mouthLines);
        laneConnectorPatches.push(...block.laneConnectorPatches);
      }
    }
  }

  return { junctions, junctionBlocks, connections, patches, laneConnectorPatches, virtualMouthLines, warnings };
}
