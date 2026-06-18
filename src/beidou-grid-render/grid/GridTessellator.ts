/**
 * 剖分器：把「区域 + 级别 + 高度范围」转成**规则网格模型** `Tessellation`。
 *
 * `Tessellation` 是渲染层的核心数据契约：位置完全由 `原点 + 步长 × 整数索引` 决定，
 * 下游 GPU 引擎据此用 `gl_InstanceID` 在着色器内推导每格位置（零位置上传，见设计 03）。
 *
 * 网格对齐：原点按级别步长**向 0° 对齐**地向下取整（`floor(coord/step)*step`）。
 * 北斗各级网格在经/纬向均以 0° 为锚点均匀细分（子级在父级内整数等分），故 0° 对齐的均匀格
 * 与真实北斗网格单元重合——拾取出码（geo-bridge）与渲染落格因而一致。
 */
import { cellStepDeg } from '../render-constants'

/** 解析后的可视/给定区域（度）。 */
export interface GridRegion {
  west: number
  south: number
  east: number
  north: number
  /** 经向跨度（度，已处理跨反子午线）。 */
  widthDeg: number
  /** 纬向跨度（度）。 */
  heightDeg: number
  /** 是否跨越 ±180° 反子午线。 */
  crossesAntimeridian: boolean
}

/** 高度范围（米）。`step<=0` 视为单层，层高取整段 `[min,max]`。 */
export interface HeightRange {
  min: number
  max: number
  step: number
}

/** 规则网格模型（见设计术语表）。 */
export interface Tessellation {
  level: number
  /** 区域原点（西南角）经度，已按步长向 0° 对齐。 */
  originLonDeg: number
  /** 区域原点（西南角）纬度，已按步长向 0° 对齐。 */
  originLatDeg: number
  stepLonDeg: number
  stepLatDeg: number
  /** 经向格数。 */
  nx: number
  /** 纬向格数。 */
  ny: number
  /** 各高度层底高（米），长度 = planes。 */
  zPlaneFloors: number[]
  /** 高度层步长（米，>0）。 */
  heightStep: number
  crossesAntimeridian: boolean
}

/** 向 0° 对齐地向下取整到步长网格。 */
const snapFloor = (coord: number, step: number): number => Math.floor(coord / step) * step

/**
 * 由「区域 + 级别 + 高度范围」剖分出规则网格模型。
 *
 * @param region 解析后的区域（建议来自 `ViewRegionResolver`，已夹纬度、已规整经度）。
 * @param level 网格级别（1..10）。
 * @param height 高度范围（米）。
 */
export const tessellate = (region: GridRegion, level: number, height: HeightRange): Tessellation => {
  const [stepLonDeg, stepLatDeg] = cellStepDeg(level)

  const originLonDeg = snapFloor(region.west, stepLonDeg)
  const originLatDeg = snapFloor(region.south, stepLatDeg)

  // 经向跨度：跨反子午线时 east 已在 resolver 内 +360 规整，故直接用 widthDeg。
  const spanLonDeg = region.crossesAntimeridian
    ? region.widthDeg + (region.west - originLonDeg)
    : region.east - originLonDeg
  const spanLatDeg = region.north - originLatDeg

  const nx = Math.max(1, Math.ceil(spanLonDeg / stepLonDeg))
  const ny = Math.max(1, Math.ceil(spanLatDeg / stepLatDeg))

  // 高度层。
  const zPlaneFloors: number[] = []
  let heightStep: number
  if (!(height.step > 0)) {
    // 单层：整段 [min,max] 作一层（层高下限 1 m 防零）。
    heightStep = Math.max(1, height.max - height.min)
    zPlaneFloors.push(height.min)
  } else {
    heightStep = height.step
    const planes = Math.max(1, Math.ceil((height.max - height.min) / height.step))
    for (let zi = 0; zi < planes; zi++) zPlaneFloors.push(height.min + zi * height.step)
  }

  return {
    level,
    originLonDeg,
    originLatDeg,
    stepLonDeg,
    stepLatDeg,
    nx,
    ny,
    zPlaneFloors,
    heightStep,
    crossesAntimeridian: region.crossesAntimeridian,
  }
}

/** 当前剖分的总格数 = nx·ny·planes。 */
export const tessellationCellCount = (t: Tessellation): number =>
  t.nx * t.ny * Math.max(1, t.zPlaneFloors.length)
