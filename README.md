# OpenCode Zen Proxy 🔄

将 [OpenCode Zen Free API](https://opencode.ai/zen/v1) 包装成 **OpenAI / Anthropic 兼容格式** 的通用代理。

支持双配额池管理、自动模型切换、流式传输、多平台部署。

## ✨ 特性

| 特性 | 说明 |
|------|------|
| 🎯 双协议 | 同时支持 OpenAI (`/v1/chat/completions`) 和 Anthropic (`/v1/messages`) |
| 🔄 格式转换 | Anthropic ↔ OpenAI 自动互转，Claude CLI / Cursor 开箱即用 |
| 📊 配额池 | Pool A (131次/天) + Pool B (10次/天)，自动切换和降级 |
| ⚡ 流式传输 | SSE 流式响应，低延迟体验 |
| 🚀 多平台 | HF Space / Netlify / Render / 裸机 一键部署 |
| 📈 监控 | 内置统计接口 (`/v1/stats`, `/v1/health`) |

## 🚀 快速开始

### 方式一：HF Space (Docker)

```bash
docker build -t opencode-zen-proxy .
docker run -d -p 7860:7860 opencode-zen-proxy
```

访问 `http://localhost:7860`

### 方式二：裸机 (Node.js)

```bash
npm install
npm start
```

### 方式三：Netlify

```bash
# 将 netlify/ 目录部署到 Netlify
# 或直接连 GitHub：netlify.toml 已配置
```

### 方式四：Render（完整 OpenCode 服务器）

```bash
# 部署 render/ 目录下的 Dockerfile 到 Render
# 运行完整 OpenCode 服务（非代理模式）
```

## 🔧 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `7860` | 监听端口 |
| `API_BASE` | `https://opencode.ai/zen/v1` | 上游 API 地址 |
| `API_TIMEOUT` | `25000` | 上游请求超时(ms) |

## 📡 API 端点

### 兼容 OpenAI

```bash
curl -X POST http://localhost:7860/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100
  }'
```

### 兼容 Anthropic (Claude CLI)

```bash
curl -X POST http://localhost:7860/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "nemotron-3-ultra-free",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### 可用模型

```bash
curl http://localhost:7860/v1/models
```

### 统计 & 健康检查

```bash
curl http://localhost:7860/v1/stats
curl http://localhost:7860/v1/health
```

## 🐍 Python 客户端

```python
from clients.python.zen_client import ZenClient

client = ZenClient(api_base="http://localhost:7860")
print(client.reply("Hello!"))
# → "Hello! How can I help you today?"
```

## 📂 项目结构

```
opencode-zen-proxy/
├── server.js                  # 主代理服务器 (Express)
├── package.json
├── Dockerfile                 # HF Space / 通用部署
│
├── netlify/
│   ├── functions/serve.js     # Netlify Function (Deno)
│   └── netlify.toml           # Netlify 配置
│
├── render/
│   └── Dockerfile             # Render OpenCode 服务器
│
├── clients/
│   └── python/
│       ├── zen_client.py      # Python 客户端
│       └── requirements.txt
│
└── docs/
    └── research/
        └── api-analysis.md    # API 分析报告
```

## 📜 模型配额

| 池 | 模型 | 每日配额 |
|----|------|---------|
| A  | `deepseek-v4-flash-free`, `minimax-m3-free`, `big-pickle` | 131 |
| B  | `nemotron-3-ultra-free`, `nemotron-3-super-free` | 10 |

配额按 **UTC 0 点** 重置，池内所有模型共享配额。

## ⚠️ 许可

仅供个人学习使用。请遵守上游服务条款。
