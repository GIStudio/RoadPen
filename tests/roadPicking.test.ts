import { describe, expect, test } from "vitest";
import { findRoadAtPoint } from "../src/geometry/roadPicking";
import type { Point, RoadEdge, RoadPenScene } from "../src/types";

function sceneWithEdges(edges: RoadEdge[]): RoadPenScene {
  const nodes = [
    { id: "center", x: 0, y: 0 },
    { id: "west", x: -120, y: 0 },
    { id: "east", x: 120, y: 0 },
    { id: "north", x: 0, y: -120 },
    { id: "near-a", x: -80, y: 28 },
    { id: "near-b", x: 80, y: 28 },
  ];

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

function road(id: string, from: string, to: string, a: Point, b: Point, layer = 0): RoadEdge {
  return {
    id,
    from,
    to,
    geomType: "polyline",
    layer,
    profileId: "default",
    controlPoints: [a, b],
  };
}

describe("roadPicking", () => {
  test("点击路面可见宽度内应命中对应道路", () => {
    const scene = sceneWithEdges([road("main", "west", "east", { x: -120, y: 0 }, { x: 120, y: 0 })]);

    expect(findRoadAtPoint(scene, { x: 0, y: 23 })?.edgeId).toBe("main");
  });

  test("点击 profile 外边界加容差之外应返回空", () => {
    const scene = sceneWithEdges([road("main", "west", "east", { x: -120, y: 0 }, { x: 120, y: 0 })]);

    expect(findRoadAtPoint(scene, { x: 0, y: 40 })).toBeNull();
  });

  test("多条道路接近时应选择最近道路", () => {
    const scene = sceneWithEdges([
      road("main", "west", "east", { x: -120, y: 0 }, { x: 120, y: 0 }),
      road("near", "near-a", "near-b", { x: -80, y: 28 }, { x: 80, y: 28 }),
    ]);

    expect(findRoadAtPoint(scene, { x: 0, y: 25 })?.edgeId).toBe("near");
  });

  test("T 路口中心附近应返回最近分支", () => {
    const scene = sceneWithEdges([
      road("west-road", "center", "west", { x: 0, y: 0 }, { x: -120, y: 0 }),
      road("east-road", "center", "east", { x: 0, y: 0 }, { x: 120, y: 0 }),
      road("north-road", "center", "north", { x: 0, y: 0 }, { x: 0, y: -120 }),
    ]);

    expect(["west-road", "east-road", "north-road"]).toContain(findRoadAtPoint(scene, { x: 2, y: -2 })?.edgeId);
  });

  test("多层道路重叠时应优先拾取较高 layer", () => {
    const scene = sceneWithEdges([
      road("lower", "west", "east", { x: -120, y: 0 }, { x: 120, y: 0 }, 0),
      road("upper", "near-a", "near-b", { x: -80, y: 0 }, { x: 80, y: 0 }, 2),
    ]);

    expect(findRoadAtPoint(scene, { x: 0, y: 0 })?.edgeId).toBe("upper");
  });
});
