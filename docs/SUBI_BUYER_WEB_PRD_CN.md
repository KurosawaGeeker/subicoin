# Subi Buyer Web PRD

版本：v0.1

状态：草案

范围：只覆盖买家 Web。卖家 Web、卖家客户端、Subi Coin、链上合约、提现和卖家结算不在本文档范围内。

## 1. 背景

Subi 当前核心链路已经跑通：

```text
Buyer Codex / OpenAI-compatible client
-> Subi Gateway
-> Seller Agent
-> Seller local Codex / upstream
-> Subi Gateway
-> Buyer
```

买家 Web 的第一阶段目标不是做一个复杂市场，而是给买家一个干净、可信、可操作的控制台：

```text
购买额度
复制配置
完成自检
开始使用
查看消耗
```

参考站点 `https://cc.yoouu.cn` 的可借鉴点：

```text
按客户端 / 提供商拆分配置教程
每个教程给可复制命令
覆盖 Codex、Claude Code、OpenAI-compatible、Cursor / Continue 等入口
```

参考站点的问题：

```text
没有 credit / 余额 / 消耗闭环
颜色太多，视觉焦点分散
教程、FAQ、工具入口混在一起，信息架构很乱
页面更像教程集合，不像专业控制台
黑色霓虹、动态渐变、彩色徽章过多，不适合 Subi 的交易平台定位
```

Subi Buyer Web 要反过来做：

```text
白色为底
粉色为唯一主色
每个页面只解决一个任务
配置教程必须短、准、可复制
额度余额和请求消耗必须成为第一层信息
```

## 2. 产品定位

Subi Buyer Web 是买家的额度与接入控制台。

买家侧核心价值主张：

```text
无需额外网络配置：买家只配置 Subi endpoint 和 key，不需要自己处理代理链路。
更便宜：用低价 Credits 获取顶级模型使用权。
P2P 新概念：模型供应来自在线卖家节点，而不是传统中心化账号池。
```

买家进入 Web 后，应在 60 秒内完成：

```text
1. 看到账户余额
2. 购买或充值额度
3. 复制自己的 Subi API key
4. 按客户端 Tab 复制配置命令
5. 运行自检，确认请求能通过 Gateway
```

核心体验不是“学习怎么配置各种工具”，而是“我已经买了额度，现在立刻能用”。

## 3. 用户角色

### 3.1 Buyer

买家关心：

```text
余额还有多少
一次请求大概花多少钱
API key 在哪里
Base URL 应该填什么
Codex CLI / Claude Code / OpenAI SDK 怎么配
请求失败时到底是 key 错、URL 错、余额不足，还是没有在线卖家
```

买家不应该被迫理解：

```text
Seller Agent 如何连接
卖家如何结算
Subi Coin 合约
节点调度细节
Gateway 内部实现
```

## 4. MVP 目标

MVP-1 Buyer Web 必须完成：

```text
买家余额展示
额度购买入口
API key 创建 / 查看 / 复制
OpenAI-compatible Base URL 复制
按客户端拆分的配置教程
一键自检
请求记录和扣费记录
```

MVP-1 不做：

```text
卖家后台
卖家客户端下载
卖家收益 dashboard
Subi Coin 链上支付
复杂套餐权益
团队账号
发票
邀请返佣
高级风控配置
复杂模型市场
```

## 5. 信息架构

买家 Web 保持 4 个主导航：

```text
Dashboard
Credits
Setup
Usage
```

### 5.1 Dashboard

Dashboard 是登录后的第一屏，不做营销首页。

第一屏必须展示：

```text
当前余额
今日消耗
默认 API key
默认 Base URL
继续配置按钮
购买额度按钮
```

布局建议：

```text
顶部：Subi logo / 当前余额 / 账户菜单
上方主区：余额卡片 + 今日消耗
中间主区：API key / Base URL 复制区
下方：快速配置入口，按 Provider Tabs 跳转
```

Dashboard 不放：

```text
长篇介绍
复杂 FAQ
多彩功能卡片
卖家收益信息
链上合约解释
内部服务状态卡片
```

### 5.2 Credits

Credits 页面负责购买额度和查看账本。

页面结构：

```text
余额总览
购买额度
充值记录
扣费记录
退款 / 调整记录
```

MVP 阶段额度使用链下账本，不等同于 Subi Coin。

建议文案：

```text
Subi Credits
用于支付模型请求消耗。MVP 阶段为平台内余额，不是链上代币。
```

购买区域保持简单：

```text
100 Credits
500 Credits
2000 Credits
自定义金额，50 Credits 起充
```

MVP 如果支付系统还没接入，可以先支持：

```text
手动创建充值订单
后台确认到账
余额入账
```

### 5.3 Setup

Setup 是买家 Web 最重要的页面。

它只做一件事：让买家把 Subi 的 URL 和 API key 填进自己正在用的客户端。

买家只有一把 Subi buyer API key。不同客户端只是读取的官方环境变量名不同，不代表平台要给用户发多把 key。

Access 区必须同时展示：

```text
SUBI BUYER API KEY：同一把 key，所有客户端复用
OPENAI_BASE_URL：https://api.subi.xyz/v1，用于 Codex CLI / OpenAI SDK / Cursor / Continue
ANTHROPIC_BASE_URL：https://api.subi.xyz，用于 Claude Code
```

客户端映射：

```text
Codex CLI / OpenAI SDK / Cursor:
  OPENAI_BASE_URL = Subi OpenAI-compatible URL
  OPENAI_API_KEY  = Subi buyer API key

Claude Code:
  ANTHROPIC_BASE_URL  = Subi Anthropic-compatible URL
  ANTHROPIC_AUTH_TOKEN = Subi buyer API key
```

Setup 使用 Provider Tabs：

```text
Codex CLI
Claude Code
OpenAI SDK
Cursor / Continue
cURL
```

每个 Tab 的结构必须固定：

```text
1. 需要填入的值
2. 复制配置
3. 测试命令
```

配置教程必须极简，直接给可复制命令。不要写成长教程，不要让用户在页面里找关键字段。

#### 5.3.1 Codex CLI Tab

当前已验证链路优先展示 Codex CLI。

关键原则：变量名使用官方 OpenAI-compatible 客户端会读取的名字，变量值填 Subi 的内容。

```bash
export OPENAI_BASE_URL="https://api.subi.xyz/v1"
export OPENAI_API_KEY="sk-subi_xxx"
```

启动示例：

```bash
codex \
  -c 'model_provider="subi"' \
  -c 'model_providers.subi.name="Subi"' \
  -c "model_providers.subi.base_url=\"${OPENAI_BASE_URL}\"" \
  -c 'model_providers.subi.env_key="OPENAI_API_KEY"' \
  -c 'model_providers.subi.wire_api="responses"' \
  -c 'model_providers.subi.supports_websockets=false'
```

测试命令：

```bash
curl -sS "${OPENAI_BASE_URL}/responses" \
  -H "Authorization: Bearer ${OPENAI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.1-codex",
    "input": "Reply exactly: SUBI_BUYER_OK",
    "stream": false
  }'
```

#### 5.3.2 Claude Code Tab

Claude Code 是产品目标形态。当前代码尚未完成 Claude Code 原生端到端验收，因此页面上必须标注状态：

```text
Coming soon / Anthropic-compatible target
```

配置形态：

```bash
export ANTHROPIC_BASE_URL="https://api.subi.xyz"
export ANTHROPIC_AUTH_TOKEN="sk-subi_xxx"

claude
```

页面文案必须说明：

```text
当前推荐先使用 Codex CLI Tab。Claude Code 原生模式完成验收后会开放。
```

#### 5.3.3 OpenAI SDK Tab

Node.js 示例：

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

const response = await client.responses.create({
  model: "gpt-5.1-codex",
  input: "Reply exactly: SUBI_BUYER_OK",
});

console.log(response.output_text);
```

环境变量：

```bash
export OPENAI_BASE_URL="https://api.subi.xyz/v1"
export OPENAI_API_KEY="sk-subi_xxx"
```

#### 5.3.4 Cursor / Continue Tab

该 Tab 只展示两个字段：

```text
Base URL: https://api.subi.xyz/v1
API Key: sk-subi_xxx
```

如果不同工具需要 JSON 配置，页面只提供最小模板，不展开成长篇教程。

Continue 示例：

```json
{
  "models": [
    {
      "title": "Subi",
      "provider": "openai",
      "model": "gpt-5.1-codex",
      "apiBase": "https://api.subi.xyz/v1",
      "apiKey": "sk-subi_xxx"
    }
  ]
}
```

#### 5.3.5 cURL Tab

cURL 用于最小链路自检和客服排查。

```bash
curl -sS "https://api.subi.xyz/v1/responses" \
  -H "Authorization: Bearer sk-subi_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.1-codex",
    "input": "Reply exactly: SUBI_BUYER_OK",
    "stream": false
  }'
```

## 6. Usage

Usage 页面用于回答买家的两个问题：

```text
我的钱花在哪里了？
刚才那条请求为什么失败？
```

请求记录字段：

```text
request_id
time
path
model
stream
status
seller_node
duration_ms
time_to_first_chunk_ms
credits_charged
error
```

扣费记录字段：

```text
ledger_id
time
type: recharge / debit / refund / adjustment
amount
balance_after
request_id
note
```

当前 Gateway 已有 access log、买家账户、余额扣费、credit ledger、request fill 和 seller earning ledger。Web MVP 下一步需要把页面从 mock 数据切到这些真实接口。

## 7. Credit 计费要求

MVP 阶段先使用平台内 Credit，不直接暴露链上 Subi Coin。

账本必须满足：

```text
每次充值生成一条 recharge
每次请求成功生成一条 debit
请求失败不扣费，或生成 refund
每条 debit 必须能关联 request_id
余额不能为负
扣费必须幂等，不能因为重试重复扣钱
```

模型计费在第一版可以先简化：

```text
按请求固定扣费
或按返回 bytes / duration 做临时估算
```

但 UI 文案要诚实：

```text
Estimated cost
```

直到后端实现准确 token accounting 后，再改成：

```text
Final cost
```

## 8. 视觉设计

Subi Buyer Web 的视觉目标是：干净、专业、轻量、像一个余额控制台，而不是教程资源站。

### 8.1 色彩

主色只使用粉色系：

```text
Primary: #EC4899
Primary hover: #DB2777
Light pink background: #FFF7FB
Soft pink border: #FBCFE8
Text: #111827
Muted text: #6B7280
Border: #E5E7EB
Background: #FFFFFF
```

状态色也要克制：

```text
Success: 深灰文字 + 浅粉 / 浅灰背景，不使用大面积绿色
Warning: 深灰文字 + 浅粉描边，不使用橙色大块
Error: #DC2626 仅用于错误文字和小图标
```

禁止：

```text
彩虹渐变
黑色霓虹加载页
动态背景渐变
玻璃拟态大卡片
大面积蓝色 / 紫色 / 绿色
每个模块一个颜色
```

### 8.2 布局

设计规则：

```text
页面最大宽度 1120px
卡片圆角不超过 8px
一个页面只保留一个主按钮
表格和配置区优先可扫描
代码块必须有复制按钮
API key 默认隐藏，点击后短暂显示
移动端优先堆叠，不横向溢出
```

### 8.3 组件

MVP 需要的组件：

```text
TopNav
BalanceCard
CreditPlanCard
ApiKeyField
BaseUrlField
ProviderTabs
CopyCodeBlock
DoctorResult
UsageTable
LedgerTable
EmptyState
ErrorBanner
```

不需要的组件：

```text
大 Hero
营销轮播
动态图表
多色功能矩阵
复杂侧边栏
教程目录树
```

## 9. 一键自检

Setup 页面必须有 Buyer Doctor。

自检项：

```text
Subi service 是否可访问
当前 API key 是否有效
余额是否大于 0
/v1/responses 是否可返回
当前 Base URL 是否是 Subi URL
当前请求是否命中 seller
```

自检结果要直接告诉用户下一步：

```text
通过：可以开始使用
API key 错：复制新的 API key
余额不足：购买 Credits
没有 seller：稍后重试，平台正在调度节点
Base URL 错：复制当前 Tab 的命令重新设置
```

## 10. 后端接口需求

以下接口是 Buyer Web MVP 需求，不代表当前代码已经实现。

```text
GET  /api/web/buyer/me
GET  /api/web/buyer/balance
GET  /api/web/buyer/api-keys
POST /api/web/buyer/api-keys
POST /api/web/buyer/api-keys/:id/revoke
GET  /api/web/buyer/credits/plans
POST /api/web/buyer/credits/orders
GET  /api/web/buyer/credits/ledger
GET  /api/web/buyer/usage
POST /api/web/buyer/doctor
GET  /api/web/gateway/status
```

核心数据对象：

```text
Buyer
BuyerApiKey
CreditWallet
CreditLedgerEntry
CreditOrder
RequestFill
DoctorRun
```

## 11. 页面文案原则

文案必须短。

推荐：

```text
Your Credits
Buy Credits
Copy API key
Copy Base URL
Run Doctor
Recent usage
```

避免：

```text
欢迎来到下一代 AI 编程能力交易网络
通过去中心化模型供应基础设施获得革命性体验
```

配置页可以中英混用，但命令和字段名必须保持英文原样。

## 12. 验收标准

MVP-1 Buyer Web 通过标准：

```text
买家能登录并看到余额
买家能创建、隐藏、复制、吊销 API key
买家能购买或模拟购买 Credits
买家能在 Codex CLI Tab 复制正确配置
买家能运行 Doctor 并看到明确结果
买家能发起一次请求，并在 Usage 看到 request_id
一次成功请求能产生扣费记录
余额不足时 Gateway 拒绝请求并提示购买 Credits
页面整体只使用粉色 + 白色 + 灰色，不能出现多彩教程站风格
```

## 13. 落地顺序

建议分 4 个小步：

```text
1. Buyer Web 页面
   Dashboard / Credits / Setup / Usage，优先读取真实接口。

2. Buyer API key 和 Doctor
   接真实服务可用性、API key 校验、/v1/responses 自检。

3. Credit ledger
   已实现买家余额、mock 充值订单、请求预扣 / 失败退款、Usage 关联 request_id 和 seller earning ledger。

4. 真实支付入口
   接入支付系统或后台确认充值流程。
```

第一步做网页时，优先把 Setup 和 Credits 做到可用，不要先做营销页面。
