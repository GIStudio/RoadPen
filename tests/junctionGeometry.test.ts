import { describe, expect, test } from "vitest";
import { buildJunctionGeometry } from "../src/geometry/junctionGeometry";
import { mergeRoadJunction, multiPolygonToRings } from "../src/geometry/roadMerge";
import { exportRoadSvg } from "../src/io/svgExport";
import { buildJunctionOnlyBandBuckets, buildRoadBandPolygons, buildRoadNetworkGeometry } from "../src/render/roadRenderer";
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

function polygonArea(points: Point[]): number {
  const ring =
    points.length > 1 &&
    Math.abs(points[0].x - points[points.length - 1].x) < 1e-6 &&
    Math.abs(points[0].y - points[points.length - 1].y) < 1e-6
      ? points.slice(0, -1)
      : points;

  let area = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

function polygonCentroid(points: Point[]): Point {
  const ring =
    points.length > 1 &&
    Math.abs(points[0].x - points[points.length - 1].x) < 1e-6 &&
    Math.abs(points[0].y - points[points.length - 1].y) < 1e-6
      ? points.slice(0, -1)
      : points;

  const sum = ring.reduce(
    (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / Math.max(1, ring.length), y: sum.y / Math.max(1, ring.length) };
}

function maxDistanceFrom(point: Point, polygon: Point[]): number {
  return polygon.reduce((max, item) => Math.max(max, Math.hypot(item.x - point.x, item.y - point.y)), 0);
}


function pointInPolygon(point: Point, polygon: Point[]): boolean {
  const ring =
    polygon.length > 1 &&
    Math.abs(polygon[0].x - polygon[polygon.length - 1].x) < 1e-6 &&
    Math.abs(polygon[0].y - polygon[polygon.length - 1].y) < 1e-6
      ? polygon.slice(0, -1)
      : polygon;

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-9) + a.x;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInMergedPolygons(point: Point, polygons: Point[][][]): boolean {
  return polygons.some((rings) => {
    const [outer, ...holes] = rings;
    return Boolean(outer) && pointInPolygon(point, outer) && holes.every((hole) => !pointInPolygon(point, hole));
  });
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

function angledTScene(): RoadPenScene {
  return {
    ...sceneWithEdges([
      road("west-road", "center", "west", { x: 0, y: 0 }, { x: -120, y: 0 }),
      road("east-road", "center", "east", { x: 0, y: 0 }, { x: 120, y: 0 }),
      road("branch-road", "center", "branch", { x: 0, y: 0 }, { x: 70, y: -120 }),
    ]),
    nodes: [
      { id: "center", x: 0, y: 0 },
      { id: "west", x: -120, y: 0 },
      { id: "east", x: 120, y: 0 },
      { id: "branch", x: 70, y: -120 },
    ],
  };
}

function crossScene(): RoadPenScene {
  return sceneWithEdges([
    road("west-road", "center", "west", { x: 0, y: 0 }, { x: -120, y: 0 }),
    road("east-road", "center", "east", { x: 0, y: 0 }, { x: 120, y: 0 }),
    road("north-road", "center", "north", { x: 0, y: 0 }, { x: 0, y: -120 }),
    road("south-road", "center", "south", { x: 0, y: 0 }, { x: 0, y: 120 }),
  ]);
}

function diagonalCrossScene(): RoadPenScene {
  return {
    ...sceneWithEdges([
      road("north-west-road", "center", "north-west", { x: 0, y: 0 }, { x: -112, y: -48 }),
      road("south-east-road", "center", "south-east", { x: 0, y: 0 }, { x: 112, y: 48 }),
      road("north-east-road", "center", "north-east", { x: 0, y: 0 }, { x: 88, y: -82 }),
      road("south-west-road", "center", "south-west", { x: 0, y: 0 }, { x: -88, y: 82 }),
    ]),
    nodes: [
      { id: "center", x: 0, y: 0 },
      { id: "north-west", x: -112, y: -48 },
      { id: "south-east", x: 112, y: 48 },
      { id: "north-east", x: 88, y: -82 },
      { id: "south-west", x: -88, y: 82 },
    ],
  };
}

function yScene(): RoadPenScene {
  return {
    ...sceneWithEdges([
      road("north-west-road", "center", "north-west", { x: 0, y: 0 }, { x: -72, y: -112 }),
      road("north-east-road", "center", "north-east", { x: 0, y: 0 }, { x: 72, y: -112 }),
      road("south-road", "center", "south", { x: 0, y: 0 }, { x: 0, y: 132 }),
    ]),
    nodes: [
      { id: "center", x: 0, y: 0 },
      { id: "north-west", x: -72, y: -112 },
      { id: "north-east", x: 72, y: -112 },
      { id: "south", x: 0, y: 132 },
    ],
  };
}

describe("junctionGeometry", () => {
  test("三条道路共享节点时应识别为 T 路口并生成补片", () => {
    const result = buildJunctionGeometry(tScene());
    const center = result.junctions.find((junction) => junction.nodeId === "center");
    const block = result.junctionBlocks.find((junctionBlock) => junctionBlock.nodeId === "center");

    expect(center).toMatchObject({ type: "t", degree: 3 });
    expect(block).toMatchObject({ id: "junction-center", type: "t", degree: 3 });
    expect(block?.surfacePatches.length).toBeGreaterThan(0);
    expect(block?.mouthLines).toHaveLength(3);
    expect(block?.laneConnectorPatches.length).toBeGreaterThan(0);
    expect(result.patches.some((patch) => patch.nodeId === "center" && patch.bandId === "carriageway")).toBe(true);
    expect(result.virtualMouthLines.filter((line) => line.nodeId === "center")).toHaveLength(3);
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
    expect(result.laneConnectorPatches.every((patch) => polygonArea(patch.polygon) > 20)).toBe(true);
    expect(result.laneConnectorPatches.every((patch) => patch.polygon.length > 12)).toBe(true);
    expect(result.laneConnectorPatches.every((patch) => !hasSelfIntersection(patch.polygon))).toBe(true);
  });

  test("四条道路共享节点时应识别为十字路口且补片不自交", () => {
    const result = buildJunctionGeometry(crossScene());
    const center = result.junctions.find((junction) => junction.nodeId === "center");
    const carriagewayPatch = result.patches.find((patch) => patch.nodeId === "center" && patch.kind === "virtual-boundary");
    const turnPatches = result.patches.filter((patch) => patch.nodeId === "center" && patch.kind === "turn");

    expect(center).toMatchObject({ type: "cross", degree: 4 });
    expect(result.junctionBlocks.find((block) => block.nodeId === "center")).toMatchObject({ id: "junction-center", type: "cross", degree: 4 });
    expect(carriagewayPatch).toBeDefined();
    expect(carriagewayPatch?.junctionBlockId).toBe("junction-center");
    expect(hasSelfIntersection(carriagewayPatch?.polygon ?? [])).toBe(false);
    expect(turnPatches).toHaveLength(8);
    expect(turnPatches.every((patch) => patch.directed && patch.fromEdgeId && patch.toEdgeId && patch.fromEdgeId !== patch.toEdgeId)).toBe(true);
    expect(result.virtualMouthLines.filter((line) => line.nodeId === "center")).toHaveLength(4);
    expect(result.laneConnectorPatches.filter((patch) => patch.nodeId === "center" && patch.baseLane === "facility")).toHaveLength(4);
    expect(result.laneConnectorPatches.every((patch) => patch.fromEdgeId !== patch.toEdgeId)).toBe(true);
  });

  test("斜角 T 路口也应生成有深度的同类 lane 角区 connector", () => {
    const result = buildJunctionGeometry(angledTScene());
    const facilityConnectors = result.laneConnectorPatches.filter(
      (patch) => patch.nodeId === "center" && patch.baseLane === "facility",
    );

    expect(result.junctions.find((junction) => junction.nodeId === "center")).toMatchObject({ type: "t", degree: 3 });
    expect(facilityConnectors).toHaveLength(2);
    expect(facilityConnectors.every((patch) => polygonArea(patch.polygon) > 20)).toBe(true);
    expect(facilityConnectors.every((patch) => patch.polygon.length > 12)).toBe(true);
    expect(facilityConnectors.every((patch) => !hasSelfIntersection(patch.polygon))).toBe(true);
    expect(result.laneConnectorPatches.filter((patch) => patch.nodeId === "center" && patch.baseLane === "sidewalk")).toHaveLength(2);
    expect(result.laneConnectorPatches.filter((patch) => patch.nodeId === "center" && patch.baseLane === "clearance")).toHaveLength(2);
  });

  test("T 路口补片应让车行道合并为连续 polygon", () => {
    const { bandBuckets, junctionPatches } = buildRoadBandPolygons(tScene());
    const carriageway = bandBuckets.get("carriageway");
    const turnPatches = junctionPatches.filter((patch) => patch.nodeId === "center" && patch.kind === "turn");

    expect(junctionPatches.some((patch) => patch.nodeId === "center" && patch.bandId === "carriageway")).toBe(true);
    expect(turnPatches).toHaveLength(4);
    expect(turnPatches.every((patch) => patch.directed && patch.fromEdgeId && patch.toEdgeId)).toBe(true);
    expect(carriageway).toBeDefined();

    const merged = mergeRoadJunction(carriageway?.polygons ?? []);
    const rings = multiPolygonToRings(merged);
    expect(merged).toHaveLength(1);
    expect(rings).toHaveLength(1);
  });

  test("车行道右转补片应延伸到 mouth 与外侧 lane connector 的虚拟深度", () => {
    const result = buildJunctionGeometry(tScene());
    const turnPatches = result.patches.filter((patch) => patch.nodeId === "center" && patch.kind === "turn");

    expect(turnPatches).toHaveLength(4);
    expect(turnPatches.every((patch) => maxDistanceFrom({ x: 0, y: 0 }, patch.polygon) > 42)).toBe(true);
  });

  test("斜向十字路口的对角小三角应由双向车行道右转补齐", () => {
    const { bandBuckets, junctionPatches } = buildRoadBandPolygons(diagonalCrossScene());
    const carriageway = bandBuckets.get("carriageway");
    const turnPatches = junctionPatches.filter((patch) => patch.nodeId === "center" && patch.kind === "turn");
    const forwardDiagonalTurn = turnPatches.find((patch) => patch.fromEdgeId === "north-west-road" && patch.toEdgeId === "north-east-road");
    const reverseDiagonalTurn = turnPatches.find((patch) => patch.fromEdgeId === "north-east-road" && patch.toEdgeId === "north-west-road");
    const merged = mergeRoadJunction(carriageway?.polygons ?? []);
    const rings = multiPolygonToRings(merged);

    expect(turnPatches).toHaveLength(8);
    expect(forwardDiagonalTurn).toBeDefined();
    expect(reverseDiagonalTurn).toBeDefined();
    expect(pointInMergedPolygons(polygonCentroid(forwardDiagonalTurn?.polygon ?? []), rings)).toBe(true);
    expect(pointInMergedPolygons(polygonCentroid(reverseDiagonalTurn?.polygon ?? []), rings)).toBe(true);
  });

  test("派生道路网络应把路口几何归属到 JunctionBlock", () => {
    const network = buildRoadNetworkGeometry(yScene());
    const block = network.junctionBlocks.find((item) => item.nodeId === "center");

    expect(network.roadSegments.length).toBeGreaterThan(0);
    expect(block).toBeDefined();
    expect(block?.surfacePatches.every((patch) => patch.junctionBlockId === block.id)).toBe(true);
    expect(block?.mouthLines.every((line) => line.junctionBlockId === block.id)).toBe(true);
    expect(block?.laneConnectorPatches.every((patch) => patch.junctionBlockId === block.id)).toBe(true);
    expect(block?.laneStops.every((stop) => stop.junctionBlockId === block.id)).toBe(true);
  });

  test("调试隔离路口时只收集该 JunctionBlock 的路口几何", () => {
    const data = buildRoadBandPolygons(yScene());
    const isolated = buildJunctionOnlyBandBuckets(data, "junction-center");
    const isolatedPolygonCount = [...isolated.values()].reduce((sum, bucket) => sum + bucket.polygons.length, 0);
    const block = data.junctionBlocks.find((item) => item.id === "junction-center");

    expect(block).toBeDefined();
    expect(isolatedPolygonCount).toBe((block?.surfacePatches.length ?? 0) + (block?.laneConnectorPatches.length ?? 0));
    expect(isolated.has("carriageway")).toBe(true);
    expect(isolated.has("sidewalk")).toBe(true);
    expect(isolatedPolygonCount).toBeLessThan([...data.bandBuckets.values()].reduce((sum, bucket) => sum + bucket.polygons.length, 0));
  });

  test("T 路口主路外侧 lane 只应在存在 connector 的一侧停止", () => {
    const { edgeCenterlines, laneStops } = buildRoadBandPolygons(tScene());
    const mainChain = edgeCenterlines.find(
      (chain) => chain.edgeIds.includes("west-road") && chain.edgeIds.includes("east-road"),
    );

    expect(mainChain).toBeDefined();
    const mainCenterStops = laneStops.filter((stop) => stop.chainId === mainChain?.id && stop.nodeId === "center");
    expect(mainCenterStops.some((stop) => stop.bandId === "carriageway" && stop.junctionBlockId === "junction-center")).toBe(true);
    for (const base of ["facility", "sidewalk", "clearance"]) {
      const stoppedBandIds = new Set(mainCenterStops.filter((stop) => stop.bandId.startsWith(base)).map((stop) => stop.bandId));
      expect(stoppedBandIds.size).toBe(1);
      expect(stoppedBandIds.has(`${base}_left`) && stoppedBandIds.has(`${base}_right`)).toBe(false);
      expect(mainCenterStops.some((stop) => stop.bandId.startsWith(base) && stop.kind === "connector")).toBe(true);
    }
  });

  test("Y 路口尖角应由 carriageway virtual boundary 中心面覆盖", () => {
    const result = buildJunctionGeometry(yScene());
    const centerPatch = result.patches.find((patch) => patch.nodeId === "center" && patch.kind === "virtual-boundary");
    const turnPatches = result.patches.filter((patch) => patch.nodeId === "center" && patch.kind === "turn");

    expect(result.junctions.find((junction) => junction.nodeId === "center")).toMatchObject({ type: "t", degree: 3 });
    expect(result.junctionBlocks.find((block) => block.nodeId === "center")).toMatchObject({ id: "junction-center", type: "t", degree: 3 });
    expect(result.virtualMouthLines.filter((line) => line.nodeId === "center")).toHaveLength(3);
    expect(centerPatch).toBeDefined();
    expect(centerPatch?.bandId).toBe("carriageway");
    expect(turnPatches).toHaveLength(6);
    expect(turnPatches.every((patch) => patch.directed && patch.fromEdgeId && patch.toEdgeId)).toBe(true);
    expect(result.laneConnectorPatches.filter((patch) => patch.nodeId === "center" && patch.baseLane === "facility")).toHaveLength(3);
    expect(centerPatch ? polygonArea(centerPatch.polygon) : 0).toBeGreaterThan(2500);
    expect(centerPatch ? pointInPolygon({ x: 0, y: -32 }, centerPatch.polygon) : false).toBe(true);
    expect(hasSelfIntersection(centerPatch?.polygon ?? [])).toBe(false);
  });

  test("SVG 调试导出应包含路口补片和路口标签层", () => {
    const svg = exportRoadSvg(tScene(), { width: 300, height: 300 });

    expect(svg).toContain('id="junction-patches"');
    expect(svg).toContain('data-kind="virtual-boundary"');
    expect(svg).toContain('data-junction-block-id="junction-center"');
    expect(svg).toContain('data-kind="turn"');
    expect(svg).toContain('data-directed="true"');
    expect(svg).toContain('data-from-edge-id=');
    expect(svg).toContain('data-to-edge-id=');
    expect(svg).toContain('id="virtual-mouth-lines"');
    expect(svg).toContain('id="lane-connectors"');
    expect(svg).toContain('data-base-lane="sidewalk"');
    expect(svg).toContain('id="junction-labels"');
    expect(svg).toContain('data-junction-type="t"');
  });
});
