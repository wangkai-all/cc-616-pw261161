'use strict';

/**
 * 渡口排班试算服务。
 *   node server.js
 * 读取环境变量 PORT（缺省 3000），只绑定 127.0.0.1。
 * 仅使用 Node.js 内置模块，无第三方依赖。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadDataset } = require('./data/dataset');
const {
  ValidationError,
  replayOriginal,
  runTrial,
  compareResults,
  compareStrategies,
  normalizeTrialConfig,
} = require('./lib/engine');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_PORT = 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const dataset = loadDataset();

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, error) {
  const status = error instanceof ValidationError
    ? (error.status || 400)
    : (error.status || 500);
  const message = error instanceof ValidationError
    ? error.message
    : (status === 500 ? '服务内部错误' : error.message);
  sendJson(res, status, {
    ok: false,
    error: {
      code: error.code || (status === 500 ? 'INTERNAL_ERROR' : 'ERROR'),
      message,
      field: error.field || null,
    },
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        chunks.length = 0;
        req.removeAllListeners('data');
        req.resume();
        const err = new ValidationError('请求体超过 64KB 上限', null, 'BODY_TOO_LARGE');
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (raw.trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const err = new ValidationError('请求体不是合法 JSON', null, 'INVALID_JSON');
    err.status = 400;
    throw err;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('请求体必须是 JSON 对象', null, 'INVALID_JSON');
  }
  return parsed;
}

function originalPayload() {
  const result = replayOriginal(dataset);
  return {
    ok: true,
    result,
    inputSnapshot: {
      label: '原输入版',
      arrivals: result.inputs.arrivalCount,
      limits: result.inputs.originalLimits,
      denominator: result.denominator,
    },
  };
}

function trialPayload(body) {
  const config = body.config !== undefined ? body.config : body;
  const result = runTrial(dataset, config);
  const original = replayOriginal(dataset);
  return {
    ok: true,
    result,
    compareToOriginal: compareResults(original, result),
    baseline: original,
    inputSnapshot: {
      label: '本次试算输入快照，可随时退回原输入版',
      arrivals: result.inputs.arrivalCount,
      baseArrivalCount: result.inputs.baseArrivalCount,
      surgeArrivalCount: result.inputs.surgeArrivalCount,
      limits: result.inputs.originalLimits,
      denominator: result.denominator,
    },
  };
}

function comparePayload(body) {
  const config = body.config !== undefined ? body.config : body;
  const normalized = normalizeTrialConfig(config);
  const original = replayOriginal(dataset);
  const comparison = compareStrategies(dataset, normalized);
  return {
    ok: true,
    comparison,
    baseline: original,
    compareTimedToOriginal: compareResults(original, comparison.timed),
    compareFillToOriginal: compareResults(original, comparison.fill),
    inputSnapshot: {
      label: '同一批到达日志下的两种调度规则对比',
      denominator: comparison.demandTotal,
    },
  };
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const { pathname } = url;

  if (pathname.startsWith('/api/')) {
    if (pathname === '/api/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 GET' } }, { allow: 'GET, HEAD' });
      }
      return sendJson(res, 200, { ok: true, status: 'ok', dataset: dataset.meta });
    }

    if (pathname === '/api/dataset') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 GET' } }, { allow: 'GET, HEAD' });
      }
      return sendJson(res, 200, {
        ok: true,
        dataset: {
          meta: dataset.meta,
          arrivals: dataset.arrivals,
          limits: dataset.limits,
          disruptions: dataset.disruptions,
        },
      });
    }

    if (pathname === '/api/replay') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 GET' } }, { allow: 'GET, HEAD' });
      }
      return sendJson(res, 200, originalPayload());
    }

    if (pathname === '/api/trial' || pathname === '/api/compare') {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 POST' } }, { allow: 'POST' });
      }
      const body = await readJsonBody(req);
      if (pathname === '/api/trial') return sendJson(res, 200, trialPayload(body));
      return sendJson(res, 200, comparePayload(body));
    }

    return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `未知接口 ${pathname}` } });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }
  return serveStatic(req, res, pathname);
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendError(res, err);
      else res.destroy();
    });
  });
}

function resolvePort(raw) {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  if (!/^\d+$/.test(String(raw).trim())) {
    throw new Error(`PORT 必须是 0-65535 的整数，收到 ${JSON.stringify(raw)}`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT 必须是 0-65535 的整数，收到 ${JSON.stringify(raw)}`);
  }
  return port;
}

function start() {
  let port;
  try {
    port = resolvePort(process.env.PORT);
  } catch (err) {
    console.error(`[ferry] ${err.message}`);
    process.exit(1);
  }
  const server = createServer();
  server.on('error', (err) => {
    console.error(`[ferry] 启动失败：${err.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    console.log(`[ferry] 渡口排班试算已启动：http://127.0.0.1:${addr.port}`);
  });
  return server;
}

if (require.main === module) start();

module.exports = { createServer, resolvePort, start, DEFAULT_PORT };
