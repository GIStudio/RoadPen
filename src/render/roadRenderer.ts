import type { JunctionType, LaneBand, Point, RoadPenScene, SceneNode } from "../types";
import type { JunctionAnalysis, JunctionPatch, LaneConnectorPatch } from "../geometry/junctionGeometry";
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
  draftPoints?: Point[];
  snapPreview?: SnapTarget | null;
  intersectionPreview?: Point[];
}

export interface BandBucket {
  band: LaneBand;
  polygons: Point[][];
}

export interface RoadBandData {
  bandBuckets: Map<string, BandBucket>;
  junctions: JunctionAnalysis[];
  junctionPatches: JunctionPatch[];
  laneConnectorPatches: LaneConnectorPatch[];
  edgeCenterlines: Array<{
    edgeId: string;
    geomType: string;
    rawPoints: Point[];
    renderPoints: Point[];
  }>;
  warnings: string[];
}

const EPS = 1e-9;
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

function indexNodes(scene: RoadPenScene): Map<string, SceneNode> {
  const map = new Map<string, SceneNode>();
  for (const node of scene.nodes) {
    map.set(node.id, node);
  }
  return map;
}

function nodeDegreeMap(scene: RoadPenScene): Map<string, number> {
  const map = new Map<string, number>();
  for (const edge of scene.edges) {
    map.set(edge.from, (map.get(edge.from) ?? 0) + 1);
    map.set(edge.to, (map.get(edge.to) ?? 0) + 1);
  }
  return map;
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

function addBandPolygon(bandBuckets: Map<string, BandBucket>, band: LaneBand, polygon: Point[]): void {
  if (polygon.length < 4) {
    return;
  }
  const bucketBand = semanticBandForBucket(band);
  const bucket = bandBuckets.get(bucketBand.id) ?? { band: bucketBand, polygons: [] };
  bandBuckets.set(bucketBand.id, bucket);
  bucket.polygons.push(polygon);
}

function addDeadEndCaps(
  scene: RoadPenScene,
  nodeMap: Map<string, SceneNode>,
  profileMap: Map<string, { carriagewayWidth: number; facilityWidth: number; sidewalkWidth: number; clearanceWidth: number }>,
  bandBuckets: Map<string, BandBucket>,
): void {
  const degrees = nodeDegreeMap(scene);

  for (const edge of scene.edges) {
    if (edge.endMode !== "closed") {
      continue;
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
      addBandPolygon(bandBuckets, carriageway, deadEndDisk(center, outward, carriagewayRadius));

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
        );
      }
    }
  }
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
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < ring.length; i += 1) {
    ctx.lineTo(ring[i].x, ring[i].y);
  }
  ctx.closePath();
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

export function buildRoadBandPolygons(scene: RoadPenScene): RoadBandData {
  const nodeMap = indexNodes(scene);
  const bandBuckets = new Map<string, BandBucket>();
  const edgeCenterlines: RoadBandData["edgeCenterlines"] = [];
  const warnings = new Set<string>();

  const profileMap = new Map<string, { carriagewayWidth: number; facilityWidth: number; sidewalkWidth: number; clearanceWidth: number }>();
  for (const profile of scene.profiles) {
    profileMap.set(profile.id, {
      carriagewayWidth: profile.carriagewayWidth,
      facilityWidth: profile.facilityWidth,
      sidewalkWidth: profile.sidewalkWidth,
      clearanceWidth: profile.clearanceWidth,
    });
  }

  for (const edge of scene.edges) {
    const profile = profileMap.get(edge.profileId) ?? profileMap.get("default");
    if (!profile) {
      continue;
    }

    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);
    if (!from || !to) {
      continue;
    }

    const bands = buildLaneBandsForProfile(edge.profileId, profileMap);
    if (bands.length === 0) {
      continue;
    }

    const maxOffset = Math.max(...bands.map((band) => Math.max(Math.abs(band.qInner), Math.abs(band.qOuter))));
    const isSpline = edge.geomType === "spline";
    const rawCenterline = edge.controlPoints.map((p) => ({ ...p }));
    const splineTurnOptions = {
      angleThresholdDeg: 6,
      radiusFactor: 2.2,
      clampRatio: 0.45,
      minInnerRadius: 0.4,
    };
    const centerline = isSpline
      ? buildSkeletonPathByPoints(rawCenterline, maxOffset, {
          samplesPerTurn: 20,
          turnOptions: splineTurnOptions,
        })
      : rawCenterline;
    edgeCenterlines.push({
      edgeId: edge.id,
      geomType: edge.geomType,
      rawPoints: rawCenterline.map((point) => ({ ...point })),
      renderPoints: centerline.map((point) => ({ ...point })),
    });

    const turns = isSpline
      ? new Map()
      : computeTurnSpecs(centerline, maxOffset, {
          angleThresholdDeg: 6,
          radiusFactor: 2.2,
          clampRatio: 0.45,
          minInnerRadius: 0.4,
        });

    for (const turn of turns.values()) {
      if (turn?.warning) {
        warnings.add(`道路 ${edge.id}：${turn.warning}`);
      }
    }

    for (const band of bands) {
      const polygon = isSpline
        ? buildSmoothBandPolygon(centerline, band.qInner, band.qOuter)
        : buildBandPolygon(centerline, turns, band.qInner, band.qOuter, {
            samplesPerTurn: 20,
          });
      if (polygon.length < 3) {
        continue;
      }
      addBandPolygon(bandBuckets, band, polygon);
    }
  }

  addDeadEndCaps(scene, nodeMap, profileMap, bandBuckets);

  const junctionGeometry = buildJunctionGeometry(scene, profileMap);
  for (const warning of junctionGeometry.warnings) {
    warnings.add(warning);
  }

  for (const patch of junctionGeometry.patches) {
    addBandPolygon(bandBuckets, patch.band, patch.polygon);
  }

  for (const patch of junctionGeometry.laneConnectorPatches) {
    addBandPolygon(bandBuckets, patch.band, patch.polygon);
  }

  if (!bandBuckets.has("carriageway")) {
    const defaultBands = profileToBands({
      carriagewayWidth: 24,
      facilityWidth: 4,
      sidewalkWidth: 8,
      clearanceWidth: 4,
    });
    for (const band of defaultBands) {
      bandBuckets.set(band.id, { band: { ...band }, polygons: [] });
    }
  }

  return {
    bandBuckets,
    junctions: junctionGeometry.junctions,
    junctionPatches: junctionGeometry.patches,
    laneConnectorPatches: junctionGeometry.laneConnectorPatches,
    edgeCenterlines,
    warnings: [...warnings],
  };
}

export function renderRoads(ctx: CanvasRenderingContext2D | null, scene: RoadPenScene, params: RenderContext): string[] {
  if (!ctx) {
    return [];
  }

  const { width, height, draftPoints, snapPreview, intersectionPreview } = params;
  ctx.clearRect(0, 0, width, height);

  const { bandBuckets, junctions, warnings: geometryWarnings } = buildRoadBandPolygons(scene);
  const orderedBands = [...bandBuckets.values()].sort((a, b) => a.band.zIndex - b.band.zIndex);

  for (const bucket of orderedBands) {
    const merged = mergeRoadJunction(bucket.polygons);
    const rings = multiPolygonToRings(merged);

    for (const ringSet of rings) {
      for (const ring of ringSet) {
        if (ring.length < 3) {
          continue;
        }

        const signedArea = polygonArea(ring);
        if (Math.abs(signedArea) < 1e-6) {
          continue;
        }

        ctx.fillStyle = bucket.band.color;
        ctx.strokeStyle = "rgba(8, 14, 29, 0.8)";
        ctx.lineWidth = 1;
        drawRing(ctx, ring);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  drawJunctionLabels(ctx, junctions);
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
