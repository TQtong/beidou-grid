# BeiDou Grid Location Codec Visualization System

This is a BeiDou Grid Location Codec visualization project based on Vue 3, TypeScript, Cesium, and Element Plus. The project has two main parts: the application layer for UI interaction and Cesium scene rendering, and the BeiDou Grid domain layer for 2D/3D encoding, decoding, grid objects, and range queries.

## Technology Stack

- Vue 3: application UI and reactive state management.
- TypeScript: type safety for application code and core domain logic.
- Vite: local development and production build tooling.
- Cesium: 3D globe, rectangular grid, and extruded height visualization.
- Element Plus: form controls, buttons, selectors, and other UI widgets.
- Decimal.js: high-precision decimal calculations for grid size and coordinate steps.
- JSTS: geometry relationship calculations used by 2D and 3D range queries.
- Moment.js: timing and date/time utilities used in range-query logic.

## Current Directory Structure

```text
src/
├─ main.ts                              # Vue bootstrap entry; registers Element Plus, Cesium styles, and global styles
├─ app/                                 # Application layer: page component, Cesium scene control, and app styles
│  ├─ App.vue                           # Main UI component for forms, Cesium container, and grid creation triggers
│  ├─ index.ts                          # Cesium scene entry; exports init/createGrid and creates Viewer/grid entities
│  └─ style.css                         # Global styles for base page sizing and layout
└─ beidou-grid/                         # BeiDou Grid domain layer: encoding, decoding, grid models, queries, utilities
   ├─ index.ts                          # Unified domain export for core/codec/grid/query/facade/legacy-codec modules
   ├─ core/                             # Core foundation: constants, types, geo point model, GIS helpers, string helper
   │  ├─ BeiDouGeoPoint.ts              # Geographic point model storing longitude, latitude, elevation, and directions
   │  ├─ BeiDouGridCommonUtils.ts       # Shared encode/decode helpers for directions, characters, and code fragments
   │  ├─ BeiDouGridConstants.ts         # BeiDou Grid constants for levels, sizes, character sets, and elevation params
   │  ├─ GisUtils.ts                    # GIS geometry helpers for coordinates, envelopes, JSTS geometry, spatial math
   │  ├─ StringBuilder.ts               # String-building helper for grid code assembly and repeated fragment appends
   │  └─ type.ts                        # Shared domain types for coordinate directions and spatial relation values
   ├─ codec/                            # Structured codec module for converting coordinates and BeiDou grid codes
   │  ├─ BeiDouGridDecoder.ts           # Grid decoder that parses 2D/3D codes into coordinate, elevation, and bounds
   │  └─ BeiDouGridEncoder.ts           # Grid encoder that converts longitude, latitude, elevation, and level into codes
   ├─ grid/                             # Grid model module for concrete 2D/3D grid cells
   │  ├─ BeiDouGrid2D.ts                # 2D grid model with level, lon/lat bounds, code, and equality checks
   │  └─ BeiDouGrid3D.ts                # 3D grid model extending 2D grids with elevation bounds and 3D code data
   ├─ query/                            # Spatial query module for finding grid codes intersecting target geometries
   │  ├─ BeiDouGrid2DRangeQuery.ts      # 2D range query based on JSTS geometry relationship checks
   │  └─ BeiDouGrid3DRangeQuery.ts      # 3D range query adding elevation filtering on top of 2D geometry checks
   ├─ facade/                           # Facade module that consolidates public APIs and reduces deep imports
   │  └─ BeiDouGridUtils.ts             # Unified utility facade for encoding, decoding, range queries, geometry helpers
   └─ legacy-codec/                     # Legacy codec compatibility module preserving the previous plugins implementation
      ├─ codec-2d.ts                    # Legacy 2D encoder/decoder with encode, decode, and reference-code operations
      ├─ codec-3d.ts                    # Legacy 3D encoder/decoder combining 2D codes with elevation encoding
      ├─ data.ts                        # Legacy codec tables for grid sizes, counts, code lengths, and elevation params
      ├─ getElevationNeighbor.ts        # Elevation-neighbor helper for finding adjacent elevation-code relationships
      ├─ index.ts                       # Unified legacy codec export for Codec2D, Codec3D, and related types
      └─ type.ts                        # Legacy codec types for lon/lat, elevation, directions, and decode options
```

## Directories and Files

### `src/main.ts`

The application bootstrap entry. It creates the Vue app instance, registers Element Plus, imports Cesium widget styles and global styles, and mounts the app to the `#app` DOM node.

### `src/app/`

The application layer. It contains code that is directly related to the UI, user interaction, and the Cesium demonstration scene.

- `App.vue`: the main UI component. It contains the Cesium container, longitude/latitude inputs, height selector, grid-level selector, and the lifecycle logic that initializes the scene and creates grids.
- `index.ts`: the Cesium scene control entry for the application layer. It exports `init` and `createGrid`, initializes `Cesium.Viewer`, loads terrain, and creates 2D geographic rectangles plus 3D extruded grid entities from user parameters.
- `style.css`: global application styles. It currently controls the base page sizing and global layout.

### `src/beidou-grid/`

The BeiDou Grid domain layer. It contains grid encoding, decoding, grid models, spatial range queries, shared utilities, and a compatibility module for the older codec implementation. Application code should preferably consume domain capabilities through `src/beidou-grid/index.ts` or `facade/BeiDouGridUtils.ts`.

- `index.ts`: the unified public export for the BeiDou Grid domain layer. It exports core types, encoders, decoders, grid models, query classes, facade utilities, and the legacy codec entry to reduce deep import paths.

### `src/beidou-grid/core/`

The core foundation directory. It contains constants, types, coordinate models, GIS helpers, and string utilities that do not belong to a specific application workflow.

- `BeiDouGeoPoint.ts`: the geographic point model used by BeiDou Grid logic. It stores longitude, latitude, elevation, coordinate directions, and related accessor methods.
- `BeiDouGridCommonUtils.ts`: shared helpers for encoding and decoding, including direction, character, and code-fragment handling.
- `BeiDouGridConstants.ts`: BeiDou Grid constants, including grid levels, grid sizes, code character sets, and elevation encoding parameters.
- `GisUtils.ts`: GIS geometry helpers for coordinate handling, JSTS geometry objects, spatial envelopes, and geometry splitting support.
- `StringBuilder.ts`: a small string-building utility used by code-generation paths that append many fragments.
- `type.ts`: shared domain types, including longitude/latitude directions and spatial relation values.

### `src/beidou-grid/codec/`

The structured BeiDou Grid encoding and decoding directory. It converts between geographic coordinates and BeiDou grid codes.

- `BeiDouGridEncoder.ts`: the BeiDou 2D/3D grid encoder. It generates standard grid codes from longitude, latitude, elevation, and grid level.
- `BeiDouGridDecoder.ts`: the BeiDou 2D/3D grid decoder. It parses grid codes back into coordinate, elevation, and grid-range information.

### `src/beidou-grid/grid/`

The grid model directory. It contains classes that represent concrete grid cells.

- `BeiDouGrid2D.ts`: the 2D BeiDou grid model. It stores the grid level, longitude/latitude bounds, and grid code, and provides equality checks.
- `BeiDouGrid3D.ts`: the 3D BeiDou grid model. It extends the 2D grid model and adds elevation bounds plus 3D code information.

### `src/beidou-grid/query/`

The spatial range-query directory. It finds BeiDou grid codes that intersect with or are contained by target geometries.

- `BeiDouGrid2DRangeQuery.ts`: the 2D range-query implementation. It uses JSTS geometry objects, envelopes, and spatial relationship checks to find 2D grid codes that intersect a target geometry.
- `BeiDouGrid3DRangeQuery.ts`: the 3D range-query implementation. It adds elevation ranges on top of 2D geometry checks and finds 3D grid codes intersecting the target geometry and height interval.

### `src/beidou-grid/facade/`

The facade layer. It consolidates commonly used APIs so the application layer does not need to depend on many internal modules directly.

- `BeiDouGridUtils.ts`: the unified BeiDou Grid utility facade. It wraps encoding, decoding, 2D range queries, 3D range queries, and geometry helper operations.

### `src/beidou-grid/legacy-codec/`

The legacy codec compatibility directory. It preserves the implementation that previously lived under `plugins`, so the current Cesium demonstration and existing imports can keep working. If the project fully migrates to `codec/` later, direct dependencies on this directory can be reduced gradually.

- `codec-2d.ts`: the legacy 2D grid encoder/decoder. It provides `encode`, `decode`, reference encoding, and related 2D code operations.
- `codec-3d.ts`: the legacy 3D grid encoder/decoder. It combines 2D encoding with elevation encoding to generate 3D grid codes.
- `data.ts`: grid sizes, grid counts, code lengths, and elevation encoding parameters used by the legacy codec.
- `getElevationNeighbor.ts`: a legacy elevation-neighbor helper used to calculate adjacent relationships between elevation codes.
- `index.ts`: the unified export for the legacy codec. It exports `Codec2D`, `Codec3D`, and related types.
- `type.ts`: shared legacy codec types, including longitude/latitude, elevation, directions, decode options, and polar grid types.

## Recommended Imports

Application code that needs the Cesium demonstration API should import from `src/app/index.ts`:

```typescript
import { init, createGrid } from './app'
```

Domain code that needs BeiDou Grid functionality should preferably import from `src/beidou-grid/index.ts`:

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

Inside files under `src/app/`, such as `App.vue`, use the local application entry:

```typescript
import { init, createGrid } from './index'
```

## Module Relationships

- `main.ts` only bootstraps the application and does not handle grid business logic directly.
- `app/` owns the UI and Cesium visualization, and it may call encoding features from `beidou-grid/`.
- `beidou-grid/core/` provides foundational types, constants, and shared helpers.
- `beidou-grid/codec/` depends on `core/` and handles standard encoding and decoding.
- `beidou-grid/grid/` depends on `core/` and `facade/` and represents grid objects.
- `beidou-grid/query/` depends on `core/`, `codec/`, and JSTS and handles range queries.
- `beidou-grid/facade/` aggregates common capabilities from `codec/`, `query/`, and `core/`.
- `beidou-grid/legacy-codec/` is the compatibility layer for the older implementation and is still used by the Cesium example in `app/index.ts`.

## Quick Start

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Build for production:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Maintenance Conventions

- Add new BeiDou Grid domain logic under the proper layer in `src/beidou-grid/`.
- Add new pages, controls, and Cesium presentation logic under `src/app/`.
- Public domain APIs should be consolidated through `src/beidou-grid/index.ts` or `facade/BeiDouGridUtils.ts` when possible.
- `legacy-codec/` exists for compatibility with the old implementation and should not receive new business features by default.
- Avoid recreating temporary directory names such as `plugins/` and `plugins1/`; new directories should be named by responsibility.

## License

This project is open source under the [MIT License](LICENSE).
