const isStaticPreview = window.location.protocol === "file:";
const publicOrigin = isStaticPreview ? "https://api.subi.xyz" : window.location.origin;

const state = {
  user: null,
  apiKey: "",
  apiKeyID: "",
  apiKeyPrefix: "",
  apiKeys: [],
  openaiBaseUrl: `${publicOrigin}/v1`,
  anthropicBaseUrl: publicOrigin,
  balanceMicros: 0,
  usage: [],
  ledger: [],
  activeProvider: "codex",
  authMode: "login",
  refreshing: false,
};

const creditMicros = 1_000_000;
const refreshIntervalMS = 5000;

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

function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  if (isStaticPreview) {
    const error = new Error("Run behind Subi Gateway to use live account data");
    error.status = path === "/api/web/auth/me" ? 401 : 503;
    throw error;
  }
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

function forgetSecret(prefix) {
  if (prefix) {
    window.localStorage.removeItem(`subi_buyer_secret:${prefix}`);
  }
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
          <button class="auth-close" type="button" data-auth-close aria-label="Close">Close</button>
          <div class="auth-heading">
            <span class="brand-mark">S</span>
            <div>
              <h2 id="auth-modal-title">Sign in to Subi</h2>
              <p id="auth-modal-copy">Manage credits, API keys, and request usage.</p>
            </div>
          </div>
          <div class="auth-tabs" role="tablist" aria-label="Authentication mode">
            <button class="active" type="button" role="tab" aria-selected="true" data-auth-mode="login">Sign in</button>
            <button type="button" role="tab" aria-selected="false" data-auth-mode="register">Create account</button>
          </div>
          <div class="auth-provider-grid">
            <button class="auth-provider" type="button" data-auth-disabled>
              <span>G</span>
              Google
            </button>
            <button class="auth-provider" type="button" data-auth-disabled>
              <span>A</span>
              Apple
            </button>
          </div>
          <button class="auth-provider auth-provider-wide" type="button" data-auth-disabled>
            <span>@</span>
            Email verification code
          </button>
          <div class="auth-divider"><span>Email and password</span></div>
          <form class="auth-form" id="auth-form">
            <label>
              <span>Email</span>
              <input id="auth-email" name="email" type="email" autocomplete="email" placeholder="you@company.com" required />
            </label>
            <label>
              <span>Password</span>
              <input id="auth-password" name="password" type="password" autocomplete="current-password" minlength="8" placeholder="At least 8 characters" required />
            </label>
            <p class="auth-error" id="auth-error" role="alert"></p>
            <button class="btn btn-primary full" id="auth-submit" type="submit">Sign in</button>
          </form>
        </section>
      </div>
    `,
  );
  document.querySelector("#auth-form")?.addEventListener("submit", handleAuthSubmit);
}

function setAuthMode(mode) {
  state.authMode = mode === "register" ? "register" : "login";
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    const active = button.dataset.authMode === state.authMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  setText("#auth-modal-title", state.authMode === "register" ? "Create your Subi account" : "Sign in to Subi");
  setText(
    "#auth-modal-copy",
    state.authMode === "register" ? "Create a buyer or seller workspace with email and password." : "Manage credits, API keys, and request usage.",
  );
  setText("#auth-submit", state.authMode === "register" ? "Create account" : "Sign in");
  setText("#auth-error", "");
  const passwordInput = document.querySelector("#auth-password");
  if (passwordInput) {
    passwordInput.autocomplete = state.authMode === "register" ? "new-password" : "current-password";
  }
}

function openAuthModal(mode = "login") {
  ensureAuthModal();
  setAuthMode(mode);
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

function providerContent() {
  const apiKey = state.apiKey || state.apiKeyPrefix || "Sign in to create a Subi buyer key";
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
  button.textContent = state.user ? "Sign out" : "Sign in";
}

function renderAccess() {
  const shownKey = state.apiKey || state.apiKeyPrefix || "Sign in to create a key";
  setInput("#api-key", shownKey);
  setInput("#openai-base-url", state.openaiBaseUrl);
  setInput("#anthropic-base-url", state.anthropicBaseUrl);
  setText("#active-key-pill", state.apiKeyPrefix ? `Active ${state.apiKeyPrefix}` : "No active key");
  renderProvider();
}

function renderBalance() {
  const credits = formatCredits(state.balanceMicros);
  setText("#top-balance span", `${credits} Credits`);
  setText("#credit-balance", credits);
  setText("#credit-estimate", state.user ? `Estimated for ${Math.floor(Number(state.balanceMicros || 0) / 3_000_000).toLocaleString()} short coding requests.` : "Sign in to load your balance.");

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
    body.innerHTML = `<tr><td colspan="5">Sign in to load usage.</td></tr>`;
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

function renderAPIKeys() {
  const body = document.querySelector("#api-keys-table-body");
  if (!body) {
    return;
  }
  if (!state.user) {
    body.innerHTML = `<tr><td colspan="5">Sign in to load API keys.</td></tr>`;
    return;
  }
  if (state.apiKeys.length === 0) {
    body.innerHTML = `<tr><td colspan="5">No API keys yet.</td></tr>`;
    return;
  }
  body.innerHTML = state.apiKeys
    .map((key) => {
      const revoked = Boolean(key.revoked_at);
      const active = key.id === state.apiKeyID && !revoked;
      const statusClass = revoked ? "refunded" : "ok";
      const status = revoked ? "Revoked" : active ? "Current" : "Active";
      return `
        <tr>
          <td>${escapeHtml(key.name || "Default key")}</td>
          <td><code>${escapeHtml(key.key_prefix || "-")}</code></td>
          <td><span class="table-status ${statusClass}">${status}</span></td>
          <td>${escapeHtml(formatDateTime(key.last_used_at))}</td>
          <td>${escapeHtml(formatDateTime(key.created_at))}</td>
        </tr>
      `;
    })
    .join("");
}

function ledgerTypeLabel(type) {
  switch (type) {
    case "recharge":
      return "Recharge";
    case "debit":
      return "Debit";
    case "refund":
      return "Refund";
    default:
      return type || "-";
  }
}

function renderLedger() {
  const body = document.querySelector("#ledger-table-body");
  if (!body) {
    return;
  }
  if (!state.user) {
    body.innerHTML = `<tr><td colspan="5">Sign in to load ledger.</td></tr>`;
    return;
  }
  if (state.ledger.length === 0) {
    body.innerHTML = `<tr><td colspan="5">No credit ledger entries yet.</td></tr>`;
    return;
  }
  body.innerHTML = state.ledger
    .map((entry) => {
      const amountMicros = Number(entry.amount_micros || 0);
      const sign = amountMicros > 0 ? "+" : amountMicros < 0 ? "-" : "";
      const statusClass = amountMicros >= 0 ? "ok" : "refunded";
      return `
        <tr>
          <td>${escapeHtml(formatDateTime(entry.created_at))}</td>
          <td><span class="table-status ${statusClass}">${escapeHtml(ledgerTypeLabel(entry.type))}</span></td>
          <td>${escapeHtml(`${sign}${formatCredits(Math.abs(amountMicros))}`)}</td>
          <td>${escapeHtml(formatCredits(entry.balance_after_micros))}</td>
          <td><code>${escapeHtml(compactID(entry.request_id))}</code></td>
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
  setText("#doctor-status", state.user ? "Live account checks" : "Waiting for sign in");
}

function renderAll() {
  renderAuth();
  renderAccess();
  renderBalance();
  renderAPIKeys();
  renderUsage();
  renderLedger();
  renderDoctor();
  window.lucide?.createIcons();
}

async function ensureBuyerKey() {
  const keysPayload = await api("/api/web/buyer/api-keys");
  const keys = keysPayload.api_keys || [];
  state.apiKeys = keys;
  const existing = keys.find((key) => !key.revoked_at);
  if (existing) {
    const stored = storedSecretFor(existing.key_prefix);
    if (stored) {
      state.apiKeyID = existing.id;
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
  state.apiKeyID = created.api_key?.id || "";
  state.apiKeyPrefix = created.api_key?.key_prefix || "";
  state.apiKeys = created.api_key ? [created.api_key, ...keys] : keys;
  rememberSecret(state.apiKeyPrefix, state.apiKey);
}

async function createBuyerKey() {
  if (!state.user) {
    await loginOrRegister();
    if (!state.user) {
      return;
    }
  }
  const created = await api("/api/web/buyer/api-keys", {
    method: "POST",
    body: { name: `Codex ${new Date().toLocaleDateString()}` },
  });
  state.apiKey = created.secret;
  state.apiKeyID = created.api_key?.id || "";
  state.apiKeyPrefix = created.api_key?.key_prefix || "";
  rememberSecret(state.apiKeyPrefix, state.apiKey);
  const keysPayload = await api("/api/web/buyer/api-keys");
  state.apiKeys = keysPayload.api_keys || [];
  renderAll();
  showToast("Created key");
}

async function revokeCurrentBuyerKey() {
  if (!state.user || !state.apiKeyID) {
    showToast("No active key");
    return;
  }
  if (!window.confirm(`Revoke ${state.apiKeyPrefix || "current key"}?`)) {
    return;
  }
  await api(`/api/web/buyer/api-keys/${encodeURIComponent(state.apiKeyID)}/revoke`, {
    method: "POST",
  });
  forgetSecret(state.apiKeyPrefix);
  state.apiKey = "";
  state.apiKeyID = "";
  state.apiKeyPrefix = "";
  const keysPayload = await api("/api/web/buyer/api-keys");
  state.apiKeys = keysPayload.api_keys || [];
  const fallback = state.apiKeys.find((key) => !key.revoked_at && storedSecretFor(key.key_prefix));
  if (fallback) {
    state.apiKey = storedSecretFor(fallback.key_prefix);
    state.apiKeyID = fallback.id;
    state.apiKeyPrefix = fallback.key_prefix;
  }
  renderAll();
  showToast("Revoked key");
}

async function refreshBuyerData() {
  if (!state.user || state.refreshing) {
    return;
  }
  state.refreshing = true;
  try {
    const [balancePayload, usagePayload, ledgerPayload, keysPayload] = await Promise.all([
      api("/api/web/buyer/balance"),
      api("/api/web/buyer/usage?limit=20"),
      api("/api/web/buyer/credits/ledger?limit=50"),
      api("/api/web/buyer/api-keys"),
    ]);
    state.balanceMicros = balancePayload.wallet?.balance_micros || 0;
    state.usage = usagePayload.usage || [];
    state.ledger = ledgerPayload.ledger || [];
    state.apiKeys = keysPayload.api_keys || state.apiKeys;
  } finally {
    state.refreshing = false;
  }
}

async function refreshBuyerDataAndRender({ toast = false } = {}) {
  if (!state.user) {
    if (toast) {
      showToast("Sign in required");
    }
    return;
  }
  try {
    await refreshBuyerData();
    renderAll();
    if (toast) {
      showToast("Refreshed");
    }
  } catch (error) {
    if (toast) {
      showToast(error.message);
    }
  }
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
    state.apiKeyID = "";
    state.apiKeyPrefix = "";
    state.apiKeys = [];
    state.balanceMicros = 0;
    state.usage = [];
    state.ledger = [];
  }
  renderAll();
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = document.querySelector("#auth-submit");
  const email = String(form.email.value || "").trim();
  const password = String(form.password.value || "");
  if (!email || !password) {
    setText("#auth-error", "Email and password are required.");
    return;
  }
  if (password.length < 8) {
    setText("#auth-error", "Password must be at least 8 characters.");
    return;
  }
  setText("#auth-error", "");
  if (submitButton) {
    submitButton.disabled = true;
  }
  try {
    await api(state.authMode === "register" ? "/api/web/auth/register" : "/api/web/auth/login", {
      method: "POST",
      body: { email, password },
    });
    closeAuthModal();
    showToast(state.authMode === "register" ? "Account created" : "Signed in");
    await loadAccount();
  } catch (error) {
    if (state.authMode === "login" && error.status === 401) {
      setText("#auth-error", "Email or password is incorrect.");
    } else if (state.authMode === "register" && error.status === 409) {
      setText("#auth-error", "Account already exists. Sign in instead.");
    } else {
      setText("#auth-error", error.message);
    }
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
    }
  }
}

async function loginOrRegister(mode = "login") {
  openAuthModal(mode);
}

async function logout() {
  await api("/api/web/auth/logout", { method: "POST" });
  state.user = null;
  state.apiKey = "";
  state.apiKeyID = "";
  state.apiKeyPrefix = "";
  state.apiKeys = [];
  state.balanceMicros = 0;
  state.usage = [];
  state.ledger = [];
  renderAll();
  showToast("Signed out");
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
  const authClose = event.target.closest("[data-auth-close]");
  if (authClose) {
    closeAuthModal();
    return;
  }

  const authModeButton = event.target.closest("[data-auth-mode]");
  if (authModeButton) {
    setAuthMode(authModeButton.dataset.authMode);
    return;
  }

  const authDisabled = event.target.closest("[data-auth-disabled]");
  if (authDisabled) {
    showToast("This sign-in method is coming soon");
    return;
  }

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
      openAuthModal("login");
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

document.querySelector("#create-key")?.addEventListener("click", async () => {
  try {
    await createBuyerKey();
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#revoke-key")?.addEventListener("click", async () => {
  try {
    await revokeCurrentBuyerKey();
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#run-doctor")?.addEventListener("click", () => {
  renderDoctor();
  showToast(state.user ? "Doctor passed" : "Sign in required");
});

document.querySelector("#refresh-data")?.addEventListener("click", () => {
  refreshBuyerDataAndRender({ toast: true });
});

document.querySelector("#refresh-usage")?.addEventListener("click", () => {
  refreshBuyerDataAndRender({ toast: true });
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

ensureAuthModal();
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeAuthModal();
  }
});

renderAll();
loadAccount();

window.setInterval(() => {
  if (document.visibilityState === "visible") {
    refreshBuyerDataAndRender();
  }
}, refreshIntervalMS);
