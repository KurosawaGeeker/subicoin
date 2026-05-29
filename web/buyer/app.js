const apiKeyValue = "sk-subi_live_7K4m9xQp2aDemoKey";
const openaiBaseUrlValue = "https://api.subi.xyz/v1";
const anthropicBaseUrlValue = "https://api.subi.xyz";

const providerContent = {
  codex: {
    title: "Codex CLI",
    tag: "Recommended",
    copy: `export OPENAI_BASE_URL="${openaiBaseUrlValue}"
export OPENAI_API_KEY="${apiKeyValue}"

codex \\
  -c 'model_provider="subi"' \\
  -c 'model_providers.subi.name="Subi"' \\
  -c "model_providers.subi.base_url=\\"\${OPENAI_BASE_URL}\\"" \\
  -c 'model_providers.subi.env_key="OPENAI_API_KEY"' \\
  -c 'model_providers.subi.wire_api="responses"' \\
  -c 'model_providers.subi.supports_websockets=false'`,
    test: `curl -sS "${openaiBaseUrlValue}/responses" \\
  -H "Authorization: Bearer ${apiKeyValue}" \\
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
    copy: `export ANTHROPIC_BASE_URL="${anthropicBaseUrlValue}"
export ANTHROPIC_AUTH_TOKEN="${apiKeyValue}"

claude`,
    test: `claude
# Ask: Reply exactly: SUBI_BUYER_OK`,
  },
  sdk: {
    title: "OpenAI SDK",
    tag: "Node.js",
    copy: `export OPENAI_BASE_URL="${openaiBaseUrlValue}"
export OPENAI_API_KEY="${apiKeyValue}"`,
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
    copy: `Base URL: ${openaiBaseUrlValue}
API Key: ${apiKeyValue}`,
    test: `{
  "models": [
    {
      "title": "Subi",
      "provider": "openai",
      "model": "gpt-5.1-codex",
      "apiBase": "${openaiBaseUrlValue}",
      "apiKey": "${apiKeyValue}"
    }
  ]
}`,
  },
  curl: {
    title: "cURL",
    tag: "Debug",
    copy: `curl -sS "${openaiBaseUrlValue}/responses" \\
  -H "Authorization: Bearer ${apiKeyValue}" \\
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

document.addEventListener("click", (event) => {
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
  }
});

document.querySelector("#reveal-key").addEventListener("click", () => {
  const apiKeyInput = document.querySelector("#api-key");
  const visible = apiKeyInput.type === "text";
  apiKeyInput.type = visible ? "password" : "text";
  document.querySelector("#reveal-key").innerHTML = visible
    ? '<i data-lucide="eye" aria-hidden="true"></i>Reveal key'
    : '<i data-lucide="eye-off" aria-hidden="true"></i>Hide key';
  window.lucide?.createIcons();
});

document.querySelector("#run-doctor").addEventListener("click", () => {
  const checks = [...document.querySelectorAll("#doctor-list li")];
  checks.forEach((item) => item.classList.remove("done"));
  checks.forEach((item, index) => {
    window.setTimeout(() => item.classList.add("done"), 260 * (index + 1));
  });
  window.setTimeout(() => showToast("Doctor passed"), 1250);
});

document.querySelector("#add-custom-credits").addEventListener("click", () => {
  const input = document.querySelector("#custom-credits");
  const amount = Number.parseInt(input.value, 10);
  if (!Number.isFinite(amount) || amount < 50) {
    input.value = "50";
    showToast("Minimum is 50 credits");
    return;
  }
  showToast(`Custom top-up: ${amount} credits`);
});

renderProvider("codex");
window.lucide?.createIcons();
