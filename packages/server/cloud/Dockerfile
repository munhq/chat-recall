# Build context is packages/server/ (so both client/ and cloud/ are reachable).
# See .github/workflows/build-chat-recall-cloud.yml (context: ./packages/server).

# ── Stage 1: build the React dashboard ─────────────────────────────────────
FROM node:20-bookworm-slim AS client
WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
# Baked at build time (Vite). Same-origin API, so VITE_API_BASE defaults to /api.
ARG VITE_OIDC_ISSUER
ARG VITE_OIDC_CLIENT_ID
ARG VITE_API_BASE
RUN npm run build

# ── Stage 2: runtime — sync API + bundled dashboard ────────────────────────
FROM node:20-bookworm-slim
WORKDIR /app
COPY cloud/package.json ./
RUN npm install --omit=dev
COPY cloud/server.mjs cloud/migrate.mjs ./
COPY cloud/migrations ./migrations
COPY --from=client /client/dist ./client
ENV PORT=8080
ENV STATIC_DIR=/app/client
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
