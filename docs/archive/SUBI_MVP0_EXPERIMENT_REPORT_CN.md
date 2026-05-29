# Subi MVP-0 实验报告

## 1. 摘要

本次 MVP-0 实验验证了 Subi 最小链路：

```text
Buyer Codex CLI -> Subi Gateway -> Seller Agent -> Seller 本机 Codex 订阅态 -> 原路返回
```

实验结论：链路已跑通。Buyer 机器无需登录 Seller 的 ChatGPT/Codex 账号，也无需使用 OpenAI 官方 API key；Buyer 只持有 Subi buyer key，并通过 Subi Gateway 间接使用 Seller 机器上的 Codex 订阅态能力。

本次实验不验证 Subi Coin、结算、市场、提现、复杂计费、多租户隔离和生产级调度。

## 2. 实验时间与角色

- 实验日期：2026-05-27
- Gateway：AWS EC2，公网端口 `18080`
- Seller：本机 Mac，运行 `seller-agent-darwin-arm64`
- Buyer：另一台机器上的 Codex CLI，本次使用 GitHub Codespaces 作为 Buyer 环境

实验拓扑：

```text
Buyer Codespace
  Codex CLI
  OPENAI_API_KEY=<Subi buyer key>
  base_url=http://<gateway-host>:18080/v1
        |
        v
Subi Gateway
  /v1/responses
  /api/v1/subi/seller/agent/ws
        |
        v
Seller Agent on Mac
  SELLER_UPSTREAM_MODE=codex-exec
        |
        v
Seller Mac Codex CLI
  Logged in using ChatGPT
```

## 3. 环境配置

### Gateway

- 部署方式：systemd 服务 `subi-gateway`
- 服务监听：`0.0.0.0:18080`
- 健康检查：

```bash
curl http://<gateway-host>:18080/health
```

预期：

```json
{"ok":true}
```

### Seller

- 运行方式：本机 `screen` 会话 `subi-seller-agent`
- 连接方式：WebSocket 连接 Gateway
- 上游模式：`codex-exec`
- Codex 登录态：`Logged in using ChatGPT`

关键配置：

```bash
SUBI_GATEWAY_WS_URL="ws://<gateway-host>:18080/api/v1/subi/seller/agent/ws"
SUBI_SELLER_NODE_TOKEN="<redacted>"
SUBI_NODE_ID="seller-001"
SELLER_UPSTREAM_MODE="codex-exec"
SELLER_CODEX_BIN="$(command -v codex)"
SELLER_CODEX_MODEL="gpt-5.5"
SELLER_CODEX_WORKDIR="/tmp/subi-codex-work"
SELLER_CODEX_SANDBOX="read-only"
SELLER_CODEX_EXTRA_ARGS="--ephemeral --ignore-user-config"
```

### Buyer

Buyer 使用 Codex CLI 的 OpenAI-compatible provider 配置，但 key 和 base URL 都指向 Subi：

```bash
export OPENAI_API_KEY="<Subi buyer key>"

codex --profile subi
```

`~/.codex/subi.config.toml`：

```toml
model = "gpt-5.5"
model_provider = "subi"

[model_providers.subi]
name = "Subi"
base_url = "http://<gateway-host>:18080/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
supports_websockets = false
```

注意：`OPENAI_API_KEY` 的值不是 OpenAI 官方 API key，而是 Subi buyer key。若 base URL 配置未生效，Codex 会请求 `https://api.openai.com/v1/responses`，并因 key 不属于 OpenAI 官方平台而返回 401。

## 4. 验收项与结果

### 4.1 基础链路

目的：确认 Buyer 请求能经 Gateway 转发到 Seller Agent，并由 Seller 本机 Codex 返回。

Buyer 侧提示词：

```text
Reply exactly: SUBI_BUYER_CODEX_OK
```

通过标准：

```text
Buyer Codex 返回 SUBI_BUYER_CODEX_OK
Seller Agent 日志出现 request done
```

结果：通过。

Seller Agent 侧日志示例：

```text
seller-agent codex request done: request_id=... bytes=2333 duration=...
```

### 4.2 长回答稳定返回

目的：验证较长响应不会中途断开、超时或破坏 SSE/Responses 返回结构。

Buyer 侧提示词：

```text
Print lines L001 through L200, one line each. Each line must be exactly "Lxxx: subi long response test", replacing xxx with the line number. After L200, print exactly SUBI_LONG_OK. Do not add any other text.
```

通过标准：

```text
输出包含 L001
输出包含 L200
输出包含 SUBI_LONG_OK
请求成功完成
Seller Agent 日志出现 request done
```

结果：通过。

Seller Agent 侧长回答日志示例：

```text
seller-agent codex request done: request_id=subi_1779871038430140629 bytes=33298 duration=36.660406542s
seller-agent codex request done: request_id=subi_1779872524635783997 bytes=33298 duration=45.376038375s
```

结论：MVP-0 当前能稳定返回约 33KB 级别响应。更大响应、并发长响应和网络抖动下的行为尚未覆盖。

### 4.3 Seller Agent 停止后的可读错误

目的：验证 Seller Agent 不在线时，Gateway 返回明确错误，而不是请求卡死或返回不可理解错误。

操作：

```bash
screen -S subi-seller-agent -X quit
```

Buyer 侧提示词：

```text
Reply exactly: SHOULD_NOT_RUN
```

通过标准：

```text
不返回 SHOULD_NOT_RUN
返回 503 Service Unavailable
错误信息包含 no available seller node
```

结果：通过。

实际返回：

```text
unexpected status 503 Service Unavailable: no available seller node,
url: http://<gateway-host>:18080/v1/responses
```

Raw API 验证返回：

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json

{"error":{"message":"no available seller node","type":"api_error"}}
```

Gateway 日志示例：

```text
seller agent disconnected: websocket: close 1006 (abnormal closure): unexpected EOF
```

结论：Seller 不在线时，Buyer 能获得可读错误。当前错误仍偏技术化，后续可进一步包装成面向用户的错误说明。

### 4.4 同一 Buyer 连续请求 Sticky 到同一 Seller

目的：验证同一 Buyer 的连续请求会固定路由到同一 Seller，避免会话在多 Seller 间跳转。

Buyer 连续提示词：

```text
Reply exactly: STICKY_1_OK
Reply exactly: STICKY_2_OK
Reply exactly: STICKY_3_OK
```

通过标准：

```text
三次请求均成功返回对应 OK
三次请求路由到同一个 seller node
```

结果：通过。

说明：当前 Gateway 的 sticky 逻辑使用 `sessionHash`。当请求没有显式 session id 时，会基于 buyer key 派生 session hash。第一次选中的 seller 会被记录，后续同一 buyer key 的请求继续路由到同一 seller。

代码位置：

```text
backend/internal/service/subi_p2p.go
reserveNode(sessionHash, requestID)
```

限制：当前 Gateway 没有 per-request access log，服务端日志不能直接回放每次请求的 seller 选择。本项结果基于 Buyer 侧验收和实验观察确认。后续应补 Gateway access log，将 `request_id`、`seller_node`、`session_hash`、`status` 和 `duration` 写入日志。

## 5. 已观察到的问题

### 5.1 Gateway 缺少请求级日志

当前 Gateway 只记录：

- 服务启动
- Seller WebSocket 断连

没有记录每个 Buyer 请求的：

- `request_id`
- path
- status
- seller node
- duration
- stream
- error
- bytes

影响：

- 成功请求只能从 Seller Agent 日志侧观察
- Sticky 结果无法从 Gateway 日志独立验证
- Buyer 报错时需要结合 Buyer 输出和 Seller 日志排查

建议优先补 access log。

### 5.2 Buyer 配置容易误用

Buyer 侧容易出现两类错误：

1. 只设置 `OPENAI_API_KEY`，但没有改 base URL，导致请求打到 OpenAI 官方接口：

```text
https://api.openai.com/v1/responses
```

2. base URL 已改对，但 `OPENAI_API_KEY` 不是当前 Gateway 认可的 Subi buyer key，导致：

```text
401 Unauthorized: invalid buyer API key
```

建议为 Buyer 提供一条安装/配置脚本，自动写入：

- `~/.codex/subi.config.toml`
- shell 环境中的 `OPENAI_API_KEY`
- 配置校验命令

### 5.3 Seller Agent 退出表现为 1006

Gateway 侧日志会记录：

```text
seller agent disconnected: websocket: close 1006 (abnormal closure): unexpected EOF
```

这对开发者可读，但不够结构化。后续可以在 Seller Agent 退出前发送 shutdown envelope，或 Gateway 将断连日志结构化为：

```text
seller_disconnected node=seller-001 reason=unexpected_eof
```

## 6. 安全注意事项

- 本次实验中的 buyer key 曾在截图/终端中暴露过，继续实验前建议重新生成。
- `SUBI_SELLER_NODE_TOKEN` 不应出现在日志、截图或文档中。
- Gateway 当前公网开放 `18080`，正式实验建议只允许 Buyer IP 和 Seller IP 访问。
- Buyer key 目前相当于调用凭证，应支持吊销、轮换和最小权限。
- Seller 执行的是本机 Codex CLI，生产环境必须增加隔离、配额、审计和任务生命周期控制。

## 7. 下一步建议

优先级 P0：

1. 轮换 `SUBI_BUYER_API_KEY` 和 `SUBI_SELLER_NODE_TOKEN`。
2. 为 Gateway 增加 access log。
3. 为 Buyer 提供 one-shot 配置脚本和配置自检命令。

优先级 P1：

1. 增加 Seller 在线状态查询接口。
2. 增加 request id 透传与 Buyer 侧错误定位信息。
3. 增加多 Seller 的可观测调度面板或 CLI。
4. 增加并发、超时、断流、重连实验。

优先级 P2：

1. 接入简单计量：请求数、响应字节数、耗时。
2. 接入额度/限流策略。
3. 设计 Seller 收益、Buyer 消耗和平台抽成模型。

## 8. 实验结论

Subi MVP-0 已验证核心假设：Buyer 可以通过 Subi Gateway 使用 Seller 机器上的 Codex 订阅态能力，而不需要直接持有 Seller 的账号或登录态。

当前系统已经具备继续进入 MVP-1 的基础，但在进入更大范围实验前，应优先完成凭证轮换、Gateway access log、Buyer 配置脚本和基础可观测能力。
