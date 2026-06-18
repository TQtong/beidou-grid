/**
 * 渲染层 → 北斗编解码领域层（`src/beidou-grid/**`）的**唯一桥接点**。
 *
 * 拾取时把命中的经纬高转成北斗网格码即经此处调用领域层；本桥**不改**领域层实现（见设计 11 · 保持不变）。
 * 领域层 `Codec2D.encode` 内部 `getSecond` 对**恰为 0 或 NaN** 的经纬度会抛错（历史实现的边界），
 * 故此处对 0 做极小偏移、并以 try/catch 兜底，保证拾取在任何位置都不抛。
 */
import Codec2D from '../beidou-grid/legacy-codec/codec-2d'
import Codec3D from '../beidou-grid/legacy-codec/codec-3d'

const EARTH_SEMI_MAJOR_AXIS = 6378137

/** 把恰为 0 的度数推离 0 一个极小量（规避领域层 `getSecond` 对 0 的历史性抛错），不影响落格。 */
const nudge = (deg: number): number => (deg === 0 ? 1e-9 : deg)

/**
 * 经纬度 → 北斗二维网格码。
 * @returns 网格码；若领域层因极区/边界抛错则返回 undefined（调用方据此降级显示）。
 */
export const pointToCode2D = (lonDeg: number, latDeg: number, level: number): string | undefined => {
  try {
    return Codec2D.encode({ lngDegree: nudge(lonDeg), latDegree: nudge(latDeg) }, level)
  } catch {
    return undefined
  }
}

/**
 * 经纬高 → 北斗三维网格码（含高度方向编码）。
 * @returns 网格码；失败返回 undefined。
 */
export const pointToCode3D = (
  lonDeg: number,
  latDeg: number,
  heightMeters: number,
  level: number,
): string | undefined => {
  try {
    return Codec3D.encode(
      { lngDegree: nudge(lonDeg), latDegree: nudge(latDeg), elevation: heightMeters },
      EARTH_SEMI_MAJOR_AXIS,
      level,
    )
  } catch {
    return undefined
  }
}
