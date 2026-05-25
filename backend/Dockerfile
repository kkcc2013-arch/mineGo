# Pocket Monster Go — Generic Service Dockerfile
# Build arg SERVICE_NAME selects which service to containerize
ARG SERVICE_NAME=user-service

# ── Stage 1: Install deps ────────────────────────────────────
FROM node:20-alpine AS deps
ARG SERVICE_NAME
WORKDIR /build

# Copy manifests first (layer cache)
COPY shared/package.json            ./shared/
COPY services/${SERVICE_NAME}/package.json ./services/${SERVICE_NAME}/

# Install production deps for shared + service
RUN cd shared && npm install --omit=dev && \
    cd ../services/${SERVICE_NAME} && npm install --omit=dev

# ── Stage 2: Runtime image ───────────────────────────────────
FROM node:20-alpine AS runtime
ARG SERVICE_NAME
ENV SERVICE_NAME=${SERVICE_NAME}

# Security: non-root user
RUN addgroup -S pmg && adduser -S pmg -G pmg

WORKDIR /app

# Copy installed modules
COPY --from=deps /build/shared/node_modules            ./shared/node_modules/
COPY --from=deps /build/services/${SERVICE_NAME}/node_modules \
                                                        ./services/${SERVICE_NAME}/node_modules/
# Copy source
COPY shared/     ./shared/
COPY services/${SERVICE_NAME}/  ./services/${SERVICE_NAME}/

USER pmg

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD node services/${SERVICE_NAME}/src/index.js
