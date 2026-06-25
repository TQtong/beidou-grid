// ============================================================
// GridCubeField.ts — 统一实例化立方体场（线框 / 填充 + 状态着色 + GPU 拾取）
// 层级：L3（渲染 Primitive 控制器，自定义 DrawCommand）
// 职责：用「一份单位盒 + 一次实例化 draw」绘制整片北斗格立方体，同时满足三需求：
//        ① 默认线框、可切实心填充；每格按「状态纹理 + 调色板」独立着色；
//        ② 级别/区域变化时由编排器重设剖分（setTessellation），位置全部由
//           gl_InstanceID 推出，零逐实例位置上传；
//        ③ GPU 离屏拾取：点击立方体 → 解码实例号 → 切换其选中色；
//        ④ 无人机影响：setDroneInfluence 标记周边格并变色。
// 精度：command.modelMatrix = 区域原点 ENU→ECEF 帧；VS 在相对原点的局部米计算
//       （float32 精度足够，规避绝对 ECEF 大坐标抖动），与旧 GridInstancedFill 一致。
// 依赖：cesium 内部渲染 API（经 cesium-internals 收口）+ 公开 API（BoundingSphere/
//       Cartesian3/Matrix4/Transforms/PrimitiveType/ComponentDatatype/IndexDatatype/
//       WebGLConstants/Ellipsoid/Math/Scene）、GridFieldShaders、GridStateModel、
//       InstancePicker、GridTessellator 的 Tessellation。
// 生命周期：静态 GPU 资源（单位盒/着色器/命令）首次 update 时建一次；状态纹理随
//       尺寸变化重建、随状态变化整幅 copyFrom；destroy 释放全部 GPU 资源。
// 被消费：BeiDouFieldScene。
// ============================================================

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
  type Scene,
} from 'cesium';

import {
  CesiumInternals,
  type CesiumBuffer,
  type CesiumDrawCommand,
  type CesiumShaderProgram,
  type CesiumTexture,
  type CesiumVertexArray,
  type CesiumContext,
  type CesiumFrameState,
} from './cesium-internals';
import {
  ATTRIBUTE_LOCATIONS,
  PICK_FRAGMENT_SHADER,
  PICK_VERTEX_SHADER,
  RENDER_FRAGMENT_SHADER,
  RENDER_VERTEX_SHADER,
} from './GridFieldShaders';
import GridStateModel, { type GridCellInfo } from './GridStateModel';
import InstancePicker from './InstancePicker';
import type { Tessellation } from '../grid/GridTessellator';
import { pointToCode2D, pointToCode3D } from '../geo-bridge';

/** 渲染模式：线框 / 填充。 */
export type FieldMode = 'wire' | 'fill';

/** 拾取回调：参数为被点中的实例号（-1 表示点到空白）。 */
export type PickCallback = (instanceId: number) => void;

/** 拾取到的网格编码与格信息。 */
export interface PickedGridInfo extends GridCellInfo {
  /** 二维北斗网格编码。 */
  code2D: string;
  /** 三维北斗网格编码。 */
  code3D: string;
}

/** 赤道每度米长（纬向恒定近似，经向再乘 cos(lat)）。 */
const METERS_PER_DEG = 111320.0;

/**
 * 单位盒 8 角，分量 ∈ {0,1}（与着色器 (i+position.x) 的覆盖区间自洽）。
 * 0-3 底面（z=0），4-7 顶面（z=1）。
 */
const UNIT_BOX_CORNERS = new Float32Array([
  0, 0, 0, // 0
  1, 0, 0, // 1
  1, 1, 0, // 2
  0, 1, 0, // 3
  0, 0, 1, // 4
  1, 0, 1, // 5
  1, 1, 1, // 6
  0, 1, 1, // 7
]);

/** 单位盒 12 三角（36 索引），CCW 外向（与 {0,1} 角点保持外向，可背面剔除）。 */
const TRI_INDICES = new Uint16Array([
  0, 2, 1, 0, 3, 2, // 底 z-
  4, 5, 6, 4, 6, 7, // 顶 z+
  0, 1, 5, 0, 5, 4, // 南 y-
  3, 7, 6, 3, 6, 2, // 北 y+
  0, 4, 7, 0, 7, 3, // 西 x-
  1, 2, 6, 1, 6, 5, // 东 x+
]);

/** 单位盒 12 条棱（24 索引），用于线框模式。 */
const WIRE_INDICES = new Uint16Array([
  0, 1, 1, 2, 2, 3, 3, 0, // 底环
  4, 5, 5, 6, 6, 7, 7, 4, // 顶环
  0, 4, 1, 5, 2, 6, 3, 7, // 竖棱
]);

const TRI_INDEX_COUNT = TRI_INDICES.length;
const WIRE_INDEX_COUNT = WIRE_INDICES.length;

const _scratchOrigin = new Cartesian3();
const _scratchMid = new Cartesian3();

export default class GridCubeField {
  /** Cesium 场景（拾取时取相机矩阵）。 */
  private readonly scene: Scene;
  /** 状态合成模型（类别 / 选中 / 无人机）。 */
  private readonly state = new GridStateModel();
  /** GPU 离屏拾取器。 */
  private readonly picker = new InstancePicker();

  // ── 静态 GPU 资源（与实例数无关，建一次）──
  private cornerBuffer: CesiumBuffer | undefined;
  private wireIndexBuffer: CesiumBuffer | undefined;
  private triIndexBuffer: CesiumBuffer | undefined;
  private vaWire: CesiumVertexArray | undefined;
  private vaTri: CesiumVertexArray | undefined;
  private renderSp: CesiumShaderProgram | undefined;
  private pickSp: CesiumShaderProgram | undefined;
  private rsLine: unknown;
  private rsTri: unknown;
  private rsPick: unknown;
  private renderCommand: CesiumDrawCommand | undefined;
  private pickCommand: CesiumDrawCommand | undefined;
  private staticBuilt = false;
  private palettesBuilt = false;

  // ── 状态 / 调色板纹理 ──
  private stateTexture: CesiumTexture | undefined;
  private paletteWireTex: CesiumTexture | undefined;
  private paletteFillTex: CesiumTexture | undefined;

  // ── 剖分镜像（供 uniformMap 读取）──
  private nx = 0;
  private ny = 0;
  private dimX = 1;
  private dimY = 1;
  private dimZ = 1;
  private texW = 1;
  private texH = 1;
  private instanceCount = 0;

  /** 区域原点 ENU→ECEF 帧（command.modelMatrix）。 */
  private readonly modelMatrix = Matrix4.clone(Matrix4.IDENTITY);
  /** 包围球（视锥裁剪）。 */
  private readonly boundingSphere = new BoundingSphere();

  /** 渲染模式（默认线框，对应需求①「默认线框」）。 */
  private mode: FieldMode = 'wire';
  /** 填充模式全局不透明度（线框恒为 1）。 */
  private fillOpacity = 1.0;
  /** 显示开关。 */
  private show = true;

  // ── 拾取 ──
  /** CPU 端自算的拾取投影矩阵（proj·view·model）。 */
  private readonly pickMvp = Matrix4.clone(Matrix4.IDENTITY);
  private readonly _mvScratch = Matrix4.clone(Matrix4.IDENTITY);
  /** 待处理的拾取请求（屏幕 CSS 像素 + 回调）。 */
  private pending: { x: number; y: number; cb?: PickCallback } | undefined;

  // ── 脏标记 ──
  /** 状态纹理尺寸需重建（实例数变化）。 */
  private texSizeDirty = false;
  /** 状态纹理数据需重传（选中 / 无人机变化）。 */
  private stateDirty = false;

  private destroyed = false;

  /**
   * @param scene Cesium 场景（用于拾取时读取相机视图/投影矩阵）
   */
  public constructor(scene: Scene) {
    this.scene = scene;
  }

  /**
   * 重设剖分（编排器在级别/区域变化后调用）。
   * 计算度→米因子、原点 ENU 帧、包围球，并把剖分写入状态模型（触发选中重映射）。
   * 不直接碰 GPU——纹理在下次 update（有 context 时）创建/上传。
   *
   * @param t 剖分结果（来自 GridTessellator）
   */
  public setTessellation(t: Tessellation): void {
    if (this.destroyed) return;

    const planes = Math.max(1, t.zPlaneFloors.length);
    const originHeight = t.zPlaneFloors[0] ?? 0;

    // 度→米（经向乘 cos(originLat)，区域内按原点纬度线性近似）。
    const cosLat = Math.max(0.02, Math.cos(CesiumMath.toRadians(t.originLatDeg)));
    const mPerDegLon = METERS_PER_DEG * cosLat;
    const mPerDegLat = METERS_PER_DEG;

    this.nx = t.nx;
    this.ny = t.ny;
    this.dimX = t.stepLonDeg * mPerDegLon;
    this.dimY = t.stepLatDeg * mPerDegLat;
    this.dimZ = Math.max(1.0, t.heightStep);
    this.instanceCount = t.nx * t.ny * planes;

    // 原点 ENU→ECEF 帧。
    const originEcef = Cartesian3.fromDegrees(
      t.originLonDeg,
      t.originLatDeg,
      originHeight,
      Ellipsoid.WGS84,
      _scratchOrigin,
    );
    Transforms.eastNorthUpToFixedFrame(originEcef, Ellipsoid.WGS84, this.modelMatrix);

    // 包围球：中心 = 区域中点（ENU 局部米 → ECEF）；半径 = 半对角 + 一层余量。
    const midLocal = _scratchMid;
    midLocal.x = (t.nx * this.dimX) / 2;
    midLocal.y = (t.ny * this.dimY) / 2;
    midLocal.z = (planes * this.dimZ) / 2;
    Matrix4.multiplyByPoint(this.modelMatrix, midLocal, this.boundingSphere.center);
    this.boundingSphere.radius =
      Math.hypot(t.nx * this.dimX, t.ny * this.dimY, planes * this.dimZ) * 0.5 + this.dimZ;

    // 写入状态模型（重算纹理尺寸、重映射选中、清无人机叠加）。
    const sizeChanged = this.state.setGrid({
      level: t.level,
      originLonDeg: t.originLonDeg,
      originLatDeg: t.originLatDeg,
      originHeightMeters: originHeight,
      stepLonDeg: t.stepLonDeg,
      stepLatDeg: t.stepLatDeg,
      heightStepMeters: this.dimZ,
      nx: t.nx,
      ny: t.ny,
      planes,
      metersPerDegLon: mPerDegLon,
    });
    void mPerDegLat; // 已经由 dimY 体现；保留命名以示对称

    this.texW = this.state.getTexWidth();
    this.texH = this.state.getTexHeight();
    if (sizeChanged) this.texSizeDirty = true;
    this.stateDirty = true;
  }

  /**
   * 设置渲染模式（需求①：线框 ↔ 填充）。仅切换命令的 VA/索引/渲染态，不重建 GPU 资源。
   *
   * @param mode 'wire' 线框 / 'fill' 填充
   */
  public setMode(mode: FieldMode): void {
    this.mode = mode;
  }

  /** 取当前渲染模式。 */
  public getMode(): FieldMode {
    return this.mode;
  }

  /**
   * 设置填充模式全局不透明度（0..1）。线框模式忽略此值。
   *
   * @param opacity 不透明度
   */
  public setFillOpacity(opacity: number): void {
    this.fillOpacity = CesiumMath.clamp(opacity, 0, 1);
  }

  /** 显示/隐藏整片立方体场。 */
  public setVisible(visible: boolean): void {
    this.show = visible;
  }

  /**
   * 设置无人机影响（需求③）。标记无人机周边受影响立方体并变色。
   *
   * @param lonDeg 无人机经度（度）
   * @param latDeg 无人机纬度（度）
   * @param heightMeters 无人机大地高（米）
   * @param radiusMeters 影响半径（米）
   */
  public setDroneInfluence(lonDeg: number, latDeg: number, heightMeters: number, radiusMeters: number): void {
    if (this.destroyed) return;
    this.state.setDroneInfluence(lonDeg, latDeg, heightMeters, radiusMeters);
    this.stateDirty = true;
  }

  /** 清除无人机影响（恢复底层选中/空格）。 */
  public clearDrone(): void {
    if (this.destroyed) return;
    this.state.clearDrone();
    this.stateDirty = true;
  }

  /** 清空全部选中。 */
  public clearSelections(): void {
    if (this.destroyed) return;
    this.state.clearSelections();
    this.stateDirty = true;
  }

  /**
   * 请求一次拾取（需求①：点击立方体改色）。坐标为屏幕 CSS 像素（左上原点）。
   * 实际拾取在下一帧 update 内执行（彼时有合法 context 与当前相机矩阵）。
   *
   * @param screenX 屏幕 X（CSS 像素）
   * @param screenY 屏幕 Y（CSS 像素）
   * @param cb      可选回调，返回被点中的实例号（-1 表示空白）
   */
  public requestPick(screenX: number, screenY: number, cb?: PickCallback): void {
    if (this.destroyed) return;
    this.pending = { x: screenX, y: screenY, cb };
  }

  /**
   * 把拾取实例号反查为北斗网格编码与展示信息。
   *
   * @param instanceId 拾取返回的实例号
   * @returns 网格编码信息；越界或编码失败返回 undefined
   */
  public getPickedGridInfo(instanceId: number): PickedGridInfo | undefined {
    const cell = this.state.getCellInfo(instanceId);
    if (!cell) return undefined;

    try {
      const { lonDeg, latDeg, heightMeters } = cell.center;
      return {
        ...cell,
        code2D: pointToCode2D(lonDeg, latDeg, cell.level),
        code3D: pointToCode3D(lonDeg, latDeg, heightMeters, cell.level),
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[GridCubeField] 网格编码生成失败（已忽略）：', err);
      return undefined;
    }
  }

  /**
   * 每帧由场景调用（scene.primitives.add(this) 后 Cesium 自动调用）：
   * 必要时建/更新 GPU 资源，推渲染命令，处理待办拾取。
   *
   * @param frameState Cesium 帧状态（含 context 与 commandList）
   */
  public update(frameState: CesiumFrameState): void {
    if (this.destroyed || !this.show || this.instanceCount === 0) return;
    const context = frameState.context;

    if (!this.staticBuilt) this.buildStaticGpu(context);
    if (!this.palettesBuilt) this.buildPalettes(context);

    // 状态纹理：尺寸变化重建（重建即含最新数据），否则按需整幅重传。
    if (this.texSizeDirty) {
      this.rebuildStateTexture(context);
      this.texSizeDirty = false;
      this.stateDirty = false;
    } else if (this.stateDirty) {
      this.uploadStateTexture();
      this.stateDirty = false;
    }

    if (!this.renderCommand) this.buildCommands(context);
    if (!this.renderCommand) return;

    // 刷新随帧/随模式变化的字段。
    const wire = this.mode === 'wire';
    this.renderCommand.vertexArray = wire ? this.vaWire : this.vaTri;
    this.renderCommand.count = wire ? WIRE_INDEX_COUNT : TRI_INDEX_COUNT;
    this.renderCommand.primitiveType = wire ? PrimitiveType.LINES : PrimitiveType.TRIANGLES;
    this.renderCommand.renderState = wire ? this.rsLine : this.rsTri;
    this.renderCommand.modelMatrix = this.modelMatrix;
    this.renderCommand.boundingVolume = this.boundingSphere;
    this.renderCommand.instanceCount = this.instanceCount;
    frameState.commandList.push(this.renderCommand);

    // 处理待办拾取（在合法 context + 当前相机矩阵下离屏渲染回读）。
    if (this.pending) this.runPick(context);
  }

  /**
   * 执行待办拾取：算 u_mvp → 用实心三角拾取命令离屏渲染 → 回读解码 → 切换选中。
   * 全程 try/catch，拾取异常绝不冲垮渲染循环。
   *
   * @param context Cesium 渲染上下文
   */
  private runPick(context: CesiumContext): void {
    const req = this.pending;
    this.pending = undefined;
    if (!req || !this.pickCommand) {
      req?.cb?.(-1);
      return;
    }
    try {
      // u_mvp = proj · (view · model)。view/proj 取自当前相机（update 内有效）。
      const camera = this.scene.camera;
      Matrix4.multiply(camera.viewMatrix, this.modelMatrix, this._mvScratch);
      Matrix4.multiply(camera.frustum.projectionMatrix, this._mvScratch, this.pickMvp);

      // 拾取恒用实心三角（线框模式下也用实心体拾取，点轮廓即可选中，UX 更好）。
      this.pickCommand.vertexArray = this.vaTri;
      this.pickCommand.count = TRI_INDEX_COUNT;
      this.pickCommand.primitiveType = PrimitiveType.TRIANGLES;
      this.pickCommand.renderState = this.rsPick;
      this.pickCommand.modelMatrix = this.modelMatrix;
      this.pickCommand.boundingVolume = this.boundingSphere;
      this.pickCommand.instanceCount = this.instanceCount;

      // 屏幕 CSS 像素 → GL（设备）像素。比例 = 绘制缓冲尺寸 / 画布客户端尺寸，
      // 该比例已包含 devicePixelRatio 与 Cesium resolutionScale，比读取 scene.pixelRatio 更稳健。
      const canvas = this.scene.canvas;
      const sx = canvas.clientWidth > 0 ? context.drawingBufferWidth / canvas.clientWidth : 1;
      const sy = canvas.clientHeight > 0 ? context.drawingBufferHeight / canvas.clientHeight : 1;
      const glX = req.x * sx;
      const glY = context.drawingBufferHeight - req.y * sy;

      const id = this.picker.pick(context, this.pickCommand, glX, glY);
      if (id >= 0) {
        this.state.toggleSelection(id);
        this.stateDirty = true;
      }
      req.cb?.(id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[GridCubeField] 拾取失败（已忽略，不影响渲染）：', err);
      req.cb?.(-1);
    }
  }

  /**
   * 构建静态 GPU 资源：单位盒角缓冲、线框/三角索引缓冲、两个 VertexArray。
   *
   * @param context Cesium 渲染上下文
   */
  private buildStaticGpu(context: CesiumContext): void {
    const I = CesiumInternals;

    this.cornerBuffer = I.Buffer.createVertexBuffer({
      context,
      typedArray: UNIT_BOX_CORNERS,
      usage: I.BufferUsage.STATIC_DRAW,
    });
    this.wireIndexBuffer = I.Buffer.createIndexBuffer({
      context,
      typedArray: WIRE_INDICES,
      usage: I.BufferUsage.STATIC_DRAW,
      indexDatatype: IndexDatatype.UNSIGNED_SHORT,
    });
    this.triIndexBuffer = I.Buffer.createIndexBuffer({
      context,
      typedArray: TRI_INDICES,
      usage: I.BufferUsage.STATIC_DRAW,
      indexDatatype: IndexDatatype.UNSIGNED_SHORT,
    });

    // 位置属性（divisor 0；位置全由 gl_InstanceID 推出，无逐实例属性）。
    const positionAttr = {
      index: ATTRIBUTE_LOCATIONS.position,
      vertexBuffer: this.cornerBuffer,
      componentsPerAttribute: 3,
      componentDatatype: ComponentDatatype.FLOAT,
      normalize: false,
      offsetInBytes: 0,
      strideInBytes: 12,
      instanceDivisor: 0,
    };
    this.vaWire = new I.VertexArray({
      context,
      attributes: [{ ...positionAttr }],
      indexBuffer: this.wireIndexBuffer,
    });
    this.vaTri = new I.VertexArray({
      context,
      attributes: [{ ...positionAttr }],
      indexBuffer: this.triIndexBuffer,
    });

    this.staticBuilt = true;
  }

  /**
   * 构建双调色板纹理（256×1 RGBA8，NEAREST/CLAMP）。
   *
   * @param context Cesium 渲染上下文
   */
  private buildPalettes(context: CesiumContext): void {
    const I = CesiumInternals;
    const sampler = new I.Sampler({
      minificationFilter: I.TextureMinificationFilter.NEAREST,
      magnificationFilter: I.TextureMagnificationFilter.NEAREST,
      wrapS: I.TextureWrap.CLAMP_TO_EDGE,
      wrapT: I.TextureWrap.CLAMP_TO_EDGE,
    });
    this.paletteWireTex = new I.Texture({
      context,
      width: 256,
      height: 1,
      pixelFormat: I.PixelFormat.RGBA,
      pixelDatatype: I.PixelDatatype.UNSIGNED_BYTE,
      flipY: false,
      source: { arrayBufferView: this.state.getPalette('wire') },
      sampler,
    });
    this.paletteFillTex = new I.Texture({
      context,
      width: 256,
      height: 1,
      pixelFormat: I.PixelFormat.RGBA,
      pixelDatatype: I.PixelDatatype.UNSIGNED_BYTE,
      flipY: false,
      source: { arrayBufferView: this.state.getPalette('fill') },
      sampler,
    });
    this.palettesBuilt = true;
  }

  /**
   * 重建状态纹理（尺寸变化时）：销毁旧纹理，按当前 texW/texH 与最新数据创建。
   *
   * @param context Cesium 渲染上下文
   */
  private rebuildStateTexture(context: CesiumContext): void {
    const I = CesiumInternals;
    if (this.stateTexture && !this.stateTexture.isDestroyed()) {
      this.stateTexture.destroy();
      this.stateTexture = undefined;
    }
    const sampler = new I.Sampler({
      minificationFilter: I.TextureMinificationFilter.NEAREST,
      magnificationFilter: I.TextureMagnificationFilter.NEAREST,
      wrapS: I.TextureWrap.CLAMP_TO_EDGE,
      wrapT: I.TextureWrap.CLAMP_TO_EDGE,
    });
    this.stateTexture = new I.Texture({
      context,
      width: this.texW,
      height: this.texH,
      pixelFormat: I.PixelFormat.RGBA,
      pixelDatatype: I.PixelDatatype.UNSIGNED_BYTE,
      flipY: false,
      source: { arrayBufferView: this.state.getTexDataView() },
      sampler,
    });
  }

  /** 整幅重传状态纹理（尺寸不变、数据变化时）。 */
  private uploadStateTexture(): void {
    if (!this.stateTexture) return;
    this.stateTexture.copyFrom({
      source: {
        arrayBufferView: this.state.getTexDataView(),
        width: this.texW,
        height: this.texH,
      },
      xOffset: 0,
      yOffset: 0,
    });
  }

  /**
   * 构建渲染与拾取的 ShaderProgram / RenderState / DrawCommand（建一次，之后仅改可变字段）。
   *
   * @param context Cesium 渲染上下文
   */
  private buildCommands(context: CesiumContext): void {
    const I = CesiumInternals;

    // ShaderProgram（缓存）。
    if (!this.renderSp) {
      this.renderSp = I.ShaderProgram.fromCache({
        context,
        vertexShaderSource: RENDER_VERTEX_SHADER,
        fragmentShaderSource: RENDER_FRAGMENT_SHADER,
        attributeLocations: { ...ATTRIBUTE_LOCATIONS },
      });
    }
    if (!this.pickSp) {
      this.pickSp = I.ShaderProgram.fromCache({
        context,
        vertexShaderSource: PICK_VERTEX_SHADER,
        fragmentShaderSource: PICK_FRAGMENT_SHADER,
        attributeLocations: { ...ATTRIBUTE_LOCATIONS },
      });
    }

    // 预乘 over 混合（src=ONE, dst=ONE_MINUS_SRC_ALPHA）。
    const premultipliedBlend = {
      enabled: true,
      equationRgb: WebGLConstants.FUNC_ADD,
      equationAlpha: WebGLConstants.FUNC_ADD,
      functionSourceRgb: WebGLConstants.ONE,
      functionDestinationRgb: WebGLConstants.ONE_MINUS_SRC_ALPHA,
      functionSourceAlpha: WebGLConstants.ONE,
      functionDestinationAlpha: WebGLConstants.ONE_MINUS_SRC_ALPHA,
    };

    // 线框渲染态：不剔除（线无正反面）、深度测试开、深度写关、半透混合。
    if (!this.rsLine) {
      this.rsLine = I.RenderState.fromCache({
        cull: { enabled: false },
        depthTest: { enabled: true },
        depthMask: false,
        blending: premultipliedBlend,
      });
    }
    // 填充渲染态：背面剔除、深度测试开、深度写关、半透混合。
    if (!this.rsTri) {
      this.rsTri = I.RenderState.fromCache({
        cull: { enabled: true, face: WebGLConstants.BACK },
        depthTest: { enabled: true },
        depthMask: false,
        blending: premultipliedBlend,
      });
    }
    // 拾取渲染态：背面剔除、深度测试 + 深度写（取最前格）、不混合。
    if (!this.rsPick) {
      this.rsPick = I.RenderState.fromCache({
        cull: { enabled: true, face: WebGLConstants.BACK },
        depthTest: { enabled: true },
        depthMask: true,
        blending: { enabled: false },
      });
    }

    // 渲染命令的 uniformMap（int/float/sampler 均由 Cesium 按 GLSL 类型上传）。
    const renderUniformMap: Record<string, () => unknown> = {
      u_nx: () => this.nx,
      u_ny: () => this.ny,
      u_dimX: () => this.dimX,
      u_dimY: () => this.dimY,
      u_dimZ: () => this.dimZ,
      u_texW: () => this.texW,
      u_texH: () => this.texH,
      u_stateTex: () => this.stateTexture,
      u_palette: () => (this.mode === 'wire' ? this.paletteWireTex : this.paletteFillTex),
      // 线框恒为 1；填充用可调不透明度。
      u_opacity: () => (this.mode === 'wire' ? 1.0 : this.fillOpacity),
    };

    if (!this.renderCommand) {
      this.renderCommand = new I.DrawCommand({
        vertexArray: this.vaWire,
        shaderProgram: this.renderSp,
        renderState: this.rsLine,
        primitiveType: PrimitiveType.LINES,
        pass: I.Pass.TRANSLUCENT,
        modelMatrix: this.modelMatrix,
        boundingVolume: this.boundingSphere,
        owner: this,
        cull: true,
        instanceCount: this.instanceCount,
        count: WIRE_INDEX_COUNT,
        uniformMap: renderUniformMap,
      });
    }

    // 拾取命令 uniformMap（仅位置反解 + 自算 u_mvp）。
    const pickUniformMap: Record<string, () => unknown> = {
      u_nx: () => this.nx,
      u_ny: () => this.ny,
      u_dimX: () => this.dimX,
      u_dimY: () => this.dimY,
      u_dimZ: () => this.dimZ,
      u_mvp: () => this.pickMvp,
    };

    if (!this.pickCommand) {
      this.pickCommand = new I.DrawCommand({
        vertexArray: this.vaTri,
        shaderProgram: this.pickSp,
        renderState: this.rsPick,
        primitiveType: PrimitiveType.TRIANGLES,
        pass: I.Pass.OPAQUE,
        modelMatrix: this.modelMatrix,
        boundingVolume: this.boundingSphere,
        owner: this,
        cull: false, // 拾取离屏手动 execute，不走视锥裁剪
        instanceCount: this.instanceCount,
        count: TRI_INDEX_COUNT,
        uniformMap: pickUniformMap,
      });
    }
  }

  /** 是否已销毁（Cesium primitives 集合协议）。 */
  public isDestroyed(): boolean {
    return this.destroyed;
  }

  /** 释放全部 GPU 资源（buffer / VA / shaderProgram / 纹理 / 拾取器）。 */
  public destroy(): boolean {
    if (this.destroyed) return true;

    if (this.vaWire && !this.vaWire.isDestroyed()) this.vaWire.destroy();
    if (this.vaTri && !this.vaTri.isDestroyed()) this.vaTri.destroy();
    if (this.cornerBuffer && !this.cornerBuffer.isDestroyed()) this.cornerBuffer.destroy();
    if (this.wireIndexBuffer && !this.wireIndexBuffer.isDestroyed()) this.wireIndexBuffer.destroy();
    if (this.triIndexBuffer && !this.triIndexBuffer.isDestroyed()) this.triIndexBuffer.destroy();
    if (this.stateTexture && !this.stateTexture.isDestroyed()) this.stateTexture.destroy();
    if (this.paletteWireTex && !this.paletteWireTex.isDestroyed()) this.paletteWireTex.destroy();
    if (this.paletteFillTex && !this.paletteFillTex.isDestroyed()) this.paletteFillTex.destroy();
    if (this.renderSp && !this.renderSp.isDestroyed()) this.renderSp.destroy();
    if (this.pickSp && !this.pickSp.isDestroyed()) this.pickSp.destroy();
    this.picker.destroy();

    this.vaWire = undefined;
    this.vaTri = undefined;
    this.cornerBuffer = undefined;
    this.wireIndexBuffer = undefined;
    this.triIndexBuffer = undefined;
    this.stateTexture = undefined;
    this.paletteWireTex = undefined;
    this.paletteFillTex = undefined;
    this.renderSp = undefined;
    this.pickSp = undefined;
    this.renderCommand = undefined;
    this.pickCommand = undefined;
    this.rsLine = undefined;
    this.rsTri = undefined;
    this.rsPick = undefined;

    this.destroyed = true;
    return true;
  }
}
