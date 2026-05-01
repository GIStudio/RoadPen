import { describe, expect, test } from "vitest";
import { buildJunctionGeometry } from "../src/geometry/junctionGeometry";
import { commitRoadWithTopology, findSnapTarget, type DraftAnchor } from "../src/geometry/topology";
import { exportScene, parseRoadPenScene } from "../src/io/io";
import { buildRoadBandPolygons } from "../src/render/roadRenderer";
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

function road(id: string, from: string, to: string, points: Point[]): RoadEdge {
  return {
    id,
    from,
    to,
    geomType: points.length === 2 ? "polyline" : "spline",
    profileId: "default",
    controlPoints: points,
  };
}

function horizontalScene(): RoadPenScene {
  return sceneWithEdges(
    [road("main", "west", "east", [{ x: -100, y: 0 }, { x: 100, y: 0 }])],
    [
      { id: "west", x: -100, y: 0 },
      { id: "east", x: 100, y: 0 },
    ],
  );
}

function idFactories(scene: RoadPenScene): { node: () => string; edge: () => string } {
  let nodeSerial = scene.nodes.length;
  let edgeSerial = scene.edges.length;
  return {
    node: () => `n-test-${++nodeSerial}`,
    edge: () => `e-test-${++edgeSerial}`,
  };
}

function freeAnchor(point: Point): DraftAnchor {
  return {
    point,
    snap: {
      type: "free",
      point,
      distance: 0,
    },
  };
}

function anchorFromPoint(scene: RoadPenScene, point: Point): DraftAnchor {
  const snap = findSnapTarget(scene, point, { nodeRadius: 12, edgeRadius: 16 });
  return { point: snap.point, snap };
}

describe("topology", () => {
  test("点靠近已有节点时，snap target 应优先选择 node", () => {
    const scene = horizontalScene();
    const snap = findSnapTarget(scene, { x: -96, y: 3 }, { nodeRadius: 12, edgeRadius: 16 });

    expect(snap).toMatchObject({ type: "node", nodeId: "west" });
  });

  test("点靠近已有道路中段时，应返回 edge snap target", () => {
    const scene = horizontalScene();
    const snap = findSnapTarget(scene, { x: 12, y: 7 }, { nodeRadius: 12, edgeRadius: 16 });

    expect(snap).toMatchObject({ type: "edge", edgeId: "main", segmentIndex: 0 });
    expect(snap.point).toEqual({ x: 12, y: 0 });
  });

  test("新道路端点吸附到旧道路中段后，应拆分旧边形成 T 路口", () => {
    const scene = horizontalScene();
    const ids = idFactories(scene);
    const anchors = [freeAnchor({ x: 0, y: -80 }), anchorFromPoint(scene, { x: 0, y: 6 })];

    const result = commitRoadWithTopology(scene, anchors, "default", ids.node, ids.edge);
    const junction = buildJunctionGeometry(scene).junctions.find((item) => item.point.x === 0 && item.point.y === 0);
    const { junctionPatches } = buildRoadBandPolygons(scene);

    expect(result?.createdEdgeIds).toHaveLength(1);
    expect(scene.edges).toHaveLength(3);
    expect(junction).toMatchObject({ type: "t", degree: 3 });
    expect(junctionPatches.some((patch) => patch.nodeId === junction?.nodeId && patch.bandId === "carriageway")).toBe(true);
  });

  test("新道路穿过旧道路时，应同时拆分新旧道路形成十字路口", () => {
    const scene = horizontalScene();
    const ids = idFactories(scene);
    const anchors = [freeAnchor({ x: 0, y: -80 }), freeAnchor({ x: 0, y: 80 })];

    const result = commitRoadWithTopology(scene, anchors, "default", ids.node, ids.edge);
    const junction = buildJunctionGeometry(scene).junctions.find((item) => item.point.x === 0 && item.point.y === 0);
    const { junctionPatches } = buildRoadBandPolygons(scene);

    expect(result?.createdEdgeIds).toHaveLength(2);
    expect(scene.edges).toHaveLength(4);
    expect(junction).toMatchObject({ type: "cross", degree: 4 });
    expect(junctionPatches.some((patch) => patch.nodeId === junction?.nodeId && patch.bandId === "carriageway")).toBe(true);
  });

  test("自动拓扑后的 scene 导出再导入应保持共享节点结构", () => {
    const scene = horizontalScene();
    const ids = idFactories(scene);
    commitRoadWithTopology(scene, [freeAnchor({ x: 0, y: -80 }), freeAnchor({ x: 0, y: 80 })], "default", ids.node, ids.edge);

    const { scene: imported, warnings } = parseRoadPenScene(exportScene(scene));
    const junction = buildJunctionGeometry(imported).junctions.find((item) => item.point.x === 0 && item.point.y === 0);

    expect(warnings).toHaveLength(0);
    expect(junction).toMatchObject({ type: "cross", degree: 4 });
  });
});
