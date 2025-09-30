import * as Cesium from 'cesium'
import Codec3D from './plugins/codec-3d'
import type { LngLatEle, LngLat } from './plugins/type'
import Codec2D from './plugins/codec-2d'

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
    shouldAnimate: true // 运行动画自动播放
  })

  Cesium.createWorldTerrainAsync().then((terrainProvider) => {
    viewer.terrainProvider = terrainProvider
  })

  // 深度监测
  viewer.scene.globe.depthTestAgainstTerrain = true

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
    north: 88
  }
  const bboxNorth = {
    west: 0,
    south: -88,
    east: 180,
    north: 0
  }
  const bboxSouth = {
    west: -180,
    south: -88,
    east: 0,
    north: 0
  }

  const stepLon = 6
  const stepLat = 4
  const stepHeight = 445280

  for (let lon = bboxEast.west - stepLon; lon < bboxEast.east; lon += stepLon) {
    for (let lat = bboxEast.south - stepLat; lat < bboxEast.north; lat += stepLat) {
      for (
        let height = stepHeight;
        height < 445281;
        height += stepHeight
      ) {
        const centerLon = lon + stepLon / 2
        const centerLat = lat + stepLat / 2
        const code2d = Codec2D.encode({ lngDegree: centerLon, latDegree: centerLat }, 1)
        const Rectangle = Cesium.Rectangle.fromDegrees(lon, lat, lon + stepLon, lat + stepLat)

        const sideLength = Cesium.Cartesian3.distance(
          Cesium.Cartesian3.fromDegrees(lon, lat, height),
          Cesium.Cartesian3.fromDegrees(lon + stepLon, lat, height)
        )
        const sideWidth = Cesium.Cartesian3.distance(
          Cesium.Cartesian3.fromDegrees(lon, lat, height),
          Cesium.Cartesian3.fromDegrees(lon, lat + stepLat, height)
        )

        viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(centerLon, centerLat, height),
          box: {
            dimensions: new Cesium.Cartesian3(sideLength, sideWidth, height),
            material: Cesium.Color.fromRandom(),
            outline: true,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 1
          }
        })

        // const rectangle = viewer.entities.add({
        //   rectangle: {
        //     coordinates: Rectangle,
        //     material: Cesium.Color.fromRandom(),
        //     height
        //   }
        // })
        viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(centerLon, centerLat, height),
          label: {
            text: code2d,
            show: true,
            font: '12px Arial',
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor: Cesium.Color.BLACK
          }
        })
      }
      // const centerLon = lon + stepLon / 2
      // const centerLat = lat + stepLat / 2
      // const code2d = Codec2D.encode({ lngDegree: centerLon, latDegree: centerLat }, 1)
      // console.log(code2d)

      // const Rectangle = Cesium.Rectangle.fromDegrees(lon, lat, lon + stepLon, lat + stepLat)
      // viewer.entities.add({
      //   rectangle: {
      //     coordinates: Rectangle,
      //     material: Cesium.Color.fromRandom()
      //   }
      // })
      // viewer.entities.add({
      //   position: Cesium.Cartesian3.fromDegrees(centerLon, centerLat, 1000),
      //   label: {
      //     text: code2d,
      //     show: true,
      //     font: '12px Arial',
      //     fillColor: Cesium.Color.WHITE,
      //     showBackground: true,
      //     backgroundColor: Cesium.Color.BLACK
      //   }
      // })
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
