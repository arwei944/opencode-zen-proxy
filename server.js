/**
 * OpenCode Zen Proxy — 通用代理服务器
 *
 * 将 OpenCode Zen Free API (opencode.ai/zen/v1) 包装成
 * OpenAI / Anthropic 兼容格式，支持双配额池管理、流式传输、健康检查。
 *
 * 部署方式:
 *   - HF Space:  Dockerfile → node server.js
 *   - 裸机/VPS:  node server.js
 *   - Netlify:   netlify/functions/serve.js (Deno)
 */

// ──────────────────────────── 配置 ────────────────────────────
const PORT        = parseInt(process.env.PORT || '7860', 10);
const API_BASE    = process.env.API_BASE || 'https://opencode.ai/zen/v1';
const API_TIMEOUT = parseInt(process.env.API_TIMEOUT || '25000', 10);

// 模型池 — Pool A: 131 次/天, Pool B: 10 次/天 (UTC 重置)
const POOLS = {
  A: { limit: 131, models: ['deepseek-v4-flash-free', 'minimax-m3-free', 'big-pickle'] },
  B: { limit:  10, models: ['nemotron-3-ultra-free', 'nemotron-3-super-free'] },
};

// ──────────────────────────── 统计 ────────────────────────────
const stats = {
  startTime:        Date.now(),
  totalRequests:    0,
  successful:       0,
  failed:           0,
  rateLimited:      0,
  totalTokens:      0,
  promptTokens:     0,
  completionTokens: 0,
  poolUsed:          { A: 0, B: 0 },
  consecutive429:   0,
  lastSuccessTime:  0,
};

function poolOf(model) {
  if (POOLS.B.models.includes(model)) return 'B';
  return 'A';
}
function poolUsed(p)   { return stats.poolUsed[p]; }
function poolLimit(p)  { return POOLS[p].limit; }
function poolAvail(m)  { return poolUsed(poolOf(m)) < poolLimit(poolOf(m)); }

function selectModel(preferred) {
  if (preferred && poolAvail(preferred)) return preferred;
  for (const m of POOLS.A.models) if (poolAvail(m)) return m;
  for (const m of POOLS.B.models) if (poolAvail(m)) return m;
  return null;
}

function trackModel(model) { stats.poolUsed[poolOf(model)]++; }

function secsToUTCMidnight() {
  const n = new Date();
  return Math.floor((new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1)) - n) / 1000);
}

// ────────────────────────────  Anthropic → OpenAI ────────────────────────────
function anthropicToOpenAI(body) {
  const msgs = [];
  if (body.system) {
    const text = typeof body.system === 'string' ? body.system
      : Array.isArray(body.system) ? body.system.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
    if (text) msgs.push({ role: 'system', content: text });
  }
  for (const m of (body.messages || [])) {
    const blocks = typeof m.content === 'string'
      ? [{ type: 'text', text: m.content }]
      : Array.isArray(m.content) ? m.content : [{ type: 'text', text: '' }];
    if (m.role === 'user') {
      const parts = []; const tools = [];
      for (const b of blocks) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image' && b.source?.type === 'base64')
          parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
        else if (b.type === 'tool_result') {
          const ct = typeof b.content === 'string' ? b.content
            : Array.isArray(b.content) ? b.content.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
          tools.push({ role: 'tool', tool_call_id: b.tool_use_id, content: ct });
        }
      }
      if (parts.length === 1 && parts[0].type === 'text') msgs.push({ role: 'user', content: parts[0].text });
      else if (parts.length) msgs.push({ role: 'user', content: parts });
      msgs.push(...tools);
    } else if (m.role === 'assistant') {
      const texts = []; const calls = [];
      for (const b of blocks) {
        if (b.type === 'text') texts.push(b.text);
        else if (b.type === 'tool_use')
          calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
      }
      const obj = { role: 'assistant' };
      const t = texts.join('\n');
      if (t) obj.content = t;
      if (calls.length) obj.tool_calls = calls;
      msgs.push(obj);
    }
  }
  const result = {
    model: body.model, messages: msgs, max_tokens: body.max_tokens || 4096, stream: !!body.stream,
    temperature: body.temperature,
  };
  if (body.tools) result.tools = body.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || {} } }));
  if (body.tool_choice) {
    const c = body.tool_choice;
    result.tool_choice = c.type === 'any' ? 'required' : c.type === 'tool' ? { type: 'function', function: { name: c.name } } : c.type;
  }
  return result;
}

// ────────────────────────────  OpenAI → Anthropic ────────────────────────────
function finishMap(r) {
  if (r === 'stop') return 'end_turn';
  if (r === 'length') return 'max_tokens';
  if (r === 'tool_calls') return 'tool_use';
  return 'end_turn';
}

function oaiToAnthropic(oai, model) {
  const ch = oai.choices?.[0];
  const msg = ch?.message || {};
  const usage = oai.usage || {};
  const content = [];
  const text = msg.content || '';
  const reasoning = msg.reasoning_content || msg.reasoning || '';
  const textToUse = text || reasoning || '';
  if (textToUse) content.push({ type: 'text', text: textToUse });
  if (msg.tool_calls) for (const tc of msg.tool_calls) {
    let inp = {};
    try { inp = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: inp });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: `msg_${Date.now().toString(36)}${crypto.randomBytes(12).toString('base64url').slice(0, 16)}`,
    type: 'message', role: 'assistant', content, model,
    stop_reason: finishMap(ch?.finish_reason), stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    },
  };
}

// ──────────────────────────── 流式 OpenAI SSE → Anthropic SSE ────────────────────────────
function streamOaiToAnthropic(expressRes, upstream, model) {
  const st = {
    msgId: `msg_${Date.now().toString(36)}${crypto.randomBytes(12).toString('base64url').slice(0, 16)}`,
    model, inTokens: 0, outTokens: 0,
    textStarted: false, textIdx: -1, tools: new Map(), blockIdx: -1,
    started: false, finished: false,
  };
  expressRes.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  function sse(ev, data) { expressRes.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); }

  function msgStart() {
    sse('message_start', { type: 'message_start', message: {
      id: st.msgId, type: 'message', role: 'assistant', content: [], model: st.model,
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: st.inTokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }});
  }
  function cbStart(idx, type, toolId, toolName) {
    sse('content_block_start', {
      type: 'content_block_start', index: idx,
      content_block: type === 'text'
        ? { type: 'text', text: '' }
        : { type: 'tool_use', id: toolId, name: toolName, input: {} },
    });
  }
  function cbStop(idx)  { sse('content_block_stop', { type: 'content_block_stop', index: idx }); }
  function textDelta(idx, t) { sse('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: t } }); }
  function jsonDelta(idx, j) { sse('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: j } }); }

  let buf = '';
  upstream.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      const payload = t.slice(6).trim();
      if (payload === '[DONE]') continue;
      let data;
      try { data = JSON.parse(payload); } catch { continue; }
      if (data.usage) {
        st.inTokens = data.usage.prompt_tokens || st.inTokens;
        st.outTokens = data.usage.completion_tokens || st.outTokens;
      }
      if (!data.choices?.[0]) continue;
      const delta = data.choices[0].delta || {};
      const fr = data.choices[0].finish_reason;
      if (!st.started) { msgStart(); st.started = true; }

      const textDeltaStr = delta.content || delta.reasoning_content || delta.reasoning || '';
      if (textDeltaStr) {
        if (!st.textStarted) {
          st.textIdx = ++st.blockIdx; st.textStarted = true;
          cbStart(st.textIdx, 'text', '', '');
        }
        textDelta(st.textIdx, delta.content || textDeltaStr);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!st.tools.has(tc.index)) {
            if (st.textStarted) { cbStop(st.textIdx); st.textStarted = false; }
            const idx = ++st.blockIdx;
            const tid = tc.id || `toolu_${Date.now().toString(36)}`;
            st.tools.set(tc.index, { bi: idx, id: tid, name: tc.function?.name || '', args: '' });
            cbStart(idx, 'tool_use', tid, tc.function?.name || '');
          }
          const ts = st.tools.get(tc.index);
          if (tc.function?.arguments) {
            ts.args += tc.function.arguments;
            jsonDelta(ts.bi, tc.function.arguments);
          }
          if (tc.function?.name) ts.name = tc.function.name;
        }
      }

      if (fr) {
        if (st.textStarted) { cbStop(st.textIdx); st.textStarted = false; }
        for (const [, v] of st.tools) cbStop(v.bi);
        st.tools.clear();
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: finishMap(fr), stop_sequence: null }, usage: { output_tokens: st.outTokens || 0, cache_read_input_tokens: 0 } });
        sse('message_stop', { type: 'message_stop' });
        st.finished = true;
      }
    }
  });
  upstream.on('end', () => {
    if (st.started && !st.finished) {
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: st.outTokens || 0 } });
      sse('message_stop', { type: 'message_stop' });
    }
    expressRes.end();
  });
  upstream.on('error', () => expressRes.end());
}

// ────────────────────────────  上游请求 ────────────────────────────
function buildHeaders() {
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'OpenCodeZen-Proxy/1.0',
  };
}

async function callUpstream(path, body, stream) {
  const url = `${API_BASE}${path}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT),
  });
  if (resp.status === 429) {
    const errBody = await resp.text().catch(() => '');
    return { status: 429, data: null, raw: errBody };
  }
  if (stream) {
    return { status: resp.status, stream: resp.body };
  }
  const data = await resp.json();
  // 记录配额
  if (data.usage) {
    stats.totalTokens += data.usage.total_tokens || 0;
    stats.promptTokens += data.usage.prompt_tokens || 0;
    stats.completionTokens += data.usage.completion_tokens || 0;
  }
  return { status: resp.status, data };
}

// ────────────────────────────  Express 服务器 ────────────────────────────
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));

// 模型列表
app.get('/v1/models', (req, res) => {
  const allModels = [...POOLS.A.models, ...POOLS.B.models];
  res.json({
    object: 'list',
    data: allModels.map(m => ({
      id: m, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'opencode-zen',
      pool: poolOf(m), quota_used: poolUsed(poolOf(m)), quota_limit: poolLimit(poolOf(m)), available: poolAvail(m),
    })),
  });
});

// 统计
app.get('/v1/stats', (req, res) => {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  res.json({
    uptime: elapsed,
    requests: { total: stats.totalRequests, successful: stats.successful, failed: stats.failed, rate_limited: stats.rateLimited },
    tokens: { total: stats.totalTokens, prompt: stats.promptTokens, completion: stats.completionTokens },
    quota: {
      pool_a: { used: stats.poolUsed.A, limit: POOLS.A.limit, remaining: POOLS.A.limit - stats.poolUsed.A },
      pool_b: { used: stats.poolUsed.B, limit: POOLS.B.limit, remaining: POOLS.B.limit - stats.poolUsed.B },
      total_remaining: (POOLS.A.limit - stats.poolUsed.A) + (POOLS.B.limit - stats.poolUsed.B),
      utc_reset_in: secsToUTCMidnight(),
    },
  });
});

// 健康检查
app.get('/v1/health', (req, res) => {
  const remaining = (POOLS.A.limit - stats.poolUsed.A) + (POOLS.B.limit - stats.poolUsed.B);
  res.status(remaining > 0 ? 200 : 503).json({
    status: remaining > 0 ? 'healthy' : 'degraded',
    quota_remaining: remaining, consecutive_429: stats.consecutive429,
  });
});

// 根路径
app.get('/', (req, res) => {
  res.json({
    service: 'OpenCode Zen Proxy', version: '2.0.0',
    status: 'running', uptime: Math.floor((Date.now() - stats.startTime) / 1000),
    docs: 'https://github.com/arwei944/opencode-zen-proxy',
  });
});

// ────────────  OpenAI Chat Completions ────────────
app.post('/v1/chat/completions', async (req, res) => {
  const body = req.body;
  const stream = !!body.stream;
  stats.totalRequests++;

  const model = selectModel(body.model);
  if (!model) {
    const rem = (POOLS.A.limit - stats.poolUsed.A) + (POOLS.B.limit - stats.poolUsed.B);
    stats.rateLimited++;
    return res.status(429).json({
      error: { message: `All quota exhausted. Reset in ${secsToUTCMidnight()}s (remaining: ${rem})`, type: 'quota_exhausted' },
    });
  }

  const reqBody = {
    model, messages: body.messages,
    max_tokens: body.max_tokens || 4096,
    temperature: body.temperature ?? 0.7,
    stream,
  };
  if (body.stop) reqBody.stop = body.stop;

  // 重试逻辑
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));

    const result = await callUpstream('/chat/completions', reqBody, stream);

    if (result.status === 429) {
      stats.rateLimited++;
      stats.consecutive429++;
      if (stats.consecutive429 >= 3) {
        trackModel(model);
        const alt = selectModel();
        if (alt && alt !== model) { reqBody.model = alt; continue; }
      }
      return res.status(429).json({ error: { message: 'Rate limited', type: 'rate_limit_error' } });
    }

    if (result.status === 200) {
      stats.successful++;
      stats.consecutive429 = 0;
      stats.lastSuccessTime = Date.now();
      trackModel(model);

      if (stream && result.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
          'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Model': model,
        });
        const reader = result.stream.getReader();
        const pump = () => {
          reader.read().then(({ done, value }) => {
            if (done) return res.end();
            res.write(value);
            pump();
          }).catch(() => res.end());
        };
        pump();
        return;
      }

      if (!stream) {
        return res.json(result.data);
      }
    }

    stats.failed++;
  }

  res.status(502).json({ error: { message: 'Upstream error after retries', type: 'proxy_error' } });
});

// ────────────  Anthropic Messages ────────────
app.post('/v1/messages', async (req, res) => {
  const body = req.body;
  const isStream = !!body.stream;
  stats.totalRequests++;

  const model = selectModel(body.model);
  if (!model) {
    const rem = (POOLS.A.limit - stats.poolUsed.A) + (POOLS.B.limit - stats.poolUsed.B);
    stats.rateLimited++;
    return res.status(429).json({
      type: 'error',
      error: { type: 'rate_limit_error', message: `All quota exhausted. Reset in ${secsToUTCMidnight()}s (remaining: ${rem})` },
    });
  }

  // 判断该模型需要哪种上游格式
  const isNativeAnthropic = POOLS.B.models.includes(model);
  let reqBody;

  if (isNativeAnthropic) {
    // Pool B 模型原生走 Anthropic 格式透传
    reqBody = { ...body, model, stream: isStream };
  } else {
    // Pool A 模型需要 Anthropic → OpenAI 转换
    reqBody = anthropicToOpenAI(body);
    reqBody.model = model;
    reqBody.stream = isStream;
  }

  const path = isNativeAnthropic ? '/messages' : '/chat/completions';

  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));

    const result = await callUpstream(path, reqBody, isStream);

    if (result.status === 429) {
      stats.rateLimited++;
      stats.consecutive429++;
      if (stats.consecutive429 >= 3) {
        trackModel(model);
        const alt = selectModel();
        if (alt && alt !== model) { reqBody.model = alt; continue; }
      }
      return res.status(429).json({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } });
    }

    if (result.status === 200) {
      stats.successful++;
      stats.consecutive429 = 0;
      stats.lastSuccessTime = Date.now();
      trackModel(model);

      if (isNativeAnthropic) {
        // 原生 Anthropic：直接透传
        if (isStream && result.stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
            'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Model': model,
          });
          const reader = result.stream.getReader();
          const pump = () => {
            reader.read().then(({ done, value }) => {
              if (done) return res.end();
              res.write(value);
              pump();
            }).catch(() => res.end());
          };
          pump();
          return;
        }
        return res.json(result.data);
      }

      // OpenAI 格式 → 返回 Anthropic 格式
      if (isStream && result.stream) {
        streamOaiToAnthropic(res, result.stream.pipeThrough ? result.stream : require('stream').Readable.from(result.stream), model);
        return;
      }

      return res.json(oaiToAnthropic(result.data, model));
    }

    stats.failed++;
  }

  res.status(502).json({ type: 'error', error: { type: 'api_error', message: 'Upstream error after retries' } });
});

// ──────────────────────────── 启动 ────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenCode Zen Proxy ready on port ${PORT}`);
  console.log(`  API:    ${API_BASE}`);
  console.log(`  Pools:  A=${POOLS.A.limit}/d B=${POOLS.B.limit}/d`);
});
