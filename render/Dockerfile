# Render 部署：运行完整的 OpenCode 服务器
FROM ghcr.io/anomalyco/opencode:latest

# ⚠️ 请修改此密码！
ENV OPENCODE_SERVER_PASSWORD=opencode123
ENV OPENCODE_PORT=1337

EXPOSE 1337

CMD ["serve", "--hostname", "0.0.0.0", "--port", "1337"]
