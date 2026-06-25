// ============================================================
// GridFillPrimitive.ts — 隔离/占用网格「实心格」3D 盒 Primitive
// 层级：L3（渲染 Primitive 控制器）
// 职责：把少量高亮网格单元（飞行器所在格 + 缓冲环 / 单点查询格）渲染成半透实心 3D 盒。
//       每个 cell → 一个 BoxGeometry 实例（ENU 米尺寸 + 中心摆位），盒底由 cell.box
//       的 minHeightMeters 决定（贴地由 BeiDouGridScene 用 terrainBaseHeight 偏移
//       box.minHeightMeters 实现，保持高度 = maxHeight - minHeight 的立体感）。
//       多 cell 批成单 Primitive（少量 draw call）。
// 依赖：cesium（Primitive/GeometryInstance/BoxGeometry/PerInstanceColorAppearance/
//       ColorGeometryInstanceAttribute/Cartesian3/Color/Math）、render-constants（enuFrameAt）、
//       geo-bridge（CellBox）。
// 被消费：AirspaceIsolator（飞行器隔离）、BeiDouGridScene.drawPointGrid（单点查询）。
// 生命周期：setCells 双缓冲换 Primitive；destroy 摘除并销毁。
// ============================================================

import {
  BoxGeometry,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  Math as CesiumMath,
  PerInstanceColorAppearance,
  Primitive,
  type PrimitiveCollection,
} from 'cesium';

import type { CellBox } from '../geo-bridge';
import { enuFrameAt } from '../render-constants';

/** 一个待填充的网格单元（地理 box + 颜色）。 */
export interface FillCell {
  /** 单元地理 box（西南角 + 度步长 + 高度区间）。 */
  box: CellBox;
  /** 填充颜色（含 alpha）。 */
  color: Color;
}

/** 赤道每度经/纬的米长（用于度步长 → 米尺寸换算）。 */
const METERS_PER_DEG_LAT = 111320.0;
const METERS_PER_DEG_LON_EQUATOR = 111320.0;

export default class GridFillPrimitive {
  private readonly primitives: PrimitiveCollection;
  private current: Primitive | undefined;
  private destroyed = false;

  /**
   * @param primitives 宿主 scene.primitives。
   */
  public constructor(primitives: PrimitiveCollection) {
    this.primitives = primitives;
  }

  /**
   * 用一组单元重建填充层（双缓冲）。空数组等价 clear。
   *
   * 每个单元 → 一个 BoxGeometry 实例：
   *   - 中心点（经向/纬向取 box 中点，高度取 box 高度中点）→ ENU modelMatrix；
   *   - 盒尺寸（米）：dimX = stepLon·metersPerDegLon·cos(centerLat)，
   *                 dimY = stepLat·metersPerDegLat，dimZ = maxH-minH；
   *   - 微抬 ε 米防与线格网共面 z-fighting。
   *
   * @param cells 待填充单元（数量应较小：飞行器格 + 缓冲环 / 单格查询）
   */
  public setCells(cells: readonly FillCell[]): void {
    if (this.destroyed) return;

    if (cells.length === 0) {
      this.clear();
      return;
    }

    const instances: GeometryInstance[] = new Array(cells.length);
    for (let k = 0; k < cells.length; k++) {
      instances[k] = GridFillPrimitive.buildBoxInstance(cells[k]!);
    }

    const primitive = new Primitive({
      geometryInstances: instances,
      appearance: new PerInstanceColorAppearance({
        translucent: true,
        closed: true,   // 盒子封闭体，背面剔除 + 正确深度
        flat: false,    // 带轻微光照，立体感更强（隔离格更醒目）
      }),
      asynchronous: false,
      releaseGeometryInstances: true,
    });

    const old = this.current;
    this.primitives.add(primitive);
    this.current = primitive;
    if (old) this.primitives.remove(old);
  }

  /**
   * 由一个 FillCell 构建 BoxGeometry 实例（ENU 摆位 + 米尺寸 + 颜色）。
   *
   * @param cell 单元
   * @returns GeometryInstance
   */
  private static buildBoxInstance(cell: FillCell): GeometryInstance {
    const b = cell.box;
    const centerLon = b.swLonDeg + b.stepLonDeg / 2;
    const centerLat = b.swLatDeg + b.stepLatDeg / 2;
    const centerH = (b.minHeightMeters + b.maxHeightMeters) / 2;

    // 度步长 → 米尺寸。经向乘 cos(centerLat) 收缩；纬向近似恒定。
    const cosLat = Math.max(0.02, Math.cos(CesiumMath.toRadians(centerLat)));
    const dimX = b.stepLonDeg * METERS_PER_DEG_LON_EQUATOR * cosLat;       // 东西向（米）
    const dimY = b.stepLatDeg * METERS_PER_DEG_LAT;                        // 南北向（米）
    const dimZ = Math.max(1.0, b.maxHeightMeters - b.minHeightMeters);     // 垂直（米），至少 1m

    // ENU 摆位：盒中心在 centerH，微抬 EPS 防与线格网共面闪烁。
    const EPS = 0.5; // 米
    const modelMatrix = enuFrameAt(centerLon, centerLat, centerH + EPS);

    const geometry = BoxGeometry.fromDimensions({
      dimensions: new Cartesian3(dimX, dimY, dimZ),
      vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
    });

    return new GeometryInstance({
      geometry,
      modelMatrix,
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(cell.color),
      },
    });
  }

  /** 显示/隐藏。 */
  public setVisible(visible: boolean): void {
    if (this.current) this.current.show = visible;
  }

  /** 清空当前填充（控制器仍可再次 setCells）。 */
  public clear(): void {
    if (this.current) {
      this.primitives.remove(this.current);
      this.current = undefined;
    }
  }

  /** 是否已销毁。 */
  public isDestroyed(): boolean {
    return this.destroyed;
  }

  /** 销毁。 */
  public destroy(): void {
    if (this.destroyed) return;
    this.clear();
    this.destroyed = true;
  }
}
