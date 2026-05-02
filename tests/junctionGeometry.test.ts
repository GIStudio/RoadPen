import { describe, expect, test } from "vitest";
import { buildJunctionGeometry } from "../src/geometry/junctionGeometry";
import { mergeRoadJunction, multiPolygonToRings } from "../src/geometry/roadMerge";
import { exportRoadSvg } from "../src/io/svgExport";
import { buildRoadBandPolygons } from "../src/render/roadRenderer";
import type { Point, RoadEdge, RoadPenScene } from "../src/types";

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return abC * abD < 0 && cdA * cdB < 0;
}

function hasSelfIntersection(points: Point[]): boolean {
  const ring =
    points.length > 1 &&
    Math.abs(points[0].x - points[points.length - 1].x) < 1e-6 &&
    Math.abs(points[0].y - points[points.length - 1].y) < 1e-6
      ? points.slice(0, -1)
      : points;

  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    for (let j = i + 1; j < ring.length; j += 1) {
      const adjacent = Math.abs(i - j) <= 1 || (i === 0 && j === ring.length - 1);
      if (adjacent) {
        continue;
      }
      const c = ring[j];
      const d = ring[(j + 1) % ring.length];
      if (segmentsIntersect(a, b, c, d)) {
        return true;
      }
    }
  }

  return false;
}

function sceneWithEdges(edges: RoadEdge[]): RoadPenScene {
  const nodes = [
    { id: "center", x: 0, y: 0 },
    { id: "west", x: -120, y: 0 },
    { id: "east", x: 120, y: 0 },
    { id: "north", x: 0, y: -120 },
    { id: "south", x: 0, y: 120 },
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

function road(id: string, from: string, to: string, a: Point, b: Point): RoadEdge {
  return {
    id,
    from,
    to,
    geomType: "polyline",
    profileId: "default",
    controlPoints: [a, b],
  };
}

function tScene(): RoadPenScene {
  return sceneWithEdges([
    road("west-road", "center", "west", { x: 0, y: 0 }, { x: -120, y: 0 }),
    road("east-road", "center", "east", { x: 0, y: 0 }, { x: 120, y: 0 }),
    road("north-road", "center", "north", { x: 0, y: 0 }, { x: 0, y: -120 }),
  ]);
}

function crossScene(): RoadPenScene {
  return sceneWithEdges([
    road("west-road", "center", "west", { x: 0, y: 0 }, { x: -120, y: 0 }),
    road("east-road", "center", "east", { x: 0, y: 0 }, { x: 120, y: 0 }),
    road("north-road", "center", "north", { x: 0, y: 0 }, { x: 0, y: -120 }),
    road("south-road", "center", "south", { x: 0, y: 0 }, { x: 0, y: 120 }),
  ]);
}

describe("junctionGeometry", () => {
  test("三条道路共享节点时应识别为 T 路口并生成补片", () => {
    const result = buildJunctionGeometry(tScene());
    const center = result.junctions.find((junction) => junction.nodeId === "center");

    expect(center).toMatchObject({ type: "t", degree: 3 });
    expect(result.patches.some((patch) => patch.nodeId === "center" && patch.bandId === "carriageway")).toBe(true);
  });

  test("T 路口只应让车行道进入中心融合，外侧 lane 应生成独立 connector", () => {
    const result = buildJunctionGeometry(tScene());

    expect(result.patches.every((patch) => patch.bandId === "carriageway")).toBe(true);
    expect(result.patches.some((patch) => patch.nodeId === "center" && patch.bandId === "clearance_left")).toBe(false);
    expect(result.patches.some((patch) => patch.nodeId === "center" && patch.bandId === "sidewalk_left")).toBe(false);
    expect(result.patches.some((patch) => patch.nodeId === "center" && patch.bandId === "facility_left")).toBe(false);

    expect(result.laneConnectorPatches.filter((patch) => patch.nodeId === "center" && patch.baseLane === "facility")).toHaveLength(2);
    expect(result.laneConnectorPatches.filter((patch) => patch.nodeId === "center" && patch.baseLane === "sidewalk")).toHaveLength(2);
    expect(result.laneConnectorPatches.filter((patch) => patch.nodeId === "center" && patch.baseLane === "clearance")).toHaveLength(2);
    expect(result.laneConnectorPatches.every((patch) => patch.fromEdgeId !== patch.toEdgeId)).toBe(true);
  });

  test("四条道路共享节点时应识别为十字路口且补片不自交", () => {
    const result = buildJunctionGeometry(crossScene());
    const center = result.junctions.find((junction) => junction.nodeId === "center");
    const carriagewayPatch = result.patches.find((patch) => patch.nodeId === "center" && patch.bandId === "carriageway");

    expect(center).toMatchObject({ type: "cross", degree: 4 });
    expect(carriagewayPatch).toBeDefined();
    expect(hasSelfIntersection(carriagewayPatch?.polygon ?? [])).toBe(false);
  });

  test("T 路口补片应让车行道合并为连续 polygon", () => {
    const { bandBuckets, junctionPatches } = buildRoadBandPolygons(tScene());
    const carriageway = bandBuckets.get("carriageway");

    expect(junctionPatches.some((patch) => patch.nodeId === "center" && patch.bandId === "carriageway")).toBe(true);
    expect(carriageway).toBeDefined();

    const merged = mergeRoadJunction(carriageway?.polygons ?? []);
    const rings = multiPolygonToRings(merged);
    expect(merged).toHaveLength(1);
    expect(rings).toHaveLength(1);
  });

  test("SVG 调试导出应包含路口补片和路口标签层", () => {
    const svg = exportRoadSvg(tScene(), { width: 300, height: 300 });

    expect(svg).toContain('id="junction-patches"');
    expect(svg).toContain('id="lane-connectors"');
    expect(svg).toContain('data-base-lane="sidewalk"');
    expect(svg).toContain('id="junction-labels"');
    expect(svg).toContain('data-junction-type="t"');
  });
});
