.PHONY: build build-gateway build-agent test tidy clean

BUN ?= bun

build: build-gateway build-agent

build-gateway:
	@$(BUN) run build:gateway

build-agent:
	@$(BUN) run build:agent

test:
	@$(BUN) test
	@$(BUN) run typecheck

tidy:
	@$(BUN) install

clean:
	@rm -rf bin ../dist
