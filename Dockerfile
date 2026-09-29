# ─── AMD AI Key Balancer — Docker 镜像 ───────────────────────────────────────
# 用途：
#   1. 本地开发 / 测试：docker compose up
#   2. 部署到 Cloudflare：docker compose run --rm deploy
#
# 镜像本身只包含 Node + 依赖；密钥通过环境变量或 .env 文件传入，不写进镜像。
# ──────────────────────────────────────────────────────────────────────────────

FROM node:22-slim AS base
WORKDIR /app

# 只复制包管理文件，利用 Docker 层缓存
COPY package.json package-lock.json .npmrc ./

# 安装全部依赖（含 wrangler、typescript 等 devDependencies）
RUN npm ci --registry=https://registry.npmjs.org

# 复制源码
COPY . .

# 暴露 wrangler dev 默认端口
EXPOSE 8787

# 默认命令：本地开发模式
CMD ["npx", "wrangler", "dev", "--ip", "0.0.0.0"]
