# HF Space Docker 部署 - OpenCode Zen Proxy
FROM node:20-slim@sha256:8d5ac0e1ef991b994f66b44af2ae01aa8f11c4f5b3766c04dd5dd36bed8a78

WORKDIR /app

# 强制重建标记 - 每次推送时修改此值
ENV BUILD_NUMBER=20260615.2

# 默认环境变量（可在 HF Space 设置中覆盖）
ENV MODEL=deepseek-v4-flash-free
ENV API_TIMEOUT=60000
ENV API_BASE=https://opencode.ai/zen/v1

# 如需开启 API Key 认证，在 HF Space Secrets 中设置 PROXY_API_KEY

COPY package.json ./
RUN npm install --production --no-cache

COPY server.js ./

EXPOSE 7860
CMD ["node", "server.js"]
