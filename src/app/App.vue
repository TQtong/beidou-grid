<script setup lang="ts">
// ============================================================
// App.vue — 北斗空域立方体场 · 地理空间指挥台（重设计 Demo UI）
// 聚焦三需求：① 渲染模式(线框/填充) + 点击立方体改色 + 清除选中；
//            ② 比例尺联动级别(自动) + 手动锁定 + 当前生效级别显示；
//            ③ 无人机低空飞行(起飞/降落 + 高度/影响半径/速度)。
// 视觉：暗色磨砂玻璃「指挥台」面板，青蓝主色，Element Plus 组件深色化适配。
// ============================================================
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue'
import {
  init,
  dispose,
  setMode,
  setFillOpacity,
  clearSelections,
  setLevelOverride,
  getActiveLevel,
  setGivenRange,
  clearGivenRange,
  startDrone,
  stopDrone,
  setDroneAltitude,
  setDroneInfluenceRadius,
  setDroneSpeed,
  loadBoundary,
  flyToPoint,
  PUER_BOUNDARY_URL,
  PUER_CENTER,
  type FieldMode,
} from './index'

/** 普洱市经纬度范围（GeoJSON bbox 近似；加载边界后由实测覆盖相机）。 */
const PUER_BBOX = { west: 99.10, south: 22.02, east: 102.20, north: 24.13 } as const

const container = useTemplateRef<HTMLDivElement>('container')

// ── 需求①：渲染模式 / 填充 / 选中 ──
const renderMode = ref<FieldMode>('wire')
const fillOpacity = ref<number>(75) // 0..100（仅填充模式生效）

// ── 需求②：级别 ──
const levelMode = ref<number | 'auto'>(5) // 默认锁定 5 级（不再按比例尺自动选级）
const activeLevel = ref<number>(5)
const levelOptions = [
  { label: '自动（按比例尺）', value: 'auto' as const },
  ...Array.from({ length: 10 }, (_v, i) => ({ label: `${i + 1} 级`, value: i + 1 })),
]

// ── 需求③：无人机 ──
const droneRunning = ref<boolean>(false)
const droneAltitude = ref<number>(150) // 米
const droneRadius = ref<number>(320) // 米（影响半径）
const droneSpeed = ref<number>(45) // 0.05..2.0 rad/s 用 ×100 整数滑杆承载

// ── 给定范围 ──
const limitToPuer = ref<boolean>(true)

// 颜色图例（与 GridStateModel 调色板一致）。
const legend = [
  { name: '空格', color: '#00e5ff' },
  { name: '无人机所在格', color: '#ff3b30' },
  { name: '无人机影响格', color: '#ff9500' },
  { name: '选中 A', color: '#ffd60a' },
  { name: '选中 B', color: '#30d158' },
  { name: '选中 C', color: '#bf5af2' },
]

/** 当前生效级别轮询句柄。 */
let levelTimer: number | undefined

// ── 事件处理 ──

/** 切换渲染模式（线框/填充）。 */
const onModeChange = (mode: FieldMode): void => {
  renderMode.value = mode
  setMode(mode)
}

/** 调整填充不透明度。 */
const onFillOpacityChange = (v: number): void => {
  setFillOpacity(v / 100)
}

/** 锁定/恢复级别。 */
const onLevelChange = (v: number | 'auto'): void => {
  setLevelOverride(v === 'auto' ? undefined : v)
}

/** 无人机起飞/降落切换。 */
const onToggleDrone = (): void => {
  if (droneRunning.value) {
    stopDrone()
    droneRunning.value = false
  } else {
    startDrone(PUER_CENTER.lon, PUER_CENTER.lat)
    droneRunning.value = true
  }
}

/** 调无人机高度。 */
const onAltitudeChange = (v: number): void => {
  setDroneAltitude(v)
}

/** 调无人机影响半径。 */
const onRadiusChange = (v: number): void => {
  setDroneInfluenceRadius(v)
}

/** 调无人机速度（滑杆值 ÷100 = rad/s）。 */
const onSpeedChange = (v: number): void => {
  setDroneSpeed(v / 100)
}

/** 切换是否限定普洱市范围。 */
const onLimitChange = (v: boolean): void => {
  if (v) {
    setGivenRange(PUER_BBOX.west, PUER_BBOX.south, PUER_BBOX.east, PUER_BBOX.north)
  } else {
    clearGivenRange()
  }
}

/** 飞回普洱市中心。 */
const onFlyToPuer = (): void => {
  flyToPoint(PUER_CENTER.lon, PUER_CENTER.lat, 0, 6000, 1.2)
}

/** 清除全部点击选中。 */
const onClearSelections = (): void => {
  clearSelections()
}

// 滑杆 tooltip 格式化。
const fmtMeters = (v: number): string => `${v} m`
const fmtPercent = (v: number): string => `${v}%`
const fmtSpeed = (v: number): string => `${(v / 100).toFixed(2)} rad/s`

onMounted(async () => {
  if (!container.value) return

  // 初始化（默认高度区间：离地 0–600m，5 层 ×120m；立方体场底面贴地形面）。
  init(container.value, { heightRange: { min: 0, max: 600, step: 120 } })

  // 应用初始 UI 状态。
  setMode(renderMode.value)
  setFillOpacity(fillOpacity.value / 100)
  // 默认锁定级别（levelMode 默认 5 级）；选「自动」时传 undefined。
  setLevelOverride(typeof levelMode.value === 'number' ? levelMode.value : undefined)
  if (limitToPuer.value) {
    setGivenRange(PUER_BBOX.west, PUER_BBOX.south, PUER_BBOX.east, PUER_BBOX.north)
  }

  // 加载普洱市边界（不抢相机；init 已飞向普洱）。
  loadBoundary(PUER_BOUNDARY_URL, { flyTo: false }).catch(() => {
    /* 边界加载失败不阻断主流程。 */
  })

  // 轮询当前生效级别（比例尺联动后实时反映）。
  levelTimer = window.setInterval(() => {
    activeLevel.value = getActiveLevel()
  }, 400)
})

onBeforeUnmount(() => {
  if (levelTimer !== undefined) {
    window.clearInterval(levelTimer)
    levelTimer = undefined
  }
  dispose()
})
</script>

<template>
  <div class="stage">
    <div ref="container" class="cesium-container"></div>

    <aside class="console">
      <header class="console__head">
        <span class="console__pulse"></span>
        <div class="console__titles">
          <h1 class="console__title">北斗空域立方体场</h1>
          <p class="console__subtitle">地理空间指挥台 · GeoSOT</p>
        </div>
      </header>

      <!-- 需求①：渲染 -->
      <section class="panel">
        <h2 class="panel__title">渲染模式</h2>
        <el-radio-group :model-value="renderMode" @change="onModeChange">
          <el-radio-button value="wire">线框</el-radio-button>
          <el-radio-button value="fill">填充</el-radio-button>
        </el-radio-group>

        <div class="field" :class="{ 'field--muted': renderMode !== 'fill' }">
          <label class="field__label">填充不透明度</label>
          <el-slider
            v-model="fillOpacity"
            :min="4"
            :max="100"
            :disabled="renderMode !== 'fill'"
            :format-tooltip="fmtPercent"
            @input="onFillOpacityChange"
          />
        </div>

        <p class="hint">点击任意立方体循环改变其颜色：黄 → 绿 → 品红 → 还原。</p>
        <el-button class="btn-block" size="small" plain @click="onClearSelections">
          清除全部选中
        </el-button>
      </section>

      <!-- 需求②：级别 -->
      <section class="panel">
        <h2 class="panel__title">北斗网格级别</h2>
        <el-select :model-value="levelMode" class="select-block" @change="onLevelChange">
          <el-option
            v-for="opt in levelOptions"
            :key="String(opt.value)"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <div class="metric">
          <span class="metric__label">当前生效级别</span>
          <span class="metric__value">L{{ activeLevel }}</span>
        </div>
        <p class="hint">选「自动」时，缩放地图即按比例尺动态调整级别。</p>
      </section>

      <!-- 需求③：无人机 -->
      <section class="panel">
        <h2 class="panel__title">无人机低空飞行</h2>
        <el-button
          class="btn-block"
          :type="droneRunning ? 'danger' : 'primary'"
          @click="onToggleDrone"
        >
          {{ droneRunning ? '降落' : '起飞' }}
        </el-button>

        <div class="field">
          <label class="field__label">巡航高度</label>
          <el-slider
            v-model="droneAltitude"
            :min="20"
            :max="600"
            :format-tooltip="fmtMeters"
            @input="onAltitudeChange"
          />
        </div>
        <div class="field">
          <label class="field__label">影响半径</label>
          <el-slider
            v-model="droneRadius"
            :min="50"
            :max="1500"
            :format-tooltip="fmtMeters"
            @input="onRadiusChange"
          />
        </div>
        <div class="field">
          <label class="field__label">飞行速度</label>
          <el-slider
            v-model="droneSpeed"
            :min="5"
            :max="150"
            :format-tooltip="fmtSpeed"
            @input="onSpeedChange"
          />
        </div>
      </section>

      <!-- 给定范围 -->
      <section class="panel">
        <h2 class="panel__title">区域约束</h2>
        <div class="switch-row">
          <span class="switch-row__label">限定普洱市范围</span>
          <el-switch :model-value="limitToPuer" @change="onLimitChange" />
        </div>
        <el-button class="btn-block" size="small" plain @click="onFlyToPuer">
          飞到普洱市
        </el-button>
      </section>

      <!-- 图例 -->
      <section class="panel">
        <h2 class="panel__title">颜色图例</h2>
        <ul class="legend">
          <li v-for="item in legend" :key="item.name" class="legend__item">
            <span class="legend__swatch" :style="{ background: item.color }"></span>
            <span class="legend__name">{{ item.name }}</span>
          </li>
        </ul>
      </section>
    </aside>
  </div>
</template>

<style scoped>
.stage {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #04070d;
}

.cesium-container {
  position: absolute;
  inset: 0;
}

/* ── 指挥台面板 ── */
.console {
  position: absolute;
  top: 18px;
  right: 18px;
  width: 348px;
  max-height: calc(100vh - 36px);
  overflow-y: auto;
  padding: 18px 18px 22px;
  border-radius: 16px;
  background: linear-gradient(160deg, rgba(10, 19, 33, 0.82), rgba(6, 12, 22, 0.78));
  backdrop-filter: blur(20px) saturate(150%);
  -webkit-backdrop-filter: blur(20px) saturate(150%);
  border: 1px solid rgba(53, 196, 255, 0.22);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(120, 210, 255, 0.08);
  color: #cfe2f4;
  font-family: 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
}

.console::-webkit-scrollbar {
  width: 6px;
}
.console::-webkit-scrollbar-thumb {
  background: rgba(53, 196, 255, 0.28);
  border-radius: 3px;
}

.console__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 14px;
  margin-bottom: 6px;
  border-bottom: 1px solid rgba(53, 196, 255, 0.16);
}

.console__pulse {
  position: relative;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #35f0c4;
  box-shadow: 0 0 0 0 rgba(53, 240, 196, 0.6);
  animation: pulse 1.8s infinite;
}
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(53, 240, 196, 0.55); }
  70% { box-shadow: 0 0 0 9px rgba(53, 240, 196, 0); }
  100% { box-shadow: 0 0 0 0 rgba(53, 240, 196, 0); }
}

.console__title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 1px;
  color: #eaf5ff;
}
.console__subtitle {
  margin: 2px 0 0;
  font-size: 11px;
  letter-spacing: 2px;
  color: #5fa8d6;
  text-transform: uppercase;
}

/* ── 分区 ── */
.panel {
  padding: 14px 0;
  border-bottom: 1px solid rgba(53, 196, 255, 0.1);
}
.panel:last-child {
  border-bottom: none;
  padding-bottom: 2px;
}
.panel__title {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: #8fd0f5;
}

.field {
  margin-top: 12px;
}
.field--muted {
  opacity: 0.45;
}
.field__label {
  display: block;
  margin-bottom: 2px;
  font-size: 12px;
  color: #9fb8cf;
}

.hint {
  margin: 12px 0 10px;
  font-size: 11.5px;
  line-height: 1.6;
  color: #7c93aa;
}

.btn-block {
  width: 100%;
}
.select-block {
  width: 100%;
}

.metric {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-top: 12px;
  padding: 8px 12px;
  border-radius: 9px;
  background: rgba(53, 196, 255, 0.08);
  border: 1px solid rgba(53, 196, 255, 0.16);
}
.metric__label {
  font-size: 12px;
  color: #9fb8cf;
}
.metric__value {
  font-size: 20px;
  font-weight: 700;
  color: #35f0c4;
  font-variant-numeric: tabular-nums;
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.switch-row__label {
  font-size: 12.5px;
  color: #bcd3e8;
}

/* ── 图例 ── */
.legend {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 12px;
}
.legend__item {
  display: flex;
  align-items: center;
  gap: 8px;
}
.legend__swatch {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  box-shadow: 0 0 8px rgba(255, 255, 255, 0.18);
  flex: none;
}
.legend__name {
  font-size: 12px;
  color: #aec5db;
}

/* ── Element Plus 深色化适配 ── */
:deep(.el-radio-group) {
  width: 100%;
  display: flex;
}
:deep(.el-radio-button) {
  flex: 1;
}
:deep(.el-radio-button__inner) {
  width: 100%;
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(53, 196, 255, 0.25);
  color: #bcd3e8;
}
:deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
  background: rgba(53, 196, 255, 0.22);
  border-color: rgba(53, 196, 255, 0.6);
  color: #eaf5ff;
  box-shadow: -1px 0 0 0 rgba(53, 196, 255, 0.6);
}

:deep(.el-slider__runway) {
  background: rgba(255, 255, 255, 0.12);
}
:deep(.el-slider__bar) {
  background: linear-gradient(90deg, #35c4ff, #35f0c4);
}
:deep(.el-slider__button) {
  border-color: #35f0c4;
  background: #0a1321;
}

:deep(.el-select__wrapper) {
  background: rgba(255, 255, 255, 0.04);
  box-shadow: 0 0 0 1px rgba(53, 196, 255, 0.25) inset;
}
:deep(.el-select__placeholder),
:deep(.el-select__selected-item) {
  color: #d7e6f5;
}

:deep(.el-button) {
  font-weight: 600;
}
:deep(.el-button.is-plain) {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(53, 196, 255, 0.3);
  color: #bcd3e8;
}
:deep(.el-button.is-plain:hover) {
  background: rgba(53, 196, 255, 0.14);
  border-color: rgba(53, 196, 255, 0.6);
  color: #eaf5ff;
}
</style>
