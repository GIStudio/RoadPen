import { describe, expect, test } from "vitest";
import type { RoadPenScene } from "../src/types";
import { exportScene, parseRoadPenScene } from "../src/io/io";

describe("import-export", () => {
  const fixtureScene: RoadPenScene = {
    version: "1.0.0",
    units: "px",
    scalePxPerM: 20,
    nodes: [
      { id: "n-1", x: 12, y: 34 },
      { id: "n-2", x: 72, y: 94 },
    ],
    profiles: [
      {
        id: "default",
        name: "默认横断面",
        carriagewayWidth: 24,
        facilityWidth: 4,
        sidewalkWidth: 8,
        clearanceWidth: 4,
      },
    ],
    edges: [
      {
        id: "e-1",
        from: "n-1",
        to: "n-2",
        geomType: "polyline",
        profileId: "default",
        controlPoints: [
          { x: 12, y: 34 },
          { x: 42, y: 58 },
          { x: 72, y: 94 },
        ],
      },
    ],
  };

  test("导出后再导入应保持场景几何一致", () => {
    const text = exportScene(fixtureScene);
    const { scene, warnings } = parseRoadPenScene(text);

    expect(warnings.length).toBe(0);
    expect(scene.nodes).toHaveLength(2);
    expect(scene.edges).toHaveLength(1);
    expect(scene.edges[0]).toMatchObject({
      id: "e-1",
      from: "n-1",
      to: "n-2",
      geomType: "polyline",
      layer: 0,
      controlPoints: fixtureScene.edges[0].controlPoints,
    });
  });

  test("老格式文件兼容根对象加载", () => {
    const legacy = JSON.stringify({
      version: "0.9.0",
      units: "px",
      scalePxPerM: 12,
      nodes: fixtureScene.nodes,
      edges: fixtureScene.edges,
      profiles: fixtureScene.profiles,
    });
    const { scene, warnings } = parseRoadPenScene(legacy);

    expect(warnings).toContain("检测到不同版本文件 (0.9.0)，已按当前版本 1.0.0 重建。");
    expect(scene.scalePxPerM).toBe(12);
    expect(scene.nodes).toHaveLength(2);
  });

  test("道路末端模式应导入导出保持，旧数据默认自由端", () => {
    const closedScene: RoadPenScene = {
      ...fixtureScene,
      edges: [
        {
          ...fixtureScene.edges[0],
          endMode: "closed",
        },
      ],
    };
    const { scene } = parseRoadPenScene(exportScene(closedScene));
    const { scene: legacyScene } = parseRoadPenScene(
      JSON.stringify({
        version: "1.0.0",
        units: "px",
        scalePxPerM: 20,
        nodes: fixtureScene.nodes,
        edges: fixtureScene.edges,
        profiles: fixtureScene.profiles,
      }),
    );

    expect(scene.edges[0].endMode).toBe("closed");
    expect(legacyScene.edges[0].endMode).toBe("free");
  });

  test("道路 layer 应导入导出保持，旧数据默认 layer 0", () => {
    const layeredScene: RoadPenScene = {
      ...fixtureScene,
      edges: [
        {
          ...fixtureScene.edges[0],
          layer: 2,
        },
      ],
    };
    const { scene } = parseRoadPenScene(exportScene(layeredScene));
    const { scene: legacyScene } = parseRoadPenScene(
      JSON.stringify({
        version: "1.0.0",
        units: "px",
        scalePxPerM: 20,
        nodes: fixtureScene.nodes,
        edges: fixtureScene.edges,
        profiles: fixtureScene.profiles,
      }),
    );

    expect(scene.edges[0].layer).toBe(2);
    expect(legacyScene.edges[0].layer).toBe(0);
  });
});
