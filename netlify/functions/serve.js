/**
 * Netlify Function — OpenCode Zen Proxy (Deno)
 *
 * 与 server.js 共用同一套配置逻辑，但部署为 Netlify 无服务器函数。
 * 使用 Deno 运行时 + Hono 框架。
 */

import { Hono } from 'npm:hono@^4.12.23';
import { handle } from 'npm:hono@^4.12.23/netlify';

// ──── 配置 ────
const API_BASE    = 'https://opencode.ai/zen/v1';
const API_TIMEOUT = 25000;

const POOLS = {
  A: { limit: 131, models: ['deepseek-v4-flash-free', 'minimax-m3-free', 'big-pickle'] },
  B: { limit:  10, models: ['nemotron-3-ultra-free', 'nemotron-3-super-free'] },
};

// ──── 统计 ────
const stats = {
  startTime: Date.now(), totalRequests: 0, successful: 0, failed: 0,
  rateLimited: 0, totalTokens: 0, poolUsed: { A: 0, B: 0 }, consecutive429: 0,
};

function poolOf(m)    { return POOLS.B.models.includes(m) ? 'B' : 'A'; }
function poolAvail(m) { return stats.poolUsed[poolOf(m)] < POOLS[poolOf(m)].limit; }

function selectModel(preferred) {
  if (preferred && poolAvail(preferred)) return preferred;
  for (const m of POOLS.A.models) if (poolAvail(m)) return m;
  for (const m of POOLS.B.models) if (poolAvail(m)) return m;
  return null;
}

function trackModel(m) { stats.poolUsed[poolOf(m)]++; }

function secsToMidnight() {
  const n = new Date();
  return Math.floor((new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1)) - n) / 1000);
}

// ──── 格式转换 ────
function anthropicToOpenAI(body) {
  const msgs = [];
  if (body.system) {
    const t = typeof body.system === 'string' ? body.system
      : Array.isArray(body.system) ? body.system.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
    if (t) msgs.push({ role: 'system', content: t });
  }
  for (const m of (body.messages || [])) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }]
      : Array.isArray(m.content) ? m.content : [{ type: 'text', text: '' }];
    if (m.role === 'user') {
      const parts = [];
      for (const b of blocks) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image' && b.source?.type === 'base64')
          parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
      }
      msgs.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
    } else if (m.role === 'assistant') {
      const texts = []; const calls = [];
      for (const b of blocks) {
        if (b.type === 'text') texts.push(b.text);
        else if (b.type === 'tool_use')
          calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
      }
      const obj = { role: 'assistant' };
      if (texts.length) obj.content = texts.join('\n');
      if (calls.length) obj.tool_calls = calls;
      msgs.push(obj);
    }
  }
  return { model: body.model, messages: msgs, max_tokens: body.max_tokens || 4096, stream: !!body.stream, temperature: body.temperature };
}

// ──── Hono App ────
const app = new Hono();

app.get('/', c => c.json({
  service: 'OpenCode Zen Proxy (Netlify)', version: '2.0.0',
  uptime: Math.floor((Date.now() - stats.startTime) / 1000),
}));

app.get('/v1/models', c => {
  const all = [...POOLS.A.models, ...POOLS.B.models];
  return c.json({ object: 'list', data: all.map(m => ({
    id: m, object: 'model', owned_by: 'opencode-zen',
    pool: poolOf(m), quota_used: stats.poolUsed[poolOf(m)], quota_limit: POOLS[poolOf(m)].limit, available: poolAvail(m),
  })) });
});

app.get('/v1/stats', c => c.json({
  uptime: (Date.now() - stats.startTime) / 1000,
  requests: { total: stats.totalRequests, successful: stats.successful, failed: stats.failed, rate_limited: stats.rateLimited },
  quota: {
    pool_a: { used: stats.poolUsed.A, limit: POOLS.A.limit, remaining: POOLS.A.limit - stats.poolUsed.A },
    pool_b: { used: stats.poolUsed.B, limit: POOLS.B.limit, remaining: POOLS.B.limit - stats.poolUsed.B },
    utc_reset_in: secsToMidnight(),
  },
}));

app.post('/v1/chat/completions', async c => {
  const body = await c.req.json();
  stats.totalRequests++;
  const model = selectModel(body.model);
  if (!model) {
    stats.rateLimited++;
    return c.json({ error: { message: `Quota exhausted, reset in ${secsToMidnight()}s`, type: 'quota_exhausted' } }, 429);
  }
  const upstream = { model, messages: body.messages, max_tokens: body.max_tokens || 4096, temperature: body.temperature ?? 0.7, stream: false };
  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'OpenCodeZen-Proxy/1.0' },
    body: JSON.stringify(upstream), signal: AbortSignal.timeout(API_TIMEOUT),
  });
  if (resp.status === 429) { stats.rateLimited++; return c.json({ error: { message: 'Rate limited' } }, 429); }
  if (!resp.ok) { stats.failed++; return c.json({ error: { message: 'Upstream error' } }, 502); }
  stats.successful++; trackModel(model);
  const data = await resp.json();
  if (data.usage) stats.totalTokens += data.usage.total_tokens || 0;
  return c.json(data);
});

app.post('/v1/messages', async c => {
  const body = await c.req.json();
  stats.totalRequests++;
  const model = selectModel(body.model);
  if (!model) { stats.rateLimited++; return c.json({ type: 'error', error: { type: 'rate_limit_error', message: 'Quota exhausted' } }, 429); }

  const isNative = POOLS.B.models.includes(model);
  const path = isNative ? '/messages' : '/chat/completions';
  const upstream = isNative
    ? { ...body, model, stream: false }
    : { ...anthropicToOpenAI(body), model, stream: false };

  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'OpenCodeZen-Proxy/1.0' },
    body: JSON.stringify(upstream), signal: AbortSignal.timeout(API_TIMEOUT),
  });
  if (resp.status === 429) { stats.rateLimited++; return c.json({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }, 429); }
  if (!resp.ok) { stats.failed++; return c.json({ type: 'error', error: { type: 'api_error', message: 'Upstream error' } }, 502); }
  stats.successful++; trackModel(model);
  const data = await resp.json();
  if (data.usage) stats.totalTokens += data.usage.total_tokens || 0;
  return c.json(isNative ? data : {
    id: `msg_${Date.now().toString(36)}`, type: 'message', role: 'assistant',
    content: [{ type: 'text', text: data.choices?.[0]?.message?.content || '' }],
    model, stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 },
  });
});

export const handler = handle(app);
