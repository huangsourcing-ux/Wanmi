.PHONY: bootstrap dev worker generate verify-generated verify-oss-real verify-migrations verify-nginx verify-operations verify-provider-write-policy verify-release fmt lint test test-integration test-e2e performance security build smoke check down

bootstrap:
	corepack enable
	corepack prepare pnpm@11.7.0 --activate
	pnpm install --frozen-lockfile
	node scripts/bootstrap.mjs

dev:
	docker compose up -d postgres whodat minio minio-init
	pnpm dev

worker:
	pnpm worker

generate:
	pnpm generate

verify-generated:
	pnpm verify-generated

verify-oss-real:
	pnpm verify:cloud:oss

verify-migrations:
	docker compose up -d --wait --wait-timeout 60 postgres
	pnpm verify:migrations

verify-nginx:
	pnpm verify:nginx

verify-operations:
	pnpm verify:operations

verify-provider-write-policy:
	node scripts/verify-provider-write-policy.mjs

verify-release:
	pnpm verify:release

fmt:
	pnpm format

lint:
	pnpm lint
	pnpm typecheck

test:
	pnpm test

test-integration:
	docker compose up -d postgres whodat minio minio-init
	pnpm --filter @wanmi/web migrate
	pnpm test:integration

test-e2e:
	docker compose up -d postgres whodat minio minio-init
	pnpm --filter @wanmi/web migrate
	pnpm test:e2e

performance:
	docker compose up -d postgres whodat minio minio-init
	pnpm --filter @wanmi/web migrate
	pnpm --filter @wanmi/web build
	ALLOW_REAL_PROVIDER_WRITES=false pnpm --filter @wanmi/web performance

security: build
	pnpm security

build:
	pnpm build
	docker build --platform linux/amd64 --file apps/web/Dockerfile --tag wanmi-web:d0 .

smoke:
	node scripts/smoke.mjs

check: verify-provider-write-policy verify-generated verify-migrations verify-nginx verify-operations verify-release lint test test-integration security build

down:
	docker compose down
