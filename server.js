const express = require('express');

const PORT = Number(process.env.PORT || 7860);
const API_BASE = 'https://opencode.ai/zen/v1';
const API_TIMEOUT = Number(process.env.API_TIMEOUT || 60000);
const MODEL = 'deepseek-v4-flash-free';

const app = express();
app.use(express.json({ limit: '20mb' }));

// ── 工具函数 ──

function sendError(res, status, message) {
  res.status(status).json({ error: { message, type: 'proxy_error' } });
}

// ── 创建代理处理函数（直接指定上游路径）──

function createProxy(upstreamPath) {
  return async (req, res) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT);
    const upstreamUrl = `${API_BASE}${upstreamPath}`;

    try {
      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...req.body,
          model: MODEL,
        }),
        signal: controller.signal,
      });

      res.status(upstream.status);
      res.setHeader('content-type', 'application/json');

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
  };
}

// ── 路由定义 ──

app.get('/', (req, res) => {
  res.json({ service: 'OpenCode Zen Proxy', model: MODEL, version: '2.1.0' });
});

// 调试端点
app.post('/debug', (req, res) => {
  res.json({
    version: '2.1.0',
    bodyKeys: Object.keys(req.body),
    upstreamBase: API_BASE,
    model: MODEL,
    contentType: req.headers['content-type'],
  });
});

// OpenAI 格式聊天
app.post('/v1/chat/completions', createProxy('/chat/completions'));

// Anthropic 格式消息
app.post('/v1/messages', createProxy('/messages'));

// 模型列表
app.get('/v1/models', async (req, res) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT);

  try {
    const upstream = await fetch(`${API_BASE}/models`, {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
    });
    res.status(upstream.status);
    res.setHeader('content-type', 'application/json');
    res.send(await upstream.text());
  } catch (err) {
    const timeout = err.name === 'AbortError';
    sendError(res, timeout ? 504 : 502, timeout ? '请求超时' : '上游请求失败');
  } finally {
    clearTimeout(timer);
  }
});

// 404 处理
app.use((req, res) => sendError(res, 404, 'Not Found'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy listening on ${PORT} | Model: ${MODEL}`);
});
