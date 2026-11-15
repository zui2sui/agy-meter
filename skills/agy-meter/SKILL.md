---
name: agy-meter
description: Open or reference the AGY Meter sidecar UI panel to inspect live token output speed (Streaming & E2E tok/s), TTFT, exact backend routed model ID, context window sawtooth trend & compactions, KV cache hit rate, estimated public API USD cost, 5-hour / weekly / Pro Argon plan quota remaining & full-window USD valuation, and subagent consumption trees.
---

# AGY Meter — Local Telemetry & Quota Valuation

Use this skill whenever the user asks to view, open, or check real-time token output speed, backend routed model IDs, TTFT, context window occupancy, KV cache hit rates, public API cost estimates, 5-hour / weekly / Argon plan quota equivalence, or subagent telemetry in the Antigravity UI.

## Opening the UI Panel

Check that `agy-meter` is enabled, then surface the exact clickable `sidecar://` pill so the user can toggle the **AGY Meter** panel in the auxiliary side pane with one click:

```markdown
[AGY Meter](sidecar://agy-meter/telemetry-panel/)
```

## Capabilities in the Panel

- **Persistent Top Header & Plan Quota Strip (`5h` / `周` / `Argon`)**:
  - Auto-follows the active conversation or searches/switches across historical sessions via read-only SQLite FTS5 (`conversations_fts`).
  - One-click pricing toggle between **Current Effective Price (`当前价`, date-aware official promo rates)** and **Standard List Price (`原价`)**.
  - Live **5-Hour, Weekly, and Pro Argon Quota Bars** (via local read-only `RetrieveUserQuotaSummary` / `GetUserStatus`) showing remaining `%`, reset countdown, current window API equivalent spend (`已用`), and extrapolated **100% Full-Window Reference API Value (`预估`)**.
- **Tab 1 — Current Session (`会话`)**:
  - Side-by-side metrics: **Streaming Decode Speed (`流式速度 tok/s`)**, **End-to-End Speed (`端到端速度 tok/s`)**, and **Session Cost Estimate (`会话估算`)**, automatically tagging server-buffered short bursts as `缓冲`.
  - Exact backend routed model ID chip with hover details and inferred orchestrator/worker roles.
  - **Context Window Sawtooth Area Chart (`上下文水位趋势`)** with ceiling indicator and exact auto/manual compaction drop pins (`压缩 ×N`), plus **Cost & Token Breakdown Bar (`成本与 Token 构成`)** switchable between **Cost Share (`费用`)** and **Token Share (`Token`)**.
  - Turn-grouped cards expandable to individual LLM hops and compaction dividers.
- **Tab 2 — Subagent Tree (`子智能体`)**:
  - Full parent-child topology across Subagents, Browser Agents, and Swarm Workers with aggregated tree output tokens and USD cost, clickable to inspect any child session.
- **Tab 3 — Global Stats & Speed Leaderboard (`全局`)**:
  - Filterable by **Current 5h Window (`本轮 5h`) / Last 7 Days (`近 7 天`) / All Time (`全部`)**, ranking backend model IDs by steady-state median `tok/s`, output tokens, cache hit rate, and cumulative API spend, plus persistent quota window valuation history (`额度窗口记录`).
