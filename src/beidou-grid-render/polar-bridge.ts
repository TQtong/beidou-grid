// ============================================================
// polar-bridge.ts — 极区（|lat|≥88°）编码路由 + 格边界正向枚举
// 层级：L1（渲染层，封装 legacy 极区编码 + 极区格几何生成）
// 职责：① 把极区点编码路由到 legacy Codec2D/Codec3D（支持极区，新 codec 不支持）；
//       ② 正向枚举极区某级的「纬度带 + 每带扇区数」（不依赖 decode——decode 极区抛错）。
// 依赖：legacy-codec（Codec2D/Codec3D/data.gridCountPole）。
// 被消费：PolarGridTessellator / PolarGridLinePrimitive / AirspaceIsolator（极区分支）。
// 重要：decode 极区不可用，故极区格边界用本模块正向生成，绝不调用 decode2D/3D。
// ============================================================

import Codec2D from '@/beidou-grid/legacy-codec/codec-2d';
import Codec3D from '@/beidou-grid/legacy-codec/codec-3d';
import { gridCountPole } from '@/beidou-grid/legacy-codec/data';

import { POLAR_LIMIT_DEG } from './render-constants';

/** 极区纬度带（含扇区数）。扇区均匀从 0° 起；sectors=1 表示圆盘（无径向线）。 */
export interface PolarBand {
  /** 带的低纬边界（度，靠赤道侧；南半球为更负值的高纬侧，见 hemisphere 说明）。 */
  latLoDeg: number;
  /** 带的高纬边界（度，靠极点侧）。 */
  latHiDeg: number;
  /** 该带经度扇区数（>=1）；1=圆盘（仅纬圈，无径向线）。 */
  sectors: number;
  /** 是否圆盘点格（最靠极点）。 */
  isPoint: boolean;
}

/** 半球。 */
export type Hemisphere = 'N' | 'S';

/** 判断纬度是否在极区。 */
export function isPolarLat(latDeg: number): boolean {
  return Math.abs(latDeg) >= POLAR_LIMIT_DEG;
}

/**
 * 极区二维编码（路由到 legacy Codec2D，支持 encodeNPole）。
 *
 * @param lonDeg 经度（度）
 * @param latDeg 纬度（度，|lat|≥88）
 * @param level  级别（1..10）
 * @returns 北斗二维码（极区）
 */
export function polarPointToCode2D(lonDeg: number, latDeg: number, level: number): string {
  return Codec2D.encode({ lngDegree: lonDeg, latDegree: latDeg }, level);
}

/**
 * 极区三维编码（路由到 legacy Codec3D）。
 *
 * @param lonDeg 经度（度）
 * @param latDeg 纬度（度，|lat|≥88）
 * @param heightMeters 高度（米）
 * @param level 级别（1..10）
 * @param earthRadius 参考球半径（默认 6378137，与 Codec3D 默认一致）
 * @returns 北斗三维码（极区）
 */
export function polarPointToCode3D(
  lonDeg: number,
  latDeg: number,
  heightMeters: number,
  level: number,
  earthRadius = 6378137,
): string {
  return Codec3D.encode(
    { lngDegree: lonDeg, latDegree: latDeg, elevation: heightMeters },
    earthRadius,
    level,
  );
}

/** 枚举用的中间格状态（POINT 圆盘 或 RING 环）。 */
interface PolarCell {
  /** 相对极冠基（88°）的纬度低偏移（度，0..2）。 */
  offLoDeg: number;
  /** 相对极冠基的纬度高偏移（度，0..2）。 */
  offHiDeg: number;
  /** 经度扇区数（1=圆盘）。 */
  sectors: number;
  /** 是否圆盘点格。 */
  isPoint: boolean;
}

/** 极冠总纬跨（度）。 */
const CAP_SPAN_DEG = 2.0;

/**
 * 正向枚举某级极区的纬度带 + 每带扇区数（北半球语义；南半球由调用方镜像）。
 *
 * 算法：从 level-1 的极冠圆盘出发，按规则逐级把每个 cell 展开成子 cell：
 *   - n=2 用特殊 4 分（含 60°/120° 扇区）；
 *   - n≥3 用 gridCountPole 一般规则（POINT→top 点 + 其余 3 扇环；RING→ K·gLng 扇）。
 *
 * 偏移语义：offLoDeg/offHiDeg 是相对 88° 的偏移（0..2°）；北半球真实纬度
 * = 88 + off；南半球 = -(88 + off)（调用方在 tessellator 里换算）。
 *
 * @param level 级别（1..10）
 * @returns PolarBand[]（offLo/offHi 已换算成北半球真实纬度填入 latLo/HiDeg）
 */
export function enumeratePolarBandsNorth(level: number): PolarBand[] {
  if (level < 1 || level > 10) {
    throw new RangeError(`polar level must be in [1,10], got ${level}.`);
  }

  // 初始：level-1 极冠圆盘 [0,2]（相对 88°），扇 1，POINT。
  let cells: PolarCell[] = [{ offLoDeg: 0, offHiDeg: CAP_SPAN_DEG, sectors: 1, isPoint: true }];

  for (let n = 2; n <= level; n++) {
    const next: PolarCell[] = [];
    if (n === 2) {
      // 特殊 4 分（来自 encodeNPole 的 n=2 分支）：把极冠 [0,2] 分 4×0.5°。
      // 自靠极点到靠赤道：[1.5,2]点 / [1.0,1.5]120°(3扇) / [0.5,1.0]60°(6扇) / [0,0.5]60°(6扇)
      const cap = cells[0]!; // n=1 只有一个圆盘
      const q = (cap.offHiDeg - cap.offLoDeg) / 4; // 0.5°
      next.push({ offLoDeg: cap.offLoDeg + 3 * q, offHiDeg: cap.offHiDeg,         sectors: 1, isPoint: true });  // [1.5,2]
      next.push({ offLoDeg: cap.offLoDeg + 2 * q, offHiDeg: cap.offLoDeg + 3 * q, sectors: 3, isPoint: false }); // [1.0,1.5] 120°
      next.push({ offLoDeg: cap.offLoDeg + 1 * q, offHiDeg: cap.offLoDeg + 2 * q, sectors: 6, isPoint: false }); // [0.5,1.0] 60°
      next.push({ offLoDeg: cap.offLoDeg + 0 * q, offHiDeg: cap.offLoDeg + 1 * q, sectors: 6, isPoint: false }); // [0,0.5]  60°
    } else {
      // n≥3 一般规则。
      const pair = gridCountPole[n]!;
      const gLng = pair[0]!;
      const gLat = pair[1]!;
      for (const cell of cells) {
        const span = cell.offHiDeg - cell.offLoDeg;
        const sub = span / gLat;
        if (cell.isPoint) {
          // 圆盘父：纬向分 gLat 带；最靠极点(最高 off)的带仍圆盘，其余为 3 扇环（120°）。
          for (let b = 0; b < gLat; b++) {
            const lo = cell.offLoDeg + b * sub;
            const hi = lo + sub;
            const topMost = b === gLat - 1; // 最靠极点
            next.push({
              offLoDeg: lo,
              offHiDeg: hi,
              sectors: topMost ? 1 : 3,   // 源码：top→point，其余 ring lngSize=120°→3 扇
              isPoint: topMost,
            });
          }
        } else {
          // 环父：纬向分 gLat 带；每带扇数 = 父扇数 · gLng。
          const childSectors = cell.sectors * gLng;
          for (let b = 0; b < gLat; b++) {
            const lo = cell.offLoDeg + b * sub;
            const hi = lo + sub;
            next.push({ offLoDeg: lo, offHiDeg: hi, sectors: childSectors, isPoint: false });
          }
        }
      }
    }
    cells = next;
  }

  // 换算成北半球真实纬度（88 + off）。
  return cells.map((c) => ({
    latLoDeg: 88.0 + c.offLoDeg,
    latHiDeg: 88.0 + c.offHiDeg,
    sectors: c.sectors,
    isPoint: c.isPoint,
  }));
}
