// ============================================================
// DroneController.ts — 无人机低空飞行模拟控制器（控制层 L4.5）
// 职责：需求③「模拟无人机低空飞行，渲染周边受影响立方体并变色」的驱动方。
//       ① 用 requestAnimationFrame 驱动无人机沿圆形巡航航线低空飞行；
//       ② 在 Cesium 场景中以 Entity（点 + 文本标牌「无人机」）呈现机体，并拖一条
//          渐隐尾迹折线表现航迹；
//       ③ 每帧（按节流频率）把当前机位 + 影响半径喂给 GridCubeField.setDroneInfluence，
//          由立方体场标记机体所在格（核心）与周边格（影响），并变色。
// 设计要点：
//   · 机体位置用 CallbackProperty 暴露给 Cesium，机体/尾迹随相机以 60fps 平滑刷新，
//     与「影响重算 + 状态纹理上传」解耦——后者按固定时间步节流（默认 ~12Hz），
//     既保证观感流畅，又把大网格下的整幅纹理重传次数降到可控范围。
//   · 经纬换算与 GridCubeField 完全一致（METERS_PER_DEG=111320，经向乘 cos(lat)），
//     确保机位与格定位无系统偏差。
// 依赖：cesium（Entity / CallbackProperty / Cartesian3 / Color / 材质 / Math）、GridCubeField。
// 被消费：BeiDouFieldScene（编排器持有并透传 start/stop/altitude/radius/speed）。
// ============================================================

import {
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  Math as CesiumMath,
  PolylineGlowMaterialProperty,
  VerticalOrigin,
  type Entity,
  type Viewer,
} from 'cesium';

import type GridCubeField from '../core/GridCubeField';

/** 经度→米换算基准（与 GridCubeField 保持一致，避免机位与格定位系统偏差）。 */
const METERS_PER_DEG = 111320.0;

/** 无人机飞行与影响的默认参数。 */
const DRONE_DEFAULTS = {
  /** 巡航大地高（米）：低空。 */
  altitudeMeters: 150,
  /** 影响半径（米）：决定标记多大范围的周边格。 */
  influenceRadiusMeters: 320,
  /** 巡航圆半径（米）：航线绕中心的水平半径。 */
  orbitRadiusMeters: 700,
  /** 角速度（弧度/秒）：航线推进快慢。 */
  angularSpeedRadPerSec: 0.45,
  /** 高度起伏幅度（米）：叠加在巡航高度上的轻微上下浮动，增强真实感。 */
  altitudeBobMeters: 25,
  /** 高度起伏角速度（弧度/秒）。 */
  altitudeBobSpeedRadPerSec: 0.9,
  /** 尾迹保留点数。 */
  trailLength: 64,
  /** 影响重算节流间隔（秒）：约 12Hz，平衡观感与纹理上传开销。 */
  influenceThrottleSeconds: 0.08,
} as const;

/** 机位（用于内部计算与对外查询）。 */
export interface DronePosition {
  /** 经度（度）。 */
  lonDeg: number;
  /** 纬度（度）。 */
  latDeg: number;
  /** 大地高（米）。 */
  heightMeters: number;
}

/**
 * 无人机低空飞行模拟控制器。
 *
 * 生命周期：构造（建机体 + 尾迹 Entity，隐藏待飞）→ start（起飞，开 rAF）→
 *           [setAltitude / setInfluenceRadius / setSpeed / setOrbitRadius 实时调参] →
 *           stop（降落，停 rAF + 清影响 + 隐藏）→ dispose（彻底移除 Entity）。
 */
export default class DroneController {
  /** Cesium Viewer（机体/尾迹挂在其 entities 上）。 */
  private readonly viewer: Viewer;
  /** 立方体场（影响的接收方）。 */
  private readonly field: GridCubeField;

  // ── Entity（懒建，dispose 时移除）──
  /** 机体 Entity（点 + 文本标牌）。 */
  private droneEntity: Entity | undefined;
  /** 尾迹 Entity（渐隐发光折线）。 */
  private trailEntity: Entity | undefined;

  // ── 航线状态 ──
  /** 巡航中心经度（度）。 */
  private centerLonDeg = 100.972;
  /** 巡航中心纬度（度）。 */
  private centerLatDeg = 22.778;
  /** 水平航线相位（弧度）。 */
  private phase = 0;
  /** 高度起伏相位（弧度）。 */
  private bobPhase = 0;

  // ── 可调参数 ──
  /** 巡航大地高（米）。 */
  private altitudeMeters: number = DRONE_DEFAULTS.altitudeMeters;
  /** 影响半径（米）。 */
  private influenceRadiusMeters: number = DRONE_DEFAULTS.influenceRadiusMeters;
  /** 巡航圆半径（米）。 */
  private orbitRadiusMeters: number = DRONE_DEFAULTS.orbitRadiusMeters;
  /** 角速度（弧度/秒）。 */
  private angularSpeedRadPerSec: number = DRONE_DEFAULTS.angularSpeedRadPerSec;
  /** 地形面高（米，贴地基准，由编排器同步）；巡航高度按「离地高」叠加其上。 */
  private groundHeightMeters = 0;

  // ── 当前机位（CallbackProperty 读取）──
  /** 当前机位 ECEF（机体 Entity 位置回调返回此值）。 */
  private readonly currentEcef = new Cartesian3();
  /** 当前机位地理坐标（对外查询用）。 */
  private readonly currentGeo: DronePosition = {
    lonDeg: this.centerLonDeg,
    latDeg: this.centerLatDeg,
    heightMeters: this.altitudeMeters,
  };
  /** 尾迹点缓冲（ECEF，环形截断到 trailLength）。 */
  private trail: Cartesian3[] = [];

  // ── rAF 循环 ──
  /** 是否飞行中。 */
  private running = false;
  /** rAF 句柄。 */
  private rafId = 0;
  /** 上一帧时间戳（毫秒，rAF 提供）。 */
  private lastTs = 0;
  /** 影响重算节流累加器（秒）。 */
  private influenceAccum = 0;

  private destroyed = false;

  /**
   * @param viewer Cesium Viewer（机体/尾迹 Entity 的宿主）
   * @param field  立方体场（接收无人机影响）
   */
  public constructor(viewer: Viewer, field: GridCubeField) {
    this.viewer = viewer;
    this.field = field;
  }

  /**
   * 起飞：以给定（或上次/默认）中心开始低空巡航。
   * 若已在飞行则仅更新中心并继续。
   *
   * @param centerLonDeg 巡航中心经度（度，可选；不传沿用当前中心）
   * @param centerLatDeg 巡航中心纬度（度，可选；不传沿用当前中心）
   */
  public start(centerLonDeg?: number, centerLatDeg?: number): void {
    if (this.destroyed) return;
    if (Number.isFinite(centerLonDeg)) this.centerLonDeg = centerLonDeg as number;
    if (Number.isFinite(centerLatDeg)) this.centerLatDeg = centerLatDeg as number;

    this.ensureEntities();
    if (this.droneEntity) this.droneEntity.show = true;
    if (this.trailEntity) this.trailEntity.show = true;

    if (this.running) return;
    this.running = true;
    this.lastTs = 0;
    this.influenceAccum = 0;
    this.trail = [];
    // 立即落一帧，避免起飞瞬间机体停在原点。
    this.advance(0);
    this.scheduleFrame();
  }

  /**
   * 降落：停止巡航，清除立方体场上的无人机影响，并隐藏机体/尾迹。
   */
  public stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (!this.destroyed) this.field.clearDrone();
    if (this.droneEntity) this.droneEntity.show = false;
    if (this.trailEntity) this.trailEntity.show = false;
    this.trail = [];
  }

  /** 是否正在飞行。 */
  public isRunning(): boolean {
    return this.running;
  }

  /**
   * 设巡航高度（米，离地高）。低空范围约束在 [20, 2000]。
   * 实际大地高 = 地面高 + 此值 + 起伏，使机体贴地飞行、与立方体层对齐。
   *
   * @param meters 离地高（米）
   */
  public setAltitude(meters: number): void {
    if (!Number.isFinite(meters)) return;
    this.altitudeMeters = CesiumMath.clamp(meters, 20, 2000);
  }

  /**
   * 同步地面高（贴地基准，米），由编排器在剖分后调用。
   * 之后机体大地高 = 此地面高 + 巡航离地高 + 起伏。
   *
   * @param meters 地面高（米）
   */
  public setGroundHeight(meters: number): void {
    if (Number.isFinite(meters)) this.groundHeightMeters = meters;
  }

  /**
   * 设影响半径（米），约束在 [50, 3000]。下一次影响重算即生效。
   *
   * @param meters 影响半径（米）
   */
  public setInfluenceRadius(meters: number): void {
    if (!Number.isFinite(meters)) return;
    this.influenceRadiusMeters = CesiumMath.clamp(meters, 50, 3000);
  }

  /**
   * 设角速度（弧度/秒），约束在 [0.05, 2.0]。控制巡航推进快慢。
   *
   * @param radPerSec 角速度（弧度/秒）
   */
  public setSpeed(radPerSec: number): void {
    if (!Number.isFinite(radPerSec)) return;
    this.angularSpeedRadPerSec = CesiumMath.clamp(radPerSec, 0.05, 2.0);
  }

  /**
   * 设巡航圆半径（米），约束在 [50, 5000]。
   *
   * @param meters 巡航圆半径（米）
   */
  public setOrbitRadius(meters: number): void {
    if (!Number.isFinite(meters)) return;
    this.orbitRadiusMeters = CesiumMath.clamp(meters, 50, 5000);
  }

  /** 当前机位（地理坐标）。 */
  public getPosition(): DronePosition {
    return { ...this.currentGeo };
  }

  /**
   * 销毁：停飞并从场景移除机体/尾迹 Entity。
   */
  public destroy(): void {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
    const entities = this.viewer.entities;
    if (this.droneEntity) {
      entities.remove(this.droneEntity);
      this.droneEntity = undefined;
    }
    if (this.trailEntity) {
      entities.remove(this.trailEntity);
      this.trailEntity = undefined;
    }
  }

  /**
   * 懒建机体与尾迹 Entity（仅首次起飞时建一次）。
   * 机体位置 / 尾迹折线均用 CallbackProperty（isConstant=false）暴露，
   * 使其随相机每帧重新求值，无需手动逐帧 setProperty。
   */
  private ensureEntities(): void {
    const entities = this.viewer.entities;

    if (!this.droneEntity) {
      this.droneEntity = entities.add({
        // 机体位置：返回内部 currentEcef（每帧由 advance 更新）。
        position: new CallbackPositionProperty(() => this.currentEcef, false),
        point: {
          pixelSize: 12,
          color: Color.fromCssColorString('#ff3b30'),
          outlineColor: Color.fromCssColorString('#ffffff'),
          outlineWidth: 2,
          // 始终压过地形/格渲染，保证机体可见。
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: '无人机',
          font: '600 14px "PingFang SC","Microsoft YaHei",sans-serif',
          fillColor: Color.fromCssColorString('#ffffff'),
          showBackground: true,
          backgroundColor: Color.fromCssColorString('#ff3b30').withAlpha(0.85),
          backgroundPadding: new Cartesian2(8, 4),
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -18),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }

    if (!this.trailEntity) {
      this.trailEntity = entities.add({
        polyline: {
          // 尾迹折线：返回内部 trail 缓冲（每帧追加新点、截断旧点）。
          positions: new CallbackProperty(() => this.trail, false),
          width: 4,
          material: new PolylineGlowMaterialProperty({
            glowPower: 0.25,
            color: Color.fromCssColorString('#ff9500').withAlpha(0.9),
          }),
        },
      });
    }
  }

  /**
   * rAF 调度：登记下一动画帧。
   */
  private scheduleFrame(): void {
    this.rafId = requestAnimationFrame((ts) => this.onFrame(ts));
  }

  /**
   * 每动画帧回调：算 dt → 推进航线 → 节流刷新影响 → 登记下一帧。
   *
   * @param ts requestAnimationFrame 提供的高精度时间戳（毫秒）
   */
  private onFrame(ts: number): void {
    if (!this.running || this.destroyed) return;
    const dt = this.lastTs === 0 ? 0 : Math.min(0.1, (ts - this.lastTs) / 1000);
    this.lastTs = ts;

    this.advance(dt);

    this.scheduleFrame();
  }

  /**
   * 推进一步：更新相位 → 计算机位（ECEF + 地理）→ 追加尾迹 →
   * 按节流间隔把机位 + 半径喂给立方体场。
   *
   * @param dt 距上帧的时间增量（秒）
   */
  private advance(dt: number): void {
    // 推进相位。
    this.phase += this.angularSpeedRadPerSec * dt;
    this.bobPhase += DRONE_DEFAULTS.altitudeBobSpeedRadPerSec * dt;
    if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2;
    if (this.bobPhase > Math.PI * 2) this.bobPhase -= Math.PI * 2;

    // 水平圆形巡航：东/北方向米偏移。
    const east = this.orbitRadiusMeters * Math.cos(this.phase);
    const north = this.orbitRadiusMeters * Math.sin(this.phase);

    // 米偏移 → 经纬增量（经向乘 cos(lat)，与 GridCubeField 一致）。
    const cosLat = Math.max(0.02, Math.cos(CesiumMath.toRadians(this.centerLatDeg)));
    const lonDeg = this.centerLonDeg + east / (METERS_PER_DEG * cosLat);
    const latDeg = this.centerLatDeg + north / METERS_PER_DEG;

    // 高度 = 地面高 + 巡航离地高 + 轻微正弦起伏（贴地飞行，与立方体层对齐）。
    const heightMeters =
      this.groundHeightMeters + this.altitudeMeters + DRONE_DEFAULTS.altitudeBobMeters * Math.sin(this.bobPhase);

    this.currentGeo.lonDeg = lonDeg;
    this.currentGeo.latDeg = latDeg;
    this.currentGeo.heightMeters = heightMeters;
    Cartesian3.fromDegrees(lonDeg, latDeg, heightMeters, undefined, this.currentEcef);

    // 追加尾迹（克隆当前点，环形截断）。
    this.trail.push(Cartesian3.clone(this.currentEcef));
    if (this.trail.length > DRONE_DEFAULTS.trailLength) {
      this.trail.shift();
    }

    // 影响节流：累加到阈值才重算（机体仍以 60fps 平滑移动）。
    this.influenceAccum += dt;
    if (dt === 0 || this.influenceAccum >= DRONE_DEFAULTS.influenceThrottleSeconds) {
      this.influenceAccum = 0;
      this.field.setDroneInfluence(lonDeg, latDeg, heightMeters, this.influenceRadiusMeters);
    }
  }
}
