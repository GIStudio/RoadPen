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
});
