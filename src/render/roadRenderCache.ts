import type { RoadPenScene } from "../types";
import { buildRoadBandPolygons, buildRoadPaintCache, type RoadBandData, type RoadPaintCache } from "./roadRenderer";

export interface RoadGeometryRenderCache {
  geometryVersion: number;
  roadData: RoadBandData;
  visibleCacheByMode: Map<string, RoadPaintCache>;
}

export function roadPaintCacheKey(isolatedJunctionBlockId: string | null | undefined): string {
  return isolatedJunctionBlockId ? `junction:${isolatedJunctionBlockId}` : "normal";
}

export function getRoadGeometryCache(
  existing: RoadGeometryRenderCache | null,
  scene: RoadPenScene,
  geometryVersion: number,
  buildGeometry: (scene: RoadPenScene) => RoadBandData = buildRoadBandPolygons,
): RoadGeometryRenderCache {
  if (existing && existing.geometryVersion === geometryVersion) {
    return existing;
  }

  return {
    geometryVersion,
    roadData: buildGeometry(scene),
    visibleCacheByMode: new Map(),
  };
}

export function getRoadPaintCache(
  geometryCache: RoadGeometryRenderCache,
  isolatedJunctionBlockId: string | null | undefined,
  buildPaint: (roadData: RoadBandData, isolatedJunctionBlockId?: string | null) => RoadPaintCache = buildRoadPaintCache,
): RoadPaintCache {
  const key = roadPaintCacheKey(isolatedJunctionBlockId);
  const existing = geometryCache.visibleCacheByMode.get(key);
  if (existing) {
    return existing;
  }

  const paintCache = buildPaint(geometryCache.roadData, isolatedJunctionBlockId ?? null);
  geometryCache.visibleCacheByMode.set(key, paintCache);
  return paintCache;
}
