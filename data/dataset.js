'use strict';

/**
 * 本地生成的小规模渡口数据（无外部依赖，结果可复现）。
 *
 * 数据刻意拆成两份独立输入：
 *   arrivals —— 乘客到达日志：每个序号只说明“第几分钟来了一个人”，不含任何班次信息
 *   limits   —— 每班可登船限额：与到达日志无关，供原发班方案回放使用
 *
 * 另有 disruptions —— 停航 / 集中到达情景，只作为“试算参数”，不改动上面两份输入。
 */

const MINUTE = 60 * 1000;
const DAY_START = Date.UTC(2026, 10, 21, 0, 0, 0); // 本地造数据固定“当天”
const ORIGIN_MINUTE = 8 * 60; // 原方案首班 08:00 的内存坐标，仅用于展示

/** 到达日志：offset 为相对原方案首班的分钟数。 */
const ARRIVAL_OFFSETS = [
  0, 1, 1, 2, 2, 2, 3, 4, 5, 5,
  6, 7, 9, 11, 12, 12, 13, 16, 18, 19,
  21, 22, 22, 24, 27, 29, 30, 31, 33, 35,
  38, 39, 41, 44, 47, 48, 49, 52, 55, 57,
  59, 61, 63, 66, 68, 70, 72, 74, 77, 79,
];

/** 每班可登船限额（与到达日志独立）。 */
const DEPARTURE_LIMITS = [
  { departMinute: 0, limit: 5, boat: '甲' },
  { departMinute: 10, limit: 5, boat: '乙' },
  { departMinute: 20, limit: 6, boat: '甲' },
  { departMinute: 30, limit: 6, boat: '乙' },
  { departMinute: 40, limit: 7, boat: '甲' },
  { departMinute: 50, limit: 7, boat: '乙' },
  { departMinute: 60, limit: 8, boat: '甲' },
  { departMinute: 70, limit: 8, boat: '乙' },
];

/** 试算情景种子（只改试算参数，不改到达日志与每班限额）。 */
const DISRUPTIONS = [
  {
    id: 'closure-surge',
    label: '一艘停运 + 一批集中到达',
    closure: { enabled: true, boat: '乙', fromMinute: 20, toMinute: 50 },
    surge: { enabled: true, atMinute: 25, count: 12 },
  },
  {
    id: 'closure',
    label: '仅一艘停运',
    closure: { enabled: true, boat: '乙', fromMinute: 20, toMinute: 50 },
    surge: { enabled: false, atMinute: 25, count: 0 },
  },
  {
    id: 'surge',
    label: '仅一批集中到达',
    closure: { enabled: false, boat: '乙', fromMinute: 20, toMinute: 50 },
    surge: { enabled: true, atMinute: 25, count: 12 },
  },
  {
    id: 'baseline',
    label: '无停航、无集中到达',
    closure: { enabled: false, boat: '乙', fromMinute: 20, toMinute: 50 },
    surge: { enabled: false, atMinute: 25, count: 0 },
  },
];

const ORIGINAL_HORIZON_MINUTES = 90;

function clockLabel(epochMs) {
  const d = new Date(epochMs);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function minuteToEpoch(minute, originMinute = ORIGIN_MINUTE) {
  if (!Number.isFinite(minute)) throw new Error('minuteToEpoch: minute 必须是有限数字');
  return DAY_START + (originMinute + minute) * MINUTE;
}

function buildArrivals() {
  return ARRIVAL_OFFSETS.map((offsetMinute, seq) => ({
    id: `P${seq + 1}`,
    seq,
    offsetMinute,
    epochMs: minuteToEpoch(offsetMinute),
    clock: clockLabel(minuteToEpoch(offsetMinute)),
    source: 'base',
  }));
}

function buildLimits() {
  return DEPARTURE_LIMITS.map((row, index) => ({
    index,
    boat: row.boat,
    departMinute: row.departMinute,
    epochMs: minuteToEpoch(row.departMinute),
    clock: clockLabel(minuteToEpoch(row.departMinute)),
    limit: row.limit,
  }));
}

function loadDataset() {
  const arrivals = buildArrivals();
  const limits = buildLimits();
  return {
    meta: {
      generatedAt: '2026-11-21T08:00:00.000Z',
      source: 'local-seed',
      origin: clockLabel(minuteToEpoch(0)),
      arrivalCount: arrivals.length,
      departureCount: limits.length,
      totalLimit: limits.reduce((sum, row) => sum + row.limit, 0),
      note: '到达日志与每班限额为两份独立输入；情景只改试算参数。',
    },
    dayStart: DAY_START,
    originMinute: ORIGIN_MINUTE,
    originalHorizonMinutes: ORIGINAL_HORIZON_MINUTES,
    arrivals,
    limits,
    disruptions: DISRUPTIONS,
  };
}

module.exports = {
  MINUTE,
  DAY_START,
  ORIGIN_MINUTE,
  ORIGINAL_HORIZON_MINUTES,
  ARRIVAL_OFFSETS,
  DEPARTURE_LIMITS,
  DISRUPTIONS,
  minuteToEpoch,
  clockLabel,
  loadDataset,
};
