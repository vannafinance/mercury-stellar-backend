# ---- Vanna app · production image for Cloud Run ----
# Multi-stage. Next.js 16 standalone output. Node 22 (glibc/Debian for sharp).

# 1. deps
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# 2. builder
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* are inlined at BUILD time. Default matches the app's built-in
# fallback so a build WITHOUT this arg (e.g. Cloud Run "deploy from repo", which
# does not pass build args) still bakes a VALID url instead of "" — the app uses
# `?? fallback`, which does NOT catch an empty string, so "" would crash new URL().
# Change this to your real domain, or override via --build-arg / cloudbuild _SITE_URL.
ARG NEXT_PUBLIC_SITE_URL=https://app.vanna.finance
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build

# 3. runner (minimal)
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Cloud Run injects PORT=8080; Next standalone honors PORT + HOSTNAME.
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# Standalone server + assets
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static     ./.next/static
COPY --from=builder /app/public           ./public

# next/image needs sharp in production. It is NOT in package.json, so install it
# explicitly into the standalone node_modules (glibc build for this base image).
RUN npm install --no-save sharp@^0.34.0 \
 && npm cache clean --force \
 && chown -R nextjs:nodejs /app

USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
