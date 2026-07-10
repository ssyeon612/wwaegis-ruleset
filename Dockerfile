# ── 1) 프론트엔드 빌드 ──────────────────────────────
FROM node:20-slim AS web
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ── 2) 백엔드 + 빌드된 프론트 서빙 ──────────────────
FROM node:20-slim
WORKDIR /app
# better-sqlite3 네이티브 빌드 대비 (prebuilt 실패 시)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY backend/package*.json backend/
RUN cd backend && npm install --omit=dev
COPY backend/ backend/
COPY --from=web /app/frontend/dist frontend/dist
ENV PORT=4000
EXPOSE 4000
CMD ["node", "backend/server.js"]
