// ============================================================
// index.ts — 北斗网格渲染层统一导出口
// 层级：L4（对外门面）
// 职责：收敛对外 API，应用层只 import 此文件。
// ============================================================

export { default as BeiDouGridScene } from './BeiDouGridScene';
export type { BeiDouGridConfig } from './BeiDouGridScene';
export type { Aircraft } from './isolation/AirspaceIsolator';
export type { HeightRange, Tessellation } from './grid/GridTessellator';
export type { OccupancyColoring } from './primitive/GridInstancedFill';
export type { LevelPxConfig, LevelPick } from './level/ScaleLevelSelector';
export type { RegionResult } from './region/ViewRegionResolver';
export type { CellBox } from './geo-bridge';
export type { PolarBand, Hemisphere } from './polar-bridge';
export type { PolarTessellation } from './grid/PolarGridTessellator';

export { default as ScaleLevelSelector } from './level/ScaleLevelSelector';
export { default as ViewRegionResolver } from './region/ViewRegionResolver';
export { default as GridTessellator } from './grid/GridTessellator';
export { default as PolarGridTessellator } from './grid/PolarGridTessellator';
export { default as GridLinePrimitive } from './primitive/GridLinePrimitive';
export { default as GridFillPrimitive } from './primitive/GridFillPrimitive';
export { default as GridInstancedFill } from './primitive/GridInstancedFill';
export { default as GridLabelPrimitive } from './primitive/GridLabelPrimitive';
export { default as PolarGridLinePrimitive } from './primitive/PolarGridLinePrimitive';
export { default as AirspaceIsolator } from './isolation/AirspaceIsolator';
export { default as GeoJsonBoundaryLoader } from './loader/GeoJsonBoundaryLoader';
export type { BoundaryLoadResult, BoundaryStyle } from './loader/GeoJsonBoundaryLoader';

export {
  MIN_LEVEL,
  MAX_LEVEL,
  POLAR_LIMIT_DEG,
  SAFE_LAT_DEG,
  LEVEL_SIZE_METERS,
  LEVEL_STEP_DEGREES,
  RENDER_DEFAULTS,
  levelSizeMeters,
  levelStepDegrees,
  packColorToFloat,
  enuFrameAt,
} from './render-constants';

export {
  clampToEncodableRange,
  snapToGridOrigin,
  codeToBox2D,
  pointToCellBox3D,
  pointToCode2D,
  pointToCode3D,
} from './geo-bridge';

export {
  isPolarLat,
  polarPointToCode2D,
  polarPointToCode3D,
  enumeratePolarBandsNorth,
} from './polar-bridge';

// ── 重设计：立方体场渲染路径（统一实例化立方体 + 拾取 + 无人机）──
export { default as BeiDouFieldScene } from './control/BeiDouFieldScene';
export type { BeiDouFieldConfig } from './control/BeiDouFieldScene';
export { default as DroneController } from './control/DroneController';
export type { DronePosition } from './control/DroneController';
export { default as GridCubeField } from './core/GridCubeField';
export type { FieldMode, PickCallback } from './core/GridCubeField';
export { default as GridStateModel, Category } from './core/GridStateModel';
export { default as InstancePicker } from './core/InstancePicker';
