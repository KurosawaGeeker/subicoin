# Subi Agent Operating Notes

Last updated: 2026-05-27.

This file records the current experiment topology and operating rules for agents
working in this repository. Do not store API keys, buyer keys, seller tokens, or
OpenAI/OpenClaw secrets in this file.

## Current Chain

```text
Buyer Codex CLI in GitHub Codespaces
  -> Subi Gateway on AWS EC2 Japan
  -> Seller Agent on seller machine
  -> Seller local Codex/OpenClaw-capable runtime
  -> response returns along the same path
```

## Machine Responsibilities

| Machine | Current role | Runs | Chain position | Notes |
| --- | --- | --- | --- | --- |
| Buyer machine | Buyer/client environment | Codex CLI and repo test scripts | Starts requests to `/v1/responses` | Current buyer is GitHub Codespaces. It should not run `seller-agent` and should not need seller ChatGPT/Codex login state. |
| Gateway server | Subi relay/control point | `subi-gateway` systemd service | Receives buyer HTTP requests and seller WebSocket connections | Current public host is `13.230.32.216`, AWS EC2 in Japan, listening on TCP `18080`. |
| Seller machine | Supply-side execution environment | `seller-agent`, local `codex exec` or compatible upstream | Maintains WebSocket to Gateway and executes forwarded requests | Current physical seller machine is in China. It owns the seller-side logged-in runtime. |
| Singapore VPS, if used | Optional auxiliary runtime/relay | OpenClaw or other runtime components when explicitly configured | Not the authoritative Subi Gateway unless reconfigured | Treat this as auxiliary until its exact service and host are confirmed in the current run. |

## Gateway Server

- Public IP: `13.230.32.216`
- Region/location: AWS EC2 Japan
- Public HTTP base URL: `http://13.230.32.216:18080`
- OpenAI-compatible API base URL: `http://13.230.32.216:18080/v1`
- Health check: `http://13.230.32.216:18080/health`
- Seller WebSocket URL: `ws://13.230.32.216:18080/api/v1/subi/seller/agent/ws`
- Linux service name: `subi-gateway`
- Expected listen address: `0.0.0.0:18080`
- AWS Security Group must allow TCP `18080` from the current Buyer and Seller
  IPs during experiments.

Useful non-secret Gateway checks:

```bash
curl -fsS http://13.230.32.216:18080/health
ssh ubuntu@13.230.32.216 'sudo systemctl status subi-gateway --no-pager'
ssh ubuntu@13.230.32.216 'sudo journalctl -u subi-gateway -n 100 --no-pager'
```

## Code Locations

- Gateway entrypoint: `backend/cmd/subi-gateway`
- Seller Agent entrypoint: `backend/cmd/seller-agent`
- P2P dispatch, seller registry, sticky routing: `backend/internal/service/subi_p2p.go`
- Buyer session context carry-over: `backend/internal/service/subi_session.go`
- MVP-0 runbook: `docs/SUBI_MVP0_EXPERIMENT_RUNBOOK_CN.md`
- MVP-0 report: `docs/SUBI_MVP0_EXPERIMENT_REPORT_CN.md`

## Experiment Rules

1. Buyer is currently GitHub Codespaces.
2. Any bash script intended to run on the Buyer/Codespaces side must be provided
   as a copy-paste one-shot command. Do not require the user to open `nano`,
   manually edit files, or assemble multiple snippets.
3. Prefer scripts shaped like:

```bash
cat >/tmp/subi-test.sh <<'BASH'
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# commands here
BASH
bash /tmp/subi-test.sh
```

4. For repo-local tests that already exist, a shorter one-shot is acceptable:

```bash
cd "$(git rev-parse --show-toplevel)" && make test-subi-mvp1-session
```

5. Buyer-side `OPENAI_API_KEY` means the Subi buyer key, not an OpenAI official
   API key. Buyer-side base URL must point to the Subi Gateway, for example:

```bash
export OPENAI_BASE_URL="http://13.230.32.216:18080/v1"
export OPENAI_API_KEY="<Subi buyer key>"
```

6. Seller-side secrets and logged-in runtime state stay on the Seller machine.
   Buyer should not receive seller tokens or seller ChatGPT/Codex credentials.

## Current MVP-1 Session Test

Local automated session tests do not require a real second seller. They use fake
seller WebSocket connections inside Go tests to validate:

- same-session history injection on the same seller
- context carry-over when a session migrates from `seller-001` to `seller-002`
- isolation between different buyer session IDs
- disabling session context
- readable `503 no available seller node` errors

Run locally or in Codespaces:

```bash
cd "$(git rev-parse --show-toplevel)" && make test-subi-mvp1-session
```
