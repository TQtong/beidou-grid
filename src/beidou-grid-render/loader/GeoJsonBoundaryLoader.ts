// ============================================================
// GeoJsonBoundaryLoader.ts — 行政区/区域 GeoJSON 边界加载与 Primitive 渲染
// 层级：L3（渲染层，独立 Primitive 控制器；与北斗格网层平行）
// 职责：从 URL 拉取 GeoJSON（FeatureCollection / Feature / Polygon / MultiPolygon），
//       把每个外/内环转换为 Cesium GroundPolylinePrimitive（贴地折线），单 Primitive 批渲染。
// 设计契合：与北斗格网层一致——零 viewer.entities，全部 scene.primitives；
//           双缓冲 rebuild、destroy 释放 GPU 资源。
// 依赖：cesium（GroundPolylinePrimitive/PolylineGeometry/GeometryInstance/Color/...）。
// 被消费：BeiDouGridScene.loadBoundary / app/index.ts。
// ============================================================

import {
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  GroundPolylinePrimitive,
  GroundPolylineGeometry,
  PolylineColorAppearance,
  Rectangle,
  type PrimitiveCollection,
} from 'cesium';

/** GeoJSON 边界外观参数。 */
export interface BoundaryStyle {
  /** 边界线颜色。 */
  color: Color;
  /** 线宽（像素）。 */
  width: number;
}

/** 加载结果摘要。 */
export interface BoundaryLoadResult {
  /** 加载到的 ring 数（外环+内环总和）。 */
  ringCount: number;
  /** 计算得到的全部坐标的经纬度 bbox（弧度 Rectangle）。可用于 setGivenRange。 */
  bounds?: Rectangle;
  /** 估算总顶点数（仅用于诊断）。 */
  vertexCount: number;
}

/** 简化的 GeoJSON 类型（避免引入额外依赖）。 */
interface GeoJsonGeometry {
  type: string;
  // Point: [lon,lat]; LineString: [[lon,lat],...]; Polygon: [[[lon,lat],...], ...];
  // MultiPolygon: [[[[lon,lat],...], ...], ...]
  coordinates: unknown;
}
interface GeoJsonFeature {
  type: 'Feature';
  geometry: GeoJsonGeometry;
  properties?: Record<string, unknown>;
}
interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}
type AnyGeoJson = GeoJsonGeometry | GeoJsonFeature | GeoJsonFeatureCollection;

export default class GeoJsonBoundaryLoader {
  private readonly primitives: PrimitiveCollection;
  private current: GroundPolylinePrimitive | undefined;
  private destroyed = false;

  public constructor(primitives: PrimitiveCollection) {
    this.primitives = primitives;
  }

  /**
   * 从 URL 异步加载 GeoJSON 并渲染（双缓冲）。
   *
   * @param url   GeoJSON 资源 URL
   * @param style 边界外观
   * @returns 加载结果摘要
   */
  public async loadFromUrl(url: string, style: BoundaryStyle): Promise<BoundaryLoadResult> {
    const resp = await fetch(url, { mode: 'cors' });
    if (!resp.ok) {
      throw new Error(`Failed to fetch GeoJSON: ${resp.status} ${resp.statusText}`);
    }
    const json = (await resp.json()) as AnyGeoJson;
    return this.loadFromObject(json, style);
  }

  /**
   * 用已解析的 GeoJSON 对象渲染。
   *
   * @param json  GeoJSON 对象（Geometry / Feature / FeatureCollection）
   * @param style 边界外观
   */
  public loadFromObject(json: AnyGeoJson, style: BoundaryStyle): BoundaryLoadResult {
    if (this.destroyed) {
      return { ringCount: 0, vertexCount: 0 };
    }

    // 1) 收集所有 ring（Cartesian3 数组，已贴地高度）。
    const rings: Cartesian3[][] = [];
    let minLonDeg = Infinity, maxLonDeg = -Infinity;
    let minLatDeg = Infinity, maxLatDeg = -Infinity;
    let vertexCount = 0;

    const pushRing = (ring2D: number[][]) => {
      if (!ring2D || ring2D.length < 2) return;
      const pts: Cartesian3[] = new Array(ring2D.length);
      for (let i = 0; i < ring2D.length; i++) {
        const c = ring2D[i]!;
        const lon = Number(c[0]);
        const lat = Number(c[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        pts[i] = Cartesian3.fromDegrees(lon, lat, 0);
        if (lon < minLonDeg) minLonDeg = lon;
        if (lon > maxLonDeg) maxLonDeg = lon;
        if (lat < minLatDeg) minLatDeg = lat;
        if (lat > maxLatDeg) maxLatDeg = lat;
      }
      // 确保闭合（首尾相连，便于线连贯）。
      if (pts.length >= 2 && !Cartesian3.equals(pts[0]!, pts[pts.length - 1]!)) {
        pts.push(Cartesian3.clone(pts[0]!));
      }
      vertexCount += pts.length;
      rings.push(pts);
    };

    const consumeGeometry = (geom: GeoJsonGeometry | undefined): void => {
      if (!geom || !geom.coordinates) return;
      const t = geom.type;
      const co = geom.coordinates;
      switch (t) {
        case 'Polygon': {
          // co: [[[lon,lat],...], ...]
          const polygon = co as number[][][];
          for (const ring of polygon) pushRing(ring);
          break;
        }
        case 'MultiPolygon': {
          // co: [[[[lon,lat],...], ...], ...]
          const multi = co as number[][][][];
          for (const polygon of multi) {
            for (const ring of polygon) pushRing(ring);
          }
          break;
        }
        case 'LineString': {
          pushRing(co as number[][]);
          break;
        }
        case 'MultiLineString': {
          const multi = co as number[][][];
          for (const ls of multi) pushRing(ls);
          break;
        }
        case 'GeometryCollection': {
          const gs = (geom as unknown as { geometries: GeoJsonGeometry[] }).geometries;
          if (gs) for (const g of gs) consumeGeometry(g);
          break;
        }
        // Point / MultiPoint 不画边界，忽略。
        default:
          break;
      }
    };

    const consumeAny = (obj: AnyGeoJson): void => {
      if (!obj || typeof obj !== 'object') return;
      const type = (obj as { type?: string }).type;
      if (type === 'FeatureCollection') {
        for (const f of (obj as GeoJsonFeatureCollection).features ?? []) {
          consumeGeometry(f.geometry);
        }
      } else if (type === 'Feature') {
        consumeGeometry((obj as GeoJsonFeature).geometry);
      } else {
        consumeGeometry(obj as GeoJsonGeometry);
      }
    };

    consumeAny(json);

    // 2) 构造 GeometryInstance（每个 ring 一条贴地折线，颜色统一）。
    const colorAttr = ColorGeometryInstanceAttribute.fromColor(style.color);
    const instances: GeometryInstance[] = rings.map((positions) => new GeometryInstance({
      geometry: new GroundPolylineGeometry({
        positions,
        width: Math.max(1, style.width),
      }),
      attributes: { color: colorAttr },
    }));

    // 3) 双缓冲：先 add 新、后 remove 旧。
    if (instances.length > 0) {
      const primitive = new GroundPolylinePrimitive({
        geometryInstances: instances,
        appearance: new PolylineColorAppearance(),
        asynchronous: false,
        releaseGeometryInstances: true,
      });
      const old = this.current;
      this.primitives.add(primitive);
      this.current = primitive;
      if (old) this.primitives.remove(old);
    } else {
      this.clear();
    }

    // 4) 返回 bbox。
    let bounds: Rectangle | undefined;
    if (Number.isFinite(minLonDeg)) {
      bounds = Rectangle.fromDegrees(minLonDeg, minLatDeg, maxLonDeg, maxLatDeg);
    }

    return { ringCount: rings.length, vertexCount, bounds };
  }

  /** 显示/隐藏。 */
  public setVisible(visible: boolean): void {
    if (this.current) this.current.show = visible;
  }

  /** 清空（保留控制器以便再次 load）。 */
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

  /** 销毁：清空 + 释放引用。 */
  public destroy(): void {
    if (this.destroyed) return;
    this.clear();
    this.destroyed = true;
  }
}
