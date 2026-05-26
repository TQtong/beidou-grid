// ============================================================
// bench/RebuildBench.ts — 重建链路性能探针
// 层级：测试 / 诊断
// 职责：用 performance.now 包裹各阶段，统计 选级别/解析区域/剖分/线格网/标注/
//       (满填充) 各段耗时与总耗时；输出可读报告。
// 依赖：cesium、beidou-grid-render 各模块。
// 用法：在 BeiDouGridScene.rebuild 内插桩，或在外部对固定相机姿态压测。
// ============================================================

import type { Scene } from 'cesium';
import ScaleLevelSelector from '../level/ScaleLevelSelector';
import ViewRegionResolver from '../region/ViewRegionResolver';
import GridTessellator from '../grid/GridTessellator';
import GridLinePrimitive from '../primitive/GridLinePrimitive';
import { RENDER_DEFAULTS } from '../render-constants';

/** 单次重建各阶段耗时（毫秒）。 */
export interface BenchReport {
  pickLevelMs: number;
  resolveRegionMs: number;
  tessellateMs: number;
  lineRebuildMs: number;
  totalMs: number;
  level: number;
  nx: number;
  ny: number;
  zPlanes: number;
  cellCount: number;
  lineSegEstimate: number;
}

/**
 * 对当前相机姿态压测一次完整线格网重建链路，返回各阶段耗时。
 *
 * @param scene Cesium 场景
 * @param line  线格网控制器（独立创建用于压测，避免污染正式场景）
 * @returns     BenchReport
 */
export function benchRebuild(scene: Scene, line: GridLinePrimitive): BenchReport {
  const t0 = performance.now();

  const pick = ScaleLevelSelector.pickLevel(scene, RENDER_DEFAULTS.levelPx);
  const t1 = performance.now();

  const region = ViewRegionResolver.resolveRegion(scene, undefined);
  const t2 = performance.now();

  if (!region) {
    return {
      pickLevelMs: t1 - t0, resolveRegionMs: t2 - t1, tessellateMs: 0,
      lineRebuildMs: 0, totalMs: t2 - t0, level: pick.level,
      nx: 0, ny: 0, zPlanes: 0, cellCount: 0, lineSegEstimate: 0,
    };
  }

  const level = ViewRegionResolver.clampLevelByBudget(region, pick.level, 1, RENDER_DEFAULTS.maxCells);
  const tess = GridTessellator.tessellate(region, level, { min: 0, max: 20000, step: 1000 });
  const t3 = performance.now();

  line.rebuild(tess, {
    color: RENDER_DEFAULTS.lineColor,
    lineWidth: 1,
    drawVerticalEdges: tess.zPlaneFloors.length > 1,
  });
  const t4 = performance.now();

  return {
    pickLevelMs: t1 - t0,
    resolveRegionMs: t2 - t1,
    tessellateMs: t3 - t2,
    lineRebuildMs: t4 - t3,
    totalMs: t4 - t0,
    level,
    nx: tess.nx,
    ny: tess.ny,
    zPlanes: tess.zPlaneFloors.length,
    cellCount: GridTessellator.cellCount(tess),
    // 线段估算：经向(nx+1) + 纬向(ny+1)，每层。
    lineSegEstimate: ((tess.nx + 1) + (tess.ny + 1)) * tess.zPlaneFloors.length,
  };
}

/**
 * 多次取样求中位数，平滑抖动；打印报告。
 *
 * @param scene Cesium 场景
 * @param runs  取样次数（默认 20）
 */
export function benchRebuildMedian(scene: Scene, runs = 20): BenchReport {
  const line = new GridLinePrimitive(scene.primitives);
  const reports: BenchReport[] = [];
  for (let i = 0; i < runs; i++) reports.push(benchRebuild(scene, line));
  line.destroy();

  const median = (key: keyof BenchReport): number => {
    const arr = reports.map((r) => r[key] as number).sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)]!;
  };

  const out: BenchReport = {
    pickLevelMs: median('pickLevelMs'),
    resolveRegionMs: median('resolveRegionMs'),
    tessellateMs: median('tessellateMs'),
    lineRebuildMs: median('lineRebuildMs'),
    totalMs: median('totalMs'),
    level: reports[0]!.level,
    nx: reports[0]!.nx,
    ny: reports[0]!.ny,
    zPlanes: reports[0]!.zPlanes,
    cellCount: reports[0]!.cellCount,
    lineSegEstimate: reports[0]!.lineSegEstimate,
  };

  // 可读报告。

  console.table({
    '选级别(ms)': out.pickLevelMs.toFixed(2),
    '解析区域(ms)': out.resolveRegionMs.toFixed(2),
    '剖分(ms)': out.tessellateMs.toFixed(2),
    '线格网重建(ms)': out.lineRebuildMs.toFixed(2),
    '总计(ms)': out.totalMs.toFixed(2),
    级别: out.level,
    'nx×ny×层': `${out.nx}×${out.ny}×${out.zPlanes}`,
    格数: out.cellCount.toLocaleString('zh-CN'),
    线段数: out.lineSegEstimate.toLocaleString('zh-CN'),
  });
  return out;
}

/**
 * 单独压测满填充实例缓冲的 CPU 构建耗时（不含 GPU 上传）。
 * 验证「1e6 实例紧循环填充 < 80ms」。
 *
 * @param nx 经向格数
 * @param ny 纬向格数
 * @param planes 高度层数
 */
export function benchInstanceBuffer(nx: number, ny: number, planes: number): number {
  const total = nx * ny * planes;
  const xf = new Float32Array(total * 6);   // 中心 + 尺寸
  const col = new Uint8Array(total * 4);    // RGBA
  const cats = new Uint8Array(total);       // 类别
  const pal = new Uint8Array(256 * 4);
  pal.set([255, 59, 48, 90], 1 * 4);

  const dimX = 50, dimY = 50, dimZ = 1000;
  const t0 = performance.now();
  let w = 0, c = 0;
  for (let zi = 0; zi < planes; zi++) {
    const cz = zi * dimZ + dimZ / 2;
    for (let j = 0; j < ny; j++) {
      const cy = (j + 0.5) * dimY;
      const rowBase = (zi * ny + j) * nx;
      for (let i = 0; i < nx; i++) {
        const cx = (i + 0.5) * dimX;
        xf[w++] = cx; xf[w++] = cy; xf[w++] = cz;
        xf[w++] = dimX; xf[w++] = dimY; xf[w++] = dimZ;
        const cat = cats[rowBase + i]!;
        const pb = cat * 4;
        col[c++] = pal[pb]!;
        col[c++] = pal[pb + 1]!;
        col[c++] = pal[pb + 2]!;
        col[c++] = pal[pb + 3]!;
      }
    }
  }
  const dt = performance.now() - t0;
  // 防 DCE：读一个值。
  if (xf[0] === Number.POSITIVE_INFINITY) console.log(col[0]);
  return dt;
}
