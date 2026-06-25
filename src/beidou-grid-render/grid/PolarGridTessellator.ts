// ============================================================
// PolarGridTessellator.ts — 极区收敛格剖分
// 层级：L2（渲染调度子模块，极区分支）
// 职责：给定半球 + 级别，产出极区纬度带（真实纬度）+ 每带扇区数，供极区线格网渲染。
//       南半球镜像北半球结果。
// 依赖：polar-bridge（enumeratePolarBandsNorth / PolarBand / Hemisphere）。
// 被消费：PolarGridLinePrimitive / BeiDouGridScene（极区分支）。
// ============================================================

import { enumeratePolarBandsNorth, type Hemisphere, type PolarBand } from '../polar-bridge';

/** 极区剖分结果。 */
export interface PolarTessellation {
  /** 半球。 */
  hemisphere: Hemisphere;
  /** 级别。 */
  level: number;
  /** 纬度带（真实纬度，已按半球镜像）。 */
  bands: PolarBand[];
  /** 高度层底高数组（米）；与中低纬共用同一 heightRange。 */
  zPlaneFloors: number[];
  /** 高度层步长（米）。 */
  heightStep: number;
}

export default class PolarGridTessellator {
  /**
   * 剖分极区。
   *
   * @param hemisphere 'N'（北极冠 [88,90]）或 'S'（南极冠 [-90,-88]）
   * @param level      级别（1..10）
   * @param zPlaneFloors 高度层底高数组（复用中低纬剖分的高度层）
   * @param heightStep   高度层步长（米）
   * @returns PolarTessellation
   */
  public static tessellate(
    hemisphere: Hemisphere,
    level: number,
    zPlaneFloors: number[],
    heightStep: number,
  ): PolarTessellation {
    const north = enumeratePolarBandsNorth(level);
    const bands: PolarBand[] = hemisphere === 'N'
      ? north
      : north.map((b) => ({
          // 南半球镜像：纬度取负并交换 lo/hi（保持 lo<hi）。
          latLoDeg: -b.latHiDeg,
          latHiDeg: -b.latLoDeg,
          sectors: b.sectors,
          isPoint: b.isPoint,
        }));

    return { hemisphere, level, bands, zPlaneFloors, heightStep };
  }
}
