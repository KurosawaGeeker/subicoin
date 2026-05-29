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

renderProvider("codex");
initNetworkMap();
