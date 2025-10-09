import { Decimal } from 'decimal.js'

/**
 * 北斗网格码常量定义类
 * 集中管理所有网格相关的常量
 */
export default class BeiDouGridConstants {

    /**
     * 网格尺寸数组[层级][0:经度度数, 1:纬度度数]
     * 根据标准5.1条网格划分规则定义
     */
    public static GRID_SIZES_DEGREES = {
            0: [] as Decimal[], // 第0级占位
            1: [BeiDouGridConstants.bd(6), BeiDouGridConstants.bd(4)], // 1级：6°×4°
            2: [BeiDouGridConstants.bd(0.5), BeiDouGridConstants.bd(0.5)], // 2级：30′×30′
            3: [BeiDouGridConstants.bd(0.25), BeiDouGridConstants.bd(10).div(BeiDouGridConstants.bd(60))], // 3级：15′×10′
            4: [BeiDouGridConstants.bd(1).div(BeiDouGridConstants.bd(60)), BeiDouGridConstants.bd(1).div(BeiDouGridConstants.bd(60))], // 4级：1′×1′
            5: [BeiDouGridConstants.bd(4).div(BeiDouGridConstants.bd(3600)), BeiDouGridConstants.bd(4).div(BeiDouGridConstants.bd(3600))], // 5级：4″×4″
            6: [BeiDouGridConstants.bd(2).div(BeiDouGridConstants.bd(3600)), BeiDouGridConstants.bd(2).div(BeiDouGridConstants.bd(3600))], // 6级：2″×2″
            7: [BeiDouGridConstants.bd(1).div(BeiDouGridConstants.bd(4 * 3600)), BeiDouGridConstants.bd(1).div(BeiDouGridConstants.bd(4 * 3600))], // 7级：1/4″×1/4″
            8: [BeiDouGridConstants.bd(1).div(BeiDouGridConstants.bd(32 * 3600)), BeiDouGridConstants.bd(1).div(BeiDouGridConstants.bd(32 * 3600))], // 8级：1/32″×1/32″
            9: [BeiDouGridConstants.bd(1).div(BeiDouGridConstants.bd(256 * 3600)), BeiDouGridConstants.bd(1).div(BeiDouGridConstants.bd(256 * 3600))], // 9级：1/256″×1/256″
            10: [BeiDouGridConstants.bd(1).div(BeiDouGridConstants.bd(2048 * 3600)), BeiDouGridConstants.bd(1).div(BeiDouGridConstants.bd(2048 * 3600))] // 10级：1/2048″×1/2048″
    };

    /**
     * 各层级网格行列数[经度方向, 纬度方向]
     */
    public static GRID_DIVISIONS = {
            0: [],  // 第0级占位
            1: [60, 22],    // 第1级 (6°=360'/6°)
            2: [12, 8],     // 第2级
            3: [2, 3],      // 第3级
            4: [15, 10],    // 第4级
            5: [15, 15],    // 第5级
            6: [2, 2],      // 第6级
            7: [8, 8],      // 第7级
            8: [8, 8],      // 第8级
            9: [8, 8],      // 第9级
            10: [8, 8]       // 第10级
    };

    /**
     * 网格大小数据（单位：秒）
     */
    public static GRID_SIZES_SECONDS = {
            0: [] as number[],                           // 第0级（占位）
            1: [21600.0, 14400.0],          // 第1级
            2: [1800.0, 1800.0],            // 第2级
            3: [900.0, 600.0],              // 第3级
            4: [60.0, 60.0],                // 第4级
            5: [4.0, 4.0],                  // 第5级
            6: [2.0, 2.0],                  // 第6级
            7: [0.25, 0.25],                // 第7级
            8: [0.03125, 0.03125],          // 第8级
            9: [0.00390625, 0.00390625],    // 第9级
            10: [0.00048828125, 0.00048828125] // 第10级
    };

    /**
     * 各级网格编码长度
     */
    public static CODE_LENGTH_AT_LEVEL = [
            1,  // 0级长度
            4,  // 1级长度
            6,  // 2级长度
            7,  // 3级长度
            9,  // 4级长度
            11, // 5级长度
            12, // 6级长度
            14, // 7级长度
            16, // 8级长度
            18, // 9级长度
            20  // 10级长度
    ];

    /**
     * 赤道周长（单位：米）
     */
    public static EARTH_EQUATOR_CIRCUMFERENCE = 40075000.0;

    /**
     * 地球半径（单位：米）
     */
    public static EARTH_RADIUS = 6378137;

    /**
     * 三维网格长度数据（单位：米）
     * 根据赤道周长和各级网格的角度划分计算得出
     */
    public static GRID_SIZES_3D = BeiDouGridConstants.calculateGridSizes3D();

    /**
     * 各级网格的高度编码位数和基数
     */
    public static ELEVATION_ENCODING = {
            0: [0, 0],    // 0级（占位）
            1: [6, 10],   // 1级：6位，10进制
            3: [3, 8],    // 2级：3位，8进制
            4: [1, 2],    // 3级：1位，2进制
            5: [4, 16],   // 4级：4位，16进制
            6: [4, 16],   // 5级：4位，16进制
            7: [1, 2],    // 6级：1位，2进制
            8: [3, 8],    // 7级：3位，8进制
            9: [3, 8],    // 8级：3位，8进制
            10: [3, 8],    // 9级：3位，8进制
            11: [3, 8]     // 10级：3位，8进制
    };

    /**
     * 32位整数n中各级别编码的位位置（按照GB/T 39409-2020标准附录C）
     * 从低位到高位的位范围：[起始位, 结束位]
     */
      public static HEIGHT_BIT_RANGES = {
            0: [32, 32],   // a0: 第32位
            1: [26, 31],   // a1a2: 第26-31位
            2: [23, 25],   // a3: 第23-25位
            4: [22, 22],   // a4: 第22位
            5: [18, 21],   // a5: 第18-21位
            6: [14, 17],   // a6: 第14-17位
            7: [13, 13],   // a7: 第13位
            8: [10, 12],   // a8: 第10-12位
            9: [7, 9],     // a9: 第7-9位
            10: [4, 6],     // a10: 第4-6位
            11: [1, 3]      // a11: 第1-3位
      };

    /**
     * 创建BigDecimal对象的辅助方法
     * 使用String构造器以避免精度问题
     */
    private static bd(val: number) {
        return new Decimal(val.toString());
    }

    /**
     * 计算各级网格的长度
     * 根据赤道周长和各级网格的角度划分计算
     *
     * @return 各级网格长度数组
     */
    private static calculateGridSizes3D() {
        const sizes = new Array(11);

        // 0级长度为0
        sizes[0] = 0;

        // 第一级网格：4°
        sizes[1] = BeiDouGridConstants.EARTH_EQUATOR_CIRCUMFERENCE / 360.0 * 4.0;

        // 第二级网格：30′
        sizes[2] = BeiDouGridConstants.EARTH_EQUATOR_CIRCUMFERENCE / 360.0 * (30.0 / 60.0);

        // 第三级网格：15′
        sizes[3] = BeiDouGridConstants.EARTH_EQUATOR_CIRCUMFERENCE / 360.0 * (15.0 / 60.0);

        // 第四级网格：1′
        sizes[4] = BeiDouGridConstants.EARTH_EQUATOR_CIRCUMFERENCE / 360.0 * (1.0 / 60.0);

        // 第五级网格：4″
        sizes[5] = BeiDouGridConstants.EARTH_EQUATOR_CIRCUMFERENCE / 360.0 * (4.0 / 3600.0);

        // 第六级网格：2″
        sizes[6] = BeiDouGridConstants.EARTH_EQUATOR_CIRCUMFERENCE / 360.0 * (2.0 / 3600.0);

        // 第七级网格：1/4″
        sizes[7] = BeiDouGridConstants.EARTH_EQUATOR_CIRCUMFERENCE / 360.0 * (0.25 / 3600.0);

        // 第八级网格：1/32″
        sizes[8] = BeiDouGridConstants.EARTH_EQUATOR_CIRCUMFERENCE / 360.0 * (1.0 / 32.0 / 3600.0);

        // 第九级网格：1/256″
        sizes[9] = BeiDouGridConstants.EARTH_EQUATOR_CIRCUMFERENCE / 360.0 * (1.0 / 256.0 / 3600.0);

        // 第十级网格：1/2048″
        sizes[10] = BeiDouGridConstants.EARTH_EQUATOR_CIRCUMFERENCE / 360.0 * (1.0 / 2048.0 / 3600.0);

        return sizes;
    }


}
