import type { JunctionType, LaneBand, Point, RoadEdge, RoadPenScene, SceneNode } from "../types";
import {
  buildBandPolygon,
  buildSmoothBandPolygon,
  buildLaneBandsForProfile,
  computeTurnSpecs,
  distance,
  profileToBands,
  smoothPathByPoints,
} from "../geometry/roadGeometry";
import { mergeRoadJunction, multiPolygonToRings } from "../geometry/roadMerge";

interface RenderContext {
  width: number;
  height: number;
  draftPoints?: Point[];
}

export interface BandBucket {
  band: LaneBand;
  polygons: Point[][];
}

export interface RoadBandData {
  bandBuckets: Map<string, BandBucket>;
  warnings: string[];
}

export interface JunctionLabel {
  nodeId: string;
  type: JunctionType;
  degree: number;
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

function addOrZero(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
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

function normalize(v: Point): Point {
  const len = Math.hypot(v.x, v.y);
  if (len <= EPS) {
    return { x: 0, y: 0 };
  }
  return { x: v.x / len, y: v.y / len };
}

function classifyJunction(vectors: Point[]): JunctionType {
  const n = vectors.length;
  if (n <= 1) {
    return "line";
  }
  if (n === 2) {
    const a = normalize(vectors[0]);
    const b = normalize(vectors[1]);
    return a.x * b.x + a.y * b.y < -0.82 ? "line" : "curve";
  }
  if (n === 3) {
    return "t";
  }
  return "cross";
}

function detectJunctionLabels(scene: RoadPenScene): JunctionLabel[] {
  const nodeMap = indexNodes(scene);
  const junctions: JunctionLabel[] = [];

  for (const node of scene.nodes) {
    const vectors: Point[] = [];
    for (const edge of scene.edges) {
      if (edge.from !== node.id && edge.to !== node.id) {
        continue;
      }

      const otherId = edge.from === node.id ? edge.to : edge.from;
      const other = nodeMap.get(otherId);
      if (!other) {
        continue;
      }
      vectors.push({
        x: addOrZero(other.x - node.x),
        y: addOrZero(other.y - node.y),
      });
    }

    const type = classifyJunction(vectors);
    junctions.push({
      nodeId: node.id,
      type,
      degree: vectors.length,
    });
  }

  return junctions;
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

function drawJunctionLabels(ctx: CanvasRenderingContext2D, scene: RoadPenScene, labels: JunctionLabel[]): void {
  const nodeMap = indexNodes(scene);
  ctx.save();
  ctx.font = "12px 'Figtree', 'PingFang SC', sans-serif";
  ctx.textBaseline = "middle";

  for (const label of labels) {
    const node = nodeMap.get(label.nodeId);
    if (!node) {
      continue;
    }
    const style = JUNCTION_STYLE[label.type];
    const text = style.text;
    const x = node.x + 8;
    const y = node.y - 14;
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

export function buildRoadBandPolygons(scene: RoadPenScene): RoadBandData {
  const nodeMap = indexNodes(scene);
  const bandBuckets = new Map<string, BandBucket>();
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

    const isSpline = edge.geomType === "spline";
    let centerline = edge.controlPoints.map((p) => ({ ...p }));
    if (isSpline) {
      centerline = smoothPathByPoints(centerline, 0.5, 14);
    }

    const bands = buildLaneBandsForProfile(edge.profileId, profileMap);
    if (bands.length === 0) {
      continue;
    }

    const maxOffset = Math.max(...bands.map((band) => Math.max(Math.abs(band.qInner), Math.abs(band.qOuter))));
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
      const bucket = bandBuckets.get(band.id) ?? { band: { ...band }, polygons: [] };
      bandBuckets.set(band.id, bucket);
      bucket.polygons.push(polygon);
    }
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
    warnings: [...warnings],
  };
}

export function renderRoads(ctx: CanvasRenderingContext2D | null, scene: RoadPenScene, params: RenderContext): string[] {
  if (!ctx) {
    return [];
  }

  const { width, height, draftPoints } = params;
  ctx.clearRect(0, 0, width, height);

  const { bandBuckets, warnings: geometryWarnings } = buildRoadBandPolygons(scene);
  const orderedBands = [...bandBuckets.values()].sort((a, b) => b.band.zIndex - a.band.zIndex);
  const junctionLabels = detectJunctionLabels(scene);

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

  drawJunctionLabels(ctx, scene, junctionLabels);

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
