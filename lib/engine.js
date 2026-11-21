'use strict';

/**
 * 渡口排班引擎（纯函数，无 I/O）。
 *
 * 输入刻意分为两份，任何路径都不合并：
 *   arrivals —— 乘客到达日志：[{ id, minute, source }]
 *   limits   —— 每班可登船限额：[{ index, minute, boat, limit }]
 *
 * 统计口径：
 *   demandTotal = 统计时段内到达人数（需求分母）。只由到达日志与统计终点决定，
 *                 改发船间隔 / 调度方式都不会改变它。
 *   avgWait     = 全部到达者的等待之和 / demandTotal。
 *                 未上船者按“到达至统计终点”计（截尾等待），便于跨方案比较。
 */

const BOATS = Object.freeze(['甲', '乙']);
const MAX_HORIZON = 240;
const MAX_SURGE = 200;
const MAX_CAPACITY = 60;

class ValidationError extends Error {
  constructor(message, field = null, code = 'INVALID_CONFIG') {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.field = field;
    this.status = 400;
  }
}

const DEFAULT_TRIAL = Object.freeze({
  mode: 'timed',
  intervalMinutes: 10,
  capacity: 10,
  fillThreshold: 10,
  maxWaitMinutes: 25,
  roundTripMinutes: 20,
  horizonMinutes: 90,
  lastDepartureMinutes: 70,
  closure: Object.freeze({ enabled: true, boat: '乙', fromMinute: 20, toMinute: 50 }),
  surge: Object.freeze({ enabled: true, atMinute: 25, count: 12 }),
});

function cloneDefaultTrial() {
  return {
    mode: DEFAULT_TRIAL.mode,
    intervalMinutes: DEFAULT_TRIAL.intervalMinutes,
    capacity: DEFAULT_TRIAL.capacity,
    fillThreshold: DEFAULT_TRIAL.fillThreshold,
    maxWaitMinutes: DEFAULT_TRIAL.maxWaitMinutes,
    roundTripMinutes: DEFAULT_TRIAL.roundTripMinutes,
    horizonMinutes: DEFAULT_TRIAL.horizonMinutes,
    lastDepartureMinutes: DEFAULT_TRIAL.lastDepartureMinutes,
    closure: { ...DEFAULT_TRIAL.closure },
    surge: { ...DEFAULT_TRIAL.surge },
  };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function asObject(value, field, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${where}：${field} 必须是对象`, field);
  }
  return value;
}

function intField(value, field, { min, max, where = '试算参数' }) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ValidationError(`${where}：${field} 必须是整数`, field);
  }
  if (min !== undefined && value < min) {
    throw new ValidationError(`${where}：${field} 不能小于 ${min}`, field);
  }
  if (max !== undefined && value > max) {
    throw new ValidationError(`${where}：${field} 不能大于 ${max}`, field);
  }
  return value;
}

function boolField(value, field, where) {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${where}：${field} 必须是布尔值`, field);
  }
  return value;
}

/** 校验并补全试算参数；缺省字段用 DEFAULT_TRIAL 补齐。 */
function normalizeTrialConfig(raw) {
  let input = raw;
  if (input === undefined || input === null) input = {};
  asObject(input, 'config', '试算参数');

  const cfg = cloneDefaultTrial();
  const where = '试算参数';

  if (input.mode !== undefined) {
    if (input.mode !== 'timed' && input.mode !== 'fill') {
      throw new ValidationError('mode 只能是 timed（定点发船）或 fill（等满发船）', 'mode');
    }
    cfg.mode = input.mode;
  }

  const scalar = {
    horizonMinutes: [1, MAX_HORIZON],
    intervalMinutes: [1, MAX_HORIZON],
    capacity: [1, MAX_CAPACITY],
    fillThreshold: [1, MAX_CAPACITY],
    maxWaitMinutes: [1, MAX_HORIZON],
    roundTripMinutes: [1, MAX_HORIZON],
    lastDepartureMinutes: [0, MAX_HORIZON],
  };
  for (const [key, [min, max]] of Object.entries(scalar)) {
    if (input[key] !== undefined) {
      cfg[key] = intField(input[key], key, { min, max, where });
    }
  }

  intField(cfg.horizonMinutes, 'horizonMinutes', { min: 1, max: MAX_HORIZON, where });
  intField(cfg.lastDepartureMinutes, 'lastDepartureMinutes', {
    min: 0, max: cfg.horizonMinutes, where: '试算参数（末班不能晚于统计终点）',
  });
  if (cfg.fillThreshold > cfg.capacity) {
    throw new ValidationError('fillThreshold 不能大于 capacity', 'fillThreshold');
  }

  if (input.closure !== undefined) {
    asObject(input.closure, 'closure', where);
    if (input.closure.enabled !== undefined) {
      cfg.closure.enabled = boolField(input.closure.enabled, 'closure.enabled', where);
    }
    if (input.closure.boat !== undefined) {
      if (!BOATS.includes(input.closure.boat)) {
        throw new ValidationError('closure.boat 只能是甲或乙', 'closure.boat');
      }
      cfg.closure.boat = input.closure.boat;
    }
    if (input.closure.fromMinute !== undefined) {
      cfg.closure.fromMinute = intField(input.closure.fromMinute, 'closure.fromMinute', {
        min: 0, max: cfg.horizonMinutes, where,
      });
    }
    if (input.closure.toMinute !== undefined) {
      cfg.closure.toMinute = intField(input.closure.toMinute, 'closure.toMinute', {
        min: 0, max: cfg.horizonMinutes, where,
      });
    }
    if (cfg.closure.enabled && cfg.closure.fromMinute >= cfg.closure.toMinute) {
      throw new ValidationError('停航开始时间必须早于结束时间', 'closure.toMinute');
    }
  }

  if (input.surge !== undefined) {
    asObject(input.surge, 'surge', where);
    if (input.surge.enabled !== undefined) {
      cfg.surge.enabled = boolField(input.surge.enabled, 'surge.enabled', where);
    }
    if (input.surge.atMinute !== undefined) {
      cfg.surge.atMinute = intField(input.surge.atMinute, 'surge.atMinute', {
        min: 0, max: cfg.horizonMinutes, where,
      });
    }
    if (input.surge.count !== undefined) {
      cfg.surge.count = intField(input.surge.count, 'surge.count', { min: 0, max: MAX_SURGE, where });
    }
  }

  return cfg;
}

function scenarioId(cfg) {
  if (!cfg.closure.enabled && !cfg.surge.enabled) return 'baseline';
  if (cfg.closure.enabled && cfg.surge.enabled) return 'closure-surge';
  if (cfg.closure.enabled) return 'closure';
  return 'surge';
}

function scenarioLabel(cfg) {
  const parts = [];
  if (cfg.closure.enabled) {
    parts.push(`${cfg.closure.boat}船停运 ${cfg.closure.fromMinute}–${cfg.closure.toMinute} 分`);
  }
  if (cfg.surge.enabled) {
    parts.push(`${cfg.surge.atMinute} 分集中到达 ${cfg.surge.count} 人`);
  }
  return parts.length ? parts.join('，') : '无停航、无集中到达';
}

function formatOffsetMinute(minute) {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(8 + h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function buildInputArrivals(dataset, horizonMinutes) {
  return dataset.arrivals
    .filter((row) => row.offsetMinute <= horizonMinutes)
    .map((row) => ({ id: `P${row.seq + 1}`, minute: row.offsetMinute, source: 'base', seq: row.seq }));
}

function buildSurgeArrivals(cfg) {
  if (!cfg.surge.enabled || cfg.surge.count <= 0) return [];
  const rows = [];
  for (let i = 0; i < cfg.surge.count; i += 1) {
    rows.push({
      id: `S${i + 1}`,
      minute: cfg.surge.atMinute,
      source: 'surge',
      seq: null,
    });
  }
  return rows;
}

function demandFingerprint(arrivals) {
  const minutes = arrivals.map((row) => row.minute).sort((a, b) => a - b);
  let hash = 2166136261; // FNV-1a：仅用于区分需求口径，不用于安全校验
  for (const minute of minutes) {
    hash ^= minute + 1;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const first = minutes.length ? minutes[0] : null;
  const last = minutes.length ? minutes[minutes.length - 1] : null;
  return `${minutes.length}|${first ?? '-'}|${last ?? '-'}|${hash.toString(36)}`;
}

function buildTrialSchedule(cfg) {
  if (cfg.mode !== 'timed') return [];
  const schedule = [];
  for (let minute = 0; minute <= cfg.lastDepartureMinutes; minute += cfg.intervalMinutes) {
    schedule.push({ minute, limit: cfg.capacity });
  }
  return schedule;
}

const WAIT_BUCKETS = Object.freeze([
  { from: 0, to: 5, label: '0–5 分' },
  { from: 5, to: 10, label: '5–10 分' },
  { from: 10, to: 15, label: '10–15 分' },
  { from: 15, to: 20, label: '15–20 分' },
  { from: 20, to: 30, label: '20–30 分' },
  { from: 30, to: 45, label: '30–45 分' },
  { from: 45, to: Infinity, label: '45 分以上' },
]);

function bucketIndex(wait) {
  for (let i = 0; i < WAIT_BUCKETS.length; i += 1) {
    if (wait >= WAIT_BUCKETS[i].from && wait < WAIT_BUCKETS[i].to) return i;
  }
  return WAIT_BUCKETS.length - 1;
}

/**
 * 逐分钟仿真。
 * strategy:
 *   'original' —— 严格按给定班次与每班限额上客（原发班回放），不受停航影响
 *   'timed'    —— 按固定间隔到点发船（有客才发）
 *   'fill'     —— 排队达到开船人数或最久等待到点，有船才发
 */
function simulate({ arrivals, schedule, strategy, cfg, closureBoats = true }) {
  const boats = strategy === 'original'
    ? null
    : BOATS.map((id, index) => ({ id, index, freeAt: 0 }));

  function boatClosed(id, minute) {
    if (!closureBoats || !cfg.closure.enabled) return false;
    return cfg.closure.boat === id
      && minute >= cfg.closure.fromMinute
      && minute < cfg.closure.toMinute;
  }

  function pickBoat(minute) {
    let best = null;
    for (const boat of boats) {
      if (boat.freeAt > minute || boatClosed(boat.id, minute)) continue;
      if (!best || boat.freeAt < best.freeAt
        || (boat.freeAt === best.freeAt && boat.index < best.index)) {
        best = boat;
      }
    }
    return best;
  }

  const sortedArrivals = [...arrivals].sort((a, b) => {
    if (a.minute !== b.minute) return a.minute - b.minute;
    const aSeq = a.seq ?? Number.MAX_SAFE_INTEGER;
    const bSeq = b.seq ?? Number.MAX_SAFE_INTEGER;
    if (aSeq !== bSeq) return aSeq - bSeq;
    return a.id.localeCompare(b.id);
  });
  const byMinute = new Map();
  for (const slot of schedule) {
    if (!byMinute.has(slot.minute)) byMinute.set(slot.minute, []);
    byMinute.get(slot.minute).push(slot);
  }

  const queue = [];
  const departures = [];
  const events = [];
  const waitedMinutes = [];
  const queueTrace = [];
  let nextArrival = 0;
  let boardedTotal = 0;
  let seatsOffered = 0;
  let emptySeats = 0;
  let idleTicks = 0;
  let missedDepartures = 0;
  let forcedDepartures = 0;
  let totalWait = 0;
  let boardedWaitSum = 0;
  let maxWait = 0;
  let peakQueue = 0;

  function takeFromQueue(minute, limit, boatId, extra) {
    const queueBefore = queue.length;
    const boardCount = Math.min(limit, queueBefore);
    const boarded = queue.splice(0, boardCount);
    let departureWaitSum = 0;
    let departureMaxWait = 0;
    for (const p of boarded) {
      const w = minute - p.minute;
      waitedMinutes.push(w);
      totalWait += w;
      boardedWaitSum += w;
      departureWaitSum += w;
      if (w > maxWait) maxWait = w;
      if (w > departureMaxWait) departureMaxWait = w;
    }
    boardedTotal += boardCount;
    seatsOffered += limit;
    emptySeats += limit - boardCount;

    let status = '满员';
    if (boardCount === 0) status = '空船';
    else if (boardCount < limit) status = extra?.forced ? '未满（等待到点）' : '未满';

    const record = {
      index: departures.length + 1,
      minute,
      clock: formatOffsetMinute(minute),
      boat: boatId,
      limit,
      queueBefore,
      boarded: boardCount,
      boardedIds: boarded.map((p) => p.id),
      emptySeats: limit - boardCount,
      queueAfter: queue.length,
      status,
      forced: Boolean(extra?.forced),
      avgWaitMinutes: boardCount > 0 ? round2(departureWaitSum / boardCount) : null,
      maxWaitMinutes: boardCount > 0 ? departureMaxWait : null,
    };
    departures.push(record);
    return record;
  }

  function dispatchScheduled(minute, slot) {
    if (strategy === 'original') {
      takeFromQueue(minute, slot.limit, slot.boat, {});
      return;
    }
    if (queue.length === 0) {
      idleTicks += 1;
      return;
    }
    const boat = pickBoat(minute);
    if (!boat) {
      missedDepartures += 1;
      events.push({
        minute,
        clock: formatOffsetMinute(minute),
        type: 'missed',
        text: `定点班次因无可用渡船取消（排队 ${queue.length} 人）`,
      });
      return;
    }
    boat.freeAt = minute + cfg.roundTripMinutes;
    takeFromQueue(minute, cfg.capacity, boat.id, {});
  }

  for (let minute = 0; minute <= cfg.horizonMinutes; minute += 1) {
    while (nextArrival < sortedArrivals.length && sortedArrivals[nextArrival].minute <= minute) {
      queue.push(sortedArrivals[nextArrival]);
      nextArrival += 1;
    }
    queueTrace.push(queue.length);
    if (queue.length > peakQueue) peakQueue = queue.length;

    if (strategy === 'fill') {
      if (minute > cfg.lastDepartureMinutes || queue.length === 0) continue;
      const oldestWait = minute - queue[0].minute;
      const full = queue.length >= cfg.fillThreshold;
      if (!full && oldestWait < cfg.maxWaitMinutes) continue;
      const boat = pickBoat(minute);
      if (!boat) continue;
      boat.freeAt = minute + cfg.roundTripMinutes;
      if (!full) forcedDepartures += 1;
      const record = takeFromQueue(minute, cfg.capacity, boat.id, { forced: !full });
      if (!full) {
        events.push({
          minute,
          clock: record.clock,
          type: 'forced',
          text: `${boat.id}船排队 ${record.queueBefore} 人，最久等待 ${oldestWait} 分，提前开船（空 ${record.emptySeats} 座）`,
        });
      }
      continue;
    }

    const slots = byMinute.get(minute);
    if (!slots) continue;
    for (const slot of slots) dispatchScheduled(minute, slot);
  }

  const unboarded = queue.map((p) => {
    const wait = Math.max(0, cfg.horizonMinutes - p.minute);
    totalWait += wait;
    if (wait > maxWait) maxWait = wait;
    return { id: p.id, arrivedMinute: p.minute, censoredWait: wait };
  });
  const censoredWait = unboarded.reduce((sum, p) => sum + p.censoredWait, 0);

  // queueTrace 记录每分钟“到达后、发船前”的排队人数；peakQueue 取其中的峰值
  return {
    departures,
    events,
    waitedMinutes,
    queueTrace,
    peakQueue,
    queueAtEnd: unboarded,
    counters: {
      boardedTotal,
      seatsOffered,
      emptySeats,
      idleTicks,
      missedDepartures,
      forcedDepartures,
    },
    wait: {
      totalWait,
      boardedWaitSum,
      censoredWait,
      maxWait,
      demandTotal: sortedArrivals.length,
    },
  };
}

function buildHistogram(waits) {
  const buckets = WAIT_BUCKETS.map((b) => ({ ...b, to: b.to === Infinity ? null : b.to, count: 0 }));
  for (const wait of waits) buckets[bucketIndex(wait)].count += 1;
  return buckets;
}

function finalizeResult({
  kind, title, scenario, scenarioLabel: label, cfg, arrivals, schedule,
  demandFingerprint: fingerprint, raw, extraParams,
}) {
  const { counters, wait } = raw;
  const demandTotal = wait.demandTotal;
  const allWaits = [...raw.waitedMinutes, ...raw.queueAtEnd.map((p) => p.censoredWait)];
  const boardedTotal = counters.boardedTotal;

  const stats = {
    demandTotal,
    boarded: boardedTotal,
    unboarded: raw.queueAtEnd.length,
    boardedRate: demandTotal > 0 ? round2((boardedTotal / demandTotal) * 100) : 0,
    avgWaitMinutes: demandTotal > 0 ? round2(wait.totalWait / demandTotal) : 0,
    avgWaitBoardedMinutes: boardedTotal > 0 ? round2(wait.boardedWaitSum / boardedTotal) : 0,
    maxWaitMinutes: round2(wait.maxWait),
    emptySeats: counters.emptySeats,
    seatsOffered: counters.seatsOffered,
    departureCount: raw.departures.length,
    loadFactor: counters.seatsOffered > 0 ? round2((boardedTotal / counters.seatsOffered) * 100) : 0,
    totalWaitMinutes: round2(wait.totalWait),
    censoredWaitMinutes: round2(wait.censoredWait),
    idleTicks: counters.idleTicks,
    missedDepartures: counters.missedDepartures,
    forcedDepartures: counters.forcedDepartures,
    peakQueue: raw.peakQueue,
    seatsPerDeparture: raw.departures.length > 0
      ? round2(counters.seatsOffered / raw.departures.length)
      : 0,
  };

  return {
    meta: {
      kind,
      title,
      scenario,
      scenarioLabel: label,
      generatedAt: new Date().toISOString(),
    },
    params: cfg,
    inputs: {
      arrivals: arrivals.map((row) => ({
        id: row.id,
        minute: row.minute,
        source: row.source,
        seq: row.seq,
      })),
      arrivalCount: arrivals.length,
      baseArrivalCount: arrivals.filter((row) => row.source === 'base').length,
      surgeArrivalCount: arrivals.filter((row) => row.source === 'surge').length,
      limits: kind === 'original' ? schedule : null,
      ...extraParams,
    },
    denominator: {
      demandTotal,
      fingerprint,
      note: '需求分母只由到达日志与统计终点决定；改发船间隔不会改变它。',
    },
    schedule: {
      mode: cfg ? cfg.mode : 'original',
      capacity: cfg ? cfg.capacity : null,
      intervalMinutes: cfg && cfg.mode === 'timed' ? cfg.intervalMinutes : null,
      planned: schedule.map((slot) => ({
        minute: slot.minute,
        clock: formatOffsetMinute(slot.minute),
        limit: slot.limit,
      })),
    },
    departures: raw.departures,
    events: raw.events,
    queueAtEnd: raw.queueAtEnd,
    queueTrace: raw.queueTrace,
    waitHistogram: buildHistogram(allWaits),
    stats,
  };
}

/** 原发班方案回放：班次与每班限额都来自独立输入，不做任何调度试算。 */
function replayOriginal(dataset) {
  const horizonMinutes = dataset.originalHorizonMinutes || 90;
  const arrivals = buildInputArrivals(dataset, horizonMinutes);
  const limits = dataset.limits.map((row) => ({
    index: row.index,
    minute: row.departMinute,
    boat: row.boat,
    limit: row.limit,
  }));
  const cfg = {
    mode: 'original',
    horizonMinutes,
    closure: { enabled: false },
    surge: { enabled: false },
  };
  const raw = simulate({
    arrivals,
    schedule: limits,
    strategy: 'original',
    cfg,
    closureBoats: false,
  });
  return finalizeResult({
    kind: 'original',
    title: '原发班方案回放',
    scenario: 'original',
    scenarioLabel: '原始到达日志 + 原始每班限额',
    cfg: null,
    arrivals,
    schedule: limits,
    demandFingerprint: demandFingerprint(arrivals),
    raw,
    extraParams: {
      horizonMinutes,
      originalLimits: limits,
    },
  });
}

/** 停航 / 集中到达 + 调度规则试算。 */
function runTrial(dataset, rawConfig) {
  const cfg = normalizeTrialConfig(rawConfig);
  const baseArrivals = buildInputArrivals(dataset, cfg.horizonMinutes);
  const surgeArrivals = buildSurgeArrivals(cfg);
  const arrivals = [...baseArrivals, ...surgeArrivals];
  const schedule = buildTrialSchedule(cfg);
  const raw = simulate({
    arrivals,
    schedule,
    strategy: cfg.mode,
    cfg,
    closureBoats: true,
  });
  return finalizeResult({
    kind: 'trial',
    title: cfg.mode === 'fill' ? '等满发船试算' : '定点发船试算',
    scenario: scenarioId(cfg),
    scenarioLabel: scenarioLabel(cfg),
    cfg,
    arrivals,
    schedule,
    demandFingerprint: demandFingerprint(arrivals),
    raw,
    extraParams: {
      horizonMinutes: cfg.horizonMinutes,
      baseArrivalCount: baseArrivals.length,
      surgeArrivalCount: surgeArrivals.length,
      excludedArrivals: dataset.arrivals.length - baseArrivals.length,
      // 试算结果也附带原输入版的每班限额，便于“退回原输入版”时不丢上下文
      originalLimits: dataset.limits.map((row) => ({
        index: row.index,
        minute: row.departMinute,
        boat: row.boat,
        limit: row.limit,
      })),
    },
  });
}

function compareResults(original, trial) {
  const rows = [
    ['demandTotal', '需求人数（分母）', 'count'],
    ['boarded', '已上船', 'count'],
    ['unboarded', '未清队列', 'count'],
    ['avgWaitMinutes', '平均等待（分）', 'minutes'],
    ['maxWaitMinutes', '最长等待（分）', 'minutes'],
    ['emptySeats', '空座', 'count'],
    ['departureCount', '发船班次', 'count'],
    ['loadFactor', '载客率（%）', 'percent'],
  ].map(([key, label, format]) => ({
    key,
    label,
    format,
    original: original.stats[key],
    trial: trial.stats[key],
    delta: round2(trial.stats[key] - original.stats[key]),
  }));

  return {
    sameDemand: original.denominator.fingerprint === trial.denominator.fingerprint,
    originalDemand: original.stats.demandTotal,
    trialDemand: trial.stats.demandTotal,
    rows,
  };
}

/**
 * 同一停航 + 集中到达情景下，比较定点发船与等满发船的取舍。
 * 关键是看未清队列、平均等待与空座。
 */
function compareStrategies(dataset, rawConfig) {
  const cfg = normalizeTrialConfig(rawConfig);
  const timed = runTrial(dataset, { ...cfg, mode: 'timed' });
  const fill = runTrial(dataset, { ...cfg, mode: 'fill' });
  const metrics = [
    ['unboarded', '未清队列', 'count', 'lower'],
    ['avgWaitMinutes', '平均等待（分）', 'minutes', 'lower'],
    ['maxWaitMinutes', '最长等待（分）', 'minutes', 'lower'],
    ['emptySeats', '空座', 'count', 'lower'],
    ['departureCount', '发船班次', 'count', 'none'],
    ['boarded', '已上船', 'count', 'higher'],
  ].map(([key, label, format]) => {
    const t = timed.stats[key];
    const f = fill.stats[key];
    return { key, label, format, timed: t, fill: f, delta: round2(f - t) };
  });
  return {
    scenario: scenarioId(cfg),
    scenarioLabel: scenarioLabel(cfg),
    demandTotal: timed.stats.demandTotal,
    demandFingerprint: timed.denominator.fingerprint,
    sameDemand: timed.denominator.fingerprint === fill.denominator.fingerprint,
    timed,
    fill,
    metrics,
  };
}

module.exports = {
  BOATS,
  DEFAULT_TRIAL,
  WAIT_BUCKETS,
  ValidationError,
  normalizeTrialConfig,
  scenarioId,
  scenarioLabel,
  formatOffsetMinute,
  replayOriginal,
  runTrial,
  compareResults,
  compareStrategies,
  demandFingerprint,
};
