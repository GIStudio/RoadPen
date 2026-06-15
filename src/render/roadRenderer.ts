import { GEOMETRY_ISSUE_TYPES, type DebugSettings, type GeometryIssueMarker, type GeometryIssueReport, type GeometryIssueType, type JunctionType, type LaneBand, type Point, type RoadEdge, type RoadPenScene, type SceneNode, type TurnSpec } from "../types";
import type { CarriagewayVirtualMouthLine, JunctionAnalysis, JunctionBlock, JunctionPatch, LaneConnectorPatch } from "../geometry/junctionGeometry";
import { buildJunctionGeometry } from "../geometry/junctionGeometry";
import type { SnapTarget } from "../geometry/topology";
import {
  buildBandPolygon,
  buildSkeletonPathByPoints,
  buildSmoothBandPolygon,
  buildLaneBandsForProfile,
  computeTurnSpecs,
  distance,
  profileToBands,
} from "../geometry/roadGeometry";
import { mergeRoadJunction, multiPolygonToRings } from "../geometry/roadMerge";

interface RenderContext {
  width: number;
  height: number;
  backgroundColor?: string;
  draftPoints?: Point[];
  snapPreview?: SnapTarget | null;
  intersectionPreview?: Point[];
  debug?: DebugSettings;
  selectedEdgeId?: string | null;
  selectedJunctionBlockId?: string | null;
  isolatedJunctionBlockId?: string | null;
}

export interface BandBucket {
  roadLayer: number;
  semanticBandId: string;
  band: LaneBand;
  polygons: Point[][];
}

export interface RoadLayerFootprint {
  roadLayer: number;
  polygons: Point[][];
}

export interface OuterLaneBridgePatch {
  chainId: string;
  layer: number;
  bandId: string;
  semanticBandId: string;
  baseLane: string;
  fromNodeId: string;
  toNodeId: string;
  fromJunctionBlockId?: string;
  toJunctionBlockId?: string;
  reason: "short-gap" | "overlap" | "sharp-turn";
  polygon: Point[];
  point: Point;
}

export interface ExtremeTurnFallbackPatch {
  chainId: string;
  layer: number;
  bandId: string;
  semanticBandId: string;
  edgeIds: string[];
  turnIndex: number;
  radius: number;
  deltaDeg: number;
  polygon: Point[];
  point: Point;
}

export interface LocalZOrderSliceBand {
  semanticBandId: string;
  band: LaneBand;
  polygon: Point[];
}

export interface LocalZOrderSlice {
  chainId: string;
  layer: number;
  edgeIds: string[];
  sliceIndex: number;
  reason: "self-overlap";
  point: Point;
  footprint: Point[][];
  bands: LocalZOrderSliceBand[];
}

export interface RoadBandData {
  bandBuckets: Map<string, BandBucket>;
  roadFootprints: RoadLayerFootprint[];
  geometryIssues: GeometryIssueReport;
  junctions: JunctionAnalysis[];
  junctionBlocks: JunctionBlock[];
  junctionPatches: JunctionPatch[];
  laneConnectorPatches: LaneConnectorPatch[];
  virtualMouthLines: CarriagewayVirtualMouthLine[];
  laneStops: Array<{
    chainId: string;
    junctionBlockId?: string;
    nodeId: string;
    layer: number;
    bandId: string;
    kind: "node" | "connector";
    point: Point;
    distance: number;
  }>;
  outerLaneBridges: OuterLaneBridgePatch[];
  extremeTurnFallbacks: ExtremeTurnFallbackPatch[];
  localZOrderSlices: LocalZOrderSlice[];
  edgeCenterlines: Array<{
    id: string;
    layer: number;
    edgeIds: string[];
    geomType: string;
    rawPoints: Point[];
    sourcePoints: Point[];
    renderPoints: Point[];
    turns: Array<{
      idx: number;
      point: Point;
      radius: number;
      ell: number;
      deltaDeg: number;
    }>;
  }>;
  warnings: string[];
}

export type RoadSegmentGeometry = RoadBandData["edgeCenterlines"][number];

export interface RoadNetworkGeometry {
  roadSegments: RoadSegmentGeometry[];
  junctionBlocks: JunctionBlock[];
  warnings: string[];
}

const EPS = 1e-9;
const ROAD_BACKGROUND_COLOR = "#0a1024";
const JUNCTION_EDGE_TRIM_MIN = 18;
const JUNCTION_EDGE_TRIM_FACTOR = 1.45;
const JUNCTION_MOUTH_OVERLAP = 0.75;
const JUNCTION_CONTROL_POINT_SPACING = 10;
const SHORT_EDGE_STUB_LENGTH = 42;
const SHARP_CORNER_DELTA_DEG = 115;
const JUNCTION_STYLE: Record<
  JunctionType,
  { text: string; fill: string; fillText: string; stroke: string; border: string }
> = {
  line: {
    text: "LINE",
    fill: "rgba(37, 99, 235, 0.85)",
    fillText: "#e2e8f0",
    stroke: "rgba(147, 197, 253, 0.95)",
    border: "#93c5fd",
  },
  curve: {
    text: "CURVE",
    fill: "rgba(34, 197, 94, 0.85)",
    fillText: "#ecfeff",
    stroke: "rgba(167, 243, 208, 0.9)",
    border: "#6ee7b7",
  },
  t: {
    text: "T",
    fill: "rgba(217, 70, 239, 0.85)",
    fillText: "#f8fafc",
    stroke: "rgba(249, 168, 212, 0.9)",
    border: "#f9a8d4",
  },
  cross: {
    text: "X",
    fill: "rgba(234, 88, 12, 0.85)",
    fillText: "#fff7ed",
    stroke: "rgba(254, 215, 170, 0.9)",
    border: "#fdba74",
  },
};

const GEOMETRY_ISSUE_STYLE: Record<GeometryIssueType, { color: string; label: string }> = {
  crossLayerOverlap: { color: "#38bdf8", label: "XL" },
  sameLayerUnsplitCrossing: { color: "#fb923c", label: "SX" },
  shortEdgeStub: { color: "#f43f5e", label: "ST" },
  junctionSurfaceGapCandidate: { color: "#facc15", label: "JG" },
  sharpCornerGapCandidate: { color: "#a78bfa", label: "SC" },
  outerLaneCoverageGap: { color: "#34d399", label: "LG" },
  extremeTurnFallback: { color: "#fb7185", label: "TF" },
  selfOverlapCandidate: { color: "#60a5fa", label: "SO" },
  localZOrderApplied: { color: "#22d3ee", label: "LZ" },
};

type ProfileMap = Map<string, { carriagewayWidth: number; facilityWidth: number; sidewalkWidth: number; clearanceWidth: number }>;

function indexNodes(scene: RoadPenScene): Map<string, SceneNode> {
  const map = new Map<string, SceneNode>();
  for (const node of scene.nodes) {
    map.set(node.id, node);
  }
  return map;
}

function nodeDegreeMap(scene: RoadPenScene, layer?: number): Map<string, number> {
  const map = new Map<string, number>();
  for (const edge of scene.edges) {
    if (layer !== undefined && roadLayer(edge) !== layer) {
      continue;
    }
    map.set(edge.from, (map.get(edge.from) ?? 0) + 1);
    map.set(edge.to, (map.get(edge.to) ?? 0) + 1);
  }
  return map;
}

function roadLayer(edge: RoadEdgeLike): number {
  return typeof edge.layer === "number" && Number.isFinite(edge.layer) ? Math.trunc(edge.layer) : 0;
}

function layerNodeKey(layer: number, nodeId: string): string {
  return `${layer}:${nodeId}`;
}

function profileMapFromScene(scene: RoadPenScene): ProfileMap {
  const profileMap: ProfileMap = new Map();
  for (const profile of scene.profiles) {
    profileMap.set(profile.id, {
      carriagewayWidth: profile.carriagewayWidth,
      facilityWidth: profile.facilityWidth,
      sidewalkWidth: profile.sidewalkWidth,
      clearanceWidth: profile.clearanceWidth,
    });
  }
  return profileMap;
}

function maxProfileOffsetForEdge(edge: RoadEdge, profileMap: ProfileMap): number {
  const bands = buildLaneBandsForProfile(edge.profileId, profileMap);
  return Math.max(0, ...bands.map((band) => Math.max(Math.abs(band.qInner), Math.abs(band.qOuter))));
}

function addPoint(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subPoint(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scalePoint(point: Point, value: number): Point {
  return { x: point.x * value, y: point.y * value };
}

function movePointToward(point: Point, target: Point, amount: number): Point {
  const vector = subPoint(target, point);
  const len = Math.hypot(vector.x, vector.y);
  if (len <= EPS || amount <= 0) {
    return { ...point };
  }
  const step = Math.min(amount, len * 0.45);
  return addPoint(point, scalePoint(vector, step / len));
}

function unitPoint(point: Point): Point | null {
  const len = Math.hypot(point.x, point.y);
  return len > EPS ? { x: point.x / len, y: point.y / len } : null;
}

function leftNormal(point: Point): Point {
  return { x: -point.y, y: point.x };
}

function semicirclePoint(center: Point, outward: Point, radius: number, t: number): Point {
  const normal = leftNormal(outward);
  const angle = -Math.PI / 2 + Math.PI * t;
  return addPoint(center, addPoint(scalePoint(outward, Math.cos(angle) * radius), scalePoint(normal, Math.sin(angle) * radius)));
}

function deadEndDisk(center: Point, outward: Point, radius: number, samples = 18): Point[] {
  const points: Point[] = [];
  for (let i = 0; i <= samples; i += 1) {
    points.push(semicirclePoint(center, outward, radius, i / samples));
  }
  points.push({ ...center });
  points.push({ ...points[0] });
  return points;
}

function deadEndRing(center: Point, outward: Point, innerRadius: number, outerRadius: number, samples = 18): Point[] {
  if (outerRadius <= innerRadius + 1e-6) {
    return [];
  }

  const points: Point[] = [];
  for (let i = 0; i <= samples; i += 1) {
    points.push(semicirclePoint(center, outward, outerRadius, i / samples));
  }
  for (let i = samples; i >= 0; i -= 1) {
    points.push(semicirclePoint(center, outward, innerRadius, i / samples));
  }
  points.push({ ...points[0] });
  return points;
}

function endpointOutward(edge: RoadEdgeLike, atFrom: boolean): Point | null {
  const points = edge.controlPoints;
  if (points.length < 2) {
    return null;
  }
  const start = atFrom ? points[0] : points[points.length - 1];
  const next = atFrom ? points[1] : points[points.length - 2];
  return unitPoint(subPoint(start, next));
}

type RoadEdgeLike = RoadPenScene["edges"][number];
type BranchSide = "left" | "right";
type LaneBase = "facility" | "sidewalk" | "clearance";
type EndpointKey = string;

interface VisualChain {
  id: string;
  layer: number;
  profileId: string;
  edgeIds: string[];
  nodeIds: string[];
  points: Point[];
  geomType: string;
}

interface ContinuationPair {
  nodeId: string;
  layer: number;
  aEdgeId: string;
  bEdgeId: string;
}

interface ChainBranch {
  edge: RoadEdgeLike;
  nodeId: string;
  layer: number;
  direction: Point;
  profileId: string;
}

const PASS_THROUGH_DOT = -0.82;
const LANE_STOP_MIN_SPAN = 8;

interface LaneStopCandidate {
  junctionBlockId: string | undefined;
  nodeId: string;
  point: Point;
  kind: "node" | "connector";
}

interface ProjectedLaneStop {
  junctionBlockId: string | undefined;
  nodeId: string;
  point: Point;
  distanceAlong: number;
  stopDistance: number;
  kind: "node" | "connector";
}

interface LaneStopInterval {
  junctionBlockId: string | undefined;
  nodeId: string;
  start: number;
  end: number;
  hasConnectorStops: boolean;
}

interface LaneBridgeSpan {
  fromJunctionBlockId: string | undefined;
  toJunctionBlockId: string | undefined;
  fromNodeId: string;
  toNodeId: string;
  start: number;
  end: number;
  reason: "short-gap" | "overlap";
}

interface DistanceInterval {
  start: number;
  end: number;
}

interface ConnectorStopEntry {
  junctionBlockId: string;
  edgeId: string;
  point: Point;
  baseLane: LaneBase;
  side: BranchSide;
}

interface JunctionMouthEntry {
  junctionBlockId: string;
  edgeId: string;
  point: Point;
}

function laneBaseForBand(band: LaneBand): LaneBase | null {
  if (band.id.startsWith("facility")) {
    return "facility";
  }
  if (band.id.startsWith("sidewalk")) {
    return "sidewalk";
  }
  if (band.id.startsWith("clearance")) {
    return "clearance";
  }
  return null;
}

function trimKey(edgeId: string, nodeId: string, side: BranchSide, base: LaneBase): string {
  return `${edgeId}:${nodeId}:${side}:${base}`;
}

function laneConnectorTrimMap(patches: LaneConnectorPatch[]): Set<string> {
  const map = new Set<string>();
  for (const patch of patches) {
    map.add(trimKey(patch.fromEdgeId, patch.nodeId, "left", patch.baseLane));
    map.add(trimKey(patch.toEdgeId, patch.nodeId, "right", patch.baseLane));
  }
  return map;
}

function bandSideAtEndpoint(edge: RoadEdgeLike, nodeId: string, band: LaneBand): BranchSide | null {
  const isLeftBand = band.id.endsWith("_left");
  const isRightBand = band.id.endsWith("_right");
  if (!isLeftBand && !isRightBand) {
    return null;
  }

  const edgeSide: BranchSide = isLeftBand ? "left" : "right";
  if (nodeId === edge.from) {
    return edgeSide;
  }
  if (nodeId === edge.to) {
    return edgeSide === "left" ? "right" : "left";
  }
  return null;
}

function chainBandSideAtNode(chain: VisualChain, nodeId: string, edgeId: string, band: LaneBand): BranchSide | null {
  const isLeftBand = band.id.endsWith("_left");
  const isRightBand = band.id.endsWith("_right");
  if (!isLeftBand && !isRightBand) {
    return null;
  }

  const index = chain.edgeIds.indexOf(edgeId);
  if (index < 0) {
    return null;
  }

  const chainSide: BranchSide = isLeftBand ? "left" : "right";
  if (chain.nodeIds[index] === nodeId) {
    return chainSide;
  }
  if (chain.nodeIds[index + 1] === nodeId) {
    return chainSide === "left" ? "right" : "left";
  }
  return null;
}

function shouldTrimBandEndpoint(edge: RoadEdgeLike, nodeId: string, band: LaneBand, trimMap: Set<string>): boolean {
  const branchSide = bandSideAtEndpoint(edge, nodeId, band);
  const base = laneBaseForBand(band);
  return branchSide && base ? trimMap.has(trimKey(edge.id, nodeId, branchSide, base)) : false;
}

function trimPolylineEndpoint(points: Point[], atStart: boolean, distancePx: number): Point[] {
  if (points.length < 2 || distancePx <= EPS) {
    return points;
  }

  const out = points.map((point) => ({ ...point }));
  const index = atStart ? 0 : out.length - 1;
  const neighborIndex = atStart ? 1 : out.length - 2;
  const endpoint = out[index];
  const neighbor = out[neighborIndex];
  const vector = subPoint(neighbor, endpoint);
  const length = Math.hypot(vector.x, vector.y);
  if (length <= EPS) {
    return out;
  }

  const inset = Math.min(distancePx, length * 0.45);
  out[index] = addPoint(endpoint, scalePoint(vector, inset / length));
  return out;
}

function trimPolylineForJunctions(points: Point[], trimStart: boolean, trimEnd: boolean, distancePx: number): Point[] {
  let out = points.map((point) => ({ ...point }));
  if (trimStart) {
    out = trimPolylineEndpoint(out, true, distancePx);
  }
  if (trimEnd) {
    out = trimPolylineEndpoint(out, false, distancePx);
  }
  return out;
}

function capBucketId(base: string, edgeId: string, nodeId: string): string {
  return `${base}_endcap_${edgeId}_${nodeId}`;
}

function semanticBandForBucket(band: LaneBand): LaneBand {
  if (band.id.startsWith("facility")) {
    return { ...band, id: "facility", name: "facility" };
  }
  if (band.id.startsWith("sidewalk")) {
    return { ...band, id: "sidewalk", name: "sidewalk" };
  }
  if (band.id.startsWith("clearance")) {
    return { ...band, id: "clearance", name: "clearance" };
  }
  return { ...band };
}

export function bandBucketKey(roadLayerValue: number, semanticBandId: string): string {
  return `layer:${roadLayerValue}:${semanticBandId}`;
}

function addBandPolygon(bandBuckets: Map<string, BandBucket>, band: LaneBand, polygon: Point[], roadLayerValue = 0): void {
  if (polygon.length < 4) {
    return;
  }
  const normalizedLayer = Math.trunc(roadLayerValue);
  const bucketBand = semanticBandForBucket(band);
  const key = bandBucketKey(normalizedLayer, bucketBand.id);
  const bucket = bandBuckets.get(key) ?? {
    roadLayer: normalizedLayer,
    semanticBandId: bucketBand.id,
    band: bucketBand,
    polygons: [],
  };
  bandBuckets.set(key, bucket);
  bucket.polygons.push(polygon);
}

function validPolygon(points: Point[]): boolean {
  return points.length >= 4 && Math.abs(polygonArea(points)) > 1e-4;
}

function offsetPoint(point: Point, direction: Point, q: number): Point {
  return addPoint(point, scalePoint(leftNormal(direction), q));
}

function closePolygon(points: Point[]): Point[] {
  if (points.length === 0) {
    return [];
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (Math.abs(first.x - last.x) <= 1e-6 && Math.abs(first.y - last.y) <= 1e-6) {
    return points;
  }
  return [...points, { ...first }];
}

function sampleExtremeTurnCenterline(turn: TurnSpec, samples = 18): Point[] {
  const sampleCount = Math.max(6, Math.floor(samples));
  const handle = (4 / 3) * turn.radius * Math.tan(turn.delta / 4);
  const c1 = addPoint(turn.a, scalePoint(turn.u, handle));
  const c2 = addPoint(turn.b, scalePoint(turn.v, -handle));
  const points: Point[] = [];
  for (let i = 0; i <= sampleCount; i += 1) {
    const t = i / sampleCount;
    const mt = 1 - t;
    points.push({
      x: mt * mt * mt * turn.a.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * turn.b.x,
      y: mt * mt * mt * turn.a.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * turn.b.y,
    });
  }
  return points;
}

function buildExtremeTurnFallbackPolygons(center: Point, turn: TurnSpec, band: LaneBand): Point[][] {
  const minQ = Math.min(band.qInner, band.qOuter);
  const maxQ = Math.max(band.qInner, band.qOuter);
  const deltaDeg = (turn.delta * 180) / Math.PI;
  if (deltaDeg < 150) {
    return [closePolygon([
      offsetPoint(turn.a, turn.u, maxQ),
      offsetPoint(center, turn.u, maxQ),
      offsetPoint(center, turn.v, maxQ),
      offsetPoint(turn.b, turn.v, maxQ),
      offsetPoint(turn.b, turn.v, minQ),
      offsetPoint(center, turn.v, minQ),
      offsetPoint(center, turn.u, minQ),
      offsetPoint(turn.a, turn.u, minQ),
    ])];
  }

  const turnCenterline = sampleExtremeTurnCenterline(turn, 32);
  const sweptPolygon = buildSmoothBandPolygon(turnCenterline, band.qInner, band.qOuter);
  if (validPolygon(sweptPolygon)) {
    return [sweptPolygon];
  }

  return [closePolygon([
    offsetPoint(turn.a, turn.u, maxQ),
    offsetPoint(turn.b, turn.v, maxQ),
    offsetPoint(turn.b, turn.v, minQ),
    offsetPoint(turn.a, turn.u, minQ),
  ])];
}

function turnNeedsLocalFallback(turn: TurnSpec, band: LaneBand): boolean {
  const bandMaxOffset = Math.max(Math.abs(band.qInner), Math.abs(band.qOuter));
  return Boolean(turn.warning) || turn.radius <= bandMaxOffset + 1 || turn.ell <= bandMaxOffset * 0.75;
}

export function buildRoadLayerFootprints(bandBuckets: Map<string, BandBucket>): RoadLayerFootprint[] {
  const byLayer = new Map<number, Point[][]>();
  for (const bucket of bandBuckets.values()) {
    const polygons = byLayer.get(bucket.roadLayer) ?? [];
    polygons.push(...bucket.polygons.map((polygon) => polygon.map((point) => ({ ...point }))));
    byLayer.set(bucket.roadLayer, polygons);
  }
  return [...byLayer.entries()]
    .map(([roadLayerValue, polygons]) => ({ roadLayer: roadLayerValue, polygons }))
    .sort((a, b) => a.roadLayer - b.roadLayer);
}

function isOuterLaneBand(band: LaneBand): boolean {
  return band.id.startsWith("facility_") || band.id.startsWith("sidewalk_") || band.id.startsWith("clearance_");
}

function polylineCumulativeLengths(points: Point[]): number[] {
  const lengths = [0];
  for (let i = 1; i < points.length; i += 1) {
    lengths.push(lengths[i - 1] + distance(points[i - 1], points[i]));
  }
  return lengths;
}

function pointOnPolylineAt(points: Point[], cumulative: number[], target: number): Point {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }
  if (target <= 0) {
    return { ...points[0] };
  }
  const total = cumulative[cumulative.length - 1] ?? 0;
  if (target >= total) {
    return { ...points[points.length - 1] };
  }

  for (let i = 1; i < points.length; i += 1) {
    if (cumulative[i] < target) {
      continue;
    }
    const startDistance = cumulative[i - 1];
    const segmentLength = cumulative[i] - startDistance;
    const t = segmentLength <= EPS ? 0 : (target - startDistance) / segmentLength;
    return {
      x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
      y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
    };
  }

  return { ...points[points.length - 1] };
}

function slicePolylineByDistance(points: Point[], start: number, end: number, minSpan = LANE_STOP_MIN_SPAN): Point[] {
  if (points.length < 2 || end - start <= EPS) {
    return [];
  }

  const cumulative = polylineCumulativeLengths(points);
  const total = cumulative[cumulative.length - 1] ?? 0;
  const from = Math.max(0, Math.min(start, total));
  const to = Math.max(0, Math.min(end, total));
  if (to - from <= minSpan) {
    return [];
  }

  const out: Point[] = [pointOnPolylineAt(points, cumulative, from)];
  for (let i = 1; i < points.length - 1; i += 1) {
    if (cumulative[i] > from + EPS && cumulative[i] < to - EPS) {
      out.push({ ...points[i] });
    }
  }
  out.push(pointOnPolylineAt(points, cumulative, to));
  return out;
}

function projectPointToPolylineDistance(points: Point[], point: Point): { distanceAlong: number; point: Point; distanceToPath: number } | null {
  if (points.length < 2) {
    return null;
  }

  const cumulative = polylineCumulativeLengths(points);
  let best: { distanceAlong: number; point: Point; distanceToPath: number } | null = null;

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const ab = subPoint(b, a);
    const lenSq = ab.x * ab.x + ab.y * ab.y;
    if (lenSq <= EPS) {
      continue;
    }
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * ab.x + (point.y - a.y) * ab.y) / lenSq));
    const projected = { x: a.x + ab.x * t, y: a.y + ab.y * t };
    const d = distance(point, projected);
    const along = cumulative[i] + Math.sqrt(lenSq) * t;
    if (!best || d < best.distanceToPath) {
      best = { distanceAlong: along, point: projected, distanceToPath: d };
    }
  }

  return best;
}

function projectPointToPolylineDistanceNear(
  points: Point[],
  cumulative: number[],
  point: Point,
  anchorDistance: number,
  windowDistance: number,
): { distanceAlong: number; point: Point; distanceToPath: number } | null {
  if (points.length < 2) {
    return null;
  }

  const from = anchorDistance - windowDistance;
  const to = anchorDistance + windowDistance;
  let best: { distanceAlong: number; point: Point; distanceToPath: number } | null = null;

  for (let i = 0; i < points.length - 1; i += 1) {
    const segmentStart = cumulative[i];
    const segmentEnd = cumulative[i + 1];
    if (segmentEnd < from - EPS || segmentStart > to + EPS) {
      continue;
    }

    const a = points[i];
    const b = points[i + 1];
    const ab = subPoint(b, a);
    const lenSq = ab.x * ab.x + ab.y * ab.y;
    if (lenSq <= EPS) {
      continue;
    }

    const t = Math.max(0, Math.min(1, ((point.x - a.x) * ab.x + (point.y - a.y) * ab.y) / lenSq));
    const along = segmentStart + Math.sqrt(lenSq) * t;
    if (along < from - EPS || along > to + EPS) {
      continue;
    }

    const projected = { x: a.x + ab.x * t, y: a.y + ab.y * t };
    const d = distance(point, projected);
    if (!best || d < best.distanceToPath) {
      best = { distanceAlong: along, point: projected, distanceToPath: d };
    }
  }

  return best;
}

function nodeDistanceAnchorsForChain(chain: VisualChain, nodeMap: Map<string, SceneNode>, points: Point[]): Map<string, number[]> {
  const anchors = new Map<string, number[]>();
  if (points.length < 2) {
    return anchors;
  }

  const cumulative = polylineCumulativeLengths(points);
  let searchIndex = 0;
  for (const nodeId of chain.nodeIds) {
    const node = nodeMap.get(nodeId);
    if (!node) {
      continue;
    }

    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = searchIndex; i < points.length; i += 1) {
      const d = distance(node, points[i]);
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = i;
      }
      if (d <= 1e-4) {
        break;
      }
    }

    let anchorDistance: number | null = null;
    if (bestIndex >= 0 && bestDistance <= Math.max(2, JUNCTION_CONTROL_POINT_SPACING)) {
      anchorDistance = cumulative[bestIndex];
      searchIndex = Math.max(searchIndex, bestIndex);
    } else {
      const projected = projectPointToPolylineDistance(points, node);
      anchorDistance = projected?.distanceAlong ?? null;
    }

    if (anchorDistance !== null) {
      const list = anchors.get(nodeId) ?? [];
      list.push(anchorDistance);
      anchors.set(nodeId, list);
    }
  }

  return anchors;
}

function projectStopToPolyline(
  points: Point[],
  cumulative: number[],
  stop: LaneStopCandidate,
  defaultStopDistance: number,
  nodeAnchors?: Map<string, number[]>,
): { distanceAlong: number; point: Point; distanceToPath: number } | null {
  const anchors = nodeAnchors?.get(stop.nodeId) ?? [];
  if (anchors.length === 0) {
    return projectPointToPolylineDistance(points, stop.point);
  }

  const localWindow = Math.max(defaultStopDistance * 4, 96);
  if (stop.kind === "node") {
    const anchorDistance = anchors[0];
    return {
      distanceAlong: anchorDistance,
      point: pointOnPolylineAt(points, cumulative, anchorDistance),
      distanceToPath: 0,
    };
  }

  let best: { distanceAlong: number; point: Point; distanceToPath: number } | null = null;
  for (const anchorDistance of anchors) {
    const projected = projectPointToPolylineDistanceNear(points, cumulative, stop.point, anchorDistance, localWindow);
    if (projected && (!best || projected.distanceToPath < best.distanceToPath)) {
      best = projected;
    }
  }

  return best ?? projectPointToPolylineDistance(points, stop.point);
}

function visibleLaneSpansAroundStops(
  points: Point[],
  stops: LaneStopCandidate[],
  defaultStopDistance: number,
  nodeAnchors?: Map<string, number[]>,
): { spans: Point[][]; stops: ProjectedLaneStop[]; intervals: LaneStopInterval[]; bridgeSpans: LaneBridgeSpan[] } {
  if (points.length < 2 || stops.length === 0) {
    return { spans: [points.map((point) => ({ ...point }))], stops: [], intervals: [], bridgeSpans: [] };
  }

  const cumulative = polylineCumulativeLengths(points);
  const total = cumulative[cumulative.length - 1] ?? 0;
  const projectedStops = stops
    .map((stop) => {
      const projected = projectStopToPolyline(points, cumulative, stop, defaultStopDistance, nodeAnchors);
      const stopDistance = defaultStopDistance;
      return projected && projected.distanceToPath <= Math.max(2, stopDistance * 0.6)
        ? {
            junctionBlockId: stop.junctionBlockId,
            nodeId: stop.nodeId,
            point: projected.point,
            distanceAlong: projected.distanceAlong,
            stopDistance,
            kind: stop.kind,
          }
        : null;
    })
    .filter((stop): stop is ProjectedLaneStop => Boolean(stop))
    .sort((a, b) => a.distanceAlong - b.distanceAlong);

  if (projectedStops.length === 0) {
    return { spans: [points.map((point) => ({ ...point }))], stops: [], intervals: [], bridgeSpans: [] };
  }

  const centerDistanceByNode = new Map<string, number>();
  for (const stop of projectedStops) {
    if (stop.kind === "node") {
      centerDistanceByNode.set(stop.nodeId, stop.distanceAlong);
    }
  }
  const localProjectedStops = projectedStops.filter((stop) => {
    if (stop.kind !== "connector") {
      return true;
    }
    const centerDistance = centerDistanceByNode.get(stop.nodeId);
    if (centerDistance === undefined) {
      return true;
    }
    const maxConnectorDistance = Math.max(stop.stopDistance * 4, 96);
    return Math.abs(stop.distanceAlong - centerDistance) <= maxConnectorDistance;
  });

  const groups = new Map<string, ProjectedLaneStop[]>();
  for (const stop of localProjectedStops) {
    const group = groups.get(stop.nodeId) ?? [];
    group.push(stop);
    groups.set(stop.nodeId, group);
  }

  const intervals = [...groups.entries()]
    .flatMap(([nodeId, group]) => {
      const intervalsForNode: LaneStopInterval[] = [];
      const centerStops = group.filter((stop) => stop.kind === "node");
      const connectorStops = group.filter((stop) => stop.kind === "connector");
      const junctionBlockId = connectorStops[0]?.junctionBlockId ?? centerStops[0]?.junctionBlockId;

      if (connectorStops.length > 0) {
        const distances = [...connectorStops, ...centerStops].map((stop) => stop.distanceAlong);
        intervalsForNode.push({
          junctionBlockId,
          nodeId,
          start: Math.max(0, Math.min(...distances)),
          end: Math.min(total, Math.max(...distances)),
          hasConnectorStops: true,
        });
      }

      if (connectorStops.length === 0) {
        for (const stop of centerStops) {
          intervalsForNode.push({
            junctionBlockId,
            nodeId,
            start: Math.max(0, stop.distanceAlong - stop.stopDistance),
            end: Math.min(total, stop.distanceAlong + stop.stopDistance),
            hasConnectorStops: false,
          });
        }
      }

      return intervalsForNode;
    })
    .sort((a, b) => a.start - b.start);

  const bridgeSpans: LaneBridgeSpan[] = [];
  const bridgeGapThreshold = Math.max(LANE_STOP_MIN_SPAN * 2, defaultStopDistance * 2.4);
  for (let i = 1; i < intervals.length; i += 1) {
    const previous = intervals[i - 1];
    const current = intervals[i];
    if (previous.nodeId === current.nodeId || !previous.hasConnectorStops || !current.hasConnectorStops) {
      continue;
    }

    const gap = current.start - previous.end;
    if (gap >= 0 && gap <= bridgeGapThreshold && current.start - previous.end > EPS) {
      bridgeSpans.push({
        fromJunctionBlockId: previous.junctionBlockId,
        toJunctionBlockId: current.junctionBlockId,
        fromNodeId: previous.nodeId,
        toNodeId: current.nodeId,
        start: previous.end,
        end: current.start,
        reason: "short-gap",
      });
      continue;
    }

    if (gap < 0 && previous.end - current.start <= bridgeGapThreshold) {
      bridgeSpans.push({
        fromJunctionBlockId: previous.junctionBlockId,
        toJunctionBlockId: current.junctionBlockId,
        fromNodeId: previous.nodeId,
        toNodeId: current.nodeId,
        start: current.start,
        end: previous.end,
        reason: "overlap",
      });
    }
  }

  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end + EPS) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }

  const spans: Point[][] = [];
  let cursor = 0;
  for (const interval of merged) {
    const span = slicePolylineByDistance(points, cursor, interval.start);
    if (span.length >= 2) {
      spans.push(span);
    }
    cursor = Math.max(cursor, interval.end);
  }
  const tail = slicePolylineByDistance(points, cursor, total);
  if (tail.length >= 2) {
    spans.push(tail);
  }

  return { spans, stops: localProjectedStops, intervals, bridgeSpans };
}

function splitPolylineByExcludedIntervals(points: Point[], intervals: DistanceInterval[], minSpan = LANE_STOP_MIN_SPAN): Point[][] {
  if (points.length < 2 || intervals.length === 0) {
    return [points.map((point) => ({ ...point }))];
  }
  const cumulative = polylineCumulativeLengths(points);
  const total = cumulative[cumulative.length - 1] ?? 0;
  const merged: DistanceInterval[] = [];
  for (const interval of intervals
    .map((item) => ({
      start: Math.max(0, Math.min(total, Math.min(item.start, item.end))),
      end: Math.max(0, Math.min(total, Math.max(item.start, item.end))),
    }))
    .filter((item) => item.end - item.start > EPS)
    .sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end + EPS) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }

  const spans: Point[][] = [];
  let cursor = 0;
  for (const interval of merged) {
    const span = slicePolylineByDistance(points, cursor, interval.start, minSpan);
    if (span.length >= 2) {
      spans.push(span);
    }
    cursor = Math.max(cursor, interval.end);
  }
  const tail = slicePolylineByDistance(points, cursor, total, minSpan);
  if (tail.length >= 2) {
    spans.push(tail);
  }
  return spans;
}

function splitPolylineAroundTurnFallbacks(points: Point[], turns: TurnSpec[], band: LaneBand): Point[][] {
  if (turns.length === 0) {
    return [points.map((point) => ({ ...point }))];
  }
  const bandMaxOffset = Math.max(Math.abs(band.qInner), Math.abs(band.qOuter));
  const maxProjectionDistance = Math.max(10, bandMaxOffset * 1.5);
  const intervals: DistanceInterval[] = [];
  for (const turn of turns) {
    const start = projectPointToPolylineDistance(points, turn.a);
    const end = projectPointToPolylineDistance(points, turn.b);
    if (!start || !end || start.distanceToPath > maxProjectionDistance || end.distanceToPath > maxProjectionDistance) {
      continue;
    }
    intervals.push({ start: start.distanceAlong, end: end.distanceAlong });
  }
  return splitPolylineByExcludedIntervals(points, intervals, 4);
}

function dotPoint(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y;
}

function endpointKey(edgeId: string, nodeId: string): EndpointKey {
  return `${edgeId}::${nodeId}`;
}

function firstDirectionFromNode(edge: RoadEdgeLike, nodeId: string): Point | null {
  const points = edge.controlPoints;
  if (points.length < 2) {
    return null;
  }

  if (edge.from === nodeId) {
    return unitPoint(subPoint(points[1], points[0]));
  }
  if (edge.to === nodeId) {
    return unitPoint(subPoint(points[points.length - 2], points[points.length - 1]));
  }
  return null;
}

function collectChainBranches(scene: RoadPenScene): Map<string, ChainBranch[]> {
  const branches = new Map<string, ChainBranch[]>();

  for (const edge of scene.edges) {
    const layer = roadLayer(edge);
    const fromDirection = firstDirectionFromNode(edge, edge.from);
    if (fromDirection) {
      const list = branches.get(edge.from) ?? [];
      list.push({ edge, nodeId: edge.from, layer, direction: fromDirection, profileId: edge.profileId });
      branches.set(edge.from, list);
    }

    const toDirection = firstDirectionFromNode(edge, edge.to);
    if (toDirection) {
      const list = branches.get(edge.to) ?? [];
      list.push({ edge, nodeId: edge.to, layer, direction: toDirection, profileId: edge.profileId });
      branches.set(edge.to, list);
    }
  }

  return branches;
}

function buildContinuationPairs(scene: RoadPenScene): ContinuationPair[] {
  const branchesByNode = collectChainBranches(scene);
  const pairs: ContinuationPair[] = [];

  for (const [nodeId, branches] of branchesByNode) {
    if (branches.length < 2) {
      continue;
    }

    const candidates: Array<{ a: ChainBranch; b: ChainBranch; dot: number }> = [];
    for (let i = 0; i < branches.length; i += 1) {
      for (let j = i + 1; j < branches.length; j += 1) {
        const a = branches[i];
        const b = branches[j];
        if (a.profileId !== b.profileId) {
          continue;
        }
        if (a.layer !== b.layer) {
          continue;
        }
        const dot = dotPoint(a.direction, b.direction);
        if (dot <= PASS_THROUGH_DOT) {
          candidates.push({ a, b, dot });
        }
      }
    }

    candidates.sort((a, b) => a.dot - b.dot);
    const usedEdges = new Set<string>();
    for (const candidate of candidates) {
      if (usedEdges.has(candidate.a.edge.id) || usedEdges.has(candidate.b.edge.id)) {
        continue;
      }
      usedEdges.add(candidate.a.edge.id);
      usedEdges.add(candidate.b.edge.id);
      pairs.push({ nodeId, layer: candidate.a.layer, aEdgeId: candidate.a.edge.id, bEdgeId: candidate.b.edge.id });
    }
  }

  return pairs;
}

function otherNode(edge: RoadEdgeLike, nodeId: string): string {
  return edge.from === nodeId ? edge.to : edge.from;
}

function orientedEdgePoints(edge: RoadEdgeLike, startNodeId: string): Point[] {
  const points = edge.controlPoints.map((point) => ({ ...point }));
  return edge.from === startNodeId ? points : points.reverse();
}

function appendChainPoints(out: Point[], points: Point[]): void {
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && distance(last, point) <= EPS) {
      continue;
    }
    out.push({ ...point });
  }
}

function pointKey(point: Point): string {
  return `${point.x.toFixed(6)},${point.y.toFixed(6)}`;
}

export function buildVisualChains(scene: RoadPenScene): {
  chains: VisualChain[];
  continuationPairs: ContinuationPair[];
} {
  const edgeMap = new Map(scene.edges.map((edge) => [edge.id, edge]));
  const continuationPairs = buildContinuationPairs(scene);
  const continuation = new Map<EndpointKey, EndpointKey>();

  for (const pair of continuationPairs) {
    const a = endpointKey(pair.aEdgeId, pair.nodeId);
    const b = endpointKey(pair.bEdgeId, pair.nodeId);
    continuation.set(a, b);
    continuation.set(b, a);
  }

  const usedEdges = new Set<string>();
  const chains: VisualChain[] = [];

  function hasContinuation(edge: RoadEdgeLike, nodeId: string): boolean {
    return continuation.has(endpointKey(edge.id, nodeId));
  }

  function walk(startEdge: RoadEdgeLike, startNodeId: string): VisualChain {
    const edgeIds: string[] = [];
    const nodeIds: string[] = [startNodeId];
    const points: Point[] = [];
    let currentEdge = startEdge;
    let currentNodeId = startNodeId;

    while (!usedEdges.has(currentEdge.id)) {
      appendChainPoints(points, orientedEdgePoints(currentEdge, currentNodeId));
      edgeIds.push(currentEdge.id);
      usedEdges.add(currentEdge.id);

      const exitNodeId = otherNode(currentEdge, currentNodeId);
      nodeIds.push(exitNodeId);
      const nextEndpoint = continuation.get(endpointKey(currentEdge.id, exitNodeId));
      if (!nextEndpoint) {
        break;
      }

      const [nextEdgeId] = nextEndpoint.split("::");
      const nextEdge = edgeMap.get(nextEdgeId);
      if (!nextEdge || usedEdges.has(nextEdge.id)) {
        break;
      }

      currentEdge = nextEdge;
      currentNodeId = exitNodeId;
    }

    return {
      id: `vc-${chains.length + 1}`,
      layer: roadLayer(startEdge),
      profileId: startEdge.profileId,
      edgeIds,
      nodeIds,
      points,
      geomType: points.length > 2 ? "spline" : "polyline",
    };
  }

  for (const edge of scene.edges) {
    if (usedEdges.has(edge.id)) {
      continue;
    }
    const startAtFrom = !hasContinuation(edge, edge.from);
    const startAtTo = !hasContinuation(edge, edge.to);
    if (!startAtFrom && !startAtTo) {
      continue;
    }
    chains.push(walk(edge, startAtFrom ? edge.from : edge.to));
  }

  for (const edge of scene.edges) {
    if (!usedEdges.has(edge.id)) {
      chains.push(walk(edge, edge.from));
    }
  }

  return { chains, continuationPairs };
}

function junctionTurnSkipIndices(
  chain: VisualChain,
  nodeMap: Map<string, SceneNode>,
  degrees: Map<string, number>,
  points: Point[],
): Set<number> {
  const skip = new Set<number>();
  if (points.length < 3 || chain.nodeIds.length < 3) {
    return skip;
  }

  const junctionPointKeys = new Set(
    chain.nodeIds
      .slice(1, -1)
      .filter((nodeId) => (degrees.get(nodeId) ?? 0) >= 3)
      .map((nodeId) => {
        const node = nodeMap.get(nodeId);
        return node ? pointKey(node) : "";
      })
      .filter(Boolean),
  );

  for (let i = 1; i < points.length - 1; i += 1) {
    if (junctionPointKeys.has(pointKey(points[i]))) {
      skip.add(i);
    }
  }

  return skip;
}

function simplifyCenterlineNearJunctions(
  chain: VisualChain,
  nodeMap: Map<string, SceneNode>,
  degrees: Map<string, number>,
  points: Point[],
): Point[] {
  if (points.length < 3) {
    return points.map((point) => ({ ...point }));
  }

  const junctionPoints = chain.nodeIds
    .filter((nodeId) => (degrees.get(nodeId) ?? 0) >= 3)
    .map((nodeId) => nodeMap.get(nodeId))
    .filter((node): node is SceneNode => Boolean(node));

  if (junctionPoints.length === 0) {
    return points.map((point) => ({ ...point }));
  }

  const out: Point[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const isEndpoint = i === 0 || i === points.length - 1;
    const exactJunctionPoint = junctionPoints.some((node) => distance(node, point) <= EPS);
    const nearJunctionPoint = junctionPoints.some((node) => distance(node, point) <= JUNCTION_CONTROL_POINT_SPACING);
    if (!isEndpoint && !exactJunctionPoint && nearJunctionPoint) {
      continue;
    }
    appendChainPoints(out, [point]);
  }

  return out.length >= 2 ? out : points.map((point) => ({ ...point }));
}

function addDeadEndCaps(
  scene: RoadPenScene,
  nodeMap: Map<string, SceneNode>,
  profileMap: Map<string, { carriagewayWidth: number; facilityWidth: number; sidewalkWidth: number; clearanceWidth: number }>,
  bandBuckets: Map<string, BandBucket>,
): void {
  const degreeMapsByLayer = new Map<number, Map<string, number>>();

  for (const edge of scene.edges) {
    if (edge.endMode !== "closed") {
      continue;
    }
    const layer = roadLayer(edge);
    let degrees = degreeMapsByLayer.get(layer);
    if (!degrees) {
      degrees = nodeDegreeMap(scene, layer);
      degreeMapsByLayer.set(layer, degrees);
    }

    const profile = profileMap.get(edge.profileId) ?? profileMap.get("default");
    if (!profile) {
      continue;
    }

    const bands = buildLaneBandsForProfile(edge.profileId, profileMap);
    const carriageway = bands.find((band) => band.id === "carriageway");
    const lanePairs = [
      {
        base: "facility",
        left: bands.find((band) => band.id === "facility_left"),
      },
      {
        base: "sidewalk",
        left: bands.find((band) => band.id === "sidewalk_left"),
      },
      {
        base: "clearance",
        left: bands.find((band) => band.id === "clearance_left"),
      },
    ];

    for (const endpoint of [
      { nodeId: edge.from, atFrom: true },
      { nodeId: edge.to, atFrom: false },
    ]) {
      if ((degrees.get(endpoint.nodeId) ?? 0) !== 1) {
        continue;
      }

      const node = nodeMap.get(endpoint.nodeId);
      const outward = endpointOutward(edge, endpoint.atFrom);
      if (!node || !outward || !carriageway) {
        continue;
      }

      const center = { x: node.x, y: node.y };
      const carriagewayRadius = Math.max(Math.abs(carriageway.qInner), Math.abs(carriageway.qOuter));
      addBandPolygon(bandBuckets, carriageway, deadEndDisk(center, outward, carriagewayRadius), layer);

      for (const pair of lanePairs) {
        if (!pair.left) {
          continue;
        }
        const innerRadius = Math.min(Math.abs(pair.left.qInner), Math.abs(pair.left.qOuter));
        const outerRadius = Math.max(Math.abs(pair.left.qInner), Math.abs(pair.left.qOuter));
        addBandPolygon(
          bandBuckets,
          {
            ...pair.left,
            id: capBucketId(pair.base, edge.id, endpoint.nodeId),
            name: `${pair.base}-endcap`,
          },
          deadEndRing(center, outward, innerRadius, outerRadius),
          layer,
        );
      }
    }
  }
}

function emptyGeometryIssueCounts(): Record<GeometryIssueType, number> {
  return GEOMETRY_ISSUE_TYPES.reduce(
    (acc, type) => {
      acc[type] = 0;
      return acc;
    },
    {} as Record<GeometryIssueType, number>,
  );
}

function issueReportFromMarkers(markers: GeometryIssueMarker[]): GeometryIssueReport {
  const counts = emptyGeometryIssueCounts();
  for (const marker of markers) {
    counts[marker.type] += 1;
  }
  return { counts, markers };
}

function addIssue(
  markers: GeometryIssueMarker[],
  type: GeometryIssueType,
  layer: number,
  point: Point,
  message: string,
  extras: Pick<GeometryIssueMarker, "edgeIds" | "junctionBlockId"> = {},
): void {
  markers.push({
    type,
    layer,
    point: { ...point },
    message,
    ...extras,
  });
}

function crossPoint(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x;
}

function segmentIntersection(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
): { point: Point; t: number; u: number } | null {
  const r = subPoint(b, a);
  const s = subPoint(d, c);
  const denominator = crossPoint(r, s);
  if (Math.abs(denominator) <= EPS) {
    return null;
  }

  const cma = subPoint(c, a);
  const t = crossPoint(cma, s) / denominator;
  const u = crossPoint(cma, r) / denominator;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) {
    return null;
  }

  const clampedT = Math.max(0, Math.min(1, t));
  return {
    point: addPoint(a, scalePoint(r, clampedT)),
    t: clampedT,
    u: Math.max(0, Math.min(1, u)),
  };
}

function edgePolylineLength(edge: RoadEdgeLike): number {
  let total = 0;
  for (let i = 1; i < edge.controlPoints.length; i += 1) {
    total += distance(edge.controlPoints[i - 1], edge.controlPoints[i]);
  }
  return total;
}

function edgeEndpointNear(edge: RoadEdgeLike, point: Point): boolean {
  const first = edge.controlPoints[0];
  const last = edge.controlPoints[edge.controlPoints.length - 1];
  return Boolean(first && distance(first, point) <= 1e-5) || Boolean(last && distance(last, point) <= 1e-5);
}

function edgesShareNode(a: RoadEdgeLike, b: RoadEdgeLike): boolean {
  return a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to;
}

function markerKey(type: GeometryIssueType, point: Point, edgeIds: string[] = [], layer = 0): string {
  return `${type}:${layer}:${edgeIds.slice().sort().join("+")}:${point.x.toFixed(3)},${point.y.toFixed(3)}`;
}

function polygonCentroid(points: Point[]): Point {
  const ring =
    points.length > 1 &&
    Math.abs(points[0].x - points[points.length - 1].x) < 1e-6 &&
    Math.abs(points[0].y - points[points.length - 1].y) < 1e-6
      ? points.slice(0, -1)
      : points;
  if (ring.length === 0) {
    return { x: 0, y: 0 };
  }
  const sum = ring.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
  return { x: sum.x / ring.length, y: sum.y / ring.length };
}

function nearestSameLayerJunctionDistance(edge: RoadEdgeLike, junctionBlocks: JunctionBlock[]): number {
  const layer = roadLayer(edge);
  let best = Number.POSITIVE_INFINITY;
  for (const block of junctionBlocks) {
    if (block.layer !== layer) {
      continue;
    }
    for (const point of edge.controlPoints) {
      best = Math.min(best, distance(point, block.point));
    }
  }
  return best;
}

export function analyzeRoadGeometryIssues(
  scene: RoadPenScene,
  roadData: Pick<RoadBandData, "junctionBlocks" | "junctionPatches" | "edgeCenterlines" | "outerLaneBridges" | "extremeTurnFallbacks" | "localZOrderSlices">,
): GeometryIssueReport {
  const markers: GeometryIssueMarker[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < scene.edges.length; i += 1) {
    const aEdge = scene.edges[i];
    for (let j = i + 1; j < scene.edges.length; j += 1) {
      const bEdge = scene.edges[j];
      for (let ai = 0; ai < aEdge.controlPoints.length - 1; ai += 1) {
        for (let bi = 0; bi < bEdge.controlPoints.length - 1; bi += 1) {
          const hit = segmentIntersection(
            aEdge.controlPoints[ai],
            aEdge.controlPoints[ai + 1],
            bEdge.controlPoints[bi],
            bEdge.controlPoints[bi + 1],
          );
          if (!hit) {
            continue;
          }

          const aLayer = roadLayer(aEdge);
          const bLayer = roadLayer(bEdge);
          const issueLayer = Math.max(aLayer, bLayer);
          const edgeIds = [aEdge.id, bEdge.id];
          const key = markerKey(aLayer === bLayer ? "sameLayerUnsplitCrossing" : "crossLayerOverlap", hit.point, edgeIds, issueLayer);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);

          if (aLayer !== bLayer) {
            addIssue(markers, "crossLayerOverlap", issueLayer, hit.point, `跨层道路相交：${aEdge.id} (L${aLayer}) / ${bEdge.id} (L${bLayer})`, { edgeIds });
            continue;
          }

          if (!edgesShareNode(aEdge, bEdge) || !edgeEndpointNear(aEdge, hit.point) || !edgeEndpointNear(bEdge, hit.point)) {
            addIssue(markers, "sameLayerUnsplitCrossing", aLayer, hit.point, `同层道路几何相交但未共享节点：${aEdge.id} / ${bEdge.id}`, { edgeIds });
          }
        }
      }
    }
  }

  const degreeMapsByLayer = new Map<number, Map<string, number>>();
  const degreesForLayer = (layer: number): Map<string, number> => {
    let degrees = degreeMapsByLayer.get(layer);
    if (!degrees) {
      degrees = nodeDegreeMap(scene, layer);
      degreeMapsByLayer.set(layer, degrees);
    }
    return degrees;
  };

  for (const edge of scene.edges) {
    const layer = roadLayer(edge);
    const length = edgePolylineLength(edge);
    if (length > SHORT_EDGE_STUB_LENGTH) {
      continue;
    }
    const degrees = degreesForLayer(layer);
    const touchesJunction = (degrees.get(edge.from) ?? 0) >= 3 || (degrees.get(edge.to) ?? 0) >= 3;
    const nearJunction = nearestSameLayerJunctionDistance(edge, roadData.junctionBlocks) <= 64;
    if (touchesJunction || nearJunction) {
      const point = edge.controlPoints[Math.floor(edge.controlPoints.length / 2)] ?? edge.controlPoints[0];
      addIssue(markers, "shortEdgeStub", layer, point, `短 stub/断条候选：${edge.id} length=${length.toFixed(1)}px`, { edgeIds: [edge.id] });
    }
  }

  for (const patch of roadData.junctionPatches) {
    if (patch.kind !== "corner-closure" && patch.kind !== "large-angle-closure") {
      continue;
    }
    addIssue(
      markers,
      "junctionSurfaceGapCandidate",
      patch.layer,
      polygonCentroid(patch.polygon),
      `路口灰面缺口候选：${patch.junctionBlockId}`,
      { edgeIds: [patch.fromEdgeId ?? "", patch.toEdgeId ?? ""].filter(Boolean), junctionBlockId: patch.junctionBlockId },
    );
  }

  for (const bridge of roadData.outerLaneBridges) {
    const key = markerKey("outerLaneCoverageGap", bridge.point, [bridge.chainId, bridge.bandId], bridge.layer);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    addIssue(
      markers,
      "outerLaneCoverageGap",
      bridge.layer,
      bridge.point,
      `外侧 lane bridge：${bridge.chainId} ${bridge.bandId} ${bridge.reason}`,
      { junctionBlockId: bridge.fromJunctionBlockId ?? bridge.toJunctionBlockId },
    );
  }

  for (const fallback of roadData.extremeTurnFallbacks) {
    const key = markerKey("extremeTurnFallback", fallback.point, fallback.edgeIds, fallback.layer);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    addIssue(
      markers,
      "extremeTurnFallback",
      fallback.layer,
      fallback.point,
      `极限角 fallback：${fallback.chainId} idx=${fallback.turnIndex} radius=${fallback.radius.toFixed(1)} delta=${fallback.deltaDeg.toFixed(0)}deg`,
      { edgeIds: fallback.edgeIds },
    );
  }

  for (const chain of roadData.edgeCenterlines) {
    const hit = findCenterlineSelfIntersection(chain.renderPoints);
    if (!hit) {
      continue;
    }
    const key = markerKey("selfOverlapCandidate", hit.point, chain.edgeIds, chain.layer);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    addIssue(
      markers,
      "selfOverlapCandidate",
      chain.layer,
      hit.point,
      `自重叠道路中心线：${chain.id} seg ${hit.firstSegmentIndex}/${hit.secondSegmentIndex}`,
      { edgeIds: chain.edgeIds },
    );
  }

  const localZChains = new Map<string, LocalZOrderSlice>();
  for (const slice of roadData.localZOrderSlices) {
    localZChains.set(`${slice.layer}:${slice.chainId}`, slice);
  }
  for (const slice of localZChains.values()) {
    addIssue(
      markers,
      "localZOrderApplied",
      slice.layer,
      slice.point,
      `已按路径顺序绘制自重叠道路：${slice.chainId} slices=${roadData.localZOrderSlices.filter((item) => item.layer === slice.layer && item.chainId === slice.chainId).length}`,
      { edgeIds: slice.edgeIds },
    );
  }

  const junctionPoints = roadData.junctionBlocks.map((block) => ({ layer: block.layer, point: block.point }));
  for (const chain of roadData.edgeCenterlines) {
    for (const turn of chain.turns) {
      if (turn.deltaDeg < SHARP_CORNER_DELTA_DEG) {
        continue;
      }
      const nearJunction = junctionPoints.some((junction) => junction.layer === chain.layer && distance(junction.point, turn.point) <= 36);
      if (nearJunction) {
        continue;
      }
      addIssue(
        markers,
        "sharpCornerGapCandidate",
        chain.layer,
        turn.point,
        `锐角/大转角空洞候选：${chain.id} delta=${turn.deltaDeg.toFixed(0)}deg`,
        { edgeIds: chain.edgeIds },
      );
    }
  }

  return issueReportFromMarkers(markers);
}

export function polygonArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area * 0.5;
}

function drawRing(ctx: CanvasRenderingContext2D, ring: Point[]): void {
  if (ring.length < 3) {
    return;
  }
  const p0 = ring[0];
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < ring.length; i += 1) {
    ctx.lineTo(ring[i].x, ring[i].y);
  }
  ctx.closePath();
}

function drawRingSet(ctx: CanvasRenderingContext2D, ringSet: Point[][]): void {
  ctx.beginPath();
  for (const ring of ringSet) {
    if (ring.length >= 3 && Math.abs(polygonArea(ring)) >= 1e-6) {
      drawRing(ctx, ring);
    }
  }
}

function drawMergedPolygons(
  ctx: CanvasRenderingContext2D,
  polygons: Point[][],
  fillStyle: string,
  strokeStyle?: string,
  strokeWidth = 1,
): void {
  const merged = mergeRoadJunction(polygons);
  const rings = multiPolygonToRings(merged);
  for (const ringSet of rings) {
    if (ringSet.length === 0) {
      continue;
    }
    ctx.fillStyle = fillStyle;
    if (strokeStyle) {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = strokeWidth;
    }
    drawRingSet(ctx, ringSet);
    ctx.fill("evenodd");
    if (strokeStyle) {
      ctx.stroke();
    }
  }
}

function drawLocalZOrderSlices(ctx: CanvasRenderingContext2D, slices: LocalZOrderSlice[], backgroundColor: string): void {
  for (const slice of slices.sort((a, b) => a.sliceIndex - b.sliceIndex)) {
    drawMergedPolygons(ctx, slice.footprint, backgroundColor);
    for (const item of slice.bands.slice().sort((a, b) => a.band.zIndex - b.band.zIndex)) {
      drawMergedPolygons(ctx, [item.polygon], item.band.color, "rgba(8, 14, 29, 0.8)");
    }
  }
}

function drawJunctionMarker(ctx: CanvasRenderingContext2D, junction: JunctionAnalysis): void {
  if (junction.type !== "t" && junction.type !== "cross") {
    return;
  }

  const style = JUNCTION_STYLE[junction.type];
  const { x, y } = junction.point;
  ctx.save();
  ctx.beginPath();
  ctx.fillStyle = style.fill;
  ctx.strokeStyle = style.border;
  ctx.lineWidth = 1.5;
  ctx.arc(x, y, junction.type === "cross" ? 12 : 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = style.fillText;
  ctx.font = "bold 12px 'Figtree', 'PingFang SC', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(style.text, x, y + 0.5);
  ctx.restore();
}

function drawJunctionLabels(ctx: CanvasRenderingContext2D, labels: JunctionAnalysis[]): void {
  ctx.save();
  ctx.font = "12px 'Figtree', 'PingFang SC', sans-serif";
  ctx.textBaseline = "middle";

  for (const label of labels) {
    if (label.type !== "t" && label.type !== "cross") {
      continue;
    }
    drawJunctionMarker(ctx, label);
    const style = JUNCTION_STYLE[label.type];
    const text = style.text;
    const x = label.point.x + 8;
    const y = label.point.y - 14;
    const metrics = ctx.measureText(text);
    const width = Math.max(36, metrics.width + 10);
    const height = 17;

    ctx.beginPath();
    ctx.fillStyle = style.fill;
    ctx.strokeStyle = style.border;
    ctx.lineWidth = 1;
    ctx.roundRect(x - 2, y - height / 2, width, height, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = style.fillText;
    ctx.fillText(text, x + 3, y + 0.5);

    ctx.fillStyle = "#e2e8f0";
    ctx.font = "11px 'Figtree', 'PingFang SC', sans-serif";
    ctx.fillText(`deg ${label.degree}`, x + 3, y + 9.5);
  }

  ctx.restore();
}

function dataJunctionBlockId(junction: JunctionAnalysis): string {
  return junction.layer === 0 ? `junction-${junction.nodeId}` : `junction-${junction.nodeId}-layer-${junction.layer}`;
}

function drawSnapPreview(ctx: CanvasRenderingContext2D, scene: RoadPenScene, preview: SnapTarget | null | undefined): void {
  if (!preview || preview.type === "free") {
    return;
  }

  ctx.save();
  if (preview.type === "edge") {
    const edge = scene.edges.find((item) => item.id === preview.edgeId);
    const a = edge?.controlPoints[preview.segmentIndex];
    const b = edge?.controlPoints[preview.segmentIndex + 1];
    if (a && b) {
      ctx.strokeStyle = "rgba(250, 204, 21, 0.95)";
      ctx.lineWidth = 5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  const label = preview.type === "node" ? "节点吸附" : "道路吸附";
  const point = preview.point;
  ctx.beginPath();
  ctx.fillStyle = preview.type === "node" ? "rgba(56, 189, 248, 0.22)" : "rgba(250, 204, 21, 0.22)";
  ctx.strokeStyle = preview.type === "node" ? "#38bdf8" : "#facc15";
  ctx.lineWidth = 2;
  ctx.arc(point.x, point.y, preview.type === "node" ? 13 : 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.font = "12px 'Figtree', 'PingFang SC', sans-serif";
  ctx.textBaseline = "middle";
  const metrics = ctx.measureText(label);
  const width = metrics.width + 14;
  const x = point.x + 12;
  const y = point.y - 18;
  ctx.beginPath();
  ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
  ctx.strokeStyle = preview.type === "node" ? "#38bdf8" : "#facc15";
  ctx.roundRect(x, y - 10, width, 20, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#f8fafc";
  ctx.fillText(label, x + 7, y + 0.5);
  ctx.restore();
}

function drawIntersectionPreview(ctx: CanvasRenderingContext2D, points: Point[] | undefined): void {
  if (!points || points.length === 0) {
    return;
  }

  ctx.save();
  ctx.strokeStyle = "#fb7185";
  ctx.fillStyle = "rgba(251, 113, 133, 0.22)";
  ctx.lineWidth = 2;
  for (const point of points) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(point.x - 6, point.y - 6);
    ctx.lineTo(point.x + 6, point.y + 6);
    ctx.moveTo(point.x + 6, point.y - 6);
    ctx.lineTo(point.x - 6, point.y + 6);
    ctx.stroke();
  }
  ctx.restore();
}

function drawDebugPolyline(ctx: CanvasRenderingContext2D, points: Point[], color: string, dash: number[] = []): void {
  if (points.length < 2) {
    return;
  }
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) {
    ctx.lineTo(point.x, point.y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawDebugPolygon(ctx: CanvasRenderingContext2D, polygon: Point[], color: string, dash: number[] = []): void {
  if (polygon.length < 3) {
    return;
  }
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(polygon[0].x, polygon[0].y);
  for (const point of polygon.slice(1)) {
    ctx.lineTo(point.x, point.y);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawDebugLabel(ctx: CanvasRenderingContext2D, text: string, point: Point, color = "#f8fafc"): void {
  ctx.save();
  ctx.font = "10px 'Figtree', 'PingFang SC', sans-serif";
  ctx.textBaseline = "top";
  const lines = text.split("\n");
  const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + 8;
  const height = lines.length * 12 + 6;
  ctx.fillStyle = "rgba(8, 13, 28, 0.82)";
  ctx.strokeStyle = "rgba(148, 163, 184, 0.55)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(point.x + 6, point.y + 6, width, height, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  lines.forEach((line, index) => {
    ctx.fillText(line, point.x + 10, point.y + 9 + index * 12);
  });
  ctx.restore();
}

function drawGeometryIssueMarker(ctx: CanvasRenderingContext2D, marker: GeometryIssueMarker): void {
  const style = GEOMETRY_ISSUE_STYLE[marker.type];
  ctx.save();
  ctx.strokeStyle = style.color;
  ctx.fillStyle = "rgba(8, 13, 28, 0.72)";
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.arc(marker.point.x, marker.point.y, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = style.color;
  ctx.font = "bold 9px 'Figtree', 'PingFang SC', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(style.label, marker.point.x, marker.point.y + 0.5);
  drawDebugLabel(ctx, `${style.label} L${marker.layer}\n${marker.message}`, marker.point, style.color);
  ctx.restore();
}

function drawDebugOverlay(ctx: CanvasRenderingContext2D, data: RoadBandData, debug: DebugSettings): void {
  ctx.save();
  ctx.globalAlpha = 0.92;

  if (debug.layers.junctionSurface) {
    for (const block of data.junctionBlocks) {
      drawDebugLabel(
        ctx,
        `${block.id}\nlayer ${block.layer} ${block.type} deg ${block.degree}\nconnections ${block.connections.length}\nmouth ${block.mouthLines.length} / connectors ${block.laneConnectorPatches.length}`,
        block.point,
        "#bfdbfe",
      );
    }

    for (const patch of data.junctionPatches) {
      const color = patch.kind === "mouth" ? "#fb923c" : patch.kind === "virtual-boundary" ? "#38bdf8" : "#facc15";
      const dash = patch.kind === "mouth" ? [2, 2] : patch.kind === "virtual-boundary" ? [8, 3] : [5, 3];
      drawDebugPolygon(ctx, patch.polygon, color, dash);
    }

    for (const line of data.virtualMouthLines) {
      drawDebugPolyline(ctx, [line.innerPoint, line.outerPoint], "#38bdf8", [3, 2]);
      ctx.beginPath();
      ctx.fillStyle = "#bae6fd";
      ctx.arc(line.centerPoint.x, line.centerPoint.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (debug.layers.laneConnectors) {
    for (const patch of data.laneConnectorPatches) {
      drawDebugPolygon(ctx, patch.polygon, "#22c55e", [3, 3]);
    }
  }

  if (debug.layers.roadSkeleton) {
    for (const chain of data.edgeCenterlines) {
      drawDebugPolyline(ctx, chain.rawPoints, "#ef4444", [7, 4]);
      drawDebugPolyline(ctx, chain.sourcePoints, "#facc15", [3, 3]);
      drawDebugPolyline(ctx, chain.renderPoints, "#38bdf8");

      chain.rawPoints.forEach((point, index) => {
        ctx.beginPath();
        ctx.fillStyle = "#f97316";
        ctx.strokeStyle = "#fff7ed";
        ctx.lineWidth = 1;
        ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        drawDebugLabel(ctx, `${chain.id} raw p${index}\n${point.x.toFixed(1)}, ${point.y.toFixed(1)}`, point, "#fed7aa");
      });

      chain.sourcePoints.forEach((point, index) => {
        const turn = chain.turns.find((item) => item.idx === index);
        if (!turn) {
          return;
        }
        ctx.beginPath();
        ctx.fillStyle = "#facc15";
        ctx.strokeStyle = "#fff7ed";
        ctx.lineWidth = 1;
        ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        drawDebugLabel(
          ctx,
          `${chain.id} turn p${index}\n${point.x.toFixed(1)}, ${point.y.toFixed(1)}\nr=${turn.radius.toFixed(1)} ell=${turn.ell.toFixed(1)} d=${turn.deltaDeg.toFixed(0)}`,
          point,
          "#fde68a",
        );
      });

      if (chain.rawPoints.length > 0) {
        drawDebugLabel(ctx, `${chain.id} layer ${chain.layer}\nedges=${chain.edgeIds.join("+")}\nraw red / source yellow / render cyan`, chain.rawPoints[0], "#bae6fd");
      }
    }
  }

  if (debug.layers.junctionBranches) {
    for (const junction of data.junctions) {
      if (junction.degree < 3) {
        continue;
      }
      ctx.beginPath();
      ctx.strokeStyle = junction.type === "cross" ? "#fb923c" : "#e879f9";
      ctx.lineWidth = 1.5;
      ctx.arc(junction.point.x, junction.point.y, 16, 0, Math.PI * 2);
      ctx.stroke();

      for (const branch of junction.branches) {
        const end = addPoint(junction.point, scalePoint(branch.direction, 34));
        drawDebugPolyline(ctx, [junction.point, end], "#a78bfa", [2, 3]);
        drawDebugLabel(ctx, branch.edgeId, end, "#ddd6fe");
      }
    }
  }

  if (debug.layers.laneStops) {
    for (const stop of data.laneStops) {
      ctx.beginPath();
      ctx.fillStyle = "rgba(244, 114, 182, 0.9)";
      ctx.strokeStyle = "#fce7f3";
      ctx.lineWidth = 1.5;
      ctx.arc(stop.point.x, stop.point.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = "rgba(244, 114, 182, 0.7)";
      ctx.setLineDash([4, 3]);
      ctx.arc(stop.point.x, stop.point.y, stop.distance, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      drawDebugLabel(
        ctx,
        `lane stop\n${stop.junctionBlockId ?? "no-block"}\n${stop.chainId} L${stop.layer} ${stop.nodeId}\n${stop.bandId} ${stop.kind}\nd=${stop.distance.toFixed(1)}`,
        stop.point,
        "#fbcfe8",
      );
    }
  }

  if (debug.layers.geometryIssues) {
    for (const marker of data.geometryIssues.markers) {
      drawGeometryIssueMarker(ctx, marker);
    }
  }

  ctx.restore();
}

function drawSelectedRoad(ctx: CanvasRenderingContext2D, scene: RoadPenScene, selectedEdgeId: string | null | undefined): void {
  if (!selectedEdgeId) {
    return;
  }

  const edge = scene.edges.find((item) => item.id === selectedEdgeId);
  if (!edge || edge.controlPoints.length < 2) {
    return;
  }

  const profileMap = profileMapFromScene(scene);
  const radius = maxProfileOffsetForEdge(edge, profileMap);
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.beginPath();
  ctx.moveTo(edge.controlPoints[0].x, edge.controlPoints[0].y);
  for (const point of edge.controlPoints.slice(1)) {
    ctx.lineTo(point.x, point.y);
  }
  ctx.strokeStyle = "rgba(14, 165, 233, 0.2)";
  ctx.lineWidth = Math.max(12, radius * 2 + 12);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(edge.controlPoints[0].x, edge.controlPoints[0].y);
  for (const point of edge.controlPoints.slice(1)) {
    ctx.lineTo(point.x, point.y);
  }
  ctx.strokeStyle = "#fde047";
  ctx.lineWidth = 3;
  ctx.setLineDash([9, 5]);
  ctx.stroke();
  ctx.restore();
}

export function buildJunctionOnlyBandBuckets(data: RoadBandData, junctionBlockId: string): Map<string, BandBucket> {
  const buckets = new Map<string, BandBucket>();
  const block = data.junctionBlocks.find((item) => item.id === junctionBlockId);
  if (!block) {
    return buckets;
  }

  for (const patch of block.surfacePatches) {
    addBandPolygon(buckets, patch.band, patch.polygon, patch.layer);
  }
  for (const patch of block.laneConnectorPatches) {
    addBandPolygon(buckets, patch.band, patch.polygon, patch.layer);
  }
  for (const bridge of data.outerLaneBridges) {
    if (bridge.fromJunctionBlockId !== junctionBlockId && bridge.toJunctionBlockId !== junctionBlockId) {
      continue;
    }
    const bucket = data.bandBuckets.get(bandBucketKey(bridge.layer, bridge.semanticBandId));
    addBandPolygon(buckets, bucket?.band ?? { id: bridge.semanticBandId, name: bridge.semanticBandId, qInner: 0, qOuter: 0, color: "#7dd3fc", zIndex: 0 }, bridge.polygon, bridge.layer);
  }
  return buckets;
}

function drawSelectedJunctionBlock(ctx: CanvasRenderingContext2D, block: JunctionBlock | null | undefined): void {
  if (!block) {
    return;
  }

  ctx.save();
  ctx.strokeStyle = "rgba(253, 224, 71, 0.95)";
  ctx.lineWidth = 2.5;
  ctx.setLineDash([8, 4]);
  for (const patch of [...block.surfacePatches, ...block.laneConnectorPatches]) {
    drawDebugPolygon(ctx, patch.polygon, "rgba(253, 224, 71, 0.95)", [8, 4]);
  }
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(253, 224, 71, 0.95)";
  ctx.beginPath();
  ctx.arc(block.point.x, block.point.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function findCenterlineSelfIntersection(points: Point[]): { point: Point; firstSegmentIndex: number; secondSegmentIndex: number } | null {
  for (let i = 0; i < points.length - 1; i += 1) {
    for (let j = i + 2; j < points.length - 1; j += 1) {
      if (i === 0 && j === points.length - 2 && distance(points[0], points[points.length - 1]) <= EPS) {
        continue;
      }
      const hit = segmentIntersection(points[i], points[i + 1], points[j], points[j + 1]);
      if (hit && hit.t > 1e-4 && hit.t < 1 - 1e-4 && hit.u > 1e-4 && hit.u < 1 - 1e-4) {
        return { point: hit.point, firstSegmentIndex: i, secondSegmentIndex: j };
      }
    }
  }

  return null;
}

function hasCenterlineSelfIntersection(points: Point[]): boolean {
  return Boolean(findCenterlineSelfIntersection(points));
}

function splitCenterlineForLocalZOrder(centerline: Point[], sourceCenterline: Point[]): Point[][] {
  if (centerline.length < 2) {
    return [];
  }
  const cumulative = polylineCumulativeLengths(centerline);
  const total = cumulative[cumulative.length - 1] ?? 0;
  const cuts = [0, total];
  for (const point of sourceCenterline.slice(1, -1)) {
    const projected = projectPointToPolylineDistance(centerline, point);
    if (projected && projected.distanceAlong > LANE_STOP_MIN_SPAN && projected.distanceAlong < total - LANE_STOP_MIN_SPAN) {
      cuts.push(projected.distanceAlong);
    }
  }
  const sortedCuts = [...new Set(cuts.map((value) => Number(value.toFixed(3))))].sort((a, b) => a - b);
  const slices: Point[][] = [];
  for (let i = 1; i < sortedCuts.length; i += 1) {
    const slice = slicePolylineByDistance(centerline, sortedCuts[i - 1], sortedCuts[i], 4);
    if (slice.length >= 2) {
      slices.push(slice);
    }
  }
  return slices.length > 0 ? slices : [centerline.map((point) => ({ ...point }))];
}

function buildLocalZOrderSlicesForChain(
  chain: VisualChain,
  sourceCenterline: Point[],
  centerline: Point[],
  bands: LaneBand[],
): LocalZOrderSlice[] {
  if (!findCenterlineSelfIntersection(centerline)) {
    return [];
  }

  const sliceCenterlines = splitCenterlineForLocalZOrder(centerline, sourceCenterline);
  return sliceCenterlines.flatMap((sliceCenterline, sliceIndex) => {
    const sliceBands: LocalZOrderSliceBand[] = [];
    for (const band of bands) {
      const semanticBand = semanticBandForBucket(band);
      const polygon = buildSmoothBandPolygon(sliceCenterline, band.qInner, band.qOuter);
      if (validPolygon(polygon)) {
        sliceBands.push({
          semanticBandId: semanticBand.id,
          band: { ...semanticBand },
          polygon: polygon.map((point) => ({ ...point })),
        });
      }
    }
    if (sliceBands.length === 0) {
      return [];
    }
    const cumulative = polylineCumulativeLengths(sliceCenterline);
    const midpoint = pointOnPolylineAt(sliceCenterline, cumulative, (cumulative[cumulative.length - 1] ?? 0) * 0.5);
    return [{
      chainId: chain.id,
      layer: chain.layer,
      edgeIds: [...chain.edgeIds],
      sliceIndex,
      reason: "self-overlap" as const,
      point: midpoint,
      footprint: sliceBands.map((item) => item.polygon.map((point) => ({ ...point }))),
      bands: sliceBands,
    }];
  });
}

function buildSegmentBandPolygons(centerline: Point[], band: LaneBand): Point[][] {
  const polygons: Point[][] = [];
  for (let i = 0; i < centerline.length - 1; i += 1) {
    if (distance(centerline[i], centerline[i + 1]) <= EPS) {
      continue;
    }
    const spanPolygon = buildSmoothBandPolygon([centerline[i], centerline[i + 1]], band.qInner, band.qOuter);
    if (spanPolygon.length >= 3) {
      polygons.push(spanPolygon);
    }
  }
  return polygons;
}

function buildSelfSafeBandPolygons(
  centerline: Point[],
  band: LaneBand,
  options: { forceSegmentFallback?: boolean; allowSelfIntersectionFallback?: boolean } = {},
): Point[][] {
  const polygon = buildSmoothBandPolygon(centerline, band.qInner, band.qOuter);
  const allowSelfIntersectionFallback = options.allowSelfIntersectionFallback ?? true;
  if (!options.forceSegmentFallback && (!allowSelfIntersectionFallback || !hasCenterlineSelfIntersection(centerline))) {
    return polygon.length >= 3 ? [polygon] : [];
  }

  const polygons = buildSegmentBandPolygons(centerline, band);
  return polygons.length > 0 ? polygons : polygon.length >= 3 ? [polygon] : [];
}

export function buildRoadBandPolygons(scene: RoadPenScene): RoadBandData {
  const nodeMap = indexNodes(scene);
  const bandBuckets = new Map<string, BandBucket>();
  const edgeCenterlines: RoadBandData["edgeCenterlines"] = [];
  const laneStops: RoadBandData["laneStops"] = [];
  const outerLaneBridges: RoadBandData["outerLaneBridges"] = [];
  const extremeTurnFallbacks: RoadBandData["extremeTurnFallbacks"] = [];
  const localZOrderSlices: RoadBandData["localZOrderSlices"] = [];
  const laneStopDebugKeys = new Set<string>();
  const warnings = new Set<string>();
  const degreeMapsByLayer = new Map<number, Map<string, number>>();
  const degreesForLayer = (layer: number): Map<string, number> => {
    let degrees = degreeMapsByLayer.get(layer);
    if (!degrees) {
      degrees = nodeDegreeMap(scene, layer);
      degreeMapsByLayer.set(layer, degrees);
    }
    return degrees;
  };

  const profileMap = profileMapFromScene(scene);

  const junctionGeometry = buildJunctionGeometry(scene, profileMap);
  const connectorStopsByNode = new Map<string, ConnectorStopEntry[]>();
  const mouthStopsByNode = new Map<string, JunctionMouthEntry[]>();
  for (const block of junctionGeometry.junctionBlocks) {
    for (const stop of block.laneStops) {
      const key = layerNodeKey(stop.layer, stop.nodeId);
      const stops = connectorStopsByNode.get(key) ?? [];
      stops.push({
        junctionBlockId: stop.junctionBlockId,
        edgeId: stop.edgeId,
        point: { ...stop.point },
        baseLane: stop.baseLane,
        side: stop.side,
      });
      connectorStopsByNode.set(key, stops);
    }

    for (const line of block.mouthLines) {
      const key = layerNodeKey(line.layer, line.nodeId);
      const stops = mouthStopsByNode.get(key) ?? [];
      stops.push({
        junctionBlockId: line.junctionBlockId,
        edgeId: line.edgeId,
        point: { ...line.centerPoint },
      });
      mouthStopsByNode.set(key, stops);
    }
  }
  const { chains: visualChains } = buildVisualChains(scene);
  for (const warning of junctionGeometry.warnings) {
    warnings.add(warning);
  }

  for (const chain of visualChains) {
    const chainLayer = chain.layer;
    const degrees = degreesForLayer(chainLayer);
    const profile = profileMap.get(chain.profileId) ?? profileMap.get("default");
    if (!profile) {
      continue;
    }

    if (chain.points.length < 2) {
      continue;
    }

    const bands = buildLaneBandsForProfile(chain.profileId, profileMap);
    if (bands.length === 0) {
      continue;
    }

    const maxOffset = Math.max(...bands.map((band) => Math.max(Math.abs(band.qInner), Math.abs(band.qOuter))));
    const rawCenterline = chain.points.map((p) => ({ ...p }));
    const sourceCenterline = simplifyCenterlineNearJunctions(chain, nodeMap, degrees, rawCenterline);
    const skipTurnIndices = junctionTurnSkipIndices(chain, nodeMap, degrees, sourceCenterline);
    const splineTurnOptions = {
      angleThresholdDeg: 6,
      radiusFactor: 2.2,
      clampRatio: 0.45,
      minInnerRadius: 0.4,
      skipTurnIndices,
    };
    const usesSmoothCenterline = sourceCenterline.length > 2;
    const turns = computeTurnSpecs(sourceCenterline, maxOffset, splineTurnOptions);
    const centerline =
      usesSmoothCenterline
        ? buildSkeletonPathByPoints(sourceCenterline, maxOffset, {
            samplesPerTurn: 20,
            turnOptions: splineTurnOptions,
          })
        : sourceCenterline;
    const chainSelfIntersection = findCenterlineSelfIntersection(centerline);
    const allowSelfIntersectionFallback = !chainSelfIntersection;
    if (chainSelfIntersection) {
      localZOrderSlices.push(...buildLocalZOrderSlicesForChain(chain, sourceCenterline, centerline, bands));
    }
    const nodeAnchors = nodeDistanceAnchorsForChain(chain, nodeMap, centerline);
    const defaultLaneStopDistance = Math.max(18, maxOffset * 1.1);
    const junctionNodeIds = [...new Set(chain.nodeIds)].filter((nodeId) => (degrees.get(nodeId) ?? 0) >= 3);
    const chainEdgeIds = new Set(chain.edgeIds);
    const mouthStopsForCarriageway = (): LaneStopCandidate[] =>
      junctionNodeIds.flatMap((nodeId) => {
        const node = nodeMap.get(nodeId);
        if (!node) {
          return [];
        }
        const stops = (mouthStopsByNode.get(layerNodeKey(chainLayer, nodeId)) ?? [])
          .filter((stop) => chainEdgeIds.has(stop.edgeId))
          .map((stop) => ({
            junctionBlockId: stop.junctionBlockId,
            nodeId,
            point: movePointToward(stop.point, node, JUNCTION_MOUTH_OVERLAP),
            kind: "connector" as const,
          }));
        return stops.length > 0
          ? [{ junctionBlockId: stops[0].junctionBlockId, nodeId, point: { x: node.x, y: node.y }, kind: "node" as const }, ...stops]
          : [];
      });
    const laneStopsForBand = (band: LaneBand): LaneStopCandidate[] =>
      junctionNodeIds.flatMap((nodeId) => {
        const node = nodeMap.get(nodeId);
        if (!node) {
          return [];
        }
        const base = laneBaseForBand(band);
        if (!base) {
          return [];
        }
        const connectorStops: LaneStopCandidate[] = [];
        for (const stop of connectorStopsByNode.get(layerNodeKey(chainLayer, nodeId)) ?? []) {
          if (
            chainEdgeIds.has(stop.edgeId) &&
            stop.baseLane === base &&
            chainBandSideAtNode(chain, nodeId, stop.edgeId, band) === stop.side
          ) {
            connectorStops.push({ junctionBlockId: stop.junctionBlockId, nodeId, point: { ...stop.point }, kind: "connector" });
          }
        }
        return connectorStops.length > 0
          ? [{ junctionBlockId: connectorStops[0].junctionBlockId, nodeId, point: { x: node.x, y: node.y }, kind: "node" }, ...connectorStops]
          : [];
      });
    edgeCenterlines.push({
      id: chain.id,
      layer: chainLayer,
      edgeIds: chain.edgeIds,
      geomType: chain.geomType,
      rawPoints: rawCenterline.map((point) => ({ ...point })),
      sourcePoints: sourceCenterline.map((point) => ({ ...point })),
      renderPoints: centerline.map((point) => ({ ...point })),
      turns: [...turns.entries()].flatMap(([idx, turn]) =>
        turn
          ? [{
          idx,
          point: { ...sourceCenterline[idx] },
          radius: turn.radius,
          ell: turn.ell,
          deltaDeg: (turn.delta * 180) / Math.PI,
        }]
          : [],
      ),
    });

    for (const turn of turns.values()) {
      if (turn?.warning) {
        warnings.add(`道路 ${chain.edgeIds.join("+")}：${turn.warning}`);
      }
    }

    for (const band of bands) {
      const semanticBand = semanticBandForBucket(band);
      const fallbackTurnsForBand = [...turns.values()].filter((turn): turn is TurnSpec => Boolean(turn && turnNeedsLocalFallback(turn, band)));
      const buildRenderableBandPolygons = (span: Point[]): Point[][] =>
        splitPolylineAroundTurnFallbacks(span, fallbackTurnsForBand, band).flatMap((safeSpan) =>
          buildSelfSafeBandPolygons(safeSpan, band, { allowSelfIntersectionFallback }),
        );
      for (const [turnIndex, turn] of turns.entries()) {
        if (!turn || !turnNeedsLocalFallback(turn, band)) {
          continue;
        }
        const center = sourceCenterline[turnIndex];
        if (!center) {
          continue;
        }
        for (const polygon of buildExtremeTurnFallbackPolygons(center, turn, band)) {
          if (!validPolygon(polygon)) {
            continue;
          }
          addBandPolygon(bandBuckets, band, polygon, chainLayer);
          extremeTurnFallbacks.push({
            chainId: chain.id,
            layer: chainLayer,
            bandId: band.id,
            semanticBandId: semanticBand.id,
            edgeIds: [...chain.edgeIds],
            turnIndex,
            radius: turn.radius,
            deltaDeg: (turn.delta * 180) / Math.PI,
            polygon: polygon.map((point) => ({ ...point })),
            point: { ...center },
          });
        }
      }

      if (band.id === "carriageway") {
        const stoppedSpans = visibleLaneSpansAroundStops(centerline, mouthStopsForCarriageway(), defaultLaneStopDistance, nodeAnchors);
        for (const stop of stoppedSpans.stops) {
          const key = `${chain.id}:${chainLayer}:${band.id}:${stop.nodeId}:${stop.point.x.toFixed(2)}:${stop.point.y.toFixed(2)}`;
          if (!laneStopDebugKeys.has(key)) {
            laneStopDebugKeys.add(key);
            laneStops.push({
              chainId: chain.id,
              junctionBlockId: stop.junctionBlockId,
              nodeId: stop.nodeId,
              layer: chainLayer,
              bandId: band.id,
              kind: stop.kind,
              point: { ...stop.point },
              distance: stop.stopDistance,
            });
          }
        }
        for (const span of stoppedSpans.spans) {
          for (const polygon of buildRenderableBandPolygons(span)) {
            addBandPolygon(bandBuckets, band, polygon, chainLayer);
          }
        }
        continue;
      }

      if (isOuterLaneBand(band)) {
        const stoppedLaneSpans = visibleLaneSpansAroundStops(centerline, laneStopsForBand(band), defaultLaneStopDistance, nodeAnchors);
        const bridgeCumulative = stoppedLaneSpans.bridgeSpans.length > 0 ? polylineCumulativeLengths(centerline) : [];
        for (const stop of stoppedLaneSpans.stops) {
          const key = `${chain.id}:${chainLayer}:${band.id}:${stop.nodeId}:${stop.point.x.toFixed(2)}:${stop.point.y.toFixed(2)}`;
          if (!laneStopDebugKeys.has(key)) {
            laneStopDebugKeys.add(key);
            laneStops.push({
              chainId: chain.id,
              junctionBlockId: stop.junctionBlockId,
              nodeId: stop.nodeId,
              layer: chainLayer,
              bandId: band.id,
              kind: stop.kind,
              point: { ...stop.point },
              distance: stop.stopDistance,
            });
          }
        }
        for (const bridge of stoppedLaneSpans.bridgeSpans) {
          const bridgeCenterline = slicePolylineByDistance(centerline, bridge.start, bridge.end, 1);
          if (bridgeCenterline.length < 2) {
            continue;
          }
          const bridgePoint = pointOnPolylineAt(centerline, bridgeCumulative, (bridge.start + bridge.end) * 0.5);
          const baseLane = laneBaseForBand(band);
          for (const polygon of buildSelfSafeBandPolygons(bridgeCenterline, band, { allowSelfIntersectionFallback })) {
            addBandPolygon(bandBuckets, band, polygon, chainLayer);
            outerLaneBridges.push({
              chainId: chain.id,
              layer: chainLayer,
              bandId: band.id,
              semanticBandId: semanticBand.id,
              baseLane: baseLane ?? semanticBand.id,
              fromNodeId: bridge.fromNodeId,
              toNodeId: bridge.toNodeId,
              fromJunctionBlockId: bridge.fromJunctionBlockId,
              toJunctionBlockId: bridge.toJunctionBlockId,
              reason: bridge.reason,
              polygon: polygon.map((point) => ({ ...point })),
              point: { ...bridgePoint },
            });
          }
        }
        for (const span of stoppedLaneSpans.spans) {
          for (const polygon of buildRenderableBandPolygons(span)) {
            addBandPolygon(bandBuckets, band, polygon, chainLayer);
          }
        }
        continue;
      }

      const polygons = usesSmoothCenterline
        ? buildRenderableBandPolygons(centerline)
        : [
            buildBandPolygon(sourceCenterline, turns, band.qInner, band.qOuter, {
              samplesPerTurn: 20,
            }),
          ].filter((polygon) => polygon.length >= 3);
      for (const polygon of polygons) {
        addBandPolygon(bandBuckets, band, polygon, chainLayer);
      }
    }
  }

  addDeadEndCaps(scene, nodeMap, profileMap, bandBuckets);

  for (const patch of junctionGeometry.patches) {
    addBandPolygon(bandBuckets, patch.band, patch.polygon, patch.layer);
  }

  for (const patch of junctionGeometry.laneConnectorPatches) {
    addBandPolygon(bandBuckets, patch.band, patch.polygon, patch.layer);
  }

  if (!bandBuckets.has(bandBucketKey(0, "carriageway"))) {
    const defaultBands = profileToBands({
      carriagewayWidth: 24,
      facilityWidth: 4,
      sidewalkWidth: 8,
      clearanceWidth: 4,
    });
    for (const band of defaultBands) {
      const bucketBand = semanticBandForBucket(band);
      bandBuckets.set(bandBucketKey(0, bucketBand.id), {
        roadLayer: 0,
        semanticBandId: bucketBand.id,
        band: { ...bucketBand },
        polygons: [],
      });
    }
  }

  const roadFootprints = buildRoadLayerFootprints(bandBuckets);
  const geometryIssues = analyzeRoadGeometryIssues(scene, {
    junctionBlocks: junctionGeometry.junctionBlocks,
    junctionPatches: junctionGeometry.patches,
    edgeCenterlines,
    outerLaneBridges,
    extremeTurnFallbacks,
    localZOrderSlices,
  });

  return {
    bandBuckets,
    roadFootprints,
    geometryIssues,
    junctions: junctionGeometry.junctions,
    junctionBlocks: junctionGeometry.junctionBlocks,
    junctionPatches: junctionGeometry.patches,
    laneConnectorPatches: junctionGeometry.laneConnectorPatches,
    virtualMouthLines: junctionGeometry.virtualMouthLines,
    laneStops,
    outerLaneBridges,
    extremeTurnFallbacks,
    localZOrderSlices,
    edgeCenterlines,
    warnings: [...warnings],
  };
}

export function buildRoadNetworkGeometry(scene: RoadPenScene): RoadNetworkGeometry {
  const data = buildRoadBandPolygons(scene);
  return {
    roadSegments: data.edgeCenterlines,
    junctionBlocks: data.junctionBlocks,
    warnings: data.warnings,
  };
}

export function renderRoads(ctx: CanvasRenderingContext2D | null, scene: RoadPenScene, params: RenderContext): string[] {
  if (!ctx) {
    return [];
  }

  const { width, height, draftPoints, snapPreview, intersectionPreview, debug, selectedEdgeId, selectedJunctionBlockId, isolatedJunctionBlockId } = params;
  ctx.clearRect(0, 0, width, height);

  const roadData = buildRoadBandPolygons(scene);
  const { bandBuckets, junctions, warnings: geometryWarnings } = roadData;
  const visibleBandBuckets = isolatedJunctionBlockId ? buildJunctionOnlyBandBuckets(roadData, isolatedJunctionBlockId) : bandBuckets;
  const backgroundColor = params.backgroundColor ?? ROAD_BACKGROUND_COLOR;
  const visibleFootprints = buildRoadLayerFootprints(visibleBandBuckets);
  const bucketsByLayer = new Map<number, BandBucket[]>();
  for (const bucket of visibleBandBuckets.values()) {
    const buckets = bucketsByLayer.get(bucket.roadLayer) ?? [];
    buckets.push(bucket);
    bucketsByLayer.set(bucket.roadLayer, buckets);
  }
  const localSlicesByLayer = new Map<number, LocalZOrderSlice[]>();
  if (!isolatedJunctionBlockId) {
    for (const slice of roadData.localZOrderSlices) {
      const slices = localSlicesByLayer.get(slice.layer) ?? [];
      slices.push(slice);
      localSlicesByLayer.set(slice.layer, slices);
    }
  }

  visibleFootprints.forEach((footprint, index) => {
    if (index > 0) {
      drawMergedPolygons(ctx, footprint.polygons, backgroundColor);
    }
    const layerBuckets = (bucketsByLayer.get(footprint.roadLayer) ?? []).sort((a, b) => a.band.zIndex - b.band.zIndex);
    for (const bucket of layerBuckets) {
      drawMergedPolygons(ctx, bucket.polygons, bucket.band.color, "rgba(8, 14, 29, 0.8)");
    }
    drawLocalZOrderSlices(ctx, localSlicesByLayer.get(footprint.roadLayer) ?? [], backgroundColor);
  });

  drawSelectedRoad(ctx, scene, selectedEdgeId);
  const selectedBlockId = isolatedJunctionBlockId ?? selectedJunctionBlockId;
  const selectedBlock = selectedBlockId ? roadData.junctionBlocks.find((block) => block.id === selectedBlockId) : null;
  drawSelectedJunctionBlock(ctx, selectedBlock);
  drawJunctionLabels(
    ctx,
    isolatedJunctionBlockId
      ? junctions.filter((junction) => dataJunctionBlockId(junction) === isolatedJunctionBlockId)
      : junctions,
  );
  if (debug?.enabled) {
    drawDebugOverlay(ctx, roadData, debug);
  }
  drawSnapPreview(ctx, scene, snapPreview);
  drawIntersectionPreview(ctx, intersectionPreview);

  if (draftPoints && draftPoints.length > 1) {
    ctx.strokeStyle = "rgba(250, 204, 21, 0.95)";
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    const p0 = draftPoints[0];
    ctx.moveTo(p0.x, p0.y);
    for (const p of draftPoints.slice(1)) {
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(250, 204, 21, 0.95)";
    for (const p of draftPoints) {
      const radius = draftPoints.length > 1 && p === draftPoints[draftPoints.length - 1] ? 3.8 : 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    const len = distance(draftPoints[0], draftPoints[draftPoints.length - 1]);
    const mid = draftPoints[Math.floor(draftPoints.length / 2)];
    ctx.fillStyle = "rgba(147,197,253,0.9)";
    ctx.font = "12px 'Figtree', 'PingFang SC', sans-serif";
    ctx.fillText(`草稿长度 ${len.toFixed(0)} px`, mid.x + 8, mid.y + 4);
  }

  return geometryWarnings;
}
