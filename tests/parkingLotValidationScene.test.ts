import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { buildParkingLotValidationScene, PARKING_LOT_VALIDATION_SOURCE } from "../src/fixtures/parkingLotValidationScene";
import { exportScene, parseRoadPenScene } from "../src/io/io";
import { bandBucketKey, buildRoadBandPolygons } from "../src/render/roadRenderer";
import type { Point } from "../src/types";
import { renderRoadSceneAtlasPng, renderRoadScenePng, splitSceneIntoSpatialPanels } from "./helpers/renderRoadScenePng";

const PNG_OUTPUT_PATH = resolve("test-artifacts/parking-lot-validation.png");
const ATLAS_OUTPUT_PATH = resolve("test-artifacts/parking-lot-validation-atlas.png");
const ATLAS_JSON_OUTPUT_PATH = resolve("test-artifacts/parking-lot-validation-atlas.json");
const OUTER_SEMANTIC_BANDS = ["facility", "sidewalk", "clearance"] as const;

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const ab = { x: b.x - a.x, y: b.y - a.y };
  const lenSq = ab.x * ab.x + ab.y * ab.y;
  if (lenSq <= 1e-9) {
    return Math.hypot(point.x - a.x, point.y - a.y);
  }
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * ab.x + (point.y - a.y) * ab.y) / lenSq));
  const projected = { x: a.x + ab.x * t, y: a.y + ab.y * t };
  return Math.hypot(point.x - projected.x, point.y - projected.y);
}

function ringContainsPoint(ring: Point[], point: Point): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    const intersects = a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-9) + a.x;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonTouchesProbe(polygon: Point[], probe: Point, radius: number): boolean {
  if (ringContainsPoint(polygon, probe)) {
    return true;
  }
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (Math.hypot(a.x - probe.x, a.y - probe.y) <= radius || distanceToSegment(probe, a, b) <= radius) {
      return true;
    }
  }
  return false;
}

function polygonArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function bridgeConnects(
  bridge: { fromJunctionBlockId?: string; toJunctionBlockId?: string },
  a: string,
  b: string,
): boolean {
  return (
    (bridge.fromJunctionBlockId === a && bridge.toJunctionBlockId === b) ||
    (bridge.fromJunctionBlockId === b && bridge.toJunctionBlockId === a)
  );
}

describe("parking lot validation scene", () => {
  test("项目内固定验证场景应来自保存的 RoadPen 导出文件", () => {
    const scene = buildParkingLotValidationScene();

    expect(PARKING_LOT_VALIDATION_SOURCE.fileName).toBe("parkingLotValidationScene.roadpen.json");
    expect(PARKING_LOT_VALIDATION_SOURCE.exportedAt).toBe("2026-06-14T09:42:51.708Z");
    expect(PARKING_LOT_VALIDATION_SOURCE.nodeCount).toBe(39);
    expect(PARKING_LOT_VALIDATION_SOURCE.edgeCount).toBe(42);
    expect(PARKING_LOT_VALIDATION_SOURCE.profileCount).toBe(1);
    expect(PARKING_LOT_VALIDATION_SOURCE.layers).toEqual([0]);
    expect(scene.nodes).toHaveLength(PARKING_LOT_VALIDATION_SOURCE.nodeCount);
    expect(scene.edges).toHaveLength(PARKING_LOT_VALIDATION_SOURCE.edgeCount);
  });

  test("固定验证场景应可导出导入往返", () => {
    const scene = buildParkingLotValidationScene();
    const { scene: imported, warnings } = parseRoadPenScene(exportScene(scene));

    expect(warnings).toHaveLength(0);
    expect(imported.nodes.map((node) => node.id)).toEqual(scene.nodes.map((node) => node.id));
    expect(imported.edges.map((edge) => edge.id)).toEqual(scene.edges.map((edge) => edge.id));
    expect(imported.edges.map((edge) => edge.layer)).toEqual(scene.edges.map((edge) => edge.layer));
  });

  test("固定验证场景应能生成道路 band、路口块和诊断计数", () => {
    const data = buildRoadBandPolygons(buildParkingLotValidationScene());

    expect(data.bandBuckets.get(bandBucketKey(0, "carriageway"))?.polygons.length).toBeGreaterThan(0);
    expect(data.bandBuckets.get(bandBucketKey(0, "facility"))?.polygons.length).toBeGreaterThan(0);
    expect(data.bandBuckets.get(bandBucketKey(0, "sidewalk"))?.polygons.length).toBeGreaterThan(0);
    expect(data.bandBuckets.get(bandBucketKey(0, "clearance"))?.polygons.length).toBeGreaterThan(0);
    expect(data.junctionBlocks.length).toBeGreaterThan(0);
    expect(data.geometryIssues.markers.length).toBeGreaterThan(0);
    expect(data.geometryIssues.counts.junctionSurfaceGapCandidate).toBeGreaterThan(0);
    expect(data.geometryIssues.counts.outerLaneCoverageGap).toBeGreaterThan(0);
    expect(data.geometryIssues.counts.extremeTurnFallback).toBeGreaterThan(0);
    expect(data.geometryIssues.counts.selfOverlapCandidate).toBeGreaterThan(0);
    expect(data.geometryIssues.counts.localZOrderApplied).toBeGreaterThan(0);
  });

  test("S04 极限转弯 fallback 应是连续面而不是一排分段梯形", () => {
    const data = buildRoadBandPolygons(buildParkingLotValidationScene());
    const s04Fallbacks = data.extremeTurnFallbacks.filter((fallback) => fallback.edgeIds.includes("e-42"));
    const fallbackCountsByBandAndTurn = new Map<string, number>();

    expect(s04Fallbacks.length).toBeGreaterThan(0);
    expect(s04Fallbacks.length).toBeLessThanOrEqual(7);

    for (const fallback of s04Fallbacks) {
      const key = `${fallback.bandId}:${fallback.turnIndex}`;
      fallbackCountsByBandAndTurn.set(key, (fallbackCountsByBandAndTurn.get(key) ?? 0) + 1);
      expect(fallback.polygon.length).toBeGreaterThan(8);
    }
    expect([...fallbackCountsByBandAndTurn.values()].every((count) => count === 1)).toBe(true);
  });

  test("极限折返 fallback 应被 closure 处理，不进入普通 warning 面板", () => {
    const data = buildRoadBandPolygons(buildParkingLotValidationScene());
    const riskyTurnChains = data.edgeCenterlines.filter((chain) => chain.edgeIds.some((edgeId) => edgeId === "e-41" || edgeId === "e-42"));
    const riskyTurns = riskyTurnChains.flatMap((chain) => chain.turns);
    const fallbackPatches = data.extremeTurnFallbacks.filter((fallback) =>
      fallback.edgeIds.some((edgeId) => edgeId === "e-41" || edgeId === "e-42"),
    );

    expect(riskyTurns.some((turn) => turn.fitState === "fallback" && turn.clusterType === "u-turn" && turn.fallbackResolved)).toBe(true);
    expect(fallbackPatches.length).toBeGreaterThan(0);
    for (const patch of fallbackPatches) {
      expect(Math.abs(polygonArea(patch.polygon))).toBeGreaterThan(10);
    }
    expect(data.warnings.some((warning) => warning.includes("转折过急") || warning.includes("自适应转弯 fallback"))).toBe(false);
  });

  test("lane stop 裁剪点应保持在所属路口 node 附近", () => {
    const scene = buildParkingLotValidationScene();
    const nodeMap = new Map(scene.nodes.map((node) => [node.id, node]));
    const data = buildRoadBandPolygons(scene);

    for (const stop of data.laneStops) {
      const node = nodeMap.get(stop.nodeId);
      expect(node).toBeTruthy();
      if (!node) {
        continue;
      }
      const distanceToNode = Math.hypot(stop.point.x - node.x, stop.point.y - node.y);
      expect(distanceToNode).toBeLessThanOrEqual(120);
    }
  });

  test("vc-7 小半径蛇形路的外侧 lane 在 sharp turn probe 周边不应完全缺失", () => {
    const data = buildRoadBandPolygons(buildParkingLotValidationScene());
    const probes: Point[] = [
      { x: 547.3828125, y: 245.92189025878906 },
      { x: 182.08984375, y: 412.2109375 },
      { x: 540.5859375, y: 463.265625 },
    ];

    for (const semanticBand of OUTER_SEMANTIC_BANDS) {
      const bucket = data.bandBuckets.get(bandBucketKey(0, semanticBand));
      expect(bucket?.polygons.length).toBeGreaterThan(0);
      for (const probe of probes) {
        const covered = bucket?.polygons.some((polygon) => polygonTouchesProbe(polygon, probe, 64)) ?? false;
        if (!covered) {
          throw new Error(`${semanticBand} lane is missing around vc-7 probe (${probe.x}, ${probe.y})`);
        }
      }
    }
  });

  test("连续路口 n-20..n-23 之间应生成 outer lane bridge patch", () => {
    const data = buildRoadBandPolygons(buildParkingLotValidationScene());
    const expectedPairs = [
      ["junction-n-20", "junction-n-21"],
      ["junction-n-21", "junction-n-22"],
      ["junction-n-22", "junction-n-23"],
    ] as const;

    for (const [from, to] of expectedPairs) {
      for (const semanticBand of OUTER_SEMANTIC_BANDS) {
        const hasBridge = data.outerLaneBridges.some((bridge) => bridge.semanticBandId === semanticBand && bridgeConnects(bridge, from, to));
        if (!hasBridge) {
          throw new Error(`${semanticBand} bridge is missing between ${from} and ${to}`);
        }
      }
    }
  });

  test("固定验证场景应能渲染并导出 PNG artifact", () => {
    const result = renderRoadScenePng(buildParkingLotValidationScene(), PNG_OUTPUT_PATH);
    const bytes = readFileSync(PNG_OUTPUT_PATH);

    expect(existsSync(PNG_OUTPUT_PATH)).toBe(true);
    expect(result.width).toBeGreaterThan(300);
    expect(result.height).toBeGreaterThan(200);
    expect(result.bytes).toBe(bytes.length);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(bytes.length).toBeGreaterThan(10_000);
  }, 15_000);

  test("固定验证场景应能按空间子图渲染 atlas PNG artifact", () => {
    const scene = buildParkingLotValidationScene();
    const panels = splitSceneIntoSpatialPanels(scene);
    const result = renderRoadSceneAtlasPng(scene, ATLAS_OUTPUT_PATH, {
      columns: 3,
      cellWidth: 420,
      cellHeight: 300,
      jsonOutputPath: ATLAS_JSON_OUTPUT_PATH,
    });
    const bytes = readFileSync(ATLAS_OUTPUT_PATH);
    const atlasJson = JSON.parse(readFileSync(ATLAS_JSON_OUTPUT_PATH, "utf8")) as typeof result;

    expect(panels.length).toBeGreaterThan(1);
    expect(result.panelCount).toBe(panels.length);
    expect(result.panels.every((panel) => panel.edgeIds.length > 0)).toBe(true);
    expect(existsSync(ATLAS_OUTPUT_PATH)).toBe(true);
    expect(existsSync(ATLAS_JSON_OUTPUT_PATH)).toBe(true);
    expect(result.width).toBeGreaterThan(800);
    expect(result.height).toBeGreaterThan(300);
    expect(result.bytes).toBe(bytes.length);
    expect(result.jsonBytes).toBeGreaterThan(1_000);
    expect(atlasJson.panelCount).toBe(result.panelCount);
    expect(atlasJson.panels[0].issueCounts.outerLaneCoverageGap).toBeGreaterThan(0);
    expect(atlasJson.panels.some((panel) => panel.issueCounts.extremeTurnFallback > 0)).toBe(true);
    expect(atlasJson.panels.some((panel) => panel.issueCounts.selfOverlapCandidate > 0 && panel.issueCounts.localZOrderApplied > 0)).toBe(true);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(bytes.length).toBeGreaterThan(10_000);
  }, 20_000);
});
