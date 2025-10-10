import * as Cesium from 'cesium'
import Codec3D from './plugins/codec-3d'
import type { LngLatEle, LngLat } from './plugins/type'
import Codec2D from './plugins/codec-2d'
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate'
import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory'
import { log } from 'mathjs'
import GeoJsonWriter from 'jsts/org/locationtech/jts/io/GeoJsonWriter'
import BeiDouGridUtils from './plugins1/BeiDouGridUtils'

export const init = (elemnet: HTMLDivElement): Cesium.Viewer => {
  const viewer = new Cesium.Viewer(elemnet, {
    geocoder: false, // 右上角 搜索
    homeButton: false, // 右上角 Home
    sceneModePicker: false, // 右上角 2D/3D切换
    baseLayerPicker: false, // 右上角 地形
    navigationHelpButton: false, // 右上角 Help
    animation: true, // 左下角 圆盘动画控件
    timeline: true, // 时间轴
    fullscreenButton: false, // 右下角 全屏控件
    vrButton: false, // 如果设置为true，将创建VRButton小部件。
    scene3DOnly: true, // 每个几何实例仅以3D渲染以节省GPU内存
    infoBox: false, // 隐藏点击要素后的提示信息
    shouldAnimate: true, // 运行动画自动播放
  })

  Cesium.createWorldTerrainAsync().then((terrainProvider) => {
    viewer.terrainProvider = terrainProvider
  })

  // 深度监测
  // viewer.scene.globe.depthTestAgainstTerrain = true

  // const lngLatNE: LngLat = {
  //   lngDegree: 116,
  //   lngMinute: 18,
  //   lngSecond: 45.37,
  //   lngDirection: 'E',
  //   latDegree: 39,
  //   latMinute: 59,
  //   latSecond: 35.38,
  //   latDirection: 'N'
  // }
  // console.log('坐标: ', lngLatNE)
  // const codeNE = Codec2D.encode(lngLatNE, 10)
  // console.log('北斗二维网格位置码: ', codeNE)
  // console.log('解码 => ', Codec2D.decode(codeNE))
  // console.log('-------------------')
  // console.log('参照 N50J47539B82553461')
  // const referNE1 = Codec2D.refer(codeNE, 'N50J47539B82553461')
  // console.log(referNE1)
  // console.log('还原')
  // const deReferNE1 = Codec2D.deRefer(referNE1)
  // console.log(deReferNE1)
  // console.log('-------------------')
  // console.log('参照 N50J47539b82')
  // const referNE2 = Codec2D.refer(codeNE, 'N50J47539b82')
  // console.log(referNE2)
  // console.log('还原')
  // const deReferNE2 = Codec2D.deRefer(referNE2)
  // console.log(deReferNE2)
  // console.log('-------------------')
  // console.log('参照 N50J4754909')
  // const referNE3 = Codec2D.refer(codeNE, 'N50J4754909')
  // console.log(referNE3)
  // console.log('还原')
  // const deReferNE3 = Codec2D.deRefer(referNE3)
  // console.log(deReferNE3)

  // const h = 8848.86
  // const code = Codec3D.encodeElevation(h)
  // console.log('珠穆朗玛峰高程方向编码', code)
  // console.log('珠穆朗玛峰高程方向编码解码结果', Codec3D.decodeElevation(code))
  // const zmlmf: LngLatEle = {
  //   lngDegree: 86.9,
  //   latDegree: 27.9,
  //   elevation: h
  // }
  // console.log('珠穆朗玛峰大地坐标', zmlmf)
  // const code3d = Codec3D.encode(zmlmf)
  // console.log('珠穆朗玛峰北斗三维网格位置码', code3d)
  // console.log('珠穆朗玛峰北斗三维网格位置码解码结果', Codec3D.decode(code3d))

  const bboxEast = {
    west: 73.66,
    south: 3.86,
    east: 135.05,
    north: 53.55
  }

  // const bboxEast = {
  //   west: 0,
  //   south: 0,
  //   east: 180,
  //   north: 88
  // }
  const bboxWest = {
    west: -180,
    south: 0,
    east: 0,
    north: 88,
  }
  const bboxNorth = {
    west: 0,
    south: -88,
    east: 180,
    north: 0,
  }
  const bboxSouth = {
    west: -180,
    south: -88,
    east: 0,
    north: 0,
  }

  const stepLon = 6
  const stepLat = 4
  const stepHeight = 445280

  const maxHeight = 4452800
  let lastHeight = 0

  for (let lon = bboxEast.west - stepLon; lon < bboxEast.east; lon += stepLon) {
    for (
      let lat = bboxEast.south - stepLat;
      lat < bboxEast.north;
      lat += stepLat
    ) {
      lastHeight = 0
      for (let height = stepHeight; height < maxHeight; height += stepHeight) {
        const centerLon = lon + stepLon / 2
        const centerLat = lat + stepLat / 2
        const code2d = Codec2D.encode({
          lngDegree: centerLon,
          latDegree: centerLat,
        },1)
        const code3d = Codec3D.encode({
          lngDegree: centerLon,
          latDegree: centerLat,
          elevation: height,
        },6378137, 1)
        const geometry = Cesium.Rectangle.fromDegrees(
          lon,
          lat,
          lon + stepLon,
          lat + stepLat
        )

        viewer.entities.add({
          rectangle: {
            coordinates: geometry,
            material: Cesium.Color.YELLOW.withAlpha(0.1),
            height: height - stepHeight,
            extrudedHeight: stepHeight,
            // fill: false,
            outline: true,
            outlineColor: Cesium.Color.PURPLE,
            outlineWidth: 1,
          },
        })
        viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(centerLon, centerLat, height),
          label: {
            text: code3d,
            show: true,
            font: '12px Arial',
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor: Cesium.Color.BLACK,
          },
        })
        lastHeight = height
      }
    }
  }

  // for (let lon = bboxWest.west; lon < bboxWest.east; lon += stepLon) {
  //   for (let lat = bboxWest.south; lat < bboxWest.north; lat += stepLat) {
  //     // const code = Codec2D.encode({ lngDegree: lon, latDegree: lat })
  //     const Rectangle = Cesium.Rectangle.fromDegrees(lon, lat, lon + stepLon, lat + stepLat)
  //     viewer.entities.add({
  //       rectangle: {
  //         coordinates: Rectangle,
  //         material: Cesium.Color.fromRandom()
  //       }
  //     })
  //   }
  // }

  // for (let lon = bboxNorth.west; lon < bboxNorth.east; lon += stepLon) {
  //   for (let lat = bboxNorth.south; lat < bboxNorth.north; lat += stepLat) {
  //     // const code = Codec2D.encode({ lngDegree: lon, latDegree: lat })
  //     const Rectangle = Cesium.Rectangle.fromDegrees(lon, lat, lon + stepLon, lat + stepLat)
  //     viewer.entities.add({
  //       rectangle: {
  //         coordinates: Rectangle,
  //         material: Cesium.Color.fromRandom()
  //       }
  //     })
  //   }
  // }

  // for (let lon = bboxSouth.west; lon < bboxSouth.east; lon += stepLon) {
  //   for (let lat = bboxSouth.south; lat < bboxSouth.north; lat += stepLat) {
  //     // const code = Codec2D.encode({ lngDegree: lon, latDegree: lat })
  //     const Rectangle = Cesium.Rectangle.fromDegrees(lon, lat, lon + stepLon, lat + stepLat)
  //     viewer.entities.add({
  //       rectangle: {
  //         coordinates: Rectangle,
  //         material: Cesium.Color.fromRandom()
  //       }
  //     })
  //   }
  // }

  return viewer
}

// export const init = (elemnet: HTMLDivElement): Cesium.Viewer => {
//   const viewer = new Cesium.Viewer(elemnet, {
//     geocoder: false, // 右上角 搜索
//     homeButton: false, // 右上角 Home
//     sceneModePicker: false, // 右上角 2D/3D切换
//     baseLayerPicker: false, // 右上角 地形
//     navigationHelpButton: false, // 右上角 Help
//     animation: true, // 左下角 圆盘动画控件
//     timeline: true, // 时间轴
//     fullscreenButton: false, // 右下角 全屏控件
//     vrButton: false, // 如果设置为true，将创建VRButton小部件。
//     scene3DOnly: true, // 每个几何实例仅以3D渲染以节省GPU内存
//     infoBox: false, // 隐藏点击要素后的提示信息
//     shouldAnimate: true, // 运行动画自动播放
//   })

//   Cesium.createWorldTerrainAsync().then((terrainProvider) => {
//     viewer.terrainProvider = terrainProvider
//   })

//   const GEOMETRY_FACTORY = new GeometryFactory()

//   // // 创建一个小的多边形（北京故宫区域）
//   // const polygonCoords: Coordinate[] = [
//   //   new Coordinate(116.391, 39.913),
//   //   new Coordinate(116.401, 39.913),
//   //   new Coordinate(116.401, 39.923),
//   //   new Coordinate(116.391, 39.923),
//   //   new Coordinate(116.391, 39.913),
//   // ]

//   // // 查找网格码层级
//   // const targetLevel = 1

//   // const polygon = GEOMETRY_FACTORY.createPolygon(polygonCoords)
//   // console.log('初始数据{}', new GeoJsonWriter().write(polygon))
//   // // 查找网格码
//   // const gridCodes = BeiDouGridUtils.find2DIntersectingGridCodes(
//   //   polygon,
//   //   targetLevel
//   // )

//   // console.log('找到 {} 个{}级二维网格码:', gridCodes.size, targetLevel)

//   // 创建一个简单的矩形几何图形（包含高度数据）
//   const coordinates: Coordinate[] = [
//     new Coordinate(116.391, 39.913, 100),
//     new Coordinate(116.401, 39.913, 100),
//     new Coordinate(116.401, 39.923, 100),
//     new Coordinate(116.391, 39.923, 100),
//     new Coordinate(116.391, 39.913, 100)
//   ]

//   const geom = GEOMETRY_FACTORY.createPolygon(coordinates)
//   console.log('初始数据{}', new GeoJsonWriter().write(geom))
//   // 查询网格
//   const result = BeiDouGridUtils.find3DIntersectingGridCodes(geom, 8, 0, 0)
//   console.log('result', result)

//   return viewer
// }
