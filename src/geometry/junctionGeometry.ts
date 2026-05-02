import type { JunctionType, LaneBand, Point, RoadEdge, RoadPenScene, SceneNode } from "../types";
import { buildLaneBandsForProfile, distance } from "./roadGeometry";

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
  band: LaneBand;
  polygon: Point[];
}

export interface LaneConnectorPatch {
  nodeId: string;
  baseLane: "facility" | "sidewalk" | "clearance";
  fromEdgeId: string;
  toEdgeId: string;
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

function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(point: Point, value: number): Point {
  return { x: point.x * value, y: point.y * value };
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
  return Math.max(18, maxOffset * 1.45);
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

function buildLaneConnectorPolygon(point: Point, aDir: Point, aLeft: LaneBand, bDir: Point, bRight: LaneBand): Point[] {
  const aNormal = leftNormal(aDir);
  const bNormal = leftNormal(bDir);
  const polygon = [
    add(point, scale(aNormal, aLeft.qInner)),
    add(point, scale(bNormal, bRight.qOuter)),
    add(point, scale(bNormal, bRight.qInner)),
    add(point, scale(aNormal, aLeft.qOuter)),
  ];
  const first = polygon[0];
  const last = polygon[polygon.length - 1];
  if (Math.abs(first.x - last.x) > 1e-6 || Math.abs(first.y - last.y) > 1e-6) {
    polygon.push({ ...first });
  }
  return polygon;
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
  if (gap <= Math.PI / 36 || gap >= Math.PI * 0.75) {
    return false;
  }

  const gapDot = branchGapDot(a, b);
  return gapDot > -0.707 && gapDot < 0.985;
}

function buildLaneConnectorPatches(analysis: JunctionAnalysis, profileMap: ProfileMap): LaneConnectorPatch[] {
  if (analysis.degree < 3) {
    return [];
  }

  const branches = sortedBranches(analysis.branches);
  const bases: Array<"facility" | "sidewalk" | "clearance"> = ["facility", "sidewalk", "clearance"];
  const patches: LaneConnectorPatch[] = [];

  for (const base of bases) {
    for (let i = 0; i < branches.length; i += 1) {
      const a = branches[i];
      const b = branches[(i + 1) % branches.length];
      const aLeft = branchBand(profileMap, a, `${base}_left`);
      const bRight = branchBand(profileMap, b, `${base}_right`);
      if (!aLeft || !bRight) {
        continue;
      }

      if (Math.abs(aLeft.qOuter - aLeft.qInner) <= 1e-6 || Math.abs(bRight.qOuter - bRight.qInner) <= 1e-6) {
        continue;
      }

      if (!canBuildCollisionCorner(a, b)) {
        continue;
      }

      const polygon = buildLaneConnectorPolygon(analysis.point, a.direction, aLeft, b.direction, bRight);
      if (polygon.length < 4) {
        continue;
      }

      patches.push({
        nodeId: analysis.nodeId,
        baseLane: base,
        fromEdgeId: a.edgeId,
        toEdgeId: b.edgeId,
        band: {
          ...aLeft,
          id: base,
          name: base,
        },
        polygon,
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
    const patch = buildCarriagewayPatchForBand(analysis, bandId, branchBands);
    if (patch) {
      patches.push(patch);
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
