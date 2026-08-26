# syntax=docker/dockerfile:1
#
# Build this image on a machine with >=1GB free RAM (mediasoup compiles a
# native C++ worker at install time — see docs/DEPLOYMENT.md for why that
# step is unsafe on a $4/512MB droplet). Push the built image to a registry
# and just `docker pull` + run it on the small box; never `docker build` there.

# ---- Build stage ----
FROM node:20-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build
# Strip devDependencies (typescript, eslint, @nestjs/cli, ...) in place —
# this does NOT recompile mediasoup's native worker, just deletes the
# packages that are no longer needed, shrinking node_modules by ~60%.
RUN npm prune --omit=dev

# ---- Runtime stage ----
FROM node:20-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system callservice && adduser --system --ingroup callservice callservice

WORKDIR /app
ENV NODE_ENV=production
# Caps V8's heap — matters on a 512MB-1GB droplet where an unbounded heap can
# starve the mediasoup worker processes of memory. Comfortable on 1GB+; on a
# genuinely 512MB box, lower this further (e.g. 192) — see docs/DEPLOYMENT.md.
ENV NODE_OPTIONS="--max-old-space-size=256"

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY public ./public
COPY package.json ./

USER callservice

EXPOSE 4000
# mediasoup media: one shared UDP+TCP port per worker (MEDIASOUP_WEBRTC_PORT +
# workerIndex), not a big port range — see MediasoupAppConfig/WorkerPoolService.
# With the default single worker (1 vCPU droplets) that's exactly one port.
EXPOSE 44000/udp
EXPOSE 44000/tcp

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:4000/health || exit 1

CMD ["node", "dist/main.js"]
