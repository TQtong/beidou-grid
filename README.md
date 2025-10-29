# 北斗网格位置编码可视化系统

基于 Vue 3 + TypeScript + Cesium 的北斗网格位置编码（BeiDou Grid Location Codec）三维可视化系统。

## 📋 项目简介

本项目实现了北斗网格位置编码的二维和三维可视化功能，支持多层级网格划分、高程编码、范围查询等核心功能。系统采用现代化的前端技术栈，提供直观的三维地理信息展示界面。

## ✨ 主要功能

- **二维网格编码**：支持1-10级北斗二维网格位置编码
- **三维网格编码**：集成高程信息的北斗三维网格位置编码
- **三维可视化**：基于 Cesium 的高性能三维地球渲染
- **交互式操作**：支持网格参数调整、范围查询等交互功能
- **多层级支持**：从6°×4°到1/2048″×1/2048″的10级网格精度
- **高程编码**：支持大地高度的高精度编码和解码

## 🛠️ 技术栈

- **前端框架**：Vue 3 + TypeScript
- **构建工具**：Vite
- **三维渲染**：Cesium
- **UI组件**：Element Plus
- **数学计算**：Decimal.js, Math.js
- **几何计算**：JSTS (Java Topology Suite for JavaScript)
- **时间处理**：Moment.js

## 📦 核心依赖

```json
{
  "cesium": "^1.133.1",
  "decimal.js": "^10.6.0",
  "element-plus": "^2.11.4",
  "jsts": "^2.12.1",
  "mathjs": "^14.8.2",
  "moment": "^2.30.1",
  "vue": "^3.5.21"
}
```

## 🚀 快速开始

### 环境要求

- Node.js >= 16.0.0
- npm >= 7.0.0

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

### 构建生产版本

```bash
npm run build
```

### 预览生产版本

```bash
npm run preview
```

## 📁 项目结构

```
src/
├── plugins/           # 核心编码解码插件
│   ├── codec-2d.ts   # 二维网格编码
│   ├── codec-3d.ts   # 三维网格编码
│   ├── data.ts       # 数据管理
│   └── type.ts       # 类型定义
├── plugins1/         # 北斗网格核心库
│   ├── BeiDouGrid2D.ts           # 二维网格类
│   ├── BeiDouGrid3D.ts           # 三维网格类
│   ├── BeiDouGridConstants.ts    # 常量定义
│   ├── BeiDouGridUtils.ts        # 工具函数
│   └── ...                       # 其他核心组件
├── App.vue           # 主应用组件
├── index.ts          # 主入口文件
└── main.ts           # 应用启动文件
```

## 🎯 核心功能说明

### 网格分级系统

系统支持10级网格精度，从粗到细：

| 级别 | 网格尺寸 | 精度描述 |
|------|----------|----------|
| 1级  | 6°×4°    | 大区域网格 |
| 2级  | 30′×30′  | 中等精度 |
| 3级  | 15′×10′  | 高精度 |
| 4级  | 1′×1′    | 超高精度 |
| 5级  | 4″×4″    | 极高精度 |
| ...  | ...      | ...      |
| 10级 | 1/2048″×1/2048″ | 最高精度 |

### 编码功能

- **二维编码**：经纬度坐标转换为北斗网格码
- **三维编码**：经纬度+高程坐标转换为北斗三维网格码
- **参照编码**：支持相对位置编码，减少码长
- **解码功能**：网格码反向解析为地理坐标

### 可视化功能

- **三维地球**：基于Cesium的全球三维地形渲染
- **网格显示**：多层级网格的三维可视化
- **交互控制**：支持缩放、旋转、平移等操作
- **参数调整**：实时调整网格参数和显示范围

## 🔧 使用示例

### 基本用法

```typescript
import { init, createGrid } from './index'

// 初始化Cesium场景
const viewer = init(containerElement)

// 创建网格
createGrid(
  stepHeight,    // 高度步长
  gridSize,      // 网格尺寸级别
  maxHeight,     // 最大高度
  {
    west: 97.31,   // 西经
    south: 21.08,  // 南纬
    east: 106.11,  // 东经
    north: 29.15   // 北纬
  }
)
```

### 编码示例

```typescript
import Codec2D from './plugins/codec-2d'
import Codec3D from './plugins/codec-3d'

// 二维编码
const lngLat = {
  lngDegree: 116.391,
  latDegree: 39.913
}
const code2d = Codec2D.encode(lngLat, 10)

// 三维编码
const lngLatEle = {
  lngDegree: 116.391,
  latDegree: 39.913,
  elevation: 100
}
const code3d = Codec3D.encode(lngLatEle, 6378137, 2)
```

## 📚 相关资源

- **核心库**：
  - [beidou-grid-location-codec](https://github.com/CN-Shopkeeper/beidou-grid-location-codec)
  - [BeidouGridCodec](https://github.com/ywx001/BeidouGridCodec)

- **技术文档**：
  - [Vue 3 官方文档](https://v3.vuejs.org/)
  - [Cesium 官方文档](https://cesium.com/docs/)
  - [Element Plus 文档](https://element-plus.org/)

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request 来改进项目。

## 📄 许可证

本项目基于 [MIT 许可证](LICENSE) 开源。

## 📞 联系方式

如有问题或建议，请通过以下方式联系：

- 提交 Issue
- 发送邮件

---

**注意**：本项目基于北斗网格位置编码标准实现，适用于地理信息系统、位置服务等相关应用场景。