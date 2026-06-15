import { describe, expect, test } from "vitest";
import { bandBucketKey, buildRoadBandPolygons } from "../src/render/roadRenderer";
import type { Point, RoadEdge, RoadPenScene } from "../src/types";

function sceneWithEdges(edges: RoadEdge[], nodes: RoadPenScene["nodes"]): RoadPenScene {
  return {
    version: "1.0.0",
    units: "px",
    scalePxPerM: 20,
    nodes,
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
    edges,
  };
}

function road(id: string, from: string, to: string, points: Point[], layer = 0): RoadEdge {
  return {
    id,
    from,
    to,
    layer,
    geomType: points.length === 2 ? "polyline" : "spline",
    profileId: "default",
    controlPoints: points,
  };
}

describe("road geometry diagnostics", () => {
  test("同层几何交叉但未共享节点时应计入 sameLayerUnsplitCrossing", () => {
    const scene = sceneWithEdges(
      [
        road("west-east", "west", "east", [{ x: -80, y: 0 }, { x: 80, y: 0 }]),
        road("north-south", "north", "south", [{ x: 0, y: -80 }, { x: 0, y: 80 }]),
      ],
      [
        { id: "west", x: -80, y: 0 },
        { id: "east", x: 80, y: 0 },
        { id: "north", x: 0, y: -80 },
        { id: "south", x: 0, y: 80 },
      ],
    );
    const data = buildRoadBandPolygons(scene);

    expect(data.geometryIssues.counts.sameLayerUnsplitCrossing).toBe(1);
    expect(data.geometryIssues.counts.crossLayerOverlap).toBe(0);
  });

  test("跨层几何交叉应计入 crossLayerOverlap 并生成两个 layer footprint", () => {
    const scene = sceneWithEdges(
      [
        road("lower", "west", "east", [{ x: -80, y: 0 }, { x: 80, y: 0 }], 0),
        road("upper", "north", "south", [{ x: 0, y: -80 }, { x: 0, y: 80 }], 1),
      ],
      [
        { id: "west", x: -80, y: 0 },
        { id: "east", x: 80, y: 0 },
        { id: "north", x: 0, y: -80 },
        { id: "south", x: 0, y: 80 },
      ],
    );
    const data = buildRoadBandPolygons(scene);

    expect(data.geometryIssues.counts.crossLayerOverlap).toBe(1);
    expect(data.geometryIssues.counts.sameLayerUnsplitCrossing).toBe(0);
    expect(data.roadFootprints.map((footprint) => footprint.roadLayer)).toEqual([0, 1]);
    expect(data.roadFootprints.every((footprint) => footprint.polygons.length > 0)).toBe(true);
  });

  test("贴近路口的短边应计入 shortEdgeStub", () => {
    const scene = sceneWithEdges(
      [
        road("west-road", "center", "west", [{ x: 0, y: 0 }, { x: -100, y: 0 }]),
        road("east-road", "center", "east", [{ x: 0, y: 0 }, { x: 100, y: 0 }]),
        road("north-road", "center", "north", [{ x: 0, y: 0 }, { x: 0, y: -100 }]),
        road("stub", "center", "stub-end", [{ x: 0, y: 0 }, { x: 20, y: 0 }]),
      ],
      [
        { id: "center", x: 0, y: 0 },
        { id: "west", x: -100, y: 0 },
        { id: "east", x: 100, y: 0 },
        { id: "north", x: 0, y: -100 },
        { id: "stub-end", x: 20, y: 0 },
      ],
    );
    const data = buildRoadBandPolygons(scene);

    expect(data.geometryIssues.counts.shortEdgeStub).toBeGreaterThanOrEqual(1);
  });

  test("大角度转弯应计入 sharpCornerGapCandidate", () => {
    const scene = sceneWithEdges(
      [road("sharp", "a", "b", [{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 20, y: 70 }])],
      [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 20, y: 70 },
      ],
    );
    const data = buildRoadBandPolygons(scene);

    expect(data.geometryIssues.counts.sharpCornerGapCandidate).toBeGreaterThanOrEqual(1);
  });

  test("自交道路中心线应生成路径顺序 local z slices", () => {
    const scene = sceneWithEdges(
      [road("self-crossing", "a", "b", [{ x: -80, y: -80 }, { x: 80, y: 80 }, { x: -80, y: 80 }, { x: 80, y: -80 }])],
      [
        { id: "a", x: -80, y: -80 },
        { id: "b", x: 80, y: -80 },
      ],
    );
    const data = buildRoadBandPolygons(scene);
    const carriageway = data.bandBuckets.get(bandBucketKey(0, "carriageway"));

    expect(carriageway).toBeDefined();
    expect(data.localZOrderSlices.length).toBeGreaterThan(1);
    expect(data.geometryIssues.counts.selfOverlapCandidate).toBe(1);
    expect(data.geometryIssues.counts.localZOrderApplied).toBe(1);
  });

  test("渲染旧拓扑时应忽略贴近路口的非节点控制点", () => {
    const scene = sceneWithEdges(
      [
        road("west", "center", "w", [{ x: 0, y: 0 }, { x: -100, y: 0 }]),
        road("east", "center", "e", [{ x: 0, y: 0 }, { x: 100, y: 0 }]),
        road("south", "s", "center", [{ x: 0, y: 100 }, { x: 0, y: 4 }, { x: 0, y: 0 }]),
        road("north", "center", "n", [{ x: 0, y: 0 }, { x: 0, y: -100 }]),
      ],
      [
        { id: "center", x: 0, y: 0 },
        { id: "w", x: -100, y: 0 },
        { id: "e", x: 100, y: 0 },
        { id: "s", x: 0, y: 100 },
        { id: "n", x: 0, y: -100 },
      ],
    );
    const data = buildRoadBandPolygons(scene);
    const vertical = data.edgeCenterlines.find(
      (chain) => chain.edgeIds.includes("south") && chain.edgeIds.includes("north"),
    );

    expect(vertical?.sourcePoints.some((point) => Math.hypot(point.x, point.y - 4) < 1e-6)).toBe(false);
    expect(data.warnings.some((warning) => warning.includes("转折过急"))).toBe(false);
  });
});
