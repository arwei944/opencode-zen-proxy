# HF Space Docker 部署 - OpenCode Zen Proxy
# 只使用 deepseek-v4-flash-free 免费模型，不需要 API Key
FROM node:20-slim

WORKDIR /app

# 固定使用 deepseek-v4-flash-free 免费模型，不需要 API Key
ENV MODEL=deepseek-v4-flash-free

COPY package.json ./
RUN npm install --production

COPY server.js ./

EXPOSE 7860

CMD ["node", "server.js"]
