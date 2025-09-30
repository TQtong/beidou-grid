import { createApp } from 'vue'
import App from './App.vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'

import { Ion } from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'

import './style.css'

Ion.defaultAccessToken =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIzMGM5NjQ3OC1iNzI5LTQ1OGUtOGU4NC1lNjA1OTQ0OWFmYWMiLCJpZCI6NDU4NzgsImlhdCI6MTY2Nzk2MTM2Mn0.whkwTff2Jku7dVOpt5V4zrTTW8m-BV1fJQDeBsbmZn8'


createApp(App).use(ElementPlus).mount('#app')
// createApp(App).use(pinia).use(ElementPlus).mount('#app')
