# OpenCode Zen Proxy

一个尽量简洁的 OpenCode Zen API 代理服务。

它只负责把客户端请求转发到上游 `https://opencode.ai/zen/v1`，不做复杂配额统计、不做多平台适配、不内置客户端代码。

## 功能

- 代理 `/v1/models`
- 代理 `/v1/chat/completions`
- 代理 `/v1/messages`
- 支持流式响应透传
- 请求未提供 `model` 时自动补充默认模型

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `7860` | 服务端口 |
| `API_BASE` | `https://opencode.ai/zen/v1` | 上游地址 |
| `API_TIMEOUT` | `30000` | 上游超时时间，单位毫秒 |
| `DEFAULT_MODEL` | `deepseek-v4-flash-free` | 默认模型 |
| `BODY_LIMIT` | `20mb` | 请求体大小限制 |

## 本地运行

```bash
npm install
npm start
```

访问：

```bash
curl http://localhost:7860/
```

## Docker 运行

```bash
docker build -t opencode-zen-proxy .
docker run -p 7860:7860 opencode-zen-proxy
```

## 接口示例

```bash
curl -X POST http://localhost:7860/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

## 项目结构

```text
.
├── server.js
├── package.json
├── Dockerfile
├── README.md
└── .gitignore
```

## 说明

本项目现在只保留代理所需的最小代码。复杂统计、配额池、客户端示例、多平台重复部署配置都已移除，以便维护和部署更简单。
