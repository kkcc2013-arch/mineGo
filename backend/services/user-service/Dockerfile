# Multi-stage build for Node.js microservices
# Usage: docker build -f services/user-service/Dockerfile -t pmg-user-service .
ARG SERVICE_NAME=user-service

# ── Stage 1: deps ────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY shared/package.json ./shared/
COPY services/${SERVICE_NAME}/package.json ./services/${SERVICE_NAME}/
RUN cd shared && npm install --production && cd ../services/${SERVICE_NAME} && npm install --production

# ── Stage 2: runtime ─────────────────────────────────────────
FROM node:20-alpine AS runtime
RUN addgroup -S pmg && adduser -S pmg -G pmg
WORKDIR /app
COPY --from=deps /app/shared/node_modules ./shared/node_modules
COPY --from=deps /app/services/${SERVICE_NAME}/node_modules ./services/${SERVICE_NAME}/node_modules
COPY shared/ ./shared/
COPY services/${SERVICE_NAME}/ ./services/${SERVICE_NAME}/

USER pmg
ENV NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-8080}/health || exit 1

CMD ["node", "services/${SERVICE_NAME}/src/index.js"]
