<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import {
  clearActiveMissionInfluence,
  clearGridOverlays,
  clearSelections,
  dispose,
  flyToPoint,
  getActiveLevel,
  init,
  loadBoundary,
  onGridPick,
  setActiveMissionInfluence,
  setBoundaryVisible,
  setFillOpacity,
  setGivenRange,
  setGridOverlays,
  setLevelOverride,
  setMode,
  setOperationOverlays,
  SIMAO_DISTRICT_BOUNDARY_URL,
  SIMAO_OPERATION_CENTER,
  type FieldMode,
  type GridOverlayInput,
  type OperationLayerToggles,
  type PickedGridInfo,
} from './index'
import {
  AIRSPACE_ZONES,
  AIRCRAFT_REGISTRY,
  AREA_LOADS,
  FLIGHT_PLAN_APPROVALS,
  FLIGHT_TRENDS,
  INDUSTRY_METRICS,
  LOW_ALTITUDE_FACILITIES,
  LOW_ALTITUDE_MISSIONS,
  LOW_ALTITUDE_OPERATORS,
  OPERATION_NOTICES,
  RISK_EVENTS,
  SCENARIOS,
  SIMAO_BBOX,
  aircraftLabel,
  aircraftStatusLabel,
  approvalStatusLabel,
  facilityTypeLabel,
  interpolateRoute,
  operatorTypeLabel,
  priorityLabel,
  riskLevelLabel,
  sampleRoute,
  scenarioById,
  scenarioForRisk,
  statusLabel,
  type AirspaceZone,
  type LowAltitudeFacility,
  type LowAltitudeMission,
  type LowAltitudeScenario,
  type RiskEvent,
} from './low-altitude-data'

type ScenarioFilter = 'all' | LowAltitudeScenario
type ModuleId = 'overview' | 'airspace' | 'approval' | 'industry'

const container = useTemplateRef<HTMLDivElement>('container')

const activeScenario = ref<ScenarioFilter>('all')
const activeModule = ref<ModuleId>('overview')
const selectedMissionId = ref<string>(LOW_ALTITUDE_MISSIONS[0]!.id)
const pickedGrid = ref<PickedGridInfo | undefined>(undefined)
const isPlaying = ref<boolean>(true)
const mapReady = ref<boolean>(false)

const renderMode = ref<FieldMode>('wire')
const fillOpacity = ref<number>(58)
const levelMode = ref<number | 'auto'>(5)
const activeLevel = ref<number>(5)
const showBoundary = ref<boolean>(true)
const showGridOverlay = ref<boolean>(true)

const operationToggles = ref<OperationLayerToggles>({
  routes: true,
  zones: true,
  risks: true,
  aircraft: true,
  sites: true,
})

const missionProgress = ref<Record<string, number>>(
  Object.fromEntries(LOW_ALTITUDE_MISSIONS.map((mission) => [mission.id, mission.progress])),
)

const levelOptions = [
  { label: '自动', value: 'auto' as const },
  ...Array.from({ length: 10 }, (_v, i) => ({ label: `L${i + 1}`, value: i + 1 })),
]

const moduleTabs = [
  { id: 'overview' as const, label: '运行态势' },
  { id: 'airspace' as const, label: '空域资源' },
  { id: 'approval' as const, label: '计划审批' },
  { id: 'industry' as const, label: '产业分析' },
]

const moduleLayerPresets = {
  overview: {
    routes: true,
    zones: true,
    risks: true,
    aircraft: true,
    sites: true,
    grid: true,
    mode: 'wire',
    opacity: 58,
  },
  airspace: {
    routes: true,
    zones: true,
    risks: false,
    aircraft: false,
    sites: true,
    grid: true,
    mode: 'fill',
    opacity: 34,
  },
  approval: {
    routes: true,
    zones: true,
    risks: true,
    aircraft: true,
    sites: false,
    grid: true,
    mode: 'wire',
    opacity: 62,
  },
  industry: {
    routes: true,
    zones: false,
    risks: false,
    aircraft: true,
    sites: true,
    grid: false,
    mode: 'wire',
    opacity: 46,
  },
} satisfies Record<ModuleId, OperationLayerToggles & { grid: boolean; mode: FieldMode; opacity: number }>

const moduleProfiles = {
  overview: {
    title: '运行态势总览',
    subtitle: '按低空飞行服务系统席位组织监视、情报、气象、协调与救援联动。',
    badge: '动态监控席',
  },
  airspace: {
    title: '空域资源编排',
    subtitle: '区分管制空域、适飞空域、临时管制空域与低空航路走廊。',
    badge: '航空情报席',
  },
  approval: {
    title: '飞行计划审批',
    subtitle: '围绕任务性质、飞行空域、日期、起降场、机尾号和计划状态闭环校验。',
    badge: '飞行计划席',
  },
  industry: {
    title: '低空产业运行',
    subtitle: '面向航空器、运营服务、场景应用和基础设施统计低空经济运行质量。',
    badge: '产业运营席',
  },
} as const

const activeModuleProfile = computed(() => moduleProfiles[activeModule.value])

const serviceSeats = [
  '飞行计划席',
  '航空情报席',
  '航空气象席',
  '运行协调席',
  '协助救援席',
  '飞行动态监控席',
]

const airspaceRuleCards = [
  { title: '管制空域', detail: '需经空中交通管理机构批准后实施飞行活动。' },
  { title: '适飞空域', detail: '管制空域外的微型、轻型、小型无人机适飞空间。' },
  { title: '临时管制', detail: '重大活动、抢险救灾、医疗救护等可临时增设。' },
  { title: '隔离运行', detail: '无人驾驶航空器通常应与有人驾驶航空器隔离飞行。' },
]

const approvalSteps = [
  { label: '计划受理', value: '任务/空域/时窗' },
  { label: '资料关联', value: '气象/情报/起降场' },
  { label: '风险校核', value: '禁限飞/冲突/高度' },
  { label: '协调放行', value: '运行协调/动态监控' },
]

const planQueryFields = ['任务性质', '飞行空域', '日期', '起降场', '机尾号', '计划状态']

const industryChain = [
  { label: '航空器制造', value: 'eVTOL/无人机/直升机' },
  { label: '运行服务', value: '物流/巡检/应急/文旅' },
  { label: '基础设施', value: '起降场/换电/通信导航' },
  { label: '数据平台', value: '飞服/监管/网格编码' },
]

const altitudeBands = [
  { label: '0-120m', name: '城市治理/植保', load: 76 },
  { label: '120-300m', name: '物流/巡检走廊', load: 64 },
  { label: '300-600m', name: '应急/UAM 验证', load: 42 },
]

let levelTimer: number | undefined
let playTimer: number | undefined
let offGridPick: (() => void) | undefined

const runtimeMissions = computed<LowAltitudeMission[]>(() =>
  LOW_ALTITUDE_MISSIONS.map((mission) => {
    const progress = missionProgress.value[mission.id] ?? mission.progress
    return {
      ...mission,
      progress,
      status: progress >= 100 ? 'completed' : mission.status === 'completed' && progress < 100 ? 'running' : mission.status,
    }
  }),
)

const filteredMissions = computed(() => {
  if (activeScenario.value === 'all') return runtimeMissions.value
  return runtimeMissions.value.filter((mission) => mission.scenario === activeScenario.value)
})

const selectedMission = computed(() => {
  return runtimeMissions.value.find((mission) => mission.id === selectedMissionId.value) ?? filteredMissions.value[0]
})

const visibleZones = computed(() => {
  if (activeScenario.value === 'all') return AIRSPACE_ZONES
  return AIRSPACE_ZONES.filter((zone) => !zone.scenario || zone.scenario === activeScenario.value)
})

const visibleRisks = computed(() => {
  if (activeScenario.value === 'all') return RISK_EVENTS
  return RISK_EVENTS.filter((event) => scenarioForRisk(event, runtimeMissions.value) === activeScenario.value)
})

const visibleFacilities = computed(() => {
  if (activeScenario.value === 'all') return LOW_ALTITUDE_FACILITIES
  return LOW_ALTITUDE_FACILITIES.filter((facility) => !facility.scenario || facility.scenario === activeScenario.value)
})

const selectedRisks = computed(() =>
  visibleRisks.value.filter((event) => !selectedMission.value || event.missionId === selectedMission.value.id),
)

const approvalQueue = computed(() =>
  FLIGHT_PLAN_APPROVALS.map((approval) => ({
    ...approval,
    mission: runtimeMissions.value.find((mission) => mission.id === approval.missionId),
  })).filter((approval) => activeScenario.value === 'all' || approval.mission?.scenario === activeScenario.value),
)

const operatorSummary = computed(() => {
  const aircraft = AIRCRAFT_REGISTRY.length
  const online = AIRCRAFT_REGISTRY.filter((item) => item.status === 'online').length
  const pilots = LOW_ALTITUDE_OPERATORS.reduce((sum, item) => sum + item.pilots, 0)
  const sorties = LOW_ALTITUDE_OPERATORS.reduce((sum, item) => sum + item.monthlySorties, 0)
  return { aircraft, online, pilots, sorties }
})

const trendMax = computed(() =>
  Math.max(...FLIGHT_TRENDS.map((point) => Math.max(point.sorties, point.approvals, point.alerts * 10)), 1),
)

const selectedPosition = computed(() => {
  const mission = selectedMission.value
  return mission ? interpolateRoute(mission.route, mission.progress) : undefined
})

const kpis = computed(() => {
  const missions = runtimeMissions.value
  return {
    running: missions.filter((mission) => mission.status === 'running').length,
    warning: missions.filter((mission) => mission.status === 'warning').length,
    planned: missions.filter((mission) => mission.status === 'planned').length,
    aircraft: missions.filter((mission) => mission.status !== 'completed').length,
    zones: AIRSPACE_ZONES.length,
    approvals: FLIGHT_PLAN_APPROVALS.filter((approval) => approval.status !== 'approved').length,
  }
})

const scenarioStats = computed(() =>
  SCENARIOS.map((scenario) => {
    const missions = runtimeMissions.value.filter((mission) => mission.scenario === scenario.id)
    return {
      ...scenario,
      total: missions.length,
      warning: missions.filter((mission) => mission.status === 'warning').length,
      running: missions.filter((mission) => mission.status === 'running').length,
    }
  }),
)

const gridOverlays = computed<GridOverlayInput[]>(() => {
  if (!showGridOverlay.value) return []
  const overlays: GridOverlayInput[] = []

  if (operationToggles.value.routes) {
    for (const mission of filteredMissions.value) {
      const radius = Math.max(140, Math.min(420, mission.influenceRadius * 0.55))
      for (const point of sampleRoute(mission.route, 3)) {
        overlays.push({
          lonDeg: point.lon,
          latDeg: point.lat,
          heightMeters: point.height,
          radiusMeters: radius,
          kind: mission.scenario === 'emergency' ? 'emergency' : 'route',
        })
      }
    }
  }

  if (operationToggles.value.zones) {
    for (const zone of visibleZones.value) {
      const midHeight = (zone.heightRange.min + zone.heightRange.max) / 2
      const radius = zone.radiusMeters ?? zoneRadius(zone)
      overlays.push({
        lonDeg: zone.center.lon,
        latDeg: zone.center.lat,
        heightMeters: midHeight,
        radiusMeters: radius,
        kind: zoneKind(zone),
      })
    }
  }

  if (operationToggles.value.risks) {
    for (const event of visibleRisks.value) {
      overlays.push({
        lonDeg: event.lon,
        latDeg: event.lat,
        heightMeters: event.height,
        radiusMeters: event.level === 'high' ? 540 : 360,
        kind: event.level === 'high' ? 'risk-high' : 'risk-medium',
      })
    }
  }

  return overlays
})

const fmtPercent = (v: number): string => `${v}%`
const fmtCoord = (v: number): string => v.toFixed(6)
const fmtHeight = (v: number): string => `${v.toFixed(0)} m`

const selectScenario = (scenario: ScenarioFilter): void => {
  activeScenario.value = scenario
}

const selectMission = (id: string): void => {
  selectedMissionId.value = id
  const mission = runtimeMissions.value.find((item) => item.id === id)
  if (mission) {
    const point = interpolateRoute(mission.route, mission.progress)
    flyToPoint(point.lon, point.lat, point.height, 5200, 0.8)
  }
}

const togglePlay = (): void => {
  isPlaying.value = !isPlaying.value
}

const replaySelectedMission = (): void => {
  const mission = selectedMission.value
  if (!mission) return
  missionProgress.value = { ...missionProgress.value, [mission.id]: 0 }
  isPlaying.value = true
}

const onModeChange = (mode: FieldMode): void => {
  renderMode.value = mode
  setMode(mode)
}

const onFillOpacityChange = (v: number): void => {
  setFillOpacity(v / 100)
}

const onLevelChange = (v: number | 'auto'): void => {
  levelMode.value = v
  setLevelOverride(v === 'auto' ? undefined : v)
}

const onClearSelections = (): void => {
  clearSelections()
  pickedGrid.value = undefined
}

const refreshOperationalMap = (): void => {
  if (!mapReady.value) return
  setBoundaryVisible(showBoundary.value)
  setOperationOverlays({
    missions: filteredMissions.value,
    zones: visibleZones.value,
    risks: visibleRisks.value,
    facilities: visibleFacilities.value,
    activeMissionId: selectedMission.value?.id,
    toggles: operationToggles.value,
  })

  if (showGridOverlay.value) {
    setGridOverlays(gridOverlays.value)
  } else {
    clearGridOverlays()
  }

  const point = selectedPosition.value
  const mission = selectedMission.value
  if (point && mission && operationToggles.value.aircraft) {
    setActiveMissionInfluence(point.lon, point.lat, point.height, mission.influenceRadius)
  } else {
    clearActiveMissionInfluence()
  }
}

const zoneKind = (zone: AirspaceZone): GridOverlayInput['kind'] => {
  if (zone.type === 'no-fly') return 'no-fly'
  if (zone.type === 'restricted') return 'restricted'
  if (zone.type === 'emergency') return 'emergency'
  if (zone.type === 'corridor') return 'corridor'
  return 'route'
}

const zoneRadius = (zone: AirspaceZone): number => {
  if (!zone.polygon || zone.polygon.length === 0) return 420
  const lonSpan = Math.max(...zone.polygon.map((point) => point.lon)) - Math.min(...zone.polygon.map((point) => point.lon))
  const latSpan = Math.max(...zone.polygon.map((point) => point.lat)) - Math.min(...zone.polygon.map((point) => point.lat))
  return Math.min(1800, Math.max(420, Math.hypot(lonSpan * 102000, latSpan * 111320) / 3))
}

const zoneTypeLabel = (type: AirspaceZone['type']): string => {
  const labels: Record<AirspaceZone['type'], string> = {
    corridor: '低空航路',
    takeoff: '起飞点',
    landing: '备降点',
    'no-fly': '禁飞区',
    restricted: '限飞区',
    emergency: '临时管制',
  }
  return labels[type]
}

const flyToZone = (zone: AirspaceZone): void => {
  flyToPoint(zone.center.lon, zone.center.lat, (zone.heightRange.min + zone.heightRange.max) / 2, 6200, 0.75)
}

const flyToFacility = (facility: LowAltitudeFacility): void => {
  flyToPoint(facility.lon, facility.lat, 0, 4200, 0.75)
}

const applyModulePreset = (module: ModuleId): void => {
  const preset = moduleLayerPresets[module]
  operationToggles.value = {
    routes: preset.routes,
    zones: preset.zones,
    risks: preset.risks,
    aircraft: preset.aircraft,
    sites: preset.sites,
  }
  showGridOverlay.value = preset.grid
  renderMode.value = preset.mode
  fillOpacity.value = preset.opacity
  setMode(preset.mode)
  setFillOpacity(preset.opacity / 100)
}

const statusClass = (status: LowAltitudeMission['status']): string => `status--${status}`
const priorityClass = (priority: LowAltitudeMission['priority']): string => `priority--${priority}`
const riskClass = (level: RiskEvent['level']): string => `risk--${level}`

watch(activeScenario, () => {
  if (!filteredMissions.value.some((mission) => mission.id === selectedMissionId.value)) {
    selectedMissionId.value = filteredMissions.value[0]?.id ?? LOW_ALTITUDE_MISSIONS[0]!.id
  }
})

watch(activeModule, (module) => {
  applyModulePreset(module)
})

watch(
  [
    filteredMissions,
    visibleZones,
    visibleRisks,
    visibleFacilities,
    selectedMission,
    selectedPosition,
    operationToggles,
    showBoundary,
    showGridOverlay,
    gridOverlays,
  ],
  refreshOperationalMap,
  { deep: true },
)

onMounted(async () => {
  if (!container.value) return

  init(container.value, {
    heightRange: { min: 0, max: 720, step: 120 },
    anchorLonDeg: SIMAO_OPERATION_CENTER.lon,
    anchorLatDeg: SIMAO_OPERATION_CENTER.lat,
  })
  mapReady.value = true
  offGridPick = onGridPick((info) => {
    pickedGrid.value = info
  })

  setMode(renderMode.value)
  setFillOpacity(fillOpacity.value / 100)
  setLevelOverride(typeof levelMode.value === 'number' ? levelMode.value : undefined)
  setGivenRange(SIMAO_BBOX.west, SIMAO_BBOX.south, SIMAO_BBOX.east, SIMAO_BBOX.north)

  loadBoundary(SIMAO_DISTRICT_BOUNDARY_URL, { flyTo: false }).catch(() => {
    /* 边界加载失败不阻断主流程。 */
  })

  refreshOperationalMap()

  levelTimer = window.setInterval(() => {
    activeLevel.value = getActiveLevel()
  }, 400)

  playTimer = window.setInterval(() => {
    if (!isPlaying.value) return
    const next = { ...missionProgress.value }
    const selectedId = selectedMission.value?.id
    for (const mission of LOW_ALTITUDE_MISSIONS) {
      const shouldAdvance = mission.status === 'running' || mission.status === 'warning' || mission.id === selectedId
      if (!shouldAdvance) continue
      const current = next[mission.id] ?? mission.progress
      if (current >= 100 && mission.id !== selectedId) continue
      next[mission.id] = current >= 100 ? 0 : Math.min(100, current + 2.4)
    }
    missionProgress.value = next
  }, 900)
})

onBeforeUnmount(() => {
  if (levelTimer !== undefined) {
    window.clearInterval(levelTimer)
    levelTimer = undefined
  }
  if (playTimer !== undefined) {
    window.clearInterval(playTimer)
    playTimer = undefined
  }
  offGridPick?.()
  offGridPick = undefined
  dispose()
})
</script>

<template>
  <div class="workspace" :class="`workspace--${activeModule}`">
    <div ref="container" class="cesium-container"></div>

    <header class="topbar">
      <div class="brand">
        <span class="brand__mark"></span>
        <div>
          <h1>思茅区低空经济综合运营监管平台</h1>
          <p>{{ activeModuleProfile.title }} · {{ activeModuleProfile.subtitle }}</p>
        </div>
        <span class="brand__badge">{{ activeModuleProfile.badge }}</span>
      </div>
      <nav class="module-tabs" aria-label="平台模块">
        <button
          v-for="module in moduleTabs"
          :key="module.id"
          type="button"
          class="module-tab"
          :class="{ 'module-tab--active': activeModule === module.id }"
          @click="activeModule = module.id"
        >
          <span class="module-tab__label">{{ module.label }}</span>
          <span class="module-tab__sub">{{ moduleProfiles[module.id].badge }}</span>
        </button>
      </nav>
      <div class="kpis">
        <div class="kpi">
          <span>运行任务</span>
          <strong>{{ kpis.running }}</strong>
        </div>
        <div class="kpi kpi--warn">
          <span>风险告警</span>
          <strong>{{ kpis.warning }}</strong>
        </div>
        <div class="kpi">
          <span>待飞计划</span>
          <strong>{{ kpis.planned }}</strong>
        </div>
        <div class="kpi">
          <span>空域单元</span>
          <strong>{{ kpis.zones }}</strong>
        </div>
        <div class="kpi kpi--warn">
          <span>待处理计划</span>
          <strong>{{ kpis.approvals }}</strong>
        </div>
        <div class="kpi">
          <span>有效级别</span>
          <strong>L{{ activeLevel }}</strong>
        </div>
      </div>
    </header>

    <section class="module-banner panel-shell">
      <span>{{ activeModuleProfile.badge }}</span>
      <strong>{{ activeModuleProfile.title }}</strong>
      <em>{{ activeModuleProfile.subtitle }}</em>
    </section>

    <aside class="left-rail panel-shell">
      <template v-if="activeModule === 'overview'">
        <section class="panel-section">
          <div class="panel-title">应用场景</div>
          <button
            class="scenario-row"
            :class="{ 'scenario-row--active': activeScenario === 'all' }"
            type="button"
            @click="selectScenario('all')"
          >
            <span class="scenario-row__dot scenario-row__dot--all"></span>
            <span class="scenario-row__main">综合态势</span>
            <span class="scenario-row__meta">{{ runtimeMissions.length }}</span>
          </button>
          <button
            v-for="scenario in scenarioStats"
            :key="scenario.id"
            class="scenario-row"
            :class="{ 'scenario-row--active': activeScenario === scenario.id }"
            type="button"
            @click="selectScenario(scenario.id)"
          >
            <span class="scenario-row__dot" :style="{ background: scenario.color }"></span>
            <span class="scenario-row__main">{{ scenario.name }}</span>
            <span class="scenario-row__meta">{{ scenario.running }}/{{ scenario.total }}</span>
          </button>
        </section>

        <section class="panel-section">
          <div class="panel-title">运行通告</div>
          <div class="notice-list">
            <div v-for="notice in OPERATION_NOTICES" :key="notice.id" class="notice-row" :class="`notice--${notice.level}`">
              <span class="notice-row__time">{{ notice.time }}</span>
              <span class="notice-row__body">
                <strong>{{ notice.title }}</strong>
                <em>{{ notice.source }}</em>
              </span>
            </div>
          </div>
        </section>

        <section class="panel-section panel-section--fill">
          <div class="panel-title">任务调度</div>
          <div class="mission-list">
            <button
              v-for="mission in filteredMissions"
              :key="mission.id"
              class="mission-row"
              :class="{ 'mission-row--active': selectedMission?.id === mission.id }"
              type="button"
              @click="selectMission(mission.id)"
            >
              <span class="mission-row__head">
                <span class="mission-row__name">{{ mission.name }}</span>
                <span class="tag" :class="statusClass(mission.status)">{{ statusLabel(mission.status) }}</span>
              </span>
              <span class="mission-row__meta">
                {{ scenarioById(mission.scenario).shortName }} · {{ aircraftLabel(mission.aircraftType) }} ·
                {{ priorityLabel(mission.priority) }}
              </span>
              <span class="progress">
                <span class="progress__bar" :style="{ width: `${mission.progress}%` }"></span>
              </span>
            </button>
          </div>
        </section>
      </template>

      <template v-else-if="activeModule === 'airspace'">
        <section class="panel-section">
          <div class="panel-title">空域分类规则</div>
          <div class="rule-grid">
            <div v-for="rule in airspaceRuleCards" :key="rule.title" class="rule-card">
              <strong>{{ rule.title }}</strong>
              <span>{{ rule.detail }}</span>
            </div>
          </div>
        </section>

        <section class="panel-section">
          <div class="panel-title">高度层负载</div>
          <div v-for="band in altitudeBands" :key="band.label" class="altitude-band">
            <span>
              <strong>{{ band.label }}</strong>
              <em>{{ band.name }}</em>
            </span>
            <i><b :style="{ width: `${band.load}%` }"></b></i>
            <small>{{ band.load }}%</small>
          </div>
        </section>

        <section class="panel-section panel-section--fill">
          <div class="panel-title">资源单元目录</div>
          <div class="zone-list">
            <button v-for="zone in visibleZones" :key="zone.id" class="zone-row" type="button" @click="flyToZone(zone)">
              <span class="zone-row__main">
                <strong>{{ zone.name }}</strong>
                <em>{{ zoneTypeLabel(zone.type) }} · {{ zone.heightRange.min }}-{{ zone.heightRange.max }}m</em>
              </span>
              <span class="tag">{{ zone.scenario ? scenarioById(zone.scenario).shortName : '全域' }}</span>
            </button>
          </div>
        </section>
      </template>

      <template v-else-if="activeModule === 'approval'">
        <section class="panel-section">
          <div class="panel-title">计划查询项</div>
          <div class="query-grid">
            <span v-for="field in planQueryFields" :key="field">{{ field }}</span>
          </div>
        </section>

        <section class="panel-section">
          <div class="panel-title">审批闭环</div>
          <div class="approval-stepper">
            <div v-for="(step, index) in approvalSteps" :key="step.label" class="approval-step">
              <b>{{ index + 1 }}</b>
              <span>
                <strong>{{ step.label }}</strong>
                <em>{{ step.value }}</em>
              </span>
            </div>
          </div>
        </section>

        <section class="panel-section panel-section--fill">
          <div class="panel-title">飞行计划队列</div>
          <div class="approval-list approval-list--scroll">
            <div v-for="approval in approvalQueue" :key="approval.id" class="approval-row" :class="`approval--${approval.status}`">
              <div class="approval-row__head">
                <strong>{{ approval.routeName }}</strong>
                <span>{{ approvalStatusLabel(approval.status) }}</span>
              </div>
              <p>{{ approval.applicant }} · {{ approval.window }}</p>
              <div class="risk-score">
                <span>风险评分</span>
                <strong>{{ approval.riskScore }}</strong>
                <i :style="{ width: `${approval.riskScore}%` }"></i>
              </div>
            </div>
          </div>
        </section>
      </template>

      <template v-else>
        <section class="panel-section">
          <div class="panel-title">产业运行指标</div>
          <div class="metric-grid">
            <div v-for="metric in INDUSTRY_METRICS" :key="metric.label" :class="`industry-card industry-card--${metric.tone}`">
              <span>{{ metric.label }}</span>
              <strong>{{ metric.value }}</strong>
              <em>{{ metric.delta }}</em>
            </div>
          </div>
        </section>

        <section class="panel-section">
          <div class="panel-title">产业链条</div>
          <div class="chain-list">
            <div v-for="item in industryChain" :key="item.label" class="chain-row">
              <strong>{{ item.label }}</strong>
              <span>{{ item.value }}</span>
            </div>
          </div>
        </section>

        <section class="panel-section panel-section--fill">
          <div class="panel-title">运营主体</div>
          <div class="operator-list">
            <div v-for="operator in LOW_ALTITUDE_OPERATORS" :key="operator.id" class="operator-row">
              <span>
                <strong>{{ operator.name }}</strong>
                <em>{{ operatorTypeLabel(operator.type) }} · {{ operator.aircraft }}架 · {{ operator.pilots }}人</em>
              </span>
              <b>{{ operator.complianceRate }}%</b>
            </div>
          </div>
        </section>
      </template>
    </aside>

    <aside class="right-rail panel-shell">
      <template v-if="activeModule === 'overview'">
        <section v-if="selectedMission" class="panel-section">
          <div class="panel-title">当前任务</div>
          <div class="detail-head">
            <div>
              <h2>{{ selectedMission.name }}</h2>
              <p>{{ selectedMission.operator }}</p>
            </div>
            <span class="tag" :class="priorityClass(selectedMission.priority)">
              {{ priorityLabel(selectedMission.priority) }}
            </span>
          </div>
          <div class="detail-grid">
            <div>
              <span>场景</span>
              <strong>{{ scenarioById(selectedMission.scenario).name }}</strong>
            </div>
            <div>
              <span>航空器</span>
              <strong>{{ aircraftLabel(selectedMission.aircraftType) }}</strong>
            </div>
            <div>
              <span>载荷</span>
              <strong>{{ selectedMission.payload }}</strong>
            </div>
            <div>
              <span>影响半径</span>
              <strong>{{ selectedMission.influenceRadius }} m</strong>
            </div>
          </div>
          <div class="mission-progress-line">
            <span>任务进度</span>
            <strong>{{ selectedMission.progress.toFixed(0) }}%</strong>
          </div>
          <el-progress :percentage="Math.round(selectedMission.progress)" :stroke-width="8" :show-text="false" />
        </section>

        <section class="panel-section">
          <div class="panel-title">拾取网格编码</div>
          <div v-if="pickedGrid" class="code-block">
            <span>三维编码</span>
            <code>{{ pickedGrid.code3D }}</code>
            <span>二维编码</span>
            <code>{{ pickedGrid.code2D }}</code>
            <div class="code-meta">
              <span>L{{ pickedGrid.level }}</span>
              <span>
                {{ fmtCoord(pickedGrid.center.lonDeg) }},
                {{ fmtCoord(pickedGrid.center.latDeg) }},
                {{ fmtHeight(pickedGrid.center.heightMeters) }}
              </span>
            </div>
          </div>
          <div v-else class="empty-state">等待拾取</div>
        </section>

        <section class="panel-section panel-section--fill">
          <div class="panel-title">风险事件</div>
          <div class="risk-list">
            <div v-for="event in selectedRisks" :key="event.id" class="risk-row" :class="riskClass(event.level)">
              <div class="risk-row__head">
                <strong>{{ event.title }}</strong>
                <span>{{ riskLevelLabel(event.level) }}风险</span>
              </div>
              <p>{{ event.description }}</p>
            </div>
            <div v-if="selectedRisks.length === 0" class="empty-state">当前场景无风险</div>
          </div>
        </section>

        <section class="panel-section">
          <div class="panel-title">主体与装备</div>
          <div class="registry-summary">
            <div>
              <span>注册航空器</span>
              <strong>{{ operatorSummary.aircraft }}</strong>
            </div>
            <div>
              <span>在线装备</span>
              <strong>{{ operatorSummary.online }}</strong>
            </div>
            <div>
              <span>飞手/机组</span>
              <strong>{{ operatorSummary.pilots }}</strong>
            </div>
          </div>
          <div class="aircraft-list">
            <div v-for="aircraft in AIRCRAFT_REGISTRY.slice(0, 4)" :key="aircraft.id" class="aircraft-row">
              <span>
                <strong>{{ aircraft.id }}</strong>
                <em>{{ aircraft.model }} · {{ aircraft.owner }}</em>
              </span>
              <b :class="`aircraft--${aircraft.status}`">{{ aircraftStatusLabel(aircraft.status) }}</b>
            </div>
          </div>
        </section>
      </template>

      <template v-else-if="activeModule === 'airspace'">
        <section class="panel-section">
          <div class="panel-title">空域资源态势</div>
          <div class="registry-summary">
            <div>
              <span>航路/起降</span>
              <strong>{{ visibleZones.filter((zone) => zone.type === 'corridor' || zone.type === 'takeoff' || zone.type === 'landing').length }}</strong>
            </div>
            <div>
              <span>禁限飞</span>
              <strong>{{ visibleZones.filter((zone) => zone.type === 'no-fly' || zone.type === 'restricted').length }}</strong>
            </div>
            <div>
              <span>临时管制</span>
              <strong>{{ visibleZones.filter((zone) => zone.type === 'emergency').length }}</strong>
            </div>
          </div>
        </section>

        <section class="panel-section panel-section--fill">
          <div class="panel-title">资源单元详情</div>
          <div class="zone-list">
            <button v-for="zone in visibleZones" :key="zone.id" class="zone-card" type="button" @click="flyToZone(zone)">
              <span>
                <strong>{{ zone.name }}</strong>
                <em>{{ zoneTypeLabel(zone.type) }} · 高度 {{ zone.heightRange.min }}-{{ zone.heightRange.max }}m</em>
              </span>
              <i>{{ zone.scenario ? scenarioById(zone.scenario).name : '全域共享' }}</i>
            </button>
          </div>
        </section>

        <section class="panel-section">
          <div class="panel-title">起降与服务设施</div>
          <div class="facility-list">
            <button v-for="facility in visibleFacilities" :key="facility.id" type="button" class="facility-row" @click="flyToFacility(facility)">
              <span>
                <strong>{{ facility.name }}</strong>
                <em>{{ facilityTypeLabel(facility.type) }} · 可用 {{ facility.available }}/{{ facility.capacity }}</em>
              </span>
              <b>{{ Math.round((facility.available / facility.capacity) * 100) }}%</b>
            </button>
          </div>
        </section>
      </template>

      <template v-else-if="activeModule === 'approval'">
        <section class="panel-section">
          <div class="panel-title">计划审批看板</div>
          <div class="approval-list">
            <div v-for="approval in approvalQueue" :key="approval.id" class="approval-row" :class="`approval--${approval.status}`">
              <div class="approval-row__head">
                <strong>{{ approval.routeName }}</strong>
                <span>{{ approvalStatusLabel(approval.status) }}</span>
              </div>
              <p>{{ approval.applicant }} · {{ approval.window }}</p>
              <div class="risk-score">
                <span>风险评分</span>
                <strong>{{ approval.riskScore }}</strong>
                <i :style="{ width: `${approval.riskScore}%` }"></i>
              </div>
            </div>
          </div>
        </section>

        <section class="panel-section">
          <div class="panel-title">服务席位联动</div>
          <div class="seat-grid">
            <span v-for="seat in serviceSeats" :key="seat">{{ seat }}</span>
          </div>
        </section>

        <section class="panel-section panel-section--fill">
          <div class="panel-title">合规与冲突校核</div>
          <div class="risk-list">
            <div v-for="event in visibleRisks" :key="event.id" class="risk-row" :class="riskClass(event.level)">
              <div class="risk-row__head">
                <strong>{{ event.title }}</strong>
                <span>{{ riskLevelLabel(event.level) }}风险</span>
              </div>
              <p>{{ event.description }}</p>
            </div>
          </div>
        </section>
      </template>

      <template v-else>
        <section class="panel-section">
          <div class="panel-title">产业运行规模</div>
          <div class="registry-summary">
            <div>
              <span>月保障架次</span>
              <strong>{{ operatorSummary.sorties }}</strong>
            </div>
            <div>
              <span>运营主体</span>
              <strong>{{ LOW_ALTITUDE_OPERATORS.length }}</strong>
            </div>
            <div>
              <span>注册装备</span>
              <strong>{{ operatorSummary.aircraft }}</strong>
            </div>
          </div>
        </section>

        <section class="panel-section panel-section--fill">
          <div class="panel-title">主体合规率</div>
          <div class="operator-list">
            <div v-for="operator in LOW_ALTITUDE_OPERATORS" :key="operator.id" class="operator-row">
              <span>
                <strong>{{ operator.name }}</strong>
                <em>{{ operatorTypeLabel(operator.type) }} · {{ operator.monthlySorties }}架次/月</em>
              </span>
              <b>{{ operator.complianceRate }}%</b>
            </div>
          </div>
        </section>

        <section class="panel-section">
          <div class="panel-title">装备状态</div>
          <div class="aircraft-list">
            <div v-for="aircraft in AIRCRAFT_REGISTRY" :key="aircraft.id" class="aircraft-row">
              <span>
                <strong>{{ aircraft.id }}</strong>
                <em>{{ aircraft.model }} · 最大 {{ aircraft.maxAltitude }}m</em>
              </span>
              <b :class="`aircraft--${aircraft.status}`">{{ aircraftStatusLabel(aircraft.status) }}</b>
            </div>
          </div>
        </section>
      </template>
    </aside>

    <section class="bottom-dock panel-shell">
      <template v-if="activeModule === 'overview'">
        <div class="playback">
          <el-button type="primary" @click="togglePlay">{{ isPlaying ? '暂停模拟' : '播放模拟' }}</el-button>
          <el-button plain @click="replaySelectedMission">重放任务</el-button>
          <el-button plain @click="() => selectedPosition && flyToPoint(selectedPosition.lon, selectedPosition.lat, selectedPosition.height, 5200, 0.8)">
            定位任务
          </el-button>
          <div class="industry-cards">
            <div v-for="metric in INDUSTRY_METRICS.slice(0, 3)" :key="metric.label" :class="`industry-card industry-card--${metric.tone}`">
              <span>{{ metric.label }}</span>
              <strong>{{ metric.value }}</strong>
              <em>{{ metric.delta }}</em>
            </div>
          </div>
        </div>

        <div class="airspace-load">
          <div class="dock-title">片区空域繁忙度</div>
          <div v-for="area in AREA_LOADS" :key="area.id" class="load-row">
            <span>{{ area.name }}</span>
            <i><b :style="{ width: `${area.load}%` }"></b></i>
            <em>{{ area.flights }} 架次</em>
          </div>
        </div>

        <div class="trend-card">
          <div class="dock-title">时段运行趋势</div>
          <div class="trend-chart">
            <div v-for="point in FLIGHT_TRENDS" :key="point.label" class="trend-bar">
              <span class="trend-bar__sorties" :style="{ height: `${Math.max(8, (point.sorties / trendMax) * 76)}px` }"></span>
              <span class="trend-bar__approvals" :style="{ height: `${Math.max(6, (point.approvals / trendMax) * 76)}px` }"></span>
              <em>{{ point.label }}</em>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="activeModule === 'airspace'">
        <div class="dock-card dock-card--rules">
          <div class="dock-title">空域分类</div>
          <div class="compact-rule-list">
            <span v-for="rule in airspaceRuleCards" :key="rule.title">{{ rule.title }}</span>
          </div>
          <p>按管制空域、适飞空域、临时管制空域组织显示与调度。</p>
        </div>

        <div class="dock-card">
          <div class="dock-title">高度层容量</div>
          <div v-for="band in altitudeBands" :key="band.label" class="load-row">
            <span>{{ band.label }}</span>
            <i><b :style="{ width: `${band.load}%` }"></b></i>
            <em>{{ band.load }}%</em>
          </div>
        </div>

        <div class="dock-card">
          <div class="dock-title">设施可用性</div>
          <div v-for="facility in visibleFacilities.slice(0, 4)" :key="facility.id" class="capacity-row">
            <span>{{ facility.name }}</span>
            <b>{{ facility.available }}/{{ facility.capacity }}</b>
          </div>
        </div>
      </template>

      <template v-else-if="activeModule === 'approval'">
        <div class="dock-card">
          <div class="dock-title">计划要素</div>
          <div class="query-grid query-grid--dock">
            <span v-for="field in planQueryFields" :key="field">{{ field }}</span>
          </div>
        </div>

        <div class="dock-card">
          <div class="dock-title">审批流转</div>
          <div class="step-strip">
            <span v-for="step in approvalSteps" :key="step.label">{{ step.label }}</span>
          </div>
        </div>

        <div class="dock-card">
          <div class="dock-title">风险复核</div>
          <div v-for="approval in approvalQueue.slice(0, 3)" :key="approval.id" class="load-row">
            <span>{{ approval.routeName }}</span>
            <i><b :style="{ width: `${approval.riskScore}%` }"></b></i>
            <em>{{ approval.riskScore }}</em>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="dock-card">
          <div class="dock-title">产业指标</div>
          <div class="industry-cards industry-cards--dock">
            <div v-for="metric in INDUSTRY_METRICS.slice(0, 3)" :key="metric.label" :class="`industry-card industry-card--${metric.tone}`">
              <span>{{ metric.label }}</span>
              <strong>{{ metric.value }}</strong>
              <em>{{ metric.delta }}</em>
            </div>
          </div>
        </div>

        <div class="dock-card">
          <div class="dock-title">服务链条</div>
          <div class="chain-inline">
            <span v-for="item in industryChain" :key="item.label">{{ item.label }}</span>
          </div>
        </div>

        <div class="dock-card">
          <div class="dock-title">主体架次</div>
          <div v-for="operator in LOW_ALTITUDE_OPERATORS.slice(0, 4)" :key="operator.id" class="capacity-row">
            <span>{{ operator.name }}</span>
            <b>{{ operator.monthlySorties }}</b>
          </div>
        </div>
      </template>

      <div class="render-controls">
        <div class="layer-controls">
          <label><el-switch v-model="operationToggles.routes" />航线</label>
          <label><el-switch v-model="operationToggles.zones" />空域</label>
          <label><el-switch v-model="operationToggles.risks" />风险</label>
          <label><el-switch v-model="operationToggles.aircraft" />机位</label>
          <label><el-switch v-model="operationToggles.sites" />站点</label>
          <label><el-switch v-model="showGridOverlay" />网格</label>
        </div>
        <el-radio-group :model-value="renderMode" @change="onModeChange">
          <el-radio-button value="wire">线框</el-radio-button>
          <el-radio-button value="fill">填充</el-radio-button>
        </el-radio-group>
        <el-select :model-value="levelMode" class="level-select" @change="onLevelChange">
          <el-option
            v-for="opt in levelOptions"
            :key="String(opt.value)"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <div class="opacity-control" :class="{ 'opacity-control--muted': renderMode !== 'fill' }">
          <span>透明度</span>
          <el-slider
            v-model="fillOpacity"
            :min="4"
            :max="100"
            :disabled="renderMode !== 'fill'"
            :format-tooltip="fmtPercent"
            @input="onFillOpacityChange"
          />
        </div>
        <el-button plain @click="onClearSelections">清除选中</el-button>
        <span class="dock-note">模拟数据 · 思茅区 bbox {{ SIMAO_BBOX.west }}~{{ SIMAO_BBOX.east }}</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.workspace {
  --accent: #35c4ff;
  --accent-rgb: 53, 196, 255;
  --accent-2: #30d158;
  --accent-2-rgb: 48, 209, 88;
  --danger: #ff2d55;
  --warning: #ff9500;
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #07090d;
  color: #e8eef6;
  font-family: 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
}

.workspace--airspace {
  --accent: #35f0c4;
  --accent-rgb: 53, 240, 196;
  --accent-2: #64d2ff;
  --accent-2-rgb: 100, 210, 255;
}

.workspace--approval {
  --accent: #ffd60a;
  --accent-rgb: 255, 214, 10;
  --accent-2: #ff9500;
  --accent-2-rgb: 255, 149, 0;
}

.workspace--industry {
  --accent: #c77dff;
  --accent-rgb: 199, 125, 255;
  --accent-2: #64d2ff;
  --accent-2-rgb: 100, 210, 255;
}

.cesium-container {
  position: absolute;
  inset: 0;
}

.panel-shell {
  position: absolute;
  border: 1px solid rgba(var(--accent-rgb), 0.22);
  border-radius: 8px;
  background: rgba(12, 16, 22, 0.78);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.36);
}

.topbar {
  position: absolute;
  top: 14px;
  left: 14px;
  right: 14px;
  height: 76px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 18px;
  border: 1px solid rgba(var(--accent-rgb), 0.22);
  border-radius: 8px;
  background: rgba(11, 15, 21, 0.76);
  backdrop-filter: blur(18px);
  z-index: 5;
}

.brand {
  flex: 0 0 380px;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.brand > div {
  min-width: 0;
}
.brand__mark {
  width: 12px;
  height: 34px;
  border-radius: 3px;
  background: linear-gradient(180deg, var(--accent), var(--accent-2));
}
.brand h1 {
  margin: 0;
  font-size: 18px;
  line-height: 1.2;
  color: #f6fbff;
}
.brand p {
  max-width: 260px;
  margin: 4px 0 0;
  overflow: hidden;
  font-size: 12px;
  color: #98aabb;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.brand__badge {
  flex: none;
  padding: 5px 8px;
  border-radius: 999px;
  background: rgba(var(--accent-rgb), 0.16);
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
}

.module-tabs {
  display: flex;
  gap: 6px;
  padding: 4px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.045);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.module-tab {
  height: 44px;
  min-width: 76px;
  padding: 0 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #aebbc8;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.module-tab__label,
.module-tab__sub {
  display: block;
  line-height: 1.25;
}
.module-tab__sub {
  margin-top: 3px;
  color: #788895;
  font-size: 10px;
  font-weight: 600;
}
.module-tab--active {
  background: rgba(var(--accent-rgb), 0.22);
  color: #f6fbff;
  box-shadow: inset 0 0 0 1px rgba(var(--accent-rgb), 0.38);
}
.module-tab--active .module-tab__sub {
  color: color-mix(in srgb, var(--accent) 72%, #ffffff 28%);
}

.kpis {
  display: grid;
  grid-template-columns: repeat(6, minmax(62px, 1fr));
  gap: 8px;
  flex: 1;
}
.kpi {
  min-width: 0;
  padding: 7px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.055);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.kpi span {
  display: block;
  font-size: 11px;
  color: #91a0ad;
}
.kpi strong {
  display: block;
  margin-top: 2px;
  font-size: 20px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.kpi--warn strong {
  color: var(--warning);
}

.module-banner {
  top: 104px;
  left: 360px;
  right: 398px;
  min-height: 44px;
  display: grid;
  grid-template-columns: max-content max-content minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  z-index: 3;
}
.module-banner span {
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(var(--accent-rgb), 0.18);
  color: var(--accent);
  font-size: 11px;
  font-weight: 800;
}
.module-banner strong {
  color: #f8fbff;
  font-size: 14px;
}
.module-banner em {
  min-width: 0;
  overflow: hidden;
  color: #98aabb;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-style: normal;
  font-size: 12px;
}

.left-rail,
.right-rail {
  top: 104px;
  bottom: 154px;
  width: 330px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  z-index: 4;
}
.left-rail {
  left: 14px;
}
.right-rail {
  right: 14px;
  width: 370px;
  overflow-y: auto;
}

.panel-section {
  padding: 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.panel-section:last-child {
  border-bottom: none;
}
.panel-section--fill {
  min-height: 0;
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.panel-title {
  margin-bottom: 10px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.6px;
  color: color-mix(in srgb, var(--accent) 58%, #d9f2ff 42%);
}

.rule-grid,
.metric-grid,
.query-grid,
.seat-grid {
  display: grid;
  gap: 8px;
}
.rule-grid {
  grid-template-columns: 1fr 1fr;
}
.rule-card,
.chain-row,
.operator-row,
.facility-row,
.zone-row,
.zone-card,
.dock-card {
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.052);
  border: 1px solid rgba(255, 255, 255, 0.075);
}
.rule-card {
  min-height: 82px;
  padding: 9px;
}
.rule-card strong,
.chain-row strong,
.operator-row strong,
.zone-row strong,
.zone-card strong,
.facility-row strong {
  display: block;
  color: #f6fbff;
  font-size: 12px;
}
.rule-card span,
.chain-row span,
.operator-row em,
.zone-row em,
.zone-card em,
.facility-row em {
  display: block;
  margin-top: 4px;
  color: #8e9ead;
  font-style: normal;
  font-size: 11px;
  line-height: 1.45;
}
.altitude-band {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr) 36px;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 11px;
}
.altitude-band span,
.zone-row__main,
.operator-row span,
.facility-row span,
.zone-card span {
  min-width: 0;
}
.altitude-band strong,
.altitude-band em {
  display: block;
}
.altitude-band strong {
  color: #f6fbff;
  font-size: 12px;
}
.altitude-band em {
  overflow: hidden;
  color: #8e9ead;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-style: normal;
}
.altitude-band i {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.13);
}
.altitude-band b {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
}
.altitude-band small {
  color: #b8c5d2;
  text-align: right;
}
.zone-list,
.operator-list,
.facility-list {
  min-height: 0;
  overflow-y: auto;
  display: grid;
  gap: 8px;
  padding-right: 3px;
}
.zone-row,
.zone-card,
.facility-row {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 10px;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.zone-row:hover,
.zone-card:hover,
.facility-row:hover {
  border-color: rgba(var(--accent-rgb), 0.34);
  background: rgba(var(--accent-rgb), 0.08);
}
.zone-card {
  align-items: flex-start;
  flex-direction: column;
}
.zone-card i {
  color: var(--accent);
  font-style: normal;
  font-size: 11px;
}
.query-grid {
  grid-template-columns: repeat(2, 1fr);
}
.query-grid span,
.seat-grid span,
.compact-rule-list span,
.step-strip span,
.chain-inline span {
  min-width: 0;
  padding: 7px 8px;
  border-radius: 6px;
  background: rgba(var(--accent-rgb), 0.11);
  color: #dcebf7;
  text-align: center;
  font-size: 11px;
}
.seat-grid {
  grid-template-columns: repeat(2, 1fr);
}
.approval-stepper {
  display: grid;
  gap: 8px;
}
.approval-step {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}
.approval-step b {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(var(--accent-rgb), 0.2);
  color: var(--accent);
  font-size: 12px;
}
.approval-step strong,
.approval-step em {
  display: block;
}
.approval-step strong {
  color: #f6fbff;
  font-size: 12px;
}
.approval-step em {
  color: #8e9ead;
  font-style: normal;
  font-size: 11px;
}
.approval-list--scroll {
  min-height: 0;
  overflow-y: auto;
  padding-right: 3px;
}
.metric-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.chain-list {
  display: grid;
  gap: 8px;
}
.chain-row {
  padding: 9px 10px;
}
.operator-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 10px;
}
.operator-row b,
.facility-row b,
.capacity-row b {
  flex: none;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}

.scenario-row,
.mission-row {
  width: 100%;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.scenario-row {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 8px 9px;
}
.scenario-row:hover,
.scenario-row--active,
.mission-row:hover,
.mission-row--active {
  background: rgba(255, 255, 255, 0.07);
  border-color: rgba(130, 200, 235, 0.28);
}
.scenario-row__dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}
.scenario-row__dot--all {
  background: linear-gradient(135deg, #35c4ff, #ffd60a);
}
.scenario-row__main {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.scenario-row__meta {
  color: #91a0ad;
  font-size: 12px;
}

.mission-list,
.risk-list {
  min-height: 0;
  overflow-y: auto;
  padding-right: 3px;
}
.notice-list {
  display: grid;
  gap: 7px;
}
.notice-row {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 8px;
  padding: 7px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.045);
  border-left: 3px solid #35c4ff;
}
.notice--warning {
  border-left-color: #ff9500;
}
.notice--control {
  border-left-color: #ff453a;
}
.notice-row__time {
  color: #35f0c4;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.notice-row__body {
  min-width: 0;
}
.notice-row__body strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.notice-row__body em {
  display: block;
  margin-top: 2px;
  color: #8e9ead;
  font-style: normal;
  font-size: 11px;
}
.mission-row {
  display: block;
  padding: 10px;
  margin-bottom: 8px;
}
.mission-row__head,
.risk-row__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.mission-row__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 700;
}
.mission-row__meta {
  display: block;
  margin-top: 5px;
  color: #8e9ead;
  font-size: 11.5px;
}
.progress {
  display: block;
  height: 4px;
  margin-top: 8px;
  overflow: hidden;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.12);
}
.progress__bar {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
}

.tag {
  flex: none;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  color: #101419;
  background: #aab7c4;
}
.status--running,
.priority--normal {
  background: var(--accent-2);
}
.status--warning,
.priority--urgent {
  background: var(--warning);
}
.status--planned,
.priority--important {
  background: var(--accent);
}
.status--completed {
  background: #9aa4ad;
}

.detail-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.detail-head h2 {
  margin: 0;
  font-size: 16px;
}
.detail-head p {
  margin: 5px 0 0;
  color: #91a0ad;
  font-size: 12px;
}
.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 12px;
}
.detail-grid div {
  min-width: 0;
  padding: 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.055);
}
.detail-grid span,
.mission-progress-line span,
.code-block span {
  display: block;
  margin-bottom: 3px;
  color: #8e9ead;
  font-size: 11px;
}
.detail-grid strong {
  display: block;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.mission-progress-line {
  display: flex;
  justify-content: space-between;
  margin: 12px 0 6px;
}
.mission-progress-line strong {
  color: var(--accent);
}

.approval-list {
  display: grid;
  gap: 8px;
}
.approval-row {
  padding: 8px 9px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  border-left: 3px solid var(--accent);
}
.approval--recheck {
  border-left-color: #ff9500;
}
.approval--pending {
  border-left-color: #ffd60a;
}
.approval--approved {
  border-left-color: #30d158;
}
.approval-row__head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.approval-row__head strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.approval-row__head span {
  flex: none;
  color: #cbd7e4;
  font-size: 11px;
}
.approval-row p {
  margin: 4px 0 7px;
  color: #8e9ead;
  font-size: 11.5px;
}
.risk-score {
  position: relative;
  display: grid;
  grid-template-columns: 56px 28px minmax(0, 1fr);
  align-items: center;
  gap: 7px;
}
.risk-score span {
  color: #8e9ead;
  font-size: 11px;
}
.risk-score strong {
  color: #ffcf70;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.risk-score i {
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--accent-2), #ffd60a, #ff453a);
}

.code-block {
  display: grid;
  gap: 6px;
}
.code-block code {
  display: block;
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-all;
  padding: 7px 8px;
  border-radius: 6px;
  background: rgba(var(--accent-rgb), 0.08);
  color: #f2f8ff;
  font-size: 11px;
  line-height: 1.45;
}
.code-meta {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: #b8c5d2;
  font-size: 11px;
}

.risk-row {
  margin-bottom: 8px;
  padding: 9px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.055);
  border-left: 3px solid #ff9500;
}
.risk--high {
  border-left-color: var(--danger);
}
.risk-row strong {
  font-size: 13px;
}
.risk-row span {
  color: #ffb86b;
  font-size: 11px;
}
.risk-row p,
.empty-state {
  margin: 6px 0 0;
  color: #91a0ad;
  font-size: 12px;
  line-height: 1.45;
}

.registry-summary {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 9px;
}
.registry-summary div {
  padding: 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.055);
}
.registry-summary span {
  display: block;
  color: #8e9ead;
  font-size: 11px;
}
.registry-summary strong {
  display: block;
  margin-top: 2px;
  color: var(--accent);
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}
.aircraft-list {
  display: grid;
  gap: 6px;
}
.aircraft-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.045);
}
.aircraft-row span {
  min-width: 0;
}
.aircraft-row strong,
.aircraft-row em {
  display: block;
}
.aircraft-row strong {
  font-size: 12px;
}
.aircraft-row em {
  margin-top: 2px;
  overflow: hidden;
  color: #8e9ead;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-style: normal;
  font-size: 11px;
}
.aircraft-row b {
  flex: none;
  align-self: start;
  padding: 2px 6px;
  border-radius: 999px;
  color: #101419;
  background: #aab7c4;
  font-size: 11px;
}
.aircraft--online {
  background: var(--accent-2) !important;
}
.aircraft--standby {
  background: var(--accent) !important;
}
.aircraft--maintenance {
  background: #ff9500 !important;
}

.bottom-dock {
  left: 14px;
  right: 14px;
  bottom: 14px;
  height: 136px;
  display: grid;
  grid-template-columns: 1.2fr 1.05fr 1.05fr 1.45fr;
  gap: 14px;
  padding: 14px;
  box-sizing: border-box;
  z-index: 5;
}
.playback,
.airspace-load,
.trend-card,
.dock-card,
.layer-controls,
.render-controls {
  min-width: 0;
}
.playback {
  display: grid;
  grid-template-columns: repeat(3, max-content);
  align-content: start;
  gap: 8px;
}
.industry-cards {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
}
.industry-cards--dock {
  grid-column: auto;
  height: 82px;
}
.industry-card {
  min-width: 0;
  padding: 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.055);
  border: 1px solid rgba(255, 255, 255, 0.07);
}
.industry-card span,
.industry-card em {
  display: block;
  font-size: 11px;
}
.industry-card span {
  color: #8e9ead;
}
.industry-card strong {
  display: block;
  margin: 2px 0;
  color: #f6fbff;
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}
.industry-card em {
  color: var(--accent-2);
  font-style: normal;
}
.industry-card--warn em {
  color: #ff9500;
}
.industry-card--neutral em {
  color: #9fb2c5;
}
.dock-note {
  grid-column: 1 / -1;
  color: #91a0ad;
  font-size: 11px;
}
.dock-title {
  margin-bottom: 9px;
  color: color-mix(in srgb, var(--accent) 58%, #d9f2ff 42%);
  font-size: 12px;
  font-weight: 700;
}
.dock-card {
  min-height: 0;
  padding: 0;
  border: 0;
  background: transparent;
}
.dock-card p {
  margin: 8px 0 0;
  color: #8e9ead;
  font-size: 11px;
  line-height: 1.4;
}
.compact-rule-list,
.step-strip,
.chain-inline {
  display: grid;
  gap: 7px;
}
.compact-rule-list {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.step-strip,
.chain-inline {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
.capacity-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 7px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  font-size: 11px;
}
.capacity-row span {
  min-width: 0;
  overflow: hidden;
  color: #c5d2df;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.load-row {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) 48px;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 11px;
}
.load-row span {
  overflow: hidden;
  color: #c5d2df;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.load-row i {
  height: 5px;
  overflow: hidden;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.12);
}
.load-row b {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--accent), #ffd60a, #ff453a);
}
.load-row em {
  color: #8e9ead;
  font-style: normal;
  text-align: right;
}
.trend-chart {
  height: 92px;
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  align-items: end;
  gap: 8px;
}
.trend-bar {
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-items: end;
  gap: 3px;
  height: 92px;
  position: relative;
  padding-bottom: 18px;
}
.trend-bar span {
  display: block;
  border-radius: 3px 3px 0 0;
}
.trend-bar__sorties {
  background: linear-gradient(180deg, var(--accent), rgba(var(--accent-rgb), 0.35));
}
.trend-bar__approvals {
  background: linear-gradient(180deg, var(--accent-2), rgba(var(--accent-2-rgb), 0.32));
}
.trend-bar em {
  position: absolute;
  left: 50%;
  bottom: 0;
  color: #8e9ead;
  transform: translateX(-50%);
  font-style: normal;
  font-size: 10px;
}
.layer-controls {
  display: grid;
  grid-template-columns: repeat(3, minmax(74px, 1fr));
  gap: 7px 10px;
  align-content: center;
}
.layer-controls label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #c5d2df;
}
.render-controls {
  display: grid;
  grid-template-columns: 1fr 122px 86px minmax(130px, 1fr) 92px;
  gap: 10px;
  align-items: center;
}
.render-controls .layer-controls {
  grid-row: span 2;
}
.level-select {
  width: 86px;
}
.opacity-control {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  color: #c5d2df;
  font-size: 12px;
}
.opacity-control--muted {
  opacity: 0.55;
}

:deep(.el-button) {
  font-weight: 700;
}
:deep(.el-button.is-plain) {
  background: rgba(255, 255, 255, 0.045);
  border-color: rgba(160, 184, 204, 0.28);
  color: #d7e6f5;
}
:deep(.el-radio-group) {
  width: 100%;
}
:deep(.el-radio-button__inner) {
  width: 61px;
  background: rgba(255, 255, 255, 0.045);
  border-color: rgba(160, 184, 204, 0.25);
  color: #c7d5e3;
}
:deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
  background: rgba(var(--accent-rgb), 0.26);
  border-color: rgba(var(--accent-rgb), 0.72);
  color: #ffffff;
}
:deep(.el-select__wrapper) {
  background: rgba(255, 255, 255, 0.045);
  box-shadow: 0 0 0 1px rgba(160, 184, 204, 0.25) inset;
}
:deep(.el-select__selected-item),
:deep(.el-select__placeholder) {
  color: #d7e6f5;
}
:deep(.el-slider__runway) {
  background: rgba(255, 255, 255, 0.14);
}
:deep(.el-slider__bar) {
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
}
:deep(.el-slider__button) {
  background: #121820;
  border-color: var(--accent-2);
}
:deep(.el-progress-bar__outer) {
  background: rgba(255, 255, 255, 0.12);
}
:deep(.el-progress-bar__inner) {
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
}

@media (max-width: 1120px) {
  .topbar {
    gap: 10px;
  }
  .brand {
    flex-basis: 300px;
  }
  .brand p {
    max-width: 220px;
  }
  .brand__badge {
    display: none;
  }
  .kpis {
    display: none;
  }
  .module-tabs {
    display: flex;
  }
  .module-tab {
    min-width: 64px;
    padding: 0 6px;
    font-size: 11px;
  }
  .module-tab__sub {
    display: none;
  }
  .module-banner {
    left: 328px;
    right: 344px;
  }
  .left-rail {
    width: 300px;
  }
  .right-rail {
    width: 330px;
  }
  .bottom-dock {
    grid-template-columns: 1fr 1fr;
  }
  .trend-card,
  .render-controls {
    grid-column: 1 / -1;
  }
  .render-controls {
    grid-template-columns: 1fr 122px 86px minmax(130px, 1fr) 92px;
  }
}
</style>
