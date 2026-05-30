# Subi Seller Market PRD

版本：v0.1

状态：草案

范围：卖家 Market Web 页面、卖家客户端下载入口、卖家接入配置、卖家收益与节点状态展示。当前后端已具备基础 seller earning ledger；本文档不实现合约、真实提现和 GUI 客户端，只定义页面与 MVP 后端需求。

## 1. 背景

Subi 当前代码已经跑通最小 P2P 链路：

```text
Buyer Codex / OpenAI-compatible client
-> Subi Gateway
-> Seller Agent
-> Seller local Codex subscription runtime
-> Subi Gateway
-> Buyer
```

卖家 Market 的第一阶段目标不是做传统订单市场，而是让卖家把自己的订阅和设备接入 Subi，并明确看到：

```text
我的节点是否在线
我卖出的并发 / 时间段是多少
我今天赚了多少
我帮助了多少买家请求
我应该下载哪个客户端
我应该按哪个 Provider Tab 配置本地订阅
```

Subi 的卖家不是人工接单者。卖家只提供订阅能力和在线设备，订单由平台统一调度。

参考 `https://derouter.network` 的功能分层，Seller Market 需要强化卖家转化，而不只是展示后台数据：

```text
月收益估算
三步开始提供能力
Provider 授权 / 接入
自动路由赚钱
分账比例
结算状态
Live Network 指标
错误 / 故障说明
```

Subi 可以高度借鉴这些功能模块和页面节奏。差异点是：

```text
当前优先做本机 Seller Agent 长连接
当前已验证 Codex subscription runtime
卖家不出售账号所有权，只出售订阅使用权和在线设备的请求处理能力
结算目标使用 Subi Coin / 平台账本，而不是直接照搬 USDC Solana 结算
```

## 2. 当前代码事实

当前仓库已经实现：

```text
Seller Agent WebSocket 长连接
Seller node token 鉴权
seller max_concurrency / active request 追踪
Seller Agent worker pool
codex-login 纯网络 upstream
删除 codex-app-server / codex-exec / http 本地执行 upstream
Gateway access log
sticky seller routing
```

当前仓库尚未实现：

```text
卖家账户系统
卖家收益账本
卖家提现
卖家 Web API
卖家 GUI 客户端
客户端下载签名 / 自动更新
Provider 绑定流程
真实在线时间统计
真实帮助买家数量统计
真实 Subi Coin 结算
```

因此本页第一版先完成产品结构；当前后端已能提供节点、earnings、requests 和 balance 的基础真实接口，uptime 仍待补。

## 3. 产品定位

Seller Market 是卖家的供给控制台。

Subi 的核心 slogan：

```text
给 coding 兄弟便宜 token 用。
开着电脑就能赚钱。
```

对外英文表达：

```text
Cheap tokens for coding builders.
Earn with your computer on.
```

它要让卖家在 3 分钟内完成：

```text
1. 下载 Seller Client
2. 选择自己的订阅 Provider
3. 复制配置命令
4. 启动后台进程
5. 看到节点在线
6. 设置接入数和可运行时间段
7. 查看实时收益与请求记录
```

页面不做：

```text
卖家挑单
卖家报价
高价订单筛选
任务类型筛选
买家筛选
复杂收益策略
营销长文
```

但 Seller Market 必须承担卖家转化任务。第一屏要打破三个顾虑：

```text
账号风控：强调单账号对应单设备 / 单 IP / 本地订阅态，不做账号池共享登录。
机器安全：强调买家工具在买家本机执行，卖家侧只提供模型响应通道，并有 sandbox / workdir / 并发限制。
收益动机：强调客户端常驻后平台自动派单，卖家无需接单、报价或维护买家。
```

对外文案可以写“低风险”“单机单账号”“有限权限”“后台自动赚钱”，但不建议写“绝对不会封控”或“绝对不会被打穿”。产品可以承诺机制和边界，不应该承诺无法证明的 0 风险。

## 4. 用户角色

### 4.1 Seller

卖家关心：

```text
怎么把订阅接入 Subi
客户端有没有在线
平台给我分配了多少请求
我当前赚了多少钱
什么时候能提现
我的电脑会不会被分配太多并发
我能不能只在某个时间段出售
```

卖家能控制：

```text
上线 / 下线
最大接入数 / worker 数
运行时间段
保留自用额度
设备名称
Provider 接入方式
```

卖家不能控制：

```text
单请求价格
模型价格倍率
订单类型
具体买家
是否只接高价订单
```

### 4.2 Platform

平台负责：

```text
分配请求
计量有效请求
统计收益
限制并发
记录失败和延迟
按小时结算卖家收益
```

## 5. MVP 目标

MVP-1 Seller Market 必须覆盖：

```text
卖家状态总览
Seller Client 下载入口
CLI / GUI 两种客户端入口
Provider Tabs 配置教程
节点接入数设置
运行时间段设置
收益总览
请求记录
提现入口占位
```

MVP-1 不做：

```text
链上提现
真实 Subi Coin 合约交互
收益审计报表
多设备复杂编排
团队账号
邀请返佣
卖家评级公开页
```

## 6. 信息架构

卖家 Market 采用多页结构，保持 4 个主导航：

```text
Home
Client
Earnings
API
```

页面映射：

```text
Home: index.html，负责供给端转化、slogan、月收益估算、三步引导、Live Network。
Client: client.html，负责客户端下载、Provider Tabs、seller-agent 配置和节点状态。
Earnings: earnings.html，负责收益估算、分账、提现占位和 Request Fill 流水。
API: api.html，负责买家便宜 token 接入教程、卖家节点 API 示例和错误说明。
```

### 6.1 Overview

Home 第一屏是卖家转化页，不是后台 dashboard。

必须展示：

```text
月收益估算
节点在线状态
可提现余额
今日收益
当前活跃请求
帮助过的买家请求数
当前接入数 / 最大接入数
运行时间段
```

核心动作：

```text
Start Providing
Download Client
Copy Start Command
Go Offline / Go Online
```

第一屏必须有 Trust / Objection 模块：

```text
One account, one machine：订阅登录态保留在卖家设备上。
No buyer shell：买家 Read / Edit / Bash 仍在买家本机执行。
Bounded runtime：Seller Agent 使用 workdir、sandbox、max_concurrency 和运行时间段。
Passive income：保持客户端在线，平台自动路由请求。
```

第一屏可以有收益估算卡：

```text
subscription_cost
expected_monthly_gross
platform_fee
estimated_net
```

收益估算必须标注为 estimate；真实收益和请求流水来自 Request Fill 账本。

### 6.2 Client

Client 区域负责卖家软件下载。

入口：

```text
macOS GUI
Windows GUI
Linux CLI
Docker / VPS
```

MVP 文案必须明确：

```text
GUI 客户端是目标形态，当前静态原型仅展示入口。
CLI 形态对应当前仓库的 seller-agent。
```

客户端目标形态类似 Clash：

```text
后台常驻
菜单栏 / 托盘状态
一键上线 / 下线
自动重连
开机启动
本地日志
收益状态
Provider 登录状态
```

推荐的三步上手流程：

```text
1. Log in / create wallet
   用邮箱登录，平台自动创建或绑定钱包。

2. Connect provider
   在本机完成 Codex / Claude Code / Local HTTP provider 接入。

3. Earn automatically
   Seller Client 保持在线，Subi Gateway 自动分配请求并累计收益。
```

### 6.3 Providers

Providers 是卖家接入的核心页面。

必须用 Provider Tabs，而不是长教程。

第一版 Tabs：

```text
Codex Subscription
Claude Code Subscription
Local HTTP Upstream
VPS Headless
```

每个 Tab 固定结构：

```text
1. 状态
2. 需要准备什么
3. 可复制配置命令
4. 可复制启动命令
5. 限制说明
```

#### 6.3.1 Codex Subscription

当前已验证路径，作为推荐 Tab。

关键原则：

```text
卖家不需要提供 OpenAI API key。
卖家使用本机已经登录的 Codex 订阅态。
Seller Agent 只读取 Codex 登录态并发网络请求，不启动本机 Codex agent runtime。
```

推荐配置：

```bash
export SUBI_GATEWAY_WS_URL="wss://api.subi.xyz/api/v1/subi/seller/agent/ws"
export SUBI_SELLER_NODE_TOKEN="seller_node_xxx"
export SUBI_NODE_ID="seller-macbook-001"
export SELLER_UPSTREAM_MODE="codex-login"
export SELLER_CODEX_WORKERS=1
export SELLER_CODEX_HOME="$HOME/.codex"
export SELLER_CODEX_BASE_URL="https://chatgpt.com/backend-api/codex"
```

启动：

```bash
./seller-agent
```

#### 6.3.2 Claude Code Subscription

产品目标形态，当前代码尚未端到端实现。

页面必须标注：

```text
Coming soon
```

该 Tab 只做等待名单 / 未来配置占位，不能暗示当前已经可用。

#### 6.3.3 Local HTTP Upstream

暂停开放。当前明确边界是只能使用卖家本机 Codex 登录态发网络请求，不能走本地 HTTP upstream 或外部 API key。

页面可以保留入口占位，但真实买家流量只调度 `codex-login` 节点。

#### 6.3.4 VPS Headless

适合 24 小时供给。

页面强调：

```text
VPS 只是运行环境，不改变 Provider。
推荐搭配 Codex Subscription 或 Local HTTP Upstream。
```

## 7. 供给控制

卖家能配置的运行边界：

```text
max_concurrency
daily_available_hours
self_reserve_percent
auto_start
quiet_hours
```

UI 组件：

```text
并发用 Stepper 或 Slider
时间段用 Time Range
上线状态用 Toggle
自用保留用 Slider
```

MVP 中时间段等高级设置先只作为 Web 状态，不要求立刻写入 Gateway。

后端落地时，Gateway 必须尊重 `max_concurrency`，并在 Seller Agent hello 中上报。

## 8. 收益与结算

卖家收益展示要回答：

```text
今天赚了多少
本小时赚了多少
可提现多少
待结算多少
成功请求多少
失败请求是否不计费
```

MVP 页面字段：

```text
monthly_estimate
provider_platform_split
available_subi
pending_subi
today_subi
hourly_estimate
successful_requests
failed_requests
active_buyers_helped
```

提现文案：

```text
Hourly settlement target
```

不能写成已经支持链上提现，除非后端和合约已经实现。

分账展示：

```text
MVP 可展示目标分账比例，例如 Seller 80% / Platform 15% / Reserve 5%。
如果后续改为 75/25 或其他比例，必须由后端配置驱动，不写死在页面。
```

## 9. Activity

Activity 页面展示卖家侧请求流水。

字段：

```text
request_id
time
buyer_hash
status
duration_ms
time_to_first_chunk_ms
bytes_out
earning
error
```

卖家不应该看到：

```text
买家完整 prompt
买家代码文件
买家真实身份
买家项目路径
```

当前技术链路里 seller upstream 可能能接触 prompt 内容；但 Seller Market UI 不展示这些内容。

## 10. 后端接口需求

以下接口是 Seller Market MVP 需求，不代表当前代码已经实现。

```text
GET  /api/web/seller/me
GET  /api/web/seller/nodes
POST /api/web/seller/nodes/:id/online
POST /api/web/seller/nodes/:id/offline
PATCH /api/web/seller/nodes/:id/settings
GET  /api/web/seller/downloads
GET  /api/web/seller/provider-configs
GET  /api/web/seller/estimate
GET  /api/web/seller/earnings
GET  /api/web/seller/activity
POST /api/web/seller/payouts
```

核心数据对象：

```text
Seller
SellerNode
SellerClientBuild
SellerProviderConfig
SellerSupplySettings
SellerEstimate
SellerEarningsWallet
SellerRequestFill
SellerPayout
```

## 11. 视觉设计

Seller Market 第一版采用 DeRouter-like provider acquisition landing，而不是传统 dashboard。

核心页面节奏：

```text
顶部导航：Logo / Home / Client / Earnings / API / 语言 / Login
全屏首屏：背景图 + 中心大标题 + 双 CTA + 月收益估算卡
How it works：三步开始赚钱
Trust section：解释账号风险和机器边界
Seller Client：Provider Tabs + 可复制本地进程命令
Live Network：在线 Provider、24h 请求、分账比例
Footer：协议 / Docs / Client
Mobile bottom nav：Home / Client / Earn / API / Account
```

Seller Market 不再延续 Buyer Web 的粉色控制台风格，而使用更适合卖家转化的暖色、轻玻璃、艺术背景和低密度排版：

```text
暖米色背景
棕色品牌色
真实艺术图作为首屏背景
中心化大标题
月收益估算卡
三步引导卡
轻量玻璃质感
圆角不超过 8px
配置命令必须可复制
```

页面允许大 Hero，因为卖家页首先承担供给端转化任务。Hero 下面必须尽快给出 Client 配置入口，不能只停留在营销文案。

基于 `taste-skill` 审查后的约束：

```text
Hero 只保留一句价值主张、短副标题和 CTA，不在首屏塞收益细节。
收益估算卡下移到第二屏。
Home 页面最多保留一个 eyebrow。
避免三等分数字步骤卡，步骤直接使用 Install / Connect / Earn。
不要手写 SVG 图标，品牌标记先用文字标识，后续替换为正式 logo asset。
Client 页面必须有真实视觉资产，不能只放代码块和卡片。
全站主 CTA 统一使用 Start Providing。
支持 prefers-color-scheme dark 的基础 token。
```

## 12. 验收标准

静态原型验收：

```text
页面可直接打开
第一屏能看到节点状态、收益、请求数和接入数
能看到 Client 下载入口
Providers 使用 Tab 展示不同提供商
Codex Subscription Tab 明确不需要 OpenAI API key
Claude Code Tab 明确标注 Coming soon
复制按钮可用
上线 / 下线、并发、时间段控件有可见状态变化
收益和请求流水读取 Gateway 真实接口
视觉上与 Buyer Web 属于同一产品体系
```

后续接真实后端验收：

```text
Seller 登录后能看到真实节点
Seller Agent 在线状态能实时更新
max_concurrency 能写入并影响调度
收益来自 Request Fill 账本
失败请求不计收益
提现入口只在小时结算可用时开放
```

## 13. 落地顺序

建议分 4 步：

```text
1. Seller Market 页面
   Home / Client / Earnings / API 多页结构，优先读取真实接口。

2. Seller node 状态接入
   读取 Gateway 在线节点、active requests、max_concurrency。

3. Seller settings
   支持上线 / 下线、max_concurrency、运行时间段写入。

4. Earnings ledger
   引入 Request Fill 和小时结算账本，再开放提现入口。
```
