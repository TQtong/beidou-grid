// ============================================================
// app/grid-workflows.ts — 纯函数业务层（无 Cesium / Vue 依赖）
// 职责：把"编码 / 网格化 / 时间窗 / 冲突检测 / 隔离"等空域管制业务逻辑
//       沉淀为可单测、可复用的纯函数。只 import 引擎 re-export 的真实编码函数
//       （pointToCode2D / pointToCode3D / levelStepDegrees / levelSizeMeters）
//       与数据层的 RoutePoint 类型，绝不触碰渲染对象。
// 被消费：App.vue（四场景编排）。
// ============================================================

import {
  pointToCode2D,
  pointToCode3D,
  levelStepDegrees,
  levelSizeMeters,
} from '../beidou-grid-render'
import type { RoutePoint } from './low-altitude-data'

// ──────────────────────────────────────────────
// 3.0 常量与小工具
// ──────────────────────────────────────────────

/** 纬向每度米长（恒定近似）。 */
const METERS_PER_DEG_LAT = 111_320

/** 经向每度米长随纬度（高纬收缩 = ×cos(lat)）。 */
export const metersPerDegLon = (latDeg: number): number =>
  METERS_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180)

/** 编码兜底：极端坐标可能抛异常，统一捕获返回占位 '—'。 */
const safeCode = (fn: () => string): string => {
  try {
    return fn()
  } catch {
    return '—'
  }
}

// ──────────────────────────────────────────────
// 3.1 机型尺寸 → 网格层级（国标映射）
// ──────────────────────────────────────────────

export type AircraftSizeClass = 'micro' | 'small' | 'large'

/**
 * 机型最大尺寸（米）→ 隔离/标识网格级别。
 * <0.5m → L8；0.5–8m → L7；>8m → L6
 * （《民用无人驾驶航空器系统身份识别三维空间位置标识编码》）。
 */
export const levelForAircraftSize = (sizeMeters: number): number => {
  if (sizeMeters < 0.5) return 8
  if (sizeMeters <= 8) return 7
  return 6
}

/** 机型尺寸 → 体量分级标签。 */
export const sizeClassForAircraft = (sizeMeters: number): AircraftSizeClass => {
  if (sizeMeters < 0.5) return 'micro'
  if (sizeMeters <= 8) return 'small'
  return 'large'
}

// ──────────────────────────────────────────────
// 3.2 单点编码读数
// ──────────────────────────────────────────────

export interface GridCodeReadout {
  code2D: string
  code3D: string
  level: number
  lonDeg: number
  latDeg: number
  heightMeters: number
}

/** 计算单点在给定级别的 2D/3D 北斗码读数（供十字丝 HUD、拾取卡片用）。 */
export const codeAt = (
  lonDeg: number,
  latDeg: number,
  heightMeters: number,
  level: number,
): GridCodeReadout => ({
  code2D: safeCode(() => pointToCode2D(lonDeg, latDeg, level)),
  code3D: safeCode(() => pointToCode3D(lonDeg, latDeg, heightMeters, level)),
  level,
  lonDeg,
  latDeg,
  heightMeters,
})

// ──────────────────────────────────────────────
// 3.3 航迹/航路网格化（去重三维码序列）
// ──────────────────────────────────────────────

export interface GridSequenceCell {
  /** 从 1 起的序号。 */
  index: number
  code3D: string
  code2D: string
  lonDeg: number
  latDeg: number
  heightMeters: number
}

/**
 * 把折线航路网格化为有序、去重的三维网格码序列。
 * 算法：相邻两点间按 samplesPerSeg 等分插值，每个采样点编码 3D 码；
 * 用 Set 去重并保留首次出现顺序 = 有前后关系的网格序列。
 */
export const gridifyRoute = (
  route: readonly RoutePoint[],
  level: number,
  samplesPerSeg = 6,
): GridSequenceCell[] => {
  const cells: GridSequenceCell[] = []
  if (route.length === 0) return cells

  const seen = new Set<string>()
  const pushPoint = (lon: number, lat: number, h: number): void => {
    const code3D = safeCode(() => pointToCode3D(lon, lat, h, level))
    if (code3D === '—' || seen.has(code3D)) return
    seen.add(code3D)
    cells.push({
      index: cells.length + 1,
      code3D,
      code2D: safeCode(() => pointToCode2D(lon, lat, level)),
      lonDeg: lon,
      latDeg: lat,
      heightMeters: h,
    })
  }

  if (route.length === 1) {
    const p = route[0]!
    pushPoint(p.lon, p.lat, p.height)
    return cells
  }

  for (let s = 0; s <= route.length - 2; s++) {
    const a = route[s]!
    const b = route[s + 1]!
    for (let k = 0; k < samplesPerSeg; k++) {
      const t = k / samplesPerSeg
      pushPoint(
        a.lon + (b.lon - a.lon) * t,
        a.lat + (b.lat - a.lat) * t,
        a.height + (b.height - a.height) * t,
      )
    }
  }
  const last = route[route.length - 1]!
  pushPoint(last.lon, last.lat, last.height)
  return cells
}

// ──────────────────────────────────────────────
// 3.4 航路长度（米）
// ──────────────────────────────────────────────

/** 三维欧氏累加：经向差×metersPerDegLon(两点纬度均值)，纬向差×111320，高度差直接用。 */
export const routeLengthMeters = (route: readonly RoutePoint[]): number => {
  let total = 0
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i]!
    const b = route[i + 1]!
    const latMid = (a.lat + b.lat) / 2
    const dx = (b.lon - a.lon) * metersPerDegLon(latMid)
    const dy = (b.lat - a.lat) * METERS_PER_DEG_LAT
    const dh = b.height - a.height
    total += Math.sqrt(dx * dx + dy * dy + dh * dh)
  }
  return total
}

// ──────────────────────────────────────────────
// 3.5 时间窗口分配
// ──────────────────────────────────────────────

export interface TimeWindowCell extends GridSequenceCell {
  /** 进入该格的相对秒（自起飞 0 秒起）。 */
  enterSec: number
  /** 离开该格的相对秒。 */
  exitSec: number
}

/**
 * 匀速沿网格序列推进，给每格分配占用时间窗。
 * 总耗时 = 航路总长 / 速度；单格占用 = 总耗时 / 格数；
 * startSec 用于多计划在同一时间轴上对齐（不同计划不同起飞时刻）。
 */
export const assignTimeWindows = (
  cells: readonly GridSequenceCell[],
  route: readonly RoutePoint[],
  speedMps: number,
  startSec = 0,
): TimeWindowCell[] => {
  if (cells.length === 0) return []
  const totalLen = Math.max(1, routeLengthMeters(route))
  const totalSec = totalLen / Math.max(0.1, speedMps)
  const perCell = totalSec / cells.length
  return cells.map((cell, i) => ({
    ...cell,
    enterSec: startSec + i * perCell,
    exitSec: startSec + (i + 1) * perCell,
  }))
}

/** mm:ss 格式化（向下取整、补零）。 */
export const formatRelSec = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

// ──────────────────────────────────────────────
// 3.6 冲突检测（同格同窗 + 半小时复用保护带）
// ──────────────────────────────────────────────

export interface PlanWindows {
  planId: string
  cells: readonly TimeWindowCell[]
}

export interface GridConflict {
  code3D: string
  planA: string
  planB: string
  overlapStartSec: number
  overlapEndSec: number
  lonDeg: number
  latDeg: number
  heightMeters: number
}

/** 两占用窗是否重叠（带 guard 保护带）。 */
const windowsOverlap = (a: TimeWindowCell, b: TimeWindowCell, guard: number): boolean =>
  a.enterSec - guard < b.exitSec && b.enterSec - guard < a.exitSec

/**
 * 多计划冲突检测：按 code3D 汇总各计划在该格的占用窗，对同一格里不同计划两两比对；
 * 时窗重叠（含 guardSec 保护带）即冲突。默认 guard=1800（半小时网格复用策略）。
 */
export const detectConflicts = (
  plans: readonly PlanWindows[],
  guardSec = 1800,
): GridConflict[] => {
  const byCode = new Map<string, { planId: string; w: TimeWindowCell }[]>()
  for (const plan of plans) {
    for (const w of plan.cells) {
      const list = byCode.get(w.code3D)
      if (list) list.push({ planId: plan.planId, w })
      else byCode.set(w.code3D, [{ planId: plan.planId, w }])
    }
  }

  const conflicts: GridConflict[] = []
  for (const [code3D, occ] of byCode) {
    for (let i = 0; i < occ.length; i++) {
      for (let j = i + 1; j < occ.length; j++) {
        const A = occ[i]!
        const B = occ[j]!
        if (A.planId === B.planId) continue
        if (windowsOverlap(A.w, B.w, guardSec)) {
          conflicts.push({
            code3D,
            planA: A.planId,
            planB: B.planId,
            overlapStartSec: Math.max(A.w.enterSec, B.w.enterSec),
            overlapEndSec: Math.min(A.w.exitSec, B.w.exitSec),
            lonDeg: A.w.lonDeg,
            latDeg: A.w.latDeg,
            heightMeters: A.w.heightMeters,
          })
        }
      }
    }
  }
  return conflicts
}

// ──────────────────────────────────────────────
// 3.7 隔离网格集合（障碍物圆柱覆盖 → 网格中心）
// ──────────────────────────────────────────────

export interface IsolationCell {
  code3D: string
  lonDeg: number
  latDeg: number
  heightMeters: number
}

/**
 * 把一个圆柱形覆盖（障碍物/禁限飞：中心 + 底顶高 + 半径 + 级别）展开为它覆盖到的
 * 网格中心集合。水平按米做椭圆判定，竖直按 levelSizeMeters(level) 分层。
 * 受 maxSpan=24 上限保护，极端半径不卡死。
 */
export const isolationCells = (
  centerLon: number,
  centerLat: number,
  baseHeight: number,
  topHeight: number,
  radiusM: number,
  level: number,
): IsolationCell[] => {
  const cells: IsolationCell[] = []
  const [stepLonDeg, stepLatDeg] = levelStepDegrees(level) // ← 元组解构
  const cellM = levelSizeMeters(level)
  const mPerLon = metersPerDegLon(centerLat)
  const planes = Math.max(1, Math.round((topHeight - baseHeight) / cellM))

  const maxSpan = 24
  const lonSpan = Math.min(maxSpan, Math.ceil(radiusM / mPerLon / stepLonDeg))
  const latSpan = Math.min(maxSpan, Math.ceil(radiusM / METERS_PER_DEG_LAT / stepLatDeg))

  const r2 = Math.max(1, radiusM * radiusM)
  const seen = new Set<string>()
  for (let zi = 0; zi < planes; zi++) {
    const h = baseHeight + (zi + 0.5) * cellM
    for (let dj = -latSpan; dj <= latSpan; dj++) {
      for (let di = -lonSpan; di <= lonSpan; di++) {
        const lon = centerLon + di * stepLonDeg
        const lat = centerLat + dj * stepLatDeg
        const dxM = (lon - centerLon) * mPerLon
        const dyM = (lat - centerLat) * METERS_PER_DEG_LAT
        if ((dxM * dxM) / r2 + (dyM * dyM) / r2 > 1) continue
        const code3D = safeCode(() => pointToCode3D(lon, lat, h, level))
        if (code3D === '—' || seen.has(code3D)) continue
        seen.add(code3D)
        cells.push({ code3D, lonDeg: lon, latDeg: lat, heightMeters: h })
      }
    }
  }
  return cells
}
