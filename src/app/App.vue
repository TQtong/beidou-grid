<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, useTemplateRef } from 'vue'
import {
  init,
  createGrid,
  onCellClick,
  setFillOpacity,
  type GridCreateResult,
} from './index'
import { benchInstancedGpuSweep } from '../beidou-grid-render'
import type { PickedCell } from '../beidou-grid-render'

const container = useTemplateRef('container')

const heightList = ref<{ label: string; value: number }[]>([
  { label: '1级', value: 445280 },
  { label: '2级', value: 55660 },
  { label: '3级', value: 27830 },
  { label: '4级', value: 1850 },
  { label: '5级', value: 123.69 },
  { label: '6级', value: 61.84 },
  { label: '7级', value: 7.73 },
  { label: '8级', value: 0.97 },
  { label: '9级', value: 0.121 },
  { label: '10级', value: 0.015 },
])

const gridSizeList = ref<{ label: string; value: number }[]>(
  Array.from({ length: 10 }, (_, k) => ({ label: `${k + 1}级`, value: k + 1 })),
)

const heightSelect = ref<number>(heightList.value[0]!.value)
const gridSizeSelect = ref<number>(4)
const longitudeRange = ref<number>(100.51)
const longitudeRangeEnd = ref<number>(101.47)
const latitudeRange = ref<number>(21.3)
const latitudeRangeEnd = ref<number>(23.35)
const maxHeight = ref<number>(20000)
const fillOpacity = ref<number>(0.85)
const gridResult = ref<GridCreateResult | null>(null)
const picked = ref<PickedCell | null>(null)

let offClick: (() => void) | undefined

const getCurrentBounds = () => ({
  west: Number(longitudeRange.value),
  south: Number(latitudeRange.value),
  east: Number(longitudeRangeEnd.value),
  north: Number(latitudeRangeEnd.value),
})

const renderGrid = () => {
  gridResult.value = createGrid(
    Number(heightSelect.value),
    Number(gridSizeSelect.value),
    Number(maxHeight.value),
    getCurrentBounds(),
  )
}

const handleHeightChange = () => renderGrid()
const handleGridSizeChange = () => renderGrid()
const handleOpacityChange = (v: number) => setFillOpacity(v)

const handleCreateGrid = () => {
  longitudeRange.value = 100.51
  longitudeRangeEnd.value = 101.47
  latitudeRange.value = 21.3
  latitudeRangeEnd.value = 23.35
  renderGrid()
}

const runBench = () => benchInstancedGpuSweep()

onMounted(() => {
  init(container.value as HTMLDivElement)
  renderGrid()
  offClick = onCellClick((cell) => {
    picked.value = cell ?? null
  })
})

onBeforeUnmount(() => offClick?.())
</script>

<template>
  <div ref="container" id="container"></div>
  <div class="select-container">
    <el-button type="primary" @click="handleCreateGrid">普洱市经纬度范围</el-button>
    <el-form-item label="经度范围">
      <el-input v-model="longitudeRange" placeholder="请输入经度范围" /> -
      <el-input v-model="longitudeRangeEnd" placeholder="请输入经度范围" />
    </el-form-item>
    <el-form-item label="纬度范围">
      <el-input v-model="latitudeRange" placeholder="请输入纬度范围" /> -
      <el-input v-model="latitudeRangeEnd" placeholder="请输入纬度范围" />
    </el-form-item>
    <el-form-item label="最大高度">
      <el-input v-model="maxHeight" placeholder="请输入最大高度" />
    </el-form-item>
    <el-form-item label="高度步长">
      <el-select v-model="heightSelect" placeholder="请选择高度步长" @change="handleHeightChange">
        <el-option v-for="h in heightList" :key="h.value" :label="h.label" :value="h.value" />
      </el-select>
    </el-form-item>
    <el-form-item label="网格级别">
      <el-select v-model="gridSizeSelect" placeholder="请选择网格级别" @change="handleGridSizeChange">
        <el-option v-for="g in gridSizeList" :key="g.value" :label="g.label" :value="g.value" />
      </el-select>
    </el-form-item>
    <el-form-item label="填充透明度">
      <el-slider v-model="fillOpacity" :min="0" :max="1" :step="0.05" @input="handleOpacityChange" />
    </el-form-item>
    <el-button @click="renderGrid">渲染网格</el-button>
    <el-button @click="runBench">控制台跑基准</el-button>

    <el-alert
      v-if="gridResult"
      :type="gridResult.status === 'skipped' ? 'warning' : 'success'"
      :closable="false"
      :title="gridResult.message"
      show-icon
    />
    <el-alert
      v-if="picked"
      type="info"
      :closable="false"
      show-icon
      :title="
        `拾取：${picked.code ?? '(边界无码)'} | 索引(${picked.i},${picked.j},${picked.zi}) | ` +
        `经纬高 ${picked.lonDeg.toFixed(5)}, ${picked.latDeg.toFixed(5)}, ${picked.heightMeters.toFixed(0)}m` +
        (picked.category != null ? ` | 类别 ${picked.category}` : '')
      "
    />
  </div>
</template>

<style scoped>
#container {
  width: 100%;
  height: 100%;
}
.select-container {
  position: absolute;
  top: 10px;
  left: 10px;
  width: 400px;
  background-color: rgb(255, 255, 255);
  padding: 8px;
  border-radius: 6px;
  max-height: 92vh;
  overflow: auto;
}
</style>
