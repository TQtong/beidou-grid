// ============================================================
// GridInstancedFill.ts — 满填充百万实心格（GPU 实例化）
// 层级：L3（渲染 Primitive 控制器，自定义 DrawCommand）
// 职责：用 GPU 实例化把一份单位盒绘制 N(≤1e6) 次，每格独立颜色（占用热力/分类）。
//       实例缓冲一次性紧循环构建（Float32 中心+尺寸 / UByte 颜色），单次实例化 draw call。
// 依赖：cesium 内部渲染 API（Buffer/VertexArray/ShaderProgram/RenderState/DrawCommand/
//       ComponentDatatype/PrimitiveType/BufferUsage/Pass/Matrix4/Transforms/Cartesian3/
//       BoundingSphere/Math/WebGLConstants/IndexDatatype）、render-constants、
//       GridTessellator 的 Tessellation。
//       注意：Buffer/BufferUsage/DrawCommand/Pass/RenderState/ShaderProgram/VertexArray/
//             Context/FrameState 不在 Cesium 公开 d.ts 中，运行时存在；本文件用结构化类型
//             声明 + 从命名空间动态取出（avoid `any` 污染主流程）。
// 被消费：BeiDouGridScene（enableInstancedFill 时）。
// 精度：逐实例中心用「相对区域原点的 ENU 局部米」float32；整体 modelMatrix = 原点 ENU 帧。
//       区域跨度内 float32 米级精度足够（fill 盒为视觉体）；超大区域（L1）误差亚米，可接受。
// 生命周期：rebuild 重建 VA/buffer；update(frameState) 推 DrawCommand；destroy 释放全部 GPU 资源。
// ============================================================

import * as Cesium from 'cesium';
import {
  BoundingSphere,
  Cartesian3,
  ComponentDatatype,
  Ellipsoid,
  IndexDatatype,
  Math as CesiumMath,
  Matrix4,
  PrimitiveType,
  Transforms,
  WebGLConstants,
} from 'cesium';

import type { Tessellation } from '../grid/GridTessellator';

// ── Cesium 渲染层内部 API 的最小结构化类型（按需取用，避免 `any`） ─────────────
interface CesiumBuffer {
  copyFromArrayView(typedArray: ArrayBufferView, offsetInBytes?: number): void;
  isDestroyed(): boolean;
  destroy(): void;
}
interface BufferStaticCtor {
  createVertexBuffer(opts: {
    context: unknown;
    typedArray: ArrayBufferView;
    usage: number;
  }): CesiumBuffer;
  createIndexBuffer(opts: {
    context: unknown;
    typedArray: ArrayBufferView;
    usage: number;
    indexDatatype: number;
  }): CesiumBuffer;
}
interface CesiumVertexArray {
  isDestroyed(): boolean;
  destroy(): void;
}
interface VertexArrayCtor {
  new (opts: {
    context: unknown;
    attributes: Array<{
      index: number;
      vertexBuffer: CesiumBuffer | undefined;
      componentsPerAttribute: number;
      componentDatatype: number;
      normalize: boolean;
      offsetInBytes: number;
      strideInBytes: number;
      instanceDivisor: number;
    }>;
    indexBuffer: CesiumBuffer | undefined;
  }): CesiumVertexArray;
}
interface CesiumShaderProgram {
  isDestroyed(): boolean;
  destroy(): void;
}
interface ShaderProgramCtor {
  fromCache(opts: {
    context: unknown;
    vertexShaderSource: string;
    fragmentShaderSource: string;
    attributeLocations: Record<string, number>;
  }): CesiumShaderProgram;
}
interface RenderStateCtor {
  fromCache(opts: unknown): unknown;
}
interface CesiumDrawCommand {
  modelMatrix: Matrix4;
  boundingVolume: BoundingSphere;
  instanceCount: number;
  vertexArray?: CesiumVertexArray;
}
interface DrawCommandCtor {
  new (opts: {
    vertexArray: CesiumVertexArray | undefined;
    shaderProgram: CesiumShaderProgram | undefined;
    renderState: unknown;
    primitiveType: number;
    pass: number;
    modelMatrix: Matrix4;
    boundingVolume: BoundingSphere;
    owner: unknown;
    cull: boolean;
    instanceCount: number;
    count: number;
    uniformMap: Record<string, () => unknown>;
  }): CesiumDrawCommand;
}
interface CesiumFrameState {
  context: unknown;
  commandList: CesiumDrawCommand[];
}

// 运行时从 cesium 命名空间动态取出内部 API（公开 d.ts 不导出，故用 cast）。
const CesiumAny = Cesium as unknown as {
  Buffer: BufferStaticCtor;
  BufferUsage: { STATIC_DRAW: number; DYNAMIC_DRAW: number; STREAM_DRAW: number };
  VertexArray: VertexArrayCtor;
  ShaderProgram: ShaderProgramCtor;
  RenderState: RenderStateCtor;
  DrawCommand: DrawCommandCtor;
  Pass: { OPAQUE: number; TRANSLUCENT: number; OVERLAY: number };
};
const CesiumBufferApi = CesiumAny.Buffer;
const CesiumBufferUsage = CesiumAny.BufferUsage;
const CesiumVertexArrayCtor = CesiumAny.VertexArray;
const CesiumShaderProgramApi = CesiumAny.ShaderProgram;
const CesiumRenderStateApi = CesiumAny.RenderState;
const CesiumDrawCommandCtor = CesiumAny.DrawCommand;
const CesiumPass = CesiumAny.Pass;

/** 赤道每度米长（度→米换算，纬向恒定近似、经向乘 cos(lat)）。 */
const METERS_PER_DEG = 111320.0;

/** 占用着色输入：每格一个类别字节 + 类别→RGBA 调色板。 */
export interface OccupancyColoring {
  /** 长度 = nx·ny·planes 的类别数组（行优先：idx = (zi·ny + j)·nx + i）。 */
  categories: Uint8Array;
  /** 调色板：256 项 × 4 字节 RGBA（categories[k] 索引到此）。 */
  palette: Uint8Array; // length 256*4
}

/**
 * 单位盒 8 顶点（局部坐标，范围 [-0.5,0.5]³），VS 里乘 instanceSize 得米尺寸盒。
 * 顺序：先底面 4 角(z=-0.5)，再顶面 4 角(z=+0.5)。
 */
const UNIT_BOX_CORNERS = new Float32Array([
  -0.5, -0.5, -0.5,   // 0
   0.5, -0.5, -0.5,   // 1
   0.5,  0.5, -0.5,   // 2
  -0.5,  0.5, -0.5,   // 3
  -0.5, -0.5,  0.5,   // 4
   0.5, -0.5,  0.5,   // 5
   0.5,  0.5,  0.5,   // 6
  -0.5,  0.5,  0.5,   // 7
]);

/** 单位盒 12 三角形（36 索引），CCW 外向，配合背面剔除。 */
const UNIT_BOX_INDICES = new Uint16Array([
  // 底 (z-)
  0, 2, 1, 0, 3, 2,
  // 顶 (z+)
  4, 5, 6, 4, 6, 7,
  // 南 (y-)
  0, 1, 5, 0, 5, 4,
  // 北 (y+)
  3, 7, 6, 3, 6, 2,
  // 西 (x-)
  0, 4, 7, 0, 7, 3,
  // 东 (x+)
  1, 2, 6, 1, 6, 5,
]);

/** 顶点着色器：单位盒角 × 逐实例尺寸 + 中心，乘 czm_modelViewProjection。 */
const INSTANCED_VS = /* glsl */ `
in vec3 position;            // 单位盒角 [-0.5,0.5]
in vec3 instanceCenter;      // 逐实例中心（ENU 局部米，相对区域原点）
in vec3 instanceSize;        // 逐实例盒尺寸（米）
in vec4 instanceColor;       // 逐实例颜色（归一 0..1，来自 UNSIGNED_BYTE normalized）

out vec4 v_color;

void main() {
  // 局部 ENU 位置（米）：盒角缩放到米尺寸后平移到实例中心。
  vec3 localMeters = instanceCenter + position * instanceSize;
  // czm_modelViewProjection = projection · view · (command.modelMatrix = 原点 ENU→ECEF)。
  // 故 localMeters（ENU 米）直接经该矩阵投影到裁剪空间。
  gl_Position = czm_modelViewProjection * vec4(localMeters, 1.0);
  v_color = instanceColor;
}
`;

/** 片元着色器：预乘 alpha 输出（配合 translucent 混合）。 */
const INSTANCED_FS = /* glsl */ `
in vec4 v_color;
uniform float u_opacity;
void main() {
  vec4 c = v_color;
  c.a *= u_opacity;
  c.rgb *= c.a;        // 预乘（Cesium TRANSLUCENT 通道按预乘 over 混合）
  out_FragColor = c;
}
`;

const _scratchOrigin = new Cartesian3();

export default class GridInstancedFill {
  private va: CesiumVertexArray | undefined;
  private sp: CesiumShaderProgram | undefined;
  private rs: unknown;
  private command: CesiumDrawCommand | undefined;
  private modelMatrix = Matrix4.clone(Matrix4.IDENTITY);
  private boundingSphere = new BoundingSphere();
  private instanceCount = 0;
  private opacity = 1.0;
  private show = true;

  // 复用的 GPU buffer（rebuild 时若尺寸不变则 setData 复用，避免反复 create/destroy）
  private cornerBuffer: CesiumBuffer | undefined;     // 单位盒角（静态）
  private indexBuffer: CesiumBuffer | undefined;      // 单位盒索引（静态）
  private instanceXfBuffer: CesiumBuffer | undefined; // 逐实例 [cx,cy,cz,sx,sy,sz]（Float32）
  private instanceColBuffer: CesiumBuffer | undefined;// 逐实例 RGBA（UByte）
  private capacity = 0;                                // 当前实例缓冲容量（实例数）
  private destroyed = false;

  private gpuDirty = false;
  private xfArray: Float32Array | undefined;
  private colArray: Uint8Array | undefined;

  /** @param opacity 全局不透明度系数（叠加在每格 alpha 上，可后续 setOpacity）。 */
  public constructor(opacity = 1.0) {
    this.opacity = opacity;
  }

  /**
   * 用剖分 + 占用着色重建实例数据（CPU 端，构建扁平缓冲）。
   * 不直接碰 GPU——GPU 资源在首次 update(frameState) 时创建/更新（需要 context）。
   *
   * 紧循环（zi→j→i）写入：
   *   - instanceXf[Float32]：中心 ENU 局部米(相对原点) + 盒尺寸米；
   *   - instanceCol[UByte] ：调色板[categories[idx]] 的 RGBA。
   * 无任何对象分配，1e6 实例约数十毫秒（11 篇预算）。
   *
   * @param t        剖分结果
   * @param coloring 占用着色（类别数组 + 调色板）
   */
  public rebuild(t: Tessellation, coloring: OccupancyColoring): void {
    if (this.destroyed) return;

    const planes = t.zPlaneFloors.length;
    const total = t.nx * t.ny * planes;
    this.instanceCount = total;

    // 整体 modelMatrix：区域原点（西南角 + 第一层底高）处的 ENU→ECEF 帧。
    const originHeight = t.zPlaneFloors[0] ?? 0;
    const originEcef = Cartesian3.fromDegrees(
      t.originLonDeg,
      t.originLatDeg,
      originHeight,
      Ellipsoid.WGS84,
      _scratchOrigin,
    );
    Transforms.eastNorthUpToFixedFrame(originEcef, Ellipsoid.WGS84, this.modelMatrix);

    // 度→米换算因子（经向乘 cos(originLat)；区域内按原点纬度线性近似）。
    const cosLat = Math.max(0.02, Math.cos(CesiumMath.toRadians(t.originLatDeg)));
    const mPerDegLon = METERS_PER_DEG * cosLat;
    const mPerDegLat = METERS_PER_DEG;
    const dimX = t.stepLonDeg * mPerDegLon;
    const dimY = t.stepLatDeg * mPerDegLat;
    const dimZ = Math.max(1.0, t.heightStep);

    // ── 分配/复用扁平缓冲 ──
    const xf = this.ensureXfArray(total);   // Float32Array, 6 floats/实例
    const col = this.ensureColArray(total);  // Uint8Array, 4 bytes/实例

    const cats = coloring.categories;
    const pal = coloring.palette;

    let w = 0;  // xf 写指针
    let c = 0;  // col 写指针
    for (let zi = 0; zi < planes; zi++) {
      // 该层中心高度（米）= 层底 + 半层高；ENU up 直接用米。
      const cz = (t.zPlaneFloors[zi]! - originHeight) + dimZ / 2;
      for (let j = 0; j < t.ny; j++) {
        // 该行中心北向米 = (j+0.5)·dimY。
        const cy = (j + 0.5) * dimY;
        const rowBase = (zi * t.ny + j) * t.nx;
        for (let i = 0; i < t.nx; i++) {
          const cx = (i + 0.5) * dimX;     // 东向米
          // 中心
          xf[w++] = cx; xf[w++] = cy; xf[w++] = cz;
          // 尺寸
          xf[w++] = dimX; xf[w++] = dimY; xf[w++] = dimZ;
          // 颜色：调色板[cat]
          const cat = cats[rowBase + i]!;
          const pb = cat * 4;
          col[c++] = pal[pb]!;
          col[c++] = pal[pb + 1]!;
          col[c++] = pal[pb + 2]!;
          col[c++] = pal[pb + 3]!;
        }
      }
    }

    // 包围球：以原点为中心、覆盖区域对角的米半径（用于视锥裁剪命中）。
    const radius = Math.hypot(t.nx * dimX, t.ny * dimY, planes * dimZ) * 0.5 + dimZ;
    // 包围球中心在区域中点（ENU 局部米）→ 转 ECEF。
    const midLocal = new Cartesian3((t.nx * dimX) / 2, (t.ny * dimY) / 2, (planes * dimZ) / 2);
    Matrix4.multiplyByPoint(this.modelMatrix, midLocal, this.boundingSphere.center);
    this.boundingSphere.radius = radius;

    // 标记 GPU buffer 需在下次 update 时刷新（容量变化则重建 VA）。
    this.gpuDirty = true;
  }

  /** 确保 Float32 变换数组容量足够（6 floats/实例），复用底层 buffer。 */
  private ensureXfArray(total: number): Float32Array {
    const need = total * 6;
    if (!this.xfArray || this.xfArray.length < need) {
      this.xfArray = new Float32Array(need);
    }
    return this.xfArray;
  }

  /** 确保 UByte 颜色数组容量足够（4 bytes/实例）。 */
  private ensureColArray(total: number): Uint8Array {
    const need = total * 4;
    if (!this.colArray || this.colArray.length < need) {
      this.colArray = new Uint8Array(need);
    }
    return this.colArray;
  }

  /**
   * 每帧由场景调用：必要时创建/更新 GPU 资源，并把 DrawCommand 推入命令列表。
   * 这是自定义 Primitive 的标准接口（scene.primitives.add(this) 后 Cesium 每帧调 update）。
   *
   * @param frameState Cesium 帧状态（含 context 与 commandList）
   */
  public update(frameState: CesiumFrameState): void {
    if (this.destroyed || !this.show || this.instanceCount === 0) return;

    const context = frameState.context;

    if (this.gpuDirty) {
      this.uploadGpu(context);
      this.gpuDirty = false;
    }
    if (!this.command) return;

    // 刷新随帧可能变化的字段（modelMatrix / 包围球 / 实例数）。
    this.command.modelMatrix = this.modelMatrix;
    this.command.boundingVolume = this.boundingSphere;
    this.command.instanceCount = this.instanceCount;

    frameState.commandList.push(this.command);
  }

  /**
   * 创建/更新 GPU 资源：静态单位盒 buffer、逐实例 buffer、VertexArray、ShaderProgram、
   * RenderState、DrawCommand。容量足够则 setData 复用，否则重建 VA。
   *
   * @param context Cesium 渲染上下文
   */
  private uploadGpu(context: unknown): void {
    const xf = this.xfArray!;
    const col = this.colArray!;
    const total = this.instanceCount;

    // ── 静态单位盒（首次创建）──
    if (!this.cornerBuffer) {
      this.cornerBuffer = CesiumBufferApi.createVertexBuffer({
        context,
        typedArray: UNIT_BOX_CORNERS,
        usage: CesiumBufferUsage.STATIC_DRAW,
      });
    }
    if (!this.indexBuffer) {
      this.indexBuffer = CesiumBufferApi.createIndexBuffer({
        context,
        typedArray: UNIT_BOX_INDICES,
        usage: CesiumBufferUsage.STATIC_DRAW,
        indexDatatype: IndexDatatype.UNSIGNED_SHORT,
      });
    }

    // ── 逐实例 buffer：容量不足则重建（并销毁旧的 + 旧 VA）──
    const needCapacity = total;
    const xfBytes = xf.subarray(0, total * 6);
    const colBytes = col.subarray(0, total * 4);

    if (this.capacity < needCapacity || !this.instanceXfBuffer || !this.instanceColBuffer) {
      // 销毁旧实例 buffer 与 VA（VA 引用旧 buffer）。
      this.destroyInstanceBuffersAndVa();
      this.instanceXfBuffer = CesiumBufferApi.createVertexBuffer({
        context,
        typedArray: xfBytes,
        usage: CesiumBufferUsage.STREAM_DRAW, // 频繁重建 → STREAM
      });
      this.instanceColBuffer = CesiumBufferApi.createVertexBuffer({
        context,
        typedArray: colBytes,
        usage: CesiumBufferUsage.STREAM_DRAW,
      });
      this.capacity = needCapacity;
      this.buildVertexArray(context);
    } else {
      // 容量够：原地更新数据（copyFromArrayView 仅刷新前 total 条）。
      this.instanceXfBuffer.copyFromArrayView(xfBytes, 0);
      this.instanceColBuffer.copyFromArrayView(colBytes, 0);
    }

    // ── ShaderProgram（首次创建，缓存）──
    if (!this.sp) {
      this.sp = CesiumShaderProgramApi.fromCache({
        context,
        vertexShaderSource: INSTANCED_VS,
        fragmentShaderSource: INSTANCED_FS,
        attributeLocations: {
          position: 0,
          instanceCenter: 1,
          instanceSize: 2,
          instanceColor: 3,
        },
      });
    }

    // ── RenderState（半透：混合开、深度测试开、深度写关、背面剔除）──
    if (!this.rs) {
      this.rs = CesiumRenderStateApi.fromCache({
        cull: { enabled: true, face: WebGLConstants.BACK },
        depthTest: { enabled: true },
        depthMask: false,
        blending: {
          enabled: true,
          // 预乘 over：src=ONE, dst=ONE_MINUS_SRC_ALPHA
          equationRgb: WebGLConstants.FUNC_ADD,
          equationAlpha: WebGLConstants.FUNC_ADD,
          functionSourceRgb: WebGLConstants.ONE,
          functionDestinationRgb: WebGLConstants.ONE_MINUS_SRC_ALPHA,
          functionSourceAlpha: WebGLConstants.ONE,
          functionDestinationAlpha: WebGLConstants.ONE_MINUS_SRC_ALPHA,
        },
      });
    }

    // ── DrawCommand（首次创建；之后仅更新可变字段）──
    if (!this.command) {
      this.command = new CesiumDrawCommandCtor({
        vertexArray: this.va,
        shaderProgram: this.sp,
        renderState: this.rs,
        primitiveType: PrimitiveType.TRIANGLES,
        pass: CesiumPass.TRANSLUCENT,
        modelMatrix: this.modelMatrix,
        boundingVolume: this.boundingSphere,
        owner: this,
        cull: true,
        instanceCount: this.instanceCount,
        count: UNIT_BOX_INDICES.length, // 每实例 36 索引
        uniformMap: {
          u_opacity: () => this.opacity,
        },
      });
    } else {
      this.command.vertexArray = this.va!;
    }
  }

  /**
   * 构建 VertexArray：单位盒 position（divisor 0）+ 3 个逐实例属性（divisor 1）+ 索引。
   *
   * @param context Cesium 渲染上下文
   */
  private buildVertexArray(context: unknown): void {
    this.va = new CesiumVertexArrayCtor({
      context,
      attributes: [
        {
          index: 0, // position（单位盒角）
          vertexBuffer: this.cornerBuffer,
          componentsPerAttribute: 3,
          componentDatatype: ComponentDatatype.FLOAT,
          normalize: false,
          offsetInBytes: 0,
          strideInBytes: 12,
          instanceDivisor: 0,
        },
        {
          index: 1, // instanceCenter（Float32 vec3，stride 24，offset 0）
          vertexBuffer: this.instanceXfBuffer,
          componentsPerAttribute: 3,
          componentDatatype: ComponentDatatype.FLOAT,
          normalize: false,
          offsetInBytes: 0,
          strideInBytes: 24,
          instanceDivisor: 1,
        },
        {
          index: 2, // instanceSize（Float32 vec3，stride 24，offset 12）
          vertexBuffer: this.instanceXfBuffer,
          componentsPerAttribute: 3,
          componentDatatype: ComponentDatatype.FLOAT,
          normalize: false,
          offsetInBytes: 12,
          strideInBytes: 24,
          instanceDivisor: 1,
        },
        {
          index: 3, // instanceColor（UNSIGNED_BYTE vec4 归一，stride 4）
          vertexBuffer: this.instanceColBuffer,
          componentsPerAttribute: 4,
          componentDatatype: ComponentDatatype.UNSIGNED_BYTE,
          normalize: true,
          offsetInBytes: 0,
          strideInBytes: 4,
          instanceDivisor: 1,
        },
      ],
      indexBuffer: this.indexBuffer,
    });
  }

  /** 设全局不透明度。 */
  public setOpacity(opacity: number): void {
    this.opacity = CesiumMath.clamp(opacity, 0, 1);
  }

  /** 显示/隐藏。 */
  public setVisible(visible: boolean): void {
    this.show = visible;
  }

  /** 销毁逐实例 buffer + VA（容量变化或最终销毁时调用）。 */
  private destroyInstanceBuffersAndVa(): void {
    // VA 销毁时不连带销毁 attribute buffer（我们单独管理）。
    if (this.va && !this.va.isDestroyed()) this.va.destroy();
    this.va = undefined;
    if (this.instanceXfBuffer && !this.instanceXfBuffer.isDestroyed()) this.instanceXfBuffer.destroy();
    if (this.instanceColBuffer && !this.instanceColBuffer.isDestroyed()) this.instanceColBuffer.destroy();
    this.instanceXfBuffer = undefined;
    this.instanceColBuffer = undefined;
    this.capacity = 0;
  }

  /** 是否已销毁（Cesium primitives 集合协议）。 */
  public isDestroyed(): boolean {
    return this.destroyed;
  }

  /** 销毁全部 GPU 资源（buffer / VA / shaderProgram）。RenderState 走 cache 不单独销毁。 */
  public destroy(): boolean {
    if (this.destroyed) return true;
    this.destroyInstanceBuffersAndVa();
    if (this.cornerBuffer && !this.cornerBuffer.isDestroyed()) this.cornerBuffer.destroy();
    if (this.indexBuffer && !this.indexBuffer.isDestroyed()) this.indexBuffer.destroy();
    this.cornerBuffer = undefined;
    this.indexBuffer = undefined;
    if (this.sp && !this.sp.isDestroyed()) this.sp.destroy();
    this.sp = undefined;
    this.command = undefined;
    this.rs = undefined;
    this.destroyed = true;
    return true;
  }
}
