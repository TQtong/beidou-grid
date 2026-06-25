// ============================================================
// InstancePicker.ts — GPU 实例拾取（离屏 Framebuffer + 单像素回读）
// 层级：L1（渲染核心，封装一处离屏拾取目标）
// 职责：维护一张与 drawingBuffer 同尺寸的离屏 RGBA8 颜色目标 + 深度 renderbuffer；
//       提供「清屏 → 执行拾取 DrawCommand → 回读目标像素 → 解码实例号」的一步式接口。
// 说明：拾取在 GridCubeField.update(frameState) 内调用——此刻有合法 context 与
//       当前相机矩阵；拾取 VS 用 CPU 自算的 u_mvp 投影，故不依赖 czm 自动矩阵。
// 依赖：cesium-internals（Framebuffer/Renderbuffer/Texture/Sampler/PassState/
//       ClearCommand/Context 等结构化句柄）、cesium（BoundingRectangle/Color 公开）。
// 被消费：GridCubeField。
// ============================================================

import { BoundingRectangle, Color } from 'cesium';

import {
  CesiumInternals,
  type CesiumContext,
  type CesiumDrawCommand,
  type CesiumFramebuffer,
  type CesiumRenderbuffer,
  type CesiumTexture,
} from './cesium-internals';

export default class InstancePicker {
  /** 离屏颜色目标（RGBA8，与 drawingBuffer 同尺寸）。 */
  private colorTexture: CesiumTexture | undefined;
  /** 离屏深度目标（DEPTH_COMPONENT16）。 */
  private depthRenderbuffer: CesiumRenderbuffer | undefined;
  /** 离屏帧缓冲（颜色 + 深度）。 */
  private framebuffer: CesiumFramebuffer | undefined;
  /** 自带 framebuffer/viewport 的 PassState（手动 execute 用）。 */
  private passState: { framebuffer: CesiumFramebuffer | undefined; viewport: unknown } | undefined;
  /** 清屏命令（清成透明黑 + 深度 1.0）。 */
  private clearCommand: { execute(context: unknown, passState: unknown): void; framebuffer?: CesiumFramebuffer } | undefined;

  /** 当前离屏目标尺寸（用于尺寸变化时重建）。 */
  private bufferWidth = 0;
  private bufferHeight = 0;

  /** 单像素回读复用的视口矩形。 */
  private readonly viewportRect = new BoundingRectangle(0, 0, 1, 1);

  private destroyed = false;

  /**
   * 确保离屏目标存在且尺寸匹配当前 drawingBuffer，必要时重建。
   *
   * @param context Cesium 渲染上下文
   */
  private ensureTargets(context: CesiumContext): void {
    const w = context.drawingBufferWidth;
    const h = context.drawingBufferHeight;
    if (w <= 0 || h <= 0) return;
    if (this.framebuffer && this.bufferWidth === w && this.bufferHeight === h) return;

    // 尺寸变化：销毁旧目标后重建。
    this.destroyTargets();

    const I = CesiumInternals;

    // 最近邻、夹边采样器（拾取颜色不需要过滤）。
    const sampler = new I.Sampler({
      minificationFilter: I.TextureMinificationFilter.NEAREST,
      magnificationFilter: I.TextureMagnificationFilter.NEAREST,
      wrapS: I.TextureWrap.CLAMP_TO_EDGE,
      wrapT: I.TextureWrap.CLAMP_TO_EDGE,
    });

    this.colorTexture = new I.Texture({
      context,
      width: w,
      height: h,
      pixelFormat: I.PixelFormat.RGBA,
      pixelDatatype: I.PixelDatatype.UNSIGNED_BYTE,
      flipY: false,
      sampler,
    });

    this.depthRenderbuffer = new I.Renderbuffer({
      context,
      format: I.RenderbufferFormat.DEPTH_COMPONENT16,
      width: w,
      height: h,
    });

    this.framebuffer = new I.Framebuffer({
      context,
      colorTextures: [this.colorTexture],
      depthRenderbuffer: this.depthRenderbuffer,
      // 自管附件销毁（尺寸变化/最终销毁时统一释放）。
      destroyAttachments: false,
    });

    // PassState 绑定离屏 framebuffer + 全屏视口。
    const passState = new I.PassState(context) as {
      framebuffer: CesiumFramebuffer | undefined;
      viewport: unknown;
    };
    passState.framebuffer = this.framebuffer;
    this.viewportRect.x = 0;
    this.viewportRect.y = 0;
    this.viewportRect.width = w;
    this.viewportRect.height = h;
    passState.viewport = this.viewportRect;
    this.passState = passState;

    // 清屏命令：透明黑（id=0 → 背景）+ 深度 1.0。
    this.clearCommand = new I.ClearCommand({
      color: new Color(0.0, 0.0, 0.0, 0.0),
      depth: 1.0,
      framebuffer: this.framebuffer,
    });

    this.bufferWidth = w;
    this.bufferHeight = h;
  }

  /**
   * 执行一次拾取：离屏清屏 → 执行拾取命令 → 回读 (glX,glY) 像素 → 解码实例号。
   *
   * 坐标系：传入的 glX/glY 必须是「GL 像素坐标」（已乘 pixelRatio、且 Y 已翻转为
   * 左下原点）；换算由调用方（GridCubeField）完成。
   *
   * @param context     Cesium 渲染上下文
   * @param pickCommand 拾取 DrawCommand（共享场的 VA/着色器，输出编码色）
   * @param glX         GL 像素 X（左下原点）
   * @param glY         GL 像素 Y（左下原点）
   * @returns           被点中的实例号（≥0）；点到背景或越界返回 -1
   */
  public pick(context: CesiumContext, pickCommand: CesiumDrawCommand, glX: number, glY: number): number {
    if (this.destroyed) return -1;
    this.ensureTargets(context);
    if (!this.framebuffer || !this.passState || !this.clearCommand) return -1;

    const w = this.bufferWidth;
    const h = this.bufferHeight;
    if (glX < 0 || glY < 0 || glX >= w || glY >= h) return -1;

    // 离屏清屏（颜色 + 深度）。
    this.clearCommand.framebuffer = this.framebuffer;
    this.clearCommand.execute(context, this.passState);

    // 执行拾取命令（实心三角，深度测试 + 深度写，取最前格）。
    pickCommand.execute(context, this.passState);

    // 回读单像素（RGBA8）。
    const pixels = context.readPixels({
      x: Math.floor(glX),
      y: Math.floor(glY),
      width: 1,
      height: 1,
      framebuffer: this.framebuffer,
    });

    // 解码：idp = r | g<<8 | b<<16；实例号 = idp − 1（idp=0 为背景）。
    const r = pixels[0] ?? 0;
    const g = pixels[1] ?? 0;
    const b = pixels[2] ?? 0;
    const idp = r | (g << 8) | (b << 16);
    return idp === 0 ? -1 : idp - 1;
  }

  /** 销毁离屏附件（尺寸变化或最终销毁时）。 */
  private destroyTargets(): void {
    if (this.framebuffer && !this.framebuffer.isDestroyed()) this.framebuffer.destroy();
    if (this.colorTexture && !this.colorTexture.isDestroyed()) this.colorTexture.destroy();
    if (this.depthRenderbuffer && !this.depthRenderbuffer.isDestroyed()) this.depthRenderbuffer.destroy();
    this.framebuffer = undefined;
    this.colorTexture = undefined;
    this.depthRenderbuffer = undefined;
    this.passState = undefined;
    this.clearCommand = undefined;
    this.bufferWidth = 0;
    this.bufferHeight = 0;
  }

  /** 是否已销毁。 */
  public isDestroyed(): boolean {
    return this.destroyed;
  }

  /** 释放全部离屏 GPU 资源。 */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyTargets();
    this.destroyed = true;
  }
}
