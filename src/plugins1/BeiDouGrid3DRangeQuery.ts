import moment from "moment";

import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory";
import Geometry from "jsts/org/locationtech/jts/geom/Geometry";
import LineString from "jsts/org/locationtech/jts/geom/LineString";
import Polygon from "jsts/org/locationtech/jts/geom/Polygon";
import Envelope from "jsts/org/locationtech/jts/geom/Envelope";
import Coordinate from "jsts/org/locationtech/jts/geom/Coordinate";
import BeiDouGridConstants from "./BeiDouGridConstants";
import BeiDouGridEncoder from "./BeiDouGridEncoder";
import BeiDouGridDecoder from "./BeiDouGridDecoder";
import BeiDouGrid2DRangeQuery from "./BeiDouGrid2DRangeQuery";
import BeiDouGeoPoint from "./BeiDouGeoPoint";
import GisUtils from "./GisUtils";
import BeiDouGridUtils from "./BeiDouGridUtils";

import StringBuilder from "./StringBuilder";

/**
 * 北斗三维网格范围查询工具类
 * 根据三维几何图形生成包含的北斗三维网格码集合
 */
export default class BeiDouGrid3DRangeQuery {

    /**
     * 主方法，根据几何图形查找相交的三维网格码（显式指定高度范围）
     * <p>
     * 实现逻辑分为两个阶段：
     * 1. 使用二维查询获取基础网格
     * 2. 为每个基础网格生成三维编码并筛选
     *
     * @param geom        几何图形对象，支持多边形、线、点等JTS几何类型
     * @param targetLevel 目标网格级别，范围1-10
     * @param minHeight 最小海拔高度（单位：米）
     * @param maxHeight 最大海拔高度（单位：米）
     * @return 与几何图形相交的所有指定级别三维网格码集合
     * @throws IllegalArgumentException 如果几何图形为空、目标级别不在 1-10 范围内或高度范围无效
     */
    public static find3DGridCodesInRange( geom:Geometry, targetLevel: number,
                                                     minHeight: number, maxHeight: number) {
        const startTime = moment();
        this.validateParameters(geom, targetLevel, minHeight, maxHeight);

        const result = new Set<string>();

        // 第一阶段：使用二维查询获取基础网格
        const baseGrids = BeiDouGrid2DRangeQuery.find2DGridCodesInRange(geom, targetLevel);
        let totalTime = moment().diff(startTime, 'ms');
        console.log("二维基础网格筛选完成，找到 {} 个网格，总耗时 {}ms", baseGrids.size, totalTime);

        // 第二阶段：为每个基础网格生成三维编码并筛选
        for (const grid2D of baseGrids) {
            this.generate3DGridsFor2DBase(grid2D, geom, minHeight, maxHeight, result);
        }
        totalTime = moment().diff(startTime, 'ms');
        console.log("三维查询完成：找到 {} 个{}级三维网格，总耗时 {}ms", result.size, targetLevel, totalTime);

        return result;
    }


    /**
     * 对于为线的几何图形，该方法性能优于find3DGridCodesInRange方法，首选该方法
     * @param lineString 线
     * @param targetLevel 所生成的网格等级
     * @return 线所包含的网格点
     */
    public static find3DGridCodesWithLineString( lineString:LineString, targetLevel: number) {
        const startTime = moment();
        const result = new Set<string>();
        //获取被点填充好的线
        const newGeom = GisUtils.lineFillPoints(lineString, BeiDouGridConstants.GRID_SIZES_3D[targetLevel]);
        const coordinates = newGeom.getCoordinates();
        const beiDouGeoPoints = new Set<BeiDouGeoPoint>();
        for (const coordinate of coordinates) {
            //计算三维网格
            const code = BeiDouGridUtils.encode3D(new BeiDouGeoPoint(coordinate.x, coordinate.y, coordinate.z), targetLevel);
            const beiDouGeoPoint = BeiDouGridDecoder.decode3D(code);
            if (beiDouGeoPoints.size > 1) {
                const pointsArray = Array.from(beiDouGeoPoints);
                const lastGridLng = pointsArray[pointsArray.length - 1]!.getLongitude();
                const lastGridLat = pointsArray[pointsArray.length - 1]!.getLatitude();
                const lastGridHeight = pointsArray[pointsArray.length - 1]!.getHeight();

                const lastBeiDouGeoPoint = new BeiDouGeoPoint(lastGridLng, lastGridLat, lastGridHeight);
                //去重判断
                if (!beiDouGeoPoint.equals(lastBeiDouGeoPoint)){
                    beiDouGeoPoints.add(beiDouGeoPoint);
                    result.add(code);
                }
            } else {
                beiDouGeoPoints.add(beiDouGeoPoint);
                result.add(code);
            }
        }
        const totalTime = moment().diff(startTime, 'ms');
        console.log("线查询完成：找到 {} 个{}级网格，总耗时 {}ms", result.size, targetLevel, totalTime);
        return result;
    }

    /**
     * 直接生成与几何图形相交的三维网格编码集合
     *
     * @param geom 几何图形
     * @param targetLevel 目标网格级别
     * @param minHeight 最小高度
     * @param maxHeight 最大高度
     * @return 相交的三维网格编码集合
     */
    public static generate3DGridCodesDirectly(geom:Geometry, targetLevel: number,
                                                          minHeight: number, maxHeight: number) {
        const startTime = moment();
        this.validateParameters(geom, targetLevel, minHeight, maxHeight);

        const result = new Set<string>();

        // 1. 快速筛选一级三维网格（包含高度范围）
        const level1Grids = this.findIntersectingLevel1Grids3D(geom, minHeight, maxHeight);

        // 2. 对每个相交的一级网格进行递归细化
        level1Grids.forEach(level1Grid =>
                this.refineGrid3D(level1Grid, geom, targetLevel, 1, minHeight, maxHeight, result)
        );

        const totalTime = moment().diff(startTime, 'ms');
        console.log("直接三维网格生成完成：找到 {} 个{}级网格，耗时 {}ms", result.size, targetLevel, totalTime);

        return result;
    }

    /**
     * 快速筛选一级三维网格（包含高度范围）
     */
    private static findIntersectingLevel1Grids3D(geom:Geometry,
                                                             minHeight:number, maxHeight:number) {
        // 1. 计算几何图形的边界范围（包括高度）
        const envelope = geom.getEnvelopeInternal();
        const minLng = envelope.getMinX();
        const maxLng = envelope.getMaxX();
        const minLat = envelope.getMinY();
        const maxLat = envelope.getMaxY();

        // 2. 计算一级网格索引范围（一级网格尺寸：6°×4°×高度）
        const minLngIdx =  Math.floor(minLng / 6.0);
        const maxLngIdx = Math.floor(maxLng / 6.0);
        const minLatIdx = Math.floor(minLat / 4.0);
        const maxLatIdx = Math.floor(maxLat / 4.0);
        const minAltIdx = Math.floor(minHeight / this.getGridHeight3D(1));
        const maxAltIdx = Math.floor(maxHeight / this.getGridHeight3D(1));

        // 3. 生成候选一级网格码
        const candidateGrids = new Set<string>();
        for (let altIdx = minAltIdx; altIdx <= maxAltIdx; altIdx++) {
            for (let lngIdx = minLngIdx; lngIdx <= maxLngIdx; lngIdx++) {
                for (let latIdx = minLatIdx; latIdx <= maxLatIdx; latIdx++) {
                    // 生成一级网格的三维编码
                    const grid3D = this.generateLevel1GridCode3D(lngIdx, latIdx, altIdx);
                    candidateGrids.add(grid3D);
                }
            }
        }

        // 4. 精确筛选：判断几何图形是否与网格相交（包括高度范围）
        const intersectingGrids = new Set<string>();
        for (const grid3D of candidateGrids) {
            if (this.is3DGridValidDirectly(grid3D, geom, minHeight, maxHeight)) {
                intersectingGrids.add(grid3D);
            }
        }

        return intersectingGrids;
    }

    /**
     * 生成一级三维网格码
     */
    private static generateLevel1GridCode3D(lngIdx: number, latIdx: number, altIdx: number) {
        // 生成二维部分
        const grid2D = BeiDouGridEncoder.encode2D(
                new BeiDouGeoPoint(lngIdx * 6.0 + 3.0, latIdx * 4.0 + 2.0, 0), 1);

        // 生成高度部分
        const heightCode = BeiDouGridEncoder.encode3DHeight(altIdx * this.getGridHeight3D(1) + this.getGridHeight3D(1) / 2, 1);

        // 组合成完整的三维编码
        return this.combine2DAndHeight(grid2D, heightCode, 1);
    }

    /**
     * 递归细化三维网格
     */
    private static refineGrid3D(parentGrid: string, geom: Geometry, targetLevel: number,
                                     currentLevel: number, minHeight: number, maxHeight: number,
                                     result: Set<string>) {
        if (currentLevel == targetLevel) {
            result.add(parentGrid);
            return;
        }

        // 生成当前层级网格的所有子网格
        const childGrids = this.generateChildGrids3D(parentGrid);

        // 普通for循环处理子网格（便于调试）
        console.log("生成子网格数量: " + childGrids.size);
        let validCount = 0;
        for (const childGrid of childGrids) {
            if (this.is3DGridValidDirectly(childGrid, geom, minHeight, maxHeight)) {
                this.refineGrid3D(childGrid, geom, targetLevel, currentLevel + 1,
                        minHeight, maxHeight, result);
                validCount++;
            }
        }
        console.log("有效子网格数量: " + validCount);
    }

    /**
     * 生成指定父三维网格的所有子三维网格集合
     *
     *
     * @param parentGrid  父三维网格编码（格式示例：N050J0047050）
     *                    - 必须为有效的北斗三维网格码
     *                    - 编码级别需小于10（最高级网格无子网格）
     * @return 子三维网格集合（可能为空集合）
     *         - 每个子网格的级别为 parentGrid的级别 + 1
     *         - 集合无序但保证唯一性
     *
     * @throws IllegalArgumentException 如果参数不合法：
     *         - parentGrid格式无效
     *         - parentGrid是10级网格（无子网格）
     *
     * @see BeiDouGridDecoder#decode3D 三维网格解码实现
     * @see BeiDouGridConstants#GRID_DIVISIONS 各级网格划分规则
     * @see BeiDouGridConstants#GRID_SIZES_DEGREES 各级网格尺寸定义
     */
    public static generateChildGrids3D(parentGrid: string) {
        const childGrids = new Set<string>();

        // 当前三维网格码层级
        const currentLevel = BeiDouGridDecoder.getCodeLevel3D(parentGrid);
        if (currentLevel < 1 || currentLevel >= 10) {
            throw new Error("只能生成1-9级网格的子网格");
        }

        // 解码父网格获取西南角点（包括高度）
        const parentSWCorner = BeiDouGridDecoder.decode3D(parentGrid);
        const parentSWCornerLatitude = parentSWCorner.getLatitude();
        const parentSWCornerLongitude = parentSWCorner.getLongitude();
        const parentMinHeight = parentSWCorner.getHeight();
        const parentMaxHeight = parentSWCorner.getHeight() + this.getGridHeight3D(currentLevel);


        // 获取子网格的划分数量
        const divisions = BeiDouGridConstants.GRID_DIVISIONS[currentLevel + 1 as keyof typeof BeiDouGridConstants.GRID_DIVISIONS];
        const lngDivisions = divisions[0];
        const latDivisions = divisions[1];

        // 获取子网格尺寸
        const childSize = BeiDouGridConstants.GRID_SIZES_DEGREES[currentLevel + 1 as keyof typeof BeiDouGridConstants.GRID_SIZES_DEGREES];
        const lngSize = childSize[0]!.toNumber();
        const latSize = childSize[1]!.toNumber();

        // 高度方向的网格尺寸
        const altSize = this.getGridHeight3D(currentLevel + 1);

        // 计算高度方向的网格数量
        const minAltIdx = Math.floor(parentMinHeight / altSize);
        const maxAltIdx = Math.ceil(parentMaxHeight / altSize);
        console.log("高度方向网格数量: minAltIdx={}, maxAltIdx={}, 总数量={}", minAltIdx, maxAltIdx, maxAltIdx - minAltIdx + 1);

        // 生成所有子网格的中心点并编码（高度方向生成多个网格）
        for (let i = 0; i < lngDivisions!; i++) {
            for (let j = 0; j < latDivisions!; j++) {
                // 计算子网格的西南角点（经纬度）
                const childSWLng = parentSWCornerLongitude + i * lngSize;
                const childSWLat = parentSWCornerLatitude + j * latSize;

                // 计算子网格中心点（经纬度）
                const childLng = childSWLng + lngSize / 2;
                const childLat = childSWLat + latSize / 2;

                // 生成高度方向的网格
                for (let k = minAltIdx; k <= maxAltIdx; k++) {
                    const childAlt = k * altSize + altSize / 2;
                    const childGrid = BeiDouGridEncoder.encode3D(
                            new BeiDouGeoPoint(childLng, childLat, childAlt), currentLevel + 1
                    );
                    childGrids.add(childGrid);
                }
            }
        }
        console.log("生成层级 {} 网格 {} 的 {} 个子网格",
                currentLevel, parentGrid, childGrids.size);
        return childGrids;
    }


    /**
     * 直接验证三维网格有效性（优化版）
     */
    private static is3DGridValidDirectly(grid3D: string, geom: Geometry,
                                                 gridMinAlt: number, gridMaxAlt: number) {
        try {
            // 解码获取网格边界
            const swPoint = BeiDouGridDecoder.decode3D(grid3D);

            // 获取网格的尺寸（经度、纬度、高度）
            const gridHeight = this.getGridHeight3D(this.getGridLevel3D(grid3D));

            // 计算网格的东北角点（右上角点）
            const neAlt = swPoint.getHeight() + gridHeight;

            // 高度范围验证
            if (gridMaxAlt < swPoint.getHeight() || gridMinAlt > neAlt) {
                return false;
            }

            // 二维空间验证（使用BeiDouGridRangeQuery）
            const grid2D = this.extract2DCode(grid3D, this.getGridLevel3D(grid3D));
            const intersectingGrids = BeiDouGrid2DRangeQuery.findGridCodesInRange(geom, this.getGridLevel(grid2D));
            return intersectingGrids.has(grid2D);

        } catch (e) {
            console.log("三维网格验证失败: " + grid3D + " " + e);
            return false;
        }
    }


    private static validateParameters(geom: Geometry, targetLevel: number, minHeight: number, maxHeight: number) {
        if (geom == null) {
            throw new Error("几何图形不能为空");
        }
        if (targetLevel < 1 || targetLevel > 10) {
            throw new Error("目标层级必须在1到10之间");
        }
        if (minHeight === undefined || maxHeight === undefined) {
            throw new Error("高度范围必须是有效的数值");
        }
        if (minHeight > maxHeight) {
            throw new Error("最小高度不能大于最大高度");
        }
    }

    /**
     * 主方法：根据几何图形查找相交的三维网格码（自动计算高度范围）
     */
    public static find3DGridCodesInRangeMain(geom: Geometry, targetLevel: number) {
        // 从几何图形中提取高度范围
        const heightRange = this.extractHeightRangeFromGeometry(geom);
        return this.find3DGridCodesInRange(geom, targetLevel, heightRange[0]!, heightRange[1]!);
    }

    /**
     * 从几何图形中提取高度范围
     */
    private static extractHeightRangeFromGeometry( geom:Geometry) {
        if (geom == null) {
            throw new Error("几何图形不能为空");
        }

        let minHeight = Number.MAX_VALUE;
        let maxHeight = Number.MIN_VALUE;

        // 遍历几何图形的所有点，提取高度信息
        for (const coord of geom.getCoordinates()) {
            const height = isNaN(coord.z) ? 0.0 : coord.z;
            minHeight = Math.min(minHeight, height);
            maxHeight = Math.max(maxHeight, height);
        }

        return [minHeight, maxHeight];
    }

    /**
     * 为二维基础网格生成三维编码并筛选（带高度参数，以高度字段为范围）
     */
    private static generate3DGridsFor2DBase(grid2D: string, geom: Geometry,
                                                 minHeight: number, maxHeight: number,
                                                 result: Set<string>) {
        const level = this.getGridLevel(grid2D);

        // 计算网格的高度尺寸
        const gridHeight = this.getGridHeight3D(level);

        // 计算起始和结束的高度索引
        const startIndex = Math.floor(minHeight / gridHeight);
        const endIndex = Math.ceil(maxHeight / gridHeight);

        // 为每个高度索引生成编码
        for (let i = startIndex; i <= endIndex; i++) {
            const gridMinAlt = i * gridHeight;
            const gridMaxAlt = gridMinAlt + gridHeight;

            // 生成高度编码
            const heightCode = BeiDouGridEncoder.encode3DHeight(gridMinAlt + gridHeight / 2, level);

            // 组合成完整的三维编码
            const grid3D = this.combine2DAndHeight(grid2D, heightCode, level);

            // 检查是否与几何图形相交
//            if (is3DGridValid(grid3D, geom, gridMinAlt, gridMaxAlt)) {
//                result.add(grid3D);
//            }
            result.add(grid3D);
        }
    }

    /**
     * 从几何图形中提取高度点集合
     *
     * @param geom 几何图形
     * @return 高度点集合
     */
    public static extractHeightPointsFromGeometry( geom:Geometry) {
        if (geom == null) {
            throw new Error("几何图形不能为空");
        }

        const heightPoints = new Set<number>();

        // 遍历几何图形的所有点，提取高度信息
        for (const coord of geom.getCoordinates()!) {
            // 假设 Coordinate 的 z 值代表高度
            const height = isNaN(coord.z) ? 0.0 : coord.z;
            heightPoints.add(height);
        }

        return heightPoints;
    }

    /**
     * 组合二维编码和高度编码
     */
    private static combine2DAndHeight(grid2D: string, heightCode: string, level: number) {
        const result = new StringBuilder();

        // 添加纬度方向
        result.append(grid2D[0]!);

        // 添加高度方向
        result.append(heightCode[0]!);

        let grid2DIndex = 1;
        let heightCodeIndex = 1;

        // 逐级组合编码
        for (let i = 1; i <= level; i++) {
            // 添加二维编码片段
            const level2DLength = BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[i]! -
                    BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[i - 1]!;
            result.append(grid2D.substring(grid2DIndex, grid2DIndex + level2DLength));
            grid2DIndex += level2DLength;

            // 添加高度编码片段
            if (i == 1) {
                result.append(heightCode.substring(heightCodeIndex, heightCodeIndex + 2));
                heightCodeIndex += 2;
            } else {
                result.append(heightCode.substring(heightCodeIndex, heightCodeIndex + 1));
                heightCodeIndex += 1;
            }
        }

        return result.toString();
    }

    /**
     * 判断三维网格是否有效（2.5D方案：二维空间关系 + 高度范围判断），待优化
     */
    private static is3DGridValid(grid3D: string, geom: Geometry, queryMinAlt: number, queryMaxAlt: number) {
        try {
            // 解码获取网格的三维边界信息
            const swPoint = BeiDouGridDecoder.decode3D(grid3D);
            const level = this.getGridLevel3D(grid3D);

            // 获取网格的尺寸
            const gridHeightSize = this.getGridHeight3D(level);

            // 计算网格的高度范围
            const gridMinAlt = swPoint.getHeight();
            const gridMaxAlt = gridMinAlt + gridHeightSize;

            // 1. 高度范围相交判断（精确匹配）
            const heightIntersects = (gridMaxAlt > queryMinAlt) && (gridMinAlt < queryMaxAlt);
            if (!heightIntersects) {
                return false;
            }

            // 2. 二维空间关系判断（复用现有优化逻辑）
                const grid2D = this.extract2DCode(grid3D, level);
            const intersectingGrids = BeiDouGrid2DRangeQuery.findGridCodesInRange(geom, this.getGridLevel(grid2D));

            // 3. 如果二维相交且高度相交，则三维相交（精确方案）
            return intersectingGrids.has(grid2D);

        } catch (e) {
            console.log("三维网格验证失败: " + grid3D + " " + e);
            return false;
        }
    }

    /**
     * 从三维编码中提取二维编码部分
     */
    private static extract2DCode(grid3D: string, level: number) {
        const code2D = new StringBuilder();
        code2D.append(grid3D.charAt(0)); // 纬度方向

        let index = 2; // 跳过纬度方向和高度方向

        for (let i = 1; i <= level; i++) {
            const level2DLength = BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[i]! -
                    BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[i - 1]!;
            code2D.append(grid3D.substring(index, index + level2DLength));
            index += level2DLength;

            // 跳过高度编码部分
            if (i == 1) {
                index += 2;
            } else {
                index += 1;
            }
        }

        return code2D.toString();
    }

    /**
     * 获取三维网格的高度尺寸
     */
    private static getGridHeight3D(level: number) {
        if (level < 1 || level > 10) {
            throw new Error("层级必须在1-10之间");
        }
        return BeiDouGridConstants.GRID_SIZES_3D[level];
    }

    /**
     * 获取二维网格码的层级
     */
    private static getGridLevel(grid2D: string) {
        const length = grid2D.length;
        for (let i = 1; i <= 10; i++) {
            if (length == BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[i]) {
                return i;
            }
        }
        throw new Error("无效的网格码格式: " + grid2D);
    }

    /**
     * 获取三维网格码的层级
     */
    private static getGridLevel3D(grid3D: string) {
        const length = grid3D.length;
        for (let i = 1; i <= 10; i++) {
            let expectedLength = 2; // 方向位
            for (let j = 1; j <= i; j++) {
                expectedLength += (BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[j]! -
                        BeiDouGridConstants.CODE_LENGTH_AT_LEVEL[j - 1]!);
                expectedLength += (j == 1) ? 2 : 1;
            }
            if (expectedLength == length) {
                return i;
            }
        }
        throw new Error("无效的三维网格码格式: " + grid3D);
    }
    /**
     * 创建网格边界几何图形
     */
    private static createGridBounds(swPoint: BeiDouGeoPoint, level: number) {
        const gridSize = BeiDouGridConstants.GRID_SIZES_DEGREES[level as keyof typeof BeiDouGridConstants.GRID_SIZES_DEGREES][0]!.toNumber();
        const coordinates = new Array<Coordinate>(5);
        coordinates[0] = new Coordinate(swPoint.getLongitude(), swPoint.getLatitude());
        coordinates[1] = new Coordinate(swPoint.getLongitude() + gridSize, swPoint.getLatitude());
        coordinates[2] = new Coordinate(swPoint.getLongitude() + gridSize, swPoint.getLatitude() + gridSize);
        coordinates[3] = new Coordinate(swPoint.getLongitude(), swPoint.getLatitude() + gridSize);
        coordinates[4] = coordinates[0]; // 闭合多边形
        return new GeometryFactory().createPolygon(coordinates);
    }

}
