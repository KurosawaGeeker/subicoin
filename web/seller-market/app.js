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
};

const creditMicros = 1_000_000;
const refreshIntervalMS = 5000;

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

function providerContent() {
  const nodeID = sellerState.activeNode?.node_id || defaultNodeID();
  const installCommand = oneShotInstallCommand();
  return {
    codex: {
      title: "Codex 订阅",
      tag: "推荐",
      note:
        "只复用这台机器上的 Codex 登录态发网络请求，不在你的机器执行使用者的工具命令。",
      config: installCommand,
      start: `# 安装完成后，seller-agent 会由 launchd / systemd / nohup 保持运行。`,
    },
    claude: {
      title: "Claude Code 订阅",
      tag: "Anthropic Messages",
      note:
        "复用这台机器上的 Claude Code 凭据、claude setup-token、ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY，只转发 Anthropic Messages 请求。",
      config: installCommand,
      start: `# macOS 上请先运行 claude setup-token，并把输出写入 config.env 的 SELLER_CLAUDE_CODE_OAUTH_TOKEN。
# 也可以设置 SELLER_ANTHROPIC_AUTH_TOKEN / SELLER_ANTHROPIC_API_KEY。`,
    },
    http: {
      title: "本地 HTTP Upstream",
      tag: "暂停开放",
      note:
        "当前产品边界只允许使用 Codex 登录态或 Claude Code 凭据网络请求，本地 HTTP 模式暂不接入用户流量。",
      config: `# 暂不开放。请使用 Codex 或 Claude Code 订阅模式。`,
      start: `# 当前真实流量只调度 codex-login 和 claude-code 节点。`,
    },
    vps: {
      title: "VPS Headless",
      tag: "常驻在线",
      note:
        "在 VPS 上运行同一个本地客户端，可以获得更稳定的在线时间。VPS 是设备，Provider 仍然是 Codex、Claude 或本地 HTTP。",
      config: installCommand.replace(nodeID, `${nodeID}-vps`),
      start: `nohup ~/.subi/seller/seller-agent > ~/.subi/seller/seller-agent.log 2>&1 &`,
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
    <div class="code-block">
      <button class="code-copy" type="button">复制</button>
      <pre><code>${escapeHtml(provider.config)}</code></pre>
    </div>
    <div class="code-block">
      <button class="code-copy" type="button">复制</button>
      <pre><code>${escapeHtml(provider.start)}</code></pre>
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

  const codeCopy = event.target.closest(".code-copy");
  if (codeCopy) {
    const code = codeCopy.parentElement.querySelector("code");
    copyText(code.textContent);
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
  setText("#seller-node-workers", node ? `${node.max_concurrency || 1} worker` : "--");
  renderProvider();
  renderDoctorResult();
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

  const labels = {
    passed: "通过",
    failed: "失败",
    blocked: "未完成",
  };
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const visibleChecks = result.status === "passed" ? [] : checks.filter((check) => check.status !== "passed");
  const checksMarkup = visibleChecks.length
    ? `
      <div class="doctor-checks">
        ${visibleChecks
          .map(
            (check) => `
              <div class="doctor-check ${escapeHtml(check.status || "blocked")}">
                <span>${escapeHtml(check.label || check.id || "检查项")}</span>
                <b>${escapeHtml(labels[check.status] || "未完成")}</b>
                <p>${escapeHtml(check.message || "")}</p>
              </div>
            `,
          )
          .join("")}
      </div>
    `
    : "";
  panel.hidden = false;
  panel.innerHTML = `
    <div class="doctor-summary ${escapeHtml(result.status || "blocked")}">
      <span>${escapeHtml(labels[result.status] || "未完成")}</span>
      <p>${escapeHtml(result.next_action || "查看分项结果后重试。")}</p>
    </div>
    ${checksMarkup}
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
