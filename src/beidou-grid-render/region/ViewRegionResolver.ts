// ============================================================
// ViewRegionResolver.ts — 渲染区域解析（可视范围 ∩ 给定范围 + 预算降级）
// 层级：L2（渲染调度子模块）
// 职责：① 计算相机可视的椭球矩形（含地平线裁剪）；② 与用户给定范围求交得渲染 bbox；
//       ③ 在选定级别下估算格数，超预算则逐级降级（变粗）直到达标。
// 依赖：cesium（Scene/Rectangle/Ellipsoid/Math）、render-constants。
// 被消费：BeiDouGridScene.rebuild。
// 反子午线：Rectangle.west>east 表示跨 ±180°；本模块返回的 RegionResult 标记
//           crossesAntimeridian，供剖分/线格网拆两段。
// ============================================================

import {
  Math as CesiumMath,
  Rectangle,
  type Scene,
} from 'cesium';

import { MIN_LEVEL, levelStepDegrees } from '../render-constants';

/** 渲染区域解析结果。 */
export interface RegionResult {
  /** 渲染矩形（弧度，Cesium.Rectangle）。可能跨反子午线（west>east）。 */
  rectangle: Rectangle;
  /** 是否跨 ±180°（west>east）。 */
  crossesAntimeridian: boolean;
  /** 经向跨度（度，已处理跨界）。 */
  widthDeg: number;
  /** 纬向跨度（度）。 */
  heightDeg: number;
}

export default class ViewRegionResolver {
  /**
   * 计算相机当前可视的椭球矩形。
   *
   * 用 Cesium 内置 camera.computeViewRectangle（已处理地平线裁剪与斜视）；
   * 返回 undefined 表示无法确定（如完全看天/全球）——此时退给定范围或全球。
   *
   * @param scene Cesium 场景
   * @returns 可视矩形（弧度）或 undefined
   */
  public static viewRectangle(scene: Scene): Rectangle | undefined {
    return scene.camera.computeViewRectangle(scene.globe.ellipsoid);
  }

  /**
   * 解析最终渲染区域 = 可视矩形 ∩ 给定范围。
   *
   * 规则：
   * - 无可视矩形（看天/全球）→ 用给定范围；给定也无 → 返回 undefined（不渲染）。
   * - 有可视、无给定 → 用可视矩形。
   * - 两者皆有 → 求交；不相交（intersection 返回空）→ undefined（不渲染）。
   *
   * @param scene Cesium 场景
   * @param given 用户给定范围（弧度 Rectangle）或 undefined
   * @returns RegionResult 或 undefined
   */
  public static resolveRegion(scene: Scene, given?: Rectangle): RegionResult | undefined {
    const view = ViewRegionResolver.viewRectangle(scene);

    let rect: Rectangle | undefined;
    if (!view && !given) {
      return undefined;
    } else if (!view) {
      rect = Rectangle.clone(given as Rectangle);
    } else if (!given) {
      rect = Rectangle.clone(view);
    } else {
      const inter = Rectangle.intersection(view, given, new Rectangle());
      if (!inter || ViewRegionResolver.isDegenerate(inter)) {
        return undefined;
      }
      rect = inter;
    }

    if (!rect || ViewRegionResolver.isDegenerate(rect)) {
      return undefined;
    }

    const crosses = rect.west > rect.east;
    const widthRad = ViewRegionResolver.normalizedWidthRad(rect.west, rect.east);
    const heightRad = rect.north - rect.south;

    return {
      rectangle: rect,
      crossesAntimeridian: crosses,
      widthDeg: CesiumMath.toDegrees(widthRad),
      heightDeg: CesiumMath.toDegrees(heightRad),
    };
  }

  /**
   * 判定矩形是否退化（宽或高 ≤ 极小阈值，视为无效）。
   *
   * @param rect 矩形（弧度）
   */
  private static isDegenerate(rect: Rectangle): boolean {
    const widthRad = ViewRegionResolver.normalizedWidthRad(rect.west, rect.east);
    const heightRad = rect.north - rect.south;
    // 1e-9 弧度 ≈ 6mm，足够小；用于剔除空交集。
    return widthRad <= 1e-9 || heightRad <= 1e-9;
  }

  /**
   * 计算从 west 到 east 的归一化经向跨度（弧度），正确处理跨 ±180°。
   *
   * @param westRad 西边界（弧度）
   * @param eastRad 东边界（弧度）
   */
  private static normalizedWidthRad(westRad: number, eastRad: number): number {
    let w = eastRad - westRad;
    if (w < 0) {
      // 跨反子午线：补一圈 2π。
      w += CesiumMath.TWO_PI;
    }
    return w;
  }

  /**
   * 在选定级别下估算渲染区域的格数（×高度层），超 maxCells 则逐级降级（变粗）。
   *
   * 用经向/纬向度跨度除以该级度步长得行列数，乘高度层数。从 level 向 MIN_LEVEL
   * 扫描，返回第一个总格数 ≤ maxCells 的级别；都超则返回 MIN_LEVEL。
   *
   * @param region    渲染区域解析结果
   * @param level     比例尺建议的级别
   * @param zPlanes   高度层数（≥1）
   * @param maxCells  格数上限
   * @returns         降级后的级别（1..10）
   */
  public static clampLevelByBudget(
    region: RegionResult,
    level: number,
    zPlanes: number,
    maxCells: number,
  ): number {
    const planes = Math.max(1, zPlanes);
    for (let L = level; L >= MIN_LEVEL; L--) {
      const [stepLonDeg, stepLatDeg] = levelStepDegrees(L);
      const nx = Math.ceil(region.widthDeg / stepLonDeg);
      const ny = Math.ceil(region.heightDeg / stepLatDeg);
      const cells = Math.max(1, nx) * Math.max(1, ny) * planes;
      if (cells <= maxCells) {
        return L;
      }
    }
    return MIN_LEVEL;
  }
}
