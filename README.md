# Subi P2P Gateway Prototype

Subi is a P2P top-tier model-access marketplace — essentially a matching
exchange. Buyers pay with crypto and use sellers' local Claude / Codex
subscriptions indirectly through their own coding agent; sellers keep a client
online and contribute local subscription credentials to earn crypto; the
platform handles matching, routing, metering, settlement, and takes a fee.

See `docs/SUBI_PRD_CN.md` for the full product vision.

## Target product shape

```text
Buyer device
  coding agent (codex / claude code / opencode)
  + Subi client (one-click writes base_url + buyer key)
        | request carries Subi buyer key
        v
Subi central server (subi.network)
  auth / matching / routing / metering / settlement / fee
        | dispatch single request
        v
Seller device
  Subi client / daemon
  reads local Claude / Codex credentials (never uploaded)
        | calls vendor API directly (streaming)
        v
Vendor: OpenAI / Anthropic
```

Credentials stay on the seller's machine and are used locally; the platform
never holds or proxies vendor credentials. Payment is fully crypto-based: buyers
top up with mainstream chain coins (stablecoins preferred), the platform settles
seller earnings via on-chain transfer and takes a fee on the spread. There is no
self-issued Subi Coin.

## Current prototype (this checkout)

This repository is trimmed down to the minimum forwarding chain that has been
validated in MVP-0. It does **not** yet include the GUI client, accounts, or
crypto payment described above — those are MVP-2 / MVP-3 in the PRD roadmap.

```text
Buyer Codex / OpenAI-compatible client
-> Subi Gateway
-> Seller Agent
-> Seller local Codex subscription runtime
-> original response path
```

The original sub2api full product surface (platform-owned upstream account
pools, channel/proxy management, payment providers, generated database models,
web admin frontend, old deployment templates) was removed.

## Kept Components

- `backend/cmd/subi-gateway`: standalone Gateway for buyer HTTP requests and
  seller WebSocket connections.
- `backend/cmd/seller-agent`: seller-side agent that connects to the Gateway
  and calls a local upstream, currently persistent `codex app-server`,
  per-request `codex exec`, or an HTTP-compatible local endpoint.
- `backend/internal/service/subi_p2p.go`: in-memory seller registry, sticky
  routing, request dispatch, and WebSocket envelopes.
- `backend/internal/service/subi_session.go`: optional buyer session context
  carry-over when a request migrates across sellers.
- `backend/internal/pkg/apicompat`: protocol conversion helpers kept for the
  next phase of native Anthropic/OpenAI compatibility work.
- `docs/SUBI_PRD_CN.md`: product requirements.
- `docs/archive/SUBI_MVP0_EXPERIMENT_RUNBOOK_CN.md`: MVP-0 experiment runbook (archived).
- `docs/archive/SUBI_MVP0_EXPERIMENT_REPORT_CN.md`: MVP-0 experiment report (archived).

## Quickstart

Buyer-side Codex CLI / OpenAI-compatible clients should keep the official
environment variable names and replace only their values:

```bash
export OPENAI_BASE_URL="http://<gateway-host>:18080/v1"
export OPENAI_API_KEY="<subi buyer key>"
```

`OPENAI_API_KEY` is the Subi buyer key here, not an OpenAI official API key.

Run the buyer doctor before using a client:

```bash
./scripts/subi-buyer-doctor
```

The doctor checks:

- `OPENAI_BASE_URL` is set and ends with `/v1`.
- `OPENAI_API_KEY` is set and masked in output.
- Gateway `/health` is reachable.
- `POST /v1/responses` accepts the buyer key and returns a minimal response.

Then run your OpenAI-compatible client, for example:

```bash
codex
```

## Build

```bash
make build
```

`make` uses Dockerized Go by default so the checkout can build on machines
without a local Go toolchain. Use `USE_LOCAL_GO=1 make test` if Go is installed
locally.

Outputs:

```text
dist/subi-gateway
dist/seller-agent
```

Cross-compile examples:

```bash
make build-linux-amd64
make build-darwin-arm64
```

## Test

```bash
make test
```

This runs tests for:

- Subi P2P/session services
- standalone `subi-gateway`
- `seller-agent`
- protocol compatibility helpers

## Gateway

Required environment:

```bash
export SUBI_GATEWAY_ADDR="0.0.0.0:18080"
export SUBI_BUYER_API_KEY="<subi buyer key>"
export SUBI_SELLER_NODE_TOKEN="<seller node token>"
```

Optional session context:

```bash
export SUBI_SESSION_CONTEXT_ENABLED=true
export SUBI_SESSION_MAX_TURNS=20
export SUBI_SESSION_MAX_CHARS=20000
```

Run:

```bash
./dist/subi-gateway
```

## Seller Agent

Required environment:

```bash
export SUBI_GATEWAY_WS_URL="ws://<gateway-host>:18080/api/v1/subi/seller/agent/ws"
export SUBI_SELLER_NODE_TOKEN="<seller node token>"
export SUBI_NODE_ID="seller-001"
export SELLER_UPSTREAM_MODE="codex-app-server"
export SELLER_CODEX_WORKERS=1
export SELLER_CODEX_BIN="$(command -v codex)"
export SELLER_CODEX_MODEL="gpt-5.5"
export SELLER_CODEX_WORKDIR="/tmp/subi-codex-work"
export SELLER_CODEX_SANDBOX="read-only"
export SELLER_CODEX_APP_SERVER_PORT_BASE=19100
export SELLER_CODEX_APP_SERVER_STICKY_THREADS=true
```

Run:

```bash
./dist/seller-agent
```

`SELLER_CODEX_WORKERS` controls the seller-side worker pool size and is reported
to the Gateway as this node's `max_concurrency`.

`codex-app-server` keeps one local Codex app-server process alive per worker and
streams app-server deltas back to the buyer as OpenAI-compatible SSE. Use
`SELLER_UPSTREAM_MODE=codex-exec` only as a fallback; that mode starts a fresh
`codex exec` process for every request and does not provide true token
streaming.

With `SELLER_CODEX_APP_SERVER_STICKY_THREADS=true`, the agent reuses a Codex
thread for the same Subi session hash on that worker, reducing repeated
`thread/start` overhead and keeping seller-side runtime context warm.
For strict session ordering in this MVP, keep `SELLER_CODEX_WORKERS=1`; worker
level session pinning is a later scheduler improvement.

## Buyer

Use the Quickstart flow above. Buyer-side clients should keep the official
`OPENAI_BASE_URL` and `OPENAI_API_KEY` environment variable names; only their
values change to the Subi Gateway URL and Subi buyer key.
