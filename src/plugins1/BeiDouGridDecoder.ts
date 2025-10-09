import BeiDouGridConstants from './BeiDouGridConstants'
import BeiDouGeoPoint from './BeiDouGeoPoint'
import BeiDouGridCommonUtils from './BeiDouGridCommonUtils'

import { LatDirection, LngDirection } from './type'
import StringBuilder from './StringBuilder'

/**
 * 北斗网格码解码器接口
 * 定义所有解码相关的操作
 */
export default class BeiDouGridDecoder {
  // 缓存编码映射表，避免重复创建
  private static LEVEL3_ENCODING_MAP_CACHE = new Map<string, number[][]>()
  private static LEVEL6_ENCODING_MAP_CACHE = new Map<string, number[][]>()

  /**
   * 解码二维网格编码为地理点
   *
   * @param code 二维网格编码
   * @return 解码后的地理点对象（所在网格左下角点）
   */
  public static decode2D(code: string) {
    if (code == null || code.length === 0) {
      throw new Error('位置码不能为空')
    }

    const level = this.getCodeLevel2D(code)
    const directions = this.getDirections(code)
    const lngDir =
      LngDirection[directions.get('lngDirection') as keyof typeof LngDirection]
    const latDir =
      LatDirection[directions.get('latDirection') as keyof typeof LatDirection]

    const lngSign = lngDir == LngDirection.E ? 1 : -1
    const latSign = latDir == LatDirection.N ? 1 : -1

    let lngInSec = 0
    let latInSec = 0

    for (let i = 1; i <= level; i++) {
      const offsets = this.decodeN(code, i)
      lngInSec += offsets[0]!
      latInSec += offsets[1]!
    }

    return new BeiDouGeoPoint(
      (lngInSec * lngSign) / 3600,
      (latInSec * latSign) / 3600,
      0
    )
  }

  /**
   * 解码三维网格编码为包含地理点和高度信息的 Map
   *
   * @param code 三维网格编码
   * @return 包含地理点和高度信息的 Map
   */
  public static decode3D(code: string) {
    if (code == null || code.length === 0) {
      throw new Error('位置码不能为空')
    }

    const level = this.getCodeLevel3D(code)

    const code2D = this.extract2DCode(code, level)
    const beiDouGeoPoint = this.decode2D(code2D)
    const height = this.decode3DHeight(code, level)

    beiDouGeoPoint.setHeight(height)

    return beiDouGeoPoint
  }

  /**
   * 获取二维网格码的层级
   */
  public static getCodeLevel2D(code: string) {
    const length = code.length
    for (let i = 0; i < BeiDouGridConstants.CODE_LENGTH_AT_LEVEL.length; i++) {
      if (BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[i] == length) {
        return i
      }
    }
    throw new Error('无效的二维网格码长度: ' + length)
  }

  /**
   * 获取三维网格码的层级
   */
  public static getCodeLevel3D(code: string) {
    const length = code.length
    for (let level = 1; level <= 10; level++) {
      let expectedLength = 2
      for (let i = 1; i <= level; i++) {
        expectedLength +=
          BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[i]! -
          BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[i - 1]!
        expectedLength += i == 1 ? 2 : 1
      }
      if (expectedLength == length) {
        return level
      }
    }
    throw new Error('无效的三维网格码码长度: ' + code)
  }

  /**
   * 获取经纬度方向
   */
  private static getDirections(code: string) {
    const directions = new Map<string, string>()
    directions.set('latDirection', code.charAt(0) == 'N' ? 'N' : 'S')
    const lngPart = parseInt(code.substring(1, 3))
    directions.set('lngDirection', lngPart >= 31 ? 'E' : 'W')
    return directions
  }

  /**
   * 解码第n级网格码
   */
  private static decodeN(code: string, n: number) {
    if (n < 1 || n > 10) {
      throw new Error('层级错误: ' + n)
    }

    const fragment = this.getCodeFragment(code, n)
    const rowCol = this.getRowAndCol(fragment, n, code)

    let lng = rowCol[0]
    let lat = rowCol[1]

    if (n == 1) {
      if (lng == 0) {
        throw new Error('暂不支持两极地区解码')
      }
      lng = lng >= 31 ? lng - 31 : 30 - lng
    }

    const lngOffset =
      lng *
      BeiDouGridConstants.GRID_SIZES_SECONDS[
        n as keyof typeof BeiDouGridConstants.GRID_SIZES_SECONDS
      ][0]!
    const latOffset =
      lat *
      BeiDouGridConstants.GRID_SIZES_SECONDS[
        n as keyof typeof BeiDouGridConstants.GRID_SIZES_SECONDS
      ][1]!

    return new Array(lngOffset, latOffset)
  }

  /**
   * 获取某一层级的位置码片段
   */
  private static getCodeFragment(code: string, level: number) {
    if (level == 0) {
      return code.charAt(0).toString()
    }
    const start = BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[level - 1]
    const end = BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[level]
    return code.substring(Number(start), Number(end))
  }

  /**
   * 解析行列号
   */
  private static getRowAndCol(
    codeFragment: string,
    level: number,
    code: string
  ) {
    if (
      codeFragment.length !=
      BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[level]! -
        BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[level - 1]!
    ) {
      throw new Error('编码片段长度错误: ' + codeFragment)
    }

    let lng
    let lat

    switch (level) {
      case 1:
        lng = parseInt(codeFragment.substring(0, 2))
        lat = codeFragment.charAt(2).charCodeAt(0) - 'A'.charCodeAt(0)
        break
      case 2:
        lng = this.decodeLevel2(codeFragment, code, true)
        lat = this.decodeLevel2(codeFragment, code, false)
        break
      case 4:
      case 5:
        lng = this.decodeLevel4_5(codeFragment, code, true)
        lat = this.decodeLevel4_5(codeFragment, code, false)
        break
      case 7:
      case 8:
      case 9:
      case 10:
        lng = parseInt(codeFragment.substring(0, 1), 16)
        lat = parseInt(codeFragment.substring(1, 2), 16)
        break
      case 3:
        const indices3 = this.decodeLevel3(codeFragment, code)
        lng = indices3[0]
        lat = indices3[1]
        break
      case 6:
        const indices6 = this.decodeLevel6(codeFragment, code)
        lng = indices6[0]
        lat = indices6[1]
        break
      default:
        throw new Error('不支持的层级: ' + level)
    }

    return new Array(lng, lat)
  }

  /**
   * 解码二级网格
   */
  private static decodeLevel2(
    codeFragment: string,
    code: string,
    isLng: boolean
  ) {
    const index = isLng ? 0 : 1
    const encoded = parseInt(codeFragment.substring(index, index + 1), 16)
    if (code != null) {
      const hemisphere = BeiDouGridCommonUtils.getHemisphereFromCode(code)
      let result = encoded
      switch (hemisphere) {
        case 'NE':
        case 'NW':
          result = encoded
          break
        case 'SE':
        case 'SW':
          result = isLng ? 11 - encoded : 7 - encoded
          break
        default:
          result = encoded
          break
      }
      return result
    }
    return encoded
  }

  /**
   * 解码四级/五级网格
   */
  private static decodeLevel4_5(
    codeFragment: string,
    code: string,
    isLng: boolean
  ) {
    const index = isLng ? 0 : 1
    const encoded = parseInt(codeFragment.substring(index, index + 1), 16)
    if (code != null) {
      const hemisphere = BeiDouGridCommonUtils.getHemisphereFromCode(code)
      let result = encoded
      switch (hemisphere) {
        case 'NE':
        case 'NW':
          result = encoded
          break
        case 'SE':
        case 'SW':
          result = 14 - encoded
          break
        default:
          result = encoded
          break
      }
      return result
    }
    return encoded
  }

  /**
   * 解码三级网格
   */
  private static decodeLevel3(codeFragment: string, code: string) {
    const n = parseInt(codeFragment)
    const indices = new Array(2)

    if (code != null) {
      const hemisphere = BeiDouGridCommonUtils.getHemisphereFromCode(code)
      const encodingMap = this.getLevel3EncodingMap(hemisphere)
      let found = false

      for (let i = 0; i < encodingMap.length && !found; i++) {
        for (let j = 0; j < encodingMap[i]!.length; j++) {
          if (encodingMap[i]![j] == n) {
            indices[0] = j
            indices[1] = i
            found = true
            break
          }
        }
      }

      if (!found) {
        throw new Error('无效的三级网格编码: ' + n)
      }
    } else {
      if (n <= 1) {
        indices[0] = n
        indices[1] = 0
      } else if (n <= 3) {
        indices[0] = n - 2
        indices[1] = 1
      } else {
        indices[0] = n - 4
        indices[1] = 2
      }
    }

    return indices
  }

  /**
   * 解码六级网格
   */
  private static decodeLevel6(codeFragment: string, code: string) {
    const n = parseInt(codeFragment)
    const indices = new Array(2)

    if (code != null) {
      const hemisphere = BeiDouGridCommonUtils.getHemisphereFromCode(code)
      const encodingMap = this.getLevel6EncodingMap(hemisphere)
      let found = false

      for (let i = 0; i < encodingMap.length && !found; i++) {
        for (let j = 0; j < encodingMap[i]!.length; j++) {
          if (encodingMap[i]![j] == n) {
            indices[0] = j
            indices[1] = i
            found = true
            break
          }
        }
      }

      if (!found) {
        throw new Error('无效的六级网格编码: ' + n)
      }
    } else {
      if (n <= 1) {
        indices[0] = n
        indices[1] = 0
      } else {
        indices[0] = n - 2
        indices[1] = 1
      }
    }

    return indices
  }

  /**
   * 从三维编码中提取二维编码部分
   */
  public static extract2DCode(code3D: string, level: number) {
    const code2D = new StringBuilder()
    code2D.append(code3D.charAt(0))

    let code3DIndex = 2

    for (let i = 1; i <= level; i++) {
      const level2DLength =
        BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[i]! -
        BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[i - 1]!
      code2D.append(code3D.substring(code3DIndex, code3DIndex + level2DLength))
      code3DIndex += level2DLength

      if (i == 1) {
        code3DIndex += 2
      } else {
        code3DIndex += 1
      }
    }

    return code2D.toString()
  }

  /**
   * 从三维编码中解码高度信息（网格底平面高度）
   */
  private static decode3DHeight(code: string, level: number) {
    // 高度方向符号：0表示地上，1表示地下
    const heightSign = code.charAt(1) == '0' ? 1 : -1

    // 重建完整的高度索引n
    let n = 0
    let codeIndex = 2

    for (let i = 1; i <= level; i++) {
      // 跳过二维编码部分
      const level2DLength =
        BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[i]! -
        BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[i - 1]!
      codeIndex += level2DLength

      // 获取当前级别的高度编码
      const heightCodeLength = i == 1 ? 2 : 1
      const heightCodeStr = code.substring(
        codeIndex,
        codeIndex + heightCodeLength
      )
      codeIndex += heightCodeLength

      // 解析高度编码值
      let heightIndex
      if (i == 1) {
        // 第一级特殊处理：2位十进制数表示6位二进制值
        heightIndex = parseInt(heightCodeStr, 10)
      } else {
        const radix =
          BeiDouGridConstants.ELEVATION_ENCODING[
            i as keyof typeof BeiDouGridConstants.ELEVATION_ENCODING
          ][1]
        heightIndex = parseInt(heightCodeStr, radix)
      }

      // 按照标准将编码值放置到正确的位位置
      const bitRange =
        BeiDouGridConstants.HEIGHT_BIT_RANGES[
          i as keyof typeof BeiDouGridConstants.HEIGHT_BIT_RANGES
        ]
      const startBit = bitRange[0]

      // 将heightIndex的各位设置到n的相应位置（从第1位开始计数）
      for (let bit = 0; bit < bitRange[1]! - bitRange[0]! + 1; bit++) {
        if (((heightIndex >> bit) & 1) == 1) {
          n |= 1 << (startBit! - 1 + bit)
        }
      }
    }

    // 使用标准逆公式计算高度：H = (1 + θ0)^(n*θ/θ0) * r0 - r0
    const theta = Math.PI / 180 / 60 / 60 / 2048 // theta = π/180/3600/2048
    const theta0 = Math.PI / 180 // theta0 = π/180

    const height =
      Math.pow(1 + theta0, (n * theta) / theta0) *
        BeiDouGridConstants.EARTH_RADIUS -
      BeiDouGridConstants.EARTH_RADIUS

    return height * heightSign
  }

  /**
   * 获取三级网格编码映射表
   */
  private static getLevel3EncodingMap(hemisphere: string) {
    // computeIfAbsent 的 JavaScript 等价写法
    if (!this.LEVEL3_ENCODING_MAP_CACHE.has(hemisphere)) {
      let mapping: number[][]
      switch (hemisphere) {
        case 'NW':
          mapping = [
            [1, 0],
            [3, 2],
            [5, 4],
          ]
          break
        case 'NE':
          mapping = [
            [0, 1],
            [2, 3],
            [4, 5],
          ]
          break
        case 'SW':
          mapping = [
            [5, 4],
            [3, 2],
            [1, 0],
          ]
          break
        case 'SE':
          mapping = [
            [4, 5],
            [2, 3],
            [0, 1],
          ]
          break
        default:
          mapping = [
            [0, 1],
            [2, 3],
            [4, 5],
          ]
          break
      }
      this.LEVEL3_ENCODING_MAP_CACHE.set(hemisphere, mapping)
    }
    const result = this.LEVEL3_ENCODING_MAP_CACHE.get(hemisphere)!

    return result
  }

  /**
   * 获取六级网格编码映射表
   */
  private static getLevel6EncodingMap(hemisphere: string) {
    if (!this.LEVEL6_ENCODING_MAP_CACHE.has(hemisphere)) {
      let mapping: number[][]
      switch (hemisphere) {
        case 'NW':
          mapping = [
            [1, 0],
            [3, 2],
          ]
          break
        case 'NE':
          mapping = [
            [0, 1],
            [2, 3],
          ]
          break
        case 'SW':
          mapping = [
            [3, 2],
            [1, 0],
          ]
          break
        case 'SE':
          mapping = [
            [2, 3],
            [0, 1],
          ]
          break
        default:
          mapping = [
            [0, 1],
            [2, 3],
          ]
          break
      }
      this.LEVEL6_ENCODING_MAP_CACHE.set(hemisphere, mapping)
    }
    const result = this.LEVEL6_ENCODING_MAP_CACHE.get(hemisphere)!
    return result
  }
}
