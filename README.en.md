# AGY Meter

[简体中文](./README.md) | **English**

**AGY Meter** is a local, read-only telemetry and plan-quota sidecar panel for Antigravity.

> **Disclaimer**
> - This is an **unofficial personal utility**, not affiliated with Google. It is shared **as-is** for public archival **without any guarantee of ongoing maintenance or compatibility with future internal client changes**. Feel free to fork and adapt it.
> - **100% local & read-only** (`node:sqlite` with `readOnly: true`): zero external npm dependencies, zero outbound network telemetry, and zero mutations to local client state or request pipelines.
> - All USD figures shown in the panel (`Used / Est.`, Session Est., Global Spend) are **reference conversions computed locally from recorded token counts using public API pricing**; they **do not represent official internal subscription quota weights or actual billing charges**.

---

## Features

- **Instant Bilingual Toggle (`中 | EN`)**
  - Automatically matches Chinese or English from system locale on first launch, with a top-bar `中 | EN` toggle that switches every label, chart, tooltip, and status message in place without reloading.
- **Top Plan Quota Strip (`5h` / `Weekly` / `Pro Argon` Pool)**
  - Automatically detects `Gemini` (`5h` + `Weekly`), `Claude` (`5h` + `Weekly`), and separate `Argon` weekly pools on Pro plans (dynamically folding Argon into the shared Gemini pool when merged on Ultra/shared plans).
  - Shows live remaining `%`, reset countdown, and **`Used / Est.` equivalent API USD value** for each window (switchable between **Promo / Effective** rates and **Standard List** rates).
- **Live Session Telemetry (`Session` Tab)**
  - Side-by-side **Stream Speed (`tok/s`)**, **End-to-End Speed (`tok/s`)**, and **Session Cost Estimate (`$`)**, automatically flagging server-buffered short bursts (`Buf`).
  - Displays the exact routed backend `modelId` badge for every LLM hop.
  - **Context Trend Chart**: Sawtooth area chart showing context growth, model context ceiling, and drop pins distinguishing **Auto Compact** vs. **Manual `/compact`** events.
  - **Cost & Token Breakdown Bar**: Splits usage into `Cache Read / New Input / Thinking / Response`, switchable between **Cost %** and **Token %**.
  - Expandable per-turn cards listing hop speeds, costs, and inline **Auto Compact / Manual Compact** dividers.
- **Subagent Topology Tree (`Subagents` Tab)**
  - Aggregates parent-child trees across Subagents, Browser Agents, and Swarm workers with total tree output tokens and equivalent USD cost; click any node to inspect its session directly.
- **Global Stats & Model Speed Leaderboard (`Global` Tab)**
  - Aggregates input, cache-read, and output tokens, cache hit rate, and steady-state median (`P50`) decode speed per backend model across `5h Win / 7 Days / All`, plus persistent quota window valuation history.

---

## Installation

No `npm install` or external packages required (runs directly on Antigravity's built-in Node 24 runtime):

1. Clone or copy this repository into your global `plugins/agy-meter` directory:

   **Windows (PowerShell)**
   ```powershell
   git clone https://github.com/zui2sui/agy-meter.git "$env:USERPROFILE\.gemini\config\plugins\agy-meter"
   ```

   **macOS / Linux**
   ```bash
   git clone https://github.com/zui2sui/agy-meter.git ~/.gemini/config/plugins/agy-meter
   ```

2. Open Antigravity's **Customizations / Plugins** view, ensure **AGY Meter** is enabled, and open the panel in the right auxiliary side pane (or ask the assistant in chat to surface the one-click panel link).

---

## How Metrics Are Calculated

All metrics are computed locally in real time from read-only SQLite databases (`conversations/*.db`, `conversation_summaries.db`) and the local `LanguageServerService` status RPCs:

1. **Stream Speed vs. End-to-End Speed (`tok/s`)**
   - **Stream Speed**: `outputTokens / streamSec`, measuring pure post-TTFT token decoding speed (`outputTokens` includes both thinking tokens and visible response tokens).
   - **Short-Burst Buffering (`Buf`)**: When the server flushes a short reply or thought summary in a single burst, `streamSec` is near-zero and inflates instantaneous `tok/s`. Such hops are tagged `Buf`, and the top hero metric falls back to the session's **steady-state median (`P50`)** across samples with `streamSec >= 0.8s` and `outputTokens >= 80`.
   - **E2E Speed**: `outputTokens / (ttftSec + streamSec)`, measuring overall throughput including time-to-first-token (TTFT).
   - **Global Leaderboard Speed**: Uses each `modelId`'s steady-state stream `P50` median (falling back to non-buffered `P50` when steady samples are absent) so short bursts do not skew averages.

2. **Context Occupancy, Cache Hit Rate & Compaction Drops**
   - **Current Context**: Taken from the latest hop's `inputTokens + cacheReadTokens` (falling back to `contextEst` if absent) against the reported `contextLimit` (default `256K`).
   - **Cache Hit Rate**: `∑ cacheReadTokens / ∑ (inputTokens + cacheReadTokens)`.
   - **Context Compaction**: Parsed from local `CHECKPOINT` steps (`step_type = 23`), comparing pre- and post-compaction prompt sizes (`before → after`), and checking the immediately preceding user step's slash-command payload to distinguish **Manual `/compact`** from **Auto Compact**.

3. **Public API Equivalent Cost & 4-Way Breakdown**
   - Matched per hop against official public API reference rates (USD per 1M tokens) for the routed `modelId`:
     $$\text{Hop Cost} = \frac{\text{inputTokens} \times P_{\text{in}} + \text{cacheReadTokens} \times P_{\text{cache}} + \text{outputTokens} \times P_{\text{out}}}{10^6}$$
   - **Promo vs. List**: `Promo` (`当前价`) applies active date-aware introductory API discounts based on hop timestamp; `List` (`原价`) uses undiscounted standard public list prices.
   - **4-Way Breakdown**: Total output cost on each hop is split proportionally by `thinkingTokens / outputTokens` into **Thinking** and **Response**, alongside **Cache Read** and **New Input**.

4. **Plan Quota Strip `Used / Est.` (`5h` / `Weekly` / `Argon`)**
   - **Window Spend (`Used`)**: Reads high-precision floating-point `remainingFraction` and `resetTime` from the local status RPC, derives `windowStart = resetTime - windowDuration` (`5h` or `7d`), and sums equivalent API spend across all local hops in that pool and time window (`Argon` tracked separately when independent on Pro plans, or folded into `Gemini` when shared).
   - **100% Full-Window Linear Extrapolation (`Est.`)**:
     $$\text{Estimated 100\% Window Value} = \frac{\text{Window Public API Spend}}{1 - \text{remainingFraction}}$$
   - Uses the unrounded float `1 - remainingFraction` in the denominator. To avoid small-denominator jitter right after a reset, extrapolation waits until at least `1%` is used in a `5h` window (`0.5%` in a `Weekly` window), showing the previous window's saved reference value (`≈`) until then. Because public API rates differ substantially across workloads (high cache-hit vs. heavy fresh input or long thinking output), natural variation in extrapolated full-window USD values is expected.

---

## License

[MIT](./LICENSE)
