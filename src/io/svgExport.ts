import type { Point, RoadPenScene } from "../types";
import { buildRoadBandPolygons, polygonArea } from "../render/roadRenderer";
import { mergeRoadJunction, multiPolygonToRings } from "../geometry/roadMerge";

interface SvgExportOptions {
  width: number;
  height: number;
  draftPoints?: Point[];
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return Number(value.toFixed(3)).toString();
}

function ringToPath(points: Point[]): string {
  if (points.length === 0) {
    return "";
  }

  const [first, ...rest] = points;
  return [
    `M ${fmt(first.x)} ${fmt(first.y)}`,
    ...rest.map((point) => `L ${fmt(point.x)} ${fmt(point.y)}`),
    "Z",
  ].join(" ");
}

function polylinePoints(points: Point[]): string {
  return points.map((point) => `${fmt(point.x)},${fmt(point.y)}`).join(" ");
}

function sceneMeta(scene: RoadPenScene, junctions: Array<{ nodeId: string; type: string; degree: number }>): string {
  return esc(
    JSON.stringify(
      {
        version: scene.version,
        nodes: scene.nodes.length,
        edges: scene.edges.length,
        edgeIds: scene.edges.map((edge) => ({
          id: edge.id,
          geomType: edge.geomType,
          controlPoints: edge.controlPoints.length,
        })),
        junctions: junctions.map((junction) => ({
          nodeId: junction.nodeId,
          type: junction.type,
          degree: junction.degree,
        })),
      },
      null,
      2,
    ),
  );
}

export function exportRoadSvg(scene: RoadPenScene, options: SvgExportOptions): string {
  const { width, height, draftPoints } = options;
  const { bandBuckets, junctions, junctionPatches, laneConnectorPatches, edgeCenterlines, warnings } = buildRoadBandPolygons(scene);
  const orderedBands = [...bandBuckets.values()].sort((a, b) => a.band.zIndex - b.band.zIndex);

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" viewBox="0 0 ${fmt(width)} ${fmt(height)}">`,
    "  <metadata>",
    `    ${sceneMeta(scene, junctions)}`,
    "  </metadata>",
    `  <rect id="background" x="0" y="0" width="${fmt(width)}" height="${fmt(height)}" fill="#0a1024"/>`,
    '  <g id="rendered-road-bands">',
  ];

  for (const bucket of orderedBands) {
    const merged = mergeRoadJunction(bucket.polygons);
    const rings = multiPolygonToRings(merged);
    out.push(`    <g id="band-${esc(bucket.band.id)}" data-polygons="${bucket.polygons.length}">`);

    rings.forEach((ringSet, ringSetIndex) => {
      ringSet.forEach((ring, ringIndex) => {
        if (ring.length < 3 || Math.abs(polygonArea(ring)) < 1e-6) {
          return;
        }

        out.push(
          `      <path id="band-${esc(bucket.band.id)}-${ringSetIndex}-${ringIndex}" d="${ringToPath(ring)}" fill="${bucket.band.color}" stroke="rgba(8, 14, 29, 0.8)" stroke-width="1"/>`,
        );
      });
    });

    out.push("    </g>");
  }

  out.push(
    "  </g>",
    '  <g id="raw-band-polygons" opacity="0.35" fill="none" stroke="#facc15" stroke-width="1" stroke-dasharray="5 4">',
  );

  for (const bucket of orderedBands) {
    bucket.polygons.forEach((polygon, index) => {
      if (polygon.length < 3) {
        return;
      }

      out.push(
        `    <path id="raw-${esc(bucket.band.id)}-${index}" data-band="${esc(bucket.band.id)}" data-index="${index}" d="${ringToPath(polygon)}"/>`,
      );
    });
  }

  out.push(
    "  </g>",
    '  <g id="junction-patches" opacity="0.45" fill="rgba(250, 204, 21, 0.28)" stroke="#facc15" stroke-width="1.25">',
  );

  junctionPatches.forEach((patch, index) => {
    out.push(
      `    <path id="junction-patch-${esc(patch.nodeId)}-${esc(patch.bandId)}-${index}" data-node-id="${esc(patch.nodeId)}" data-junction-type="${patch.type}" data-band="${esc(patch.bandId)}" data-kind="${esc(patch.kind ?? "unknown")}" d="${ringToPath(patch.polygon)}"/>`,
    );
  });

  out.push(
    "  </g>",
    '  <g id="lane-connectors" opacity="0.5" fill="rgba(34, 197, 94, 0.26)" stroke="#22c55e" stroke-width="1.25">',
  );

  laneConnectorPatches.forEach((patch, index) => {
    out.push(
      `    <path id="lane-connector-${esc(patch.nodeId)}-${esc(patch.baseLane)}-${index}" data-node-id="${esc(patch.nodeId)}" data-base-lane="${esc(patch.baseLane)}" data-from-edge-id="${esc(patch.fromEdgeId)}" data-to-edge-id="${esc(patch.toEdgeId)}" d="${ringToPath(patch.polygon)}"/>`,
    );
  });

  out.push("  </g>", '  <g id="junction-labels" font-family="Figtree, PingFang SC, sans-serif" text-anchor="middle">');

  junctions.forEach((junction) => {
    if (junction.type !== "t" && junction.type !== "cross") {
      return;
    }
    const label = junction.type === "cross" ? "X" : "T";
    out.push(
      `    <circle id="junction-label-${esc(junction.nodeId)}" cx="${fmt(junction.point.x)}" cy="${fmt(junction.point.y)}" r="${junction.type === "cross" ? 12 : 10}" fill="rgba(37, 99, 235, 0.88)" stroke="#bfdbfe" stroke-width="1.5"/>`,
      `    <text x="${fmt(junction.point.x)}" y="${fmt(junction.point.y + 4)}" fill="#f8fafc" font-size="12" font-weight="700">${label}</text>`,
    );
  });

  out.push("  </g>", '  <g id="rendered-centerlines" fill="none">');

  for (const edge of edgeCenterlines) {
    out.push(
      `    <polyline id="rendered-centerline-${esc(edge.id)}" data-geom-type="${edge.geomType}" data-edge-ids="${esc(edge.edgeIds.join(","))}" points="${polylinePoints(edge.renderPoints)}" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  }

  out.push("  </g>", '  <g id="edge-centerlines" fill="none">');

  for (const edge of edgeCenterlines) {
    out.push(
      `    <polyline id="centerline-${esc(edge.id)}" data-geom-type="${edge.geomType}" data-edge-ids="${esc(edge.edgeIds.join(","))}" points="${polylinePoints(edge.rawPoints)}" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
    edge.rawPoints.forEach((point, index) => {
      out.push(
        `    <circle id="control-${esc(edge.id)}-${index}" cx="${fmt(point.x)}" cy="${fmt(point.y)}" r="3" fill="#f97316" stroke="#fff7ed" stroke-width="1"/>`,
      );
    });
  }

  if (draftPoints && draftPoints.length > 0) {
    out.push(
      `    <polyline id="draft-centerline" points="${polylinePoints(draftPoints)}" stroke="#22c55e" stroke-width="2" stroke-dasharray="6 4" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  }

  out.push("  </g>");

  if (warnings.length > 0) {
    out.push("  <g id=\"geometry-warnings\">");
    warnings.forEach((warning, index) => {
      out.push(`    <text x="12" y="${fmt(24 + index * 18)}" fill="#fecdd3" font-size="12">${esc(warning)}</text>`);
    });
    out.push("  </g>");
  }

  out.push("</svg>");
  return `${out.join("\n")}\n`;
}
