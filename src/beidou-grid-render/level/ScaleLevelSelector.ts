/**
 * 选级别：按当前比例尺（每像素覆盖的度数）挑一个让单格在屏上接近 `levelPx` 像素的级别。
 *
 * 思路：`每像素度数 = 可视经度跨度 / 画布宽(px)`；目标单格度数 `= levelPx × 每像素度数`；
 * 在 1..10 级中选「单格度尺寸」与目标最接近（对数尺度）的级别。
 * 这样相机越拉近、跨度越小→目标越小→自动切到更细的级别，反之切粗。
 */
import { MIN_LEVEL, MAX_LEVEL, cellStepDeg, clampLevel } from '../render-constants'

/**
 * @param widthDeg 可视区域经度跨度（度）。
 * @param canvasWidthPx 画布宽度（像素）。
 * @param levelPx 期望单格屏幕像素尺寸。
 * @returns 级别（1..10）。
 */
export const selectLevelByScale = (
  widthDeg: number,
  canvasWidthPx: number,
  levelPx: number,
): number => {
  const px = Math.max(1, canvasWidthPx)
  const degPerPx = Math.max(1e-12, widthDeg) / px
  const targetDeg = Math.max(1e-12, levelPx * degPerPx)
  const logTarget = Math.log(targetDeg)

  let best = MIN_LEVEL
  let bestDist = Number.POSITIVE_INFINITY
  for (let level = MIN_LEVEL; level <= MAX_LEVEL; level++) {
    const cellLatDeg = cellStepDeg(level)[1]
    const dist = Math.abs(Math.log(cellLatDeg) - logTarget)
    if (dist < bestDist) {
      bestDist = dist
      best = level
    }
  }
  return clampLevel(best)
}
