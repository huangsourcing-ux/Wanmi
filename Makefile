.PHONY: bootstrap dev worker generate verify-generated verify-oss-real fmt lint test test-integration test-e2e security build smoke check down

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

security:
	pnpm security

build:
	pnpm build
	docker build --platform linux/amd64 --file apps/web/Dockerfile --tag wanmi-web:d0 .

smoke:
	node scripts/smoke.mjs

check: verify-generated lint test test-integration security build

down:
	docker compose down
