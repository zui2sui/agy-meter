/**
 * AGY Meter — Minimalist Bilingual Frontend Controller (`app.js`)
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const urlParams = new URLSearchParams(window.location.search);

  function safeGet(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  }
  function safeSet(k, v) {
    try { localStorage.setItem(k, v); } catch { /* ignore */ }
  }

  function detectInitialLang() {
    const saved = safeGet('am_lang');
    if (saved === 'zh' || saved === 'en') return saved;
    return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }

  const state = {
    lang: detectInitialLang(),
    followMode: true,
    selectedConvId: '',
    etag: '',
    uiBuild: '',
    priceMode: (safeGet('am_price_mode') ?? safeGet('ts_price_mode')) === 'standard' ? 'standard' : 'effective',
    breakdownMode: (safeGet('am_breakdown_mode') ?? safeGet('ts_breakdown_mode')) === 'tokens' ? 'tokens' : 'cost',
    activeTab: 'session',
    globalRange: safeGet('am_global_range') || safeGet('ts_global_range') || '5h',
    accountScope: safeGet('am_account_scope') === 'all' ? 'all' : 'current',
    lastAccountKey: '',
    expandedTurns: new Set(),
    autoExpandedConv: '',
    autoExpandedMaxTurn: 0,
    payload: null,
    globalPayload: null,
    dropdownOpen: false,
    pollTimer: null,
    tickTimer: null,
    receivedAtMs: 0,
  };

  // ---------- Bilingual Dictionary (zh / en) ----------
  const I18N = {
    zh: {
      pickerTitle: '切换或搜索历史会话',
      followActiveTip: '正在自动跟随当前会话',
      followPinnedTip: '已锁定历史会话',
      selectSessionAria: '选择会话',
      searchSessionLabel: '搜索会话',
      searchPlaceholder: '搜索会话…',
      followResetBtn: '跟随当前',
      sessionListAria: '会话列表',
      priceGroupAria: '计价口径',
      priceEffBtn: '当前价',
      priceEffTip: '按官方公开 API 当前生效价（含限时折扣）估算',
      priceStdBtn: '原价',
      priceStdTip: '按官方公开 API 无折扣标准原价估算',
      langGroupAria: '界面语言',
      refreshAria: '刷新',
      tablistAria: '视图',
      tabSession: '会话',
      tabTree: '子智能体',
      tabGlobal: '全局',
      loading: '加载中…',
      noSession: '暂无会话',
      noSessionData: '暂无会话数据',
      waitingGen: '等待生成',
      // Quota strip
      qHeadTip: '按公开 API 单价折算的当前窗口等效消耗 / 100% 满额线性外推参考值（已按账号隔离归因；* 表示窗口开启于多账号追踪启用前，仅计启用后已归因花费并按增量推算满额）',
      qAcctTip: (lbl) => `当前登录账号：${lbl}`,
      qColPool: '额度',
      qColRem: '剩余',
      qColUsed: '已用',
      qColEst: '预估',
      winWk: '周',
      scopeWk: '本周',
      scope5h: '本轮',
      estLowSample: '消耗较少暂无法推算满额',
      estLowPartialSample: '该窗口开启于账本启用前，等待新消耗达阈值后按增量推算满额',
      estExtrapolated: (usedPct, val) => `按已消耗 ${usedPct}% 推算 100% 满额 ≈ ${val}`,
      estPartialExtrapolated: (deltaPct, val) => `过渡窗口：按开启追踪后新增消耗 ${deltaPct}% 增量推算满额 ≈ ${val}`,
      estFallback: (val) => `参考同账号上次满额估值 ≈ ${val}`,
      qPartialTag: '（仅计追踪启用后已归因调用）',
      qRowTip: (name, win, remPct, cd, scope, used, est, partialTag = '') =>
        `${name} ${win}额度 · 剩余 ${remPct}% (${cd}后重置) · ${scope}已用 ${used}${partialTag} · ${est}`,
      qBarAria: (name, win) => `${name} ${win}剩余额度`,
      // Session status & hero
      stTool: (name) => `执行工具 ${name}`,
      stStreaming: '流式输出中',
      stThinking: '思考/首包等待中',
      stPreparing: '准备请求模型中',
      stCompacted: (n) => `已压缩 ×${n}`,
      lblStreamSpeed: '流式速度',
      tagBuf: '缓冲',
      tagBufTip: '短回复由服务端缓冲冲刷，此处展示稳态流式速度',
      lblE2eSpeed: '端到端速度',
      lblSessionEst: '会话估算',
      lblContext: '上下文',
      lblCacheHit: '缓存命中',
      // Context chart
      ctxTitle: '上下文水位趋势',
      ctxCompactCount: (n) => `压缩 ×${n}`,
      ctxCompactBreakTip: (autoN, manN) => `自动压缩 ×${autoN} · 手动压缩 ×${manN}`,
      ctxPeak: (v) => `峰值 ${v}`,
      ctxCeil: (v) => `上限 ${v}`,
      ctxHover: (cur, lim) => `上下文 ${cur} / ${lim}`,
      ctxPinTip: (isManual, hm, b, a) => `${isManual ? '手动压缩' : '自动压缩'}${hm ? ` (${hm})` : ''}：${b} → ${a}`,
      ctxAxisStart: (v) => `← 起点 ${v}`,
      ctxAxisNow: (v, p) => `当前 ${v} (${p}%) →`,
      ctxSvgSummary: (s, c, lim, pk, n) =>
        `本会话上下文从 ${s} 变化至当前 ${c}（上限 ${lim}，峰值 ${pk}，共触发 ${n} 次上下文压缩）`,
      ctxTblCap: '上下文水位摘要',
      ctxTblMetric: '指标',
      ctxTblVal: '数值',
      ctxTblCur: '当前上下文',
      ctxTblPeak: '历史峰值',
      ctxTblDrops: '压缩次数',
      // Breakdown bar
      bdTitle: '成本与 Token 构成',
      bdGroupAria: '构成占比维度',
      bdBtnCost: '费用',
      bdBtnTok: 'Token',
      catCache: '缓存读取',
      catInput: '新输入',
      catThink: '思考推理',
      catOut: '正文输出',
      bdSegTip: (lbl, usd, cp, tok, tp) => `${lbl}：${usd} (费用 ${cp}%) · ${tok} tokens (数量 ${tp}%)`,
      bdTblCap: '会话成本与 Token 构成明细',
      bdThCat: '类别',
      bdThTok: 'Token 数量',
      bdThTokPct: '数量占比',
      bdThCost: '估算费用',
      bdThCostPct: '费用占比',
      // Compactions & turns
      compAuto: '自动压缩',
      compManual: '手动压缩',
      compFrom: (v) => `原 ${v}`,
      compDivTip: (isManual, hm, delta) =>
        `${isManual ? '手动上下文压缩' : '上下文自动压缩'}${hm ? ` (${hm})` : ''}${delta ? `：${delta}` : ''}`,
      turnDefaultPrompt: (n) => `提问 #${n}`,
      turnSystemPrompt: '(子智能体或系统触发任务)',
      // Subagent tree
      treeEmpty: '暂无关联节点',
      treeSingle: '当前会话未派生子智能体',
      treeNodes: '节点数',
      treeOut: '全树输出',
      treeEst: '全树估算',
      roleRoot: '主会话',
      titleRootFallback: '当前主会话',
      titleSubFallback: (id8) => `子智能体 ${id8}`,
      // Global tab
      globLoading: '汇总中…',
      globRefreshing: '正在汇总…',
      globError: '汇总读取失败',
      globEmpty: '该范围内暂无数据',
      globRangeTitle: '统计范围',
      globRangeAria: '时间范围',
      globAcctTitle: '账号视角',
      globAcctAria: '账号统计范围',
      globAcctCur: '当前账号',
      globAcctAll: '全部',
      globR5h: '本轮 5h',
      globR7d: '近 7 天',
      globRAll: '全部',
      globTokBannerAria: 'Token 用量汇总',
      globInTag: '入 (新输入)',
      globCacheTag: '缓 (缓存读取)',
      globOutTag: '出 (总输出)',
      globHitLabel: '缓存命中率',
      globSpendLabel: '累计估算账单',
      globPillOut: '输出',
      globPillHit: '缓存',
      histTitle: '额度窗口记录',
      histLegacyAcct: '旧记录(未分号)',
      histPartialTip: (deltaPct) => `过渡窗口按开启追踪后新增 ${deltaPct}% 增量推算`,
      histColPool: '额度',
      histColReset: '重置时间',
      histColUsedPct: '已耗比例',
      histColUsed: '已用',
      histColEst: '预估',
      // Session dropdown
      ddEmpty: '无匹配会话',
      ddError: '读取失败',
      ddFallbackTitle: (id8) => `会话 ${id8}`,
    },
    en: {
      pickerTitle: 'Switch or search historical sessions',
      followActiveTip: 'Auto-following active session',
      followPinnedTip: 'Pinned to selected session',
      selectSessionAria: 'Select session',
      searchSessionAria: 'Search sessions',
      searchSessionLabel: 'Search sessions',
      searchPlaceholder: 'Search sessions…',
      followResetBtn: 'Follow active',
      sessionListAria: 'Session list',
      priceGroupAria: 'Pricing mode',
      priceEffBtn: 'Promo',
      priceEffTip: 'Estimate using current effective public API rates (incl. active promos)',
      priceStdBtn: 'List',
      priceStdTip: 'Estimate using undiscounted standard public API list rates',
      langGroupAria: 'Interface language',
      refreshAria: 'Refresh',
      tablistAria: 'Views',
      tabSession: 'Session',
      tabTree: 'Subagents',
      tabGlobal: 'Global',
      loading: 'Loading…',
      noSession: 'No session',
      noSessionData: 'No session data',
      waitingGen: 'Waiting for output',
      // Quota strip
      qHeadTip: 'Current window spend at public API rates / linearly extrapolated 100% value (isolated per account; * = window opened before ledger tracking began, showing post-tracking spend and delta estimate)',
      qAcctTip: (lbl) => `Signed-in account: ${lbl}`,
      qColPool: 'Pool',
      qColRem: 'Left',
      qColUsed: 'Used',
      qColEst: 'Est.',
      winWk: 'Wk',
      scopeWk: 'Weekly',
      scope5h: 'Window',
      estLowSample: 'Too little usage to extrapolate full window',
      estLowPartialSample: 'Pre-tracking window; waiting for delta usage threshold to extrapolate',
      estExtrapolated: (usedPct, val) => `Extrapolated 100% value from ${usedPct}% used ≈ ${val}`,
      estPartialExtrapolated: (deltaPct, val) => `Transitional window: extrapolated from +${deltaPct}% post-tracking delta ≈ ${val}`,
      estFallback: (val) => `Same-account previous window reference ≈ ${val}`,
      qPartialTag: ' (post-tracking attributed only)',
      qRowTip: (name, win, remPct, cd, scope, used, est, partialTag = '') =>
        `${name} ${win} quota · ${remPct}% left (resets in ${cd}) · ${scope} used ${used}${partialTag} · ${est}`,
      qBarAria: (name, win) => `${name} ${win} remaining quota`,
      // Session status & hero
      stTool: (name) => `Running ${name}`,
      stStreaming: 'Streaming',
      stThinking: 'Thinking / waiting TTFT',
      stPreparing: 'Preparing request',
      stCompacted: (n) => `Compacted ×${n}`,
      lblStreamSpeed: 'Stream Speed',
      tagBuf: 'Buf',
      tagBufTip: 'Short burst buffered by server; showing steady stream speed',
      lblE2eSpeed: 'E2E Speed',
      lblSessionEst: 'Session Est.',
      lblContext: 'Context',
      lblCacheHit: 'Cache Hit',
      // Context chart
      ctxTitle: 'Context Trend',
      ctxCompactCount: (n) => `Compact ×${n}`,
      ctxCompactBreakTip: (autoN, manN) => `Auto ×${autoN} · Manual ×${manN}`,
      ctxPeak: (v) => `Peak ${v}`,
      ctxCeil: (v) => `Limit ${v}`,
      ctxHover: (cur, lim) => `Context ${cur} / ${lim}`,
      ctxPinTip: (isManual, hm, b, a) => `${isManual ? 'Manual' : 'Auto'} compaction${hm ? ` (${hm})` : ''}: ${b} → ${a}`,
      ctxAxisStart: (v) => `← Start ${v}`,
      ctxAxisNow: (v, p) => `Now ${v} (${p}%) →`,
      ctxSvgSummary: (s, c, lim, pk, n) =>
        `Session context changed from ${s} to ${c} (limit ${lim}, peak ${pk}, ${n} compactions)`,
      ctxTblCap: 'Context Window Summary',
      ctxTblMetric: 'Metric',
      ctxTblVal: 'Value',
      ctxTblCur: 'Current Context',
      ctxTblPeak: 'Peak Context',
      ctxTblDrops: 'Compactions',
      // Breakdown bar
      bdTitle: 'Cost & Token Breakdown',
      bdGroupAria: 'Breakdown mode',
      bdBtnCost: 'Cost',
      bdBtnTok: 'Tokens',
      catCache: 'Cache Read',
      catInput: 'New Input',
      catThink: 'Thinking',
      catOut: 'Response',
      bdSegTip: (lbl, usd, cp, tok, tp) => `${lbl}: ${usd} (${cp}% cost) · ${tok} tokens (${tp}% tokens)`,
      bdTblCap: 'Session Cost and Token Breakdown',
      bdThCat: 'Category',
      bdThTok: 'Tokens',
      bdThTokPct: 'Token %',
      bdThCost: 'Est. Cost',
      bdThCostPct: 'Cost %',
      // Compactions & turns
      compAuto: 'Auto Compact',
      compManual: 'Manual Compact',
      compFrom: (v) => `from ${v}`,
      compDivTip: (isManual, hm, delta) =>
        `${isManual ? 'Manual' : 'Auto'} context compaction${hm ? ` (${hm})` : ''}${delta ? `: ${delta}` : ''}`,
      turnDefaultPrompt: (n) => `Turn #${n}`,
      turnSystemPrompt: '(Subagent or system task)',
      // Subagent tree
      treeEmpty: 'No linked nodes',
      treeSingle: 'No subagents spawned in this session',
      treeNodes: 'Nodes',
      treeOut: 'Tree Output',
      treeEst: 'Tree Est.',
      roleRoot: 'Root',
      titleRootFallback: 'Current Session',
      titleSubFallback: (id8) => `Subagent ${id8}`,
      // Global tab
      globLoading: 'Aggregating…',
      globRefreshing: 'Aggregating…',
      globError: 'Failed to load summary',
      globEmpty: 'No data in this range',
      globRangeTitle: 'Time Range',
      globRangeAria: 'Time range',
      globAcctTitle: 'Account Scope',
      globAcctAria: 'Account scope',
      globAcctCur: 'Current',
      globAcctAll: 'All',
      globR5h: '5h Win',
      globR7d: '7 Days',
      globRAll: 'All',
      globTokBannerAria: 'Token usage summary',
      globInTag: 'New Input',
      globCacheTag: 'Cache Read',
      globOutTag: 'Total Output',
      globHitLabel: 'Cache Hit Rate',
      globSpendLabel: 'Est. API Spend',
      globPillOut: 'Out',
      globPillHit: 'Cache',
      histTitle: 'Quota Window History',
      histLegacyAcct: 'Legacy (unscoped)',
      histPartialTip: (deltaPct) => `Transitional window extrapolated from +${deltaPct}% post-tracking delta`,
      histColPool: 'Pool',
      histColReset: 'Reset',
      histColUsedPct: 'Used %',
      histColUsed: 'Used',
      histColEst: 'Est.',
      // Session dropdown
      ddEmpty: 'No matching sessions',
      ddError: 'Failed to load',
      ddFallbackTitle: (id8) => `Session ${id8}`,
    },
  };

  function tr() {
    return I18N[state.lang] || I18N.zh;
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------- Sync static DOM attributes & document <html lang> ----------
  function applyStaticI18n() {
    const t = tr();
    document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-CN';

    $('session-picker-btn').title = t.pickerTitle;
    $('session-dropdown').setAttribute('aria-label', t.selectSessionAria);
    const searchLbl = $('session-search-label');
    if (searchLbl) searchLbl.textContent = t.searchSessionLabel;
    $('session-search-input').placeholder = t.searchPlaceholder;
    $('follow-reset-btn').textContent = t.followResetBtn;
    $('session-list').setAttribute('aria-label', t.sessionListAria);

    const priceGrp = $('price-seg-group');
    if (priceGrp) priceGrp.setAttribute('aria-label', t.priceGroupAria);
    const effBtn = $('price-mode-effective');
    effBtn.textContent = t.priceEffBtn;
    effBtn.title = t.priceEffTip;
    const stdBtn = $('price-mode-standard');
    stdBtn.textContent = t.priceStdBtn;
    stdBtn.title = t.priceStdTip;

    const langGrp = $('lang-seg-group');
    if (langGrp) langGrp.setAttribute('aria-label', t.langGroupAria);
    const zhBtn = $('lang-zh');
    const enBtn = $('lang-en');
    if (zhBtn && enBtn) {
      const isZh = state.lang === 'zh';
      zhBtn.classList.toggle('is-active', isZh);
      zhBtn.setAttribute('aria-pressed', isZh ? 'true' : 'false');
      enBtn.classList.toggle('is-active', !isZh);
      enBtn.setAttribute('aria-pressed', !isZh ? 'true' : 'false');
    }

    const refBtn = $('refresh-btn');
    refBtn.setAttribute('aria-label', t.refreshAria);
    refBtn.title = t.refreshAria;

    const tablist = $('main-tablist');
    if (tablist) tablist.setAttribute('aria-label', t.tablistAria);
    $('tab-session').textContent = t.tabSession;
    const treeLbl = $('tab-tree-label');
    if (treeLbl) treeLbl.textContent = t.tabTree;
    $('tab-global').textContent = t.tabGlobal;

    const initEmpty = $('initial-empty');
    if (initEmpty) initEmpty.textContent = t.loading;
  }

  // ---------- Host theme sync ----------
  function syncThemeScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;color:var(--background, #f7f8fa)';
    document.documentElement.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    const nums = (rgb.match(/[\d.]+/g) || []).map(Number);
    if (nums.length >= 3) {
      const scale = rgb.startsWith('color(') ? 1 : 255;
      const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const nextTheme = lum < 0.5 ? 'dark' : 'light';
      if (document.documentElement.dataset.theme !== nextTheme) {
        document.documentElement.dataset.theme = nextTheme;
      }
      return;
    }
    document.documentElement.dataset.theme =
      window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  new MutationObserver(syncThemeScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', syncThemeScheme);
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'theme-change') requestAnimationFrame(syncThemeScheme);
  });

  // ---------- Formatters ----------
  function fmtTok(n) {
    const num = Number(n || 0);
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 10_000) return `${Math.round(num / 1_000)}K`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
    return String(Math.round(num));
  }

  function fmtRate(r) {
    if (r === null || r === undefined || !Number.isFinite(r) || r <= 0) return '—';
    return r >= 100 ? String(Math.round(r)) : r.toFixed(1);
  }

  function fmtUsd(v) {
    const num = Number(v || 0);
    if (!Number.isFinite(num) || num <= 0) return '$0.00';
    if (num < 0.01) return `$${num.toFixed(3)}`;
    if (num >= 1000) return `$${Math.round(num)}`;
    return `$${num.toFixed(2)}`;
  }

  function fmtPct(ratio, digits = 0) {
    return `${(Math.max(0, Number(ratio || 0)) * 100).toFixed(digits)}%`;
  }

  function fmtCountdown(sec) {
    const s = Math.max(0, Math.floor(Number(sec || 0)));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (state.lang === 'en') {
      if (d > 0) return `${d}d ${h}h`;
      return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
    }
    if (d > 0) return `${d}天${h}h`;
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
  }

  function fmtHm(tsSec) {
    if (!tsSec || tsSec <= 0) return '';
    const d = new Date(tsSec * 1000);
    if (Number.isNaN(d.getTime())) return '';
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function fmtShortTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function pickCost(obj) {
    if (!obj) return 0;
    return state.priceMode === 'standard'
      ? (obj.costStandard ?? obj.spendStandard ?? 0)
      : (obj.costEffective ?? obj.spendEffective ?? 0);
  }

  const POOL_LABELS = { gemini: 'Gemini', claude: 'Claude', argon: 'Argon' };

  function fmtPoolName(poolKey) {
    return POOL_LABELS[poolKey] || String(poolKey || '—');
  }

  function localizeInferredBase(base) {
    if (!base || state.lang !== 'en') return base;
    return String(base)
      .replace('规划主控', 'Orchestrator')
      .replace('高速执行器', 'Worker')
      .replace('默认 Pro 路由池', 'Default Pro Pool');
  }

  function renderChip(badge) {
    if (!badge) return '<span class="model-chip">—</span>';
    const isExp = Boolean(badge.expTag);
    const shortBase = badge.raw === 'gemini-pro-orchestrator'
      ? 'orchestrator (Carbon)'
      : ((badge.raw === 'gemini-pro-orchestrator-argon' || badge.raw === 'gemini-pro-orchestrator-g1-pro')
          ? 'orchestrator (Argon)'
          : (badge.raw === 'gemini-flash-worker-agy' ? 'flash-worker (3.8)' : badge.raw));
    const tip = [badge.raw, badge.displayName, localizeInferredBase(badge.inferredBase)].filter(Boolean).join(' · ');
    return `<span class="model-chip ${isExp ? 'exp' : ''}" title="${esc(tip)}">${esc(shortBase)}</span>`;
  }

  // ---------- API ----------
  async function apiGet(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function hostConvId() {
    return window.sidecar?.conversationId || urlParams.get('conversationId') || '';
  }

  // ---------- Header & Quota Strip ----------
  function renderHeader() {
    const t = tr();
    const data = state.payload;
    const dot = $('follow-pill');
    dot.classList.toggle('is-following', state.followMode);
    dot.title = state.followMode ? t.followActiveTip : t.followPinnedTip;

    $('current-session-title').textContent =
      data?.meta?.title || (data?.conversationId ? data.conversationId.slice(0, 8) : t.noSession);

    const busy = (data?.session?.liveState?.state || 'idle') !== 'idle';
    $('live-dot').classList.toggle('is-busy', busy);

    const nodeCount = data?.tree?.nodeCount || 0;
    const badge = $('tree-count-badge');
    if (nodeCount > 1) {
      badge.textContent = String(nodeCount);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    const isEff = state.priceMode === 'effective';
    $('price-mode-effective').classList.toggle('is-active', isEff);
    $('price-mode-effective').setAttribute('aria-pressed', isEff ? 'true' : 'false');
    $('price-mode-standard').classList.toggle('is-active', !isEff);
    $('price-mode-standard').setAttribute('aria-pressed', !isEff ? 'true' : 'false');

    const strip = $('quota-strip');
    const pools = data?.quota?.pools || [];
    if (!data?.quota?.available || !pools.length) {
      strip.innerHTML = '';
      return;
    }

    const elapsed = state.receivedAtMs > 0 ? Math.max(0, (Date.now() - state.receivedAtMs) / 1000) : 0;
    const acctLabel = data?.quota?.account?.accountLabel || '';
    const acctBadgeHtml = acctLabel
      ? `<span class="q-h-acct" title="${esc(t.qAcctTip(acctLabel))}">${esc(acctLabel)}</span>`
      : '';

    const headHtml = `
      <div class="q-head" aria-hidden="true" title="${esc(t.qHeadTip)}">
        <span class="q-h-pool"><span>${esc(t.qColPool)}</span>${acctBadgeHtml}</span>
        <span class="q-h-rem">${esc(t.qColRem)}</span>
        <span class="q-h-used">${esc(t.qColUsed)}</span>
        <span class="q-h-slash">/</span>
        <span class="q-h-est">${esc(t.qColEst)}</span>
      </div>
    `;

    const groupsHtml = pools.map((p, pIdx) => {
      const shortName = fmtPoolName(p.poolKey);
      const buckets = Array.isArray(p.buckets) && p.buckets.length
        ? p.buckets
        : [{ window: '5h', label: '5h', ...p }];

      const rowsHtml = buckets.map((b, idx) => {
        const remPct = Math.max(0, Math.min(100, (b.remainingFraction ?? 0) * 100));
        const tone = remPct <= 15 ? 'low' : (remPct <= 35 ? 'warn' : '');
        const remSec = Math.max(0, (b.secondsUntilReset || 0) - elapsed);
        const spend = state.priceMode === 'standard' ? b.spendStandard : b.spendEffective;
        const fullVal = state.priceMode === 'standard' ? b.fullValueStandard : b.fullValueEffective;
        const fallback = state.priceMode === 'standard' ? b.fallbackFullStandard : b.fallbackFullEffective;
        const isWk = b.window === 'weekly';
        const winLabel = isWk ? t.winWk : '5h';
        const scopeWord = isWk ? t.scopeWk : t.scope5h;
        const isPartial = Boolean(b.isPartialWindow);
        const usedStr = fmtUsd(spend);

        let estHtml = `<span class="q-est dim">—</span>`;
        let estTip = isPartial ? t.estLowPartialSample : t.estLowSample;
        if (b.sampleReady && fullVal > 0) {
          estHtml = `<span class="q-est">${esc(fmtUsd(fullVal))}</span>`;
          if (isPartial && b.deltaUsedFraction > 0) {
            estTip = t.estPartialExtrapolated((b.deltaUsedFraction * 100).toFixed(1), fmtUsd(fullVal));
          } else {
            estTip = t.estExtrapolated((100 - remPct).toFixed(1), fmtUsd(fullVal));
          }
        } else if (fallback > 0) {
          estHtml = `<span class="q-est dim">≈${esc(fmtUsd(fallback))}</span>`;
          estTip = t.estFallback(fmtUsd(fallback));
        }

        const partialTag = isPartial ? t.qPartialTag : '';
        const rowTip = t.qRowTip(shortName, winLabel, remPct.toFixed(1), fmtCountdown(remSec), scopeWord, usedStr, estTip, partialTag);
        const usedHtml = isPartial
          ? `<span class="q-used is-partial">${esc(usedStr)}<sup class="q-used-mark" aria-hidden="true">*</sup></span>`
          : `<span class="q-used">${esc(usedStr)}</span>`;

        return `
          <div class="q-row" title="${esc(rowTip)}">
            <span class="q-name" ${idx > 0 ? 'aria-hidden="true"' : ''}>${idx === 0 ? esc(shortName) : ''}</span>
            <span class="q-win ${isWk ? 'is-wk' : ''}">${esc(winLabel)}</span>
            <progress class="q-bar ${tone}" max="100" value="${Math.max(0, Math.min(100, remPct)).toFixed(1)}" aria-label="${esc(t.qBarAria(shortName, winLabel))}"></progress>
            <span class="q-pct">${Math.round(remPct)}%</span>
            ${usedHtml}
            <span class="q-slash" aria-hidden="true">/</span>
            ${estHtml}
          </div>
        `;
      }).join('');

      return `${pIdx > 0 ? '<div class="q-sep-line" role="separator"></div>' : ''}${rowsHtml}`;
    }).join('');

    strip.innerHTML = `${headHtml}${groupsHtml}`;
  }

  // ---------- Tab 1: Session ----------
  function renderContextChart(sess) {
    const t = tr();
    const rawGens = sess?.generations || [];
    const pts = [];
    for (const g of rawGens) {
      const tok = g.totalPromptTokens > 0 ? g.totalPromptTokens : (g.contextEst || 0);
      if (tok <= 0) continue;
      pts.push({
        step: g.stepIdx >= 0 ? g.stepIdx : g.genIdx,
        tok,
        createdAt: g.createdAt || 0,
        modelId: g.modelId || '',
      });
    }
    if (!pts.length) return '';
    if (pts.length === 1) {
      pts.unshift({ step: 0, tok: 0, createdAt: pts[0].createdAt, modelId: pts[0].modelId });
    }

    const k = sess.kpis || {};
    const limit = k.contextLimit || 256000;
    const peakTok = Math.max(...pts.map((p) => p.tok));
    const yMax = Math.max(limit * 1.08, peakTok * 1.05);

    const W = 1000, H = 100;
    const padX = 10, padTop = 6, padBot = 5;
    const plotW = W - padX * 2;
    const plotH = H - padTop - padBot;

    const xOf = (i) => padX + (i / Math.max(1, pts.length - 1)) * plotW;
    const yOf = (tok) => H - padBot - Math.max(0, Math.min(1, tok / yMax)) * plotH;

    const comps = sess.compactions || [];
    const dropByAfterIdx = new Map();
    const drops = [];

    for (const c of comps) {
      const isManual = c.trigger === 'manual';
      const afterIdx = pts.findIndex((p) => p.step > c.stepIdx);
      if (afterIdx > 0) {
        const beforeTok = c.beforeTokens > 0 ? c.beforeTokens : pts[afterIdx - 1].tok;
        const afterTok = c.afterTokens > 0 ? c.afterTokens : pts[afterIdx].tok;
        const x = (xOf(afterIdx - 1) + xOf(afterIdx)) / 2;
        const d = {
          afterIdx,
          x,
          yTop: yOf(beforeTok),
          yBot: yOf(afterTok),
          beforeTok,
          afterTok,
          createdAt: c.createdAt,
          isManual,
        };
        dropByAfterIdx.set(afterIdx, d);
        drops.push(d);
      } else if (afterIdx === -1 && c.stepIdx > pts[pts.length - 1].step) {
        const beforeTok = c.beforeTokens > 0 ? c.beforeTokens : pts[pts.length - 1].tok;
        const afterTok = c.afterTokens > 0 ? c.afterTokens : Math.round(beforeTok * 0.14);
        drops.push({
          afterIdx: -1,
          x: W - padX,
          yTop: yOf(beforeTok),
          yBot: yOf(afterTok),
          beforeTok,
          afterTok,
          createdAt: c.createdAt,
          isManual,
        });
      }
    }

    const segs = [`M ${xOf(0).toFixed(1)} ${yOf(pts[0].tok).toFixed(1)}`];
    for (let i = 1; i < pts.length; i++) {
      const d = dropByAfterIdx.get(i);
      if (d) {
        segs.push(`L ${d.x.toFixed(1)} ${yOf(pts[i - 1].tok).toFixed(1)}`);
        segs.push(`L ${d.x.toFixed(1)} ${yOf(pts[i].tok).toFixed(1)}`);
      }
      segs.push(`L ${xOf(i).toFixed(1)} ${yOf(pts[i].tok).toFixed(1)}`);
    }
    const linePath = segs.join(' ');
    const areaPath = `${linePath} L ${xOf(pts.length - 1).toFixed(1)} ${(H - padBot).toFixed(1)} L ${xOf(0).toFixed(1)} ${(H - padBot).toFixed(1)} Z`;

    const yCeil = yOf(limit);
    const dropLinesSvg = drops.map((d) =>
      `<line x1="${d.x.toFixed(1)}" y1="${d.yTop.toFixed(1)}" x2="${d.x.toFixed(1)}" y2="${d.yBot.toFixed(1)}" stroke="${d.isManual ? 'var(--primary)' : 'var(--violet)'}" stroke-width="1.5" ${d.isManual ? '' : 'stroke-dasharray="3 2.5"'} vector-effect="non-scaling-stroke"/>`
    ).join('');

    const stride = Math.max(1, Math.ceil(pts.length / 44));
    const sampled = [];
    for (let i = 0; i < pts.length; i += stride) sampled.push(i);
    if (sampled[sampled.length - 1] !== pts.length - 1) sampled.push(pts.length - 1);

    const hoverRects = sampled.map((ptIdx, sIdx) => {
      const p = pts[ptIdx];
      const cx = xOf(ptIdx);
      const prevX = sIdx === 0 ? 0 : (xOf(sampled[sIdx - 1]) + cx) / 2;
      const nextX = sIdx === sampled.length - 1 ? W : (cx + xOf(sampled[sIdx + 1])) / 2;
      const hm = fmtHm(p.createdAt);
      const tip = [hm, p.modelId, t.ctxHover(fmtTok(p.tok), fmtTok(limit))].filter(Boolean).join(' · ');
      return `<rect x="${prevX.toFixed(1)}" y="0" width="${Math.max(2, nextX - prevX).toFixed(1)}" height="${H}" fill="transparent"><title>${esc(tip)}</title></rect>`;
    }).join('');

    const pinsHtml = drops.map((d) => {
      const hm = fmtHm(d.createdAt);
      const tip = t.ctxPinTip(d.isManual, hm, fmtTok(d.beforeTok), fmtTok(d.afterTok));
      return `<span class="ctx-pin ${d.isManual ? 'is-manual' : ''}" style="left:${((d.x / W) * 100).toFixed(2)}%;top:${((d.yBot / H) * 100).toFixed(2)}%" title="${esc(tip)}"></span>`;
    }).join('');

    const lastPt = pts[pts.length - 1];
    const curTok = k.contextTokens || lastPt.tok;
    const curPct = limit > 0 ? (curTok / limit) * 100 : 0;
    const dotTone = curPct >= 88 ? 'low' : (curPct >= 72 ? 'warn' : '');
    const lastXPct = (xOf(pts.length - 1) / W) * 100;
    const lastYPct = (yOf(lastPt.tok) / H) * 100;

    const manDrops = drops.filter((d) => d.isManual).length;
    const autoDrops = drops.length - manDrops;
    const metaHtml = drops.length > 0
      ? `<span class="compact-leg" title="${esc(t.ctxCompactBreakTip(autoDrops, manDrops))}"><i class="pin-swatch" aria-hidden="true"></i>${esc(t.ctxCompactCount(drops.length))}</span><span>${esc(t.ctxPeak(fmtTok(peakTok)))}</span>`
      : `<span>${esc(t.ctxPeak(fmtTok(peakTok)))}</span>`;

    const svgSummary = t.ctxSvgSummary(fmtTok(pts[0].tok), fmtTok(curTok), fmtTok(limit), fmtTok(peakTok), drops.length);

    return `
      <figure class="viz-block">
        <figcaption class="viz-cap">
          <span>${esc(t.ctxTitle)}</span>
          <span class="viz-meta">${metaHtml}</span>
        </figcaption>
        <div class="ctx-stage">
          <span class="ctx-ceil-tag" aria-hidden="true">${esc(t.ctxCeil(fmtTok(limit)))}</span>
          <svg role="img" aria-label="${esc(svgSummary)}" class="ctx-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
            <defs>
              <linearGradient id="ctx-area-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--primary)" stop-opacity="0.30"/>
                <stop offset="100%" stop-color="var(--primary)" stop-opacity="0.03"/>
              </linearGradient>
            </defs>
            <line x1="0" y1="${yCeil.toFixed(1)}" x2="${W}" y2="${yCeil.toFixed(1)}" stroke="var(--fg-subtle)" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>
            <path d="${areaPath}" fill="url(#ctx-area-grad)"/>
            <path d="${linePath}" fill="none" stroke="var(--primary)" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
            ${dropLinesSvg}
            ${hoverRects}
          </svg>
          ${pinsHtml}
          <span class="ctx-dot ${dotTone}" style="left:${lastXPct.toFixed(2)}%;top:${lastYPct.toFixed(2)}%" aria-hidden="true"></span>
        </div>
        <div class="viz-axis" aria-hidden="true">
          <span>${esc(t.ctxAxisStart(fmtTok(pts[0].tok)))}</span>
          <span>${esc(t.ctxAxisNow(fmtTok(curTok), Math.round(curPct)))}</span>
        </div>
        <table class="visually-hidden">
          <caption>${esc(t.ctxTblCap)}</caption>
          <thead>
            <tr><th scope="col">${esc(t.ctxTblMetric)}</th><th scope="col">${esc(t.ctxTblVal)}</th></tr>
          </thead>
          <tbody>
            <tr><th scope="row">${esc(t.ctxTblCur)}</th><td>${esc(fmtTok(curTok))} / ${esc(fmtTok(limit))}</td></tr>
            <tr><th scope="row">${esc(t.ctxTblPeak)}</th><td>${esc(fmtTok(peakTok))}</td></tr>
            <tr><th scope="row">${esc(t.ctxTblDrops)}</th><td>${drops.length}</td></tr>
          </tbody>
        </table>
      </figure>
    `;
  }

  function renderBreakdownBar(sess) {
    const t = tr();
    const k = sess?.kpis;
    if (!k) return '';
    const isStd = state.priceMode === 'standard';

    let cacheCost = 0, inputCost = 0, thinkCost = 0, outCost = 0;
    for (const g of (sess.generations || [])) {
      const b = isStd ? g.breakdownStandard : g.breakdownEffective;
      if (!b) continue;
      cacheCost += b.cache || 0;
      inputCost += b.input || 0;
      const gOut = b.output || 0;
      const tShare = g.outputTokens > 0 ? Math.min(1, Math.max(0, (g.thinkingTokens || 0) / g.outputTokens)) : 0;
      thinkCost += gOut * tShare;
      outCost += gOut * (1 - tShare);
    }

    const cacheTok = k.cacheReadTokens || 0;
    const inputTok = k.inputTokens || 0;
    const thinkTok = k.thinkingTokens || 0;
    const outTok = Math.max(0, (k.outputTokens || 0) - thinkTok);

    const totalTok = cacheTok + inputTok + thinkTok + outTok;
    const totalCost = cacheCost + inputCost + thinkCost + outCost;
    if (totalTok <= 0) return '';

    const byTok = state.breakdownMode === 'tokens';
    const items = [
      { cls: 's-cache', label: t.catCache, tok: cacheTok, cost: cacheCost },
      { cls: 's-input', label: t.catInput, tok: inputTok, cost: inputCost },
      { cls: 's-think', label: t.catThink, tok: thinkTok, cost: thinkCost },
      { cls: 's-out', label: t.catOut, tok: outTok, cost: outCost },
    ].map((it) => {
      const costShare = totalCost > 0 ? it.cost / totalCost : it.tok / totalTok;
      const tokShare = it.tok / totalTok;
      return {
        ...it,
        costShare,
        tokShare,
        share: byTok ? tokShare : costShare,
      };
    });

    const segsHtml = items
      .filter((it) => it.tok > 0 || it.cost > 0)
      .map((it) => {
        const tip = t.bdSegTip(it.label, fmtUsd(it.cost), (it.costShare * 100).toFixed(1), fmtTok(it.tok), (it.tokShare * 100).toFixed(1));
        return `<div class="comp-seg ${it.cls}" style="flex:${Math.max(0.018, it.share).toFixed(4)} 1 0%" title="${esc(tip)}"></div>`;
      })
      .join('');

    const legendHtml = items.map((it) => {
      const hasVal = it.tok > 0 || it.cost > 0;
      const pctStr = !hasVal || it.share <= 0
        ? '0%'
        : (it.share * 100 < 1 ? '<1%' : `${Math.round(it.share * 100)}%`);
      const subText = byTok ? fmtUsd(it.cost) : fmtTok(it.tok);
      const mainText = byTok ? fmtTok(it.tok) : fmtUsd(it.cost);
      const tip = t.bdSegTip(it.label, fmtUsd(it.cost), (it.costShare * 100).toFixed(1), fmtTok(it.tok), (it.tokShare * 100).toFixed(1));
      return `
        <div class="comp-item" title="${esc(tip)}">
          <i class="comp-sw ${it.cls}" aria-hidden="true"></i>
          <span class="comp-name">${esc(it.label)}</span>
          <span class="comp-tok">${esc(subText)}</span>
          <span class="comp-val">${esc(mainText)}</span>
          <span class="comp-pct">${pctStr}</span>
        </div>
      `;
    }).join('');

    const tableRowsHtml = items.map((it) =>
      `<tr><th scope="row">${esc(it.label)}</th><td>${esc(fmtTok(it.tok))}</td><td>${(it.tokShare * 100).toFixed(1)}%</td><td>${esc(fmtUsd(it.cost))}</td><td>${(it.costShare * 100).toFixed(1)}%</td></tr>`
    ).join('');

    return `
      <figure class="viz-block">
        <figcaption class="viz-cap">
          <span>${esc(t.bdTitle)}</span>
          <div class="mini-seg" role="group" aria-label="${esc(t.bdGroupAria)}">
            <button type="button" class="mini-seg-btn" data-comp-mode="cost" aria-pressed="${byTok ? 'false' : 'true'}">${esc(t.bdBtnCost)}</button>
            <button type="button" class="mini-seg-btn" data-comp-mode="tokens" aria-pressed="${byTok ? 'true' : 'false'}">${esc(t.bdBtnTok)}</button>
          </div>
        </figcaption>
        <div class="comp-bar" aria-hidden="true">${segsHtml}</div>
        <div class="comp-grid" aria-hidden="true">${legendHtml}</div>
        <table class="visually-hidden">
          <caption>${esc(t.bdTblCap)}</caption>
          <thead>
            <tr>
              <th scope="col">${esc(t.bdThCat)}</th>
              <th scope="col">${esc(t.bdThTok)}</th>
              <th scope="col">${esc(t.bdThTokPct)}</th>
              <th scope="col">${esc(t.bdThCost)}</th>
              <th scope="col">${esc(t.bdThCostPct)}</th>
            </tr>
          </thead>
          <tbody>${tableRowsHtml}</tbody>
        </table>
      </figure>
    `;
  }

  function renderCompactionDivider(c) {
    const t = tr();
    const isManual = c.trigger === 'manual';
    const timeStr = fmtHm(c.createdAt);
    const hasDelta = c.beforeTokens > 0 && c.afterTokens > 0 && c.beforeTokens > c.afterTokens;
    const deltaStr = hasDelta
      ? `${fmtTok(c.beforeTokens)} → ${fmtTok(c.afterTokens)}`
      : (c.beforeTokens > 0 ? t.compFrom(fmtTok(c.beforeTokens)) : '');
    const kindText = isManual ? t.compManual : t.compAuto;
    const label = [kindText, timeStr, deltaStr].filter(Boolean).join(' · ');
    const tip = t.compDivTip(isManual, timeStr, hasDelta ? `${fmtTok(c.beforeTokens)} → ${fmtTok(c.afterTokens)}` : '');
    return `<div class="compact-divider ${isManual ? 'is-manual' : ''}" title="${esc(tip)}"><span class="compact-pill">${esc(label)}</span></div>`;
  }

  function formatLiveStatus(live, compactionCount) {
    const t = tr();
    if (!live || live.state === 'idle') {
      return compactionCount > 0 ? t.stCompacted(compactionCount) : '';
    }
    if (live.phase === 'tool') return t.stTool(live.toolName || 'tool');
    if (live.phase === 'streaming') return t.stStreaming;
    if (live.phase === 'thinking') return t.stThinking;
    if (live.phase === 'preparing') return t.stPreparing;
    return live.label || '';
  }

  function formatTurnPrompt(turn) {
    const t = tr();
    if (turn.isSystemTurn) return t.turnSystemPrompt;
    if (turn.isDefaultPrompt) return t.turnDefaultPrompt(turn.turnNumber);
    return turn.promptPreview;
  }

  function renderSessionTab() {
    const t = tr();
    const el = $('session-view');
    const sess = state.payload?.session;
    if (!sess || sess.error) {
      el.innerHTML = `<div class="empty">${esc(sess?.error || t.noSessionData)}</div>`;
      return;
    }

    const k = sess.kpis;
    const latest = k.latestGen;
    const turns = sess.turns || [];

    if (state.autoExpandedConv !== sess.conversationId) {
      state.expandedTurns.clear();
      state.autoExpandedConv = sess.conversationId;
    }

    const live = sess.liveState || { state: 'idle', phase: 'idle', label: '' };
    const busy = live.state !== 'idle';
    const statusText = formatLiveStatus(live, k.compactionCount);

    const displayStream = latest
      ? (latest.isBuffered ? (k.steadyStreamMedian ?? latest.streamTokPerSec) : latest.streamTokPerSec)
      : null;

    const ctxPct = Math.min(100, (k.contextRatio || 0) * 100);
    const ctxTone = ctxPct >= 88 ? 'low' : (ctxPct >= 72 ? 'warn' : '');

    const turnsHtml = turns.length === 0
      ? ''
      : `<div class="stack">${[...turns].reverse().map((turn) => {
          const open = state.expandedTurns.has(turn.turnNumber);
          const rate = turn.steadyStreamMedian ?? turn.e2eMedian;
          const comps = turn.compactions || [];
          const splitStep = turn.generations?.length ? turn.generations[0].stepIdx : turn.userStepIdx;

          const aboveDividers = !open
            ? [...comps.filter((c) => c.stepIdx >= splitStep)].reverse().map(renderCompactionDivider).join('')
            : '';
          const belowDividers = !open
            ? [...comps.filter((c) => c.stepIdx < splitStep)].reverse().map(renderCompactionDivider).join('')
            : '';

          let body = '';
          if (open) {
            const timeline = [
              ...(turn.generations || []).map((g) => ({ step: g.stepIdx >= 0 ? g.stepIdx : g.genIdx, type: 'gen', item: g })),
              ...comps.map((c) => ({ step: c.stepIdx, type: 'compact', item: c })),
            ].sort((a, b) => a.step - b.step);

            body = `
              <div class="turn-body">
                ${timeline.map((ev) => {
                  if (ev.type === 'compact') return renderCompactionDivider(ev.item);
                  const g = ev.item;
                  const gr = g.isBuffered ? g.e2eTokPerSec : (g.streamTokPerSec ?? g.e2eTokPerSec);
                  return `
                    <div class="hop">
                      ${renderChip(g.modelBadge)}
                      <span class="sp"></span>
                      <span class="v">${fmtRate(gr)} tok/s</span>
                      <span class="v c">${esc(fmtUsd(pickCost(g)))}</span>
                    </div>
                  `;
                }).join('')}
              </div>
            `;
          }

          return `
            ${aboveDividers}
            <div class="turn">
              <button type="button" class="turn-head" data-turn="${turn.turnNumber}" aria-expanded="${open ? 'true' : 'false'}">
                <span class="turn-q">${esc(formatTurnPrompt(turn))}</span>
                <span class="turn-rate">${rate ? `${fmtRate(rate)} tok/s` : ''}</span>
                <span class="turn-cost">${esc(fmtUsd(pickCost(turn)))}</span>
              </button>
              ${body}
            </div>
            ${belowDividers}
          `;
        }).join('')}</div>`;

    el.innerHTML = `
      <article class="card hero">
        <div class="hero-top">
          ${latest ? renderChip(latest.modelBadge) : `<span class="muted">${esc(t.waitingGen)}</span>`}
          <span id="live-status-text" class="status ${busy ? 'busy' : ''}">${esc(statusText)}</span>
        </div>

        <div class="speed-grid">
          <div>
            <div class="speed-label">
              <span>${esc(t.lblStreamSpeed)}</span>
              ${latest?.isBuffered ? `<span class="tag-buf" title="${esc(t.tagBufTip)}">${esc(t.tagBuf)}</span>` : ''}
            </div>
            <div class="speed-val">${fmtRate(displayStream)}<small>tok/s</small></div>
          </div>
          <div>
            <div class="speed-label"><span>${esc(t.lblE2eSpeed)}</span></div>
            <div class="speed-val">${latest ? fmtRate(latest.e2eTokPerSec) : '—'}<small>tok/s</small></div>
          </div>
          <div>
            <div class="speed-label"><span>${esc(t.lblSessionEst)}</span></div>
            <div class="speed-val">${esc(fmtUsd(pickCost(k)))}</div>
          </div>
        </div>

        <div class="stat-grid">
          <div>
            <div class="stat-label">${esc(t.lblContext)}</div>
            <div class="stat-val">${fmtTok(k.contextTokens)} <span class="muted" style="font-size:11px;font-weight:400">/ ${fmtTok(k.contextLimit)}</span></div>
            <div class="mini-bar"><i class="${ctxTone}" style="width:${ctxPct.toFixed(1)}%"></i></div>
          </div>
          <div>
            <div class="stat-label">${esc(t.lblCacheHit)}</div>
            <div class="stat-val"><span class="hit-num">${fmtPct(k.sessionCacheHitRate, 0)}</span></div>
            <div class="mini-bar"><i class="ok" style="width:${(k.sessionCacheHitRate * 100).toFixed(1)}%"></i></div>
          </div>
        </div>

        ${renderContextChart(sess)}
        ${renderBreakdownBar(sess)}
      </article>

      ${turnsHtml}
    `;
  }

  // ---------- Tab 2: Subagent Tree ----------
  function renderTreeTab() {
    const t = tr();
    const el = $('tree-view');
    const tree = state.payload?.tree;
    if (!tree || !tree.nodes?.length) {
      el.innerHTML = `<div class="empty">${esc(t.treeEmpty)}</div>`;
      return;
    }

    if (tree.nodeCount === 1) {
      el.innerHTML = `<div class="empty">${esc(t.treeSingle)}</div>`;
      return;
    }

    el.innerHTML = `
      <div class="card kpi-grid">
        <div class="kpi-cell">
          <div class="kpi-label">${esc(t.treeNodes)}</div>
          <div class="kpi-val">${tree.nodeCount}</div>
        </div>
        <div class="kpi-cell">
          <div class="kpi-label">${esc(t.treeOut)}</div>
          <div class="kpi-val blue">${fmtTok(tree.totals.outputTokens)}</div>
        </div>
        <div class="kpi-cell">
          <div class="kpi-label">${esc(t.treeEst)}</div>
          <div class="kpi-val">${esc(fmtUsd(pickCost(tree.totals)))}</div>
        </div>
      </div>

      <div class="stack">
        ${tree.nodes.map((n) => {
          const indent = Math.min(36, n.depth * 12);
          const clickable = !n.isSelected && n.hasDb;
          const roleText = n.depth === 0 ? t.roleRoot : n.role;
          const titleText = n.hasCustomTitle
            ? n.title
            : (n.depth === 0 ? t.titleRootFallback : t.titleSubFallback(n.id.slice(0, 8)));
          return `
            <div class="node ${n.isSelected ? 'current' : ''} ${clickable ? 'clickable' : ''}" style="margin-left:${indent}px" ${clickable ? `data-inspect="${esc(n.id)}"` : ''}>
              <span class="role">${esc(roleText)}</span>
              <span class="title">${esc(titleText)}</span>
              <span class="cost">${esc(fmtUsd(pickCost(n)))}</span>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // ---------- Tab 3: Global ----------
  function renderGlobalTab() {
    const t = tr();
    const el = $('global-view');
    const g = state.globalPayload;
    if (!g) {
      el.innerHTML = `<div class="empty">${esc(t.globLoading)}</div>`;
      return;
    }

    const models = g.models || [];
    const maxRate = Math.max(50, ...models.map((m) => m.streamP50 || m.e2eP50 || 0));
    const scope = g.accountScope || state.accountScope;
    const hist = g.quotaHistory ?? (scope === 'all' ? (state.payload?.quota?.allHistory || []) : (state.payload?.quota?.history || []));
    const activeAcctLabel = g.activeAccount?.accountLabel || state.payload?.quota?.account?.accountLabel || '';

    const histHtml = !hist.length ? '' : `
      <div class="section-bar" style="margin-top:4px"><h3 id="hist-section-title" class="section-title">${esc(t.histTitle)}</h3></div>
      <div class="card" style="padding:8px 10px">
        <div tabindex="0" role="region" aria-labelledby="hist-section-title" class="table-wrapper">
          <table class="hist">
            <caption class="visually-hidden">${esc(t.histTitle)}</caption>
            <thead>
              <tr><th scope="col">${esc(t.histColPool)}</th><th scope="col">${esc(t.histColReset)}</th><th scope="col">${esc(t.histColUsedPct)}</th><th scope="col" class="u">${esc(t.histColUsed)}</th><th scope="col" class="s" aria-hidden="true">/</th><th scope="col" class="v">${esc(t.histColEst)}</th></tr>
            </thead>
            <tbody>
              ${hist.slice(0, 14).map((h) => {
                const sp = state.priceMode === 'standard' ? h.spendStandard : h.spendEffective;
                const fv = state.priceMode === 'standard' ? h.fullValueStandard : h.fullValueEffective;
                const pLabel = fmtPoolName(h.poolKey);
                const wLabel = h.windowType === 'weekly' ? t.winWk : '5h';
                const acctText = h.accountKey === 'legacy'
                  ? t.histLegacyAcct
                  : (h.accountLabel || h.planName || '');
                const showAcct = (scope === 'all' || h.accountKey === 'legacy') && acctText;
                const isPartial = Boolean(h.isPartialWindow && h.deltaUsedFraction > 0);
                const usedPctText = isPartial
                  ? `Δ${(h.deltaUsedFraction * 100).toFixed(1)}%`
                  : `${((h.usedFraction || 0) * 100).toFixed(1)}%`;
                const rowTip = isPartial ? t.histPartialTip((h.deltaUsedFraction * 100).toFixed(1)) : '';
                return `
                  <tr ${rowTip ? `title="${esc(rowTip)}"` : ''}>
                    <th scope="row">${esc(`${pLabel} ${wLabel}`)}${showAcct ? `<span class="hist-acct">${esc(acctText)}</span>` : ''}</th>
                    <td class="num">${esc(fmtShortTime(h.resetTimeIso))}</td>
                    <td class="num">${esc(usedPctText)}</td>
                    <td class="u">${esc(fmtUsd(sp))}${isPartial ? '<sup class="q-used-mark" aria-hidden="true">*</sup>' : ''}</td>
                    <td class="s" aria-hidden="true">/</td>
                    <td class="v">${esc(fmtUsd(fv))}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    el.innerHTML = `
      <div class="section-bar">
        <h3 class="section-title">${esc(t.globAcctTitle)}${activeAcctLabel ? ` · ${esc(activeAcctLabel)}` : ''}</h3>
        <div class="seg-control" role="group" aria-label="${esc(t.globAcctAria)}">
          <button type="button" class="seg-btn ${scope === 'current' ? 'is-active' : ''}" data-acct-scope="current" aria-pressed="${scope === 'current' ? 'true' : 'false'}">${esc(t.globAcctCur)}</button>
          <button type="button" class="seg-btn ${scope === 'all' ? 'is-active' : ''}" data-acct-scope="all" aria-pressed="${scope === 'all' ? 'true' : 'false'}">${esc(t.globAcctAll)}</button>
        </div>
      </div>

      <div class="section-bar">
        <h3 class="section-title">${esc(t.globRangeTitle)}</h3>
        <div class="seg-control" role="group" aria-label="${esc(t.globRangeAria)}">
          <button type="button" class="seg-btn ${state.globalRange === '5h' ? 'is-active' : ''}" data-range="5h" aria-pressed="${state.globalRange === '5h' ? 'true' : 'false'}">${esc(t.globR5h)}</button>
          <button type="button" class="seg-btn ${state.globalRange === '7d' ? 'is-active' : ''}" data-range="7d" aria-pressed="${state.globalRange === '7d' ? 'true' : 'false'}">${esc(t.globR7d)}</button>
          <button type="button" class="seg-btn ${state.globalRange === 'all' ? 'is-active' : ''}" data-range="all" aria-pressed="${state.globalRange === 'all' ? 'true' : 'false'}">${esc(t.globRAll)}</button>
        </div>
      </div>

      <div class="card global-summary">
        <div class="tok-banner" aria-label="${esc(t.globTokBannerAria)}">
          <div class="tok-item">
            <span class="tok-tag">${esc(t.globInTag)}</span>
            <span class="tok-num">${fmtTok(g.totals.inputTokens)}</span>
          </div>
          <div class="tok-item is-cache">
            <span class="tok-tag">${esc(t.globCacheTag)}</span>
            <span class="tok-num">${fmtTok(g.totals.cacheReadTokens)}</span>
          </div>
          <div class="tok-item is-out">
            <span class="tok-tag">${esc(t.globOutTag)}</span>
            <span class="tok-num">${fmtTok(g.totals.outputTokens)}</span>
          </div>
        </div>
        <div class="kpi-duo">
          <div class="kpi-cell">
            <div class="kpi-label">${esc(t.globHitLabel)}</div>
            <div class="kpi-val green">${fmtPct(g.totals.cacheHitRate, 1)}</div>
          </div>
          <div class="kpi-cell">
            <div class="kpi-label">${esc(t.globSpendLabel)}</div>
            <div class="kpi-val">${esc(fmtUsd(pickCost(g.totals)))}</div>
          </div>
        </div>
      </div>

      ${!models.length ? `<div class="empty">${esc(t.globEmpty)}</div>` : `
        <div class="stack">
          ${models.map((m) => {
            const rate = m.streamP50 ?? m.e2eP50 ?? 0;
            const pct = Math.max(3, Math.min(100, (rate / maxRate) * 100));
            return `
              <div class="lb">
                <div class="lb-top">
                  ${renderChip(m.modelBadge)}
                  <span class="sp"></span>
                  <span class="lb-rate">${fmtRate(rate)} <small>tok/s</small></span>
                </div>
                <div class="lb-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
                <div class="lb-meta">
                  <span class="lb-pill out">${esc(t.globPillOut)} <b>${fmtTok(m.outputTokens)}</b></span>
                  <span class="lb-pill hit">${esc(t.globPillHit)} <b>${fmtPct(m.cacheHitRate, 0)}</b></span>
                  <span class="cost">${esc(fmtUsd(pickCost(m)))}</span>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `}

      ${histHtml}
    `;
  }

  function renderAll() {
    applyStaticI18n();
    renderHeader();
    renderSessionTab();
    renderTreeTab();
    if (state.activeTab === 'global' && state.globalPayload) renderGlobalTab();
  }

  // ---------- Session Dropdown ----------
  async function loadSessions(q = '') {
    const t = tr();
    const list = $('session-list');
    try {
      const res = await apiGet(`/api/sessions?q=${encodeURIComponent(q)}&limit=40`);
      const items = res.items || [];
      const cur = state.payload?.conversationId || '';
      if (!items.length) {
        list.innerHTML = `<div class="empty" style="border:none">${esc(t.ddEmpty)}</div>`;
        return;
      }
      list.innerHTML = items.map((it) => {
        const titleText = it.hasCustomTitle === false ? t.ddFallbackTitle(it.id.slice(0, 8)) : it.title;
        return `
          <button type="button" role="option" aria-selected="${it.id === cur ? 'true' : 'false'}" class="session-option ${it.id === cur ? 'is-selected' : ''}" data-pick="${esc(it.id)}">
            <span class="t">${esc(titleText)}</span>
            <span class="c">${esc(fmtUsd(pickCost(it)))}</span>
          </button>
        `;
      }).join('');
    } catch {
      list.innerHTML = `<div class="empty" style="border:none">${esc(t.ddError)}</div>`;
    }
  }

  function toggleDropdown(open) {
    state.dropdownOpen = typeof open === 'boolean' ? open : !state.dropdownOpen;
    $('session-dropdown').classList.toggle('hidden', !state.dropdownOpen);
    $('session-picker-btn').setAttribute('aria-expanded', state.dropdownOpen ? 'true' : 'false');
    if (state.dropdownOpen) {
      const inp = $('session-search-input');
      loadSessions(inp.value);
      requestAnimationFrame(() => inp.focus());
    }
  }

  // ---------- Tabs ----------
  const TABS = ['session', 'tree', 'global'];
  function activateTab(key, focusBtn = false) {
    if (!TABS.includes(key)) return;
    state.activeTab = key;
    for (const k of TABS) {
      const btn = $(`tab-${k}`);
      const panel = $(`panel-${k}`);
      const active = k === key;
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.setAttribute('tabindex', active ? '0' : '-1');
      if (active) {
        panel.removeAttribute('hidden');
        if (focusBtn) btn.focus();
      } else {
        panel.setAttribute('hidden', 'until-found');
      }
    }
    if (key === 'global') fetchGlobal();
  }

  // ---------- Polling ----------
  async function fetchGlobal() {
    try {
      state.globalPayload = await apiGet(`/api/global?range=${encodeURIComponent(state.globalRange)}&accountScope=${encodeURIComponent(state.accountScope)}`);
      renderGlobalTab();
    } catch {
      $('global-view').innerHTML = `<div class="empty">${esc(tr().globError)}</div>`;
    }
  }

  async function poll(force = false) {
    if (document.hidden && !force) return;
    try {
      const target = state.followMode ? hostConvId() : state.selectedConvId;
      const qs = new URLSearchParams();
      if (target) qs.set('conversationId', target);
      if (!force && state.etag) qs.set('etag', state.etag);
      if (force) qs.set('forceQuota', '1');

      const res = await apiGet(`/api/session?${qs.toString()}`);
      if (res.uiBuild) {
        if (state.uiBuild && state.uiBuild !== res.uiBuild) {
          window.location.reload();
          return;
        }
        state.uiBuild = res.uiBuild;
      }
      if (!res.unchanged) {
        const nextAcctKey = res.quota?.account?.accountKey || '';
        const acctChanged = Boolean(state.lastAccountKey && nextAcctKey && state.lastAccountKey !== nextAcctKey);
        if (nextAcctKey) state.lastAccountKey = nextAcctKey;
        state.etag = res.etag || '';
        state.payload = res;
        state.receivedAtMs = Date.now();
        renderAll();
        if ((force || acctChanged) && state.activeTab === 'global') fetchGlobal();
      }
    } catch {
      // keep existing UI
    } finally {
      clearTimeout(state.pollTimer);
      if (!document.hidden) {
        const busy = (state.payload?.session?.liveState?.state || 'idle') !== 'idle';
        state.pollTimer = setTimeout(() => poll(false), busy ? 1500 : 3200);
      }
    }
  }

  // ---------- Events ----------
  function bindEvents() {
    $('session-picker-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDropdown();
    });

    $('follow-reset-btn').addEventListener('click', () => {
      state.followMode = true;
      state.selectedConvId = '';
      state.etag = '';
      toggleDropdown(false);
      poll(true);
    });

    let debounce = null;
    $('session-search-input').addEventListener('input', (e) => {
      clearTimeout(debounce);
      const q = e.target.value;
      debounce = setTimeout(() => loadSessions(q), 140);
    });

    document.addEventListener('click', (e) => {
      if (state.dropdownOpen && !e.target.closest('.session-selector-wrap')) {
        toggleDropdown(false);
      }

      const pick = e.target.closest('[data-pick]');
      if (pick) {
        state.followMode = false;
        state.selectedConvId = pick.dataset.pick;
        state.etag = '';
        toggleDropdown(false);
        poll(true);
        return;
      }

      const inspect = e.target.closest('[data-inspect]');
      if (inspect) {
        state.followMode = false;
        state.selectedConvId = inspect.dataset.inspect;
        state.etag = '';
        activateTab('session');
        poll(true);
        return;
      }

      const lg = e.target.closest('[data-lang]');
      if (lg) {
        const nextLang = lg.dataset.lang === 'en' ? 'en' : 'zh';
        if (state.lang !== nextLang) {
          state.lang = nextLang;
          safeSet('am_lang', nextLang);
          renderAll();
          if (state.dropdownOpen) loadSessions($('session-search-input').value);
        }
        return;
      }

      const pm = e.target.closest('[data-price-mode]');
      if (pm) {
        state.priceMode = pm.dataset.priceMode === 'standard' ? 'standard' : 'effective';
        safeSet('am_price_mode', state.priceMode);
        renderAll();
        return;
      }

      const cm = e.target.closest('[data-comp-mode]');
      if (cm) {
        const nextMode = cm.dataset.compMode === 'tokens' ? 'tokens' : 'cost';
        if (state.breakdownMode !== nextMode) {
          state.breakdownMode = nextMode;
          safeSet('am_breakdown_mode', nextMode);
          renderSessionTab();
        }
        document.querySelector(`.mini-seg-btn[data-comp-mode="${nextMode}"]`)?.focus();
        return;
      }

      const turn = e.target.closest('[data-turn]');
      if (turn) {
        const n = Number(turn.dataset.turn);
        if (state.expandedTurns.has(n)) state.expandedTurns.delete(n);
        else state.expandedTurns.add(n);
        renderSessionTab();
        return;
      }

      const asc = e.target.closest('[data-acct-scope]');
      if (asc) {
        const nextScope = asc.dataset.acctScope === 'all' ? 'all' : 'current';
        if (state.accountScope !== nextScope) {
          state.accountScope = nextScope;
          safeSet('am_account_scope', nextScope);
          $('global-view').innerHTML = `<div class="empty">${esc(tr().globRefreshing)}</div>`;
          fetchGlobal();
        }
        return;
      }

      const rng = e.target.closest('[data-range]');
      if (rng) {
        state.globalRange = rng.dataset.range;
        safeSet('am_global_range', state.globalRange);
        $('global-view').innerHTML = `<div class="empty">${esc(tr().globRefreshing)}</div>`;
        fetchGlobal();
      }
    });

    $('refresh-btn').addEventListener('click', () => {
      state.etag = '';
      poll(true);
    });

    document.querySelector('.tablist').addEventListener('click', (e) => {
      const btn = e.target.closest('.tab[data-tab]');
      if (btn) activateTab(btn.dataset.tab);
    });

    document.querySelector('.tablist').addEventListener('keydown', (e) => {
      const idx = TABS.indexOf(state.activeTab);
      if (idx < 0) return;
      let next = -1;
      if (e.key === 'ArrowRight') next = (idx + 1) % TABS.length;
      else if (e.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = TABS.length - 1;
      if (next >= 0) {
        e.preventDefault();
        activateTab(TABS[next], true);
      }
    });

    for (const k of TABS) {
      $(`panel-${k}`).addEventListener('beforematch', () => activateTab(k));
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.dropdownOpen) toggleDropdown(false);
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) poll(false);
      else clearTimeout(state.pollTimer);
    });
  }

  applyStaticI18n();
  syncThemeScheme();
  bindEvents();
  poll(true);
})();
