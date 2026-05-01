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

export interface JunctionGeometry {
  junctions: JunctionAnalysis[];
  patches: JunctionPatch[];
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

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
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

function buildPatchForBand(analysis: JunctionAnalysis, bandId: string, branchBands: Array<{ branch: JunctionBranch; band: LaneBand }>): JunctionPatch | null {
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
    const patch = buildPatchForBand(analysis, bandId, branchBands);
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
    }
  }

  return { junctions, patches, warnings };
}
