const consoleConfigStorageKey = "subi_seller_console_configs";

const sellerState = {
  user: null,
  nodes: [],
  activeNode: null,
  setup: null,
  activeProvider: "codex",
  earnings: null,
  activity: [],
  doctorResult: null,
  doctorRunning: false,
  refreshing: false,
  consoleConfigs: loadConsoleConfigs(),
  expandedConsoleNodeID: "",
  setupByNode: {},
};

const creditMicros = 1_000_000;
const refreshIntervalMS = 5000;
const doctorPassedMessage = "自检通过，随时可以接单赚钱。";
const noExpandedConsoleNode = "__subi_no_expanded_console_node__";
const consoleProviderOptions = [
  { value: "codex", label: "Codex", backend: "codex-login" },
  { value: "claude", label: "Claude", backend: "claude-code" },
  { value: "chatgpt", label: "ChatGPT", backend: "codex-login" },
  { value: "cursor", label: "Cursor", backend: "codex-login" },
  { value: "other", label: "Other", backend: "codex-login" },
];
const consoleMachineTypes = ["Mac", "Windows", "Linux", "Server", "Other"];
const consoleScheduleModes = ["永久开放", "每天固定时间", "仅本次开放", "手动暂停"];
const consoleTemporaryDurations = ["1 小时", "2 小时", "4 小时", "8 小时", "自定义"];
const consoleTimezones = ["跟随设备", "跟随账户", "Asia/Shanghai", "America/Los_Angeles", "UTC"];
const consoleBalanceModes = ["保底余额", "固定可售额度", "可售比例"];
const consoleFailureActions = ["自动暂停接新单", "自动停止全部接入", "仅提醒"];
const consoleNotificationChannels = ["站内通知", "邮件", "Telegram", "Webhook"];
const consoleWeekDays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function doctorResult(status, nextAction, checks, code = "") {
  return {
    status,
    code,
    provider: onboardingProvider(),
    node_id: sellerState.activeNode?.node_id || "",
    duration_ms: 0,
    next_action: nextAction,
    checks,
  };
}

function formatCredits(micros) {
  const credits = Number(micros || 0) / creditMicros;
  return credits.toLocaleString(undefined, {
    minimumFractionDigits: credits % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 6,
  });
}

function compactID(value) {
  if (!value) {
    return "-";
  }
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function loadConsoleConfigs() {
  try {
    const raw = window.localStorage.getItem(consoleConfigStorageKey);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveConsoleConfigs() {
  window.localStorage.setItem(consoleConfigStorageKey, JSON.stringify(sellerState.consoleConfigs));
}

function providerValueFromBackend(provider) {
  const match = consoleProviderOptions.find((option) => option.backend === provider);
  return match?.value || "codex";
}

function backendProviderFromValue(value) {
  const match = consoleProviderOptions.find((option) => option.value === value);
  return match?.backend || "codex-login";
}

function providerLabel(value) {
  const providerValue = value?.includes("-") ? providerValueFromBackend(value) : value;
  return consoleProviderOptions.find((option) => option.value === providerValue)?.label || "Codex";
}

function nodeIDSeed() {
  return Math.random().toString(16).slice(2, 8);
}

function defaultConsoleNodeID() {
  return `seller-node-${nodeIDSeed()}`;
}

function defaultConsoleConfig(node = {}) {
  const provider = providerValueFromBackend(node.provider || "codex-login");
  return {
    display_name: node.node_id ? compactID(node.node_id) : "新 Seller 节点",
    machine_name: node.status === "created" ? "待接入" : "当前设备",
    machine_type: "Mac",
    machine_note: "",
    subscription_provider: provider,
    subscription_label: `${providerLabel(provider)} 订阅`,
    accept_mode: "pause_new",
    max_buyers: Number(node.max_concurrency || 1),
    schedule_mode: "仅本次开放",
    daily_windows: "09:00-18:00",
    repeat_days: [...consoleWeekDays],
    temporary_duration: "1 小时",
    timezone: "跟随设备",
    balance_guard_mode: "保底余额",
    reserve_balance: "20",
    sellable_quota: "",
    sellable_ratio: "20",
    daily_spend_cap_enabled: false,
    daily_spend_cap: "",
    failure_action: "自动暂停接新单",
    notification_channels: ["站内通知"],
  };
}

function consoleConfigForNode(node) {
  if (!node?.node_id) {
    return defaultConsoleConfig(node);
  }
  return {
    ...defaultConsoleConfig(node),
    ...(sellerState.consoleConfigs[node.node_id] || {}),
  };
}

function updateConsoleConfig(nodeID, patch) {
  if (!nodeID) {
    return;
  }
  const existing = sellerState.consoleConfigs[nodeID] || {};
  sellerState.consoleConfigs[nodeID] = { ...existing, ...patch };
  saveConsoleConfigs();
}

function defaultNodeID() {
  const stored = window.localStorage.getItem("subi_seller_node_id");
  if (stored) {
    return stored;
  }
  const random = Math.random().toString(16).slice(2, 8);
  const nodeID = `seller-web-${random}`;
  window.localStorage.setItem("subi_seller_node_id", nodeID);
  return nodeID;
}

function currentInstallCommand() {
  if (sellerState.setup?.install_command) {
    return sellerState.setup.install_command;
  }
  if (!sellerState.user) {
    return "# 登录后生成一站式安装命令";
  }
  if (!sellerState.activeNode) {
    return "# 点击“开始接入”创建节点并生成安装命令";
  }
  return "# 点击“开始接入”生成一次性 setup token 和安装命令";
}

function oneShotInstallCommand() {
  const command = currentInstallCommand();
  if (command.startsWith("#")) {
    return command;
  }
  const canaryFlags =
    window.location.port === "18081"
      ? ` \\
  --install-dir ~/.subi/seller-canary \\
  --service-name subi-seller-canary`
      : "";
  return `${command}${canaryFlags}`;
}

function powerShellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function windowsCanaryFlags() {
  return window.location.port === "18081"
    ? ` -InstallDir "$env:USERPROFILE\\.subi\\seller-canary" -ServiceName "subi-seller-canary"`
    : "";
}

function windowsInstallCommand() {
  if (sellerState.setup?.install_command_windows) {
    return `${sellerState.setup.install_command_windows}${windowsCanaryFlags()}`;
  }
  if (!sellerState.setup?.setup_token) {
    if (!sellerState.user) {
      return "# 登录后生成 Windows Terminal 命令";
    }
    if (!sellerState.activeNode) {
      return "# 点击“开始接入”创建节点并生成 Windows Terminal 命令";
    }
    return "# 点击“开始接入”生成 Windows Terminal 命令";
  }
  const gateway = window.location.origin;
  return `iwr -UseBasicParsing ${gateway}/api/v1/subi/seller/install.ps1 | iex; Install-SubiSeller -Gateway ${powerShellQuote(gateway)} -SetupToken ${powerShellQuote(sellerState.setup.setup_token)}${windowsCanaryFlags()}`;
}

function installCommands() {
  return [
    {
      label: "Windows Terminal",
      code: windowsInstallCommand(),
    },
    {
      label: "macOS / Linux / Unix",
      code: oneShotInstallCommand(),
    },
  ];
}

function codexBareMetalGuide() {
  return {
    title: "机器上没有 Codex？",
    note:
      "如果接单机器还没有 Codex CLI 或没有登录，请先在这台机器、同一个系统用户下完成下面步骤，再执行上面的一键接入命令。",
    steps: [
      {
        title: "安装 Codex CLI",
        body: "macOS / Linux 用官方安装脚本；Windows 在 PowerShell 里安装。",
        code: `# macOS / Linux
curl -fsSL https://chatgpt.com/codex/install.sh | sh

# Windows PowerShell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"`,
      },
      {
        title: "登录已有订阅账号",
        body:
          "用已经订阅过 Codex 的 ChatGPT 账号登录。服务器或无浏览器环境使用 device auth，在浏览器里输入终端给出的验证码完成登录。",
        code: `codex login

# 无桌面浏览器 / SSH 服务器
codex login --device-auth`,
      },
      {
        title: "确认登录态可用",
        body:
          "看到已登录后再点击“开始接入”。不要 logout，不要删除 ~/.codex；seller-agent 必须和 Codex 登录态运行在同一个系统用户下。",
        code: `codex login status`,
      },
    ],
  };
}

function claudeBareMetalGuide() {
  return {
    title: "机器上没有 Claude Code？",
    note:
      "如果接单机器还没有 Claude Code 或没有登录，请先在这台机器、同一个系统用户下完成下面步骤，再执行上面的一键接入命令。",
    steps: [
      {
        title: "安装 Claude Code",
        body: "任选官方原生安装脚本；如果机器已有 Node.js 18+，也可以使用 npm 全局安装。",
        code: `# macOS / Linux / WSL
curl -fsSL https://claude.ai/install.sh | bash

# Windows PowerShell
irm https://claude.ai/install.ps1 | iex

# 已安装 Node.js 18+ 的机器也可以使用 npm
npm install -g @anthropic-ai/claude-code`,
      },
      {
        title: "登录已有 Claude 订阅账号",
        body:
          "运行 claude 后按终端提示完成 Claude 账号登录。之后需要切换或重新登录时，在 Claude Code 交互界面执行 /login。",
        code: `claude

# 在 Claude Code 交互界面里切换或重新登录
/login`,
      },
      {
        title: "让 seller-agent 能读取凭据",
        body:
          "先确认 claude 能正常启动。如果 seller-agent 读不到登录态，运行 setup-token，并把生成的 token 放进启动环境。",
        code: `claude --version
claude setup-token

# macOS / Linux / Unix
export SELLER_CLAUDE_CODE_OAUTH_TOKEN="<claude setup-token output>"

# Windows PowerShell
$env:SELLER_CLAUDE_CODE_OAUTH_TOKEN="<claude setup-token output>"`,
      },
    ],
  };
}

function providerContent() {
  const commands = installCommands();
  return {
    codex: {
      title: "Codex 订阅",
      tag: "推荐",
      note:
        "必须在运行 seller-agent 的这台机器上保持 Codex 登录态。Subi 只复用这份登录态发网络请求，不在你的机器执行使用者的工具命令。",
      commands,
      guide: codexBareMetalGuide(),
    },
    claude: {
      title: "Claude Code 订阅",
      tag: "Anthropic Messages",
      note:
        "必须在运行 seller-agent 的这台机器上保持 Claude Code 凭据可用。Subi 只复用这份凭据转发 Anthropic Messages 请求，不在你的机器执行使用者的工具命令。",
      commands,
      guide: claudeBareMetalGuide(),
    },
  };
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderProvider(providerKey) {
  sellerState.activeProvider = providerKey || sellerState.activeProvider;
  const provider = providerContent()[sellerState.activeProvider];
  const container = document.querySelector("#provider-content");
  if (!container || !provider) {
    return;
  }
  container.innerHTML = `
    <div class="provider-title">
      <h3>${provider.title}</h3>
      <span class="tag">${provider.tag}</span>
    </div>
    <p class="provider-note">${escapeHtml(provider.note)}</p>
    <div class="command-list">
      ${provider.commands
        .map(
          (command) => `
            <div class="code-block">
              <div class="code-heading">
                <span>${escapeHtml(command.label)}</span>
                <button class="code-copy" type="button">复制</button>
              </div>
              <pre><code>${escapeHtml(command.code)}</code></pre>
            </div>
          `,
        )
        .join("")}
    </div>
    ${provider.guide ? renderSetupGuide(provider.guide) : ""}
  `;
}

function renderSetupGuide(guide) {
  return `
    <div class="setup-guide">
      <div class="setup-guide-heading">
        <span>${escapeHtml(guide.title)}</span>
        <p>${escapeHtml(guide.note)}</p>
      </div>
      <ol class="setup-guide-steps">
        ${guide.steps
          .map(
            (step) => `
              <li>
                <div>
                  <b>${escapeHtml(step.title)}</b>
                  <p>${escapeHtml(step.body)}</p>
                  <pre><code>${escapeHtml(step.code)}</code></pre>
                </div>
              </li>
            `,
          )
          .join("")}
      </ol>
    </div>
  `;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    ...options,
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data?.error?.message || `Request failed: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function setText(selector, value) {
  const el = document.querySelector(selector);
  if (el) {
    el.textContent = value;
  }
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  if (!toast) {
    return;
  }
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 1500);
}

function ensureAuthModal() {
  if (document.querySelector("#auth-modal")) {
    return;
  }
  document.body.insertAdjacentHTML(
    "beforeend",
    `
      <div class="auth-modal" id="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title" hidden>
        <div class="auth-backdrop" data-auth-close></div>
        <section class="auth-card">
          <button class="auth-close" type="button" data-auth-close aria-label="关闭">关闭</button>
          <div class="auth-heading">
            <span class="brand-mark">S</span>
            <div>
              <h2 id="auth-modal-title">登录 Subi</h2>
              <p id="auth-modal-copy">输入邮箱和密码。新用户会自动创建账号。</p>
            </div>
          </div>
          <div class="auth-provider-grid">
            <button class="auth-provider" type="button" data-auth-disabled>
              <img src="./auth-google.svg" alt="" />
              Google
            </button>
            <button class="auth-provider" type="button" data-auth-disabled>
              <img src="./auth-apple.svg" alt="" />
              Apple
            </button>
          </div>
          <button class="auth-provider auth-provider-wide" type="button" data-auth-disabled>
            <span>@</span>
            邮箱验证码登录
          </button>
          <div class="auth-divider"><span>邮箱和密码</span></div>
          <form class="auth-form" id="auth-form">
            <label>
              <span>邮箱</span>
              <input id="auth-email" name="email" type="email" autocomplete="email" placeholder="you@company.com" required />
            </label>
            <label>
              <span>密码</span>
              <input id="auth-password" name="password" type="password" autocomplete="current-password" minlength="8" placeholder="至少 8 位" required />
            </label>
            <p class="auth-error" id="auth-error" role="alert"></p>
            <button class="auth-submit" id="auth-submit" type="submit">登录</button>
          </form>
        </section>
      </div>
    `,
  );
  document.querySelector("#auth-form")?.addEventListener("submit", handleAuthSubmit);
}

function openAuthModal() {
  ensureAuthModal();
  const modal = document.querySelector("#auth-modal");
  if (!modal) {
    return;
  }
  modal.hidden = false;
  document.body.classList.add("auth-lock");
  window.setTimeout(() => document.querySelector("#auth-email")?.focus(), 0);
}

function closeAuthModal() {
  const modal = document.querySelector("#auth-modal");
  if (!modal) {
    return;
  }
  modal.hidden = true;
  document.body.classList.remove("auth-lock");
  setText("#auth-error", "");
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  showToast("已复制");
}

document.addEventListener("click", (event) => {
  const authClose = event.target.closest("[data-auth-close]");
  if (authClose) {
    closeAuthModal();
    return;
  }

  const authDisabled = event.target.closest("[data-auth-disabled]");
  if (authDisabled) {
    showToast("该登录方式稍后开放");
    return;
  }

  const providerTab = event.target.closest("[data-provider]");
  if (providerTab) {
    document.querySelectorAll("[data-provider]").forEach((tab) => {
      const active = tab === providerTab;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    renderProvider(providerTab.dataset.provider);
    return;
  }

  const addConsoleNode = event.target.closest("#add-seller-node, [data-console-add]");
  if (addConsoleNode) {
    createSellerConsoleNode();
    return;
  }

  const toggleConsoleNode = event.target.closest("[data-console-toggle]");
  if (toggleConsoleNode) {
    const nodeID = toggleConsoleNode.dataset.consoleToggle;
    sellerState.expandedConsoleNodeID = sellerState.expandedConsoleNodeID === nodeID ? noExpandedConsoleNode : nodeID;
    renderSellerConsole();
    return;
  }

  const accessConsoleNode = event.target.closest("[data-console-access]");
  if (accessConsoleNode) {
    copyConsoleNodeAccess(accessConsoleNode.dataset.consoleAccess);
    return;
  }

  const consoleMode = event.target.closest("[data-console-mode]");
  if (consoleMode) {
    updateConsoleConfig(consoleMode.dataset.nodeId, { accept_mode: consoleMode.dataset.consoleMode });
    renderSellerConsole();
    return;
  }

  const consoleDay = event.target.closest("[data-console-day]");
  if (consoleDay) {
    const nodeID = consoleDay.dataset.nodeId;
    const node = consoleNodeByID(nodeID);
    const config = consoleConfigForNode(node);
    const day = consoleDay.dataset.consoleDay;
    const days = new Set(config.repeat_days || []);
    if (days.has(day)) {
      days.delete(day);
    } else {
      days.add(day);
    }
    updateConsoleConfig(nodeID, { repeat_days: [...days] });
    renderSellerConsole();
    return;
  }

  const consoleNotification = event.target.closest("[data-console-notification]");
  if (consoleNotification) {
    const nodeID = consoleNotification.dataset.nodeId;
    const node = consoleNodeByID(nodeID);
    const config = consoleConfigForNode(node);
    const channel = consoleNotification.dataset.consoleNotification;
    const channels = new Set(config.notification_channels || []);
    if (channels.has(channel)) {
      channels.delete(channel);
    } else {
      channels.add(channel);
    }
    updateConsoleConfig(nodeID, { notification_channels: [...channels] });
    renderSellerConsole();
    return;
  }

  const codeCopy = event.target.closest(".code-copy");
  if (codeCopy) {
    const code = codeCopy.closest(".code-block")?.querySelector("code");
    if (code) {
      copyText(code.textContent);
    }
    return;
  }

  const authButton = event.target.closest(".login-btn, .mobile-nav button");
  if (authButton) {
    handleAuthAction();
    return;
  }

  const startButton = event.target.closest("#start-onboarding");
  if (startButton) {
    startSellerOnboarding();
    return;
  }

  const refreshButton = event.target.closest("#refresh-seller");
  if (refreshButton) {
    refreshSellerDataAndRender({ toast: true });
    return;
  }

  const languageButton = event.target.closest(".language-toggle button");
  if (languageButton) {
    document.querySelectorAll(".language-toggle button").forEach((button) => {
      button.classList.toggle("active", button === languageButton);
    });
    showToast(languageButton.textContent.trim() === "中文" ? "已切换中文" : "英文版稍后接入");
    return;
  }
});

document.addEventListener("input", (event) => {
  const field = event.target.closest("[data-console-field]");
  if (field) {
    updateConsoleField(field);
  }
});

document.addEventListener("change", (event) => {
  const field = event.target.closest("[data-console-field]");
  if (field) {
    updateConsoleField(field);
    renderSellerConsole();
  }
});

document.querySelector("#run-doctor")?.addEventListener("click", () => {
  runSellerDoctor();
});

function renderAuth() {
  document.querySelectorAll(".login-btn").forEach((button) => {
    button.textContent = sellerState.user ? "退出" : "登录";
  });
}

function renderHomeStats() {
  const onlineNodes = sellerState.nodes.filter((node) => node.status === "online").length;
  setText("#home-online-nodes", sellerState.user ? String(onlineNodes) : "--");
  setText("#home-request-count", sellerState.user ? String(sellerState.activity.length) : "--");
}

function renderClientState() {
  const node = sellerState.activeNode;
  setText("#seller-node-title", node?.node_id || (sellerState.user ? "尚未创建节点" : "未登录"));
  setText("#seller-node-status", node?.status || "--");
  setText("#seller-node-mode", node?.provider || "--");
  setText("#seller-node-workers", node ? `${node.max_concurrency || 1} buyer` : "--");
  renderProvider();
  renderDoctorResult();
}

function doctorProblemText(result) {
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const problemChecks = result.status === "passed" ? [] : checks.filter((check) => check.status !== "passed");
  if (problemChecks.length === 0) {
    return result.status === "passed" ? doctorPassedMessage : "自检未通过，但没有返回具体问题。";
  }
  return problemChecks
    .map((check) => {
      const label = check.label || check.id || "检查项";
      const message = check.message || check.code || "未返回具体说明。";
      return `${label}：${message}`;
    })
    .join("；");
}

function doctorStatusLabel(status) {
  return status === "passed" ? "通过" : "失败";
}

function renderDoctorResultContent(result, problemText, adviceText) {
  if (result.status === "passed") {
    return `
      <div class="doctor-result-section">
        <span class="doctor-result-status">${escapeHtml(doctorStatusLabel(result.status))}</span>
        <p>${escapeHtml(doctorPassedMessage)}</p>
      </div>
    `;
  }
  return `
    <div class="doctor-result-section">
      <span class="doctor-result-status">${escapeHtml(doctorStatusLabel(result.status))}</span>
      <p>${escapeHtml(problemText)}</p>
    </div>
    <div class="doctor-result-divider" aria-hidden="true"></div>
    <div class="doctor-result-section">
      <span class="doctor-result-label">建议</span>
      <p>${escapeHtml(adviceText)}</p>
    </div>
  `;
}

function renderDoctorResult() {
  const panel = document.querySelector("#seller-doctor-panel");
  if (!panel) {
    return;
  }
  const result = sellerState.doctorResult;
  if (!result) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }

  const problemText = doctorProblemText(result);
  const adviceText = result.next_action || "查看问题后重试。";
  panel.hidden = false;
  panel.innerHTML = `
    <div class="doctor-result ${escapeHtml(result.status || "blocked")}">
      ${renderDoctorResultContent(result, problemText, adviceText)}
    </div>
  `;
}

function renderEarnings() {
  const earnings = sellerState.earnings || {};
  setText("#seller-available", sellerState.user ? formatCredits(earnings.available_payout_micros) : "--");
  setText("#seller-total-earned", sellerState.user ? formatCredits(earnings.total_earned_micros) : "--");
  setText("#seller-current-balance", sellerState.user ? formatCredits(earnings.balance_micros) : "--");

  const successfulFills = sellerState.activity.filter((item) => Number(item.seller_earning_micros || 0) > 0).length;
  setText("#seller-fill-count", sellerState.user ? `来自 ${successfulFills} 次成功 fill` : "来自 -- 次成功 fill");

  const body = document.querySelector("#seller-activity-body");
  if (!body) {
    return;
  }
  if (!sellerState.user) {
    body.innerHTML = `<tr><td colspan="6">登录后加载请求流水。</td></tr>`;
    return;
  }
  if (sellerState.activity.length === 0) {
    body.innerHTML = `<tr><td colspan="6">暂无请求流水。</td></tr>`;
    return;
  }
  body.innerHTML = sellerState.activity
    .map((item) => {
      const ok = Number(item.status || 0) >= 200 && Number(item.status || 0) < 400 && !item.error;
      const duration = item.duration_ms ? `${(Number(item.duration_ms) / 1000).toFixed(1)}s` : "-";
      const firstChunk = Number(item.time_to_first_chunk_ms || -1) >= 0 ? `${(Number(item.time_to_first_chunk_ms) / 1000).toFixed(1)}s` : "-";
      const earning = item.seller_earning_micros ? `+${formatCredits(item.seller_earning_micros)}` : "0";
      return `
        <tr>
          <td><code>${escapeHtml(compactID(item.request_id))}</code></td>
          <td><code>${escapeHtml(compactID(item.buyer_user_id))}</code></td>
          <td><span class="status-pill ${ok ? "ok" : "failed"}">${ok ? "已完成" : "失败"}</span></td>
          <td>${escapeHtml(duration)}</td>
          <td>${escapeHtml(firstChunk)}</td>
          <td>${escapeHtml(earning)}</td>
        </tr>
      `;
    })
    .join("");
}

function sameLocalDate(value, date) {
  if (!value) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toDateString() === date.toDateString();
}

function nodeActivity(node) {
  return sellerState.activity.filter((item) => item.seller_node_id === node.node_id);
}

function nodeTodayEarnings(node) {
  const today = new Date();
  return nodeActivity(node)
    .filter((item) => sameLocalDate(item.created_at, today))
    .reduce((sum, item) => sum + Number(item.seller_earning_micros || 0), 0);
}

function nodeTotalEarnings(node) {
  return nodeActivity(node).reduce((sum, item) => sum + Number(item.seller_earning_micros || 0), 0);
}

function nodeCurrentBuyers(node) {
  return Number(node.active_requests || node.current_buyers || 0);
}

function nodeMaxBuyers(node, config) {
  return Math.max(1, Math.min(10, Number(config.max_buyers || node.max_concurrency || 1)));
}

function consoleStatus(node, config) {
  const current = nodeCurrentBuyers(node);
  const max = nodeMaxBuyers(node, config);
  if (config.accept_mode === "stop_all") {
    return { label: "已停止", tone: "failed", reason: "停止全部接入" };
  }
  if (config.accept_mode === "pause_new") {
    return { label: "暂停中", tone: "idle", reason: "手动暂停接新单" };
  }
  if (node.status === "created" || node.status === "provisioned") {
    return { label: "待接入", tone: "pending", reason: "复制接入指令并在目标设备运行" };
  }
  if (node.status === "offline") {
    return { label: "离线", tone: "failed", reason: "机器离线或最近心跳中断" };
  }
  if (node.status !== "online") {
    return { label: node.status || "异常", tone: "failed", reason: "节点状态异常" };
  }
  if (config.schedule_mode === "手动暂停") {
    return { label: "暂停中", tone: "idle", reason: "运行时间设置为手动暂停" };
  }
  if (current >= max) {
    return { label: "名额已满", tone: "pending", reason: "当前接入数达到上限" };
  }
  return { label: "接单中", tone: "ok", reason: "可以接新 buyer" };
}

function consoleSetupStatus(node) {
  const setup = sellerState.setupByNode[node.node_id];
  if (!setup) {
    return node.status === "created" ? "待生成" : "已接入";
  }
  if (setup.expires_at && new Date(setup.expires_at).getTime() < Date.now()) {
    return "指令已过期";
  }
  return setup.copied_at ? "已复制" : "已生成";
}

function renderOptions(options, selected) {
  return options
    .map((option) => {
      const value = typeof option === "string" ? option : option.value;
      const label = typeof option === "string" ? option : option.label;
      return `<option value="${escapeHtml(String(value))}" ${value === selected ? "selected" : ""}>${escapeHtml(String(label))}</option>`;
    })
    .join("");
}

function renderConsoleSummary() {
  if (!document.querySelector("#console-online-nodes")) {
    return;
  }
  const nodes = sellerState.nodes;
  const configs = new Map(nodes.map((node) => [node.node_id, consoleConfigForNode(node)]));
  const onlineNodes = nodes.filter((node) => node.status === "online").length;
  const currentBuyers = nodes.reduce((sum, node) => sum + nodeCurrentBuyers(node), 0);
  const maxBuyers = nodes.reduce((sum, node) => sum + nodeMaxBuyers(node, configs.get(node.node_id)), 0);
  const todayEarnings = nodes.reduce((sum, node) => sum + nodeTodayEarnings(node), 0);
  const statuses = nodes.map((node) => consoleStatus(node, configs.get(node.node_id)));
  const accepting = statuses.find((status) => status.label === "接单中");
  const firstBlocked = statuses.find((status) => status.label !== "接单中");
  const statusLabel = !sellerState.user
    ? "未登录"
    : nodes.length === 0
      ? "暂无节点"
      : accepting
        ? "接单中"
        : firstBlocked?.label || "无可用节点";
  const reason = !sellerState.user
    ? "登录后加载节点"
    : nodes.length === 0
      ? "添加 Seller 节点后开始配置"
      : accepting
        ? accepting.reason
        : firstBlocked?.reason || "当前没有可用节点";

  setText("#console-online-nodes", sellerState.user ? `${onlineNodes} / ${nodes.length}` : "--");
  setText("#console-current-buyers", sellerState.user ? `${currentBuyers} / ${maxBuyers}` : "--");
  setText("#console-today-earnings", sellerState.user ? formatCredits(todayEarnings) : "--");
  setText("#console-accept-status", statusLabel);
  setText("#console-accept-reason", reason);
}

function renderConsoleModeButtons(node, config) {
  const modes = [
    { value: "accepting", label: "开启接单" },
    { value: "pause_new", label: "暂停接新单" },
    { value: "stop_all", label: "停止全部接入" },
  ];
  return `
    <div class="segmented-control" role="group" aria-label="接单模式">
      ${modes
        .map(
          (mode) => `
            <button
              class="${config.accept_mode === mode.value ? "active" : ""}"
              type="button"
              data-node-id="${escapeHtml(node.node_id)}"
              data-console-mode="${escapeHtml(mode.value)}"
            >${escapeHtml(mode.label)}</button>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderConsoleDayButtons(node, config) {
  const selectedDays = new Set(config.repeat_days || []);
  return `
    <div class="pill-toggle-grid" role="group" aria-label="重复日期">
      ${consoleWeekDays
        .map(
          (day) => `
            <button
              class="${selectedDays.has(day) ? "active" : ""}"
              type="button"
              data-node-id="${escapeHtml(node.node_id)}"
              data-console-day="${escapeHtml(day)}"
            >${escapeHtml(day)}</button>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderNotificationButtons(node, config) {
  const selectedChannels = new Set(config.notification_channels || []);
  return `
    <div class="pill-toggle-grid" role="group" aria-label="通知方式">
      ${consoleNotificationChannels
        .map(
          (channel) => `
            <button
              class="${selectedChannels.has(channel) ? "active" : ""}"
              type="button"
              data-node-id="${escapeHtml(node.node_id)}"
              data-console-notification="${escapeHtml(channel)}"
            >${escapeHtml(channel)}</button>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderConsoleField(node, config, field) {
  const nodeID = escapeHtml(node.node_id);
  const value = config[field.name] ?? "";
  const label = escapeHtml(field.label);
  const domain = escapeHtml(field.domain);
  if (field.type === "select") {
    return `
      <label class="console-field">
        <span>${label}</span>
        <select data-node-id="${nodeID}" data-console-field="${escapeHtml(field.name)}">
          ${renderOptions(field.options, value)}
        </select>
        <small>${domain}</small>
      </label>
    `;
  }
  if (field.type === "number") {
    return `
      <label class="console-field">
        <span>${label}</span>
        <input
          type="number"
          min="${escapeHtml(String(field.min ?? 0))}"
          max="${escapeHtml(String(field.max ?? ""))}"
          step="${escapeHtml(String(field.step ?? 1))}"
          value="${escapeHtml(String(value))}"
          data-node-id="${nodeID}"
          data-console-field="${escapeHtml(field.name)}"
        />
        <small>${domain}</small>
      </label>
    `;
  }
  if (field.type === "range") {
    return `
      <label class="console-field">
        <span>${label} <b id="${escapeHtml(field.name)}-${nodeID}">${escapeHtml(String(value))}%</b></span>
        <input
          type="range"
          min="${escapeHtml(String(field.min))}"
          max="${escapeHtml(String(field.max))}"
          step="${escapeHtml(String(field.step ?? 1))}"
          value="${escapeHtml(String(value))}"
          data-node-id="${nodeID}"
          data-console-field="${escapeHtml(field.name)}"
        />
        <small>${domain}</small>
      </label>
    `;
  }
  if (field.type === "checkbox") {
    return `
      <label class="console-field checkbox-field">
        <span>${label}</span>
        <input
          type="checkbox"
          ${value ? "checked" : ""}
          data-node-id="${nodeID}"
          data-console-field="${escapeHtml(field.name)}"
        />
        <small>${domain}</small>
      </label>
    `;
  }
  return `
    <label class="console-field">
      <span>${label}</span>
      <input
        type="text"
        value="${escapeHtml(String(value))}"
        maxlength="${escapeHtml(String(field.maxLength || 80))}"
        data-node-id="${nodeID}"
        data-console-field="${escapeHtml(field.name)}"
      />
      <small>${domain}</small>
    </label>
  `;
}

function renderConsoleSection(title, fields) {
  return `
    <section class="console-config-section">
      <h3>${escapeHtml(title)}</h3>
      <div class="console-field-grid">
        ${fields.join("")}
      </div>
    </section>
  `;
}

function renderConsoleDetails(node, config) {
  const status = consoleStatus(node, config);
  return `
    <div class="seller-node-details">
      ${renderConsoleSection("基础与机器", [
        renderConsoleField(node, config, { name: "display_name", label: "节点名称", type: "text", domain: "1-40 字符", maxLength: 40 }),
        renderConsoleField(node, config, { name: "machine_name", label: "运行机器", type: "text", domain: "1-40 字符", maxLength: 40 }),
        renderConsoleField(node, config, { name: "machine_type", label: "设备类型", type: "select", domain: "Mac / Windows / Linux / Server / Other", options: consoleMachineTypes }),
        renderConsoleField(node, config, { name: "machine_note", label: "设备备注", type: "text", domain: "0-80 字符", maxLength: 80 }),
      ])}

      ${renderConsoleSection("订阅账号", [
        renderConsoleField(node, config, { name: "subscription_provider", label: "账号类型", type: "select", domain: "Codex / Claude / ChatGPT / Cursor / Other", options: consoleProviderOptions }),
        renderConsoleField(node, config, { name: "subscription_label", label: "账号名称", type: "text", domain: "1-40 字符，只展示备注名", maxLength: 40 }),
      ])}

      <section class="console-config-section">
        <h3>接单能力</h3>
        ${renderConsoleModeButtons(node, config)}
        <div class="console-field-grid">
          ${renderConsoleField(node, config, { name: "max_buyers", label: "最大接入 buyer 数", type: "number", domain: "1-10，MVP 建议 1-3", min: 1, max: 10 })}
          <div class="console-readonly">
            <span>当前接入 buyer 数</span>
            <strong>${nodeCurrentBuyers(node)} / ${nodeMaxBuyers(node, config)}</strong>
            <small>系统实时统计</small>
          </div>
          <div class="console-readonly">
            <span>不可接单原因</span>
            <strong>${escapeHtml(status.reason)}</strong>
            <small>按控制台优先级计算</small>
          </div>
        </div>
      </section>

      <section class="console-config-section">
        <h3>运行时间</h3>
        <div class="console-field-grid">
          ${renderConsoleField(node, config, { name: "schedule_mode", label: "时间模式", type: "select", domain: "永久开放 / 每天固定时间 / 仅本次开放 / 手动暂停", options: consoleScheduleModes })}
          ${renderConsoleField(node, config, { name: "daily_windows", label: "每天时间段", type: "text", domain: "00:00-23:59，可多段", maxLength: 40 })}
          ${renderConsoleField(node, config, { name: "temporary_duration", label: "临时开放时长", type: "select", domain: "1 / 2 / 4 / 8 小时 / 自定义", options: consoleTemporaryDurations })}
          ${renderConsoleField(node, config, { name: "timezone", label: "时区", type: "select", domain: "跟随设备 / 跟随账户 / 指定时区", options: consoleTimezones })}
        </div>
        ${renderConsoleDayButtons(node, config)}
      </section>

      <section class="console-config-section">
        <h3>余额保护</h3>
        <div class="console-field-grid">
          ${renderConsoleField(node, config, { name: "balance_guard_mode", label: "余额池模式", type: "select", domain: "保底余额 / 固定可售额度 / 可售比例", options: consoleBalanceModes })}
          ${renderConsoleField(node, config, { name: "reserve_balance", label: "保底余额", type: "number", domain: "大于等于 0", min: 0, step: 1 })}
          ${renderConsoleField(node, config, { name: "sellable_quota", label: "固定可售额度", type: "number", domain: "大于 0，不能超过可用余额", min: 0, step: 1 })}
          ${renderConsoleField(node, config, { name: "sellable_ratio", label: "可售余额比例", type: "range", domain: "5%-50%，高级可到 80%", min: 5, max: 80, step: 5 })}
          ${renderConsoleField(node, config, { name: "daily_spend_cap_enabled", label: "单日消耗上限", type: "checkbox", domain: "关闭 / 开启" })}
          ${renderConsoleField(node, config, { name: "daily_spend_cap", label: "单日上限额度", type: "number", domain: "开启后填写大于 0 的额度", min: 0, step: 1 })}
        </div>
      </section>

      <section class="console-config-section">
        <h3>收益与异常</h3>
        <div class="console-field-grid">
          <div class="console-readonly">
            <span>今日收益</span>
            <strong>${formatCredits(nodeTodayEarnings(node))}</strong>
            <small>节点维度统计</small>
          </div>
          <div class="console-readonly">
            <span>累计收益</span>
            <strong>${formatCredits(nodeTotalEarnings(node))}</strong>
            <small>提现归属总 seller 账户</small>
          </div>
          ${renderConsoleField(node, config, { name: "failure_action", label: "异常后动作", type: "select", domain: "自动暂停 / 自动停止 / 仅提醒", options: consoleFailureActions })}
          <div class="console-readonly">
            <span>通知方式</span>
            ${renderNotificationButtons(node, config)}
            <small>第一版只做站内通知展示</small>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderConsoleNode(node) {
  const config = consoleConfigForNode(node);
  const status = consoleStatus(node, config);
  const expanded = sellerState.expandedConsoleNodeID === node.node_id;
  const toggleLabel = expanded ? "收起" : "配置";
  const nextMode = config.accept_mode === "accepting" ? "pause_new" : "accepting";
  const nextModeLabel = config.accept_mode === "accepting" ? "暂停" : "开启";
  return `
    <article class="seller-node-card ${expanded ? "expanded" : ""}">
      <div class="seller-node-row">
        <div class="seller-node-main">
          <span class="status-pill ${escapeHtml(status.tone)}">${escapeHtml(status.label)}</span>
          <h2>${escapeHtml(config.display_name || node.node_id)}</h2>
          <p>${escapeHtml(status.reason)}</p>
        </div>
        <div class="seller-node-meta">
          <div>
            <span>运行机器</span>
            <strong>${escapeHtml(config.machine_name || "待接入")}</strong>
          </div>
          <div>
            <span>订阅账号</span>
            <strong>${escapeHtml(config.subscription_label || providerLabel(config.subscription_provider))}</strong>
          </div>
          <div>
            <span>当前接入</span>
            <strong>${nodeCurrentBuyers(node)} / ${nodeMaxBuyers(node, config)}</strong>
          </div>
          <div>
            <span>运行时间</span>
            <strong>${escapeHtml(config.schedule_mode === "每天固定时间" ? config.daily_windows : config.schedule_mode)}</strong>
          </div>
          <div>
            <span>今日收益</span>
            <strong>${formatCredits(nodeTodayEarnings(node))}</strong>
          </div>
        </div>
        <div class="seller-node-actions">
          <button class="secondary-action compact-action" type="button" data-console-toggle="${escapeHtml(node.node_id)}">${toggleLabel}</button>
          <button class="primary-action compact-action" type="button" data-console-access="${escapeHtml(node.node_id)}">接入</button>
          <button
            class="secondary-action compact-action"
            type="button"
            data-node-id="${escapeHtml(node.node_id)}"
            data-console-mode="${escapeHtml(nextMode)}"
          >${nextModeLabel}</button>
        </div>
      </div>
      <div class="seller-node-foot">
        <span>节点 ID：<code>${escapeHtml(node.node_id)}</code></span>
        <span>设备状态：${escapeHtml(node.status || "created")}</span>
        <span>接入指令：${escapeHtml(consoleSetupStatus(node))}</span>
        <span>最近心跳：${escapeHtml(node.last_seen_at || "暂无")}</span>
      </div>
      ${expanded ? renderConsoleDetails(node, config) : ""}
    </article>
  `;
}

function renderSellerConsole() {
  renderConsoleSummary();
  const list = document.querySelector("#seller-console-list");
  if (!list) {
    return;
  }
  if (!sellerState.user) {
    list.innerHTML = `
      <article class="console-empty">
        <h2>登录后加载 Seller 节点。</h2>
        <p>控制台会按节点展示机器、订阅账号、运行时间、接单能力、余额保护和收益。</p>
        <button class="primary-action" type="button" data-console-add>登录并添加节点</button>
      </article>
    `;
    return;
  }
  if (sellerState.nodes.length === 0) {
    list.innerHTML = `
      <article class="console-empty">
        <h2>还没有 Seller 节点。</h2>
        <p>先添加一个待接入节点，再复制这一行的接入指令到对应设备上运行。</p>
        <button class="primary-action" type="button" data-console-add>添加 Seller 节点</button>
      </article>
    `;
    return;
  }
  if (
    sellerState.expandedConsoleNodeID !== noExpandedConsoleNode &&
    (!sellerState.expandedConsoleNodeID || !sellerState.nodes.some((node) => node.node_id === sellerState.expandedConsoleNodeID))
  ) {
    sellerState.expandedConsoleNodeID = sellerState.nodes[0].node_id;
  }
  list.innerHTML = sellerState.nodes.map(renderConsoleNode).join("");
}

function consoleNodeByID(nodeID) {
  return sellerState.nodes.find((node) => node.node_id === nodeID);
}

async function createSellerConsoleNode() {
  if (!sellerState.user) {
    openAuthModal("login");
    return;
  }
  const nodeID = defaultConsoleNodeID();
  const displayName = `Seller 节点 ${sellerState.nodes.length + 1}`;
  const config = { ...defaultConsoleConfig({ node_id: nodeID }), display_name: displayName };
  try {
    const payload = await api("/api/web/seller/nodes", {
      method: "POST",
      body: {
        node_id: nodeID,
        provider: backendProviderFromValue(config.subscription_provider),
        max_concurrency: Number(config.max_buyers || 1),
      },
    });
    updateConsoleConfig(payload.node.node_id, config);
    sellerState.nodes = [payload.node, ...sellerState.nodes];
    sellerState.activeNode = payload.node;
    sellerState.expandedConsoleNodeID = payload.node.node_id;
    renderAll();
    showToast("Seller 节点已添加");
  } catch (error) {
    showToast(error.message);
  }
}

async function syncConsoleNodeSettings(node, config) {
  const provider = backendProviderFromValue(config.subscription_provider);
  const maxConcurrency = nodeMaxBuyers(node, config);
  if (node.provider === provider && Number(node.max_concurrency || 1) === maxConcurrency) {
    return node;
  }
  const payload = await api(`/api/web/seller/nodes/${encodeURIComponent(node.node_id)}`, {
    method: "PATCH",
    body: {
      provider,
      max_concurrency: maxConcurrency,
    },
  });
  const updated = payload.node;
  sellerState.nodes = sellerState.nodes.map((candidate) => (candidate.node_id === updated.node_id ? updated : candidate));
  return updated;
}

async function copyConsoleNodeAccess(nodeID) {
  if (!sellerState.user) {
    openAuthModal("login");
    return;
  }
  let node = consoleNodeByID(nodeID);
  if (!node) {
    showToast("节点不存在");
    return;
  }
  const config = consoleConfigForNode(node);
  try {
    node = await syncConsoleNodeSettings(node, config);
    const setup = await api(`/api/web/seller/nodes/${encodeURIComponent(node.node_id)}/setup-token`, {
      method: "POST",
      body: {},
    });
    sellerState.setupByNode[node.node_id] = {
      ...setup,
      copied_at: new Date().toISOString(),
    };
    await copyText(setup.install_command || setup.install_command_unix || "");
    renderAll();
  } catch (error) {
    showToast(error.message);
  }
}

function updateConsoleField(target) {
  const nodeID = target.dataset.nodeId;
  const field = target.dataset.consoleField;
  if (!nodeID || !field) {
    return;
  }
  const value = target.type === "checkbox" ? target.checked : target.value;
  updateConsoleConfig(nodeID, { [field]: value });
  if (field === "sellable_ratio") {
    const output = document.getElementById(`sellable_ratio-${nodeID}`);
    if (output) {
      output.textContent = `${value}%`;
    }
  }
}

function renderAPISnippets() {
  const buyerSnippet = document.querySelector("#buyer-api-snippet");
  if (buyerSnippet) {
    buyerSnippet.textContent = `export OPENAI_BASE_URL="${window.location.origin}/v1"
export OPENAI_API_KEY="sk-subi_xxx"

codex \\
  -c 'model_provider="subi"' \\
  -c 'model_providers.subi.name="Subi"' \\
  -c "model_providers.subi.base_url=\\"\${OPENAI_BASE_URL}\\"" \\
  -c 'model_providers.subi.env_key="OPENAI_API_KEY"' \\
  -c 'model_providers.subi.wire_api="responses"'`;
  }

  const sellerSnippet = document.querySelector("#seller-api-snippet");
  if (sellerSnippet) {
    const wsURL = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/v1/subi/seller/agent/ws`;
    sellerSnippet.textContent = `export SUBI_GATEWAY_WS_URL="${wsURL}"
export SUBI_SELLER_NODE_TOKEN="seller_node_xxx"
export SUBI_NODE_ID="seller-001"
export SELLER_UPSTREAM_MODE="codex-login"
export SELLER_CODEX_HOME="$HOME/.codex"

./seller-agent`;
  }
}

function renderAll() {
  renderAuth();
  renderHomeStats();
  renderClientState();
  renderEarnings();
  renderSellerConsole();
  renderAPISnippets();
}

async function loadSellerAccount() {
  try {
    const payload = await api("/api/web/auth/me");
    sellerState.user = payload.user;
    await refreshSellerData();
  } catch (error) {
    if (error.status !== 401) {
      showToast(error.message);
    }
    sellerState.user = null;
    sellerState.nodes = [];
    sellerState.activeNode = null;
    sellerState.setup = null;
    sellerState.earnings = null;
    sellerState.activity = [];
    sellerState.doctorResult = null;
    sellerState.expandedConsoleNodeID = "";
    sellerState.setupByNode = {};
  }
  renderAll();
}

async function refreshSellerData() {
  if (!sellerState.user || sellerState.refreshing) {
    return;
  }
  sellerState.refreshing = true;
  try {
    const [nodesPayload, earningsPayload, activityPayload] = await Promise.all([
      api("/api/web/seller/nodes"),
      api("/api/web/seller/earnings"),
      api("/api/web/seller/activity?limit=20"),
    ]);
    sellerState.nodes = nodesPayload.nodes || [];
    sellerState.activeNode = sellerState.nodes[0] || null;
    sellerState.earnings = earningsPayload.earnings || null;
    sellerState.activity = activityPayload.activity || [];
  } finally {
    sellerState.refreshing = false;
  }
}

async function refreshSellerDataAndRender({ toast = false } = {}) {
  if (!sellerState.user) {
    if (toast) {
      showToast("请先登录");
    }
    return;
  }
  try {
    await refreshSellerData();
    renderAll();
    if (toast) {
      showToast("已刷新");
    }
  } catch (error) {
    if (toast) {
      showToast(error.message);
    }
  }
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = document.querySelector("#auth-submit");
  const email = String(form.email.value || "").trim();
  const password = String(form.password.value || "");
  if (!email || !password) {
    setText("#auth-error", "请填写邮箱和密码。");
    return;
  }
  if (password.length < 8) {
    setText("#auth-error", "密码至少 8 位。");
    return;
  }
  setText("#auth-error", "");
  if (submitButton) {
    submitButton.disabled = true;
  }
  try {
    await signInOrCreateAccount(email, password);
    closeAuthModal();
    showToast("已登录");
    await loadSellerAccount();
  } catch (error) {
    setText("#auth-error", error.message);
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
    }
  }
}

async function signInOrCreateAccount(email, password) {
  try {
    await api("/api/web/auth/login", {
      method: "POST",
      body: { email, password },
    });
    return;
  } catch (error) {
    if (error.status !== 401) {
      throw error;
    }
  }

  try {
    await api("/api/web/auth/register", {
      method: "POST",
      body: { email, password },
    });
  } catch (error) {
    if (error.status === 409) {
      throw new Error("邮箱或密码不正确。");
    }
    throw error;
  }
}

async function loginOrRegister() {
  openAuthModal();
}

async function logout() {
  await api("/api/web/auth/logout", { method: "POST" });
  sellerState.user = null;
  sellerState.nodes = [];
  sellerState.activeNode = null;
  sellerState.setup = null;
  sellerState.earnings = null;
  sellerState.activity = [];
  sellerState.doctorResult = null;
  sellerState.expandedConsoleNodeID = "";
  sellerState.setupByNode = {};
  renderAll();
  showToast("已退出");
}

async function handleAuthAction() {
  try {
    if (sellerState.user) {
      await logout();
    } else {
      openAuthModal("login");
    }
  } catch (error) {
    showToast(error.message);
  }
}

function onboardingProvider() {
  return sellerState.activeProvider === "claude" ? "claude-code" : "codex-login";
}

async function ensureSellerNode() {
  const provider = onboardingProvider();
  const matchingNode = sellerState.nodes.find((node) => node.provider === provider);
  if (matchingNode) {
    sellerState.activeNode = matchingNode;
    return matchingNode;
  }

  const nodeID = provider === "codex-login" ? defaultNodeID() : `${defaultNodeID()}-${provider}`;
  let payload;
  try {
    payload = await api("/api/web/seller/nodes", {
      method: "POST",
      body: {
        node_id: nodeID,
        provider,
        max_concurrency: 1,
      },
    });
  } catch (error) {
    if (error.status !== 409) {
      throw error;
    }
    window.localStorage.removeItem("subi_seller_node_id");
    return ensureSellerNode();
  }
  sellerState.activeNode = payload.node;
  sellerState.nodes = [payload.node, ...sellerState.nodes];
  return payload.node;
}

function localProviderDoctorBlocked() {
  return {
    status: "blocked",
    code: "provider_not_ready",
    provider: onboardingProvider(),
    node_id: sellerState.activeNode?.node_id || "",
    duration_ms: 0,
    next_action: "当前版本只开放 Codex 订阅自检，请切换到 Codex 节点。",
    checks: [
      {
        id: "provider_doctor",
        label: "Provider 自检",
        status: "blocked",
        code: "provider_not_ready",
        message: "Claude Code 自检暂未开放。",
      },
    ],
  };
}

async function runSellerDoctor() {
  if (!sellerState.user) {
    sellerState.doctorResult = doctorResult("blocked", "请先登录卖家账号后再运行自检。", [
      {
        id: "web_login",
        label: "网页登录",
        status: "blocked",
        code: "login_required",
        message: "当前未登录。",
      },
    ], "login_required");
    renderDoctorResult();
    return;
  }

  if (sellerState.activeProvider !== "codex") {
    sellerState.doctorResult = localProviderDoctorBlocked();
    renderDoctorResult();
    return;
  }

  const node = sellerState.nodes.find((candidate) => candidate.provider === "codex-login");
  if (!node) {
    sellerState.doctorResult = doctorResult("blocked", "先点击“开始接入”创建 Codex 节点并完成安装。", [
      {
        id: "node_created",
        label: "节点创建",
        status: "blocked",
        code: "node_not_created",
        message: "还没有可自检的 Codex 节点。",
      },
    ], "node_not_created");
    renderDoctorResult();
    return;
  }

  const button = document.querySelector("#run-doctor");
  sellerState.doctorRunning = true;
  sellerState.doctorResult = null;
  renderDoctorResult();
  if (button) {
    button.disabled = true;
    button.textContent = "自检中";
  }
  try {
    sellerState.doctorResult = await api(`/api/web/seller/nodes/${encodeURIComponent(node.node_id)}/doctor`, {
      method: "POST",
    });
    renderDoctorResult();
    await refreshSellerData();
    renderClientState();
  } catch (error) {
    sellerState.doctorResult = doctorResult("failed", "自检接口请求失败。确认当前网页打开的是安装命令使用的同一个 Gateway，并重启 Gateway 到最新版本。", [
      {
        id: "doctor_api",
        label: "自检接口",
        status: "failed",
        code: "doctor_api_failed",
        message: error.message,
      },
    ], "doctor_api_failed");
    renderDoctorResult();
  } finally {
    sellerState.doctorRunning = false;
    if (button) {
      button.disabled = false;
      button.textContent = "运行自检";
    }
  }
}

async function startSellerOnboarding() {
  try {
    if (!sellerState.user) {
      openAuthModal("login");
      return;
    }
    const node = await ensureSellerNode();
    sellerState.setup = await api(`/api/web/seller/nodes/${encodeURIComponent(node.node_id)}/setup-token`, {
      method: "POST",
      body: {},
    });
    sellerState.doctorResult = null;
    renderAll();
    showToast("安装命令已生成");
  } catch (error) {
    showToast(error.message);
  }
}

function initNetworkMap() {
  const canvas = document.querySelector("#network-map");
  if (!canvas) {
    return;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let animationFrame = 0;

  const land = [
    [
      [0.08, 0.31],
      [0.16, 0.23],
      [0.27, 0.24],
      [0.33, 0.33],
      [0.28, 0.45],
      [0.18, 0.48],
      [0.1, 0.42],
    ],
    [
      [0.27, 0.49],
      [0.33, 0.57],
      [0.31, 0.72],
      [0.25, 0.82],
      [0.21, 0.68],
      [0.22, 0.56],
    ],
    [
      [0.43, 0.29],
      [0.56, 0.23],
      [0.75, 0.27],
      [0.86, 0.37],
      [0.82, 0.49],
      [0.66, 0.5],
      [0.52, 0.43],
      [0.42, 0.43],
    ],
    [
      [0.62, 0.49],
      [0.7, 0.53],
      [0.72, 0.62],
      [0.66, 0.64],
      [0.6, 0.56],
    ],
    [
      [0.49, 0.45],
      [0.58, 0.49],
      [0.61, 0.65],
      [0.55, 0.78],
      [0.47, 0.65],
      [0.45, 0.53],
    ],
    [
      [0.75, 0.64],
      [0.83, 0.66],
      [0.88, 0.73],
      [0.82, 0.8],
      [0.73, 0.76],
    ],
  ];

  const nodes = [
    { id: "seattle", x: 0.17, y: 0.3, kind: "seller", phase: 0.1 },
    { id: "sf", x: 0.15, y: 0.35, kind: "seller", phase: 0.7 },
    { id: "la", x: 0.17, y: 0.39, kind: "buyer", phase: 1.1 },
    { id: "denver", x: 0.21, y: 0.35, kind: "buyer", phase: 1.6 },
    { id: "texas", x: 0.23, y: 0.41, kind: "seller", phase: 2.1 },
    { id: "toronto", x: 0.25, y: 0.31, kind: "buyer", phase: 2.7 },
    { id: "nyc", x: 0.29, y: 0.35, kind: "seller", phase: 3.2 },
    { id: "mexico", x: 0.23, y: 0.46, kind: "buyer", phase: 3.9 },
    { id: "bogota", x: 0.27, y: 0.56, kind: "seller", phase: 4.4 },
    { id: "lima", x: 0.25, y: 0.65, kind: "buyer", phase: 5.0 },
    { id: "saopaulo", x: 0.31, y: 0.66, kind: "seller", phase: 5.5 },
    { id: "buenosaires", x: 0.29, y: 0.74, kind: "buyer", phase: 6.1 },
    { id: "london", x: 0.48, y: 0.34, kind: "seller", phase: 6.7 },
    { id: "paris", x: 0.5, y: 0.37, kind: "buyer", phase: 7.2 },
    { id: "berlin", x: 0.52, y: 0.35, kind: "seller", phase: 7.8 },
    { id: "madrid", x: 0.47, y: 0.4, kind: "buyer", phase: 8.3 },
    { id: "istanbul", x: 0.55, y: 0.39, kind: "seller", phase: 8.9 },
    { id: "moscow", x: 0.6, y: 0.32, kind: "buyer", phase: 9.5 },
    { id: "cairo", x: 0.54, y: 0.46, kind: "seller", phase: 10.0 },
    { id: "lagos", x: 0.5, y: 0.56, kind: "buyer", phase: 10.6 },
    { id: "nairobi", x: 0.56, y: 0.61, kind: "seller", phase: 11.1 },
    { id: "johannesburg", x: 0.55, y: 0.72, kind: "buyer", phase: 11.8 },
    { id: "dubai", x: 0.59, y: 0.44, kind: "seller", phase: 12.3 },
    { id: "mumbai", x: 0.62, y: 0.51, kind: "buyer", phase: 12.9 },
    { id: "bangkok", x: 0.66, y: 0.55, kind: "seller", phase: 13.5 },
    { id: "singapore", x: 0.68, y: 0.61, kind: "buyer", phase: 14.0 },
    { id: "beijing", x: 0.68, y: 0.37, kind: "seller", phase: 14.6 },
    { id: "shanghai", x: 0.7, y: 0.43, kind: "buyer", phase: 15.1 },
    { id: "shenzhen", x: 0.69, y: 0.47, kind: "seller", phase: 15.7 },
    { id: "seoul", x: 0.75, y: 0.39, kind: "buyer", phase: 16.2 },
    { id: "tokyo", x: 0.78, y: 0.43, kind: "seller", phase: 16.8 },
    { id: "perth", x: 0.76, y: 0.72, kind: "buyer", phase: 17.4 },
    { id: "melbourne", x: 0.8, y: 0.77, kind: "seller", phase: 17.9 },
    { id: "sydney", x: 0.83, y: 0.73, kind: "buyer", phase: 18.5 },
  ];

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const routePairs = [
    ["seattle", "sf", "local"],
    ["sf", "la", "local"],
    ["la", "denver", "local"],
    ["denver", "texas", "local"],
    ["toronto", "nyc", "local"],
    ["mexico", "bogota", "local"],
    ["bogota", "lima", "local"],
    ["lima", "saopaulo", "local"],
    ["saopaulo", "buenosaires", "local"],
    ["london", "paris", "local"],
    ["paris", "berlin", "local"],
    ["madrid", "paris", "local"],
    ["berlin", "istanbul", "local"],
    ["istanbul", "moscow", "local"],
    ["cairo", "dubai", "local"],
    ["cairo", "lagos", "local"],
    ["lagos", "nairobi", "local"],
    ["nairobi", "johannesburg", "local"],
    ["dubai", "mumbai", "local"],
    ["mumbai", "bangkok", "local"],
    ["bangkok", "singapore", "local"],
    ["beijing", "shanghai", "local"],
    ["shanghai", "shenzhen", "local"],
    ["beijing", "seoul", "local"],
    ["seoul", "tokyo", "local"],
    ["perth", "melbourne", "local"],
    ["melbourne", "sydney", "local"],
    ["nyc", "london", "long"],
    ["sf", "tokyo", "long"],
    ["berlin", "beijing", "long"],
    ["singapore", "sydney", "long"],
  ];
  const routes = routePairs
    .map(([from, to, scope], index) => ({
      from: nodeById.get(from),
      to: nodeById.get(to),
      phase: (index * 0.137) % 1,
      scope,
      pace: scope === "long" ? 0.00006 + (index % 2) * 0.000008 : 0.0002 + (index % 5) * 0.000018,
    }))
    .filter((route) => route.from && route.to);

  function resize() {
    const rect = canvas.getBoundingClientRect();
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    canvas.width = Math.floor(width * pixelRatio);
    canvas.height = Math.floor(height * pixelRatio);
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }

  function point(node) {
    return {
      x: node.x * width,
      y: node.y * height,
    };
  }

  function drawBackground() {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#faf8f5");
    gradient.addColorStop(0.52, "#f1ece5");
    gradient.addColorStop(1, "#faf8f5");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(138,98,68,0.055)";
    ctx.lineWidth = 1;
    for (let x = width * 0.1; x < width; x += width * 0.1) {
      ctx.beginPath();
      ctx.moveTo(x, height * 0.18);
      ctx.lineTo(x, height * 0.86);
      ctx.stroke();
    }
    for (let y = height * 0.24; y < height * 0.84; y += height * 0.12) {
      ctx.beginPath();
      ctx.moveTo(width * 0.05, y);
      ctx.lineTo(width * 0.95, y);
      ctx.stroke();
    }
  }

  function drawLand() {
    ctx.save();
    land.forEach((shape) => {
      ctx.beginPath();
      shape.forEach(([x, y], index) => {
        const px = x * width;
        const py = y * height;
        if (index === 0) {
          ctx.moveTo(px, py);
        } else {
          ctx.lineTo(px, py);
        }
      });
      ctx.closePath();
      ctx.fillStyle = "rgba(138,98,68,0.1)";
      ctx.fill();
      ctx.strokeStyle = "rgba(44,44,44,0.08)";
      ctx.stroke();
    });
    ctx.restore();
  }

  function curvePoints(route) {
    const start = point(route.from);
    const end = point(route.to);
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    const isLong = route.scope === "long";
    const lift = Math.min(isLong ? 170 : 82, Math.abs(end.x - start.x) * (isLong ? 0.2 : 0.1) + (isLong ? 58 : 18));
    return {
      start,
      end,
      control: { x: midX, y: midY - lift },
    };
  }

  function curvePoint(route, progress) {
    const inv = 1 - progress;
    return {
      x:
        inv * inv * route.start.x +
        2 * inv * progress * route.control.x +
        progress * progress * route.end.x,
      y:
        inv * inv * route.start.y +
        2 * inv * progress * route.control.y +
        progress * progress * route.end.y,
    };
  }

  function drawTrail(route, progress) {
    const trailStart = Math.max(0, progress - 0.28);
    const steps = 18;

    for (let step = 0; step < steps; step += 1) {
      const fromProgress = trailStart + ((progress - trailStart) * step) / steps;
      const toProgress = trailStart + ((progress - trailStart) * (step + 1)) / steps;
      const from = curvePoint(route, fromProgress);
      const to = curvePoint(route, toProgress);
      const fade = (step + 1) / steps;

      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = `rgba(138,98,68,${0.018 + fade * 0.24})`;
      ctx.lineWidth = 0.7 + fade * 1.45;
      ctx.shadowColor = "rgba(196,149,106,0.48)";
      ctx.shadowBlur = fade > 0.66 ? 12 : 0;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    const token = curvePoint(route, progress);
    ctx.beginPath();
    ctx.arc(token.x, token.y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(138,98,68,0.92)";
    ctx.shadowColor = "rgba(196,149,106,0.82)";
    ctx.shadowBlur = 16;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function drawRoutes(time) {
    routes.forEach((routeConfig, index) => {
      const route = curvePoints(routeConfig);
      const activeWindow = getRouteActiveWindow(routeConfig);
      if (reduceMotion && index > 5) {
        return;
      }
      const cycle = getRouteCycle(routeConfig, index, time);

      if (cycle > activeWindow) {
        return;
      }

      const progress = reduceMotion ? Math.min(0.82, cycle / activeWindow) : cycle / activeWindow;
      drawTrail(route, progress);
    });
  }

  function getRouteActiveWindow(routeConfig) {
    return routeConfig.scope === "long" ? 0.12 : 0.34;
  }

  function getRouteCycle(routeConfig, index, time) {
    if (reduceMotion) {
      return 0.14 + index * 0.03;
    }
    return (time * routeConfig.pace + routeConfig.phase) % 1;
  }

  function drawBaseNode(node) {
    const p = point(node);
    const color = node.kind === "seller" ? "138,98,68" : "196,149,106";
    const coreRadius = node.kind === "seller" ? 2.5 : 2.1;

    ctx.beginPath();
    ctx.arc(p.x, p.y, coreRadius + 3.8, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${color},0.055)`;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p.x, p.y, coreRadius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${color},0.28)`;
    ctx.fill();
  }

  function drawNodeFlash(node, intensity) {
    if (intensity <= 0) {
      return;
    }

    const p = point(node);
    const color = node.kind === "seller" ? "138,98,68" : "196,149,106";
    const coreRadius = node.kind === "seller" ? 3.1 : 2.35;
    const alpha = intensity ** 1.5;

    ctx.beginPath();
    ctx.arc(p.x, p.y, coreRadius + 5 + intensity * 8, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${color},${alpha * 0.13})`;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p.x, p.y, coreRadius + intensity * 1.2, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${color},${0.18 + alpha * 0.76})`;
    ctx.shadowColor = `rgba(${color},${0.68 * alpha})`;
    ctx.shadowBlur = 8 + intensity * 12;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function drawNodes(time) {
    nodes.forEach((node) => {
      let intensity = 0;
      drawBaseNode(node);

      routes.forEach((routeConfig, index) => {
        const activeWindow = getRouteActiveWindow(routeConfig);
        if (reduceMotion && index > 5) {
          return;
        }

        const cycle = getRouteCycle(routeConfig, index, time);
        if (cycle > activeWindow) {
          return;
        }

        const progress = cycle / activeWindow;
        if (routeConfig.from === node && progress < 0.18) {
          intensity = Math.max(intensity, Math.sin((progress / 0.18) * Math.PI));
        }
        if (routeConfig.to === node && progress > 0.82) {
          intensity = Math.max(intensity, Math.sin(((progress - 0.82) / 0.18) * Math.PI));
        }
      });

      drawNodeFlash(node, intensity);
    });
  }

  function render(time = 0) {
    drawBackground();
    drawLand();
    drawRoutes(time);
    drawNodes(time);

    if (!reduceMotion) {
      animationFrame = window.requestAnimationFrame(render);
    }
  }

  resize();
  render(0);
  window.addEventListener("resize", () => {
    window.cancelAnimationFrame(animationFrame);
    resize();
    render(0);
  });
}

function initEntrySwitcher() {
  const entryContent = document.querySelector(".entry-content");
  const sellerPanel = document.querySelector(".entry-seller-panel");
  const sellerTrigger = document.querySelector("[data-entry-target='seller']");
  if (!entryContent || !sellerPanel || !sellerTrigger) {
    return;
  }

  function setSellerMode(active, { push = false } = {}) {
    document.body.classList.toggle("entry-earn-mode", active);
    entryContent.classList.toggle("is-active", !active);
    entryContent.setAttribute("aria-hidden", String(active));
    sellerPanel.setAttribute("aria-hidden", String(!active));
    if (push) {
      window.history.pushState({ entryMode: active ? "seller" : "entry" }, "", active ? "/seller/" : "/");
    }
  }

  function transitionToSeller(event) {
    event.preventDefault();
    const update = () => setSellerMode(true, { push: window.location.pathname !== "/seller/" });
    if (document.startViewTransition) {
      document.startViewTransition(update);
    } else {
      update();
    }
  }

  sellerTrigger.addEventListener("click", transitionToSeller);
  window.addEventListener("popstate", () => {
    setSellerMode(window.location.pathname.startsWith("/seller"));
  });
}

if (document.body.dataset.entryOnly === "true") {
  initNetworkMap();
  initEntrySwitcher();
} else {
  ensureAuthModal();
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAuthModal();
    }
  });

  renderAll();
  initNetworkMap();
  loadSellerAccount();

  window.setInterval(() => {
    if (document.visibilityState === "visible") {
      refreshSellerDataAndRender();
    }
  }, refreshIntervalMS);
}
