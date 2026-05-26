// ============================================================
// PolarGridLinePrimitive.ts — 极区收敛格线格网 Primitive
// 层级：L3（渲染 Primitive 控制器，极区分支）
// 职责：把极区剖分（纬度带 + 每带扇区数）画成「纬圈（整圈采样）+ 每带径向扇线」，
//       一段 LINES 几何、单 Primitive、1 draw call。每个高度层一套。
// 依赖：cesium（Primitive/GeometryInstance/Geometry/GeometryAttribute/ComponentDatatype/
//       PrimitiveType/PerInstanceColorAppearance/ColorGeometryInstanceAttribute/
//       BoundingSphere/Cartesian3/Ellipsoid/Color/Math）、PolarGridTessellator。
// 被消费：BeiDouGridScene（极区分支）。
// 生命周期：rebuild 双缓冲；destroy 摘除销毁。
// ============================================================

import {
  BoundingSphere,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  ComponentDatatype,
  Ellipsoid,
  Geometry,
  GeometryAttribute,
  GeometryInstance,
  PerInstanceColorAppearance,
  Primitive,
  PrimitiveType,
  type PrimitiveCollection,
} from 'cesium';

import type { PolarTessellation } from '../grid/PolarGridTessellator';

/** 极区线格网外观参数。 */
export interface PolarLineOptions {
  color: Color;
  lineWidth?: number;
  /** 每个纬圈的采样段数（整圈，越大越圆滑）。默认 360（每度一段）。 */
  circleSegments?: number;
  /** 是否画层间竖向边。 */
  drawVerticalEdges?: boolean;
}

const _scratchC = new Cartesian3();

export default class PolarGridLinePrimitive {
  private readonly primitives: PrimitiveCollection;
  private current: Primitive | undefined;
  private destroyed = false;

  public constructor(primitives: PrimitiveCollection) {
    this.primitives = primitives;
  }

  /**
   * 用极区剖分重建线格网（双缓冲）。
   *
   * @param t   极区剖分
   * @param opt 外观
   */
  public rebuild(t: PolarTessellation, opt: PolarLineOptions): void {
    if (this.destroyed) return;

    const geometry = PolarGridLinePrimitive.buildGeometry(t, opt);
    const primitive = new Primitive({
      geometryInstances: new GeometryInstance({
        geometry,
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(opt.color) },
      }),
      appearance: new PerInstanceColorAppearance({
        flat: true,
        translucent: true,
        renderState: { lineWidth: Math.min(opt.lineWidth ?? 1.0, 1.0) },
      }),
      asynchronous: false,
      releaseGeometryInstances: true,
      compressVertices: false,
    });

    const old = this.current;
    this.primitives.add(primitive);
    this.current = primitive;
    if (old) this.primitives.remove(old);
  }

  /**
   * 构建极区线几何：
   *   - 每个高度层：① 所有 band 边界纬度处画整圈纬圈（圆形 parallel）；
   *                 ② 每个 band 在其 [latLo,latHi] 区间画 sectors 条径向经线段（lon=k·360/sectors）。
   *   - 层间竖向边（可选）：在每个 band 边界、每个径向经线处连相邻层。
   *
   * @param t   极区剖分
   * @param opt 外观（circleSegments / drawVertical）
   * @returns Cesium.Geometry（LINES）
   */
  private static buildGeometry(t: PolarTessellation, opt: PolarLineOptions): Geometry {
    const ellipsoid = Ellipsoid.WGS84;
    const circleSegs = Math.max(12, opt.circleSegments ?? 360);
    const drawVertical = opt.drawVerticalEdges ?? false;
    const planes = t.zPlaneFloors.length;
    const bands = t.bands;

    // 收集所有需要画整圈的纬度（各 band 的 lo/hi 去重）。
    const parallelLatSet = new Set<number>();
    for (const b of bands) {
      parallelLatSet.add(Number(b.latLoDeg.toFixed(9)));
      parallelLatSet.add(Number(b.latHiDeg.toFixed(9)));
    }
    const parallelLats = Array.from(parallelLatSet);

    // ── 估算顶点/段数，预分配 ──
    // 纬圈：每条 circleSegs+1 顶点（首尾不共用）。
    const parallelVerts = parallelLats.length * (circleSegs + 1) * planes;
    const parallelSegs = parallelLats.length * circleSegs * planes;
    // 径向扇线：每 band sectors 条，每条 2 点（latLo→latHi）。
    let radialLineCount = 0;
    for (const b of bands) radialLineCount += b.sectors === 1 ? 0 : b.sectors; // 圆盘无径向线
    const radialVerts = radialLineCount * 2 * planes;
    const radialSegs = radialLineCount * planes;
    // 竖向边：每个 (parallelLat × 若干经度) 角点对相邻层连边——仅在「band 边界 × 每 30°」放竖边。
    const vEdgeLonStep = 30; // 度
    const vEdgeLonCount = Math.ceil(360 / vEdgeLonStep);
    const verticalLineCount = drawVertical && planes > 1
      ? parallelLats.length * vEdgeLonCount * (planes - 1)
      : 0;
    const verticalVerts = verticalLineCount * 2;
    const verticalSegs = verticalLineCount;

    const totalVerts = parallelVerts + radialVerts + verticalVerts;
    const totalSegs = parallelSegs + radialSegs + verticalSegs;

    const positions = new Float64Array(totalVerts * 3);
    const indices = new Uint32Array(totalSegs * 2);
    let vi = 0;
    let ii = 0;

    const writeVertex = (lonDeg: number, latDeg: number, hMeters: number): number => {
      const c = Cartesian3.fromDegrees(lonDeg, latDeg, hMeters, ellipsoid, _scratchC);
      const vid = vi / 3;
      positions[vi++] = c.x; positions[vi++] = c.y; positions[vi++] = c.z;
      return vid;
    };

    for (let p = 0; p < planes; p++) {
      const h = t.zPlaneFloors[p]!;

      // ① 纬圈（整圈）。
      for (const lat of parallelLats) {
        let prev = -1;
        for (let s = 0; s <= circleSegs; s++) {
          const lon = -180 + (360 * s) / circleSegs;
          const vid = writeVertex(lon, lat, h);
          if (prev >= 0) { indices[ii++] = prev; indices[ii++] = vid; }
          prev = vid;
        }
      }

      // ② 每 band 径向扇线（圆盘 sectors=1 跳过）。
      for (const b of bands) {
        if (b.sectors <= 1) continue;
        const dLon = 360 / b.sectors;
        for (let k = 0; k < b.sectors; k++) {
          const lon = -180 + k * dLon; // 从 -180 起均匀；与 0° 对齐（-180 与 180 同线）
          const a = writeVertex(lon, b.latLoDeg, h);
          const c2 = writeVertex(lon, b.latHiDeg, h);
          indices[ii++] = a; indices[ii++] = c2;
        }
      }
    }

    // ③ 层间竖向边（可选）：band 边界纬度 × 每 30° 经度，连相邻层。
    if (drawVertical && planes > 1) {
      for (let p = 0; p < planes - 1; p++) {
        const hLo = t.zPlaneFloors[p]!;
        const hHi = t.zPlaneFloors[p + 1]!;
        for (const lat of parallelLats) {
          for (let k = 0; k < vEdgeLonCount; k++) {
            const lon = -180 + k * vEdgeLonStep;
            const a = writeVertex(lon, lat, hLo);
            const c2 = writeVertex(lon, lat, hHi);
            indices[ii++] = a; indices[ii++] = c2;
          }
        }
      }
    }

    const usedPositions = positions.subarray(0, vi);
    const usedIndices = indices.subarray(0, ii);

    // 同 GridLinePrimitive：LINES 几何仅需 position，绕开 GeometryAttributes 全字段约束。
    return new Geometry({
      attributes: {
        position: new GeometryAttribute({
          componentDatatype: ComponentDatatype.DOUBLE,
          componentsPerAttribute: 3,
          values: usedPositions,
        }),
      } as unknown as Geometry['attributes'],
      indices: usedIndices,
      primitiveType: PrimitiveType.LINES,
      boundingSphere: BoundingSphere.fromVertices(usedPositions as unknown as number[]),
    });
  }

  public setVisible(visible: boolean): void {
    if (this.current) this.current.show = visible;
  }

  public clear(): void {
    if (this.current) { this.primitives.remove(this.current); this.current = undefined; }
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.clear();
    this.destroyed = true;
  }
}
