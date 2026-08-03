const PROTOCOL_STEPS = [
  { title: "step_01 — prompt", log: "[tx] op=prompt · userA → relay-01 → relay-02 → coord:9600" },
  { title: "step_02 — dispatch", log: "[tx] op=task · coord → relay-03 → gpu-01, gpu-02, gpu-03" },
  { title: "step_03 — inference", log: "[run] ollama infer × N · timing recorded · mesh-local" },
  { title: "step_04 — consensus", log: "[ok] majority vote · 1 outlier flagged · result verified" },
  { title: "step_05 — reward", log: "[mlc] +10.0 distributed · fastest worker +3.2" },
];

function initNav() {
  document.getElementById("navToggle")?.addEventListener("click", () => {
    document.getElementById("navLinks").classList.toggle("open");
  });
  document.querySelectorAll('.nav-links a[href^="#"]').forEach((a) => {
    a.addEventListener("click", () => document.getElementById("navLinks").classList.remove("open"));
  });
}

/* ---------- live chain data ---------- */
function shortHash(hash) {
  return hash ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : "—";
}

async function refreshAppVersion() {
  try {
    const j = await fetch("/api/version", { cache: "no-store" }).then((r) => r.json());
    const v = j?.version;
    const el = document.getElementById("heroAppVer");
    if (el && v) el.textContent = `v${v}`;
  } catch {
    /* ignore */
  }
}

async function refreshLive() {
  try {
    const [status, chain, validators] = await Promise.all([
      fetch("/api/status").then((r) => r.json()),
      fetch("/api/chain").then((r) => r.json()),
      fetch("/api/validators").then((r) => r.json()).catch(() => null),
    ]);
    const blocks = status?.blockchain?.length ?? chain?.blocks?.length ?? 0;
    document.getElementById("lsBlocks").textContent = blocks;
    document.getElementById("lsValidators").textContent = validators?.validators?.length || 1;
    document.getElementById("lsNodes").textContent = status?.compute_count ?? 0;
    document.getElementById("lsChain").textContent = status?.blockchain?.valid ? "VALID" : "CHECK";

    const heroStatus = document.getElementById("heroStatus");
    if (heroStatus) heroStatus.textContent = `STATUS: mainnet_live · block #${blocks - 1} · chain ${status?.blockchain?.valid ? "valid" : "syncing"}`;

    const supply = status?.mlc_supply_distributed;
    if (typeof supply === "number") {
      document.getElementById("lsMlc").textContent = Math.round(supply).toLocaleString("en-US");
    }

    const items = (chain?.blocks || []).slice(-5).reverse().map((block) =>
      `<span class="ticker-item">block <strong>#${block.index}</strong> · ${shortHash(block.hash)} · ${block.proof?.transactions?.length || 0} tx</span>`
    ).join("");
    if (items) document.getElementById("blockTicker").innerHTML = items;

    feedLiveLog(status, blocks);
  } catch {
    /* offline preview — leave placeholders */
  }
}

let liveLogSeeded = false;
function feedLiveLog(status, blocks) {
  const log = document.getElementById("liveLog");
  if (!log) return;
  const lines = [];
  if (!liveLogSeeded) {
    lines.push(`[ok] connected · noeticompute.com · chain v${status?.blockchain?.chain_version || 4}`);
    liveLogSeeded = true;
  }
  const events = status?.events || [];
  events.slice(-4).forEach((event) => {
    const text = typeof event === "string" ? event : `${event?.time || ""} ${event?.message || ""}`.trim();
    if (text) lines.push(`[ev] ${text}`);
  });
  if (!events.length) {
    lines.push(`[ok] chain height ${blocks} · validators cosigning · faucet limited (50 MLC/24h)`);
  }
  for (const text of lines) {
    const span = document.createElement("span");
    span.className = "line ok";
    span.textContent = text;
    log.appendChild(span);
  }
  while (log.children.length > 7) log.removeChild(log.firstChild);
}

function initProtocolSteps() {
  const cards = document.querySelectorAll("#protocolSteps .step-card");
  const titleEl = document.getElementById("stepLogTitle");
  const logEl = document.getElementById("stepLog");
  if (!cards.length || !logEl) return;

  let current = 0;

  function setStep(i) {
    current = i;
    const step = PROTOCOL_STEPS[i];
    cards.forEach((c, j) => c.classList.toggle("active", j === i));
    if (titleEl) titleEl.textContent = step.title;
    logEl.innerHTML =
      `<span class="line ok">${step.log}</span>` +
      `<span class="line dim">[..]<span class="cursor"></span></span>`;
  }

  cards.forEach((card, i) => {
    card.addEventListener("click", () => {
      setStep(i);
      resetTimer();
    });
  });

  let timer = setInterval(() => {
    setStep((current + 1) % PROTOCOL_STEPS.length);
  }, 4000);

  function resetTimer() {
    clearInterval(timer);
    timer = setInterval(() => {
      setStep((current + 1) % PROTOCOL_STEPS.length);
    }, 4000);
  }

  setStep(0);
}

function initCompareHighlight() {
  document.querySelectorAll(".compare-table tbody tr").forEach((row) => {
    row.addEventListener("mouseenter", () => row.classList.add("row-hover"));
    row.addEventListener("mouseleave", () => row.classList.remove("row-hover"));
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initNav();
  initProtocolSteps();
  initCompareHighlight();
  refreshAppVersion();
  refreshLive();
  setInterval(refreshLive, 12000);
});
