import { describe, expect, test } from "vitest";
import {
  buildBandPolygon,
  buildSkeletonPathByPoints,
  buildSmoothBandPolygon,
  computeTurnSpecs,
  smoothPathByPoints,
} from "../src/geometry/roadGeometry";
import type { Point } from "../src/types";

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return abC * abD < 0 && cdA * cdB < 0;
}

function hasSelfIntersection(points: Point[]): boolean {
  const ring =
    points.length > 1 &&
    Math.abs(points[0].x - points[points.length - 1].x) < 1e-6 &&
    Math.abs(points[0].y - points[points.length - 1].y) < 1e-6
      ? points.slice(0, -1)
      : points;

  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    for (let j = i + 1; j < ring.length; j += 1) {
      const adjacent = Math.abs(i - j) <= 1 || (i === 0 && j === ring.length - 1);
      if (adjacent) {
        continue;
      }
      const c = ring[j];
      const d = ring[(j + 1) % ring.length];
      if (segmentsIntersect(a, b, c, d)) {
        return true;
      }
    }
  }

  return false;
}

describe("roadGeometry", () => {
  test("两个点应生成笔直道路面", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const polygon = buildBandPolygon(points, new Map(), -12, 12);

    expect(polygon).toEqual([
      { x: 0, y: 12 },
      { x: 100, y: 12 },
      { x: 100, y: -12 },
      { x: 0, y: -12 },
      { x: 0, y: 12 },
    ]);
    expect(hasSelfIntersection(polygon)).toBe(false);
  });

  test("直线控制点应平滑后保持同一直线", () => {
    const line: Point[] = [
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 20, y: 10 },
    ];
    const curve = smoothPathByPoints(line, 0.5, 8);
    expect(curve[0]).toEqual({ x: 0, y: 10 });
    expect(curve[curve.length - 1]).toEqual({ x: 20, y: 10 });
    for (const p of curve) {
      expect(Math.abs(p.y - 10)).toBeLessThan(1e-6);
    }
  });

  test("曲线路径应生成非零曲率样条点", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 10 },
    ];
    const curve = smoothPathByPoints(points, 0.5, 10);
    expect(curve.length).toBeGreaterThan(points.length);
    expect(curve.some((point) => point.y > 0)).toBe(true);
    expect(curve.some((point) => point.y < 10)).toBe(true);
  });

  test("三点曲线应将中间点作为控制点而非折线路径点", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 50, y: 100 },
      { x: 100, y: 0 },
    ];
    const curve = smoothPathByPoints(points, 0.5, 10);

    expect(curve[0]).toEqual(points[0]);
    expect(curve[curve.length - 1]).toEqual(points[2]);
    expect(curve.some((point) => point.y > 40)).toBe(true);
    expect(curve.some((point) => Math.abs(point.x - 50) < 1e-6 && Math.abs(point.y - 100) < 1e-6)).toBe(false);
  });

  test("三点骨架应保留两端直线，只在拐点附近生成转弯段", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ];
    const path = buildSkeletonPathByPoints(points, 12, { samplesPerTurn: 12 });

    expect(path[0]).toEqual(points[0]);
    expect(path[path.length - 1]).toEqual(points[2]);
    expect(path.some((point) => Math.abs(point.x - 100) < 1e-6 && Math.abs(point.y) < 1e-6)).toBe(false);
    expect(path[1].x).toBeGreaterThan(40);
    expect(Math.abs(path[1].y)).toBeLessThan(1e-6);
    expect(path.some((point) => Math.abs(point.x - 100) < 1e-6 && point.y > 40)).toBe(true);
  });

  test("三点弯道展开成道路面时不应产生自交 polygon", () => {
    const points: Point[] = [
      { x: 258.152, y: 204.828 },
      { x: 324.602, y: 477.234 },
      { x: 614.902, y: 462.652 },
    ];
    const centerline = smoothPathByPoints(points, 0.5, 14);
    const polygon = buildSmoothBandPolygon(centerline, -12, 12);

    expect(polygon.length).toBeGreaterThan(3);
    expect(hasSelfIntersection(polygon)).toBe(false);
  });

  test("转折分析应可返回告警或合法转角", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 40, y: 1 },
      { x: 60, y: 0 },
    ];
    const turns = computeTurnSpecs(points, 1.5, { angleThresholdDeg: 1, minInnerRadius: 0.1 });
    expect(turns.size).toBe(2);
    expect([...turns.values()].some((spec) => spec === null || Boolean(spec))).toBe(true);
  });

  test("短相邻段有外部空间时应借用 turn window 保持稳定半径", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      { x: 84, y: 0 },
      { x: 84, y: 80 },
    ];
    const turns = computeTurnSpecs(points, 8, { angleThresholdDeg: 1 });
    const turn = turns.get(2);

    expect(turn?.fitState).toBe("borrowed");
    expect(turn?.radius).toBeGreaterThanOrEqual(turn?.minStableRadius ?? Number.POSITIVE_INFINITY);
    expect(turn?.availableEll).toBeGreaterThanOrEqual(turn?.requiredEll ?? Number.POSITIVE_INFINITY);
  });

  test("连续短 zigzag 应聚合为 clustered turn 并跳过内部控制点", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      { x: 86, y: 3 },
      { x: 80, y: 6 },
      { x: 86, y: 9 },
      { x: 80, y: 12 },
      { x: 86, y: 15 },
      { x: 160, y: 15 },
    ];
    const turns = computeTurnSpecs(points, 6, { angleThresholdDeg: 1 });
    const clustered = [...turns.values()].find((turn) => turn?.fitState === "clustered");
    const skeleton = buildSkeletonPathByPoints(points, 6, { samplesPerTurn: 12, turnOptions: { angleThresholdDeg: 1 } });

    expect(clustered).toBeTruthy();
    expect(clustered?.windowEndIndex).toBeGreaterThan(clustered?.idx ?? 0);
    expect(skeleton.some((point) => Math.abs(point.x - 86) < 1e-6 && Math.abs(point.y - 3) < 1e-6)).toBe(false);
  });

  test("空间不足的短转弯应标记 fallback 而不是生成负 offset 半径", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 8, y: 0 },
      { x: 8, y: 8 },
      { x: 16, y: 8 },
    ];
    const turns = computeTurnSpecs(points, 20, { angleThresholdDeg: 1, maxBorrowSpan: 24, shortSegmentCluster: false });
    const fallback = [...turns.values()].find((turn) => turn?.fitState === "fallback");

    expect(fallback).toBeTruthy();
    expect(fallback?.radius).toBeGreaterThan(0);
    expect(fallback?.radius).toBeLessThan(fallback?.minStableRadius ?? 0);
  });

  test("连续同向急转应合并为一个 turn window，避免双 fallback 互相裁切", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 120, y: 0 },
      { x: 170, y: 50 },
      { x: 120, y: 100 },
    ];
    const turns = computeTurnSpecs(points, 28, { angleThresholdDeg: 1 });
    const turnSpecs = [...turns.values()].filter(Boolean);
    const skeleton = buildSkeletonPathByPoints(points, 28, { samplesPerTurn: 12, turnOptions: { angleThresholdDeg: 1 } });

    expect(turnSpecs).toHaveLength(1);
    expect(turnSpecs[0]?.fitState).toMatch(/clustered|fallback/);
    expect(turnSpecs[0]?.windowEndIndex).toBeGreaterThan(2);
    expect(skeleton.some((point) => Math.abs(point.x - 170) < 1e-6 && Math.abs(point.y - 50) < 1e-6)).toBe(false);
  });

  test("V 型自折返应进入 u-turn fallback，而不是生成极小正常转弯", () => {
    const points: Point[] = [
      { x: 1529.38, y: 102.26 },
      { x: 1389.16, y: 229.32 },
      { x: 1594.78, y: 100.13 },
    ];
    const turns = computeTurnSpecs(points, 28, { angleThresholdDeg: 1 });
    const turn = turns.get(1);
    const skeleton = buildSkeletonPathByPoints(points, 28, { samplesPerTurn: 12, turnOptions: { angleThresholdDeg: 1 } });

    expect(turn?.fitState).toBe("fallback");
    expect(turn?.clusterType).toBe("u-turn");
    expect(turn?.fallbackResolved).toBe(true);
    expect(turn?.radius).toBeGreaterThan(0);
    expect(turn?.radius).toBeLessThan(turn?.minStableRadius ?? 0);
    expect(skeleton.some((point) => Math.abs(point.x - points[1].x) < 1e-6 && Math.abs(point.y - points[1].y) < 1e-6)).toBe(false);
  });

  test("连续风险折线应合并为 sequence window，避免多个 fallback 独立裁切", () => {
    const points: Point[] = [
      { x: 341.3, y: 173.96 },
      { x: 427.23, y: 203.97 },
      { x: 547.38, y: 245.92 },
      { x: 414.97, y: 306.2 },
      { x: 182.09, y: 412.21 },
      { x: 398.56, y: 443.04 },
      { x: 540.59, y: 463.27 },
      { x: 386.21, y: 545.99 },
      { x: 236.15, y: 626.4 },
    ];
    const turns = computeTurnSpecs(points, 28, { angleThresholdDeg: 1 });
    const turnSpecs = [...turns.values()].filter(Boolean);
    const sequence = turnSpecs.find((turn) => turn?.clusterType === "sequence" || turn?.clusterType === "u-turn");

    expect(sequence).toBeTruthy();
    expect(sequence?.windowEndIndex).toBeGreaterThan(sequence?.idx ?? 0);
    expect(turnSpecs.length).toBeLessThan(points.length - 2);
  });
});
