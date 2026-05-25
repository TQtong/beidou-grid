import * as Cesium from 'cesium'
import { Decimal } from 'decimal.js'
import Codec3D from '../beidou-grid/legacy-codec/codec-3d'

let viewer: Cesium.Viewer

type GridBounds = {
  west: number
  south: number
  east: number
  north: number
}

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

const EARTH_RADIUS = 6378137
const MAX_RENDERED_GRIDS = 20_000
const MAX_RENDERED_LABELS = 1_000

const bd = (val: number) => {
  return new Decimal(val.toString())
}

const GRID_SIZES_DEGREES = {
  0: [] as Decimal[],
  1: [bd(6), bd(4)],
  2: [bd(0.5), bd(0.5)],
  3: [bd(0.25), bd(10).div(bd(60))],
  4: [bd(1).div(bd(60)), bd(1).div(bd(60))],
  5: [bd(4).div(bd(3600)), bd(4).div(bd(3600))],
  6: [bd(2).div(bd(3600)), bd(2).div(bd(3600))],
  7: [bd(1).div(bd(4 * 3600)), bd(1).div(bd(4 * 3600))],
  8: [bd(1).div(bd(32 * 3600)), bd(1).div(bd(32 * 3600))],
  9: [bd(1).div(bd(256 * 3600)), bd(1).div(bd(256 * 3600))],
  10: [bd(1).div(bd(2048 * 3600)), bd(1).div(bd(2048 * 3600))]
}

const formatCount = (count: number) => {
  return Number.isFinite(count) ? Math.round(count).toLocaleString('zh-CN') : 'infinity'
}

const getGridStep = (gridSize: number): [number, number] => {
  const gridStep = GRID_SIZES_DEGREES[gridSize as keyof typeof GRID_SIZES_DEGREES]
  if (!gridStep || gridStep.length < 2) {
    throw new Error(`Grid level must be between 1 and 10, got ${gridSize}.`)
  }
  return [gridStep[0]!.toNumber(), gridStep[1]!.toNumber()]
}

const normalizeBounds = (bbox: GridBounds): GridBounds => {
  return {
    west: Math.min(Number(bbox.west), Number(bbox.east)),
    south: Math.min(Number(bbox.south), Number(bbox.north)),
    east: Math.max(Number(bbox.west), Number(bbox.east)),
    north: Math.max(Number(bbox.south), Number(bbox.north))
  }
}

export const estimateGridLoad = (
  stepHeight: number,
  gridSize: number,
  maxHeight: number,
  bbox: GridBounds
): GridCreateResult => {
  const bounds = normalizeBounds(bbox)
  const [stepLon, stepLat] = getGridStep(Number(gridSize))
  const width = Math.max(0, bounds.east - bounds.west)
  const height = Math.max(0, bounds.north - bounds.south)
  const columns = Math.ceil(width / stepLon) + 1
  const rows = Math.ceil(height / stepLat) + 1
  const heightLayers = Math.max(0, Math.ceil(Number(maxHeight) / Number(stepHeight)) - 1)
  const gridCount = columns * rows * heightLayers
  const labelsRendered = Math.min(gridCount, MAX_RENDERED_LABELS)
  const entityCount = gridCount + labelsRendered
  const status = gridCount > MAX_RENDERED_GRIDS ? 'skipped' : 'rendered'
  const message =
    status === 'skipped'
      ? `Skipped: estimated ${formatCount(gridCount)} 3D grids exceeds the safe limit ${formatCount(MAX_RENDERED_GRIDS)}. Reduce the range, max height, or grid level.`
      : `Estimated ${formatCount(gridCount)} 3D grids and ${formatCount(labelsRendered)} labels.`

  return {
    status,
    message,
    columns,
    rows,
    heightLayers,
    gridCount,
    entityCount,
    labelsRendered,
    stepLon,
    stepLat
  }
}

export const init = (element: HTMLDivElement): Cesium.Viewer => {
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
    shouldAnimate: true
  })

  Cesium.createWorldTerrainAsync().then((terrainProvider) => {
    viewer.terrainProvider = terrainProvider
  })

  return viewer
}

export const createGrid = (
  stepHeight: number,
  gridSize: number,
  maxHeight: number,
  bbox: GridBounds
): GridCreateResult => {
  const bounds = normalizeBounds(bbox)
  const estimate = estimateGridLoad(stepHeight, gridSize, maxHeight, bounds)

  if (estimate.status === 'skipped') {
    console.warn(estimate.message)
    return estimate
  }

  viewer.entities.removeAll()

  const { stepLon, stepLat } = estimate
  let renderedLabels = 0

  for (let lon = bounds.west - stepLon; lon < bounds.east; lon += stepLon) {
    for (let lat = bounds.south - stepLat; lat < bounds.north; lat += stepLat) {
      for (let height = stepHeight; height < maxHeight; height += stepHeight) {
        const centerLon = lon + stepLon / 2
        const centerLat = lat + stepLat / 2
        const code3d = Codec3D.encode(
          {
            lngDegree: centerLon,
            latDegree: centerLat,
            elevation: height
          },
          EARTH_RADIUS,
          2
        )
        const geometry = Cesium.Rectangle.fromDegrees(lon, lat, lon + stepLon, lat + stepLat)

        viewer.entities.add({
          rectangle: {
            coordinates: geometry,
            material: Cesium.Color.YELLOW.withAlpha(0.1),
            height: height - stepHeight,
            extrudedHeight: stepHeight,
            outline: true,
            outlineColor: Cesium.Color.PURPLE,
            outlineWidth: 1
          }
        })

        if (renderedLabels < MAX_RENDERED_LABELS) {
          viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(centerLon, centerLat, height),
            label: {
              text: code3d,
              show: true,
              font: '12px Arial',
              fillColor: Cesium.Color.WHITE,
              showBackground: true,
              backgroundColor: Cesium.Color.BLACK
            }
          })
          renderedLabels++
        }
      }
    }
  }

  return {
    ...estimate,
    labelsRendered: renderedLabels,
    entityCount: estimate.gridCount + renderedLabels,
    message: `Rendered ${formatCount(estimate.gridCount)} 3D grids and ${formatCount(renderedLabels)} labels.`
  }
}
