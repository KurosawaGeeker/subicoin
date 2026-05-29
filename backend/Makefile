.PHONY: build build-gateway build-agent test tidy clean

BIN_DIR := bin
GO_IMAGE ?= golang:1.26.3-alpine
USE_LOCAL_GO ?= 0

ifeq ($(USE_LOCAL_GO),1)
GO_CMD = go
else
GO_CMD = docker run --rm -v "$(CURDIR):/app" -w /app $(GO_IMAGE) go
endif

build: build-gateway build-agent

build-gateway:
	@mkdir -p $(BIN_DIR)
	@$(GO_CMD) build -trimpath -o $(BIN_DIR)/subi-gateway ./cmd/subi-gateway

build-agent:
	@mkdir -p $(BIN_DIR)
	@$(GO_CMD) build -trimpath -o $(BIN_DIR)/seller-agent ./cmd/seller-agent

test:
	@$(GO_CMD) test ./...

tidy:
	@$(GO_CMD) mod tidy

clean:
	@rm -rf $(BIN_DIR)
