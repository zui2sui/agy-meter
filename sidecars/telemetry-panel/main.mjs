/**
 * AGY Meter Sidecar Backend (`main.mjs`)
 *
 * Unofficial community telemetry & quota meter (100% local & read-only).
 * Zero external dependencies — uses built-in Node 24 `node:sqlite` (`readOnly: true`),
 * `sidecar_sdk`, and local `LanguageServerService` (`RetrieveUserQuotaSummary` / `GetUserStatus`).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import {
  evaluateBucketValuation,
  loadLedger,
  lookupGenAccount,
  normalizeQuotaHistoryEntries,
  readAuthBoundariesFromLsLog,
  resolveLsLogPath,
  resolvePlanName,
  saveLedger,
  syncLedgerState,
} from './ledger.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function computeUiBuild() {
  return ['main.mjs', 'ledger.mjs', 'index.html', 'styles.css', 'app.js']
    .map((f) => {
      try { return Math.trunc(statSync(join(__dirname, f)).mtimeMs); } catch { return 0; }
    })
    .join('-');
}
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROCESS_STARTED_AT_SEC = Date.now() / 1000;

// ---------------------------------------------------------------------------
// Paths & Persistent Sidecar Data Dir
// ---------------------------------------------------------------------------

function resolveAppDataDir() {
  const execData = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execData) {
    for (let d = execData; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const candidate = dirname(d);
        if (existsSync(join(candidate, 'conversations'))) return candidate;
      }
    }
  }
  const def = join(homedir(), '.gemini', 'antigravity');
  if (existsSync(def)) return def;
  return def;
}

function resolveSidecarDataDir(appDataDir) {
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  }
  return join(appDataDir, 'sidecar_data', 'agy-meter', 'telemetry-panel', 'data');
}

const APP_DATA_DIR = resolveAppDataDir();
const SIDECAR_DATA_DIR = resolveSidecarDataDir(APP_DATA_DIR);
const QUOTA_HISTORY_PATH = join(SIDECAR_DATA_DIR, 'quota_history.json');
const ACCOUNT_LEDGER_PATH = join(SIDECAR_DATA_DIR, 'account_ledger.json');
const LS_LOG_PATH = resolveLsLogPath();

// ---------------------------------------------------------------------------
// BigInt-safe Protobuf Wire Parser (Read-Only)
// ---------------------------------------------------------------------------

function decodeVarint(buf, pos) {
  let val = 0n;
  let shift = 0n;
  while (pos < buf.length) {
    const b = BigInt(buf[pos++]);
    val |= (b & 0x7fn) << shift;
    if ((b & 0x80n) === 0n) return [val, pos];
    shift += 7n;
    if (shift > 70n) throw new Error('Varint overflow');
  }
  throw new Error('Truncated varint');
}

function parseProto(buf) {
  if (!buf || buf.length === 0) return {};
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let pos = 0;
  const out = {};
  try {
    while (pos < u8.length) {
      const [tag, p1] = decodeVarint(u8, pos);
      pos = p1;
      const fn = Number(tag >> 3n);
      const wt = Number(tag & 7n);
      if (fn <= 0) break;
      let val;
      if (wt === 0) {
        [val, pos] = decodeVarint(u8, pos);
      } else if (wt === 1) {
        if (pos + 8 > u8.length) break;
        val = u8.subarray(pos, pos + 8);
        pos += 8;
      } else if (wt === 2) {
        const [lenBig, p2] = decodeVarint(u8, pos);
        const len = Number(lenBig);
        if (len < 0 || p2 + len > u8.length) break;
        val = u8.subarray(p2, p2 + len);
        pos = p2 + len;
      } else if (wt === 5) {
        if (pos + 4 > u8.length) break;
        val = u8.subarray(pos, pos + 4);
        pos += 4;
      } else {
        break;
      }
      (out[fn] ||= []).push([wt, val]);
    }
  } catch {
    // Return fields parsed safely before truncation
  }
  return out;
}

function decodePackedVarints(buf) {
  if (!buf || buf.length === 0) return [];
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let pos = 0;
  const res = [];
  try {
    while (pos < u8.length) {
      const [v, p1] = decodeVarint(u8, pos);
      pos = p1;
      res.push(Number(v));
    }
  } catch {
    // ignore trailing
  }
  return res;
}

const UTF8 = new TextDecoder('utf-8', { fatal: false });

function getInt(d, fn, def = 0) {
  const arr = d?.[fn];
  if (!arr || !arr.length || arr[0][0] !== 0) return def;
  const v = arr[0][1];
  // Handle negative int64 encoded as 10-byte unsigned varint
  if (v > 0x7fffffffffffffffn) return def;
  return Number(v);
}

function getStr(d, fn, def = '') {
  const arr = d?.[fn];
  if (!arr || !arr.length || arr[0][0] !== 2) return def;
  return UTF8.decode(arr[0][1]);
}

function getSub(d, fn) {
  const arr = d?.[fn];
  if (!arr || !arr.length || arr[0][0] !== 2) return null;
  return parseProto(arr[0][1]);
}

function getDurationSec(d, fn) {
  const sub = getSub(d, fn);
  if (!sub) return 0;
  const sec = getInt(sub, 1, 0);
  const nanos = getInt(sub, 2, 0);
  const total = sec + nanos / 1e9;
  return total > 0 && total < 86400 * 30 ? total : 0;
}

function getTimestampSec(d, fn) {
  const sub = getSub(d, fn);
  if (!sub) return 0;
  const sec = getInt(sub, 1, 0);
  const nanos = getInt(sub, 2, 0);
  return sec > 1_600_000_000 ? sec + nanos / 1e9 : 0;
}

// ---------------------------------------------------------------------------
// Official API Pricing Catalog & Model Metadata Classification
// ---------------------------------------------------------------------------

// Promo deadlines in UTC seconds:
// - Gemini 4 Argon & Carbon: introductory 50% promo through Nov 30, 2026 PST (2026-12-01T08:00:00Z)
// - Gemini 3.8 / 3.7 Flash: introductory 50% promo through Dec 31, 2026 PST (2027-01-01T08:00:00Z)
const PROMO_END_GEMINI_4_TS = Date.parse('2026-12-01T08:00:00Z') / 1000;
const PROMO_END_FLASH_38_TS = Date.parse('2027-01-01T08:00:00Z') / 1000;

/**
 * Returns { promo: [inPerM, outPerM, cachePerM], standard: [inPerM, outPerM, cachePerM], promoUntilTs, poolKey }
 */
function lookupModelPricing(modelId, modelEnum = 0) {
  const id = (modelId || '').toLowerCase();

  // Gemini 4 Argon & Orchestrator (Argon)
  if (
    id.startsWith('gemini-4-argon') ||
    id.includes('orchestrator-argon') ||
    id === 'gemini-pro-orchestrator-g1-pro' ||
    [1417, 1418, 1419, 1668, 1681].includes(modelEnum)
  ) {
    return {
      promo: [2.0, 10.0, 0.10],
      standard: [4.0, 20.0, 0.20],
      promoUntilTs: PROMO_END_GEMINI_4_TS,
      poolKey: 'argon',
    };
  }
  // Gemini 4 Carbon & Orchestrator (Carbon)
  if (id.startsWith('gemini-4-carbon') || id === 'gemini-pro-orchestrator' || id.startsWith('gemini-pro') || [1427, 1437, 1438, 1667].includes(modelEnum)) {
    return {
      promo: [2.0, 10.0, 0.10],
      standard: [4.0, 20.0, 0.20],
      promoUntilTs: PROMO_END_GEMINI_4_TS,
      poolKey: 'gemini',
    };
  }
  // Gemini 4 Hydrogen
  if (id.startsWith('gemini-4-hydrogen') || [1525, 1526, 1527, 1528].includes(modelEnum)) {
    return {
      promo: [1.50, 7.50, 0.075],
      standard: [1.50, 7.50, 0.075],
      promoUntilTs: 0,
      poolKey: 'gemini',
    };
  }
  // Gemini 3.8 / 3.7 Flash & Orchestrator Flash Worker
  if (id.startsWith('gemini-3.8-flash') || id.startsWith('gemini-3.7-flash') || id === 'gemini-flash-worker-agy' || [1318, 1319, 1320, 1669].includes(modelEnum)) {
    return {
      promo: [0.75, 3.75, 0.075],
      standard: [1.50, 7.50, 0.15],
      promoUntilTs: PROMO_END_FLASH_38_TS,
      poolKey: 'gemini',
    };
  }
  // Gemini 3.6 Flash
  if (id.startsWith('gemini-3.6-flash')) {
    return {
      promo: [1.50, 7.50, 0.15],
      standard: [1.50, 7.50, 0.15],
      promoUntilTs: 0,
      poolKey: 'gemini',
    };
  }
  // Gemini 3.5 Flash-Lite
  if (id.startsWith('gemini-3.5-flash-lite') || id.includes('flash-lite')) {
    return {
      promo: [0.30, 2.50, 0.03],
      standard: [0.30, 2.50, 0.03],
      promoUntilTs: 0,
      poolKey: 'gemini',
    };
  }
  // Claude Opus 5.5
  if (id.startsWith('claude-opus-5-5') || [1400, 1401, 1402].includes(modelEnum)) {
    return {
      promo: [4.0, 20.0, 0.20],
      standard: [4.0, 20.0, 0.20],
      promoUntilTs: 0,
      poolKey: 'claude',
    };
  }
  // Claude Sonnet 5.5
  if (id.startsWith('claude-sonnet-5-5') || [1403, 1404, 1405].includes(modelEnum)) {
    return {
      promo: [2.0, 10.0, 0.10],
      standard: [2.0, 10.0, 0.10],
      promoUntilTs: 0,
      poolKey: 'claude',
    };
  }
  // Claude Opus 4.6
  if (id.startsWith('claude-opus-4-6')) {
    return {
      promo: [5.0, 25.0, 0.50],
      standard: [5.0, 25.0, 0.50],
      promoUntilTs: 0,
      poolKey: 'claude',
    };
  }
  // Claude Sonnet 4.x
  if (id.startsWith('claude-sonnet-4')) {
    return {
      promo: [3.0, 15.0, 0.30],
      standard: [3.0, 15.0, 0.30],
      promoUntilTs: 0,
      poolKey: 'claude',
    };
  }
  // GPT-OSS 120B
  if (id.startsWith('gpt-oss')) {
    return {
      promo: [0.15, 0.60, 0.04],
      standard: [0.15, 0.60, 0.04],
      promoUntilTs: 0,
      poolKey: 'claude',
    };
  }
  // Default fallback (Gemini Pro tier)
  return {
    promo: [2.0, 10.0, 0.10],
    standard: [4.0, 20.0, 0.20],
    promoUntilTs: PROMO_END_GEMINI_4_TS,
    poolKey: id.startsWith('claude') ? 'claude' : 'gemini',
  };
}

function computeGenCost(inputTokens, outputTokens, cacheReadTokens, modelId, modelEnum, tsSec) {
  const p = lookupModelPricing(modelId, modelEnum);
  const checkTs = tsSec > 0 ? tsSec : Date.now() / 1000;
  const activeRates = p.promoUntilTs > 0 && checkTs < p.promoUntilTs ? p.promo : (p.promoUntilTs === 0 ? p.promo : p.standard);
  const [ei, eo, ec] = activeRates;
  const [si, so, sc] = p.standard;

  const effIn = (inputTokens * ei) / 1e6;
  const effOut = (outputTokens * eo) / 1e6;
  const effCache = (cacheReadTokens * ec) / 1e6;

  const stdIn = (inputTokens * si) / 1e6;
  const stdOut = (outputTokens * so) / 1e6;
  const stdCache = (cacheReadTokens * sc) / 1e6;

  return {
    poolKey: p.poolKey,
    hasPromo: p.promoUntilTs > 0 && checkTs < p.promoUntilTs,
    ratesEffective: activeRates,
    ratesStandard: p.standard,
    costEffective: effIn + effOut + effCache,
    costStandard: stdIn + stdOut + stdCache,
    breakdownEffective: { input: effIn, output: effOut, cache: effCache },
    breakdownStandard: { input: stdIn, output: stdOut, cache: stdCache },
  };
}

function classifyModelBadge(modelId, displayName = '', modelEnum = 0) {
  const raw = modelId || 'unknown';
  let expTag = null;
  let expKind = null;
  let baseId = raw;

  const suffixMatch = raw.match(/-(n|control|trial|tiered|exp(?:-[a-z0-9]+)?|preview)$/i);
  if (suffixMatch) {
    const s = suffixMatch[1].toLowerCase();
    baseId = raw.slice(0, -suffixMatch[0].length);
    if (s === 'n' || s.startsWith('exp')) { expTag = `-${s} (实验组)`; expKind = 'exp'; }
    else if (s === 'control') { expTag = '-control (对照组)'; expKind = 'ctrl'; }
    else if (s === 'trial') { expTag = '-trial (试用池)'; expKind = 'trial'; }
    else if (s === 'tiered') { expTag = '-tiered (分级池)'; expKind = 'tiered'; }
    else { expTag = `-${s}`; expKind = 'exp'; }
  }

  let inferredBase = null;
  if (raw === 'gemini-pro-orchestrator' || modelEnum === 1667) {
    inferredBase = 'Gemini 4 Carbon (规划主控)';
  } else if (
    raw === 'gemini-pro-orchestrator-argon' ||
    raw === 'gemini-pro-orchestrator-g1-pro' ||
    modelEnum === 1668 ||
    modelEnum === 1681
  ) {
    inferredBase = 'Gemini 4 Argon (规划主控)';
  } else if (raw === 'gemini-flash-worker-agy' || modelEnum === 1669) {
    inferredBase = 'Gemini 3.8 Flash (高速执行器)';
  } else if (raw === 'gemini-pro-default') {
    inferredBase = '默认 Pro 路由池';
  }

  let family = 'other';
  if (raw.includes('argon') || raw === 'gemini-pro-orchestrator-g1-pro' || modelEnum === 1668) family = 'argon';
  else if (raw.includes('carbon') || raw === 'gemini-pro-orchestrator') family = 'carbon';
  else if (raw.includes('hydrogen')) family = 'hydrogen';
  else if (raw.includes('flash')) family = 'flash';
  else if (raw.includes('claude')) family = 'claude';

  return { raw, baseId, expTag, expKind, inferredBase, family, displayName: displayName || raw };
}

// ---------------------------------------------------------------------------
// Prompt & Tool Formatting Helpers
// ---------------------------------------------------------------------------

function parseUserStepPrompt(stepPayloadBuf) {
  if (!stepPayloadBuf || stepPayloadBuf.length === 0) {
    return { isCompactionResume: false, isSlashCompact: false, text: '' };
  }
  const pay = parseProto(stepPayloadBuf);
  let rawText = '';
  let isSlashCompact = false;
  const sub19 = getSub(pay, 19);
  if (sub19) {
    rawText = getStr(sub19, 2) || getStr(sub19, 1) || '';
    if (/^\s*\/compact(?:\s|$)/i.test(rawText)) {
      isSlashCompact = true;
    }
    if (!isSlashCompact && sub19[3]) {
      for (const [, itemBuf] of sub19[3]) {
        if (!itemBuf) continue;
        const itemStr = UTF8.decode(itemBuf);
        if (itemStr.includes('compact') && itemStr.includes('collapse_all')) {
          isSlashCompact = true;
          break;
        }
      }
    }
  }
  if (!rawText) {
    rawText = UTF8.decode(stepPayloadBuf);
  }
  const hasUserReq = rawText.includes('<USER_REQUEST>');
  const hasContextSummary = rawText.includes('<CONTEXT_SUMMARY>');
  if (hasContextSummary && !hasUserReq) {
    return { isCompactionResume: true, isSlashCompact: false, text: '上下文自动压缩续接 (Context Compaction)' };
  }
  let cleaned = rawText;
  const reqMatch = rawText.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (reqMatch) {
    cleaned = reqMatch[1];
  } else {
    cleaned = cleaned
      .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/g, '')
      .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '');
  }
  // Strip non-printable control chars left over if fallback decode was used
  cleaned = cleaned.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!isSlashCompact && /^\/compact(?:\s|$)/i.test(cleaned)) {
    isSlashCompact = true;
  }
  return { isCompactionResume: false, isSlashCompact, text: cleaned.slice(0, 220) };
}

function summarizeToolArgs(toolName, argsJsonStr) {
  if (!argsJsonStr) return '';
  try {
    const obj = JSON.parse(argsJsonStr);
    if (obj.toolSummary) return String(obj.toolSummary).slice(0, 60);
    if (obj.Path) return basename(String(obj.Path));
    if (obj.query) return String(obj.query).slice(0, 50);
    if (Array.isArray(obj.queries)) return obj.queries.join(', ').slice(0, 50);
    if (obj.Role) return String(obj.Role).slice(0, 50);
    if (obj.CommandLine) return String(obj.CommandLine).split('\n')[0].slice(0, 52);
  } catch {
    // partial or non-json
  }
  return '';
}

function percentile(sortedNums, p) {
  if (!sortedNums.length) return null;
  if (sortedNums.length === 1) return sortedNums[0];
  const idx = (sortedNums.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedNums[lo];
  return sortedNums[lo] + (sortedNums[hi] - sortedNums[lo]) * (idx - lo);
}

// ---------------------------------------------------------------------------
// Incremental Per-DB File Cache (Sub-3ms Warm Queries)
// ---------------------------------------------------------------------------

function fileSignature(dbPath) {
  try {
    const s = statSync(dbPath);
    let walPart = '0:0';
    try {
      const ws = statSync(`${dbPath}-wal`);
      walPart = `${Math.trunc(ws.mtimeMs)}:${ws.size}`;
    } catch {
      // no -wal file
    }
    return `${Math.trunc(s.mtimeMs)}:${s.size}:${walPart}`;
  } catch {
    return null;
  }
}

// Lightweight cache for global / 5h-window scans: convId -> { sig, mtimeMs, gens, summary }
const LIGHT_CACHE_MAX = 600;
const lightConvCache = new Map();
// Detailed cache for active/inspected session: convId -> { sig, detail }
const DETAIL_CACHE_MAX = 24;
const detailConvCache = new Map();

function setBoundedCache(map, key, val, maxEntries) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function parseGenerationRow(gdata, stepInfo) {
  const top = parseProto(gdata);
  const stepIndices = top[2]?.length ? decodePackedVarints(top[2][0][1]) : [];
  const primaryStepIdx = stepIndices.length ? stepIndices[0] : -1;
  const st = stepInfo?.get(primaryStepIdx) || null;

  const g1 = getSub(top, 1) || {};
  const modelEnum = getInt(g1, 3, 0);
  const usage = getSub(g1, 4) || {};
  const inputTokens = getInt(usage, 2, 0);
  const outputTokens = getInt(usage, 3, 0);
  const cacheReadTokens = getInt(usage, 5, 0);
  const provider = getInt(usage, 6, 0);
  const thinkingTokens = getInt(usage, 9, 0);
  const responseTokens = getInt(usage, 10, Math.max(0, outputTokens - thinkingTokens));

  const g9 = getSub(g1, 9);
  const ctxInfo = g9 ? getSub(g9, 10) : null;
  const contextEst = ctxInfo ? getInt(ctxInfo, 1, 0) : 0;
  const contextLimit = ctxInfo ? getInt(ctxInfo, 4, 256000) : 256000;

  let ttftSec = getDurationSec(g1, 11);
  let streamSec = getDurationSec(g1, 12);

  // Fallback to step timestamps if durations are 0
  if (ttftSec <= 0 && st && st.firstChunkAt > st.createdAt && st.createdAt > 0) {
    ttftSec = st.firstChunkAt - st.createdAt;
  }
  if (streamSec <= 0 && st && st.completedAt > st.firstChunkAt && st.firstChunkAt > 0) {
    streamSec = st.completedAt - st.firstChunkAt;
  }

  const e2eSec = ttftSec + streamSec > 0
    ? ttftSec + streamSec
    : (st && st.completedAt > st.createdAt && st.createdAt > 0 ? st.completedAt - st.createdAt : 0);

  const g17 = getSub(g1, 17);
  const errorText = g17 ? getStr(g17, 3, '') : '';
  const modelId = getStr(g1, 19, '') || (modelEnum ? `enum-${modelEnum}` : 'unknown');
  const displayName = getStr(g1, 21, '') || modelId;

  const kvPairs = {};
  if (g1[20]) {
    for (const [, rawKv] of g1[20]) {
      const kv = parseProto(rawKv);
      const k = getStr(kv, 1);
      const v = getStr(kv, 2);
      if (k) kvPairs[k] = v;
    }
  }

  const createdAt = st?.createdAt || 0;
  const e2eTokPerSec = outputTokens > 0 && e2eSec > 0.02 ? outputTokens / e2eSec : null;
  const rawStreamTokPerSec = outputTokens > 0 && streamSec > 0.015 ? outputTokens / streamSec : null;

  // Detect server-side thought-summary short-burst buffering
  const isBuffered = Boolean(
    outputTokens > 0 && (
      streamSec <= 0.015 ||
      (streamSec < 0.85 && ttftSec > 0.7) ||
      (thinkingTokens > 0 && responseTokens < 120 && streamSec < 1.25 && rawStreamTokPerSec && e2eTokPerSec && rawStreamTokPerSec > e2eTokPerSec * 2.2)
    )
  );

  const totalPrompt = inputTokens + cacheReadTokens;
  const cacheHitRate = totalPrompt > 0 ? cacheReadTokens / totalPrompt : 0;

  const cost = computeGenCost(inputTokens, outputTokens, cacheReadTokens, modelId, modelEnum, createdAt);
  const modelBadge = classifyModelBadge(modelId, displayName, modelEnum);

  return {
    stepIdx: primaryStepIdx,
    stepIndices,
    createdAt,
    completedAt: st?.completedAt || (createdAt > 0 ? createdAt + e2eSec : 0),
    thinkingDurSec: st?.thinkingDurSec || 0,
    modelId,
    displayName,
    modelEnum,
    provider,
    subagentType: kvPairs.subagent_type || '',
    modelBadge,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    thinkingTokens,
    responseTokens,
    totalPromptTokens: totalPrompt,
    contextEst,
    contextLimit: contextLimit || 256000,
    cacheHitRate,
    ttftSec,
    streamSec,
    e2eSec,
    streamTokPerSec: rawStreamTokPerSec,
    e2eTokPerSec,
    isBuffered,
    isSteadySample: !isBuffered && rawStreamTokPerSec !== null && streamSec >= 0.8 && outputTokens >= 80,
    errorText: errorText ? errorText.slice(0, 180) : '',
    ...cost,
  };
}

function getLightConversation(convId) {
  const dbPath = join(APP_DATA_DIR, 'conversations', `${convId}.db`);
  const sig = fileSignature(dbPath);
  if (!sig) return null;

  const cached = lightConvCache.get(convId);
  if (cached && cached.sig === sig) return cached;

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const stepMap = new Map();
    const stepRows = db.prepare('SELECT idx, metadata FROM steps WHERE step_type = 15').all();
    for (const r of stepRows) {
      const md = r.metadata ? parseProto(r.metadata) : {};
      stepMap.set(Number(r.idx), {
        createdAt: getTimestampSec(md, 1),
        firstChunkAt: getTimestampSec(md, 6),
        completedAt: getTimestampSec(md, 7),
        thinkingDurSec: 0,
      });
    }

    const genRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    const gens = [];
    let sumIn = 0, sumCache = 0, sumOut = 0, sumThink = 0, sumEff = 0, sumStd = 0;
    const steadyRates = [];
    const e2eRates = [];
    let lastModelId = '';
    let lastDisplayName = '';
    let subagentType = '';

    for (const r of genRows) {
      if (!r.data) continue;
      const g = parseGenerationRow(r.data, stepMap);
      g.genIdx = Number(r.idx);
      gens.push(g);
      sumIn += g.inputTokens;
      sumCache += g.cacheReadTokens;
      sumOut += g.outputTokens;
      sumThink += g.thinkingTokens;
      sumEff += g.costEffective;
      sumStd += g.costStandard;
      if (g.isSteadySample && g.streamTokPerSec) steadyRates.push(g.streamTokPerSec);
      if (g.e2eTokPerSec) e2eRates.push(g.e2eTokPerSec);
      if (g.modelId && g.modelId !== 'unknown') {
        lastModelId = g.modelId;
        lastDisplayName = g.displayName;
      }
      if (g.subagentType) subagentType = g.subagentType;
    }

    steadyRates.sort((a, b) => a - b);
    e2eRates.sort((a, b) => a - b);
    const statMtime = Number(sig.split(':')[0]) || 0;

    const entry = {
      convId,
      sig,
      mtimeMs: statMtime,
      gens,
      summary: {
        genCount: gens.length,
        inputTokens: sumIn,
        cacheReadTokens: sumCache,
        outputTokens: sumOut,
        thinkingTokens: sumThink,
        costEffective: sumEff,
        costStandard: sumStd,
        steadyStreamMedian: percentile(steadyRates, 0.5),
        e2eMedian: percentile(e2eRates, 0.5),
        lastModelId,
        lastDisplayName,
        subagentType,
      },
    };
    setBoundedCache(lightConvCache, convId, entry, LIGHT_CACHE_MAX);
    return entry;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function getDetailedConversation(convId) {
  const dbPath = join(APP_DATA_DIR, 'conversations', `${convId}.db`);
  const sig = fileSignature(dbPath);
  if (!sig) return null;

  const cached = detailConvCache.get(convId);
  if (cached && cached.sig === sig) return cached.detail;

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });

    const allSteps = db.prepare(
      'SELECT idx, step_type, status, metadata, step_payload, error_details FROM steps WHERE step_type IN (14, 15, 23, 132) ORDER BY idx ASC'
    ).all();

    const plannerStepMap = new Map();
    const userSteps = [];
    const compactionSteps = [];
    const toolSteps = [];
    let latestStep = null;
    let lastUserStep = null;
    let hasActedSinceUser = false;

    for (const s of allSteps) {
      const idx = Number(s.idx);
      const stype = Number(s.step_type);
      const status = Number(s.status);
      const md = s.metadata ? parseProto(s.metadata) : {};
      const createdAt = getTimestampSec(md, 1);
      const turnUuid = getStr(md, 12, '');

      latestStep = { idx, stepType: stype, status, createdAt };

      if (stype === 14) {
        const parsed = parseUserStepPrompt(s.step_payload);
        if (parsed.isCompactionResume) {
          compactionSteps.push({ stepIdx: idx, createdAt, kind: 'resume', trigger: 'auto' });
        } else {
          lastUserStep = { idx, isSlashCompact: Boolean(parsed.isSlashCompact), turnUuid };
          hasActedSinceUser = false;
          userSteps.push({
            stepIdx: idx,
            createdAt,
            promptPreview: parsed.text || `提问 #${userSteps.length + 1}`,
            isDefaultPrompt: !parsed.text,
            isSlashCompact: Boolean(parsed.isSlashCompact),
          });
        }
      } else if (stype === 15) {
        hasActedSinceUser = true;
        let thinkingDurSec = 0;
        if (s.step_payload) {
          const sp = parseProto(s.step_payload);
          const sp20 = getSub(sp, 20);
          if (sp20) thinkingDurSec = getDurationSec(sp20, 11);
        }
        const firstChunkAt = getTimestampSec(md, 6);
        const completedAt = getTimestampSec(md, 7);
        plannerStepMap.set(idx, {
          idx,
          status,
          createdAt,
          firstChunkAt,
          completedAt,
          thinkingDurSec,
          hasError: Boolean(s.error_details && s.error_details.byteLength > 0),
        });
      } else if (stype === 23) {
        const cp = s.step_payload ? parseProto(s.step_payload) : {};
        const s30 = getSub(cp, 30);
        // Skip initial title checkpoints at step <= 2 that carry no summary payload (s30[5])
        if (s30 && !s30[5] && idx <= 2) continue;
        const isManual = Boolean(
          lastUserStep &&
          lastUserStep.isSlashCompact &&
          !hasActedSinceUser &&
          (idx - lastUserStep.idx <= 3 || (turnUuid && turnUuid === lastUserStep.turnUuid))
        );
        compactionSteps.push({
          stepIdx: idx,
          createdAt,
          kind: 'compaction',
          trigger: isManual ? 'manual' : 'auto',
        });
      } else if (stype === 132) {
        hasActedSinceUser = true;
        const m4 = getSub(md, 4) || {};
        const toolName = getStr(m4, 2, 'tool');
        const argsRaw = getStr(m4, 3, '');
        const tStart = getTimestampSec(md, 6) || createdAt;
        const tEnd = getTimestampSec(md, 8) || getTimestampSec(md, 7) || 0;
        const durationSec = tEnd > tStart && tStart > 0 ? tEnd - tStart : 0;
        toolSteps.push({
          stepIdx: idx,
          status,
          createdAt,
          toolName,
          summary: summarizeToolArgs(toolName, argsRaw),
          durationSec,
          isRunning: status === 1 || status === 2,
          hasError: status === 4 || Boolean(s.error_details && s.error_details.byteLength > 0),
        });
      }
    }

    // Parse all generations
    const genRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    const generations = [];
    for (const r of genRows) {
      if (!r.data) continue;
      const g = parseGenerationRow(r.data, plannerStepMap);
      g.genIdx = Number(r.idx);
      generations.push(g);
    }

    // Deduplicate adjacent compaction markers (e.g. step_type=23 + immediate context_summary step_type=14)
    const dedupedCompactions = [];
    for (const c of compactionSteps) {
      const prev = dedupedCompactions[dedupedCompactions.length - 1];
      if (prev && c.stepIdx - prev.stepIdx <= 5) {
        if (c.kind === 'compaction') {
          prev.stepIdx = c.stepIdx;
          prev.createdAt = c.createdAt || prev.createdAt;
          prev.kind = 'compaction';
        }
        if (c.trigger === 'manual') {
          prev.trigger = 'manual';
        }
      } else {
        dedupedCompactions.push({ ...c });
      }
    }

    // Enrich each compaction with before -> after context token counts
    for (const c of dedupedCompactions) {
      let beforeTok = 0;
      let afterTok = 0;
      for (const g of generations) {
        const anchor = g.stepIdx >= 0 ? g.stepIdx : g.genIdx;
        const promptTok = g.totalPromptTokens > 0 ? g.totalPromptTokens : g.contextEst;
        if (promptTok <= 0) continue;
        if (anchor < c.stepIdx) {
          beforeTok = promptTok;
        } else if (anchor > c.stepIdx && afterTok === 0) {
          afterTok = promptTok;
          break;
        }
      }
      c.beforeTokens = beforeTok;
      c.afterTokens = afterTok;
    }

    // Group generations + tools + compactions into USER_INPUT turns
    const turns = [];
    if (userSteps.length === 0 && (generations.length > 0 || toolSteps.length > 0 || dedupedCompactions.length > 0)) {
      userSteps.push({
        stepIdx: 0,
        createdAt: generations[0]?.createdAt || 0,
        promptPreview: '(子智能体或系统触发任务)',
        isSystemTurn: true,
      });
    }

    for (let i = 0; i < userSteps.length; i++) {
      const u = userSteps[i];
      const minStepIdx = i === 0 ? 0 : u.stepIdx;
      const nextStepIdx = i + 1 < userSteps.length ? userSteps[i + 1].stepIdx : Infinity;

      const turnGens = generations.filter((g) => {
        const anchor = g.stepIdx >= 0 ? g.stepIdx : g.genIdx;
        return anchor >= minStepIdx && anchor < nextStepIdx;
      });
      const turnTools = toolSteps.filter((t) => t.stepIdx >= minStepIdx && t.stepIdx < nextStepIdx);
      const turnCompactions = dedupedCompactions.filter((c) => c.stepIdx >= minStepIdx && c.stepIdx < nextStepIdx);

      let outTok = 0, thinkTok = 0, inTok = 0, cacheTok = 0;
      let costEff = 0, costStd = 0, streamSum = 0, e2eSum = 0, toolDurSum = 0;
      const steadySamples = [];
      const e2eSamples = [];

      for (const g of turnGens) {
        outTok += g.outputTokens;
        thinkTok += g.thinkingTokens;
        inTok += g.inputTokens;
        cacheTok += g.cacheReadTokens;
        costEff += g.costEffective;
        costStd += g.costStandard;
        streamSum += g.streamSec;
        e2eSum += g.e2eSec;
        if (g.isSteadySample && g.streamTokPerSec) steadySamples.push(g.streamTokPerSec);
        if (g.e2eTokPerSec) e2eSamples.push(g.e2eTokPerSec);
      }
      for (const t of turnTools) {
        toolDurSum += t.durationSec;
      }

      steadySamples.sort((a, b) => a - b);
      e2eSamples.sort((a, b) => a - b);
      const lastHop = turnGens[turnGens.length - 1] || null;

      turns.push({
        turnNumber: i + 1,
        userStepIdx: u.stepIdx,
        createdAt: u.createdAt,
        promptPreview: u.promptPreview,
        isDefaultPrompt: Boolean(u.isDefaultPrompt),
        isSystemTurn: Boolean(u.isSystemTurn),
        hopCount: turnGens.length,
        toolCount: turnTools.length,
        compactionCount: turnCompactions.length,
        inputTokens: inTok,
        cacheReadTokens: cacheTok,
        outputTokens: outTok,
        thinkingTokens: thinkTok,
        costEffective: costEff,
        costStandard: costStd,
        modelDurationSec: e2eSum,
        toolDurationSec: toolDurSum,
        steadyStreamMedian: percentile(steadySamples, 0.5) ?? (lastHop?.streamTokPerSec ?? null),
        e2eMedian: percentile(e2eSamples, 0.5) ?? (lastHop?.e2eTokPerSec ?? null),
        primaryModelBadge: lastHop?.modelBadge || null,
        generations: turnGens,
        tools: turnTools,
        compactions: turnCompactions,
      });
    }

    // Live activity status
    const nowSec = Date.now() / 1000;
    let liveState = { state: 'idle', phase: 'idle', label: '空闲', elapsedSec: 0, toolName: '' };

    // Check if any planner step at the tail is still running (status 1 or 2)
    const plannerList = [...plannerStepMap.values()];
    const lastPlanner = plannerList[plannerList.length - 1];
    const lastTool = toolSteps[toolSteps.length - 1];

    if (lastTool && lastTool.isRunning && (!lastPlanner || lastTool.stepIdx > lastPlanner.idx)) {
      const elapsed = lastTool.createdAt > 0 ? Math.max(0, nowSec - lastTool.createdAt) : 0;
      if (elapsed < 1800) {
        liveState = {
          state: 'tool',
          phase: 'tool',
          label: `执行工具 ${lastTool.toolName}`,
          toolName: lastTool.toolName,
          toolSummary: lastTool.summary,
          elapsedSec: elapsed,
        };
      }
    } else if (lastPlanner && (lastPlanner.status === 1 || lastPlanner.status === 2)) {
      const elapsed = lastPlanner.createdAt > 0 ? Math.max(0, nowSec - lastPlanner.createdAt) : 0;
      if (elapsed < 900) {
        const hasFirstChunk = lastPlanner.firstChunkAt > 0;
        liveState = {
          state: 'generating',
          phase: hasFirstChunk ? 'streaming' : 'thinking',
          label: hasFirstChunk ? '流式输出中' : '思考/首包等待中',
          elapsedSec: elapsed,
        };
      }
    } else if (latestStep && latestStep.stepType === 14 && (!lastPlanner || latestStep.idx > lastPlanner.idx)) {
      const elapsed = latestStep.createdAt > 0 ? Math.max(0, nowSec - latestStep.createdAt) : 0;
      if (elapsed < 120) {
        liveState = {
          state: 'generating',
          phase: 'preparing',
          label: '准备请求模型中',
          elapsedSec: elapsed,
        };
      }
    }

    // Aggregate session KPIs
    let totalIn = 0, totalCache = 0, totalOut = 0, totalThink = 0, totalResp = 0;
    let totalEff = 0, totalStd = 0;
    let effIn = 0, effOut = 0, effCache = 0;
    let stdIn = 0, stdOut = 0, stdCache = 0;
    const steadyAll = [];
    const anyStreamAll = [];
    const e2eAll = [];
    const ttftAll = [];

    for (const g of generations) {
      totalIn += g.inputTokens;
      totalCache += g.cacheReadTokens;
      totalOut += g.outputTokens;
      totalThink += g.thinkingTokens;
      totalResp += g.responseTokens;
      totalEff += g.costEffective;
      totalStd += g.costStandard;
      effIn += g.breakdownEffective.input;
      effOut += g.breakdownEffective.output;
      effCache += g.breakdownEffective.cache;
      stdIn += g.breakdownStandard.input;
      stdOut += g.breakdownStandard.output;
      stdCache += g.breakdownStandard.cache;

      if (g.isSteadySample && g.streamTokPerSec) steadyAll.push(g.streamTokPerSec);
      if (!g.isBuffered && g.streamTokPerSec) anyStreamAll.push(g.streamTokPerSec);
      if (g.e2eTokPerSec) e2eAll.push(g.e2eTokPerSec);
      if (g.ttftSec > 0) ttftAll.push(g.ttftSec);
    }

    steadyAll.sort((a, b) => a - b);
    anyStreamAll.sort((a, b) => a - b);
    e2eAll.sort((a, b) => a - b);
    ttftAll.sort((a, b) => a - b);

    const latestGen = generations[generations.length - 1] || null;
    const currentContextTokens = latestGen
      ? (latestGen.totalPromptTokens > 0 ? latestGen.totalPromptTokens : latestGen.contextEst)
      : 0;
    const currentContextLimit = latestGen?.contextLimit || 256000;
    const totalPromptAll = totalIn + totalCache;

    const manualCompactionCount = dedupedCompactions.filter((c) => c.trigger === 'manual').length;
    const autoCompactionCount = dedupedCompactions.length - manualCompactionCount;

    const detail = {
      conversationId: convId,
      sig,
      liveState,
      kpis: {
        genCount: generations.length,
        turnCount: turns.length,
        toolCount: toolSteps.length,
        compactionCount: dedupedCompactions.length,
        autoCompactionCount,
        manualCompactionCount,
        latestGen,
        steadyStreamMedian: percentile(steadyAll, 0.5) ?? percentile(anyStreamAll, 0.5),
        e2eMedian: percentile(e2eAll, 0.5),
        ttftMedian: percentile(ttftAll, 0.5),
        contextTokens: currentContextTokens,
        contextLimit: currentContextLimit,
        contextRatio: currentContextLimit > 0 ? currentContextTokens / currentContextLimit : 0,
        sessionCacheHitRate: totalPromptAll > 0 ? totalCache / totalPromptAll : 0,
        latestCacheHitRate: latestGen?.cacheHitRate ?? 0,
        inputTokens: totalIn,
        cacheReadTokens: totalCache,
        outputTokens: totalOut,
        thinkingTokens: totalThink,
        responseTokens: totalResp,
        thinkingShare: totalOut > 0 ? totalThink / totalOut : 0,
        costEffective: totalEff,
        costStandard: totalStd,
        breakdownEffective: { input: effIn, output: effOut, cache: effCache },
        breakdownStandard: { input: stdIn, output: stdOut, cache: stdCache },
      },
      turns,
      generations,
      compactions: dedupedCompactions,
    };

    setBoundedCache(detailConvCache, convId, { sig, detail }, DETAIL_CACHE_MAX);
    return detail;
  } catch (err) {
    return { error: err.message, conversationId: convId };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Conversation Summaries, FTS5 Search, & Subagent Family Tree
// ---------------------------------------------------------------------------

function readSummariesMeta() {
  const sumPath = join(APP_DATA_DIR, 'conversation_summaries.db');
  if (!existsSync(sumPath)) {
    return { byId: new Map(), childrenOf: new Map(), parentOf: new Map(), latestRootId: '' };
  }
  let db;
  try {
    db = new DatabaseSync(sumPath, { readOnly: true });
    const rows = db.prepare(`
      SELECT conversation_id, title, preview, step_count, last_modified_time,
             workspace_uris, status, agent_name, parent_conversation_id,
             nesting_depth, not_fully_idle, killed
      FROM conversation_summaries
      ORDER BY last_modified_time DESC
    `).all();

    const byId = new Map();
    const parentOf = new Map();
    const childrenOf = new Map();
    let latestRootId = '';

    for (const r of rows) {
      const id = String(r.conversation_id || '');
      if (!id) continue;
      const pId = String(r.parent_conversation_id || '');
      byId.set(id, {
        id,
        title: String(r.title || ''),
        preview: String(r.preview || '').slice(0, 100),
        stepCount: Number(r.step_count || 0),
        lastModifiedTime: String(r.last_modified_time || ''),
        workspaceUris: String(r.workspace_uris || ''),
        agentName: String(r.agent_name || ''),
        parentId: pId,
        nestingDepth: Number(r.nesting_depth || 0),
        active: Boolean(r.not_fully_idle),
        killed: Boolean(r.killed),
      });
      if (pId) {
        parentOf.set(id, pId);
        if (!childrenOf.has(pId)) childrenOf.set(pId, new Set());
        childrenOf.get(pId).add(id);
      } else if (!latestRootId && existsSync(join(APP_DATA_DIR, 'conversations', `${id}.db`))) {
        latestRootId = id;
      }
    }

    try {
      const pRows = db.prepare('SELECT conversation_id, parent_id FROM conversation_parents').all();
      for (const pr of pRows) {
        const cid = String(pr.conversation_id || '');
        const pid = String(pr.parent_id || '');
        if (cid && pid) {
          parentOf.set(cid, pid);
          if (!childrenOf.has(pid)) childrenOf.set(pid, new Set());
          childrenOf.get(pid).add(cid);
        }
      }
    } catch {
      // conversation_parents optional
    }

    return { byId, childrenOf, parentOf, latestRootId };
  } catch {
    return { byId: new Map(), childrenOf: new Map(), parentOf: new Map(), latestRootId: '' };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function buildSubagentTree(targetConvId, meta) {
  if (!targetConvId) return null;
  const { byId, childrenOf, parentOf } = meta;

  // Walk up to root
  let rootId = targetConvId;
  const visitedUp = new Set([rootId]);
  while (parentOf.has(rootId)) {
    const p = parentOf.get(rootId);
    if (!p || visitedUp.has(p)) break;
    visitedUp.add(p);
    rootId = p;
  }

  // BFS down all descendants
  const nodes = [];
  const queue = [{ id: rootId, depth: 0, parentId: null }];
  const seen = new Set();

  let treeIn = 0, treeCache = 0, treeOut = 0, treeThink = 0, treeEff = 0, treeStd = 0, treeGens = 0;

  while (queue.length > 0) {
    const { id, depth, parentId } = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);

    const sm = byId.get(id);
    const light = getLightConversation(id);
    const lsum = light?.summary;

    if (lsum) {
      treeIn += lsum.inputTokens;
      treeCache += lsum.cacheReadTokens;
      treeOut += lsum.outputTokens;
      treeThink += lsum.thinkingTokens;
      treeEff += lsum.costEffective;
      treeStd += lsum.costStandard;
      treeGens += lsum.genCount;
    }

    const role = depth === 0
      ? '主会话'
      : (sm?.agentName || lsum?.subagentType || 'subagent');

    nodes.push({
      id,
      parentId,
      depth,
      isSelected: id === targetConvId,
      title: sm?.title || (depth === 0 ? '当前主会话' : `子智能体 ${id.slice(0, 8)}`),
      hasCustomTitle: Boolean(sm?.title),
      role,
      active: sm?.active || false,
      killed: sm?.killed || false,
      lastModifiedTime: sm?.lastModifiedTime || '',
      hasDb: Boolean(light),
      genCount: lsum?.genCount || 0,
      inputTokens: lsum?.inputTokens || 0,
      cacheReadTokens: lsum?.cacheReadTokens || 0,
      outputTokens: lsum?.outputTokens || 0,
      costEffective: lsum?.costEffective || 0,
      costStandard: lsum?.costStandard || 0,
      steadyStreamMedian: lsum?.steadyStreamMedian ?? null,
      e2eMedian: lsum?.e2eMedian ?? null,
      modelBadge: lsum?.lastModelId ? classifyModelBadge(lsum.lastModelId, lsum.lastDisplayName) : null,
    });

    const kids = childrenOf.get(id);
    if (kids) {
      const sortedKids = [...kids].sort((a, b) => {
        const ta = byId.get(a)?.lastModifiedTime || '';
        const tb = byId.get(b)?.lastModifiedTime || '';
        return ta.localeCompare(tb);
      });
      for (const kid of sortedKids) {
        queue.push({ id: kid, depth: depth + 1, parentId: id });
      }
    }
  }

  return {
    rootId,
    nodeCount: nodes.length,
    totals: {
      genCount: treeGens,
      inputTokens: treeIn,
      cacheReadTokens: treeCache,
      outputTokens: treeOut,
      thinkingTokens: treeThink,
      costEffective: treeEff,
      costStandard: treeStd,
    },
    nodes,
  };
}

function searchConversations(queryStr = '', limit = 40) {
  const meta = readSummariesMeta();
  const q = String(queryStr || '').trim();
  const maxItems = Math.min(100, Math.max(5, Number(limit) || 40));

  let matchedIds = null;
  const snippetById = new Map();

  if (q) {
    const sumPath = join(APP_DATA_DIR, 'conversation_summaries.db');
    if (existsSync(sumPath)) {
      let db;
      try {
        db = new DatabaseSync(sumPath, { readOnly: true });
        // Quote each token safely so dashes/symbols never break FTS5 syntax
        const safeTokens = q
          .split(/\s+/)
          .filter(Boolean)
          .map((tok) => `"${tok.replace(/"/g, '""')}"*`);
        if (safeTokens.length > 0) {
          const ftsExpr = safeTokens.join(' AND ');
          const rows = db.prepare(`
            SELECT conversation_id,
                   snippet(conversations_fts, 10, '', '', '…', 12) AS title_snip,
                   snippet(conversations_fts, 13, '', '', '…', 16) AS user_snip
            FROM conversations_fts
            WHERE conversations_fts MATCH ?
            ORDER BY rank
            LIMIT 80
          `).all(ftsExpr);
          matchedIds = [];
          const seen = new Set();
          for (const r of rows) {
            const cid = String(r.conversation_id || '');
            if (cid && !seen.has(cid)) {
              seen.add(cid);
              matchedIds.push(cid);
              snippetById.set(cid, String(r.user_snip || r.title_snip || '').trim());
            }
          }
        }
      } catch {
        matchedIds = null;
      } finally {
        try { db?.close(); } catch { /* ignore */ }
      }
    }
  }

  const results = [];
  const candidateIds = matchedIds ?? [...meta.byId.keys()];

  for (const cid of candidateIds) {
    if (results.length >= maxItems) break;
    const sm = meta.byId.get(cid);
    // When browsing without query, show root conversations first (skip subagent noise unless searched)
    if (!q && sm && sm.parentId) continue;
    const dbExists = existsSync(join(APP_DATA_DIR, 'conversations', `${cid}.db`));
    if (!dbExists) continue;

    if (q && !matchedIds) {
      const hay = `${sm?.title || ''} ${sm?.preview || ''} ${cid}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) continue;
    }

    const light = getLightConversation(cid);
    const wsRaw = sm?.workspaceUris || '';
    const wsName = wsRaw ? decodeURIComponent(wsRaw.split(/[\\/]/).filter(Boolean).pop() || '') : '';

    results.push({
      id: cid,
      title: sm?.title || `会话 ${cid.slice(0, 8)}`,
      hasCustomTitle: Boolean(sm?.title),
      snippet: snippetById.get(cid) || sm?.preview || '',
      workspace: wsName.replace(/["\]}]/g, ''),
      lastModifiedTime: sm?.lastModifiedTime || '',
      isSubagent: Boolean(sm?.parentId),
      active: Boolean(sm?.active),
      genCount: light?.summary.genCount || 0,
      outputTokens: light?.summary.outputTokens || 0,
      costEffective: light?.summary.costEffective || 0,
      costStandard: light?.summary.costStandard || 0,
      lastModelId: light?.summary.lastModelId || '',
    });
  }

  return { query: q, latestRootId: meta.latestRootId, items: results };
}

// ---------------------------------------------------------------------------
// 5-Hour & Weekly Plan Quota + Multi-Account Attribution (`RetrieveUserQuotaSummary`)
// ---------------------------------------------------------------------------

let quotaCache = {
  fetchedAtMs: 0,
  summaryGroups: null,
  rawStatus: null,
  explicitSignedOut: false,
  lastGenTotal: -1,
};
let quotaInFlight = null;

const { ledger: ledgerState } = loadLedger(ACCOUNT_LEDGER_PATH, PROCESS_STARTED_AT_SEC);

function readQuotaHistory() {
  try {
    if (!existsSync(QUOTA_HISTORY_PATH)) return [];
    const arr = JSON.parse(readFileSync(QUOTA_HISTORY_PATH, 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveQuotaHistory(entries) {
  try {
    mkdirSync(SIDECAR_DATA_DIR, { recursive: true });
    writeFileSync(QUOTA_HISTORY_PATH, JSON.stringify(entries.slice(0, 80), null, 2), 'utf-8');
  } catch {
    // non-fatal
  }
}

async function callLsRpc(lsAddr, csrf, method) {
  try {
    const res = await fetch(
      `http://${lsAddr}/exa.language_server_pb.LanguageServerService/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf,
        },
        body: '{}',
        signal: AbortSignal.timeout(3500),
      }
    );
    if (!res.ok) {
      let bodyText = '';
      try { bodyText = (await res.text()).slice(0, 240); } catch { /* ignore */ }
      const signedOut = res.status === 401 || /not logged|unauth|token source/i.test(bodyText);
      return { ok: false, status: res.status, signedOut, data: null };
    }
    return { ok: true, status: res.status, signedOut: false, data: await res.json() };
  } catch {
    return { ok: false, status: 0, signedOut: false, data: null };
  }
}

async function fetchLsQuotaSources(force = false) {
  const now = Date.now();
  if (!force && !quotaCache.explicitSignedOut && (quotaCache.summaryGroups || quotaCache.rawStatus) && now - quotaCache.fetchedAtMs < 12_000) {
    return { ...quotaCache, statusFetched: true };
  }
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddr || !csrf) return { ...quotaCache, statusFetched: false };

  const [sumRes, statusRes] = await Promise.allSettled([
    callLsRpc(lsAddr, csrf, 'RetrieveUserQuotaSummary'),
    callLsRpc(lsAddr, csrf, 'GetUserStatus'),
  ]);

  let statusFetched = false;
  if (statusRes.status === 'fulfilled') {
    const sr = statusRes.value;
    if (sr.ok) {
      statusFetched = true;
      const nextStatus = sr.data?.userStatus || null;
      const prevEmail = String(quotaCache.rawStatus?.email || '').trim().toLowerCase();
      const nextEmail = String(nextStatus?.email || '').trim().toLowerCase();
      const prevTier = String(quotaCache.rawStatus?.userTier?.id || '');
      const nextTier = String(nextStatus?.userTier?.id || '');

      if (!nextStatus || (!nextEmail && !nextTier)) {
        quotaCache.explicitSignedOut = true;
        quotaCache.summaryGroups = null;
        quotaCache.rawStatus = null;
      } else {
        if ((prevEmail && nextEmail && prevEmail !== nextEmail) || (prevTier && nextTier && prevTier !== nextTier)) {
          quotaCache.summaryGroups = null;
        }
        quotaCache.explicitSignedOut = false;
        quotaCache.rawStatus = nextStatus;
      }
      quotaCache.fetchedAtMs = now;
    } else if (sr.signedOut) {
      statusFetched = true;
      quotaCache.explicitSignedOut = true;
      quotaCache.summaryGroups = null;
      quotaCache.rawStatus = null;
      quotaCache.fetchedAtMs = now;
    }
  }

  if (sumRes.status === 'fulfilled' && sumRes.value?.ok && !quotaCache.explicitSignedOut) {
    const groups = sumRes.value.data?.response?.groups || sumRes.value.data?.groups;
    if (Array.isArray(groups) && groups.length > 0) {
      quotaCache.summaryGroups = groups;
      quotaCache.fetchedAtMs = now;
    }
  }

  return { ...quotaCache, statusFetched };
}

function listAllConversationIds() {
  const dir = join(APP_DATA_DIR, 'conversations');
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => f.slice(0, -3))
      .filter((id) => ID_RE.test(id));
  } catch {
    return [];
  }
}

function maxConvMtimeMs(convDir, id) {
  const dbPath = join(convDir, `${id}.db`);
  try {
    let m = statSync(dbPath).mtimeMs;
    try {
      const wm = statSync(`${dbPath}-wal`).mtimeMs;
      if (wm > m) m = wm;
    } catch { /* no wal */ }
    return m;
  } catch {
    return 0;
  }
}

function syncAttributionLedger(src, nowSec = Date.now() / 1000) {
  const convDir = join(APP_DATA_DIR, 'conversations');
  const convEntries = [];

  for (const id of listAllConversationIds()) {
    const mtimeMs = maxConvMtimeMs(convDir, id);
    if (!mtimeMs) continue;
    const existing = ledgerState.conversations?.[id];
    if (existing && mtimeMs <= existing.mtimeMs) continue;
    convEntries.push({
      convId: id,
      mtimeMs,
      getGens: () => getLightConversation(id)?.gens || [],
    });
  }

  const rawStatusArg = src.statusFetched
    ? (src.explicitSignedOut ? null : src.rawStatus)
    : undefined;

  const authBoundaries = readAuthBoundariesFromLsLog(LS_LOG_PATH, nowSec * 1000);
  const res = syncLedgerState(ledgerState, {
    rawStatus: rawStatusArg,
    explicitSignedOut: Boolean(src.explicitSignedOut),
    nowSec,
    processStartedAtSec: PROCESS_STARTED_AT_SEC,
    authBoundaries,
    convEntries,
  });

  if (res.dirty) {
    saveLedger(ACCOUNT_LEDGER_PATH, SIDECAR_DATA_DIR, ledgerState);
  }
  return res;
}

function sumAllBucketSpends(specs, targetAccountKey) {
  const totals = new Map();
  let earliestStartSec = Infinity;
  for (const sp of specs) {
    totals.set(sp.id, {
      genCount: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      spendEffective: 0,
      spendStandard: 0,
    });
    if (sp.winStartSec < earliestStartSec) earliestStartSec = sp.winStartSec;
  }
  if (!specs.length || !targetAccountKey) return totals;

  const convDir = join(APP_DATA_DIR, 'conversations');
  const minEffectiveSec = Math.max(earliestStartSec, ledgerState.trackingStartedAtSec);

  for (const id of listAllConversationIds()) {
    const maxMtimeSec = maxConvMtimeMs(convDir, id) / 1000;
    if (!maxMtimeSec || maxMtimeSec < minEffectiveSec - 300) continue;

    const convLedger = ledgerState.conversations?.[id];
    if (!convLedger || !Array.isArray(convLedger.ranges)) continue;
    // Fast skip if this conversation has zero ranges attributed to targetAccountKey
    if (!convLedger.ranges.some((r) => r.accountKey === targetAccountKey)) continue;

    const light = getLightConversation(id);
    if (!light || !light.gens.length) continue;

    for (const sp of specs) {
      if (maxMtimeSec < sp.winStartSec - 300) continue;
      if (sp.winEndSec < ledgerState.trackingStartedAtSec) continue;
      const acc = totals.get(sp.id);

      for (const g of light.gens) {
        if (sp.matchPools ? !sp.matchPools.has(g.poolKey) : g.poolKey !== sp.poolKey) continue;
        if (lookupGenAccount(ledgerState, id, g.genIdx) !== targetAccountKey) continue;
        const refTs = g.completedAt > 0 ? g.completedAt : g.createdAt;
        if (refTs >= sp.winStartSec && g.createdAt >= sp.winStartSec - 60 && g.createdAt <= sp.winEndSec + 60) {
          acc.genCount++;
          acc.inputTokens += g.inputTokens;
          acc.cacheReadTokens += g.cacheReadTokens;
          acc.outputTokens += g.outputTokens;
          acc.spendEffective += g.costEffective;
          acc.spendStandard += g.costStandard;
        }
      }
    }
  }
  return totals;
}

const QUOTA_POOL_ORDER = ['gemini', 'claude', 'argon'];
const QUOTA_POOL_TITLES = {
  gemini: 'Gemini 共享池',
  claude: 'Claude / 第三方池',
  argon: 'Argon 独立池',
};

function resolveQuotaPoolKey(text = '', bucketIds = '') {
  const hay = `${text} ${bucketIds}`.toLowerCase();
  if (hay.includes('argon') || hay.includes('orchestrator-g1-pro')) return 'argon';
  if (hay.includes('gemini')) return 'gemini';
  return 'claude';
}

async function computeQuotaSnapshot(force = false) {
  let src = await fetchLsQuotaSources(force);
  const nowSec = Date.now() / 1000;
  let syncRes = syncAttributionLedger(src, nowSec);

  // If account changed since cached quota groups were fetched, immediately force-refresh RPCs
  if (syncRes.accountChanged && !force) {
    src = await fetchLsQuotaSources(true);
    syncRes = syncAttributionLedger(src, Date.now() / 1000);
  }

  const normalized = normalizeQuotaHistoryEntries(readQuotaHistory(), ledgerState.accounts);
  const history = normalized.entries;
  let historyDirty = normalized.mutated;

  const account = syncRes.activeAccount;
  const accountKey = account?.accountKey || '';
  const knownAccountCount = Object.keys(ledgerState.accounts || {}).length;

  if (src.explicitSignedOut || (!src.summaryGroups && !src.rawStatus)) {
    if (historyDirty) saveQuotaHistory(history);
    return {
      available: false,
      signedOut: Boolean(src.explicitSignedOut),
      planName: '',
      account: null,
      activeAccount: null,
      knownAccountCount,
      trackingStartedAtSec: ledgerState.trackingStartedAtSec,
      pools: [],
      history: [],
      allHistory: history.slice(0, 36),
    };
  }

  const planName = account?.planName || resolvePlanName(src.rawStatus);
  const grouped = new Map();

  const ensurePool = (poolKey) => {
    if (!grouped.has(poolKey)) {
      grouped.set(poolKey, {
        poolKey,
        title: QUOTA_POOL_TITLES[poolKey] || poolKey,
        rawBuckets: new Map(), // window ('5h' | 'weekly') -> { remainingFraction, resetTime }
      });
    }
    return grouped.get(poolKey);
  };

  // Primary source: RetrieveUserQuotaSummary (provides 5h, weekly, and separate Pro Argon group)
  if (Array.isArray(src.summaryGroups)) {
    for (const grp of src.summaryGroups) {
      const buckets = Array.isArray(grp?.buckets) ? grp.buckets : [];
      const bucketIds = buckets.map((b) => String(b?.bucketId || '')).join(' ');
      const poolKey = resolveQuotaPoolKey(grp?.displayName || '', bucketIds);
      const p = ensurePool(poolKey);

      for (const b of buckets) {
        if (typeof b?.remainingFraction !== 'number') continue;
        const bid = String(b.bucketId || '').toLowerCase();
        const win = b.window === 'weekly' || bid.endsWith('weekly') ? 'weekly' : '5h';
        p.rawBuckets.set(win, {
          remainingFraction: Math.max(0, Math.min(1, Number(b.remainingFraction))),
          resetTime: String(b.resetTime || ''),
        });
      }
    }
  }

  // Fallback only when RetrieveUserQuotaSummary is unavailable
  if (grouped.size === 0 && src.rawStatus) {
    const nowFallback = Date.now() / 1000;
    const configs = Array.isArray(src.rawStatus.cascadeModelConfigData?.clientModelConfigs)
      ? src.rawStatus.cascadeModelConfigData.clientModelConfigs
      : [];
    for (const cfg of configs) {
      const q = cfg?.quotaInfo;
      if (!q || typeof q.remainingFraction !== 'number') continue;
      const poolKey = resolveQuotaPoolKey(cfg.modelId || '', cfg.label || '');
      const resetMs = q.resetTime ? Date.parse(q.resetTime) : NaN;
      const win = Number.isFinite(resetMs) && (resetMs / 1000 - nowFallback) > 36 * 3600 ? 'weekly' : '5h';
      const p = ensurePool(poolKey);
      const cur = p.rawBuckets.get(win);
      const frac = Math.max(0, Math.min(1, Number(q.remainingFraction)));
      if (!cur || frac < cur.remainingFraction) {
        p.rawBuckets.set(win, {
          remainingFraction: frac,
          resetTime: String(q.resetTime || cur?.resetTime || ''),
        });
      }
    }
  }

  // On Pro plans Argon has its own bucket; on Ultra plans Argon shares the Gemini bucket
  const hasSeparateArgon = grouped.has('argon');
  const spendSpecs = [];
  const specsByPool = new Map();

  for (const poolKey of QUOTA_POOL_ORDER) {
    const p = grouped.get(poolKey);
    if (!p) continue;
    const matchPools = poolKey === 'gemini' && !hasSeparateArgon
      ? new Set(['gemini', 'argon'])
      : new Set([poolKey]);

    const poolSpecs = [];
    for (const win of ['5h', 'weekly']) {
      const rb = p.rawBuckets.get(win);
      if (!rb) continue;
      const durSec = win === 'weekly' ? 7 * 86400 : 5 * 3600;
      const resetMs = rb.resetTime ? Date.parse(rb.resetTime) : NaN;
      const resetSec = Number.isFinite(resetMs) ? resetMs / 1000 : nowSec + durSec;
      const winStartSec = resetSec - durSec;
      const sp = {
        id: `${poolKey}:${win}`,
        poolKey,
        matchPools,
        win,
        rb,
        resetSec,
        winStartSec,
        winEndSec: Math.max(nowSec, resetSec),
      };
      spendSpecs.push(sp);
      poolSpecs.push(sp);
    }
    if (poolSpecs.length) specsByPool.set(poolKey, { pool: p, poolSpecs });
  }

  const spendMap = sumAllBucketSpends(spendSpecs, accountKey);
  const pools = [];
  let ledgerDirty = false;

  for (const poolKey of QUOTA_POOL_ORDER) {
    const entry = specsByPool.get(poolKey);
    if (!entry) continue;
    const { pool: p, poolSpecs } = entry;

    const builtBuckets = [];
    for (const { id: specId, win, rb, resetSec, winStartSec } of poolSpecs) {
      const winUsage = spendMap.get(specId) || {
        genCount: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, spendEffective: 0, spendStandard: 0,
      };
      const valuation = evaluateBucketValuation({
        ledger: ledgerState,
        account,
        poolKey,
        win,
        rb,
        winStartSec,
        winUsage,
        nowSec,
      });
      if (valuation.baselineMutated) ledgerDirty = true;

      const prevRecord = accountKey
        ? (history.find(
            (h) => h.accountKey === accountKey && h.poolKey === poolKey && (h.windowType || '5h') === win && h.fullValueEffective > 0
          ) || null)
        : null;

      if (valuation.sampleReady && rb.resetTime && accountKey) {
        const histKey = `${accountKey}|${poolKey}|${win}|${rb.resetTime}`;
        const existingIdx = history.findIndex((h) => h.key === histKey);
        const record = {
          key: histKey,
          accountKey,
          accountLabel: account.accountLabel,
          planName: account.planName,
          poolKey,
          poolTitle: p.title,
          windowType: win,
          windowStartIso: new Date(winStartSec * 1000).toISOString(),
          resetTimeIso: rb.resetTime,
          updatedAtIso: new Date().toISOString(),
          usedFraction: valuation.usedFraction,
          isPartialWindow: valuation.isPartialWindow,
          baselineUsedFraction: valuation.baselineUsedFraction,
          deltaUsedFraction: valuation.deltaUsedFraction,
          genCount: winUsage.genCount,
          spendEffective: valuation.spendEffectiveForHistory,
          spendStandard: valuation.spendStandardForHistory,
          fullValueEffective: valuation.fullValueEffective,
          fullValueStandard: valuation.fullValueStandard,
        };
        if (existingIdx >= 0) {
          const prev = history[existingIdx];
          if (
            Math.abs((prev.usedFraction || 0) - valuation.usedFraction) > 0.0005 ||
            prev.genCount !== winUsage.genCount ||
            prev.accountLabel !== account.accountLabel
          ) {
            history[existingIdx] = record;
            historyDirty = true;
          }
        } else {
          history.unshift(record);
          historyDirty = true;
        }
      }

      builtBuckets.push({
        window: win,
        label: win === 'weekly' ? '周' : '5h',
        remainingFraction: rb.remainingFraction,
        usedFraction: valuation.usedFraction,
        isPartialWindow: valuation.isPartialWindow,
        deltaUsedFraction: valuation.deltaUsedFraction,
        resetTimeIso: rb.resetTime,
        windowStartSec: winStartSec,
        resetSec,
        secondsUntilReset: Math.max(0, Math.round(resetSec - nowSec)),
        genCount: winUsage.genCount,
        inputTokens: winUsage.inputTokens,
        cacheReadTokens: winUsage.cacheReadTokens,
        outputTokens: winUsage.outputTokens,
        spendEffective: winUsage.spendEffective,
        spendStandard: winUsage.spendStandard,
        sampleReady: valuation.sampleReady,
        fullValueEffective: valuation.fullValueEffective,
        fullValueStandard: valuation.fullValueStandard,
        fallbackFullEffective: prevRecord?.fullValueEffective ?? null,
        fallbackFullStandard: prevRecord?.fullValueStandard ?? null,
      });
    }

    if (!builtBuckets.length) continue;
    const primary5h = builtBuckets.find((b) => b.window === '5h') || builtBuckets[0];

    pools.push({
      poolKey,
      title: p.title,
      windowStartSec: primary5h.windowStartSec,
      remainingFraction: primary5h.remainingFraction,
      buckets: builtBuckets,
    });
  }

  if (ledgerDirty) {
    saveLedger(ACCOUNT_LEDGER_PATH, SIDECAR_DATA_DIR, ledgerState);
  }
  if (historyDirty) {
    history.sort((a, b) => String(b.updatedAtIso || b.resetTimeIso).localeCompare(String(a.updatedAtIso || a.resetTimeIso)));
    saveQuotaHistory(history);
  }

  const scopedHistory = accountKey
    ? history.filter((h) => h.accountKey === accountKey).slice(0, 24)
    : [];

  return {
    available: pools.length > 0,
    signedOut: false,
    planName,
    account,
    activeAccount: account,
    knownAccountCount,
    trackingStartedAtSec: ledgerState.trackingStartedAtSec,
    fetchedAtIso: new Date(quotaCache.fetchedAtMs || Date.now()).toISOString(),
    pools,
    history: scopedHistory,
    allHistory: history.slice(0, 36),
  };
}

async function getQuotaSnapshot(force = false) {
  if (force || !quotaInFlight) {
    quotaInFlight = computeQuotaSnapshot(force).finally(() => {
      quotaInFlight = null;
    });
  }
  return quotaInFlight;
}

// ---------------------------------------------------------------------------
// Global Stats & Backend Model Speed Leaderboard (`/api/global`)
// ---------------------------------------------------------------------------

async function buildGlobalStats(range = '7d', accountScope = 'current') {
  const quota = await getQuotaSnapshot(false);
  const nowSec = Date.now() / 1000;
  let minTs = 0;
  if (range === '5h') {
    const gem5h = quota.pools?.find((p) => p.poolKey === 'gemini')?.buckets?.find((b) => b.window === '5h');
    const any5h = (quota.pools || [])
      .flatMap((p) => p.buckets || [])
      .filter((b) => b.window === '5h' && b.windowStartSec > 0)
      .map((b) => b.windowStartSec);
    minTs = gem5h?.windowStartSec || (any5h.length ? Math.min(...any5h) : 0) || (nowSec - 5 * 3600);
  } else if (range === '7d') {
    minTs = nowSec - 7 * 86400;
  }

  const activeAccount = quota.activeAccount || null;
  const activeKey = activeAccount?.accountKey || '';
  const resolvedScope = accountScope === 'all' ? 'all' : 'current';
  const filterByActiveAccount = resolvedScope === 'current' && Boolean(activeKey);

  const convDir = join(APP_DATA_DIR, 'conversations');
  const modelMap = new Map();
  let sessionCount = 0;
  let totalGens = 0;
  let totalIn = 0, totalCache = 0, totalOut = 0, totalThink = 0;
  let totalEff = 0, totalStd = 0;

  for (const id of listAllConversationIds()) {
    if (filterByActiveAccount) {
      const convLedger = ledgerState.conversations?.[id];
      if (!convLedger || !convLedger.ranges?.some((r) => r.accountKey === activeKey)) continue;
    }

    if (minTs > 0) {
      const maxMtime = maxConvMtimeMs(convDir, id) / 1000;
      if (!maxMtime || maxMtime < minTs - 300) continue;
    }

    const light = getLightConversation(id);
    if (!light || !light.gens.length) continue;

    let sessionMatched = false;
    for (const g of light.gens) {
      const refTs = g.completedAt > 0 ? g.completedAt : g.createdAt;
      if (minTs > 0 && refTs < minTs) continue;
      if (filterByActiveAccount && lookupGenAccount(ledgerState, id, g.genIdx) !== activeKey) continue;
      sessionMatched = true;
      totalGens++;
      totalIn += g.inputTokens;
      totalCache += g.cacheReadTokens;
      totalOut += g.outputTokens;
      totalThink += g.thinkingTokens;
      totalEff += g.costEffective;
      totalStd += g.costStandard;

      const mid = g.modelId || 'unknown';
      let m = modelMap.get(mid);
      if (!m) {
        m = {
          modelId: mid,
          modelBadge: g.modelBadge,
          displayNames: new Set(),
          genCount: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          thinkingTokens: 0,
          costEffective: 0,
          costStandard: 0,
          steadyStreams: [],
          allStreams: [],
          e2eRates: [],
          ttfts: [],
        };
        modelMap.set(mid, m);
      }
      if (g.displayName) m.displayNames.add(g.displayName);
      m.genCount++;
      m.inputTokens += g.inputTokens;
      m.cacheReadTokens += g.cacheReadTokens;
      m.outputTokens += g.outputTokens;
      m.thinkingTokens += g.thinkingTokens;
      m.costEffective += g.costEffective;
      m.costStandard += g.costStandard;
      if (g.isSteadySample && g.streamTokPerSec) m.steadyStreams.push(g.streamTokPerSec);
      if (!g.isBuffered && g.streamTokPerSec) m.allStreams.push(g.streamTokPerSec);
      if (g.e2eTokPerSec) m.e2eRates.push(g.e2eTokPerSec);
      if (g.ttftSec > 0) m.ttfts.push(g.ttftSec);
    }
    if (sessionMatched) sessionCount++;
  }

  const models = [];
  for (const m of modelMap.values()) {
    m.steadyStreams.sort((a, b) => a - b);
    m.allStreams.sort((a, b) => a - b);
    m.e2eRates.sort((a, b) => a - b);
    m.ttfts.sort((a, b) => a - b);
    const streamSource = m.steadyStreams.length ? m.steadyStreams : m.allStreams;
    const promptSum = m.inputTokens + m.cacheReadTokens;

    models.push({
      modelId: m.modelId,
      modelBadge: m.modelBadge,
      displayNames: [...m.displayNames].slice(0, 3),
      genCount: m.genCount,
      steadyCount: m.steadyStreams.length,
      streamP50: percentile(streamSource, 0.5),
      streamP90: percentile(streamSource, 0.9),
      e2eP50: percentile(m.e2eRates, 0.5),
      ttftP50: percentile(m.ttfts, 0.5),
      cacheHitRate: promptSum > 0 ? m.cacheReadTokens / promptSum : 0,
      inputTokens: m.inputTokens,
      cacheReadTokens: m.cacheReadTokens,
      outputTokens: m.outputTokens,
      thinkingTokens: m.thinkingTokens,
      costEffective: m.costEffective,
      costStandard: m.costStandard,
    });
  }

  // Sort leaderboard by steady stream P50 desc, then genCount desc
  models.sort((a, b) => (b.streamP50 ?? -1) - (a.streamP50 ?? -1) || b.genCount - a.genCount);

  return {
    range,
    minTs,
    accountScope: resolvedScope,
    activeAccount,
    knownAccountCount: quota.knownAccountCount || 0,
    trackingStartedAtSec: quota.trackingStartedAtSec || ledgerState.trackingStartedAtSec,
    totals: {
      sessionCount,
      genCount: totalGens,
      inputTokens: totalIn,
      cacheReadTokens: totalCache,
      outputTokens: totalOut,
      thinkingTokens: totalThink,
      cacheHitRate: totalIn + totalCache > 0 ? totalCache / (totalIn + totalCache) : 0,
      costEffective: totalEff,
      costStandard: totalStd,
    },
    models,
    quotaHistory: resolvedScope === 'all' ? (quota.allHistory || []) : (quota.history || []),
  };
}

// ---------------------------------------------------------------------------
// Sidecar HTTP Server Registration & Background Attribution Poller
// ---------------------------------------------------------------------------

const app = new SidecarApp();

app.page('/', () => new Response(readFileSync(join(__dirname, 'index.html'), 'utf-8'), {
  contentType: 'text/html; charset=utf-8',
  headers: { 'Cache-Control': 'no-store' },
}));

app.api('/styles.css', () => new Response(readFileSync(join(__dirname, 'styles.css'), 'utf-8'), {
  contentType: 'text/css; charset=utf-8',
  headers: { 'Cache-Control': 'no-store' },
}), 'GET');

app.api('/app.js', () => new Response(readFileSync(join(__dirname, 'app.js'), 'utf-8'), {
  contentType: 'application/javascript; charset=utf-8',
  headers: { 'Cache-Control': 'no-store' },
}), 'GET');

app.api('/api/session', async (data) => {
  const meta = readSummariesMeta();
  const requestedId = typeof data.conversationId === 'string' && ID_RE.test(data.conversationId)
    ? data.conversationId
    : '';
  const hostId = typeof app.config.conversationId === 'string' && ID_RE.test(app.config.conversationId)
    ? app.config.conversationId
    : '';

  const targetId = requestedId || hostId || meta.latestRootId || listAllConversationIds()[0] || '';
  if (!targetId) {
    const quota = await getQuotaSnapshot(data.forceQuota === '1');
    return { empty: true, quota };
  }

  const detail = getDetailedConversation(targetId);
  const genCountNow = detail?.kpis?.genCount ?? 0;
  const genChanged = quotaCache.lastGenTotal >= 0 && genCountNow !== quotaCache.lastGenTotal;
  quotaCache.lastGenTotal = genCountNow;

  const quota = await getQuotaSnapshot(data.forceQuota === '1' || genChanged);
  const tree = buildSubagentTree(targetId, meta);
  const summaryMeta = meta.byId.get(targetId) || null;

  const quotaSig = (quota.pools || [])
    .map((p) =>
      (p.buckets || [])
        .map((b) => `${b.genCount || 0}:${Math.round((b.spendEffective || 0) * 10000)}:${Math.round((b.remainingFraction ?? -1) * 1000)}`)
        .join(','),
    )
    .join(';');
  const etag = [
    targetId,
    detail?.sig || 'none',
    detail?.liveState?.state || 'idle',
    Math.floor((detail?.liveState?.elapsedSec || 0)),
    tree?.totals?.genCount || 0,
    `${quota.activeAccount?.accountKey || (quota.signedOut ? 'signed_out' : '')}:${quota.activeAccount?.accountLabel || ''}`,
    quota.fetchedAtIso || '',
    quotaSig,
  ].join('|');

  const uiBuild = computeUiBuild();
  if (data.etag && data.etag === etag && detail?.liveState?.state === 'idle') {
    return { unchanged: true, uiBuild, etag, conversationId: targetId, latestRootId: meta.latestRootId };
  }

  return {
    uiBuild,
    etag,
    conversationId: targetId,
    latestRootId: meta.latestRootId,
    meta: summaryMeta,
    session: detail,
    tree,
    quota,
  };
}, 'GET');

app.api('/api/sessions', (data) => {
  return searchConversations(data.q || '', data.limit || 40);
}, 'GET');

app.api('/api/global', async (data) => {
  const range = ['5h', '7d', 'all'].includes(data.range) ? data.range : '7d';
  const accountScope = ['current', 'all'].includes(data.accountScope) ? data.accountScope : 'current';
  return buildGlobalStats(range, accountScope);
}, 'GET');

let bgTrackerBusy = false;
async function runBackgroundLedgerTick() {
  if (bgTrackerBusy) return;
  bgTrackerBusy = true;
  try {
    await getQuotaSnapshot(false);
  } catch {
    // non-fatal
  } finally {
    bgTrackerBusy = false;
  }
}

app.run().then(() => {
  runBackgroundLedgerTick();
  const timer = setInterval(runBackgroundLedgerTick, 12_000);
  timer.unref?.();
});
