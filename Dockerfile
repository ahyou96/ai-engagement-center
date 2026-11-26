# AI Engagement Center — single-node container (SQLite on a volume). See docs/ARCHITECTURE.md.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 AEC_DB_PATH=/data/aec.db PORT=3210 AEC_DISABLE_BACKGROUND=0
COPY --from=build /app ./
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s CMD node -e "fetch('http://127.0.0.1:3210/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "[ -f \"$AEC_DB_PATH\" ] || npm run seed; npx next start -p ${PORT}"]
