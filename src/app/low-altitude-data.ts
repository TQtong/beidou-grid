export type LowAltitudeScenario =
  | 'logistics'
  | 'emergency'
  | 'inspection'
  | 'urban-governance'
  | 'agriculture'
  | 'tourism'
  | 'uam'
  | 'surveying'

export type MissionStatus = 'planned' | 'running' | 'warning' | 'completed'
export type MissionPriority = 'normal' | 'important' | 'urgent'
export type AircraftType = 'drone' | 'evtol' | 'helicopter'

export interface RoutePoint {
  lon: number
  lat: number
  height: number
}

export interface LowAltitudeMission {
  id: string
  name: string
  scenario: LowAltitudeScenario
  status: MissionStatus
  priority: MissionPriority
  aircraftType: AircraftType
  route: RoutePoint[]
  influenceRadius: number
  progress: number
  operator: string
  payload: string
  etaMinutes: number
}

export interface AirspaceZone {
  id: string
  type: 'corridor' | 'takeoff' | 'landing' | 'no-fly' | 'restricted' | 'emergency'
  name: string
  heightRange: { min: number; max: number }
  scenario?: LowAltitudeScenario
  center: { lon: number; lat: number }
  radiusMeters?: number
  polygon?: Array<{ lon: number; lat: number }>
}

export interface RiskEvent {
  id: string
  type: 'intrusion' | 'conflict' | 'weather' | 'battery' | 'geofence'
  level: 'low' | 'medium' | 'high'
  lon: number
  lat: number
  height: number
  gridCode?: string
  missionId?: string
  title: string
  description: string
}

export interface ScenarioDefinition {
  id: LowAltitudeScenario
  name: string
  shortName: string
  color: string
  summary: string
}

export interface OperationNotice {
  id: string
  time: string
  level: 'info' | 'warning' | 'control'
  title: string
  source: string
}

export interface FlightPlanApproval {
  id: string
  missionId: string
  applicant: string
  routeName: string
  window: string
  status: 'pending' | 'approved' | 'recheck'
  riskScore: number
}

export interface LowAltitudeOperator {
  id: string
  name: string
  type: 'logistics' | 'public' | 'tourism' | 'agriculture' | 'surveying'
  aircraft: number
  pilots: number
  monthlySorties: number
  complianceRate: number
}

export interface AircraftRegistry {
  id: string
  model: string
  type: AircraftType
  owner: string
  status: 'online' | 'standby' | 'maintenance'
  maxAltitude: number
}

export interface LowAltitudeFacility {
  id: string
  name: string
  type: 'takeoff' | 'landing' | 'charging' | 'vertiport' | 'service'
  lon: number
  lat: number
  capacity: number
  available: number
  scenario?: LowAltitudeScenario
}

export interface AreaLoad {
  id: string
  name: string
  load: number
  flights: number
  alerts: number
}

export interface TrendPoint {
  label: string
  sorties: number
  approvals: number
  alerts: number
}

export interface IndustryMetric {
  label: string
  value: string
  delta: string
  tone: 'good' | 'warn' | 'neutral'
}

export const SIMAO_BOUNDARY_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/530802.json'

export const SIMAO_BBOX = {
  west: 100.322563,
  south: 22.441862,
  east: 101.447977,
  north: 23.090605,
} as const

/** 思茅区行政区 bbox 几何中心：用于行政范围描述，不作为低空运行网格锚点。 */
export const SIMAO_DISTRICT_CENTER = { lon: 100.88527, lat: 22.766234 } as const

/** 思茅主城区低空运行核心：网格、默认相机和城市任务以这里为锚点。 */
export const SIMAO_URBAN_CENTER = { lon: 100.982, lat: 22.779 } as const

/** 兼容旧调用名：业务默认中心指向主城区，而不是行政 bbox 中心。 */
export const SIMAO_CENTER = SIMAO_URBAN_CENTER

export const SCENARIOS: ScenarioDefinition[] = [
  {
    id: 'logistics',
    name: '物流配送',
    shortName: '物流',
    color: '#35c4ff',
    summary: '城区即时配送、乡镇末端补给与医疗冷链转运。',
  },
  {
    id: 'emergency',
    name: '应急救援',
    shortName: '救援',
    color: '#ff3b30',
    summary: '山地搜救、灾情侦察、应急物资投送与临时空域保障。',
  },
  {
    id: 'inspection',
    name: '基础设施巡检',
    shortName: '巡检',
    color: '#f7b731',
    summary: '电力、通信、交通与管线设施的低空自动巡检。',
  },
  {
    id: 'urban-governance',
    name: '城市治理巡查',
    shortName: '城管',
    color: '#30d158',
    summary: '城区事件发现、交通疏导、违法占道和人群密度巡查。',
  },
  {
    id: 'agriculture',
    name: '农林植保',
    shortName: '农林',
    color: '#8fd14f',
    summary: '茶园植保、林区火情巡护与病虫害遥感监测。',
  },
  {
    id: 'tourism',
    name: '文旅观光',
    shortName: '文旅',
    color: '#c77dff',
    summary: '景区观光航线、活动保障和游客安全巡查。',
  },
  {
    id: 'uam',
    name: 'eVTOL/城市空中交通',
    shortName: 'UAM',
    color: '#00e5a8',
    summary: '城际/城区空中接驳、应急转运和固定走廊验证。',
  },
  {
    id: 'surveying',
    name: '测绘环保',
    shortName: '测绘',
    color: '#64d2ff',
    summary: '倾斜摄影、生态巡测、河道水质和矿山治理核查。',
  },
]

export const LOW_ALTITUDE_MISSIONS: LowAltitudeMission[] = [
  {
    id: 'logistics-001',
    name: '思茅城区医疗冷链配送',
    scenario: 'logistics',
    status: 'running',
    priority: 'important',
    aircraftType: 'drone',
    route: [
      { lon: 100.936, lat: 22.793, height: 140 },
      { lon: 100.964, lat: 22.782, height: 150 },
      { lon: 101.006, lat: 22.757, height: 150 },
      { lon: 101.043, lat: 22.735, height: 130 },
    ],
    influenceRadius: 280,
    progress: 42,
    operator: '思茅低空物流专班',
    payload: '医疗冷链包裹',
    etaMinutes: 8,
  },
  {
    id: 'emergency-001',
    name: '西北山区搜救物资投送',
    scenario: 'emergency',
    status: 'warning',
    priority: 'urgent',
    aircraftType: 'helicopter',
    route: [
      { lon: 100.768, lat: 22.835, height: 260 },
      { lon: 100.699, lat: 22.893, height: 300 },
      { lon: 100.617, lat: 22.946, height: 320 },
      { lon: 100.556, lat: 22.985, height: 300 },
    ],
    influenceRadius: 520,
    progress: 58,
    operator: '应急救援联合指挥',
    payload: '急救包与通信中继',
    etaMinutes: 14,
  },
  {
    id: 'inspection-001',
    name: '南部输电走廊巡检',
    scenario: 'inspection',
    status: 'planned',
    priority: 'important',
    aircraftType: 'drone',
    route: [
      { lon: 100.438, lat: 22.552, height: 180 },
      { lon: 100.552, lat: 22.588, height: 190 },
      { lon: 100.702, lat: 22.632, height: 200 },
      { lon: 100.858, lat: 22.671, height: 185 },
    ],
    influenceRadius: 220,
    progress: 12,
    operator: '电网巡检中心',
    payload: '红外与可见光吊舱',
    etaMinutes: 37,
  },
  {
    id: 'urban-001',
    name: '思茅主城区治理巡查',
    scenario: 'urban-governance',
    status: 'running',
    priority: 'normal',
    aircraftType: 'drone',
    route: [
      { lon: 100.945, lat: 22.786, height: 120 },
      { lon: 100.982, lat: 22.804, height: 120 },
      { lon: 101.012, lat: 22.778, height: 120 },
      { lon: 100.978, lat: 22.748, height: 120 },
      { lon: 100.945, lat: 22.786, height: 120 },
    ],
    influenceRadius: 180,
    progress: 76,
    operator: '城市运行管理中心',
    payload: '城市治理巡查吊舱',
    etaMinutes: 6,
  },
  {
    id: 'agriculture-001',
    name: '茶园植保网格作业',
    scenario: 'agriculture',
    status: 'planned',
    priority: 'normal',
    aircraftType: 'drone',
    route: [
      { lon: 100.701, lat: 22.716, height: 90 },
      { lon: 100.747, lat: 22.744, height: 90 },
      { lon: 100.793, lat: 22.718, height: 90 },
      { lon: 100.836, lat: 22.748, height: 90 },
    ],
    influenceRadius: 160,
    progress: 5,
    operator: '茶园植保服务队',
    payload: '植保喷洒载荷',
    etaMinutes: 52,
  },
  {
    id: 'tourism-001',
    name: '茶马古道文旅观光保障',
    scenario: 'tourism',
    status: 'completed',
    priority: 'normal',
    aircraftType: 'drone',
    route: [
      { lon: 100.995, lat: 22.693, height: 180 },
      { lon: 101.047, lat: 22.707, height: 210 },
      { lon: 101.091, lat: 22.735, height: 220 },
      { lon: 101.132, lat: 22.764, height: 200 },
    ],
    influenceRadius: 240,
    progress: 100,
    operator: '文旅低空服务站',
    payload: '观光拍摄与安全巡查',
    etaMinutes: 0,
  },
  {
    id: 'uam-001',
    name: '思茅城区 eVTOL 接驳验证',
    scenario: 'uam',
    status: 'planned',
    priority: 'important',
    aircraftType: 'evtol',
    route: [
      { lon: 100.902, lat: 22.782, height: 420 },
      { lon: 101.004, lat: 22.815, height: 450 },
      { lon: 101.118, lat: 22.848, height: 460 },
      { lon: 101.239, lat: 22.872, height: 430 },
    ],
    influenceRadius: 640,
    progress: 18,
    operator: '城市空中交通试验组',
    payload: '双座 eVTOL 验证机',
    etaMinutes: 21,
  },
  {
    id: 'surveying-001',
    name: '南屏河生态测绘巡测',
    scenario: 'surveying',
    status: 'running',
    priority: 'normal',
    aircraftType: 'drone',
    route: [
      { lon: 100.527, lat: 22.802, height: 160 },
      { lon: 100.588, lat: 22.835, height: 160 },
      { lon: 100.651, lat: 22.819, height: 160 },
      { lon: 100.714, lat: 22.848, height: 160 },
      { lon: 100.779, lat: 22.833, height: 160 },
    ],
    influenceRadius: 260,
    progress: 64,
    operator: '生态环境巡测中心',
    payload: '多光谱测绘载荷',
    etaMinutes: 12,
  },
]

export const AIRSPACE_ZONES: AirspaceZone[] = [
  {
    id: 'zone-core-restricted',
    type: 'restricted',
    name: '思茅主城区限高协调区（模拟）',
    heightRange: { min: 0, max: 180 },
    center: { lon: 100.982, lat: 22.779 },
    polygon: [
      { lon: 100.927, lat: 22.814 },
      { lon: 101.028, lat: 22.822 },
      { lon: 101.047, lat: 22.758 },
      { lon: 100.948, lat: 22.733 },
    ],
  },
  {
    id: 'zone-airport-no-fly',
    type: 'no-fly',
    name: '机场净空保护区（模拟）',
    heightRange: { min: 0, max: 600 },
    center: { lon: 100.958, lat: 22.793 },
    radiusMeters: 1800,
  },
  {
    id: 'zone-emergency',
    type: 'emergency',
    name: '应急救援临时空域',
    scenario: 'emergency',
    heightRange: { min: 120, max: 500 },
    center: { lon: 100.606, lat: 22.95 },
    polygon: [
      { lon: 100.523, lat: 22.991 },
      { lon: 100.614, lat: 23.045 },
      { lon: 100.704, lat: 22.964 },
      { lon: 100.628, lat: 22.889 },
    ],
  },
  {
    id: 'zone-uam-corridor',
    type: 'corridor',
    name: 'UAM 高度走廊',
    scenario: 'uam',
    heightRange: { min: 350, max: 500 },
    center: { lon: 101.07, lat: 22.829 },
    polygon: [
      { lon: 100.888, lat: 22.764 },
      { lon: 101.253, lat: 22.853 },
      { lon: 101.226, lat: 22.898 },
      { lon: 100.877, lat: 22.811 },
    ],
  },
  {
    id: 'zone-logistics-takeoff',
    type: 'takeoff',
    name: '城区物流起降点',
    scenario: 'logistics',
    heightRange: { min: 0, max: 160 },
    center: { lon: 100.936, lat: 22.793 },
    radiusMeters: 260,
  },
  {
    id: 'zone-tea-landing',
    type: 'landing',
    name: '茶园作业备降点',
    scenario: 'agriculture',
    heightRange: { min: 0, max: 120 },
    center: { lon: 100.791, lat: 22.721 },
    radiusMeters: 320,
  },
]

export const RISK_EVENTS: RiskEvent[] = [
  {
    id: 'risk-001',
    type: 'conflict',
    level: 'high',
    lon: 100.998,
    lat: 22.776,
    height: 150,
    missionId: 'urban-001',
    title: '航线冲突预警',
    description: '城市巡查航线与物流配送航线在同层网格短时重叠。',
  },
  {
    id: 'risk-002',
    type: 'weather',
    level: 'medium',
    lon: 100.611,
    lat: 22.958,
    height: 300,
    missionId: 'emergency-001',
    title: '山地阵风提醒',
    description: '救援临时空域西侧存在阵风影响，建议保持高度裕度。',
  },
  {
    id: 'risk-003',
    type: 'battery',
    level: 'medium',
    lon: 100.742,
    lat: 22.832,
    height: 160,
    missionId: 'surveying-001',
    title: '续航返航阈值',
    description: '生态巡测任务剩余航程接近返航阈值。',
  },
  {
    id: 'risk-004',
    type: 'geofence',
    level: 'high',
    lon: 100.956,
    lat: 22.792,
    height: 120,
    missionId: 'logistics-001',
    title: '净空保护区接近',
    description: '配送航线靠近机场净空保护区边界，需保持走廊约束。',
  },
]

export const OPERATION_NOTICES: OperationNotice[] = [
  {
    id: 'notice-001',
    time: '09:15',
    level: 'control',
    title: '机场净空保护区 0-600m 临时强化监控',
    source: '空域协同席',
  },
  {
    id: 'notice-002',
    time: '10:20',
    level: 'warning',
    title: '西北山区阵风增强，救援航线建议保持 300m 以上高度',
    source: '气象保障席',
  },
  {
    id: 'notice-003',
    time: '11:05',
    level: 'info',
    title: '茶园植保作业窗口开放至 16:30',
    source: '农业服务站',
  },
  {
    id: 'notice-004',
    time: '13:40',
    level: 'info',
    title: '南屏河生态巡测航线完成 64%',
    source: '生态巡测中心',
  },
]

export const FLIGHT_PLAN_APPROVALS: FlightPlanApproval[] = [
  {
    id: 'approval-001',
    missionId: 'uam-001',
    applicant: '城市空中交通试验组',
    routeName: '思茅城区 eVTOL 接驳验证',
    window: '15:00-15:25',
    status: 'recheck',
    riskScore: 72,
  },
  {
    id: 'approval-002',
    missionId: 'inspection-001',
    applicant: '电网巡检中心',
    routeName: '南部输电走廊巡检',
    window: '14:10-15:00',
    status: 'approved',
    riskScore: 28,
  },
  {
    id: 'approval-003',
    missionId: 'agriculture-001',
    applicant: '茶园植保服务队',
    routeName: '茶园植保网格作业',
    window: '15:40-16:30',
    status: 'pending',
    riskScore: 36,
  },
  {
    id: 'approval-004',
    missionId: 'tourism-001',
    applicant: '文旅低空服务站',
    routeName: '茶马古道观光保障',
    window: '已完成',
    status: 'approved',
    riskScore: 18,
  },
]

export const LOW_ALTITUDE_OPERATORS: LowAltitudeOperator[] = [
  {
    id: 'op-001',
    name: '思茅低空物流专班',
    type: 'logistics',
    aircraft: 18,
    pilots: 26,
    monthlySorties: 642,
    complianceRate: 98.6,
  },
  {
    id: 'op-002',
    name: '应急救援联合指挥',
    type: 'public',
    aircraft: 9,
    pilots: 14,
    monthlySorties: 86,
    complianceRate: 100,
  },
  {
    id: 'op-003',
    name: '茶园植保服务队',
    type: 'agriculture',
    aircraft: 22,
    pilots: 31,
    monthlySorties: 408,
    complianceRate: 96.8,
  },
  {
    id: 'op-004',
    name: '生态环境巡测中心',
    type: 'surveying',
    aircraft: 11,
    pilots: 16,
    monthlySorties: 214,
    complianceRate: 97.9,
  },
  {
    id: 'op-005',
    name: '文旅低空服务站',
    type: 'tourism',
    aircraft: 7,
    pilots: 12,
    monthlySorties: 135,
    complianceRate: 99.1,
  },
]

export const AIRCRAFT_REGISTRY: AircraftRegistry[] = [
  {
    id: 'BD-UAV-1027',
    model: 'M350 RTK',
    type: 'drone',
    owner: '电网巡检中心',
    status: 'standby',
    maxAltitude: 500,
  },
  {
    id: 'BD-UAV-1188',
    model: '冷链配送六旋翼',
    type: 'drone',
    owner: '思茅低空物流专班',
    status: 'online',
    maxAltitude: 300,
  },
  {
    id: 'BD-HL-020',
    model: '救援直升机',
    type: 'helicopter',
    owner: '应急救援联合指挥',
    status: 'online',
    maxAltitude: 900,
  },
  {
    id: 'BD-EV-006',
    model: '双座 eVTOL 验证机',
    type: 'evtol',
    owner: '城市空中交通试验组',
    status: 'standby',
    maxAltitude: 600,
  },
  {
    id: 'BD-UAV-2210',
    model: '多光谱测绘机',
    type: 'drone',
    owner: '生态环境巡测中心',
    status: 'maintenance',
    maxAltitude: 450,
  },
]

export const LOW_ALTITUDE_FACILITIES: LowAltitudeFacility[] = [
  {
    id: 'fac-001',
    name: '思茅低空服务中心',
    type: 'service',
    lon: 100.936,
    lat: 22.793,
    capacity: 18,
    available: 11,
    scenario: 'logistics',
  },
  {
    id: 'fac-002',
    name: '南部茶园起降点',
    type: 'takeoff',
    lon: 100.791,
    lat: 22.721,
    capacity: 10,
    available: 6,
    scenario: 'agriculture',
  },
  {
    id: 'fac-003',
    name: '应急救援前置点',
    type: 'landing',
    lon: 100.606,
    lat: 22.95,
    capacity: 6,
    available: 2,
    scenario: 'emergency',
  },
  {
    id: 'fac-004',
    name: 'UAM 试验垂直起降场',
    type: 'vertiport',
    lon: 101.118,
    lat: 22.848,
    capacity: 4,
    available: 3,
    scenario: 'uam',
  },
  {
    id: 'fac-005',
    name: '生态巡测换电站',
    type: 'charging',
    lon: 100.714,
    lat: 22.848,
    capacity: 12,
    available: 7,
    scenario: 'surveying',
  },
]

export const AREA_LOADS: AreaLoad[] = [
  { id: 'area-001', name: '思茅主城区', load: 82, flights: 57, alerts: 2 },
  { id: 'area-002', name: '南屏镇', load: 61, flights: 34, alerts: 1 },
  { id: 'area-003', name: '倚象镇', load: 48, flights: 22, alerts: 0 },
  { id: 'area-004', name: '云仙乡', load: 39, flights: 18, alerts: 1 },
  { id: 'area-005', name: '思茅港镇', load: 44, flights: 20, alerts: 0 },
]

export const FLIGHT_TRENDS: TrendPoint[] = [
  { label: '06时', sorties: 18, approvals: 12, alerts: 0 },
  { label: '08时', sorties: 42, approvals: 25, alerts: 1 },
  { label: '10时', sorties: 67, approvals: 38, alerts: 2 },
  { label: '12时', sorties: 54, approvals: 31, alerts: 1 },
  { label: '14时', sorties: 78, approvals: 44, alerts: 4 },
  { label: '16时', sorties: 71, approvals: 39, alerts: 2 },
]

export const INDUSTRY_METRICS: IndustryMetric[] = [
  { label: '今日保障架次', value: '387', delta: '+12.4%', tone: 'good' },
  { label: '空域利用率', value: '68%', delta: '+8.1%', tone: 'good' },
  { label: '平均审批耗时', value: '7.6min', delta: '-18%', tone: 'good' },
  { label: '产业服务收入', value: '31.8万', delta: '+9.7%', tone: 'neutral' },
  { label: '临时管控事件', value: '2', delta: '+1', tone: 'warn' },
]

export const approvalStatusLabel = (status: FlightPlanApproval['status']): string => {
  const labels: Record<FlightPlanApproval['status'], string> = {
    pending: '待审批',
    approved: '已放行',
    recheck: '复核',
  }
  return labels[status]
}

export const operatorTypeLabel = (type: LowAltitudeOperator['type']): string => {
  const labels: Record<LowAltitudeOperator['type'], string> = {
    logistics: '物流',
    public: '公共服务',
    tourism: '文旅',
    agriculture: '农林',
    surveying: '测绘环保',
  }
  return labels[type]
}

export const aircraftStatusLabel = (status: AircraftRegistry['status']): string => {
  const labels: Record<AircraftRegistry['status'], string> = {
    online: '在线',
    standby: '待命',
    maintenance: '检修',
  }
  return labels[status]
}

export const facilityTypeLabel = (type: LowAltitudeFacility['type']): string => {
  const labels: Record<LowAltitudeFacility['type'], string> = {
    takeoff: '起飞点',
    landing: '降落点',
    charging: '换电站',
    vertiport: '垂直起降场',
    service: '服务中心',
  }
  return labels[type]
}

export const scenarioById = (id: LowAltitudeScenario): ScenarioDefinition =>
  SCENARIOS.find((item) => item.id === id) ?? SCENARIOS[0]!

export const missionById = (id: string, missions: readonly LowAltitudeMission[] = LOW_ALTITUDE_MISSIONS) =>
  missions.find((mission) => mission.id === id)

export const statusLabel = (status: MissionStatus): string => {
  const labels: Record<MissionStatus, string> = {
    planned: '待飞',
    running: '运行',
    warning: '告警',
    completed: '完成',
  }
  return labels[status]
}

export const priorityLabel = (priority: MissionPriority): string => {
  const labels: Record<MissionPriority, string> = {
    normal: '常规',
    important: '重点',
    urgent: '紧急',
  }
  return labels[priority]
}

export const aircraftLabel = (type: AircraftType): string => {
  const labels: Record<AircraftType, string> = {
    drone: '无人机',
    evtol: 'eVTOL',
    helicopter: '直升机',
  }
  return labels[type]
}

export const riskLevelLabel = (level: RiskEvent['level']): string => {
  const labels: Record<RiskEvent['level'], string> = {
    low: '低',
    medium: '中',
    high: '高',
  }
  return labels[level]
}

export const interpolateRoute = (route: readonly RoutePoint[], progress: number): RoutePoint => {
  if (route.length === 0) return { lon: SIMAO_CENTER.lon, lat: SIMAO_CENTER.lat, height: 120 }
  if (route.length === 1) return { ...route[0]! }

  const clamped = Math.min(100, Math.max(0, progress))
  const scaled = (clamped / 100) * (route.length - 1)
  const index = Math.min(route.length - 2, Math.floor(scaled))
  const localT = scaled - index
  const a = route[index]!
  const b = route[index + 1]!
  return {
    lon: a.lon + (b.lon - a.lon) * localT,
    lat: a.lat + (b.lat - a.lat) * localT,
    height: a.height + (b.height - a.height) * localT,
  }
}

export const sampleRoute = (route: readonly RoutePoint[], pointsPerSegment = 4): RoutePoint[] => {
  if (route.length <= 1) return [...route]
  const samples: RoutePoint[] = []
  const totalSegments = route.length - 1
  for (let segment = 0; segment < totalSegments; segment++) {
    const a = route[segment]!
    const b = route[segment + 1]!
    for (let k = 0; k < pointsPerSegment; k++) {
      const t = k / pointsPerSegment
      samples.push({
        lon: a.lon + (b.lon - a.lon) * t,
        lat: a.lat + (b.lat - a.lat) * t,
        height: a.height + (b.height - a.height) * t,
      })
    }
  }
  samples.push({ ...route[route.length - 1]! })
  return samples
}

export const scenarioForRisk = (
  event: RiskEvent,
  missions: readonly LowAltitudeMission[] = LOW_ALTITUDE_MISSIONS,
): LowAltitudeScenario | undefined => {
  if (!event.missionId) return undefined
  return missionById(event.missionId, missions)?.scenario
}
