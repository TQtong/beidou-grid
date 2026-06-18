/**
 * 满填充 · 属性引擎（**旧**，逐实例顶点属性；保留作对比基线，见设计 02/08）。
 *
 * 每格上传 `中心(3 float) + 尺寸(3 float) + 颜色(4 byte) = 28 字节`，CPU 端每次重建走紧循环。
 * 兼容性最好，但大数据量重建会卡——正是 `GridInstancedVoxelGPU` 要超越的对象。
 * 本引擎始终走 ENU-fast（自带逐格 ENU 中心计算），忽略 GPU 选项 `opt`。
 */
import * as Cesium from 'cesium'
import type { Tessellation } from '../grid/GridTessellator'
import {
  CesiumBufferApi,
  CesiumBufferUsage,
  CesiumVertexArrayCtor,
  CesiumShaderProgramApi,
  CesiumRenderStateApi,
  CesiumDrawCommandCtor,
  CesiumPass,
  CesiumComponentDatatype,
  CesiumIndexDatatype,
  CesiumPrimitiveType,
  WebGLConstants,
  type CesiumContext,
  type CesiumFrameState,
  type CesiumBuffer,
  type CesiumVertexArray,
  type CesiumShaderProgram,
  type CesiumRenderState,
  type CesiumDrawCommand,
} from './CesiumInternals'

const { Cartesian3, Matrix4, Transforms, Ellipsoid, Math: CesiumMath, BoundingSphere } = Cesium

/**
 * 占用着色：行优先 `idx = (zi·ny+j)·nx+i` 的类别数组 + `256×4` RGBA 调色板。
 *
 * 此类型为渲染层公共契约：两套满填充引擎与场景的 `setOccupancy` 均消费它。
 */
export interface OccupancyColoring {
  /** 每格类别字节：`0`=空（不绘制），`1..255`=类别（索引调色板）。长度须 ≥ nx·ny·planes。 */
  categories: Uint8Array
  /** 调色板：`256×4` RGBA8（类别 c 的颜色 = palette[c*4 .. c*4+3]）。 */
  palette: Uint8Array
}

const METERS_PER_DEG = 111320.0
const DEFAULT_FILL_RATIO = 0.92
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

const UNIT_BOX_CORNERS = new Float32Array([
  -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5,
  0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
])
const UNIT_BOX_INDICES = new Uint16Array([
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2,
  6, 1, 6, 5,
])

const VERTEX_SHADER = /* glsl */ `
in vec3 position;
in vec3 a_center;
in vec3 a_size;
in vec4 a_color;
out vec4 v_color;
out vec3 v_posEC;
void main() {
  if (a_color.a < 0.0001) {            // 空格塌缩
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_color = vec4(0.0);
    v_posEC = vec3(0.0);
    return;
  }
  vec3 localMeters = a_center + position * a_size;
  v_color = a_color;
  gl_Position = czm_modelViewProjection * vec4(localMeters, 1.0);
  v_posEC = (czm_modelView * vec4(localMeters, 1.0)).xyz;
}
`

const FRAGMENT_SHADER = /* glsl */ `
in vec4 v_color;
in vec3 v_posEC;
uniform float u_opacity;
void main() {
  vec4 c = v_color;
  vec3 dx = dFdx(v_posEC);
  vec3 dy = dFdy(v_posEC);
  vec3 n = normalize(cross(dx, dy));
  if (n.z < 0.0) n = -n;
  float ndl = clamp(dot(n, normalize(vec3(0.35, 0.25, 1.0))), 0.0, 1.0);
  float shade = 0.55 + 0.45 * ndl;
  c.rgb *= shade;
  c.a *= u_opacity;
  c.rgb *= c.a;
  out_FragColor = c;
}
`

const _scratchOrigin = new Cartesian3()
const _scratchMid = new Cartesian3()

export default class GridInstancedFill {
  private instanceCount = 0
  private opacity: number
  private fillRatio = DEFAULT_FILL_RATIO
  private show = true
  private destroyed = false

  private readonly modelMatrix: Cesium.Matrix4 = Matrix4.clone(Matrix4.IDENTITY, new Matrix4())
  private readonly boundingSphere: Cesium.BoundingSphere = new BoundingSphere()

  // CPU 端 scratch（逐实例 transform + 颜色）。
  private xform?: Float32Array // [cx,cy,cz, sx,sy,sz] × total
  private colors?: Uint8Array // RGBA × total

  // GPU 资源。
  private sp?: CesiumShaderProgram
  private rs?: CesiumRenderState
  private va?: CesiumVertexArray
  private cornerBuffer?: CesiumBuffer
  private indexBuffer?: CesiumBuffer
  private xformBuffer?: CesiumBuffer
  private colorBuffer?: CesiumBuffer
  private command?: CesiumDrawCommand

  private dirty = false

  constructor(opacity = 1.0) {
    this.opacity = clamp(opacity, 0, 1)
  }

  /** 重建：紧循环写逐实例属性（这正是大数据量会卡的部分）。 */
  public rebuild(t: Tessellation, coloring: OccupancyColoring): void {
    if (this.destroyed) return

    const planes = Math.max(1, t.zPlaneFloors.length)
    const total = t.nx * t.ny * planes

    const cosLat = Math.max(0.02, Math.cos(CesiumMath.toRadians(t.originLatDeg)))
    const dimX = t.stepLonDeg * METERS_PER_DEG * cosLat
    const dimY = t.stepLatDeg * METERS_PER_DEG
    const dimZ = Math.max(1.0, t.heightStep)
    const sx = dimX * this.fillRatio
    const sy = dimY * this.fillRatio
    const sz = dimZ * this.fillRatio

    if (!this.xform || this.xform.length < total * 6) this.xform = new Float32Array(total * 6)
    if (!this.colors || this.colors.length < total * 4) this.colors = new Uint8Array(total * 4)
    const xf = this.xform
    const col = this.colors
    const cats = coloring.categories
    const pal = coloring.palette

    let w = 0
    let c = 0
    for (let zi = 0; zi < planes; zi++) {
      const cz = (zi + 0.5) * dimZ
      for (let j = 0; j < t.ny; j++) {
        const cy = (j + 0.5) * dimY
        const rowBase = (zi * t.ny + j) * t.nx
        for (let i = 0; i < t.nx; i++) {
          xf[w++] = (i + 0.5) * dimX
          xf[w++] = cy
          xf[w++] = cz
          xf[w++] = sx
          xf[w++] = sy
          xf[w++] = sz
          const cat = cats[rowBase + i] ?? 0
          const pb = cat * 4
          col[c++] = pal[pb] ?? 0
          col[c++] = pal[pb + 1] ?? 0
          col[c++] = pal[pb + 2] ?? 0
          col[c++] = cat === 0 ? 0 : pal[pb + 3] ?? 0
        }
      }
    }

    const originHeight = t.zPlaneFloors[0] ?? 0
    const originEcef = Cartesian3.fromDegrees(
      t.originLonDeg,
      t.originLatDeg,
      originHeight,
      Ellipsoid.WGS84,
      _scratchOrigin,
    )
    Transforms.eastNorthUpToFixedFrame(originEcef, Ellipsoid.WGS84, this.modelMatrix)

    _scratchMid.x = (t.nx * dimX) / 2
    _scratchMid.y = (t.ny * dimY) / 2
    _scratchMid.z = (planes * dimZ) / 2
    Matrix4.multiplyByPoint(this.modelMatrix, _scratchMid, this.boundingSphere.center)
    this.boundingSphere.radius = Math.hypot(t.nx * dimX, t.ny * dimY, planes * dimZ) * 0.5 + dimZ

    this.instanceCount = total
    this.dirty = true
  }

  public update(frameState: CesiumFrameState): void {
    if (this.destroyed || !this.show || this.instanceCount === 0) return
    if (frameState.passes && frameState.passes.render === false) return

    if (this.dirty) {
      this.uploadAll(frameState.context)
      this.dirty = false
    }
    if (!this.command) return

    this.command.modelMatrix = this.modelMatrix
    this.command.boundingVolume = this.boundingSphere
    this.command.instanceCount = this.instanceCount
    this.command.count = UNIT_BOX_INDICES.length
    frameState.commandList.push(this.command)
  }

  private uploadAll(context: CesiumContext): void {
    if (!this.sp) {
      this.sp = CesiumShaderProgramApi.fromCache({
        context,
        vertexShaderSource: VERTEX_SHADER,
        fragmentShaderSource: FRAGMENT_SHADER,
        attributeLocations: { position: 0, a_center: 1, a_size: 2, a_color: 3 },
      })
    }
    if (!this.rs) {
      this.rs = CesiumRenderStateApi.fromCache({
        cull: { enabled: true, face: WebGLConstants.BACK },
        depthTest: { enabled: true },
        depthMask: false,
        blending: {
          enabled: true,
          equationRgb: WebGLConstants.FUNC_ADD,
          equationAlpha: WebGLConstants.FUNC_ADD,
          functionSourceRgb: WebGLConstants.ONE,
          functionDestinationRgb: WebGLConstants.ONE_MINUS_SRC_ALPHA,
          functionSourceAlpha: WebGLConstants.ONE,
          functionDestinationAlpha: WebGLConstants.ONE_MINUS_SRC_ALPHA,
        },
      })
    }
    // 静态单位盒缓冲跨重建复用：置 vertexArrayDestroyable=false，避免 destroyVa() 连带销毁后被复用而抛错。
    if (!this.cornerBuffer) {
      this.cornerBuffer = CesiumBufferApi.createVertexBuffer({
        context,
        typedArray: UNIT_BOX_CORNERS,
        usage: CesiumBufferUsage.STATIC_DRAW,
      })
      this.cornerBuffer.vertexArrayDestroyable = false
    }
    if (!this.indexBuffer) {
      this.indexBuffer = CesiumBufferApi.createIndexBuffer({
        context,
        typedArray: UNIT_BOX_INDICES,
        usage: CesiumBufferUsage.STATIC_DRAW,
        indexDatatype: CesiumIndexDatatype.UNSIGNED_SHORT,
      })
      this.indexBuffer.vertexArrayDestroyable = false
    }

    // 逐实例缓冲：每次重建整体重传（属性引擎的固有成本）。
    if (this.xformBuffer && !this.xformBuffer.isDestroyed()) this.xformBuffer.destroy()
    if (this.colorBuffer && !this.colorBuffer.isDestroyed()) this.colorBuffer.destroy()
    this.xformBuffer = CesiumBufferApi.createVertexBuffer({
      context,
      typedArray: this.xform!.subarray(0, this.instanceCount * 6),
      usage: CesiumBufferUsage.STATIC_DRAW,
    })
    this.colorBuffer = CesiumBufferApi.createVertexBuffer({
      context,
      typedArray: this.colors!.subarray(0, this.instanceCount * 4),
      usage: CesiumBufferUsage.STATIC_DRAW,
    })

    this.destroyVa()
    this.va = new CesiumVertexArrayCtor({
      context,
      attributes: [
        {
          index: 0,
          vertexBuffer: this.cornerBuffer,
          componentsPerAttribute: 3,
          componentDatatype: CesiumComponentDatatype.FLOAT,
          normalize: false,
          offsetInBytes: 0,
          strideInBytes: 12,
          instanceDivisor: 0,
        },
        {
          index: 1,
          vertexBuffer: this.xformBuffer,
          componentsPerAttribute: 3,
          componentDatatype: CesiumComponentDatatype.FLOAT,
          normalize: false,
          offsetInBytes: 0,
          strideInBytes: 24,
          instanceDivisor: 1,
        },
        {
          index: 2,
          vertexBuffer: this.xformBuffer,
          componentsPerAttribute: 3,
          componentDatatype: CesiumComponentDatatype.FLOAT,
          normalize: false,
          offsetInBytes: 12,
          strideInBytes: 24,
          instanceDivisor: 1,
        },
        {
          index: 3,
          vertexBuffer: this.colorBuffer,
          componentsPerAttribute: 4,
          componentDatatype: WebGLConstants.UNSIGNED_BYTE,
          normalize: true,
          offsetInBytes: 0,
          strideInBytes: 4,
          instanceDivisor: 1,
        },
      ],
      indexBuffer: this.indexBuffer,
    })

    this.command = new CesiumDrawCommandCtor({
      vertexArray: this.va,
      shaderProgram: this.sp,
      renderState: this.rs,
      primitiveType: CesiumPrimitiveType.TRIANGLES,
      pass: CesiumPass.TRANSLUCENT,
      modelMatrix: this.modelMatrix,
      boundingVolume: this.boundingSphere,
      owner: this,
      cull: true,
      instanceCount: this.instanceCount,
      count: UNIT_BOX_INDICES.length,
      uniformMap: { u_opacity: () => this.opacity },
    })
  }

  public setOpacity(opacity: number): void {
    this.opacity = clamp(opacity, 0, 1)
  }

  public setVisible(visible: boolean): void {
    this.show = visible
  }

  public isDestroyed(): boolean {
    return this.destroyed
  }

  public destroy(): boolean {
    if (this.destroyed) return true
    this.destroyVa()
    if (this.cornerBuffer && !this.cornerBuffer.isDestroyed()) this.cornerBuffer.destroy()
    if (this.indexBuffer && !this.indexBuffer.isDestroyed()) this.indexBuffer.destroy()
    if (this.xformBuffer && !this.xformBuffer.isDestroyed()) this.xformBuffer.destroy()
    if (this.colorBuffer && !this.colorBuffer.isDestroyed()) this.colorBuffer.destroy()
    if (this.sp && !this.sp.isDestroyed()) this.sp.destroy()
    this.cornerBuffer = undefined
    this.indexBuffer = undefined
    this.xformBuffer = undefined
    this.colorBuffer = undefined
    this.sp = undefined
    this.command = undefined
    this.rs = undefined
    this.xform = undefined
    this.colors = undefined
    this.destroyed = true
    return true
  }

  private destroyVa(): void {
    if (this.va && !this.va.isDestroyed()) this.va.destroy()
    this.va = undefined
  }
}
