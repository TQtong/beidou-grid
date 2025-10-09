import moment from 'moment';

import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory'
import Geometry from 'jsts/org/locationtech/jts/geom/Geometry'
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope'
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate'
import LineString from 'jsts/org/locationtech/jts/geom/LineString'
import Polygon from 'jsts/org/locationtech/jts/geom/Polygon'
import GeoJsonWriter from 'jsts/org/locationtech/jts/io/GeoJsonWriter'
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp'
import Point from 'jsts/org/locationtech/jts/geom/Point'

import BeiDouGridConstants from './BeiDouGridConstants';
import BeiDouGridEncoder from './BeiDouGridEncoder';
import BeiDouGeoPoint from './BeiDouGeoPoint';
import BeiDouGridDecoder from './BeiDouGridDecoder';

/**
 * 北斗二维网格范围查询工具类
 * 根据几何图形（多边形或线）生成包含的北斗网格码集合
 */
export default class BeiDouGrid2DRangeQuery {

    private static GEOMETRY_FACTORY = new GeometryFactory();

    /**
     * 主方法：根据几何图形查找相交的二维网格码
     *
     * @param geom        几何图形对象，支持多边形、线、点等JTS几何类型
     * @param targetLevel 目标网格级别，范围1-10
     * @return 与几何图形相交的所有指定级别网格码集合
     * @throws IllegalArgumentException 如果几何图形为空或目标级别不在 1-10 范围内
     */
    public static find2DGridCodesInRange( geom: Geometry, targetLevel: number) {
      const startTime = moment();
        this.validateParameters(geom, targetLevel);

        const result = new Set<string>();

        const envelope = geom.getEnvelopeInternal();
        const minLng = envelope.getMinX();
        const maxLng = envelope.getMaxX();
        const minLat = envelope.getMinY();
        const maxLat = envelope.getMaxY();

        // 获取目标层级的网格尺寸
        const gridSize = BeiDouGridConstants.GRID_SIZES_DEGREES[targetLevel as keyof typeof BeiDouGridConstants.GRID_SIZES_DEGREES];
        const lngSize = gridSize[0]!.toNumber();
        const latSize = gridSize[1]!.toNumber();

        // 生成候选网格
        for (let lng = minLng; lng <= maxLng + lngSize; lng += lngSize) {
            for (let lat = minLat; lat <= maxLat + latSize; lat += latSize) {

                // 生成网格编码
                const gridCode = BeiDouGridEncoder.encode2D(
                        new BeiDouGeoPoint(lng, lat, 0), targetLevel
                );

                // 检查网格是否与几何图形相交
                if (this.isGridIntersectsMath(gridCode, geom, envelope)) {
                    result.add(gridCode);
                }
            }
        }

        const totalTime = moment().diff(startTime, 'ms');
        console.log("总计算完成：找到 {} 个{}级网格，总耗时 {}ms", result.size, targetLevel, totalTime);


        return result;
    }

    /**
     * 主方法：根据几何图形查找相交的二维网格码(已过时，请参考find2DGridCodesInRange)
     *
     * @param geom        几何图形对象，支持多边形、线、点等JTS几何类型
     * @param targetLevel 目标网格级别，范围1-10
     * @return 与几何图形相交的所有指定级别网格码集合
     * @throws IllegalArgumentException 如果几何图形为空或目标级别不在 1-10 范围内
     */
    public static findGridCodesInRange( geom:Geometry, targetLevel: number) {
        const startTime = moment();
        this.validateParameters(geom, targetLevel);

        const result = new Set<string>();

        // 1. 快速筛选一级网格
        const level1Grids = this.findIntersectingLevel1Grids(geom);

        console.log("一级网格筛选完成，找到 {} 个网格，耗时 {}ms",
                level1Grids.size, moment().diff(startTime, 'ms'));


        // 2. 对每个相交的一级网格进行递归细化
        level1Grids.forEach(level1Grid => this.refineGrid(level1Grid, geom, targetLevel, 1, result));

        const totalTime = moment().diff(startTime, 'ms');
        console.log("总计算完成：找到 " + result.size + " 个" + targetLevel + "级网格，总耗时 " + totalTime + "ms");

        return result;
    }

    /**
     * 一级网格快速筛选
     */
    private static findIntersectingLevel1Grids( geom:Geometry) {
        // 1. 计算几何图形的边界范围
        const envelope = geom.getEnvelopeInternal();
        const minLng = envelope.getMinX();
        const maxLng = envelope.getMaxX();
        const minLat = envelope.getMinY();
        const maxLat = envelope.getMaxY();

        // 2. 计算一级网格索引范围（一级网格尺寸：6°×4°）
        const minLngIdx =  Math.floor(minLng / 6.0);
        const maxLngIdx =  Math.floor(maxLng / 6.0);
        const minLatIdx =  Math.floor(minLat / 4.0);
        const maxLatIdx =  Math.floor(maxLat / 4.0);

        // 3. 生成候选一级网格码
        const candidateGrids = new Set<string>();
        for (let lngIdx = minLngIdx; lngIdx <= maxLngIdx; lngIdx++) {
            for (let latIdx = minLatIdx; latIdx <= maxLatIdx; latIdx++) {
                const gridCode = BeiDouGrid2DRangeQuery.generateLevel1GridCode(lngIdx, latIdx);
                candidateGrids.add(gridCode);
            }
        }

        // 4. 精确筛选：判断几何图形是否与网格相交
        const intersectingGrids = new Set<string>();
        for (const gridCode of candidateGrids) {
            const gridPolygon = BeiDouGrid2DRangeQuery.createGridPolygon(gridCode);
            if (OverlayOp.intersection(geom, gridPolygon)) {
                intersectingGrids.add(gridCode);
            }
        }

        return intersectingGrids;
    }

    /**
     * 递归细化网格（使用数学计算优化）
     */
    private static refineGrid( parentGrid: string, geom: Geometry, targetLevel: number,
                                   currentLevel: number, result: Set<string>) {
        if (currentLevel == targetLevel) {
            result.add(parentGrid);
            return;
        }
        const startTime = moment();

        // 提前计算几何图形的边界框，避免重复计算
        const geomEnvelope = geom.getEnvelopeInternal();

        // 生成当前层级网格的所有子网格
        const childGrids = BeiDouGrid2DRangeQuery.generateChildGrids2D(parentGrid);

        const generateTime = moment().diff(startTime, 'ms');

        let intersectCount = 0;

        for (const childGrid of childGrids) {
            // 使用纯数学方法判断相交
            if (BeiDouGrid2DRangeQuery.isGridIntersectsMath(childGrid, geom, geomEnvelope)) {
                intersectCount++;
                BeiDouGrid2DRangeQuery.refineGrid(childGrid, geom, targetLevel, currentLevel + 1, result);
            }
        }

        const totalTime = moment().diff(startTime, 'ms');
        if (currentLevel <= 3) { // 只记录低层级的详细日志
            console.log("层级 {} 网格 {}: 生成 {} 子网格，{} 个相交，耗时 {}ms (生成: {}ms)",
                    currentLevel, parentGrid, childGrids.size, intersectCount,
                    totalTime, generateTime);
        }
    }

    /**
     * 生成一级网格码
     */
    private static generateLevel1GridCode(lngIdx: number, latIdx: number) {
        // 一级网格码格式：N + 经度索引(2位) + 纬度字母(A-V)
        const lngPart = (lngIdx + 31).toString().padStart(2, '0'); // 经度索引从31开始
        const latChar = String.fromCharCode(65 + latIdx); // 纬度字母从A开始

        return "N" + lngPart + latChar;
    }

    /**
     * 根据网格码创建对应的多边形几何
     *
     * @param gridCode 北斗网格码
     * @return 对应网格的多边形几何对象
     * @throws IllegalArgumentException 如果网格码格式无效
     */
    public static createGridPolygon(gridCode: string) {
        // 1. 解码获取西南角坐标（注意：解码器返回的是网格的西南角点，不是中心点）
        const swCorner = BeiDouGridDecoder.decode2D(gridCode);

        // 2. 获取网格级别
        const level = BeiDouGrid2DRangeQuery.getGridLevel(gridCode);

        // 3. 计算网格尺寸（根据级别）
        const gridSize = BeiDouGridConstants.GRID_SIZES_DEGREES[level as keyof typeof BeiDouGridConstants.GRID_SIZES_DEGREES];
        const lngSize = gridSize[0]!.toNumber();
        const latSize = gridSize[1]!.toNumber();

        // 4. 计算四个角点坐标（从西南角开始，顺时针方向）
        const sw = new Coordinate(swCorner.getLongitude(), swCorner.getLatitude());
        const se = new Coordinate(swCorner.getLongitude() + lngSize, swCorner.getLatitude());
        const ne = new Coordinate(swCorner.getLongitude() + lngSize, swCorner.getLatitude() + latSize);
        const nw = new Coordinate(swCorner.getLongitude(), swCorner.getLatitude() + latSize);

        // 5. 创建多边形（闭合环）
        const polygon = BeiDouGrid2DRangeQuery.GEOMETRY_FACTORY.createPolygon([sw, se, ne, nw, sw]);
        console.log("根据{}网格码创建对应的多边形几何{}", gridCode, new GeoJsonWriter().write(polygon));
        return polygon;
    }

    /**
     * 生成指定2维父网格的所有2维子网格集合
     *
     * @param parentGrid 父网格编码，自动识别其级别（格式示例：N50J475）
     *                   - 必须为有效的北斗二维网格码
     *                   - 编码级别需小于10（最高级网格无子网格）
     *                   - 1级网格的子网格为2级，依此类推
     * @return 子网格集合（可能为空集合）
     * - 每个子网格的级别为 parentGrid的级别 + 1
     * - 集合无序但保证唯一性
     * @throws IllegalArgumentException 如果参数不合法：
     *                                  - parentGrid格式无效
     *                                  - parentGrid层级超出1-9范围
     * @see BeiDouGridDecoder#decode2D 网格解码实现
     * @see BeiDouGridConstants#GRID_DIVISIONS 各级网格划分规则
     * @see BeiDouGridConstants#GRID_SIZES_DEGREES 各级网格尺寸定义
     */
    public static generateChildGrids2D(parentGrid: string) {
        const startTime = moment();
        // 当前二维网格码层级
        const currentLevel = BeiDouGridDecoder.getCodeLevel2D(parentGrid);

        if (currentLevel < 1 || currentLevel >= 10) {
            throw new Error("只能生成1-9级网格的子网格");
        }

        const childGrids = new Set<string>();

        // 解码父网格获取西南角点（注意：解码器返回的是网格的西南角点，不是中心点）
        const parentSWCorner = BeiDouGridDecoder.decode2D(parentGrid);

        // 获取子网格的划分数量
        const divisions = BeiDouGridConstants.GRID_DIVISIONS[(currentLevel + 1) as keyof typeof BeiDouGridConstants.GRID_DIVISIONS];
        const lngDivisions = divisions[0];
        const latDivisions = divisions[1];

        // 获取子网格尺寸
        const childSize = BeiDouGridConstants.GRID_SIZES_DEGREES[(currentLevel + 1) as keyof typeof BeiDouGridConstants.GRID_SIZES_DEGREES];
        const lngSize = childSize[0]!.toNumber();
        const latSize = childSize[1]!.toNumber();

        // 生成所有子网格的西南角点并计算中心点进行编码
        for (let i = 0; i < lngDivisions!; i++) {
            for (let j = 0; j < latDivisions!; j++) {
                // 计算子网格的西南角点
                const childSWLng = parentSWCorner.getLongitude() + i * lngSize;
                const childSWLat = parentSWCorner.getLatitude() + j * latSize;

                // 计算子网格的中心点（用于编码）
                const childLng = childSWLng + lngSize / 2;
                const childLat = childSWLat + latSize / 2;

                const childGrid = BeiDouGridEncoder.encode2D(
                        new BeiDouGeoPoint(childLng, childLat, 0), currentLevel + 1);
                childGrids.add(childGrid);
            }
        }
        const time = moment().diff(startTime, 'ms');
        if (time > 10) { // 只记录耗时较长的操作
            console.log("生成层级 {} 网格 {} 的 {} 个子网格，耗时 {}ms",
                    currentLevel, parentGrid, childGrids.size, time);
        }
        return childGrids;
    }

    /**
     * 获取指定层级的网格宽度（经度方向尺寸）
     */
    private static getGridWidth(level: number) {
        if (level < 1 || level > 10) {
              throw new Error("层级必须在1-10之间");
      }
      
      const gridSize = BeiDouGridConstants.GRID_SIZES_DEGREES[level as keyof typeof BeiDouGridConstants.GRID_SIZES_DEGREES];

        return gridSize[0]!.toNumber();
    }

    /**
     * 获取指定层级的网格高度（纬度方向尺寸）
     */
    private static getGridHeight(level: number) {
        if (level < 1 || level > 10) {
            throw new Error("层级必须在1-10之间");
        }
        return BeiDouGridConstants.GRID_SIZES_DEGREES[level as keyof typeof BeiDouGridConstants.GRID_SIZES_DEGREES][1]!.toNumber();
    }

    /**
     * 根据网格码获取层级
     */
    private static getGridLevel(gridCode: string) {
        // 根据网格码长度判断层级
        const length = gridCode.length;
        for (let i = 1; i <= 10; i++) {
            if (length == BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[i]) {
                return i;
            }
        }
        throw new Error("无效的网格码格式: " + gridCode);
    }

    /**
     * 参数验证
     */
    private static  validateParameters( geom: Geometry, targetLevel: number) {
        if (geom == null) {
            throw new Error("几何图形不能为空");
        }
        if (targetLevel < 1 || targetLevel > 10) {
            throw new Error("目标层级必须在1-10之间");
        }
    }

    /**
     * 纯数学方法判断网格与几何图形是否相交（避免JTS几何计算）
     *
     * @param gridCode     北斗网格编码
     * @param geom         待检测的几何图形（点/线/面）
     * @param geomEnvelope 几何图形的外包矩形（用于快速预判）
     * @return 是否相交
     */
    public static isGridIntersectsMath(gridCode: string, geom: Geometry, geomEnvelope: Envelope) {
        // 1. 网格解码并记录耗时
        const decodeStart = moment();
        const swCorner = BeiDouGridDecoder.decode2D(gridCode);
        const decodeTime = moment().diff(decodeStart, 'ms');
        if (decodeTime > 100000) { // 超过100μs的记录
            console.log("网格解码 {} 耗时: {}μs", gridCode, decodeTime / 1000);
        }

        // 2. 获取网格级别和宽高
        const level = BeiDouGrid2DRangeQuery.getGridLevel(gridCode);
        const gridWidth = BeiDouGrid2DRangeQuery.getGridWidth(level);
        const gridHeight = BeiDouGrid2DRangeQuery.getGridHeight(level);

        // 3. 计算网格的经纬度边界
        const rectMinX = swCorner.getLongitude();
        const rectMaxX = rectMinX + gridWidth;
        const rectMinY = swCorner.getLatitude();
        const rectMaxY = rectMinY + gridHeight;

        // 4. 快速边界框检查（快速排除不相交的情况）
        if (rectMaxX < geomEnvelope.getMinX() || rectMinX > geomEnvelope.getMaxX() ||
                rectMaxY < geomEnvelope.getMinY() || rectMinY > geomEnvelope.getMaxY()) {
            return false;
        }

        // 5. 根据几何类型分别判断
        switch (geom.getClass().name) {
            case "Point":
                return BeiDouGrid2DRangeQuery.isPointInRectangleMath(geom as unknown as Point, rectMinX, rectMaxX, rectMinY, rectMaxY);
            case "LineString":
                return BeiDouGrid2DRangeQuery.isLineIntersectsRectangleMath(geom as unknown as LineString, rectMinX, rectMaxX, rectMinY, rectMaxY);
            case "Polygon":
                return BeiDouGrid2DRangeQuery.isPolygonIntersectsRectangleMath(geom as unknown as Polygon, rectMinX, rectMaxX, rectMinY, rectMaxY);
            default:
                // 复杂几何回退到JTS原方法
                return OverlayOp.intersection(geom, BeiDouGrid2DRangeQuery.createGridPolygon(gridCode));
        }
    }

    /**
     * 判断网格编码与几何图形是否相交（数学计算）
     *
     * @param gridCode 网格编码
     * @param geom 几何图形（多边形、线、点等）
     * @return 如果相交返回 true，否则返回 false
     */
    public static getGridIntersectsMath(gridCode: string, geom: Geometry) {
        return BeiDouGrid2DRangeQuery.isGridIntersectsMath(gridCode, geom, geom.getEnvelopeInternal());
    }

    // 点与矩形相交判断
    private static isPointInRectangleMath(point: Point,
      rectMinX: number, rectMaxX: number, rectMinY: number, rectMaxY: number) {
      const coordinate = point.getCoordinate();
        return coordinate.x >= rectMinX && coordinate.x <= rectMaxX &&
                coordinate.y >= rectMinY && coordinate.y <= rectMaxY;
    }

    // 线与矩形相交判断（使用Cohen-Sutherland算法）
    private static isLineIntersectsRectangleMath(line: LineString,
                                                         rectMinX: number, rectMaxX: number, rectMinY: number, rectMaxY: number) {
        const coords = line.getCoordinates();
        for (let i = 0; i < coords.length - 1; i++) {
            if (BeiDouGrid2DRangeQuery.isLineSegmentIntersectsRectangleMath(coords[i], coords[i + 1],
                    rectMinX, rectMaxX, rectMinY, rectMaxY)) {
                return true;
            }
        }
        return false;
    }

    // 多边形与矩形相交判断（简化数学版）
    private static isPolygonIntersectsRectangleMath(polygon: Polygon,
                                                            rectMinX: number, rectMaxX: number, rectMinY: number, rectMaxY: number) {
        // 检查多边形顶点是否在矩形内
        for (const coord of polygon.getCoordinates()) {
            if (BeiDouGrid2DRangeQuery.isPointInRectangleMath(coord, rectMinX, rectMaxX, rectMinY, rectMaxY)) {
                return true;
            }
        }

        // 检查矩形顶点是否在多边形内（使用射线法数学版）
        if (BeiDouGrid2DRangeQuery.isPointInPolygonMath(rectMinX, rectMinY, polygon) ||
                BeiDouGrid2DRangeQuery.isPointInPolygonMath(rectMaxX, rectMinY, polygon) ||
                BeiDouGrid2DRangeQuery.isPointInPolygonMath(rectMaxX, rectMaxY, polygon) ||
                BeiDouGrid2DRangeQuery.isPointInPolygonMath(rectMinX, rectMaxY, polygon)) {
            return true;
        }

        // 检查边相交
        return BeiDouGrid2DRangeQuery.isPolygonEdgesIntersectRectangleMath(polygon, rectMinX, rectMaxX, rectMinY, rectMaxY);
    }

    /**
     * 判断线段是否与矩形相交（数学版）
     */
    private static isLineSegmentIntersectsRectangleMath(p1: Coordinate, p2: Coordinate,
                                                                rectMinX: number, rectMaxX: number,
                                                                rectMinY: number, rectMaxY: number) {
        return BeiDouGrid2DRangeQuery.isLineSegmentIntersectsRectangle(p1.x, p1.y, p2.x, p2.y, rectMinX, rectMaxX, rectMinY, rectMaxY);
    }

    /**
     * 判断点是否在多边形内（数学版，射线法）
     */
    private static isPointInPolygonMath(x: number, y: number, polygon: Polygon) {
        // 射线法实现
        const coords = polygon.getCoordinates();
        let inside = false;
        for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
            if (((coords[i].y > y) != (coords[j].y > y)) &&
                    (x < (coords[j].x - coords[i].x) * (y - coords[i].y) / (coords[j].y - coords[i].y) + coords[i].x)) {
                inside = !inside;
            }
        }
        return inside;
    }

    /**
     * 判断多边形边与矩形边是否相交（数学版）
     */
    private static isPolygonEdgesIntersectRectangleMath(polygon: Polygon,
                                                                rectMinX: number, rectMaxX: number,
                                                                rectMinY: number, rectMaxY: number) {
        const coords = polygon.getCoordinates();
        for (let i = 0; i < coords.length - 1; i++) {
            if (BeiDouGrid2DRangeQuery.isLineSegmentIntersectsRectangle(coords[i].x, coords[i].y,
                    coords[i + 1].x, coords[i + 1].y,
                    rectMinX, rectMaxX, rectMinY, rectMaxY)) {
                return true;
            }
        }
        return false;
    }

    /**
     * 判断线段是否与矩形相交
     */
    private static isLineSegmentIntersectsRectangle(x1: number, y1: number, x2: number, y2: number,
                                                            rectMinX: number, rectMaxX: number,
                                                            rectMinY: number, rectMaxY: number) {
        // 使用Cohen-Sutherland线段裁剪算法
        const code1 = BeiDouGrid2DRangeQuery.computeOutCode(x1, y1, rectMinX, rectMaxX, rectMinY, rectMaxY);
        const code2 = BeiDouGrid2DRangeQuery.computeOutCode(x2, y2, rectMinX, rectMaxX, rectMinY, rectMaxY);

        // 如果两个端点都在矩形内，或者线段与矩形边界相交
        return (code1 & code2) == 0;
    }

    /**
     * 计算点的区域编码
     */
    private static computeOutCode(x: number, y: number,
                                      rectMinX: number, rectMaxX: number,
                                      rectMinY: number, rectMaxY: number) {
        let code = 0;
        if (x < rectMinX) code |= 1;   // 左
        if (x > rectMaxX) code |= 2;   // 右
        if (y < rectMinY) code |= 4;   // 下
        if (y > rectMaxY) code |= 8;   // 上
        return code;
    }
}
