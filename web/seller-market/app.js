const sellerTokenValue = "seller_node_live_9xQp2aDemoToken";
const gatewayWsUrlValue = "wss://api.subi.xyz/api/v1/subi/seller/agent/ws";
const nodeIdValue = "seller-macbook-001";

const providerContent = {
  codex: {
    title: "Codex 订阅",
    tag: "推荐",
    note:
      "使用这台机器上已经登录的 Codex 订阅态。这个路径不需要卖家提供 OpenAI API key。",
    config: `export SUBI_GATEWAY_WS_URL="${gatewayWsUrlValue}"
export SUBI_SELLER_NODE_TOKEN="${sellerTokenValue}"
export SUBI_NODE_ID="${nodeIdValue}"
export SELLER_UPSTREAM_MODE="codex-app-server"
export SELLER_CODEX_WORKERS=1
export SELLER_CODEX_BIN="$(command -v codex)"
export SELLER_CODEX_MODEL="gpt-5.5"
export SELLER_CODEX_WORKDIR="/tmp/subi-codex-work"
export SELLER_CODEX_SANDBOX="read-only"
export SELLER_CODEX_APP_SERVER_PORT_BASE=19100
export SELLER_CODEX_APP_SERVER_STICKY_THREADS=true`,
    start: `./seller-agent`,
  },
  claude: {
    title: "Claude Code 订阅",
    tag: "目标形态",
    note:
      "Claude Code 卖家模式是产品目标形态。当前 MVP 先保留为等待名单占位。",
    config: `# 即将开放
# 卖家客户端会复用这台机器上的 Claude Code 订阅态。
# MVP-0 暂未开放原生 Claude Code 卖家模式。`,
    start: `# 该 Provider 开放后，在卖家后台加入等待名单。`,
  },
  http: {
    title: "本地 HTTP Upstream",
    tag: "高级模式",
    note:
      "当卖家机器上已经运行本地 OpenAI-compatible 或 Anthropic-compatible upstream 服务时使用。",
    config: `export SUBI_GATEWAY_WS_URL="${gatewayWsUrlValue}"
export SUBI_SELLER_NODE_TOKEN="${sellerTokenValue}"
export SUBI_NODE_ID="${nodeIdValue}"
export SELLER_UPSTREAM_MODE="http"
export SELLER_LOCAL_BASE_URL="http://127.0.0.1:8081"
export SELLER_LOCAL_API_KEY="local-upstream-key"`,
    start: `./seller-agent`,
  },
  vps: {
    title: "VPS Headless",
    tag: "常驻在线",
    note:
      "在 VPS 上运行同一个卖家客户端，可以获得更稳定的在线时间。VPS 是设备，Provider 仍然是 Codex、Claude 或本地 HTTP。",
    config: `export SUBI_GATEWAY_WS_URL="${gatewayWsUrlValue}"
export SUBI_SELLER_NODE_TOKEN="${sellerTokenValue}"
export SUBI_NODE_ID="seller-vps-001"
export SELLER_UPSTREAM_MODE="codex-app-server"
export SELLER_CODEX_WORKERS=1
export SELLER_CODEX_BIN="$(command -v codex)"
export SELLER_CODEX_WORKDIR="/tmp/subi-codex-work"
export SELLER_CODEX_SANDBOX="read-only"`,
    start: `nohup ./seller-agent > seller-agent.log 2>&1 &`,
  },
};

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderProvider(providerKey) {
  const provider = providerContent[providerKey];
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

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 1500);
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
  showToast("自检通过");
});

renderProvider("codex");
