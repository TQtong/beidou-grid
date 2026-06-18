/**
 * 满填充 · GPU 派生实例化体素引擎（**核心**，见设计 03/04/05/06）。
 *
 * 一句话：北斗格是规则点阵，任意格位置完全由 `gl_InstanceID` 在 GPU 端推导（**零位置上传**），
 * 每格只上传 **1 字节类别**，类别经 `256×1` 调色板纹理取色，空格在 VS 内塌缩跳过。
 *
 * 四条优化：
 *   ① 位置 GPU 派生（零位置/尺寸上传）——VertexArray 只含单位盒 `position`（divisor 0）；
 *   ② 每格 1 字节类别（`LUMINANCE` 数据纹理，CPU 端唯一 O(total) 工作退化成一次 memcpy）；
 *   ③ 类别 → 调色板间接取色（改配色只换 `256×4` 调色板，无需重写百万格）；
 *   ④ 空格（类别 0）VS 内塌缩为零面积三角形，GPU 几乎零成本跳过。
 *
 * 与 Cesium 帧循环接合：作为自定义 Primitive 加入 `scene.primitives`；
 *   - `rebuild()` 只算标量 + 标脏，**不碰 GPU**（可在任意线程时机调用）；
 *   - `update(frameState)` 才建/刷新 GPU 资源并推 DrawCommand（此时在渲染线程、有 context）。
 */
import * as Cesium from 'cesium'
import type { Tessellation } from '../grid/GridTessellator'
import type { OccupancyColoring } from './GridInstancedFill'
import {
  CesiumBufferApi,
  CesiumBufferUsage,
  CesiumVertexArrayCtor,
  CesiumShaderProgramApi,
  CesiumRenderStateApi,
  CesiumDrawCommandCtor,
  CesiumPass,
  CesiumTextureCtor,
  CesiumSamplerCtor,
  CesiumContextLimits,
  CesiumPixelFormat,
  CesiumPixelDatatype,
  CesiumComponentDatatype,
  CesiumIndexDatatype,
  CesiumPrimitiveType,
  WebGLConstants,
  TextureMinificationFilter,
  TextureMagnificationFilter,
  type CesiumContext,
  type CesiumFrameState,
  type CesiumBuffer,
  type CesiumVertexArray,
  type CesiumShaderProgram,
  type CesiumRenderState,
  type CesiumSampler,
  type CesiumTexture,
  type CesiumDrawCommand,
} from './CesiumInternals'

const { Cartesian2, Cartesian3, Matrix4, Transforms, Ellipsoid, Math: CesiumMath, BoundingSphere } =
  Cesium

/** 区域跨度（经/纬向，度）超过此阈值时切到 geodetic-exact，以消除切平面近似的地理位移。 */
export const GEODETIC_SPAN_THRESHOLD_DEG = 8.0

/** 数据纹理首选宽度（≤ 绝大多数 GPU 的 maximumTextureSize）。 */
const PREFERRED_TEX_WIDTH = 4096
/** 赤道每度米长（纬向恒定近似；经向再乘 cos(lat)）。 */
const METERS_PER_DEG = 111320.0
/** 默认填充比例（<1 时格间留缝）。 */
const DEFAULT_FILL_RATIO = 0.92

/** GPU 引擎可选项（属性引擎忽略本类型）。 */
export interface VoxelGpuOptions {
  /** 洲际级窗口置 true → VS 内逐格精确 WGS84→ECEF。 */
  geodetic?: boolean
  /** 填充比例 [0.05,1]，<1 留缝。 */
  fillRatio?: number
  /** 是否启用屏幕导数面法线的半 Lambert 光照（体积感）。 */
  lit?: boolean
}

/**
 * 单位盒 8 顶点（局部坐标，范围 [-0.5,0.5]³）。先底面 4 角(z-)，再顶面 4 角(z+)。
 */
const UNIT_BOX_CORNERS = new Float32Array([
  -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5,
  0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
])

/** 单位盒 12 三角形（36 索引），CCW 外向，配合背面剔除。 */
const UNIT_BOX_INDICES = new Uint16Array([
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2,
  6, 1, 6, 5,
])

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

// —— 着色器拼装（GLSL ES 3.00；Cesium 在 WebGL2 下自动补 `#version 300 es` 与 `out_FragColor`）——

const ENU_FAST_POSITION_BLOCK = /* glsl */ `
  // ENU-fast：切平面局部米（相对区域原点），modelMatrix = 原点 ENU→ECEF 帧。
  vec3 center = vec3(
    (float(i) + 0.5) * u_cellSize.x,
    (float(j) + 0.5) * u_cellSize.y,
    (float(zi) + 0.5) * u_cellSize.z
  );
  vec3 localMeters = center + position * (u_cellSize * u_fillRatio);
  gl_Position = czm_modelViewProjection * vec4(localMeters, 1.0);
  v_posEC = (czm_modelView * vec4(localMeters, 1.0)).xyz;
`

const GEODETIC_POSITION_BLOCK = /* glsl */ `
  // geodetic-exact：逐格中心精确 WGS84→ECEF + 每格 ENU 基放置盒角（modelMatrix = 单位阵）。
  float lonC = u_originLonDeg + (float(i) + 0.5) * u_stepDeg.x;
  float latC = u_originLatDeg + (float(j) + 0.5) * u_stepDeg.y;
  float hC   = u_zBase + (float(zi) + 0.5) * u_cellSize.z;
  const float a  = 6378137.0;
  const float b  = 6356752.314245179;
  const float e2 = 6.6943799901413165e-3;
  float latR = radians(latC);
  float lonR = radians(lonC);
  float cosLat = cos(latR);
  float sinLat = sin(latR);
  float cosLon = cos(lonR);
  float sinLon = sin(lonR);
  float N = a / sqrt(1.0 - e2 * sinLat * sinLat);
  vec3 centerEcef = vec3(
    (N + hC) * cosLat * cosLon,
    (N + hC) * cosLat * sinLon,
    ((b * b) / (a * a) * N + hC) * sinLat
  );
  vec3 up    = vec3(cosLat * cosLon, cosLat * sinLon, sinLat);
  vec3 east  = vec3(-sinLon, cosLon, 0.0);
  vec3 north = vec3(-sinLat * cosLon, -sinLat * sinLon, cosLat);
  float halfX = 0.5 * u_cellSize.x * u_fillRatio;
  float halfY = 0.5 * u_cellSize.y * u_fillRatio;
  float halfZ = 0.5 * u_cellSize.z * u_fillRatio;
  vec3 offset = position.x * (2.0 * halfX) * east
              + position.y * (2.0 * halfY) * north
              + position.z * (2.0 * halfZ) * up;
  vec3 worldPos = centerEcef + offset;
  // 绝对 ECEF（~6.4e6 m）若直接乘 float32 的 czm_modelViewProjection 会因尾数精度抖动（jitter）。
  // 用 Cesium 的 RTE（relative-to-eye）路径：把坐标拆 high/low，在眼相对小量级里做变换，消除抖动。
  // 仅在 geodetic（modelMatrix=单位阵，模型空间≡世界 ECEF）下成立。
  vec3 posHigh = floor(worldPos / 65536.0) * 65536.0;
  vec3 posLow  = worldPos - posHigh;
  vec4 pRTE = czm_translateRelativeToEye(posHigh, posLow);
  gl_Position = czm_modelViewProjectionRelativeToEye * pRTE;
  v_posEC = (czm_modelViewRelativeToEye * pRTE).xyz;
`

const buildVertexShader = (geodetic: boolean): string => /* glsl */ `
in vec3 position;
uniform highp sampler2D u_catTex;
uniform highp sampler2D u_palette;
uniform int   u_nx;
uniform int   u_ny;
uniform int   u_texW;
uniform int   u_texH;
uniform vec3  u_cellSize;
uniform float u_fillRatio;
uniform float u_originLonDeg;
uniform float u_originLatDeg;
uniform vec2  u_stepDeg;
uniform float u_zBase;
out vec4 v_color;
out vec3 v_posEC;

void main() {
  int id = gl_InstanceID;
  // 由实例 id 反解格索引（与 OccupancyColoring.categories 的 idx 布局严格一致）：
  //   idx = (zi·ny + j)·nx + i  ⇒  i = id % nx; j = (id/nx) % ny; zi = id/(nx·ny)。
  int i  = id % u_nx;
  int j  = (id / u_nx) % u_ny;
  int zi = id / (u_nx * u_ny);

  // 取该格类别：id → 纹素 (tx,ty)，NEAREST 采样中心。
  int tx = id % u_texW;
  int ty = id / u_texW;
  vec2 uv = vec2((float(tx) + 0.5) / float(u_texW), (float(ty) + 0.5) / float(u_texH));
  int category = int(texture(u_catTex, uv).r * 255.0 + 0.5);

  // 空格（类别 0）塌缩为零体积 → 零面积三角形，GPU 跳过。
  if (category == 0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_color = vec4(0.0);
    v_posEC = vec3(0.0);
    return;
  }

  // 类别 → 颜色（调色板 256×1）。
  v_color = texture(u_palette, vec2((float(category) + 0.5) / 256.0, 0.5));

  ${geodetic ? GEODETIC_POSITION_BLOCK : ENU_FAST_POSITION_BLOCK}
}
`

const buildFragmentShader = (lit: boolean): string => /* glsl */ `
in vec4 v_color;
in vec3 v_posEC;
uniform float u_opacity;

void main() {
  vec4 c = v_color;
${
  lit
    ? `  // 面法线：眼空间位置的屏幕空间偏导（无需逐顶点法线属性）。
  vec3 dx = dFdx(v_posEC);
  vec3 dy = dFdy(v_posEC);
  vec3 n = normalize(cross(dx, dy));
  if (n.z < 0.0) n = -n;
  float ndl = clamp(dot(n, normalize(vec3(0.35, 0.25, 1.0))), 0.0, 1.0);
  float shade = 0.55 + 0.45 * ndl;
  c.rgb *= shade;`
    : ''
}
  c.a *= u_opacity;
  c.rgb *= c.a; // 预乘（Cesium TRANSLUCENT 通道按预乘 over 混合）
  out_FragColor = c;
}
`

const _scratchOrigin = new Cartesian3()
const _scratchMid = new Cartesian3()

/**
 * GPU 派生实例化体素引擎。结构化满足场景的 `InstancedFillEngine` 契约。
 */
export default class GridInstancedVoxelGPU {
  // —— 标量（rebuild 落盘，update 消费）——
  private nx = 0
  private ny = 0
  private planes = 0
  private texW = 0
  private texH = 0
  private instanceCount = 0
  private cellSize: [number, number, number] = [1, 1, 1]
  private fillRatio = DEFAULT_FILL_RATIO
  private originLonDeg = 0
  private originLatDeg = 0
  private stepLonDeg = 0
  private stepLatDeg = 0
  private zBase = 0
  private geodetic = false
  private lit = true
  private opacity: number

  private readonly modelMatrix: Cesium.Matrix4 = Matrix4.clone(Matrix4.IDENTITY, new Matrix4())
  private readonly boundingSphere: Cesium.BoundingSphere = new BoundingSphere()

  // —— CPU 端复用缓冲 ——
  private catScratch?: Uint8Array
  private readonly palScratch = new Uint8Array(256 * 4)

  // —— GPU 资源 ——
  private catTexture?: CesiumTexture
  private palTexture?: CesiumTexture
  private sampler?: CesiumSampler
  private rs?: CesiumRenderState
  private va?: CesiumVertexArray
  private cornerBuffer?: CesiumBuffer
  private indexBuffer?: CesiumBuffer
  private spFast?: CesiumShaderProgram
  private spGeodetic?: CesiumShaderProgram
  /** 各变体编译时使用的 lit 值，用于在 lit 改变时重编译（否则会复用旧变体）。 */
  private spFastLit?: boolean
  private spGeodeticLit?: boolean
  private command?: CesiumDrawCommand

  // —— 状态 ——
  private dimsDirty = false
  private dataDirty = false
  private show = true
  private destroyed = false

  constructor(opacity = 1.0) {
    this.opacity = clamp(opacity, 0, 1)
  }

  /**
   * 重建（只算标量 + 标脏，**不碰 GPU**）。
   * @param t 规则网格模型。
   * @param coloring 占用着色（行优先 categories + 256×4 palette）。
   * @param opt GPU 选项（geodetic / fillRatio / lit）。
   */
  public rebuild(t: Tessellation, coloring: OccupancyColoring, opt?: VoxelGpuOptions): void {
    if (this.destroyed) return

    const planes = Math.max(1, t.zPlaneFloors.length)
    const total = t.nx * t.ny * planes

    // 米尺寸：东向随纬度按 cos(lat) 收缩；北向恒定近似；垂向用层高（下限 1 m）。
    const cosLat = Math.max(0.02, Math.cos(CesiumMath.toRadians(t.originLatDeg)))
    const dimX = t.stepLonDeg * METERS_PER_DEG * cosLat
    const dimY = t.stepLatDeg * METERS_PER_DEG
    const dimZ = Math.max(1.0, t.heightStep)

    const geodetic = !!opt?.geodetic
    if (typeof opt?.fillRatio === 'number') this.fillRatio = clamp(opt.fillRatio, 0.05, 1.0)
    const lit = opt?.lit ?? this.lit

    // 数据纹理尺寸 + 越界校验（不静默截断）。
    const maxTex = CesiumContextLimits.maximumTextureSize > 0 ? CesiumContextLimits.maximumTextureSize : 4096
    const texW = Math.min(PREFERRED_TEX_WIDTH, maxTex)
    const texH = Math.max(1, Math.ceil(total / texW))
    if (texH > maxTex) {
      throw new RangeError(
        `GridInstancedVoxelGPU: ${total.toLocaleString()} cells exceed a single data texture ` +
          `(${texW}×${texH} > maxTextureSize ${maxTex}). Reduce level or tile the region.`,
      )
    }

    // 类别字节填充（唯一 O(total) CPU 工作：一次 memcpy + 清尾部 padding）。
    const need = texW * texH
    if (!this.catScratch || this.catScratch.length < need) this.catScratch = new Uint8Array(need)
    const cats = coloring.categories
    const copyLen = Math.min(total, cats.length)
    this.catScratch.set(cats.subarray(0, copyLen), 0)
    if (need > copyLen) this.catScratch.fill(0, copyLen, need)

    // 调色板（256×4）：整幅覆盖，清残留。
    this.palScratch.fill(0)
    this.palScratch.set(coloring.palette.subarray(0, Math.min(coloring.palette.length, 256 * 4)))

    // modelMatrix：geodetic → 单位阵（VS 输出绝对 ECEF）；ENU-fast → 原点 ENU→ECEF 帧。
    const originHeight = t.zPlaneFloors[0] ?? 0
    if (geodetic) {
      Matrix4.clone(Matrix4.IDENTITY, this.modelMatrix)
    } else {
      const originEcef = Cartesian3.fromDegrees(
        t.originLonDeg,
        t.originLatDeg,
        originHeight,
        Ellipsoid.WGS84,
        _scratchOrigin,
      )
      Transforms.eastNorthUpToFixedFrame(originEcef, Ellipsoid.WGS84, this.modelMatrix)
    }

    // 包围球（视锥裁剪）：中心 = 区域中点；半径 = 半对角 + 一层高。
    const radius = Math.hypot(t.nx * dimX, t.ny * dimY, planes * dimZ) * 0.5 + dimZ
    if (geodetic) {
      const midLon = t.originLonDeg + (t.nx * t.stepLonDeg) / 2
      const midLat = t.originLatDeg + (t.ny * t.stepLatDeg) / 2
      const midH = originHeight + (planes * dimZ) / 2
      Cartesian3.fromDegrees(midLon, midLat, midH, Ellipsoid.WGS84, this.boundingSphere.center)
    } else {
      _scratchMid.x = (t.nx * dimX) / 2
      _scratchMid.y = (t.ny * dimY) / 2
      _scratchMid.z = (planes * dimZ) / 2
      Matrix4.multiplyByPoint(this.modelMatrix, _scratchMid, this.boundingSphere.center)
    }
    this.boundingSphere.radius = radius

    // 维度/变体是否变化（决定走重路径 uploadDims 还是轻路径 uploadData）。
    const dimsChanged =
      this.nx !== t.nx ||
      this.ny !== t.ny ||
      this.planes !== planes ||
      this.texW !== texW ||
      this.texH !== texH ||
      this.geodetic !== geodetic ||
      this.lit !== lit

    // 落盘标量。
    this.nx = t.nx
    this.ny = t.ny
    this.planes = planes
    this.texW = texW
    this.texH = texH
    this.instanceCount = total
    this.cellSize = [dimX, dimY, dimZ]
    this.originLonDeg = t.originLonDeg
    this.originLatDeg = t.originLatDeg
    this.stepLonDeg = t.stepLonDeg
    this.stepLatDeg = t.stepLatDeg
    this.zBase = originHeight
    this.geodetic = geodetic
    this.lit = lit

    this.dimsDirty = this.dimsDirty || dimsChanged || !this.command
    this.dataDirty = true
  }

  /** 每帧由 Cesium 调用：按脏标记建/刷新 GPU 资源并推命令。 */
  public update(frameState: CesiumFrameState): void {
    if (this.destroyed || !this.show || this.instanceCount === 0) return
    // 仅在渲染 pass 推命令（拾取由场景层射线/深度法处理，互不增加成本）。
    if (frameState.passes && frameState.passes.render === false) return

    const context = frameState.context

    if (this.dimsDirty) {
      this.uploadDims(context)
      this.dimsDirty = false
      this.dataDirty = false
    } else if (this.dataDirty) {
      this.uploadData()
      this.dataDirty = false
    }
    if (!this.command) return

    // 刷新随帧可变字段。
    this.command.modelMatrix = this.modelMatrix
    this.command.boundingVolume = this.boundingSphere
    this.command.instanceCount = this.instanceCount
    this.command.count = UNIT_BOX_INDICES.length

    frameState.commandList.push(this.command)
  }

  /** 重路径：尺寸/变体变 → 重建纹理 / VA / DrawCommand。 */
  private uploadDims(context: CesiumContext): void {
    // 着色器变体（按 geodetic + lit）。lit 改变时须重编译并释放旧程序（保持 ShaderCache 引用计数平衡）。
    if (this.geodetic && (!this.spGeodetic || this.spGeodeticLit !== this.lit)) {
      if (this.spGeodetic && !this.spGeodetic.isDestroyed()) this.spGeodetic.destroy()
      this.spGeodetic = CesiumShaderProgramApi.fromCache({
        context,
        vertexShaderSource: buildVertexShader(true),
        fragmentShaderSource: buildFragmentShader(this.lit),
        attributeLocations: { position: 0 },
      })
      this.spGeodeticLit = this.lit
    }
    if (!this.geodetic && (!this.spFast || this.spFastLit !== this.lit)) {
      if (this.spFast && !this.spFast.isDestroyed()) this.spFast.destroy()
      this.spFast = CesiumShaderProgramApi.fromCache({
        context,
        vertexShaderSource: buildVertexShader(false),
        fragmentShaderSource: buildFragmentShader(this.lit),
        attributeLocations: { position: 0 },
      })
      this.spFastLit = this.lit
    }

    // NEAREST 采样器（共用）：线性会把相邻格类别混进来。
    if (!this.sampler) {
      this.sampler = new CesiumSamplerCtor({
        minificationFilter: TextureMinificationFilter.NEAREST,
        magnificationFilter: TextureMagnificationFilter.NEAREST,
        wrapS: WebGLConstants.CLAMP_TO_EDGE,
        wrapT: WebGLConstants.CLAMP_TO_EDGE,
      })
    }

    // 类别数据纹理（尺寸变则重建）。
    this.destroyTexture('catTexture')
    this.catTexture = new CesiumTextureCtor({
      context,
      width: this.texW,
      height: this.texH,
      pixelFormat: CesiumPixelFormat.LUMINANCE,
      pixelDatatype: CesiumPixelDatatype.UNSIGNED_BYTE,
      flipY: false,
      source: {
        width: this.texW,
        height: this.texH,
        arrayBufferView: this.catScratch!.subarray(0, this.texW * this.texH),
      },
      sampler: this.sampler,
    })

    // 调色板纹理（256×1 RGBA8）：首建 / 复用刷新。
    if (!this.palTexture) {
      this.palTexture = new CesiumTextureCtor({
        context,
        width: 256,
        height: 1,
        pixelFormat: CesiumPixelFormat.RGBA,
        pixelDatatype: CesiumPixelDatatype.UNSIGNED_BYTE,
        flipY: false,
        source: { width: 256, height: 1, arrayBufferView: this.palScratch },
        sampler: this.sampler,
      })
    } else {
      this.palTexture.copyFrom({ source: { width: 256, height: 1, arrayBufferView: this.palScratch } })
    }

    // 静态单位盒缓冲（跨重建复用）。置 vertexArrayDestroyable=false：销毁旧 VA 时不连带销毁它们
    //（否则下次 new VertexArray 引用已销毁 buffer 会抛 “This object was destroyed”）。本类在 destroy() 内自行销毁。
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

    // RenderState（半透：背面剔除 + 深度测试不写深度 + 预乘 over 混合）。
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

    // VertexArray（仅 position，divisor 0：无逐实例属性，差异全走 gl_InstanceID）。
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
      ],
      indexBuffer: this.indexBuffer,
    })

    // DrawCommand（单 instanced draw）。
    const sp = this.geodetic ? this.spGeodetic! : this.spFast!
    this.command = new CesiumDrawCommandCtor({
      vertexArray: this.va,
      shaderProgram: sp,
      renderState: this.rs,
      primitiveType: CesiumPrimitiveType.TRIANGLES,
      pass: CesiumPass.TRANSLUCENT,
      modelMatrix: this.modelMatrix,
      boundingVolume: this.boundingSphere,
      owner: this,
      cull: true,
      instanceCount: this.instanceCount,
      count: UNIT_BOX_INDICES.length,
      uniformMap: this.buildUniformMap(),
    })
  }

  /** 轻路径：仅内容变 → copyFrom 局部刷新（整幅；1 字节/格，足够快）。 */
  private uploadData(): void {
    if (this.catTexture) {
      this.catTexture.copyFrom({
        source: {
          width: this.texW,
          height: this.texH,
          arrayBufferView: this.catScratch!.subarray(0, this.texW * this.texH),
        },
      })
    }
    if (this.palTexture) {
      this.palTexture.copyFrom({ source: { width: 256, height: 1, arrayBufferView: this.palScratch } })
    }
  }

  /** Uniform 闭包（随帧取最新标量）。 */
  private buildUniformMap(): Record<string, () => unknown> {
    return {
      u_catTex: () => this.catTexture,
      u_palette: () => this.palTexture,
      u_nx: () => this.nx,
      u_ny: () => this.ny,
      u_texW: () => this.texW,
      u_texH: () => this.texH,
      u_cellSize: () => new Cartesian3(this.cellSize[0], this.cellSize[1], this.cellSize[2]),
      u_fillRatio: () => this.fillRatio,
      u_originLonDeg: () => this.originLonDeg,
      u_originLatDeg: () => this.originLatDeg,
      u_stepDeg: () => new Cartesian2(this.stepLonDeg, this.stepLatDeg),
      u_zBase: () => this.zBase,
      u_opacity: () => this.opacity,
    }
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
    this.destroyTexture('catTexture')
    this.destroyTexture('palTexture')
    if (this.cornerBuffer && !this.cornerBuffer.isDestroyed()) this.cornerBuffer.destroy()
    if (this.indexBuffer && !this.indexBuffer.isDestroyed()) this.indexBuffer.destroy()
    this.cornerBuffer = undefined
    this.indexBuffer = undefined
    if (this.spFast && !this.spFast.isDestroyed()) this.spFast.destroy()
    if (this.spGeodetic && !this.spGeodetic.isDestroyed()) this.spGeodetic.destroy()
    this.spFast = undefined
    this.spGeodetic = undefined
    this.spFastLit = undefined
    this.spGeodeticLit = undefined
    this.command = undefined
    this.rs = undefined // RenderState 走 cache，不单独销毁
    this.sampler = undefined
    this.catScratch = undefined
    this.destroyed = true
    return true
  }

  private destroyTexture(field: 'catTexture' | 'palTexture'): void {
    const tex = this[field]
    if (tex && !tex.isDestroyed()) tex.destroy()
    this[field] = undefined
  }

  private destroyVa(): void {
    if (this.va && !this.va.isDestroyed()) this.va.destroy()
    this.va = undefined
  }
}
