// ============================================================
// app/index.ts — 应用层入口（替换原 Entity 路径为 Primitive 渲染层）
// 职责：① 创建/销毁 Cesium Viewer；② 构造 BeiDouGridScene 渲染器；
//       ③ 暴露公开 API（给定范围 / 单点查询 / 飞行器 / 锁定级别 / 占用着色）。
// ============================================================
import * as Cesium from 'cesium'

import {
  BeiDouGridScene,
  type Aircraft,
  type BeiDouGridConfig,
  type BoundaryLoadResult,
  type BoundaryStyle,
  type HeightRange,
  type OccupancyColoring,
} from '../beidou-grid-render'

/** 普洱市行政边界（GeoJSON，DataV 阿里云）。 */
export const PUER_BOUNDARY_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/530800.json'

let viewer: Cesium.Viewer | undefined
let gridScene: BeiDouGridScene | undefined

/** 北斗网格统计结果，供 UI 显示。 */
export interface GridStats {
  /** 当前显示级别（自动或锁定后生效）。 */
  activeLevel: number
}

/**
 * 初始化 Viewer 并创建北斗网格渲染场景。
 *
 * @param element  容器 DOM
 * @param config   渲染配置（可选）
 * @returns        Cesium.Viewer
 */
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
  })

  Cesium.createWorldTerrainAsync().then((terrainProvider) => {
    if (viewer && !viewer.isDestroyed()) {
      viewer.terrainProvider = terrainProvider
    }
  })

  // 创建北斗网格渲染场景（Primitive 路径，替换原 viewer.entities 逐格创建）。
  gridScene = new BeiDouGridScene(viewer.scene, {
    heightRange: { min: 0, max: 20000, step: 1000 },
    isolationLevel: 5,   // 隔离固定 L5（≈124m），缩放不改隔离粒度
    bufferRing: 1,       // 飞行器周围 1 圈缓冲保护区
    dwellFrames: 3,      // 贴边滞回 3 帧
    labelUse3D: false,   // 标注用二维码（不含高度）
    ...config,
  })

  return viewer
}

/** 设给定范围（管制扇区）。传 undefined 取消约束。 */
export const setGivenRange = (
  west: number,
  south: number,
  east: number,
  north: number,
): void => {
  if (!gridScene) return
  if (!Number.isFinite(west) || !Number.isFinite(south) || !Number.isFinite(east) || !Number.isFinite(north)) {
    gridScene.clearGivenRange()
    return
  }
  gridScene.setGivenRange(Cesium.Rectangle.fromDegrees(west, south, east, north))
}

/** 取消给定范围（仅用可视范围）。 */
export const clearGivenRange = (): void => {
  gridScene?.clearGivenRange()
}

/** R1：单点 + 高度 + 级别画格。 */
export const drawPointGrid = (lon: number, lat: number, height: number, level: number): void => {
  gridScene?.drawPointGrid(lon, lat, height, level)
}

/** 飞行器位置流入口（实时高亮 + 缓冲环）。 */
export const updateAircraft = (ac: Aircraft): void => {
  gridScene?.setAircraft(ac)
}

/** 清除飞行器跟踪。 */
export const clearAircraft = (): void => {
  gridScene?.clearAircraft()
}

/** 锁定/恢复显示级别（undefined = 自动按比例尺）。 */
export const setLevelOverride = (level?: number): void => {
  gridScene?.setActiveLevelOverride(level)
}

/** 取当前显示级别。 */
export const getActiveLevel = (): number => {
  return gridScene?.getActiveLevel() ?? 1
}

/** 设占用着色（满填充）。须 enableInstancedFill 开启。 */
export const setOccupancy = (coloring: OccupancyColoring): void => {
  gridScene?.setOccupancy(coloring)
}

/**
 * 加载行政区/区域 GeoJSON 边界（贴地折线 Primitive）。
 * 加载完成后可选 zoomTo（flyTo bbox），便于观察。
 *
 * @param url      GeoJSON 资源 URL（如 PUER_BOUNDARY_URL）
 * @param options  外观与是否飞行到 bbox
 */
export const loadBoundary = async (
  url: string,
  options?: { style?: Partial<BoundaryStyle>; flyTo?: boolean },
): Promise<BoundaryLoadResult | undefined> => {
  if (!gridScene) return undefined
  const result = await gridScene.loadBoundaryFromUrl(url, options?.style)
  if (options?.flyTo && result.bounds && viewer && !viewer.isDestroyed()) {
    viewer.camera.flyTo({
      destination: result.bounds,
      duration: 1.2,
    })
  }
  return result
}

/** 清除边界图层。 */
export const clearBoundary = (): void => {
  gridScene?.clearBoundary()
}

/** 设边界图层可见性。 */
export const setBoundaryVisible = (visible: boolean): void => {
  gridScene?.setBoundaryVisible(visible)
}

/** 设高度区间（重建一次）。 */
export const refreshAll = (): void => {
  gridScene?.refresh()
}

/** 调试：取实例对外暴露。 */
export const getGridScene = (): BeiDouGridScene | undefined => gridScene

/** 调试：取 Viewer。 */
export const getViewer = (): Cesium.Viewer | undefined => viewer

/**
 * 飞行相机到经纬高度点（用于「点击立即看到目标格/飞行器」）。
 * viewHeight：相机离地表/目标的相对高度（米）。默认 3000m——L5(≈124m)/L4(≈1.8km) 格可见。
 *
 * @param lon         经度（度）
 * @param lat         纬度（度）
 * @param targetH     目标大地高（米，飞行器或单点查询用）
 * @param viewHeight  相机相对目标的视距（米）
 * @param duration    飞行时长（秒）
 */
export const flyToPoint = (
  lon: number,
  lat: number,
  targetH = 0,
  viewHeight = 3000,
  duration = 1.0,
): void => {
  if (!viewer || viewer.isDestroyed()) return
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, targetH + viewHeight),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-60), // 俯视便于看到地面格
      roll: 0,
    },
    duration,
  })
}

/** 销毁：释放渲染层 + Viewer。 */
export const dispose = (): void => {
  gridScene?.dispose()
  gridScene = undefined
  if (viewer && !viewer.isDestroyed()) {
    viewer.destroy()
  }
  viewer = undefined
}

export type { Aircraft, HeightRange, OccupancyColoring, BeiDouGridConfig, BoundaryLoadResult, BoundaryStyle }
