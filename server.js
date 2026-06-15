const express = require('express');

const PORT = Number(process.env.PORT || 7860);
const API_BASE = process.env.API_BASE || 'https://opencode.ai/zen/v1';
const API_TIMEOUT = Number(process.env.API_TIMEOUT || 60000);
const MODEL = 'deepseek-v4-flash-free';
const PROXY_API_KEY = process.env.PROXY_API_KEY || '';

const app = express();
app.use(express.json({ limit: '20mb' }));

// ── API Key 认证中间件（可选）──

function authMiddleware(req, res, next) {
  // 健康检查和调试端点免认证
  if (req.path === '/' || req.path === '/health') return next();
  if (!PROXY_API_KEY) return next(); // 未设置密钥时不认证

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (token !== PROXY_API_KEY) {
    return res.status(401).json({
      error: { message: '无效的 API Key', type: 'auth_error' },
    });
  }
  next();
}
app.use(authMiddleware);

// ── 工具函数 ──

function sendError(res, status, message) {
  res.status(status).json({ error: { message, type: 'proxy_error' } });
}

// ── 创建代理处理函数 ──

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
  res.json({
    service: 'OpenCode Zen Proxy',
    model: MODEL,
    version: '2.1.0',
    auth: PROXY_API_KEY ? 'enabled' : 'disabled',
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// 调试端点
app.post('/debug', (req, res) => {
  res.json({
    version: '2.1.0',
    bodyKeys: Object.keys(req.body),
    upstreamBase: API_BASE,
    model: MODEL,
    authEnabled: !!PROXY_API_KEY,
    contentType: req.headers['content-type'],
  });
});

// OpenAI 格式聊天
app.post('/v1/chat/completions', createProxy('/chat/completions'));

// Anthropic 格式消息
app.post('/v1/messages', createProxy('/messages'));

// 模型列表（直接返回支持的模型）
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: MODEL,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'opencode',
      },
    ],
  });
});

// OpenAI 兼容的模型列表
app.get('/v1/models/:model', (req, res) => {
  if (req.params.model === MODEL) {
    return res.json({
      id: MODEL,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'opencode',
    });
  }
  sendError(res, 404, '模型不存在');
});

// 404 处理
app.use((req, res) => sendError(res, 404, 'Not Found'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✔ Zen Proxy 启动 | 端口: ${PORT} | 模型: ${MODEL} | 认证: ${PROXY_API_KEY ? '启用' : '禁用'}`);
});
