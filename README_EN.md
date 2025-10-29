# BeiDou Grid Location Codec Visualization System

A 3D visualization system for BeiDou Grid Location Codec based on Vue 3 + TypeScript + Cesium.

## 📋 Project Overview

This project implements 2D and 3D visualization functionality for BeiDou Grid Location Codec, supporting multi-level grid division, elevation encoding, range queries, and other core features. The system uses modern frontend technology stack to provide an intuitive 3D geographic information display interface.

## ✨ Key Features

- **2D Grid Encoding**: Supports 1-10 level BeiDou 2D grid location encoding
- **3D Grid Encoding**: Integrated elevation information for BeiDou 3D grid location encoding
- **3D Visualization**: High-performance 3D Earth rendering based on Cesium
- **Interactive Operations**: Supports grid parameter adjustment, range queries, and other interactive features
- **Multi-level Support**: 10-level grid precision from 6°×4° to 1/2048″×1/2048″
- **Elevation Encoding**: High-precision encoding and decoding of geodetic heights

## 🛠️ Technology Stack

- **Frontend Framework**: Vue 3 + TypeScript
- **Build Tool**: Vite
- **3D Rendering**: Cesium
- **UI Components**: Element Plus
- **Mathematical Computing**: Decimal.js, Math.js
- **Geometric Computing**: JSTS (Java Topology Suite for JavaScript)
- **Time Processing**: Moment.js

## 📦 Core Dependencies

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

## 🚀 Quick Start

### Prerequisites

- Node.js >= 16.0.0
- npm >= 7.0.0

### Install Dependencies

```bash
npm install
```

### Development Mode

```bash
npm run dev
```

### Build for Production

```bash
npm run build
```

### Preview Production Build

```bash
npm run preview
```

## 📁 Project Structure

```
src/
├── plugins/           # Core encoding/decoding plugins
│   ├── codec-2d.ts   # 2D grid encoding
│   ├── codec-3d.ts   # 3D grid encoding
│   ├── data.ts       # Data management
│   └── type.ts       # Type definitions
├── plugins1/         # BeiDou Grid core library
│   ├── BeiDouGrid2D.ts           # 2D grid class
│   ├── BeiDouGrid3D.ts           # 3D grid class
│   ├── BeiDouGridConstants.ts    # Constant definitions
│   ├── BeiDouGridUtils.ts        # Utility functions
│   └── ...                       # Other core components
├── App.vue           # Main application component
├── index.ts          # Main entry file
└── main.ts           # Application startup file
```

## 🎯 Core Functionality

### Grid Level System

The system supports 10 levels of grid precision, from coarse to fine:

| Level | Grid Size | Precision Description |
|-------|-----------|----------------------|
| Level 1 | 6°×4° | Large area grid |
| Level 2 | 30′×30′ | Medium precision |
| Level 3 | 15′×10′ | High precision |
| Level 4 | 1′×1′ | Ultra-high precision |
| Level 5 | 4″×4″ | Extreme precision |
| ... | ... | ... |
| Level 10 | 1/2048″×1/2048″ | Highest precision |

### Encoding Features

- **2D Encoding**: Convert longitude/latitude coordinates to BeiDou grid codes
- **3D Encoding**: Convert longitude/latitude/elevation coordinates to BeiDou 3D grid codes
- **Reference Encoding**: Support relative position encoding to reduce code length
- **Decoding**: Reverse parse grid codes to geographic coordinates

### Visualization Features

- **3D Earth**: Global 3D terrain rendering based on Cesium
- **Grid Display**: 3D visualization of multi-level grids
- **Interactive Controls**: Support zoom, rotate, pan operations
- **Parameter Adjustment**: Real-time adjustment of grid parameters and display range

## 🔧 Usage Examples

### Basic Usage

```typescript
import { init, createGrid } from './index'

// Initialize Cesium scene
const viewer = init(containerElement)

// Create grid
createGrid(
  stepHeight,    // Height step
  gridSize,      // Grid size level
  maxHeight,     // Maximum height
  {
    west: 97.31,   // West longitude
    south: 21.08,  // South latitude
    east: 106.11,  // East longitude
    north: 29.15   // North latitude
  }
)
```

### Encoding Examples

```typescript
import Codec2D from './plugins/codec-2d'
import Codec3D from './plugins/codec-3d'

// 2D encoding
const lngLat = {
  lngDegree: 116.391,
  latDegree: 39.913
}
const code2d = Codec2D.encode(lngLat, 10)

// 3D encoding
const lngLatEle = {
  lngDegree: 116.391,
  latDegree: 39.913,
  elevation: 100
}
const code3d = Codec3D.encode(lngLatEle, 6378137, 2)
```

## 📚 Related Resources

- **Core Libraries**:
  - [beidou-grid-location-codec](https://github.com/CN-Shopkeeper/beidou-grid-location-codec)
  - [BeidouGridCodec](https://github.com/ywx001/BeidouGridCodec)

- **Technical Documentation**:
  - [Vue 3 Official Documentation](https://v3.vuejs.org/)
  - [Cesium Official Documentation](https://cesium.com/docs/)
  - [Element Plus Documentation](https://element-plus.org/)

## 🤝 Contributing

We welcome contributions! Please feel free to submit Issues and Pull Requests to improve the project.

## 📄 License

This project is open source under the [MIT License](LICENSE).

## 📞 Contact

If you have any questions or suggestions, please contact us through:

- Submit an Issue
- Send an email

---

**Note**: This project is implemented based on the BeiDou Grid Location Codec standard and is suitable for geographic information systems, location services, and related application scenarios.
