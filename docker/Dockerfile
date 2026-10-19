# syntax=docker/dockerfile:1
# One image, two targets (§1): `web` (Next.js standalone + CSP hash hook) and `worker` (BullMQ).
# Built for linux/arm64 (Oracle A1). One build serves staging, then production by promotion:
# no NEXT_PUBLIC_* build argument, every setting is read at runtime.

ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${NODE_IMAGE} AS deps
WORKDIR /src
COPY package.json package-lock.json ./
# No install scripts: nothing in the tree needs one to build, and it closes a supply-chain path.
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build
# onnxruntime-node ships the binaries of five platforms (about 300 MB) and the worker trace copies
# them all: keep the one this image runs on (linux/arm64 on the VM) before the worker stage copies.
RUN set -eu; keep="dist/worker-standalone/node_modules/onnxruntime-node/bin/napi-v6/linux/$(node -p process.arch)"; \
    for dir in dist/worker-standalone/node_modules/onnxruntime-node/bin/napi-v6/*/*; do \
      if [ -d "$dir" ] && [ "$dir" != "$keep" ]; then rm -rf "$dir"; fi; \
    done

FROM ${NODE_IMAGE} AS models
# Local ONNX models of the worker (docs/models.md, models/MANIFEST.json): downloaded from their
# pinned URLs and verified by sha256 at build time, the only step that needs the network. The web
# target never sees them.
WORKDIR /src
COPY package.json ./
COPY scripts/fetch-models.ts scripts/
COPY models/MANIFEST.json models/
RUN MEDIA_MODELS_DIR=/app/models node scripts/fetch-models.ts

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
ARG RELEASE=dev
ENV RELEASE=${RELEASE}
LABEL org.opencontainers.image.source="https://github.com/Vegadarkk/joutiya" \
      org.opencontainers.image.revision="${RELEASE}"

FROM runtime AS web
# Code is owned by root; the container runs with a read-only file system (docker/compose.yml), and
# regenerated ISR pages stay in memory (next.config.ts). .next/cache is a tmpfs mount point.
COPY --from=build /src/.next/standalone ./
COPY --from=build /src/.next/static ./.next/static
COPY --from=build /src/public ./public
COPY --from=build /src/dist/server ./dist/server
COPY --from=build /src/infra/targets.json ./infra/targets.json
RUN mkdir -p .next/cache
ENV PORT=3000 \
    HOSTNAME=0.0.0.0
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "--import", "./dist/server/csp-hash-hook.mjs", "server.js"]

FROM runtime AS worker
# Bundle plus its traced npm packages (scripts/build-node.ts), owned by root, read-only at runtime.
COPY --from=build /src/dist/worker-standalone ./
COPY --from=build /src/infra/targets.json ./infra/targets.json
COPY --from=models /app/models ./models
# MALLOC_ARENA_MAX: glibc fragmentation with sharp/libvips (phase-3/research/libs-media.md §1.1).
ENV MEDIA_MODELS_DIR=/app/models \
    MALLOC_ARENA_MAX=2
USER node
CMD ["node", "--enable-source-maps", "dist/worker/index.mjs"]
