/**
 * 标注层：在格中心标注北斗网格码，数量封顶 `maxLabels`（超出则按 stride 均匀抽样）。
 *
 * 包装 Cesium `LabelCollection`，作为自定义 Primitive 加入 `scene.primitives` 并转发 `update`。
 * 出码经 `geo-bridge` 调用北斗编解码领域层（本层不改其实现）。
 */
import * as Cesium from 'cesium'
import type { Tessellation } from '../grid/GridTessellator'
import { pointToCode2D, pointToCode3D } from '../geo-bridge'
import type { CesiumFrameState } from './CesiumInternals'

export default class GridLabelPrimitive {
  private labels: Cesium.LabelCollection
  private show = true
  private destroyed = false

  constructor(scene: Cesium.Scene) {
    this.labels = new Cesium.LabelCollection({ scene })
  }

  /**
   * 重建标注（仅标注底层 zi=0，均匀抽样到 maxLabels）。
   * @param use3D true → 三维码（含高度），false → 二维码。
   */
  public rebuild(t: Tessellation, maxLabels: number, use3D: boolean): void {
    if (this.destroyed) return
    this.labels.removeAll()

    const cellsPerPlane = t.nx * t.ny
    if (cellsPerPlane === 0 || maxLabels <= 0) return
    const stride = Math.max(1, Math.ceil(cellsPerPlane / maxLabels))
    const baseH = t.zPlaneFloors[0] ?? 0
    const labelH = baseH + t.heightStep * 0.5

    let count = 0
    for (let cell = 0; cell < cellsPerPlane && count < maxLabels; cell += stride) {
      const i = cell % t.nx
      const j = Math.floor(cell / t.nx)
      const lon = t.originLonDeg + (i + 0.5) * t.stepLonDeg
      const lat = t.originLatDeg + (j + 0.5) * t.stepLatDeg
      const code = use3D
        ? pointToCode3D(lon, lat, labelH, t.level)
        : pointToCode2D(lon, lat, t.level)
      if (!code) continue
      this.labels.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat, labelH),
        text: code,
        font: '12px monospace',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: new Cesium.Color(0, 0, 0, 0.6),
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(1.0e3, 1.0, 5.0e6, 0.4),
      })
      count++
    }
  }

  public update(frameState: CesiumFrameState): void {
    if (this.destroyed || !this.show) return
    ;(this.labels as unknown as { update(fs: CesiumFrameState): void }).update(frameState)
  }

  public setVisible(visible: boolean): void {
    this.show = visible
    this.labels.show = visible
  }

  public isDestroyed(): boolean {
    return this.destroyed
  }

  public destroy(): boolean {
    if (this.destroyed) return true
    if (!this.labels.isDestroyed()) this.labels.destroy()
    this.destroyed = true
    return true
  }
}
