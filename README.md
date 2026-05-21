# 北斗网格位置编码可视化系统

这是一个基于 Vue 3、TypeScript、Cesium 和 Element Plus 的北斗网格位置编码可视化项目。项目包含两部分能力：一部分是用于页面交互和 Cesium 场景绘制的应用层，另一部分是北斗二维/三维网格编码、解码、范围查询等领域逻辑。

## 技术栈

- Vue 3：应用界面与响应式状态管理。
- TypeScript：核心逻辑与应用代码的类型约束。
- Vite：本地开发与生产构建工具。
- Cesium：三维地球、矩形网格和高度拉伸可视化。
- Element Plus：表单、按钮、选择器等界面控件。
- Decimal.js：网格尺度、经纬度步长等高精度小数计算。
- JSTS：二维/三维范围查询中的几何关系计算。
- Moment.js：范围查询中的耗时统计与时间处理。

## 当前目录结构

```text
src/
├─ main.ts                              # Vue 应用启动入口，注册 Element Plus、Cesium 样式和全局样式
├─ app/                                 # 应用层：页面组件、Cesium 场景控制和页面样式
│  ├─ App.vue                           # 主界面组件，负责表单交互、Cesium 容器和网格创建触发
│  ├─ index.ts                          # Cesium 场景入口，导出 init/createGrid，创建 Viewer 和网格实体
│  └─ style.css                         # 全局样式，设置页面尺寸和基础布局
└─ beidou-grid/                         # 北斗网格领域层：编码、解码、网格对象、范围查询和工具门面
   ├─ index.ts                          # 领域层统一导出口，集中导出 core/codec/grid/query/facade/legacy-codec
   ├─ core/                             # 基础核心模块：常量、类型、坐标点、GIS 工具和字符串工具
   │  ├─ BeiDouGeoPoint.ts              # 地理点模型，封装经度、纬度、高程和方向等基础数据
   │  ├─ BeiDouGridCommonUtils.ts       # 编码/解码共享工具，处理方向、字符和编码片段
   │  ├─ BeiDouGridConstants.ts         # 北斗网格常量，定义级别、尺寸、字符集和高程编码参数
   │  ├─ GisUtils.ts                    # GIS 几何辅助工具，处理坐标、包围盒、JSTS 几何和空间计算
   │  ├─ StringBuilder.ts               # 字符串构建工具，用于网格编码拼接等多片段追加场景
   │  └─ type.ts                        # 领域共享类型，定义经纬度方向、空间关系等枚举和值类型
   ├─ codec/                            # 新结构编码解码模块，负责地理坐标与北斗网格码互转
   │  ├─ BeiDouGridDecoder.ts           # 网格解码器，将二维/三维网格码解析为坐标、高程和范围信息
   │  └─ BeiDouGridEncoder.ts           # 网格编码器，将经纬度、高程和级别编码为北斗网格码
   ├─ grid/                             # 网格对象模块，表达具体二维/三维网格单元
   │  ├─ BeiDouGrid2D.ts                # 二维网格对象，保存级别、经纬度边界、编码和相等性判断
   │  └─ BeiDouGrid3D.ts                # 三维网格对象，在二维网格基础上增加高程范围和三维编码
   ├─ query/                            # 空间范围查询模块，查找与几何范围相交的网格编码
   │  ├─ BeiDouGrid2DRangeQuery.ts      # 二维范围查询，基于 JSTS 几何关系查找相交二维网格
   │  └─ BeiDouGrid3DRangeQuery.ts      # 三维范围查询，在二维几何关系上叠加高程范围过滤
   ├─ facade/                           # 门面模块，收敛对外常用 API，减少应用层深层依赖
   │  └─ BeiDouGridUtils.ts             # 统一工具门面，封装编码、解码、范围查询和几何辅助能力
   └─ legacy-codec/                     # 旧版编码器兼容模块，保留原 plugins 实现供现有演示继续使用
      ├─ codec-2d.ts                    # 旧版二维编码/解码器，提供 encode、decode 和参考编码等能力
      ├─ codec-3d.ts                    # 旧版三维编码/解码器，组合二维编码与高程编码生成三维码
      ├─ data.ts                        # 旧版编码器数据表，包含网格尺寸、数量、码长和高程参数
      ├─ getElevationNeighbor.ts        # 高程相邻编码计算工具，用于查找高程方向邻近关系
      ├─ index.ts                       # 旧版编码器统一导出口，导出 Codec2D、Codec3D 和相关类型
      └─ type.ts                        # 旧版编码器类型定义，包含经纬度、高程、方向和解码参数
```

## 目录与文件说明

### `src/main.ts`

应用启动入口。负责创建 Vue 应用实例，注册 Element Plus，引入 Cesium 控件样式和全局样式，并挂载到页面中的 `#app` 节点。

### `src/app/`

应用层目录，放置和页面、交互、Cesium 演示场景直接相关的代码。

- `App.vue`：主界面组件。包含 Cesium 容器、经纬度范围输入、高度选择、网格级别选择等界面逻辑，并在组件挂载后初始化场景和创建网格。
- `index.ts`：应用层的 Cesium 场景控制入口。导出 `init` 和 `createGrid`，负责初始化 `Cesium.Viewer`、加载地形、根据参数创建二维经纬网格和三维高度拉伸实体。
- `style.css`：应用全局样式。目前主要负责页面基础尺寸和全局布局。

### `src/beidou-grid/`

北斗网格领域层目录。这里放置网格编码、解码、网格对象、空间查询、通用工具和兼容旧实现的模块。应用层应该优先从 `src/beidou-grid/index.ts` 或 `facade/BeiDouGridUtils.ts` 使用领域能力。

- `index.ts`：北斗网格领域层统一导出口。集中导出核心类型、编码器、解码器、网格对象、查询类、门面工具类和旧版编码器，便于外部使用时减少深层路径依赖。

### `src/beidou-grid/core/`

基础核心目录，放置不依赖具体业务流程的常量、类型、坐标点、GIS 工具和字符串工具。

- `BeiDouGeoPoint.ts`：北斗网格使用的地理点模型，封装经度、纬度、高程以及经纬度方向等基础数据，并提供相关读取方法。
- `BeiDouGridCommonUtils.ts`：网格编码/解码共享工具，提供方向、字符、编码片段等通用处理能力。
- `BeiDouGridConstants.ts`：北斗网格常量定义，包括网格级别、网格尺寸、编码字符集、高程编码参数等标准配置。
- `GisUtils.ts`：GIS 几何工具，处理经纬度坐标、JSTS 几何对象、空间范围和几何拆分等辅助计算。
- `StringBuilder.ts`：简单字符串构建工具，用于编码拼接等需要多次追加字符串的场景。
- `type.ts`：领域层共享类型定义，包括经纬度方向、空间关系等类型和枚举值。

### `src/beidou-grid/codec/`

新结构下的北斗网格编码解码目录，负责将地理坐标与北斗网格码相互转换。

- `BeiDouGridEncoder.ts`：北斗二维/三维网格编码器。根据经纬度、高程和网格级别生成标准网格编码。
- `BeiDouGridDecoder.ts`：北斗二维/三维网格解码器。根据网格编码反向解析经纬度、高程和网格范围信息。

### `src/beidou-grid/grid/`

网格对象目录，放置用于表达具体网格单元的类。

- `BeiDouGrid2D.ts`：二维北斗网格对象。保存级别、经纬度边界和网格编码，并提供相等性判断。
- `BeiDouGrid3D.ts`：三维北斗网格对象。继承二维网格能力，并增加高程方向的最小值、最大值和三维编码信息。

### `src/beidou-grid/query/`

空间范围查询目录，负责根据几何范围查找相交或包含的北斗网格编码。

- `BeiDouGrid2DRangeQuery.ts`：二维范围查询实现。基于 JSTS 几何对象、包围盒和空间关系判断，查找与目标几何相交的二维网格。
- `BeiDouGrid3DRangeQuery.ts`：三维范围查询实现。在二维几何关系基础上加入高程范围，查找与目标几何和高度范围相交的三维网格。

### `src/beidou-grid/facade/`

门面层目录，用于收敛外部常用 API，避免应用层直接依赖多个内部模块。

- `BeiDouGridUtils.ts`：北斗网格统一工具门面。封装编码、解码、二维范围查询、三维范围查询、几何辅助判断等常用能力。

### `src/beidou-grid/legacy-codec/`

旧版编码器兼容目录。这里保留原 `plugins` 目录中的实现，便于当前 Cesium 演示和已有调用继续工作。后续如果统一到 `codec/` 目录，可以逐步减少对该目录的直接依赖。

- `codec-2d.ts`：旧版二维网格编码/解码实现，提供 `encode`、`decode`、参考编码等能力。
- `codec-3d.ts`：旧版三维网格编码/解码实现，组合二维编码和高程编码生成三维网格码。
- `data.ts`：旧版编码器使用的网格尺寸、网格数量、编码长度和高程编码参数。
- `getElevationNeighbor.ts`：旧版高程邻近编码计算工具，用于计算高程编码的相邻关系。
- `index.ts`：旧版编码器统一导出口，导出 `Codec2D`、`Codec3D` 和相关类型。
- `type.ts`：旧版编码器共享类型，包括经纬度、高程、方向、解码参数和极区网格类型。

## 推荐导入方式

应用层如果要使用 Cesium 演示能力，从 `src/app/index.ts` 导入：

```typescript
import { init, createGrid } from './app'
```

领域层如果要使用北斗网格能力，优先从 `src/beidou-grid/index.ts` 导入：

```typescript
import {
  BeiDouGridUtils,
  BeiDouGridEncoder,
  BeiDouGridDecoder,
  BeiDouGeoPoint,
  Codec2D,
  Codec3D,
} from './beidou-grid'
```

在 `App.vue` 这类 `src/app/` 内部文件中，可以使用同目录入口：

```typescript
import { init, createGrid } from './index'
```

## 模块关系

- `main.ts` 只负责应用启动，不直接处理网格业务。
- `app/` 负责界面和 Cesium 可视化，可以调用 `beidou-grid/` 的编码能力。
- `beidou-grid/core/` 提供基础类型、常量和通用工具。
- `beidou-grid/codec/` 依赖 `core/`，负责标准编码和解码。
- `beidou-grid/grid/` 依赖 `core/` 和 `facade/`，负责表达网格对象。
- `beidou-grid/query/` 依赖 `core/`、`codec/` 和 JSTS，负责范围查询。
- `beidou-grid/facade/` 汇总 `codec/`、`query/` 和 `core/` 的常用能力。
- `beidou-grid/legacy-codec/` 是旧实现兼容层，当前仍被 `app/index.ts` 中的 Cesium 示例使用。

## 快速开始

安装依赖：

```bash
npm install
```

启动开发服务：

```bash
npm run dev
```

生产构建：

```bash
npm run build
```

预览生产构建：

```bash
npm run preview
```

## 维护约定

- 新增北斗网格领域逻辑时，优先放入 `src/beidou-grid/` 下对应分层目录。
- 新增页面、控件、Cesium 展示逻辑时，优先放入 `src/app/`。
- 对外暴露的领域 API 应尽量通过 `src/beidou-grid/index.ts` 或 `facade/BeiDouGridUtils.ts` 汇总。
- `legacy-codec/` 用于兼容旧实现，不建议继续向其中加入新业务能力。
- 避免恢复 `plugins/`、`plugins1/` 这类临时目录名，后续新增目录应按职责命名。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
