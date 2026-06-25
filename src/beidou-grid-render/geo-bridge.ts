// ============================================================
// geo-bridge.ts — 北斗领域编解码「渲染桥」
// 层级：L1（渲染层，封装对 src/beidou-grid 领域 API 的调用）
// 职责：① 把渲染层的「经纬度/级别」吸附到标准北斗格边界（snapToGridOrigin）；
//       ② 极区守卫（编码器对 |lat|≥88° 抛错，这里安全夹取）；
//       ③ 码 → 地理 box（codeToBox2D / pointToCellBox3D）；
//       ④ 点 → 三维码（pointToCode3D）。
// 依赖：cesium、src/beidou-grid（BeiDouGeoPoint / BeiDouGridUtils）、render-constants。
// 被消费：GridTessellator（对齐原点）、AirspaceIsolator（点→码→box）、
//         GridFillPrimitive / drawPointGrid。
// ============================================================

import { Math as CesiumMath } from 'cesium';
import BeiDouGeoPoint from '@/beidou-grid/core/BeiDouGeoPoint';
import BeiDouGridUtils from '@/beidou-grid/facade/BeiDouGridUtils';
import Codec3D from '@/beidou-grid/legacy-codec/codec-3d';

import { SAFE_LAT_DEG, levelSizeMeters, levelStepDegrees } from './render-constants';

/**
 * Legacy 编码器使用的参考球半径（米），与 Codec3D 默认一致。
 * 新 facade `BeiDouGridEncoder.encode3D` 的 ELEVATION_ENCODING 表存在键缺口
 * （缺 key=2，从 1 直接跳到 3），导致 level ≥ 2 时高程查表 undefined 抛错。
 * 故渲染层的三维编码统一走 legacy Codec3D（与极区分支一致），保证 level 1..10 均可工作。
 */
const LEGACY_EARTH_RADIUS = 6378137;

/** 一个网格单元的地理范围（西南角 + 度步长 + 高度区间）。 */
export interface CellBox {
  /** 西南角经度（度）。 */
  swLonDeg: number;
  /** 西南角纬度（度）。 */
  swLatDeg: number;
  /** 经向度步长。 */
  stepLonDeg: number;
  /** 纬向度步长。 */
  stepLatDeg: number;
  /** 单元底面大地高（米）。 */
  minHeightMeters: number;
  /** 单元顶面大地高（米）。 */
  maxHeightMeters: number;
}

/** 渲染层网格原点（已吸附到标准北斗格边界）。 */
export interface GridOrigin {
  originLonDeg: number;
  originLatDeg: number;
}

/**
 * 把经纬度安全夹到北斗编码器可处理的纬度带内（|lat| < 88°）。
 * 编码器对 |lat| ≥ 88° 抛「极地区域编码尚未实现」，渲染层不能把异常透传到主循环，
 * 因此在调用编码前统一夹取；经度照常 wrap 到 [-180,180]。
 *
 * @param lonDeg 经度（度，可能越界）
 * @param latDeg 纬度（度，可能 ≥88°）
 * @returns 安全经纬度
 */
export function clampToEncodableRange(lonDeg: number, latDeg: number): { lonDeg: number; latDeg: number } {
  // 经度归一到 [-180,180]
  let lon = ((lonDeg + 180) % 360 + 360) % 360 - 180;
  if (lon === -180) lon = 180; // 规范化：-180 与 180 同一经线，统一取 180 侧避免符号歧义
  // 纬度夹到 (-88,88) 内侧
  const lat = CesiumMath.clamp(latDeg, -SAFE_LAT_DEG, SAFE_LAT_DEG);
  return { lonDeg: lon, latDeg: lat };
}

/**
 * 把任意经纬度吸附到「包含该点的标准北斗 L 级格」的【西南角】。
 *
 * 算法：用领域 encode2D 得该点所在格的二维码，再 decode2D 还原西南角点
 * （decode2D 返回的就是网格左下角）。这保证渲染格线落在标准格边界上，
 * 而不是「从可视窗口 envelope.min 直接按步长起跳」的错位近似。
 *
 * @param lonDeg 点经度（度）
 * @param latDeg 点纬度（度）
 * @param level  级别（1..10）
 * @returns 该点所在格的西南角经纬度
 */
export function snapToGridOrigin(lonDeg: number, latDeg: number, level: number): GridOrigin {
  const safe = clampToEncodableRange(lonDeg, latDeg);
  const point = new BeiDouGeoPoint(safe.lonDeg, safe.latDeg, 0);
  const code2D = BeiDouGridUtils.encode2D(point, level);
  const sw = BeiDouGridUtils.decode2D(code2D);
  return { originLonDeg: sw.getLongitude(), originLatDeg: sw.getLatitude() };
}

/**
 * 解码二维码 → 该格地理 box（西南角 + 步长；高度区间由调用方传入）。
 *
 * @param code2D          北斗二维网格码
 * @param level           该码级别（调用方已知，用于取步长；避免再解析码长）
 * @param minHeightMeters 单元底高（米）
 * @param maxHeightMeters 单元顶高（米）
 */
export function codeToBox2D(
  code2D: string,
  level: number,
  minHeightMeters: number,
  maxHeightMeters: number,
): CellBox {
  const sw = BeiDouGridUtils.decode2D(code2D);
  const [stepLonDeg, stepLatDeg] = levelStepDegrees(level);
  return {
    swLonDeg: sw.getLongitude(),
    swLatDeg: sw.getLatitude(),
    stepLonDeg,
    stepLatDeg,
    minHeightMeters,
    maxHeightMeters,
  };
}

/**
 * 给定经纬度 + 高度 + 级别 → 该点所在「三维网格单元」box。
 * 高度层高用 LEVEL_SIZE_METERS[level]（北斗三维格在该级的米尺寸），
 * 单元底高 = floor(height / sizeH) * sizeH（吸附到层边界）。
 *
 * @param lonDeg        经度（度）
 * @param latDeg        纬度（度）
 * @param heightMeters  高度（米）
 * @param level         级别（1..10）
 */
export function pointToCellBox3D(
  lonDeg: number,
  latDeg: number,
  heightMeters: number,
  level: number,
): CellBox {
  const safe = clampToEncodableRange(lonDeg, latDeg);
  const origin = snapToGridOrigin(safe.lonDeg, safe.latDeg, level);
  const [stepLonDeg, stepLatDeg] = levelStepDegrees(level);
  const sizeH = levelSizeMeters(level);
  // 高度吸附到层边界：底高为不超过 height 的最大层边界。
  const minHeightMeters = Math.floor(heightMeters / sizeH) * sizeH;
  return {
    swLonDeg: origin.originLonDeg,
    swLatDeg: origin.originLatDeg,
    stepLonDeg,
    stepLatDeg,
    minHeightMeters,
    maxHeightMeters: minHeightMeters + sizeH,
  };
}

/**
 * 给定经纬度 + 高度 + 级别 → 三维北斗网格码（带极区守卫）。
 *
 * @param lonDeg 经度（度）
 * @param latDeg 纬度（度）
 * @param heightMeters 高度（米）
 * @param level 级别（1..10）
 * @returns 三维码字符串
 */
export function pointToCode3D(lonDeg: number, latDeg: number, heightMeters: number, level: number): string {
  const safe = clampToEncodableRange(lonDeg, latDeg);
  // 走 legacy Codec3D：新 facade 的 ELEVATION_ENCODING 缺 key=2（祖传问题），level≥2 必崩。
  // legacy elevationParams 是完整顺序数组，1..10 均可，且与极区分支保持同一编码族。
  return Codec3D.encode(
    { lngDegree: safe.lonDeg, latDegree: safe.latDeg, elevation: heightMeters },
    LEGACY_EARTH_RADIUS,
    level,
  );
}

/**
 * 给定经纬度 + 级别 → 二维网格码（带极区守卫）。供标注层调用。
 */
export function pointToCode2D(lonDeg: number, latDeg: number, level: number): string {
  const safe = clampToEncodableRange(lonDeg, latDeg);
  const point = new BeiDouGeoPoint(safe.lonDeg, safe.latDeg, 0);
  return BeiDouGridUtils.encode2D(point, level);
}
