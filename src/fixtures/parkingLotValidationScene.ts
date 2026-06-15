import exportedParkingLotScene from "./parkingLotValidationScene.roadpen.json";
import { normalizeScene } from "../io/io";
import type { RoadPenScene } from "../types";

interface RoadPenSceneExport {
  exportedAt?: string;
  scene?: Partial<RoadPenScene>;
}

const exportedScene = exportedParkingLotScene as RoadPenSceneExport;
const normalizedScene = normalizeScene(exportedScene.scene ?? {});

export const PARKING_LOT_VALIDATION_SOURCE = {
  fileName: "parkingLotValidationScene.roadpen.json",
  exportedAt: exportedScene.exportedAt ?? null,
  nodeCount: normalizedScene.nodes.length,
  edgeCount: normalizedScene.edges.length,
  profileCount: normalizedScene.profiles.length,
  layers: [...new Set(normalizedScene.edges.map((edge) => edge.layer ?? 0))].sort((a, b) => a - b),
};

export function buildParkingLotValidationScene(): RoadPenScene {
  return structuredClone(normalizedScene);
}
