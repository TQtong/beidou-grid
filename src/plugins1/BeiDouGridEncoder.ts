import { Decimal } from 'decimal.js';

import BeiDouGeoPoint from './BeiDouGeoPoint';
import BeiDouGridConstants from './BeiDouGridConstants';
import BeiDouGridCommonUtils from './BeiDouGridCommonUtils';
import StringBuilder from './StringBuilder';

/**
 * 北斗网格码编码器
 * 负责所有编码相关的逻辑
 */
export default class BeiDouGridEncoder {

    // 缓存编码映射表，避免重复创建
    private static  LEVEL3_ENCODING_MAP_CACHE = new Map<string, number[][]>();
    private static  LEVEL6_ENCODING_MAP_CACHE = new Map<string, number[][]>();

    /**
     * 对一个经纬度坐标进行二维编码
     *
     * @param point 经纬度坐标，使用小数形式（正负号表示方向）
     * @param level 要编码到第几级，范围1-10
     * @return 北斗二维网格位置码
     */
    public static encode2D( point:BeiDouGeoPoint, level:number) {
        this.validateEncodeParameters(point, level);

        // 记录第n级网格的定位角点经纬度
        let baseLng = new Decimal(0);
        let baseLat = new Decimal(0);

        // 获取半球信息，用于网格码方向转换
        let hemisphere = BeiDouGridCommonUtils.getHemisphere(point);

        // 存储结果，以半球纬度方向开头
      let resCode = new StringBuilder();
      resCode.append(hemisphere.charAt(0));

        let latitude =  new Decimal(point.getLatitude());
        let longitude = new Decimal(point.getLongitude());

        // 南北极北斗二维网格位置码特殊处理
        if (latitude.abs().comparedTo(new Decimal("88")) >= 0) {
            console.warn("极地区域编码尚未实现");
            throw new Error("极地区域编码尚未实现");
        }

        // 逐级编码
        for (let i = 1; i <= level; i++) {
            // 获取当前层级的网格精度
            let lngSize = BeiDouGridConstants.GRID_SIZES_DEGREES[i as keyof typeof BeiDouGridConstants.GRID_SIZES_DEGREES][0]!;
            let latSize = BeiDouGridConstants.GRID_SIZES_DEGREES[i as keyof typeof BeiDouGridConstants.GRID_SIZES_DEGREES][1]!;

            // 计算经纬度坐标在当前层级的网格索引
            let lngDiff = longitude.sub(baseLng);
            let lngP = lngDiff.div(lngSize).floor().toNumber();

            let latDiff = latitude.abs().sub(baseLat);
            let latP = latDiff.div(latSize).floor().toNumber();

            if (i == 1) {
                // 第一级特殊处理
                if (lngP < 0) {
                    baseLng = baseLng.add(new Decimal(-lngP - 1).mul(lngSize));
                } else {
                    baseLng = baseLng.add(new Decimal(lngP).mul(lngSize));
                }
                baseLat = baseLat.add(new Decimal(latP).mul(latSize));

                resCode.append(this.encodeFragment(i, lngP + 31, latP, hemisphere));

                // 从第二级开始使用绝对值
                latitude = latitude.abs();
                longitude = longitude.abs();
            } else {
                // 更新基准点坐标
                baseLng = baseLng.add(new Decimal(lngP).mul(lngSize));
                baseLat = baseLat.add(new Decimal(latP).mul(latSize));
                resCode.append(this.encodeFragment(i, lngP, latP, hemisphere));
            }
        }

        return resCode.toString();
    }

    /**
     * 对一个经纬度坐标和高度进行三维编码（高度部分）
     *
     * @param height 高度（单位：米）
     * @param level    要编码到第几级
     * @return 北斗三维网格位置码的高度部分
     */
    public static  encode3DHeight( height:number, level:number) {
        if (level == null || level < 1 || level > 10) {
            throw new Error("编码级别必须在1-10之间");
        }

        // 计算高度编码的数学参数
        let theta = Math.PI / 180 / 60 / 60 / 2048;  // theta = π/180/3600/2048
        let theta0 = Math.PI / 180;                  // theta0 = π/180

        // 计算高度编码的值
        let n = Math.floor(
                (theta0 / theta) *
                        (Math.log((height + BeiDouGridConstants.EARTH_RADIUS) / BeiDouGridConstants.EARTH_RADIUS) / Math.log(1 + theta0))
        );

        // 确定高度方向编码（0表示正，1表示负）
        let signCode = n < 0 ? "1" : "0";
        n = Math.abs(n);

        // 将高度编码转换为32位二进制字符串
        let binaryString = this.buildBinaryString(n, signCode);

        // 构建高度编码结果
        return this.buildHeightCode(binaryString, level, signCode);
    }

    /**
     * 对一个经纬度坐标和高度进行三维编码（完整三维编码）
     *
     * @param point    经纬高度坐标
     * @param level    要编码到第几级
     * @return 北斗三维网格位置码
     */
    public static  encode3D( point:BeiDouGeoPoint, level:number) {
        this.validateEncodeParameters(point, level);

        // 计算高度编码的数学参数
        let theta = Math.PI / 180 / 60 / 60 / 2048;  // theta = π/180/3600/2048
        let theta0 = Math.PI / 180;                  // theta0 = π/180

        // 计算高度编码的值
        let n = Math.floor(
                (theta0 / theta) *
                        (Math.log((point.getHeight() + BeiDouGridConstants.EARTH_RADIUS) / BeiDouGridConstants.EARTH_RADIUS) / Math.log(1 + theta0))
        );

        // 确定高度方向编码（0表示正，1表示负）
        let signCode = n < 0 ? "1" : "0";
        n = Math.abs(n);

        // 将高度编码转换为32位二进制字符串
        let binaryString = new StringBuilder();
        binaryString.append(signCode); // 高度方向位

        // 生成31位二进制表示
        for (let i = 30; i >= 0; i--) {
            binaryString.append(((n >> i) & 1).toString());
        }

        // 获取纬度方向
        let latDirection = point.getLatitude() >= 0 ? "N" : "S";

        // 构建结果
        let result = new StringBuilder();
        result.append(latDirection); // 纬度方向位
        result.append(signCode); // 高度方向位

        let longitude = point.getLongitude();
        let latitude = Math.abs(point.getLatitude()); // 使用纬度绝对值

        // 转换为秒
        let lngInSec = longitude * 3600;
        let latInSec = latitude * 3600;

        let lngOffset = 0;
        let latOffset = 0;
        let binaryIndex = 1; // 跳过高度方向位

        // 逐级编码
        for (let i = 1; i <= level; i++) {
            let fragment2D;

            if (i == 1) {
                // 第一级特殊处理
                let lngIndex = Math.floor(lngInSec / BeiDouGridConstants.GRID_SIZES_SECONDS[i as keyof typeof BeiDouGridConstants.GRID_SIZES_SECONDS][0]!);
                let latIndex = Math.floor(latInSec / BeiDouGridConstants.GRID_SIZES_SECONDS[i][1]!);

                // 更新偏移量
                lngOffset = (lngIndex >= 0 ? lngIndex : -lngIndex - 1) * BeiDouGridConstants.GRID_SIZES_SECONDS[i as keyof typeof BeiDouGridConstants.GRID_SIZES_SECONDS][0]!;
                latOffset = latIndex * BeiDouGridConstants.GRID_SIZES_SECONDS[i as keyof typeof BeiDouGridConstants.GRID_SIZES_SECONDS][1]!;

                // 生成二维编码片段
                fragment2D = this.encodeFragment(i, lngIndex + 31, latIndex, BeiDouGridCommonUtils.getHemisphere(point));
            } else {
                // 其他级别
                let lngIndex = Math.floor((Math.abs(lngInSec) - lngOffset) / BeiDouGridConstants.GRID_SIZES_SECONDS[i as keyof typeof BeiDouGridConstants.GRID_SIZES_SECONDS][0]!);
                let latIndex = Math.floor((Math.abs(latInSec) - latOffset) / BeiDouGridConstants.GRID_SIZES_SECONDS[i as keyof typeof BeiDouGridConstants.GRID_SIZES_SECONDS][1]!);

                // 更新偏移量
                lngOffset += lngIndex * BeiDouGridConstants.GRID_SIZES_SECONDS[i as keyof typeof BeiDouGridConstants.GRID_SIZES_SECONDS][0]!;
                latOffset += latIndex * BeiDouGridConstants.GRID_SIZES_SECONDS[i as keyof typeof BeiDouGridConstants.GRID_SIZES_SECONDS][1]!;

                // 生成二维编码片段
                fragment2D = this.encodeFragment(i, lngIndex, latIndex, BeiDouGridCommonUtils.getHemisphere(point));
            }

            // 添加二维编码片段
            result.append(fragment2D);

            // 添加高度编码片段
            let bits = BeiDouGridConstants.ELEVATION_ENCODING[i as keyof typeof BeiDouGridConstants.ELEVATION_ENCODING][0]!;
            let radix = BeiDouGridConstants.ELEVATION_ENCODING[i as keyof typeof BeiDouGridConstants.ELEVATION_ENCODING][1]!;

            // 从二进制字符串中提取对应位数
            let elevationFragment = binaryString.subString(binaryIndex, binaryIndex + bits);
            let codeI = parseInt(elevationFragment, 2);

            // 转换为对应进制的字符串
            let codeStr = codeI.toString(radix).toUpperCase();

            // 第一级需要补零至2位
            if (i == 1) {
                codeStr = codeStr.padStart(2, '0');
            }

            result.append(codeStr);
            binaryIndex += bits;
        }

        return result.toString();
    }

    /**
     * 验证编码参数
     */
    private static validateEncodeParameters( point:BeiDouGeoPoint, level:number) {
        if (point == null) {
            throw new Error("坐标点不能为空");
        }

        if (level == null || level < 1 || level > 10) {
            throw new Error("编码级别必须在1-10之间");
        }
    }

    /**
     * 生成指定层级的编码片段
     */
  private static encodeFragment(level: number, lngCount: number, latCount: number, hemisphere: string) {
      switch (level) {
        case 1:
          return this.encodeLevel1(lngCount, latCount);
        case 2:
          return this.encodeLevel2(lngCount, latCount, hemisphere);
        case 3:
          return this.encodeLevel3(lngCount, latCount, hemisphere);
        case 4:
        case 5:
          return this.encodeLevel4_5(lngCount, latCount, hemisphere);
        case 6:
          return this.encodeLevel6(lngCount, latCount, hemisphere);
        case 7:
        case 8:
        case 9:
        case 10:
          return this.encodeLevel7_10(lngCount, latCount, hemisphere);
        default:
          throw new Error("非法层级level: " + level);
      }
    }


    /**
     * 一级网格编码（标准图2）
     */
    private static encodeLevel1(lngCount:number, latCount:number) {
        return lngCount.toString().padStart(2, '0') + String.fromCharCode(65 + latCount);
    }

    /**
     * 二级网格编码（标准图3）
     */
    private static encodeLevel2(lngCount:number, latCount:number, hemisphere:string) {
        let adjusted = this.adjustCounts(lngCount, latCount, hemisphere, 11, 7);
        return this.toHexPair(adjusted[0]!, adjusted[1]!);
    }

    /**
     * 三级网格Z序编码（标准图4）
     */
    private static encodeLevel3(lngCount:number, latCount:number, hemisphere:string) {
        let encodingMap = this.getLevel3EncodingMap(hemisphere);
        return encodingMap[latCount]![lngCount]!.toString();
    }

    /**
     * 四级/五级网格编码（标准图5、6）
     */
    private static encodeLevel4_5(lngCount:number, latCount:number, hemisphere:string) {
        let adjusted = this.adjustCounts(lngCount, latCount, hemisphere, 14, 14);
        return this.toHexPair(adjusted[0]!, adjusted[1]!);
    }

    /**
     * 六级网格Z序编码（标准图7）
     */
    private static encodeLevel6(lngCount:number, latCount:number, hemisphere:string) {
        let encodingMap = this.getLevel6EncodingMap(hemisphere);
        return encodingMap[latCount]![lngCount]!.toString();
    }

    /**
     * 七到十级网格编码（标准图8）
     */
    private static encodeLevel7_10(lngCount:number, latCount:number, hemisphere:string) {
        let adjusted = this.adjustCounts(lngCount, latCount, hemisphere, 7, 7);
        return this.toHexPair(adjusted[0]!, adjusted[1]!);
    }

    /**
     * 方向调整通用方法
     * 根据半球信息调整经纬度网格索引
     */
  private static adjustCounts(lng: number, lat: number, hemisphere: string, maxLng: number, maxLat: number) {
      switch (hemisphere) {
        case "NW":
          return [lng, maxLat - lat]; // 经度递增，纬度递减
        case "NE":
          return [lng, lat]; // 双递增
        case "SW":
          return [maxLng - lng, maxLat - lat]; // 双递减
        case "SE":
          return [maxLng - lng, lat]; // 经度递减，纬度递增
        default:
          return [lng, lat]; // 默认NE规则
      }
    }

    /**
     * 获取三级网格编码映射表
     * 使用缓存避免重复创建
     */
  private static getLevel3EncodingMap(hemisphere: string) {
    
    if (!this.LEVEL3_ENCODING_MAP_CACHE.has(hemisphere)) {
      let mapping: number[][]
      switch (hemisphere) {
        case "NW":
          mapping = [[1, 0], [3, 2], [5, 4]];
          break
        case "NE":
          mapping = [[0, 1], [2, 3], [4, 5]];
          break
        case "SW":
          mapping = [[5, 4], [3, 2], [1, 0]];
          break
        case "SE":
          mapping = [[4, 5], [2, 3], [0, 1]];
          break
        default:
          mapping = [[0, 1], [2, 3], [4, 5]]; // 默认东北半球
          break
      }
      this.LEVEL3_ENCODING_MAP_CACHE.set(hemisphere, mapping);
    }
    const result = this.LEVEL3_ENCODING_MAP_CACHE.get(hemisphere)!;
    return result;
    }


    /**
     * 获取六级网格编码映射表
     * 使用缓存避免重复创建
     */
    private static getLevel6EncodingMap(hemisphere:string) {
      if (!this.LEVEL6_ENCODING_MAP_CACHE.has(hemisphere)) {
        let mapping: number[][]
        switch (hemisphere) {
          case "NW":
            mapping = [[1, 0], [3, 2]];
            break
          case "NE":
            mapping = [[0, 1], [2, 3]];
            break
          case "SW":
            mapping = [[3, 2], [1, 0]];
            break
          case "SE":
            mapping = [[2, 3], [0, 1]];
            break
          default:
            mapping = [[0, 1], [2, 3]]; // 默认东北半球
            break
        }
        this.LEVEL6_ENCODING_MAP_CACHE.set(hemisphere, mapping);
      }
      const result = this.LEVEL6_ENCODING_MAP_CACHE.get(hemisphere)!;
      return result;
    }

    /**
     * 转换为十六进制对（如 3,A）
     */
    private static toHexPair(lng:number, lat:number) {
        return lng.toString(16).toUpperCase() +
                lat.toString(16).toUpperCase();
    }

    /**
     * 构建二进制字符串
     */
    private static buildBinaryString(n:number, signCode:string) {
        let binaryString = new StringBuilder();
        binaryString.append(signCode); // 高度方向位
debugger
        // 生成31位二进制表示
        for (let i = 30; i >= 0; i--) {
            binaryString.append(((n >> i) & 1).toString());
        }
        return binaryString;
    }

    /**
     * 构建高度编码
     */
  private static buildHeightCode(binaryString: StringBuilder, level: number, signCode: string) {
      debugger
        let heightCode = new StringBuilder();
        heightCode.append(signCode); // 高度方向位

        let binaryIndex = 1; // 跳过高度方向位

        // 根据各级网格的高度编码位数和基数，生成各级高度编码
        for (let i = 1; i <= level; i++) {
            let bits = BeiDouGridConstants.ELEVATION_ENCODING[i as keyof typeof BeiDouGridConstants.ELEVATION_ENCODING][0]!;
            let radix = BeiDouGridConstants.ELEVATION_ENCODING[i as keyof typeof BeiDouGridConstants.ELEVATION_ENCODING][1]!;

            // 从二进制字符串中提取对应位数
            let elevationFragment = binaryString.subString(binaryIndex, binaryIndex + bits);
            let codeI = parseInt(elevationFragment, 2);

            // 转换为对应进制的字符串
            let codeStr = codeI.toString(radix).toUpperCase();

            // 第一级需要补零至2位
            if (i == 1) {
                codeStr = codeStr.padStart(2, '0');
            }

            heightCode.append(codeStr);
            binaryIndex += bits;
        }

        return heightCode.toString();
    }
}
