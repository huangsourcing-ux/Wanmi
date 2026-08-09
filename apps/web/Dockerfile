FROM node:24.19.0-alpine3.24@sha256:2a49bdf71e9fd965a58c1703fd9ddd205b34e5782b692a72dd1d248abb0beb43 AS base
ENV COREPACK_HOME=/corepack
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN mkdir -p "$COREPACK_HOME" && \
    corepack enable && \
    corepack prepare pnpm@11.7.0 --activate && \
    chmod -R a+rX "$COREPACK_HOME"
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY patches patches
RUN --mount=type=cache,id=wanmi-pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=wanmi-pnpm-metadata,target=/root/.cache/pnpm \
    pnpm config set store-dir /pnpm/store && \
    pnpm config set fetch-retries 5 && \
    pnpm config set fetch-timeout 120000 && \
    pnpm install --frozen-lockfile

FROM base AS builder
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
ENV NEXT_PUBLIC_SERVER_URL=http://127.0.0.1:3000
ENV PUBLIC_STORAGE_MODE=local
ENV ALIYUN_SMS_MODE=mock
ENV ALIYUN_KMS_MODE=mock
ENV ALIYUN_OSS_REALNAME_MODE=mock
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/apps/web/node_modules ./apps/web/node_modules
COPY . .
RUN --mount=type=cache,id=wanmi-pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=wanmi-pnpm-metadata,target=/root/.cache/pnpm \
    PAYLOAD_SECRET=build-only-payload-secret-32-bytes \
    SESSION_PEPPER=build-only-session-pepper-32-bytes \
    TOTP_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    pnpm --filter @wanmi/web generate && \
    PAYLOAD_SECRET=build-only-payload-secret-32-bytes \
    SESSION_PEPPER=build-only-session-pepper-32-bytes \
    TOTP_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    pnpm --filter @wanmi/web build && \
    pnpm --filter @wanmi/web deploy --prod --legacy --offline /runtime && \
    rm -rf \
      /runtime/.next/cache \
      /runtime/.next/standalone \
      /runtime/.next/types \
      /runtime/node_modules/.pnpm/@esbuild+linux-x64@0.18.20 \
      /runtime/node_modules/.pnpm/@esbuild+linux-x64@0.25.12 \
      /runtime/node_modules/.pnpm/esbuild@0.18.20 \
      /runtime/node_modules/.pnpm/esbuild@0.25.12

FROM node:24.19.0-alpine3.24@sha256:2a49bdf71e9fd965a58c1703fd9ddd205b34e5782b692a72dd1d248abb0beb43 AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN rm -rf \
      /usr/local/bin/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg \
      /usr/local/lib/node_modules/corepack \
      /usr/local/lib/node_modules/npm \
      /opt/yarn-v1.22.22 && \
    addgroup --system --gid 1001 wanmi && \
    adduser --system --disabled-password --no-create-home --uid 1001 --ingroup wanmi wanmi
COPY --from=builder --chown=wanmi:wanmi /runtime /app
USER wanmi
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start"]
