import type { LaneBand, Point, TurnSpec } from "../types";

export interface TurnSpecOptions {
  angleThresholdDeg?: number;
  radiusFactor?: number;
  clampRatio?: number;
  minInnerRadius?: number;
}

export interface GeometryOptions {
  samplesPerTurn?: number;
  tension?: number;
  turnOptions?: TurnSpecOptions;
}

const EPS = 1e-9;

function length(p: Point): number {
  return Math.hypot(p.x, p.y);
}

function unit(p: Point): Point {
  const len = length(p);
  if (len <= EPS) {
    return { x: 0, y: 0 };
  }
  return { x: p.x / len, y: p.y / len };
}

function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

function scale(p: Point, s: number): Point {
  return { x: p.x * s, y: p.y * s };
}

function leftNormal(v: Point): Point {
  return { x: -v.y, y: v.x };
}

function cross2(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x;
}

export function distance(a: Point, b: Point): number {
  return length(sub(a, b));
}

function sanitizePoints(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      continue;
    }
    if (!out.length || distance(point, out[out.length - 1]) > 1e-6) {
      out.push({ x: point.x, y: point.y });
    }
  }
  return out;
}

function lineIntersection(p: Point, d: Point, q: Point, e: Point): Point | null {
  const den = cross2(d, e);
  if (Math.abs(den) <= EPS) {
    return null;
  }
  const t = cross2(sub(q, p), e) / den;
  return add(p, scale(d, t));
}

function catmullRomBezierPoints(points: Point[], tension = 0.5, segments = 12): Point[] {
  const n = points.length;
  if (n <= 2) {
    return points.map((p) => ({ ...p }));
  }

  const samplePerSegment = Math.max(3, Math.floor(segments));
  const output: Point[] = [];

  for (let i = 0; i < n - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];

    for (let s = 0; s < samplePerSegment; s += 1) {
      const t = s / samplePerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1.x +
          (p2.x - p0.x) * tension * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y =
        0.5 *
        (2 * p1.y +
          (p2.y - p0.y) * tension * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      output.push({ x, y });
    }
  }

  output.push({ ...points[n - 1] });
  return output;
}

function quadraticBezierPoints(points: [Point, Point, Point], segments = 24): Point[] {
  const steps = Math.max(6, Math.floor(segments));
  const [p0, p1, p2] = points;
  const output: Point[] = [];

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const mt = 1 - t;
    output.push({
      x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
      y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
    });
  }

  return output;
}

export function smoothPathByPoints(points: Point[], tension = 0.5, segments = 12): Point[] {
  const input = sanitizePoints(points);
  if (input.length < 2) {
    return input.map((p) => ({ ...p }));
  }
  if (input.length === 2) {
    return input.map((p) => ({ ...p }));
  }
  if (input.length === 3) {
    return quadraticBezierPoints([input[0], input[1], input[2]], segments * 2);
  }
  return catmullRomBezierPoints(input, tension, segments);
}

export function profileToBands(profile: {
  carriagewayWidth: number;
  facilityWidth: number;
  sidewalkWidth: number;
  clearanceWidth: number;
}): LaneBand[] {
  const wRoad = Math.max(0.1, profile.carriagewayWidth);
  const hf = Math.max(0, profile.facilityWidth);
  const hs = Math.max(0, profile.sidewalkWidth);
  const hc = Math.max(0, profile.clearanceWidth);

  const halfRoad = wRoad * 0.5;

  const bands: LaneBand[] = [
    {
      id: "carriageway",
      name: "carriageway",
      qInner: -halfRoad,
      qOuter: halfRoad,
      color: "rgba(45, 55, 72, 0.95)",
      zIndex: 40,
    },
    {
      id: "facility_left",
      name: "facility-left",
      qInner: halfRoad,
      qOuter: halfRoad + hf,
      color: "rgba(120, 113, 108, 0.85)",
      zIndex: 30,
    },
    {
      id: "facility_right",
      name: "facility-right",
      qInner: -(halfRoad + hf),
      qOuter: -halfRoad,
      color: "rgba(120, 113, 108, 0.85)",
      zIndex: 30,
    },
    {
      id: "sidewalk_left",
      name: "sidewalk-left",
      qInner: halfRoad + hf,
      qOuter: halfRoad + hf + hs,
      color: "rgba(134, 239, 172, 0.85)",
      zIndex: 20,
    },
    {
      id: "sidewalk_right",
      name: "sidewalk-right",
      qInner: -(halfRoad + hf + hs),
      qOuter: -(halfRoad + hf),
      color: "rgba(134, 239, 172, 0.85)",
      zIndex: 20,
    },
    {
      id: "clearance_left",
      name: "clearance-left",
      qInner: halfRoad + hf + hs,
      qOuter: halfRoad + hf + hs + hc,
      color: "rgba(186, 230, 253, 0.45)",
      zIndex: 10,
    },
    {
      id: "clearance_right",
      name: "clearance-right",
      qInner: -(halfRoad + hf + hs + hc),
      qOuter: -(halfRoad + hf + hs),
      color: "rgba(186, 230, 253, 0.45)",
      zIndex: 10,
    },
  ];

  return bands.filter((band) => Math.abs(band.qOuter - band.qInner) > 1e-6);
}

export function computeTurnSpecs(
  points: Point[],
  maxOffset: number,
  options: TurnSpecOptions = {},
): Map<number, TurnSpec | null> {
  const input = sanitizePoints(points);
  const n = input.length;
  const angleThresholdDeg = options.angleThresholdDeg ?? 6;
  const radiusFactor = options.radiusFactor ?? 2.2;
  const clampRatio = options.clampRatio ?? 0.45;
  const minInnerRadius = options.minInnerRadius ?? 1;

  const angleThreshold = (Math.PI * angleThresholdDeg) / 180;
  const turns = new Map<number, TurnSpec | null>();

  if (n < 3) {
    return turns;
  }

  const clampBase = Math.max(Math.abs(maxOffset), 1);
  const baseRadius = Math.max(clampBase * 2 * radiusFactor, 8, minInnerRadius);

  for (let i = 1; i < n - 1; i += 1) {
    const prev = input[i - 1];
    const curr = input[i];
    const next = input[i + 1];
    const prevSeg = sub(curr, prev);
    const nextSeg = sub(next, curr);
    const u = unit(prevSeg);
    const v = unit(nextSeg);
    const uLen = length(prevSeg);
    const vLen = length(nextSeg);

    if (uLen <= 1e-6 || vLen <= 1e-6) {
      turns.set(i, null);
      continue;
    }

    const dot = Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y));
    const delta = Math.acos(dot);
    const cr = cross2(u, v);

    if (delta < angleThreshold || Math.abs(cr) <= EPS) {
      turns.set(i, null);
      continue;
    }

    const sigma = cr >= 0 ? 1 : -1;
    const ellDesired = baseRadius * Math.tan(delta / 2);
    const lim = clampRatio * Math.min(uLen, vLen);
    const ell = Math.max(0, Math.min(ellDesired, lim));

    if (ell <= 1e-6) {
      turns.set(i, null);
      continue;
    }

    const radius = ell / Math.tan(delta / 2);
    const turn: TurnSpec = {
      idx: i,
      u,
      v,
      a: add(curr, scale(u, -ell)),
      b: add(curr, scale(v, ell)),
      delta,
      sigma,
      radius,
      ell,
      warning: undefined,
    };

    const innerBoundary = Math.abs(maxOffset);
    if (radius <= innerBoundary + minInnerRadius) {
      turn.warning = `转折过急：idx=${i}, radius=${radius.toFixed(2)} 太小`;
    }

    turns.set(i, turn);
  }

  return turns;
}

function offsetTurnCurve(turn: TurnSpec, q: number, samples = 24): Point[] {
  const sampleCount = Math.max(4, Math.floor(samples));
  const rQ = turn.radius - turn.sigma * q;
  if (rQ <= 1e-6) {
    return [];
  }

  const nIn = leftNormal(turn.u);
  const nOut = leftNormal(turn.v);
  const p0 = add(turn.a, scale(nIn, q));
  const p3 = add(turn.b, scale(nOut, q));
  const h = (4 / 3) * rQ * Math.tan(turn.delta / 4);
  const p1 = add(p0, scale(turn.u, h));
  const p2 = add(p3, scale(turn.v, -h));

  const out: Point[] = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const t = sampleCount <= 1 ? 0 : i / (sampleCount - 1);
    const mt = 1 - t;
    out.push({
      x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
      y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return out;
}

export function buildBoundaryPath(points: Point[], turns: Map<number, TurnSpec | null>, q: number, samplesPerTurn = 24): Point[] {
  const cleaned = sanitizePoints(points);
  const n = cleaned.length;
  if (n === 0) {
    return [];
  }
  if (n === 1 || Math.abs(q) < EPS) {
    if (Math.abs(q) < EPS) {
      return [cleaned[0]];
    }
    return [];
  }
  if (n === 2) {
    const dir = unit(sub(cleaned[1], cleaned[0]));
    const nrm = leftNormal(dir);
    return [add(cleaned[0], scale(nrm, q)), add(cleaned[1], scale(nrm, q))];
  }

  const out: Point[] = [];
  const firstDir = unit(sub(cleaned[1], cleaned[0]));
  const firstNorm = leftNormal(firstDir);
  out.push(add(cleaned[0], scale(firstNorm, q)));

  for (let i = 1; i < n - 1; i += 1) {
    const prev = cleaned[i - 1];
    const cur = cleaned[i];
    const next = cleaned[i + 1];
    const turn = turns.get(i) || null;

    if (turn) {
      const curve = offsetTurnCurve(turn, q, samplesPerTurn);
      if (curve.length >= 2) {
        if (distance(curve[0], out[out.length - 1]) < 1e-6) {
          out.push(...curve.slice(1));
        } else {
          out.push(...curve);
        }
        continue;
      }
    }

    const prevDir = unit(sub(cur, prev));
    const nextDir = unit(sub(next, cur));
    const prevNorm = leftNormal(prevDir);
    const nextNorm = leftNormal(nextDir);
    const pPrev = add(cur, scale(prevNorm, q));
    const pNext = add(cur, scale(nextNorm, q));
    const intersect = lineIntersection(pPrev, prevDir, pNext, nextDir);

    out.push(
      intersect ?? {
        x: (pPrev.x + pNext.x) * 0.5,
        y: (pPrev.y + pNext.y) * 0.5,
      },
    );
  }

  const lastDir = unit(sub(cleaned[n - 1], cleaned[n - 2]));
  const lastNorm = leftNormal(lastDir);
  out.push(add(cleaned[n - 1], scale(lastNorm, q)));

  return out;
}

export function buildBandPolygon(
  centerline: Point[],
  turns: Map<number, TurnSpec | null>,
  qInner: number,
  qOuter: number,
  options: GeometryOptions = {},
): Point[] {
  if (centerline.length < 2) {
    return [];
  }

  const minQ = Math.min(qInner, qOuter);
  const maxQ = Math.max(qInner, qOuter);

  const samplesPerTurn = options.samplesPerTurn ?? 24;
  const outer = buildBoundaryPath(centerline, turns, maxQ, samplesPerTurn);
  const inner = buildBoundaryPath(centerline, turns, minQ, samplesPerTurn);

  if (outer.length < 2 || inner.length < 2) {
    return [];
  }

  const polygon = [...outer, ...inner.slice().reverse()];
  if (polygon.length < 3) {
    return [];
  }

  const first = polygon[0];
  const last = polygon[polygon.length - 1];
  if (Math.abs(first.x - last.x) > 1e-6 || Math.abs(first.y - last.y) > 1e-6) {
    polygon.push({ ...first });
  }

  return polygon;
}

function buildSmoothBoundaryPath(points: Point[], q: number): Point[] {
  const cleaned = sanitizePoints(points);
  if (cleaned.length < 2) {
    return [];
  }

  return cleaned.map((point, index) => {
    const prev = cleaned[Math.max(0, index - 1)];
    const next = cleaned[Math.min(cleaned.length - 1, index + 1)];
    const tangent = unit(sub(next, prev));
    const nrm = leftNormal(tangent);
    return add(point, scale(nrm, q));
  });
}

export function buildSmoothBandPolygon(centerline: Point[], qInner: number, qOuter: number): Point[] {
  if (centerline.length < 2) {
    return [];
  }

  const minQ = Math.min(qInner, qOuter);
  const maxQ = Math.max(qInner, qOuter);
  const outer = buildSmoothBoundaryPath(centerline, maxQ);
  const inner = buildSmoothBoundaryPath(centerline, minQ);

  if (outer.length < 2 || inner.length < 2) {
    return [];
  }

  const polygon = [...outer, ...inner.slice().reverse()];
  if (polygon.length < 3) {
    return [];
  }

  const first = polygon[0];
  const last = polygon[polygon.length - 1];
  if (Math.abs(first.x - last.x) > 1e-6 || Math.abs(first.y - last.y) > 1e-6) {
    polygon.push({ ...first });
  }

  return polygon;
}

export function buildLaneBandsForProfile(
  profileId: string,
  profileMap: Map<string, { carriagewayWidth: number; facilityWidth: number; sidewalkWidth: number; clearanceWidth: number }>,
): LaneBand[] {
  const profile = profileMap.get(profileId);
  if (!profile) {
    return profileToBands({
      carriagewayWidth: 20,
      facilityWidth: 2,
      sidewalkWidth: 3,
      clearanceWidth: 2,
    });
  }
  return profileToBands(profile);
}
