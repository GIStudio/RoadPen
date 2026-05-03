import type { JunctionType, LaneBand, Point, RoadEdge, RoadPenScene, SceneNode, TurnSpec } from "../types";
import { buildLaneBandsForProfile, distance, sampleOffsetTurnCurve } from "./roadGeometry";

export interface JunctionBranch {
  edgeId: string;
  direction: Point;
  profileId: string;
}

export interface JunctionAnalysis {
  nodeId: string;
  point: Point;
  type: JunctionType;
  degree: number;
  branches: JunctionBranch[];
}

export interface JunctionPatch {
  nodeId: string;
  type: JunctionType;
  bandId: string;
  kind?: "mouth" | "turn" | "center";
  band: LaneBand;
  polygon: Point[];
}

export interface LaneConnectorPatch {
  nodeId: string;
  baseLane: "facility" | "sidewalk" | "clearance";
  fromEdgeId: string;
  toEdgeId: string;
  gapRadians: number;
  fromStopPoint: Point;
  toStopPoint: Point;
  band: LaneBand;
  polygon: Point[];
}

export interface JunctionGeometry {
  junctions: JunctionAnalysis[];
  patches: JunctionPatch[];
  laneConnectorPatches: LaneConnectorPatch[];
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

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function lineIntersection(p: Point, d: Point, q: Point, e: Point): Point | null {
  const den = d.x * e.y - d.y * e.x;
  if (Math.abs(den) <= EPS) {
    return null;
  }
  const t = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / den;
  return add(p, scale(d, t));
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

function convexHull(points: Point[]): Point[] {
  const unique = new Map<string, Point>();
  for (const point of points) {
    if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
      unique.set(pointKey(point), point);
    }
  }

  const sorted = [...unique.values()].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (sorted.length < 3) {
    return [];
  }

  const lower: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= EPS) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= EPS) {
      upper.pop();
    }
    upper.push(point);
  }

  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  if (hull.length < 3) {
    return [];
  }

  hull.push({ ...hull[0] });
  return hull;
}

function patchRadiusForBand(band: LaneBand): number {
  const maxOffset = Math.max(Math.abs(band.qInner), Math.abs(band.qOuter));
  return Math.max(14, maxOffset * 1.05);
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

function buildCarriagewayConnectorPolygon(point: Point, aDir: Point, aBand: LaneBand, bDir: Point, bBand: LaneBand): Point[] {
  const turn = buildVirtualLaneTurn(point, aDir, bDir, aBand, bBand, compactConnectorEll(aDir, bDir, aBand, bBand));
  if (!turn) {
    return [];
  }

  const outerQ = virtualLaneBoundaryQ(aBand.qOuter, bBand.qInner);
  const innerQ = virtualLaneBoundaryQ(aBand.qInner, bBand.qOuter);
  const outerCurve = sampleOffsetTurnCurve(turn, outerQ, JUNCTION_LANE_CURVE_SAMPLES);
  const innerCurve = sampleOffsetTurnCurve(turn, innerQ, JUNCTION_LANE_CURVE_SAMPLES);
  if (outerCurve.length < 4 || innerCurve.length < 4) {
    return [];
  }

  const polygon = [...outerCurve, ...innerCurve.reverse()];
  polygon.push({ ...polygon[0] });
  return polygon;
}

function buildCarriagewayPatchForBand(
  analysis: JunctionAnalysis,
  bandId: string,
  branchBands: Array<{ branch: JunctionBranch; band: LaneBand }>,
): JunctionPatch | null {
  if (analysis.degree < 3 || branchBands.length < 2) {
    return null;
  }

  const referenceBand = branchBands[0].band;
  const points: Point[] = [];

  for (const { branch, band } of branchBands) {
    const normal = leftNormal(branch.direction);
    const radius = patchRadiusForBand(band);
    const capCenter = add(analysis.point, scale(branch.direction, radius));
    points.push(add(capCenter, scale(normal, band.qInner)));
    points.push(add(capCenter, scale(normal, band.qOuter)));
    points.push(add(analysis.point, scale(normal, band.qInner)));
    points.push(add(analysis.point, scale(normal, band.qOuter)));
  }

  const polygon = convexHull(points);
  if (polygon.length < 4) {
    return null;
  }

  return {
    nodeId: analysis.nodeId,
    type: analysis.type,
    bandId,
    band: { ...referenceBand },
    polygon,
  };
}

function buildCarriagewayConnectorPatches(analysis: JunctionAnalysis, branchBands: Array<{ branch: JunctionBranch; band: LaneBand }>): JunctionPatch[] {
  const branches = sortedBranches(branchBands.map((item) => item.branch));
  const bandByEdge = new Map(branchBands.map((item) => [item.branch.edgeId, item.band]));
  const passThrough = passThroughPairs(branches);
  const patches: JunctionPatch[] = [];

  for (let i = 0; i < branches.length; i += 1) {
    const a = branches[i];
    const b = branches[(i + 1) % branches.length];
    if (passThrough.has(branchPairKey(a, b)) || !canBuildCollisionCorner(a, b)) {
      continue;
    }

    const aBand = bandByEdge.get(a.edgeId);
    const bBand = bandByEdge.get(b.edgeId);
    if (!aBand || !bBand) {
      continue;
    }

    const polygon = buildCarriagewayConnectorPolygon(analysis.point, a.direction, aBand, b.direction, bBand);
    if (polygon.length < 4) {
      continue;
    }

    patches.push({
      nodeId: analysis.nodeId,
      type: analysis.type,
      bandId: "carriageway",
      kind: "turn",
      band: { ...aBand },
      polygon,
    });
  }

  return patches;
}

function buildCarriagewayMouthPatches(
  analysis: JunctionAnalysis,
  profileMap: ProfileMap,
  branchBands: Array<{ branch: JunctionBranch; band: LaneBand }>,
): JunctionPatch[] {
  return branchBands.flatMap(({ branch, band }) => {
    const normal = leftNormal(branch.direction);
    const depth = carriagewayJunctionDepthForBranch(profileMap, branch, band);
    const mouthCenter = add(analysis.point, scale(branch.direction, depth));
    const polygon = [
      add(analysis.point, scale(normal, band.qInner)),
      add(mouthCenter, scale(normal, band.qInner)),
      add(mouthCenter, scale(normal, band.qOuter)),
      add(analysis.point, scale(normal, band.qOuter)),
    ];
    polygon.push({ ...polygon[0] });

    return [
      {
        nodeId: analysis.nodeId,
        type: analysis.type,
        bandId: "carriageway",
        kind: "mouth" as const,
        band: { ...band },
        polygon,
      },
    ];
  });
}

function buildCarriagewayCenterEnvelopePatch(
  analysis: JunctionAnalysis,
  profileMap: ProfileMap,
  branchBands: Array<{ branch: JunctionBranch; band: LaneBand }>,
): JunctionPatch | null {
  if (branchBands.length < 3) {
    return null;
  }

  const referenceBand = branchBands[0].band;
  const boundaryPoints = branchBands.flatMap(({ branch, band }) => {
    const normal = leftNormal(branch.direction);
    const depth = carriagewayJunctionDepthForBranch(profileMap, branch, band);
    const mouthCenter = add(analysis.point, scale(branch.direction, depth));
    return [add(mouthCenter, scale(normal, band.qInner)), add(mouthCenter, scale(normal, band.qOuter))];
  });

  const polygon = boundaryPoints
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
    nodeId: analysis.nodeId,
    type: analysis.type,
    bandId: "carriageway",
    kind: "center",
    band: { ...referenceBand },
    polygon,
  };
}

function bandBaseId(id: string): "facility" | "sidewalk" | "clearance" | null {
  if (id.startsWith("facility_")) {
    return "facility";
  }
  if (id.startsWith("sidewalk_")) {
    return "sidewalk";
  }
  if (id.startsWith("clearance_")) {
    return "clearance";
  }
  return null;
}

function branchBand(profileMap: ProfileMap, branch: JunctionBranch, bandId: string): LaneBand | null {
  return buildLaneBandsForProfile(branch.profileId, profileMap).find((band) => band.id === bandId) ?? null;
}

function quadraticPoints(p0: Point, p1: Point, p2: Point, samples = 8): Point[] {
  const out: Point[] = [];
  const steps = Math.max(3, Math.floor(samples));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const mt = 1 - t;
    out.push({
      x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
      y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
    });
  }
  return out;
}

function normalizedAngleDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) {
    delta -= Math.PI * 2;
  }
  while (delta < -Math.PI) {
    delta += Math.PI * 2;
  }
  return delta;
}

function arcAroundCenter(center: Point, start: Point, end: Point, samples = 12): Point[] {
  const r0 = distance(center, start);
  const r1 = distance(center, end);
  if (r0 <= 1e-6 || r1 <= 1e-6) {
    return [];
  }

  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const delta = normalizedAngleDelta(a0, Math.atan2(end.y - center.y, end.x - center.x));
  const steps = Math.max(4, Math.floor(samples));
  const out: Point[] = [];

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const angle = a0 + delta * t;
    const radius = r0 + (r1 - r0) * t;
    out.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  }

  return out;
}

function filletArcAtBoundaryCorner(junctionPoint: Point, corner: Point, start: Point, end: Point, samples = 12): Point[] {
  const toStart = normalize(sub(start, corner));
  const toEnd = normalize(sub(end, corner));
  if (!toStart || !toEnd) {
    return [];
  }

  const dotValue = Math.max(-1, Math.min(1, dot(toStart, toEnd)));
  const theta = Math.acos(dotValue);
  if (theta <= Math.PI / 36 || theta >= Math.PI - Math.PI / 36) {
    return [];
  }

  const startDist = distance(corner, start);
  const endDist = distance(corner, end);
  const tangentDist = Math.max(4, Math.min(startDist, endDist) * 0.72);
  const radius = tangentDist * Math.tan(theta / 2);
  const bisector = normalize(add(toStart, toEnd));
  if (!bisector || radius <= 1e-6) {
    return [];
  }

  const centerDist = radius / Math.sin(theta / 2);
  const awayFromJunction = sub(corner, junctionPoint);
  const orientedBisector = dot(bisector, awayFromJunction) >= 0 ? bisector : scale(bisector, -1);
  const center = add(corner, scale(orientedBisector, centerDist));
  const tangentA = add(corner, scale(toStart, tangentDist));
  const tangentB = add(corner, scale(toEnd, tangentDist));
  return arcAroundCenter(center, tangentA, tangentB, samples);
}

function offsetCornerBoundary(point: Point, aDir: Point, aQ: number, bDir: Point, bQ: number): Point[] {
  const aNormal = leftNormal(aDir);
  const bNormal = leftNormal(bDir);
  const start = add(point, scale(aNormal, aQ));
  const end = add(point, scale(bNormal, bQ));
  const control =
    lineIntersection(start, aDir, end, bDir) ?? {
      x: (start.x + end.x + point.x) / 3,
      y: (start.y + end.y + point.y) / 3,
    };

  if (distance(start, end) <= 1e-6) {
    return [];
  }

  const arc = filletArcAtBoundaryCorner(point, control, start, end, 12);
  return arc.length > 0 ? arc : quadraticPoints(start, control, end, 10);
}

function boundaryPoint(point: Point, direction: Point, q: number): Point {
  return add(point, scale(leftNormal(direction), q));
}

function projectPointToLine(point: Point, linePoint: Point, lineDirection: Point): Point {
  return add(linePoint, scale(lineDirection, dot(sub(point, linePoint), lineDirection)));
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
    warning: undefined,
  };
}

function buildLaneConnectorGeometry(
  point: Point,
  aDir: Point,
  aLeft: LaneBand,
  bDir: Point,
  bRight: LaneBand,
  aReference: LaneBand,
  bReference: LaneBand,
  ellHint: number,
): { polygon: Point[]; fromStopPoint: Point; toStopPoint: Point } | null {
  const turn = buildVirtualLaneTurn(point, aDir, bDir, aReference, bReference, ellHint);
  if (!turn) {
    return null;
  }

  const outerQ = virtualLaneBoundaryQ(aLeft.qOuter, bRight.qInner);
  const innerQ = virtualLaneBoundaryQ(aLeft.qInner, bRight.qOuter);
  const outerCurve = sampleOffsetTurnCurve(turn, outerQ, JUNCTION_LANE_CURVE_SAMPLES);
  const innerCurve = sampleOffsetTurnCurve(turn, innerQ, JUNCTION_LANE_CURVE_SAMPLES);
  if (outerCurve.length < 4 || innerCurve.length < 4) {
    return null;
  }

  const polygon = [...outerCurve, ...innerCurve.reverse()];
  polygon.push({ ...polygon[0] });
  return {
    polygon,
    fromStopPoint: { ...turn.a },
    toStopPoint: { ...turn.b },
  };
}

function carriagewayHalfWidth(profileMap: ProfileMap, a: JunctionBranch, b: JunctionBranch): number {
  const aBand = branchBand(profileMap, a, "carriageway");
  const bBand = branchBand(profileMap, b, "carriageway");
  return Math.max(
    Math.abs(aBand?.qInner ?? 0),
    Math.abs(aBand?.qOuter ?? 0),
    Math.abs(bBand?.qInner ?? 0),
    Math.abs(bBand?.qOuter ?? 0),
  );
}

function laneConnectorStaysOutsideCarriagewayCenter(point: Point, polygon: Point[], profileMap: ProfileMap, a: JunctionBranch, b: JunctionBranch): boolean {
  const minDistance = carriagewayHalfWidth(profileMap, a, b) * 0.95;
  return polygon.every((item) => distance(point, item) >= minDistance);
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

function buildLaneConnectorPatches(analysis: JunctionAnalysis, profileMap: ProfileMap): LaneConnectorPatch[] {
  if (analysis.degree < 3) {
    return [];
  }

  const branches = sortedBranches(analysis.branches);
  const passThrough = passThroughPairs(branches);
  const bases: Array<"facility" | "sidewalk" | "clearance"> = ["facility", "sidewalk", "clearance"];
  const patches: LaneConnectorPatch[] = [];

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
      const connector = buildLaneConnectorGeometry(analysis.point, a.direction, aLeft, b.direction, bRight, aReference, bReference, ellHint);
      if (!connector || connector.polygon.length < 4) {
        continue;
      }

      patches.push({
        nodeId: analysis.nodeId,
        baseLane: base,
        fromEdgeId: a.edgeId,
        toEdgeId: b.edgeId,
        gapRadians,
        fromStopPoint: connector.fromStopPoint,
        toStopPoint: connector.toStopPoint,
        band: {
          ...aLeft,
          id: base,
          name: base,
        },
        polygon: connector.polygon,
      });
    }
  }

  return patches;
}

function buildPatchesForJunction(analysis: JunctionAnalysis, profileMap: ProfileMap): JunctionPatch[] {
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
  for (const [bandId, branchBands] of byBand) {
    if (bandId !== "carriageway") {
      continue;
    }
    patches.push(...buildCarriagewayMouthPatches(analysis, profileMap, branchBands));
    patches.push(...buildCarriagewayConnectorPatches(analysis, branchBands));
    const centerPatch = buildCarriagewayCenterEnvelopePatch(analysis, profileMap, branchBands);
    if (centerPatch) {
      patches.push(centerPatch);
    }
  }

  return patches;
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
  const patches: JunctionPatch[] = [];
  const laneConnectorPatches: LaneConnectorPatch[] = [];

  for (const node of scene.nodes) {
    const edges = edgesByNode.get(node.id) ?? [];
    const branches: JunctionBranch[] = [];

    for (const edge of edges) {
      const direction = edgeDirectionAtNode(edge, node.id, node, nodeMap);
      if (!direction) {
        warnings.push(`路口 ${node.id}：道路 ${edge.id} 在节点附近方向过短，已跳过该分支。`);
        continue;
      }
      branches.push({
        edgeId: edge.id,
        direction,
        profileId: edge.profileId,
      });
    }

    const type = classifyJunction(branches.map((branch) => branch.direction));
    const analysis: JunctionAnalysis = {
      nodeId: node.id,
      point: { x: node.x, y: node.y },
      type,
      degree: branches.length,
      branches,
    };
    junctions.push(analysis);
    warnings.push(...duplicateDirectionWarnings(analysis));

    if (analysis.degree >= 3) {
      const junctionPatches = buildPatchesForJunction(analysis, profileMap);
      if (junctionPatches.length === 0) {
        warnings.push(`路口 ${node.id}：无法生成 ${type.toUpperCase()} 路口补片。`);
      }
      patches.push(...junctionPatches);
      laneConnectorPatches.push(...buildLaneConnectorPatches(analysis, profileMap));
    }
  }

  return { junctions, patches, laneConnectorPatches, warnings };
}
