FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS base
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
RUN PAYLOAD_SECRET=build-only-payload-secret-32-bytes \
    SESSION_PEPPER=build-only-session-pepper-32-bytes \
    TOTP_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    pnpm --filter @wanmi/web generate && \
    PAYLOAD_SECRET=build-only-payload-secret-32-bytes \
    SESSION_PEPPER=build-only-session-pepper-32-bytes \
    TOTP_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    pnpm --filter @wanmi/web build

FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN groupadd --system --gid 1001 wanmi && useradd --system --uid 1001 --gid wanmi wanmi
COPY --from=builder --chown=wanmi:wanmi /app /app
USER wanmi
EXPOSE 3000
CMD ["pnpm", "--filter", "@wanmi/web", "start"]
