const express = require('express');

const PORT = Number(process.env.PORT || 7860);
const API_BASE = (process.env.API_BASE || 'https://opencode.ai/zen/v1').replace(/\/$/, '');
const API_TIMEOUT = Number(process.env.API_TIMEOUT || 30000);
const MODEL = process.env.MODEL || 'deepseek-v4-flash-free';

const app = express();
app.use(express.json({ limit: '20mb' }));

// ── 工具函数 ──

function upstreamPath(req) {
  // API_BASE = "https://opencode.ai/zen/v1"
  // req.url = "/v1/chat/completions"
  // 结果: "https://opencode.ai/zen/v1/chat/completions"
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.startsWith('/v1') ? url.pathname.substring(3) : url.pathname;
  return `${API_BASE}${path}`;
}

function cleanHeaders(headers) {
  const next = { 'content-type': 'application/json' };
  for (const name of ['authorization', 'anthropic-version', 'x-api-key']) {
    if (headers[name]) next[name] = headers[name];
  }
  return next;
}

function sendError(res, status, message) {
  res.status(status).json({ error: { message, type: 'proxy_error' } });
}

// ── 核心代理逻辑 ──

async function proxy(req, res) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT);

  try {
    const upstream = await fetch(upstreamPath(req), {
      method: req.method,
      headers: cleanHeaders(req.headers),
      body: JSON.stringify({ ...req.body, model: MODEL }),
      signal: controller.signal,
    });

    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');

    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(chunk);
    }
    res.end();
  } catch (err) {
    const timeout = err.name === 'AbortError';
    sendError(res, timeout ? 504 : 502, timeout ? '请求超时' : '上游请求失败');
  } finally {
    clearTimeout(timer);
  }
}

// ── 路由定义 ──

app.get('/', (req, res) => {
  res.json({ service: 'OpenCode Zen Proxy', model: MODEL });
});

app.post('/v1/chat/completions', proxy);
app.post('/v1/messages', proxy);

app.get('/v1/models', async (req, res) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT);

  try {
    const upstream = await fetch(`${API_BASE}/models`, {
      headers: cleanHeaders(req.headers),
      signal: controller.signal,
    });
    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
    res.send(await upstream.text());
  } catch (err) {
    const timeout = err.name === 'AbortError';
    sendError(res, timeout ? 504 : 502, timeout ? '请求超时' : '上游请求失败');
  } finally {
    clearTimeout(timer);
  }
});

app.use((req, res) => sendError(res, 404, 'Not Found'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy listening on ${PORT} | Model: ${MODEL}`);
});
