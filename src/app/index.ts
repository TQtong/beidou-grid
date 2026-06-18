/**
 * 应用层：创建 Viewer + 北斗渲染场景，暴露公开 API（init / 渲染 / 占用着色 / 拾取 / 基准 / 清理）。
 *
 * 渲染走 `beidou-grid-render` 的 GPU 实例化满填充（单 draw call、位置 GPU 派生、1 字节/格），
 * 替换了原「逐格 viewer.entities.add + 2 万格上限」的卡顿实现——现在百万~千万格也流畅。
 */
import * as Cesium from 'cesium'
import {
  BeiDouGridScene,
  cellStepDeg,
  type BeiDouGridConfig,
  type GridDims,
  type OccupancyColoring,
  type OccupancyProvider,
  type PickedCell,
} from '../beidou-grid-render'

let viewer: Cesium.Viewer | undefined
let gridScene: BeiDouGridScene | undefined
let demoPickHandler: Cesium.ScreenSpaceEventHandler | undefined

type GridBounds = { west: number; south: number; east: number; north: number }

export type GridCreateResult = {
  status: 'rendered' | 'skipped'
  message: string
  columns: number
  rows: number
  heightLayers: number
  gridCount: number
  entityCount: number
  labelsRendered: number
  stepLon: number
  stepLat: number
}

const formatCount = (count: number): string =>
  Number.isFinite(count) ? Math.round(count).toLocaleString('zh-CN') : 'infinity'

const normalizeBounds = (bbox: GridBounds): GridBounds => ({
  west: Math.min(Number(bbox.west), Number(bbox.east)),
  south: Math.min(Number(bbox.south), Number(bbox.north)),
  east: Math.max(Number(bbox.west), Number(bbox.east)),
  north: Math.max(Number(bbox.south), Number(bbox.north)),
})

const planesOf = (maxHeight: number, stepHeight: number): number =>
  stepHeight > 0 ? Math.max(1, Math.ceil(Number(maxHeight) / Number(stepHeight))) : 1

/** 估算格规模（不再有「超限跳过」——GPU 实例化可流畅渲染百万~千万格）。 */
export const estimateGridLoad = (
  stepHeight: number,
  gridSize: number,
  maxHeight: number,
  bbox: GridBounds,
): GridCreateResult => {
  const bounds = normalizeBounds(bbox)
  const [stepLon, stepLat] = cellStepDeg(Number(gridSize))
  const width = Math.max(0, bounds.east - bounds.west)
  const height = Math.max(0, bounds.north - bounds.south)
  const columns = Math.ceil(width / stepLon) + 1
  const rows = Math.ceil(height / stepLat) + 1
  const heightLayers = planesOf(maxHeight, stepHeight)
  const gridCount = columns * rows * heightLayers

  return {
    status: 'rendered',
    message: `Estimated ${formatCount(gridCount)} 北斗网格。`,
    columns,
    rows,
    heightLayers,
    gridCount,
    entityCount: gridCount,
    labelsRendered: 0,
    stepLon,
    stepLat,
  }
}

/** 创建 Viewer + 北斗渲染场景。 */
export const init = (element: HTMLDivElement, config?: BeiDouGridConfig): Cesium.Viewer => {
  viewer = new Cesium.Viewer(element, {
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    baseLayerPicker: false,
    navigationHelpButton: false,
    animation: true,
    timeline: true,
    fullscreenButton: false,
    vrButton: false,
    scene3DOnly: true,
    infoBox: false,
    shouldAnimate: true,
    // GPU 引擎依赖 WebGL2（gl_InstanceID / in-out / dFdx）；Cesium 1.133 默认即用 WebGL2
    // （仅在显式 contextOptions.requestWebgl1 时才回退 WebGL1），故无需额外声明。
  })

  Cesium.createWorldTerrainAsync()
    .then((terrainProvider) => {
      if (viewer && !viewer.isDestroyed()) viewer.terrainProvider = terrainProvider
    })
    .catch(() => {
      /* 无地形时仍可渲染（椭球面） */
    })

  gridScene = new BeiDouGridScene(viewer.scene, {
    heightRange: { min: 0, max: 20000, step: 0 },
    labelUse3D: false,
    enableLines: true,
    enableLabels: false,
    enableInstancedFill: true, // 开启满填充（默认引擎 'gpu'）；无占用数据时不绘制，开销可忽略
    fillEngine: 'gpu',
    ...config,
  })

  return viewer
}

const flyToBounds = (bounds: GridBounds): void => {
  if (!viewer) return
  viewer.camera.flyTo({
    destination: Cesium.Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north),
    duration: 1.0,
  })
}

/**
 * 渲染北斗网格（驱动场景）：设定高度范围、锁定级别、给定范围、开启占用演示并飞向区域。
 * 保留与原 UI 的调用契约；返回规模摘要（不再有 2 万格上限）。
 */
export const createGrid = (
  stepHeight: number,
  gridSize: number,
  maxHeight: number,
  bbox: GridBounds,
): GridCreateResult => {
  if (!gridScene || !viewer) {
    throw new Error('createGrid: 请先调用 init()。')
  }
  const bounds = normalizeBounds(bbox)
  const estimate = estimateGridLoad(stepHeight, gridSize, maxHeight, bounds)

  gridScene.setHeightRange({ min: 0, max: Number(maxHeight), step: Number(stepHeight) })
  gridScene.setLevelOverride(Number(gridSize))
  gridScene.setGivenRange(bounds)
  enableOccupancyDemo()
  flyToBounds(bounds)

  return {
    ...estimate,
    message: `渲染 ${formatCount(estimate.gridCount)} 北斗网格（GPU 实例化 · 单 draw call · ${estimate.heightLayers} 高度层）。`,
  }
}

// ───────────────────────── 占用着色 ─────────────────────────

/** 演示调色板：0 透明、1 青、2 橙、3 品红。 */
const DEMO_PALETTE = ((): Uint8Array => {
  const p = new Uint8Array(256 * 4)
  p.set([0, 224, 224, 220], 1 * 4)
  p.set([255, 150, 40, 220], 2 * 4)
  p.set([230, 60, 200, 220], 3 * 4)
  return p
})()

export const setOccupancy = (coloring: OccupancyColoring): void => gridScene?.setOccupancy(coloring)

export const setOccupancyProvider = (provider?: OccupancyProvider): void =>
  gridScene?.setOccupancyProvider(provider)

/** 一键演示「大数据量不卡顿」：按当前维度即时生成同心环 + 高度配色的体素。 */
export const enableOccupancyDemo = (fillRatio = 0.6): void => {
  if (!gridScene) return
  const bands = Math.min(12, Math.max(2, Math.round(6 / Math.max(0.1, fillRatio))))
  const provider: OccupancyProvider = ({ nx, ny, planes }: GridDims): OccupancyColoring => {
    const total = nx * ny * planes
    const categories = new Uint8Array(total)
    const cxf = (nx - 1) / 2
    const cyf = (ny - 1) / 2
    const maxR = Math.max(1, Math.hypot(cxf, cyf))
    for (let zi = 0; zi < planes; zi++) {
      for (let j = 0; j < ny; j++) {
        const rowBase = (zi * ny + j) * nx
        const dy = j - cyf
        for (let i = 0; i < nx; i++) {
          const dx = i - cxf
          const r = Math.hypot(dx, dy) / maxR
          const band = Math.floor(r * bands)
          categories[rowBase + i] = band % 2 === 0 ? 1 + ((zi + (band >> 1)) % 3) : 0
        }
      }
    }
    return { categories, palette: DEMO_PALETTE }
  }
  gridScene.setOccupancyProvider(provider)
}

export const disableOccupancyDemo = (): void => gridScene?.setOccupancyProvider(undefined)

// ───────────────────────── 拾取 ─────────────────────────

export const pickGridCellAt = (x: number, y: number, use3D?: boolean): PickedCell | undefined =>
  gridScene?.pickCellAt(new Cesium.Cartesian2(x, y), use3D)

/** 左键点击回调，返回解绑函数。 */
export const onCellClick = (
  cb: (cell: PickedCell | undefined) => void,
  use3D?: boolean,
): (() => void) => {
  if (!viewer || viewer.isDestroyed()) return () => {}
  demoPickHandler?.destroy()
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
  handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    cb(gridScene?.pickCellAt(movement.position, use3D))
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
  demoPickHandler = handler
  return () => {
    if (demoPickHandler === handler) demoPickHandler = undefined
    if (!handler.isDestroyed()) handler.destroy()
  }
}

// ───────────────────────── 其它 ─────────────────────────

export const setGivenRange = (bbox: GridBounds): void =>
  gridScene?.setGivenRange(normalizeBounds(bbox))
export const clearGivenRange = (): void => gridScene?.clearGivenRange()
export const setLevelOverride = (level?: number): void => gridScene?.setLevelOverride(level)
export const getActiveLevel = (): number | undefined => gridScene?.getActiveLevel()
export const setFillOpacity = (opacity: number): void => gridScene?.setFillOpacity(opacity)
export const refreshAll = (): void => gridScene?.refresh()

export const flyToPoint = (lon: number, lat: number, height = 0, range = 60000): void => {
  if (!viewer) return
  viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(lon, lat, height), range),
    { duration: 1.0 },
  )
}

export const getGridScene = (): BeiDouGridScene | undefined => gridScene
export const getViewer = (): Cesium.Viewer | undefined => viewer

export const dispose = (): void => {
  demoPickHandler?.destroy()
  demoPickHandler = undefined
  gridScene?.dispose()
  gridScene = undefined
  if (viewer && !viewer.isDestroyed()) viewer.destroy()
  viewer = undefined
}
