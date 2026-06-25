// ============================================================
// BeiDouFieldScene.ts — 北斗立方体场渲染编排器（重设计后对外主类）
// 层级：L4（渲染层门面 / 编排）
// 职责：统一驱动「重设计」三需求：
//   ① 网格线 + 每立方体渲染（默认线框，可切填充，点击改色）—— 由 GridCubeField 承载；
//   ② 随地图比例尺动态调整北斗网格等级 —— moveEnd 后按比例尺选级 + 预算降级；
//   ③ 模拟无人机低空飞行并标记周边受影响立方体 —— 由 DroneController 承载并透传。
// 编排链路（相机停稳触发，rAF 防抖）：
//   解析区域(可视∩给定) → 选级别(自动/锁定) → 预算降级 → 剖分 → field.setTessellation。
// 交互：在场景画布上装 LEFT_CLICK 监听 → field.requestPick（拾取与改色在场内完成）。
// 依赖：cesium（Scene/Viewer/Rectangle/Event 句柄/ScreenSpaceEventHandler/Math）、
//       GridCubeField / DroneController / ScaleLevelSelector / ViewRegionResolver / GridTessellator /
//       render-constants。
// 被消费：应用层（app/index.ts、App.vue）。
// 注：构造传 Viewer（非仅 Scene）——DroneController 需要 entities 承载机体/尾迹。
// ============================================================

import {
  Cartographic,
  Rectangle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Math as CesiumMath,
  sampleTerrainMostDetailed,
  type Scene,
  type Viewer,
} from 'cesium';

import GridCubeField, { type FieldMode } from '../core/GridCubeField';
import DroneController from './DroneController';
import ScaleLevelSelector, { type LevelPxConfig } from '../level/ScaleLevelSelector';
import ViewRegionResolver, { type RegionResult } from '../region/ViewRegionResolver';
import GridTessellator, { type HeightRange, type Tessellation } from '../grid/GridTessellator';
import { RENDER_DEFAULTS, levelSizeMeters } from '../render-constants';

/** 赤道每度米长（纬向恒定近似；与 GridCubeField/DroneController 一致）。 */
const METERS_PER_DEG_LAT = 111320.0;

/**
 * 贴地渲染窗口的最大半跨（米）。
 * 立方体场是「区域原点 ENU 切平面」上的一整片平板：区域越大，平板因地球曲率
 * 越偏离地表，远端会抬升「漂浮」（半跨 d 处抬升 ≈ d²/2R）。半跨 7km 时曲率抬升
 * 仅 ≈3.8m（远小于层高），故把渲染区域收敛到「视点为中心」的此尺度窗口，保证贴地。
 */
const MAX_GROUND_HALF_SPAN_METERS = 7000;

/** 地形高程采样网格边数（N×N 个采样点覆盖窗口，求地形 min/max）。 */
const GROUND_SAMPLE_GRID: number = 7;

/**
 * 立方体场底面在采样最低地形下再下探的余量（米）。
 * 保证窗口内每一列的底面都不高于其脚下地形（粗采样点之间的洼地也被覆盖），
 * 从而靠地形深度遮挡裁掉地下部分、无悬空；代价是多一层左右被埋的立方体。
 */
const GROUND_BASE_MARGIN_METERS = 120;

/** 公开配置。所有字段可选，未给走默认。 */
export interface BeiDouFieldConfig {
  /** 选级别像素区间（单格屏幕尺寸目标区间）。 */
  levelPx?: LevelPxConfig;
  /** 格数预算（自动模式超此值则级别变粗，防一次绘制过多立方体）。 */
  maxCells?: number;
  /**
   * 高度区间（低空空域立方体层）。默认 { min: 0, max: 600, step: 120 }：
   * 固定 5 层、每层 120m——层数有界，规避「step 依赖级别」的鸡生蛋问题，
   * 且低空无人机（约 50–400m）恰落在层内。step 必须 > 0。
   */
  heightRange?: HeightRange;
  /**
   * 静态网格锚点中心经度（度）。给定后网格固定贴在此处一片范围上，相机倾斜/远近/
   * 平移都不重算；不给则首帧从相机视图取一次中心并冻结。
   */
  anchorLonDeg?: number;
  /** 静态网格锚点中心纬度（度）。见 anchorLonDeg。 */
  anchorLatDeg?: number;
}

/** 解析后的内部配置（字段全部填齐，anchor 可空表示首帧从视图取）。 */
interface ResolvedConfig {
  levelPx: LevelPxConfig;
  maxCells: number;
  heightRange: HeightRange;
  anchorLonDeg: number | undefined;
  anchorLatDeg: number | undefined;
}

export default class BeiDouFieldScene {
  /** Cesium 场景（= viewer.scene）。 */
  private readonly scene: Scene;
  /** 解析后的配置。 */
  private readonly cfg: ResolvedConfig;

  /** 统一实例化立方体场（承载需求①）。 */
  private readonly field: GridCubeField;
  /** 无人机飞行控制器（承载需求③）。 */
  private readonly drone: DroneController;

  /** 当前生效的显示级别（最近一次 rebuild 选定，可能被预算降级修改）。 */
  private activeLevel = 1;
  /** 手动锁定级别（覆盖比例尺自动选级）；undefined = 自动（承载需求②的手动旁路）。 */
  private levelOverride: number | undefined;
  /** 给定范围（约束区域 = 可视 ∩ 给定）；undefined = 仅用可视范围。 */
  private given: Rectangle | undefined;

  /** 窗口内地形最低高（米，立方体场底面基准）；未采样时 0（椭球面），异步采样后修正。 */
  private groundMinMeters = 0;
  /** 窗口内地形最高高（米，立方体场顶面 = 此 + 空域厚度）。 */
  private groundMaxMeters = 600;
  /** 窗口内地形平均高（米，喂无人机作离地基准）。 */
  private groundCenterMeters = 0;
  /** 地面采样令牌（异步乱序丢弃用：仅最新一次结果生效）。 */
  private groundSampleSeq = 0;
  /** 上次已采样的「地形提供方|窗口矩形」键（去重，避免同窗口重复采样导致回环）。 */
  private groundSampledKey = '';
  /** 上次采样所用地形提供方（变化时强制重采样：椭球面→世界地形）。 */
  private lastTerrainProvider: unknown;

  /**
   * 网格锚点中心（度）——仅首帧从视图取一次，之后冻结。
   * 静态网格的核心：网格固定贴在这片地理范围上，相机倾斜/远近/平移都不重算。
   */
  private frozenCenterLonDeg: number | undefined;
  private frozenCenterLatDeg: number | undefined;
  /** 自动模式下首帧按比例尺选定并冻结的级别（手动锁定时不用）。 */
  private frozenAutoLevel: number | undefined;

  /** rAF 防抖标记。 */
  private rafPending = false;
  private destroyed = false;

  /** 左键点击拾取事件句柄。 */
  private readonly clickHandler: ScreenSpaceEventHandler;

  /**
   * @param viewer Cesium Viewer（来自应用层；其 scene 用于渲染，其 entities 用于无人机）
   * @param cfg    配置（可选）
   */
  public constructor(viewer: Viewer, cfg?: BeiDouFieldConfig) {
    this.scene = viewer.scene;
    this.cfg = BeiDouFieldScene.resolveConfig(cfg);

    // 立方体场：加入 primitives 集合后，Cesium 每帧自动调用 field.update(frameState)。
    this.field = new GridCubeField(this.scene);
    this.scene.primitives.add(this.field);

    // 无人机控制器。
    this.drone = new DroneController(viewer, this.field);

    // 静态网格：不再监听相机停稳 / 瓦片加载——倾斜、缩放、平移都不重算网格。
    // 网格仅在首帧构建一次，之后只由显式操作（改级别 / 改区域 / 刷新）或地形异步
    // 采样到位（贴地一次性纠正）触发重建，锚点中心始终冻结不变。

    // 左键点击 → 请求拾取（拾取/改色在 field 内于下一帧执行）——需求①点击改色入口。
    this.clickHandler = new ScreenSpaceEventHandler(this.scene.canvas);
    this.clickHandler.setInputAction((movement: ScreenSpaceEventHandler.PositionedEvent) => {
      if (this.destroyed) return;
      this.field.requestPick(movement.position.x, movement.position.y);
    }, ScreenSpaceEventType.LEFT_CLICK);

    // 首次构建。
    this.schedule();
  }

  /**
   * 解析配置，未给字段填默认。
   *
   * @param cfg 用户配置
   */
  private static resolveConfig(cfg?: BeiDouFieldConfig): ResolvedConfig {
    const d = RENDER_DEFAULTS;
    return {
      levelPx: cfg?.levelPx ?? { ...d.levelPx },
      maxCells: cfg?.maxCells ?? d.maxCells,
      heightRange: cfg?.heightRange ?? { min: 0, max: 600, step: 120 },
      anchorLonDeg: Number.isFinite(cfg?.anchorLonDeg) ? cfg!.anchorLonDeg : undefined,
      anchorLatDeg: Number.isFinite(cfg?.anchorLatDeg) ? cfg!.anchorLatDeg : undefined,
    };
  }

  // ──────────────────────────────────────────────
  // 需求①：渲染模式 / 填充 / 选中
  // ──────────────────────────────────────────────

  /**
   * 设渲染模式（线框 ↔ 填充）。默认线框。
   *
   * @param mode 'wire' 线框 / 'fill' 填充
   */
  public setMode(mode: FieldMode): void {
    this.field.setMode(mode);
  }

  /** 取当前渲染模式。 */
  public getMode(): FieldMode {
    return this.field.getMode();
  }

  /**
   * 设填充模式全局不透明度（0..1）。线框模式忽略。
   *
   * @param opacity 不透明度
   */
  public setFillOpacity(opacity: number): void {
    this.field.setFillOpacity(opacity);
  }

  /** 清空全部点击选中（不影响无人机标记）。 */
  public clearSelections(): void {
    this.field.clearSelections();
  }

  // ──────────────────────────────────────────────
  // 需求②：级别（比例尺自动 / 手动锁定）
  // ──────────────────────────────────────────────

  /**
   * 手动锁定显示级别（覆盖比例尺自动选级）；传 undefined 恢复自动。
   *
   * @param level 级别（1..10）或 undefined
   */
  public setLevelOverride(level?: number): void {
    this.levelOverride = level === undefined ? undefined : CesiumMath.clamp(Math.round(level), 1, 10);
    // 切回自动：清掉冻结的自动级别，下次重建按当前比例尺重新选一次并再冻结。
    if (this.levelOverride === undefined) this.frozenAutoLevel = undefined;
    this.schedule();
  }

  /** 当前生效的显示级别（最近一次 rebuild 选定）。 */
  public getActiveLevel(): number {
    return this.activeLevel;
  }

  /**
   * 设给定范围（约束渲染区域 = 可视 ∩ 给定）。传 undefined 取消约束。
   *
   * @param rect 给定矩形（Cesium.Rectangle，弧度）或 undefined
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

  // ──────────────────────────────────────────────
  // 需求③：无人机（透传 DroneController）
  // ──────────────────────────────────────────────

  /**
   * 无人机起飞：以给定（或视图中心 / 上次）为巡航中心开始低空飞行。
   * 不传中心时取当前给定范围中心，再不行取相机下方点。
   *
   * @param centerLonDeg 巡航中心经度（度，可选）
   * @param centerLatDeg 巡航中心纬度（度，可选）
   */
  public startDrone(centerLonDeg?: number, centerLatDeg?: number): void {
    if (this.destroyed) return;
    let lon = centerLonDeg;
    let lat = centerLatDeg;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      const c = this.resolveViewCenterDeg();
      if (c) {
        lon = c.lonDeg;
        lat = c.latDeg;
      }
    }
    this.drone.start(lon, lat);
  }

  /** 无人机降落：停飞 + 清除其影响标记。 */
  public stopDrone(): void {
    this.drone.stop();
  }

  /** 无人机是否在飞行。 */
  public isDroneRunning(): boolean {
    return this.drone.isRunning();
  }

  /**
   * 设无人机巡航大地高（米）。
   *
   * @param meters 大地高（米）
   */
  public setDroneAltitude(meters: number): void {
    this.drone.setAltitude(meters);
  }

  /**
   * 设无人机影响半径（米）。
   *
   * @param meters 影响半径（米）
   */
  public setDroneInfluenceRadius(meters: number): void {
    this.drone.setInfluenceRadius(meters);
  }

  /**
   * 设无人机角速度（弧度/秒，控制巡航快慢）。
   *
   * @param radPerSec 角速度（弧度/秒）
   */
  public setDroneSpeed(radPerSec: number): void {
    this.drone.setSpeed(radPerSec);
  }

  /**
   * 设无人机巡航圆半径（米）。
   *
   * @param meters 巡航圆半径（米）
   */
  public setDroneOrbitRadius(meters: number): void {
    this.drone.setOrbitRadius(meters);
  }

  // ──────────────────────────────────────────────
  // 通用
  // ──────────────────────────────────────────────

  /** 强制重建（合并到下一帧）。 */
  public refresh(): void {
    this.schedule();
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
   * 全链路重建（静态网格）：确定/复用冻结锚点中心 → 选级别 → 围绕锚点造固定窗口 →
   * 贴地高度区间 → 剖分 → 写入立方体场。相机倾斜/远近/平移都不会触发此方法——
   * 只有首帧、显式操作（改级别/区域/刷新）、地形异步采样到位才会重建，且锚点不变，
   * 故网格固定贴在同一片地理范围上，不随视角动态重算。
   */
  private rebuild(): void {
    // 1) 锚点中心：仅首帧从视图确定一次，之后冻结复用（静态网格的核心）。
    if (this.frozenCenterLonDeg === undefined || this.frozenCenterLatDeg === undefined) {
      const c = this.resolveAnchorCenterDeg();
      if (!c) {
        this.field.setVisible(false);
        return; // 暂无法确定中心（看天/无范围）——下次显式触发再建。
      }
      this.frozenCenterLonDeg = c.lonDeg;
      this.frozenCenterLatDeg = c.latDeg;
    }
    this.field.setVisible(true);
    const cLon = this.frozenCenterLonDeg;
    const cLat = this.frozenCenterLatDeg;

    // 2) 级别：手动锁定优先；自动模式下首帧按比例尺选定并冻结（之后不随缩放变化）。
    let level: number;
    if (this.levelOverride !== undefined) {
      level = this.levelOverride;
    } else {
      if (this.frozenAutoLevel === undefined) {
        this.frozenAutoLevel = ScaleLevelSelector.pickLevel(this.scene, this.cfg.levelPx).level;
      }
      level = this.frozenAutoLevel;
    }
    this.activeLevel = level;

    // 3) 贴地高度区间：底面下探到窗口内地形最低处之下，顶面抬到地形最高处之上再加
    //    配置的空域厚度。配合 globe.depthTestAgainstTerrain，每一列地表以下的立方体
    //    被地形遮挡裁掉、只露出地表以上部分——网格随地形起伏「贴地」而非悬空平板。
    //    高度仍为固定大地高分层（符合北斗三维格语义）；地形 min/max 由异步采样得到。
    const hr = this.cfg.heightRange;
    const step = hr.step > 0 ? hr.step : 1;
    const airspace = Math.max(step, hr.max - hr.min); // 地表之上的空域厚度
    const groundedRange: HeightRange = {
      min: this.groundMinMeters - GROUND_BASE_MARGIN_METERS,
      max: this.groundMaxMeters + airspace,
      step: hr.step,
    };
    const zPlanes = Math.max(1, Math.ceil((groundedRange.max - groundedRange.min) / step));

    // 4) 固定网格窗口：以冻结锚点为中心，半跨取 min(曲率安全, 预算允许)，可选裁到给定范围。
    const renderRegion = this.buildGridWindow(cLon, cLat, level, zPlanes);

    // 5) 异步采样窗口内地形 min/max（采到新值后回调里再重建），并用当前缓存即时渲染。
    this.requestGroundSpan(renderRegion);

    // 6) 剖分（纯标量；南北已夹到安全纬度内）。
    const t: Tessellation = GridTessellator.tessellate(renderRegion, level, groundedRange);

    // 7) 写入立方体场（重算度→米、原点 ENU 帧、包围球；触发选中重映射）。
    this.field.setTessellation(t);

    // 8) 同步地面高给无人机，使其巡航高度按「离地高」解释，与立方体层贴地对齐。
    this.drone.setGroundHeight(this.groundCenterMeters);
  }

  /**
   * 确定网格锚点中心（仅首帧调用一次）：
   *  ① 配置显式给定的锚点（确定性，默认普洱城区，与无人机巡航中心一致）——优先；
   *  ② 否则取相机视图∩给定范围的中心（首帧用户看向处）；
   *  ③ 再否则取给定范围中心。返回 undefined 表示暂不可定。
   */
  private resolveAnchorCenterDeg(): { lonDeg: number; latDeg: number } | undefined {
    if (this.cfg.anchorLonDeg !== undefined && this.cfg.anchorLatDeg !== undefined) {
      return { lonDeg: this.cfg.anchorLonDeg, latDeg: this.cfg.anchorLatDeg };
    }
    const region = ViewRegionResolver.resolveRegion(this.scene, this.given);
    if (region) {
      const c = Rectangle.center(region.rectangle);
      return { lonDeg: CesiumMath.toDegrees(c.longitude), latDeg: CesiumMath.toDegrees(c.latitude) };
    }
    if (this.given) {
      const c = Rectangle.center(this.given);
      return { lonDeg: CesiumMath.toDegrees(c.longitude), latDeg: CesiumMath.toDegrees(c.latitude) };
    }
    return undefined;
  }

  /**
   * 以锚点中心造固定网格窗口：半跨取 min(曲率安全, 预算允许)，可选裁到给定范围。
   * 与相机视图无关——倾斜/远近都不改变它，故网格静态固定。
   *
   * @param cLon  锚点经度（度）
   * @param cLat  锚点纬度（度）
   * @param level 当前级别
   * @param planes 高度层数（预算估算用）
   * @returns 固定渲染窗口
   */
  private buildGridWindow(cLon: number, cLat: number, level: number, planes: number): RegionResult {
    // 半跨（米）= min(曲率安全, 预算允许)。预算：每边格数 ≤ √(maxCells/层数)。
    const maxCellsPerSide = Math.max(1, Math.floor(Math.sqrt(this.cfg.maxCells / Math.max(1, planes))));
    const budgetHalfMeters = (maxCellsPerSide * levelSizeMeters(level)) / 2;
    const halfMeters = Math.min(MAX_GROUND_HALF_SPAN_METERS, budgetHalfMeters);

    // 米 → 度（经向按 cos(lat) 放大）。
    const cosLat = Math.max(0.02, Math.cos(CesiumMath.toRadians(cLat)));
    const halfLatDeg = halfMeters / METERS_PER_DEG_LAT;
    const halfLonDeg = halfMeters / (METERS_PER_DEG_LAT * cosLat);

    let w = cLon - halfLonDeg;
    let e = cLon + halfLonDeg;
    let s = cLat - halfLatDeg;
    let n = cLat + halfLatDeg;

    // 可选裁到给定范围（不跨反子午线时）。
    if (this.given && this.given.west <= this.given.east) {
      w = Math.max(w, CesiumMath.toDegrees(this.given.west));
      e = Math.min(e, CesiumMath.toDegrees(this.given.east));
      s = Math.max(s, CesiumMath.toDegrees(this.given.south));
      n = Math.min(n, CesiumMath.toDegrees(this.given.north));
      // 裁空兜底：退回纯锚点窗口（不裁）。
      if (e - w <= 1e-9 || n - s <= 1e-9) {
        w = cLon - halfLonDeg; e = cLon + halfLonDeg;
        s = cLat - halfLatDeg; n = cLat + halfLatDeg;
      }
    }

    return {
      rectangle: Rectangle.fromDegrees(w, s, e, n),
      crossesAntimeridian: false,
      widthDeg: e - w,
      heightDeg: n - s,
    };
  }

  /**
   * 异步采样窗口内地形高程的 min/max/均值（贴地基准），采到新值后触发一次重建。
   *
   * 在窗口上铺 N×N 粗采样点，用 sampleTerrainMostDetailed 直接向地形数据请求高程
   * （比 globe.getHeight 稳健——后者仅对当前渲染四叉树中保留的瓦片有效，常返回
   * undefined）。min 决定立方体场底面（再下探余量），max 决定顶面（加空域厚度），
   * 均值喂无人机作离地基准。去重：同一「地形提供方 + 窗口矩形」只采样一次，避免
   * 回环；地形提供方变化（椭球面→世界地形）时强制重采样；结果按令牌丢弃乱序回包。
   *
   * @param region 渲染区域（已收窗）
   */
  private requestGroundSpan(region: RegionResult): void {
    const provider = this.scene.globe.terrainProvider;

    // 地形提供方变化（如世界地形加载完成）→ 清去重键，强制重采样。
    if (provider !== this.lastTerrainProvider) {
      this.lastTerrainProvider = provider;
      this.groundSampledKey = '';
    }

    const r = region.rectangle;
    const key = `${r.west.toFixed(4)},${r.south.toFixed(4)},${r.east.toFixed(4)},${r.north.toFixed(4)}`;
    if (key === this.groundSampledKey) return; // 同窗口已采样，不重复请求
    this.groundSampledKey = key;

    // 在窗口上铺 N×N 采样点（区域已 clamp，不跨反子午线，直接线性插值经纬度）。
    const N = GROUND_SAMPLE_GRID;
    const samples: Cartographic[] = [];
    for (let jy = 0; jy < N; jy++) {
      const ty = N === 1 ? 0.5 : jy / (N - 1);
      const lat = r.south + (r.north - r.south) * ty;
      for (let ix = 0; ix < N; ix++) {
        const tx = N === 1 ? 0.5 : ix / (N - 1);
        const lon = r.west + (r.east - r.west) * tx;
        samples.push(new Cartographic(lon, lat, 0));
      }
    }

    const seq = ++this.groundSampleSeq;
    sampleTerrainMostDetailed(provider, samples)
      .then((results) => {
        if (this.destroyed || seq !== this.groundSampleSeq) return; // 过期结果丢弃
        let mn = Infinity, mx = -Infinity, sum = 0, cnt = 0;
        for (const c of results) {
          const h = c.height;
          if (typeof h === 'number' && Number.isFinite(h)) {
            if (h < mn) mn = h;
            if (h > mx) mx = h;
            sum += h;
            cnt++;
          }
        }
        if (cnt === 0) return; // 全无效（如椭球面提供方）：保持当前缓存
        const changed =
          Math.abs(mn - this.groundMinMeters) > 0.5 || Math.abs(mx - this.groundMaxMeters) > 0.5;
        this.groundMinMeters = mn;
        this.groundMaxMeters = mx;
        this.groundCenterMeters = sum / cnt;
        if (changed) this.schedule(); // 用新地形跨度重建（贴地）
      })
      .catch(() => {
        // 采样失败（如提供方不支持）：保持当前缓存，下次相机停稳再试。
        this.groundSampledKey = '';
      });
  }

  /**
   * 解析「视图中心」经纬度：优先给定范围中心，否则相机正下方与椭球交点。
   *
   * @returns 中心经纬度（度）或 undefined
   */
  private resolveViewCenterDeg(): { lonDeg: number; latDeg: number } | undefined {
    if (this.given) {
      const c = Rectangle.center(this.given);
      return {
        lonDeg: CesiumMath.toDegrees(c.longitude),
        latDeg: CesiumMath.toDegrees(c.latitude),
      };
    }
    const region = ViewRegionResolver.resolveRegion(this.scene, undefined);
    if (region) {
      const c = Rectangle.center(region.rectangle);
      return {
        lonDeg: CesiumMath.toDegrees(c.longitude),
        latDeg: CesiumMath.toDegrees(c.latitude),
      };
    }
    return undefined;
  }

  /**
   * 销毁：解绑事件、销毁无人机、移除立方体场（移除即触发其 destroy）。
   */
  public dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clickHandler.destroy();
    this.drone.destroy();
    // 从 primitives 集合移除会触发 field.destroy()。
    this.scene.primitives.remove(this.field);
  }
}
