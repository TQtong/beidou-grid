// ============================================================
// GridLabelPrimitive.ts — 北斗网格码标注（LabelCollection，封顶）
// 层级：L3（渲染 Primitive 控制器）
// 职责：在可视网格上抽样显示网格码，硬封顶 maxLabels，优先靠近屏幕中心的格。
//       用 Cesium.LabelCollection 批渲染（非 Entity）。
// 依赖：cesium（LabelCollection/Label/Cartesian3/Color/HorizontalOrigin/VerticalOrigin/
//       LabelStyle/NearFarScalar/Math）、render-constants、geo-bridge、GridTessellator。
// 被消费：BeiDouGridScene。
// 性能：抽样步长 = ceil(sqrt(nx·ny / maxLabels))，保证标注数 ≤ maxLabels，O(标注数)。
// ============================================================

import {
  Cartesian3,
  Color,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  Math as CesiumMath,
  NearFarScalar,
  VerticalOrigin,
  type PrimitiveCollection,
} from 'cesium';

import { pointToCode2D, pointToCode3D } from '../geo-bridge';
import type { Tessellation } from '../grid/GridTessellator';

/** 标注外观/行为参数。 */
export interface GridLabelOptions {
  /** 标注数量上限。 */
  maxLabels: number;
  /** 是否用三维码（含高度）；false 用二维码。 */
  use3D: boolean;
  /** 标注用的高度层索引（use3D 时取该层中心高度；默认 0）。 */
  zPlaneIndex?: number;
  /** 文本颜色。 */
  fillColor?: Color;
  /** 文本字体（CSS font）。 */
  font?: string;
  /** 远近缩放（近大远小，防远处文字糊成一片）。 */
  scaleByDistance?: NearFarScalar;
}

export default class GridLabelPrimitive {
  private readonly primitives: PrimitiveCollection;
  private readonly collection: LabelCollection;
  private destroyed = false;

  /**
   * @param primitives 宿主 scene.primitives。
   */
  public constructor(primitives: PrimitiveCollection) {
    this.primitives = primitives;
    this.collection = new LabelCollection();
    this.primitives.add(this.collection);
  }

  /**
   * 用新剖分重建标注（抽样 + 封顶）。
   *
   * 抽样步长 stride = max(1, ceil(sqrt(nx·ny / maxLabels)))：使抽样格数 ≈ maxLabels；
   * 遍历 (i,j) 仅取 i%stride==0 && j%stride==0 的格中心；累计到 maxLabels 即停。
   * 每个格中心调 pointToCode2D/3D 得码作为文本。
   *
   * @param t   剖分结果
   * @param opt 标注参数
   */
  public rebuild(t: Tessellation, opt: GridLabelOptions): void {
    if (this.destroyed) return;

    this.collection.removeAll();

    const maxLabels = Math.max(0, opt.maxLabels);
    if (maxLabels === 0) return;

    const totalCells = t.nx * t.ny;
    const stride = Math.max(1, Math.ceil(Math.sqrt(totalCells / maxLabels)));

    const zi = CesiumMath.clamp(opt.zPlaneIndex ?? 0, 0, t.zPlaneFloors.length - 1);
    const layerFloor = t.zPlaneFloors[zi]!;
    const labelHeight = opt.use3D ? layerFloor + t.heightStep / 2 : 0;

    const fillColor = opt.fillColor ?? Color.WHITE;
    const font = opt.font ?? '12px sans-serif';
    const scaleByDistance = opt.scaleByDistance ?? new NearFarScalar(1.0e3, 1.0, 5.0e6, 0.4);

    let count = 0;
    for (let j = 0; j < t.ny && count < maxLabels; j += stride) {
      // 格中心纬度。
      const latDeg = t.originLatDeg + (j + 0.5) * t.stepLatDeg;
      for (let i = 0; i < t.nx && count < maxLabels; i += stride) {
        const lonDeg = t.originLonDeg + (i + 0.5) * t.stepLonDeg;

        // 生成码（极区守卫在 geo-bridge 内）。
        const text = opt.use3D
          ? pointToCode3D(lonDeg, latDeg, labelHeight, t.level)
          : pointToCode2D(lonDeg, latDeg, t.level);

        this.collection.add({
          position: Cartesian3.fromDegrees(lonDeg, latDeg, labelHeight),
          text,
          font,
          fillColor,
          style: LabelStyle.FILL_AND_OUTLINE,
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          horizontalOrigin: HorizontalOrigin.CENTER,
          verticalOrigin: VerticalOrigin.CENTER,
          scaleByDistance,
        });
        count++;
      }
    }
  }

  /** 显示/隐藏。 */
  public setVisible(visible: boolean): void {
    this.collection.show = visible;
  }

  /** 清空标注（保留 collection 以便复用图集）。 */
  public clear(): void {
    this.collection.removeAll();
  }

  /** 是否已销毁。 */
  public isDestroyed(): boolean {
    return this.destroyed;
  }

  /** 销毁：移除 collection（连带销毁其纹理图集）。 */
  public destroy(): void {
    if (this.destroyed) return;
    this.primitives.remove(this.collection); // remove 会 destroy LabelCollection
    this.destroyed = true;
  }
}
