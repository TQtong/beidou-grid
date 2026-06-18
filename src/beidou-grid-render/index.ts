/**
 * 渲染层 barrel 导出。
 */
export { default as BeiDouGridScene } from './BeiDouGridScene'
export type {
  BeiDouGridConfig,
  PickedCell,
  GridDims,
  OccupancyProvider,
} from './BeiDouGridScene'

export type { GridRegionInput } from './region/ViewRegionResolver'
export {
  resolveViewRegion,
  clampLevelByBudget,
} from './region/ViewRegionResolver'
export { selectLevelByScale } from './level/ScaleLevelSelector'
export {
  tessellate,
  tessellationCellCount,
  type Tessellation,
  type GridRegion,
  type HeightRange,
} from './grid/GridTessellator'

export { RENDER_DEFAULTS, cellStepDeg } from './render-constants'

export { default as GridLinePrimitive } from './primitive/GridLinePrimitive'
export { default as GridLabelPrimitive } from './primitive/GridLabelPrimitive'
export { default as GridInstancedFill } from './primitive/GridInstancedFill'
export type { OccupancyColoring } from './primitive/GridInstancedFill'
export {
  default as GridInstancedVoxelGPU,
  GEODETIC_SPAN_THRESHOLD_DEG,
} from './primitive/GridInstancedVoxelGPU'
export type { VoxelGpuOptions } from './primitive/GridInstancedVoxelGPU'

export {
  benchInstancedGpuVsAttribute,
  benchInstancedGpuSweep,
  printInstancedGpuBench,
  type GpuBenchResult,
  type GpuBenchRow,
} from './bench/InstancedGpuBench'

export { pointToCode2D, pointToCode3D } from './geo-bridge'
