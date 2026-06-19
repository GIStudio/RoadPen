import { describe, expect, test } from "vitest";
import { getRoadGeometryCache, getRoadPaintCache } from "../src/render/roadRenderCache";
import { buildRoadBandPolygons, buildRoadPaintCache } from "../src/render/roadRenderer";
import type { RoadPenScene } from "../src/types";

function smallJunctionScene(): RoadPenScene {
  return {
    version: "1.0.0",
    units: "px",
    scalePxPerM: 20,
    nodes: [
      { id: "center", x: 0, y: 0 },
      { id: "west", x: -100, y: 0 },
      { id: "east", x: 100, y: 0 },
      { id: "north", x: 0, y: -100 },
      { id: "south", x: 0, y: 100 },
    ],
    edges: [
      { id: "west-road", from: "center", to: "west", geomType: "polyline", profileId: "default", controlPoints: [{ x: 0, y: 0 }, { x: -100, y: 0 }] },
      { id: "east-road", from: "center", to: "east", geomType: "polyline", profileId: "default", controlPoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
      { id: "north-road", from: "center", to: "north", geomType: "polyline", profileId: "default", controlPoints: [{ x: 0, y: 0 }, { x: 0, y: -100 }] },
      { id: "south-road", from: "center", to: "south", geomType: "polyline", profileId: "default", controlPoints: [{ x: 0, y: 0 }, { x: 0, y: 100 }] },
    ],
    profiles: [
      {
        id: "default",
        name: "default",
        carriagewayWidth: 24,
        facilityWidth: 4,
        sidewalkWidth: 8,
        clearanceWidth: 4,
      },
    ],
  };
}

describe("road render cache", () => {
  test("同一 sceneGeometryVersion 下 geometry 只构建一次", () => {
    const scene = smallJunctionScene();
    let buildCount = 0;
    const buildGeometry = () => {
      buildCount += 1;
      return buildRoadBandPolygons(scene);
    };

    let cache = getRoadGeometryCache(null, scene, 0, buildGeometry);
    cache = getRoadGeometryCache(cache, scene, 0, buildGeometry);
    cache = getRoadGeometryCache(cache, scene, 0, buildGeometry);

    expect(buildCount).toBe(1);
    expect(cache.geometryVersion).toBe(0);
  });

  test("sceneGeometryVersion 变化后 geometry cache 会重建", () => {
    const scene = smallJunctionScene();
    let buildCount = 0;
    const buildGeometry = () => {
      buildCount += 1;
      return buildRoadBandPolygons(scene);
    };

    let cache = getRoadGeometryCache(null, scene, 0, buildGeometry);
    cache = getRoadGeometryCache(cache, scene, 1, buildGeometry);

    expect(buildCount).toBe(2);
    expect(cache.geometryVersion).toBe(1);
  });

  test("normal 与 isolated junction paint cache 分开缓存", () => {
    const scene = smallJunctionScene();
    const geometryCache = getRoadGeometryCache(null, scene, 0);
    const isolatedJunctionBlockId = geometryCache.roadData.junctionBlocks[0]?.id;
    let paintBuildCount = 0;
    const buildPaint = (roadData: typeof geometryCache.roadData, isolatedJunctionBlockId?: string | null) => {
      paintBuildCount += 1;
      return buildRoadPaintCache(roadData, isolatedJunctionBlockId ?? null);
    };

    const normalA = getRoadPaintCache(geometryCache, null, buildPaint);
    const normalB = getRoadPaintCache(geometryCache, null, buildPaint);
    expect(normalA).toBe(normalB);
    expect(paintBuildCount).toBe(1);

    expect(isolatedJunctionBlockId).toBeTruthy();
    const isolatedA = getRoadPaintCache(geometryCache, isolatedJunctionBlockId, buildPaint);
    const isolatedB = getRoadPaintCache(geometryCache, isolatedJunctionBlockId, buildPaint);
    expect(isolatedA).toBe(isolatedB);
    expect(paintBuildCount).toBe(2);
    expect(isolatedA.allPolygons.length).toBeLessThanOrEqual(normalA.allPolygons.length);
  });
});
