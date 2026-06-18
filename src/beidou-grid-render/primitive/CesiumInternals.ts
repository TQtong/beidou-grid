/**
 * 动态取用 Cesium 的**内部渲染 API**（`Buffer / VertexArray / ShaderProgram / RenderState /
 * DrawCommand / Pass / Texture / Sampler / ContextLimits` 等）。
 *
 * 这些类在运行时存在于 `cesium` 命名空间（由 `@cesium/engine` 导出），但**不在公开 `.d.ts`**，
 * 故用「最小结构化类型 + 一次 cast」取出：既拿到类型检查，又不依赖 Cesium 私有形状的全部细节，
 * 也避免 `any` 扩散。两套满填充引擎（属性 / GPU）共用本模块。
 */
import * as Cesium from 'cesium'

/** Cesium 内部 Context（由 `frameState.context` 提供，作不透明句柄传递）。 */
export type CesiumContext = object

/** Cesium 每帧帧状态（仅声明本层用到的字段）。 */
export interface CesiumFrameState {
  context: CesiumContext
  commandList: unknown[]
  passes?: { render?: boolean; pick?: boolean }
}

export interface CesiumDestroyable {
  isDestroyed(): boolean
  destroy(): void
}
export interface CesiumBuffer extends CesiumDestroyable {
  /**
   * 默认 true：`VertexArray.destroy()` 会连带销毁其引用的此 buffer。
   * 对**跨重建复用**的静态 buffer（单位盒顶点/索引）须置 false，否则销毁旧 VA 时会误销毁共享 buffer，
   * 导致下次 `new VertexArray` 引用到已销毁 buffer 而抛 “This object was destroyed”。
   */
  vertexArrayDestroyable: boolean
}
export type CesiumVertexArray = CesiumDestroyable
export type CesiumShaderProgram = CesiumDestroyable
export type CesiumRenderState = object
export type CesiumSampler = object

/** 纹理数据源（行优先 typed array）。 */
export interface CesiumTextureSource {
  width: number
  height: number
  arrayBufferView: ArrayBufferView
}

export interface CesiumTexture extends CesiumDestroyable {
  /** 子区域写：仅传 source 即整幅刷新；带 xOffset/yOffset 可只刷脏行（增量）。 */
  copyFrom(options: { source: CesiumTextureSource; xOffset?: number; yOffset?: number }): void
}

/** DrawCommand 运行期可改写的字段（其余字段构造时设定）。 */
export interface CesiumDrawCommand {
  modelMatrix: Cesium.Matrix4
  boundingVolume: Cesium.BoundingSphere
  instanceCount: number
  count: number
}

interface VertexAttribute {
  index: number
  vertexBuffer: CesiumBuffer
  componentsPerAttribute: number
  componentDatatype: number
  normalize: boolean
  offsetInBytes: number
  strideInBytes: number
  instanceDivisor: number
}

interface VertexArrayOptions {
  context: CesiumContext
  attributes: VertexAttribute[]
  indexBuffer?: CesiumBuffer
}

interface DrawCommandOptions {
  vertexArray: CesiumVertexArray
  shaderProgram: CesiumShaderProgram
  renderState: CesiumRenderState
  primitiveType: number
  pass: number
  modelMatrix: Cesium.Matrix4
  boundingVolume: Cesium.BoundingSphere
  owner: unknown
  cull: boolean
  instanceCount: number
  count: number
  offset?: number
  uniformMap: Record<string, () => unknown>
}

interface TextureOptions {
  context: CesiumContext
  width: number
  height: number
  pixelFormat: number
  pixelDatatype: number
  flipY?: boolean
  source?: CesiumTextureSource
  sampler?: CesiumSampler
}

interface SamplerOptions {
  minificationFilter: number
  magnificationFilter: number
  wrapS: number
  wrapT: number
}

interface CesiumInternalApi {
  Buffer: {
    createVertexBuffer(o: { context: CesiumContext; typedArray: ArrayBufferView; usage: number }): CesiumBuffer
    createIndexBuffer(o: {
      context: CesiumContext
      typedArray: ArrayBufferView
      usage: number
      indexDatatype: number
    }): CesiumBuffer
  }
  BufferUsage: { STATIC_DRAW: number; DYNAMIC_DRAW: number; STREAM_DRAW: number }
  VertexArray: new (o: VertexArrayOptions) => CesiumVertexArray
  ShaderProgram: {
    fromCache(o: {
      context: CesiumContext
      vertexShaderSource: string
      fragmentShaderSource: string
      attributeLocations: Record<string, number>
    }): CesiumShaderProgram
  }
  RenderState: { fromCache(o: unknown): CesiumRenderState }
  DrawCommand: new (o: DrawCommandOptions) => CesiumDrawCommand
  Pass: { OPAQUE: number; TRANSLUCENT: number; OVERLAY: number }
  Texture: new (o: TextureOptions) => CesiumTexture
  Sampler: new (o: SamplerOptions) => CesiumSampler
  /** 这两个是 getter 属性，须**惰性**读取（context 初始化前为 0）。 */
  ContextLimits: { readonly maximumTextureSize: number; readonly maximumVertexTextureImageUnits: number }
  PixelFormat: { LUMINANCE: number; RGBA: number }
  PixelDatatype: { UNSIGNED_BYTE: number }
  ComponentDatatype: { FLOAT: number }
  IndexDatatype: { UNSIGNED_SHORT: number }
  PrimitiveType: { TRIANGLES: number }
}

const api = Cesium as unknown as CesiumInternalApi

export const CesiumBufferApi = api.Buffer
export const CesiumBufferUsage = api.BufferUsage
export const CesiumVertexArrayCtor = api.VertexArray
export const CesiumShaderProgramApi = api.ShaderProgram
export const CesiumRenderStateApi = api.RenderState
export const CesiumDrawCommandCtor = api.DrawCommand
export const CesiumPass = api.Pass
export const CesiumTextureCtor = api.Texture
export const CesiumSamplerCtor = api.Sampler
/** 注意：`ContextLimits` 导出对象本身（含 getter），消费方在 rebuild 时**惰性**读其属性。 */
export const CesiumContextLimits = api.ContextLimits
export const CesiumPixelFormat = api.PixelFormat
export const CesiumPixelDatatype = api.PixelDatatype
export const CesiumComponentDatatype = api.ComponentDatatype
export const CesiumIndexDatatype = api.IndexDatatype
export const CesiumPrimitiveType = api.PrimitiveType

/** 公开枚举（已在 d.ts，直接用）：纹理过滤 / 环绕 / GL 常量。 */
export const WebGLConstants = Cesium.WebGLConstants
export const TextureMinificationFilter = Cesium.TextureMinificationFilter
export const TextureMagnificationFilter = Cesium.TextureMagnificationFilter
