# OpenCode Zen Free API 分析报告

> 基于 opencode-zen-research-94afdde1 的研究成果

## API 端点

```
https://opencode.ai/zen/v1/chat/completions  — OpenAI 格式
https://opencode.ai/zen/v1/messages           — Anthropic 格式
https://opencode.ai/zen/v1/models             — 模型列表
```

## 配额池

| 池 | 模型 | 每日配额 |
|----|------|---------|
| A  | deepseek-v4-flash-free, minimax-m3-free, big-pickle | **131 次** |
| B  | nemotron-3-ultra-free, nemotron-3-super-free | **10 次** |

- 配额按 **UTC 0 点**重置
- Pool A 所有模型共享 131 次（非每个模型 131 次）
- 429 限流时建议等待，3 次连续 429 后会自动切换模型池

## 代理方案对比

| 方案 | 延迟 | 稳定性 | 部署复杂度 |
|------|------|--------|-----------|
| HF Space (Node.js) | 低 | 稳定 | 低 — Docker 单文件 |
| Netlify Functions | 中 | 稳定 | 低 — Git 推送即部署 |
| Render (Docker) | 中 | 稳定 | 低 — 一键部署 |

## 注意事项

- 免费 API 仅供个人学习用途，请勿滥用
- 建议实施客户端缓存和指数退避重试
- 监控 `consecutive_429` 指标，及时切换模型
