const isStaticPreview = window.location.protocol === "file:";
const publicOrigin = isStaticPreview ? "https://api.subi.xyz" : window.location.origin;
const savedLocale = window.localStorage.getItem("subi_buyer_locale");
const initialLocale = savedLocale === "en" || savedLocale === "zh" ? savedLocale : "zh";

const state = {
  locale: initialLocale,
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
  refreshing: false,
  revealedKeys: new Set(),
};

const creditMicros = 1_000_000;
const refreshIntervalMS = 5000;
const codeCopyPayloads = new Map();

const i18n = {
  en: {
    pageTitle: "Subi Model Access Console",
    buyer: "Use models",
    seller: "Earn",
    dashboard: "Dashboard",
    creditsNav: "Credits",
    setupNav: "Setup",
    keysNav: "Keys",
    usageNav: "Usage",
    refresh: "Refresh",
    signIn: "Sign in",
    signOut: "Sign out",
    heroTitle: "The cheapest top models\nPowered by SUBI community contributors",
    heroCopy: "Buy credits once and use one Subi key across your coding clients.",
    noProxy: "No VPN needed",
    lowerCost: "Lowest price",
    p2pNetwork: "Community supply network",
    buyCreditsCta: "Buy Credits",
    accessCta: "Access keys",
    setupCta: "Setup",
    yourCredits: "Your Credits",
    signInLoadBalance: "Sign in to load your balance.",
    todaySpend: "Today spend",
    requests: "Requests",
    accessTitle: "Your Subi access",
    accessCopy:
      "Claude Code does not need a separate key. Use the same Subi API key with the Anthropic-compatible URL.",
    revealKey: "Reveal key",
    hideKey: "Hide key",
    subiBuyerApiKey: "SUBI API KEY",
    signInCreateKey: "Sign in to create a key",
    newKey: "New key",
    deleteCurrent: "Delete current key",
    buyCreditsTitle: "Buy credits",
    offchainBalance: "Off-chain MVP balance",
    starter: "Starter",
    starterCopy: "Quick test budget.",
    add100: "Add 100",
    builder: "Builder",
    builderCopy: "Daily coding usage.",
    add500: "Add 500",
    studio: "Studio",
    studioCopy: "Heavy sessions.",
    add2000: "Add 2,000",
    custom: "Custom",
    customCopy: "Minimum top-up is 50 credits.",
    creditsAmount: "Credits amount",
    addCustom: "Add Custom",
    apiKeys: "API keys",
    noActiveKey: "No active key",
    activeKey: "Active",
    selectedKey: "Selected",
    name: "Name",
    keyColumn: "Key",
    status: "Status",
    lastUsed: "Last used",
    created: "Created",
    actions: "Actions",
    useKey: "Use",
    selected: "Selected",
    copyKey: "Copy key",
    deleteKey: "Delete key",
    secretUnavailableShort: "Full key unavailable",
    secretUnavailableToast: "Full key is not available. Create a new key if you lost it.",
    secretHintKnown: "Full key is available on this device. Copy or reveal it only when configuring a client.",
    secretHintUnknown:
      "Only the prefix is available for this key. Subi returns the full secret only when the key is created.",
    selectedKeyToast: "Selected {key}",
    configureClient: "Configure your client",
    providerTemplateNote:
      "Template shows {key}*** on screen. Copy uses the full key saved on this device.",
    providerTemplateMissingSecret:
      "Template shows {key}*** on screen, but the full key is not available on this device. Delete and recreate it before copying.",
    providerTemplateNoKey: "Create or select an API key before configuring a client.",
    runDoctor: "Run Doctor",
    buyerDoctor: "Access Doctor",
    waitingSignIn: "Waiting for sign in",
    liveChecks: "Live account checks",
    subiReady: "Subi service ready",
    keyValid: "API key format valid",
    creditsAboveZero: "Credits above zero",
    sellerAvailable: "Supply node available",
    supplyNode: "Node",
    creditActivity: "Credit activity",
    request: "Request",
    duration: "Duration",
    creditCost: "Credits",
    creditLedger: "Credit ledger",
    balanceHistory: "Balance history",
    time: "Time",
    type: "Type",
    amount: "Amount",
    balance: "Balance",
    copied: "Copied",
    languageSwitched: "Language switched",
    staticPreviewError: "Run behind Subi Gateway to use live account data",
    authTitle: "Sign in to Subi",
    authCopy: "Use email and password. New accounts are created automatically.",
    close: "Close",
    emailCode: "Email verification code",
    emailPassword: "Email and password",
    email: "Email",
    password: "Password",
    passwordPlaceholder: "At least 8 characters",
    authRequired: "Email and password are required.",
    passwordTooShort: "Password must be at least 8 characters.",
    signedIn: "Signed in",
    signedOut: "Signed out",
    wrongEmailPassword: "Email or password is incorrect.",
    signInRequired: "Sign in required",
    authMethodSoon: "This sign-in method is coming soon",
    createdKey: "Created key",
    deletedKey: "Deleted key",
    noActiveKeyToast: "No active key",
    deleteConfirm: "Delete {key}? This cannot be undone.",
    currentKey: "current key",
    refreshed: "Refreshed",
    doctorPassed: "Doctor passed",
    minimumCredits: "Minimum is 50 credits",
    addedCredits: "Added {amount} credits",
    estimateRequests: "Estimated for {count} short coding requests.",
    signInLoadUsage: "Sign in to load usage.",
    noUsage: "No usage yet.",
    signInLoadKeys: "Sign in to load API keys.",
    noKeys: "No API keys yet.",
    defaultKey: "Default key",
    completed: "Completed",
    refunded: "Refunded",
    deleted: "Deleted",
    current: "Current",
    active: "Active",
    signInLoadLedger: "Sign in to load ledger.",
    noLedger: "No credit ledger entries yet.",
    recharge: "Recharge",
    debit: "Debit",
    refund: "Refund",
    copy: "Copy",
    codexTitle: "Codex CLI",
    recommended: "Recommended",
    claudeTitle: "Claude Code",
    comingSoon: "Coming soon",
    sdkTitle: "OpenAI SDK",
    nodejs: "Node.js",
    cursorTitle: "Cursor / Continue",
    openaiCompatible: "OpenAI-compatible",
    curlTitle: "cURL",
    debug: "Debug",
    providerKeyFallback: "Sign in to create a Subi API key",
    curlSuccess: "# Success body should include:\nSUBI_BUYER_OK",
  },
  zh: {
    pageTitle: "Subi 模型接入控制台",
    buyer: "用模型",
    seller: "赚收益",
    dashboard: "首页",
    creditsNav: "充值",
    setupNav: "配置",
    keysNav: "密钥",
    usageNav: "用量",
    refresh: "刷新",
    signIn: "登录",
    signOut: "退出",
    heroTitle: "最便宜的顶级模型\n得益于 SUBI 社区贡献者",
    heroCopy: "充值一次，用同一个 Subi Key 接入 Codex、Claude Code 和常见 OpenAI 兼容客户端。",
    noProxy: "无需梯子",
    lowerCost: "最低的价格",
    p2pNetwork: "社区供给网络",
    buyCreditsCta: "购买额度",
    accessCta: "接入信息",
    setupCta: "配置客户端",
    yourCredits: "当前额度",
    signInLoadBalance: "登录后查看余额。",
    todaySpend: "今日消耗",
    requests: "请求数",
    accessTitle: "你的 Subi 接入信息",
    accessCopy: "Claude Code 不需要单独的 key。使用同一个 Subi API key，并填写 Anthropic 兼容地址。",
    revealKey: "显示 key",
    hideKey: "隐藏 key",
    subiBuyerApiKey: "SUBI API KEY",
    signInCreateKey: "登录后创建 key",
    newKey: "新建 key",
    deleteCurrent: "删除当前 key",
    buyCreditsTitle: "购买额度",
    offchainBalance: "MVP 阶段站内余额",
    starter: "Starter",
    starterCopy: "快速试用。",
    add100: "充值 100",
    builder: "Builder",
    builderCopy: "日常写代码。",
    add500: "充值 500",
    studio: "Studio",
    studioCopy: "重度会话。",
    add2000: "充值 2,000",
    custom: "自定义",
    customCopy: "50 Credits 起充。",
    creditsAmount: "额度数量",
    addCustom: "充值自定义额度",
    apiKeys: "API Keys",
    noActiveKey: "暂无可用 key",
    activeKey: "当前",
    selectedKey: "已选中",
    name: "名称",
    keyColumn: "Key",
    status: "状态",
    lastUsed: "上次使用",
    created: "创建时间",
    actions: "操作",
    useKey: "使用",
    selected: "当前",
    copyKey: "复制 key",
    deleteKey: "删除 key",
    secretUnavailableShort: "无法显示完整 key",
    secretUnavailableToast: "这个 key 的完整值不在本机。丢失后请删除并新建。",
    secretHintKnown: "这个完整 key 在本机可用。只在配置客户端时复制或显示。",
    secretHintUnknown: "这个 key 只能看到前缀。Subi 只会在创建时返回一次完整密钥。",
    selectedKeyToast: "已选择 {key}",
    configureClient: "配置你的客户端",
    providerTemplateNote: "页面显示 {key}***，点击复制时会复制本机保存的完整 key。",
    providerTemplateMissingSecret: "页面显示 {key}***，但本机没有完整密钥。需要复制完整命令时请删除后重新创建。",
    providerTemplateNoKey: "先创建或选择一个 API key，再配置客户端。",
    runDoctor: "运行自检",
    buyerDoctor: "接入自检",
    waitingSignIn: "等待登录",
    liveChecks: "正在读取账号状态",
    subiReady: "Subi 服务可用",
    keyValid: "API key 格式正确",
    creditsAboveZero: "余额大于 0",
    sellerAvailable: "有供给节点可用",
    supplyNode: "供给节点",
    creditActivity: "额度使用记录",
    request: "请求",
    duration: "耗时",
    creditCost: "额度",
    creditLedger: "额度账本",
    balanceHistory: "余额历史",
    time: "时间",
    type: "类型",
    amount: "数量",
    balance: "余额",
    copied: "已复制",
    languageSwitched: "已切换语言",
    staticPreviewError: "需要部署在 Subi Gateway 后才能读取真实账号数据",
    authTitle: "登录 Subi",
    authCopy: "输入邮箱和密码。新用户会自动创建账号。",
    close: "关闭",
    emailCode: "邮箱验证码登录",
    emailPassword: "邮箱和密码",
    email: "邮箱",
    password: "密码",
    passwordPlaceholder: "至少 8 位",
    authRequired: "请输入邮箱和密码。",
    passwordTooShort: "密码至少 8 位。",
    signedIn: "已登录",
    signedOut: "已退出",
    wrongEmailPassword: "邮箱或密码错误。",
    signInRequired: "请先登录",
    authMethodSoon: "这个登录方式稍后开放",
    createdKey: "已创建 key",
    deletedKey: "已删除 key",
    noActiveKeyToast: "没有可用 key",
    deleteConfirm: "删除 {key}？删除后无法恢复。",
    currentKey: "当前 key",
    refreshed: "已刷新",
    doctorPassed: "自检通过",
    minimumCredits: "最低充值 50 Credits",
    addedCredits: "已充值 {amount} Credits",
    estimateRequests: "约可支持 {count} 次短编程请求。",
    signInLoadUsage: "登录后查看用量。",
    noUsage: "还没有用量记录。",
    signInLoadKeys: "登录后查看 API keys。",
    noKeys: "还没有 API key。",
    defaultKey: "默认 key",
    completed: "完成",
    refunded: "退回",
    deleted: "已删除",
    current: "当前",
    active: "可用",
    signInLoadLedger: "登录后查看账本。",
    noLedger: "还没有额度账本记录。",
    recharge: "充值",
    debit: "扣费",
    refund: "退款",
    copy: "复制",
    codexTitle: "Codex CLI",
    recommended: "推荐",
    claudeTitle: "Claude Code",
    comingSoon: "即将开放",
    sdkTitle: "OpenAI SDK",
    nodejs: "Node.js",
    cursorTitle: "Cursor / Continue",
    openaiCompatible: "OpenAI 兼容",
    curlTitle: "cURL",
    debug: "调试",
    providerKeyFallback: "登录后创建 Subi API key",
    curlSuccess: "# 成功返回里应该包含：\nSUBI_BUYER_OK",
  },
};

function t(key, values = {}) {
  let text = i18n[state.locale]?.[key] || i18n.en[key] || key;
  Object.entries(values).forEach(([name, value]) => {
    text = text.replaceAll(`{${name}}`, String(value));
  });
  return text;
}

function icon(name) {
  return `<i data-lucide="${name}" aria-hidden="true"></i>`;
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

function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString(state.locale === "zh" ? "zh-CN" : "en-US", {
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
    const error = new Error(t("staticPreviewError"));
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

function keyPrefix(keyOrPrefix) {
  return typeof keyOrPrefix === "object" ? keyOrPrefix?.key_prefix || "" : keyOrPrefix || "";
}

function keyIdentity(key) {
  return key?.id || key?.key_prefix || "";
}

function storedSecretFor(keyOrPrefix) {
  const keyID = typeof keyOrPrefix === "object" ? keyOrPrefix?.id || "" : "";
  const prefix = keyPrefix(keyOrPrefix);
  if (keyID) {
    const stored = window.localStorage.getItem(`subi_buyer_secret_id:${keyID}`);
    if (stored) {
      return stored;
    }
  }
  if (!prefix) {
    return "";
  }
  return window.localStorage.getItem(`subi_buyer_secret:${prefix}`) || "";
}

function rememberSecret(keyOrPrefix, secret) {
  const keyID = typeof keyOrPrefix === "object" ? keyOrPrefix?.id || "" : "";
  const prefix = keyPrefix(keyOrPrefix);
  if (keyID && secret) {
    window.localStorage.setItem(`subi_buyer_secret_id:${keyID}`, secret);
  }
  if (prefix && secret) {
    window.localStorage.setItem(`subi_buyer_secret:${prefix}`, secret);
  }
}

function forgetSecret(keyOrPrefix) {
  const keyID = typeof keyOrPrefix === "object" ? keyOrPrefix?.id || "" : "";
  const prefix = keyPrefix(keyOrPrefix);
  if (keyID) {
    window.localStorage.removeItem(`subi_buyer_secret_id:${keyID}`);
  }
  if (prefix) {
    window.localStorage.removeItem(`subi_buyer_secret:${prefix}`);
  }
}

function selectedAPIKey() {
  const selected = state.apiKeys.find((key) => key.id === state.apiKeyID);
  if (selected) {
    return selected;
  }
  if (!state.apiKeyID && !state.apiKeyPrefix) {
    return null;
  }
  return {
    id: state.apiKeyID,
    key_prefix: state.apiKeyPrefix,
    revoked_at: "",
  };
}

function fullSecretForKey(key) {
  if (!key) {
    return "";
  }
  const stored = storedSecretFor(key);
  if (stored) {
    return stored;
  }
  return key.id === state.apiKeyID || key.key_prefix === state.apiKeyPrefix ? state.apiKey : "";
}

function selectAPIKeyObject(key) {
  if (!key) {
    state.apiKey = "";
    state.apiKeyID = "";
    state.apiKeyPrefix = "";
    return null;
  }
  state.apiKeyID = key.id || "";
  state.apiKeyPrefix = key.key_prefix || "";
  state.apiKey = fullSecretForKey(key);
  return key;
}

function syncSelectedAPIKey() {
  const current = state.apiKeys.find((key) => key.id === state.apiKeyID && !key.revoked_at);
  if (current) {
    return selectAPIKeyObject(current);
  }
  const fallback = state.apiKeys.find((key) => !key.revoked_at);
  return selectAPIKeyObject(fallback || null);
}

function isKeyRevealed(key) {
  const identity = keyIdentity(key);
  return Boolean(identity && state.revealedKeys.has(identity));
}

function maskedKeyForProvider(key) {
  const prefix = key?.key_prefix || state.apiKeyPrefix;
  return prefix ? `${prefix}***` : "<SUBI_BUYER_API_KEY>";
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
          <button class="auth-close" type="button" data-auth-close aria-label="${escapeHtml(t("close"))}">${escapeHtml(t("close"))}</button>
          <div class="auth-heading">
            <span class="brand-mark">S</span>
            <div>
              <h2 id="auth-modal-title">${escapeHtml(t("authTitle"))}</h2>
              <p id="auth-modal-copy">${escapeHtml(t("authCopy"))}</p>
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
            ${escapeHtml(t("emailCode"))}
          </button>
          <div class="auth-divider"><span>${escapeHtml(t("emailPassword"))}</span></div>
          <form class="auth-form" id="auth-form">
            <label>
              <span>${escapeHtml(t("email"))}</span>
              <input id="auth-email" name="email" type="email" autocomplete="email" placeholder="you@company.com" required />
            </label>
            <label>
              <span>${escapeHtml(t("password"))}</span>
              <input id="auth-password" name="password" type="password" autocomplete="current-password" minlength="8" placeholder="${escapeHtml(t("passwordPlaceholder"))}" required />
            </label>
            <p class="auth-error" id="auth-error" role="alert"></p>
            <button class="btn btn-primary full" id="auth-submit" type="submit">${escapeHtml(t("signIn"))}</button>
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

function providerContent() {
  const selected = selectedAPIKey();
  const selectedLabel = selected?.key_prefix || t("noActiveKey");
  const selectedSecret = fullSecretForKey(selected);
  const displayApiKey = selected ? maskedKeyForProvider(selected) : "<SUBI_BUYER_API_KEY>";
  const copyApiKey = selectedSecret || "";
  const note = selected
    ? selectedSecret
      ? t("providerTemplateNote", { key: selectedLabel })
      : t("providerTemplateMissingSecret", { key: selectedLabel })
    : t("providerTemplateNoKey");
  const withFullKey = (template) => (copyApiKey ? template(copyApiKey) : "");
  const codexCopy = (apiKey) => `export OPENAI_BASE_URL="${state.openaiBaseUrl}"
export OPENAI_API_KEY="${apiKey}"

codex \\
  -c 'model_provider="subi"' \\
  -c 'model_providers.subi.name="Subi"' \\
  -c "model_providers.subi.base_url=\\"\${OPENAI_BASE_URL}\\"" \\
  -c 'model_providers.subi.env_key="OPENAI_API_KEY"' \\
  -c 'model_providers.subi.wire_api="responses"' \\
  -c 'model_providers.subi.supports_websockets=false'`;
  const responsesCurl = (apiKey) => `curl -sS "${state.openaiBaseUrl}/responses" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.1-codex",
    "input": "Reply exactly: SUBI_BUYER_OK",
    "stream": false
  }'`;
  const claudeCopy = (apiKey) => `export ANTHROPIC_BASE_URL="${state.anthropicBaseUrl}"
export ANTHROPIC_AUTH_TOKEN="${apiKey}"

claude`;
  const sdkCopy = (apiKey) => `export OPENAI_BASE_URL="${state.openaiBaseUrl}"
export OPENAI_API_KEY="${apiKey}"`;
  const cursorCopy = (apiKey) => `Base URL: ${state.openaiBaseUrl}
API Key: ${apiKey}`;
  const cursorTest = (apiKey) => `{
  "models": [
    {
      "title": "Subi",
      "provider": "openai",
      "model": "gpt-5.1-codex",
      "apiBase": "${state.openaiBaseUrl}",
      "apiKey": "${apiKey}"
    }
  ]
}`;
  return {
    codex: {
      title: t("codexTitle"),
      tag: t("recommended"),
      note,
      copy: codexCopy(displayApiKey),
      copyRaw: withFullKey(codexCopy),
      test: responsesCurl(displayApiKey),
      testRaw: withFullKey(responsesCurl),
    },
    claude: {
      title: t("claudeTitle"),
      tag: t("comingSoon"),
      note,
      copy: claudeCopy(displayApiKey),
      copyRaw: withFullKey(claudeCopy),
      test: `claude
# Ask: Reply exactly: SUBI_BUYER_OK`,
      testRaw: "claude\n# Ask: Reply exactly: SUBI_BUYER_OK",
    },
    sdk: {
      title: t("sdkTitle"),
      tag: t("nodejs"),
      note,
      copy: sdkCopy(displayApiKey),
      copyRaw: withFullKey(sdkCopy),
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
      testRaw: `import OpenAI from "openai";

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
      title: t("cursorTitle"),
      tag: t("openaiCompatible"),
      note,
      copy: cursorCopy(displayApiKey),
      copyRaw: withFullKey(cursorCopy),
      test: cursorTest(displayApiKey),
      testRaw: withFullKey(cursorTest),
    },
    curl: {
      title: t("curlTitle"),
      tag: t("debug"),
      note,
      copy: responsesCurl(displayApiKey),
      copyRaw: withFullKey(responsesCurl),
      test: t("curlSuccess"),
      testRaw: t("curlSuccess"),
    },
  };
}

function registerCodeCopy(value) {
  const id = `code-copy-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
  codeCopyPayloads.set(id, value);
  return id;
}

function renderProvider(providerKey = state.activeProvider) {
  state.activeProvider = providerKey;
  const provider = providerContent()[providerKey];
  const container = document.querySelector("#provider-content");
  if (!container || !provider) {
    return;
  }
  codeCopyPayloads.clear();
  const renderCodeBlock = (displayText, rawText) => `
    <div class="code-block">
      <button class="code-copy" type="button" ${rawText ? `data-copy-id="${escapeHtml(registerCodeCopy(rawText))}"` : `disabled title="${escapeHtml(t("secretUnavailableToast"))}"`}>${escapeHtml(t("copy"))}</button>
      <pre><code>${escapeHtml(displayText)}</code></pre>
    </div>
  `;
  container.innerHTML = `
    <div class="provider-title">
      <h3>${provider.title}</h3>
      <span class="tag">${provider.tag}</span>
    </div>
    <p class="provider-note">${escapeHtml(provider.note)}</p>
    ${renderCodeBlock(provider.copy, provider.copyRaw)}
    ${renderCodeBlock(provider.test, provider.testRaw)}
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
  showToast(t("copied"));
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

function setButtonHTML(selector, iconName, label) {
  const el = document.querySelector(selector);
  if (el) {
    el.innerHTML = `${iconName ? icon(iconName) : ""}${escapeHtml(label)}`;
  }
}

function applyStaticTranslations() {
  document.documentElement.lang = state.locale === "zh" ? "zh-CN" : "en";
  document.title = t("pageTitle");
  document.querySelectorAll("[data-locale]").forEach((button) => {
    button.classList.toggle("active", button.dataset.locale === state.locale);
  });

  setText(".role-switcher a:first-child", t("buyer"));
  setText(".role-switcher a:last-child", t("seller"));
  setText('.nav a[href="#dashboard"]', t("dashboard"));
  setText('.nav a[href="#credits"]', t("creditsNav"));
  setText('.nav a[href="#setup"]', t("setupNav"));
  setText('.nav a[href="#keys"]', t("keysNav"));
  setText('.nav a[href="#usage"]', t("usageNav"));
  setButtonHTML("#refresh-data", "refresh-cw", t("refresh"));
  setText("#dashboard-title", t("heroTitle"));
  setText(".hero-subcopy", t("heroCopy"));
  setButtonHTML('.hero-actions [data-scroll-target="#credits"]', "credit-card", t("buyCreditsCta"));
  setButtonHTML('.hero-actions [data-scroll-target="#keys"]', "key-round", t("accessCta"));

  const valuePills = document.querySelectorAll(".value-strip span");
  const valueTexts = [t("noProxy"), t("lowerCost"), t("p2pNetwork")];
  const valueIcons = ["wifi", "badge-percent", "network"];
  valuePills.forEach((pill, index) => {
    pill.innerHTML = `${icon(valueIcons[index])}${escapeHtml(valueTexts[index])}`;
  });

  setText(".balance-main span", t("yourCredits"));
  const balanceRows = document.querySelectorAll(".balance-row span");
  if (balanceRows[0]) balanceRows[0].textContent = t("todaySpend");
  if (balanceRows[1]) balanceRows[1].textContent = t("requests");
  setText("#access-title", t("accessTitle"));
  setText(".access-panel .panel-subcopy", t("accessCopy"));
  setText('.copy-field:nth-child(1) > span', t("subiBuyerApiKey"));
  setButtonHTML("#create-key", "key-round", t("newKey"));
  setButtonHTML("#delete-key", "trash-2", t("deleteCurrent"));
  setText("#credits-title", t("buyCreditsTitle"));
  setText("#credits .muted-pill", t("offchainBalance"));

  const planCards = document.querySelectorAll(".plan-card");
  const planText = [
    [t("starter"), "100", t("starterCopy"), t("add100")],
    [t("builder"), "500", t("builderCopy"), t("add500")],
    [t("studio"), "2,000", t("studioCopy"), t("add2000")],
    [t("custom"), "50+", t("customCopy"), t("addCustom")],
  ];
  planCards.forEach((card, index) => {
    const [label, value, copy, button] = planText[index] || [];
    if (!label) {
      return;
    }
    card.querySelector(":scope > span").textContent = label;
    card.querySelector(":scope > strong").textContent = value;
    card.querySelector(":scope > p").textContent = copy;
    const action = card.querySelector(".btn");
    if (action) {
      action.innerHTML = `${icon("plus")}${escapeHtml(button)}`;
    }
  });
  setText(".custom-credit-field span", t("creditsAmount"));

  setText("#keys-title", t("apiKeys"));
  setText("#setup-title", t("configureClient"));
  setButtonHTML("#run-doctor", "stethoscope", t("runDoctor"));
  setText(".doctor-header strong", t("buyerDoctor"));
  const doctorItems = document.querySelectorAll("#doctor-list li");
  [t("subiReady"), t("keyValid"), t("creditsAboveZero"), t("sellerAvailable")].forEach((label, index) => {
    if (doctorItems[index]) {
      doctorItems[index].innerHTML = `<span></span>${escapeHtml(label)}`;
    }
  });

  const providerTabs = document.querySelectorAll(".provider-tab");
  const providerLabels = [
    ["terminal-square", t("codexTitle")],
    ["sparkles", t("claudeTitle")],
    ["braces", t("sdkTitle")],
    ["panel-top", t("cursorTitle")],
    ["send", t("curlTitle")],
  ];
  providerTabs.forEach((tab, index) => {
    const [tabIcon, label] = providerLabels[index] || [];
    if (label) {
      tab.innerHTML = `${icon(tabIcon)}${escapeHtml(label)}`;
    }
  });

  setText("#usage-title", t("creditActivity"));
  setButtonHTML("#refresh-usage", "refresh-cw", t("refresh"));
  setText(".ledger-block h2", t("creditLedger"));
  setText(".ledger-block .muted-pill", t("balanceHistory"));

  const keyHeaders = document.querySelectorAll("#keys th");
  [t("name"), t("keyColumn"), t("status"), t("lastUsed"), t("created"), t("actions")].forEach((label, index) => {
    if (keyHeaders[index]) keyHeaders[index].textContent = label;
  });
  const usageHeaders = document.querySelectorAll("#usage > .table-wrap th");
  [t("request"), t("status"), t("supplyNode"), t("duration"), t("creditCost")].forEach((label, index) => {
    if (usageHeaders[index]) usageHeaders[index].textContent = label;
  });
  const ledgerHeaders = document.querySelectorAll(".ledger-block th");
  [t("time"), t("type"), t("amount"), t("balance"), t("request")].forEach((label, index) => {
    if (ledgerHeaders[index]) ledgerHeaders[index].textContent = label;
  });

  const modal = document.querySelector("#auth-modal");
  if (modal) {
    setText(".auth-close", t("close"));
    document.querySelector(".auth-close")?.setAttribute("aria-label", t("close"));
    setText("#auth-modal-title", t("authTitle"));
    setText("#auth-modal-copy", t("authCopy"));
    setText(".auth-provider-wide", `@ ${t("emailCode")}`);
    setText(".auth-divider span", t("emailPassword"));
    setText('.auth-form label:nth-of-type(1) span', t("email"));
    setText('.auth-form label:nth-of-type(2) span', t("password"));
    document.querySelector("#auth-password")?.setAttribute("placeholder", t("passwordPlaceholder"));
    setText("#auth-submit", t("signIn"));
  }

  const toast = document.querySelector("#toast");
  if (toast && !toast.classList.contains("show")) {
    toast.textContent = t("copied");
  }
}

function renderAuth() {
  const button = document.querySelector("#auth-action");
  if (!button) {
    return;
  }
  button.textContent = state.user ? t("signOut") : t("signIn");
}

function renderRevealKeyButton() {
  const revealButton = document.querySelector("#reveal-key");
  const key = selectedAPIKey();
  const secret = fullSecretForKey(key);
  if (!revealButton) {
    return;
  }
  const visible = Boolean(secret && isKeyRevealed(key));
  revealButton.disabled = !secret;
  revealButton.title = secret ? "" : t("secretUnavailableToast");
  revealButton.innerHTML = visible ? `${icon("eye-off")}${escapeHtml(t("hideKey"))}` : `${icon("eye")}${escapeHtml(t("revealKey"))}`;
}

function renderAccess() {
  const key = selectedAPIKey();
  const secret = fullSecretForKey(key);
  const visible = Boolean(secret && isKeyRevealed(key));
  const shownKey = secret || state.apiKeyPrefix || t("signInCreateKey");
  const apiKeyInput = document.querySelector("#api-key");
  if (apiKeyInput) {
    apiKeyInput.type = secret && !visible ? "password" : "text";
  }
  setInput("#api-key", shownKey);
  setInput("#openai-base-url", state.openaiBaseUrl);
  setInput("#anthropic-base-url", state.anthropicBaseUrl);
  setText("#active-key-pill", state.apiKeyPrefix ? `${t("selectedKey")} ${state.apiKeyPrefix}` : t("noActiveKey"));
  const copyKeyButton = document.querySelector('[data-copy-target="api-key"]');
  if (copyKeyButton) {
    copyKeyButton.disabled = !secret;
    copyKeyButton.title = secret ? t("copyKey") : t("secretUnavailableToast");
  }
  setText("#key-secret-hint", secret ? t("secretHintKnown") : state.apiKeyPrefix ? t("secretHintUnknown") : "");
  renderRevealKeyButton();
  renderProvider();
}

function renderBalance() {
  const credits = formatCredits(state.balanceMicros);
  setText("#top-balance span", `${credits} Credits`);
  setText("#credit-balance", credits);
  setText(
    "#credit-estimate",
    state.user
      ? t("estimateRequests", {
          count: Math.floor(Number(state.balanceMicros || 0) / 3_000_000).toLocaleString(
            state.locale === "zh" ? "zh-CN" : "en-US",
          ),
        })
      : t("signInLoadBalance"),
  );

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
    body.innerHTML = `<tr><td colspan="5">${escapeHtml(t("signInLoadUsage"))}</td></tr>`;
    return;
  }
  if (state.usage.length === 0) {
    body.innerHTML = `<tr><td colspan="5">${escapeHtml(t("noUsage"))}</td></tr>`;
    return;
  }
  body.innerHTML = state.usage
    .map((item) => {
      const ok = Number(item.status || 0) >= 200 && Number(item.status || 0) < 400 && !item.error;
      const status = ok ? t("completed") : t("refunded");
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
    body.innerHTML = `<tr><td colspan="6">${escapeHtml(t("signInLoadKeys"))}</td></tr>`;
    return;
  }
  if (state.apiKeys.length === 0) {
    body.innerHTML = `<tr><td colspan="6">${escapeHtml(t("noKeys"))}</td></tr>`;
    return;
  }
  body.innerHTML = state.apiKeys
    .map((key) => {
      const revoked = Boolean(key.revoked_at);
      const active = key.id === state.apiKeyID && !revoked;
      const secret = fullSecretForKey(key);
      const secretAvailable = Boolean(secret && !revoked);
      const revealed = Boolean(secretAvailable && isKeyRevealed(key));
      const keyValue = revealed ? secret : key.key_prefix || "-";
      const statusClass = revoked ? "refunded" : "ok";
      const status = revoked ? t("deleted") : active ? t("current") : t("active");
      const keyID = escapeHtml(key.id || "");
      const selectDisabled = revoked || active ? "disabled" : "";
      const secretDisabled = secretAvailable ? "" : "disabled";
      const deleteDisabled = revoked ? "disabled" : "";
      const secretTitle = revoked
        ? ` title="${escapeHtml(t("deleted"))}"`
        : secretAvailable
          ? ""
          : ` title="${escapeHtml(t("secretUnavailableToast"))}"`;
      return `
        <tr class="${active ? "selected-row" : ""} ${revoked ? "revoked-row" : ""}">
          <td>${escapeHtml(key.name || t("defaultKey"))}</td>
          <td>
            <div class="key-cell">
              <code>${escapeHtml(keyValue)}</code>
              ${secret ? "" : `<span>${escapeHtml(t("secretUnavailableShort"))}</span>`}
            </div>
          </td>
          <td><span class="table-status ${statusClass}">${status}</span></td>
          <td>${escapeHtml(formatDateTime(key.last_used_at))}</td>
          <td>${escapeHtml(formatDateTime(key.created_at))}</td>
          <td>
            <div class="key-actions">
              <button class="key-action" type="button" data-key-action="select" data-key-id="${keyID}" ${selectDisabled}>
                ${icon(active ? "check" : "mouse-pointer-click")}${escapeHtml(active ? t("selected") : t("useKey"))}
              </button>
              <button class="key-action icon-only" type="button" data-key-action="copy" data-key-id="${keyID}" aria-label="${escapeHtml(t("copyKey"))}" ${secretDisabled}${secretTitle}>
                ${icon("copy")}
              </button>
              <button class="key-action icon-only" type="button" data-key-action="reveal" data-key-id="${keyID}" aria-label="${escapeHtml(revealed ? t("hideKey") : t("revealKey"))}" ${secretDisabled}${secretTitle}>
                ${icon(revealed ? "eye-off" : "eye")}
              </button>
              <button class="key-action icon-only danger" type="button" data-key-action="delete" data-key-id="${keyID}" aria-label="${escapeHtml(t("deleteKey"))}" ${deleteDisabled}>
                ${icon("trash-2")}
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function ledgerTypeLabel(type) {
  switch (type) {
    case "recharge":
      return t("recharge");
    case "debit":
      return t("debit");
    case "refund":
      return t("refund");
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
    body.innerHTML = `<tr><td colspan="5">${escapeHtml(t("signInLoadLedger"))}</td></tr>`;
    return;
  }
  if (state.ledger.length === 0) {
    body.innerHTML = `<tr><td colspan="5">${escapeHtml(t("noLedger"))}</td></tr>`;
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
    Boolean(state.apiKey),
    Number(state.balanceMicros || 0) > 0,
    state.usage.some((item) => item.seller_node_id) || state.user,
  ];
  checks.forEach((item, index) => {
    if (passing[index]) {
      item.classList.add("done");
    }
  });
  setText("#doctor-status", state.user ? t("liveChecks") : t("waitingSignIn"));
}

function renderAll() {
  applyStaticTranslations();
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
    selectAPIKeyObject(existing);
    return;
  }

  const created = await api("/api/web/buyer/api-keys", {
    method: "POST",
    body: { name: "Codex" },
  });
  rememberSecret(created.api_key, created.secret);
  state.apiKeys = created.api_key ? [created.api_key, ...keys] : keys;
  selectAPIKeyObject(created.api_key);
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
  rememberSecret(created.api_key, created.secret);
  const keysPayload = await api("/api/web/buyer/api-keys");
  state.apiKeys = keysPayload.api_keys || [];
  const freshKey = state.apiKeys.find((key) => key.id === created.api_key?.id) || created.api_key;
  selectAPIKeyObject(freshKey);
  renderAll();
  showToast(t("createdKey"));
}

async function deleteBuyerKey(key = selectedAPIKey()) {
  if (!state.user || !key?.id) {
    showToast(t("noActiveKeyToast"));
    return;
  }
  if (!window.confirm(t("deleteConfirm", { key: key.key_prefix || t("currentKey") }))) {
    return;
  }
  await api(`/api/web/buyer/api-keys/${encodeURIComponent(key.id)}`, {
    method: "DELETE",
  });
  forgetSecret(key);
  state.revealedKeys.delete(keyIdentity(key));
  const keysPayload = await api("/api/web/buyer/api-keys");
  state.apiKeys = keysPayload.api_keys || [];
  syncSelectedAPIKey();
  renderAll();
  showToast(t("deletedKey"));
}

async function deleteCurrentBuyerKey() {
  await deleteBuyerKey(selectedAPIKey());
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
    syncSelectedAPIKey();
  } finally {
    state.refreshing = false;
  }
}

async function refreshBuyerDataAndRender({ toast = false } = {}) {
  if (!state.user) {
    if (toast) {
      showToast(t("signInRequired"));
    }
    return;
  }
  try {
    await refreshBuyerData();
    renderAll();
    if (toast) {
      showToast(t("refreshed"));
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
    state.revealedKeys.clear();
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
    setText("#auth-error", t("authRequired"));
    return;
  }
  if (password.length < 8) {
    setText("#auth-error", t("passwordTooShort"));
    return;
  }
  setText("#auth-error", "");
  if (submitButton) {
    submitButton.disabled = true;
  }
  try {
    await signInOrCreateAccount(email, password);
    closeAuthModal();
    showToast(t("signedIn"));
    await loadAccount();
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
      throw new Error(t("wrongEmailPassword"));
    }
    throw error;
  }
}

async function loginOrRegister() {
  openAuthModal();
}

async function logout() {
  await api("/api/web/auth/logout", { method: "POST" });
  state.user = null;
  state.apiKey = "";
  state.apiKeyID = "";
  state.apiKeyPrefix = "";
  state.apiKeys = [];
  state.revealedKeys.clear();
  state.balanceMicros = 0;
  state.usage = [];
  state.ledger = [];
  renderAll();
  showToast(t("signedOut"));
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
  showToast(t("addedCredits", { amount }));
}

document.addEventListener("click", async (event) => {
  const authClose = event.target.closest("[data-auth-close]");
  if (authClose) {
    closeAuthModal();
    return;
  }

  const authDisabled = event.target.closest("[data-auth-disabled]");
  if (authDisabled) {
    showToast(t("authMethodSoon"));
    return;
  }

  const languageButton = event.target.closest("[data-locale]");
  if (languageButton) {
    state.locale = languageButton.dataset.locale === "en" ? "en" : "zh";
    window.localStorage.setItem("subi_buyer_locale", state.locale);
    renderAll();
    showToast(t("languageSwitched"));
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
    const raw = codeCopyPayloads.get(codeCopy.dataset.copyId || "") || "";
    if (!raw) {
      showToast(t("secretUnavailableToast"));
      return;
    }
    copyText(raw);
    return;
  }

  const keyAction = event.target.closest("[data-key-action]");
  if (keyAction) {
    const key = state.apiKeys.find((item) => item.id === keyAction.dataset.keyId);
    if (!key) {
      showToast(t("noActiveKeyToast"));
      return;
    }
    const action = keyAction.dataset.keyAction;
    if (action === "select") {
      if (key.revoked_at) {
        showToast(t("noActiveKeyToast"));
        return;
      }
      selectAPIKeyObject(key);
      renderAll();
      showToast(t("selectedKeyToast", { key: key.key_prefix || t("currentKey") }));
      return;
    }
    if (action === "copy") {
      const secret = fullSecretForKey(key);
      if (!secret) {
        showToast(t("secretUnavailableToast"));
        return;
      }
      await copyText(secret);
      return;
    }
    if (action === "reveal") {
      const secret = fullSecretForKey(key);
      if (!secret) {
        showToast(t("secretUnavailableToast"));
        return;
      }
      const identity = keyIdentity(key);
      if (state.revealedKeys.has(identity)) {
        state.revealedKeys.delete(identity);
      } else {
        state.revealedKeys.add(identity);
      }
      renderAll();
      return;
    }
    if (action === "delete") {
      try {
        await deleteBuyerKey(key);
      } catch (error) {
        showToast(error.message);
      }
      return;
    }
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
  const key = selectedAPIKey();
  const secret = fullSecretForKey(key);
  if (!secret) {
    showToast(t("secretUnavailableToast"));
    return;
  }
  const identity = keyIdentity(key);
  if (state.revealedKeys.has(identity)) {
    state.revealedKeys.delete(identity);
  } else {
    state.revealedKeys.add(identity);
  }
  renderAll();
});

document.querySelector("#create-key")?.addEventListener("click", async () => {
  try {
    await createBuyerKey();
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#delete-key")?.addEventListener("click", async () => {
  try {
    await deleteCurrentBuyerKey();
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#run-doctor")?.addEventListener("click", () => {
  renderDoctor();
  showToast(state.user ? t("doctorPassed") : t("signInRequired"));
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
    showToast(t("minimumCredits"));
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
