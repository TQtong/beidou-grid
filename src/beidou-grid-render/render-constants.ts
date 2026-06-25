// ============================================================
// render-constants.ts — 北斗网格渲染层精确常量与小工具
// 层级：L0（渲染层基础，无业务依赖）
// 职责：① 级别↔尺寸的精确数值表（度 / 米），避免运行时反复 Decimal 转换；
//       ② 颜色 RGBA 打包/解包（GPU 实例化用单 float 携带颜色）；
//       ③ ENU 局部切平面工具（盒子贴地表）；④ 渲染预算默认值。
// 依赖：cesium（Cartesian3 / Matrix4 / Transforms / Color / Math）。
// 被消费：geo-bridge / GridTessellator / GridLinePrimitive / GridFillPrimitive /
//         GridInstancedFill / ScaleLevelSelector / BeiDouGridScene。
// 数据来源：与 src/beidou-grid/core/BeiDouGridConstants.ts 完全一致（单测对拍）。
// ============================================================

import { Cartesian3, Color, Math as CesiumMath, Matrix4, Transforms } from 'cesium';

/** 北斗网格支持的最小 / 最大级别（含端点）。 */
export const MIN_LEVEL = 1;
export const MAX_LEVEL = 10;

/**
 * 各级网格在赤道的米尺寸（= 40075000/360 × 角度），同时用作三维层高的默认基准。
 * index = 级别（1..10）；index 0 为占位（NaN，永不使用）。
 * 这些值与 BeiDouGridConstants.GRID_SIZES_3D 精确相等，写死以省去运行时计算。
 */
export const LEVEL_SIZE_METERS: readonly number[] = [
  Number.NaN,                 // L0 占位
  445277.77777777775,         // L1  6°
  55659.722222222226,         // L2  30′
  27829.861111111113,         // L3  15′（注：经向 15′，纬向 10′，米尺寸取经向）
  1855.3240740740741,         // L4  1′
  123.68827160493827,         // L5  4″
  61.844135802469134,         // L6  2″
  7.730516975308642,          // L7  1/4″
  0.9663146219135802,         // L8  1/32″
  0.12078932773919753,        // L9  1/256″
  0.015098665967399691,       // L10 1/2048″
];

/**
 * 各级网格度步长 [stepLon°, stepLat°]。index = 级别（1..10），0 为占位。
 * 注意 L3 经向(0.25°=15′) ≠ 纬向(10/60°=10′)，逐项写死，与
 * BeiDouGridConstants.GRID_SIZES_DEGREES[L].toNumber() 精确相等。
 */
export const LEVEL_STEP_DEGREES: readonly (readonly [number, number])[] = [
  [Number.NaN, Number.NaN],                                       // L0 占位
  [6, 4],                                                         // L1
  [0.5, 0.5],                                                     // L2
  [0.25, 0.16666666666666666],                                    // L3 (15′, 10′)
  [0.016666666666666666, 0.016666666666666666],                   // L4 (1′)
  [0.0011111111111111111, 0.0011111111111111111],                 // L5 (4″)
  [0.0005555555555555556, 0.0005555555555555556],                 // L6 (2″)
  [0.00006944444444444444, 0.00006944444444444444],               // L7 (1/4″)
  [0.000008680555555555556, 0.000008680555555555556],             // L8 (1/32″)
  [0.0000010850694444444445, 0.0000010850694444444445],           // L9 (1/256″)
  [0.00000013563368055555556, 0.00000013563368055555556],         // L10 (1/2048″)
];

/**
 * 极区分界纬度：|lat| ≥ 88° 属于北斗「极区收敛格」（与中低纬的均匀经纬格拓扑不同）。
 *
 * 重要：极区编码在 legacy 编码器 Codec2D.encode 的 encodeNPole 分支已实现；
 * 而新 codec/BeiDouGridEncoder.encode2D 对 |lat|≥88° 抛错。两套 decode 均不支持极区。
 * 渲染层对极区的处理（见 doc 12）：编码路由到 legacy；不依赖 decode；
 * 用「纬圈 + 径向扇线」收敛格而非均匀经纬线格。
 *
 * 本常量 SAFE_LAT_DEG 仅用于「中低纬路径」（geo-bridge 走新 facade，要求 |lat|<88°）
 * 把落在极区边缘的点夹回，避免新 facade 抛错。
 */
export const POLAR_LIMIT_DEG = 88.0;
/** 中低纬安全上限：略小于 88°，保证新 facade encode 不抛（极区另走 doc 12）。 */
export const SAFE_LAT_DEG = 87.999999;

/** 取某级别的度步长 [stepLon, stepLat]，越界抛错（绝不静默回退）。 */
export function levelStepDegrees(level: number): readonly [number, number] {
  if (!Number.isInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
    throw new RangeError(`BeiDou grid level must be an integer in [1,10], got ${level}.`);
  }
  return LEVEL_STEP_DEGREES[level]!;
}

/** 取某级别的米尺寸（赤道），越界抛错。 */
export function levelSizeMeters(level: number): number {
  if (!Number.isInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
    throw new RangeError(`BeiDou grid level must be an integer in [1,10], got ${level}.`);
  }
  return LEVEL_SIZE_METERS[level]!;
}

const _packBuffer = new ArrayBuffer(4);
const _packView = new DataView(_packBuffer);

/**
 * 把 Cesium.Color（分量 0..1）打包成一个 float32 携带的 RGBA8888。
 * 用于 GPU 实例化：每实例只传 1 个 float 即可携带颜色，省带宽。
 *
 * 打包方式：r,g,b,a 各量化到 [0,255] 整数，按 R<<24 | G<<16 | B<<8 | A 组成 uint32，
 * 再用 Uint32→Float32 的「位重解释」存进 float 顶点缓冲（GPU 端用 unpack 还原）。
 *
 * @param color  Cesium.Color（分量 0..1）
 * @returns      一个 number（其 float32 位模式等于该 uint32）
 */
export function packColorToFloat(color: Color): number {
  const r = Math.round(CesiumMath.clamp(color.red, 0, 1) * 255) & 0xff;
  const g = Math.round(CesiumMath.clamp(color.green, 0, 1) * 255) & 0xff;
  const b = Math.round(CesiumMath.clamp(color.blue, 0, 1) * 255) & 0xff;
  const a = Math.round(CesiumMath.clamp(color.alpha, 0, 1) * 255) & 0xff;
  const u32 = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
  _packView.setUint32(0, u32, false);
  return _packView.getFloat32(0, false);
}

const _enuScratch = new Cartesian3();

/**
 * 在指定地理点建立 ENU（East-North-Up）到 ECEF 的 4×4 变换矩阵。
 * 用于把「以米为单位、轴对齐切平面」的盒子摆到地表正确朝向。
 *
 * @param lonDeg 经度（度）
 * @param latDeg 纬度（度）
 * @param heightMeters 大地高（米）
 * @param result 可选输出矩阵（复用，避免 GC）
 */
export function enuFrameAt(
  lonDeg: number,
  latDeg: number,
  heightMeters: number,
  result?: Matrix4,
): Matrix4 {
  const origin = Cartesian3.fromDegrees(lonDeg, latDeg, heightMeters, undefined, _enuScratch);
  return Transforms.eastNorthUpToFixedFrame(origin, undefined, result);
}

/** 渲染预算与外观默认值（可被 BeiDouGridConfig 覆盖）。 */
export const RENDER_DEFAULTS = {
  /** 选级别目标像素区间：单格屏幕尺寸落在 [minPx, maxPx]，理想 target。 */
  levelPx: { minPx: 24, maxPx: 160, target: 64 } as const,
  /** 预算降级阈值：渲染 bbox 内格数（×高度层）超此值则级别变粗。 */
  maxCells: 2_000_000,
  /** 线格网层放宽阈值（线数 = nx+ny，远小于格数，可放宽）。 */
  maxLatticeCells: 8_000_000,
  /** 标注数量封顶。 */
  maxLabels: 500,
  /** 线格网颜色。 */
  lineColor: Color.fromCssColorString('#35c4ff').withAlpha(0.85),
  /** 飞行器所在格高亮色。 */
  isolationColor: Color.fromCssColorString('#ff3b30').withAlpha(0.40),
  /** 隔离缓冲环颜色。 */
  bufferColor: Color.fromCssColorString('#ff9500').withAlpha(0.28),
};
