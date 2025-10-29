<script setup lang="ts">
import { onMounted, ref, useTemplateRef } from 'vue'
import { init, createGrid } from './index'

const container = useTemplateRef('container')

const heightList = ref<{ label: string, value: number }[]>([
  {
    label: '1级',
    value: 445280
  },
  {
    label: '2级',
    value: 55660
  },
  {
    label: '3级',
    value: 27830
  },
  {
    label: '4级',
    value: 1850
  },
  {
    label: '5级',
    value: 123.69
  },
  {
    label: '6级',
    value: 61.84
  },
  {
    label: '7级',
    value: 7.73
  },
  {
    label: '8级',
    value: 0.97
  },
  {
    label: '9级',
    value: 0.121
  },
  {
    label: '10级',
    value: 0.015
  }
])


const gridSizeList = ref<{ label: string, value: number }[]>([
  {
    label: '1级',
    value: 1
  },
  {
    label: '2级',
    value: 2
  },
  {
    label: '3级',
    value: 3
  },
  {
    label: '4级',
    value: 4
  },
  {
    label: '5级',
    value: 5
  },
  {
    label: '6级',
    value: 6
  },
  {
    label: '7级',
    value: 7
  },
  {
    label: '8级',
    value: 8
  },
  {
    label: '9级',
    value: 9
  },
  {
    label: '10级',
    value: 10
  }
])

const heightSelect = ref<number>(heightList.value[0]!.value)
const gridSizeSelect = ref<number>(gridSizeList.value[0]!.value)
const longitudeRange = ref<number>(97.31)
const longitudeRangeEnd = ref<number>(106.11)
const latitudeRange = ref<number>(21.08)
const latitudeRangeEnd = ref<number>(29.15)
const maxHeight = ref<number>(4452800)
const handleHeightChange = (value: number) => {
  createGrid( heightSelect.value, gridSizeSelect.value, maxHeight.value, {
    west: longitudeRange.value,
    south: latitudeRange.value,
    east: longitudeRangeEnd.value,
    north: latitudeRangeEnd.value
  })
}

const handleGridSizeChange = (value: number) => {
  createGrid(heightSelect.value, gridSizeSelect.value, maxHeight.value, {
    west: longitudeRange.value,
    south: latitudeRange.value,
    east: longitudeRangeEnd.value,
    north: latitudeRangeEnd.value
  })
}

const handleCreateGrid = () => {
  longitudeRange.value = 100.51
  longitudeRangeEnd.value = 101.47
  latitudeRange.value = 21.30
  latitudeRangeEnd.value = 23.35
  createGrid(heightSelect.value, gridSizeSelect.value, maxHeight.value, {
    west: longitudeRange.value,
    south: latitudeRange.value,
    east: longitudeRangeEnd.value,  
    north: latitudeRangeEnd.value
  })
}
onMounted(() => {
  init(container.value as HTMLDivElement)
  createGrid(heightSelect.value, gridSizeSelect.value, maxHeight.value, {
    west: longitudeRange.value,
    south: latitudeRange.value,
    east: longitudeRangeEnd.value,
    north: latitudeRangeEnd.value
  })
})
</script>

<template>
  <div ref="container" id="container">
  </div>
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
    <el-form-item label="高度">
      <el-select v-model="heightSelect" :options="heightList" placeholder="请选择高度" @change="handleHeightChange" />
    </el-form-item>
    <el-form-item label="网格尺寸">
      <el-select v-model="gridSizeSelect" :options="gridSizeList" placeholder="请选择网格尺寸" @change="handleGridSizeChange" />
    </el-form-item>

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
}
</style>
