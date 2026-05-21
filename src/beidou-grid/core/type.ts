/**
 * 空间关系枚举
 */
export const SpatialRelation = {
  /** 包含 */
  CONTAINS: 0,
  /** 相交 */
  INTERSECTS: 1,
  /** 被包含 */
  WITHIN: 2,
  /** 不相交 */
  DISJOINT: 3
} as const;

export type SpatialRelation = typeof SpatialRelation[keyof typeof SpatialRelation];

/**
 * 经度方向枚举
 */
export const LngDirection = {
  /**
   * 东经
   */
  E: 0,
  /**
   * 西经
   */
  W: 1
} as const;

export type LngDirection = typeof LngDirection[keyof typeof LngDirection];

/**
 * 纬度方向枚举
 */
export const LatDirection = {
  /**
   * 北纬
   */
  N: 0,
  /**
   * 南纬
   */
  S: 1
} as const;

export type LatDirection = typeof LatDirection[keyof typeof LatDirection];