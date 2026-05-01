import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";
import type { Point } from "../types";

type PointRing = Point[];
type RingCoords = [number, number][];

function ringToPolygon(ring: PointRing): Polygon {
  if (ring.length < 3) {
    return [];
  }

  const closed = [...ring];
  const first = closed[0];
  const last = closed[closed.length - 1];
  if (Math.abs(first.x - last.x) > 1e-6 || Math.abs(first.y - last.y) > 1e-6) {
    closed.push({ ...first });
  }

  const ringCoords: RingCoords = closed.map((p) => [p.x, p.y]);
  return [ringCoords];
}

export function mergeRoadJunction(polygons: PointRing[]): MultiPolygon {
  let result: MultiPolygon = [];

  for (const polygon of polygons) {
    const asMulti = ringToPolygon(polygon);
    if (asMulti.length === 0) {
      continue;
    }

    if (result.length === 0) {
      result = [asMulti];
      continue;
    }

    try {
      result = polygonClipping.union(result, asMulti) as MultiPolygon;
    } catch {
      continue;
    }
  }

  if (result.length === 0) {
    return [];
  }

  return result;
}

export function multiPolygonToRings(polygons: MultiPolygon): PointRing[][] {
  if (!polygons || polygons.length === 0) {
    return [];
  }

  const rings: PointRing[][] = [];
  for (const poly of polygons) {
    const polyRings: PointRing[] = [];
    for (const ring of poly) {
      if (ring.length < 3) {
        continue;
      }
      const ringPts = ring.map((pt) => ({ x: pt[0], y: pt[1] }));
      const first = ringPts[0];
      const last = ringPts[ringPts.length - 1];
      if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) {
        ringPts.pop();
      }
      if (ringPts.length >= 3) {
        polyRings.push(ringPts);
      }
    }
    if (polyRings.length > 0) {
      rings.push(polyRings);
    }
  }

  return rings;
}
