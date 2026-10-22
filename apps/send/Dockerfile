# 5050 Send: one image, three roles.
#   web    (default)  node dist/index.js    public API on API_HOST + dashboard on DASHBOARD_HOST
#   worker            node dist/worker.js   scheduled sends, fan-out, webhooks, analytics, rollups
#   smtp              node dist/smtp.js     SMTP relay (smtp.example.com)
# Set ROLE=worker|smtp alongside the command so the healthcheck probes the right thing.

FROM node:22-alpine AS build
ENV NPM_CONFIG_FETCH_RETRIES=5 NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 NPM_CONFIG_FETCH_TIMEOUT=600000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Dashboard SPA (send/web) → /app/web/dist, served by src/internal/spa.ts on DASHBOARD_HOST.
FROM node:22-alpine AS web
ENV NPM_CONFIG_FETCH_RETRIES=5 NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 NPM_CONFIG_FETCH_TIMEOUT=600000
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
RUN npm run build

FROM node:22-alpine AS deps
ENV NPM_CONFIG_FETCH_RETRIES=5 NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 NPM_CONFIG_FETCH_TIMEOUT=600000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    ROLE=web
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
COPY --from=web --chown=node:node /app/web/dist ./web/dist
COPY --chown=node:node package.json ./
RUN mkdir -p /var/lib/5050-send/acme && chown -R node:node /var/lib/5050-send
USER node
EXPOSE 3000 587 2465 2587
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/index.js"]
