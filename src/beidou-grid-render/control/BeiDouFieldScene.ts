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

/** 采样地面高用的复用 Cartographic（避免逐帧 GC）。 */
const _scratchCarto = new Cartographic();

/** 赤道每度米长（纬向恒定近似；与 GridCubeField/DroneController 一致）。 */
const METERS_PER_DEG_LAT = 111320.0;

/**
 * 贴地渲染窗口的最大半跨（米）。
 * 立方体场是「区域原点 ENU 切平面」上的一整片平板：区域越大，平板因地球曲率
 * 越偏离地表，远端会抬升「漂浮」（半跨 d 处抬升 ≈ d²/2R）。半跨 7km 时曲率抬升
 * 仅 ≈3.8m（远小于层高），故把渲染区域收敛到「视点为中心」的此尺度窗口，保证贴地。
 */
const MAX_GROUND_HALF_SPAN_METERS = 7000;

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
}

/** 解析后的内部配置（字段全部填齐）。 */
interface ResolvedConfig {
  levelPx: LevelPxConfig;
  maxCells: number;
  heightRange: HeightRange;
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

  /** 区域地形面高（米，贴地基准）；地形未采样时为 0（椭球面），异步采样后修正。 */
  private groundHeightMeters = 0;
  /** 地面采样令牌（异步乱序丢弃用：仅最新一次结果生效）。 */
  private groundSampleSeq = 0;
  /** 上次已采样的「地形提供方|中心点」键（去重，避免同点重复采样导致回环）。 */
  private groundSampledKey = '';
  /** 上次采样所用地形提供方（变化时强制重采样：椭球面→世界地形）。 */
  private lastTerrainProvider: unknown;
  /** 上一次地形瓦片待加载数（侦测「刚加载完」以触发重建、重采样地面高）。 */
  private prevTileLoad = 0;

  /** rAF 防抖标记。 */
  private rafPending = false;
  private destroyed = false;

  /** 相机停稳事件解绑句柄。 */
  private readonly removeMoveEnd: () => void;
  /** 地形瓦片加载进度事件解绑句柄。 */
  private readonly removeTileLoad: () => void;
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

    // 相机停稳 → 重建（拖动中不重建，避免抖动）——需求②比例尺联动入口。
    this.removeMoveEnd = this.scene.camera.moveEnd.addEventListener(() => this.schedule());

    // 地形瓦片加载完成（待加载数从 >0 归 0）→ 重建一次重采样地面高，纠正贴地。
    // 首帧地形尚未就绪时立方体场暂落椭球面，瓦片到位后此事件触发自动抬到地表。
    this.removeTileLoad = this.scene.globe.tileLoadProgressEvent.addEventListener((queued: number) => {
      if (!this.destroyed && this.prevTileLoad > 0 && queued === 0) this.schedule();
      this.prevTileLoad = queued;
    });

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
   * 全链路重建：解析区域 → 选级别 → 预算降级 → 剖分 → 写入立方体场。
   * 无可视区域（看天/与给定无交集）时隐藏立方体场。
   */
  private rebuild(): void {
    // 1) 解析区域（可视 ∩ 给定）。
    const region = ViewRegionResolver.resolveRegion(this.scene, this.given);
    if (!region) {
      this.field.setVisible(false);
      return;
    }
    this.field.setVisible(true);

    // 2) 选级别：手动锁优先，否则比例尺自动。
    const autoPick = ScaleLevelSelector.pickLevel(this.scene, this.cfg.levelPx);
    const desiredLevel = this.levelOverride ?? autoPick.level;

    // 3) 预算降级：仅自动模式生效（手动锁定尊重用户选择，不降级）。
    //    高度层数由固定 step 推出（step>0 保证），避免「step 依赖级别」的鸡生蛋。
    const hr = this.cfg.heightRange;
    const step = hr.step > 0 ? hr.step : 1;
    const zPlanes = Math.max(1, Math.ceil((hr.max - hr.min) / step));
    let level: number;
    if (this.levelOverride !== undefined) {
      level = desiredLevel;
    } else {
      level = ViewRegionResolver.clampLevelByBudget(region, desiredLevel, zPlanes, this.cfg.maxCells);
    }
    this.activeLevel = level;

    // 4) 贴地窗口：把渲染区域收敛到「视点为中心、曲率/预算安全」的有限窗口。
    //    大区域（尤其倾斜看到地平线、computeViewRectangle 退回整片给定范围）下，
    //    平切面网格会随地球曲率抬离地表而漂浮——收窗后曲率误差与立方体数均受控。
    const renderRegion = this.clampRegionForGrounding(
      region,
      level,
      zPlanes,
      autoPick.centerLonDeg,
      autoPick.centerLatDeg,
    );

    // 5) 贴地：用已缓存地面高即时渲染，同时异步采样窗口中心（≈视点）地形高，
    //    采到新值后回调里再重建——使立方体场底面坐落于地形而非海平面（椭球面）。
    this.requestGroundHeight(renderRegion);
    const groundedRange: HeightRange = {
      min: this.groundHeightMeters + hr.min,
      max: this.groundHeightMeters + hr.max,
      step: hr.step,
    };

    // 6) 剖分（纯标量；南北已夹到安全纬度内）。
    const t: Tessellation = GridTessellator.tessellate(renderRegion, level, groundedRange);

    // 7) 写入立方体场（重算度→米、原点 ENU 帧、包围球；触发选中重映射）。
    this.field.setTessellation(t);

    // 8) 同步地面高给无人机，使其巡航高度按「离地高」解释，与立方体层贴地对齐。
    this.drone.setGroundHeight(this.groundHeightMeters);
  }

  /**
   * 把渲染区域收敛到「视点为中心」的有限窗口，半跨取 min(曲率安全, 预算允许)。
   * 这样网格只覆盖视点周边一片，既规避大区域平切面随曲率漂浮（贴地），
   * 又在级别锁定（不降级）时约束立方体数量。跨反子午线时不收窗（保持既有行为）。
   *
   * @param region          原始渲染区域（可视 ∩ 给定）
   * @param level           当前级别
   * @param planes          高度层数
   * @param viewCenterLonDeg 视点（屏幕中心地面点）经度（度）
   * @param viewCenterLatDeg 视点纬度（度）
   * @returns 收窗后的渲染区域
   */
  private clampRegionForGrounding(
    region: RegionResult,
    level: number,
    planes: number,
    viewCenterLonDeg: number,
    viewCenterLatDeg: number,
  ): RegionResult {
    if (region.crossesAntimeridian) return region;

    const rect = region.rectangle;
    const westDeg = CesiumMath.toDegrees(rect.west);
    const eastDeg = CesiumMath.toDegrees(rect.east);
    const southDeg = CesiumMath.toDegrees(rect.south);
    const northDeg = CesiumMath.toDegrees(rect.north);

    // 窗口中心：优先视点地面点；落在区域外（或无效）则退回区域中心。
    let cLon = viewCenterLonDeg;
    let cLat = viewCenterLatDeg;
    if (
      !Number.isFinite(cLon) || !Number.isFinite(cLat) ||
      cLon < westDeg || cLon > eastDeg || cLat < southDeg || cLat > northDeg
    ) {
      cLon = (westDeg + eastDeg) / 2;
      cLat = (southDeg + northDeg) / 2;
    }

    // 半跨（米）= min(曲率安全, 预算允许)。预算：每边格数 ≤ √(maxCells/层数)。
    const maxCellsPerSide = Math.max(1, Math.floor(Math.sqrt(this.cfg.maxCells / Math.max(1, planes))));
    const budgetHalfMeters = (maxCellsPerSide * levelSizeMeters(level)) / 2;
    const halfMeters = Math.min(MAX_GROUND_HALF_SPAN_METERS, budgetHalfMeters);

    // 米 → 度（经向按 cos(lat) 放大）。
    const cosLat = Math.max(0.02, Math.cos(CesiumMath.toRadians(cLat)));
    const halfLatDeg = halfMeters / METERS_PER_DEG_LAT;
    const halfLonDeg = halfMeters / (METERS_PER_DEG_LAT * cosLat);

    // 窗口 ∩ 区域。
    const w = Math.max(westDeg, cLon - halfLonDeg);
    const e = Math.min(eastDeg, cLon + halfLonDeg);
    const s = Math.max(southDeg, cLat - halfLatDeg);
    const n = Math.min(northDeg, cLat + halfLatDeg);
    if (e - w <= 1e-9 || n - s <= 1e-9) return region; // 异常兜底：不收窗

    return {
      rectangle: Rectangle.fromDegrees(w, s, e, n),
      crossesAntimeridian: false,
      widthDeg: e - w,
      heightDeg: n - s,
    };
  }

  /**
   * 异步采样渲染区域中心处的地形面高（贴地基准），采到新值后触发一次重建。
   *
   * 用 sampleTerrainMostDetailed 直接向地形数据请求高程（比 globe.getHeight 稳健——
   * 后者仅对当前渲染四叉树中保留的瓦片有效，常返回 undefined）。去重策略：同一
   * 「地形提供方 + 中心点」只采样一次，避免回环；地形提供方变化（椭球面→世界地形）
   * 时强制重采样。结果按令牌丢弃乱序回包。
   *
   * @param region 渲染区域
   */
  private requestGroundHeight(region: RegionResult): void {
    const center = Rectangle.center(region.rectangle, _scratchCarto);
    const provider = this.scene.globe.terrainProvider;

    // 地形提供方变化（如世界地形加载完成）→ 清去重键，强制重采样。
    if (provider !== this.lastTerrainProvider) {
      this.lastTerrainProvider = provider;
      this.groundSampledKey = '';
    }

    const lonDeg = CesiumMath.toDegrees(center.longitude);
    const latDeg = CesiumMath.toDegrees(center.latitude);
    const key = `${lonDeg.toFixed(4)},${latDeg.toFixed(4)}`;
    if (key === this.groundSampledKey) return; // 同点已采样，不重复请求
    this.groundSampledKey = key;

    const seq = ++this.groundSampleSeq;
    const sample = new Cartographic(center.longitude, center.latitude, 0);
    sampleTerrainMostDetailed(provider, [sample])
      .then((results) => {
        if (this.destroyed || seq !== this.groundSampleSeq) return; // 过期结果丢弃
        const h = results[0]?.height;
        if (typeof h === 'number' && Number.isFinite(h) && Math.abs(h - this.groundHeightMeters) > 0.5) {
          this.groundHeightMeters = h;
          this.schedule(); // 用新地面高重建（贴地）
        }
      })
      .catch(() => {
        // 采样失败（如提供方不支持）：保持当前地面高，下次相机停稳再试。
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
    this.removeMoveEnd();
    this.removeTileLoad();
    this.clickHandler.destroy();
    this.drone.destroy();
    // 从 primitives 集合移除会触发 field.destroy()。
    this.scene.primitives.remove(this.field);
  }
}
