FROM node:24.22.1-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a
COPY infra/sandboxes/computer/apt-security.sh /tmp/apt-security.sh
RUN /tmp/apt-security.sh
# pnpm lives in the image so containers start without downloading it.
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable
WORKDIR /app
# Manifests land before the source tree so editing a source file does not re-run the
# install. pnpm gets a partial workspace: every package listed in pnpm-workspace.yaml
# needs its manifest below, or --frozen-lockfile fails. The store is a cache mount, so
# a lockfile change reuses whatever was already downloaded.
COPY --chmod=755 package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install && chmod -R a+rX "${COREPACK_HOME}" && pnpx --version
COPY --chmod=755 patches patches
COPY --chmod=755 apps/api/package.json apps/api/
COPY --chmod=755 apps/desktop/package.json apps/desktop/
COPY --chmod=755 apps/mobile/package.json apps/mobile/
COPY --chmod=755 apps/web/package.json apps/web/
COPY --chmod=755 apps/worker/package.json apps/worker/
COPY --chmod=755 apps/www/package.json apps/www/
COPY --chmod=755 packages/adapter-kit/package.json packages/adapter-kit/
COPY --chmod=755 packages/adapters/package.json packages/adapters/
COPY --chmod=755 packages/auth/package.json packages/auth/
COPY --chmod=755 packages/chat-ui/package.json packages/chat-ui/
COPY --chmod=755 packages/contracts/package.json packages/contracts/
COPY --chmod=755 packages/core/package.json packages/core/
COPY --chmod=755 packages/db/package.json packages/db/
COPY --chmod=755 packages/logging/package.json packages/logging/
COPY --chmod=755 packages/memory/package.json packages/memory/
COPY --chmod=755 packages/page-kit/package.json packages/page-kit/
COPY --chmod=755 packages/testkit/package.json packages/testkit/
COPY --chmod=755 packages/ui-tokens/package.json packages/ui-tokens/
COPY --chmod=755 packages/ui-web/package.json packages/ui-web/
COPY --chmod=755 infra/sandboxes/supervisor/package.json infra/sandboxes/supervisor/
COPY --chmod=755 infra/updater/package.json infra/updater/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --store-dir=/pnpm/store
# Normalize modes: a restrictive host umask (e.g. 077 on hardened hosts) would otherwise
# leave the copied tree unreadable to USER node at runtime.
COPY --chmod=755 . .
RUN pnpm --filter @rakazo/db generate
RUN pnpm --filter @rakazo/api --filter @rakazo/worker build
RUN RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web build
RUN install -d -m 750 -o node -g node /data /app/apps/web/node_modules/.vite-temp /app/apps/web/asset-archive
ARG TARGETARCH
ARG UV_VERSION=0.12.19
RUN set -eux; \
  case "$TARGETARCH" in \
    amd64) uv_arch=x86_64; uv_sha256=23bf5552d220e0842b65c862097b2ebaeba0064b74eda5e565e77fd25969d8c8 ;; \
    arm64) uv_arch=aarch64; uv_sha256=0804e9b164c64b6914182d5920c08551958a095986f10a3731056df701126436 ;; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  archive="$(mktemp)"; \
  curl -fsSL "https://releases.astral.sh/github/uv/releases/download/${UV_VERSION}/uv-${uv_arch}-unknown-linux-gnu.tar.gz" -o "$archive"; \
  echo "$uv_sha256  $archive" | sha256sum -c -; \
  tar -xzf "$archive" -C /usr/local/bin --strip-components=1 "uv-${uv_arch}-unknown-linux-gnu/uv" "uv-${uv_arch}-unknown-linux-gnu/uvx"; \
  rm -f "$archive"; \
  uv --version; \
  uvx --version
# Last root step, so a cached earlier layer cannot be the filesystem that ships.
RUN /tmp/apt-security.sh --check && rm -f /tmp/apt-security.sh
ARG GIT_SHA
ENV NODE_ENV=production
ENV GIT_SHA=$GIT_SHA
EXPOSE 3100 5173 7091
USER node
CMD ["pnpm", "--filter", "@rakazo/api", "start"]
