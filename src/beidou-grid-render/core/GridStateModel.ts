// ============================================================
// GridStateModel.ts — 立方体场「每格状态」CPU 合成模型
// 层级：L1（渲染核心，纯 CPU，无 Cesium 渲染依赖）
// 职责：把「选中状态 + 无人机影响」合成为一张「每实例 1 字节类别」的状态缓冲
//       （供上传到 GPU 状态纹理），并生成「类别 → RGBA」的双调色板（线框 / 填充
//       对空格透明度需求不同）。同时负责：
//        ① 实例号 ↔ 网格索引 (i,j,zi) ↔ 地理中心 的互转；
//        ② 选中态跨「重建（pan）」持久化（按地理中心 + 级别建键，平移保留、变级别重置）；
//        ③ 无人机球形影响区的增量标记（仅遍历邻域，CORE/INFLUENCE 分级）。
// 类别优先级：DRONE_CORE > DRONE_INFLUENCE > SELECT_* > EMPTY。
// 被消费：GridCubeField。
// ============================================================

/** 网格类别枚举（与调色板槽位、着色器采样值一致；0..255）。 */
export const Category = {
  /** 空格（默认）：线框可见、填充近透明。 */
  EMPTY: 0,
  /** 无人机所在格（核心）。 */
  DRONE_CORE: 1,
  /** 无人机影响范围内的格。 */
  DRONE_INFLUENCE: 2,
  /** 用户选中色 A（黄）。 */
  SELECT_A: 10,
  /** 用户选中色 B（绿）。 */
  SELECT_B: 11,
  /** 用户选中色 C（品红）。 */
  SELECT_C: 12,
} as const;

/** 选中态点击循环顺序：空 → A → B → C → 空。 */
const SELECT_CYCLE: readonly number[] = [
  Category.EMPTY,
  Category.SELECT_A,
  Category.SELECT_B,
  Category.SELECT_C,
];

/** 单格的当前剖分上下文（由 setGrid 写入，供索引/地理互转复用）。 */
interface GridContext {
  /** 级别（1..10）。 */
  level: number;
  /** 西南原点经度（度，已吸附标准格）。 */
  originLonDeg: number;
  /** 西南原点纬度（度）。 */
  originLatDeg: number;
  /** 原点大地高（米，= 第一层底高）。 */
  originHeightMeters: number;
  /** 经向度步长。 */
  stepLonDeg: number;
  /** 纬向度步长。 */
  stepLatDeg: number;
  /** 层高（米）。 */
  heightStepMeters: number;
  /** 经向格数。 */
  nx: number;
  /** 纬向格数。 */
  ny: number;
  /** 高度层数。 */
  planes: number;
  /** 每经度米（= dimX/stepLon，随原点纬度 cos 收缩）。 */
  metersPerDegLon: number;
  /** 每纬度米（≈111320）。 */
  metersPerDegLat: number;
}

/** 持久化的选中条目（按地理中心 + 级别建键）。 */
interface SelectionEntry {
  /** 级别（用于变级别时剔除失配选中）。 */
  level: number;
  /** 格中心经度（度）。 */
  lonCenterDeg: number;
  /** 格中心纬度（度）。 */
  latCenterDeg: number;
  /** 高度层索引。 */
  zi: number;
  /** 选中类别（SELECT_A/B/C）。 */
  category: number;
}

/** 赤道每度米长（纬向恒定近似）。 */
const METERS_PER_DEG_LAT = 111320.0;

/**
 * 把 0..1 颜色分量与 alpha 写入调色板字节缓冲的指定类别槽。
 *
 * @param palette 256×4 字节缓冲
 * @param category 类别（0..255）
 * @param r 红 0..255
 * @param g 绿 0..255
 * @param b 蓝 0..255
 * @param a 透明度 0..255
 */
function setPaletteSlot(
  palette: Uint8Array,
  category: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const o = category * 4;
  palette[o] = r;
  palette[o + 1] = g;
  palette[o + 2] = b;
  palette[o + 3] = a;
}

export default class GridStateModel {
  /** 当前剖分上下文（首次 setGrid 前为 undefined）。 */
  private ctx: GridContext | undefined;

  /** 实例总数 n = nx·ny·planes。 */
  private count = 0;

  /** 状态纹理宽（≈ ceil(sqrt(n))，下取 2 的整十量级以内）。 */
  private texWidth = 1;
  /** 状态纹理高（= ceil(n/texWidth)）。 */
  private texHeight = 1;

  /** 上传到 GPU 的状态字节缓冲（length = texWidth·texHeight·4，仅 R 通道有效）。 */
  private texData = new Uint8Array(4);

  /** 逻辑「基础类别」层（EMPTY + 选中），不含无人机叠加（length = n）。 */
  private baseCat = new Uint8Array(1);

  /** 无人机占用标记（1=被无人机覆盖；length = n），用于点击时判定 drone 是否压住选中。 */
  private droneFlag = new Uint8Array(1);

  /** 当前被无人机标记的实例号列表（增量恢复用）。 */
  private droneIds: number[] = [];

  /** 选中态持久化表（键 = `${level}|${lonC}|${latC}|${zi}`）。 */
  private selections = new Map<string, SelectionEntry>();

  /** 线框模式调色板（256×4，空格半透明可见）。 */
  private readonly paletteWire = new Uint8Array(256 * 4);
  /** 填充模式调色板（256×4，空格近透明）。 */
  private readonly paletteFill = new Uint8Array(256 * 4);

  /** 无人机影响标记的安全上限（防止半径过大 / 格过细导致邻域爆炸）。 */
  private readonly maxDroneCells = 200_000;

  public constructor() {
    this.buildPalettes();
  }

  /**
   * 构建双调色板。两套仅在「空格 EMPTY」的 alpha 上不同：
   *  - 线框：空格 cyan α≈0.5（让默认网格清晰可见）；
   *  - 填充：空格 cyan α≈0.06（满屏实心盒时空格几乎透明，只凸显被标记格）。
   * 其余类别两套一致；未列出的类别 alpha=0（着色器 discard）。
   */
  private buildPalettes(): void {
    // 先全部清零（alpha=0 → 透明 → discard）。
    this.paletteWire.fill(0);
    this.paletteFill.fill(0);

    // EMPTY：cyan，线框清晰醒目 / 填充淡可见（凸显立方体轮廓）。
    setPaletteSlot(this.paletteWire, Category.EMPTY, 80, 240, 255, 224); // α≈0.88（明亮网格线）
    setPaletteSlot(this.paletteFill, Category.EMPTY, 0, 229, 255, 34); //  α≈0.13

    // DRONE_CORE：红。
    setPaletteSlot(this.paletteWire, Category.DRONE_CORE, 255, 59, 48, 242); // α≈0.95
    setPaletteSlot(this.paletteFill, Category.DRONE_CORE, 255, 59, 48, 217); // α≈0.85

    // DRONE_INFLUENCE：橙。
    setPaletteSlot(this.paletteWire, Category.DRONE_INFLUENCE, 255, 149, 0, 217); // α≈0.85
    setPaletteSlot(this.paletteFill, Category.DRONE_INFLUENCE, 255, 149, 0, 128); // α≈0.50

    // SELECT_A：黄。
    setPaletteSlot(this.paletteWire, Category.SELECT_A, 255, 214, 10, 242);
    setPaletteSlot(this.paletteFill, Category.SELECT_A, 255, 214, 10, 204); // α≈0.80

    // SELECT_B：绿。
    setPaletteSlot(this.paletteWire, Category.SELECT_B, 48, 209, 88, 242);
    setPaletteSlot(this.paletteFill, Category.SELECT_B, 48, 209, 88, 204);

    // SELECT_C：品红。
    setPaletteSlot(this.paletteWire, Category.SELECT_C, 191, 90, 242, 242);
    setPaletteSlot(this.paletteFill, Category.SELECT_C, 191, 90, 242, 204);
  }

  /**
   * 设定（或更新）当前剖分上下文，并据此：重算实例数与纹理尺寸、重建基础类别层
   * （从持久化选中表按地理中心重映射，剔除级别失配项）、清空无人机叠加。
   *
   * @param p 剖分上下文参数
   * @returns 纹理尺寸是否发生变化（变化则上层需重建 GPU 纹理）
   */
  public setGrid(p: {
    level: number;
    originLonDeg: number;
    originLatDeg: number;
    originHeightMeters: number;
    stepLonDeg: number;
    stepLatDeg: number;
    heightStepMeters: number;
    nx: number;
    ny: number;
    planes: number;
    metersPerDegLon: number;
  }): boolean {
    const ctx: GridContext = {
      level: p.level,
      originLonDeg: p.originLonDeg,
      originLatDeg: p.originLatDeg,
      originHeightMeters: p.originHeightMeters,
      stepLonDeg: p.stepLonDeg,
      stepLatDeg: p.stepLatDeg,
      heightStepMeters: p.heightStepMeters,
      nx: p.nx,
      ny: p.ny,
      planes: p.planes,
      metersPerDegLon: p.metersPerDegLon,
      metersPerDegLat: METERS_PER_DEG_LAT,
    };
    this.ctx = ctx;

    const n = ctx.nx * ctx.ny * ctx.planes;
    this.count = n;

    // 纹理尺寸：近似正方形，宽 = ceil(sqrt(n))，高 = ceil(n/宽)。
    const newW = Math.max(1, Math.ceil(Math.sqrt(n)));
    const newH = Math.max(1, Math.ceil(n / newW));
    const sizeChanged = newW !== this.texWidth || newH !== this.texHeight;
    this.texWidth = newW;
    this.texHeight = newH;

    // 重新分配 CPU 缓冲（容量不足才新建，避免频繁 GC）。
    const texLen = newW * newH * 4;
    if (this.texData.length < texLen) {
      this.texData = new Uint8Array(texLen);
    }
    if (this.baseCat.length < n) {
      this.baseCat = new Uint8Array(n);
    }
    if (this.droneFlag.length < n) {
      this.droneFlag = new Uint8Array(n);
    }

    // 清空当前帧使用的区段（仅前 n / texLen，避免清整段大 buffer 的浪费）。
    this.baseCat.fill(0, 0, n);
    this.droneFlag.fill(0, 0, n);
    this.droneIds.length = 0;
    // texData 仅 R 通道有意义；这里整段（含 G/B/A）清零，保证尾部填充区也为 0。
    this.texData.fill(0, 0, texLen);

    // 选中态重映射：剔除级别失配项；其余按地理中心定位到新索引并写入 baseCat。
    this.remapSelections();

    // 基础类别 → texData（无人机叠加在后续 setDroneInfluence 时再覆盖）。
    this.composeBaseIntoTex();

    return sizeChanged;
  }

  /**
   * 把当前选中表按地理中心重映射到新剖分的实例索引，写入 baseCat。
   * 级别与当前不一致的条目直接删除（变级别重置选中，避免漂移）。
   */
  private remapSelections(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const [key, entry] of this.selections) {
      if (entry.level !== ctx.level) {
        this.selections.delete(key);
        continue;
      }
      const idx = this.geoCenterToIndex(entry.lonCenterDeg, entry.latCenterDeg, entry.zi);
      if (idx >= 0) {
        this.baseCat[idx] = entry.category;
      }
      // 落在当前区域之外的选中：保留在表中（平移回来仍可复现），但本次不写 texData。
    }
  }

  /** 把 baseCat 的前 n 项写入 texData 的 R 通道（行优先，纹素号 = 实例号）。 */
  private composeBaseIntoTex(): void {
    const n = this.count;
    const tex = this.texData;
    const base = this.baseCat;
    for (let id = 0; id < n; id++) {
      tex[id * 4] = base[id]!;
    }
  }

  /**
   * 由「格中心经纬度 + 层索引」定位实例号（用于选中持久化重映射）。
   * 因原点恒吸附到全局标准北斗格，同级别下中心点落在全局固定格点上，
   * floor((center−origin)/step) 在同级别平移时给出稳定且精确的索引。
   *
   * @returns 实例号；越界返回 -1
   */
  private geoCenterToIndex(lonCenterDeg: number, latCenterDeg: number, zi: number): number {
    const ctx = this.ctx;
    if (!ctx) return -1;
    const i = Math.floor((lonCenterDeg - ctx.originLonDeg) / ctx.stepLonDeg);
    const j = Math.floor((latCenterDeg - ctx.originLatDeg) / ctx.stepLatDeg);
    if (i < 0 || i >= ctx.nx || j < 0 || j >= ctx.ny || zi < 0 || zi >= ctx.planes) {
      return -1;
    }
    return (zi * ctx.ny + j) * ctx.nx + i;
  }

  /**
   * 实例号 → 网格索引 (i,j,zi)。
   *
   * @param id 实例号 [0,n)
   */
  public indexToCell(id: number): { i: number; j: number; zi: number } {
    const ctx = this.ctx;
    if (!ctx) return { i: 0, j: 0, zi: 0 };
    const nxny = ctx.nx * ctx.ny;
    const zi = Math.floor(id / nxny);
    const rem = id - zi * nxny;
    const j = Math.floor(rem / ctx.nx);
    const i = rem - j * ctx.nx;
    return { i, j, zi };
  }

  /**
   * 网格索引 (i,j,zi) → 格中心地理坐标（度 + 大地高米）。
   *
   * @param i 经向索引
   * @param j 纬向索引
   * @param zi 高度层索引
   */
  public cellCenter(i: number, j: number, zi: number): { lonDeg: number; latDeg: number; heightMeters: number } {
    const ctx = this.ctx!;
    return {
      lonDeg: ctx.originLonDeg + (i + 0.5) * ctx.stepLonDeg,
      latDeg: ctx.originLatDeg + (j + 0.5) * ctx.stepLatDeg,
      heightMeters: ctx.originHeightMeters + (zi + 0.5) * ctx.heightStepMeters,
    };
  }

  /**
   * 切换某实例的选中状态（点击立方体改色）。
   * 按「空 → A → B → C → 空」循环；回到空则从持久化表移除。
   * 若该格当前被无人机压住（droneFlag=1），仅更新逻辑层，不动 texData（无人机优先显示），
   * 待无人机离开后由 clearDrone/setDroneInfluence 恢复时显现。
   *
   * @param id 实例号
   * @returns 切换后的类别
   */
  public toggleSelection(id: number): number {
    const ctx = this.ctx;
    if (!ctx || id < 0 || id >= this.count) return Category.EMPTY;

    const { i, j, zi } = this.indexToCell(id);
    const center = this.cellCenter(i, j, zi);
    const key = this.selectionKey(ctx.level, center.lonDeg, center.latDeg, zi);

    const cur = this.selections.get(key)?.category ?? Category.EMPTY;
    const next = this.nextSelectCategory(cur);

    if (next === Category.EMPTY) {
      this.selections.delete(key);
    } else {
      this.selections.set(key, {
        level: ctx.level,
        lonCenterDeg: center.lonDeg,
        latCenterDeg: center.latDeg,
        zi,
        category: next,
      });
    }

    this.baseCat[id] = next;
    // 无人机未压住该格时，立即反映到上传缓冲。
    if (this.droneFlag[id] !== 1) {
      this.texData[id * 4] = next;
    }
    return next;
  }

  /** 选中循环：返回下一个类别。 */
  private nextSelectCategory(cur: number): number {
    const idx = SELECT_CYCLE.indexOf(cur);
    const nextIdx = idx < 0 ? 1 : (idx + 1) % SELECT_CYCLE.length;
    return SELECT_CYCLE[nextIdx]!;
  }

  /** 构造选中持久化键（级别 + 中心经纬度定点到 1e-9° + 层索引）。 */
  private selectionKey(level: number, lonCenterDeg: number, latCenterDeg: number, zi: number): string {
    return `${level}|${lonCenterDeg.toFixed(9)}|${latCenterDeg.toFixed(9)}|${zi}`;
  }

  /** 清空全部选中（保留无人机叠加）。 */
  public clearSelections(): void {
    this.selections.clear();
    const n = this.count;
    // 把 baseCat 中的选中清回 EMPTY，并刷新未被无人机压住的 texData。
    for (let id = 0; id < n; id++) {
      if (this.baseCat[id] !== Category.EMPTY) {
        this.baseCat[id] = Category.EMPTY;
        if (this.droneFlag[id] !== 1) {
          this.texData[id * 4] = Category.EMPTY;
        }
      }
    }
  }

  /**
   * 设置无人机当前位置与影响半径，重算受影响立方体并叠加到 texData。
   * 增量式：先把上一次标记的格恢复为 baseCat，再标记本次邻域。
   * 球形影响：无人机所在格 = DRONE_CORE；半径内其它格 = DRONE_INFLUENCE。
   *
   * @param lonDeg 无人机经度（度）
   * @param latDeg 无人机纬度（度）
   * @param heightMeters 无人机大地高（米）
   * @param radiusMeters 影响半径（米）
   */
  public setDroneInfluence(lonDeg: number, latDeg: number, heightMeters: number, radiusMeters: number): void {
    const ctx = this.ctx;
    if (!ctx || this.count === 0) return;

    // ① 恢复上一次的无人机格为基础类别。
    this.restoreDroneCells();

    // ② 定位无人机所在格索引。
    const ci = Math.floor((lonDeg - ctx.originLonDeg) / ctx.stepLonDeg);
    const cj = Math.floor((latDeg - ctx.originLatDeg) / ctx.stepLatDeg);
    const ck = Math.floor((heightMeters - ctx.originHeightMeters) / ctx.heightStepMeters);

    const dimX = ctx.stepLonDeg * ctx.metersPerDegLon;
    const dimY = ctx.stepLatDeg * ctx.metersPerDegLat;
    const dimZ = ctx.heightStepMeters;

    // ③ 邻域半径（格数），各轴按米半径 / 米步长上取整。
    const rI = Math.max(0, Math.ceil(radiusMeters / Math.max(1e-6, dimX)));
    const rJ = Math.max(0, Math.ceil(radiusMeters / Math.max(1e-6, dimY)));
    const rK = Math.max(0, Math.ceil(radiusMeters / Math.max(1e-6, dimZ)));

    const i0 = Math.max(0, ci - rI);
    const i1 = Math.min(ctx.nx - 1, ci + rI);
    const j0 = Math.max(0, cj - rJ);
    const j1 = Math.min(ctx.ny - 1, cj + rJ);
    const k0 = Math.max(0, ck - rK);
    const k1 = Math.min(ctx.planes - 1, ck + rK);

    const r2 = radiusMeters * radiusMeters;
    let marked = 0;

    for (let zi = k0; zi <= k1; zi++) {
      // 该层中心高（米，相对原点）。
      const cz = (zi + 0.5) * dimZ;
      const droneUp = heightMeters - ctx.originHeightMeters; // 无人机相对原点的米高
      const dUp = cz - droneUp;
      for (let j = j0; j <= j1; j++) {
        const cyCenterLat = ctx.originLatDeg + (j + 0.5) * ctx.stepLatDeg;
        const dNorth = (latDeg - cyCenterLat) * ctx.metersPerDegLat; // 注意符号无关（平方）
        const baseJ = (zi * ctx.ny + j) * ctx.nx;
        for (let i = i0; i <= i1; i++) {
          const cxCenterLon = ctx.originLonDeg + (i + 0.5) * ctx.stepLonDeg;
          const dEast = (lonDeg - cxCenterLon) * ctx.metersPerDegLon;
          const dist2 = dEast * dEast + dNorth * dNorth + dUp * dUp;
          if (dist2 > r2) continue;

          const id = baseJ + i;
          const isCore = i === ci && j === cj && zi === ck;
          const cat = isCore ? Category.DRONE_CORE : Category.DRONE_INFLUENCE;
          this.texData[id * 4] = cat;
          this.droneFlag[id] = 1;
          this.droneIds.push(id);
          marked++;
          if (marked >= this.maxDroneCells) {
            // 邻域过大：截断标记（避免极端配置卡顿）；已标记部分仍生效。
            return;
          }
        }
      }
    }

    // 若无人机恰好落在区域外，droneIds 可能为空——此时仅核心格不可见，但不报错。
  }

  /** 把上一次标记的无人机格恢复为基础类别，并清空标记。 */
  private restoreDroneCells(): void {
    const ids = this.droneIds;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k]!;
      this.droneFlag[id] = 0;
      this.texData[id * 4] = this.baseCat[id]!;
    }
    ids.length = 0;
  }

  /** 清除无人机影响（恢复基础类别）。 */
  public clearDrone(): void {
    this.restoreDroneCells();
  }

  /** 当前实例总数。 */
  public getCount(): number {
    return this.count;
  }

  /** 状态纹理宽。 */
  public getTexWidth(): number {
    return this.texWidth;
  }

  /** 状态纹理高。 */
  public getTexHeight(): number {
    return this.texHeight;
  }

  /**
   * 取上传用状态字节缓冲。注意：返回的是内部缓冲（length 可能大于 texW·texH·4，
   * 上层应只取前 texW·texH·4 字节，或用 subarray）。
   */
  public getTexData(): Uint8Array {
    return this.texData;
  }

  /** 取「恰好 texW·texH·4」长度的状态数据视图（用于纹理上传，长度严格匹配）。 */
  public getTexDataView(): Uint8Array {
    return this.texData.subarray(0, this.texWidth * this.texHeight * 4);
  }

  /**
   * 取调色板字节缓冲（256×4）。
   *
   * @param mode 'wire' 线框 / 'fill' 填充
   */
  public getPalette(mode: 'wire' | 'fill'): Uint8Array {
    return mode === 'wire' ? this.paletteWire : this.paletteFill;
  }
}
