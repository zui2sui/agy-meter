# AGY Meter

**简体中文** | [English](./README.en.md)

**AGY Meter** 是一个面向 Antigravity 的本地只读遥测与套餐额度计量侧边栏插件（Sidecar UI）。

> **说明与免责声明（Disclaimer）**
> - 本项目为**非官方个人自用小工具**，与 Google 无关，按现状（**As-Is**）公开存档分享，**不承诺跟进客户端后续内部结构变更或长期维护**，欢迎自行 Fork 修改。
> - 插件 **100% 本地只读运行**（`node:sqlite` `readOnly: true`），无任何外部依赖、无联网外发行为、不修改任何本地状态或请求链路。
> - 面板中显示的美元金额（`已用 / 预估`、会话估算、全局账单）均**仅按公开 API 参考单价对本地记录的 Token 数做等效折算**，**不代表官方内部订阅额度扣减权重或真实账单**，仅供日常直观参考。

---

## 功能概览

- **中 / EN 双语一键切换（Bilingual UI）**
  - 首次打开根据系统语言自动匹配中文或英文，支持顶部栏 `中 | EN` 按钮即时无刷新切换全部标签、图表、提示与状态文案。
- **顶部套餐额度条（5h / 周 / Pro Argon 独立池 + 多账号隔离）**
  - 自动识别 `Gemini`（5h + 周）、`Claude`（5h + 周）以及 Pro 订阅下的独立 `Argon` 周额度池（Ultra 订阅下自动合并归入 Gemini 池）。
  - 实时显示剩余百分比、重置倒计时，以及当前窗口的 **`已用 / 预估` 等效 API 美元价值**（支持一键切换 **当前生效价** / **标准原价**）。
  - **多账号归因隔离**：后台静默维护本地匿名哈希账本（仅记录账号邮箱的截断 SHA-256 摘要，不存明文邮箱），切换 Pro / Ultra 等多账号时严格隔离各账号的花费与历史参考估值；在启用于半途的过渡窗口中自动隐藏旧混杂消耗（以 `*` 提示）并改用新增消耗增量外推满额。
- **会话实时遥测（`会话` 标签页）**
  - 并列展示 **流式解码速度（`tok/s`）**、**端到端速度（`tok/s`）** 与 **本会话等效估算（`$`）**，自动识别服务端短包缓冲输出。
  - 显示每一跳底层真实路由模型 ID 标签。
  - **上下文水位趋势图**：折线面积图展示本会话上下文增长轨迹、容量上限线，以及自动/手动上下文压缩（Compaction）断崖落差标记。
  - **成本与 Token 构成条**：区分 `缓存读取 / 新输入 / 思考推理 / 正文输出` 四类消耗，支持一键切换 **按费用占比** 与 **按 Token 数量占比**。
  - 按对话轮次折叠展示每轮提问的耗时、跳数、速度与成本明细，并精确区分系统**自动压缩**与用户**手动 `/compact` 压缩**。
- **子智能体拓扑树（`子智能体` 标签页）**
  - 汇总主会话派生的 Subagent / Browser Agent / Swarm 节点拓扑、总输出 Token 与全树等效成本，点击任意子节点可直接切入查看详情。
- **全局统计与模型速度榜（`全局` 标签页）**
  - 支持按 **`当前账号` / `全部`** 与 **`本轮 5h` / `近 7 天` / `全部`** 两个维度交叉筛选，汇总本地历史的输入、缓存读取、输出 Token、缓存命中率与各底层模型稳态流式速度中位数（P50），并按账号标识展示历史额度窗口估值记录。

---

## 安装方式

无需安装任何第三方依赖（直接使用客户端内置的 Node 24 运行时）：

1. 将本仓库克隆或复制到全局插件目录 `plugins/agy-meter` 下：

   **Windows (PowerShell)**
   ```powershell
   git clone https://github.com/zui2sui/agy-meter.git "$env:USERPROFILE\.gemini\config\plugins\agy-meter"
   ```

   **macOS / Linux**
   ```bash
   git clone https://github.com/zui2sui/agy-meter.git ~/.gemini/config/plugins/agy-meter
   ```

   *(如果之前安装过旧版目录名，移除或禁用旧插件目录即可。)*

2. 打开 Antigravity 的 **Customizations / Plugins** 页面，确保 **AGY Meter** 处于启用状态，即可在右侧辅助栏打开面板（或在对话中输入提示词让助手生成打开面板的快捷链接）。

---

## 各项指标计算方法

所有指标均基于客户端本地只读 SQLite 会话库（`conversations/*.db`、`conversation_summaries.db`）与本地语言服务状态接口实时计算：

1. **流式速度与端到端速度（`tok/s`）**
   - **流式速度（Stream Speed）**：`outputTokens / streamSec`，衡量首包到达（TTFT）后模型纯流式解码速率（`outputTokens` 包含思考推理 Token 与正文输出 Token）。
   - **短包缓冲修正（`缓冲` / `Buf`）**：当服务端将极短回复或思考摘要一次性合并下发时，`streamSec` 极小会导致瞬时速率虚高。插件会自动识别此类短脉冲样本并标注 `缓冲`，同时回退展示本会话**稳态样本**（`streamSec >= 0.8s` 且 `outputTokens >= 80`）的中位数（P50）。
   - **端到端速度（E2E Speed）**：`outputTokens / (ttftSec + streamSec)`，将首包等待耗时一并计入的整体吞吐速率。
   - **全局模型榜速度**：取各底层 `modelId` 稳态流式样本的 **P50 中位数**（无稳态样本时取非缓冲样本 P50），避免极端短包拉偏均值。

2. **上下文水位、缓存命中率与压缩落差**
   - **当前上下文（Context）**：取最新一跳请求的 `inputTokens + cacheReadTokens`（缺失时回退至 `contextEst`），对比该模型上报的上下文容量上限（默认 `256K`）。
   - **缓存命中率（Cache Hit Rate）**：`∑ cacheReadTokens / ∑ (inputTokens + cacheReadTokens)`。
   - **上下文压缩（Compaction）**：读取本地 `CHECKPOINT` 步骤（`step_type = 23`），对比压缩前后相邻两跳上下文容量得出落差（`压缩前 → 压缩后`），并根据前置用户步骤是否携带原生 `/compact` 斜杠命令标记区分**手动压缩**与**自动压缩**。

3. **公开 API 等效成本与四维构成**
   - 按每一跳实际路由到的底层 `modelId` 匹配官方公开 API 参考单价（美元 / 百万 Token）逐跳累加：
     $$\text{单跳估算费用} = \frac{\text{inputTokens} \times P_{\text{in}} + \text{cacheReadTokens} \times P_{\text{cache}} + \text{outputTokens} \times P_{\text{out}}}{10^6}$$
   - **当前价 vs. 原价**：`当前价` 根据请求发生时间自动套用官方限时折扣单价；`原价` 按无折扣标准公开单价计算。
   - **四维构成**：总输出费用按每跳 `thinkingTokens / outputTokens` 比例拆分为**思考推理**与**正文输出**，与**缓存读取**、**新输入**共同组成费用/Token 占比条。

4. **套餐额度条 `已用 / 预估`（5h / 周 / Argon 池）**
   - **窗口累计已用（`已用`）**：读取本地状态接口返回的高精度剩余额度浮点数 `remainingFraction` 与重置时间 `resetTime`，由 `windowStart = resetTime - 窗口周期`（`5h` 或 `7天`）反推当前窗口起点，汇总该时间段内对应额度池的所有本地调用等效花费（Pro 订阅下 `Argon` 独立计池，合并池场景自动归入 `Gemini` 池）。
   - **100% 满额线性外推（`预估`）**：
     $$\text{100\% 满额预估参考值} = \frac{\text{当前窗口累计公开 API 等效花费}}{1 - \text{remainingFraction}}$$
   - 分母使用未四舍五入的原始浮点消耗比例 `1 - remainingFraction`。为防止新窗口刚开启时因分母过小产生数值抖动，`5h` 窗口已消耗 `< 1%`（`周` 窗口 `< 0.5%`）时暂不外推，优先显示上一周期保存的同池满额参考值（带 `≈` 前缀）。由于不同负载（高缓存命中 vs. 大量新输入/长思考输出）的公开 API 单价不同，满额折算值随使用结构自然波动属正常现象。

---

## License

[MIT](./LICENSE)
