.PHONY: build build-gateway build-agent build-linux-amd64 build-darwin-arm64 test test-subi-mvp1-session tidy clean

DIST_DIR := dist
GO_IMAGE ?= golang:1.26.3-alpine
USE_LOCAL_GO ?= 0

ifeq ($(USE_LOCAL_GO),1)
GO_BACKEND = cd backend && go
GO_BACKEND_LINUX_AMD64 = cd backend && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go
GO_BACKEND_DARWIN_ARM64 = cd backend && GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go
else
GO_BACKEND = docker run --rm -v "$(CURDIR):/workspace" -w /workspace/backend $(GO_IMAGE) go
GO_BACKEND_LINUX_AMD64 = docker run --rm -e GOOS=linux -e GOARCH=amd64 -e CGO_ENABLED=0 -v "$(CURDIR):/workspace" -w /workspace/backend $(GO_IMAGE) go
GO_BACKEND_DARWIN_ARM64 = docker run --rm -e GOOS=darwin -e GOARCH=arm64 -e CGO_ENABLED=0 -v "$(CURDIR):/workspace" -w /workspace/backend $(GO_IMAGE) go
endif

build: build-gateway build-agent

build-gateway:
	@mkdir -p $(DIST_DIR)
	@$(GO_BACKEND) build -trimpath -o ../$(DIST_DIR)/subi-gateway ./cmd/subi-gateway

build-agent:
	@mkdir -p $(DIST_DIR)
	@$(GO_BACKEND) build -trimpath -o ../$(DIST_DIR)/seller-agent ./cmd/seller-agent

build-linux-amd64:
	@mkdir -p $(DIST_DIR)
	@$(GO_BACKEND_LINUX_AMD64) build -trimpath -o ../$(DIST_DIR)/subi-gateway-linux-amd64 ./cmd/subi-gateway
	@$(GO_BACKEND_LINUX_AMD64) build -trimpath -o ../$(DIST_DIR)/seller-agent-linux-amd64 ./cmd/seller-agent

build-darwin-arm64:
	@mkdir -p $(DIST_DIR)
	@$(GO_BACKEND_DARWIN_ARM64) build -trimpath -o ../$(DIST_DIR)/subi-gateway-darwin-arm64 ./cmd/subi-gateway
	@$(GO_BACKEND_DARWIN_ARM64) build -trimpath -o ../$(DIST_DIR)/seller-agent-darwin-arm64 ./cmd/seller-agent

test:
	@$(GO_BACKEND) test ./...

test-subi-mvp1-session:
	@./scripts/subi-mvp1-session-test

tidy:
	@$(GO_BACKEND) mod tidy

clean:
	@rm -rf $(DIST_DIR) backend/bin
