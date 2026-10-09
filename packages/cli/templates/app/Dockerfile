# 多阶段构建：builder 里编译，runtime 只带产物与生产依赖。
# 想让镜像更小/更省事？见 Dockerfile.direct（直接跑 .ts，零构建）。
FROM node:24-slim AS builder
WORKDIR /app
# 先只拷依赖清单：依赖没变时这一层可复用缓存
COPY package*.json ./
RUN npm ci || npm install
# 再拷源码并编译（dist/ + 需要的非 TS 资产）
COPY . .
RUN npm run build

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
# 只要编译产物 + 配置资产（源码与测试不进生产镜像）
COPY --from=builder /app/dist ./dist
# 非 root 运行（node 镜像自带 node 用户）
USER node
EXPOSE 9000
# 优雅停机：容器停止时先发 SIGTERM，main.ts 里有处理器
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
