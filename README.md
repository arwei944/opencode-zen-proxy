---
sdk: docker
tags:
- docker
- node
- proxy
---

# OpenCode Zen Proxy

一个极简的 OpenCode Zen 代理，只使用 **deepseek-v4-flash-free** 免费模型。

通过 HF Space 部署，使用 HF 的美国 IP 与上游 API 交互。

## 功能

- 固定使用 `deepseek-v4-flash-free` 模型
- 代理 `/v1/chat/completions`（OpenAI 格式）
- 代理 `/v1/messages`（Anthropic 格式）
- 代理 `/v1/models`
- 流式响应透传

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `7860` | 服务端口 |
| `MODEL` | `deepseek-v4-flash-free` | 固定使用的模型 |

## 本地运行

```bash
npm install
npm start
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
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

> 请求中不需要传 `model`，服务端会固定使用 `deepseek-v4-flash-free`。
