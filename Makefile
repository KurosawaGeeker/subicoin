.PHONY: build build-gateway build-agent build-linux-amd64 build-darwin-arm64 test test-subi-mvp1-session test-local-oneclick seed-local-test-account tidy clean

DIST_DIR := dist
BUN ?= bun

build: build-gateway build-agent

build-gateway:
	@cd backend && $(BUN) run build:gateway

build-agent:
	@cd backend && $(BUN) run build:agent

build-linux-amd64:
	@cd backend && $(BUN) run build:linux-amd64

build-darwin-arm64:
	@cd backend && $(BUN) run build:darwin-arm64

test:
	@cd backend && $(BUN) test
	@cd backend && $(BUN) run typecheck

test-subi-mvp1-session:
	@./scripts/subi-mvp1-session-test

test-local-oneclick:
	@./scripts/subi-local-oneclick-test

seed-local-test-account:
	@./scripts/subi-seed-local-test-account

tidy:
	@cd backend && $(BUN) install

clean:
	@rm -rf $(DIST_DIR) backend/bin
