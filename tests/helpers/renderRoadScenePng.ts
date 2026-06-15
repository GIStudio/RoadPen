import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";
import { buildRoadBandPolygons, buildRoadLayerFootprints, type BandBucket, type RoadBandData } from "../../src/render/roadRenderer";
import { mergeRoadJunction, multiPolygonToRings } from "../../src/geometry/roadMerge";
import type { GeometryIssueReport, Point, RoadEdge, RoadPenScene } from "../../src/types";

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface Viewport {
  width: number;
  height: number;
  minX: number;
  minY: number;
  scale: number;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RoadScenePngOptions {
  maxWidth?: number;
  maxHeight?: number;
  padding?: number;
}

export interface RoadSceneImage {
  width: number;
  height: number;
  image: Uint8Array;
  data: RoadBandData;
}

export interface RoadSceneAtlasPanel {
  id: string;
  scene: RoadPenScene;
  edgeIds: string[];
  nodeIds: string[];
  bounds: Bounds;
}

export interface RoadSceneAtlasOptions {
  cellWidth?: number;
  cellHeight?: number;
  columns?: number;
  clusterPadding?: number;
  panelGap?: number;
  scenePadding?: number;
  jsonOutputPath?: string;
}

export interface RoadSceneAtlasResult {
  width: number;
  height: number;
  bytes: number;
  jsonBytes: number;
  panelCount: number;
  panels: Array<{
    id: string;
    edgeIds: string[];
    nodeIds: string[];
    bounds: Bounds;
    warnings: number;
    warningMessages: string[];
    issueCounts: GeometryIssueReport["counts"];
    probes: Array<{
      id: string;
      type: string;
      point: Point;
      passed: boolean;
      message: string;
    }>;
    outerLaneCoverageGaps: number;
  }>;
}

const BACKGROUND: Rgba = { r: 10, g: 16, b: 36, a: 1 };
const PANEL_BACKGROUND: Rgba = { r: 15, g: 23, b: 42, a: 1 };
const PANEL_BORDER: Rgba = { r: 51, g: 65, b: 85, a: 1 };
const PANEL_TEXT: Rgba = { r: 226, g: 232, b: 240, a: 1 };

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    return {
      r: Number.parseInt(hex[1].slice(0, 2), 16),
      g: Number.parseInt(hex[1].slice(2, 4), 16),
      b: Number.parseInt(hex[1].slice(4, 6), 16),
      a: 1,
    };
  }

  const rgba = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
  if (rgba) {
    const parts = rgba[1].split(",").map((part) => Number(part.trim()));
    return {
      r: parts[0] ?? 0,
      g: parts[1] ?? 0,
      b: parts[2] ?? 0,
      a: parts.length >= 4 && Number.isFinite(parts[3]) ? parts[3] : 1,
    };
  }

  return { ...BACKGROUND };
}

function blendPixel(image: Uint8Array, index: number, color: Rgba): void {
  const alpha = Math.max(0, Math.min(1, color.a));
  const inv = 1 - alpha;
  image[index] = Math.round(color.r * alpha + image[index] * inv);
  image[index + 1] = Math.round(color.g * alpha + image[index + 1] * inv);
  image[index + 2] = Math.round(color.b * alpha + image[index + 2] * inv);
  image[index + 3] = 255;
}

function pointBounds(polygons: Point[][]): Bounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const polygon of polygons) {
    for (const point of polygon) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  }

  return { minX, minY, maxX, maxY };
}

function viewportFor(polygons: Point[][], maxWidth: number, maxHeight: number, padding: number): Viewport {
  const bounds = pointBounds(polygons);
  const worldWidth = Math.max(1, bounds.maxX - bounds.minX + padding * 2);
  const worldHeight = Math.max(1, bounds.maxY - bounds.minY + padding * 2);
  const scale = Math.min(maxWidth / worldWidth, maxHeight / worldHeight);
  return {
    width: Math.max(1, Math.ceil(worldWidth * scale)),
    height: Math.max(1, Math.ceil(worldHeight * scale)),
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    scale,
  };
}

function toScreenX(pointX: number, viewport: Viewport): number {
  return (pointX - viewport.minX) * viewport.scale;
}

function toScreenY(pointY: number, viewport: Viewport): number {
  return (pointY - viewport.minY) * viewport.scale;
}

function fillRingSet(image: Uint8Array, viewport: Viewport, ringSet: Point[][], color: Rgba): void {
  if (ringSet.length === 0) {
    return;
  }

  const screenRings = ringSet.map((ring) =>
    ring.map((point) => ({
      x: toScreenX(point.x, viewport),
      y: toScreenY(point.y, viewport),
    })),
  );
  const minY = Math.max(0, Math.floor(Math.min(...screenRings.flatMap((ring) => ring.map((point) => point.y)))));
  const maxY = Math.min(viewport.height - 1, Math.ceil(Math.max(...screenRings.flatMap((ring) => ring.map((point) => point.y)))));

  for (let y = minY; y <= maxY; y += 1) {
    const scanY = y + 0.5;
    const xs: number[] = [];
    for (const ring of screenRings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const a = ring[j];
        const b = ring[i];
        if ((a.y > scanY) === (b.y > scanY)) {
          continue;
        }
        xs.push(a.x + ((scanY - a.y) * (b.x - a.x)) / (b.y - a.y || 1e-9));
      }
    }
    xs.sort((a, b) => a - b);

    for (let i = 0; i + 1 < xs.length; i += 2) {
      const start = Math.max(0, Math.floor(xs[i]));
      const end = Math.min(viewport.width - 1, Math.ceil(xs[i + 1]));
      for (let x = start; x <= end; x += 1) {
        blendPixel(image, (y * viewport.width + x) * 4, color);
      }
    }
  }
}

function fillPolygons(image: Uint8Array, viewport: Viewport, polygons: Point[][], color: Rgba): void {
  const merged = mergeRoadJunction(polygons);
  for (const ringSet of multiPolygonToRings(merged)) {
    fillRingSet(image, viewport, ringSet, color);
  }
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodePng(width: number, height: number, image: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(image.buffer, image.byteOffset + y * width * 4, width * 4).copy(raw, rowStart + 1);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createImage(width: number, height: number, color: Rgba): Uint8Array {
  const image = new Uint8Array(width * height * 4);
  for (let i = 0; i < image.length; i += 4) {
    image[i] = color.r;
    image[i + 1] = color.g;
    image[i + 2] = color.b;
    image[i + 3] = 255;
  }
  return image;
}

function renderRoadDataIntoImage(image: Uint8Array, viewport: Viewport, data: RoadBandData): void {
  const footprints = buildRoadLayerFootprints(data.bandBuckets);
  const bucketsByLayer = new Map<number, BandBucket[]>();
  for (const bucket of data.bandBuckets.values()) {
    const buckets = bucketsByLayer.get(bucket.roadLayer) ?? [];
    buckets.push(bucket);
    bucketsByLayer.set(bucket.roadLayer, buckets);
  }
  const localSlicesByLayer = new Map<number, RoadBandData["localZOrderSlices"]>();
  for (const slice of data.localZOrderSlices) {
    const slices = localSlicesByLayer.get(slice.layer) ?? [];
    slices.push(slice);
    localSlicesByLayer.set(slice.layer, slices);
  }

  footprints.forEach((footprint, index) => {
    if (index > 0) {
      fillPolygons(image, viewport, footprint.polygons, BACKGROUND);
    }
    const buckets = (bucketsByLayer.get(footprint.roadLayer) ?? []).sort((a, b) => a.band.zIndex - b.band.zIndex);
    for (const bucket of buckets) {
      fillPolygons(image, viewport, bucket.polygons, parseColor(bucket.band.color));
    }
    for (const slice of (localSlicesByLayer.get(footprint.roadLayer) ?? []).sort((a, b) => a.sliceIndex - b.sliceIndex)) {
      fillPolygons(image, viewport, slice.footprint, BACKGROUND);
      for (const item of slice.bands.slice().sort((a, b) => a.band.zIndex - b.band.zIndex)) {
        fillPolygons(image, viewport, [item.polygon], parseColor(item.band.color));
      }
    }
  });
}

export function renderRoadSceneToImage(scene: RoadPenScene, options: RoadScenePngOptions = {}): RoadSceneImage {
  const data = buildRoadBandPolygons(scene);
  const allPolygons = [...data.bandBuckets.values()].flatMap((bucket) => bucket.polygons);
  const viewport = viewportFor(allPolygons, options.maxWidth ?? 1400, options.maxHeight ?? 1000, options.padding ?? 72);
  const image = createImage(viewport.width, viewport.height, BACKGROUND);
  renderRoadDataIntoImage(image, viewport, data);
  return { width: viewport.width, height: viewport.height, image, data };
}

export function renderRoadScenePng(scene: RoadPenScene, outputPath: string, options: RoadScenePngOptions = {}): { width: number; height: number; bytes: number } {
  const rendered = renderRoadSceneToImage(scene, options);
  const png = encodePng(rendered.width, rendered.height, rendered.image);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, png);
  return { width: rendered.width, height: rendered.height, bytes: png.length };
}

function edgeBounds(edge: RoadEdge): Bounds {
  return pointBounds([edge.controlPoints]);
}

function expandedBoundsOverlap(a: Bounds, b: Bounds, padding: number): boolean {
  return a.minX - padding <= b.maxX && a.maxX + padding >= b.minX && a.minY - padding <= b.maxY && a.maxY + padding >= b.minY;
}

function mergeBounds(bounds: Bounds[]): Bounds {
  return {
    minX: Math.min(...bounds.map((item) => item.minX)),
    minY: Math.min(...bounds.map((item) => item.minY)),
    maxX: Math.max(...bounds.map((item) => item.maxX)),
    maxY: Math.max(...bounds.map((item) => item.maxY)),
  };
}

function findRoot(parent: number[], index: number): number {
  let root = index;
  while (parent[root] !== root) {
    root = parent[root];
  }
  while (parent[index] !== index) {
    const next = parent[index];
    parent[index] = root;
    index = next;
  }
  return root;
}

function union(parent: number[], a: number, b: number): void {
  const rootA = findRoot(parent, a);
  const rootB = findRoot(parent, b);
  if (rootA !== rootB) {
    parent[rootB] = rootA;
  }
}

export function splitSceneIntoSpatialPanels(scene: RoadPenScene, options: { clusterPadding?: number } = {}): RoadSceneAtlasPanel[] {
  if (scene.edges.length === 0) {
    return [];
  }

  const clusterPadding = options.clusterPadding ?? 32;
  const edgeBoundsList = scene.edges.map(edgeBounds);
  const parent = scene.edges.map((_, index) => index);
  const edgeIndexById = new Map(scene.edges.map((edge, index) => [edge.id, index]));
  const edgesByNode = new Map<string, number[]>();
  for (let i = 0; i < scene.edges.length; i += 1) {
    const edge = scene.edges[i];
    for (const nodeId of [edge.from, edge.to]) {
      const list = edgesByNode.get(nodeId) ?? [];
      list.push(i);
      edgesByNode.set(nodeId, list);
    }
  }

  for (const indexes of edgesByNode.values()) {
    for (let i = 1; i < indexes.length; i += 1) {
      union(parent, indexes[0], indexes[i]);
    }
  }

  for (let i = 0; i < edgeBoundsList.length; i += 1) {
    for (let j = i + 1; j < edgeBoundsList.length; j += 1) {
      if (expandedBoundsOverlap(edgeBoundsList[i], edgeBoundsList[j], clusterPadding)) {
        union(parent, i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < scene.edges.length; i += 1) {
    const root = findRoot(parent, i);
    const list = groups.get(root) ?? [];
    list.push(i);
    groups.set(root, list);
  }

  const nodeById = new Map(scene.nodes.map((node) => [node.id, node]));
  const panels = [...groups.values()].map((edgeIndexes) => {
    const edges = edgeIndexes.map((index) => scene.edges[index]);
    const nodeIds = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))];
    const nodes = nodeIds.flatMap((nodeId) => {
      const node = nodeById.get(nodeId);
      return node ? [{ ...node }] : [];
    });
    const bounds = mergeBounds(edgeIndexes.map((index) => edgeBoundsList[index]));
    return {
      id: "",
      scene: {
        version: scene.version,
        units: scene.units,
        scalePxPerM: scene.scalePxPerM,
        profiles: scene.profiles.map((profile) => ({ ...profile })),
        nodes,
        edges: edges.map((edge) => ({
          ...edge,
          controlPoints: edge.controlPoints.map((point) => ({ ...point })),
        })),
      },
      edgeIds: edges.map((edge) => edge.id).filter((edgeId) => edgeIndexById.has(edgeId)),
      nodeIds,
      bounds,
    };
  });

  panels.sort((a, b) => {
    const rowEpsilon = Math.max(64, clusterPadding);
    if (Math.abs(a.bounds.minY - b.bounds.minY) <= rowEpsilon) {
      return a.bounds.minX - b.bounds.minX;
    }
    return a.bounds.minY - b.bounds.minY;
  });

  return panels.map((panel, index) => ({
    ...panel,
    id: `S${String(index + 1).padStart(2, "0")}`,
  }));
}

function drawRect(image: Uint8Array, width: number, height: number, x: number, y: number, rectWidth: number, rectHeight: number, color: Rgba): void {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(width, Math.ceil(x + rectWidth));
  const bottom = Math.min(height, Math.ceil(y + rectHeight));
  for (let py = top; py < bottom; py += 1) {
    for (let px = left; px < right; px += 1) {
      blendPixel(image, (py * width + px) * 4, color);
    }
  }
}

function drawRectOutline(image: Uint8Array, width: number, height: number, x: number, y: number, rectWidth: number, rectHeight: number, color: Rgba): void {
  drawRect(image, width, height, x, y, rectWidth, 1, color);
  drawRect(image, width, height, x, y + rectHeight - 1, rectWidth, 1, color);
  drawRect(image, width, height, x, y, 1, rectHeight, color);
  drawRect(image, width, height, x + rectWidth - 1, y, 1, rectHeight, color);
}

const FONT_5X7: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "010", "010", "111"],
  "2": ["111", "001", "001", "111", "100", "100", "111"],
  "3": ["111", "001", "001", "111", "001", "001", "111"],
  "4": ["101", "101", "101", "111", "001", "001", "001"],
  "5": ["111", "100", "100", "111", "001", "001", "111"],
  "6": ["111", "100", "100", "111", "101", "101", "111"],
  "7": ["111", "001", "001", "010", "010", "010", "010"],
  "8": ["111", "101", "101", "111", "101", "101", "111"],
  "9": ["111", "101", "101", "111", "001", "001", "111"],
  E: ["111", "100", "100", "111", "100", "100", "111"],
  G: ["111", "100", "100", "101", "101", "101", "111"],
  L: ["100", "100", "100", "100", "100", "100", "111"],
  S: ["111", "100", "100", "111", "001", "001", "111"],
  W: ["101", "101", "101", "101", "101", "111", "101"],
  " ": ["000", "000", "000", "000", "000", "000", "000"],
};

function drawText(image: Uint8Array, width: number, height: number, x: number, y: number, text: string, color: Rgba, scale = 2): void {
  let cursorX = x;
  for (const char of text.toUpperCase()) {
    const glyph = FONT_5X7[char] ?? FONT_5X7[" "];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] === "1") {
          drawRect(image, width, height, cursorX + col * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cursorX += 4 * scale;
  }
}

function blitImage(target: Uint8Array, targetWidth: number, targetHeight: number, source: Uint8Array, sourceWidth: number, sourceHeight: number, x: number, y: number): void {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  for (let sy = 0; sy < sourceHeight; sy += 1) {
    const ty = top + sy;
    if (ty < 0 || ty >= targetHeight) {
      continue;
    }
    for (let sx = 0; sx < sourceWidth; sx += 1) {
      const tx = left + sx;
      if (tx < 0 || tx >= targetWidth) {
        continue;
      }
      const sourceIndex = (sy * sourceWidth + sx) * 4;
      const targetIndex = (ty * targetWidth + tx) * 4;
      target[targetIndex] = source[sourceIndex];
      target[targetIndex + 1] = source[sourceIndex + 1];
      target[targetIndex + 2] = source[sourceIndex + 2];
      target[targetIndex + 3] = source[sourceIndex + 3];
    }
  }
}

export function renderRoadSceneAtlasPng(scene: RoadPenScene, outputPath: string, options: RoadSceneAtlasOptions = {}): RoadSceneAtlasResult {
  const panels = splitSceneIntoSpatialPanels(scene, { clusterPadding: options.clusterPadding });
  const cellWidth = options.cellWidth ?? 420;
  const cellHeight = options.cellHeight ?? 300;
  const panelGap = options.panelGap ?? 16;
  const columns = Math.max(1, options.columns ?? Math.ceil(Math.sqrt(Math.max(1, panels.length))));
  const rows = Math.max(1, Math.ceil(Math.max(1, panels.length) / columns));
  const width = columns * cellWidth + (columns + 1) * panelGap;
  const height = rows * cellHeight + (rows + 1) * panelGap;
  const image = createImage(width, height, BACKGROUND);
  const resultPanels: RoadSceneAtlasResult["panels"] = [];

  panels.forEach((panel, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const cellX = panelGap + col * (cellWidth + panelGap);
    const cellY = panelGap + row * (cellHeight + panelGap);
    const headerHeight = 28;
    drawRect(image, width, height, cellX, cellY, cellWidth, cellHeight, PANEL_BACKGROUND);
    drawRectOutline(image, width, height, cellX, cellY, cellWidth, cellHeight, PANEL_BORDER);

    const rendered = renderRoadSceneToImage(panel.scene, {
      maxWidth: cellWidth - 24,
      maxHeight: cellHeight - headerHeight - 16,
      padding: options.scenePadding ?? 56,
    });
    const drawX = cellX + Math.floor((cellWidth - rendered.width) / 2);
    const drawY = cellY + headerHeight + Math.floor((cellHeight - headerHeight - rendered.height) / 2);
    blitImage(image, width, height, rendered.image, rendered.width, rendered.height, drawX, drawY);

    const outerLaneCoverageGaps = rendered.data.geometryIssues.counts.outerLaneCoverageGap ?? 0;
    drawText(
      image,
      width,
      height,
      cellX + 10,
      cellY + 8,
      `${panel.id} E${panel.edgeIds.length} W${rendered.data.warnings.length} LG${outerLaneCoverageGaps}`,
      PANEL_TEXT,
      2,
    );
    resultPanels.push({
      id: panel.id,
      edgeIds: panel.edgeIds,
      nodeIds: panel.nodeIds,
      bounds: panel.bounds,
      warnings: rendered.data.warnings.length,
      warningMessages: rendered.data.warnings,
      issueCounts: rendered.data.geometryIssues.counts,
      probes: rendered.data.geometryIssues.markers.map((marker, markerIndex) => ({
        id: `${panel.id}-P${String(markerIndex + 1).padStart(2, "0")}`,
        type: marker.type,
        point: marker.point,
        passed: true,
        message: marker.message,
      })),
      outerLaneCoverageGaps,
    });
  });

  const png = encodePng(width, height, image);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, png);
  const json = JSON.stringify(
    {
      width,
      height,
      panelCount: panels.length,
      panels: resultPanels,
    },
    null,
    2,
  );
  const jsonOutputPath = options.jsonOutputPath ?? outputPath.replace(/\.png$/i, ".json");
  mkdirSync(dirname(jsonOutputPath), { recursive: true });
  writeFileSync(jsonOutputPath, json);
  return { width, height, bytes: png.length, jsonBytes: Buffer.byteLength(json), panelCount: panels.length, panels: resultPanels };
}
