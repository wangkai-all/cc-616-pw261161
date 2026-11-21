'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/**
 * 极简 DOM stub：足以执行 app.js 的启动、一遍试算渲染与切换视图。
 * 只实现测试需要的接口，任何未覆盖的调用会直接抛错，避免“静默通过”。
 */
function makeDom() {
  const ids = [...htmlSource.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  function makeNode(id) {
    const node = {
      id,
      dataset: {},
      style: {},
      children: [],
      attributes: {},
      hidden: false,
      textContent: '',
      _html: '',
      classList: { add() {}, remove() {} },
      get innerHTML() { return this._html; },
      set innerHTML(value) { this._html = String(value); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name]; },
      addEventListener(type, fn) { this.listeners = this.listeners || {}; this.listeners[type] = fn; },
      after(node) { this.next = node; },
      appendChild(node) { this.children.push(node); return node; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      remove() {},
      fetch: null,
    };
    return node;
  }
  const nodes = new Map(ids.map((id) => [id, makeNode(id)]));
  // 把 HTML 里的初始 value / checked 搬进 stub
  for (const [id, node] of nodes) {
    const tag = htmlSource.match(new RegExp(`<(input|select)[^>]*id="${id}"[^>]*>`));
    if (!tag) continue;
    const valueMatch = tag[0].match(/value="([^"]*)"/);
    if (valueMatch) node.value = valueMatch[1];
    if (/\schecked(\s|>)/.test(tag[0])) node.checked = true;
  }
  const modeRadios = [...htmlSource.matchAll(/<input[^>]*name="mode"[^>]*value="([^"]+)"[^>]*>/g)]
    .map((m, i) => {
      const radio = makeNode(`mode-${m[1]}`);
      radio.value = m[1];
      radio.checked = i === 0;
      return radio;
    });
  const formNode = nodes.get('trial-form');
  formNode.querySelector = (selector) => {
    if (selector === 'input[name="mode"]:checked') {
      return modeRadios.find((r) => r.checked) || null;
    }
    return null;
  };
  const views = ['view-overview', 'view-waits', 'view-detail'].map((id) => nodes.get(id));
  const tabs = ['overview', 'waits', 'detail'].map((view) => {
    const node = makeNode(`tab-${view}`);
    node.dataset.view = view;
    return node;
  });
  views.forEach((v) => { v.hidden = v.id !== 'view-overview'; });

  const doc = {
    getElementById: (id) => nodes.get(id) || null,
    querySelectorAll(selector) {
      if (selector === '.view') return views;
      if (selector === '.segmented button') return tabs;
      return [];
    },
    createElement: (tag) => makeNode(`created-${tag}`),
  };
  return { doc, nodes, tabs, views };
}

function fakeResult(kind) {
  const histogram = [
    { from: 0, to: 5, label: '0–5 分', count: 3 },
    { from: 5, to: 10, label: '5–10 分', count: 1 },
    { from: 10, to: 15, label: '10–15 分', count: 0 },
    { from: 15, to: 20, label: '15–20 分', count: 0 },
    { from: 20, to: 30, label: '20–30 分', count: 0 },
    { from: 30, to: 45, label: '30–45 分', count: 0 },
    { from: 45, to: Infinity, label: '45 分以上', count: 0 },
  ];
  const departures = [{
    index: 1, minute: 0, clock: '08:00', boat: '甲', limit: 5, queueBefore: 1,
    boarded: 1, boardedIds: ['P1'], emptySeats: 4, queueAfter: 0, status: '未满',
    forced: false, avgWaitMinutes: 0, maxWaitMinutes: 0,
  }];
  return {
    meta: { kind, title: kind === 'original' ? '原发班方案回放' : '定点发船试算', scenario: kind, scenarioLabel: '测试情景', generatedAt: 'x' },
    params: null,
    inputs: {
      arrivals: [], arrivalCount: 4, baseArrivalCount: 4, surgeArrivalCount: 0,
      originalLimits: [{ index: 0, minute: 0, boat: '甲', limit: 5 }], horizonMinutes: 90,
    },
    denominator: { demandTotal: 4, fingerprint: '4|0|9|18', note: '测试' },
    schedule: { mode: kind === 'original' ? 'original' : 'timed', capacity: 5, intervalMinutes: 10, planned: [{ minute: 0, clock: '08:00', limit: 5 }] },
    departures,
    events: [],
    queueAtEnd: [{ id: 'P4', arrivedMinute: 9, censoredWait: 3 }],
    queueTrace: [0, 1, 0],
    waitHistogram: histogram,
    stats: {
      demandTotal: 4, boarded: 1, unboarded: 1, boardedRate: 25, avgWaitMinutes: 1.5,
      avgWaitBoardedMinutes: 0, maxWaitMinutes: 3, emptySeats: 4, seatsOffered: 5,
      departureCount: 1, loadFactor: 20, totalWaitMinutes: 6, censoredWaitMinutes: 3,
      idleTicks: 0, missedDepartures: 0, forcedDepartures: 0, peakQueue: 1,
    },
  };
}

test('前端启动后写入 data-evidence-result 状态，切换视图只动可见性', async () => {
  const { doc, nodes, tabs, views } = makeDom();
  const result = fakeResult('original');
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, method: init.method });
    if (url === '/api/replay') {
      return { ok: true, status: 200, json: async () => ({ ok: true, result, inputSnapshot: {} }) };
    }
    if (url === '/api/trial') {
      const trial = fakeResult('trial');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: trial,
          compareToOriginal: {
            sameDemand: false, originalDemand: 4, trialDemand: 4,
            rows: [{ key: 'demandTotal', label: '需求人数（分母）', format: 'count', original: 4, trial: 4, delta: 0 }],
          },
        }),
      };
    }
    throw new Error(`unexpected ${url}`);
  };

  const context = vm.createContext({
    document: doc,
    fetch: fetchStub,
    console,
    setTimeout,
    URL,
    Date,
    Math,
    JSON,
    Number,
    String,
  });
  vm.runInContext(appSource, context, { filename: 'app.js' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const resultNode = nodes.get('business-result');
  assert.equal(resultNode.dataset.viewKind, 'original');
  assert.equal(resultNode.dataset.denominator, '4');
  assert.equal(resultNode.dataset.departures, '1');
  assert.equal(resultNode.dataset.unboarded, '1');
  assert.equal(resultNode.dataset.mode, 'original');
  assert.equal(calls[0].url, '/api/replay');
  assert.equal(nodes.get('status-dot').dataset.state, 'ok');
  assert.match(nodes.get('status-text').textContent, /已回放原发班方案/);
  assert.equal(nodes.get('kpi-row').innerHTML.includes('未清队列（统计终点）'), true);

  // 切换视图：只隐藏/显示面板
  tabs[1].listeners.click();
  assert.equal(resultNode.dataset.activeView, 'waits');
  assert.equal(views[1].hidden, false);
  assert.equal(views[0].hidden, true);
  tabs[2].listeners.click();
  assert.equal(views[2].hidden, false);
  assert.equal(views[1].hidden, true);

  // 试算：状态与明细跟着变
  nodes.get('trial-form').listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(nodes.get('business-result').dataset.viewKind, 'trial');
  assert.equal(calls.some((c) => c.url === '/api/trial' && c.method === 'POST'), true);
  assert.match(nodes.get('status-text').textContent, /试算完成/);
  assert.match(nodes.get('compare-body').innerHTML, /需求人数（分母）/);
});

test('前端拒绝非法表单值并显示错误，不发请求', async () => {
  const { doc, nodes } = makeDom();
  nodes.get('intervalMinutes').value = '0';
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, method: init.method });
    if (url === '/api/replay') {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: fakeResult('original'), inputSnapshot: {} }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  // 其余数字字段给合法值
  for (const [id, value] of Object.entries({
    capacity: '10', fillThreshold: '10', maxWaitMinutes: '25', roundTripMinutes: '20',
    lastDepartureMinutes: '70', horizonMinutes: '90', 'closure-from': '20', 'closure-to': '50',
    'surge-at': '25', 'surge-count': '12',
  })) nodes.get(id).value = value;
  nodes.get('closure-enabled').checked = true;
  nodes.get('closure-boat').value = '乙';
  nodes.get('surge-enabled').checked = true;

  const context = vm.createContext({
    document: doc, fetch: fetchStub, console, setTimeout, URL, Date, Math, JSON, Number, String,
  });
  vm.runInContext(appSource, context, { filename: 'app.js' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  nodes.get('intervalMinutes').value = '0';
  nodes.get('trial-form').listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(nodes.get('form-error').hidden, false);
  assert.match(nodes.get('form-error').textContent, /发船间隔/);
  assert.equal(calls.filter((c) => c.url === '/api/trial').length, 0);
  assert.equal(nodes.get('status-dot').dataset.state, 'error');
});
