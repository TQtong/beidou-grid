import { Math as CesiumMath } from 'cesium'
/**
 * 自封装三维坐标点，包含经度、纬度和高度属性
 * 经度范围：-180到180度
 * 纬度范围：-90到90度
 */

export default class BeiDouGeoPoint {
  /**
   * 经度，有效范围：-180到180度
   */
  private longitude: number = 0

  /**
   * 纬度，有效范围：-90到90度
   */
  private latitude: number = 0

  /**
   * 大地高，单位：米
   */
  private height: number = 0

  constructor(longitude: number, latitude: number, height: number) {
    this.longitude = longitude
    this.latitude = latitude
    this.height = height
  }

  public getLongitude() {
    return this.longitude
  }
  public getLatitude() {
    return this.latitude
  }
  public getHeight() {
    return this.height
  }
  public setHeight(height: number) {
    this.height = height
  }

  /**
   * 验证经纬度是否在有效范围内
   * @return 是否有效
   */
  public isValid() {
    return (
      this.longitude >= -180 &&
      this.longitude <= 180 &&
      this.latitude >= -90 &&
      this.latitude <= 90
    )
  }

  /**
   * 计算与另一点的距离（使用Haversine公式）
   * @param other 另一个地理点
   * @return 距离，单位：米
   */
  public distanceTo(other: BeiDouGeoPoint) {
    const R = 6371000 // 地球半径，单位：米

    const lat1 = CesiumMath.toRadians(this.latitude)
    const lat2 = CesiumMath.toRadians(other.latitude)
    const lon1 = CesiumMath.toRadians(this.longitude)
    const lon2 = CesiumMath.toRadians(other.longitude)

    const dLat = lat2 - lat1
    const dLon = lon2 - lon1

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

    let distance = R * c

    // 考虑高度差
    if (this.height != 0 || other.height != 0) {
      const heightDiff = this.height - other.height
      distance = Math.sqrt(distance * distance + heightDiff * heightDiff)
    }

    return distance
  }

  /**
   * 格式化输出经纬度信息
   * @return 格式化的字符串
   */
  public toString() {
    return `GeoPoint(经度={this.longitude}, 纬度={this.latitude}, 高度={this.height})`
  }

  public equals(obj: any) {
    if (obj == null) {
      return false
    }
    if (!(obj instanceof BeiDouGeoPoint)) {
      return false
    }
    const other = obj as BeiDouGeoPoint
    return (
      this.longitude == other.longitude &&
      this.latitude == other.latitude &&
      this.height == other.height
    )
  }
}
