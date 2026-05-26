// ============================================================
// ScaleLevelSelector.ts — 按地图比例尺动态选北斗网格级别
// 层级：L2（渲染调度子模块）
// 职责：读取相机比例尺（metersPerPixel），映射到使单格屏幕尺寸落入
//       [minPx,maxPx] 的北斗级别（1..10）。
// 依赖：cesium（Scene/Camera/PerspectiveFrustum/Ray/Cartesian2/3）、render-constants。
// 被消费：BeiDouGridScene.rebuild（每次相机停稳）。
// 算法：metersPerPixel = 2·d·tan(fovy/2)/canvasHeight；
//       cellPx(L) = LEVEL_SIZE_METERS[L]·latFactor / metersPerPixel；
//       选最细且 cellPx ≥ minPx 的 L。
// ============================================================

import {
  Cartesian2,
  Cartesian3,
  Math as CesiumMath,
  PerspectiveFrustum,
  type Ray,
  type Scene,
} from 'cesium';

import {
  LEVEL_SIZE_METERS,
  MAX_LEVEL,
  MIN_LEVEL,
} from '../render-constants';

/** 选级别的像素区间配置。 */
export interface LevelPxConfig {
  /** 单格最小屏幕像素（低于则用更粗级别）。 */
  minPx: number;
  /** 单格最大屏幕像素（仅用于上界 sanity，不强制）。 */
  maxPx: number;
  /** 理想像素（用于在多个候选间取最接近者，可选优化）。 */
  target: number;
}

/** 选级别结果，含中间量便于调试/显示。 */
export interface LevelPick {
  /** 选定级别（1..10）。 */
  level: number;
  /** 每像素米数。 */
  metersPerPixel: number;
  /** 屏幕中心地面点纬度（度），用于纬度修正与上层剖分参考。 */
  centerLatDeg: number;
  /** 屏幕中心地面点经度（度）。 */
  centerLonDeg: number;
}

const _centerPx = new Cartesian2();
const _hitScratch = new Cartesian3();

export default class ScaleLevelSelector {
  /**
   * 计算屏幕中心处的每像素米数，并返回该处地面点经纬度。
   *
   * 实现：取屏幕中心像素发射 picking 射线，与地球（地形优先，无地形则椭球）求交得地面点；
   * 无交点（视线看天）时退化为「相机到椭球面最近距离」。
   * metersPerPixel = 2·distance·tan(fovy/2) / canvasClientHeight。
   *
   * @param scene Cesium 场景
   * @returns { metersPerPixel, lonDeg, latDeg }
   */
  public static measure(scene: Scene): { metersPerPixel: number; lonDeg: number; latDeg: number } {
    const camera = scene.camera;
    const canvas = scene.canvas;
    const height = canvas.clientHeight > 0 ? canvas.clientHeight : canvas.height;

    // 屏幕中心像素（CSS 像素）。
    _centerPx.x = (canvas.clientWidth > 0 ? canvas.clientWidth : canvas.width) / 2;
    _centerPx.y = height / 2;

    // 中心射线与地球求交。getPickRay 在某些相机姿态下可能返回 undefined。
    const ray: Ray | undefined = camera.getPickRay(_centerPx) as Ray | undefined;
    let hit: Cartesian3 | undefined;
    if (ray) {
      hit = scene.globe.pick(ray, scene, _hitScratch);
    }

    let distance: number;
    let lonDeg: number;
    let latDeg: number;

    if (hit) {
      distance = Cartesian3.distance(camera.positionWC, hit);
      const carto = scene.globe.ellipsoid.cartesianToCartographic(hit);
      lonDeg = CesiumMath.toDegrees(carto.longitude);
      latDeg = CesiumMath.toDegrees(carto.latitude);
    } else {
      // 看天兜底：用相机到椭球面的高度作为距离，地面点取相机正下方（星下点）。
      const carto = scene.globe.ellipsoid.cartesianToCartographic(camera.positionWC);
      distance = Math.max(1.0, carto.height);
      lonDeg = CesiumMath.toDegrees(carto.longitude);
      latDeg = CesiumMath.toDegrees(carto.latitude);
    }

    // fovy：透视相机的垂直视场角；非透视兜底 60°。
    const frustum = camera.frustum;
    const persp = frustum instanceof PerspectiveFrustum ? frustum : undefined;
    const fovy = persp && Number.isFinite(persp.fovy)
      ? (persp.fovy as number)
      : CesiumMath.toRadians(60);

    const metersPerPixel = (2.0 * distance * Math.tan(fovy / 2.0)) / height;
    return { metersPerPixel, lonDeg, latDeg };
  }

  /**
   * 由比例尺选北斗级别。
   *
   * 从最细级别（10）向粗（1）扫描，返回第一个「单格屏幕像素 ≥ minPx」的级别；
   * 都不满足（极度拉远）则返回 MIN_LEVEL。纬度修正：经向格的米尺寸随纬度按
   * cos(lat) 收缩，用 latFactor 修正使高纬不致选级别偏粗。
   *
   * @param scene Cesium 场景
   * @param cfg   像素区间配置
   * @returns     LevelPick（含级别与中间量）
   */
  public static pickLevel(scene: Scene, cfg: LevelPxConfig): LevelPick {
    const { metersPerPixel, lonDeg, latDeg } = ScaleLevelSelector.measure(scene);

    // 纬度修正因子：经向 1 米对应的角度随 cos(lat) 变化；格的「东西向米宽」
    // 在高纬收缩为 size·cos(lat)，故屏幕像素也按 cos(lat) 收缩。clamp 防极区为 0。
    const latFactor = Math.max(0.05, Math.cos(CesiumMath.toRadians(latDeg)));

    let chosen = MIN_LEVEL;
    for (let L = MAX_LEVEL; L >= MIN_LEVEL; L--) {
      const cellPx = (LEVEL_SIZE_METERS[L]! * latFactor) / metersPerPixel;
      if (cellPx >= cfg.minPx) {
        chosen = L;
        break;
      }
    }

    return {
      level: CesiumMath.clamp(chosen, MIN_LEVEL, MAX_LEVEL),
      metersPerPixel,
      centerLatDeg: latDeg,
      centerLonDeg: lonDeg,
    };
  }
}
