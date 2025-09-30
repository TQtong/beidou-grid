/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { LngLat, DecodeOption, LngDirection, LatDirection, PoleGrid } from './type'
import { gridSizes1, gridCount1, codeLengthAtLevel, gridCountPole } from './data'

class Codec2D {
  /**
   * 对一个经纬度坐标编码
   * @param lngLat 经纬度坐标，可以写小数形式（正负号表示方向），也可以写度分秒形式（均为正数，direction字段表示方向）
   * @param level 要编码到第几级，默认为10
   * @returns 北斗二维网格位置码
   */
  static encode(lngLat: LngLat, level = 10): string {
    let [lngInSec, latInSec] = this.getSecond(lngLat)
    // 记录第n级网格的定位角点经纬度
    let lngN = 0,
      latN = 0
    // 存储结果
    let resCode = ''
    if (Math.abs(lngLat.latDegree) >= 88) {
      // 都变换到东经0~90°
      let part: number
      let parent: PoleGrid = { isPoint: true, latSize: 2 * 3600 }
      if (lngInSec >= 120 * 3600) {
        lngInSec -= 120 * 3600
        part = 2
      } else if (lngInSec <= -120 * 3600) {
        lngInSec = -lngInSec - 60 * 3600
        part = 2
      } else if (lngInSec < 0) {
        lngInSec = -lngInSec
        part = 3
      } else {
        part = 1
      }
      for (let i = 0; i <= level; i++) {
        const res = this.encodeNPole(lngInSec, latInSec, lngN, latN, parent, i, part)
        lngN += res[0]
        latN += res[1]
        resCode += res[2]
        parent = res[3]
      }
    } else {
      for (let i = 0; i <= level; i++) {
        const t = this.encodeN(lngInSec, latInSec, lngN, latN, i)
        lngN += t[0]
        latN += t[1]
        resCode += t[2]
        // 从第二级开始，对称到东北半球计算，需要均取非负数计算
        if (i === 1) {
          lngInSec = Math.abs(lngInSec)
          latInSec = Math.abs(latInSec)
        }
      }
    }

    return resCode
  }

  /**
   * 以下坐标均以秒表示，且第2级开始所有半球均对称到东北半球处理（非负）
   * @param lngInSec 位置经度
   * @param latInSec 位置纬度
   * @param lngN 该位置所在第n级二维北斗网格的定位角点经度
   * @param latN 该位置所在第n级二维北斗网格的定位角点纬度
   * @param n 第n级
   * @returns [lngN+1, latN+1, codeN]
   */
  private static encodeN(
    lngInSec: number,
    latInSec: number,
    lngN: number,
    latN: number,
    n: number
  ): [number, number, string] {
    if (n === 0) {
      // 南北半球标识码
      return [0, 0, latInSec > 0 ? 'N' : 'S']
    } else if (n === 1) {
      // 根据国家基本比例尺地形图分幅和编号，按照1:1000000对第一级进行划分
      // 经度
      const a = Math.floor(lngInSec / gridSizes1[n][0])
      // 纬度
      const b = Math.floor(Math.abs(latInSec) / gridSizes1[n][1])
      return [
        // a <0 时，需要取反并-1
        (a >= 0 ? a : -a - 1) * gridSizes1[n][0],
        b * gridSizes1[n][1],
        this.encodeFragment(n, a + 31, b)
      ]
    } else {
      // 公式中需要+1，为了底下方便计算没有+1，因为之后还要-1
      const a = Math.floor((lngInSec - lngN) / gridSizes1[n][0])
      const b = Math.floor((latInSec - latN) / gridSizes1[n][1])
      return [a * gridSizes1[n][0], b * gridSizes1[n][1], this.encodeFragment(n, a, b)]
    }
  }

  private static encodeNPole(
    lngInSec: number,
    latInSec: number,
    lngN: number,
    latN: number,
    parent: PoleGrid,
    n: number,
    part: number
  ): [number, number, string, PoleGrid] {
    if (n < 0 || n > 10) {
      throw new Error('encodeNP: 等级应该在0~10之间')
    }
    let lngNP1: number
    let latNP1: number
    let codeN = ''
    let self: PoleGrid
    if (n === 0) {
      lngNP1 = 0
      latNP1 = 0
      codeN = latInSec > 0 ? 'N' : 'S'
      self = { isPoint: true, latSize: 2 * 3600 }
    } else if (n === 1) {
      lngNP1 = 0
      latNP1 = 88 * 3600
      codeN = '000'
      self = { isPoint: true, latSize: 2 * 3600 }
    } else if (n === 2) {
      // 第二级时，全都对称到东经0~120°
      if (latInSec - latN >= parent.latSize / 2) {
        codeN += (0).toString()
        if (latInSec - latN >= parent.latSize * 0.75) {
          lngNP1 = 0
          latNP1 = parent.latSize * 0.75
          codeN += (0).toString()
          self = { isPoint: true, latSize: parent.latSize / 4 }
        } else {
          lngNP1 = 0
          latNP1 = parent.latSize * 0.5
          codeN += part.toString()
          self = {
            isPoint: false,
            latSize: parent.latSize / 4,
            lngSize: 120 * 3600
          }
        }
      } else {
        codeN += part.toString()
        const row = Math.floor(latInSec - latN / (parent.latSize * 0.25))
        const col = Math.floor(lngInSec / (60 * 3600))
        lngNP1 = 60 * 3600 * col
        latNP1 = row * (parent.latSize * 0.25)
        codeN += col + 2 * row
        self = {
          isPoint: false,
          latSize: parent.latSize / 4,
          lngSize: 60 * 3600
        }
      }
    } else {
      const gridCountLng = gridCountPole[n][0]
      const gridCountLat = gridCountPole[n][1]
      if (parent.isPoint) {
        if (latInSec - latN >= parent.latSize / gridCountLat) {
          codeN = '0'
          lngNP1 = 0
          latNP1 = (parent.latSize / gridCountLat) * (gridCountLat - 1)
          self = { isPoint: true, latSize: parent.latSize / gridCountLat }
        } else {
          codeN = part.toString()
          lngNP1 = 0
          latNP1 = 0
          self = {
            isPoint: false,
            latSize: parent.latSize / gridCountLat,
            lngSize: 120 * 3600
          }
        }
      } else {
        const gridSizeLng = parent.lngSize! / gridCountLng
        const gridSizeLat = parent.latSize / gridCountLat
        const a = Math.floor((lngInSec - lngN) / gridSizeLng)
        const b = Math.floor((latInSec - latN) / gridSizeLat)
        lngNP1 = a * gridSizeLng
        latNP1 = b * gridSizeLat
        codeN = a.toString(16).toUpperCase() + b.toString(16).toUpperCase()
        self = {
          isPoint: false,
          latSize: parent.latSize / gridCountLat,
          lngSize: parent.lngSize! / gridCountLng
        }
      }
    }
    return [lngNP1, latNP1, codeN, self]
  }

  /**
   *
   * @param level 当前编码层级
   * @param lngCount 经度方向网格数
   * @param latCount 纬度方向网格数
   * @returns 当前层级的编码片段
   */
  private static encodeFragment(level: number, lngCount: number, latCount: number): string {
    if (level === 3 || level === 6) {
      return (latCount * 2 + lngCount).toString()
    } else if (level > 1 && level <= 10) {
      return lngCount.toString(16).toUpperCase() + latCount.toString(16).toUpperCase()
    } else if (level === 1) {
      // 前置位补零
      const aS = lngCount.toString().padStart(2, '0')
      const bS = String.fromCharCode(65 + latCount)
      return aS + bS
    }
    throw new Error('非法层级level')
  }

  /**
   * 对北斗二维网格位置码解码
   * @param code 需要解码的北斗二维网格位置码
   * @param decodeOption 解码选项，可不传
   * @returns 经纬度坐标
   */
  static decode(code: string, decodeOption: DecodeOption = { form: 'decimal' }): LngLat {
    // 层级
    const level = this.getCodeLevel(code)
    // 半球方向
    const directions = this.getDirections(code)
    // 南北半球标识
    const [lngSign, latSign] = this.getSigns(directions)
    // 用于累加结果
    let lng = 0
    let lat = 0
    // 对 1 ~ level 级进行解码
    for (let i = 1; i <= level; i++) {
      const pair = this.decodeN(code, i)
      lng += pair[0]
      lat += pair[1]
    }
    const result: LngLat = { latDegree: 0, lngDegree: 0 }
    // 格式化输出结果
    if (decodeOption.form === 'decimal') {
      // 用小数表示
      lng *= lngSign
      lat *= latSign
      result.lngDegree = lng / 3600
      result.latDegree = lat / 3600
    } else {
      // 用度分秒表示
      // 方向
      result.latDirection = latSign == -1 ? 'S' : 'N'
      result.lngDirection = lngSign == -1 ? 'W' : 'E'
      // 经度
      result.lngSecond = lng % 60
      lng = (lng - result.lngSecond) / 60
      result.lngMinute = lng % 60
      lng = (lng - result.lngMinute) / 60
      result.lngDegree = lng
      // 纬度
      result.latSecond = lat % 60
      lat = (lat - result.latSecond) / 60
      result.latMinute = lat % 60
      lat = (lat - result.latMinute) / 60
      result.latDegree = lat
    }
    return result
  }

  /**
   * 对第n级进行解码
   * @param code 北斗二维网格位置码
   * @param n 层级
   * @returns [number, number] 该层级的经纬度偏移量（单位秒，且非负）
   */
  private static decodeN(code: string, n: number): [number, number] {
    if (n < 1 || n > 10) {
      throw new Error('层级错误')
    }
    // 获取行列号
    const rowCol = this.getRowAndCol(this.getCodeAtLevel(code, n), n)
    // 如果是第一级，需要特殊处理
    if (n === 1) {
      if (rowCol[0] === 0) {
        throw new Error('暂不支持解码两极地区(纬度大于等于88°)编码')
      }
      rowCol[0] = rowCol[0] >= 31 ? rowCol[0] - 31 : 30 - rowCol[0]
    }
    return [rowCol[0] * gridSizes1[n][0], rowCol[1] * gridSizes1[n][1]]
  }

  /**
   *
   * @param target 目标区域位置
   * @param reference 参考网格位置码
   * @param separator 分隔符
   * @returns 参考网格位置码
   */
  static refer(target: string | LngLat, reference: string, separator = '-'): string {
    if (typeof target !== 'string') {
      return this.refer(this.encode(target), reference)
    }
    const level = this.getCodeLevel(reference)
    if (level < 5) {
      // 因为第五级有15个网格，而参考码网格最多有8个
      throw new Error('参照网格编码必须大于等于5级')
    }
    // 获取半球信息
    const directions = this.getDirections(reference)
    const [lngSign, latSign] = this.getSigns(directions)
    const diff = this.getOffset(reference, target)
    const lngDiff = diff[0] * lngSign
    const latDiff = diff[1] * latSign
    if (Math.abs(lngDiff) > 7 || Math.abs(latDiff) > 7) {
      throw new Error('不可进行参考')
    }
    let c = reference + separator
    // 对第level进行参照
    if (lngDiff >= 0) {
      c += lngDiff
    } else {
      c += String.fromCharCode(64 + -lngDiff).toUpperCase()
    }
    if (latDiff >= 0) {
      c += latDiff
    } else {
      c += String.fromCharCode(64 + -latDiff).toUpperCase()
    }
    const tLevel = this.getCodeLevel(target)
    // 对剩余的层级进行参照
    for (let i = level + 1; i <= tLevel; i++) {
      // a为列号，b为行号
      const [a, b] = this.getRowAndCol(this.getCodeAtLevel(target, i), i)
      c += separator
      // 如果符号为负，需要取字母
      if (lngSign === 1 || a === 0) {
        c += a
      } else {
        c += String.fromCharCode(64 + a).toUpperCase()
      }
      if (latSign === 1 || b === 0) {
        c += b
      } else {
        c += String.fromCharCode(64 + b).toUpperCase()
      }
    }
    return c
  }

  /**
   * 还原斗参考网格位置码
   * @param code 北斗参考网格位置码
   * @param separator 分隔符，默认是"-"
   * @returns 还原后的北斗参考网格位置码
   */
  static deRefer(code: string, separator = '-'): string {
    const split = code.split(separator)
    if (split.length === 1) {
      return code
    }
    // 参考位置网格等级
    const rLevel = this.getCodeLevel(split[0])
    // 目标位置网格等级
    const tLevel = rLevel + split.length - 2
    const [lngSign, latSign] = this.getSigns(this.getDirections(split[0]))

    // 获取编码的ascii码范围
    const ascii_0 = '0'.charCodeAt(0)
    const ascii_7 = '7'.charCodeAt(0)
    const ascii_A = 'A'.charCodeAt(0)
    const ascii_G = 'G'.charCodeAt(0)
    let result = ''
    for (let i = rLevel; i <= tLevel; i++) {
      let offsetX: number, offsetY: number
      const charX = split[1 + i - rLevel].charCodeAt(0)
      const charY = split[1 + i - rLevel].charCodeAt(1)
      // 计算经度方向偏移位置
      if (charX >= ascii_0 && charX <= ascii_7) {
        offsetX = (charX - ascii_0) * lngSign
      } else if (charX >= ascii_A && charX <= ascii_G) {
        offsetX = -((charX - ascii_A + 1) * lngSign)
      } else {
        throw new Error('参照码错误, 必须在0~7、A~G之间')
      }
      // 计算纬度方向偏移位置
      if (charY >= ascii_0 && charY <= ascii_7) {
        offsetY = (charY - ascii_0) * latSign
      } else if (charY >= ascii_A && charY <= ascii_G) {
        offsetY = -((charY - ascii_A + 1) * latSign)
      } else {
        throw new Error('参照码错误, 必须在0~7、A~G之间')
      }
      if (i === rLevel) {
        // 对level级进行还原
        result = this.getRelativeGrid(split[0], offsetX, offsetY)
      } else {
        result += this.encodeFragment(i, offsetX, offsetY)
      }
    }
    return result
  }

  /**
   * 缩短一个北斗二维网格编码
   * @param code 北斗二维网格编码
   * @param level 目标层级
   * @returns 缩短后的编码
   */
  static shorten(code: string, level: number): string {
    // level=0时只返回半球编号
    if (level < 0 || level > 10) {
      throw new Error('层级错误')
    }
    const nowLevel = this.getCodeLevel(code)
    if (nowLevel <= level) {
      return code
    }
    return code.substring(0, codeLengthAtLevel[level])
  }

  /**
   * 获取一个位置码的最大级别
   * @param code 位置码
   * @returns 级别
   */
  static getCodeLevel(code: string): number {
    const level = codeLengthAtLevel.indexOf(code.length)
    if (level === -1) {
      throw new Error('编码长度错误!')
    }
    return level
  }

  /**
   * 获取一个参照位置网格的可参照范围
   * @param code 参照位置网格编码，必须大于等于5级
   * @returns [LngLat, LngLat]，西南角和东北角坐标
   */
  static getReferRange(code: string): [LngLat, LngLat] {
    const level = this.getCodeLevel(code)
    if (level < 5) {
      throw new Error('参照网格编码必须大于等于5级')
    }
    const lngLat = this.decode(code, { form: 'dms' })
    const lngLatInSecond = this.getSecond(lngLat)
    let westBound: number
    let eastBound: number
    let northBound: number
    let southBound: number
    // 乘数因子为8的项需要减掉一个第十级网格大小，是因为边界上并不能参照
    if (lngLatInSecond[0] >= 0) {
      westBound = lngLatInSecond[0] - 7 * gridSizes1[level][0]
      eastBound = lngLatInSecond[0] + 8 * gridSizes1[level][0] - gridSizes1[10][0]
    } else {
      westBound = lngLatInSecond[0] - 8 * gridSizes1[level][0] + gridSizes1[10][0]
      eastBound = lngLatInSecond[0] + 7 * gridSizes1[level][0]
    }
    if (lngLatInSecond[1] >= 0) {
      southBound = lngLatInSecond[1] - 7 * gridSizes1[level][1]
      northBound = lngLatInSecond[1] + 8 * gridSizes1[level][1] - gridSizes1[10][1]
    } else {
      southBound = lngLatInSecond[1] - 8 * gridSizes1[level][1] + gridSizes1[10][1]
      northBound = lngLatInSecond[1] + 7 * gridSizes1[level][1]
    }
    return [
      { lngDegree: westBound / 3600, latDegree: southBound / 3600 },
      { lngDegree: eastBound / 3600, latDegree: northBound / 3600 }
    ]
  }

  /**
   * 获取一个网格相邻网格码，默认是周围九个(包括自己)
   * @param code 目标网格码
   * @param offsets 需要获取的网格码的偏移量(按照半球的坐标轴方向)
   * @returns string[]
   */
  static getNeighbors(
    code: string,
    offsets: [number, number][] = [
      [-1, -1],
      [-1, 0],
      [-1, 1],
      [0, -1],
      [0, 0],
      [0, 1],
      [1, -1],
      [1, 0],
      [1, 1]
    ]
  ): string[] {
    const neighbors: string[] = []
    for (let i = 0; i < offsets.length; i++) {
      neighbors.push(this.getRelativeGrid(code, offsets[i][0], offsets[i][1]))
    }
    return neighbors
  }

  /**
   * 同一级位于同一级别下的两个网格，获取之间的所有网格
   * @param start 起始网格
   * @param end 结束网格
   * @returns string[]所有网格
   */
  static getAmongUs(start: string, end: string): string[] {
    const levelStart = this.getCodeLevel(start)
    const levelEnd = this.getCodeLevel(end)
    if (levelStart !== levelEnd) {
      throw new Error('两个编码必须等级相同')
    }

    const results: string[] = []
    const [diffX, diffY] = this.getOffset(start, end)
    for (let i = 0; diffX >= 0 ? i <= diffX : i >= diffX; diffX >= 0 ? i++ : i--) {
      for (let j = 0; diffY >= 0 ? j <= diffY : j >= diffY; diffY >= 0 ? j++ : j--) {
        results.push(this.getRelativeGrid(start, i, j))
      }
    }
    return results
  }

  /**
   * 获取某一处网格的大致网格大小(只是估计值)
   * @param code 网格码
   * @param level 层级
   * @returns [lngLength, latLength]网格大小
   */
  static getGridSize(code: string, level: number) {
    code = this.shorten(code, level)
    const lngLat = this.decode(code)

    const cosLat = Math.cos((Math.abs(lngLat.latDegree) * Math.PI) / 180)
    const lngLength = (gridSizes1[level][0] / 3600) * 111.7 * cosLat
    const latLength = (gridSizes1[level][1] / 3600) * 111.7
    return [lngLength, latLength]
  }

  /**
   * 用于计算两个同级网格之间相差多少格，注意此方法不同于北斗参照网格码算法
   * @param reference 被参考位置网格码
   * @param target 目标位置网格码
   * @returns [lngDiff, latDiff]，经纬度方向分别偏差网格数量(按照半球的坐标轴方向)
   */
  static getOffset(reference: string, target: string): [number, number] {
    const level = this.getCodeLevel(reference)
    target = this.shorten(target, level)
    // 如果level-1层的网格相同，直接进行减法即可
    if (
      reference.substring(0, codeLengthAtLevel[level - 1]) ===
      target.substring(0, codeLengthAtLevel[level - 1])
    ) {
      const rRowCol = this.getRowAndCol(this.getCodeAtLevel(reference, level), level)
      const tRowCol = this.getRowAndCol(this.getCodeAtLevel(target, level), level)
      return [tRowCol[0] - rRowCol[0], tRowCol[1] - rRowCol[1]]
    } else {
      // 如果level-1层不同，为了计算简单，转为经纬度计算
      // 获取目标位置和参考位置的坐标(用度分秒保证计算误差)
      const tLngLat = this.decode(target, { form: 'dms' })
      const tInSecond = this.getSecond(tLngLat)
      const rLngLat = this.decode(reference, { form: 'dms' })
      const rInSecond = this.getSecond(rLngLat)
      // 获取半球信息
      const directions = this.getDirections(reference)
      const [lngSign, latSign] = this.getSigns(directions)
      // 乘上符号是为了变换到东北半球计算
      // 东北半球网格的原点在左下角(西南角)，对于参考坐标系的负方向(西、南)方向取整需要补1，所以直接使用Math.floor
      // 列差
      let lngDiff = ((tInSecond[0] - rInSecond[0]) / gridSizes1[level][0]) * lngSign
      lngDiff = Math.floor(lngDiff)
      // 行差
      let latDiff = ((tInSecond[1] - rInSecond[1]) / gridSizes1[level][1]) * latSign
      latDiff = Math.floor(latDiff)
      return [lngDiff, latDiff]
    }
  }

  /**
   *
   * @param code 被参考的网格码
   * @param offsetX 经度方向偏移格数(按照半球的坐标轴方向)
   * @param offsetY 纬度方向偏移格数(按照半球的坐标轴方向)
   * @returns 相对位置的网格码
   */
  static getRelativeGrid(code: string, offsetX: number, offsetY: number): string {
    const level = this.getCodeLevel(code)
    const rowCol = this.getRowAndCol(this.getCodeAtLevel(code, level), level)
    const newX = rowCol[0] + offsetX
    const newY = rowCol[1] + offsetY
    if (newX >= 0 && newX < gridCount1[level][0] && newY >= 0 && newY < gridCount1[level][1]) {
      // 如果两个网格的上一层网格相同可以直接相加得到结果
      return (
        code.substring(0, codeLengthAtLevel[level - 1]) + this.encodeFragment(level, newX, newY)
      )
    } else {
      // 上一层网格不相同，采用经纬度计算
      // 采用度分秒可以避免计算误差
      const lngLat = this.decode(code, { form: 'dms' })
      // 半球符号lngSign与latSign各自约去(平方为1)
      lngLat.lngSecond! += offsetX * gridSizes1[level][0]
      lngLat.latSecond! += offsetY * gridSizes1[level][1]
      return this.encode(lngLat, level)
    }
  }

  /**
   * 获取某一级别的代码片段
   * @param code 位置码
   * @param level 级别
   * @returns 该级别的位置码片段
   */
  private static getCodeAtLevel(code: string, level: number) {
    if (level === 0) {
      return code.charAt(0)
    }
    return code.substring(codeLengthAtLevel[level - 1], codeLengthAtLevel[level])
  }

  /**
   * 获取某一级别的网格的行列号
   * @param codeFragment 某级别位置码片段
   * @param level 级别
   * @returns [lng, lat] => [列号, 行号]
   */
  private static getRowAndCol(codeFragment: string, level: number): [number, number] {
    if (codeFragment.length !== codeLengthAtLevel[level] - codeLengthAtLevel[level - 1]) {
      throw new Error('编码片段长度错误!')
    }
    let lng: number
    let lat: number
    switch (level) {
      case 0:
        return [0, 0]
      case 1:
        lng = Number(codeFragment.substring(0, 2))
        lat = codeFragment.charCodeAt(2) - 65
        break
      case 2:
      case 4:
      case 5:
      case 7:
      case 8:
      case 9:
      case 10:
        lng = parseInt(codeFragment.charAt(0), 16)
        lat = parseInt(codeFragment.charAt(1), 16)
        break
      case 3:
      case 6: {
        const n = Number(codeFragment)
        lng = n % 2
        lat = (n - lng) / 2
        break
      }
      default:
        throw new Error('层级错误!')
    }
    this.checkCodeFragmentRange(lng, lat, level)
    return [lng, lat]
  }

  /**
   * 检查第level级代码片段范围是否合法
   * @param lng 列号
   * @param lat 行号
   * @param level 级别
   */
  private static checkCodeFragmentRange(lng: number, lat: number, level: number) {
    if (level === 1) {
      if (lng > gridCount1[level][0] || lng < 1 || lat < 0 || lat > gridCount1[level][1] - 1) {
        throw new Error('位置码错误')
      }
    } else if (
      lng > gridCount1[level][0] - 1 ||
      lng < 0 ||
      lat < 0 ||
      lat > gridCount1[level][1] - 1
    ) {
      throw new Error('位置码错误')
    }
  }

  /**
   * 获取位置码的半球信息：东南、东北、西南、西北
   * @param code 位置码
   * @returns [lngDir, latDir] => [经度方向, 纬度方向]
   */
  private static getDirections(code: string): [LngDirection, LatDirection] {
    const latDir = code.charAt(0) === 'N' ? 'N' : 'S'
    const lngDir = Number(code.substring(1, 3)) >= 31 ? 'E' : 'W'
    return [lngDir, latDir]
  }

  private static getSigns(directions: [LngDirection, LatDirection]) {
    return [directions[0] === 'E' ? 1 : -1, directions[1] === 'N' ? 1 : -1]
  }

  private static getSecond(lngLat: LngLat): [number, number] {
    // 检查经度相关的参数是否有效
    if (!lngLat.lngDegree || isNaN(lngLat.lngDegree)) {
      throw new Error('Invalid longitude values')
    }

    // 检查纬度相关的参数是否有效
    if (!lngLat.latDegree || isNaN(lngLat.latDegree)) {
      throw new Error('Invalid latitude values')
    }
    // 计算经度，换算成秒
    const lngInSec =
      (lngLat.lngDegree * 3600 + (lngLat.lngMinute ??= 0) * 60 + (lngLat.lngSecond ??= 0)) *
      ((lngLat.lngDirection ?? 'E') === 'W' ? -1 : 1)
    // 计算纬度，换算成秒
    const latInSec =
      (lngLat.latDegree * 3600 + (lngLat.latMinute ??= 0) * 60 + (lngLat.latSecond ??= 0)) *
      ((lngLat.latDirection ?? 'N') === 'S' ? -1 : 1)
    return [lngInSec, latInSec]
  }
}

export default Codec2D
