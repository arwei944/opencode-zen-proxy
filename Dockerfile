# HF Space Docker 部署
FROM node:20-slim

WORKDIR /app

ENV MODEL=deepseek-v4-flash-free

COPY package.json ./
RUN npm install --production

COPY server.js ./

EXPOSE 7860

CMD ["node", "server.js"]
