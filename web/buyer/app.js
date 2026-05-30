const state = {
  user: null,
  apiKey: "",
  apiKeyPrefix: "",
  openaiBaseUrl: `${window.location.origin}/v1`,
  anthropicBaseUrl: window.location.origin,
  balanceMicros: 0,
  usage: [],
  activeProvider: "codex",
};

const creditMicros = 1_000_000;

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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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

function storedSecretFor(prefix) {
  if (!prefix) {
    return "";
  }
  return window.localStorage.getItem(`subi_buyer_secret:${prefix}`) || "";
}

function rememberSecret(prefix, secret) {
  if (prefix && secret) {
    window.localStorage.setItem(`subi_buyer_secret:${prefix}`, secret);
  }
}

function providerContent() {
  const apiKey = state.apiKey || state.apiKeyPrefix || "Login to create a Subi buyer key";
  return {
    codex: {
      title: "Codex CLI",
      tag: "Recommended",
      copy: `export OPENAI_BASE_URL="${state.openaiBaseUrl}"
export OPENAI_API_KEY="${apiKey}"

codex \\
  -c 'model_provider="subi"' \\
  -c 'model_providers.subi.name="Subi"' \\
  -c "model_providers.subi.base_url=\\"\${OPENAI_BASE_URL}\\"" \\
  -c 'model_providers.subi.env_key="OPENAI_API_KEY"' \\
  -c 'model_providers.subi.wire_api="responses"' \\
  -c 'model_providers.subi.supports_websockets=false'`,
      test: `curl -sS "${state.openaiBaseUrl}/responses" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.1-codex",
    "input": "Reply exactly: SUBI_BUYER_OK",
    "stream": false
  }'`,
    },
    claude: {
      title: "Claude Code",
      tag: "Coming soon",
      copy: `export ANTHROPIC_BASE_URL="${state.anthropicBaseUrl}"
export ANTHROPIC_AUTH_TOKEN="${apiKey}"

claude`,
      test: `claude
# Ask: Reply exactly: SUBI_BUYER_OK`,
    },
    sdk: {
      title: "OpenAI SDK",
      tag: "Node.js",
      copy: `export OPENAI_BASE_URL="${state.openaiBaseUrl}"
export OPENAI_API_KEY="${apiKey}"`,
      test: `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

const response = await client.responses.create({
  model: "gpt-5.1-codex",
  input: "Reply exactly: SUBI_BUYER_OK",
});

console.log(response.output_text);`,
    },
    cursor: {
      title: "Cursor / Continue",
      tag: "OpenAI-compatible",
      copy: `Base URL: ${state.openaiBaseUrl}
API Key: ${apiKey}`,
      test: `{
  "models": [
    {
      "title": "Subi",
      "provider": "openai",
      "model": "gpt-5.1-codex",
      "apiBase": "${state.openaiBaseUrl}",
      "apiKey": "${apiKey}"
    }
  ]
}`,
    },
    curl: {
      title: "cURL",
      tag: "Debug",
      copy: `curl -sS "${state.openaiBaseUrl}/responses" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.1-codex",
    "input": "Reply exactly: SUBI_BUYER_OK",
    "stream": false
  }'`,
      test: `# Success body should include:
SUBI_BUYER_OK`,
    },
  };
}

function renderProvider(providerKey = state.activeProvider) {
  state.activeProvider = providerKey;
  const provider = providerContent()[providerKey];
  const container = document.querySelector("#provider-content");
  if (!container || !provider) {
    return;
  }
  container.innerHTML = `
    <div class="provider-title">
      <h3>${provider.title}</h3>
      <span class="tag">${provider.tag}</span>
    </div>
    <div class="code-block">
      <button class="code-copy" type="button">Copy</button>
      <pre><code>${escapeHtml(provider.copy)}</code></pre>
    </div>
    <div class="code-block">
      <button class="code-copy" type="button">Copy</button>
      <pre><code>${escapeHtml(provider.test)}</code></pre>
    </div>
  `;
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  if (!toast) {
    return;
  }
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 1600);
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
  showToast("Copied");
}

function setText(selector, value) {
  const el = document.querySelector(selector);
  if (el) {
    el.textContent = value;
  }
}

function setInput(selector, value) {
  const el = document.querySelector(selector);
  if (el) {
    el.value = value;
  }
}

function renderAuth() {
  const button = document.querySelector("#auth-action");
  if (!button) {
    return;
  }
  button.textContent = state.user ? "Logout" : "Login";
}

function renderAccess() {
  const shownKey = state.apiKey || state.apiKeyPrefix || "Login to create a key";
  setInput("#api-key", shownKey);
  setInput("#openai-base-url", state.openaiBaseUrl);
  setInput("#anthropic-base-url", state.anthropicBaseUrl);
  renderProvider();
}

function renderBalance() {
  const credits = formatCredits(state.balanceMicros);
  setText("#top-balance span", `${credits} Credits`);
  setText("#credit-balance", credits);
  setText("#credit-estimate", state.user ? `Estimated for ${Math.floor(Number(state.balanceMicros || 0) / 3_000_000).toLocaleString()} short coding requests.` : "Login to load your balance.");

  const debits = state.usage.reduce((sum, item) => sum + Number(item.cost_micros || 0), 0);
  setText("#today-spend", formatCredits(debits));
  setText("#request-count", String(state.usage.length));
}

function renderUsage() {
  const body = document.querySelector("#usage-table-body");
  if (!body) {
    return;
  }
  if (!state.user) {
    body.innerHTML = `<tr><td colspan="5">Login to load usage.</td></tr>`;
    return;
  }
  if (state.usage.length === 0) {
    body.innerHTML = `<tr><td colspan="5">No usage yet.</td></tr>`;
    return;
  }
  body.innerHTML = state.usage
    .map((item) => {
      const ok = Number(item.status || 0) >= 200 && Number(item.status || 0) < 400 && !item.error;
      const status = ok ? "Completed" : "Refunded";
      const statusClass = ok ? "ok" : "refunded";
      const duration = item.duration_ms ? `${(Number(item.duration_ms) / 1000).toFixed(1)}s` : "-";
      const credits = item.cost_micros ? `-${formatCredits(item.cost_micros)}` : "0";
      return `
        <tr>
          <td><code>${escapeHtml(compactID(item.request_id))}</code></td>
          <td><span class="table-status ${statusClass}">${status}</span></td>
          <td>${escapeHtml(item.seller_node_id || "-")}</td>
          <td>${escapeHtml(duration)}</td>
          <td>${escapeHtml(credits)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderDoctor() {
  const checks = [...document.querySelectorAll("#doctor-list li")];
  checks.forEach((item) => item.classList.remove("done"));
  const passing = [
    Boolean(state.user),
    Boolean(state.apiKey || state.apiKeyPrefix),
    Number(state.balanceMicros || 0) > 0,
    state.usage.some((item) => item.seller_node_id) || state.user,
  ];
  checks.forEach((item, index) => {
    if (passing[index]) {
      item.classList.add("done");
    }
  });
  setText("#doctor-status", state.user ? "Live account checks" : "Waiting for login");
}

function renderAll() {
  renderAuth();
  renderAccess();
  renderBalance();
  renderUsage();
  renderDoctor();
  window.lucide?.createIcons();
}

async function ensureBuyerKey() {
  const keysPayload = await api("/api/web/buyer/api-keys");
  const keys = keysPayload.api_keys || [];
  const existing = keys.find((key) => !key.revoked_at);
  if (existing) {
    const stored = storedSecretFor(existing.key_prefix);
    if (stored) {
      state.apiKeyPrefix = existing.key_prefix;
      state.apiKey = stored;
      return;
    }
  }

  const created = await api("/api/web/buyer/api-keys", {
    method: "POST",
    body: { name: "Codex" },
  });
  state.apiKey = created.secret;
  state.apiKeyPrefix = created.api_key?.key_prefix || "";
  rememberSecret(state.apiKeyPrefix, state.apiKey);
}

async function refreshBuyerData() {
  const [balancePayload, usagePayload] = await Promise.all([
    api("/api/web/buyer/balance"),
    api("/api/web/buyer/usage?limit=20"),
  ]);
  state.balanceMicros = balancePayload.wallet?.balance_micros || 0;
  state.usage = usagePayload.usage || [];
}

async function loadAccount() {
  try {
    const payload = await api("/api/web/auth/me");
    state.user = payload.user;
    await ensureBuyerKey();
    await refreshBuyerData();
  } catch (error) {
    if (error.status !== 401) {
      showToast(error.message);
    }
    state.user = null;
    state.apiKey = "";
    state.apiKeyPrefix = "";
    state.balanceMicros = 0;
    state.usage = [];
  }
  renderAll();
}

async function loginOrRegister() {
  const email = window.prompt("Email");
  if (!email) {
    return;
  }
  const password = window.prompt("Password, at least 8 characters");
  if (!password) {
    return;
  }
  try {
    await api("/api/web/auth/login", {
      method: "POST",
      body: { email, password },
    });
  } catch (error) {
    if (error.status !== 401) {
      throw error;
    }
    await api("/api/web/auth/register", {
      method: "POST",
      body: { email, password },
    });
  }
  showToast("Logged in");
  await loadAccount();
}

async function logout() {
  await api("/api/web/auth/logout", { method: "POST" });
  state.user = null;
  state.apiKey = "";
  state.apiKeyPrefix = "";
  state.balanceMicros = 0;
  state.usage = [];
  renderAll();
  showToast("Logged out");
}

async function addCredits(amount) {
  if (!state.user) {
    await loginOrRegister();
    if (!state.user) {
      return;
    }
  }
  await api("/api/web/buyer/credits/orders", {
    method: "POST",
    body: { amount_credits: amount },
  });
  await refreshBuyerData();
  renderAll();
  showToast(`Added ${amount} credits`);
}

document.addEventListener("click", async (event) => {
  const copyTarget = event.target.closest("[data-copy-target]");
  if (copyTarget) {
    const input = document.getElementById(copyTarget.dataset.copyTarget);
    copyText(input.value);
    return;
  }

  const codeCopy = event.target.closest(".code-copy");
  if (codeCopy) {
    const code = codeCopy.parentElement.querySelector("code");
    copyText(code.textContent);
    return;
  }

  const providerTab = event.target.closest("[data-provider]");
  if (providerTab) {
    document.querySelectorAll(".provider-tab").forEach((tab) => {
      const active = tab === providerTab;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    renderProvider(providerTab.dataset.provider);
    return;
  }

  const scrollTarget = event.target.closest("[data-scroll-target]");
  if (scrollTarget) {
    document.querySelector(scrollTarget.dataset.scrollTarget)?.scrollIntoView({ behavior: "smooth" });
    return;
  }

  const addButton = event.target.closest("[data-add-credits]");
  if (addButton) {
    const amount = Number.parseInt(addButton.dataset.addCredits, 10);
    if (Number.isFinite(amount) && amount > 0) {
      try {
        await addCredits(amount);
      } catch (error) {
        showToast(error.message);
      }
    }
  }
});

document.querySelector("#auth-action")?.addEventListener("click", async () => {
  try {
    if (state.user) {
      await logout();
    } else {
      await loginOrRegister();
    }
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#reveal-key")?.addEventListener("click", () => {
  const apiKeyInput = document.querySelector("#api-key");
  const visible = apiKeyInput.type === "text";
  apiKeyInput.type = visible ? "password" : "text";
  document.querySelector("#reveal-key").innerHTML = visible
    ? '<i data-lucide="eye" aria-hidden="true"></i>Reveal key'
    : '<i data-lucide="eye-off" aria-hidden="true"></i>Hide key';
  window.lucide?.createIcons();
});

document.querySelector("#run-doctor")?.addEventListener("click", () => {
  renderDoctor();
  showToast(state.user ? "Doctor passed" : "Login required");
});

document.querySelector("#add-custom-credits")?.addEventListener("click", async () => {
  const input = document.querySelector("#custom-credits");
  const amount = Number.parseInt(input.value, 10);
  if (!Number.isFinite(amount) || amount < 50) {
    input.value = "50";
    showToast("Minimum is 50 credits");
    return;
  }
  try {
    await addCredits(amount);
  } catch (error) {
    showToast(error.message);
  }
});

renderAll();
loadAccount();
