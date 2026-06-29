# AgentFlux Desktop — Scaffold Plan

## Directory Structure

```
desktop/
├── plan.md                # This file
├── package.json           # Scripts, dependencies, Electron entry point
├── tsconfig.json          # TypeScript config for the renderer (src/)
├── tsconfig.electron.json # TypeScript config for Electron main process
├── vite.config.ts         # Vite bundler config for the renderer
├── postcss.config.js      # PostCSS config (Tailwind + Autoprefixer)
├── tailwind.config.js     # Tailwind CSS config
├── index.html             # Vite entry HTML
├── electron/              # Electron main-process code (TypeScript → JS)
│   ├── main.ts            # Window lifecycle, app bootstrap
│   └── preload.ts         # Secure contextBridge between main & renderer
└── src/                   # Renderer / UI source (React, styles)
    ├── main.tsx           # React entry point
    ├── App.tsx            # Root component (sidebar + dashboard layout)
    ├── Dashboard.tsx      # Dashboard with chart placeholder cards
    └── index.css          # Tailwind directives
```

## Build Pipeline

1. **Renderer build** (`npm run build`): `tsc` type-checks `src/`, then `vite build`
   outputs bundled assets to `dist/`.
2. **Electron compile** (`npm run electron:compile`): `tsc -p tsconfig.electron.json`
   compiles `electron/*.ts` → `electron/*.js` in-place (CommonJS modules).
3. **Dev mode** (`npm run electron:dev`): Compiles Electron TS, then runs Vite dev
   server and Electron concurrently — Electron loads `http://localhost:5173`.
4. **Production build** (`npm run electron:build`): Builds renderer, compiles
   Electron TS, then `electron-builder` packages the app.

## Key Configuration Notes

- `package.json` `"main": "electron/main.js"` — Electron loads the **compiled** JS
  entry point (produced by `electron:compile`). The source is `electron/main.ts`.
- `electron/main.ts` references `preload.js` (the compiled output) in
  `webPreferences.preload`, not the `.ts` source.
- `tsconfig.json` covers only `src/` (renderer, `noEmit: true`).
- `tsconfig.electron.json` covers `electron/` and emits CommonJS `.js` files.
- `react` and `react-dom` are in `dependencies` so they are available at runtime
  in production builds.

## Next Steps

1. Replace Dashboard placeholder cards with real Recharts visualizations.
2. Add Zustand store for application state (route data, cache stats, costs).
3. Implement IPC handlers in `electron/main.ts` for backend communication.
4. Extend `preload.ts` to expose a typed API surface to the renderer.
5. Add Electron main-process tests and renderer component tests.
