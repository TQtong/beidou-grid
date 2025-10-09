import type BeiDouGeoPoint from "./BeiDouGeoPoint";
import BeiDouGrid2D from "./BeiDouGrid2D";
import BeiDouGridConstants from "./BeiDouGridConstants";
import BeiDouGridUtils from "./BeiDouGridUtils";

export default class BeiDouGrid3D extends BeiDouGrid2D{
    /**
     * 网格最小大地高度
     */
    private minHeight:number = 0;

    /**
     * 网格最大大地高度
     */
  private maxHeight: number = 0;
  
  constructor(level:number, point:BeiDouGeoPoint) {
    super(level, point);
    this.minHeight = point.getHeight();
    this.maxHeight = point.getHeight() + BeiDouGridConstants.GRID_SIZES_3D[level]!;

    this.code = BeiDouGridUtils.encode3D(point, level);
  }



    public equals(obj:any) {
        if (obj == null){
            return false;
        }
        if (!(obj instanceof BeiDouGrid3D)){
            return false;
        }
        const other = obj as BeiDouGrid3D;
        if (this.level != other.level){
            return false;
        }
        if (this.code != null && other.code != null){
            return this.code === other.code;
        }
        return this.minLongitude == other.minLongitude &&
                this.maxLongitude == other.maxLongitude &&
                this.minLatitude == other.minLatitude &&
                this.maxLatitude == other.maxLatitude &&
                this.minHeight == other.minHeight &&
                this.maxHeight == other.maxHeight;
    }
}
