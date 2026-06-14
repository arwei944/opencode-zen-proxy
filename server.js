const express = require('express');

const PORT = Number(process.env.PORT || 7860);
const API_BASE = (process.env.API_BASE || 'https://opencode.ai/zen/v1').replace(/\/$/, '');
const API_TIMEOUT = Number(process.env.API_TIMEOUT || 30000);
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'deepseek-v4-flash-free';

const app = express();
app.use(express.json({ limit: process.env.BODY_LIMIT || '20mb' }));

function upstreamUrl(req) {
  return `${API_BASE}${req.originalUrl}`;
}

function cleanHeaders(headers) {
  const next = { 'content-type': 'application/json' };
  for (const name of ['authorization', 'anthropic-version', 'anthropic-beta', 'x-api-key']) {
    if (headers[name]) next[name] = headers[name];
  }
  return next;
}

function withDefaultModel(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return body.model ? body : { ...body, model: DEFAULT_MODEL };
}

function sendError(res, status, message, type = 'proxy_error') {
  res.status(status).json({ error: { message, type } });
}

async function proxyRequest(req, res) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT);

  try {
    const upstream = await fetch(upstreamUrl(req), {
      method: req.method,
      headers: cleanHeaders(req.headers),
      body: JSON.stringify(withDefaultModel(req.body)),
      signal: controller.signal,
    });

    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');

    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(chunk);
    }
    res.end();
  } catch (error) {
    const timeout = error && error.name === 'AbortError';
    sendError(res, timeout ? 504 : 502, timeout ? '上游请求超时' : '上游请求失败');
  } finally {
    clearTimeout(timer);
  }
}

app.get('/', (req, res) => {
  res.json({
    service: 'OpenCode Zen Proxy',
    status: 'running',
    upstream: API_BASE,
    endpoints: ['/v1/models', '/v1/chat/completions', '/v1/messages'],
  });
});

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
  } catch (error) {
    const timeout = error && error.name === 'AbortError';
    sendError(res, timeout ? 504 : 502, timeout ? '上游请求超时' : '上游请求失败');
  } finally {
    clearTimeout(timer);
  }
});

app.post('/v1/chat/completions', proxyRequest);
app.post('/v1/messages', proxyRequest);

app.use((req, res) => {
  sendError(res, 404, '仅代理 /v1/models、/v1/chat/completions 和 /v1/messages', 'not_found');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenCode Zen Proxy listening on ${PORT}`);
  console.log(`Upstream: ${API_BASE}`);
});
