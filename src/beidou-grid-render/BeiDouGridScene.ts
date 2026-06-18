/**
 * L4 编排器：订阅相机、调度重建、暴露 API、拾取。
 *
 * 重建全链路（相机停稳 moveEnd → rAF 防抖 → 一次 rebuild）：
 *   1) 解析区域（可视 ∩ 给定）；无区域 → 隐藏各层并返回
 *   2) 选级别（手动锁定优先，否则按比例尺）
 *   3) 预算降级（自动模式按 maxCells 约束级别）
 *   4) 剖分 → Tessellation（记录 lastTess 供拾取）
 *   5) 线格网（主可见层）
 *   6) 标注（封顶 maxLabels）
 *   7) 满填充（生成器优先 + geodetic 透传；引擎按 fillEngine 二选一）
 */
import * as Cesium from 'cesium'
import { RENDER_DEFAULTS, clampLevel } from './render-constants'
import {
  resolveViewRegion,
  clampLevelByBudget,
  type GridRegionInput,
} from './region/ViewRegionResolver'
import { selectLevelByScale } from './level/ScaleLevelSelector'
import { tessellate, type Tessellation, type HeightRange } from './grid/GridTessellator'
import GridLinePrimitive from './primitive/GridLinePrimitive'
import GridLabelPrimitive from './primitive/GridLabelPrimitive'
import GridInstancedFill, { type OccupancyColoring } from './primitive/GridInstancedFill'
import GridInstancedVoxelGPU, {
  GEODETIC_SPAN_THRESHOLD_DEG,
  type VoxelGpuOptions,
} from './primitive/GridInstancedVoxelGPU'
import { pointToCode2D, pointToCode3D } from './geo-bridge'
import type { CesiumFrameState } from './primitive/CesiumInternals'

const { Cartesian3, Cartographic, Math: CesiumMath } = Cesium

/** 当前剖分维度。 */
export interface GridDims {
  nx: number
  ny: number
  planes: number
  level: number
}

/** 占用着色生成器：每次重建按当前真实维度回调生成（优先于静态 occupancy）。 */
export type OccupancyProvider = (dims: GridDims) => OccupancyColoring

/** 拾取结果。 */
export interface PickedCell {
  /** 北斗网格码（use3D 决定二维/三维）；领域层在极区等边界出码失败时为 undefined。 */
  code: string | undefined
  level: number
  /** 经向格索引（0..nx-1）。 */
  i: number
  /** 纬向格索引（0..ny-1）。 */
  j: number
  /** 高度层索引（0..planes-1）。 */
  zi: number
  lonDeg: number
  latDeg: number
  /** 命中点高度（米，WGS84 椭球高）。 */
  heightMeters: number
  /** 若已设占用着色，则为该格类别字节（0=空）；否则 undefined。 */
  category?: number
}

/** 满填充引擎公共契约——两种实现均结构化满足本接口，场景按 fillEngine 二选一。 */
interface InstancedFillEngine {
  rebuild(t: Tessellation, coloring: OccupancyColoring, opt?: VoxelGpuOptions): void
  update(frameState: CesiumFrameState): void
  setOpacity(opacity: number): void
  setVisible(visible: boolean): void
  isDestroyed(): boolean
  destroy(): boolean
}

/** 渲染层配置。 */
export interface BeiDouGridConfig {
  /** 自动选级目标单格像素尺寸。默认 RENDER_DEFAULTS.levelPx。 */
  levelPx?: number
  /** 满填充/标注格数预算（自动降级阈值）。默认 RENDER_DEFAULTS.maxCells。 */
  maxCells?: number
  /** 标注数量封顶。默认 RENDER_DEFAULTS.maxLabels。 */
  maxLabels?: number
  /** 高度范围（米）。默认 { min:0, max:20000, step:0 }（单层）。 */
  heightRange?: HeightRange
  /** 线格网颜色 / 线宽。 */
  lineColor?: Cesium.Color
  lineWidth?: number
  /** 拾取/标注默认是否用三维码。默认 false。 */
  labelUse3D?: boolean
  /** 是否绘制线格网。默认 true。 */
  enableLines?: boolean
  /** 是否绘制标注。默认 false（数据量大时标注成本不低）。 */
  enableLabels?: boolean
  /** 是否开启满填充（GPU 实例化）。默认 false（库默认）。 */
  enableInstancedFill?: boolean
  /** 满填充引擎：'gpu'（默认，推荐）或 'attribute'（兼容/对比）。 */
  fillEngine?: 'attribute' | 'gpu'
  /** 满填充不透明度。默认 0.85。 */
  fillOpacity?: number
  /** 满填充留缝比例 [0.05,1]。默认 0.92。 */
  fillRatio?: number
  /** 满填充是否启用面法线光照。默认 true。 */
  lit?: boolean
}

type RequiredConfig = Required<
  Omit<BeiDouGridConfig, 'lineColor' | 'heightRange'>
> & { lineColor: Cesium.Color; heightRange: HeightRange }

const DEFAULT_CONFIG: RequiredConfig = {
  levelPx: RENDER_DEFAULTS.levelPx,
  maxCells: RENDER_DEFAULTS.maxCells,
  maxLabels: RENDER_DEFAULTS.maxLabels,
  heightRange: { min: 0, max: 20000, step: 0 },
  lineColor: Cesium.Color.fromCssColorString('#7c5cff'),
  lineWidth: 1.0,
  labelUse3D: false,
  enableLines: true,
  enableLabels: false,
  enableInstancedFill: false,
  fillEngine: 'gpu',
  fillOpacity: 0.85,
  fillRatio: 0.92,
  lit: true,
}

const clampInt = (v: number, lo: number, hi: number): number =>
  hi < lo ? lo : v < lo ? lo : v > hi ? hi : v

export default class BeiDouGridScene {
  private readonly scene: Cesium.Scene
  private readonly cfg: RequiredConfig

  private readonly linePrimitive?: GridLinePrimitive
  private readonly labelPrimitive?: GridLabelPrimitive
  private readonly instancedFill?: InstancedFillEngine

  private given?: GridRegionInput
  private levelOverride?: number
  private occupancy?: OccupancyColoring
  private occupancyProvider?: OccupancyProvider
  private lastTess?: Tessellation
  /** 上次实际上传 GPU 的着色（生成器或静态择一）；拾取按它取类别，保证「点到的格」与「画出的格」同源。 */
  private renderedColoring?: OccupancyColoring

  private removeMoveEnd?: () => void
  private rafId: number | null = null
  private destroyed = false

  constructor(scene: Cesium.Scene, config: BeiDouGridConfig = {}) {
    this.scene = scene
    this.cfg = { ...DEFAULT_CONFIG, ...config }

    // 半透体素默认不写深度；开启半透深度拾取，使 pickCellAt 的 scene.pickPosition 能命中体素盒表面，
    // 从而解析到正确的高度层 zi（而非穿透到地表）。拾取仅在点击时发生，开销可忽略。
    scene.pickTranslucentDepth = true

    const primitives = scene.primitives

    if (this.cfg.enableLines) {
      this.linePrimitive = new GridLinePrimitive(this.cfg.lineColor, this.cfg.lineWidth)
      primitives.add(this.linePrimitive)
    }
    if (this.cfg.enableLabels) {
      this.labelPrimitive = new GridLabelPrimitive(scene)
      primitives.add(this.labelPrimitive)
    }
    if (this.cfg.enableInstancedFill) {
      this.instancedFill =
        this.cfg.fillEngine === 'attribute'
          ? new GridInstancedFill(this.cfg.fillOpacity)
          : new GridInstancedVoxelGPU(this.cfg.fillOpacity)
      primitives.add(this.instancedFill)
    }

    // 相机停稳 → 防抖重建。
    this.removeMoveEnd = scene.camera.moveEnd.addEventListener(() => this.schedule())
    this.schedule()
  }

  // ───────────────────────── 公开 API ─────────────────────────

  /** 设定给定渲染范围（度）；不设则跟随相机可视范围。 */
  public setGivenRange(range: GridRegionInput): void {
    this.given = range
    this.schedule()
  }

  public clearGivenRange(): void {
    this.given = undefined
    this.schedule()
  }

  /** 手动锁定级别（1..10）；传 undefined 恢复自动选级。 */
  public setLevelOverride(level?: number): void {
    this.levelOverride = level == null ? undefined : clampLevel(level)
    this.schedule()
  }

  public getActiveLevel(): number | undefined {
    return this.lastTess?.level ?? this.levelOverride
  }

  /** 运行期更新高度范围（米）并重建。 */
  public setHeightRange(height: HeightRange): void {
    this.cfg.heightRange = height
    this.schedule()
  }

  /** 静态占用着色（每次重建复用）。 */
  public setOccupancy(coloring: OccupancyColoring): void {
    this.occupancy = coloring
    this.schedule()
  }

  /** 占用着色生成器（每次重建按当前维度回调生成；优先于静态）。 */
  public setOccupancyProvider(provider?: OccupancyProvider): void {
    this.occupancyProvider = provider
    this.schedule()
  }

  /** 当前剖分维度。 */
  public getGridDims(): GridDims | undefined {
    const t = this.lastTess
    if (!t) return undefined
    return { nx: t.nx, ny: t.ny, planes: Math.max(1, t.zPlaneFloors.length), level: t.level }
  }

  public setFillOpacity(opacity: number): void {
    this.instancedFill?.setOpacity(opacity)
    this.scene.requestRender()
  }

  public setVisible(visible: boolean): void {
    this.linePrimitive?.setVisible(visible)
    this.labelPrimitive?.setVisible(visible)
    this.instancedFill?.setVisible(visible)
    this.scene.requestRender()
  }

  /** 强制重建（合并到下一帧）。 */
  public refresh(): void {
    this.schedule()
  }

  // ───────────────────────── 拾取 ─────────────────────────

  /**
   * 屏幕像素 → 北斗码 + 整数格索引 (i,j,zi) + 命中点经纬高 + 类别。
   * 取世界坐标两级降级：① scene.pickPosition（含体素盒真实三维高度）；② 相机射线 ∩ 地球（地表）。
   */
  public pickCellAt(windowPosition: Cesium.Cartesian2, use3D?: boolean): PickedCell | undefined {
    const t = this.lastTess
    if (this.destroyed || !t) return undefined

    const scratch = new Cartesian3()
    let world: Cesium.Cartesian3 | undefined
    try {
      const picked = this.scene.pickPosition(windowPosition, scratch)
      if (picked && Number.isFinite(picked.x) && (picked.x !== 0 || picked.y !== 0 || picked.z !== 0)) {
        world = picked
      }
    } catch {
      world = undefined
    }
    if (!world) {
      const ray = this.scene.camera.getPickRay(windowPosition)
      if (ray) world = this.scene.globe.pick(ray, this.scene, scratch)
    }
    if (!world) return undefined

    const carto = Cartographic.fromCartesian(world, undefined, new Cartographic())
    if (!carto) return undefined
    const lonDeg = CesiumMath.toDegrees(carto.longitude)
    const latDeg = CesiumMath.toDegrees(carto.latitude)
    const heightMeters = carto.height

    // 经纬高 → 当前剖分内整数格索引。
    let lonForIdx = lonDeg
    if (t.crossesAntimeridian && lonForIdx < t.originLonDeg) lonForIdx += 360
    const i = clampInt(Math.floor((lonForIdx - t.originLonDeg) / t.stepLonDeg), 0, t.nx - 1)
    const j = clampInt(Math.floor((latDeg - t.originLatDeg) / t.stepLatDeg), 0, t.ny - 1)
    const planes = Math.max(1, t.zPlaneFloors.length)
    const zBase = t.zPlaneFloors[0] ?? 0
    const step = t.heightStep > 0 ? t.heightStep : 1
    const zi = clampInt(Math.floor((heightMeters - zBase) / step), 0, planes - 1)

    const want3D = use3D ?? this.cfg.labelUse3D
    const code = want3D
      ? pointToCode3D(lonDeg, latDeg, heightMeters, t.level)
      : pointToCode2D(lonDeg, latDeg, t.level)

    let category: number | undefined
    // 优先用「实际渲染的着色」（生成器路径下 this.occupancy 为空），回退静态 occupancy。
    const occ = this.renderedColoring ?? this.occupancy
    if (occ) {
      const idx = (zi * t.ny + j) * t.nx + i // 与 OccupancyColoring 行优先布局一致
      if (idx >= 0 && idx < occ.categories.length) category = occ.categories[idx]
    }

    return { code, level: t.level, i, j, zi, lonDeg, latDeg, heightMeters, category }
  }

  // ───────────────────────── 内部：调度 + 重建 ─────────────────────────

  private schedule(): void {
    if (this.destroyed || this.rafId !== null) return
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null
      this.rebuild()
    })
  }

  private hideAll(): void {
    this.linePrimitive?.setVisible(false)
    this.labelPrimitive?.setVisible(false)
    this.instancedFill?.setVisible(false)
    this.lastTess = undefined
    this.renderedColoring = undefined
  }

  private rebuild(): void {
    if (this.destroyed) return

    // 1) 区域。
    const region = resolveViewRegion(this.scene, this.given)
    if (!region) {
      this.hideAll()
      this.scene.requestRender()
      return
    }

    // 2) 级别（手动锁定优先，否则按比例尺）。
    const canvasWidth = this.scene.canvas.clientWidth || this.scene.canvas.width || 1
    let level =
      this.levelOverride ?? selectLevelByScale(region.widthDeg, canvasWidth, this.cfg.levelPx)

    // 3) 预算降级（仅自动模式）。
    if (this.levelOverride == null) {
      level = clampLevelByBudget(region, level, this.cfg.heightRange, this.cfg.maxCells)
    }

    // 4) 剖分。
    const t = tessellate(region, level, this.cfg.heightRange)
    this.lastTess = t

    // 5) 线格网。
    if (this.linePrimitive) {
      this.linePrimitive.rebuild(t)
      this.linePrimitive.setVisible(true)
    }

    // 6) 标注。
    if (this.labelPrimitive) {
      this.labelPrimitive.rebuild(t, this.cfg.maxLabels, this.cfg.labelUse3D)
      this.labelPrimitive.setVisible(true)
    }

    // 7) 满填充（生成器优先；geodetic 透传）。
    if (this.instancedFill) {
      const planes = Math.max(1, t.zPlaneFloors.length)
      const coloring: OccupancyColoring | undefined = this.occupancyProvider
        ? this.occupancyProvider({ nx: t.nx, ny: t.ny, planes, level: t.level })
        : this.occupancy
      const expected = t.nx * t.ny * planes
      if (coloring && coloring.categories.length >= expected) {
        const geodetic =
          Math.max(region.widthDeg, region.heightDeg) > GEODETIC_SPAN_THRESHOLD_DEG
        try {
          this.instancedFill.rebuild(t, coloring, {
            geodetic,
            fillRatio: this.cfg.fillRatio,
            lit: this.cfg.lit,
          })
          this.instancedFill.setVisible(true)
          // 记录实际上传的着色，供拾取按同一数组取类别（与 GPU 渲染同源）。
          this.renderedColoring = coloring
        } catch (e) {
          // 手动锁定过细级别 + 大范围 → 超单数据纹理上限会抛 RangeError。
          // 不让异常逃逸 rAF 回调：跳过满填充（线/标注仍在），给出可恢复提示。
          this.instancedFill.setVisible(false)
          this.renderedColoring = undefined
          console.warn(
            '[BeiDouGridScene] 满填充已跳过（格数超单数据纹理上限，请降低级别或缩小范围）：',
            e,
          )
        }
      } else {
        // 无匹配占用数据 → 不绘制满填充（避免尺寸不符或空填充）。
        this.instancedFill.setVisible(false)
        this.renderedColoring = undefined
      }
    }

    this.scene.requestRender()
  }

  // ───────────────────────── 销毁 ─────────────────────────

  public dispose(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.removeMoveEnd?.()
    this.removeMoveEnd = undefined
    const primitives = this.scene.primitives
    // 从集合移除会触发各自 destroy()。
    if (this.linePrimitive) primitives.remove(this.linePrimitive)
    if (this.labelPrimitive) primitives.remove(this.labelPrimitive)
    if (this.instancedFill) primitives.remove(this.instancedFill)
  }
}
