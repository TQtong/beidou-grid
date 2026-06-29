<script setup lang="ts">
// ============================================================
// App.vue — 北斗网格 · 低空空域管制台（四场景，单文件）
// 共享一个 BeiDouFieldScene 引擎核心，顶栏 tab 在四个专业场景间切换：
//   ① SUB 空域剖分  ② ISO 网格隔离  ③ COR 航路时窗  ④ TRK 实时航迹
// 业务逻辑全部走 grid-workflows 纯函数；视觉效果只走引擎既有 API。
// ============================================================
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  clearActiveMissionInfluence,
  clearGridOverlays,
  clearSelections,
  dispose,
  flyToBBox,
  flyToPoint,
  getActiveLevel,
  init,
  isDroneRunning,
  loadBoundary,
  onCursorReadout,
  onGridPick,
  setBoundaryVisible,
  setDroneAltitude,
  setDroneInfluenceRadius,
  setDroneOrbitRadius,
  setDroneSpeed,
  setFillOpacity,
  setGivenRange,
  setGridOverlays,
  setLevelOverride,
  setMode,
  startDrone,
  stopDrone,
  SIMAO_DISTRICT_BOUNDARY_URL,
  SIMAO_OPERATION_CENTER,
  type CursorReadout,
  type GridOverlayInput,
  type PickedGridInfo,
} from './index'
import {
  LOW_ALTITUDE_MISSIONS,
  SIMAO_BBOX,
  scenarioById,
  type LowAltitudeMission,
} from './low-altitude-data'
import {
  assignTimeWindows,
  codeAt,
  detectConflicts,
  formatRelSec,
  gridifyRoute,
  isolationCells,
  levelForAircraftSize,
  routeLengthMeters,
  type GridConflict,
  type TimeWindowCell,
} from './grid-workflows'

// ──────────────────────────────────────────────
// 场景定义
// ──────────────────────────────────────────────
type ScenarioId = 'sub' | 'iso' | 'cor' | 'trk'

const SCENARIO_TABS: { id: ScenarioId; code: string; name: string }[] = [
  { id: 'sub', code: 'SUB', name: '空域剖分' },
  { id: 'iso', code: 'ISO', name: '网格隔离' },
  { id: 'cor', code: 'COR', name: '航路时窗' },
  { id: 'trk', code: 'TRK', name: '实时航迹' },
]
const SCENARIO_NAME: Record<ScenarioId, string> = {
  sub: '空域剖分',
  iso: '网格隔离',
  cor: '航路时窗',
  trk: '实时航迹',
}

const activeScenario = ref<ScenarioId>('sub')

// ──────────────────────────────────────────────
// 共享渲染状态
// ──────────────────────────────────────────────
const renderMode = ref<'wire' | 'fill'>('wire')
const fillOpacity = ref(40) // 0..100，传引擎 /100
const levelMode = ref<number | 'auto'>('auto') // 'auto' → setLevelOverride(undefined)
const activeLevel = ref(5) // 由 getActiveLevel() 轮询刷新
const showBoundary = ref(true)
const cursor = ref<CursorReadout | undefined>()
const pinnedGrids = ref<PickedGridInfo[]>([]) // 拾取钉入，最多 8 条
const lastPick = ref<PickedGridInfo | undefined>()

// 共享 watcher
watch(renderMode, (m) => setMode(m))
watch(fillOpacity, (v) => setFillOpacity(v / 100))
watch(levelMode, (v) => setLevelOverride(v === 'auto' ? undefined : v))
watch(showBoundary, (v) => setBoundaryVisible(v))

// 单格边长查表（UI 展示用，索引 = level）
const CELL_SIZE_LABEL: (string | null)[] = [
  null, '~110km', '~28km', '~6.9km', '~1.7km', '~430m', '~110m', '~27m', '~6.7m', '~1.7m', '~42cm',
]
const cellSizeLabel = computed(() => CELL_SIZE_LABEL[activeLevel.value] ?? '—')

const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const

// ──────────────────────────────────────────────
// 拾取 / 钉入
// ──────────────────────────────────────────────
const togglePin = (info: PickedGridInfo): void => {
  const idx = pinnedGrids.value.findIndex((g) => g.code3D === info.code3D)
  if (idx >= 0) {
    pinnedGrids.value = pinnedGrids.value.filter((_, i) => i !== idx)
    return
  }
  pinnedGrids.value = [info, ...pinnedGrids.value].slice(0, 8)
}
const removePin = (code3D: string): void => {
  pinnedGrids.value = pinnedGrids.value.filter((g) => g.code3D !== code3D)
}
const clearPicks = (): void => {
  clearSelections()
  pinnedGrids.value = []
  lastPick.value = undefined
}

// 签名 HUD：光标网格读数
const cursorCode = computed(() =>
  cursor.value
    ? codeAt(
        cursor.value.lonDeg,
        cursor.value.latDeg,
        Math.max(0, cursor.value.heightMeters),
        activeLevel.value,
      )
    : undefined,
)

// ──────────────────────────────────────────────
// 格式化工具
// ──────────────────────────────────────────────
const fmtLon = (v: number): string => `${Math.abs(v).toFixed(5)}°${v >= 0 ? 'E' : 'W'}`
const fmtLat = (v: number): string => `${Math.abs(v).toFixed(5)}°${v >= 0 ? 'N' : 'S'}`
const fmtH = (v: number): string => `${v.toFixed(1)} m`

const clock = ref('--:--:--')
const formatClock = (): string => {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// ──────────────────────────────────────────────
// 场景②：网格隔离
// ──────────────────────────────────────────────
interface Obstacle {
  id: string
  name: string
  kind: 'building' | 'tower' | 'school' | 'fuel' | 'airport'
  lon: number
  lat: number
  baseHeight: number
  topHeight: number
  radius: number
  level: number
  overlayKind: 'no-fly' | 'restricted'
}
const OBSTACLE_KIND_LABEL: Record<Obstacle['kind'], string> = {
  building: '高层建筑',
  tower: '通信铁塔',
  school: '学校',
  fuel: '加油加气',
  airport: '机场净空',
}
const OBSTACLES: Obstacle[] = [
  { id: 'obs-tower', name: '思茅广电发射铁塔', kind: 'tower', lon: 100.974, lat: 22.786, baseHeight: 0, topHeight: 220, radius: 90, level: 6, overlayKind: 'no-fly' },
  { id: 'obs-build', name: '城区高层建筑群', kind: 'building', lon: 100.99, lat: 22.776, baseHeight: 0, topHeight: 160, radius: 160, level: 5, overlayKind: 'restricted' },
  { id: 'obs-school', name: '思茅第一中学', kind: 'school', lon: 100.968, lat: 22.77, baseHeight: 0, topHeight: 120, radius: 200, level: 5, overlayKind: 'restricted' },
  { id: 'obs-fuel', name: '城南加油加气站', kind: 'fuel', lon: 101.004, lat: 22.764, baseHeight: 0, topHeight: 100, radius: 140, level: 6, overlayKind: 'no-fly' },
  { id: 'obs-airport', name: '机场净空保护区', kind: 'airport', lon: 100.958, lat: 22.793, baseHeight: 0, topHeight: 600, radius: 1500, level: 4, overlayKind: 'no-fly' },
]
const activeObstacles = ref<Set<string>>(new Set(OBSTACLES.map((o) => o.id)))
const isolationStats = ref<Record<string, number>>({})

const applyIsolation = (): void => {
  const overlays: GridOverlayInput[] = []
  const stats: Record<string, number> = {}
  for (const obs of OBSTACLES) {
    if (!activeObstacles.value.has(obs.id)) continue
    const cells = isolationCells(obs.lon, obs.lat, obs.baseHeight, obs.topHeight, obs.radius, obs.level)
    stats[obs.id] = cells.length
    for (const c of cells) {
      overlays.push({
        lonDeg: c.lonDeg,
        latDeg: c.latDeg,
        heightMeters: c.heightMeters,
        radiusMeters: 1,
        kind: obs.overlayKind,
      })
    }
  }
  isolationStats.value = stats
  setGridOverlays(overlays)
}
const toggleObstacle = (id: string): void => {
  const next = new Set(activeObstacles.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  activeObstacles.value = next
  if (activeScenario.value === 'iso') applyIsolation()
}
const focusObstacle = (obs: Obstacle): void => {
  flyToPoint(obs.lon, obs.lat, obs.topHeight, 3200, 1.2)
}
const isolationTotal = computed(() =>
  OBSTACLES.reduce(
    (sum, o) => (activeObstacles.value.has(o.id) ? sum + (isolationStats.value[o.id] ?? 0) : sum),
    0,
  ),
)

// ──────────────────────────────────────────────
// 场景③：航路时窗
// ──────────────────────────────────────────────
interface FlightPlan {
  id: string
  name: string
  mission: LowAltitudeMission
  speedMps: number
  startSec: number
  level: number
  color: string
}
const flightPlans = ref<FlightPlan[]>(
  LOW_ALTITUDE_MISSIONS.slice(0, 3).map((m, i) => ({
    id: m.id,
    name: m.name,
    mission: m,
    speedMps: m.aircraftType === 'helicopter' ? 28 : m.aircraftType === 'evtol' ? 36 : 16,
    startSec: i * 90,
    level: 6,
    color: scenarioById(m.scenario).color,
  })),
)
const selectedPlanId = ref(flightPlans.value[0]?.id ?? '')
const corridorLevel = ref(6)
const CORRIDOR_LEVELS = [5, 6, 7] as const

const planSequences = computed<Record<string, TimeWindowCell[]>>(() =>
  Object.fromEntries(
    flightPlans.value.map((p) => {
      const cells = gridifyRoute(p.mission.route, corridorLevel.value, 7)
      return [p.id, assignTimeWindows(cells, p.mission.route, p.speedMps, p.startSec)]
    }),
  ),
)
const conflicts = computed<GridConflict[]>(() =>
  detectConflicts(
    flightPlans.value.map((p) => ({ planId: p.id, cells: planSequences.value[p.id] ?? [] })),
    1800,
  ),
)
const conflictCodeSet = computed(() => new Set(conflicts.value.map((c) => c.code3D)))
const selectedPlan = computed(() => flightPlans.value.find((p) => p.id === selectedPlanId.value))
const selectedSequence = computed<TimeWindowCell[]>(
  () => planSequences.value[selectedPlanId.value] ?? [],
)

const planCellCount = (id: string): number => planSequences.value[id]?.length ?? 0
const planNameById = (id: string): string => flightPlans.value.find((p) => p.id === id)?.name ?? id

const selectedRouteKm = computed(() =>
  selectedPlan.value ? routeLengthMeters(selectedPlan.value.mission.route) / 1000 : 0,
)
const selectedDurationSec = computed(() => {
  const seq = selectedSequence.value
  if (seq.length === 0) return 0
  return (seq[seq.length - 1]!.exitSec) - (seq[0]!.enterSec)
})

const applyCorridor = (): void => {
  const overlays: GridOverlayInput[] = []
  const conflictCodes = conflictCodeSet.value
  for (const plan of flightPlans.value) {
    for (const cell of planSequences.value[plan.id] ?? []) {
      overlays.push({
        lonDeg: cell.lonDeg,
        latDeg: cell.latDeg,
        heightMeters: cell.heightMeters,
        radiusMeters: 1,
        kind: conflictCodes.has(cell.code3D) ? 'risk-high' : 'corridor',
      })
    }
  }
  setGridOverlays(overlays)
}
watch([corridorLevel, conflicts], () => {
  if (activeScenario.value === 'cor') applyCorridor()
})

const focusPlan = (plan: FlightPlan): void => {
  selectedPlanId.value = plan.id
  const start = plan.mission.route[0]
  if (start) flyToPoint(start.lon, start.lat, start.height, 4200, 1.2)
}

// ──────────────────────────────────────────────
// 场景④：实时航迹
// ──────────────────────────────────────────────
type TrackAircraft = 'micro' | 'small' | 'large'
const aircraftSizes: Record<TrackAircraft, { label: string; size: number; radius: number; alt: number }> = {
  micro: { label: '微型无人机', size: 0.4, radius: 120, alt: 90 },
  small: { label: '小型无人机', size: 3, radius: 240, alt: 150 },
  large: { label: '大型无人机/eVTOL', size: 12, radius: 420, alt: 220 },
}
const TRACK_ORDER: TrackAircraft[] = ['micro', 'small', 'large']
const trackAircraft = ref<TrackAircraft>('small')
const droneFlying = ref(false)
const trackLevel = computed(() => levelForAircraftSize(aircraftSizes[trackAircraft.value].size))

const applyDroneConfig = (): void => {
  const a = aircraftSizes[trackAircraft.value]
  setDroneAltitude(a.alt)
  setDroneInfluenceRadius(a.radius)
  setDroneOrbitRadius(a.radius * 3.2)
  setDroneSpeed(0.18)
  setLevelOverride(trackLevel.value)
  levelMode.value = trackLevel.value
}
const selectAircraft = (t: TrackAircraft): void => {
  if (trackAircraft.value === t) return
  trackAircraft.value = t
  if (droneFlying.value) applyDroneConfig()
}
const toggleDrone = (): void => {
  if (droneFlying.value) {
    stopDrone()
    droneFlying.value = false
    return
  }
  applyDroneConfig()
  startDrone(SIMAO_OPERATION_CENTER.lon, SIMAO_OPERATION_CENTER.lat)
  droneFlying.value = true
}

// ──────────────────────────────────────────────
// 场景编排
// ──────────────────────────────────────────────
const applyScenario = (id: ScenarioId): void => {
  // 复位共享渲染状态
  clearGridOverlays()
  clearActiveMissionInfluence()
  if (isDroneRunning()) {
    stopDrone()
    droneFlying.value = false
  }

  if (id === 'sub') {
    setMode(renderMode.value)
    setGivenRange(NaN, NaN, NaN, NaN)
  } else if (id === 'iso') {
    renderMode.value = 'fill'
    setMode('fill')
    setFillOpacity(fillOpacity.value / 100)
    applyIsolation()
  } else if (id === 'cor') {
    renderMode.value = 'fill'
    setMode('fill')
    setFillOpacity(fillOpacity.value / 100)
    applyCorridor()
  } else if (id === 'trk') {
    renderMode.value = 'wire'
    setMode('wire')
  }
}
const selectScenario = (id: ScenarioId): void => {
  if (id === activeScenario.value) return
  activeScenario.value = id
  pinnedGrids.value = []
  lastPick.value = undefined
  applyScenario(id)
}

// 区域快捷定位
const flyUrbanCenter = (): void => {
  flyToPoint(SIMAO_OPERATION_CENTER.lon, SIMAO_OPERATION_CENTER.lat, 0, 6000, 1.2)
}
const flyDistrict = (): void => {
  flyToBBox(SIMAO_BBOX.west, SIMAO_BBOX.south, SIMAO_BBOX.east, SIMAO_BBOX.north, 1.4)
}

// ──────────────────────────────────────────────
// 状态条派生
// ──────────────────────────────────────────────
const levelText = computed(() => (levelMode.value === 'auto' ? `AUTO·L${activeLevel.value}` : `L${activeLevel.value}`))
const modeText = computed(() => (renderMode.value === 'fill' ? '填充' : '线框'))

// ──────────────────────────────────────────────
// 生命周期
// ──────────────────────────────────────────────
const mapRef = ref<HTMLDivElement | null>(null)
let clockTimer: number | undefined
let levelTimer: number | undefined
let unGridPick: (() => void) | undefined
let unCursor: (() => void) | undefined

onMounted(async () => {
  const el = mapRef.value
  if (!el) return
  init(el)
  unGridPick = onGridPick((info) => {
    lastPick.value = info
    if (info) togglePin(info)
  })
  unCursor = onCursorReadout((r) => {
    cursor.value = r
  })
  setMode(renderMode.value)
  setFillOpacity(fillOpacity.value / 100)
  setLevelOverride(undefined)
  await loadBoundary(SIMAO_DISTRICT_BOUNDARY_URL, { flyTo: false }).catch(() => {})
  setBoundaryVisible(showBoundary.value)
  applyScenario(activeScenario.value)
  clock.value = formatClock()
  clockTimer = window.setInterval(() => {
    clock.value = formatClock()
  }, 1000)
  levelTimer = window.setInterval(() => {
    activeLevel.value = getActiveLevel()
  }, 500)
})

onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer)
  if (levelTimer) clearInterval(levelTimer)
  unGridPick?.()
  unCursor?.()
  dispose()
})
</script>

<template>
  <div class="console">
    <!-- 作战图（Cesium 容器，铺满，主角） -->
    <div ref="mapRef" class="map"></div>

    <!-- 顶栏 -->
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">北斗网格</span>
        <span class="brand-sub">低空空域管制台</span>
      </div>
      <nav class="tabs">
        <button
          v-for="tab in SCENARIO_TABS"
          :key="tab.id"
          class="tab"
          :class="{ active: activeScenario === tab.id }"
          type="button"
          @click="selectScenario(tab.id)"
        >
          <span class="tab-code">{{ tab.code }}</span>
          <span class="tab-name">{{ tab.name }}</span>
        </button>
      </nav>
      <div class="topbar-right">
        <div class="region-btns">
          <button class="region-btn" type="button" @click="flyUrbanCenter">主城区</button>
          <button class="region-btn" type="button" @click="flyDistrict">全域</button>
        </div>
        <div class="clock mono">{{ clock }}</div>
      </div>
    </header>

    <!-- 左作业栏 -->
    <aside class="rail rail-left">
      <!-- 场景①：空域剖分 -->
      <template v-if="activeScenario === 'sub'">
        <section class="panel">
          <div class="panel-head">
            <span class="panel-title">剖分级别</span>
            <span class="panel-tag mono">L{{ activeLevel }}</span>
          </div>
          <div class="seg seg-levels">
            <button
              class="seg-btn"
              :class="{ active: levelMode === 'auto' }"
              type="button"
              @click="levelMode = 'auto'"
            >
              AUTO
            </button>
            <button
              v-for="lv in LEVELS"
              :key="lv"
              class="seg-btn mono"
              :class="{ active: levelMode === lv }"
              type="button"
              @click="levelMode = lv"
            >
              L{{ lv }}
            </button>
          </div>
          <p class="panel-note">AUTO 模式下级别随地图比例尺联动；锁定后固定不变。</p>
        </section>

        <section class="panel">
          <div class="panel-head"><span class="panel-title">渲染</span></div>
          <div class="seg">
            <button
              class="seg-btn"
              :class="{ active: renderMode === 'wire' }"
              type="button"
              @click="renderMode = 'wire'"
            >
              线框
            </button>
            <button
              class="seg-btn"
              :class="{ active: renderMode === 'fill' }"
              type="button"
              @click="renderMode = 'fill'"
            >
              填充
            </button>
          </div>
          <div v-if="renderMode === 'fill'" class="field">
            <label class="field-label">
              <span>不透明度</span>
              <span class="mono">{{ fillOpacity }}%</span>
            </label>
            <input v-model.number="fillOpacity" class="slider" type="range" min="0" max="100" />
          </div>
          <label class="check">
            <input v-model="showBoundary" type="checkbox" />
            <span>显示行政边界</span>
          </label>
        </section>

        <section class="panel">
          <div class="panel-head"><span class="panel-title">逐格拾取</span></div>
          <p class="panel-note">单击作战图立方体循环改色，并钉入右栏读数。</p>
          <dl class="ledger">
            <div class="ledger-row">
              <dt>当前级别</dt>
              <dd class="mono">L{{ activeLevel }}</dd>
            </div>
            <div class="ledger-row">
              <dt>单格边长</dt>
              <dd class="mono">{{ cellSizeLabel }}</dd>
            </div>
            <div class="ledger-row">
              <dt>已钉网格</dt>
              <dd class="mono">{{ pinnedGrids.length }} / 8</dd>
            </div>
          </dl>
          <button class="btn-line" type="button" @click="clearPicks">清空选中</button>
        </section>
      </template>

      <!-- 场景②：网格隔离 -->
      <template v-else-if="activeScenario === 'iso'">
        <section class="panel">
          <div class="panel-head"><span class="panel-title">渲染</span></div>
          <div class="field">
            <label class="field-label">
              <span>填充不透明度</span>
              <span class="mono">{{ fillOpacity }}%</span>
            </label>
            <input v-model.number="fillOpacity" class="slider" type="range" min="0" max="100" />
          </div>
        </section>

        <section class="panel panel-grow">
          <div class="panel-head">
            <span class="panel-title">隔离目标</span>
            <span class="panel-tag mono">{{ activeObstacles.size }}/{{ OBSTACLES.length }}</span>
          </div>
          <ul class="obstacle-list">
            <li
              v-for="obs in OBSTACLES"
              :key="obs.id"
              class="obstacle"
              :class="{ off: !activeObstacles.has(obs.id) }"
            >
              <button
                class="dot-toggle"
                :class="obs.overlayKind === 'no-fly' ? 'is-nofly' : 'is-restricted'"
                type="button"
                :aria-pressed="activeObstacles.has(obs.id)"
                @click="toggleObstacle(obs.id)"
              ></button>
              <div class="obstacle-body" @click="focusObstacle(obs)">
                <div class="obstacle-top">
                  <span class="obstacle-name">{{ obs.name }}</span>
                  <span class="pill" :class="obs.overlayKind === 'no-fly' ? 'pill-nofly' : 'pill-restricted'">
                    {{ obs.overlayKind === 'no-fly' ? '禁飞' : '限飞' }}
                  </span>
                </div>
                <div class="obstacle-meta mono">
                  {{ OBSTACLE_KIND_LABEL[obs.kind] }}·L{{ obs.level }}·{{ obs.topHeight }}m·{{ isolationStats[obs.id] ?? 0 }}格
                </div>
              </div>
            </li>
          </ul>
        </section>

        <section class="panel">
          <dl class="ledger">
            <div class="ledger-row strong">
              <dt>隔离网格合计</dt>
              <dd class="mono phos">{{ isolationTotal }} 格</dd>
            </div>
          </dl>
        </section>
      </template>

      <!-- 场景③：航路时窗 -->
      <template v-else-if="activeScenario === 'cor'">
        <section class="panel">
          <div class="panel-head"><span class="panel-title">航路网格级别</span></div>
          <div class="seg">
            <button
              v-for="lv in CORRIDOR_LEVELS"
              :key="lv"
              class="seg-btn mono"
              :class="{ active: corridorLevel === lv }"
              type="button"
              @click="corridorLevel = lv"
            >
              L{{ lv }}
            </button>
          </div>
          <p class="panel-note">级别越高网格越细，时窗序列越密。</p>
        </section>

        <section class="panel panel-grow">
          <div class="panel-head">
            <span class="panel-title">飞行计划</span>
            <span class="panel-tag mono">{{ flightPlans.length }}</span>
          </div>
          <ul class="plan-list">
            <li
              v-for="plan in flightPlans"
              :key="plan.id"
              class="plan"
              :class="{ active: selectedPlanId === plan.id }"
              @click="focusPlan(plan)"
            >
              <span class="plan-dot" :style="{ background: plan.color }"></span>
              <div class="plan-body">
                <div class="plan-name">{{ plan.name }}</div>
                <div class="plan-meta mono">
                  起飞+{{ plan.startSec }}·{{ plan.speedMps }}m/s·{{ planCellCount(plan.id) }}格
                </div>
              </div>
            </li>
          </ul>
        </section>

        <section class="panel">
          <div class="panel-head"><span class="panel-title">冲突检测</span></div>
          <div v-if="conflicts.length === 0" class="verdict verdict-ok">
            <span class="verdict-dot"></span>
            <span>可放行 · 无同格同窗冲突</span>
          </div>
          <div v-else class="verdict verdict-bad">
            <span class="verdict-dot"></span>
            <span>{{ conflicts.length }} 处冲突需调整</span>
          </div>
        </section>
      </template>

      <!-- 场景④：实时航迹 -->
      <template v-else>
        <section class="panel">
          <div class="panel-head"><span class="panel-title">机型 → 层级</span></div>
          <div class="aircraft-list">
            <button
              v-for="key in TRACK_ORDER"
              :key="key"
              class="aircraft"
              :class="{ active: trackAircraft === key }"
              type="button"
              @click="selectAircraft(key)"
            >
              <span class="aircraft-name">{{ aircraftSizes[key].label }}</span>
              <span class="aircraft-map mono">
                ≤{{ aircraftSizes[key].size }}m → L{{ levelForAircraftSize(aircraftSizes[key].size) }}
              </span>
            </button>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><span class="panel-title">飞行模拟</span></div>
          <button
            class="btn-block"
            :class="droneFlying ? 'is-stop' : 'is-go'"
            type="button"
            @click="toggleDrone"
          >
            {{ droneFlying ? '■ 降落' : '▶ 起飞' }}
          </button>
        </section>

        <section class="panel">
          <div class="panel-head"><span class="panel-title">运行遥测</span></div>
          <dl class="ledger">
            <div class="ledger-row">
              <dt>状态</dt>
              <dd class="mono" :class="droneFlying ? 'phos' : ''">{{ droneFlying ? '巡航中' : '待命' }}</dd>
            </div>
            <div class="ledger-row">
              <dt>所在格级别</dt>
              <dd class="mono">L{{ trackLevel }}</dd>
            </div>
            <div class="ledger-row">
              <dt>影响半径</dt>
              <dd class="mono">{{ aircraftSizes[trackAircraft].radius }} m</dd>
            </div>
            <div class="ledger-row">
              <dt>巡航高度</dt>
              <dd class="mono">{{ aircraftSizes[trackAircraft].alt }} m</dd>
            </div>
          </dl>
        </section>
      </template>
    </aside>

    <!-- 右读数栏 -->
    <aside class="rail rail-right">
      <!-- 场景③：序列检视 -->
      <template v-if="activeScenario === 'cor'">
        <section class="panel">
          <div class="panel-head">
            <span class="panel-title">序列检视</span>
            <span class="panel-tag">{{ selectedPlan?.name ?? '—' }}</span>
          </div>
          <dl class="ledger">
            <div class="ledger-row">
              <dt>航路长度</dt>
              <dd class="mono">{{ selectedRouteKm.toFixed(2) }} km</dd>
            </div>
            <div class="ledger-row">
              <dt>网格数</dt>
              <dd class="mono">{{ selectedSequence.length }}</dd>
            </div>
            <div class="ledger-row">
              <dt>总耗时</dt>
              <dd class="mono">{{ formatRelSec(selectedDurationSec) }}</dd>
            </div>
          </dl>
        </section>

        <section class="panel panel-grow seq-panel">
          <div class="panel-head"><span class="panel-title">三维网格码序列</span></div>
          <div class="seq-table">
            <div class="seq-head mono">
              <span class="c-idx">#</span>
              <span class="c-code">网格三维码</span>
              <span class="c-in">进入</span>
              <span class="c-out">离开</span>
            </div>
            <div class="seq-body">
              <div
                v-for="cell in selectedSequence"
                :key="cell.code3D"
                class="seq-row mono"
                :class="{ conflict: conflictCodeSet.has(cell.code3D) }"
              >
                <span class="c-idx">{{ cell.index }}</span>
                <span class="c-code">{{ cell.code3D }}</span>
                <span class="c-in">{{ formatRelSec(cell.enterSec) }}</span>
                <span class="c-out">{{ formatRelSec(cell.exitSec) }}</span>
              </div>
              <div v-if="selectedSequence.length === 0" class="seq-empty">无序列数据</div>
            </div>
          </div>
        </section>

        <section v-if="conflicts.length > 0" class="panel">
          <div class="panel-head">
            <span class="panel-title">冲突明细</span>
            <span class="panel-tag mono bad">{{ conflicts.length }}</span>
          </div>
          <ul class="conflict-list">
            <li v-for="(c, i) in conflicts.slice(0, 6)" :key="c.code3D + i" class="conflict-item">
              <div class="conflict-code mono">{{ c.code3D }}</div>
              <div class="conflict-pair">{{ planNameById(c.planA) }} ⇄ {{ planNameById(c.planB) }}</div>
              <div class="conflict-win mono">
                重叠 {{ formatRelSec(c.overlapStartSec) }}–{{ formatRelSec(c.overlapEndSec) }}
              </div>
            </li>
          </ul>
        </section>
      </template>

      <!-- 场景①②④：拾取检视 -->
      <template v-else>
        <section class="panel">
          <div class="panel-head"><span class="panel-title">最近拾取</span></div>
          <div v-if="lastPick" class="pick-card">
            <div class="pick-3d mono phos">{{ lastPick.code3D }}</div>
            <div class="pick-2d mono">{{ lastPick.code2D }}</div>
            <div class="pick-grid">
              <div class="pick-cell">
                <span class="pick-k">级别</span>
                <span class="pick-v mono">L{{ lastPick.level }}</span>
              </div>
              <div class="pick-cell">
                <span class="pick-k">经度</span>
                <span class="pick-v mono">{{ fmtLon(lastPick.center.lonDeg) }}</span>
              </div>
              <div class="pick-cell">
                <span class="pick-k">纬度</span>
                <span class="pick-v mono">{{ fmtLat(lastPick.center.latDeg) }}</span>
              </div>
              <div class="pick-cell">
                <span class="pick-k">高程</span>
                <span class="pick-v mono">{{ fmtH(lastPick.center.heightMeters) }}</span>
              </div>
            </div>
          </div>
          <div v-else class="pick-empty">
            <p>移动光标看左下十字丝读数</p>
            <p class="dim">单击作战图立方体钉入网格</p>
          </div>
        </section>

        <section class="panel panel-grow">
          <div class="panel-head">
            <span class="panel-title">已钉网格</span>
            <span class="panel-tag mono">{{ pinnedGrids.length }}</span>
          </div>
          <ul class="pin-list">
            <li v-for="grid in pinnedGrids" :key="grid.code3D" class="pin">
              <div class="pin-body">
                <div class="pin-code mono phos">{{ grid.code3D }}</div>
                <div class="pin-meta mono">
                  L{{ grid.level }}·{{ fmtLon(grid.center.lonDeg) }} {{ fmtLat(grid.center.latDeg) }}
                </div>
              </div>
              <button class="pin-del" type="button" @click="removePin(grid.code3D)">×</button>
            </li>
            <li v-if="pinnedGrids.length === 0" class="pin-empty">尚无钉入网格</li>
          </ul>
        </section>
      </template>
    </aside>

    <!-- 签名：网格读数十字丝 HUD -->
    <div class="reticle" :class="{ live: !!cursor }">
      <div class="reticle-cross">
        <span class="cross-h"></span>
        <span class="cross-v"></span>
        <span class="cross-dot"></span>
      </div>
      <div class="reticle-panel">
        <div class="reticle-label mono">光标网格读数 · L{{ activeLevel }}</div>
        <template v-if="cursorCode">
          <div class="reticle-code mono">{{ cursorCode.code3D }}</div>
          <div class="reticle-coords mono">
            {{ fmtLon(cursorCode.lonDeg) }} · {{ fmtLat(cursorCode.latDeg) }} · {{ fmtH(cursorCode.heightMeters) }}
          </div>
        </template>
        <div v-else class="reticle-idle mono">移入作战图取读数</div>
      </div>
    </div>

    <!-- 底状态条 -->
    <footer class="statusbar mono">
      <span class="status-item">级别 <b>{{ levelText }}</b></span>
      <span class="status-sep">|</span>
      <span class="status-item">模式 <b>{{ modeText }}</b></span>
      <span class="status-sep">|</span>
      <span class="status-item">场景 <b>{{ SCENARIO_NAME[activeScenario] }}</b></span>
      <span class="status-sep">|</span>
      <span v-if="activeScenario === 'sub'" class="status-item">单格 <b>{{ cellSizeLabel }}</b></span>
      <span v-else-if="activeScenario === 'iso'" class="status-item">隔离 <b>{{ isolationTotal }} 格</b></span>
      <span v-else-if="activeScenario === 'cor'" class="status-item">
        冲突 <b :class="{ bad: conflicts.length > 0 }">{{ conflicts.length }}</b>
      </span>
      <span v-else class="status-item">航迹 <b :class="{ phos: droneFlying }">{{ droneFlying ? '巡航中' : '待命' }}</b></span>

      <span class="status-spacer"></span>

      <span v-if="cursor" class="status-item">
        坐标 <b>{{ fmtLon(cursor.lonDeg) }} {{ fmtLat(cursor.latDeg) }}</b>
      </span>
      <span v-else class="status-item dim">坐标 待命</span>
      <span class="status-sep">|</span>
      <span class="status-item dim">基准 CGCS2000 / GeoSOT</span>
    </footer>
  </div>
</template>

<style>
/* ============================================================
   北斗网格管制台 · 视觉令牌（雷达深空 + 磷光琥珀）
   实心面板 + 1px hairline + 等宽数据 + 单一磷光琥珀强调色。
   禁止：毛玻璃 / 霓虹高饱和 / 多套换肤 / 渐变药丸 / 大圆角。
   ============================================================ */
.console {
  --bg: #0a0e12;
  --panel: #11161c;
  --panel-2: #161d25;
  --line: #243039;
  --line-soft: #1a222a;
  --ink: #c7d2dc;
  --ink-mid: #8d9aa6;
  --ink-dim: #61707c;
  --phosphor: #d8a24a;
  --phosphor-2: #e8c074;
  --phosphor-dim: #9a7438;
  --signal: #c8503a;
  --signal-2: #e0654c;
  --ok: #5a8c6e;
  --info: #4a7a96;

  --display: 'Barlow Semi Condensed', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  --body: 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
  --mono: 'JetBrains Mono', 'DejaVu Sans Mono', ui-monospace, monospace;

  position: fixed;
  inset: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--body);
  font-size: 13px;
  overflow: hidden;
}

.console .mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

/* —— 作战图 —— */
.console .map {
  position: absolute;
  inset: 0;
}
.console .cesium-viewer-bottom,
.console .cesium-widget-credits,
.console .cesium-viewer-toolbar,
.console .cesium-viewer-animationContainer,
.console .cesium-viewer-timelineContainer {
  display: none !important;
}

/* —— 顶栏 —— */
.console .topbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 46px;
  display: flex;
  align-items: stretch;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  z-index: 20;
}
.console .brand {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 16px;
  border-right: 1px solid var(--line);
}
.console .brand-mark {
  font-family: var(--display);
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.5px;
  color: var(--phosphor);
}
.console .brand-sub {
  font-size: 10px;
  color: var(--ink-dim);
  letter-spacing: 1px;
}
.console .tabs {
  display: flex;
  align-items: stretch;
}
.console .tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  min-width: 78px;
  padding: 0 14px;
  background: transparent;
  border: none;
  border-right: 1px solid var(--line-soft);
  border-bottom: 2px solid transparent;
  color: var(--ink-mid);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.console .tab:hover {
  background: var(--panel-2);
  color: var(--ink);
}
.console .tab.active {
  color: var(--phosphor-2);
  border-bottom-color: var(--phosphor);
  box-shadow: inset 0 -10px 18px -14px var(--phosphor);
}
.console .tab-code {
  font-family: var(--display);
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 1px;
}
.console .tab-name {
  font-size: 10px;
  letter-spacing: 0.5px;
}
.console .topbar-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 16px;
}
.console .region-btns {
  display: flex;
  gap: 6px;
}
.console .region-btn {
  padding: 5px 11px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 2px;
  color: var(--ink-mid);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.console .region-btn:hover {
  color: var(--phosphor-2);
  border-color: var(--phosphor-dim);
}
.console .clock {
  font-size: 14px;
  font-weight: 500;
  color: var(--phosphor);
  letter-spacing: 1px;
}

/* —— 两侧 rail —— */
.console .rail {
  position: absolute;
  top: 46px;
  bottom: 28px;
  background: var(--panel);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  overflow-y: auto;
  z-index: 15;
}
.console .rail-left {
  left: 0;
  width: 300px;
  border-right: 1px solid var(--line);
}
.console .rail-right {
  right: 0;
  width: 320px;
  border-left: 1px solid var(--line);
}

/* —— 面板 —— */
.console .panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 11px 12px;
}
.console .panel-grow {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 120px;
}
.console .panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.console .panel-title {
  font-family: var(--display);
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.5px;
  color: var(--ink);
}
.console .panel-tag {
  font-size: 11px;
  color: var(--ink-dim);
  border: 1px solid var(--line);
  border-radius: 2px;
  padding: 1px 6px;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.console .panel-tag.bad {
  color: var(--signal-2);
  border-color: var(--signal);
}
.console .panel-note {
  font-size: 11px;
  line-height: 1.5;
  color: var(--ink-dim);
  margin-top: 8px;
}

/* —— 分段控件 —— */
.console .seg {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.console .seg-levels {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
}
.console .seg-btn {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 8px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 2px;
  color: var(--ink-mid);
  font-size: 12px;
  text-align: center;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.console .seg-btn:hover {
  color: var(--ink);
  border-color: var(--phosphor-dim);
}
.console .seg-btn.active {
  color: var(--phosphor-2);
  border-color: var(--phosphor);
  background: rgba(216, 162, 74, 0.11);
}

/* —— 滑块 / 字段 —— */
.console .field {
  margin-top: 10px;
}
.console .field-label {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--ink-mid);
  margin-bottom: 6px;
}
.console .slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 3px;
  background: var(--line);
  border-radius: 2px;
  outline: none;
}
.console .slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 13px;
  height: 13px;
  border-radius: 2px;
  background: var(--phosphor);
  border: 1px solid var(--phosphor-2);
  cursor: pointer;
}
.console .slider::-moz-range-thumb {
  width: 13px;
  height: 13px;
  border-radius: 2px;
  background: var(--phosphor);
  border: 1px solid var(--phosphor-2);
  cursor: pointer;
}

/* —— checkbox —— */
.console .check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--ink-mid);
  cursor: pointer;
}
.console .check input {
  accent-color: var(--phosphor);
  width: 13px;
  height: 13px;
}

/* —— 账册 —— */
.console .ledger {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.console .ledger-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid var(--line-soft);
  font-size: 12px;
}
.console .ledger-row:last-child {
  border-bottom: none;
}
.console .ledger-row dt {
  color: var(--ink-mid);
}
.console .ledger-row dd {
  color: var(--ink);
}
.console .ledger-row.strong dt {
  color: var(--ink);
  font-weight: 600;
}
.console .phos {
  color: var(--phosphor-2);
}

/* —— 行内按钮 —— */
.console .btn-line {
  margin-top: 10px;
  width: 100%;
  padding: 7px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 2px;
  color: var(--ink-mid);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.console .btn-line:hover {
  color: var(--signal-2);
  border-color: var(--signal);
}
.console .btn-block {
  width: 100%;
  padding: 11px;
  border: 1px solid var(--line);
  border-radius: 2px;
  font-family: var(--display);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 1px;
  cursor: pointer;
  transition: all 0.15s;
}
.console .btn-block.is-go {
  background: rgba(216, 162, 74, 0.12);
  border-color: var(--phosphor);
  color: var(--phosphor-2);
}
.console .btn-block.is-go:hover {
  background: rgba(216, 162, 74, 0.2);
}
.console .btn-block.is-stop {
  background: rgba(200, 80, 58, 0.14);
  border-color: var(--signal);
  color: var(--signal-2);
}
.console .btn-block.is-stop:hover {
  background: rgba(200, 80, 58, 0.22);
}

/* —— 障碍物列表（场景②）—— */
.console .obstacle-list,
.console .plan-list,
.console .pin-list,
.console .aircraft-list,
.console .conflict-list {
  list-style: none;
  display: flex;
  flex-direction: column;
}
.console .panel-grow .obstacle-list,
.console .panel-grow .plan-list,
.console .panel-grow .pin-list {
  flex: 1 1 auto;
  overflow-y: auto;
}
.console .obstacle {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 8px 0;
  border-bottom: 1px solid var(--line-soft);
}
.console .obstacle:last-child {
  border-bottom: none;
}
.console .obstacle.off {
  opacity: 0.42;
}
.console .dot-toggle {
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  margin-top: 3px;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: transparent;
  cursor: pointer;
  transition: background 0.15s, box-shadow 0.15s;
}
.console .obstacle:not(.off) .dot-toggle.is-nofly {
  background: var(--signal);
  border-color: var(--signal-2);
}
.console .obstacle:not(.off) .dot-toggle.is-restricted {
  background: var(--phosphor);
  border-color: var(--phosphor-2);
}
.console .obstacle-body {
  flex: 1 1 auto;
  min-width: 0;
  cursor: pointer;
}
.console .obstacle-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.console .obstacle-name {
  font-size: 12px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.console .obstacle-meta,
.console .plan-meta {
  font-size: 10.5px;
  color: var(--ink-dim);
  margin-top: 3px;
}
.console .pill {
  flex: 0 0 auto;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 2px;
  border: 1px solid;
  letter-spacing: 0.5px;
}
.console .pill-nofly {
  color: var(--signal-2);
  border-color: var(--signal);
  background: rgba(200, 80, 58, 0.1);
}
.console .pill-restricted {
  color: var(--phosphor-2);
  border-color: var(--phosphor-dim);
  background: rgba(216, 162, 74, 0.1);
}

/* —— 飞行计划列表（场景③）—— */
.console .plan {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 8px;
  margin-bottom: 4px;
  border: 1px solid transparent;
  border-radius: 2px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.console .plan:hover {
  background: var(--panel-2);
}
.console .plan.active {
  border-color: var(--phosphor);
  background: rgba(216, 162, 74, 0.1);
}
.console .plan-dot {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  margin-top: 3px;
  border-radius: 50%;
}
.console .plan-body {
  min-width: 0;
}
.console .plan-name {
  font-size: 12px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* —— 判定块（场景③）—— */
.console .verdict {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 11px;
  border: 1px solid;
  border-radius: 2px;
  font-size: 12px;
}
.console .verdict-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}
.console .verdict-ok {
  color: var(--ok);
  border-color: rgba(90, 140, 110, 0.5);
  background: rgba(90, 140, 110, 0.08);
}
.console .verdict-ok .verdict-dot {
  background: var(--ok);
}
.console .verdict-bad {
  color: var(--signal-2);
  border-color: var(--signal);
  background: rgba(200, 80, 58, 0.1);
}
.console .verdict-bad .verdict-dot {
  background: var(--signal);
}

/* —— 机型列表（场景④）—— */
.console .aircraft-list {
  gap: 5px;
}
.console .aircraft {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 10px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 2px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.console .aircraft:hover {
  border-color: var(--phosphor-dim);
}
.console .aircraft.active {
  border-color: var(--phosphor);
  background: rgba(216, 162, 74, 0.11);
}
.console .aircraft-name {
  font-size: 12px;
  color: var(--ink);
}
.console .aircraft.active .aircraft-name {
  color: var(--phosphor-2);
}
.console .aircraft-map {
  font-size: 11px;
  color: var(--ink-dim);
}
.console .aircraft.active .aircraft-map {
  color: var(--phosphor);
}

/* —— 拾取检视（右栏）—— */
.console .pick-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.console .pick-3d {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--phosphor-2);
  word-break: break-all;
  text-shadow: 0 0 10px rgba(216, 162, 74, 0.35);
}
.console .pick-2d {
  font-size: 12px;
  color: var(--ink-mid);
  word-break: break-all;
}
.console .pick-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  background: var(--line-soft);
  border: 1px solid var(--line-soft);
}
.console .pick-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 9px;
  background: var(--panel);
}
.console .pick-k {
  font-size: 10px;
  color: var(--ink-dim);
}
.console .pick-v {
  font-size: 12px;
  color: var(--ink);
}
.console .pick-empty {
  padding: 14px 4px;
  font-size: 12px;
  color: var(--ink-mid);
  line-height: 1.7;
}
.console .pick-empty .dim {
  color: var(--ink-dim);
  font-size: 11px;
}

/* —— 已钉网格 —— */
.console .pin {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid var(--line-soft);
}
.console .pin:last-child {
  border-bottom: none;
}
.console .pin-body {
  flex: 1 1 auto;
  min-width: 0;
}
.console .pin-code {
  font-size: 12px;
  color: var(--phosphor-2);
  word-break: break-all;
}
.console .pin-meta {
  font-size: 10px;
  color: var(--ink-dim);
  margin-top: 2px;
}
.console .pin-del {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 2px;
  color: var(--ink-dim);
  cursor: pointer;
  line-height: 1;
}
.console .pin-del:hover {
  color: var(--signal-2);
  border-color: var(--signal);
}
.console .pin-empty,
.console .seq-empty {
  padding: 12px 4px;
  font-size: 11px;
  color: var(--ink-dim);
  text-align: center;
}

/* —— 序列表（场景③右栏）—— */
.console .seq-panel {
  min-height: 200px;
}
.console .seq-table {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-soft);
  border-radius: 2px;
  overflow: hidden;
  min-height: 0;
}
.console .seq-head {
  display: flex;
  padding: 6px 8px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--line);
  font-size: 10px;
  color: var(--ink-dim);
}
.console .seq-body {
  flex: 1 1 auto;
  overflow-y: auto;
  min-height: 0;
}
.console .seq-row {
  display: flex;
  padding: 5px 8px;
  font-size: 11px;
  color: var(--ink);
  border-bottom: 1px solid var(--line-soft);
}
.console .seq-row:last-child {
  border-bottom: none;
}
.console .seq-row.conflict {
  color: var(--signal-2);
  background: rgba(200, 80, 58, 0.12);
}
.console .c-idx {
  flex: 0 0 28px;
  color: var(--ink-dim);
}
.console .seq-row .c-idx {
  color: var(--ink-mid);
}
.console .c-code {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.console .c-in,
.console .c-out {
  flex: 0 0 44px;
  text-align: right;
}

/* —— 冲突明细 —— */
.console .conflict-list {
  gap: 6px;
}
.console .conflict-item {
  padding: 7px 9px;
  border: 1px solid var(--signal);
  border-radius: 2px;
  background: rgba(200, 80, 58, 0.08);
}
.console .conflict-code {
  font-size: 11px;
  color: var(--signal-2);
  word-break: break-all;
}
.console .conflict-pair {
  font-size: 11px;
  color: var(--ink);
  margin-top: 3px;
}
.console .conflict-win {
  font-size: 10px;
  color: var(--ink-mid);
  margin-top: 2px;
}

/* —— 签名十字丝 HUD —— */
.console .reticle {
  position: absolute;
  left: 312px;
  bottom: 42px;
  z-index: 25;
  pointer-events: none;
  display: flex;
  align-items: center;
  gap: 12px;
  opacity: 0.5;
  transition: opacity 0.2s;
}
.console .reticle.live {
  opacity: 1;
}
.console .reticle-cross {
  position: relative;
  width: 46px;
  height: 46px;
  flex: 0 0 auto;
}
.console .cross-h,
.console .cross-v {
  position: absolute;
  background: var(--phosphor);
  opacity: 0.7;
}
.console .cross-h {
  left: 0;
  right: 0;
  top: 50%;
  height: 1px;
  transform: translateY(-0.5px);
}
.console .cross-v {
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  transform: translateX(-0.5px);
}
.console .cross-dot {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--phosphor-2);
  transform: translate(-50%, -50%);
}
.console .reticle.live .cross-dot {
  box-shadow: 0 0 8px 2px rgba(216, 162, 74, 0.75);
}
.console .reticle-panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 7px 11px;
  min-width: 210px;
}
.console .reticle-label {
  font-size: 10px;
  color: var(--ink-dim);
  letter-spacing: 0.5px;
}
.console .reticle-code {
  font-size: 14px;
  font-weight: 600;
  color: var(--phosphor-2);
  margin-top: 3px;
  word-break: break-all;
  text-shadow: 0 0 9px rgba(216, 162, 74, 0.45);
}
.console .reticle-coords {
  font-size: 11px;
  color: var(--ink-mid);
  margin-top: 2px;
}
.console .reticle-idle {
  font-size: 12px;
  color: var(--ink-dim);
  margin-top: 4px;
}

/* —— 底状态条 —— */
.console .statusbar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 28px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 14px;
  background: var(--panel);
  border-top: 1px solid var(--line);
  font-size: 11px;
  color: var(--ink-mid);
  z-index: 20;
}
.console .status-item b {
  color: var(--phosphor);
  font-weight: 500;
}
.console .status-item.dim,
.console .status-item.dim b {
  color: var(--ink-dim);
}
.console .status-item b.bad {
  color: var(--signal-2);
}
.console .status-item b.phos {
  color: var(--phosphor-2);
}
.console .status-sep {
  color: var(--line);
}
.console .status-spacer {
  margin-left: auto;
}

/* —— 滚动条 —— */
.console .rail::-webkit-scrollbar,
.console .seq-body::-webkit-scrollbar,
.console .panel-grow ul::-webkit-scrollbar {
  width: 8px;
}
.console .rail::-webkit-scrollbar-track,
.console .seq-body::-webkit-scrollbar-track,
.console .panel-grow ul::-webkit-scrollbar-track {
  background: transparent;
}
.console .rail::-webkit-scrollbar-thumb,
.console .seq-body::-webkit-scrollbar-thumb,
.console .panel-grow ul::-webkit-scrollbar-thumb {
  background: var(--line);
  border-radius: 4px;
}

/* —— 响应式 —— */
@media (max-width: 1180px) {
  .console .rail-left {
    width: 248px;
  }
  .console .rail-right {
    width: 264px;
  }
  .console .reticle {
    left: 260px;
  }
  .console .tab {
    min-width: 64px;
    padding: 0 9px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .console * {
    transition: none !important;
  }
}
</style>
