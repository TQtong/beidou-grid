/**
 * 两满填充引擎的 **CPU 重建 + 显存** 对比基准（见设计 08）。
 *
 * 在不接 GPU 的纯 CPU/算法层面，复现并测量两引擎在一次 `moveEnd` 重建里真正跑在主线程的工作量
 * （这正是造成掉帧的部分）：
 *   - attribute：为每格算 ENU 中心、写 6 float 位置/尺寸 + 4 byte 颜色（查调色板）；
 *   - gpu：把 categories 一次 `set()` 进 `texW×texH` padding 缓冲 + 清尾部。
 * 并按字节精确给出两者「CPU 端分配/写入」与「需上传 GPU」的内存量与倍率。
 */

const ATTR_FLOATS_PER_INSTANCE = 6 // center.xyz + size.xyz
const ATTR_BYTES_PER_INSTANCE = ATTR_FLOATS_PER_INSTANCE * 4 + 4 // 24B 位置/尺寸 + 4B 颜色 = 28B
const GPU_TEX_WIDTH = 4096
const PALETTE_BYTES = 256 * 4

export interface GpuBenchRow {
  label: 'attribute' | 'gpu'
  cpuBuildMs: number
  cpuBytes: number
  uploadBytes: number
}

export interface GpuBenchResult {
  nx: number
  ny: number
  planes: number
  total: number
  attribute: GpuBenchRow
  gpu: GpuBenchRow
  /** attribute.cpuBuildMs / gpu.cpuBuildMs。 */
  cpuSpeedup: number
  /** attribute.uploadBytes / gpu.uploadBytes（≈28×）。 */
  uploadRatio: number
}

/** 确定性步进生成类别（多次 run 负载一致，避免随机带来的方差）。 */
const makeCategories = (total: number, fillRatio: number): Uint8Array => {
  const cats = new Uint8Array(total)
  const period = Math.max(2, Math.round(1 / Math.max(0.01, fillRatio)))
  for (let k = 0; k < total; k++) cats[k] = k % period === 0 ? 1 + (k % 3) : 0
  return cats
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** 复现 GridInstancedFill 的紧循环（attribute）。 */
const buildAttributeOnce = (nx: number, ny: number, planes: number, cats: Uint8Array): number => {
  const total = nx * ny * planes
  const xf = new Float32Array(total * ATTR_FLOATS_PER_INSTANCE)
  const col = new Uint8Array(total * 4)
  const pal = new Uint8Array(PALETTE_BYTES)
  pal.set([255, 59, 48, 230], 1 * 4)

  const dimX = 50,
    dimY = 50,
    dimZ = 1000

  const t0 = performance.now()
  let w = 0,
    c = 0
  for (let zi = 0; zi < planes; zi++) {
    const cz = zi * dimZ + dimZ * 0.5
    for (let j = 0; j < ny; j++) {
      const cy = (j + 0.5) * dimY
      const rowBase = (zi * ny + j) * nx
      for (let i = 0; i < nx; i++) {
        const cx = (i + 0.5) * dimX
        xf[w++] = cx
        xf[w++] = cy
        xf[w++] = cz
        xf[w++] = dimX
        xf[w++] = dimY
        xf[w++] = dimZ
        const cat = cats[rowBase + i] ?? 0
        const pb = cat * 4
        col[c++] = pal[pb] ?? 0
        col[c++] = pal[pb + 1] ?? 0
        col[c++] = pal[pb + 2] ?? 0
        col[c++] = pal[pb + 3] ?? 0
      }
    }
  }
  const dt = performance.now() - t0
  // 防 DCE。
  if (xf[0] === Number.POSITIVE_INFINITY || (col[0] === 255 && col[3] === 254)) console.log('noop')
  return dt
}

/** 复现 GridInstancedVoxelGPU 的 memcpy（gpu）。 */
const buildGpuOnce = (total: number, cats: Uint8Array): number => {
  const texW = GPU_TEX_WIDTH
  const texH = Math.max(1, Math.ceil(total / texW))
  const scratch = new Uint8Array(texW * texH)

  const t0 = performance.now()
  scratch.set(cats)
  if (scratch.length > total) scratch.fill(0, total)
  const dt = performance.now() - t0
  if (scratch[0] === 255 && scratch[texW * texH - 1] === 254) console.log('noop')
  return dt
}

/** 单点对比。 */
export const benchInstancedGpuVsAttribute = (
  nx: number,
  ny: number,
  planes: number,
  runs = 7,
  fillRatio = 0.5,
): GpuBenchResult => {
  const total = nx * ny * planes
  const cats = makeCategories(total, fillRatio)

  buildAttributeOnce(nx, ny, planes, cats) // 预热（JIT），不计入
  buildGpuOnce(total, cats)

  const attrMs: number[] = []
  const gpuMs: number[] = []
  for (let r = 0; r < runs; r++) attrMs.push(buildAttributeOnce(nx, ny, planes, cats))
  for (let r = 0; r < runs; r++) gpuMs.push(buildGpuOnce(total, cats))

  const texH = Math.max(1, Math.ceil(total / GPU_TEX_WIDTH))
  const gpuCpuBytes = GPU_TEX_WIDTH * texH + PALETTE_BYTES
  const gpuUploadBytes = GPU_TEX_WIDTH * texH + PALETTE_BYTES
  const attrCpuBytes = total * ATTR_BYTES_PER_INSTANCE + PALETTE_BYTES
  const attrUploadBytes = total * ATTR_BYTES_PER_INSTANCE

  const attribute: GpuBenchRow = {
    label: 'attribute',
    cpuBuildMs: median(attrMs),
    cpuBytes: attrCpuBytes,
    uploadBytes: attrUploadBytes,
  }
  const gpu: GpuBenchRow = {
    label: 'gpu',
    cpuBuildMs: median(gpuMs),
    cpuBytes: gpuCpuBytes,
    uploadBytes: gpuUploadBytes,
  }

  return {
    nx,
    ny,
    planes,
    total,
    attribute,
    gpu,
    cpuSpeedup: gpu.cpuBuildMs > 0 ? attribute.cpuBuildMs / gpu.cpuBuildMs : Number.POSITIVE_INFINITY,
    uploadRatio: gpu.uploadBytes > 0 ? attribute.uploadBytes / gpu.uploadBytes : Number.POSITIVE_INFINITY,
  }
}

const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(2)} MB`

/** 控制台打印单点结果。 */
export const printInstancedGpuBench = (r: GpuBenchResult): void => {
  console.log(
    `北斗满填充引擎对比 — ${r.nx}×${r.ny}×${r.planes} = ${r.total.toLocaleString()} 格`,
  )
  console.table({
    'attribute（旧）': {
      'CPU重建(ms)': r.attribute.cpuBuildMs.toFixed(3),
      CPU字节: mb(r.attribute.cpuBytes),
      上传字节: mb(r.attribute.uploadBytes),
    },
    'gpu（新·默认）': {
      'CPU重建(ms)': r.gpu.cpuBuildMs.toFixed(3),
      CPU字节: mb(r.gpu.cpuBytes),
      上传字节: mb(r.gpu.uploadBytes),
    },
  })
  console.log(
    `→ CPU 重建提速 ≈ ${r.cpuSpeedup.toFixed(1)}×，上传字节压缩 ≈ ${r.uploadRatio.toFixed(1)}×`,
  )
}

/** 一组档位扫描：~1e5 → 1e6 → 4e6 → 1e7。 */
export const benchInstancedGpuSweep = (runs = 5): GpuBenchResult[] => {
  const cases: Array<[number, number, number]> = [
    [316, 316, 1],
    [1000, 1000, 1],
    [1000, 1000, 4],
    [1000, 1000, 10],
  ]
  const out: GpuBenchResult[] = []
  for (const [nx, ny, planes] of cases) {
    const r = benchInstancedGpuVsAttribute(nx, ny, planes, runs)
    printInstancedGpuBench(r)
    out.push(r)
  }
  return out
}
