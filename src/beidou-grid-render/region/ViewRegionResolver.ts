/**
 * 区域解析：相机可视矩形 ∩ 给定范围 → 规整的 `GridRegion`，并提供「预算降级」。
 *
 * - 可视矩形来自 `scene.camera.computeViewRectangle`（俯仰过大时可能返回 undefined，做兜底）。
 * - 纬度夹紧到 ±`POLAR_LIMIT_DEG`（极区另有专门分支，本层只做夹紧）。
 * - `clampLevelByBudget`：自动模式下若 `nx·ny·planes` 超 `maxCells`，逐级降级直到落入预算。
 */
import * as Cesium from 'cesium'
import { RENDER_DEFAULTS, MIN_LEVEL, cellStepDeg, clampLevel } from '../render-constants'
import type { GridRegion, HeightRange } from '../grid/GridTessellator'

/** 给定经纬度范围（度）。 */
export interface GridRegionInput {
  west: number
  south: number
  east: number
  north: number
}

interface SceneLike {
  camera: { computeViewRectangle(ellipsoid?: unknown, result?: Cesium.Rectangle): Cesium.Rectangle | undefined }
}

const POLAR = RENDER_DEFAULTS.POLAR_LIMIT_DEG

const clampLat = (lat: number): number => Math.min(POLAR, Math.max(-POLAR, lat))

const _viewScratch = new Cesium.Rectangle()

/** 相机可视矩形（度）；不可得返回 undefined。 */
const viewRectangleDeg = (scene: SceneLike): GridRegionInput | undefined => {
  const rect = scene.camera.computeViewRectangle(Cesium.Ellipsoid.WGS84, _viewScratch)
  if (!rect) return undefined
  const toDeg = Cesium.Math.toDegrees
  return {
    west: toDeg(rect.west),
    south: toDeg(rect.south),
    east: toDeg(rect.east),
    north: toDeg(rect.north),
  }
}

/** 构造 GridRegion（计算跨度 + 反子午线标志），输入已是度。 */
const makeRegion = (west: number, south: number, east: number, north: number): GridRegion => {
  const crossesAntimeridian = east < west
  const widthDeg = crossesAntimeridian ? east + 360 - west : east - west
  const heightDeg = north - south
  return { west, south, east, north, widthDeg, heightDeg, crossesAntimeridian }
}

/**
 * 解析渲染区域。
 * @param scene Cesium 场景（提供相机可视矩形）。
 * @param given 可选给定范围；提供时与可视矩形求交（都不跨反子午线的常规情形），相机移开 → 交集为空 → undefined（上层清空）。
 * @returns 规整区域；无有效区域返回 undefined。
 */
export const resolveViewRegion = (
  scene: SceneLike,
  given?: GridRegionInput,
): GridRegion | undefined => {
  const view = viewRectangleDeg(scene)

  if (!given) {
    if (!view) return undefined
    const south = clampLat(view.south)
    const north = clampLat(view.north)
    if (north <= south) return undefined
    return makeRegion(view.west, south, view.east, view.north > north ? north : view.north)
  }

  // 给定范围：纬度夹紧；经度**保留方向**（west>east 表示向东跨 ±180°），以支持跨反子午线。
  const gSouth = clampLat(Math.min(given.south, given.north))
  const gNorth = clampLat(Math.max(given.south, given.north))
  if (gNorth <= gSouth) return undefined
  const gWest = given.west
  const gEast = given.east
  const givenCrosses = gEast < gWest

  // 与可视矩形求交（仅当给定与可视都不跨反子午线的常规情形）；否则直接用给定（保留跨界语义）。
  if (view && view.east > view.west && !givenCrosses) {
    const west = Math.max(gWest, view.west)
    const east = Math.min(gEast, view.east)
    const south = Math.max(gSouth, clampLat(view.south))
    const north = Math.min(gNorth, clampLat(view.north))
    if (east <= west || north <= south) return undefined // 相机移开，交集为空
    return makeRegion(west, south, east, north)
  }

  return makeRegion(gWest, gSouth, gEast, gNorth)
}

/**
 * 预算降级：在自动模式下，若该级别下 `nx·ny·planes > maxCells`，逐级降级（变粗）直到落入预算或到最低级。
 * @returns 调整后的级别。
 */
export const clampLevelByBudget = (
  region: GridRegion,
  level: number,
  height: HeightRange,
  maxCells: number = RENDER_DEFAULTS.maxCells,
): number => {
  const planes =
    height.step > 0 ? Math.max(1, Math.ceil((height.max - height.min) / height.step)) : 1

  let lvl = clampLevel(level)
  while (lvl > MIN_LEVEL) {
    const [stepLon, stepLat] = cellStepDeg(lvl)
    const nx = Math.max(1, Math.ceil(region.widthDeg / stepLon))
    const ny = Math.max(1, Math.ceil(region.heightDeg / stepLat))
    if (nx * ny * planes <= maxCells) break
    lvl -= 1
  }
  return lvl
}
