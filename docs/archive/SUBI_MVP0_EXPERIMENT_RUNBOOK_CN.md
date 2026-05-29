# Subi MVP-0 实验操作书

本文用于跑通最小链路：

```text
Buyer Codex CLI -> Subi Gateway -> Seller Agent -> Seller 本机 Codex 订阅态 -> 原路返回
```

本实验只验证 P2P 转发链路和卖家订阅态消费能力，不验证 Subi Coin、结算、市场、提现、复杂计费和多卖家调度。

## 1. 机器角色

- Server：公网 Subi Gateway。
- Seller 机器：卖家机器，必须已经安装 Codex CLI，并用 ChatGPT 订阅账号登录。
- Buyer 机器：买家机器，只把 Subi Gateway URL 和 Subi buyer key 填进 Codex CLI 原本读取的 `OPENAI_BASE_URL` / `OPENAI_API_KEY`，不安装 seller-agent。

建议先用一个 seller、一个 buyer、一个 gateway。MVP-0 的 seller-agent 默认单并发。

## 2. 准备变量

在本地先生成两段密钥：

```bash
export SUBI_BUYER_API_KEY="$(openssl rand -hex 24)"
export SUBI_SELLER_NODE_TOKEN="$(openssl rand -hex 24)"

echo "BUYER=$SUBI_BUYER_API_KEY"
echo "SELLER=$SUBI_SELLER_NODE_TOKEN"
```

记录以下地址：

```bash
export SERVER_HOST="<你的服务器 IP 或域名>"
export GATEWAY_HTTP="http://${SERVER_HOST}:18080"
export GATEWAY_WS="ws://${SERVER_HOST}:18080/api/v1/subi/seller/agent/ws"
```

如果你已经配好 HTTPS 反代，把地址改成：

```bash
export GATEWAY_HTTP="https://<你的域名>"
export GATEWAY_WS="wss://<你的域名>/api/v1/subi/seller/agent/ws"
```

## 3. 构建二进制

在开发机器的仓库根目录执行：

```bash
cd /Users/xiaoke/subcoin/sub2api
mkdir -p dist
```

构建 Linux Gateway：

```bash
docker run --rm \
  -v "$PWD":/repo \
  -v sub2api-gomod:/go/pkg/mod \
  -v sub2api-gocache:/root/.cache/go-build \
  -w /repo/backend \
  -e CGO_ENABLED=0 \
  -e GOOS=linux \
  -e GOARCH=amd64 \
  golang:1.26.3-alpine \
  go build -o /repo/dist/subi-gateway-linux-amd64 ./cmd/subi-gateway
```

构建 macOS Apple Silicon Seller Agent：

```bash
docker run --rm \
  -v "$PWD":/repo \
  -v sub2api-gomod:/go/pkg/mod \
  -v sub2api-gocache:/root/.cache/go-build \
  -w /repo/backend \
  -e CGO_ENABLED=0 \
  -e GOOS=darwin \
  -e GOARCH=arm64 \
  golang:1.26.3-alpine \
  go build -o /repo/dist/seller-agent-darwin-arm64 ./cmd/seller-agent
```

如果 Seller 是 Linux x86_64：

```bash
docker run --rm \
  -v "$PWD":/repo \
  -v sub2api-gomod:/go/pkg/mod \
  -v sub2api-gocache:/root/.cache/go-build \
  -w /repo/backend \
  -e CGO_ENABLED=0 \
  -e GOOS=linux \
  -e GOARCH=amd64 \
  golang:1.26.3-alpine \
  go build -o /repo/dist/seller-agent-linux-amd64 ./cmd/seller-agent
```

## 4. 部署 Gateway 到 Server

上传二进制：

```bash
scp dist/subi-gateway-linux-amd64 ubuntu@${SERVER_HOST}:/tmp/subi-gateway
```

在本机执行远程安装命令：

```bash
ssh ubuntu@${SERVER_HOST} '
  sudo mkdir -p /opt/subi
  sudo mv /tmp/subi-gateway /opt/subi/subi-gateway
  sudo chmod +x /opt/subi/subi-gateway
'
```

从本机把环境变量写入服务器。注意这里依赖本机当前 shell 里的 `SUBI_BUYER_API_KEY` 和 `SUBI_SELLER_NODE_TOKEN`：

```bash
ssh ubuntu@${SERVER_HOST} "sudo tee /opt/subi/subi-gateway.env >/dev/null" <<EOF
SUBI_GATEWAY_ADDR=0.0.0.0:18080
SUBI_BUYER_API_KEY=${SUBI_BUYER_API_KEY}
SUBI_SELLER_NODE_TOKEN=${SUBI_SELLER_NODE_TOKEN}
EOF

ssh ubuntu@${SERVER_HOST} 'sudo chmod 600 /opt/subi/subi-gateway.env'
```

创建 systemd 服务：

```bash
ssh ubuntu@${SERVER_HOST} "sudo tee /etc/systemd/system/subi-gateway.service >/dev/null" <<'EOF'
[Unit]
Description=Subi MVP-0 Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/opt/subi/subi-gateway.env
ExecStart=/opt/subi/subi-gateway
Restart=always
RestartSec=3
User=ubuntu
WorkingDirectory=/opt/subi

[Install]
WantedBy=multi-user.target
EOF
```

启动 Gateway：

```bash
ssh ubuntu@${SERVER_HOST} '
  sudo systemctl daemon-reload
  sudo systemctl enable --now subi-gateway
  sudo systemctl status subi-gateway --no-pager
'
```

开放端口：

```bash
ssh ubuntu@${SERVER_HOST} '
  sudo ufw allow 18080/tcp
  sudo ufw status numbered
'
```

如果是 AWS Lightsail/EC2，还需要在云控制台安全组/Networking 里放行 TCP `18080`。正式实验建议只放行 Seller IP 和 Buyer IP。

验证 Gateway：

```bash
curl -sS ${GATEWAY_HTTP}/health
```

预期输出：

```json
{"ok":true}
```

## 5. 准备 Seller 机器

Seller 机器必须安装并登录 Codex CLI：

```bash
codex --version
codex login status
```

如果不是 `Logged in using ChatGPT`，执行：

```bash
codex login --device-auth
```

按终端提示在浏览器完成 ChatGPT 登录。

先做订阅态探针：

```bash
printf '' | codex exec --json --skip-git-repo-check --sandbox read-only \
  'Reply exactly: SUBI_SUBSCRIPTION_OK'
```

预期看到：

```json
{"type":"item.completed","item":{"type":"agent_message","text":"SUBI_SUBSCRIPTION_OK"}}
```

> 注意：不要在 Seller 机器上用内置 `openai_base_url + forced_login_method="api"` 做测试，这会把 Codex 登录方式切到 API key，影响订阅态实验。

## 6. 启动 Seller Agent

把 seller-agent 二进制放到 Seller 机器，例如：

```bash
chmod +x ./dist/seller-agent-darwin-arm64
```

启动：

```bash
SUBI_GATEWAY_WS_URL="${GATEWAY_WS}" \
SUBI_SELLER_NODE_TOKEN="${SUBI_SELLER_NODE_TOKEN}" \
SUBI_NODE_ID="seller-001" \
SELLER_UPSTREAM_MODE="codex-exec" \
SELLER_CODEX_BIN="$(command -v codex)" \
SELLER_CODEX_MODEL="gpt-5.5" \
SELLER_CODEX_WORKDIR="/tmp/subi-codex-work" \
SELLER_CODEX_SANDBOX="read-only" \
SELLER_CODEX_EXTRA_ARGS="--ephemeral --ignore-user-config" \
./dist/seller-agent-darwin-arm64
```

预期日志：

```text
seller-agent connected: node=seller-001 gateway=... mode=codex-exec
```

如果 Seller 是 Linux，把最后一行换成：

```bash
./dist/seller-agent-linux-amd64
```

## 7. Gateway 到 Seller 的链路验收

在任意能访问 Gateway 的机器上执行：

```bash
curl -sS -N "${GATEWAY_HTTP}/v1/responses" \
  -H "Authorization: Bearer ${SUBI_BUYER_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "subi-codex-subscription",
    "stream": true,
    "input": "Reply exactly: SUBI_CURL_OK"
  }'
```

预期 SSE 里包含：

```text
SUBI_CURL_OK
data: [DONE]
```

Seller 机器日志应出现：

```text
seller-agent codex request done: request_id=... bytes=... duration=...
```

## 8. Buyer Codex CLI 配置

Buyer 机器不需要安装 seller-agent，只需要安装 Codex CLI。

关键点：Buyer 侧不要新增 Subi 专用客户端环境变量名。我们要做的是把 Subi 的值填进 OpenAI-compatible 客户端原本读取的官方兼容变量：

```text
OPENAI_BASE_URL = Subi Gateway 的 /v1 endpoint
OPENAI_API_KEY  = Subi buyer key，不是 OpenAI 官方 API key
```

`SUBI_BUYER_API_KEY` 只是本操作书在 Server/Gateway 配置阶段用来保存测试密钥值的临时 shell 变量，不是 buyer 客户端要读取的变量名。到了 Buyer 机器上，要把这段 key 的值写进 `OPENAI_API_KEY`。

Codex CLI 的 base URL 在本次实验里通过 `model_providers.subi.base_url` 显式指定，但取值来自 `OPENAI_BASE_URL`。也就是说，概念上仍然是把 OpenAI Base URL 的值改成 Subi Gateway。

一次性命令测试：

```bash
export OPENAI_BASE_URL="http://<SERVER_HOST>:18080/v1"
export OPENAI_API_KEY="<Subi buyer key>"

printf '' | codex exec --json \
  --ignore-user-config \
  --skip-git-repo-check \
  --sandbox read-only \
  -m gpt-5.5 \
  -c 'model_provider="subi"' \
  -c 'model_providers.subi.name="Subi"' \
  -c "model_providers.subi.base_url=\"${OPENAI_BASE_URL}\"" \
  -c 'model_providers.subi.env_key="OPENAI_API_KEY"' \
  -c 'model_providers.subi.wire_api="responses"' \
  -c 'model_providers.subi.supports_websockets=false' \
  'Reply exactly: SUBI_BUYER_CODEX_OK'
```

预期输出：

```json
{"type":"item.completed","item":{"type":"agent_message","text":"SUBI_BUYER_CODEX_OK"}}
```

交互式 Buyer 体验：

```bash
export OPENAI_BASE_URL="http://<SERVER_HOST>:18080/v1"
export OPENAI_API_KEY="<Subi buyer key>"

codex \
  -m gpt-5.5 \
  -c 'model_provider="subi"' \
  -c 'model_providers.subi.name="Subi"' \
  -c "model_providers.subi.base_url=\"${OPENAI_BASE_URL}\"" \
  -c 'model_providers.subi.env_key="OPENAI_API_KEY"' \
  -c 'model_providers.subi.wire_api="responses"' \
  -c 'model_providers.subi.supports_websockets=false'
```

如果希望长期使用，可以写入 Buyer 机器的 `~/.codex/config.toml`。这里的 `base_url` 要和 `OPENAI_BASE_URL` 的值保持一致，`env_key` 必须继续指向 `OPENAI_API_KEY`：

```toml
[profiles.subi]
model = "gpt-5.5"
model_provider = "subi"

[model_providers.subi]
name = "Subi"
base_url = "http://<SERVER_HOST>:18080/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
supports_websockets = false
```

之后启动：

```bash
export OPENAI_BASE_URL="http://<SERVER_HOST>:18080/v1"
export OPENAI_API_KEY="<Subi buyer key>"
codex --profile subi
```

## 9. 停止与重启

Server：

```bash
sudo systemctl restart subi-gateway
sudo journalctl -u subi-gateway -f
```

Seller：

```bash
pkill -f seller-agent
```

重启 Seller Agent 后，Gateway 会重新识别在线节点。

## 10. 故障排查

### Gateway health 不通

检查服务：

```bash
sudo systemctl status subi-gateway --no-pager
sudo journalctl -u subi-gateway -n 100 --no-pager
```

检查监听：

```bash
ss -lntp | grep 18080
```

检查云防火墙和系统防火墙是否都放行了 `18080`。

### Seller Agent 连不上 Gateway

确认 WS URL：

```bash
echo "$GATEWAY_WS"
```

确认 token 一致：

```bash
grep SUBI_SELLER_NODE_TOKEN /opt/subi/subi-gateway.env
```

如果 Gateway 使用 HTTPS，Seller 必须使用 `wss://.../api/v1/subi/seller/agent/ws`。

### Buyer 返回 `no available seller node`

说明 Gateway 没有在线 Seller，或 Seller 心跳过期。

检查 Seller Agent 是否还在运行，Gateway 日志里是否有 seller connected/disconnected。

### Buyer 返回 `seller node is busy`

MVP-0 默认单 seller 单并发。等待上一个请求完成，或启动第二个 seller-agent。

### Seller 侧 Codex 报 `Not logged in`

在 Seller 机器重新登录：

```bash
codex login --device-auth
codex login status
```

必须显示 `Logged in using ChatGPT`。

### Buyer Codex CLI 走公网 tunnel 502

临时 tunnel 对 Codex CLI 的长请求和较大 request body 不稳定。正式实验建议：

- 直接使用 Server 的公网 `18080`。
- 或者使用 Caddy/Nginx 做 HTTPS 反代。
- 不建议用 localtunnel 作为正式验收路径。

## 11. 当前 MVP-0 限制

- `codex-exec` 模式不是模型原生 token 级流式；它先拿到完整 Codex CLI 输出，再包装成 Responses SSE。
- 当前只适合验证订阅态消费和 P2P 转发，不是最终 Claude Code/Sub2API 兼容形态。
- Gateway 使用内存 registry，重启后 sticky session 会丢失。
- 默认单 seller 单并发。
- Seller 侧执行的是本机 Codex CLI，真实生产需要更严格的隔离和任务生命周期管理。
