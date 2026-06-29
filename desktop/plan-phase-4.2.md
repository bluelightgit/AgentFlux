# Phase 4.2 Development Plan: Multi-Agent Observability + Control Plane

## Goal
1. Enhance Electron app with real-time multi-agent observability (context, tokens, cache, workflow)
2. Add Phase 4.2 control plane features (preference radar, budget, A/B test)
3. Use multi-agent execution (DAG) for the actual development work
4. Monitor and document multi-agent telemetry during development

## Tasks

### Observability Enhancements (new components)
- **OA-1**: Real-time event stream panel (live subagent.run events with token/cache/cost)
- **OA-2**: Per-agent detail view (click agent → see turns, input, output, cacheRead, cacheWrite, cost, hit rate)
- **OA-3**: DAG workflow visualization (node graph with status colors, topological layout)
- **OA-4**: Cache efficiency panel (per-agent L1/L2 hit rates, cache miss cost impact)

### Phase 4.2 Control Plane
- **D2-1**: Preference radar chart (5-dim vector with sliders + real-time mode prediction)
- **D2-2**: Preference persistence (write to agentflux.json)
- **D2-5**: Budget settings panel (max cost, per-role allocation, budget router preview)
- **D2-6**: A/B test configuration (two preference sets, toggle, track results)

### Infrastructure
- **OA-5**: Enhanced agent-status reader (read sessions/ dir for per-agent token totals)
- **OA-6**: Event stream aggregator (live subagent events grouped by session)
