/**
 * 渲染层全局常量与预算。
 *
 * 这些值集中控制「自动选级 / 预算降级 / 极区夹紧」的行为，方便统一调参。
 * 满填充虽然单格成本极低（1 字节 + GPU 派生），仍受 `maxCells` 约束以控制**绘制量**（填充率），
 * 避免「虽然不卡 CPU，但海量半透盒叠加拖累 GPU 像素填充」。
 */
export const RENDER_DEFAULTS = {
  /** 自动选级时，期望单格在屏幕上的目标像素尺寸（越大→级别越粗）。 */
  levelPx: 64,
  /** 标注 / 满填充格数预算；自动模式下超则**级别降级**（clampLevelByBudget）。 */
  maxCells: 2_000_000,
  /** 线层预算（更宽，线数 = nx+ny，远小于格数）。 */
  maxLatticeCells: 8_000_000,
  /** 标注数量封顶。 */
  maxLabels: 1_000,
  /** 中低纬南北夹紧到 ±88°，极区走专门收敛分支（本层仅做夹紧）。 */
  POLAR_LIMIT_DEG: 88,
} as const

/** 北斗各级网格单元尺寸（弧秒），下标 = 级别（1..10）；与 `beidou-grid` 编解码层 `gridSizes1` 同口径。 */
export const GRID_CELL_SECONDS: ReadonlyArray<readonly [number, number]> = [
  [1, 1], // level 0 占位（不使用）
  [21600, 14400], // 1: 6°×4°
  [1800, 1800], // 2: 0.5°×0.5°
  [900, 600], // 3: 0.25°×10′
  [60, 60], // 4: 1′×1′
  [4, 4], // 5
  [2, 2], // 6
  [0.25, 0.25], // 7
  [0.03125, 0.03125], // 8
  [0.00390625, 0.00390625], // 9
  [0.00048828125, 0.00048828125], // 10
]

/** 级别合法范围。 */
export const MIN_LEVEL = 1
export const MAX_LEVEL = 10

/** 把级别夹到 [MIN_LEVEL, MAX_LEVEL]。 */
export const clampLevel = (level: number): number =>
  Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(level)))

/** 第 `level` 级单元的度步长 `[stepLonDeg, stepLatDeg]`。 */
export const cellStepDeg = (level: number): [number, number] => {
  const lvl = clampLevel(level)
  const [secLon, secLat] = GRID_CELL_SECONDS[lvl]!
  return [secLon / 3600, secLat / 3600]
}
