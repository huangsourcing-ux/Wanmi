.PHONY: bootstrap dev worker rebuild validate-rebuild-local generate sync-frontend-source verify-bootstrap verify-docs verify-frontend-source verify-generated verify-oss-real verify-migrations verify-nginx verify-operations verify-provider-write-policy verify-rebuild verify-release verify-validation-tiers fmt lint test test-integration test-e2e performance security security-secrets build smoke check-docs check-fast check-integration check down

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

rebuild:
	node scripts/rebuild.mjs --manifest "$${RELEASE_MANIFEST:-deploy/release-manifest.json}"

validate-rebuild-local:
	node scripts/validate-rebuild-local.mjs

generate:
	pnpm generate

verify-bootstrap:
	node scripts/verify-bootstrap.mjs

verify-docs:
	node scripts/verify-docs.mjs

verify-generated:
	pnpm verify-generated

sync-frontend-source:
	pnpm sync:frontend-source

verify-frontend-source:
	pnpm verify:frontend-source

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

verify-rebuild:
	pnpm verify:rebuild

verify-release:
	pnpm verify:release

verify-validation-tiers:
	node --test scripts/validation-tiers.test.mjs

fmt:
	pnpm format

lint:
	pnpm lint
	pnpm typecheck

test:
	pnpm test

test-integration:
	docker compose up -d postgres whodat minio minio-init
	docker compose up -d --wait --wait-timeout 60 postgres whodat minio
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

security-secrets:
	node scripts/security.mjs --secrets-only

build:
	pnpm build
	docker build --platform linux/amd64 --file apps/web/Dockerfile --tag wanmi-web:d0 .

smoke:
	node scripts/smoke.mjs

check-docs: verify-docs security-secrets

check-fast: verify-bootstrap verify-provider-write-policy verify-generated verify-frontend-source verify-validation-tiers lint test

check-integration: verify-migrations test-integration

check: verify-bootstrap verify-provider-write-policy verify-generated verify-frontend-source verify-migrations verify-nginx verify-operations verify-rebuild verify-release verify-validation-tiers lint test test-integration security build

down:
	docker compose down
