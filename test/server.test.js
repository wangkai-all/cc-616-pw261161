'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createServer, resolvePort } = require('../server');

async function withServer(fn) {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}

function request(base, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(url, {
      method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 静态资源 */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('health 返回服务状态', async () => {
  await withServer(async (base) => {
    const res = await request(base, '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.dataset.arrivalCount, 50);
    assert.equal(res.json.dataset.departureCount, 8);
  });
});

test('GET /api/replay 返回原发班方案与独立输入快照', async () => {
  await withServer(async (base) => {
    const res = await request(base, '/api/replay');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    const { result, inputSnapshot } = res.json;
    assert.equal(result.meta.kind, 'original');
    assert.equal(result.stats.departureCount, 8);
    assert.equal(result.stats.demandTotal, 50);
    assert.equal(inputSnapshot.limits.length, 8);
    assert.equal(inputSnapshot.label, '原输入版');
  });
});

test('POST /api/trial 返回试算结果及与原输入版的对比', async () => {
  await withServer(async (base) => {
    const res = await request(base, '/api/trial', {
      method: 'POST',
      body: {
        config: {
          mode: 'timed',
          intervalMinutes: 15,
          closure: { enabled: true, boat: '乙', fromMinute: 20, toMinute: 50 },
          surge: { enabled: true, atMinute: 25, count: 12 },
        },
      },
    });
    assert.equal(res.status, 200);
    const { result, compareToOriginal } = res.json;
    assert.equal(result.meta.kind, 'trial');
    assert.equal(result.stats.demandTotal, 62);
    assert.equal(result.schedule.intervalMinutes, 15);
    assert.equal(compareToOriginal.sameDemand, false);
    assert.equal(compareToOriginal.originalDemand, 50);
    assert.equal(compareToOriginal.trialDemand, 62);
    assert.ok(Array.isArray(result.departures));
    assert.equal(
      result.waitHistogram.reduce((sum, b) => sum + b.count, 0),
      result.stats.demandTotal,
    );
  });
});

test('POST /api/trial 可直接传平铺参数（兼容无 config 包裹）', async () => {
  await withServer(async (base) => {
    const res = await request(base, '/api/trial', {
      method: 'POST',
      body: { mode: 'fill', capacity: 12, fillThreshold: 12 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.result.schedule.mode, 'fill');
    assert.equal(res.json.result.params.capacity, 12);
  });
});

test('POST /api/compare 在同一情景下比较两种发船方式', async () => {
  await withServer(async (base) => {
    const res = await request(base, '/api/compare', {
      method: 'POST',
      body: {
        config: {
          mode: 'timed',
          intervalMinutes: 10,
          closure: { enabled: true, boat: '乙', fromMinute: 20, toMinute: 50 },
          surge: { enabled: true, atMinute: 25, count: 12 },
        },
      },
    });
    assert.equal(res.status, 200);
    const { comparison } = res.json;
    assert.equal(comparison.sameDemand, true);
    assert.equal(comparison.timed.stats.demandTotal, comparison.fill.stats.demandTotal);
    assert.ok(comparison.metrics.some((m) => m.key === 'unboarded'));
    assert.ok(comparison.metrics.some((m) => m.key === 'emptySeats'));
  });
});

test('非法试算参数返回 400 与可读错误', async () => {
  await withServer(async (base) => {
    const cases = [
      { body: { config: { mode: 'ship' } }, field: 'mode' },
      { body: { config: { mode: 'timed', intervalMinutes: 0 } }, field: 'intervalMinutes' },
      { body: { config: { mode: 'timed', capacity: -1 } }, field: 'capacity' },
      { body: { config: { mode: 'timed', closure: { enabled: true, fromMinute: 60, toMinute: 30 } } }, field: 'closure.toMinute' },
      { body: { config: [] }, field: 'config' },
    ];
    for (const item of cases) {
      const res = await request(base, '/api/trial', { method: 'POST', body: item.body });
      assert.equal(res.status, 400, JSON.stringify(item));
      assert.equal(res.json.ok, false);
      assert.equal(res.json.error.field, item.field);
      assert.ok(res.json.error.message.length > 0);
    }
  });
});

test('损坏的 JSON 请求体返回 400', async () => {
  await withServer(async (base) => {
    const res = await request(base, '/api/trial', { method: 'POST', body: '{not json' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'INVALID_JSON');
  });
});

test('超大请求体返回 413', async () => {
  await withServer(async (base) => {
    const body = JSON.stringify({ config: { mode: 'timed' }, pad: 'x'.repeat(70 * 1024) });
    const res = await request(base, '/api/trial', { method: 'POST', body });
    assert.equal(res.status, 413);
    assert.equal(res.json.ok, false);
  });
});

test('方法不匹配返回 405 并带 Allow 头', async () => {
  await withServer(async (base) => {
    const trialGet = await request(base, '/api/trial');
    assert.equal(trialGet.status, 405);
    assert.match(trialGet.headers.allow, /POST/);

    const replayPost = await request(base, '/api/replay', { method: 'POST', body: {} });
    assert.equal(replayPost.status, 405);
    assert.match(replayPost.headers.allow, /GET/);
  });
});

test('未知 API 返回 404 JSON', async () => {
  await withServer(async (base) => {
    const res = await request(base, '/api/nope');
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'NOT_FOUND');
  });
});

test('首页包含 data-evidence-result 业务结果区与三个操作按钮', async () => {
  await withServer(async (base) => {
    const res = await request(base, '/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /data-evidence-result="ferry-dispatch-result"/);
    assert.match(res.text, /回放原发班方案/);
    assert.match(res.text, /试算停航和集中到达/);
    assert.match(res.text, /查看等待分布/);
    assert.match(res.text, /127\.0\.0\.1/);
    assert.match(res.text, /data-view="waits"[^>]*>查看等待分布/);
    assert.match(res.text, /id="business-result"[\s\S]*?data-denominator/);
  });
});

test('静态资源可取且目录穿越被拒绝', async () => {
  await withServer(async (base) => {
    const css = await request(base, '/styles.css');
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);

    const js = await request(base, '/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);

    const outside = await request(base, '/..%2f..%2fetc%2fpasswd');
    assert.ok(outside.status === 403 || outside.status === 404);

    const missing = await request(base, '/missing.html');
    assert.equal(missing.status, 404);
  });
});

test('PORT 解析：缺省 3000，非法值抛错', () => {
  assert.equal(resolvePort(undefined), 3000);
  assert.equal(resolvePort(''), 3000);
  assert.equal(resolvePort('4321'), 4321);
  assert.equal(resolvePort('0'), 0);
  assert.throws(() => resolvePort('abc'), /PORT/);
  assert.throws(() => resolvePort('-1'), /PORT/);
  assert.throws(() => resolvePort('70000'), /PORT/);
  assert.throws(() => resolvePort('3.14'), /PORT/);
});
