import type { Point, RoadEdge, RoadPenScene } from "../types";
import { buildLaneBandsForProfile, distance } from "./roadGeometry";

export interface RoadPickHit {
  edgeId: string;
  distance: number;
  threshold: number;
  point: Point;
  segmentIndex: number;
}

type ProfileMap = Map<string, { carriagewayWidth: number; facilityWidth: number; sidewalkWidth: number; clearanceWidth: number }>;

const PICK_TOLERANCE_PX = 6;
const EPS = 1e-9;

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

function profileMaxOffset(profileId: string, profileMap: ProfileMap): number {
  const bands = buildLaneBandsForProfile(profileId, profileMap);
  return Math.max(0, ...bands.map((band) => Math.max(Math.abs(band.qInner), Math.abs(band.qOuter))));
}

function closestPointOnSegment(point: Point, a: Point, b: Point): { point: Point; distance: number } {
  const ab = { x: b.x - a.x, y: b.y - a.y };
  const lenSq = ab.x * ab.x + ab.y * ab.y;
  if (lenSq <= EPS) {
    return { point: { ...a }, distance: distance(point, a) };
  }

  const t = Math.max(0, Math.min(1, ((point.x - a.x) * ab.x + (point.y - a.y) * ab.y) / lenSq));
  const projected = { x: a.x + ab.x * t, y: a.y + ab.y * t };
  return { point: projected, distance: distance(point, projected) };
}

function bestHitOnEdge(edge: RoadEdge, point: Point, threshold: number): RoadPickHit | null {
  if (edge.controlPoints.length < 2) {
    return null;
  }

  let best: RoadPickHit | null = null;
  for (let i = 0; i < edge.controlPoints.length - 1; i += 1) {
    const candidate = closestPointOnSegment(point, edge.controlPoints[i], edge.controlPoints[i + 1]);
    if (candidate.distance > threshold) {
      continue;
    }
    if (!best || candidate.distance < best.distance) {
      best = {
        edgeId: edge.id,
        distance: candidate.distance,
        threshold,
        point: candidate.point,
        segmentIndex: i,
      };
    }
  }

  return best;
}

export function findRoadAtPoint(scene: RoadPenScene, point: Point, tolerancePx = PICK_TOLERANCE_PX): RoadPickHit | null {
  const profileMap = profileMapFromScene(scene);
  let best: RoadPickHit | null = null;

  for (const edge of scene.edges) {
    const threshold = profileMaxOffset(edge.profileId, profileMap) + tolerancePx;
    const hit = bestHitOnEdge(edge, point, threshold);
    if (!hit) {
      continue;
    }
    if (!best || hit.distance < best.distance) {
      best = hit;
    }
  }

  return best;
}
