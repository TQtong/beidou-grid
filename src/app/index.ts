// ============================================================
// app/index.ts — 应用层入口（重设计：立方体场渲染路径）
// 职责：① 创建/销毁 Cesium Viewer；② 构造 BeiDouFieldScene 渲染编排器；
//       ③ 暴露面向三需求的 Demo API：
//          需求① 渲染模式(线框/填充) / 填充透明度 / 清除选中；
//          需求② 级别锁定(自动/1-10) / 取当前生效级别；
//          需求③ 无人机起飞·降落 / 高度 / 影响半径 / 速度；
//       ④ 可选加载普洱市行政边界（贴地折线，独立于立方体场）。
// 说明：边界加载器直接挂在 app 层（持有 viewer），保持编排器聚焦三需求。
// ============================================================
import * as Cesium from 'cesium'

import {
  BeiDouFieldScene,
  type BeiDouFieldConfig,
  type FieldMode,
  type HeightRange,
  GeoJsonBoundaryLoader,
  type BoundaryLoadResult,
  type BoundaryStyle,
} from '../beidou-grid-render'

/** 普洱市行政边界（GeoJSON，DataV 阿里云）。 */
export const PUER_BOUNDARY_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/530800.json'

/** 普洱市中心（思茅区附近），作为默认定位与无人机巡航中心。 */
export const PUER_CENTER = { lon: 100.972, lat: 22.778 } as const

let viewer: Cesium.Viewer | undefined
let fieldScene: BeiDouFieldScene | undefined
let boundaryLoader: GeoJsonBoundaryLoader | undefined

/**
 * 初始化 Viewer 并创建北斗立方体场渲染编排器。
 *
 * @param element 容器 DOM
 * @param config  渲染配置（可选）
 * @returns       Cesium.Viewer
 */
export const init = (element: HTMLDivElement, config?: BeiDouFieldConfig): Cesium.Viewer => {
  viewer = new Cesium.Viewer(element, {
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    baseLayerPicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    vrButton: false,
    scene3DOnly: true,
    infoBox: false,
    selectionIndicator: false,
    shouldAnimate: true,
  })

  // 异步加载世界地形（立方体场底面贴近真实地表观感更好）。
  Cesium.createWorldTerrainAsync()
    .then((terrainProvider) => {
      if (viewer && !viewer.isDestroyed()) {
        viewer.terrainProvider = terrainProvider
      }
    })
    .catch(() => {
      /* 地形加载失败时退回椭球面，不影响立方体场渲染。 */
    })

  // 立方体场渲染编排器（构造传 viewer，内部用 viewer.scene 渲染、viewer.entities 承载无人机）。
  fieldScene = new BeiDouFieldScene(viewer, config)

  // 边界加载器（独立图层，挂在场景 primitives 上）。
  boundaryLoader = new GeoJsonBoundaryLoader(viewer.scene.primitives)

  // 默认飞向普洱市，便于直接观察。
  flyToPoint(PUER_CENTER.lon, PUER_CENTER.lat, 0, 6000, 0)

  return viewer
}

// ──────────────────────────────────────────────
// 需求①：渲染模式 / 填充 / 选中
// ──────────────────────────────────────────────

/** 设渲染模式（线框/填充）。默认线框。 */
export const setMode = (mode: FieldMode): void => {
  fieldScene?.setMode(mode)
}

/** 取当前渲染模式。 */
export const getMode = (): FieldMode => fieldScene?.getMode() ?? 'wire'

/** 设填充模式全局不透明度（0..1）。 */
export const setFillOpacity = (opacity: number): void => {
  fieldScene?.setFillOpacity(opacity)
}

/** 清空全部点击选中。 */
export const clearSelections = (): void => {
  fieldScene?.clearSelections()
}

// ──────────────────────────────────────────────
// 需求②：级别
// ──────────────────────────────────────────────

/** 锁定/恢复显示级别（undefined = 自动按比例尺）。 */
export const setLevelOverride = (level?: number): void => {
  fieldScene?.setLevelOverride(level)
}

/** 取当前生效的显示级别。 */
export const getActiveLevel = (): number => fieldScene?.getActiveLevel() ?? 1

/** 设给定范围（约束区域）。任一参数非有限值则取消约束。 */
export const setGivenRange = (west: number, south: number, east: number, north: number): void => {
  if (!fieldScene) return
  if (![west, south, east, north].every(Number.isFinite)) {
    fieldScene.clearGivenRange()
    return
  }
  fieldScene.setGivenRange(Cesium.Rectangle.fromDegrees(west, south, east, north))
}

/** 取消给定范围（仅用可视范围）。 */
export const clearGivenRange = (): void => {
  fieldScene?.clearGivenRange()
}

// ──────────────────────────────────────────────
// 需求③：无人机
// ──────────────────────────────────────────────

/** 无人机起飞（不传中心则用视图/给定范围中心）。 */
export const startDrone = (centerLon?: number, centerLat?: number): void => {
  fieldScene?.startDrone(centerLon, centerLat)
}

/** 无人机降落（停飞 + 清影响）。 */
export const stopDrone = (): void => {
  fieldScene?.stopDrone()
}

/** 无人机是否在飞行。 */
export const isDroneRunning = (): boolean => fieldScene?.isDroneRunning() ?? false

/** 设无人机巡航大地高（米）。 */
export const setDroneAltitude = (meters: number): void => {
  fieldScene?.setDroneAltitude(meters)
}

/** 设无人机影响半径（米）。 */
export const setDroneInfluenceRadius = (meters: number): void => {
  fieldScene?.setDroneInfluenceRadius(meters)
}

/** 设无人机角速度（弧度/秒）。 */
export const setDroneSpeed = (radPerSec: number): void => {
  fieldScene?.setDroneSpeed(radPerSec)
}

/** 设无人机巡航圆半径（米）。 */
export const setDroneOrbitRadius = (meters: number): void => {
  fieldScene?.setDroneOrbitRadius(meters)
}

// ──────────────────────────────────────────────
// 边界 / 相机 / 生命周期
// ──────────────────────────────────────────────

/**
 * 加载行政区/区域 GeoJSON 边界（贴地折线 Primitive），可选飞到其 bbox。
 *
 * @param url     GeoJSON 资源 URL（如 PUER_BOUNDARY_URL）
 * @param options 外观与是否飞行到 bbox
 * @returns       加载结果摘要（含 ring 数与 bounds）
 */
export const loadBoundary = async (
  url: string,
  options?: { style?: Partial<BoundaryStyle>; flyTo?: boolean },
): Promise<BoundaryLoadResult | undefined> => {
  if (!boundaryLoader) return undefined
  const resolved: BoundaryStyle = {
    color: options?.style?.color ?? Cesium.Color.fromCssColorString('#35c4ff').withAlpha(0.95),
    width: options?.style?.width ?? 3,
  }
  const result = await boundaryLoader.loadFromUrl(url, resolved)
  if (options?.flyTo && result.bounds && viewer && !viewer.isDestroyed()) {
    viewer.camera.flyTo({ destination: result.bounds, duration: 1.2 })
  }
  return result
}

/** 设边界图层可见性。 */
export const setBoundaryVisible = (visible: boolean): void => {
  boundaryLoader?.setVisible(visible)
}

/** 清空边界图层。 */
export const clearBoundary = (): void => {
  boundaryLoader?.clear()
}

/** 强制重建一次。 */
export const refreshAll = (): void => {
  fieldScene?.refresh()
}

/** 调试：取编排器实例。 */
export const getFieldScene = (): BeiDouFieldScene | undefined => fieldScene

/** 调试：取 Viewer。 */
export const getViewer = (): Cesium.Viewer | undefined => viewer

/**
 * 飞行相机到经纬高度点（俯视）。
 *
 * @param lon        经度（度）
 * @param lat        纬度（度）
 * @param targetH    目标大地高（米）
 * @param viewHeight 相机相对目标视距（米）
 * @param duration   飞行时长（秒）
 */
export const flyToPoint = (
  lon: number,
  lat: number,
  targetH = 0,
  viewHeight = 4000,
  duration = 1.0,
): void => {
  if (!viewer || viewer.isDestroyed()) return
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, targetH + viewHeight),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-55),
      roll: 0,
    },
    duration,
  })
}

/** 销毁：释放渲染层 + Viewer。 */
export const dispose = (): void => {
  fieldScene?.dispose()
  fieldScene = undefined
  boundaryLoader?.destroy()
  boundaryLoader = undefined
  if (viewer && !viewer.isDestroyed()) {
    viewer.destroy()
  }
  viewer = undefined
}

export type { BeiDouFieldConfig, FieldMode, HeightRange, BoundaryLoadResult, BoundaryStyle }
