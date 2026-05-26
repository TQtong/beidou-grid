<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue'
import {
  init,
  dispose,
  setGivenRange,
  clearGivenRange,
  drawPointGrid,
  updateAircraft,
  clearAircraft,
  setLevelOverride,
  getActiveLevel,
  refreshAll,
  loadBoundary,
  clearBoundary,
  setBoundaryVisible,
  flyToPoint,
  PUER_BOUNDARY_URL,
} from './index'

/**
 * 不同级别下推荐的相机视距（米）——使单格在屏幕上有可见尺寸（数十像素）。
 * 经验值：cellMeters · 30 左右，下限 800m，上限 80km，避免极端。
 */
const viewHeightForLevel = (level: number): number => {
  // 单位：米。L1≈445km, L2≈55km, L3≈28km, L4≈1.85km, L5≈124m, L6≈62m, L7≈7.7m, L8+≈<1m
  const cellMetersTable = [NaN, 445278, 55660, 27830, 1855.3, 123.7, 61.8, 7.7, 0.97, 0.12, 0.015]
  const m = cellMetersTable[level] ?? 124
  return Math.min(80000, Math.max(800, m * 30))
}

const container = useTemplateRef('container')

// 折叠面板默认展开项。
const panelActive = ref<string[]>(['level', 'range'])

// 级别选项（含「自动」）。
const levelOptions = ref<{ label: string; value: number | 'auto' }[]>([
  { label: '自动（按比例尺）', value: 'auto' },
  ...Array.from({ length: 10 }, (_v, i) => ({ label: `${i + 1}级`, value: i + 1 })),
])

// 表单状态。默认定位到普洱市 + 级别锁定 L5（与 onMounted 自动加载边界保持一致）。
const levelMode = ref<number | 'auto'>(5)
const useGivenRange = ref<boolean>(true)
// 普洱市经纬度范围（来自 GeoJSON bbox 的近似值；首次加载边界后会被 bbox 实测覆盖）。
const givenWest = ref<number>(99.10)
const givenEast = ref<number>(102.20)
const givenSouth = ref<number>(22.02)
const givenNorth = ref<number>(24.13)

// 默认目标点：普洱市中心（思茅区附近）。
const pointLon = ref<number>(100.972)
const pointLat = ref<number>(22.778)
const pointHeight = ref<number>(1000)
const pointLevel = ref<number>(5)

// 默认飞行器位置：普洱市中心（思茅区附近），便于直接观察隔离格效果。
const aircraftLon = ref<number>(100.972)
const aircraftLat = ref<number>(22.778)
const aircraftHeight = ref<number>(8000)
const aircraftRunning = ref<boolean>(false)

const activeLevelText = ref<string>('1')

const isolationOptions = ref<{ label: string; value: number }[]>(
  Array.from({ length: 10 }, (_v, i) => ({ label: `${i + 1}级`, value: i + 1 })),
)
const isolationLevel = ref<number>(5)
const bufferRing = ref<number>(1)

// 边界图层状态。
const boundaryLoading = ref<boolean>(false)
const boundaryLoaded = ref<boolean>(false)
const boundaryVisible = ref<boolean>(true)
const boundaryRingCount = ref<number>(0)
const boundaryVertexCount = ref<number>(0)
const boundaryError = ref<string>('')

// 模拟飞行器移动定时器。
let aircraftTimer: number | undefined

const isAutoLevel = computed(() => levelMode.value === 'auto')

const refreshActiveLevel = () => {
  activeLevelText.value = String(getActiveLevel())
}

const applyLevelMode = () => {
  setLevelOverride(levelMode.value === 'auto' ? undefined : Number(levelMode.value))
  // rAF 后再读，等待 rebuild 生效。
  requestAnimationFrame(() => refreshActiveLevel())
}

const applyGivenRange = () => {
  if (useGivenRange.value) {
    setGivenRange(
      Number(givenWest.value),
      Number(givenSouth.value),
      Number(givenEast.value),
      Number(givenNorth.value),
    )
  } else {
    clearGivenRange()
  }
  requestAnimationFrame(() => refreshActiveLevel())
}

const applyPointGrid = () => {
  const lon = Number(pointLon.value)
  const lat = Number(pointLat.value)
  const h = Number(pointHeight.value)
  const lv = Number(pointLevel.value)
  drawPointGrid(lon, lat, h, lv)
  // 飞行到目标点，相机高度按级别取「可视格尺寸」。
  flyToPoint(lon, lat, h, viewHeightForLevel(lv), 1.2)
}

const applyAircraft = (opts?: { flyTo?: boolean }) => {
  const lon = Number(aircraftLon.value)
  const lat = Number(aircraftLat.value)
  const h = Number(aircraftHeight.value)
  updateAircraft({ lon, lat, height: h })
  if (opts?.flyTo) {
    // 飞行到飞行器位置；视距按隔离级别（隔离格的尺寸）。
    flyToPoint(lon, lat, h, viewHeightForLevel(isolationLevel.value), 1.2)
  }
}

const startAircraftSim = () => {
  if (aircraftRunning.value) return
  aircraftRunning.value = true
  applyAircraft({ flyTo: true })
  // 每 500ms 飞行器经度+0.001（约 100m 向东），便于直观看见跨格隔离切换。
  // 模拟过程中不每帧 flyTo（会打架），只在「设置位置」/启动时飞行一次。
  aircraftTimer = window.setInterval(() => {
    aircraftLon.value = Number((Number(aircraftLon.value) + 0.001).toFixed(6))
    applyAircraft()
  }, 500)
}

const stopAircraftSim = () => {
  aircraftRunning.value = false
  if (aircraftTimer !== undefined) {
    window.clearInterval(aircraftTimer)
    aircraftTimer = undefined
  }
  clearAircraft()
}

const handlePresetPuer = () => {
  givenWest.value = 100.51
  givenEast.value = 101.47
  givenSouth.value = 21.30
  givenNorth.value = 23.35
  useGivenRange.value = true
  applyGivenRange()
}

const handlePresetBeijing = () => {
  givenWest.value = 116.0
  givenEast.value = 116.8
  givenSouth.value = 39.5
  givenNorth.value = 40.2
  useGivenRange.value = true
  applyGivenRange()
}

const handleClearRange = () => {
  useGivenRange.value = false
  clearGivenRange()
  requestAnimationFrame(() => refreshActiveLevel())
}

const handleRefresh = () => {
  refreshAll()
  requestAnimationFrame(() => refreshActiveLevel())
}

const handleLoadPuerBoundary = async () => {
  boundaryError.value = ''
  boundaryLoading.value = true
  try {
    const result = await loadBoundary(PUER_BOUNDARY_URL, {
      style: { width: 3 },
      flyTo: true,
    })
    if (result) {
      boundaryLoaded.value = true
      boundaryVisible.value = true
      boundaryRingCount.value = result.ringCount
      boundaryVertexCount.value = result.vertexCount
    }
  } catch (err) {
    boundaryError.value = err instanceof Error ? err.message : String(err)
  } finally {
    boundaryLoading.value = false
  }
}

const handleToggleBoundary = () => {
  setBoundaryVisible(boundaryVisible.value)
}

const handleClearBoundary = () => {
  clearBoundary()
  boundaryLoaded.value = false
  boundaryRingCount.value = 0
  boundaryVertexCount.value = 0
}

onMounted(async () => {
  init(container.value as HTMLDivElement, {
    isolationLevel: isolationLevel.value,
    bufferRing: bufferRing.value,
    dwellFrames: 3,
    heightRange: { min: 0, max: 20000, step: 1000 },
  })

  // ① 锁定显示级别为 L5（与 levelMode 默认值一致）。
  applyLevelMode()

  // ② 应用初始给定范围（普洱市近似 bbox），让首帧只渲染该区域。
  applyGivenRange()

  // ③ 异步加载普洱市行政边界，加载完成后用 GeoJSON 精确 bbox 覆盖输入框 + 飞行相机。
  try {
    boundaryLoading.value = true
    boundaryError.value = ''
    const result = await loadBoundary(PUER_BOUNDARY_URL, {
      style: { width: 3 },
      flyTo: true,
    })
    if (result) {
      boundaryLoaded.value = true
      boundaryVisible.value = true
      boundaryRingCount.value = result.ringCount
      boundaryVertexCount.value = result.vertexCount
      // 用 GeoJSON 实测 bbox 同步表单 + 给定范围，使网格与边界严格对齐。
      if (result.bounds) {
        const Cesium = await import('cesium')
        const west = Cesium.Math.toDegrees(result.bounds.west)
        const east = Cesium.Math.toDegrees(result.bounds.east)
        const south = Cesium.Math.toDegrees(result.bounds.south)
        const north = Cesium.Math.toDegrees(result.bounds.north)
        givenWest.value = Number(west.toFixed(4))
        givenEast.value = Number(east.toFixed(4))
        givenSouth.value = Number(south.toFixed(4))
        givenNorth.value = Number(north.toFixed(4))
        applyGivenRange()
      }
    }
  } catch (err) {
    boundaryError.value = err instanceof Error ? err.message : String(err)
  } finally {
    boundaryLoading.value = false
  }

  // 等 rebuild 完成读取生效级别。
  setTimeout(() => refreshActiveLevel(), 200)
})

onBeforeUnmount(() => {
  if (aircraftTimer !== undefined) window.clearInterval(aircraftTimer)
  dispose()
})
</script>

<template>
  <div ref="container" id="container"></div>
  <div class="panel">
    <el-collapse v-model="panelActive" class="panel-collapse">
      <el-collapse-item title="显示级别" name="level">
        <el-form-item label="级别">
          <el-select v-model="levelMode" placeholder="级别模式" @change="applyLevelMode">
            <el-option
              v-for="opt in levelOptions"
              :key="String(opt.value)"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
        </el-form-item>
        <el-tag type="info">当前生效级别：L{{ activeLevelText }}</el-tag>
        <el-tag v-if="isAutoLevel" type="success" style="margin-left:8px">自动</el-tag>
      </el-collapse-item>

      <el-collapse-item title="给定范围（管制扇区）" name="range">
        <el-form-item label="启用给定范围">
          <el-switch v-model="useGivenRange" @change="applyGivenRange" />
        </el-form-item>
        <el-form-item label="经度">
          <el-input v-model="givenWest" placeholder="west" /> ~
          <el-input v-model="givenEast" placeholder="east" />
        </el-form-item>
        <el-form-item label="纬度">
          <el-input v-model="givenSouth" placeholder="south" /> ~
          <el-input v-model="givenNorth" placeholder="north" />
        </el-form-item>
        <el-button-group>
          <el-button type="primary" @click="applyGivenRange">应用</el-button>
          <el-button @click="handlePresetPuer">普洱市</el-button>
          <el-button @click="handlePresetBeijing">北京</el-button>
          <el-button @click="handleClearRange">取消约束</el-button>
        </el-button-group>
      </el-collapse-item>

      <el-collapse-item title="单点查询（R1）" name="point">
        <el-form-item label="经度">
          <el-input v-model="pointLon" />
        </el-form-item>
        <el-form-item label="纬度">
          <el-input v-model="pointLat" />
        </el-form-item>
        <el-form-item label="高度(米)">
          <el-input v-model="pointHeight" />
        </el-form-item>
        <el-form-item label="级别">
          <el-input-number v-model="pointLevel" :min="1" :max="10" />
        </el-form-item>
        <el-button type="primary" @click="applyPointGrid">绘制点所在网格</el-button>
      </el-collapse-item>

      <el-collapse-item title="飞行器空域隔离" name="aircraft">
        <el-form-item label="经度">
          <el-input v-model="aircraftLon" />
        </el-form-item>
        <el-form-item label="纬度">
          <el-input v-model="aircraftLat" />
        </el-form-item>
        <el-form-item label="高度(米)">
          <el-input v-model="aircraftHeight" />
        </el-form-item>
        <el-form-item label="隔离级别">
          <el-select v-model="isolationLevel" :disabled="aircraftRunning">
            <el-option
              v-for="opt in isolationOptions"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="缓冲环(格)">
          <el-input-number v-model="bufferRing" :min="0" :max="5" :disabled="aircraftRunning" />
        </el-form-item>
        <el-button-group>
          <el-button type="primary" @click="applyAircraft({ flyTo: true })">设置位置并飞行</el-button>
          <el-button v-if="!aircraftRunning" type="success" @click="startAircraftSim">开始模拟</el-button>
          <el-button v-else type="warning" @click="stopAircraftSim">停止模拟</el-button>
        </el-button-group>
      </el-collapse-item>

      <el-collapse-item title="区域边界 (GeoJSON)" name="boundary">
        <el-button-group>
          <el-button
            type="primary"
            :loading="boundaryLoading"
            @click="handleLoadPuerBoundary"
          >
            加载普洱市边界
          </el-button>
          <el-button v-if="boundaryLoaded" @click="handleClearBoundary">清除</el-button>
        </el-button-group>
        <el-form-item v-if="boundaryLoaded" label="显示" style="margin-top:8px">
          <el-switch v-model="boundaryVisible" @change="handleToggleBoundary" />
        </el-form-item>
        <el-tag v-if="boundaryLoaded" type="success" style="margin-top:4px">
          已加载 {{ boundaryRingCount }} 环 / {{ boundaryVertexCount }} 顶点
        </el-tag>
        <el-alert
          v-if="boundaryError"
          type="error"
          :title="`边界加载失败：${boundaryError}`"
          show-icon
          style="margin-top:8px"
        />
        <div style="font-size:12px;color:#888;margin-top:6px">
          数据源：DataV.GeoAtlas (geo.datav.aliyun.com)
        </div>
      </el-collapse-item>

      <el-collapse-item title="操作" name="action">
        <el-button @click="handleRefresh">手动刷新</el-button>
      </el-collapse-item>
    </el-collapse>
  </div>
</template>

<style scoped>
#container {
  width: 100%;
  height: 100%;
}
.panel {
  position: absolute;
  top: 10px;
  left: 10px;
  width: 420px;
  max-height: calc(100vh - 20px);
  overflow-y: auto;
  background-color: rgba(255, 255, 255, 0.92);
  padding: 8px 10px;
  border-radius: 6px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
}
.panel-collapse {
  --el-collapse-header-bg-color: transparent;
}
</style>
