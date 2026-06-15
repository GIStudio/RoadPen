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

function ringSetToPath(rings: Point[][]): string {
  return rings.map(ringToPath).filter(Boolean).join(" ");
}

function polylinePoints(points: Point[]): string {
  return points.map((point) => `${fmt(point.x)},${fmt(point.y)}`).join(" ");
}

function sceneMeta(scene: RoadPenScene, junctions: Array<{ nodeId: string; layer: number; type: string; degree: number }>): string {
  return esc(
    JSON.stringify(
      {
        version: scene.version,
        nodes: scene.nodes.length,
        edges: scene.edges.length,
        edgeIds: scene.edges.map((edge) => ({
          id: edge.id,
          layer: edge.layer ?? 0,
          geomType: edge.geomType,
          controlPoints: edge.controlPoints.length,
        })),
        junctions: junctions.map((junction) => ({
          nodeId: junction.nodeId,
          layer: junction.layer,
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
  const { bandBuckets, roadFootprints, junctions, junctionPatches, laneConnectorPatches, virtualMouthLines, laneStops, edgeCenterlines, localZOrderSlices, warnings } = buildRoadBandPolygons(scene);
  const orderedBands = [...bandBuckets.values()].sort((a, b) => a.roadLayer - b.roadLayer || a.band.zIndex - b.band.zIndex);
  const bucketsByLayer = new Map<number, typeof orderedBands>();
  for (const bucket of orderedBands) {
    const buckets = bucketsByLayer.get(bucket.roadLayer) ?? [];
    buckets.push(bucket);
    bucketsByLayer.set(bucket.roadLayer, buckets);
  }
  const localSlicesByLayer = new Map<number, typeof localZOrderSlices>();
  for (const slice of localZOrderSlices) {
    const slices = localSlicesByLayer.get(slice.layer) ?? [];
    slices.push(slice);
    localSlicesByLayer.set(slice.layer, slices);
  }

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" viewBox="0 0 ${fmt(width)} ${fmt(height)}">`,
    "  <metadata>",
    `    ${sceneMeta(scene, junctions)}`,
    "  </metadata>",
    `  <rect id="background" x="0" y="0" width="${fmt(width)}" height="${fmt(height)}" fill="#0a1024"/>`,
    '  <g id="rendered-road-bands">',
  ];

  roadFootprints.forEach((footprint, footprintIndex) => {
    if (footprintIndex > 0) {
      const occlusionRings = multiPolygonToRings(mergeRoadJunction(footprint.polygons));
      out.push(`    <g id="layer-occlusion-${footprint.roadLayer}" data-road-layer="${footprint.roadLayer}" data-polygons="${footprint.polygons.length}">`);
      occlusionRings.forEach((ringSet, ringSetIndex) => {
        const d = ringSetToPath(ringSet);
        if (d) {
          out.push(`      <path id="layer-occlusion-${footprint.roadLayer}-${ringSetIndex}" data-road-layer="${footprint.roadLayer}" d="${d}" fill="#0a1024" fill-rule="evenodd"/>`);
        }
      });
      out.push("    </g>");
    }

    for (const bucket of bucketsByLayer.get(footprint.roadLayer) ?? []) {
      const merged = mergeRoadJunction(bucket.polygons);
      const rings = multiPolygonToRings(merged);
      out.push(`    <g id="band-layer-${bucket.roadLayer}-${esc(bucket.semanticBandId)}" data-band="${esc(bucket.semanticBandId)}" data-road-layer="${bucket.roadLayer}" data-polygons="${bucket.polygons.length}">`);

      rings.forEach((ringSet, ringSetIndex) => {
        if (ringSet.every((ring) => ring.length < 3 || Math.abs(polygonArea(ring)) < 1e-6)) {
          return;
        }
        const d = ringSetToPath(ringSet);
        out.push(
          `      <path id="band-layer-${bucket.roadLayer}-${esc(bucket.semanticBandId)}-${ringSetIndex}" data-band="${esc(bucket.semanticBandId)}" data-road-layer="${bucket.roadLayer}" d="${d}" fill="${bucket.band.color}" fill-rule="evenodd" stroke="rgba(8, 14, 29, 0.8)" stroke-width="1"/>`,
        );
      });

      out.push("    </g>");
    }

    const localSlices = localSlicesByLayer.get(footprint.roadLayer) ?? [];
    if (localSlices.length > 0) {
      out.push(`    <g id="local-z-order-layer-${footprint.roadLayer}" data-road-layer="${footprint.roadLayer}" data-slices="${localSlices.length}">`);
      for (const slice of localSlices.sort((a, b) => a.sliceIndex - b.sliceIndex)) {
        out.push(`      <g id="local-z-order-${esc(slice.chainId)}-${slice.sliceIndex}" data-chain-id="${esc(slice.chainId)}" data-edge-ids="${esc(slice.edgeIds.join(","))}" data-road-layer="${slice.layer}" data-local-slice-id="${slice.sliceIndex}" data-reason="${esc(slice.reason)}">`);
        const footprintRings = multiPolygonToRings(mergeRoadJunction(slice.footprint));
        footprintRings.forEach((ringSet, ringSetIndex) => {
          const d = ringSetToPath(ringSet);
          if (d) {
            out.push(`        <path id="local-z-order-${esc(slice.chainId)}-${slice.sliceIndex}-occlusion-${ringSetIndex}" data-road-layer="${slice.layer}" data-local-slice-id="${slice.sliceIndex}" d="${d}" fill="#0a1024" fill-rule="evenodd"/>`);
          }
        });
        for (const item of slice.bands.slice().sort((a, b) => a.band.zIndex - b.band.zIndex)) {
          out.push(
            `        <path id="local-z-order-${esc(slice.chainId)}-${slice.sliceIndex}-${esc(item.semanticBandId)}" data-band="${esc(item.semanticBandId)}" data-road-layer="${slice.layer}" data-local-slice-id="${slice.sliceIndex}" d="${ringToPath(item.polygon)}" fill="${item.band.color}" fill-rule="evenodd" stroke="rgba(8, 14, 29, 0.8)" stroke-width="1"/>`,
          );
        }
        out.push("      </g>");
      }
      out.push("    </g>");
    }
  });

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
        `    <path id="raw-layer-${bucket.roadLayer}-${esc(bucket.semanticBandId)}-${index}" data-band="${esc(bucket.semanticBandId)}" data-road-layer="${bucket.roadLayer}" data-index="${index}" d="${ringToPath(polygon)}"/>`,
      );
    });
  }

  out.push(
    "  </g>",
    '  <g id="junction-patches" opacity="0.45" fill="rgba(250, 204, 21, 0.28)" stroke="#facc15" stroke-width="1.25">',
  );

  junctionPatches.forEach((patch, index) => {
    const turnAttrs =
      patch.kind === "turn"
        ? `${patch.connectionId ? ` data-connection-id="${esc(patch.connectionId)}"` : ""}${patch.fromEdgeId ? ` data-from-edge-id="${esc(patch.fromEdgeId)}"` : ""}${patch.toEdgeId ? ` data-to-edge-id="${esc(patch.toEdgeId)}"` : ""}${patch.directed ? ' data-directed="true"' : ""}`
        : "";
    out.push(
      `    <path id="junction-patch-${esc(patch.nodeId)}-${patch.layer}-${esc(patch.bandId)}-${index}" data-junction-block-id="${esc(patch.junctionBlockId)}" data-node-id="${esc(patch.nodeId)}" data-road-layer="${patch.layer}" data-junction-type="${patch.type}" data-band="${esc(patch.bandId)}" data-kind="${esc(patch.kind ?? "unknown")}"${turnAttrs} d="${ringToPath(patch.polygon)}"/>`,
    );
  });

  out.push(
    "  </g>",
    '  <g id="virtual-mouth-lines" opacity="0.75" fill="none" stroke="#38bdf8" stroke-width="1.4" stroke-dasharray="3 2">',
  );

  virtualMouthLines.forEach((line, index) => {
    out.push(
      `    <line id="virtual-mouth-${esc(line.nodeId)}-${line.layer}-${esc(line.edgeId)}-${index}" data-junction-block-id="${esc(line.junctionBlockId)}" data-node-id="${esc(line.nodeId)}" data-road-layer="${line.layer}" data-edge-id="${esc(line.edgeId)}" data-junction-type="${line.type}" data-band="${esc(line.bandId)}" data-kind="virtual-boundary" x1="${fmt(line.innerPoint.x)}" y1="${fmt(line.innerPoint.y)}" x2="${fmt(line.outerPoint.x)}" y2="${fmt(line.outerPoint.y)}"/>`,
    );
  });

  out.push(
    "  </g>",
    '  <g id="lane-connectors" opacity="0.5" fill="rgba(34, 197, 94, 0.26)" stroke="#22c55e" stroke-width="1.25">',
  );

  laneConnectorPatches.forEach((patch, index) => {
    out.push(
      `    <path id="lane-connector-${esc(patch.nodeId)}-${patch.layer}-${esc(patch.baseLane)}-${index}" data-junction-block-id="${esc(patch.junctionBlockId)}" data-connection-id="${esc(patch.connectionId)}" data-node-id="${esc(patch.nodeId)}" data-road-layer="${patch.layer}" data-base-lane="${esc(patch.baseLane)}" data-from-edge-id="${esc(patch.fromEdgeId)}" data-to-edge-id="${esc(patch.toEdgeId)}" d="${ringToPath(patch.polygon)}"/>`,
    );
  });

  out.push(
    "  </g>",
    '  <g id="lane-stops" opacity="0.75" fill="rgba(244, 114, 182, 0.9)" stroke="#fce7f3" stroke-width="1">',
  );

  laneStops.forEach((stop, index) => {
    out.push(
      `    <circle id="lane-stop-${esc(stop.chainId)}-${stop.layer}-${esc(stop.nodeId)}-${index}" data-chain-id="${esc(stop.chainId)}"${stop.junctionBlockId ? ` data-junction-block-id="${esc(stop.junctionBlockId)}"` : ""} data-node-id="${esc(stop.nodeId)}" data-road-layer="${stop.layer}" data-band-id="${esc(stop.bandId)}" data-kind="${esc(stop.kind)}" data-distance="${fmt(stop.distance)}" cx="${fmt(stop.point.x)}" cy="${fmt(stop.point.y)}" r="4"/>`,
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
      `    <polyline id="rendered-centerline-${esc(edge.id)}" data-road-layer="${edge.layer}" data-geom-type="${edge.geomType}" data-edge-ids="${esc(edge.edgeIds.join(","))}" points="${polylinePoints(edge.renderPoints)}" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  }

  out.push("  </g>", '  <g id="edge-centerlines" fill="none">');

  for (const edge of edgeCenterlines) {
    out.push(
      `    <polyline id="centerline-${esc(edge.id)}" data-road-layer="${edge.layer}" data-geom-type="${edge.geomType}" data-edge-ids="${esc(edge.edgeIds.join(","))}" points="${polylinePoints(edge.rawPoints)}" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
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
