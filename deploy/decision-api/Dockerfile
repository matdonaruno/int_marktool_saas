# 判断 API（Cloud Run）。ビルドコンテキストはリポジトリルート:
#   docker build -f deploy/decision-api/Dockerfile .
# functions/ のコード（aiRouter・criticAgent 等）をそのまま使う（ロジックの二重実装をしない: MASTER_SPEC 1.1）

FROM node:20-slim AS build
WORKDIR /app
COPY functions/package.json functions/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY functions/tsconfig.json ./
COPY functions/src ./src
RUN npx tsc

FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY functions/package.json functions/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/lib ./lib
USER node
EXPOSE 8080
CMD ["node", "lib/decisionApi/server.js"]
