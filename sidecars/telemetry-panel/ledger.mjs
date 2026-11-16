/**
 * AGY Meter — Multi-Account Attribution Ledger & Quota Isolation (`ledger.mjs`)
 *
 * Maintains a privacy-safe local attribution ledger (`account_ledger.json`) in `SIDECAR_DATA_DIR`
 * so switching between Antigravity accounts (e.g. Pro <-> Ultra) never mixes spend or
 * quota history across accounts.
 *
 * Privacy guarantee:
 * - Only stores a 16-char SHA-256 hex digest (`accountKey`) and a truncated prefix (`zh***`)
 *   without domain or full email addresses.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolves Antigravity's `language_server.log` path across platforms (best-effort optional signal).
 */
export function resolveLsLogPath(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') {
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
    return join(appData, 'Antigravity', 'logs', 'language_server.log');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Antigravity', 'logs', 'language_server.log');
  }
  const cfgHome = env.XDG_CONFIG_HOME || join(home, '.config');
  return join(cfgHome, 'Antigravity', 'logs', 'language_server.log');
}

/**
 * Parses a glog line prefix (`I1116 21:27:45.299178 ...`) as local Unix seconds.
 */
export function parseGlogLocalTs(line, nowMs = Date.now()) {
  const m = /^[IWEF](\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(line);
  if (!m) return 0;
  const mon = Number(m[1]) - 1;
  const day = Number(m[2]);
  const hh = Number(m[3]);
  const mm = Number(m[4]);
  const ss = Number(m[5]);
  const frac = m[6] ? Number(`0.${m[6]}`) : 0;
  const nowDate = new Date(nowMs);
  const year = nowDate.getFullYear();

  // Pick candidate year closest to nowMs (handles Dec 31 <-> Jan 1 boundary safely)
  let bestTs = 0;
  let bestDiff = Infinity;
  for (const y of [year - 1, year, year + 1]) {
    const d = new Date(y, mon, day, hh, mm, ss, 0);
    if (d.getMonth() !== mon || d.getDate() !== day) continue;
    const tsSec = d.getTime() / 1000 + frac;
    const diff = Math.abs(nowMs / 1000 - tsSec);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestTs = tsSec;
    }
  }
  return bestDiff <= 180 * 86400 ? bestTs : 0;
}

/**
 * Tail-reads the trailing bytes of `language_server.log` for recent auth boundary timestamps
 * (`SetUserTier ... ""` sign-out and `[auth-login] ... code_exchanged / done` sign-in).
 */
export function readAuthBoundariesFromLsLog(logPath = resolveLsLogPath(), nowMs = Date.now()) {
  if (!logPath || !existsSync(logPath)) return { logoutAtSec: 0, loginAtSec: 0 };
  let fd;
  try {
    const size = statSync(logPath).size;
    if (size <= 0) return { logoutAtSec: 0, loginAtSec: 0 };
    const tailBytes = Math.min(size, 65536);
    const buf = Buffer.allocUnsafe(tailBytes);
    fd = openSync(logPath, 'r');
    readSync(fd, buf, 0, tailBytes, size - tailBytes);
    const lines = buf.toString('utf8').split(/\r?\n/);

    let logoutAtSec = 0;
    let loginAtSec = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l) continue;
      if (!loginAtSec && l.includes('[auth-login]') && (l.includes('step=code_exchanged') || l.includes(' done '))) {
        const ts = parseGlogLocalTs(l, nowMs);
        if (ts > 0) loginAtSec = ts;
      }
      if (!logoutAtSec && l.includes('SetUserTier called with userTier: ""')) {
        const ts = parseGlogLocalTs(l, nowMs);
        if (ts > 0) logoutAtSec = ts;
      }
      if (loginAtSec && logoutAtSec) break;
    }
    return { logoutAtSec, loginAtSec };
  } catch {
    return { logoutAtSec: 0, loginAtSec: 0 };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Resolves the user-facing subscription tier label (e.g. 'Ultra', 'Pro', 'Free').
 * Prioritizes `userTier.name` and `userTier.id` because Google AI Ultra tiers
 * (e.g. `g1-ultra-lite-tier`) still report `planInfo.planName: 'Pro'` in backend metadata.
 */
export function resolvePlanName(rawStatus) {
  if (!rawStatus || typeof rawStatus !== 'object') return 'Plan';
  const tierId = String(rawStatus.userTier?.id || rawStatus.planStatus?.planInfo?.teamsTier || '').trim();
  const tierName = String(rawStatus.userTier?.name || '').replace(/^Google AI\s+/i, '').trim();
  const planInfoName = String(rawStatus.planStatus?.planInfo?.planName || '').replace(/^Google AI\s+/i, '').trim();
  let plan = tierName || planInfoName || 'Plan';
  if (/ultra/i.test(tierId) && !/ultra/i.test(plan)) {
    plan = 'Ultra';
  } else if (/pro/i.test(tierId) && plan === 'Plan') {
    plan = 'Pro';
  }
  return plan;
}

/**
 * Derives an anonymized, collision-disambiguated account identity from `GetUserStatus.userStatus`.
 * Returns `null` when user status indicates signed-out / unauthenticated.
 */
export function deriveAccountIdentity(rawStatus, accountsRegistry = {}) {
  if (!rawStatus || typeof rawStatus !== 'object') return null;
  const emailNorm = String(rawStatus.email || '').trim().toLowerCase();
  const tierId = String(rawStatus.userTier?.id || rawStatus.planStatus?.planInfo?.teamsTier || '').trim();
  if (!emailNorm && !tierId) return null;

  const keyInput = emailNorm || `tier:${tierId}`;
  const accountKey = createHash('sha256').update(keyInput).digest('hex').slice(0, 16);

  const rawPlan = resolvePlanName(rawStatus);

  const localPart = emailNorm.includes('@') ? emailNorm.split('@')[0] : '';
  const maskedHint = localPart ? `${localPart.slice(0, Math.min(2, localPart.length))}***` : '';

  const baseLabel = maskedHint ? `${rawPlan} (${maskedHint})` : rawPlan;
  let accountLabel = baseLabel;

  // Disambiguate if a different account shares identical plan + 2-char masked prefix
  const hasCollision = Object.entries(accountsRegistry).some(
    ([k, meta]) => k !== accountKey && meta && meta.accountLabel === baseLabel
  );
  if (hasCollision) {
    accountLabel = `${rawPlan} (${maskedHint || 'acct'}#${accountKey.slice(0, 2)})`;
  }

  return {
    accountKey,
    planName: rawPlan,
    tierId,
    maskedHint,
    accountLabel,
  };
}

export function createEmptyLedger(nowSec = Date.now() / 1000) {
  return {
    version: 1,
    trackingStartedAtSec: nowSec,
    activeSession: null,
    prevSession: null,
    accounts: {},
    conversations: {},
    windowBaselines: {},
  };
}

export function loadLedger(ledgerPath, nowSec = Date.now() / 1000) {
  try {
    if (existsSync(ledgerPath)) {
      const parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && Number(parsed.trackingStartedAtSec) > 0) {
        parsed.accounts ||= {};
        parsed.conversations ||= {};
        parsed.windowBaselines ||= {};
        return { ledger: parsed, existed: true };
      }
    }
  } catch {
    // Fall through to clean initialization if corrupted
  }
  return { ledger: createEmptyLedger(nowSec), existed: false };
}

export function saveLedger(ledgerPath, dataDir, ledger) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf-8');
  } catch {
    // non-fatal
  }
}

export function appendGenAttribution(convEntry, genIdx, accountKey) {
  const ranges = convEntry.ranges;
  const last = ranges[ranges.length - 1];
  if (last && last.to + 1 === genIdx && last.accountKey === accountKey) {
    last.to = genIdx;
  } else if (!last || genIdx > last.to) {
    ranges.push({ from: genIdx, to: genIdx, accountKey });
  }
  if (genIdx >= convEntry.nextGenIdx) {
    convEntry.nextGenIdx = genIdx + 1;
  }
}

/**
 * Looks up the attributed `accountKey` (`string` or `null`) for `(convId, genIdx)`.
 */
export function lookupGenAccount(ledger, convId, genIdx) {
  const entry = ledger?.conversations?.[convId];
  if (!entry || !Array.isArray(entry.ranges)) return null;
  for (let i = 0; i < entry.ranges.length; i++) {
    const r = entry.ranges[i];
    if (genIdx >= r.from && genIdx <= r.to) return r.accountKey || null;
  }
  return null;
}

/**
 * Advances account state transitions and incrementally attributes newly added
 * generations in modified conversations into run-length ranges.
 *
 * @param {object} ledger Mutable ledger object
 * @param {object} opts
 * @param {object|null|undefined} opts.rawStatus `GetUserStatus.userStatus` (`undefined` = transient fetch error)
 * @param {boolean} opts.explicitSignedOut True if LS explicitly reported signed-out state
 * @param {number} opts.nowSec Current Unix epoch seconds
 * @param {number} opts.processStartedAtSec Sidecar boot Unix epoch seconds
 * @param {{logoutAtSec: number, loginAtSec: number}} opts.authBoundaries Optional LS log boundaries
 * @param {Array<{convId: string, mtimeMs: number, getGens: () => Array<{genIdx: number, createdAt: number, completedAt: number}>}>} opts.convEntries
 * @returns {{ dirty: boolean, accountChanged: boolean, activeAccount: object|null }}
 */
export function syncLedgerState(ledger, {
  rawStatus,
  explicitSignedOut = false,
  nowSec = Date.now() / 1000,
  processStartedAtSec = nowSec,
  authBoundaries = { logoutAtSec: 0, loginAtSec: 0 },
  convEntries = [],
}) {
  let dirty = false;
  let accountChanged = false;

  const observed = deriveAccountIdentity(rawStatus, ledger.accounts);

  if (explicitSignedOut || (rawStatus !== undefined && !observed)) {
    if (ledger.activeSession) {
      const logoutAt = (authBoundaries.logoutAtSec > (ledger.activeSession.loginAtSec || 0) && authBoundaries.logoutAtSec <= nowSec + 5)
        ? authBoundaries.logoutAtSec
        : (ledger.activeSession.lastConfirmedAtSec || nowSec);
      ledger.prevSession = {
        ...ledger.activeSession,
        signedOutAtSec: logoutAt,
      };
      ledger.activeSession = null;
      dirty = true;
      accountChanged = true;
    }
  } else if (observed) {
    const prevAcctMeta = ledger.accounts[observed.accountKey];
    if (
      !prevAcctMeta ||
      prevAcctMeta.planName !== observed.planName ||
      prevAcctMeta.tierId !== observed.tierId ||
      prevAcctMeta.accountLabel !== observed.accountLabel
    ) {
      ledger.accounts[observed.accountKey] = {
        ...observed,
        firstSeenSec: prevAcctMeta?.firstSeenSec || nowSec,
        lastSeenSec: nowSec,
      };
      dirty = true;
    } else if (nowSec - (prevAcctMeta.lastSeenSec || 0) > 60) {
      prevAcctMeta.lastSeenSec = nowSec;
      dirty = true;
    }

    if (!ledger.activeSession && !ledger.prevSession) {
      // Very first initialization of the ledger
      ledger.activeSession = {
        accountKey: observed.accountKey,
        loginAtSec: ledger.trackingStartedAtSec,
        lastConfirmedAtSec: nowSec,
      };
      dirty = true;
      accountChanged = true;
    } else if (ledger.activeSession && ledger.activeSession.accountKey === observed.accountKey) {
      // Same account active; check if a sign-out -> re-login cycle occurred between polls
      const prevConfirmed = ledger.activeSession.lastConfirmedAtSec || 0;
      if (authBoundaries.logoutAtSec > prevConfirmed + 1 && authBoundaries.loginAtSec >= authBoundaries.logoutAtSec && authBoundaries.loginAtSec <= nowSec + 5) {
        ledger.prevSession = {
          accountKey: observed.accountKey,
          loginAtSec: ledger.activeSession.loginAtSec,
          lastConfirmedAtSec: authBoundaries.logoutAtSec,
          signedOutAtSec: authBoundaries.logoutAtSec,
        };
        ledger.activeSession.loginAtSec = authBoundaries.loginAtSec;
      }
      if (nowSec - prevConfirmed >= 15) {
        ledger.activeSession.lastConfirmedAtSec = nowSec;
        dirty = true;
      }
    } else {
      // Account switched (A -> B, or returning from signed-out prevSession to B)
      const prev = ledger.activeSession || ledger.prevSession;
      const prevKey = prev?.accountKey || '';
      const isDifferentAccount = prevKey !== observed.accountKey;

      let loginAtSec = nowSec;
      if (
        authBoundaries.loginAtSec > 0 &&
        authBoundaries.loginAtSec >= (prev?.lastConfirmedAtSec || 0) - 30 &&
        authBoundaries.loginAtSec <= nowSec + 5
      ) {
        loginAtSec = authBoundaries.loginAtSec;
      } else if (prev?.signedOutAtSec) {
        loginAtSec = Math.max(prev.signedOutAtSec, processStartedAtSec - 2);
      } else if (prev) {
        // Caught in-process between polls or across IDE restart
        loginAtSec = Math.max(prev.lastConfirmedAtSec || 0, processStartedAtSec - 2);
      }

      if (prev) {
        const logoutAtSec = prev.signedOutAtSec ||
          (authBoundaries.logoutAtSec > (prev.loginAtSec || 0) && authBoundaries.logoutAtSec <= loginAtSec
            ? authBoundaries.logoutAtSec
            : Math.min(loginAtSec, prev.lastConfirmedAtSec || loginAtSec));

        ledger.prevSession = {
          accountKey: prev.accountKey,
          loginAtSec: prev.loginAtSec,
          lastConfirmedAtSec: prev.lastConfirmedAtSec,
          signedOutAtSec: logoutAtSec,
        };
      }

      ledger.activeSession = {
        accountKey: observed.accountKey,
        loginAtSec,
        lastConfirmedAtSec: nowSec,
      };
      dirty = true;
      if (isDifferentAccount || !prevKey) accountChanged = true;
    }
  }

  // Incrementally scan modified conversations and attribute newly observed generations
  for (const item of convEntries) {
    let convEntry = ledger.conversations[item.convId];
    if (convEntry && item.mtimeMs > 0 && item.mtimeMs <= convEntry.mtimeMs) {
      continue;
    }

    const gens = item.getGens();
    if (!convEntry) {
      convEntry = { mtimeMs: 0, nextGenIdx: 0, ranges: [] };
      ledger.conversations[item.convId] = convEntry;
    }

    let stalledOnIncompleteTs = false;
    for (let i = 0; i < gens.length; i++) {
      const g = gens[i];
      if (g.genIdx < convEntry.nextGenIdx) continue;
      if (!(g.createdAt > 0)) {
        const tok = (g.inputTokens || 0) + (g.cacheReadTokens || 0) + (g.outputTokens || 0);
        const isTail = i === gens.length - 1;
        const isFreshFile = item.mtimeMs > 0 && nowSec - item.mtimeMs / 1000 < 30;
        if (isTail && tok > 0 && isFreshFile) {
          stalledOnIncompleteTs = true;
          break;
        }
        // Permanently unlinked / empty placeholder gen_metadata (stepIdxs=[]) — record null and advance
        appendGenAttribution(convEntry, g.genIdx, null);
        dirty = true;
        continue;
      }
      const refTs = g.completedAt > 0 ? g.completedAt : g.createdAt;
      let assignKey = null;

      if (refTs >= ledger.trackingStartedAtSec) {
        if (ledger.activeSession && g.createdAt >= ledger.activeSession.loginAtSec - 1) {
          assignKey = ledger.activeSession.accountKey;
        } else if (
          ledger.prevSession &&
          g.createdAt >= ledger.prevSession.loginAtSec - 1 &&
          refTs <= (ledger.prevSession.signedOutAtSec ?? ledger.prevSession.lastConfirmedAtSec) + 1
        ) {
          assignKey = ledger.prevSession.accountKey;
        }
      }

      appendGenAttribution(convEntry, g.genIdx, assignKey);
      dirty = true;
    }

    if (!stalledOnIncompleteTs && item.mtimeMs > convEntry.mtimeMs) {
      convEntry.mtimeMs = item.mtimeMs;
      dirty = true;
    }
  }

  const activeAccount = ledger.activeSession
    ? (ledger.accounts[ledger.activeSession.accountKey] || observed || null)
    : null;

  return { dirty, accountChanged, activeAccount };
}

/**
 * Ensures pre-v1.3 quota history records without an `accountKey` are quarantined as `'legacy'`
 * so another account's historical estimates are never matched as per-account fallback,
 * and keeps stored account labels/plans aligned with the latest account registry.
 */
export function normalizeQuotaHistoryEntries(entries, accountsRegistry = {}) {
  if (!Array.isArray(entries)) return { entries: [], mutated: false };
  let mutated = false;
  const out = entries.map((h) => {
    if (!h || typeof h !== 'object') return h;
    if (!h.accountKey) {
      mutated = true;
      return { ...h, accountKey: 'legacy', accountLabel: '' };
    }
    const acctMeta = accountsRegistry?.[h.accountKey];
    if (
      acctMeta &&
      ((acctMeta.accountLabel && h.accountLabel !== acctMeta.accountLabel) ||
        (acctMeta.planName && h.planName !== acctMeta.planName))
    ) {
      mutated = true;
      return {
        ...h,
        accountLabel: acctMeta.accountLabel || h.accountLabel,
        planName: acctMeta.planName || h.planName,
      };
    }
    return h;
  });
  return { entries: out, mutated };
}

/**
 * Computes full-window valuation and partial-window baseline delta extrapolation cleanly.
 */
export function evaluateBucketValuation({
  ledger,
  account,
  poolKey,
  win,
  rb,
  winStartSec,
  winUsage,
  nowSec,
}) {
  const usedFraction = Math.max(0, 1 - rb.remainingFraction);
  const minThreshold = win === 'weekly' ? 0.005 : 0.01;
  const isPartialWindow = Boolean(account?.accountKey && winStartSec < ledger.trackingStartedAtSec);

  let effectiveUsedForCalc = usedFraction;
  let spendEffForCalc = winUsage.spendEffective;
  let spendStdForCalc = winUsage.spendStandard;
  let baselineUsedFraction = null;
  let deltaUsedFraction = null;

  if (isPartialWindow && rb.resetTime && account?.accountKey) {
    const bKey = `${account.accountKey}|${poolKey}|${win}|${rb.resetTime}`;
    let baseline = ledger.windowBaselines[bKey];
    let baselineMutated = false;

    if (!baseline) {
      baseline = {
        usedFraction,
        trackedSpendEffective: winUsage.spendEffective,
        trackedSpendStandard: winUsage.spendStandard,
        capturedAtSec: nowSec,
      };
      ledger.windowBaselines[bKey] = baseline;
      baselineMutated = true;
    } else if (usedFraction + 1e-6 < baseline.usedFraction) {
      // Server reset or fraction decreased relative to stale baseline; re-anchor cleanly
      baseline = {
        usedFraction,
        trackedSpendEffective: winUsage.spendEffective,
        trackedSpendStandard: winUsage.spendStandard,
        capturedAtSec: nowSec,
      };
      ledger.windowBaselines[bKey] = baseline;
      baselineMutated = true;
    }

    deltaUsedFraction = Math.max(0, usedFraction - baseline.usedFraction);
    baselineUsedFraction = baseline.usedFraction;
    effectiveUsedForCalc = deltaUsedFraction;
    spendEffForCalc = Math.max(0, winUsage.spendEffective - baseline.trackedSpendEffective);
    spendStdForCalc = Math.max(0, winUsage.spendStandard - baseline.trackedSpendStandard);

    // Prune stale baselines older than 14 days
    for (const k of Object.keys(ledger.windowBaselines)) {
      if (nowSec - (ledger.windowBaselines[k]?.capturedAtSec || 0) > 14 * 86400) {
        delete ledger.windowBaselines[k];
        baselineMutated = true;
      }
    }

    const sampleReady = effectiveUsedForCalc >= minThreshold && spendEffForCalc > 0;
    return {
      usedFraction,
      isPartialWindow: true,
      baselineUsedFraction,
      deltaUsedFraction,
      sampleReady,
      fullValueEffective: sampleReady ? spendEffForCalc / effectiveUsedForCalc : null,
      fullValueStandard: sampleReady ? spendStdForCalc / effectiveUsedForCalc : null,
      spendEffectiveForHistory: sampleReady ? spendEffForCalc : winUsage.spendEffective,
      spendStandardForHistory: sampleReady ? spendStdForCalc : winUsage.spendStandard,
      baselineMutated,
    };
  }

  const sampleReady = usedFraction >= minThreshold && winUsage.spendEffective > 0;
  return {
    usedFraction,
    isPartialWindow: false,
    baselineUsedFraction: null,
    deltaUsedFraction: null,
    sampleReady,
    fullValueEffective: sampleReady ? winUsage.spendEffective / usedFraction : null,
    fullValueStandard: sampleReady ? winUsage.spendStandard / usedFraction : null,
    spendEffectiveForHistory: winUsage.spendEffective,
    spendStandardForHistory: winUsage.spendStandard,
    baselineMutated: false,
  };
}
