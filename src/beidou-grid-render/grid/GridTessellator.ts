// ============================================================
// GridTessellator.ts — 渲染网格剖分（区域 + 级别 → 对齐原点 + nx/ny/zPlanes）
// 层级：L2（渲染调度子模块）
// 职责：把渲染区域吸附到标准北斗格边界（用 geo-bridge.snapToGridOrigin），
//       产出经/纬向行列数与高度层数组。全程标量，绝不创建逐格对象（百万格也只
//       返回几个标量 + 一个高度层数组）。
// 依赖：cesium（Rectangle/Math）、render-constants、geo-bridge、ViewRegionResolver 的 RegionResult。
// 被消费：GridLinePrimitive / GridLabelPrimitive / GridInstancedFill。
// ============================================================

import { Math as CesiumMath, type Rectangle } from 'cesium';

import {
  POLAR_LIMIT_DEG,
  levelSizeMeters,
  levelStepDegrees,
} from '../render-constants';
import { snapToGridOrigin } from '../geo-bridge';
import type { RegionResult } from '../region/ViewRegionResolver';

/** 高度区间（航空空域层）。 */
export interface HeightRange {
  /** 最小大地高（米）。 */
  min: number;
  /** 最大大地高（米）。 */
  max: number;
  /**
   * 高度层步长（米）。为 0 或负时，用该级别的北斗三维格层高
   * LEVEL_SIZE_METERS[level]（见 tessellate 内逻辑）。
   */
  step: number;
}

/** 剖分结果（纯标量 + 高度层数组），喂给各 Primitive 构建器。 */
export interface Tessellation {
  /** 级别（1..10）。 */
  level: number;
  /** 对齐后的格网西南原点经度（度）。 */
  originLonDeg: number;
  /** 对齐后的格网西南原点纬度（度）。 */
  originLatDeg: number;
  /** 经向度步长。 */
  stepLonDeg: number;
  /** 纬向度步长。 */
  stepLatDeg: number;
  /** 经向格数（覆盖区域）。 */
  nx: number;
  /** 纬向格数（覆盖区域）。 */
  ny: number;
  /** 是否跨反子午线（透传自 RegionResult）。 */
  crossesAntimeridian: boolean;
  /** 高度层【底面】高度数组（米），长度 = 层数；每层顶面 = 该值 + heightStep。 */
  zPlaneFloors: number[];
  /** 高度层步长（米，实际生效值）。 */
  heightStep: number;
}

export default class GridTessellator {
  /**
   * 把渲染区域剖分成标准北斗格网。
   *
   * 步骤：
   * 1. 取区域西南角经纬度（弧度→度）。
   * 2. snapToGridOrigin：用领域 encode2D→decode2D 把西南角吸附到标准格【西南角】，
   *    得到 originLon/Lat（保证格线落在标准边界上，不错位半格）。
   * 3. nx = ceil((east-origin)/stepLon)+1，ny 同理（+1 让格网完整盖住区域右/上边界）。
   * 4. 高度层：step≤0 时用 LEVEL_SIZE_METERS[level] 作层高；从 min 到 max 生成层底数组。
   *
   * 跨反子午线时，east 用「逻辑东经」(= west + widthDeg) 计算 nx，避免 east<west 导致负数。
   *
   * 极区衔接：纬度夹到 [-POLAR_LIMIT_DEG, POLAR_LIMIT_DEG]——|lat|≥88° 由 doc 12
   * 极区收敛格单独渲染，本均匀格只覆盖 |lat|<88°。
   *
   * @param region     ViewRegionResolver 解析结果
   * @param level      级别（1..10）
   * @param heightRange 高度区间
   * @returns          Tessellation（纯标量 + 层底数组）
   */
  public static tessellate(
    region: RegionResult,
    level: number,
    heightRange: HeightRange,
  ): Tessellation {
    const rect: Rectangle = region.rectangle;
    const [stepLonDeg, stepLatDeg] = levelStepDegrees(level);

    const westDeg = CesiumMath.toDegrees(rect.west);
    const southDegRaw = CesiumMath.toDegrees(rect.south);

    // 极区衔接：south/north 夹到 ±88°，把极冠交给 PolarGridTessellator。
    const southDeg = Math.max(-POLAR_LIMIT_DEG, southDegRaw);

    // 吸附西南角到标准格边界（少量编码/解码调用，非逐格）。
    const origin = snapToGridOrigin(westDeg, southDeg, level);
    const originLonDeg = origin.originLonDeg;
    const originLatDeg = origin.originLatDeg;

    // 逻辑东经/北纬（跨界用 west+width 得到连续东经，避免 east<west）。
    const eastLogicalDeg = westDeg + region.widthDeg;
    const northDegRaw = southDegRaw + region.heightDeg;
    const northDeg = Math.min(POLAR_LIMIT_DEG, northDegRaw);

    // 行列数：+1 确保覆盖区域右/上边界所在的整格。
    const nxRaw = Math.ceil((eastLogicalDeg - originLonDeg) / stepLonDeg) + 1;
    const nyRaw = Math.ceil((northDeg - originLatDeg) / stepLatDeg) + 1;
    const nx = Math.max(1, nxRaw);
    const ny = Math.max(1, nyRaw);

    // 高度层步长：≤0 → 用该级三维格层高。
    const heightStep = heightRange.step > 0 ? heightRange.step : levelSizeMeters(level);
    const zPlaneFloors: number[] = [];
    // 从 min 起，逐层底高，直到底高 ≥ max（确保至少一层；用 1e-6 容差吃掉浮点尾差）。
    for (let h = heightRange.min; h < heightRange.max - 1e-6; h += heightStep) {
      zPlaneFloors.push(h);
    }
    if (zPlaneFloors.length === 0) {
      // 区间退化（min≈max）也保证一层，避免空高度。
      zPlaneFloors.push(heightRange.min);
    }

    return {
      level,
      originLonDeg,
      originLatDeg,
      stepLonDeg,
      stepLatDeg,
      nx,
      ny,
      crossesAntimeridian: region.crossesAntimeridian,
      zPlaneFloors,
      heightStep,
    };
  }

  /**
   * 估算剖分的总格数（nx·ny·层数）。供调用方二次校验/日志（剖分后再确认未超预算）。
   *
   * @param t 剖分结果
   */
  public static cellCount(t: Tessellation): number {
    return t.nx * t.ny * Math.max(1, t.zPlaneFloors.length);
  }

  /**
   * 计算第 (i,j) 格的西南角经纬度（度）。供标注/隔离按需取单格用；
   * 线格网层不调用它（线格网按 origin+步长直接算线端点）。
   *
   * @param t 剖分
   * @param i 经向索引 [0, nx)
   * @param j 纬向索引 [0, ny)
   */
  public static cellSouthWest(t: Tessellation, i: number, j: number): { lonDeg: number; latDeg: number } {
    return {
      lonDeg: t.originLonDeg + i * t.stepLonDeg,
      latDeg: t.originLatDeg + j * t.stepLatDeg,
    };
  }
}
