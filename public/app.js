'use strict';

/** 渡口排班试算台前端（原生 ES module，无依赖）。 */

const el = (id) => document.getElementById(id);

const ui = {
  statusDot: el('status-dot'),
  statusText: el('status-text'),
  form: el('trial-form'),
  formError: el('form-error'),
  btnTrial: el('btn-trial'),
  btnCompare: el('btn-compare'),
  btnReplay: el('btn-replay'),
  btnRevert: el('btn-revert'),
  result: el('business-result'),
  resultCaption: el('result-caption'),
  kpiRow: el('kpi-row'),
  compareNote: el('compare-note'),
  compareBody: el('compare-body'),
  strategyCard: el('strategy-card'),
  strategyBody: el('strategy-body'),
  strategyNote: el('strategy-note'),
  facts: el('facts'),
  hist: el('histogram'),
  histLegend: el('hist-legend'),
  waitFacts: el('wait-facts'),
  compareWaitCard: el('compare-wait-card'),
  histFill: el('histogram-fill'),
  histAxisFill: el('hist-axis-fill'),
  waitFactsFill: el('wait-facts-fill'),
  departureBody: el('departure-body'),
  eventsCard: el('events-card'),
  eventList: el('event-list'),
  queueCard: el('queue-card'),
  queueList: el('queue-list'),
  queueNote: el('queue-note'),
  raw: el('raw-json'),
  footerState: el('footer-state'),
  tabs: [...document.querySelectorAll('.segmented button')],
  views: [...document.querySelectorAll('.view')],
};

const state = {
  view: 'overview',
  current: null,
  comparison: null,
};

function setStatus(stateName, text) {
  ui.statusDot.dataset.state = stateName;
  ui.statusText.textContent = text;
}

function setBusy(busy) {
  for (const btn of [ui.btnTrial, ui.btnCompare, ui.btnReplay, ui.btnRevert]) btn.disabled = busy;
}

function showError(message) {
  ui.formError.textContent = message;
  ui.formError.hidden = false;
  setStatus('error', '出错了');
}

function clearError() {
  ui.formError.hidden = true;
  ui.formError.textContent = '';
}

async function api(path, { method = 'GET', body } = {}) {
  const init = { method, headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new Error('无法连接服务，请确认 node server.js 正在运行');
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`服务返回了无法解析的内容（HTTP ${response.status}）`);
  }
  if (!response.ok || payload.ok === false) {
    const message = payload?.error?.message || `请求失败（HTTP ${response.status}）`;
    const err = new Error(message);
    err.code = payload?.error?.code;
    err.field = payload?.error?.field;
    throw err;
  }
  return payload;
}

/* ---------- 参数读取 ---------- */

function readNumber(id, label, { min = 0, max = 240 } = {}) {
  const raw = el(id).value.trim();
  if (raw === '') throw new Error(`${label}不能为空`);
  if (!/^\d+$/.test(raw)) throw new Error(`${label}必须是非负整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${label}超出可处理范围`);
  if (value < min || value > max) throw new Error(`${label}必须在 ${min}–${max} 之间`);
  return value;
}

function readConfig() {
  const mode = ui.form.querySelector('input[name="mode"]:checked')?.value;
  if (!mode) throw new Error('请选择调度方式');
  const cfg = {
    mode,
    intervalMinutes: readNumber('intervalMinutes', '发船间隔', { min: 1, max: 240 }),
    capacity: readNumber('capacity', '每班可登船限额', { min: 1, max: 60 }),
    fillThreshold: readNumber('fillThreshold', '等满开船人数', { min: 1, max: 60 }),
    maxWaitMinutes: readNumber('maxWaitMinutes', '最长等待', { min: 1, max: 240 }),
    roundTripMinutes: readNumber('roundTripMinutes', '单船往返时长', { min: 1, max: 240 }),
    lastDepartureMinutes: readNumber('lastDepartureMinutes', '末班时刻', { min: 0, max: 240 }),
    horizonMinutes: readNumber('horizonMinutes', '统计终点', { min: 1, max: 240 }),
    closure: {
      enabled: el('closure-enabled').checked,
      boat: el('closure-boat').value,
      fromMinute: readNumber('closure-from', '停运开始时刻', { min: 0, max: 240 }),
      toMinute: readNumber('closure-to', '停运结束时刻', { min: 0, max: 240 }),
    },
    surge: {
      enabled: el('surge-enabled').checked,
      atMinute: readNumber('surge-at', '集中到达时刻', { min: 0, max: 240 }),
      count: readNumber('surge-count', '集中到达人数', { min: 0, max: 200 }),
    },
  };
  if (cfg.fillThreshold > cfg.capacity) throw new Error('等满开船人数不能大于每班可登船限额');
  if (cfg.closure.enabled && cfg.closure.fromMinute >= cfg.closure.toMinute) {
    throw new Error('停运开始时刻必须早于结束时刻');
  }
  if (cfg.lastDepartureMinutes > cfg.horizonMinutes) throw new Error('末班时刻不能晚于统计终点');
  return cfg;
}

/* ---------- 渲染工具 ---------- */

function fmtCount(v) {
  return Number.isInteger(v) ? String(v) : String(v);
}

function fmtSigned(v) {
  if (v > 0) return `+${v}`;
  return String(v);
}

function deltaClass(delta, direction) {
  if (delta === 0 || direction === 'none') return '';
  const goodWhenUp = direction === 'up';
  if (goodWhenUp) return delta > 0 ? 'up' : 'down';
  return delta < 0 ? 'up' : 'down';
}

function renderKpis(result) {
  const s = result.stats;
  const cards = [
    {
      label: '未清队列（统计终点）',
      value: s.unboarded,
      unit: '人',
      sub: '统计终点仍在排队、未上船的人数',
      accent: true,
    },
    {
      label: '需求分母',
      value: s.demandTotal,
      unit: '人',
      sub: '只由到达日志决定，改间隔不变',
    },
    {
      label: '已上船',
      value: s.boarded,
      unit: '人',
      sub: `上船率 ${s.boardedRate}%`,
    },
    {
      label: '平均等待',
      value: s.avgWaitMinutes,
      unit: '分',
      sub: `上船者平均 ${s.avgWaitBoardedMinutes} 分`,
    },
    {
      label: '空座',
      value: s.emptySeats,
      unit: '座',
      sub: `发船 ${s.departureCount} 班，载客率 ${s.loadFactor}%`,
    },
    {
      label: '排队峰值',
      value: s.peakQueue,
      unit: '人',
      sub: `计划班次 ${result.schedule.planned.length} 班`,
    },
    {
      label: '最长等待',
      value: s.maxWaitMinutes,
      unit: '分',
      sub: `截尾等待合计 ${s.censoredWaitMinutes} 分`,
    },
  ];
  ui.kpiRow.innerHTML = cards.map((c) => `
    <div class="kpi${c.accent ? ' accent' : ''}" data-kpi="${c.label}">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value">${fmtCount(c.value)}<small>${c.unit}</small></div>
      <div class="kpi-sub">${c.sub}</div>
    </div>`).join('');
}

function renderCompare(comparison, originalTitle, trialTitle) {
  if (!comparison) {
    ui.compareBody.innerHTML = '<tr><td colspan="4" class="empty">尚未对比。点击“回放原发班方案”，再做一次试算。</td></tr>';
    ui.compareNote.textContent = '对比会同时给出原发班方案与本次试算，便于退回原输入版核对。';
    return;
  }
  const rows = comparison.rows.map((row) => {
    const direction = row.key === 'demandTotal' ? 'none'
      : row.key === 'boarded' || row.key === 'loadFactor' ? 'up' : 'down';
    const cls = deltaClass(row.delta, direction);
    const deltaText = row.key === 'demandTotal'
      ? (comparison.sameDemand ? '不变' : fmtSigned(row.delta))
      : fmtSigned(row.delta);
    return `<tr data-metric="${row.key}">
      <td>${row.label}</td>
      <td class="num">${row.original}</td>
      <td class="num">${row.trial}</td>
      <td class="num delta ${cls}">${deltaText}</td>
    </tr>`;
  }).join('');
  ui.compareBody.innerHTML = rows;
  ui.compareNote.textContent = comparison.sameDemand
    ? `需求分母一致（${comparison.originalDemand} 人）：${originalTitle} 与 ${trialTitle} 可直接对比。`
    : `注意：需求分母不同（${comparison.originalDemand} → ${comparison.trialDemand}），差异来自集中到达，不是发船间隔。`;
}

function renderStrategy(comparison) {
  if (!comparison) {
    ui.strategyCard.hidden = true;
    return;
  }
  ui.strategyCard.hidden = false;
  ui.strategyBody.innerHTML = comparison.metrics.map((m) => {
    const dir = m.key === 'boarded' ? 'up' : m.key === 'departureCount' ? 'none' : 'down';
    const cls = deltaClass(m.delta, dir);
    return `<tr data-metric="${m.key}">
      <td>${m.label}</td>
      <td class="num">${m.timed}</td>
      <td class="num">${m.fill}</td>
      <td class="num delta ${cls}">${fmtSigned(m.delta)}</td>
    </tr>`;
  }).join('');
  const unboarded = comparison.metrics.find((m) => m.key === 'unboarded');
  const empty = comparison.metrics.find((m) => m.key === 'emptySeats');
  const queueDelta = unboarded.fill - unboarded.timed;
  const seatDelta = empty.fill - empty.timed;
  const queueText = queueDelta === 0 ? '未清队列持平'
    : queueDelta > 0 ? `未清队列多 ${queueDelta} 人`
      : `未清队列少 ${-queueDelta} 人`;
  const seatText = seatDelta === 0 ? '空座持平'
    : seatDelta < 0 ? `空座少 ${-seatDelta} 座`
      : `空座多 ${seatDelta} 座`;
  ui.strategyNote.textContent = `同一批 ${comparison.demandTotal} 名到达者、同样的停航与集中到达：`
    + `等满发船相对定点发船${queueText}、${seatText}；`
    + `这就是“上船等待”与“空座”的取舍。`;
}

function renderFacts(result) {
  const rows = [
    ['结果类型', result.meta.kind === 'original' ? '原发班方案回放（原始输入）' : '调度试算'],
    ['情景', result.meta.scenarioLabel],
    ['统计时段', `${result.inputs.horizonMinutes} 分钟（08:00 起）`],
    ['需求分母', `${result.denominator.demandTotal} 人 · 指纹 ${result.denominator.fingerprint}`],
    ['到达构成', `原始 ${result.inputs.baseArrivalCount} 人 + 集中到达 ${result.inputs.surgeArrivalCount} 人`],
    ['班次来源', result.meta.kind === 'original'
      ? `每班限额输入（${result.inputs.originalLimits.length} 班）`
      : `${result.schedule.mode === 'fill' ? '等满发船' : '定点发船'} · 计划 ${result.schedule.planned.length} 班`],
    ['发船班次', `${result.stats.departureCount} 班`],
    ['强制/取消', `提前开船 ${result.stats.forcedDepartures} 次 · 取消 ${result.stats.missedDepartures} 次`],
  ];
  ui.facts.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function histogramBars(hist, mostIndex) {
  const max = Math.max(1, ...hist.map((b) => b.count));
  return hist.map((b, i) => {
    const height = Math.round((b.count / max) * 100);
    return `<div class="hist-bar${i === mostIndex && b.count > 0 ? ' is-most' : ''}"
      style="height:${Math.max(2, height)}%"
      title="${b.label}：${b.count} 人"
      data-bucket="${i}">
      <span class="hist-count">${b.count > 0 ? b.count : ''}</span>
    </div>`;
  }).join('');
}

function drawHistogram(container, axis, result) {
  const hist = result.waitHistogram;
  const most = hist.reduce((best, b, i) => (b.count > hist[best].count ? i : best), 0);
  container.innerHTML = histogramBars(hist, most);
  axis.innerHTML = hist.map((b) => `<span>${b.label}</span>`).join('');
}

function waitFactsHtml(result) {
  const s = result.stats;
  const total = result.waitHistogram.reduce((sum, b) => sum + b.count, 0);
  return `
    <div>样本人数<strong>${total}</strong></div>
    <div>平均等待<strong>${s.avgWaitMinutes} 分</strong></div>
    <div>上船者平均<strong>${s.avgWaitBoardedMinutes} 分</strong></div>
    <div>最长等待<strong>${s.maxWaitMinutes} 分</strong></div>
    <div>未上船（计至终点）<strong>${s.unboarded} 人</strong></div>`;
}

function renderHistogram(result) {
  drawHistogram(ui.hist, document.getElementById('hist-axis'), result);
  ui.histLegend.innerHTML = `
    <li><span class="swatch" style="background:var(--series-1)"></span>各等待区间人数</li>
    <li><span class="swatch" style="background:var(--series-2)"></span>人数最多的区间</li>`;
  ui.waitFacts.innerHTML = waitFactsHtml(result);
}

function renderCompareWait(comparison) {
  if (!comparison) {
    ui.compareWaitCard.hidden = true;
    return;
  }
  ui.compareWaitCard.hidden = false;
  drawHistogram(ui.histFill, ui.histAxisFill, comparison.fill);
  ui.waitFactsFill.innerHTML = waitFactsHtml(comparison.fill);
}

function statusPill(status) {
  if (status === '满员') return '<span class="pill ok">满员</span>';
  if (status === '空船') return '<span class="pill warn">空船</span>';
  if (status.startsWith('未满（等待到点）')) return '<span class="pill warn">未满·等待到点</span>';
  return '<span class="pill warn">未满</span>';
}

function renderDepartures(result) {
  if (result.departures.length === 0) {
    ui.departureBody.innerHTML = '<tr><td colspan="9" class="empty">本次没有发出任何班次。</td></tr>';
    return;
  }
  ui.departureBody.innerHTML = result.departures.map((d) => `<tr data-departure="${d.index}">
      <td class="num">${d.index}</td>
      <td><strong>${d.clock}</strong></td>
      <td>${d.boat}船</td>
      <td class="num">${d.limit}</td>
      <td class="num">${d.queueBefore}</td>
      <td class="num">${d.boarded}</td>
      <td class="num">${d.emptySeats}</td>
      <td class="num">${d.queueAfter}</td>
      <td>${statusPill(d.status)}</td>
    </tr>`).join('');
}

function renderEvents(result) {
  const events = result.events || [];
  if (events.length === 0) {
    ui.eventsCard.hidden = true;
    return;
  }
  ui.eventsCard.hidden = false;
  ui.eventList.innerHTML = events.map((e) =>
    `<li><strong>${e.clock}</strong> · ${e.text}</li>`).join('');
}

function renderQueue(result) {
  if (result.queueAtEnd.length === 0) {
    ui.queueCard.hidden = true;
    return;
  }
  ui.queueCard.hidden = false;
  ui.queueNote.textContent = `共 ${result.queueAtEnd.length} 人到统计终点仍未上船，等待按“到达至终点”计入。`;
  ui.queueList.innerHTML = result.queueAtEnd.slice(0, 40).map((p) =>
    `<li>${p.id} · ${String(Math.floor(p.arrivedMinute / 60) + 8).padStart(2, '0')}:${String(p.arrivedMinute % 60).padStart(2, '0')} 到 · 等 ${p.censoredWait} 分</li>`).join('')
    + (result.queueAtEnd.length > 40 ? `<li>…另有 ${result.queueAtEnd.length - 40} 人</li>` : '');
}

function render(result, { comparison = null, caption = '' } = {}) {
  ui.result.dataset.viewKind = result.meta.kind;
  ui.result.dataset.mode = result.meta.kind === 'original' ? 'original' : (result.schedule.mode || '');
  ui.result.dataset.denominator = String(result.stats.demandTotal);
  ui.result.dataset.arrivalCount = String(result.inputs.arrivalCount);
  ui.result.dataset.departures = String(result.stats.departureCount);
  ui.result.dataset.unboarded = String(result.stats.unboarded);
  ui.result.dataset.scenario = result.meta.scenario;

  ui.resultCaption.textContent = caption || result.meta.title;
  ui.btnRevert.hidden = result.meta.kind === 'original';
  renderKpis(result);
  renderCompare(comparison, '原发班方案', result.meta.title);
  renderFacts(result);
  renderHistogram(result);
  renderDepartures(result);
  renderEvents(result);
  renderQueue(result);

  const summary = {
    view: state.view,
    kind: result.meta.kind,
    title: result.meta.title,
    scenario: result.meta.scenario,
    denominator: result.stats.demandTotal,
    departures: result.departures,
    events: result.events,
    queueAtEnd: result.queueAtEnd,
    waitHistogram: result.waitHistogram,
    queueTrace: result.queueTrace,
    stats: result.stats,
    schedule: result.schedule,
    inputs: {
      arrivalCount: result.inputs.arrivalCount,
      baseArrivalCount: result.inputs.baseArrivalCount,
      surgeArrivalCount: result.inputs.surgeArrivalCount,
      originalLimits: result.inputs.originalLimits,
    },
    denominatorNote: result.denominator.note,
  };
  ui.raw.textContent = JSON.stringify(summary, null, 2);
  ui.footerState.textContent = `最近更新：${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
}

function switchView(view) {
  state.view = view;
  for (const tab of ui.tabs) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  }
  for (const panel of ui.views) {
    panel.hidden = panel.id !== `view-${view}`;
  }
  if (ui.result) ui.result.dataset.activeView = view;
}

/* ---------- 操作 ---------- */

async function doReplay() {
  clearError();
  setBusy(true);
  setStatus('loading', '正在回放原发班方案…');
  try {
    const payload = await api('/api/replay');
    state.current = payload.result;
    // 回放时对比区展示“原始 vs 原始”，明确可退回原输入版
    const selfCompare = {
      sameDemand: true,
      originalDemand: payload.result.stats.demandTotal,
      trialDemand: payload.result.stats.demandTotal,
      rows: [
        ['demandTotal', '需求人数（分母）'],
        ['boarded', '已上船'],
        ['unboarded', '未清队列'],
        ['avgWaitMinutes', '平均等待（分）'],
        ['maxWaitMinutes', '最长等待（分）'],
        ['emptySeats', '空座'],
        ['departureCount', '发船班次'],
        ['loadFactor', '载客率（%）'],
      ].map(([key, label]) => ({
        key, label,
        original: payload.result.stats[key],
        trial: payload.result.stats[key],
        delta: 0,
      })),
    };
    render(payload.result, {
      comparison: selfCompare,
      caption: '原发班方案回放 · 原始到达日志 + 原始每班限额（已退回原输入版）',
    });
    ui.strategyCard.hidden = true;
    ui.compareWaitCard.hidden = true;
    ui.compareNote.textContent = '当前是原输入版：到达日志与每班限额都未被改动。';
    setStatus('ok', `已回放原发班方案 · ${payload.result.stats.departureCount} 班`);
  } catch (err) {
    showError(err.message);
  } finally {
    setBusy(false);
  }
}

async function doTrial() {
  clearError();
  let config;
  try {
    config = readConfig();
  } catch (err) {
    showError(err.message);
    return;
  }
  setBusy(true);
  setStatus('loading', '正在试算…');
  try {
    const payload = await api('/api/trial', { method: 'POST', body: { config } });
    state.current = payload.result;
    render(payload.result, {
      comparison: payload.compareToOriginal,
      caption: `${payload.result.meta.title} · ${payload.result.meta.scenarioLabel}`,
    });
    ui.strategyCard.hidden = true;
    ui.compareWaitCard.hidden = true;
    if (payload.compareToOriginal.sameDemand) {
      ui.compareNote.textContent = `需求分母一致（${payload.compareToOriginal.originalDemand} 人）：与原发班方案可直接对比。`;
    } else {
      ui.compareNote.textContent = `注意：需求分母不同（${payload.compareToOriginal.originalDemand} → ${payload.compareToOriginal.trialDemand}），差异来自集中到达，不是发船间隔。`;
    }
    setStatus('ok', `试算完成 · 未清队列 ${payload.result.stats.unboarded} 人`);
  } catch (err) {
    showError(err.message);
  } finally {
    setBusy(false);
  }
}

async function doCompare() {
  clearError();
  let config;
  try {
    config = readConfig();
  } catch (err) {
    showError(err.message);
    return;
  }
  setBusy(true);
  setStatus('loading', '正在比较两种发船方式…');
  try {
    const payload = await api('/api/compare', { method: 'POST', body: { config } });
    const { comparison } = payload;
    const result = comparison.timed;
    state.current = result;
    state.comparison = comparison;
    render(result, {
      comparison: payload.compareTimedToOriginal,
      caption: `定点发船 vs 等满发船 · ${comparison.scenarioLabel}`,
    });
    renderStrategy(comparison);
    renderCompareWait(comparison);
    ui.compareNote.textContent = payload.compareTimedToOriginal.sameDemand
      ? `需求分母一致（${payload.compareTimedToOriginal.originalDemand} 人）：原发班与试算可直接对比。`
      : `注意：需求分母不同（${payload.compareTimedToOriginal.originalDemand} → ${payload.compareTimedToOriginal.trialDemand}），差异来自集中到达。`;
    setStatus('ok', `已比较：定点未清 ${comparison.timed.stats.unboarded} 人 / 等满未清 ${comparison.fill.stats.unboarded} 人`);
  } catch (err) {
    showError(err.message);
  } finally {
    setBusy(false);
  }
}

/* ---------- 事件绑定 ---------- */

ui.form.addEventListener('submit', (event) => {
  event.preventDefault();
  doTrial();
});
ui.btnReplay.addEventListener('click', doReplay);
ui.btnCompare.addEventListener('click', doCompare);
ui.btnRevert.addEventListener('click', doReplay);

for (const tab of ui.tabs) {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
}

switchView('overview');

(async function boot() {
  setStatus('loading', '正在读取原发班方案…');
  await doReplay();
})();
