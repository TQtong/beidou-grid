// ============================================================
// BeiDouGridScene.ts — 北斗空域网格渲染编排器（对外主类）
// 层级：L4（渲染层门面 / 编排）
// 职责：订阅相机停稳与每帧事件；调度「选级别 → 解析区域 → 预算降级 → 剖分 →
//       重建 线格网/标注/(可选)满填充 + 刷新飞行器隔离」全链路；rAF 防抖；公开 API。
// 依赖：cesium（Scene/Rectangle/PrimitiveCollection/Event 句柄/Color/Math）、
//       ScaleLevelSelector / ViewRegionResolver / GridTessellator /
//       GridLinePrimitive / GridFillPrimitive / GridInstancedFill /
//       GridLabelPrimitive / AirspaceIsolator / 极区分支 / render-constants。
// 被消费：应用层（app/index.ts、App.vue）。
// 线格网 vs 其它：线格网用更宽的 maxLatticeCells（线数=nx+ny，远小于格数）；
//                标注/满填充用 maxCells 约束（影响真实绘制量）。
// ============================================================

import {
  Cartographic,
  Color,
  Math as CesiumMath,
  NearFarScalar,
  Rectangle,
  sampleTerrainMostDetailed,
  type Scene,
} from 'cesium';

import ScaleLevelSelector, { type LevelPxConfig } from './level/ScaleLevelSelector';
import ViewRegionResolver, { type RegionResult } from './region/ViewRegionResolver';
import GridTessellator, { type HeightRange, type Tessellation } from './grid/GridTessellator';
import PolarGridTessellator from './grid/PolarGridTessellator';
import GridLinePrimitive from './primitive/GridLinePrimitive';
import GridFillPrimitive from './primitive/GridFillPrimitive';
import GridInstancedFill, { type OccupancyColoring } from './primitive/GridInstancedFill';
import GridLabelPrimitive from './primitive/GridLabelPrimitive';
import PolarGridLinePrimitive from './primitive/PolarGridLinePrimitive';
import AirspaceIsolator, { type Aircraft } from './isolation/AirspaceIsolator';
import GeoJsonBoundaryLoader, {
  type BoundaryLoadResult,
  type BoundaryStyle,
} from './loader/GeoJsonBoundaryLoader';
import { POLAR_LIMIT_DEG, RENDER_DEFAULTS } from './render-constants';

/** 公开配置。所有字段可选，未给走 RENDER_DEFAULTS。 */
export interface BeiDouGridConfig {
  /** 选级别像素区间。 */
  levelPx?: LevelPxConfig;
  /** 标注/满填充格数预算（超则级别降级）。 */
  maxCells?: number;
  /** 线格网格数预算（更宽，线数 = nx+ny）。 */
  maxLatticeCells?: number;
  /** 标注数量封顶。 */
  maxLabels?: number;
  /** 高度区间（航空空域层）。默认 {min:0,max:20000,step:1000}。 */
  heightRange?: HeightRange;
  /** 线颜色。 */
  lineColor?: Color;
  /** 线宽（像素）。 */
  lineWidth?: number;
  /** 标注用三维码（含高度）；默认 false（二维码）。 */
  labelUse3D?: boolean;
  /** 隔离固定级别（不传 = 跟随显示级别）。 */
  isolationLevel?: number;
  /** 隔离缓冲环（格数），默认 0。 */
  bufferRing?: number;
  /** 隔离本格高亮色。 */
  isolationColor?: Color;
  /** 隔离缓冲环色。 */
  bufferColor?: Color;
  /** 隔离边界滞回帧数，默认 3。 */
  dwellFrames?: number;
  /** 是否开启满填充（GPU 实例化）。默认 false。 */
  enableInstancedFill?: boolean;
  /**
   * 网格线是否贴地（terrain-clamp）。默认 true：用 GroundPolylinePrimitive，
   * 网格随地形起伏。设为 false 可看到多高度层 + 层间竖向边的 3D 立体网格。
   */
  clampGridToGround?: boolean;
}

/** 解析后的内部配置（字段全部填齐）。 */
interface ResolvedConfig {
  levelPx: LevelPxConfig;
  maxCells: number;
  maxLatticeCells: number;
  maxLabels: number;
  heightRange: HeightRange;
  lineColor: Color;
  lineWidth: number;
  labelUse3D: boolean;
  isolationLevel?: number;
  bufferRing: number;
  isolationColor: Color;
  bufferColor: Color;
  dwellFrames: number;
  enableInstancedFill: boolean;
  clampGridToGround: boolean;
}

export default class BeiDouGridScene {
  private readonly scene: Scene;
  private readonly cfg: ResolvedConfig;

  private readonly linePrimitive: GridLinePrimitive;
  private readonly labelPrimitive: GridLabelPrimitive;
  private readonly fillPrimitive: GridFillPrimitive;
  private readonly polarLineNorth: PolarGridLinePrimitive;
  private readonly polarLineSouth: PolarGridLinePrimitive;
  private readonly isolator: AirspaceIsolator;
  private readonly instancedFill?: GridInstancedFill;
  private readonly boundaryLoader: GeoJsonBoundaryLoader;

  /** 当前显示级别（最近一次 rebuild 选定）。 */
  private activeLevel = 1;
  /** 手动锁定级别（覆盖比例尺自动选级）；undefined = 自动。 */
  private levelOverride: number | undefined;

  /** 给定范围（约束区域）；undefined = 仅用可视范围。 */
  private given: Rectangle | undefined;
  /** 飞行器位置；undefined = 无飞行器隔离。 */
  private aircraft: Aircraft | undefined;
  /** 单点查询模式：true 时 preUpdate 不刷飞行器（避免覆盖单点高亮）。 */
  private pointQueryMode = false;

  /** 占用着色（满填充用）；undefined = 不更新满填充颜色。 */
  private occupancy: OccupancyColoring | undefined;

  /**
   * 地形基准高度（米）：当前渲染区域中心的地形高度。
   * 用于「贴地 3D 网格」——所有高度层 + 隔离盒都上抬这个高度，使底面落在地表上，
   * 同时保留 heightRange 内的 3D 立体感（多层 + 层间竖边 + 盒子高度）。
   * 由 sampleTerrainMostDetailed 异步刷新；首帧未就绪时为 0（落在 WGS84 椭球面上）。
   */
  private terrainBaseHeight = 0;
  /** 上次采样的区域中心（弧度），用于判断是否需要重新采样。 */
  private lastSampledCenter: { lon: number; lat: number } | undefined;
  /** 地形采样进行中标志，防并发重复请求。 */
  private terrainSampling = false;

  /** rAF 防抖标记。 */
  private rafPending = false;
  /** 已销毁标记。 */
  private destroyed = false;

  /** 事件解绑句柄。 */
  private readonly removeMoveEnd: () => void;
  private readonly removePreUpdate: () => void;

  /**
   * @param scene Cesium 场景（来自 viewer.scene）
   * @param cfg   配置（可选）
   */
  public constructor(scene: Scene, cfg?: BeiDouGridConfig) {
    this.scene = scene;
    this.cfg = BeiDouGridScene.resolveConfig(cfg);

    const primitives = scene.primitives;
    this.linePrimitive = new GridLinePrimitive(primitives);
    this.labelPrimitive = new GridLabelPrimitive(primitives);
    this.fillPrimitive = new GridFillPrimitive(primitives);
    this.polarLineNorth = new PolarGridLinePrimitive(primitives);
    this.polarLineSouth = new PolarGridLinePrimitive(primitives);
    this.boundaryLoader = new GeoJsonBoundaryLoader(primitives);
    this.isolator = new AirspaceIsolator(this.fillPrimitive, {
      isolationLevel: this.cfg.isolationLevel,
      bufferRing: this.cfg.bufferRing,
      centerColor: this.cfg.isolationColor,
      bufferColor: this.cfg.bufferColor,
      dwellFrames: this.cfg.dwellFrames,
      // terrainBaseHeight 由每次 rebuild 调用 isolator.setTerrainBaseHeight 更新；构造时 0。
      terrainBaseHeight: 0,
    });

    if (this.cfg.enableInstancedFill) {
      this.instancedFill = new GridInstancedFill(1.0);
      // 自定义 Primitive：加入集合后 Cesium 每帧调其 update(frameState)。
      primitives.add(this.instancedFill);
    }

    // 相机停稳 → 重建（拖动中不重建，避免抖动）。
    this.removeMoveEnd = scene.camera.moveEnd.addEventListener(() => this.schedule());
    // 每帧 → 刷新飞行器隔离（跨格才真正重建，开销恒定）。
    this.removePreUpdate = scene.preUpdate.addEventListener(() => this.tickAircraft());

    // 首次构建。
    this.schedule();
  }

  /**
   * 解析配置，未给字段填 RENDER_DEFAULTS。
   *
   * @param cfg 用户配置
   */
  private static resolveConfig(cfg?: BeiDouGridConfig): ResolvedConfig {
    const d = RENDER_DEFAULTS;
    return {
      levelPx: cfg?.levelPx ?? { ...d.levelPx },
      maxCells: cfg?.maxCells ?? d.maxCells,
      maxLatticeCells: cfg?.maxLatticeCells ?? d.maxLatticeCells,
      maxLabels: cfg?.maxLabels ?? d.maxLabels,
      heightRange: cfg?.heightRange ?? { min: 0, max: 20000, step: 1000 },
      lineColor: cfg?.lineColor ?? d.lineColor,
      lineWidth: cfg?.lineWidth ?? 1.0,
      labelUse3D: cfg?.labelUse3D ?? false,
      isolationLevel: cfg?.isolationLevel,
      bufferRing: cfg?.bufferRing ?? 0,
      isolationColor: cfg?.isolationColor ?? d.isolationColor,
      bufferColor: cfg?.bufferColor ?? d.bufferColor,
      dwellFrames: cfg?.dwellFrames ?? 3,
      enableInstancedFill: cfg?.enableInstancedFill ?? false,
      clampGridToGround: cfg?.clampGridToGround ?? true,
    };
  }

  /**
   * 设给定范围（约束渲染区域 = 可视 ∩ 给定）。传 undefined 取消约束（仅用可视范围）。
   *
   * @param rect 给定矩形（弧度 Cesium.Rectangle）或 undefined
   */
  public setGivenRange(rect?: Rectangle): void {
    this.given = rect ? Rectangle.clone(rect) : undefined;
    this.schedule();
  }

  /** 清除给定范围（等价 setGivenRange(undefined)）。 */
  public clearGivenRange(): void {
    this.given = undefined;
    this.schedule();
  }

  /**
   * 设飞行器实时位置（驱动隔离层）。退出单点查询模式。
   *
   * @param ac 飞行器位置
   */
  public setAircraft(ac: Aircraft): void {
    this.aircraft = { lon: ac.lon, lat: ac.lat, height: ac.height };
    this.pointQueryMode = false;
    // 立即刷新一次（不等下一帧），降低延迟感。
    if (!this.destroyed) this.isolator.refresh(this.aircraft, this.activeLevel);
  }

  /** 清除飞行器（停止隔离跟踪）。 */
  public clearAircraft(): void {
    this.aircraft = undefined;
    this.isolator.clear();
  }

  /**
   * R1：给定经纬度 + 高度 + 级别，绘制点所在网格（单点查询，独立于飞行器隔离）。
   * 进入单点查询模式：preUpdate 不再刷飞行器，避免覆盖该高亮。
   *
   * @param lon    经度（度）
   * @param lat    纬度（度）
   * @param height 高度（米）
   * @param level  级别（1..10）
   */
  public drawPointGrid(lon: number, lat: number, height: number, level: number): void {
    this.pointQueryMode = true;
    this.aircraft = undefined;
    this.isolator.drawPointGrid(lon, lat, height, level);
  }

  /**
   * 手动锁定显示级别（覆盖比例尺自动选级）；传 undefined 恢复自动。
   *
   * @param level 级别（1..10）或 undefined
   */
  public setActiveLevelOverride(level?: number): void {
    this.levelOverride = level === undefined ? undefined : CesiumMath.clamp(Math.round(level), 1, 10);
    this.schedule();
  }

  /** 当前生效的显示级别（最近一次 rebuild 选定，可能由预算降级修改）。 */
  public getActiveLevel(): number {
    return this.activeLevel;
  }

  /**
   * 设占用着色（满填充用）。仅在 enableInstancedFill 时生效；触发重建。
   *
   * @param coloring 类别数组 + 调色板
   */
  public setOccupancy(coloring: OccupancyColoring): void {
    this.occupancy = coloring;
    this.schedule();
  }

  /** 强制重建（合并到下一帧）。 */
  public refresh(): void {
    this.schedule();
  }

  /**
   * 异步加载 GeoJSON 行政区/区域边界并渲染（贴地折线，单 Primitive 批渲染）。
   * 与北斗格网层平行；不影响选级别 / 区域解析。
   *
   * @param url   GeoJSON URL
   * @param style 边界外观（颜色 / 线宽）
   * @returns     加载结果摘要（含 ring 数与 bbox）
   */
  public loadBoundaryFromUrl(url: string, style?: Partial<BoundaryStyle>): Promise<BoundaryLoadResult> {
    const resolved: BoundaryStyle = {
      color: style?.color ?? Color.fromCssColorString('#ffd400').withAlpha(0.95),
      width: style?.width ?? 3,
    };
    return this.boundaryLoader.loadFromUrl(url, resolved);
  }

  /** 设边界图层可见性。 */
  public setBoundaryVisible(visible: boolean): void {
    this.boundaryLoader.setVisible(visible);
  }

  /** 清空边界图层。 */
  public clearBoundary(): void {
    this.boundaryLoader.clear();
  }

  /**
   * rAF 防抖：合并一帧内多次触发，仅在下一动画帧执行一次 rebuild。
   */
  private schedule(): void {
    if (this.destroyed || this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      if (!this.destroyed) this.rebuild();
    });
  }

  /**
   * 全链路重建：选级别 → 解析区域 → 预算降级 → 剖分 → 重建三层 + 刷隔离。
   */
  private rebuild(): void {
    // 1) 解析区域（可视 ∩ 给定）。无区域（看天/空交集）→ 清空。
    const region = ViewRegionResolver.resolveRegion(this.scene, this.given);
    if (!region) {
      this.clearRenderLayers();
      return;
    }

    // 2) 选级别：手动锁优先，否则比例尺自动。
    const autoPick = ScaleLevelSelector.pickLevel(this.scene, this.cfg.levelPx);
    const desiredLevel = this.levelOverride ?? autoPick.level;

    // 3) 预算降级：仅在自动模式下生效。
    //    手动锁定时尊重用户选择（即便会很多格）——降级会让锁失效（5→3→1），违反用户意图。
    //    自动模式按标注/满填充预算约束级别（线格网更宽，单独判定）。
    let level: number;
    if (this.levelOverride !== undefined) {
      level = desiredLevel;
    } else {
      const zPlanesGuess = Math.max(1, Math.ceil((this.cfg.heightRange.max - this.cfg.heightRange.min) /
        (this.cfg.heightRange.step > 0 ? this.cfg.heightRange.step : 1)));
      level = ViewRegionResolver.clampLevelByBudget(region, desiredLevel, zPlanesGuess, this.cfg.maxCells);
    }
    this.activeLevel = level;

    // 4) 剖分（中低纬，南北已夹到 ±88°）。贴地模式下，把 heightRange 整体上抬到 terrainBaseHeight，
    //    使三维网格的底面落在地形面、顶面继续向上延伸（保留高度立体感）。
    const effectiveHeightRange = this.cfg.clampGridToGround
      ? {
          min: this.cfg.heightRange.min + this.terrainBaseHeight,
          max: this.cfg.heightRange.max + this.terrainBaseHeight,
          step: this.cfg.heightRange.step,
        }
      : this.cfg.heightRange;
    const t: Tessellation = GridTessellator.tessellate(region, level, effectiveHeightRange);

    // 异步采样区域中心地形高度，更新后下次 rebuild 会用新值（贴地更精确）。
    if (this.cfg.clampGridToGround) {
      this.scheduleTerrainSample(region);
    }

    // 把当前 terrainBaseHeight 传给隔离器（贴地模式下盒底跟着地形）。
    this.isolator.setTerrainBaseHeight(this.cfg.clampGridToGround ? this.terrainBaseHeight : 0);

    // 5) 线格网（主力）。线数远小于格数，即便超 maxCells 也安全；用 maxLatticeCells 兜底极端值。
    const latticeCells = t.nx * t.ny * Math.max(1, t.zPlaneFloors.length);
    if (latticeCells <= this.cfg.maxLatticeCells) {
      this.linePrimitive.rebuild(t, {
        color: this.cfg.lineColor,
        lineWidth: this.cfg.lineWidth,
        drawVerticalEdges: t.zPlaneFloors.length > 1,
      });
    } else {
      // 极端：连线格网都超宽（理论罕见），清空线层以防卡顿。
      this.linePrimitive.clear();
    }

    // 6) 标注（封顶）。
    this.labelPrimitive.rebuild(t, {
      maxLabels: this.cfg.maxLabels,
      use3D: this.cfg.labelUse3D,
      zPlaneIndex: 0,
      fillColor: Color.WHITE,
      scaleByDistance: new NearFarScalar(1.0e3, 1.0, 5.0e6, 0.4),
    });

    // 7) 满填充（可选）。
    if (this.instancedFill && this.occupancy) {
      // 占用类别数组长度须匹配 nx·ny·planes；不匹配则跳过（由调用方保证一致性）。
      const expected = t.nx * t.ny * t.zPlaneFloors.length;
      if (this.occupancy.categories.length >= expected) {
        this.instancedFill.rebuild(t, this.occupancy);
      }
    }

    // 8) 极区收敛格（区域触及 ±88° 时启用，与中低纬无缝拼接）。
    this.rebuildPolar(region, level, t);

    // 9) 飞行器隔离 / 单点查询（单点模式下不被覆盖）。
    if (!this.pointQueryMode && this.aircraft) {
      this.isolator.refresh(this.aircraft, level);
    }
  }

  /**
   * 极区分支：区域触及 ±88° 时各自渲染极冠收敛格；否则清空。
   *
   * @param region 渲染区域
   * @param level  级别
   * @param t      中低纬剖分（用其高度层与 lineColor 配置）
   */
  private rebuildPolar(region: RegionResult, level: number, t: Tessellation): void {
    const northDeg = CesiumMath.toDegrees(region.rectangle.north);
    const southDeg = CesiumMath.toDegrees(region.rectangle.south);

    // 极区线沿用同样配置（保留竖边）。
    const polarVertical = t.zPlaneFloors.length > 1;
    if (northDeg >= POLAR_LIMIT_DEG) {
      const pt = PolarGridTessellator.tessellate('N', level, t.zPlaneFloors, t.heightStep);
      this.polarLineNorth.rebuild(pt, {
        color: this.cfg.lineColor,
        lineWidth: this.cfg.lineWidth,
        drawVerticalEdges: polarVertical,
      });
    } else {
      this.polarLineNorth.clear();
    }
    if (southDeg <= -POLAR_LIMIT_DEG) {
      const pt = PolarGridTessellator.tessellate('S', level, t.zPlaneFloors, t.heightStep);
      this.polarLineSouth.rebuild(pt, {
        color: this.cfg.lineColor,
        lineWidth: this.cfg.lineWidth,
        drawVerticalEdges: polarVertical,
      });
    } else {
      this.polarLineSouth.clear();
    }
  }

  /**
   * 异步采样区域中心地形高度。结果回写到 terrainBaseHeight，下次 rebuild 生效。
   *
   * 策略：① 优先 scene.globe.getHeight（已加载瓦片即时返回，最快）；
   *       ② 否则 sampleTerrainMostDetailed（异步拉取瓦片，精确）。
   *       ③ 区域中心未明显变化时不重复采样。
   *
   * @param region 当前渲染区域
   */
  private scheduleTerrainSample(region: RegionResult): void {
    const lonRad = (region.rectangle.west + region.rectangle.east) / 2;
    const latRad = (region.rectangle.south + region.rectangle.north) / 2;

    // 同区域附近（< ~1km 等同）不重复采样。
    const last = this.lastSampledCenter;
    if (last && Math.abs(last.lon - lonRad) < 1e-5 && Math.abs(last.lat - latRad) < 1e-5) {
      return;
    }

    // 先用已加载瓦片即时取值。
    const carto = new Cartographic(lonRad, latRad, 0);
    const immediate = this.scene.globe.getHeight(carto);
    if (typeof immediate === 'number' && Number.isFinite(immediate)) {
      this.applyTerrainBase(immediate, lonRad, latRad);
      return;
    }

    if (this.terrainSampling) return;
    const provider = this.scene.terrainProvider;
    if (!provider) return;

    this.terrainSampling = true;
    sampleTerrainMostDetailed(provider, [new Cartographic(lonRad, latRad, 0)])
      .then((results) => {
        this.terrainSampling = false;
        if (this.destroyed) return;
        const h = results[0]?.height;
        if (typeof h === 'number' && Number.isFinite(h)) {
          this.applyTerrainBase(h, lonRad, latRad);
        }
      })
      .catch(() => {
        this.terrainSampling = false;
      });
  }

  /** 写回 terrainBaseHeight 并触发一次 rebuild（应用新基准）。 */
  private applyTerrainBase(h: number, lonRad: number, latRad: number): void {
    if (Math.abs(this.terrainBaseHeight - h) < 0.5) {
      // < 0.5m 抖动不触发重建。
      this.lastSampledCenter = { lon: lonRad, lat: latRad };
      return;
    }
    this.terrainBaseHeight = h;
    this.lastSampledCenter = { lon: lonRad, lat: latRad };
    this.schedule();
  }

  /**
   * 每帧刷新飞行器隔离（跨格才重建）。单点查询模式下跳过。
   */
  private tickAircraft(): void {
    if (this.destroyed || this.pointQueryMode || !this.aircraft) return;
    this.isolator.refresh(this.aircraft, this.activeLevel);
  }

  /** 清空所有渲染层（区域无效时）。 */
  private clearRenderLayers(): void {
    this.linePrimitive.clear();
    this.labelPrimitive.clear();
    this.polarLineNorth.clear();
    this.polarLineSouth.clear();
    // 隔离/满填充保留（飞行器可能仍在视野外但需追踪）；如需一并清空可在此调用。
  }

  /**
   * 销毁：解绑事件、销毁所有 Primitive 控制器。
   */
  public dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.removeMoveEnd();
    this.removePreUpdate();
    this.linePrimitive.destroy();
    this.labelPrimitive.destroy();
    this.fillPrimitive.destroy();
    this.polarLineNorth.destroy();
    this.polarLineSouth.destroy();
    this.boundaryLoader.destroy();
    if (this.instancedFill) {
      // 从 primitives 集合移除会触发其 destroy()。
      this.scene.primitives.remove(this.instancedFill);
    }
  }
}
