// ============================================================
// GridLinePrimitive.ts — 北斗格网「线格网」Primitive（百万格主力）
// 层级：L3（渲染 Primitive 控制器）
// 职责：把剖分结果（origin + 步长 + nx/ny + 高度层）构建成一段 LINES 几何，
//       封单个 Cesium.Primitive（PerInstanceColorAppearance flat），1 draw call。
//       共享边 → 顶点/索引规模 O((nx+ny)·层数)，百万格仅数千线、数万顶点。
//
// 三维 + 贴地：本 Primitive 是「整段三维几何」（每个 zPlane 一套水平网格 + 层间竖向边），
//       高度由 zPlaneFloors 给出。要把「底面贴地」，应由 BeiDouGridScene 在剖分前用
//       terrainBaseHeight 偏移 heightRange（统一上抬到地形面），而非把整体压平到地面。
//       这样既保留高度层立体感，又让最底层平面落在地表上。
//
// 依赖：cesium（Primitive/GeometryInstance/Geometry/GeometryAttribute/
//       ComponentDatatype/PrimitiveType/PerInstanceColorAppearance/
//       ColorGeometryInstanceAttribute/BoundingSphere/Cartesian3/Ellipsoid/Color/Math）、
//       GridTessellator 的 Tessellation。
// 被消费：BeiDouGridScene。
// 反子午线：crossesAntimeridian 时经度按 wrap 到 [-180,180]。
// 生命周期：rebuild() 双缓冲换 Primitive；destroy() 从 scene 摘除并销毁。
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
  Math as CesiumMath,
  PerInstanceColorAppearance,
  Primitive,
  PrimitiveType,
  type PrimitiveCollection,
} from 'cesium';

import type { Tessellation } from '../grid/GridTessellator';

/** 线格网构建/外观参数。 */
export interface GridLineOptions {
  /** 线颜色。 */
  color: Color;
  /** 线宽（像素，注意 WebGL 多数实现 lineWidth 上限为 1）。 */
  lineWidth?: number;
  /** 单条格线最大采样点数上限（防大窗口顶点爆炸）。 */
  maxSamplesPerLine?: number;
  /** 是否绘制层间竖向边（3D 立体感）。默认 true。 */
  drawVerticalEdges?: boolean;
}

const _scratchC = new Cartesian3();

export default class GridLinePrimitive {
  private readonly scene_primitives: PrimitiveCollection;
  private current: Primitive | undefined;
  private destroyed = false;

  /**
   * @param primitives 宿主 scene.primitives（构造时传入，便于 add/remove）。
   */
  public constructor(primitives: PrimitiveCollection) {
    this.scene_primitives = primitives;
  }

  /**
   * 用新剖分重建线格网（双缓冲）。
   *
   * 先构建新 Primitive 并加入场景，再移除旧的——避免「先移除后构建」的空帧闪烁。
   * 同步构建（asynchronous:false）：顶点量小（数万级），主线程毫秒级完成。
   *
   * @param t   剖分结果（zPlaneFloors 已被上层 shift 到 terrainBase+层 offset）
   * @param opt 外观参数
   */
  public rebuild(t: Tessellation, opt: GridLineOptions): void {
    if (this.destroyed) return;

    const geometry = GridLinePrimitive.buildLatticeGeometry(t, opt);
    const primitive = new Primitive({
      geometryInstances: new GeometryInstance({
        geometry,
        attributes: {
          color: ColorGeometryInstanceAttribute.fromColor(opt.color),
        },
      }),
      appearance: new PerInstanceColorAppearance({
        flat: true,
        translucent: true,
        renderState: {
          lineWidth: Math.min(opt.lineWidth ?? 1.0, 1.0),
        },
      }),
      asynchronous: false,
      releaseGeometryInstances: true,
      compressVertices: false,
    });

    const old = this.current;
    this.scene_primitives.add(primitive);
    this.current = primitive;
    if (old) {
      this.scene_primitives.remove(old);
    }
  }

  /**
   * 构建线格网几何（LINES）。
   *
   * 几何组成（每个高度层一套）：
   *   - 经向格线 (nx+1) 条：固定经度 lon_i，从 originLat 到 originLat+ny·stepLat；
   *   - 纬向格线 (ny+1) 条：固定纬度 lat_j，从 originLon 到 originLon+nx·stepLon；
   * 每条线沿其延伸方向等角采样 S 个点（S 自适应，≥2），相邻点连一条 LINE 段。
   * 层间竖向边（可选）：在格网四角 + 适当间隔的格角，连接相邻高度层。
   *
   * 复杂度：顶点数 ≈ ((nx+1)+(ny+1))·S·层数；对 1000×1000 单层、S=2 约 4004 顶点。
   *
   * @param t   剖分结果
   * @param opt 外观参数（取 maxSamplesPerLine / drawVerticalEdges）
   * @returns   Cesium.Geometry（PrimitiveType.LINES）
   */
  private static buildLatticeGeometry(t: Tessellation, opt: GridLineOptions): Geometry {
    const ellipsoid = Ellipsoid.WGS84;
    const planes = t.zPlaneFloors.length;
    const maxSamples = Math.max(2, opt.maxSamplesPerLine ?? 64);
    const drawVertical = opt.drawVerticalEdges ?? true;

    const lonSpanDeg = t.nx * t.stepLonDeg;
    const latSpanDeg = t.ny * t.stepLatDeg;
    const samplesAlongLat = CesiumMath.clamp(Math.ceil(latSpanDeg / 2) + 1, 2, maxSamples);
    const samplesAlongLon = CesiumMath.clamp(Math.ceil(lonSpanDeg / 2) + 1, 2, maxSamples);

    const cols = t.nx + 1;
    const rows = t.ny + 1;

    const vertsPerPlane = cols * samplesAlongLat + rows * samplesAlongLon;
    const cornerCount = cols * rows;
    const verticalStride = Math.max(1, Math.ceil(cornerCount / 4000));
    const verticalCornersPerPlanePair = Math.ceil(cornerCount / verticalStride);
    const verticalVerts = drawVertical && planes > 1
      ? verticalCornersPerPlanePair * (planes - 1) * 2
      : 0;

    const totalVerts = vertsPerPlane * planes + verticalVerts;

    const positions = new Float64Array(totalVerts * 3);
    const segPerPlane =
      cols * (samplesAlongLat - 1) + rows * (samplesAlongLon - 1);
    const verticalSegs = drawVertical && planes > 1
      ? verticalCornersPerPlanePair * (planes - 1)
      : 0;
    const totalSegs = segPerPlane * planes + verticalSegs;
    const indices = new Uint32Array(totalSegs * 2);

    let vi = 0;
    let ii = 0;

    const writeVertex = (lonDeg: number, latDeg: number, hMeters: number): number => {
      const c = Cartesian3.fromDegrees(GridLinePrimitive.wrapLon(lonDeg), latDeg, hMeters, ellipsoid, _scratchC);
      const vid = vi / 3;
      positions[vi++] = c.x;
      positions[vi++] = c.y;
      positions[vi++] = c.z;
      return vid;
    };

    for (let p = 0; p < planes; p++) {
      const h = t.zPlaneFloors[p]!;

      for (let i = 0; i < cols; i++) {
        const lon = t.originLonDeg + i * t.stepLonDeg;
        let prevVid = -1;
        for (let s = 0; s < samplesAlongLat; s++) {
          const tt = s / (samplesAlongLat - 1);
          const lat = t.originLatDeg + tt * latSpanDeg;
          const vid = writeVertex(lon, lat, h);
          if (prevVid >= 0) { indices[ii++] = prevVid; indices[ii++] = vid; }
          prevVid = vid;
        }
      }
      for (let j = 0; j < rows; j++) {
        const lat = t.originLatDeg + j * t.stepLatDeg;
        let prevVid = -1;
        for (let s = 0; s < samplesAlongLon; s++) {
          const tt = s / (samplesAlongLon - 1);
          const lon = t.originLonDeg + tt * lonSpanDeg;
          const vid = writeVertex(lon, lat, h);
          if (prevVid >= 0) { indices[ii++] = prevVid; indices[ii++] = vid; }
          prevVid = vid;
        }
      }
    }

    if (drawVertical && planes > 1) {
      for (let p = 0; p < planes - 1; p++) {
        const hLo = t.zPlaneFloors[p]!;
        const hHi = t.zPlaneFloors[p + 1]!;
        let cornerIdx = 0;
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++, cornerIdx++) {
            if (cornerIdx % verticalStride !== 0) continue;
            const lon = t.originLonDeg + i * t.stepLonDeg;
            const lat = t.originLatDeg + j * t.stepLatDeg;
            const a = writeVertex(lon, lat, hLo);
            const b = writeVertex(lon, lat, hHi);
            indices[ii++] = a; indices[ii++] = b;
          }
        }
      }
    }

    const usedPositions = positions.subarray(0, vi);
    const usedIndices = indices.subarray(0, ii);

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

  /**
   * 经度归一到 [-180,180]，处理跨反子午线时 lon 超出 ±180 的情况。
   *
   * @param lonDeg 可能越界的经度
   */
  private static wrapLon(lonDeg: number): number {
    let lon = ((lonDeg + 180) % 360 + 360) % 360 - 180;
    if (lon === -180) lon = 180;
    return lon;
  }

  /** 隐藏/显示当前线格网（不重建）。 */
  public setVisible(visible: boolean): void {
    if (this.current) this.current.show = visible;
  }

  /** 清空（移除当前 Primitive，但控制器仍可再次 rebuild）。 */
  public clear(): void {
    if (this.current) {
      this.scene_primitives.remove(this.current);
      this.current = undefined;
    }
  }

  /** 是否已销毁。 */
  public isDestroyed(): boolean {
    return this.destroyed;
  }

  /** 彻底销毁：移除 Primitive、释放引用。 */
  public destroy(): void {
    if (this.destroyed) return;
    this.clear();
    this.destroyed = true;
  }
}
