# Subi P2P Gateway Prototype

Subi 是一个 P2P 顶级模型使用权交易市场，本质上是一个撮合交易所。买家通过本地 coding agent 使用模型能力；卖家保持本机客户端在线，把本地 Claude / Codex 订阅态能力接入市场；平台负责鉴权、撮合、路由、计量、结算和抽成。

完整产品愿景见 [docs/SUBI_PRD_CN.md](./docs/SUBI_PRD_CN.md)。

## 目标形态

```text
Buyer 设备
  coding agent: codex / claude code / opencode
  + Subi client: 一键写入 base_url 和 buyer key
        | 请求携带 Subi buyer key
        v
Subi 中心服务器
  auth / matching / routing / metering / settlement / fee
        | 分发单次请求
        v
Seller 设备
  Subi client / daemon
  读取本地 Claude / Codex 凭据，不上传平台
        | 本机直接请求 Vendor，可流式
        v
Vendor: OpenAI / Anthropic
```

核心原则：

- 卖家的 vendor 凭据留在卖家机器上，平台不托管、不代理 vendor 凭据。
- 买家的工具执行仍在买家本机，Subi 只接管模型请求通道。
- 卖家节点不挑单、不报价、不选择任务类型，平台按负载自动调度。
- 当前代码优先验证转发链路和一站式 seller 接入底座，不包含真实链上支付。

## 当前原型

当前仓库是已经裁剪过的最小转发链路：

```text
Buyer Codex / OpenAI-compatible client
-> Subi Gateway
-> Seller Agent
-> Seller local Codex subscription runtime
-> 原路返回
```

已保留组件：

- `backend/cmd/subi-gateway`：Gateway，接收买家 HTTP 请求和卖家 WebSocket 长连接。
- `backend/cmd/seller-agent`：卖家侧 agent，连接 Gateway，并调用本机 upstream。
- `backend/internal/service/subi_p2p.go`：seller registry、sticky routing、dispatch、WebSocket envelope。
- `backend/internal/service/subi_session.go`：可选的 Gateway 托管 session 文本上下文。
- `backend/internal/store`：SQLite 账号、Web session、Buyer API key、Seller node、setup token 存储。
- `backend/internal/pkg/apicompat`：Anthropic / OpenAI 协议兼容辅助。
- `web/buyer`、`web/seller-market`：静态 Web 原型。

## 构建

```bash
make build
```

默认通过 Dockerized Go 构建，本机不需要安装 Go。构建产物：

```text
dist/subi-gateway
dist/seller-agent
```

交叉编译：

```bash
make build-linux-amd64
make build-darwin-arm64
```

## 测试

```bash
make test
```

测试覆盖：

- Subi P2P / session service
- `subi-gateway`
- 协议兼容转换
- SQLite 账号和节点接入存储

## Gateway 启动

### 旧实验模式

旧模式只用环境变量中的单个 buyer key 和 seller token：

```bash
export SUBI_GATEWAY_ADDR="0.0.0.0:18080"
export SUBI_BUYER_API_KEY="<subi buyer key>"
export SUBI_SELLER_NODE_TOKEN="<seller node token>"

./dist/subi-gateway
```

### 账号接入模式

账号接入模式使用 SQLite：

```bash
export SUBI_GATEWAY_ADDR="0.0.0.0:18080"
export SUBI_DB_PATH="/opt/subi/subi.db"
export SUBI_PUBLIC_GATEWAY_WS_URL="wss://<gateway-host>/api/v1/subi/seller/agent/ws"

./dist/subi-gateway
```

启用 `SUBI_DB_PATH` 后，Gateway 提供最小 Web API：

```text
POST /api/web/auth/register
POST /api/web/auth/login
POST /api/web/auth/logout
GET  /api/web/auth/me

GET  /api/web/buyer/me
GET  /api/web/buyer/api-keys
POST /api/web/buyer/api-keys
POST /api/web/buyer/api-keys/:id/revoke

GET  /api/web/seller/me
GET  /api/web/seller/nodes
POST /api/web/seller/nodes
POST /api/web/seller/nodes/:node_id/setup-token

GET  /api/v1/subi/seller/setup?token=...
GET  /api/v1/subi/seller/install.sh
```

如果需要在账号模式下继续兼容旧实验 key：

```bash
export SUBI_DEV_STATIC_KEYS=true
export SUBI_BUYER_API_KEY="<legacy buyer key>"
export SUBI_SELLER_NODE_TOKEN="<legacy seller token>"
```

可选开启 Gateway 托管 session 文本上下文：

```bash
export SUBI_SESSION_CONTEXT_ENABLED=true
export SUBI_SESSION_MAX_TURNS=20
export SUBI_SESSION_MAX_CHARS=20000
```

## Seller 一站式接入

账号模式下，卖家不应该手动复制一堆环境变量。流程应该是：

```text
注册 / 登录
-> 创建 seller node
-> 生成 setup token
-> 复制安装命令
-> 安装脚本兑换 node_id / node_token / ws_url
-> 本机启动 seller-agent
-> Gateway 显示节点在线
```

安装命令示例：

```bash
curl -fsSL https://<gateway-host>/api/v1/subi/seller/install.sh | bash -s -- \
  --gateway https://<gateway-host> \
  --setup-token <subi_setup_xxx> \
  --agent-path ./dist/seller-agent-darwin-arm64
```

安装脚本会：

- 调用 `GET /api/v1/subi/seller/setup?token=...`
- 写入 `~/.subi/seller/config.env`
- 安装 `seller-agent`
- macOS 使用 launchd 启动
- Linux 使用 `systemd --user` 启动
- 无 systemd 时 fallback 到 `nohup`

本地自检：

```bash
./scripts/subi-seller-doctor
```

## Seller Agent 手动启动

如果不用一站式安装，也可以手动启动：

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

./dist/seller-agent
```

推荐模式是 `codex-app-server`。它会保持本机 Codex app-server 常驻，并把 delta 流式回传给买家。`codex-exec` 只作为兜底模式，每个请求都会启动一次 `codex exec`，延迟更高且不是真正 token streaming。

## Buyer 使用方式

买家侧客户端继续使用官方兼容环境变量名，只替换变量值：

```bash
export OPENAI_BASE_URL="http://<gateway-host>:18080/v1"
export OPENAI_API_KEY="<subi buyer key>"
```

这里的 `OPENAI_API_KEY` 是 Subi buyer key，不是 OpenAI 官方 API key。

运行 buyer doctor：

```bash
./scripts/subi-buyer-doctor
```

然后启动 OpenAI-compatible 客户端，例如：

```bash
codex
```

## 当前未完成

这些能力还没有实现，不能按生产能力对外承诺：

- Buyer Credit 余额和扣费账本
- Seller 收益账本和提现
- 真实加密货币充值 / 提现
- 完整 Web 登录页面接真实接口
- GUI 客户端
- 多 Gateway 实例共享状态
- 生产级调度、风控、健康分

当前最稳定的下一步是继续做：

```text
Buyer Credit wallet
-> Request Fill 账本
-> 成功请求扣费
-> Seller earning ledger
-> Web 页面从 mock 切真实数据
```
