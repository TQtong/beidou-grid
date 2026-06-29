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
  type GridOverlayInput,
  type GridPickListener,
  type PickedGridInfo,
} from '../beidou-grid-render'
import {
  SIMAO_BOUNDARY_URL,
  SIMAO_DISTRICT_CENTER as SIMAO_ADMIN_CENTER,
  SIMAO_URBAN_CENTER,
  type AirspaceZone,
  type LowAltitudeFacility,
  type LowAltitudeMission,
  type RiskEvent,
  type RoutePoint,
} from './low-altitude-data'

/** 思茅区行政边界（GeoJSON，DataV 阿里云）。 */
export const SIMAO_DISTRICT_BOUNDARY_URL = SIMAO_BOUNDARY_URL

/** 思茅区行政 bbox 几何中心。 */
export const SIMAO_DISTRICT_CENTER = SIMAO_ADMIN_CENTER
/** 思茅主城区低空运行核心，作为默认定位、网格锚点与城市任务示范中心。 */
export const SIMAO_OPERATION_CENTER = SIMAO_URBAN_CENTER
/** 兼容旧调用名。 */
export const PUER_BOUNDARY_URL = SIMAO_DISTRICT_BOUNDARY_URL
/** 兼容旧调用名。 */
export const PUER_CENTER = SIMAO_OPERATION_CENTER

let viewer: Cesium.Viewer | undefined
let fieldScene: BeiDouFieldScene | undefined
let boundaryLoader: GeoJsonBoundaryLoader | undefined
let operationEntities: Cesium.Entity[] = []
/** 光标地理读数监听句柄（onCursorReadout 装，dispose 时 destroy）。 */
let cursorHandler: Cesium.ScreenSpaceEventHandler | undefined

/** 光标在 3D 场景上的地理读数（经纬度 + 地形高）。 */
export interface CursorReadout {
  lonDeg: number
  latDeg: number
  heightMeters: number
}

export interface OperationLayerToggles {
  routes: boolean
  zones: boolean
  risks: boolean
  aircraft: boolean
  sites: boolean
}

export interface OperationOverlayState {
  missions: LowAltitudeMission[]
  zones: AirspaceZone[]
  risks: RiskEvent[]
  facilities?: LowAltitudeFacility[]
  activeMissionId?: string
  toggles: OperationLayerToggles
}

const SCENARIO_COLORS: Record<string, string> = {
  logistics: '#35c4ff',
  emergency: '#ff3b30',
  inspection: '#f7b731',
  'urban-governance': '#30d158',
  agriculture: '#8fd14f',
  tourism: '#c77dff',
  uam: '#00e5a8',
  surveying: '#64d2ff',
}

const ZONE_COLORS: Record<AirspaceZone['type'], string> = {
  corridor: '#35f0c4',
  takeoff: '#35c4ff',
  landing: '#30d158',
  'no-fly': '#ff453a',
  restricted: '#ffd60a',
  emergency: '#ff9500',
}

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

  // 关键：开启地形深度测试。默认 false 时 Cesium 会在画主体前清空地形深度，
  // 任何 primitive 都"穿透"地形显示；开启后地形保留深度，埋在地表下的立方体被
  // 正确遮挡——这是立方体场"贴地"（底部被地形裁掉、只露出地表以上部分）的基础。
  viewer.scene.globe.depthTestAgainstTerrain = true

  // 异步加载世界地形（立方体场底面贴近真实地表观感更好）。
  Cesium.createWorldTerrainAsync()
    .then((terrainProvider) => {
      if (viewer && !viewer.isDestroyed()) {
        viewer.terrainProvider = terrainProvider
        // 世界地形就位后触发一次重建，重采样地形高把静态网格贴到真实地表
        // （静态网格不再随相机移动重建，故此处需显式纠正一次贴地）。
        fieldScene?.refresh()
      }
    })
    .catch(() => {
      /* 地形加载失败时退回椭球面，不影响立方体场渲染。 */
    })

  // 立方体场渲染编排器（构造传 viewer，内部用 viewer.scene 渲染、viewer.entities 承载无人机）。
  // 静态网格锚点默认普洱城区（= 相机定位中心 / 无人机巡航中心），网格固定贴在此处，
  // 不随相机倾斜/远近/平移重算；调用方可在 config 里覆盖。
  fieldScene = new BeiDouFieldScene(viewer, {
    ...config,
    anchorLonDeg: config?.anchorLonDeg ?? SIMAO_OPERATION_CENTER.lon,
    anchorLatDeg: config?.anchorLatDeg ?? SIMAO_OPERATION_CENTER.lat,
  })

  // 边界加载器（独立图层，挂在场景 primitives 上）。
  boundaryLoader = new GeoJsonBoundaryLoader(viewer.scene.primitives)

  // 默认飞向思茅区，便于直接观察低空经济示范场景。
  flyToPoint(SIMAO_OPERATION_CENTER.lon, SIMAO_OPERATION_CENTER.lat, 0, 6000, 0)

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

/** 监听点击拾取到的网格编码；返回取消监听函数。 */
export const onGridPick = (listener: GridPickListener): (() => void) => {
  return fieldScene?.onGridPick(listener) ?? (() => undefined)
}

/** 设置业务叠加网格着色（航路/禁限飞/风险等）。 */
export const setGridOverlays = (overlays: readonly GridOverlayInput[]): void => {
  fieldScene?.setGridOverlays(overlays)
}

/** 清空业务叠加网格着色。 */
export const clearGridOverlays = (): void => {
  fieldScene?.clearGridOverlays()
}

/** 用当前任务位置驱动网格影响范围着色。 */
export const setActiveMissionInfluence = (
  lon: number,
  lat: number,
  height: number,
  radius: number,
): void => {
  fieldScene?.setActiveMissionInfluence(lon, lat, height, radius)
}

/** 清空当前任务影响范围。 */
export const clearActiveMissionInfluence = (): void => {
  fieldScene?.clearActiveMissionInfluence()
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
 * 订阅鼠标在 3D 场景上的地理读数（经纬度 + 地形高）。
 * 鼠标移出地球时回调 undefined；返回取消订阅函数。
 *
 * @param listener 读数监听器（undefined 表示光标不在地球上）
 * @returns        取消订阅函数
 */
export const onCursorReadout = (
  listener: (r: CursorReadout | undefined) => void,
): (() => void) => {
  if (!viewer || viewer.isDestroyed()) return () => undefined
  // 同一时刻仅保留一个光标 handler。
  cursorHandler?.destroy()
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
  cursorHandler = handler
  handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
    if (!viewer || viewer.isDestroyed()) {
      listener(undefined)
      return
    }
    const ray = viewer.camera.getPickRay(movement.endPosition)
    const cart = ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined
    if (!cart) {
      listener(undefined)
      return
    }
    const carto = Cesium.Cartographic.fromCartesian(cart)
    listener({
      lonDeg: Cesium.Math.toDegrees(carto.longitude),
      latDeg: Cesium.Math.toDegrees(carto.latitude),
      heightMeters: carto.height,
    })
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
  return () => {
    if (cursorHandler === handler) {
      handler.destroy()
      cursorHandler = undefined
    }
  }
}

/**
 * 相机飞向给定经纬 bbox。
 *
 * @param west     西经度（度）
 * @param south    南纬度（度）
 * @param east     东经度（度）
 * @param north    北纬度（度）
 * @param duration 飞行时长（秒）
 */
export const flyToBBox = (
  west: number,
  south: number,
  east: number,
  north: number,
  duration = 1.2,
): void => {
  if (!viewer || viewer.isDestroyed()) return
  viewer.camera.flyTo({
    destination: Cesium.Rectangle.fromDegrees(west, south, east, north),
    duration,
  })
}

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

/** 绘制低空经济业务图层：航线、空域区、起降点、机位和风险点。 */
export const setOperationOverlays = (state: OperationOverlayState): void => {
  if (!viewer || viewer.isDestroyed()) return
  clearOperationOverlays()

  const entities = viewer.entities
  const activeMission = state.missions.find((mission) => mission.id === state.activeMissionId)

  if (state.toggles.zones) {
    for (const zone of state.zones) {
      drawZone(zone)
    }
  }

  if (state.toggles.sites && state.facilities) {
    for (const facility of state.facilities) {
      const color = Cesium.Color.fromCssColorString(SCENARIO_COLORS[facility.scenario ?? 'logistics'] ?? '#35c4ff')
      operationEntities.push(entities.add({
        name: facility.name,
        position: Cesium.Cartesian3.fromDegrees(facility.lon, facility.lat, 25),
        billboard: undefined,
        point: {
          pixelSize: facility.type === 'vertiport' ? 13 : 10,
          color,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: facility.name,
          font: '600 11px "Microsoft YaHei",sans-serif',
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: color.withAlpha(0.62),
          pixelOffset: new Cesium.Cartesian2(0, -18),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }))
    }
  }

  if (state.toggles.routes) {
    for (const mission of state.missions) {
      const active = mission.id === state.activeMissionId
      const color = Cesium.Color.fromCssColorString(SCENARIO_COLORS[mission.scenario] ?? '#35c4ff')
      const entity = entities.add({
        name: mission.name,
        polyline: {
          positions: routePositions(mission.route),
          width: active ? 5 : 2,
          material: color.withAlpha(active ? 0.95 : 0.52),
          clampToGround: false,
        },
      })
      operationEntities.push(entity)
    }
  }

  if (state.toggles.aircraft && activeMission) {
    const current = activeMission.route.length > 0
      ? interpolateRouteLocal(activeMission.route, activeMission.progress)
      : { lon: SIMAO_OPERATION_CENTER.lon, lat: SIMAO_OPERATION_CENTER.lat, height: 150 }
    const color = Cesium.Color.fromCssColorString(SCENARIO_COLORS[activeMission.scenario] ?? '#35c4ff')
    operationEntities.push(entities.add({
      name: `${activeMission.name} 当前位置`,
      position: Cesium.Cartesian3.fromDegrees(current.lon, current.lat, current.height),
      point: {
        pixelSize: activeMission.aircraftType === 'evtol' ? 14 : 11,
        color,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: activeMission.aircraftType === 'evtol' ? 'eVTOL' : activeMission.aircraftType === 'helicopter' ? '救援机' : '无人机',
        font: '600 12px "Microsoft YaHei",sans-serif',
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: color.withAlpha(0.72),
        pixelOffset: new Cesium.Cartesian2(0, -20),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }))
  }

  if (state.toggles.risks) {
    for (const risk of state.risks) {
      const high = risk.level === 'high'
      const color = Cesium.Color.fromCssColorString(high ? '#ff2d55' : '#ff9500')
      operationEntities.push(entities.add({
        name: risk.title,
        position: Cesium.Cartesian3.fromDegrees(risk.lon, risk.lat, risk.height),
        point: {
          pixelSize: high ? 13 : 10,
          color,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: high ? '高风险' : '中风险',
          font: '600 12px "Microsoft YaHei",sans-serif',
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: color.withAlpha(0.74),
          pixelOffset: new Cesium.Cartesian2(0, -18),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }))
    }
  }
}

export const clearOperationOverlays = (): void => {
  if (!viewer || viewer.isDestroyed()) {
    operationEntities = []
    return
  }
  for (const entity of operationEntities) {
    viewer.entities.remove(entity)
  }
  operationEntities = []
}

const drawZone = (zone: AirspaceZone): void => {
  if (!viewer || viewer.isDestroyed()) return
  const color = Cesium.Color.fromCssColorString(ZONE_COLORS[zone.type] ?? '#35c4ff')

  if (zone.polygon && zone.polygon.length >= 3) {
    operationEntities.push(viewer.entities.add({
      name: zone.name,
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(
          zone.polygon.map((point) => Cesium.Cartesian3.fromDegrees(point.lon, point.lat, zone.heightRange.min)),
        ),
        height: zone.heightRange.min,
        extrudedHeight: zone.heightRange.max,
        material: color.withAlpha(zone.type === 'no-fly' ? 0.22 : 0.14),
        outline: true,
        outlineColor: color.withAlpha(0.82),
      },
    }))
    const labelPosition = Cesium.Cartesian3.fromDegrees(zone.center.lon, zone.center.lat, zone.heightRange.max + 35)
    operationEntities.push(viewer.entities.add({
      name: `${zone.name} 标签`,
      position: labelPosition,
      label: {
        text: zone.name,
        font: '600 12px "Microsoft YaHei",sans-serif',
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: color.withAlpha(0.62),
        pixelOffset: new Cesium.Cartesian2(0, -8),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }))
    return
  }

  if (zone.radiusMeters && zone.radiusMeters > 0) {
    operationEntities.push(viewer.entities.add({
      name: zone.name,
      position: Cesium.Cartesian3.fromDegrees(zone.center.lon, zone.center.lat, zone.heightRange.max),
      ellipse: {
        semiMajorAxis: zone.radiusMeters,
        semiMinorAxis: zone.radiusMeters,
        height: zone.heightRange.min,
        extrudedHeight: zone.heightRange.max,
        material: color.withAlpha(zone.type === 'no-fly' ? 0.2 : 0.13),
        outline: true,
        outlineColor: color.withAlpha(0.82),
      },
      label: {
        text: zone.name,
        font: '600 12px "Microsoft YaHei",sans-serif',
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: color.withAlpha(0.62),
        pixelOffset: new Cesium.Cartesian2(0, -18),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }))
  }
}

const routePositions = (route: readonly RoutePoint[]): Cesium.Cartesian3[] =>
  route.map((point) => Cesium.Cartesian3.fromDegrees(point.lon, point.lat, point.height))

const interpolateRouteLocal = (route: readonly RoutePoint[], progress: number): RoutePoint => {
  if (route.length === 0) return { lon: SIMAO_OPERATION_CENTER.lon, lat: SIMAO_OPERATION_CENTER.lat, height: 120 }
  if (route.length === 1) return { ...route[0]! }
  const clamped = Math.min(100, Math.max(0, progress))
  const scaled = (clamped / 100) * (route.length - 1)
  const index = Math.min(route.length - 2, Math.floor(scaled))
  const t = scaled - index
  const a = route[index]!
  const b = route[index + 1]!
  return {
    lon: a.lon + (b.lon - a.lon) * t,
    lat: a.lat + (b.lat - a.lat) * t,
    height: a.height + (b.height - a.height) * t,
  }
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
  cursorHandler?.destroy()
  cursorHandler = undefined
  fieldScene?.dispose()
  fieldScene = undefined
  boundaryLoader?.destroy()
  boundaryLoader = undefined
  clearOperationOverlays()
  if (viewer && !viewer.isDestroyed()) {
    viewer.destroy()
  }
  viewer = undefined
}

export type {
  BeiDouFieldConfig,
  FieldMode,
  HeightRange,
  BoundaryLoadResult,
  BoundaryStyle,
  GridOverlayInput,
  PickedGridInfo,
}
