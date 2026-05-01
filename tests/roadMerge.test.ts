import { describe, expect, test } from "vitest";
import { multiPolygonToRings, mergeRoadJunction } from "../src/geometry/roadMerge";

interface Point {
  x: number;
  y: number;
}

function polygonArea(ring: Point[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area * 0.5);
}

function totalArea(rings: Point[][]): number {
  return rings.reduce((sum, ring) => {
    return sum + (ring.length >= 3 ? polygonArea(ring) : 0);
  }, 0);
}

describe("roadMerge", () => {
  test("吸附并道将相邻矩形合并为单体", () => {
    const left = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 0, y: 1 },
    ];
    const right = [
      { x: 2, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 1 },
      { x: 2, y: 1 },
    ];

    const merged = mergeRoadJunction([left, right]);
    expect(merged).toHaveLength(1);
    const rings = multiPolygonToRings(merged);
    expect(rings.length).toBe(1);
    expect(rings[0].length).toBeGreaterThan(0);
    const mergedRings = rings.flat();
    expect(totalArea(mergedRings)).toBeCloseTo(4, 6);
  });
});
