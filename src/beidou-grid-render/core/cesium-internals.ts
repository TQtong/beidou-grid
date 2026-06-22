// ============================================================
// cesium-internals.ts — Cesium 渲染层「内部 API」集中访问与结构化类型
// 层级：L0（渲染核心基础，无业务依赖）
// 职责：把本次重设计要用到的 Cesium 私有渲染对象（Buffer / VertexArray /
//       ShaderProgram / RenderState / DrawCommand / Texture / Sampler /
//       Framebuffer / Renderbuffer / PassState / ClearCommand 以及 Context /
//       UniformState 的少量成员）统一收口到一个文件，对外暴露「带最小结构化类型
//       的句柄」，避免 `any` 在主流程蔓延、并把『从命名空间动态取出私有符号』的
//       cast 仅集中在这里一处。
// 说明：这些符号运行时存在、但不在 Cesium 公开 d.ts 中（与现有 GridInstancedFill
//       的做法一致）。本文件只声明「我们真正调用到的成员」，不追求完整签名。
// 被消费：GridCubeField / InstancePicker。
// ============================================================

import * as Cesium from 'cesium';
import type { BoundingSphere, Color, Matrix4 } from 'cesium';

// ── GPU Buffer ────────────────────────────────────────────────────────────
/** Cesium 顶点/索引 Buffer 实例（仅声明我们用到的成员）。 */
export interface CesiumBuffer {
  /** 原地覆盖缓冲数据（容量足够时复用，避免重建）。 */
  copyFromArrayView(typedArray: ArrayBufferView, offsetInBytes?: number): void;
  isDestroyed(): boolean;
  destroy(): void;
}
/** Buffer 静态工厂。 */
export interface CesiumBufferStatic {
  createVertexBuffer(opts: { context: unknown; typedArray: ArrayBufferView; usage: number }): CesiumBuffer;
  createIndexBuffer(opts: {
    context: unknown;
    typedArray: ArrayBufferView;
    usage: number;
    indexDatatype: number;
  }): CesiumBuffer;
}

// ── VertexArray ───────────────────────────────────────────────────────────
/** 单个顶点属性描述（结构同 Cesium VertexArray 入参）。 */
export interface CesiumVertexAttribute {
  index: number;
  vertexBuffer: CesiumBuffer | undefined;
  componentsPerAttribute: number;
  componentDatatype: number;
  normalize: boolean;
  offsetInBytes: number;
  strideInBytes: number;
  instanceDivisor: number;
}
/** Cesium VertexArray 实例。 */
export interface CesiumVertexArray {
  isDestroyed(): boolean;
  destroy(): void;
}
/** VertexArray 构造器。 */
export interface CesiumVertexArrayCtor {
  new (opts: {
    context: unknown;
    attributes: CesiumVertexAttribute[];
    indexBuffer: CesiumBuffer | undefined;
  }): CesiumVertexArray;
}

// ── ShaderProgram ─────────────────────────────────────────────────────────
/** Cesium ShaderProgram 实例。 */
export interface CesiumShaderProgram {
  isDestroyed(): boolean;
  destroy(): void;
}
/** ShaderProgram 工厂（带缓存）。 */
export interface CesiumShaderProgramStatic {
  fromCache(opts: {
    context: unknown;
    vertexShaderSource: string;
    fragmentShaderSource: string;
    attributeLocations: Record<string, number>;
  }): CesiumShaderProgram;
}

// ── RenderState ───────────────────────────────────────────────────────────
/** RenderState 工厂（带缓存）。返回的对象是不透明句柄。 */
export interface CesiumRenderStateStatic {
  fromCache(opts: unknown): unknown;
}

// ── Texture / Sampler ─────────────────────────────────────────────────────
/** Cesium Texture 实例（仅声明我们用到的成员）。 */
export interface CesiumTexture {
  readonly width: number;
  readonly height: number;
  /**
   * 局部/整幅覆盖纹理数据。source 可为 { arrayBufferView, width, height }。
   * 我们用「整幅覆盖」（xOffset=yOffset=0，width/height=纹理全尺寸）做状态刷新。
   */
  copyFrom(opts: {
    source: { arrayBufferView: ArrayBufferView; width: number; height: number };
    xOffset?: number;
    yOffset?: number;
  }): void;
  isDestroyed(): boolean;
  destroy(): void;
}
/** Texture 构造器。 */
export interface CesiumTextureCtor {
  new (opts: {
    context: unknown;
    width: number;
    height: number;
    pixelFormat: number;
    pixelDatatype: number;
    flipY?: boolean;
    source?: { arrayBufferView: ArrayBufferView };
    sampler?: unknown;
  }): CesiumTexture;
}
/** Sampler 构造器。 */
export interface CesiumSamplerCtor {
  new (opts: {
    minificationFilter: number;
    magnificationFilter: number;
    wrapS?: number;
    wrapT?: number;
  }): unknown;
}

// ── Framebuffer / Renderbuffer（拾取离屏目标）────────────────────────────
/** Cesium Framebuffer 实例。 */
export interface CesiumFramebuffer {
  isDestroyed(): boolean;
  destroy(): void;
}
/** Framebuffer 构造器。 */
export interface CesiumFramebufferCtor {
  new (opts: {
    context: unknown;
    colorTextures: CesiumTexture[];
    depthRenderbuffer?: CesiumRenderbuffer;
    destroyAttachments?: boolean;
  }): CesiumFramebuffer;
}
/** Cesium Renderbuffer 实例。 */
export interface CesiumRenderbuffer {
  isDestroyed(): boolean;
  destroy(): void;
}
/** Renderbuffer 构造器。 */
export interface CesiumRenderbufferCtor {
  new (opts: { context: unknown; format: number; width: number; height: number }): CesiumRenderbuffer;
}

// ── DrawCommand / PassState / ClearCommand ────────────────────────────────
/** Cesium DrawCommand 实例（我们读写的可变字段 + execute）。 */
export interface CesiumDrawCommand {
  modelMatrix: Matrix4;
  boundingVolume: BoundingSphere;
  instanceCount: number;
  count: number;
  primitiveType: number;
  vertexArray?: CesiumVertexArray;
  renderState: unknown;
  pass: number;
  /** 手动执行（拾取离屏渲染用）。 */
  execute(context: unknown, passState: unknown): void;
}
/** DrawCommand 构造器。 */
export interface CesiumDrawCommandCtor {
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
/** PassState 构造器（拾取离屏需要自带 framebuffer/viewport 的 PassState）。 */
export interface CesiumPassStateCtor {
  new (context: unknown): {
    framebuffer: CesiumFramebuffer | undefined;
    viewport: unknown;
  };
}
/** ClearCommand 实例。 */
export interface CesiumClearCommand {
  execute(context: unknown, passState: unknown): void;
}
/** ClearCommand 构造器。 */
export interface CesiumClearCommandCtor {
  new (opts: { color?: Color; depth?: number; framebuffer?: CesiumFramebuffer }): CesiumClearCommand;
}

// ── Context / UniformState（运行期句柄，update(frameState) 时取得）────────
/** Cesium UniformState（我们仅需写 model 矩阵——其 setter 会同步派生矩阵）。 */
export interface CesiumUniformState {
  model: Matrix4;
}
/** Cesium 渲染上下文（仅声明我们用到的成员）。 */
export interface CesiumContext {
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly uniformState: CesiumUniformState;
  /** 从指定 framebuffer 回读像素（拾取解码用）。返回 RGBA 字节数组。 */
  readPixels(opts: {
    x: number;
    y: number;
    width: number;
    height: number;
    framebuffer?: CesiumFramebuffer;
  }): Uint8Array;
}
/** Cesium 每帧帧状态（自定义 Primitive update 入参的最小子集）。 */
export interface CesiumFrameState {
  context: CesiumContext;
  commandList: CesiumDrawCommand[];
}

// ── 集中 cast：从 cesium 命名空间取出全部私有符号 ──────────────────────────
const C = Cesium as unknown as {
  Buffer: CesiumBufferStatic;
  BufferUsage: { STATIC_DRAW: number; DYNAMIC_DRAW: number; STREAM_DRAW: number };
  VertexArray: CesiumVertexArrayCtor;
  ShaderProgram: CesiumShaderProgramStatic;
  RenderState: CesiumRenderStateStatic;
  DrawCommand: CesiumDrawCommandCtor;
  Pass: { OPAQUE: number; TRANSLUCENT: number; OVERLAY: number };
  Texture: CesiumTextureCtor;
  Sampler: CesiumSamplerCtor;
  TextureMinificationFilter: { NEAREST: number; LINEAR: number };
  TextureMagnificationFilter: { NEAREST: number; LINEAR: number };
  TextureWrap: { CLAMP_TO_EDGE: number; REPEAT: number };
  PixelFormat: { RGBA: number; RED: number; DEPTH_COMPONENT: number };
  PixelDatatype: { UNSIGNED_BYTE: number; FLOAT: number };
  Framebuffer: CesiumFramebufferCtor;
  Renderbuffer: CesiumRenderbufferCtor;
  RenderbufferFormat: { DEPTH_COMPONENT16: number; DEPTH24_STENCIL8: number };
  PassState: CesiumPassStateCtor;
  ClearCommand: CesiumClearCommandCtor;
};

/** Cesium 私有渲染 API 句柄集合（全部经一次 cast 取出，外部按需解构）。 */
export const CesiumInternals = {
  Buffer: C.Buffer,
  BufferUsage: C.BufferUsage,
  VertexArray: C.VertexArray,
  ShaderProgram: C.ShaderProgram,
  RenderState: C.RenderState,
  DrawCommand: C.DrawCommand,
  Pass: C.Pass,
  Texture: C.Texture,
  Sampler: C.Sampler,
  TextureMinificationFilter: C.TextureMinificationFilter,
  TextureMagnificationFilter: C.TextureMagnificationFilter,
  TextureWrap: C.TextureWrap,
  PixelFormat: C.PixelFormat,
  PixelDatatype: C.PixelDatatype,
  Framebuffer: C.Framebuffer,
  Renderbuffer: C.Renderbuffer,
  RenderbufferFormat: C.RenderbufferFormat,
  PassState: C.PassState,
  ClearCommand: C.ClearCommand,
} as const;
