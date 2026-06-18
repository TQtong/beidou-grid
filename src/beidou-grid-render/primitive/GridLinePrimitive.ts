/**
 * 线格网（主可见层，非瓶颈）。
 *
 * 关键：网格线数 = `(nx+1)+(ny+1)` 量级，而非逐格——百万格也只有数千条线。
 * 用一个 Cesium `Primitive` + `PolylineColorAppearance` 批量绘制底/顶两层格线 + 四角竖边，
 * 既给出三维体积参照，又保持极低的几何构建成本。
 *
 * 本类作为自定义 Primitive 加入 `scene.primitives`：Cesium 每帧调 `update(frameState)`，
 * 内部转发给所持有的 Cesium `Primitive`；移除时 `destroy()`。
 */
import * as Cesium from 'cesium'
import type { Tessellation } from '../grid/GridTessellator'
import type { CesiumFrameState } from './CesiumInternals'

/** 单次重建的格线实例硬上限（极端 nx+ny 时按 stride 抽稀，保证有界）。 */
const MAX_LINE_INSTANCES = 30_000

export default class GridLinePrimitive {
  private primitive?: Cesium.Primitive
  private show = true
  private color: Cesium.Color
  private widthPx: number
  private destroyed = false

  constructor(color: Cesium.Color = Cesium.Color.fromCssColorString('#7c5cff'), widthPx = 1.0) {
    this.color = color
    this.widthPx = widthPx
  }

  public setColor(color: Cesium.Color): void {
    this.color = color
  }

  /** 重建格线几何（底/顶格网 + 四角竖边）。 */
  public rebuild(t: Tessellation): void {
    if (this.destroyed) return
    this.disposePrimitive()

    const planes = Math.max(1, t.zPlaneFloors.length)
    const baseH = t.zPlaneFloors[0] ?? 0
    const topH = baseH + planes * t.heightStep
    const eastLon = t.originLonDeg + t.nx * t.stepLonDeg
    const northLat = t.originLatDeg + t.ny * t.stepLatDeg

    // 抽稀步长：极端情形下 (nx+1)+(ny+1) 过大时按 stride 跳行，保证实例数有界。
    const linesPerLattice = t.nx + 1 + (t.ny + 1)
    const stride = Math.max(1, Math.ceil((linesPerLattice * 2) / MAX_LINE_INSTANCES))

    const instances: Cesium.GeometryInstance[] = []
    const colorAttr = Cesium.ColorGeometryInstanceAttribute.fromColor(this.color)
    const addLine = (positions: Cesium.Cartesian3[]): void => {
      instances.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.PolylineGeometry({
            positions,
            width: this.widthPx,
            vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
            arcType: Cesium.ArcType.GEODESIC,
          }),
          attributes: { color: colorAttr },
        }),
      )
    }

    for (const h of [baseH, topH]) {
      // 经向格线（常 lon，跨 lat）。
      for (let ii = 0; ii <= t.nx; ii += stride) {
        const lon = t.originLonDeg + ii * t.stepLonDeg
        addLine(Cesium.Cartesian3.fromDegreesArrayHeights([lon, t.originLatDeg, h, lon, northLat, h]))
      }
      // 纬向格线（常 lat，跨 lon）。
      for (let jj = 0; jj <= t.ny; jj += stride) {
        const lat = t.originLatDeg + jj * t.stepLatDeg
        addLine(Cesium.Cartesian3.fromDegreesArrayHeights([t.originLonDeg, lat, h, eastLon, lat, h]))
      }
    }

    // 四角竖边（底→顶），凸显体积。
    const corners: [number, number][] = [
      [t.originLonDeg, t.originLatDeg],
      [eastLon, t.originLatDeg],
      [eastLon, northLat],
      [t.originLonDeg, northLat],
    ]
    for (const [lon, lat] of corners) {
      addLine(Cesium.Cartesian3.fromDegreesArrayHeights([lon, lat, baseH, lon, lat, topH]))
    }

    this.primitive = new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
      asynchronous: false,
      show: this.show,
    })
  }

  public update(frameState: CesiumFrameState): void {
    if (this.destroyed || !this.show || !this.primitive) return
    this.primitive.show = this.show
    // 转发给内部 Cesium Primitive（其 update 会把自身命令推入 commandList）。
    ;(this.primitive as unknown as { update(fs: CesiumFrameState): void }).update(frameState)
  }

  public setVisible(visible: boolean): void {
    this.show = visible
    if (this.primitive) this.primitive.show = visible
  }

  /** 线层不参与不透明度联动（保留接口一致性）。 */
  public setOpacity(_opacity: number): void {
    void _opacity
  }

  public isDestroyed(): boolean {
    return this.destroyed
  }

  public destroy(): boolean {
    if (this.destroyed) return true
    this.disposePrimitive()
    this.destroyed = true
    return true
  }

  private disposePrimitive(): void {
    if (this.primitive && !this.primitive.isDestroyed()) this.primitive.destroy()
    this.primitive = undefined
  }
}
