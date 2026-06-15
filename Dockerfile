# HF Space Docker 部署 - OpenCode Zen Proxy
FROM node:20-slim@sha256:8d5acac0e1ef991b994f66b44af2ae01aa8f11c4f5b3766c04dd5dd36bed8a78

WORKDIR /app

# 强制重建标记 - 每次推送时修改此值
ENV BUILD_NUMBER=20260615.1
ENV MODEL=deepseek-v4-flash-free

COPY package.json ./
RUN npm install --production --no-cache

COPY server.js ./

EXPOSE 7860
CMD ["node", "server.js"]
