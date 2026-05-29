# Subi PRD

版本：v0.2

状态：讨论稿

## 0. 一句话定义

Subi 是一个 P2P 顶级模型使用权交易市场，本质是一个撮合交易所。

```text
买家用加密货币付费，通过本地 coding agent 间接使用卖家机器上的 Claude / Codex 订阅态能力。
卖家保持客户端在线、贡献本地订阅凭据即可赚取加密货币收益。
平台负责撮合、路由、计量、结算，并抽取手续费。
```

相比中心化 API 中转或平台自营售卖额度，Subi 的差异是：

```text
平台不持有上游账号，也不自己买卖模型额度。
模型调用使用卖家本地的 Claude / Codex 凭据，凭据不出卖家设备。
平台只做撮合、路由、计量、加密货币结算和信誉。
```

## 1. 系统架构总览

对应整体链路（见架构图）：

```text
Buyer 设备
  coding agent: codex / claude code / opencode
  + Subi 客户端（一键写入 base_url 与 buyer key）
        |  coding agent 携带 Subi buyer key 发起请求
        v
Subi 中心服务器  subi.network
  鉴权 / 撮合 / 路由 / 计量 / 结算 / 手续费
        |  分发单次请求
        v
Seller 设备
  Subi 客户端 / daemon
  从本地系统环境读取 Claude / Codex 凭据
        |  直接请求 vendor 接口（可流式）
        v
Vendor
  OpenAI / Anthropic 官方接口
```

核心原则：

```text
买家本机继续运行原生 coding agent，工具执行（Read / Edit / Bash / Apply）发生在买家本机。
中心服务器只接管模型请求通道，不改写买家 coding agent 的工具执行逻辑。
卖家客户端只提供模型响应通道，凭据留在卖家本地，不上传中心服务器，也不接触买家本机。
```

## 2. 三个核心组件

Subi 由三个组件构成：

```text
Subi 客户端（buyer / seller 通用 GUI）
Subi 中心服务器 / 网站（subi.network）
Vendor 官方接口（OpenAI / Anthropic）
```

### 2.1 Subi 客户端

统一一个带 GUI 的桌面客户端，buyer 和 seller 都安装同一个程序，按登录身份切换工作模式。

#### Seller 模式

卖家登录后，客户端在卖家设备上：

```text
登录卖家账户，绑定收款钱包地址
从本地系统环境读取 Claude / Codex 凭据（如 codex / claude code 已登录态、环境变量）
与中心服务器保持长连接，上报在线状态、负载、可用额度边界
接收中心服务器分发的单次模型请求
用本地凭据直接请求 vendor 官方接口（OpenAI / Anthropic），可流式
把响应流式回传给中心服务器
本地展示实时收益、累计收益、在线时长、请求数、成功率
```

卖家可在客户端配置：

```text
上线 / 下线
每日最大可出售额度
最大并发
保留自用额度
是否开机自启动
收款钱包地址
```

凭据安全要点：

```text
卖家凭据只在卖家本地使用，绝不上传中心服务器。
客户端对凭据本地加密存储，请求 vendor 时本地注入。
卖家可随时在客户端查看凭据使用范围并一键停用。
```

#### Buyer 模式

买家登录后，客户端在买家设备上：

```text
登录买家账户，展示加密货币余额与实时消耗
拉取买家 key 和中心服务器请求地址
一键把 base_url 和 buyer key 写入本地 coding agent 配置
检测本地已安装的 coding agent（codex / claude code / opencode）并适配各自配置格式
本地展示实时消耗、累计消耗、请求数、平均延迟
```

买家也可以不装客户端，直接在网站复制请求地址和 key，手动填进 coding agent（见 5 节）。

#### 推荐技术栈

客户端建议用 Go 写核心、Web 技术写界面，理由是现有 `seller-agent` 已经是 Go，可直接复用转发、WebSocket、凭据注入逻辑。

```text
首选：Wails（Go 核心 + Web 前端）
  - 复用现有 Go 代码（seller-agent / apicompat / WebSocket envelope）
  - 体积小、原生系统能力强，便于读取本地凭据和写入 coding agent 配置
  - 前端用 React + TypeScript + Tailwind

备选：Tauri（Rust 核心 + Web 前端）
  - 体积最小、安全模型好，但需要把 Go 转发逻辑用 Rust 重写或以 sidecar 方式调用现有二进制

不推荐：Electron
  - 开发最快，但体积大、内存占用高，对一个常驻挂机的卖家客户端不划算
```

实时收益 / 消耗的展示通过中心服务器的计量数据推送（WebSocket / SSE）刷新。

### 2.2 中心服务器 / 网站（subi.network）

中心服务器是撮合交易所，对外是网站，对内是网关。

网站负责：

```text
买家 / 卖家注册、登录、账户管理
为买家生成、吊销、轮换 API key
展示买家余额、消耗、卖家收益、提现记录
加密货币充值入口与收款钱包绑定
下载 Subi 客户端
```

网关负责：

```text
接收买家 coding agent 请求，校验 buyer key
根据负载自动选择在线卖家节点（sticky routing）
把单次请求分发给卖家客户端，保持流式连接
把卖家响应原样写回买家
记录请求级 access log（request_id / seller_node / session_hash / status / duration / bytes）
链下实时计量 token 用量与成本，扣买家余额、记卖家收益
```

卖家在网站注册后，只需登录客户端即可开始赚钱；买家在网站注册后可直接拿到请求地址和 key，或用客户端一键配置。

### 2.3 Vendor

Vendor 是 OpenAI / Anthropic 官方接口。请求由卖家客户端用卖家本地凭据直接发起，平台不持有也不中转 vendor 凭据。

## 3. 用户角色

```text
买家 Buyer
卖家 Seller
平台 Subi
```

### 3.1 买家

买家是模型能力的需求方，用加密货币付费，在本地 coding agent 中使用顶级模型。

核心诉求：

```text
以低价使用顶级模型
接近原生 coding agent 体验
不用购买完整月度订阅
按实际用量消耗加密货币余额
不关心背后路由到哪个卖家
请求稳定、不断流、扣费清晰
```

基础流程：

```text
注册 Subi
-> 用加密货币充值余额
-> 获取请求地址和 buyer key（或用客户端一键配置）
-> 本地运行 coding agent
-> 请求进入中心服务器
-> 路由到卖家节点
-> 响应返回本地 coding agent
-> 本机执行文件读取、代码修改、Bash、diff / apply
-> 按实际用量扣除余额
```

### 3.2 卖家

卖家是模型能力的供给方，拥有一个或多个模型订阅，通过保持客户端在线把订阅能力接入市场。

核心诉求：

```text
把闲置模型订阅变现
保持客户端在线即可赚钱
无需主动服务买家、无需挑单、无需设置价格
收益实时可见
有有效消耗就能定期提现到加密钱包
```

基础流程：

```text
注册 Seller 身份
-> 安装 Subi 客户端
-> 客户端读取本地 Claude / Codex 凭据
-> 绑定收款钱包，设置运行边界
-> 保持客户端在线
-> 接收中心服务器自动分配的请求
-> 用本地凭据请求 vendor 并返回响应
-> 按周期结算加密货币收益
-> 提现到钱包
```

卖家不能配置：

```text
单请求价格
模型价格倍率
订单筛选 / 买家筛选 / 任务类型筛选
高价优先接单
```

### 3.3 平台

Subi 是市场、网关、结算和信誉系统。

平台职责：

```text
维护买家和卖家账户
为买家生成 API key
分发 Subi 客户端
接收 coding agent 请求并自动选择卖家节点
转发请求和流式响应
链下统计用量和费用，扣买家余额
通过公链转账向卖家结算，抽取手续费
处理失败、退款、限流、信誉和异常节点
```

## 4. 核心交易对象

Subi 上交易的对象是：

```text
卖家模型订阅能力的一次可用调用份额。
```

它不是账号所有权，不是节点控制权，也不是传统云算力。

市场最小成交单位是一次有效请求 Request Fill，记录：

```text
request_id
buyer_id
seller_id
model_tier
input_tokens
output_tokens
cache_tokens
request_status
latency
cost            # 以平台计价币种（USD / 稳定币）计
seller_earning
platform_fee
```

## 5. 买家端产品体验

买家有两条配置路径。

路径 A：客户端一键配置（推荐）

```text
安装 Subi 客户端 -> 登录 -> 一键写入 base_url 和 buyer key 到本地 coding agent
```

路径 B：手动配置

不改变客户端读取的环境变量名称，只改变值：

```text
官方 Base URL 环境变量 -> 填中心服务器 URL
官方 API key 环境变量  -> 填 Subi buyer key
```

```bash
# Claude Code
export ANTHROPIC_BASE_URL="https://api.subi.network"
export ANTHROPIC_AUTH_TOKEN="subi_xxx"

claude
```

```bash
# Codex CLI / OpenAI-compatible client
export OPENAI_BASE_URL="https://api.subi.network/v1"
export OPENAI_API_KEY="subi_xxx"

codex \
  -c 'model_provider="subi"' \
  -c 'model_providers.subi.name="Subi"' \
  -c "model_providers.subi.base_url=\"${OPENAI_BASE_URL}\"" \
  -c 'model_providers.subi.env_key="OPENAI_API_KEY"' \
  -c 'model_providers.subi.wire_api="responses"' \
  -c 'model_providers.subi.supports_websockets=false'
```

这里的 `OPENAI_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 值是 Subi buyer key，不是 vendor 官方 key。买家的官方 key 不参与 Subi P2P 链路。

买家端执行逻辑：

```text
coding agent 运行在买家本机
买家本机保存 session，执行 Read / Edit / Bash / Apply 等工具
Subi 只接管模型请求通道
卖家节点只负责生成模型响应
```

Subi 支持 sticky routing：

```text
同一个买家 / API key / session 优先路由到同一卖家节点
```

目的：提升响应风格一致性、稳定 prompt cache、便于排错和计费。

## 6. 卖家端客户端

见 2.1 Seller 模式。要点重申：

```text
凭据从卖家本地系统环境读取，本地加密存储，绝不上传中心服务器。
客户端用卖家本地凭据直接请求 vendor，不经过中心服务器中转 vendor 凭据。
客户端不接触买家本机，不执行买家 Bash 命令。
卖家不挑单、不报价、不选择任务类型。
```

## 7. 路由与调度

Subi 采用平台调度型 P2P 模式。中心服务器根据以下维度自动分配请求：

```text
节点在线状态
当前负载
每日剩余额度
并发容量
健康分
最近失败率
响应延迟
sticky session 需求
模型等级
```

调度目标：

```text
优先保证买家请求成功
均衡消耗卖家额度
避免单个卖家过载
让稳定卖家获得更多收益
让异常卖家自动降权
```

异常处理：

```text
请求失败不结算
超时请求自动切换卖家
高错误率节点降权
连续异常节点暂停派单
恢复健康检查后重新进入供给池
```

## 8. 计价与定价

平台内以统一计价币种结算，建议用 USD 或稳定币（USDC）作为计量单位，避免公链币价波动直接影响账单。

基础计价公式：

```text
cost =
input_tokens * input_rate
+ output_tokens * output_rate
+ cache_tokens * cache_rate
+ request_base_fee
```

买家价格由平台统一决定，不由卖家报价。

收益拆分（MVP 固定，可后续调整，但不开放卖家手动改价）：

```text
买家支付 100%
卖家获得 80%
平台抽成 15%
风险准备金 5%
```

```text
seller_earning = cost * 0.80
platform_fee   = cost * 0.15
reserve        = cost * 0.05
```

## 9. 加密货币支付与结算

Subi 不发行自有代币，完全采用主流公链加密货币收付。

### 9.1 买家充值

```text
买家选择公链币种（如 USDC / ETH / BTC / SOL 等）
向平台指定收款地址转账
平台确认链上到账后，按到账时汇率折算成平台内余额（计价币种计）
余额可用于调用模型
```

充值入口与支持币种由平台运营，优先支持稳定币以降低折算波动。

### 9.2 链下计量、链上结算

请求频率高、计量细、流式响应复杂，因此不做每笔请求上链。

```text
链下实时计量每次 Request Fill 的 token 用量与成本，扣买家余额、记卖家收益
平台按周期（如按小时 / 按日）汇总卖家应得收益
平台通过公链转账（优先稳定币）把收益打到卖家绑定的钱包地址
```

### 9.3 卖家提现

```text
收益按周期累计到卖家账户余额
卖家在客户端 / 网站发起提现到绑定钱包
平台校验后通过公链转账支付，扣除必要的链上手续费
```

卖家体感目标：

```text
有有效消耗就能定期提现到自己的加密钱包。
```

### 9.4 手续费

平台收入来自买家支付与卖家收益之间的差价（见 8 节拆分），加上必要时的充值 / 提现链上手续费转嫁。平台不靠长期压款盈利，而靠撮合规模和稳定供给。

### 9.5 风控不靠长期压款

```text
失败请求不结算
异常节点立刻降权
高错误率自动停止派单
新卖家限流，新卖家提现上限
大额提现审核
重复异常冻结当前周期收益
```

## 10. 开源策略

核心可信组件开源，平台运营系统闭源。

建议开源：

```text
Subi 客户端核心（凭据本地使用、转发、计量上报逻辑）
CLI / SDK
请求协议文档
加密货币结算与对账验证工具
```

不建议开源：

```text
路由调度策略
风控和反刷规则
卖家健康评分算法
价格和补贴策略
平台后台管理系统
私有上游适配细节
异常检测和封禁策略
```

开源目标：

```text
让卖家相信客户端不会偷凭据或滥用机器
让买家相信计量和结算可对账
保留平台的调度、风控和运营能力
```

## 11. 阶段路线

### MVP-0：最小转发链路（已验证）

```text
买家 coding agent -> 中心服务器 -> 卖家 daemon -> 卖家本机 Claude / Codex 订阅 -> 原路返回
```

验证目标：

```text
买家 coding agent 能连上中心服务器
中心服务器能看到在线卖家节点
请求能被分配到卖家节点
卖家能用本地凭据拿到 vendor 响应
streaming 不断流
失败时返回可读错误
同一买家连续请求 sticky 到同一卖家
```

详见实验报告 `docs/archive/SUBI_MVP0_EXPERIMENT_REPORT_CN.md`。MVP-0 不含支付、结算、市场机制。

### MVP-1：Session 上下文迁移（进行中）

中心服务器内存托管 session 文本历史，卖家尽量无状态。

目标：

```text
同一个 buyer session 从 seller-001 切到 seller-002 后，仍能记住前文文本对话。
```

Session ID 识别优先级：

```text
metadata.session_id
metadata.user_id
x-session-id
x-stainless-session-id
conversation_id
previous_response_id
buyer-key-hash fallback
```

配置开关：

```bash
SUBI_SESSION_CONTEXT_ENABLED=true
SUBI_SESSION_MAX_TURNS=20
SUBI_SESSION_MAX_CHARS=20000
```

只迁移文本对话上下文；不迁移卖家文件系统状态、shell 目录、后台进程、临时文件、vendor 内部 session id、tool cache。

验收用例：

```text
1. Buyer 第一句：记住暗号是 blue-lobster
2. 请求落到 seller-001
3. 停 seller-001，启动 seller-002
4. Buyer 第二句：我的暗号是什么？
5. 请求落到 seller-002，返回 blue-lobster
```

### MVP-2：客户端 GUI 与账户体系

```text
统一 GUI 客户端（buyer / seller 模式）
买家 / 卖家注册、登录
买家一键配置 coding agent
卖家本地凭据读取与加密存储
实时收益 / 消耗展示
中心服务器请求级 access log
```

### MVP-3：加密货币支付与结算

```text
买家加密货币充值与余额
链下计量与扣费
卖家收益结算与公链转账提现
平台手续费
基础健康分与异常节点降权
```

### 暂不做

```text
卖家自由报价 / 挑单
远程 terminal / 远程执行买家命令
企业隐私计算 / TEE
完全去中心化调度
每笔请求上链
自有代币与复杂 tokenomics
```

## 12. 核心指标

买家侧：

```text
API key 创建成功率
coding agent 配置成功率
请求成功率
首 token 延迟
流式中断率
平均价格
复购率
```

卖家侧：

```text
新增卖家数 / 在线卖家数
卖家平均在线时长
每小时有效请求数
每小时收益
提现成功率
卖家留存率
异常节点比例
```

平台侧：

```text
总请求数 / 总 token 消耗
买家总消耗 / 卖家总收益
平台手续费收入
风险准备金余额
供需匹配率
路由失败率
加密货币充值 / 提现成功率
```

## 13. 待讨论问题

1. 平台计价币种用 USD 记账还是直接用某种稳定币（USDC）记账？
2. 买家充值支持哪些公链和币种？是否自建收款地址还是接第三方支付网关？
3. 卖家提现的最小周期和最小金额？链上手续费由谁承担？
4. 客户端读取本地 Claude / Codex 凭据的具体来源（环境变量 / 登录态文件）如何在各平台统一？
5. 卖家节点如何做健康检查和自动恢复？
6. 如何检测卖家节点返回异常、空响应或低质量响应？
7. 新卖家的提现上限和限流策略？
8. 风险准备金比例是否固定为 5%？
9. 是否需要平台自营节点作为冷启动供给？
10. 客户端技术栈最终选 Wails 还是 Tauri？
