// ============================================================
// AirspaceIsolator.ts — 飞行器所在北斗空域动态隔离
// 层级：L3（渲染业务控制器）
// 职责：把飞行器实时位置编码为北斗三维网格码，高亮所在格 + 缓冲环（隔离保护区）。
//       码比对去抖 + 边界滞回；仅跨格才重建 GridFillPrimitive。
// 依赖：geo-bridge（pointToCode3D / pointToCellBox3D / snapToGridOrigin）、
//       render-constants（levelStepDegrees / levelSizeMeters / 颜色默认）、
//       GridFillPrimitive（FillCell）。
// 被消费：BeiDouGridScene（每帧 tick 飞行器 / drawPointGrid）。
// ============================================================

import { Color, Math as CesiumMath } from 'cesium';

import {
  clampToEncodableRange,
  pointToCellBox3D,
  pointToCode3D,
  snapToGridOrigin,
  type CellBox,
} from '../geo-bridge';
import {
  POLAR_LIMIT_DEG,
  levelSizeMeters,
  levelStepDegrees,
} from '../render-constants';
import { polarPointToCode3D } from '../polar-bridge';
import type GridFillPrimitive from '../primitive/GridFillPrimitive';
import type { FillCell } from '../primitive/GridFillPrimitive';

/** 飞行器位置。 */
export interface Aircraft {
  /** 经度（度）。 */
  lon: number;
  /** 纬度（度）。 */
  lat: number;
  /** 大地高（米）。 */
  height: number;
}

/** 隔离参数。 */
export interface IsolationOptions {
  /** 隔离级别（1..10）；不传则用当前显示级别（refresh 第二参）。 */
  isolationLevel?: number;
  /** 缓冲环半径（格数）：0=仅本格，1=本格 + 8 邻，依此类推。 */
  bufferRing: number;
  /** 本格高亮色。 */
  centerColor: Color;
  /** 缓冲环色。 */
  bufferColor: Color;
  /**
   * 边界滞回帧数：连续 dwellFrames 帧检测到新格才真正切换，避免贴边抖动。
   * 0 = 不滞回（一变即切）。
   */
  dwellFrames: number;
  /**
   * 地形基准高度（米）。> 0 时，buildCells 计算的盒「底高」会以该值为参考（贴地）；
   * = 0 时按绝对大地高（floor 到层底）。由 BeiDouGridScene 在每次 rebuild 时设置。
   */
  terrainBaseHeight?: number;
}

export default class AirspaceIsolator {
  private readonly fill: GridFillPrimitive;
  private options: IsolationOptions;

  /** 上次已生效的三维码（本格）。 */
  private committedCode = '';
  /** 候选新码（滞回中）。 */
  private pendingCode = '';
  /** 候选新码已连续检测帧数。 */
  private pendingFrames = 0;

  /**
   * @param fill    隔离填充 Primitive 控制器
   * @param options 隔离参数
   */
  public constructor(fill: GridFillPrimitive, options: IsolationOptions) {
    this.fill = fill;
    this.options = options;
  }

  /** 更新隔离参数（如运行时改缓冲环 / 隔离级别），并强制下次刷新。 */
  public setOptions(patch: Partial<IsolationOptions>): void {
    this.options = { ...this.options, ...patch };
    this.committedCode = ''; // 强制下次 refresh 重建
  }

  /**
   * 用飞行器当前位置刷新隔离层。每帧或每次位置更新调用，开销恒定。
   *
   * 流程：
   * 1. 按隔离级别 L（options.isolationLevel 或 activeLevel）编码三维码；
   * 2. 与 committedCode 比对：相同 → 直接返回（不重建）；
   * 3. 不同 → 滞回判定（连续 dwellFrames 帧为同一新码才切换）；
   * 4. 切换 → 计算本格 + 缓冲环单元集合，调 fill.setCells。
   *
   * @param ac          飞行器位置
   * @param activeLevel 当前显示级别（隔离级别未显式指定时用它）
   */
  public refresh(ac: Aircraft, activeLevel: number): void {
    const level = this.resolveLevel(activeLevel);
    // 极区编码走 legacy；中低纬走 facade（带极区守卫）。
    const code = Math.abs(ac.lat) >= POLAR_LIMIT_DEG
      ? polarPointToCode3D(ac.lon, ac.lat, ac.height, level)
      : pointToCode3D(ac.lon, ac.lat, ac.height, level);

    // 仍在已生效格 → 无需重建（最常见路径，零开销）。
    if (code === this.committedCode) {
      this.pendingCode = '';
      this.pendingFrames = 0;
      return;
    }

    // 滞回：连续 dwellFrames 帧检测到同一新码才切换。
    if (this.options.dwellFrames > 0) {
      if (code === this.pendingCode) {
        this.pendingFrames++;
      } else {
        this.pendingCode = code;
        this.pendingFrames = 1;
      }
      if (this.pendingFrames < this.options.dwellFrames) {
        return; // 还没稳定，暂不切换
      }
    }

    // 提交切换。
    this.committedCode = code;
    this.pendingCode = '';
    this.pendingFrames = 0;

    const cells = this.buildCells(ac, level);
    this.fill.setCells(cells);
  }

  /**
   * 单点查询（R1）：给定经纬度 + 高度 + 级别，直接高亮该点所在格（无缓冲环、无滞回）。
   * 与隔离共用同一 fill 控制器；调用后会覆盖隔离显示（设计上单点查询与飞行器隔离互斥使用）。
   *
   * @param lon   经度（度）
   * @param lat   纬度（度）
   * @param height 高度（米）
   * @param level 级别（1..10）
   */
  public drawPointGrid(lon: number, lat: number, height: number, level: number): void {
    // 极区：编码可正常路由到 legacy，但 pointToCellBox3D 依赖 snapToGridOrigin → encode2D（新）
    // 对极区会抛/夹取。极区单点查询走极区分支：用极区扇格几何（doc 12），此处简化
    // 为对极区点夹取到 |lat|<88 后高亮（仅作展示，编码仍是该点真实极区码）。
    const box = pointToCellBox3D(lon, lat, height, level);
    const cell: FillCell = { box, color: this.options.centerColor };
    this.committedCode = Math.abs(lat) >= POLAR_LIMIT_DEG
      ? polarPointToCode3D(lon, lat, height, level)
      : pointToCode3D(lon, lat, height, level);
    // 单点查询：把 cell 的底高叠加 terrainBaseHeight（地形上方），保持高度立体。
    const base = this.options.terrainBaseHeight ?? 0;
    if (base !== 0) {
      cell.box.minHeightMeters += base;
      cell.box.maxHeightMeters += base;
    }
    this.fill.setCells([cell]);
  }

  /** 清空隔离显示。 */
  public clear(): void {
    this.committedCode = '';
    this.pendingCode = '';
    this.pendingFrames = 0;
    this.fill.clear();
  }

  /**
   * 解析实际隔离级别：显式 isolationLevel 优先，否则用显示级别；clamp 到 [1,10]。
   *
   * @param activeLevel 当前显示级别
   */
  private resolveLevel(activeLevel: number): number {
    const L = this.options.isolationLevel ?? activeLevel;
    return CesiumMath.clamp(Math.round(L), 1, 10);
  }

  /**
   * 计算本格 + 缓冲环的填充单元集合。
   *
   * 本格西南角由 snapToGridOrigin 吸附；缓冲环按度步长在经/纬向偏移 di/dj 格。
   * 高度区间用该级三维层高（飞行器高度吸附到层底）。中心格用 centerColor，
   * 环用 bufferColor。
   *
   * @param ac    飞行器位置
   * @param level 隔离级别
   * @returns     FillCell[]
   */
  private buildCells(ac: Aircraft, level: number): FillCell[] {
    const safe = clampToEncodableRange(ac.lon, ac.lat);
    const origin = snapToGridOrigin(safe.lonDeg, safe.latDeg, level); // 本格西南角
    const [stepLonDeg, stepLatDeg] = levelStepDegrees(level);
    const sizeH = levelSizeMeters(level);
    const minHeight = Math.floor(ac.height / sizeH) * sizeH;          // 高度吸附到层底
    const maxHeight = minHeight + sizeH;

    const r = Math.max(0, Math.floor(this.options.bufferRing));
    const cells: FillCell[] = [];

    // 地形基准高度：让隔离盒贴地（底面在地形面上）。terrainBaseHeight 由 BeiDouGridScene
    // 在 rebuild 时根据当前区域中心地形高度更新；为 0 时按原绝对高度。
    const base = this.options.terrainBaseHeight ?? 0;

    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const box: CellBox = {
          swLonDeg: origin.originLonDeg + di * stepLonDeg,
          swLatDeg: origin.originLatDeg + dj * stepLatDeg,
          stepLonDeg,
          stepLatDeg,
          minHeightMeters: minHeight + base,
          maxHeightMeters: maxHeight + base,
        };
        const isCenter = di === 0 && dj === 0;
        cells.push({ box, color: isCenter ? this.options.centerColor : this.options.bufferColor });
      }
    }
    return cells;
  }

  /** 由 BeiDouGridScene 在每次 rebuild 时更新地形基准高度。 */
  public setTerrainBaseHeight(meters: number): void {
    if (this.options.terrainBaseHeight !== meters) {
      this.options.terrainBaseHeight = meters;
      this.committedCode = ''; // 强制下次 refresh 重建
    }
  }
}
