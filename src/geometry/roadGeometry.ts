import type { LaneBand, Point, TurnSpec } from "../types";

export interface TurnSpecOptions {
  angleThresholdDeg?: number;
  radiusFactor?: number;
  clampRatio?: number;
  minInnerRadius?: number;
  skipTurnIndices?: ReadonlySet<number>;
  adaptive?: boolean;
  stableRadiusSafety?: number;
  shortSegmentCluster?: boolean;
  shortSegmentFactor?: number;
  maxClusterSpan?: number;
  maxBorrowSpan?: number;
  maxRiskySequenceSpan?: number;
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

function cubicBezierPoints(p0: Point, p1: Point, p2: Point, p3: Point, segments = 24): Point[] {
  const steps = Math.max(6, Math.floor(segments));
  const output: Point[] = [];

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const mt = 1 - t;
    output.push({
      x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
      y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
    });
  }

  return output;
}

function pushDistinct(points: Point[], point: Point): void {
  if (!points.length || distance(points[points.length - 1], point) > 1e-6) {
    points.push({ x: point.x, y: point.y });
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function polylineCumulativeLengths(points: Point[]): number[] {
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]));
  }
  return cumulative;
}

function pointAtDistance(points: Point[], cumulative: number[], targetDistance: number): Point {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }
  if (targetDistance <= 0) {
    return { ...points[0] };
  }
  const total = cumulative[cumulative.length - 1] ?? 0;
  if (targetDistance >= total) {
    return { ...points[points.length - 1] };
  }

  for (let i = 1; i < cumulative.length; i += 1) {
    if (targetDistance > cumulative[i] + 1e-6) {
      continue;
    }
    const segmentLength = cumulative[i] - cumulative[i - 1];
    if (segmentLength <= EPS) {
      return { ...points[i] };
    }
    const t = (targetDistance - cumulative[i - 1]) / segmentLength;
    return add(points[i - 1], scale(sub(points[i], points[i - 1]), t));
  }
  return { ...points[points.length - 1] };
}

function directionAtDistance(points: Point[], cumulative: number[], targetDistance: number, forward: boolean): Point {
  if (points.length < 2) {
    return { x: 1, y: 0 };
  }
  const total = cumulative[cumulative.length - 1] ?? 0;
  const clamped = clamp(targetDistance, 0, total);
  for (let i = 1; i < cumulative.length; i += 1) {
    if (clamped > cumulative[i] + 1e-6) {
      continue;
    }
    const segmentIndex = forward && Math.abs(clamped - cumulative[i]) <= 1e-6 && i + 1 < points.length ? i + 1 : i;
    const a = points[Math.max(0, segmentIndex - 1)];
    const b = points[Math.min(points.length - 1, segmentIndex)];
    return unit(sub(b, a));
  }
  return unit(sub(points[points.length - 1], points[points.length - 2]));
}

function adaptiveTurnSamples(turn: TurnSpec, requestedSamples: number): number {
  const arcLength = Math.max(0, turn.radius * turn.delta);
  return Math.min(Math.max(6, Math.ceil(arcLength / 6)), Math.max(6, Math.min(24, Math.floor(requestedSamples))));
}

function sampleCenterTurn(turn: TurnSpec, samplesPerTurn: number): Point[] {
  const handle = (4 / 3) * turn.radius * Math.tan(turn.delta / 4);
  const c1 = add(turn.a, scale(turn.u, handle));
  const c2 = add(turn.b, scale(turn.v, -handle));
  return cubicBezierPoints(turn.a, c1, c2, turn.b, adaptiveTurnSamples(turn, samplesPerTurn));
}

export function buildSkeletonPathByPoints(points: Point[], maxOffset = 12, options: GeometryOptions = {}): Point[] {
  const input = sanitizePoints(points);
  if (input.length < 3) {
    return input.map((p) => ({ ...p }));
  }

  const samplesPerTurn = options.samplesPerTurn ?? 24;
  const turns = computeTurnSpecs(input, maxOffset, {
    angleThresholdDeg: options.turnOptions?.angleThresholdDeg ?? 6,
    radiusFactor: options.turnOptions?.radiusFactor ?? 2.2,
    clampRatio: options.turnOptions?.clampRatio ?? 0.45,
    minInnerRadius: options.turnOptions?.minInnerRadius ?? 0.4,
    skipTurnIndices: options.turnOptions?.skipTurnIndices,
    adaptive: options.turnOptions?.adaptive,
    stableRadiusSafety: options.turnOptions?.stableRadiusSafety,
    shortSegmentCluster: options.turnOptions?.shortSegmentCluster,
    shortSegmentFactor: options.turnOptions?.shortSegmentFactor,
    maxClusterSpan: options.turnOptions?.maxClusterSpan,
    maxBorrowSpan: options.turnOptions?.maxBorrowSpan,
    maxRiskySequenceSpan: options.turnOptions?.maxRiskySequenceSpan,
  });

  const output: Point[] = [];
  pushDistinct(output, input[0]);

  let cursorDistance = 0;
  const cumulative = polylineCumulativeLengths(input);
  let i = 1;
  while (i < input.length - 1) {
    const turn = turns.get(i) ?? null;
    if (!turn) {
      pushDistinct(output, input[i]);
      cursorDistance = cumulative[i] ?? cursorDistance;
      i += 1;
      continue;
    }

    if (turn.windowStartDistance >= cursorDistance - 1e-6) {
      pushDistinct(output, turn.a);
      if (turn.fitState !== "fallback") {
        for (const point of sampleCenterTurn(turn, samplesPerTurn)) {
          pushDistinct(output, point);
        }
      }
      pushDistinct(output, turn.b);
      cursorDistance = Math.max(cursorDistance, turn.windowEndDistance);
      i = Math.max(i + 1, turn.windowEndIndex);
      continue;
    }

    pushDistinct(output, input[i]);
    cursorDistance = cumulative[i] ?? cursorDistance;
    i += 1;
  }

  pushDistinct(output, input[input.length - 1]);
  return output;
}

export function smoothPathByPoints(points: Point[], tension = 0.5, segments = 12): Point[] {
  const maxOffset = Math.max(4, 12 * Math.max(0.25, tension));
  return buildSkeletonPathByPoints(points, maxOffset, {
    samplesPerTurn: segments * 2,
    turnOptions: { adaptive: false },
  });
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
      color: "rgb(45, 55, 72)",
      zIndex: 5,
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
  const skipTurnIndices = options.skipTurnIndices;
  const adaptive = options.adaptive ?? true;
  const shortSegmentCluster = options.shortSegmentCluster ?? true;

  const angleThreshold = (Math.PI * angleThresholdDeg) / 180;
  const turns = new Map<number, TurnSpec | null>();

  if (n < 3) {
    return turns;
  }

  const clampBase = Math.max(Math.abs(maxOffset), 1);
  const baseRadius = Math.max(clampBase * 2 * radiusFactor, 8, minInnerRadius);
  const minStableRadius = clampBase + (options.stableRadiusSafety ?? Math.max(4, clampBase * 0.15));
  const targetRadius = Math.max(baseRadius, minStableRadius);
  const shortSegmentLength = clampBase * (options.shortSegmentFactor ?? 1.2);
  const maxClusterSpan = options.maxClusterSpan ?? Math.max(clampBase * 5, 140);
  const maxBorrowSpan = options.maxBorrowSpan ?? Math.max(clampBase * 5, 140);
  const maxRiskySequenceSpan = options.maxRiskySequenceSpan ?? Math.max(clampBase * 8, 220);
  const riskySequenceGap = Math.max(clampBase * 6, 180);
  const cumulative = polylineCumulativeLengths(input);
  const totalLength = cumulative[cumulative.length - 1] ?? 0;

  type LocalTurnDraft = {
    idx: number;
    centerDistance: number;
    delta: number;
    sigma: number;
    requiredEll: number;
    localAvailable: number;
  };

  const localTurnDraft = (idx: number): LocalTurnDraft | null => {
    if (idx <= 0 || idx >= n - 1 || skipTurnIndices?.has(idx)) {
      return null;
    }
    const prevSeg = sub(input[idx], input[idx - 1]);
    const nextSeg = sub(input[idx + 1], input[idx]);
    const uLen = length(prevSeg);
    const vLen = length(nextSeg);
    if (uLen <= 1e-6 || vLen <= 1e-6) {
      return null;
    }
    const u = unit(prevSeg);
    const v = unit(nextSeg);
    const dot = Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y));
    const delta = Math.acos(dot);
    const cr = cross2(u, v);
    if (delta < angleThreshold || Math.abs(cr) <= EPS) {
      return null;
    }
    return {
      idx,
      centerDistance: cumulative[idx] ?? 0,
      delta,
      sigma: cr >= 0 ? 1 : -1,
      requiredEll: targetRadius * Math.tan(delta / 2),
      localAvailable: clampRatio * Math.min(uLen, vLen),
    };
  };

  const isRiskyTurnDraft = (draft: LocalTurnDraft): boolean =>
    draft.requiredEll > draft.localAvailable || draft.delta >= Math.PI * 0.72;

  const indexAfterDistance = (value: number): number => {
    for (let index = 1; index < cumulative.length; index += 1) {
      if (cumulative[index] >= value - 1e-6) {
        return index;
      }
    }
    return cumulative.length - 1;
  };

  const makeTurn = (
    idx: number,
    centerDistance: number,
    startDistance: number,
    endDistance: number,
    fitState: TurnSpec["fitState"],
    availableEll: number,
    deltaHint?: number,
    sigmaHint?: number,
    clusterType?: TurnSpec["clusterType"],
  ): TurnSpec | null => {
    const a = pointAtDistance(input, cumulative, startDistance);
    const b = pointAtDistance(input, cumulative, endDistance);
    const u = directionAtDistance(input, cumulative, startDistance, true);
    const v = directionAtDistance(input, cumulative, endDistance, true);
    const dot = Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y));
    const delta = deltaHint ?? Math.acos(dot);
    const cr = cross2(u, v);
    const sigma = sigmaHint ?? (cr >= 0 ? 1 : -1);
    const ell = Math.max(0, Math.min(centerDistance - startDistance, endDistance - centerDistance));
    if (ell <= 1e-6 || delta < angleThreshold || Math.abs(sigma) <= EPS) {
      return null;
    }
    const radius = fitState === "fallback" ? ell / Math.tan(delta / 2) : Math.max(minStableRadius, ell / Math.tan(delta / 2));
    const requiredEll = targetRadius * Math.tan(delta / 2);
    const turn: TurnSpec = {
      idx,
      u,
      v,
      a,
      b,
      delta,
      sigma,
      radius,
      ell,
      minStableRadius,
      targetRadius,
      requiredEll,
      availableEll,
      fitState,
      windowStartIndex: Math.max(0, indexAfterDistance(startDistance) - 1),
      windowEndIndex: indexAfterDistance(endDistance),
      windowStartDistance: startDistance,
      windowEndDistance: endDistance,
      clusterType,
      fallbackResolved: fitState === "fallback" ? true : undefined,
      warning: undefined,
    };
    return turn;
  };

  const clusteredPivots = new Map<number, { startIndex: number; endIndex: number }>();
  if (adaptive && shortSegmentCluster) {
    let segmentIndex = 0;
    while (segmentIndex < n - 1) {
      if (distance(input[segmentIndex], input[segmentIndex + 1]) > shortSegmentLength) {
        segmentIndex += 1;
        continue;
      }
      const startIndex = segmentIndex;
      while (segmentIndex < n - 1 && distance(input[segmentIndex], input[segmentIndex + 1]) <= shortSegmentLength) {
        segmentIndex += 1;
      }
      const endIndex = segmentIndex;
      const segmentCount = endIndex - startIndex;
      const span = (cumulative[endIndex] ?? 0) - (cumulative[startIndex] ?? 0);
      const pivot = startIndex + 1;
      if (
        segmentCount >= 2 &&
        startIndex > 0 &&
        endIndex < n - 1 &&
        pivot > 0 &&
        pivot < n - 1 &&
        span <= maxClusterSpan &&
        !skipTurnIndices?.has(pivot)
      ) {
        clusteredPivots.set(pivot, { startIndex, endIndex });
      }
    }
  }

  const adjacentTurnCluster = (idx: number): TurnSpec | null => {
    if (!adaptive || idx + 1 >= n - 1 || skipTurnIndices?.has(idx + 1) || clusteredPivots.has(idx) || clusteredPivots.has(idx + 1)) {
      return null;
    }

    const before = sub(input[idx], input[idx - 1]);
    const middle = sub(input[idx + 1], input[idx]);
    const after = sub(input[idx + 2], input[idx + 1]);
    const beforeLength = length(before);
    const middleLength = length(middle);
    const afterLength = length(after);
    if (beforeLength <= 1e-6 || middleLength <= 1e-6 || afterLength <= 1e-6 || middleLength > maxClusterSpan) {
      return null;
    }

    const beforeDirection = unit(before);
    const middleDirection = unit(middle);
    const afterDirection = unit(after);
    const firstDelta = Math.acos(Math.max(-1, Math.min(1, beforeDirection.x * middleDirection.x + beforeDirection.y * middleDirection.y)));
    const secondDelta = Math.acos(Math.max(-1, Math.min(1, middleDirection.x * afterDirection.x + middleDirection.y * afterDirection.y)));
    const firstCross = cross2(beforeDirection, middleDirection);
    const secondCross = cross2(middleDirection, afterDirection);
    if (firstDelta < angleThreshold || secondDelta < angleThreshold || Math.abs(firstCross) <= EPS || Math.abs(secondCross) <= EPS) {
      return null;
    }

    const firstSigma = firstCross >= 0 ? 1 : -1;
    const secondSigma = secondCross >= 0 ? 1 : -1;
    if (firstSigma !== secondSigma) {
      return null;
    }

    const firstRequiredEll = targetRadius * Math.tan(firstDelta / 2);
    const secondRequiredEll = targetRadius * Math.tan(secondDelta / 2);
    const firstLocalAvailable = clampRatio * Math.min(beforeLength, middleLength);
    const secondLocalAvailable = clampRatio * Math.min(middleLength, afterLength);
    if (firstRequiredEll <= firstLocalAvailable && secondRequiredEll <= secondLocalAvailable) {
      return null;
    }

    const firstCenterDistance = cumulative[idx] ?? 0;
    const secondCenterDistance = cumulative[idx + 1] ?? firstCenterDistance;
    const searchStart = Math.max(0, firstCenterDistance - Math.min(firstCenterDistance, maxBorrowSpan * 0.5));
    const searchEnd = Math.min(totalLength, secondCenterDistance + Math.min(totalLength - secondCenterDistance, maxBorrowSpan * 0.5));
    const centerDistance = (searchStart + searchEnd) * 0.5;
    const entry = directionAtDistance(input, cumulative, searchStart, true);
    const exit = directionAtDistance(input, cumulative, searchEnd, true);
    const dot = Math.max(-1, Math.min(1, entry.x * exit.x + entry.y * exit.y));
    const delta = Math.acos(dot);
    const requiredEll = targetRadius * Math.tan(delta / 2);
    const minEllToCoverBothTurns = Math.max(centerDistance - firstCenterDistance, secondCenterDistance - centerDistance);
    const availableEll = Math.min(centerDistance - searchStart, searchEnd - centerDistance);
    const desiredEll = Math.max(requiredEll, minEllToCoverBothTurns);
    const fitState: TurnSpec["fitState"] = availableEll >= desiredEll ? "clustered" : "fallback";
    const ell = fitState === "clustered" ? desiredEll : availableEll;
    if (ell <= 1e-6 || ell < minEllToCoverBothTurns - 1e-6) {
      return null;
    }

    return makeTurn(
      idx,
      centerDistance,
      centerDistance - ell,
      centerDistance + ell,
      fitState,
      availableEll,
      delta,
      firstSigma,
      "adjacent",
    );
  };

  const riskySequenceCluster = (idx: number): TurnSpec | null => {
    if (!adaptive || idx >= n - 1 || skipTurnIndices?.has(idx) || clusteredPivots.has(idx)) {
      return null;
    }

    const first = localTurnDraft(idx);
    const second = localTurnDraft(idx + 1);
    if (!first || !second) {
      return null;
    }

    let last = second;
    let hasRiskyTurn = isRiskyTurnDraft(first) || isRiskyTurnDraft(second);
    let maxDelta = Math.max(first.delta, second.delta);
    let sigmaBalance = first.sigma * first.delta + second.sigma * second.delta;

    while (last.idx + 1 < n - 1) {
      const next = localTurnDraft(last.idx + 1);
      if (!next) {
        break;
      }
      const gap = next.centerDistance - last.centerDistance;
      const span = next.centerDistance - first.centerDistance;
      if (gap > riskySequenceGap || span > maxRiskySequenceSpan) {
        break;
      }
      last = next;
      hasRiskyTurn = hasRiskyTurn || isRiskyTurnDraft(next);
      maxDelta = Math.max(maxDelta, next.delta);
      sigmaBalance += next.sigma * next.delta;
    }

    if (!hasRiskyTurn || last.idx === first.idx) {
      return null;
    }

    const firstCenterDistance = first.centerDistance;
    const lastCenterDistance = last.centerDistance;
    const before = Math.min(firstCenterDistance, maxBorrowSpan * 0.5);
    const after = Math.min(totalLength - lastCenterDistance, maxBorrowSpan * 0.5);
    const searchStart = Math.max(0, firstCenterDistance - before);
    const searchEnd = Math.min(totalLength, lastCenterDistance + after);
    const centerDistance = (searchStart + searchEnd) * 0.5;
    const availableEll = Math.min(centerDistance - searchStart, searchEnd - centerDistance);
    const minEllToCoverSequence = Math.max(
      Math.abs(centerDistance - firstCenterDistance),
      Math.abs(lastCenterDistance - centerDistance),
    );
    const entry = directionAtDistance(input, cumulative, searchStart, true);
    const exit = directionAtDistance(input, cumulative, searchEnd, true);
    const dot = Math.max(-1, Math.min(1, entry.x * exit.x + entry.y * exit.y));
    const entryExitDelta = Math.acos(dot);
    const delta = Math.max(entryExitDelta, Math.min(Math.PI - 1e-4, maxDelta));
    const requiredEll = targetRadius * Math.tan(delta / 2);
    const desiredEll = Math.max(requiredEll, minEllToCoverSequence);
    const fitState: TurnSpec["fitState"] = availableEll >= desiredEll ? "clustered" : "fallback";
    const ell = fitState === "clustered" ? desiredEll : availableEll;
    if (ell <= 1e-6 || ell < minEllToCoverSequence - 1e-6) {
      return null;
    }

    return makeTurn(
      idx,
      centerDistance,
      centerDistance - ell,
      centerDistance + ell,
      fitState,
      availableEll,
      delta,
      sigmaBalance >= 0 ? 1 : -1,
      maxDelta >= Math.PI * 0.72 ? "u-turn" : "sequence",
    );
  };

  for (let i = 1; i < n - 1; i += 1) {
    if (skipTurnIndices?.has(i)) {
      turns.set(i, null);
      continue;
    }

    const cluster = clusteredPivots.get(i);
    if (cluster) {
      const startDistance = cumulative[cluster.startIndex] ?? 0;
      const endDistance = cumulative[cluster.endIndex] ?? startDistance;
      const centerDistance = (startDistance + endDistance) * 0.5;
      const entry = directionAtDistance(input, cumulative, startDistance, true);
      const exit = directionAtDistance(input, cumulative, endDistance, true);
      const dot = Math.max(-1, Math.min(1, entry.x * exit.x + entry.y * exit.y));
      const delta = Math.acos(dot);
      const cr = cross2(entry, exit);
      const requiredEll = targetRadius * Math.tan(delta / 2);
      const availableEll = Math.min(centerDistance - startDistance, endDistance - centerDistance);
      const fitState: TurnSpec["fitState"] = availableEll >= requiredEll ? "clustered" : "fallback";
      const ell = fitState === "clustered" ? requiredEll : availableEll;
      const turn = makeTurn(
        i,
        centerDistance,
        centerDistance - ell,
        centerDistance + ell,
        fitState,
        availableEll,
        delta,
        cr >= 0 ? 1 : -1,
        "short-segment",
      );
      turns.set(i, turn);
      if (turn) {
        i = Math.max(i, cluster.endIndex - 1);
      }
      continue;
    }

    const sequenceCluster = riskySequenceCluster(i);
    if (sequenceCluster) {
      turns.set(i, sequenceCluster);
      i = Math.max(i + 1, sequenceCluster.windowEndIndex - 1);
      continue;
    }

    const adjacentCluster = adjacentTurnCluster(i);
    if (adjacentCluster) {
      turns.set(i, adjacentCluster);
      i += 1;
      continue;
    }

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
    const requiredEll = targetRadius * Math.tan(delta / 2);
    const localAvailable = clampRatio * Math.min(uLen, vLen);
    const centerDistance = cumulative[i] ?? 0;
    const localCanFit = requiredEll <= localAvailable;
    let fitState: TurnSpec["fitState"] = localCanFit || !adaptive ? "normal" : "borrowed";
    let availableEll = localAvailable;
    let ell = Math.min(requiredEll, localAvailable);

    if (adaptive && !localCanFit) {
      const before = Math.min(centerDistance, maxBorrowSpan * 0.5);
      const after = Math.min(totalLength - centerDistance, maxBorrowSpan * 0.5);
      availableEll = Math.min(before, after);
      if (availableEll >= requiredEll) {
        ell = requiredEll;
        fitState = "borrowed";
      } else {
        ell = Math.max(0, availableEll);
        fitState = "fallback";
      }
    }

    if (ell <= 1e-6) {
      turns.set(i, null);
      continue;
    }

    const turn = makeTurn(
      i,
      centerDistance,
      centerDistance - ell,
      centerDistance + ell,
      fitState,
      availableEll,
      delta,
      sigma,
      fitState === "fallback" && delta >= Math.PI * 0.72 ? "u-turn" : undefined,
    );
    turns.set(i, turn);
  }

  return turns;
}

export function sampleOffsetTurnCurve(turn: TurnSpec, q: number, samples = 24): Point[] {
  const sampleCount = adaptiveTurnSamples(turn, samples);
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

  const cumulative = polylineCumulativeLengths(cleaned);
  let cursorDistance = 0;
  let i = 1;
  while (i < n - 1) {
    const prev = cleaned[i - 1];
    const cur = cleaned[i];
    const next = cleaned[i + 1];
    const turn = turns.get(i) || null;

    if (turn && turn.windowStartDistance >= cursorDistance - 1e-6) {
      const curve = turn.fitState === "fallback" ? [] : sampleOffsetTurnCurve(turn, q, samplesPerTurn);
      if (curve.length >= 2) {
        if (distance(curve[0], out[out.length - 1]) < 1e-6) {
          out.push(...curve.slice(1));
        } else {
          out.push(...curve);
        }
        cursorDistance = Math.max(cursorDistance, turn.windowEndDistance);
        i = Math.max(i + 1, turn.windowEndIndex);
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
    cursorDistance = cumulative[i] ?? cursorDistance;
    i += 1;
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
