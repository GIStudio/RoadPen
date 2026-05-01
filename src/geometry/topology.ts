import type { GeometryType, Point, RoadEdge, RoadPenScene, SceneNode } from "../types";

export type SnapTarget =
  | {
      type: "node";
      point: Point;
      distance: number;
      nodeId: string;
    }
  | {
      type: "edge";
      point: Point;
      distance: number;
      edgeId: string;
      segmentIndex: number;
      t: number;
    }
  | {
      type: "free";
      point: Point;
      distance: 0;
    };

export interface DraftAnchor {
  point: Point;
  snap: SnapTarget;
}

export interface TopologyCommitResult {
  fromNodeId: string;
  toNodeId: string;
  createdNodeIds: string[];
  createdEdgeIds: string[];
  splitEdgeIds: string[];
  warnings: string[];
}

export interface SnapOptions {
  nodeRadius?: number;
  edgeRadius?: number;
  excludeEdgeIds?: Set<string>;
}

export interface SplitTarget {
  edgeId: string;
  segmentIndex: number;
  t: number;
  point: Point;
  nodeId: string;
}

interface PathStop {
  segmentIndex: number;
  t: number;
  point: Point;
  nodeId: string;
}

export interface IntersectionHit {
  point: Point;
  pathSegmentIndex: number;
  pathT: number;
  edgeId: string;
  edgeSegmentIndex: number;
  edgeT: number;
}

const EPS = 1e-7;
const NODE_REUSE_RADIUS = 12;

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(point: Point, value: number): Point {
  return { x: point.x * value, y: point.y * value };
}

function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y;
}

function cross(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function segmentLength(a: Point, b: Point): number {
  return distance(a, b);
}

function geometryTypeForControlPoints(points: Point[]): GeometryType {
  return points.length === 2 ? "polyline" : "spline";
}

function pushDistinct(points: Point[], point: Point): void {
  if (!points.length || distance(points[points.length - 1], point) > EPS) {
    points.push(clonePoint(point));
  }
}

function findNodeNear(scene: RoadPenScene, point: Point, radius: number): SceneNode | null {
  let best: { node: SceneNode; dist: number } | null = null;
  for (const node of scene.nodes) {
    const dist = distance(node, point);
    if (dist <= radius && (!best || dist < best.dist)) {
      best = { node, dist };
    }
  }
  return best?.node ?? null;
}

function projectPointToSegment(point: Point, a: Point, b: Point): { point: Point; t: number; distance: number } | null {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 <= EPS) {
    return null;
  }

  const t = Math.max(0, Math.min(1, dot(sub(point, a), ab) / len2));
  const projected = add(a, scale(ab, t));
  return {
    point: projected,
    t,
    distance: distance(point, projected),
  };
}

export function findSnapTarget(scene: RoadPenScene, point: Point, options: SnapOptions = {}): SnapTarget {
  const nodeRadius = options.nodeRadius ?? 12;
  const edgeRadius = options.edgeRadius ?? 16;
  const node = findNodeNear(scene, point, nodeRadius);
  if (node) {
    return {
      type: "node",
      point: { x: node.x, y: node.y },
      distance: distance(point, node),
      nodeId: node.id,
    };
  }

  let bestEdge: Extract<SnapTarget, { type: "edge" }> | null = null;
  for (const edge of scene.edges) {
    if (options.excludeEdgeIds?.has(edge.id)) {
      continue;
    }

    for (let i = 0; i < edge.controlPoints.length - 1; i += 1) {
      const projection = projectPointToSegment(point, edge.controlPoints[i], edge.controlPoints[i + 1]);
      if (!projection || projection.distance > edgeRadius) {
        continue;
      }
      if (projection.t <= EPS || projection.t >= 1 - EPS) {
        continue;
      }
      if (!bestEdge || projection.distance < bestEdge.distance) {
        bestEdge = {
          type: "edge",
          point: projection.point,
          distance: projection.distance,
          edgeId: edge.id,
          segmentIndex: i,
          t: projection.t,
        };
      }
    }
  }

  return bestEdge ?? { type: "free", point: clonePoint(point), distance: 0 };
}

function segmentIntersection(a: Point, b: Point, c: Point, d: Point): { point: Point; t: number; u: number } | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denominator = cross(r, s);
  if (Math.abs(denominator) <= EPS) {
    return null;
  }

  const cma = sub(c, a);
  const t = cross(cma, s) / denominator;
  const u = cross(cma, r) / denominator;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) {
    return null;
  }

  const clampedT = Math.max(0, Math.min(1, t));
  const clampedU = Math.max(0, Math.min(1, u));
  return {
    point: add(a, scale(r, clampedT)),
    t: clampedT,
    u: clampedU,
  };
}

function isPathEndpoint(path: Point[], point: Point): boolean {
  return path.length > 0 && (distance(path[0], point) <= EPS || distance(path[path.length - 1], point) <= EPS);
}

export function findPathRoadIntersections(scene: RoadPenScene, path: Point[], ignorePathEndpoints = true): IntersectionHit[] {
  const hits: IntersectionHit[] = [];
  const seen = new Set<string>();
  if (path.length < 2) {
    return hits;
  }

  for (let pathIndex = 0; pathIndex < path.length - 1; pathIndex += 1) {
    const a = path[pathIndex];
    const b = path[pathIndex + 1];
    if (segmentLength(a, b) <= EPS) {
      continue;
    }

    for (const edge of scene.edges) {
      for (let edgeIndex = 0; edgeIndex < edge.controlPoints.length - 1; edgeIndex += 1) {
        const c = edge.controlPoints[edgeIndex];
        const d = edge.controlPoints[edgeIndex + 1];
        if (segmentLength(c, d) <= EPS) {
          continue;
        }

        const hit = segmentIntersection(a, b, c, d);
        if (!hit) {
          continue;
        }
        if (ignorePathEndpoints && isPathEndpoint(path, hit.point)) {
          continue;
        }

        const key = `${edge.id}:${edgeIndex}:${hit.point.x.toFixed(5)},${hit.point.y.toFixed(5)}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        hits.push({
          point: hit.point,
          pathSegmentIndex: pathIndex,
          pathT: hit.t,
          edgeId: edge.id,
          edgeSegmentIndex: edgeIndex,
          edgeT: hit.u,
        });
      }
    }
  }

  return hits;
}

function getOrCreateNode(scene: RoadPenScene, point: Point, nodeIdFactory: () => string, createdNodeIds: string[], reuseRadius = NODE_REUSE_RADIUS): string {
  const existing = findNodeNear(scene, point, reuseRadius);
  if (existing) {
    return existing.id;
  }

  const id = nodeIdFactory();
  scene.nodes.push({ id, x: point.x, y: point.y });
  createdNodeIds.push(id);
  return id;
}

function pointForNode(scene: RoadPenScene, nodeId: string, fallback: Point): Point {
  const node = scene.nodes.find((item) => item.id === nodeId);
  return node ? { x: node.x, y: node.y } : clonePoint(fallback);
}

function normalizedSplitTargets(edge: RoadEdge, targets: SplitTarget[]): PathStop[] {
  const sorted = [...targets].sort((a, b) => a.segmentIndex + a.t - (b.segmentIndex + b.t));
  const out: PathStop[] = [];
  for (const target of sorted) {
    const isStart = target.segmentIndex === 0 && distance(target.point, edge.controlPoints[0]) <= EPS;
    const isEnd =
      target.segmentIndex === edge.controlPoints.length - 2 &&
      distance(target.point, edge.controlPoints[edge.controlPoints.length - 1]) <= EPS;
    if (isStart || isEnd) {
      continue;
    }
    if (out.some((item) => item.nodeId === target.nodeId || distance(item.point, target.point) <= EPS)) {
      continue;
    }
    out.push({
      segmentIndex: target.segmentIndex,
      t: target.t,
      point: clonePoint(target.point),
      nodeId: target.nodeId,
    });
  }
  return out;
}

function splitPathIntoPieces(path: Point[], startNodeId: string, endNodeId: string, stops: PathStop[]): Array<{ from: string; to: string; points: Point[] }> {
  const sortedStops = [...stops].sort((a, b) => a.segmentIndex + a.t - (b.segmentIndex + b.t));
  const pieces: Array<{ from: string; to: string; points: Point[] }> = [];
  let from = startNodeId;
  let currentPoint = path[0];
  let nextVertexIndex = 1;

  for (const stop of sortedStops) {
    if (distance(currentPoint, stop.point) <= EPS || from === stop.nodeId) {
      nextVertexIndex = Math.max(nextVertexIndex, stop.segmentIndex + 1);
      continue;
    }

    const points: Point[] = [clonePoint(currentPoint)];
    for (let i = nextVertexIndex; i <= stop.segmentIndex; i += 1) {
      pushDistinct(points, path[i]);
    }
    pushDistinct(points, stop.point);
    if (points.length >= 2) {
      pieces.push({ from, to: stop.nodeId, points });
    }

    from = stop.nodeId;
    currentPoint = stop.point;
    nextVertexIndex = stop.segmentIndex + 1;
  }

  if (from !== endNodeId && distance(currentPoint, path[path.length - 1]) > EPS) {
    const points: Point[] = [clonePoint(currentPoint)];
    for (let i = nextVertexIndex; i < path.length; i += 1) {
      pushDistinct(points, path[i]);
    }
    if (points.length >= 2) {
      pieces.push({ from, to: endNodeId, points });
    }
  }

  return pieces;
}

export function splitEdgesAtTargets(scene: RoadPenScene, targets: SplitTarget[], edgeIdFactory: () => string): string[] {
  const splitEdgeIds: string[] = [];
  const byEdge = new Map<string, SplitTarget[]>();
  for (const target of targets) {
    byEdge.set(target.edgeId, [...(byEdge.get(target.edgeId) ?? []), target]);
  }

  for (const [edgeId, edgeTargets] of byEdge) {
    const edgeIndex = scene.edges.findIndex((edge) => edge.id === edgeId);
    if (edgeIndex < 0) {
      continue;
    }

    const edge = scene.edges[edgeIndex];
    const stops = normalizedSplitTargets(edge, edgeTargets);
    if (stops.length === 0) {
      continue;
    }

    const pieces = splitPathIntoPieces(edge.controlPoints, edge.from, edge.to, stops);
    if (pieces.length < 2) {
      continue;
    }

    edge.from = pieces[0].from;
    edge.to = pieces[0].to;
    edge.controlPoints = pieces[0].points;
    edge.geomType = geometryTypeForControlPoints(edge.controlPoints);
    splitEdgeIds.push(edge.id);

    const newEdges = pieces.slice(1).map((piece) => ({
      id: edgeIdFactory(),
      from: piece.from,
      to: piece.to,
      geomType: geometryTypeForControlPoints(piece.points),
      profileId: edge.profileId,
      controlPoints: piece.points,
    }));
    splitEdgeIds.push(...newEdges.map((newEdge) => newEdge.id));
    scene.edges.splice(edgeIndex + 1, 0, ...newEdges);
  }

  return splitEdgeIds;
}

function endpointNodeForAnchor(
  scene: RoadPenScene,
  anchor: DraftAnchor,
  nodeIdFactory: () => string,
  createdNodeIds: string[],
  splitTargets: SplitTarget[],
): string {
  if (anchor.snap.type === "node") {
    return anchor.snap.nodeId;
  }

  if (anchor.snap.type === "edge") {
    const nodeId = getOrCreateNode(scene, anchor.snap.point, nodeIdFactory, createdNodeIds);
    const point = pointForNode(scene, nodeId, anchor.snap.point);
    splitTargets.push({
      edgeId: anchor.snap.edgeId,
      segmentIndex: anchor.snap.segmentIndex,
      t: anchor.snap.t,
      point,
      nodeId,
    });
    return nodeId;
  }

  return getOrCreateNode(scene, anchor.point, nodeIdFactory, createdNodeIds);
}

export function commitRoadWithTopology(
  scene: RoadPenScene,
  anchors: DraftAnchor[],
  profileId: string,
  nodeIdFactory: () => string,
  edgeIdFactory: () => string,
): TopologyCommitResult | null {
  if (anchors.length < 2) {
    return null;
  }

  const warnings: string[] = [];
  const createdNodeIds: string[] = [];
  const createdEdgeIds: string[] = [];
  const splitTargets: SplitTarget[] = [];

  const fromNodeId = endpointNodeForAnchor(scene, anchors[0], nodeIdFactory, createdNodeIds, splitTargets);
  const toNodeId = endpointNodeForAnchor(scene, anchors[anchors.length - 1], nodeIdFactory, createdNodeIds, splitTargets);
  if (fromNodeId === toNodeId) {
    warnings.push("起点和终点吸附到了同一个节点，已跳过道路创建。");
    return {
      fromNodeId,
      toNodeId,
      createdNodeIds,
      createdEdgeIds,
      splitEdgeIds: [],
      warnings,
    };
  }

  const fromNode = scene.nodes.find((node) => node.id === fromNodeId);
  const toNode = scene.nodes.find((node) => node.id === toNodeId);
  if (!fromNode || !toNode) {
    return null;
  }

  const path = anchors.map((anchor) => clonePoint(anchor.point));
  path[0] = { x: fromNode.x, y: fromNode.y };
  path[path.length - 1] = { x: toNode.x, y: toNode.y };

  const newPathStops: PathStop[] = [];
  const intersections = findPathRoadIntersections(scene, path, true);
  for (const hit of intersections) {
    const nodeId = getOrCreateNode(scene, hit.point, nodeIdFactory, createdNodeIds);
    const point = pointForNode(scene, nodeId, hit.point);
    if (nodeId === fromNodeId || nodeId === toNodeId) {
      continue;
    }

    splitTargets.push({
      edgeId: hit.edgeId,
      segmentIndex: hit.edgeSegmentIndex,
      t: hit.edgeT,
      point,
      nodeId,
    });
    newPathStops.push({
      segmentIndex: hit.pathSegmentIndex,
      t: hit.pathT,
      point,
      nodeId,
    });
  }

  const splitEdgeIds = splitEdgesAtTargets(scene, splitTargets, edgeIdFactory);
  const pieces = splitPathIntoPieces(path, fromNodeId, toNodeId, newPathStops);
  for (const piece of pieces) {
    if (piece.from === piece.to || piece.points.length < 2) {
      continue;
    }
    const edge: RoadEdge = {
      id: edgeIdFactory(),
      from: piece.from,
      to: piece.to,
      geomType: geometryTypeForControlPoints(piece.points),
      profileId,
      controlPoints: piece.points,
    };
    scene.edges.push(edge);
    createdEdgeIds.push(edge.id);
  }

  if (splitEdgeIds.length > 0) {
    warnings.push(`已自动拆分 ${splitEdgeIds.length} 段道路并生成共享路口节点。`);
  }

  return {
    fromNodeId,
    toNodeId,
    createdNodeIds,
    createdEdgeIds,
    splitEdgeIds,
    warnings,
  };
}
