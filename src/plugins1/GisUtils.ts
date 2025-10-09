import { Math as CesiumMath } from 'cesium'

import Geometry from 'jsts/org/locationtech/jts/geom/Geometry';
import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory';
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate';

import BeiDouGridConstants from './BeiDouGridConstants';
import type LineString from 'jsts/org/locationtech/jts/geom/LineString';

export default class GisUtils {
    /**
     * 将几何类型为LineString的对象根据距离填充点
     *
     * @param originalLine 初始几何对象
     * @param distance 多少米距离填充一个点
     * @return 填充了点的线
     */
    public static lineFillPoints(originalLine: Geometry, distance: number) {
        if (originalLine == null) {
            return null;
        }
        const geometryFactory = new GeometryFactory();
        if (Geometry.TYPENAME_LINESTRING === originalLine.getGeometryType()) {
            const coordinates = (originalLine as unknown as LineString).getCoordinates();
            const resultCoordinates = new Array<Coordinate>();
            for (let i = 0; i < coordinates.length - 1; i++) {
                if (isNaN(coordinates[i].z)) {
                    coordinates[i].z = 0;
                }
                if (isNaN(coordinates[i + 1].z)) {
                    coordinates[i + 1].z = 0;
                }
                const actualDistance = this.calculateDistance(coordinates[i].x, coordinates[i].y, coordinates[i].z,
                        coordinates[i + 1].x, coordinates[i + 1].y, coordinates[i + 1].z);
                //两点之间需要新生成的点的数量
                let pointCount = 0;
                if (actualDistance % distance == 0) {
                    pointCount = (actualDistance / distance) - 1;
                } else {
                    pointCount = (actualDistance / distance);
                }

                resultCoordinates.push(coordinates[i]);

                for (let j = 1; j <= pointCount; j++) {
                    const newPointX = coordinates[i].x + ((coordinates[i + 1].x - coordinates[i].x) * j) / (pointCount + 1);
                    const newPointY = coordinates[i].y + ((coordinates[i + 1].y - coordinates[i].y) * j) / (pointCount + 1);
                    const newPointZ = coordinates[i].z + ((coordinates[i + 1].z - coordinates[i].z) * j) / (pointCount + 1);
                    resultCoordinates.push(new Coordinate(newPointX, newPointY, newPointZ));
                }
            }
            resultCoordinates.push(coordinates[coordinates.length - 1]);
            return geometryFactory.createLineString(resultCoordinates);
        }
        return originalLine;
    }
    // 计算两个经纬高之间的距离，高度的单位是米
    private static calculateDistance(lon1: number, lat1: number, h1: number, lon2: number, lat2: number, h2: number) {
        // 将经纬度转换为弧度
        const lat1Rad = CesiumMath.toRadians(lat1);
        const lon1Rad = CesiumMath.toRadians(lon1);
        const lat2Rad = CesiumMath.toRadians(lat2);
        const lon2Rad = CesiumMath.toRadians(lon2);

        // 转换为三维直角坐标
        const x1 = (BeiDouGridConstants.EARTH_RADIUS + h1) * Math.cos(lat1Rad) * Math.cos(lon1Rad);
        const y1 = (BeiDouGridConstants.EARTH_RADIUS + h1) * Math.cos(lat1Rad) * Math.sin(lon1Rad);
        const z1 = (BeiDouGridConstants.EARTH_RADIUS + h1) * Math.sin(lat1Rad);

        const x2 = (BeiDouGridConstants.EARTH_RADIUS + h2) * Math.cos(lat2Rad) * Math.cos(lon2Rad);
        const y2 = (BeiDouGridConstants.EARTH_RADIUS + h2) * Math.cos(lat2Rad) * Math.sin(lon2Rad);
        const z2 = (BeiDouGridConstants.EARTH_RADIUS + h2) * Math.sin(lat2Rad);

        // 计算坐标差
        const dx = x2 - x1;
        const dy = y2 - y1;
        const dz = z2 - z1;

        // 返回欧几里得距离,单位为米
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
}
