'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDataset } = require('../data/dataset');
const {
  ValidationError,
  normalizeTrialConfig,
  replayOriginal,
  runTrial,
  compareStrategies,
  compareResults,
} = require('../lib/engine');

const dataset = loadDataset();

function totalHistogram(result) {
  return result.waitHistogram.reduce((sum, bucket) => sum + bucket.count, 0);
}

test('到达日志与每班限额是两份独立输入', () => {
  assert.equal(dataset.arrivals.length, 50);
  assert.equal(dataset.limits.length, 8);
  assert.equal(dataset.meta.arrivalCount, 50);
  assert.equal(dataset.meta.departureCount, 8);
  assert.equal(dataset.meta.totalLimit, 52);
  for (const arrival of dataset.arrivals) {
    assert.equal(arrival.source, 'base');
    assert.ok(!('limit' in arrival), '到达记录不应携带班次限额');
    assert.ok(!('departMinute' in arrival), '到达记录不应携带发船时刻');
  }
  for (const limit of dataset.limits) {
    assert.ok(!('arrivalCount' in limit), '限额记录不应携带到达人数');
  }
});

test('回放原发班方案：逐班按原始限额上客，不改动输入', () => {
  const before = JSON.stringify(dataset.arrivals) + JSON.stringify(dataset.limits);
  const result = replayOriginal(dataset);
  assert.equal(JSON.stringify(dataset.arrivals) + JSON.stringify(dataset.limits), before);

  assert.equal(result.meta.kind, 'original');
  assert.deepEqual(result.departures.map((d) => d.clock), [
    '08:00', '08:10', '08:20', '08:30', '08:40', '08:50', '09:00', '09:10',
  ]);
  assert.deepEqual(result.departures.map((d) => d.limit), [5, 5, 6, 6, 7, 7, 8, 8]);
  assert.deepEqual(result.departures.map((d) => d.boarded), [1, 5, 6, 6, 7, 7, 8, 6]);
  assert.equal(result.stats.departureCount, 8);
  assert.equal(result.stats.boarded, 46);
  assert.equal(result.stats.unboarded, 4);
  assert.equal(result.stats.emptySeats, 6);
  assert.equal(result.stats.demandTotal, 50);
  assert.equal(totalHistogram(result), 50);
});

test('原发班回放不产生调度事件，也不受停航参数影响', () => {
  const result = replayOriginal(dataset);
  assert.deepEqual(result.events, []);
  assert.equal(result.stats.missedDepartures, 0);
  assert.equal(result.stats.forcedDepartures, 0);
  assert.equal(result.schedule.mode, 'original');
});

test('改发船间隔只换班次，不换需求分母', () => {
  const ten = runTrial(dataset, { mode: 'timed', intervalMinutes: 10 });
  const fifteen = runTrial(dataset, { mode: 'timed', intervalMinutes: 15 });
  const twenty = runTrial(dataset, { mode: 'timed', intervalMinutes: 20 });

  assert.equal(ten.stats.demandTotal, 62);
  assert.equal(fifteen.stats.demandTotal, 62);
  assert.equal(twenty.stats.demandTotal, 62);
  assert.equal(ten.denominator.fingerprint, fifteen.denominator.fingerprint);
  assert.equal(ten.denominator.fingerprint, twenty.denominator.fingerprint);

  assert.notEqual(ten.stats.departureCount, fifteen.stats.departureCount);
  assert.ok(ten.stats.departureCount > fifteen.stats.departureCount);
  // 分母不变时，间隔越长未清队列越难清空
  assert.ok(fifteen.stats.unboarded >= ten.stats.unboarded);
  assert.deepEqual(ten.inputs.arrivals, fifteen.inputs.arrivals);
});

test('集中到达计入分母，停航不计入分母', () => {
  const baseline = runTrial(dataset, {
    mode: 'timed',
    intervalMinutes: 10,
    closure: { enabled: false },
    surge: { enabled: false },
  });
  const closureOnly = runTrial(dataset, {
    mode: 'timed',
    intervalMinutes: 10,
    closure: { enabled: true, boat: '乙', fromMinute: 20, toMinute: 50 },
    surge: { enabled: false },
  });
  const surgeOnly = runTrial(dataset, {
    mode: 'timed',
    intervalMinutes: 10,
    closure: { enabled: false },
    surge: { enabled: true, atMinute: 25, count: 12 },
  });

  assert.equal(baseline.stats.demandTotal, 50);
  assert.equal(closureOnly.stats.demandTotal, 50);
  assert.equal(surgeOnly.stats.demandTotal, 62);
  assert.equal(closureOnly.denominator.fingerprint, baseline.denominator.fingerprint);
  assert.notEqual(surgeOnly.denominator.fingerprint, baseline.denominator.fingerprint);
  assert.equal(surgeOnly.inputs.surgeArrivalCount, 12);
  assert.equal(baseline.inputs.surgeArrivalCount, 0);
});

test('停航时段内该船不出班，定点班次会因无船而取消', () => {
  const result = runTrial(dataset, {
    mode: 'timed',
    intervalMinutes: 10,
    closure: { enabled: true, boat: '乙', fromMinute: 20, toMinute: 50 },
    surge: { enabled: false },
  });
  assert.ok(result.stats.missedDepartures >= 1);
  assert.ok(result.events.some((e) => e.type === 'missed'));
  assert.ok(result.stats.unboarded > 0);
  for (const dep of result.departures) {
    if (dep.minute >= 20 && dep.minute < 50) {
      assert.notEqual(dep.boat, '乙', `乙船在停航时段 ${dep.clock} 不应出班`);
    }
  }
  assert.equal(totalHistogram(result), result.stats.demandTotal);
});

test('同一停航 + 集中到达情景下，等满发船与定点发船用同一需求分母', () => {
  const comparison = compareStrategies(dataset, {
    mode: 'timed',
    intervalMinutes: 10,
    closure: { enabled: true, boat: '乙', fromMinute: 20, toMinute: 50 },
    surge: { enabled: true, atMinute: 25, count: 12 },
  });
  assert.equal(comparison.sameDemand, true);
  assert.equal(comparison.timed.stats.demandTotal, 62);
  assert.equal(comparison.fill.stats.demandTotal, 62);
  assert.equal(comparison.demandFingerprint, comparison.timed.denominator.fingerprint);

  const unboarded = comparison.metrics.find((m) => m.key === 'unboarded');
  assert.equal(unboarded.timed, comparison.timed.stats.unboarded);
  assert.equal(unboarded.fill, comparison.fill.stats.unboarded);
  assert.equal(unboarded.delta, unboarded.fill - unboarded.timed);

  // 题面取舍：等满发船用“多留一些人排队”换“少空座”，两种代价都要能量出来
  assert.ok(comparison.fill.stats.emptySeats < comparison.timed.stats.emptySeats,
    '等满发船应减少空座');
  assert.ok(comparison.fill.stats.unboarded > comparison.timed.stats.unboarded,
    '等满发船把代价转移到未清队列');
  const empty = comparison.metrics.find((m) => m.key === 'emptySeats');
  assert.equal(empty.timed, comparison.timed.stats.emptySeats);
  assert.equal(empty.fill, comparison.fill.stats.emptySeats);
  assert.equal(empty.delta, comparison.fill.stats.emptySeats - comparison.timed.stats.emptySeats);
  assert.equal(totalHistogram(comparison.timed), 62);
  assert.equal(totalHistogram(comparison.fill), 62);
});

test('空场景（无到达）不会除以零', () => {
  const emptyDataset = {
    ...dataset,
    arrivals: [],
  };
  const result = runTrial(emptyDataset, {
    mode: 'timed',
    intervalMinutes: 10,
    closure: { enabled: false },
    surge: { enabled: false },
  });
  assert.equal(result.stats.demandTotal, 0);
  assert.equal(result.stats.boarded, 0);
  assert.equal(result.stats.avgWaitMinutes, 0);
  assert.equal(result.stats.loadFactor, 0);
  assert.equal(totalHistogram(result), 0);
  assert.deepEqual(result.departures, []);
});

test('等满发船在排队到点或满额时开船，并记录提前开船事件', () => {
  const result = runTrial(dataset, {
    mode: 'fill',
    capacity: 6,
    fillThreshold: 6,
    maxWaitMinutes: 25,
    roundTripMinutes: 20,
    lastDepartureMinutes: 70,
    closure: { enabled: true, boat: '乙', fromMinute: 20, toMinute: 50 },
    surge: { enabled: true, atMinute: 25, count: 12 },
  });
  assert.ok(result.departures.length > 0);
  for (const dep of result.departures) {
    assert.ok(dep.boarded > 0, '等满发船不应发出空船');
    assert.ok(dep.boarded <= 6);
    assert.ok(dep.minute <= 70);
  }
  assert.equal(totalHistogram(result), result.stats.demandTotal);
});

test('对比原发班与试算，明确报告分母是否一致', () => {
  const original = replayOriginal(dataset);
  const sameDemand = runTrial(dataset, {
    mode: 'timed',
    intervalMinutes: 10,
    closure: { enabled: false },
    surge: { enabled: false },
  });
  assert.equal(compareResults(original, sameDemand).sameDemand, true);

  const surge = runTrial(dataset, {
    mode: 'timed',
    intervalMinutes: 10,
    closure: { enabled: false },
    surge: { enabled: true, atMinute: 25, count: 12 },
  });
  const compared = compareResults(original, surge);
  assert.equal(compared.sameDemand, false);
  assert.equal(compared.originalDemand, 50);
  assert.equal(compared.trialDemand, 62);
  const demandRow = compared.rows.find((row) => row.key === 'demandTotal');
  assert.equal(demandRow.delta, 12);
});

test('同样的输入重复运行，结果一致', () => {
  const config = {
    mode: 'timed',
    intervalMinutes: 10,
    closure: { enabled: true, boat: '乙', fromMinute: 20, toMinute: 50 },
    surge: { enabled: true, atMinute: 25, count: 12 },
  };
  const first = runTrial(dataset, config);
  const second = runTrial(dataset, config);
  const strip = (r) => ({ ...r, meta: { ...r.meta, generatedAt: null } });
  assert.deepEqual(strip(first), strip(second));
});

test('试算参数异常输入应当被拒绝', () => {
  const cases = [
    [{ mode: 'metro' }, /mode/],
    [{ mode: 'timed', intervalMinutes: 0 }, /intervalMinutes/],
    [{ mode: 'timed', intervalMinutes: -5 }, /intervalMinutes/],
    [{ mode: 'timed', intervalMinutes: 2.5 }, /intervalMinutes/],
    [{ mode: 'timed', intervalMinutes: '10' }, /intervalMinutes/],
    [{ mode: 'timed', capacity: 0 }, /capacity/],
    [{ mode: 'timed', capacity: 61 }, /capacity/],
    [{ mode: 'timed', fillThreshold: 7, capacity: 6 }, /fillThreshold/],
    [{ mode: 'timed', lastDepartureMinutes: 999 }, /lastDepartureMinutes/],
    [{ mode: 'timed', closure: { enabled: true, fromMinute: 50, toMinute: 20 } }, /停航开始/],
    [{ mode: 'timed', closure: { enabled: true, boat: '丙' } }, /closure\.boat/],
    [{ mode: 'timed', closure: { enabled: 'yes' } }, /closure\.enabled/],
    [{ mode: 'timed', surge: { enabled: true, count: -1 } }, /surge\.count/],
    [{ mode: 'timed', surge: { enabled: true, atMinute: 500 } }, /surge\.atMinute/],
    [[], /必须是对象/],
    ['timed', /必须是对象/],
    [42, /必须是对象/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(
      () => normalizeTrialConfig(input),
      (err) => err instanceof ValidationError && pattern.test(err.message),
      `输入 ${JSON.stringify(input)} 应报错 ${pattern}`,
    );
  }
});

test('缺省试算参数可补全为合法配置', () => {
  const cfg = normalizeTrialConfig(undefined);
  assert.equal(cfg.mode, 'timed');
  assert.equal(cfg.intervalMinutes, 10);
  assert.equal(cfg.closure.enabled, true);
  assert.equal(cfg.surge.enabled, true);
  assert.equal(cfg.horizonMinutes, 90);
  const cfg2 = normalizeTrialConfig({ mode: 'fill' });
  assert.equal(cfg2.mode, 'fill');
  assert.equal(cfg2.capacity, cfg.capacity);
});
