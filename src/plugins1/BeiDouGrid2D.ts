import type BeiDouGeoPoint from "./BeiDouGeoPoint";
import BeiDouGridConstants from "./BeiDouGridConstants";
import BeiDouGridUtils from "./BeiDouGridUtils";

export default class BeiDouGrid2D {
    /**
     * 网格等级
     */
    protected level:number = 0;
    /**
     * 网格最小经度
     */
    protected minLongitude:number = 0;
    /**
     * 网格最大经度
     */
    protected maxLongitude:number = 0;
    /**
     * 网格最小纬度
     */
    protected minLatitude:number = 0;
    /**
     * 网格最大纬度
     */
    protected maxLatitude:number = 0;
    /**
     * 网格编码
     */
    protected code:string = "" ;

     constructor(level:number, point:BeiDouGeoPoint) {
        this.level = level;

        this.minLongitude = point.getLongitude();
        this.maxLongitude = point.getLongitude() + BeiDouGridConstants.GRID_SIZES_DEGREES[level as keyof typeof BeiDouGridConstants.GRID_SIZES_DEGREES][0]!.toNumber();

        this.minLatitude = point.getLatitude();
        this.maxLatitude = point.getLatitude() + BeiDouGridConstants.GRID_SIZES_DEGREES[level as keyof typeof BeiDouGridConstants.GRID_SIZES_DEGREES][1]!.toNumber();

        this.code = BeiDouGridUtils.encode2D(point, level);
    }

    public equals(obj:any) {
        if (obj == null){
            return false;
        }
        if (!(obj instanceof BeiDouGrid2D)){
            return false;
      }
      const other = obj as BeiDouGrid2D;
        if (this.level != other.level){
            return false;
        }
        if (this.code != null && other.code != null){
            return this.code === other.code;
        }
        return this.minLongitude == other.minLongitude &&
                this.maxLongitude == other.maxLongitude &&
                this.minLatitude == other.minLatitude &&
                this.maxLatitude == other.maxLatitude;
    }

}
