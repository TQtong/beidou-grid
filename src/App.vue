<script setup lang="ts">
import { onMounted, ref, useTemplateRef } from 'vue'
import { init } from './index'

const container = useTemplateRef('container')

onMounted(() => {
  init(container.value as HTMLDivElement)
})
</script>

<template>
  <div ref="container" id="container">
   
  </div>
</template>

<style scoped>
#container {
  width: 100%;
  height: 100%;
}
</style>
