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
USER node
CMD ["node", "--enable-source-maps", "dist/worker/index.mjs"]
