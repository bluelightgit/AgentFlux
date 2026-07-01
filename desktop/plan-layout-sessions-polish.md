# Layout Fix + Sessions Redesign + Polish

## Phase 1 (parallel)

### Task A: Fixed Toolbar & Sidebar
- File: `src/components/AppShell.tsx`
- Problem: TopBar and Sidebar scroll with content — only `<main>` should scroll
- Fix: outer div `h-screen overflow-hidden flex flex-col`; TopBar `shrink-0`; Sidebar `shrink-0 overflow-y-auto h-full`; Main `flex-1 overflow-auto`

### Task B: Sessions Page Complete Redesign + Markdown
- Files: `src/components/SessionsPage.tsx` (rewrite), new `src/components/MarkdownRenderer.tsx`
- Install: `react-markdown`, `remark-gfm`
- Problem: layout messy/misaligned, conversation content rendered as `<pre>` plain text
- Fix: redesign two-panel layout cleanly; render all conversation text via MarkdownRenderer (code blocks, lists, bold, etc.)
- Also update `src/components/AgentSessionViewer.tsx` to use MarkdownRenderer for message text

## Phase 2 (after Phase 1, parallel)

### Task C: Frameless Window + Platform Titlebar + Custom Scrollbar
- Files: `electron/main.ts` (frame:false, titleBarStyle), `src/components/AppShell.tsx` (integrate TitleBar), new `src/components/TitleBar.tsx`, `src/index.css` (scrollbar)
- Frameless window with custom titlebar merged into TopBar
- Platform-aware: Windows (min/max/close right), macOS (traffic lights left via `titleBarStyle: 'hiddenInset'`)
- Custom scrollbar CSS (thin, dark mode aware)

### Task D: Dark Mode Audit
- Audit ALL components for missing `dark:` variants
- Focus: cards, borders, inputs, dropdowns, badges, table rows that show light in dark mode
- Fix with appropriate `dark:` Tailwind classes

## Constraints
- Zero emoji, Lucide SVG icons only
- All text with `<` or `>` uses JSX expression braces
- `typeof window !== 'undefined'` guards for Electron IPC
- NO `node:fs` or `node:path` imports in renderer code
- Build must pass: `npx vite build`
- Tests must pass: `npx vitest run` (23/23)
