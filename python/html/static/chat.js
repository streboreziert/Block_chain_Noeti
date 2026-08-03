(() => {
  const STORAGE_KEY = "noeti_chat_v5";
  const app = document.getElementById("chatApp");
  const sidebar = document.getElementById("chatSidebar");
  const chatList = document.getElementById("chatList");
  const log = document.getElementById("chatLog");
  const empty = document.getElementById("chatEmpty");
  const form = document.getElementById("chatForm");
  const input = document.getElementById("chatInput");
  const sendBtn = document.getElementById("chatSend");
  const statusEl = document.getElementById("chatStatus");
  const networkStatus = document.getElementById("networkStatus");
  const backendPill = document.getElementById("backendPill");
  const modelBtn = document.getElementById("modelPickerBtn");
  const modelLabel = document.getElementById("modelPickerLabel");
  const modelMenu = document.getElementById("modelMenu");
  const suggestGrid = document.getElementById("suggestGrid");
  const btnNew = document.getElementById("btnNewChat");
  const btnSidebar = document.getElementById("btnSidebar");
  const chartEl = document.getElementById("insightChart");
  const insightMeta = document.getElementById("insightMeta");
  const claimList = document.getElementById("claimList");
  const sourceList = document.getElementById("sourceList");
  const pipeline = document.getElementById("wfPipeline");
  const togglesEl = document.getElementById("wfJudgeToggles");
  const composerTools = document.getElementById("composerTools");
  const modeChat = document.getElementById("modeChat");
  const modeNewsroom = document.getElementById("modeNewsroom");
  const emptyByline = document.getElementById("emptyByline");
  const sourcingGraph = document.getElementById("sourcingGraph");
  const railActivity = document.getElementById("railActivity");
  const railJudges = document.getElementById("railJudges");
  const railGate = document.getElementById("railGate");
  const railGateBlock = document.getElementById("railGateBlock");
  const railActivityBlock = document.getElementById("railActivityBlock");
  const railJudgesBlock = document.getElementById("railJudgesBlock");
  const railPacketBlock = document.getElementById("railPacketBlock");
  const railPacket = document.getElementById("railPacket");
  const railQuality = document.getElementById("railQuality");
  const setPrivateRoute = document.getElementById("setPrivateRoute");
  const composerNote = document.getElementById("composerNote");
  const featuresMenu = document.getElementById("featuresMenu");
  const settingsMenu = document.getElementById("settingsMenu");
  const btnFeatures = document.getElementById("btnFeatures");
  const btnSettings = document.getElementById("btnSettings");
  const setTemp = document.getElementById("setTemp");
  const setTempVal = document.getElementById("setTempVal");
  const setDensity = document.getElementById("setDensity");
  const setDepth = document.getElementById("setDepth");
  const setAutoRail = document.getElementById("setAutoRail");
  const setEnterSend = document.getElementById("setEnterSend");
  const chatSearch = document.getElementById("chatSearch");
  const judgeCount = document.getElementById("judgeCount");
  if (!app || !log || !form || !input) return;

  const SUGGESTS_CHAT = [
    "Explain ProofPath with sources",
    "Compare Noeti vs centralized AI chat",
    "What does multi-witness verification look like?",
    "How to make pizza",
  ];
  const SUGGESTS_NEWS = [
    "Verify: EU AI Act penalties took effect in 2025",
    "Is OpenAI training on public Reddit posts?",
    "Check claim: confidential LLM GPUs run on independent compute",
    "Wire check: Ukraine grain corridor reopened",
  ];
  const DEFAULT_JUDGES = [
    { role: "speed_judge", label: "Speed judge (0.5B)", id: "qwen2.5:0.5b", prompt: "Fast triage" },
    { role: "balance_judge", label: "Balance judge (1.5B)", id: "qwen2.5:1.5b", prompt: "Weigh sources" },
    { role: "skeptic_judge", label: "Skeptic judge (0.5B)", id: "qwen2.5:0.5b", prompt: "Hostile skeptic" },
    { role: "editor_judge", label: "Editor judge (1.5B)", id: "qwen2.5:1.5b", prompt: "Publish gate" },
    { role: "wire_judge", label: "Wire judge (0.5B)", id: "qwen2.5:0.5b", prompt: "Prefer primaries" },
  ];
  const STAGE_ORDER = ["search", "atomize", "graph", "judges", "gate"];
  const DEPTH_ROLES = {
    fast: ["speed_judge", "editor_judge"],
    standard: ["speed_judge", "balance_judge", "skeptic_judge", "editor_judge", "wire_judge"],
    deep: ["speed_judge", "balance_judge", "skeptic_judge", "editor_judge", "wire_judge"],
  };

  let models = [];
  let currentModel = "openai/gpt-4o-mini";
  let pickingSlot = "chat"; // chat | checker | validator | watcher
  let witnessModels = {
    checker: "qwen2.5:0.5b",
    validator: "qwen2.5:1.5b",
    watcher: "qwen2.5:0.5b",
  };
  let deskTrail = false;
  let mode = "chat"; // newsroom removed
  let judgeDefs = DEFAULT_JUDGES.slice();
  let animTimer = null;
  let state = loadState();
  if (state.witnessModels && typeof state.witnessModels === "object") {
    witnessModels = { ...witnessModels, ...state.witnessModels };
  }
  if (typeof state.deskTrail === "boolean") deskTrail = state.deskTrail;
  let activeId = state.activeId || null;
  mode = "chat";
  const params = new URLSearchParams(location.search);
  // newsroom mode removed from chat

  function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {}; }
    catch { return {}; }
  }
  function saveState() {
    state.activeId = activeId;
    state.model = currentModel;
    state.witnessModels = { ...witnessModels };
    state.deskTrail = !!deskTrail;
    state.mode = mode;
    state.settings = {
      density: setDensity?.value || "compact",
      accent: document.getElementById("setAccent")?.value || "moss",
      showPaid: document.getElementById("setShowPaid")?.checked !== false,
      temp: Number(setTemp?.value || 55),
      depth: setDepth?.value || "standard",
      autoRail: !!setAutoRail?.checked,
      enterSend: !!setEnterSend?.checked,
      privateRoute: !!setPrivateRoute?.checked,
      webSearch: !!document.getElementById("toggleWebSearch")?.checked,
      compare: !!document.getElementById("toggleCompare")?.checked,
      systemPrompt: (document.getElementById("setSystemPrompt")?.value || "").slice(0, 2000),
      featSources: document.getElementById("featSources")?.checked !== false,
      featGraph: document.getElementById("featGraph")?.checked !== false,
      featTimestamps: document.getElementById("featTimestamps")?.checked !== false,
      featCompactMeta: !!document.getElementById("featCompactMeta")?.checked,
      featFocus: !!document.getElementById("featFocus")?.checked,
      featSlash: document.getElementById("featSlash")?.checked !== false,
      featAutoArtifacts: document.getElementById("featAutoArtifacts")?.checked !== false,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  function uid() {
    return "c_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
  function ensureChats() {
    if (!Array.isArray(state.chats)) state.chats = [];
    // Drop empty duplicate "New chat" threads (keep active + newest empty one)
    const empties = state.chats.filter((c) => !(c.messages || []).length && (c.title || "New chat") === "New chat");
    if (empties.length > 1) {
      const keepId = activeId && empties.some((c) => c.id === activeId)
        ? activeId
        : empties.sort((a, b) => (b.updated || 0) - (a.updated || 0))[0].id;
      const drop = new Set(empties.filter((c) => c.id !== keepId).map((c) => c.id));
      state.chats = state.chats.filter((c) => !drop.has(c.id));
    }
  }
  function activeChat() { ensureChats(); return state.chats.find((c) => c.id === activeId) || null; }
  function titleFrom(text) {
    const t = (text || "New chat").replace(/\s+/g, " ").trim();
    return t.length > 42 ? t.slice(0, 42) + "…" : t;
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  /** Plain readable HTML — no raw ### ** --- left in the bubble */
  function formatContent(text) {
    let raw = String(text || "").replace(/\r\n/g, "\n");
    // Extract fenced code first
    const fences = [];
    raw = raw.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const i = fences.length;
      fences.push({ lang: lang || "", code });
      return `\u0000FENCE${i}\u0000`;
    });
    let html = escapeHtml(raw);
    // restore fences
    html = html.replace(/\u0000FENCE(\d+)\u0000/g, (_, i) => {
      const f = fences[Number(i)];
      return `<pre class="code-block" data-lang="${escapeHtml(f.lang)}"><code>${escapeHtml(f.code)}</code></pre>`;
    });
    html = html.replace(/`([^`]+)`/g, "<code class=\"inline\">$1</code>");
    html = html.replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
    // headings
    html = html.replace(/^#{6}\s+(.+)$/gm, "<h6>$1</h6>");
    html = html.replace(/^#{5}\s+(.+)$/gm, "<h5>$1</h5>");
    html = html.replace(/^#{4}\s+(.+)$/gm, "<h4>$1</h4>");
    html = html.replace(/^#{3}\s+(.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^#{2}\s+(.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^#{1}\s+(.+)$/gm, "<h2>$1</h2>");
    // hr
    html = html.replace(/^\s*-{3,}\s*$/gm, "<hr>");
    // bold / italic (complete markers only)
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    // lists
    html = html.replace(/^(?:[-*•])\s+(.+)$/gm, "<li>$1</li>");
    html = html.replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g, (block) => `<ul>${block}</ul>`);
    html = html.replace(/^\d+\.\s+(.+)$/gm, "<li class=\"ol\">$1</li>");
    // strip leftover markdown junk that didn't pair (streaming mid-token)
    html = html.replace(/(^|\n)\s*#{1,6}\s+/g, "$1");
    html = html.replace(/\*{1,3}/g, "");
    // breaks
    html = html.replace(/\n/g, "<br>");
    return html;
  }
  window.__noetiFormatContent = formatContent;
  function setEmptyVisible(show) {
    const appEl = document.getElementById("chatApp");
    if (empty) {
      empty.hidden = !show;
      if (show) {
        empty.removeAttribute("hidden");
        empty.style.display = "";
      } else {
        empty.setAttribute("hidden", "");
        empty.style.display = "none";
      }
    }
    if (log) log.hidden = !!show;
    appEl?.classList.toggle("has-messages", !show);
    if (input) input.placeholder = "Message…";
  }
  function featOn(id) {
    const el = document.getElementById(id);
    return !el || el.checked;
  }
  function temperature() {
    return Math.round(Number(setTemp?.value || 55)) / 100;
  }
  function anyMenuOpen() {
    return !!(modelMenu?.classList.contains("is-open")
      || featuresMenu?.classList.contains("is-open")
      || settingsMenu?.classList.contains("is-open"));
  }

  function hideMenuEl(menu) {
    if (!menu) return;
    menu.classList.remove("is-open");
    menu.hidden = true;
    menu.setAttribute("hidden", "");
  }

  function showMenuEl(menu) {
    if (!menu) return;
    menu.classList.add("is-open");
    menu.hidden = false;
    menu.removeAttribute("hidden");
  }

  function showBackdrop(on) {
    const bd = document.getElementById("menuBackdrop");
    if (!bd) return;
    bd.classList.toggle("is-open", !!on);
    bd.hidden = !on;
    if (on) bd.removeAttribute("hidden");
    else bd.setAttribute("hidden", "");
    app.classList.toggle("menu-open", !!on);
    document.body.classList.toggle("noeti-menu-open", !!on);
  }

  function closeAllMenus() {
    hideMenuEl(modelMenu);
    hideMenuEl(featuresMenu);
    hideMenuEl(settingsMenu);
    modelBtn?.setAttribute("aria-expanded", "false");
    btnFeatures?.setAttribute("aria-expanded", "false");
    btnSettings?.setAttribute("aria-expanded", "false");
    showBackdrop(false);
  }

  function closeMenus() {
    hideMenuEl(featuresMenu);
    hideMenuEl(settingsMenu);
    btnFeatures?.setAttribute("aria-expanded", "false");
    btnSettings?.setAttribute("aria-expanded", "false");
  }

  function toggleMenu(btn, menu) {
    if (!menu || !btn) return;
    const willOpen = !menu.classList.contains("is-open");
    closeAllMenus();
    if (!willOpen) return;
    btn.setAttribute("aria-expanded", "true");
    showMenuEl(menu);
    showBackdrop(true);
  }

  function openModelMenu(slot) {
    pickingSlot = slot || "chat";
    const title = document.getElementById("modelMenuTitle");
    if (title) {
      title.textContent =
        pickingSlot === "chat" ? "Choose model"
        : pickingSlot === "checker" ? "Checker model"
        : pickingSlot === "validator" ? "Validator model"
        : pickingSlot === "watcher" ? "Watcher model"
        : "Choose model";
    }
    closeAllMenus();
    modelBtn?.setAttribute("aria-expanded", "true");
    showMenuEl(modelMenu);
    showBackdrop(true);
    renderModelMenu();
  }

  function closeModelMenu() {
    closeAllMenus();
  }

  function shortModelName(id) {
    if (!id) return "Select";
    const m = models.find((x) => x.id === id);
    let name = m?.name || id;
    // Prefer family + short id over long provider/model paths
    if (name.includes("/")) name = name.split("/").pop() || name;
    if (name.includes(":")) {
      const [base, tag] = name.split(":");
      name = tag && tag.length <= 6 ? `${base} ${tag}` : base;
    }
    return name.length > 14 ? name.slice(0, 12) + "…" : name;
  }

  function updatePlaneLabels() {
    const map = {
      checker: document.getElementById("planeCheckerLabel"),
      validator: document.getElementById("planeValidatorLabel"),
      watcher: document.getElementById("planeWatcherLabel"),
    };
    const railMap = {
      checker: document.getElementById("railPlaneChecker"),
      validator: document.getElementById("railPlaneValidator"),
      watcher: document.getElementById("railPlaneWatcher"),
    };
    for (const role of ["checker", "validator", "watcher"]) {
      const id = witnessModels[role];
      if (map[role]) map[role].textContent = shortModelName(id);
      if (railMap[role]) railMap[role].textContent = id || "—";
    }
    document.querySelectorAll(".plane-picker").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.plane === pickingSlot);
    });
  }

  function applySettingsUI() {
    const s = state.settings || {};
    if (setDensity && s.density) {
      setDensity.value = s.density === "cozy" ? "regular" : s.density;
    }
    if (setTemp && s.temp != null) setTemp.value = String(s.temp);
    if (setDepth && s.depth) setDepth.value = s.depth;
    if (setAutoRail && s.autoRail != null) setAutoRail.checked = s.autoRail;
    if (setEnterSend && s.enterSend != null) setEnterSend.checked = s.enterSend;
    if (setPrivateRoute && s.privateRoute != null) setPrivateRoute.checked = s.privateRoute;
    const showPaid = document.getElementById("setShowPaid");
    if (showPaid && s.showPaid != null) showPaid.checked = s.showPaid;
    const web = document.getElementById("toggleWebSearch");
    if (web && s.webSearch != null) web.checked = !!s.webSearch;
    const cmp = document.getElementById("toggleCompare");
    if (cmp && s.compare != null) cmp.checked = !!s.compare;
    const sys = document.getElementById("setSystemPrompt");
    if (sys && s.systemPrompt != null) sys.value = s.systemPrompt;
    const asst = document.getElementById("assistantSelect");
    if (asst && localStorage.getItem("noeti_assistant")) asst.value = localStorage.getItem("noeti_assistant");
    syncCompareUI();
    const map = {
      featSources: s.featSources,
      featGraph: s.featGraph,
      featTimestamps: s.featTimestamps,
      featCompactMeta: s.featCompactMeta,
      featFocus: s.featFocus,
      featSlash: s.featSlash,
      featAutoArtifacts: s.featAutoArtifacts,
    };
    Object.entries(map).forEach(([id, val]) => {
      const el = document.getElementById(id);
      if (el && val != null) el.checked = !!val;
    });
    app.dataset.density = setDensity?.value || "compact";
    const accent = document.getElementById("setAccent")?.value || state.settings?.accent || "moss";
    app.dataset.accent = accent;
    if (document.getElementById("setAccent") && state.settings?.accent) document.getElementById("setAccent").value = state.settings.accent;
    if (setTempVal) setTempVal.textContent = temperature().toFixed(2);
    syncDepthToJudges();
    syncPrivateNote();
    applyModuleVisibility();
  }

  function applyModuleVisibility() {
    const chart = document.getElementById("railChartBlock");
    if (chart) chart.hidden = false; // Desk scene always visible when rail open
    app.classList.toggle("focus-mode", featOn("featFocus"));
  }

  function syncCompareUI() {
    const on = !!document.getElementById("toggleCompare")?.checked;
    const wrap = document.getElementById("compareModelBWrap");
    const pane = document.getElementById("comparePane");
    if (wrap) wrap.hidden = !on;
    if (pane && !on) pane.hidden = true;
    window.__noetiCompareMode = on;
    if (typeof window.__noetiRefreshComposerNote === "function") window.__noetiRefreshComposerNote();
  }

  function syncPrivateNote() {
    const priv = !!setPrivateRoute?.checked;
    if (composerNote) {
      composerNote.textContent = priv
        ? "Private local stack · on-node models only · no public search · draft — not publish-ready"
        : "Public path · non-sensitive only · toggle Private local stack in Settings for first-pass privacy";
    }
    app.classList.toggle("private-route", priv);
    // When enabling private, snap chat model to an on-node install if needed
    if (priv && models?.length) {
      const cur = models.find((m) => m.id === currentModel);
      if (!cur?.on_node) {
        const nodePick = models.find((m) => m.on_node)?.id;
        if (nodePick) {
          currentModel = nodePick;
          updateModelLabel();
          saveState();
        }
      }
    }
  }

  function syncDepthToJudges() {
    if (!togglesEl || !setDepth) return;
    const depth = setDepth?.value || "standard";
    const roles = new Set(DEPTH_ROLES[depth] || DEPTH_ROLES.standard);
    if (!togglesEl) return;
    [...togglesEl.querySelectorAll('input[name="judge"]')].forEach((el) => {
      el.checked = roles.has(el.value);
    });
    updateJudgeCount();
  }

  function updateJudgeCount() {
    if (judgeCount) judgeCount.textContent = String(selectedRoles().length);
  }

  function setMode(_next) {
    mode = "chat";
    modeChat?.classList.add("is-on");
    modeNewsroom?.classList.remove("is-on");
    modeChat?.setAttribute("aria-selected", "true");
    modeNewsroom?.setAttribute("aria-selected", "false");
    if (composerTools) composerTools.hidden = true;
    if (pipeline) pipeline.hidden = true;
    if (emptyByline) {
      emptyByline.textContent = "A trail behind claims. Planes that can contest. Private first when the binder is sensitive.";
    }
    input.placeholder = "Message…";
    app.classList.remove("mode-newsroom");
    renderSuggests();
    saveState();
    const url = new URL(location.href);
    url.searchParams.delete("mode");
    url.searchParams.delete("workflow");
    history.replaceState({}, "", url.pathname + url.search);
  }

  function setPipeline(active, doneThrough) {
    if (!pipeline) return;
    [...pipeline.querySelectorAll("li")].forEach((li) => {
      const stage = li.dataset.stage;
      const idx = STAGE_ORDER.indexOf(stage);
      li.classList.toggle("is-done", doneThrough != null && idx <= doneThrough);
      li.classList.toggle("is-active", stage === active);
    });
  }
  function startLocalAnim() {
    if (!pipeline || !featOn("featPipeline")) return;
    pipeline.hidden = false;
    let i = 0;
    setPipeline(STAGE_ORDER[0], -1);
    clearInterval(animTimer);
    animTimer = setInterval(() => {
      i = (i + 1) % STAGE_ORDER.length;
      setPipeline(STAGE_ORDER[i], i - 1);
    }, 1200);
  }
  function stopLocalAnim() {
    clearInterval(animTimer);
    animTimer = null;
    setPipeline("gate", STAGE_ORDER.length - 1);
  }

  function renderToggles(list) {
    if (!togglesEl) return;
    togglesEl.innerHTML = list.map((j) => `<label class="wf-toggle">
      <input type="checkbox" name="judge" value="${escapeHtml(j.role)}" checked data-model="${escapeHtml(j.id)}" />
      <span><strong>${escapeHtml(j.label)}</strong><em>${escapeHtml(j.id)}</em></span>
    </label>`).join("");
    togglesEl.querySelectorAll('input[name="judge"]').forEach((el) => {
      el.addEventListener("change", () => { updateJudgeCount(); saveState(); });
    });
    syncDepthToJudges();
  }
  function selectedRoles() {
    if (!togglesEl) return DEFAULT_JUDGES.map((j) => j.role);
    const picked = [...togglesEl.querySelectorAll('input[name="judge"]:checked')].map((el) => el.value);
    return picked.length ? picked : DEFAULT_JUDGES.map((j) => j.role);
  }

  function renderChart(insights) {
    if (!chartEl) return;
    const bars = insights?.bars || [];
    if (!bars.length) {
      chartEl.innerHTML = '<p class="dim">No graph yet</p>';
      return;
    }
    chartEl.hidden = false;
    if (sourcingGraph) sourcingGraph.hidden = true;
    const w = 260, h = 120, pad = 18, gap = 12;
    const bw = (w - pad * 2 - gap * (bars.length - 1)) / bars.length;
    let rects = "";
    bars.forEach((b, i) => {
      const bh = Math.max(4, (b.value / 100) * (h - pad * 2));
      const x = pad + i * (bw + gap);
      const y = h - pad - bh;
      rects += `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="4" fill="#111" opacity="${0.35 + (b.value/100)*0.65}"></rect>`;
      rects += `<text x="${x + bw/2}" y="${h - 4}" text-anchor="middle" font-size="9" fill="#888">${escapeHtml(b.label)}</text>`;
    });
    chartEl.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="120">${rects}</svg>`;
    if (insightMeta) insightMeta.textContent = `${insights.model || ""} · ${insights.latency_ms || 0}ms · ${insights.reply_words || 0} words`;
  }

  let deskGraphState = {
    yaw: 0.4,
    pitch: 0.35,
    zoom: 1.15,
    nodes: [],
    edges: [],
    judgements: [],
    activity: [],
    summary: null,
    selectedId: null,
    auto: true,
  };

  function fibSphere(count, radius) {
    const pts = [];
    const n = Math.max(count, 1);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      pts.push({
        x: Math.cos(theta) * r * radius,
        y: y * radius,
        z: Math.sin(theta) * r * radius,
      });
    }
    return pts;
  }

  function project3d(x, y, z, w, h, yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    const y1 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    const depth = 520 / (520 + z2 + 220);
    return {
      x: w * 0.5 + x1 * depth,
      y: h * 0.5 + y1 * depth * 0.92,
      s: depth,
      z: z2,
    };
  }

  function findJudgementRow(node, judgements) {
    const needle = (node.full || node.label || "").slice(0, 36);
    return (judgements || []).find((j) => (j.claim || "").slice(0, 36) === needle)
      || (judgements || []).find((j) => (j.claim || "").includes(needle.slice(0, 18)))
      || null;
  }


  function openDeskEdgeDetail(from, to, edge) {
    const panel = document.getElementById("deskDetail");
    if (!panel) return;
    panel.hidden = false;
    deskGraphState.selectedId = null;
    deskGraphState._paint?.();
    const kind = document.getElementById("deskDetailKind");
    const title = document.getElementById("deskDetailTitle");
    const body = document.getElementById("deskDetailBody");
    const meta = document.getElementById("deskDetailMeta");
    const link = document.getElementById("deskDetailLink");
    const linksEl = document.getElementById("deskDetailLinks");
    const votes = document.getElementById("deskDetailVotes");
    const rel = edge?.rel || "related";
    const src = from.type === "source" ? from : (to.type === "source" ? to : from);
    const claim = from.type === "claim" ? from : (to.type === "claim" ? to : to);
    if (kind) kind.textContent = "Link path";
    if (title) title.textContent = `${(from.label || from.type).slice(0, 40)} → ${(to.label || to.type).slice(0, 40)}`;
    const bits = (edge?.overlap || []).slice(0, 5).join(", ");
    const row = findJudgementRow(claim, deskGraphState.judgements);
    const reasons = (row?.judges || []).map((j) => `${j.label}: ${plainReasonText(j.reason || "").slice(0, 120)}`).filter(Boolean);
    if (body) {
      body.textContent = [
        `Relation: ${rel}${edge?.weight != null ? ` · strength ${Number(edge.weight).toFixed(1)}` : ""}`,
        src?.type === "source" ? `Source: ${(src.full || src.label || "").slice(0, 100)}` : "",
        claim?.type === "claim" ? `Claim: ${(claim.full || claim.label || "").slice(0, 120)}` : "",
        bits ? `Shared signals: ${bits}` : "",
        reasons[0] ? `How it informed the result — ${reasons[0]}` : "How it informed the result — link scored from search overlap and witness attention.",
      ].filter(Boolean).join("\n\n");
    }
    if (meta) {
      meta.hidden = false;
      meta.innerHTML = `<span>${escapeHtml(rel)}</span>` + (src?.channel ? `<span>${escapeHtml(src.channel)}</span>` : "");
    }
    if (link) {
      if (src?.url && /^https?:\/\//i.test(src.url)) {
        link.hidden = false; link.href = src.url; link.textContent = "Open source";
      } else link.hidden = true;
    }
    if (linksEl) {
      linksEl.hidden = false;
      linksEl.innerHTML = `<p>Endpoints</p>
        <button type="button" data-jump="${escapeHtml(from.id)}"><strong>${escapeHtml((from.label || from.id).slice(0, 50))}</strong><em>from</em></button>
        <button type="button" data-jump="${escapeHtml(to.id)}"><strong>${escapeHtml((to.label || to.id).slice(0, 50))}</strong><em>to</em></button>`;
      linksEl.querySelectorAll("[data-jump]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const n = deskGraphState.nodes.find((x) => x.id === btn.dataset.jump);
          if (n) openDeskDetail(n, deskGraphState.judgements);
        });
      });
    }
    if (votes) {
      votes.innerHTML = "";
      (row?.judges || []).forEach((j) => {
        const d = document.createElement("div");
        d.className = "desk-vote";
        d.innerHTML = `<strong>${escapeHtml(j.label)}</strong>
          <span class="wf-verdict ${escapeHtml(j.verdict)}">${escapeHtml(j.verdict)}</span>
          <p>${escapeHtml(plainReasonText(j.reason || "").slice(0, 220))}</p>`;
        votes.appendChild(d);
      });
      if (!(row?.judges || []).length) {
        votes.innerHTML = `<p class="desk-vote-model">Tap a claim endpoint for plane votes.</p>`;
      }
    }
    app.classList.add("rail-open");
  }

  function setArchStages(map, routeLabel) {
    // Keep arch strip hidden — unstyled dump was leaking into chat.
    // Progress lives on Desk chips (Checker / Validator / Watcher).
    const strip = document.getElementById("archStrip");
    if (strip) strip.hidden = true;
    const route = document.getElementById("archRoute");
    if (route) route.textContent = routeLabel || (document.getElementById("setPrivateRoute")?.checked ? "Private local" : "Public");
  }


  const PROV_STOP = new Set([
    "that","this","with","from","have","been","were","will","your","their","about","into",
    "than","then","them","they","what","when","where","which","while","would","could","should",
    "there","these","those","other","some","more","most","such","only","also","just","like",
    "over","after","before","because","through","during","each","make","made","using","used",
    "very","much","many","http","https","www","com","org","html","the","and","for","are","was",
    "not","but","you","all","can","had","her","his","its","our","out","has","how","did","does",
  ]);

  function provTokens(text) {
    return String(text || "")
      .toLowerCase()
      .match(/[a-z][a-z0-9-]{2,}/g)
      ?.filter((w) => !PROV_STOP.has(w) && w.length >= 3) || [];
  }

  function scoreTextOverlap(a, b) {
    const wa = provTokens(a);
    const wb = new Set(provTokens(b));
    if (!wa.length || !wb.size) return 0;
    const hits = wa.filter((w) => wb.has(w));
    // denser overlap on short phrases scores higher
    return hits.length + (hits.length / Math.max(wa.length, 1)) * 2;
  }

  function sharedProvWords(a, b) {
    const wb = new Set(provTokens(b));
    return [...new Set(provTokens(a).filter((w) => wb.has(w)))].slice(0, 8);
  }

  function sentenceFromPoint(clientX, clientY, root) {
    let node = null;
    let offset = 0;
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(clientX, clientY);
      if (range) { node = range.startContainer; offset = range.startOffset; }
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(clientX, clientY);
      if (pos) { node = pos.offsetNode; offset = pos.offset; }
    }
    if (!node || !root.contains(node)) return "";
    const block = (node.nodeType === 3 ? node.parentElement : node)?.closest?.("p, li, h2, h3, h4, h5, h6, div.msg-content") || root;
    const full = (block.innerText || block.textContent || "").replace(/\s+/g, " ").trim();
    if (!full) return "";
    let abs = 0;
    const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let cur;
    let caretAbs = 0;
    let found = false;
    while ((cur = walk.nextNode())) {
      const len = cur.textContent.length;
      if (cur === node || cur.contains?.(node)) {
        caretAbs = abs + Math.min(offset, len);
        found = true;
        break;
      }
      abs += len;
    }
    if (!found) return full.slice(0, 220);
    const parts = full.split(/(?<=[.!?])\s+/);
    let pos = 0;
    for (const part of parts) {
      const next = pos + part.length;
      if (caretAbs >= pos - 2 && caretAbs <= next + 2) return part.trim();
      pos = next + 1;
    }
    // List items / short blocks: use whole block as the unit
    if (block.tagName === "LI" || full.length < 160) return full;
    return full.slice(0, 220);
  }

  function sourcesForClaim(payload, claimText) {
    const sources = payload?.sources || [];
    const edges = payload?.graph?.edges || [];
    const nodes = payload?.graph?.nodes || [];
    if (!claimText || !nodes.length) return [];
    const claimNode = nodes.find((n) =>
      n.type === "claim" && (
        (n.full || n.label || "") === claimText
        || (n.full || "").includes(claimText.slice(0, 40))
        || claimText.includes((n.full || n.label || "").slice(0, 40))
      )
    );
    if (!claimNode) return [];
    const linked = [];
    edges.forEach((e) => {
      if (e.from !== claimNode.id && e.to !== claimNode.id) return;
      if (!["supports", "related", "contests"].includes(e.rel || "related")) return;
      const oid = e.from === claimNode.id ? e.to : e.from;
      const gn = nodes.find((n) => n.id === oid && n.type === "source");
      if (!gn) return;
      // match graph node to payload.sources
      const src = sources.find((s) =>
        (s.url && gn.url && s.url === gn.url)
        || (s.title && gn.label && s.title.slice(0, 40) === gn.label.slice(0, 40))
      ) || {
        title: gn.label || gn.full,
        url: gn.url,
        snippet: gn.snippet,
        channel: gn.channel,
      };
      linked.push({
        src,
        score: Number(e.weight) || 1,
        rel: e.rel || "related",
        overlap: e.overlap || [],
      });
    });
    linked.sort((a, b) => b.score - a.score);
    return linked;
  }

  function buildSentenceReason(sentence, row, linked) {
    const bits = [];
    const top = linked[0];
    if (top) {
      const overlap = (top.overlap || sharedProvWords(sentence, `${top.src.title || ""} ${top.src.snippet || ""}`)).slice(0, 5);
      const title = (top.src.title || top.src.url || "a source").slice(0, 70);
      const rel = top.rel === "supports" ? "supports" : top.rel === "contests" ? "contests" : "relates to";
      bits.push(`This line ${rel} “${title}”${overlap.length ? ` via ${overlap.join(", ")}` : ""}.`);
    }
    // Prefer the judge reason that shares the most words with THIS sentence
    const judges = row?.judges || [];
    let bestJ = null;
    let bestS = 0;
    judges.forEach((j) => {
      const sc = scoreTextOverlap(sentence, `${j.reason || ""} ${(j.steps || []).join(" ")}`);
      if (sc > bestS) { bestS = sc; bestJ = j; }
    });
    if (bestJ && bestS >= 1) {
      bits.push(`${bestJ.label} (${(bestJ.verdict || "unknown").toUpperCase()}): ${plainReasonText(bestJ.reason || "").slice(0, 180)}`);
    } else if (judges[0]?.reason) {
      // Only cite a general vote if we have a claim match — mark it as claim-level
      bits.push(`Claim-level ${judges[0].label}: ${plainReasonText(judges[0].reason).slice(0, 140)}`);
    }
    if (!bits.length) {
      return "No distinct source trail for this sentence yet — Desk links may be thin for this line.";
    }
    return bits.join(" ");
  }


  function clearProvMarks() {
    document.querySelectorAll("mark.prov-mark").forEach((m) => {
      const parent = m.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(m.textContent || ""), m);
      parent.normalize();
    });
  }

  function markSentenceInContent(sentence) {
    clearProvMarks();
    const s = String(sentence || "").trim();
    if (s.length < 6) return;
    const roots = document.querySelectorAll(".msg.assistant .msg-content.prov-ready");
    const needle = s.slice(0, Math.min(120, s.length));
    for (const root of roots) {
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walk.nextNode())) {
        const t = node.textContent || "";
        const idx = t.indexOf(needle);
        if (idx < 0) continue;
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, Math.min(t.length, idx + needle.length));
        try {
          const mark = document.createElement("mark");
          mark.className = "prov-mark";
          range.surroundContents(mark);
        } catch (_) { /* ignore split issues */ }
        return;
      }
    }
  }

  function showProvenance(sentence, payload, at = null) {
    const pop = document.getElementById("provPop");
    if (!pop) return;
    const claims = payload?.claims || [];
    const judgements = payload?.judgements || [];
    const sources = payload?.sources || [];
    const s = String(sentence || "").trim();
    if (s.length < 6) { pop.hidden = true; return; }
    markSentenceInContent(s);

    const hasDesk = !!(payload?.judgements?.length || payload?.sources?.length || payload?.claims?.length || payload?.graph);
    if (!hasDesk) {
      pop.hidden = false;
      pop.style.transform = "";
      pop.innerHTML = `
        <h3>Why this is here</h3>
        <div class="prov-quote">${escapeHtml(s.slice(0, 280))}</div>
        <p><strong>Reason</strong> · Desk has not finished mapping this reply yet — wait for Checker / Validator / Watcher, then tap again.</p>
        <p>Open the Desk rail to watch sources appear.</p>
        <p style="margin-top:0.75rem"><button type="button" class="btn-chip" id="provClose">Close</button></p>`;
      document.getElementById("provClose")?.addEventListener("click", () => { pop.hidden = true; clearProvMarks(); });
      placeProvPop(pop, at);
      return;
    }

    // 1) Best claim match — require real overlap or leave unmatched
    let best = null;
    let bestScore = 0;
    const pool = judgements.length
      ? judgements.map((j) => ({ text: j.claim, row: j }))
      : claims.map((c) => ({ text: typeof c === "string" ? c : c.text || c.claim || "", row: null }));
    pool.forEach((item) => {
      const tt = item.text || "";
      let score = scoreTextOverlap(s, tt);
      const low = s.toLowerCase();
      const tl = tt.toLowerCase();
      if (tl && (tl.includes(low.slice(0, Math.min(48, low.length))) || low.includes(tl.slice(0, Math.min(48, tl.length))))) {
        score += 5;
      }
      if (score > bestScore) { bestScore = score; best = item; }
    });
    const claimMatched = !!(best && bestScore >= 2);
    const row = claimMatched
      ? (best.row || findJudgementRow({ full: best.text, label: best.text }, judgements))
      : null;

    // 2) Sources: claim-linked edges first, else sentence-only ranked — NEVER dump unranked full list
    let linked = claimMatched ? sourcesForClaim(payload, best.text) : [];
    if (!linked.length) {
      linked = sources
        .map((src) => {
          const blob = `${src.title || ""} ${src.snippet || ""}`;
          const score = scoreTextOverlap(s, blob);
          const overlap = sharedProvWords(s, blob);
          return { src, score, rel: score >= 2 ? "supports" : "related", overlap };
        })
        .filter((r) => r.score >= 1.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, 4);
    } else {
      // Re-rank claim-linked by sentence overlap so different sentences differ
      linked = linked
        .map((L) => {
          const blob = `${L.src.title || ""} ${L.src.snippet || ""}`;
          const extra = scoreTextOverlap(s, blob);
          const overlap = (L.overlap && L.overlap.length)
            ? L.overlap
            : sharedProvWords(s, blob);
          return { ...L, score: (L.score || 1) + extra * 1.5, overlap, sentScore: extra };
        })
        .sort((a, b) => (b.sentScore - a.sentScore) || (b.score - a.score))
        .slice(0, 4);
      // Drop links with zero sentence overlap if we have any with overlap
      if (linked.some((L) => L.sentScore > 0)) {
        linked = linked.filter((L) => L.sentScore > 0);
      }
    }

    const why = buildSentenceReason(s, row, linked);
    const path = (row?.judges || [])
      .map((j) => {
        const sc = scoreTextOverlap(s, j.reason || "");
        return { j, sc, text: `${j.label}: ${(j.verdict || "").toUpperCase()} — ${plainReasonText(j.reason || "").slice(0, 160)}` };
      })
      .filter((x) => x.sc >= 1 || (claimMatched && x.j.reason))
      .sort((a, b) => b.sc - a.sc)
      .slice(0, 3);

    pop.hidden = false;
    pop.style.transform = "";
    const emptyTrail = !linked.length && !path.length;
    pop.innerHTML = `
      <h3>Why this is here</h3>
      <div class="prov-quote">${escapeHtml(s.slice(0, 280))}</div>
      <p><strong>Reason</strong> · ${escapeHtml(emptyTrail
        ? (hasDesk
          ? "No source trail for this line — try a more claim-like sentence, or check Desk."
          : why)
        : why)}</p>
      ${claimMatched ? `<p>Tied claim · ${escapeHtml((best.text || "").slice(0, 160))}</p>` : ""}
      ${row?.aggregate?.final_verdict ? `<p>Claim vote · <strong>${escapeHtml(row.aggregate.final_verdict)}</strong></p>` : ""}
      ${path.length ? `<p>Plane notes</p><ul>${path.map((p) => `<li>${escapeHtml(p.text)}</li>`).join("")}</ul>` : ""}
      ${linked.length ? `<p>Sources</p><ul>${linked.map((L) => {
        const src = L.src;
        const title = src.title || src.url || "source";
        const url = src.url || "";
        const ov = (L.overlap || []).slice(0, 5).join(", ");
        const snip = (src.snippet || "").slice(0, 90);
        const rel = L.rel || "related";
        return `<li>${url
          ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(String(title).slice(0, 80))}</a>`
          : escapeHtml(String(title).slice(0, 80))}
          <em> · ${escapeHtml(rel)}${ov ? ` · ${escapeHtml(ov)}` : ""}${snip ? ` — ${escapeHtml(snip)}` : ""}</em></li>`;
      }).join("")}</ul>` : ""}
      <p style="margin-top:0.75rem"><button type="button" class="btn-chip" id="provClose">Close</button></p>`;
    document.getElementById("provClose")?.addEventListener("click", () => { pop.hidden = true; clearProvMarks(); });
    placeProvPop(pop, at);
  }

  function placeProvPop(pop, at) {
    if (!pop) return;
    // Phone: CSS bottom-sheet — don't fight it with absolute coords
    if (window.matchMedia("(max-width: 820px)").matches) {
      pop.style.left = "";
      pop.style.right = "";
      pop.style.top = "";
      pop.style.bottom = "";
      pop.style.width = "";
      pop.style.maxWidth = "";
      pop.style.transform = "";
      return;
    }
    pop.style.transform = "";
    const main = document.querySelector(".chat-main") || document.querySelector(".chat-stream");
    const box = main?.getBoundingClientRect?.() || { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight };
    const pad = 10;
    const maxW = Math.min(360, Math.max(220, box.width - pad * 2));
    pop.style.width = maxW + "px";
    pop.style.maxWidth = maxW + "px";
    pop.style.right = "auto";
    pop.style.bottom = "auto";
    const x = (at && Number.isFinite(at.x)) ? at.x : box.left + box.width / 2;
    const y = (at && Number.isFinite(at.y)) ? at.y : box.top + box.height * 0.35;
    let left = x - maxW / 2;
    left = Math.max(box.left + pad, Math.min(left, box.right - maxW - pad));
    let top = y + 14;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    requestAnimationFrame(() => {
      const rect = pop.getBoundingClientRect();
      if (rect.bottom > box.bottom - pad) {
        top = Math.max(box.top + pad, y - rect.height - 12);
        pop.style.top = top + "px";
      }
      if (rect.right > box.right - pad) {
        pop.style.left = Math.max(box.left + pad, box.right - rect.width - pad) + "px";
      }
    });
  }

  function openDeskDetail(node, judgements) {
    const panel = document.getElementById("deskDetail");
    if (!panel || !node) return;
    panel.hidden = false;
    deskGraphState.selectedId = node.id;
    deskGraphState._paint?.();
    const kind = document.getElementById("deskDetailKind");
    const title = document.getElementById("deskDetailTitle");
    const body = document.getElementById("deskDetailBody");
    const meta = document.getElementById("deskDetailMeta");
    const link = document.getElementById("deskDetailLink");
    const linksEl = document.getElementById("deskDetailLinks");
    const votes = document.getElementById("deskDetailVotes");
    const nodes = deskGraphState.nodes || [];
    const edges = deskGraphState.edges || [];
    const neighbors = edges
      .filter((e) => e.from === node.id || e.to === node.id)
      .map((e) => {
        const oid = e.from === node.id ? e.to : e.from;
        const n = nodes.find((x) => x.id === oid);
        return n
          ? {
              node: n,
              rel: e.rel || "related",
              weight: e.weight || 1,
              overlap: e.overlap || [],
            }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0));

    if (kind) {
      kind.textContent = node.type === "claim" ? "Claim"
        : node.type === "source" ? "Source"
        : "Desk path";
    }
    if (title) title.textContent = (node.full || node.label || node.id || "").slice(0, 180);

    if (body) {
      if (node.type === "source") {
        body.textContent = node.snippet || [node.channel, node.url].filter(Boolean).join(" · ") || "No snippet";
      } else if (node.type === "desk") {
        const gate = deskGraphState.summary?.publish_gate || "review";
        const nClaims = (deskGraphState.judgements || []).length || neighbors.filter((n) => n.node.type === "claim").length;
        const nSrc = neighbors.filter((n) => n.node.type === "source").length
          || nodes.filter((n) => n.type === "source").length;
        body.textContent = `Publish gate ${gate}. ${nClaims} claim(s) · ${nSrc} source(s) on this map.`;
      } else {
        body.textContent = node.full || node.label || "";
      }
    }

    if (meta) {
      const chips = [];
      if (node.type === "source" && node.channel) chips.push(node.channel);
      if (node.type === "claim") {
        const row = findJudgementRow(node, judgements);
        const final = row?.aggregate?.final_verdict;
        if (final) chips.push(final);
        if (row?.judges?.length) chips.push(`${row.judges.length} models`);
      }
      if (node.type === "desk" && deskTrail) chips.push("trail on");
      if (chips.length) {
        meta.hidden = false;
        meta.innerHTML = chips.map((c) => `<span>${escapeHtml(c)}</span>`).join("");
      } else {
        meta.hidden = true;
        meta.innerHTML = "";
      }
    }

    if (link) {
      if (node.url && /^https?:\/\//i.test(node.url)) {
        link.hidden = false;
        link.href = node.url;
        link.textContent = "Open source";
      } else link.hidden = true;
    }

    if (linksEl) {
      const useful = neighbors.filter((n) => n.node.type === "claim" || n.node.type === "source").slice(0, 8);
      if (useful.length) {
        linksEl.hidden = false;
        const label = node.type === "claim" ? "Logical links" : node.type === "source" ? "Logical links" : "Connected";
        linksEl.innerHTML = `<p>${escapeHtml(label)}</p>` + useful.map((n) => {
          const lab = (n.node.label || n.node.id || "").slice(0, 56);
          const rel = n.rel === "supports" ? "strong" : (n.rel || "related");
          const bits = (n.overlap || []).slice(0, 3).join(" · ");
          const sub = bits ? `${rel} · ${bits}` : `${rel} · w${Number(n.weight || 1).toFixed(1)}`;
          return `<button type="button" data-jump="${escapeHtml(n.node.id)}">
            <strong>${escapeHtml(lab)}</strong>
            <em>${escapeHtml(sub)}</em>
          </button>`;
        }).join("");
        linksEl.querySelectorAll("[data-jump]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const next = nodes.find((n) => n.id === btn.dataset.jump);
            if (next) openDeskDetail(next, deskGraphState.judgements);
          });
        });
      } else {
        linksEl.hidden = true;
        linksEl.innerHTML = "";
      }
    }

    if (votes) {
      votes.innerHTML = "";
      if (node.type === "claim") {
        const row = findJudgementRow(node, judgements);
        (row?.judges || []).forEach((j) => {
          const d = document.createElement("div");
          d.className = "desk-vote";
          const ms = j.latency_ms != null ? ` · ${j.latency_ms}ms` : "";
          const saw = j.saw?.source_count != null ? ` · saw ${j.saw.source_count}` : "";
          let trailHtml = "";
          if (deskTrail && Array.isArray(j.steps) && j.steps.length) {
            trailHtml = `<ol class="desk-trail">${j.steps.map((s, i) =>
              `<li data-n="${i + 1}">${escapeHtml(plainReasonText(s))}</li>`
            ).join("")}</ol>`;
          } else if (deskTrail && !j.steps?.length) {
            trailHtml = `<p class="desk-vote-model">No trail on this run — send again with Trail on.</p>`;
          }
          d.innerHTML = `<strong>${escapeHtml(j.label)}</strong>
            <span class="wf-verdict ${escapeHtml(j.verdict)}">${escapeHtml(j.verdict)}</span>
            <span class="desk-vote-model">${escapeHtml(j.model || "")}${escapeHtml(ms)}${escapeHtml(saw)}</span>
            <p>${escapeHtml(plainReasonText(j.reason || ""))}</p>
            ${trailHtml}`;
          votes.appendChild(d);
        });
        if (!(row?.judges || []).length) {
          votes.innerHTML = `<p class="desk-vote-model">No model votes for this claim yet.</p>`;
        }
      } else if (node.type === "desk") {
        const path = (deskGraphState.activity || []).slice(0, 10);
        if (path.length) {
          const ol = document.createElement("ol");
          ol.className = "desk-path";
          path.forEach((a) => {
            const li = document.createElement("li");
            const who = a.actor || a.stage || "desk";
            const did = a.did || a.verdict || "";
            li.textContent = `${who}: ${did}`;
            ol.appendChild(li);
          });
          votes.appendChild(ol);
        }
      } else if (node.type === "source") {
        const linkedClaims = neighbors.filter((n) => n.node.type === "claim");
        linkedClaims.slice(0, 3).forEach((n) => {
          const row = findJudgementRow(n.node, judgements);
          if (!row) return;
          const d = document.createElement("div");
          d.className = "desk-vote";
          const final = row.aggregate?.final_verdict || "unknown";
          d.innerHTML = `<strong>Claim vote</strong>
            <span class="wf-verdict ${escapeHtml(final)}">${escapeHtml(final)}</span>
            <p>${escapeHtml((n.node.full || n.node.label || "").slice(0, 140))}</p>`;
          votes.appendChild(d);
        });
      }
    }
  }

  function renderSourcingGraph(graph, judgements, extras = {}) {
    if (!sourcingGraph) return;
    const nodes = (graph?.nodes || []).filter((n) => n.type !== "channel");
    const idset = new Set(nodes.map((n) => n.id));
    const edges = (graph?.edges || []).filter((e) => idset.has(e.from) && idset.has(e.to));
    if (chartEl) chartEl.hidden = true;
    sourcingGraph.hidden = false;
    if (!nodes.length) {
      sourcingGraph.innerHTML = `<div class="desk-scene-empty">
        <p>Sphere graph</p>
        <span>Touch a point for claim or source info</span>
      </div>`;
      return;
    }

    const shell = nodes.filter((n) => n.type !== "desk");
    const baseR = 220;
    const sphere = fibSphere(shell.length, baseR);
    const layout = { desk: { x: 0, y: 0, z: 0 } };
    shell.forEach((n, i) => { layout[n.id] = sphere[i] || { x: 0, y: 0, z: 0 }; });

    const prevSel = deskGraphState.selectedId;
    deskGraphState = {
      yaw: deskGraphState.yaw ?? 0.4,
      pitch: deskGraphState.pitch ?? 0.35,
      zoom: Math.max(0.65, Math.min(2.4, deskGraphState.zoom ?? 1.15)),
      auto: deskGraphState.auto !== false,
      selectedId: prevSel && nodes.some((n) => n.id === prevSel) ? prevSel : null,
      nodes: nodes.map((n) => ({ ...n, ...(layout[n.id] || { x: 0, y: 0, z: 0 }) })),
      edges,
      judgements: judgements || deskGraphState.judgements || [],
      activity: extras.activity || deskGraphState.activity || [],
      summary: extras.summary || deskGraphState.summary || null,
      explain: extras.explain != null ? !!extras.explain : deskGraphState.explain,
      baseR,
    };

    const w = 860, h = 720;

    function themeCats() {
      const dark = document.documentElement.getAttribute("data-theme") === "black"
        || document.body?.getAttribute("data-theme") === "black";
      const CAT = dark ? {
        desk: { fill: "#5eead4", soft: "rgba(45,212,191,0.35)", label: "Desk hub" },
        claim: { fill: "#94a3b8", soft: "rgba(148,163,184,0.35)", label: "Claim" },
        "claim-ok": { fill: "#2dd4bf", soft: "rgba(45,212,191,0.4)", label: "Supported" },
        "claim-bad": { fill: "#f87171", soft: "rgba(248,113,113,0.35)", label: "Contested" },
        "src-wiki": { fill: "#38bdf8", soft: "rgba(56,189,248,0.35)", label: "Wiki" },
        "src-news": { fill: "#a78bfa", soft: "rgba(167,139,250,0.35)", label: "News" },
        "src-web": { fill: "#64748b", soft: "rgba(100,116,139,0.35)", label: "Web" },
      } : {
        desk: { fill: "#111111", soft: "rgba(17,17,17,0.45)", label: "Desk hub" },
        claim: { fill: "#888888", soft: "rgba(136,136,136,0.4)", label: "Claim" },
        "claim-ok": { fill: "#333333", soft: "rgba(51,51,51,0.45)", label: "Supported" },
        "claim-bad": { fill: "#111111", soft: "rgba(17,17,17,0.55)", label: "Contested" },
        "src-wiki": { fill: "#555555", soft: "rgba(85,85,85,0.4)", label: "Wiki" },
        "src-news": { fill: "#444444", soft: "rgba(68,68,68,0.45)", label: "News" },
        "src-web": { fill: "#777777", soft: "rgba(119,119,119,0.4)", label: "Web" },
      };
      return { dark, CAT };
    }

    function nodeCategory(n) {
      if (n.type === "desk") return "desk";
      if (n.type === "claim") {
        const row = findJudgementRow(n, deskGraphState.judgements);
        const v = row?.aggregate?.final_verdict;
        if (v === "supported") return "claim-ok";
        if (v === "contested") return "claim-bad";
        return "claim";
      }
      const ch = String(n.channel || n.source || "").toLowerCase();
      const url = String(n.url || "").toLowerCase();
      if (ch.includes("wiki") || url.includes("wikipedia")) return "src-wiki";
      if (ch.includes("news") || ch.includes("wire") || ch.includes("rss")) return "src-news";
      return "src-web";
    }

    function syncZoomLabel() {
      const lab = document.getElementById("deskZoomLabel");
      if (lab) lab.textContent = `${Math.round((deskGraphState.zoom || 1) * 100)}%`;
    }

    function paint() {
      const { dark, CAT } = themeCats();
      const { yaw, pitch, selectedId } = deskGraphState;
      const z = deskGraphState.zoom || 1;
      const projected = {};
      deskGraphState.nodes.forEach((n) => {
        projected[n.id] = {
          ...n,
          cat: nodeCategory(n),
          ...project3d((n.x || 0) * z, (n.y || 0) * z, (n.z || 0) * z, w, h, yaw, pitch),
        };
      });
      const ordered = Object.values(projected).sort((a, b) => a.z - b.z);

      let guides = "";
      for (let ring = 0; ring < 4; ring++) {
        const rr = (70 + ring * 48) * z;
        const pts = [];
        for (let a = 0; a <= 48; a++) {
          const t = (a / 48) * Math.PI * 2;
          const p = project3d(Math.cos(t) * rr, Math.sin(t) * rr * 0.34, Math.sin(t) * rr * 0.22, w, h, yaw, pitch);
          pts.push(`${p.x},${p.y}`);
        }
        guides += `<polyline class="desk-sphere-guide${ring === 0 ? " is-core" : ""}" points="${pts.join(" ")}" />`;
      }

      let lines = "";
      deskGraphState.edges.forEach((e) => {
        const a = projected[e.from], b = projected[e.to];
        if (!a || !b) return;
        const hot = selectedId && (e.from === selectedId || e.to === selectedId);
        const wt = Number(e.weight) || 1;
        const strong = e.rel === "supports" || e.rel === "investigates";
        const soft = e.rel === "related" || e.rel === "uses_channel";
        let stroke = dark ? "rgba(45,212,191,0.22)" : "rgba(201,162,74,0.22)";
        if (e.rel === "supports") stroke = hot ? (dark ? "#5eead4" : "#111") : (dark ? "rgba(148,163,184,0.45)" : "rgba(17,17,17,0.35)");
        else if (e.rel === "contests") stroke = hot ? (dark ? "#f87171" : "#111") : (dark ? "rgba(248,113,113,0.35)" : "rgba(17,17,17,0.22)");
        else if (e.rel === "related") stroke = hot ? (dark ? "#94a3b8" : "#555") : (dark ? "rgba(148,163,184,0.28)" : "rgba(17,17,17,0.18)");
        else if (e.rel === "investigates") stroke = hot ? (dark ? "#38bdf8" : "#333") : (dark ? "rgba(56,189,248,0.3)" : "rgba(17,17,17,0.2)");
        else if (hot) stroke = dark ? "#5eead4" : "#111";
        const width = hot ? Math.min(3.2, 1.4 + wt * 0.25) : Math.min(2.2, 0.55 + wt * 0.18);
        const dash = soft && !hot ? "4 5" : (strong ? "none" : "2 4");
        const eid = escapeHtml(e.id || `${e.from}_${e.to}`);
        lines += `<line class="desk-edge-hit" data-edge="${eid}" data-from="${escapeHtml(e.from)}" data-to="${escapeHtml(e.to)}"
          x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"
          stroke="transparent" stroke-width="14" opacity="1" />`;
        lines += `<line class="desk-edge" data-edge="${eid}" data-from="${escapeHtml(e.from)}" data-to="${escapeHtml(e.to)}"
          x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"
          stroke="${stroke}" stroke-width="${width}" opacity="${hot ? 0.95 : 0.75}"
          stroke-dasharray="${dash}" />`;
      });

      let points = "";
      let floatLabel = "";
      const coreDot = dark ? "#0a0e14" : "#fff";
      ordered.forEach((n) => {
        const cat = CAT[n.cat] || CAT.claim;
        const r = (n.type === "desk" ? 10 : n.type === "claim" ? 7.2 : 5.8) * n.s;
        const sel = n.id === selectedId;
        const op = 0.55 + n.s * 0.45;
        let mark = "";
        if (n.type === "desk") {
          const d = r * 1.15;
          mark = `<polygon class="desk-point-core" points="${n.x},${n.y - d} ${n.x + d},${n.y} ${n.x},${n.y + d} ${n.x - d},${n.y}"
            fill="${cat.fill}" opacity="${op}" />
            <circle cx="${n.x}" cy="${n.y}" r="${r * 0.35}" fill="${coreDot}" opacity="0.9" />`;
        } else if (n.cat === "claim-bad") {
          mark = `<rect class="desk-point-core" x="${n.x - r}" y="${n.y - r}" width="${r * 2}" height="${r * 2}" rx="2"
            transform="rotate(45 ${n.x} ${n.y})" fill="${cat.fill}" opacity="${op}" />`;
        } else {
          mark = `<circle class="desk-point-core" cx="${n.x}" cy="${n.y}" r="${r}" fill="${cat.fill}" opacity="${op}" />
            <circle cx="${n.x}" cy="${n.y}" r="${Math.max(1.4, r * 0.28)}" fill="${coreDot}" opacity="0.7" />`;
        }
        points += `<g class="desk-point" data-id="${escapeHtml(n.id)}" data-cat="${escapeHtml(n.cat)}">
          ${sel ? `<circle cx="${n.x}" cy="${n.y}" r="${r + 10}" class="desk-point-ring" stroke="${cat.fill}" />` : ""}
          <circle cx="${n.x}" cy="${n.y}" r="${r + 14}" fill="transparent" />
          <circle cx="${n.x}" cy="${n.y}" r="${r + 5}" fill="${cat.soft}" opacity="${sel ? 0.45 : 0.18}" />
          ${mark}
        </g>`;
        if (sel) {
          const tip = escapeHtml((n.label || n.type).slice(0, 36));
          const catLab = escapeHtml(cat.label);
          const tw = Math.min(220, Math.max(120, tip.length * 6.4 + 22));
          floatLabel = `<g class="desk-float-label">
            <rect x="${n.x + 16}" y="${n.y - 28}" rx="8" width="${tw}" height="36" />
            <text class="desk-float-cat" x="${n.x + 24}" y="${n.y - 14}">${catLab}</text>
            <text x="${n.x + 24}" y="${n.y + 2}">${tip}</text>
          </g>`;
        }
      });

      const defs = `<defs>
        <filter id="deskGlow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.2" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>`;

      if (!sourcingGraph.querySelector(".desk-scene-svg")) {
        sourcingGraph.innerHTML = `
          <svg class="desk-scene-svg" viewBox="0 0 ${w} ${h}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet"></svg>
          <p class="desk-scene-stats"></p>`;
      }
      const svgEl = sourcingGraph.querySelector(".desk-scene-svg");
      const statsEl = sourcingGraph.querySelector(".desk-scene-stats");
      const claimsN = deskGraphState.nodes.filter((n) => n.type === "claim").length;
      const sourcesN = deskGraphState.nodes.filter((n) => n.type === "source").length;
      svgEl.innerHTML = `${defs}${guides}${lines}${points}${floatLabel}`;
      const linkN = deskGraphState.edges.filter((e) => e.rel === "supports" || e.rel === "related").length;
      if (statsEl) statsEl.textContent = `${claimsN} claims · ${sourcesN} sources · ${linkN} links · scroll zoom · drag spin`;
      if (insightMeta) insightMeta.textContent = `${claimsN} ↔ ${sourcesN} · ${linkN} scored links`;
      syncZoomLabel();
      svgEl.querySelectorAll(".desk-point").forEach((g) => {
        g.addEventListener("click", (ev) => {
          ev.stopPropagation();
          deskGraphState.auto = false;
          const id = g.getAttribute("data-id");
          openDeskDetail(deskGraphState.nodes.find((n) => n.id === id), deskGraphState.judgements);
        });
      });
      svgEl.querySelectorAll(".desk-edge-hit, .desk-edge").forEach((ln) => {
        ln.style.cursor = "pointer";
        ln.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const from = deskGraphState.nodes.find((n) => n.id === ln.dataset.from);
          const to = deskGraphState.nodes.find((n) => n.id === ln.dataset.to);
          const edge = deskGraphState.edges.find((e) =>
            (e.from === ln.dataset.from && e.to === ln.dataset.to) ||
            (e.id && e.id === ln.dataset.edge)
          );
          if (from && to) openDeskEdgeDetail(from, to, edge || { from: ln.dataset.from, to: ln.dataset.to, rel: "related" });
        });
      });
    }

    function setDeskZoom(next) {
      deskGraphState.zoom = Math.max(0.65, Math.min(2.4, next));
      deskGraphState.auto = false;
      syncZoomLabel();
      deskGraphState._paint?.();
    }

    paint();
    deskGraphState._paint = paint;
    syncZoomLabel();

    if (!sourcingGraph.dataset.orbitBound) {
      sourcingGraph.dataset.orbitBound = "1";
      let dragging = false, lx = 0, ly = 0;
      sourcingGraph.addEventListener("pointerdown", (e) => {
        if (e.target.closest?.(".desk-point")) return;
        dragging = true;
        deskGraphState.auto = false;
        lx = e.clientX; ly = e.clientY;
        sourcingGraph.classList.add("is-dragging");
      });
      window.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        deskGraphState.yaw += (e.clientX - lx) * 0.008;
        deskGraphState.pitch = Math.max(-0.6, Math.min(0.9, deskGraphState.pitch + (e.clientY - ly) * 0.006));
        lx = e.clientX; ly = e.clientY;
        deskGraphState._paint?.();
      });
      window.addEventListener("pointerup", () => {
        dragging = false;
        sourcingGraph.classList.remove("is-dragging");
      });
      sourcingGraph.addEventListener("wheel", (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.08 : 0.08;
        setDeskZoom((deskGraphState.zoom || 1) + delta);
      }, { passive: false });
      document.getElementById("btnDeskZoomIn")?.addEventListener("click", () => setDeskZoom((deskGraphState.zoom || 1) + 0.15));
      document.getElementById("btnDeskZoomOut")?.addEventListener("click", () => setDeskZoom((deskGraphState.zoom || 1) - 0.15));
      document.getElementById("btnDeskZoomReset")?.addEventListener("click", () => {
        deskGraphState.yaw = 0.4;
        deskGraphState.pitch = 0.35;
        setDeskZoom(1.15);
        deskGraphState.auto = true;
      });
      const tick = () => {
        if (deskGraphState.auto && deskGraphState.nodes.length && deskGraphState._paint) {
          deskGraphState.yaw += 0.0035;
          deskGraphState._paint();
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }
  document.getElementById("btnCloseDeskDetail")?.addEventListener("click", () => {
    const panel = document.getElementById("deskDetail");
    if (panel) panel.hidden = true;
    deskGraphState.selectedId = null;
    deskGraphState._paint?.();
  });
  document.querySelectorAll("[data-plane-chip]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const plane = btn.getAttribute("data-plane-chip");
      if (plane) openModelMenu(plane);
    });
  });

  function syncDeskTrailUi() {
    const btn = document.getElementById("btnDeskTrail");
    const lab = document.getElementById("deskTrailLabel");
    if (lab) lab.textContent = deskTrail ? "On" : "Off";
    if (btn) {
      btn.classList.toggle("is-on", !!deskTrail);
      btn.setAttribute("aria-pressed", deskTrail ? "true" : "false");
    }
  }
  document.getElementById("btnDeskTrail")?.addEventListener("click", () => {
    deskTrail = !deskTrail;
    saveState();
    syncDeskTrailUi();
    // Refresh open detail so trail show/hide updates immediately
    if (deskGraphState.selectedId) {
      const n = deskGraphState.nodes.find((x) => x.id === deskGraphState.selectedId);
      if (n) openDeskDetail(n, deskGraphState.judgements);
    }
    if (insightMeta && deskTrail) {
      insightMeta.textContent = "Trail on — next Desk run will include step-by-step paths.";
    }
  });
  syncDeskTrailUi();
  document.getElementById("btnDeskToCanvas")?.addEventListener("click", () => pushDeskToCanvas());

  function renderSources(sources) {
    if (!sourceList || !featOn("featSources")) return;
    sourceList.innerHTML = "";
    const cleaned = (sources || []).filter((s) => {
      const label = String(s.channel || s.source || s.kind || "").toLowerCase();
      const url = String(s.url || "");
      if (label === "noeti" && !/^https?:\/\//i.test(url)) return false;
      return true;
    });
    if (!cleaned.length) {
      sourceList.innerHTML = '<li class="dim">No sources</li>';
      return;
    }
    for (const s of cleaned) {
      const li = document.createElement("li");
      const title = s.title || "Source";
      const label = s.channel || s.source || s.kind || "source";
      const url = (s.url || "").trim();
      const real = /^https?:\/\//i.test(url) && !/noeticompute\.com\/\?wire=/i.test(url);
      if (real) {
        li.innerHTML = `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(title)}</span></a>`;
      } else {
        li.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(title)}</span>`;
      }
      sourceList.appendChild(li);
    }
  }

  function plainClaimText(c) {
    const raw = typeof c === "string" ? c : (c?.claim || c?.text || "");
    return String(raw)
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1")
      .replace(/^\s*-{3,}\s*$/gm, "")
      .replace(/\*{1,3}/g, "")
      .trim();
  }

  function plainReasonText(s) {
    let t = String(s || "")
      .replace(/\*{1,3}/g, "")
      .replace(/_{1,3}/g, "")
      .replace(/`+/g, "")
      .replace(/^#+\s*/gm, "")
      .replace(/\s+/g, " ")
      .trim();
    t = t.replace(/^(verdict|reason)\s*[:\-–]\s*/gi, "");
    t = t.replace(/\b(verdict|reason)\s*[:\-–]\s*/gi, "");
    t = t.replace(/^(supported|contested|unknown)\s*[.\-:]?\s*/i, "");
    const dangling = /[-—–]$/.test(t);
    if (dangling || (t.length > 120 && !/[.!?]$/.test(t))) {
      const m = t.match(/^([\s\S]{40,}?[.!?])/);
      if (m) t = m[1].trim();
      else if (dangling) {
        t = t.replace(/\s+\S*[-—–]?$/, "").replace(/[,;:*-—–\s]+$/, "").trim();
        if (t && !/[.!?]$/.test(t)) t += "…";
      } else if (t && !/[.!?]$/.test(t)) {
        t = t.replace(/[,;:\s]+$/, "") + "…";
      }
    }
    return t.trim();
  }

  function renderClaims(claims) {
    if (!claimList) return;
    claimList.innerHTML = "";
    const rows = (claims || [])
      .map((c) => plainClaimText(c))
      .filter((t) => t && t.length >= 12 && t.length <= 280)
      .slice(0, 8);
    if (!rows.length) {
      claimList.innerHTML = '<li class="dim">None yet</li>';
      return;
    }
    for (const t of rows) {
      const li = document.createElement("li");
      li.textContent = t;
      claimList.appendChild(li);
    }
  }

  function renderActivity(rows) {
    if (!railActivityBlock || !railActivity) return;
    railActivityBlock.hidden = true; // scene-first Desk — no text feed
    if (!rows?.length) return;
    railActivity.innerHTML = rows.map((row, i) => `<li class="wf-act wf-act-${escapeHtml(row.stage || "step")}">
      <header><strong>${escapeHtml(row.actor)}</strong></header>
      <p>${escapeHtml(row.did)}</p>
    </li>`).join("");
  }

  function renderJudgeRail(judgements) {
    if (!railJudgesBlock || !railJudges) return;
    railJudgesBlock.hidden = true; // votes live in point detail panel
    if (!judgements?.length) return;
    railJudges.innerHTML = "";
  }

  function renderPacket(payload) {
    if (!railPacketBlock || !railPacket) return;
    railPacketBlock.hidden = true;
    const pp = payload?.proofpath || (payload?.run_id ? payload : null);
    if (!pp?.run_id) {
      railPacket.innerHTML = "";
      return;
    }
    const q = pp.quality || payload?.summary?.quality || {};
    const gate = pp.summary?.publish_gate || payload?.summary?.publish_gate || "review";
    const digest = (pp.integrity?.digest || "").slice(0, 22);
    railPacket.innerHTML = `
      <div class="pp-id"><code>${escapeHtml(pp.run_id)}</code></div>
      <div class="pp-meta">
        <span class="pp-badge ${escapeHtml(q.tier || "draft")}">${escapeHtml(q.tier || "draft")}</span>
        <span class="pp-route">${escapeHtml(pp.routing || payload?.routing || "public_search")}</span>
        <span class="gate ${gate === "ready" ? "ok" : gate === "blocked" ? "blocked" : ""}">${escapeHtml(gate)}</span>
      </div>
      <p class="pp-label">${escapeHtml(q.label || "Draft ProofPath packet")}</p>
      ${digest ? `<p class="pp-digest"><span>Integrity</span> ${escapeHtml(digest)}…</p>` : ""}
      <div class="pp-actions">
        <button type="button" class="btn-chip" data-pp="copy">Copy link</button>
        <button type="button" class="btn-chip" data-pp="json">Export JSON</button>
        <button type="button" class="btn-chip" data-pp="txt">Export TXT</button>
        <button type="button" class="btn-chip" data-pp="desk">Save to Desk</button>
        <a class="btn-chip" href="/desk" target="_blank" rel="noopener">Open Desk</a>
        <button type="button" class="btn-chip" data-pp="canvas">Open in Canvas</button>
      </div>`;
    railPacket.querySelectorAll("[data-pp]").forEach((btn) => {
      btn.addEventListener("click", () => handlePacketAction(btn.dataset.pp, pp));
    });
  }

  function pushDeskToCanvas(extra = {}) {
    const chat = activeChat();
    const payload = chat?.lastPayload || {};
    const q = extra.query || payload.query || chat?.messages?.filter((m) => m.role === "user").slice(-1)[0]?.content || "";
    const reply = extra.reply || chat?.messages?.filter((m) => m.role === "assistant").slice(-1)[0]?.content || "";
    try {
      localStorage.setItem("noeti_canvas_desk_import", JSON.stringify({
        query: String(q).slice(0, 600),
        reply: String(reply).slice(0, 6000),
        claims: payload.claims || [],
        judgements: payload.judgements || [],
        summary: payload.summary || {},
        sources: (payload.sources || []).slice(0, 12),
        worker_model: payload.worker_model || currentModel || "",
        run_id: payload.run_id || payload.proofpath?.run_id || extra.run_id || "",
        at: Date.now(),
      }));
    } catch (_) {}
    window.location.href = "/canvas";
  }

  async function handlePacketAction(action, pp) {
    if (action === "canvas") {
      pushDeskToCanvas({ run_id: pp?.run_id });
      return;
    }
    const rid = pp?.run_id;
    if (!rid) return;
    const share = `${location.origin}/api/proofpath/runs/${rid}`;
    if (action === "copy") {
      try { await navigator.clipboard.writeText(share); } catch (_) { /* ignore */ }
      return;
    }
    if (action === "json" || action === "txt") {
      const url = `/api/proofpath/runs/${encodeURIComponent(rid)}/export?format=${action}`;
      if (action === "txt") {
        window.open(url, "_blank");
        return;
      }
      try {
        const res = await fetch(url);
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data.trail || data, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `proofpath-${rid}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (_) { /* ignore */ }
      return;
    }
    if (action === "desk") {
      try {
        const res = await fetch("/api/desk/from-run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ run_id: rid }),
        });
        const data = await res.json();
        if (composerNote) {
          if (data.ok) composerNote.textContent = `Saved to Desk · ${data.project?.id || ""}`;
          else if (res.status === 401) composerNote.textContent = "Sign in at /desk to save this run";
          else composerNote.textContent = data.message || "Could not save to Desk";
          setTimeout(() => syncPrivateNote(), 2800);
        }
      } catch (_) {
        if (composerNote) composerNote.textContent = "Could not reach Desk";
      }
    }
  }

  function updateRail(payload) {
    updatePlaneLabels();
    if (payload?.desk_planes) {
      const railMap = {
        checker: document.getElementById("railPlaneChecker"),
        validator: document.getElementById("railPlaneValidator"),
        watcher: document.getElementById("railPlaneWatcher"),
      };
      for (const role of ["checker", "validator", "watcher"]) {
        const id = payload.desk_planes[role] || witnessModels[role];
        if (railMap[role]) railMap[role].textContent = id || "—";
      }
    }
    renderPacket(payload);
    // Prefer real web sourcing graph over reply metric bars
    if (payload?.graph?.nodes?.length) {
      renderSourcingGraph(payload.graph, payload.judgements, {
        activity: payload.activity,
        summary: payload.summary,
        explain: payload.explain,
      });
    } else if (payload?.insights?.bars?.length && !payload?.judgements) renderChart(payload.insights);
    else if (payload?.graph) {
      renderSourcingGraph(payload.graph, payload.judgements, {
        activity: payload.activity,
        summary: payload.summary,
        explain: payload.explain,
      });
    }
    else if (payload?.insights) renderChart(payload.insights);
    renderSources(payload?.sources);
    // Prefer atomized claims — never dump a whole recipe via claim_candidates
    const atoms = payload?.claims;
    if (Array.isArray(atoms) && atoms.length) renderClaims(atoms);
    else renderClaims([]);
    renderActivity(payload?.activity);
    renderJudgeRail(payload?.judgements);
    if (railGate) {
      if (payload?.summary) {
        const q = payload.summary.quality || payload.proofpath?.quality || {};
        railGate.textContent = String(payload.summary.publish_gate || "review").toUpperCase();
        railGate.className = "gate " + (payload.summary.publish_gate === "ready" ? "ok" : payload.summary.publish_gate === "blocked" ? "blocked" : "");
        railGate.title = q.label || `supported ${payload.summary.supported} · contested ${payload.summary.contested}`;
        if (railQuality) {
          railQuality.hidden = !q.label;
          railQuality.textContent = q.label || "";
        }
      } else {
        railGate.textContent = "Waiting…";
        railGate.className = "gate";
        railGate.title = "";
      }
    }
    applyModuleVisibility();
  }

  function setDeskPending(query) {
    maybeOpenRail();
    startDeskProgress();
    if (insightMeta) insightMeta.textContent = "Searching the web · planes running…";
    if (sourceList) sourceList.innerHTML = '<li class="dim">Searching…</li>';
    if (claimList) claimList.innerHTML = '<li class="dim">Atomizing…</li>';
    if (railActivity) railActivity.innerHTML = '<li class="dim">Desk running…</li>';
    if (railJudges) railJudges.innerHTML = '<p class="dim">Planes running…</p>';
    if (railGate) {
      railGate.textContent = "Running…";
      railGate.className = "gate";
    }
    if (railPacket) railPacket.innerHTML = '<p class="dim">Building ProofPath…</p>';
    if (sourcingGraph) {
      sourcingGraph.hidden = false;
      sourcingGraph.innerHTML = `<div class="desk-scene-empty">
        <p>Mapping “${escapeHtml((query || "").slice(0, 72))}”</p>
        <span>Web search + Checker / Validator / Watcher</span>
      </div>`;
    }
    if (chartEl) chartEl.hidden = true;
    const detail = document.getElementById("deskDetail");
    if (detail) detail.hidden = true;
  }

  async function runDeskWitness(query, reply, basePayload) {
    updatePlaneLabels();
    const qRaw = String(query || "").trim();
    const rRaw = String(reply || "").trim();
    const searchQ = (qRaw.length >= 12 ? qRaw : (rRaw.slice(0, 400) || qRaw || "desk verify sources")).trim();
    setDeskPending(searchQ);
    const privDesk = !!setPrivateRoute?.checked;
    setArchStages({
      ask: "done", model: "done",
      search: privDesk ? "skip" : "run",
      checker: "idle", validator: "idle", watcher: "idle", gate: "idle", seal: "idle",
    }, privDesk ? "Private local" : "Public");
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => ctrl?.abort(), 42000);
    try {
      const res = await fetch("/api/workflow/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        signal: ctrl?.signal,
        body: JSON.stringify({
          query: searchQ,
          context: rRaw.slice(0, 4000),
          judges: ["checker", "validator", "watcher"],
          models: { ...witnessModels },
          explain: !!deskTrail,
          // Always search the public web for Desk — private routing is chat-only
          private: false,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        const msg = data.message || (res.status === 504 ? "Desk timed out" : "Desk witness failed");
        if (insightMeta) insightMeta.textContent = msg;
        finishDeskProgress(false);
        if (sourcingGraph) {
          sourcingGraph.innerHTML = `<div class="desk-scene-empty">
            <p>No map yet</p>
            <span>${escapeHtml(msg)}. Try again, or pick faster Desk models.</span>
          </div>`;
        }
        return null;
      }
      const merged = {
        ...(basePayload || {}),
        ...data,
        insights: data.insights || basePayload?.insights,
        // Prefer real web sources from Desk search
        sources: (data.sources && data.sources.length) ? data.sources : (basePayload?.sources || []),
        graph: data.graph,
        claims: data.claims,
        judgements: data.judgements,
        activity: data.activity,
        summary: data.summary,
        proofpath: data.proofpath,
        run_id: data.run_id,
      };
      finishDeskProgress(true);
      updateRail(merged);
      maybeOpenRail();
      setArchStages({
        ask: "done", model: "done",
        search: (merged.sources || []).length ? "done" : (setPrivateRoute?.checked ? "skip" : "done"),
        checker: "done", validator: "done", watcher: "done",
        gate: "done", seal: merged.proofpath || merged.run_id ? "done" : "run",
      }, setPrivateRoute?.checked ? "Private local" : "Public");
      try {
        localStorage.setItem("noeti_canvas_desk_import", JSON.stringify({
          query: searchQ,
          reply: rRaw.slice(0, 6000),
          claims: merged.claims || [],
          judgements: merged.judgements || [],
          summary: merged.summary || {},
          sources: (merged.sources || []).slice(0, 12),
          worker_model: merged.worker_model || basePayload?.model || "",
          run_id: merged.run_id || merged.proofpath?.run_id || "",
          at: Date.now(),
        }));
      } catch (_) {}
      const chat = activeChat();
      if (chat) {
        chat.lastPayload = merged;
        chat.lastSources = merged.sources;
        chat.lastRunId = data.run_id || data.proofpath?.run_id;
        chat.updated = Date.now();
        saveState();
      }
      if (insightMeta) {
        const n = (merged.sources || []).length;
        const timed = (data.judgements || []).some((row) =>
          (row.judges || []).some((j) => j.error === "timeout")
        );
        insightMeta.textContent = n
          ? `Web search · ${n} source(s) · gate ${data.summary?.publish_gate || "review"} · ${data.latency_ms || "?"}ms${timed ? " · some judges timed out" : ""}`
          : `No sources found · gate ${data.summary?.publish_gate || "review"} · try a clearer ask`;
      }
      if (!(merged.sources || []).length && sourcingGraph && !merged.graph?.nodes?.length) {
        sourcingGraph.innerHTML = `<div class="desk-scene-empty">
          <p>No sources</p>
          <span>Search returned nothing for this ask. Try more specific wording.</span>
        </div>`;
      }
      return data;
    } catch (err) {
      const msg = err?.name === "AbortError" ? "Desk timed out — pick faster Checker/Validator/Watcher models." : String(err.message || err);
      finishDeskProgress(false);
      if (insightMeta) insightMeta.textContent = msg;
      if (sourcingGraph) {
        sourcingGraph.innerHTML = `<div class="desk-scene-empty">
          <p>Desk stalled</p>
          <span>${escapeHtml(msg)}</span>
        </div>`;
      }
      if (sourceList) sourceList.innerHTML = `<li class="dim">${escapeHtml(msg)}</li>`;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }


  let deskProgressTimer = null;
  let deskProgressIdx = 0;
  const DESK_PROGRESS_LABELS = {
    search: "Searching the web…",
    atomize: "Splitting claims…",
    graph: "Linking claims ↔ sources…",
    judges: "Checker · Validator · Watcher…",
    gate: "Publish gate…",
  };

  function startDeskProgress() {
    const wrap = document.getElementById("deskProgress");
    const bar = document.getElementById("deskProgressBar");
    const track = document.getElementById("deskProgressTrack");
    const label = document.getElementById("deskProgressLabel");
    const stages = document.getElementById("deskProgressStages");
    if (!wrap || !bar) return;
    wrap.hidden = false;
    deskProgressIdx = 0;
    clearInterval(deskProgressTimer);
    const paint = () => {
      const stage = STAGE_ORDER[Math.min(deskProgressIdx, STAGE_ORDER.length - 1)];
      const pct = Math.min(92, 8 + deskProgressIdx * 18 + (deskProgressIdx > 0 ? 6 : 0));
      bar.style.width = pct + "%";
      if (track) track.setAttribute("aria-valuenow", String(pct));
      if (label) label.textContent = DESK_PROGRESS_LABELS[stage] || "Working…";
      if (stages) {
        [...stages.querySelectorAll("li")].forEach((li, i) => {
          li.classList.toggle("is-done", i < deskProgressIdx);
          li.classList.toggle("is-active", i === deskProgressIdx);
        });
      }
    };
    paint();
    deskProgressTimer = setInterval(() => {
      if (deskProgressIdx < STAGE_ORDER.length - 1) deskProgressIdx += 1;
      paint();
    }, 1400);
  }

  function finishDeskProgress(ok = true) {
    const wrap = document.getElementById("deskProgress");
    const bar = document.getElementById("deskProgressBar");
    const track = document.getElementById("deskProgressTrack");
    const label = document.getElementById("deskProgressLabel");
    const stages = document.getElementById("deskProgressStages");
    clearInterval(deskProgressTimer);
    deskProgressTimer = null;
    if (bar) bar.style.width = "100%";
    if (track) track.setAttribute("aria-valuenow", "100");
    if (stages) {
      [...stages.querySelectorAll("li")].forEach((li) => {
        li.classList.add("is-done");
        li.classList.remove("is-active");
      });
    }
    if (label) label.textContent = ok ? "Map ready" : "Stopped";
    if (wrap) {
      setTimeout(() => { wrap.hidden = true; }, ok ? 450 : 900);
    }
  }

  function maybeOpenRail() {
    // On phones, keep chat first — don't bury the thread under Desk
    if (window.matchMedia("(max-width: 820px)").matches) return;
    if (setAutoRail?.checked !== false) app.classList.add("rail-open");
  }

  function workflowSummaryText(data) {
    const gate = data.summary?.publish_gate || "review";
    const q = data.summary?.quality || data.proofpath?.quality || {};
    const n = (data.sources || []).length;
    const claims = (data.claims || []).length;
    const judges = selectedRoles().length;
    const rid = data.run_id || data.proofpath?.run_id || "";
    let out = `**ProofPath** · gate **${gate}** · ${q.tier || "draft"} · ${claims} claim(s) · ${n} source(s) · ${judges} judges · ${data.latency_ms}ms\n`;
    if (rid) out += `Run \`${rid}\`\n`;
    if (q.label) out += `\n_${q.label}_\n`;
    out += "\n";
    (data.judgements || []).forEach((row, i) => {
      out += `${i + 1}. ${row.claim}\n   → ${row.aggregate?.final_verdict || "unknown"}`;
      (row.judges || []).forEach((j) => {
        const saw = j.saw?.source_count != null ? ` (saw ${j.saw.source_count})` : "";
        out += `\n   · ${j.label}: ${j.verdict}${saw}`;
      });
      out += "\n\n";
    });
    if (data.sources?.length) {
      out += "Sources:\n";
      data.sources.slice(0, 5).forEach((s) => {
        const url = (s.url || "").trim();
        const real = /^https?:\/\//i.test(url) && !/noeticompute\.com\/\?wire=/i.test(url);
        out += real
          ? `· ${s.title || url} — ${url}\n`
          : `· ${s.title || "Source"} (${s.source || s.channel || "wire"})\n`;
      });
    }
    return out.trim();
  }

  function appendBubble(role, text, meta, extras = {}) {
    setEmptyVisible(false);
    const row = document.createElement("div");
    row.className = `msg ${role}` + (extras.workflow ? " msg-workflow" : "");
    const avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    avatar.textContent = role === "user" ? "You" : "N";
    const body = document.createElement("div");
    body.className = "msg-body";
    const content = document.createElement("div");
    content.className = "msg-content";
    if (extras.thinking) {
      content.classList.add("thinking");
      content.textContent = text;
    } else {
      content.innerHTML = formatContent(text);
    }
    body.appendChild(content);
    if (role === "assistant" && !extras.thinking) {
      content.classList.add("prov-ready");
      const hint = document.createElement("p");
      hint.className = "prov-hint";
      hint.textContent = "Tap any sentence for source + reason";
      body.appendChild(hint);
    }
    if (extras.workflowCard && featOn("featInlineCards")) body.appendChild(extras.workflowCard);
    // Source chips removed from the bubble — they were repeating "NOETI" stubs.
    if (meta || featOn("featTimestamps")) {
      const m = document.createElement("div");
      m.className = "msg-meta" + (featOn("featCompactMeta") ? " compact" : "");
      const bits = [];
      if (meta) bits.push(meta);
      if (featOn("featTimestamps")) bits.push(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      m.textContent = bits.join(" · ");
      body.appendChild(m);
    }
    row.appendChild(avatar);
    row.appendChild(body);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return row;
  }

  function buildWorkflowCard(data) {
    const wrap = document.createElement("div");
    wrap.className = "wf-inline pp-card";
    const gate = data.summary?.publish_gate || "review";
    const q = data.summary?.quality || data.proofpath?.quality || {};
    const rid = data.run_id || data.proofpath?.run_id || "";
    wrap.innerHTML = `
      <div class="pp-card-top">
        <div class="gate ${gate === "ready" ? "ok" : gate === "blocked" ? "blocked" : ""}">Gate: ${escapeHtml(gate)}</div>
        <span class="pp-badge ${escapeHtml(q.tier || "draft")}">${escapeHtml(q.tier || "draft")}</span>
      </div>
      ${rid ? `<div class="pp-id"><code>${escapeHtml(rid)}</code></div>` : ""}
      ${q.label ? `<p class="pp-label">${escapeHtml(q.label)}</p>` : ""}`;
    const act = document.createElement("div");
    act.className = "wf-inline-acts";
    (data.activity || []).slice(0, 8).forEach((row) => {
      const p = document.createElement("p");
      const saw = row.saw?.source_count != null ? ` · saw ${row.saw.source_count}` : "";
      p.innerHTML = `<strong>${escapeHtml(row.actor)}</strong> ${escapeHtml(row.did)}${escapeHtml(saw)}
        ${row.verdict ? `<span class="wf-verdict ${escapeHtml(row.verdict)}">${escapeHtml(row.verdict)}</span>` : ""}`;
      act.appendChild(p);
    });
    wrap.appendChild(act);
    if (rid) {
      const actions = document.createElement("div");
      actions.className = "pp-actions";
      actions.innerHTML = `
        <button type="button" class="btn-chip" data-pp="copy">Copy link</button>
        <button type="button" class="btn-chip" data-pp="json">Export JSON</button>
        <button type="button" class="btn-chip" data-pp="txt">Export TXT</button>
        <button type="button" class="btn-chip" data-pp="desk">Save to Desk</button>`;
      actions.querySelectorAll("[data-pp]").forEach((btn) => {
        btn.addEventListener("click", () => handlePacketAction(btn.dataset.pp, data.proofpath || data));
      });
      wrap.appendChild(actions);
    }
    return wrap;
  }

  function renderSidebar(filter = "") {
    ensureChats();
    chatList.innerHTML = "";
    const q = filter.trim().toLowerCase();
    const sorted = [...state.chats]
      .filter((c) => !q || (c.title || "").toLowerCase().includes(q) || (c.messages || []).some((m) => (m.content || "").toLowerCase().includes(q)))
      .sort((a, b) => (b.updated || 0) - (a.updated || 0));
    for (const c of sorted) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chat-item" + (c.id === activeId ? " active" : "");
      const badge = c.kind === "newsroom" ? '<em class="chat-kind">desk</em>' : "";
      btn.innerHTML = `<span>${escapeHtml(c.title || "New chat")}</span>${badge}`;
      btn.addEventListener("click", () => {
        activeId = c.id;
        if (c.model) currentModel = c.model;
        if (c.kind === "newsroom") setMode("newsroom");
        updateModelLabel();
        saveState();
        renderSidebar(chatSearch?.value || "");
        renderMessages();
        if (c.lastPayload) updateRail(c.lastPayload);
        else if (c.lastInsights) updateRail({ insights: c.lastInsights, sources: c.lastSources });
        sidebar.classList.remove("open");
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "chat-item-del";
      del.textContent = "×";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        state.chats = state.chats.filter((x) => x.id !== c.id);
        if (activeId === c.id) activeId = state.chats[0]?.id || null;
        saveState();
        renderSidebar(chatSearch?.value || "");
        renderMessages();
      });
      btn.appendChild(del);
      chatList.appendChild(btn);
    }
  }

  function renderMessages() {
    const chat = activeChat();
    log.innerHTML = "";
    if (!chat || !chat.messages?.length) { setEmptyVisible(true); return; }
    setEmptyVisible(false);
    for (const m of chat.messages) {
      const extras = { sources: m.sources, workflow: m.kind === "newsroom" };
      if (m.workflowData) extras.workflowCard = buildWorkflowCard(m.workflowData);
      appendBubble(m.role, m.content, m.meta, extras);
    }
  }

  function updateModelLabel() {
    const m = models.find((x) => x.id === currentModel);
    if (modelLabel) modelLabel.textContent = m ? m.name : currentModel;
    updatePlaneLabels();
  }

  let modelFilter = "all";
  let modelQuery = "";

  function filteredModels() {
    const showPaid = document.getElementById("setShowPaid")?.checked !== false;
    return models.filter((m) => {
      const dep = m.deployment || (m.paid ? "centralized" : "decentralized");
      if (dep === "centralized" && !showPaid && modelFilter !== "centralized" && modelFilter !== "paid") return false;
      if (modelFilter === "decentralized" && dep !== "decentralized") return false;
      if (modelFilter === "centralized" || modelFilter === "paid") {
        if (dep !== "centralized" && !m.paid) return false;
      }
      if (modelFilter === "free" && m.paid && !m.free_route) return false;
      if (modelFilter === "node" && !m.on_node) return false;
      if (modelFilter === "fast" && m.tier !== "fast") return false;
      if (modelFilter === "flagship" && m.tier !== "flagship") return false;
      if (modelFilter === "strong" && m.tier !== "strong" && m.tier !== "balanced") return false;
      if (modelQuery) {
        const q = modelQuery.toLowerCase();
        const blob = `${m.name} ${m.family} ${m.id} ${m.desc || ""} ${m.deployment_label || ""}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }

  function renderModelMenu() {
    const list = document.getElementById("modelMenuList") || modelMenu;
    list.innerHTML = "";
    const selectedId = pickingSlot === "chat" ? currentModel : witnessModels[pickingSlot];
    const groups = {};
    for (const m of filteredModels()) (groups[m.family] ||= []).push(m);
    const families = Object.keys(groups);
    if (!families.length) {
      list.innerHTML = '<p class="dim" style="padding:0.75rem">No models match.</p>';
      return;
    }
    for (const family of families) {
      const head = document.createElement("div");
      head.className = "model-group";
      head.textContent = family;
      list.appendChild(head);
      for (const m of groups[family]) {
        const opt = document.createElement("button");
        opt.type = "button";
        const locked = !!m.locked;
        const dep = m.deployment || (m.paid ? "centralized" : "decentralized");
        const indep = dep === "decentralized";
        opt.className = "model-option" + (m.id === selectedId ? " selected" : "") + (locked ? " locked" : "") + (m.paid ? " paid" : "") + (indep ? " decentralized" : " centralized");
        const routeTag = locked
          ? "<em class='dim'>needs network key</em>"
          : m.on_node
          ? "<em class='ok'>on node</em>"
          : indep
          ? "<em class='ok'>Decentralized</em>"
          : "<em class='paid'>Centralized · paid</em>";
        const card = m.card || {};
        const cardBits = [];
        if (card.context_length) cardBits.push(`${Math.round(Number(card.context_length) / 1000)}k ctx`);
        if (card.can_self_host) cardBits.push("self-host");
        if (card.free_route) cardBits.push("free");
        else if (card.paid || m.paid) cardBits.push("paid");
        if (card.on_node || m.on_node) cardBits.push("on node");
        const cardLine = cardBits.length
          ? `<small class="model-card-line">${escapeHtml(cardBits.join(" · "))}</small>`
          : "";
        opt.innerHTML = `<div class="model-option-main"><strong>${escapeHtml(m.name)}</strong><span>${escapeHtml(m.desc || m.deployment_label || "")}</span>${cardLine}</div>
          <div class="model-option-tags"><em class="tier-${escapeHtml(m.tier)}">${escapeHtml(m.tier)}</em>${routeTag}</div>`;
        if (typeof window.__noetiEnhanceModelOption === "function") {
          try { window.__noetiEnhanceModelOption(m, opt); } catch (_) { /* ignore */ }
        }
        opt.addEventListener("click", () => {
          if (pickingSlot === "chat") {
            currentModel = m.id;
            const chat = activeChat();
            if (chat) chat.model = currentModel;
          } else if (pickingSlot in witnessModels) {
            witnessModels[pickingSlot] = m.id;
          }
          updateModelLabel();
          saveState();
          closeAllMenus();
          if (pickingSlot === "chat") showModelCardPop(m);
          pickingSlot = "chat";
          updatePlaneLabels();
          if (locked) {
            const note = document.querySelector(".composer-note");
            if (note) note.textContent = `${m.name} needs a network catalog key — set it in Admin`;
          }
        });
        list.appendChild(opt);
      }
    }
  }

  function newChat() {
    ensureChats();
    const id = uid();
    state.chats.unshift({
      id,
      title: "New chat",
      model: currentModel,
      kind: "chat",
      messages: [],
      updated: Date.now(),
    });
    activeId = id; saveState(); renderSidebar(chatSearch?.value || ""); renderMessages(); input.focus();
    sidebar.classList.remove("open");
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 180) + "px";
  }

  function renderSuggests() {
    if (!suggestGrid) return;
    suggestGrid.innerHTML = "";
    const list = SUGGESTS_CHAT;
    for (const s of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "suggest";
      b.textContent = s;
      b.addEventListener("click", () => sendMessage(s));
      suggestGrid.appendChild(b);
    }
  }

  document.getElementById("emptyStarters")?.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".starter[data-prompt]");
    if (!btn) return;
    const prompt = btn.getAttribute("data-prompt") || "";
    if (!prompt) return;
    input.value = prompt;
    autosize();
    input.focus();
    sendMessage(prompt);
  });

  async function loadModels() {
    const res = await fetch("/api/chat/models", { cache: "no-store" });
    const data = await res.json();
    models = data.models || [];
    currentModel = state.model || data.default || currentModel;
    // Prefer real catalog ids for Desk planes when defaults aren't listed
    const ids = new Set((models || []).map((m) => m.id));
    const fallback = currentModel || data.default || (models[0] && models[0].id);
    const nodePick = (models || []).find((m) => m.on_node)?.id;
    const freePick = (models || []).find((m) => m.free_route || (!m.paid && m.deployment === "decentralized"))?.id;
    const fastPick = (models || []).find((m) =>
      m.on_node || m.free_route || ((m.tier === "fast" || m.speed === "fast") && !m.paid)
    )?.id
      || (models || []).find((m) => /0\.5b|1\.5b|3b|mini|flash|haiku|small/i.test(String(m.id || m.name || "")))?.id
      || freePick
      || nodePick;
    const heavy = (id) => /70b|72b|405b|r1|opus|sonnet|gpt-4(?!o-mini)|claude-3(?!-haiku)/i.test(String(id || ""));
    for (const role of ["checker", "validator", "watcher"]) {
      const cur = witnessModels[role];
      if (!ids.has(cur) || heavy(cur)) {
        witnessModels[role] = fastPick || freePick || nodePick || (heavy(fallback) ? fastPick : fallback) || cur;
      }
    }
    updateModelLabel(); renderModelMenu(); fillCompareModelSelect();
    updatePlaneLabels();
    if (backendPill) {
      const onNode = (models || []).filter((m) => m.on_node).length;
      backendPill.textContent = data.backend === "network" || data.backend === "remote"
        ? `Network · ${models.length}`
        : `Node · ${onNode || models.length}`;
      backendPill.title = `${data.label || "Noeti"} · ${data.decentralized_count || 0} decentralized · ${data.centralized_count || 0} centralized`;
    }
  }

  async function loadJudges() {
    try {
      const res = await fetch("/api/workflow/judges");
      const data = await res.json();
      if (data.ok && data.judges?.length) judgeDefs = data.judges;
    } catch (_) { /* defaults */ }
    renderToggles(judgeDefs);
  }

  async function sendChat(text, chat, thinking) {
    if (typeof window.__noetiStreamSend === "function") {
      try {
        const done = await window.__noetiStreamSend({
          text,
          chat,
          thinking,
          model: currentModel,
          temperature: temperature(),
        });
        if (done?.substituted && done?.substitute_reason) {
          appendBubble("assistant", done.substitute_reason, "note");
        }
        const chatNow = activeChat();
        const lastUser = [...(chatNow?.messages || [])].reverse().find((m) => m.role === "user");
        const lastAsst = [...(chatNow?.messages || [])].reverse().find((m) => m.role === "assistant");
        // Desk runs in background so the reply is usable immediately
        void runDeskWitness(
          lastUser?.content || text,
          lastAsst?.content || done?.reply || "",
          chatNow?.lastPayload || { insights: done?.insights, sources: done?.sources }
        );
        return;
      } catch (err) {
        thinking.querySelector(".msg-content").classList.remove("thinking");
        thinking.querySelector(".msg-content").textContent = String(err.message || err);
        return;
      }
    }
    const payloadMessages = chat.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));
    setArchStages({
      ask: "done", model: "run",
      search: setPrivateRoute?.checked ? "skip" : "idle",
      checker: "idle", validator: "idle", watcher: "idle", gate: "idle", seal: "idle",
    }, setPrivateRoute?.checked ? "Private local" : "Public");
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: payloadMessages,
        model: currentModel,
        temperature: temperature(),
        prefer_local: !!setPrivateRoute?.checked,
        private: !!setPrivateRoute?.checked,
        web_search: !!document.getElementById("toggleWebSearch")?.checked && !setPrivateRoute?.checked,
      }),
    });
    const data = await res.json();
    thinking.remove();
    if (!data.ok) {
      appendBubble("assistant", data.message || "Request failed.", "error");
      return;
    }
    let meta = `${data.label} · ${data.model} · ${data.latency_ms}ms · t=${temperature().toFixed(2)}`;
    if (data.substituted) meta += " · substituted";
    chat.messages.push({ role: "assistant", content: data.reply, meta, sources: data.sources });
    chat.lastSources = data.sources;
    chat.lastInsights = data.insights;
    chat.lastPayload = { insights: data.insights, sources: data.sources };
    chat.updated = Date.now();
    saveState();
    appendBubble("assistant", data.reply, meta, { sources: data.sources });
    void runDeskWitness(text, data.reply, chat.lastPayload);
    if (data.substituted && data.substitute_reason) {
      appendBubble("assistant", data.substitute_reason, "note");
    }
  }

  function showModelCardPop(m) {
    const el = document.getElementById("modelCardPop");
    if (!el || !m) return;
    const card = m.card || {};
    el.hidden = false;
    el.innerHTML = `<strong>${escapeHtml(m.name)}</strong>
      <span>${escapeHtml(m.deployment_label || m.desc || "")}</span>
      <ul>
        <li>Context: ${card.context_length ? Math.round(Number(card.context_length) / 1000) + "k" : "—"}</li>
        <li>${card.can_self_host ? "Can self-host" : "Centralized route"}</li>
        <li>${card.on_node || m.on_node ? "Running on this node" : "Routed"}</li>
        <li>${card.free_route ? "Free route" : (card.paid || m.paid ? "Paid" : "—")}</li>
        <li>Speed: ${escapeHtml(card.speed || m.tier || "—")}</li>
      </ul>`;
  }

  function mergeChats(remoteChats) {
    if (!Array.isArray(remoteChats) || !remoteChats.length) return;
    ensureChats();
    const byId = new Map(state.chats.map((c) => [c.id, c]));
    for (const rc of remoteChats) {
      if (!rc?.id) continue;
      const local = byId.get(rc.id);
      if (!local || (rc.updated || 0) > (local.updated || 0)) {
        byId.set(rc.id, { ...local, ...rc });
      }
    }
    state.chats = [...byId.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0));
    if (!activeId && state.chats.length) activeId = state.chats[0].id;
    saveState();
    renderSidebar(chatSearch?.value || "");
    renderMessages();
  }

  function fillCompareModelSelect() {
    const sel = document.getElementById("compareModelB");
    if (!sel || !models.length) return;
    const keep = sel.value || localStorage.getItem("noeti_compare_b") || "";
    const picks = models.filter((m) => !m.locked).slice(0, 80);
    sel.innerHTML = picks.map((m) =>
      `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`
    ).join("");
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }

  async function sendNewsroom(text, chat, thinking) {
    startLocalAnim();
    const priv = !!setPrivateRoute?.checked;
    thinking.querySelector(".msg-content").textContent = priv
      ? "Private ProofPath · atomize → judges (no public search)…"
      : "Newsroom · search → graph → judges → ProofPath packet…";
    const roles = selectedRoles();
    const res = await fetch("/api/workflow/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: text, judges: roles, private: priv }),
    });
    const data = await res.json();
    stopLocalAnim();
    thinking.remove();
    if (!data.ok) {
      appendBubble("assistant", data.message || "Workflow failed.", "error");
      return;
    }
    const summary = workflowSummaryText(data);
    const qTier = data.summary?.quality?.tier || data.proofpath?.quality?.tier || "draft";
    const meta = `ProofPath · ${data.run_id || "local"} · ${data.worker_model} · ${data.latency_ms}ms · gate ${data.summary.publish_gate} · ${qTier}`;
    const card = buildWorkflowCard(data);
    chat.kind = "newsroom";
    if (!Array.isArray(chat.runHistory)) chat.runHistory = [];
    if (data.run_id) {
      chat.runHistory.unshift({
        run_id: data.run_id,
        at: Date.now(),
        gate: data.summary?.publish_gate,
        query: text.slice(0, 120),
      });
      chat.runHistory = chat.runHistory.slice(0, 20);
      chat.lastRunId = data.run_id;
    }
    chat.messages.push({
      role: "assistant",
      content: summary,
      meta,
      sources: data.sources,
      kind: "newsroom",
      run_id: data.run_id,
      workflowData: {
        summary: data.summary,
        activity: data.activity,
        judgements: data.judgements,
        run_id: data.run_id,
        proofpath: data.proofpath,
        quality: data.summary?.quality || data.proofpath?.quality,
      },
    });
    chat.lastPayload = data;
    chat.lastSources = data.sources;
    chat.updated = Date.now();
    saveState();
    appendBubble("assistant", summary, meta, { sources: data.sources, workflow: true, workflowCard: card });
    updateRail(data);
    maybeOpenRail();
  }

  async function sendMessage(text, forceMode) {
    text = (text || "").trim();
    const hasImg = !!(document.getElementById("imagePreview")?.querySelector(".img-chip"));
    if (!text && hasImg) text = "What do you see in this image?";
    if (!text) return;
    setEmptyVisible(false);
    const runMode = forceMode || mode;
    ensureChats();
    if (!activeChat()) newChat();
    const chat = activeChat();
    chat.model = currentModel;
    chat.kind = "chat";
    chat.messages.push({ role: "user", content: text });
    if (chat.title === "New chat") chat.title = titleFrom(text);
    chat.updated = Date.now();
    saveState(); renderSidebar(chatSearch?.value || "");
    const userRow = appendBubble("user", text);
    // Show attached image thumbs on the user bubble
    const prev = document.getElementById("imagePreview");
    const thumbs = prev ? [...prev.querySelectorAll("img")].map((img) => img.src) : [];
    if (thumbs.length && userRow) {
      const gal = document.createElement("div");
      gal.className = "msg-images";
      thumbs.forEach((src) => {
        const im = document.createElement("img");
        im.src = src;
        im.alt = "Attached";
        gal.appendChild(im);
      });
      userRow.querySelector(".msg-body")?.prepend(gal);
    }
    input.value = ""; autosize();
    if (sendBtn) sendBtn.disabled = true;
    const thinking = appendBubble(
      "assistant",
      "Routing · gathering sources…",
      "thinking",
      { thinking: true }
    );
    try {
      await sendChat(text, chat, thinking);
    } catch (err) {
      stopLocalAnim();
      thinking.remove();
      appendBubble("assistant", "Network error reaching compute.", String(err));
    } finally {
      if (sendBtn) sendBtn.disabled = false;
      input.focus();
      renderSidebar(chatSearch?.value || "");
    }
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); sendMessage(input.value); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && setEnterSend?.checked !== false) {
      e.preventDefault();
      sendMessage(input.value);
    }
  });
  input.addEventListener("input", autosize);
  modelBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (modelMenu.classList.contains("is-open") && pickingSlot === "chat") closeAllMenus();
    else openModelMenu("chat");
  });
  document.querySelectorAll(".plane-picker").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const plane = btn.dataset.plane;
      if (!plane) return;
      if (modelMenu.classList.contains("is-open") && pickingSlot === plane) closeAllMenus();
      else openModelMenu(plane);
    });
  });
  document.addEventListener("pointerdown", (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    if (el.closest("#btnCloseModelMenu") || el.closest("#menuBackdrop")) {
      e.preventDefault();
      closeAllMenus();
      return;
    }
    if (!anyMenuOpen()) return;
    // outside click closes
    if (el.closest("#modelMenu, #modelPickerBtn, #deskPlanes, #featuresMenu, #btnFeatures, #settingsMenu, #btnSettings")) return;
    closeAllMenus();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllMenus();
  });
  document.querySelectorAll("[data-close-menu]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeAllMenus();
    });
  });
  btnNew?.addEventListener("click", newChat);
  btnSidebar?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Focus mode hides the sidebar — exit it first
    if (app.classList.contains("focus-mode")) {
      const focus = document.getElementById("featFocus");
      if (focus) {
        focus.checked = false;
        focus.dispatchEvent(new Event("change", { bubbles: true }));
      }
      app.classList.remove("focus-mode");
    }
    const narrow = window.matchMedia("(max-width: 900px)").matches;
    if (narrow) {
      const open = !sidebar.classList.contains("open");
      sidebar.classList.toggle("open", open);
      app.classList.toggle("sidebar-drawer-open", open);
      btnSidebar.setAttribute("aria-expanded", open ? "true" : "false");
      const bd = document.getElementById("menuBackdrop");
      if (bd) {
        bd.hidden = !open;
        bd.classList.toggle("is-open", open);
        if (open) bd.removeAttribute("hidden");
        else bd.setAttribute("hidden", "");
      }
    } else {
      const collapsed = app.classList.toggle("sidebar-collapsed");
      btnSidebar.setAttribute("aria-expanded", collapsed ? "false" : "true");
      try { localStorage.setItem("noeti_sidebar_collapsed", collapsed ? "1" : "0"); } catch (_) {}
    }
  });
  // Restore desktop collapse preference
  try {
    if (localStorage.getItem("noeti_sidebar_collapsed") === "1" && !window.matchMedia("(max-width: 900px)").matches) {
      app.classList.add("sidebar-collapsed");
      btnSidebar?.setAttribute("aria-expanded", "false");
    } else {
      btnSidebar?.setAttribute("aria-expanded", "true");
    }
  } catch (_) {}
  document.getElementById("menuBackdrop")?.addEventListener("click", () => {
    if (sidebar.classList.contains("open")) {
      sidebar.classList.remove("open");
      app.classList.remove("sidebar-drawer-open");
      btnSidebar?.setAttribute("aria-expanded", "false");
    }
  });

  function handleProvPointer(ev) {
    const content = ev.target?.closest?.(".msg.assistant .msg-content.prov-ready, .msg.assistant .msg-content");
    if (!content) return;
    if (ev.target?.closest?.("a, button, .prov-hint")) return;
    const msg = content.closest(".msg.assistant");
    if (!msg) return;
    const sel = window.getSelection?.();
    // If user just finished a selection, mouseup handler owns it
    if (sel && !sel.isCollapsed && String(sel.toString() || "").trim().length >= 8) return;
    const x = ev.clientX ?? ev.changedTouches?.[0]?.clientX;
    const y = ev.clientY ?? ev.changedTouches?.[0]?.clientY;
    let text = "";
    if (x != null) text = sentenceFromPoint(x, y, content);
    if (text.length < 6) text = (content.innerText || "").split(/(?<=[.!?])\s+/).find((s) => s.trim().length > 20) || "";
    if (text.length < 6) return;
    const chat = activeChat();
    showProvenance(text, chat?.lastPayload || {}, { x, y });
  }
  function handleProvSelection() {
    const sel = window.getSelection?.();
    if (!sel || sel.isCollapsed) return;
    const text = String(sel.toString() || "").trim().replace(/\s+/g, " ");
    if (text.length < 8) return;
    const anchor = sel.anchorNode?.parentElement;
    if (!anchor?.closest?.(".msg.assistant .msg-content")) return;
    const chat = activeChat();
    const rect = sel.getRangeAt?.(0)?.getBoundingClientRect?.();
    showProvenance(text, chat?.lastPayload || {}, rect ? { x: rect.left + rect.width / 2, y: rect.bottom } : null);
  }
  document.getElementById("chatLog")?.addEventListener("click", handleProvPointer);
  document.getElementById("chatLog")?.addEventListener("mouseup", handleProvSelection);
  document.getElementById("chatLog")?.addEventListener("touchend", () => {
    setTimeout(handleProvSelection, 30);
  }, { passive: true });

  document.getElementById("btnToggleRail")?.addEventListener("click", () => app.classList.toggle("rail-open"));
  document.getElementById("btnCloseRail")?.addEventListener("click", () => app.classList.remove("rail-open"));
  const setDeskOpen = document.getElementById("setDeskOpen");
  if (setDeskOpen) {
    setDeskOpen.checked = app.classList.contains("rail-open");
    setDeskOpen.addEventListener("change", () => {
      app.classList.toggle("rail-open", !!setDeskOpen.checked);
    });
    const syncDeskToggle = () => { setDeskOpen.checked = app.classList.contains("rail-open"); };
    new MutationObserver(syncDeskToggle).observe(app, { attributes: true, attributeFilter: ["class"] });
  }
  const closeChatSettings = () => {
    const menu = document.getElementById("settingsMenu");
    if (menu) menu.hidden = true;
    btnSettings?.setAttribute("aria-expanded", "false");
  };
  document.getElementById("setPlaneChecker")?.addEventListener("click", () => {
    closeChatSettings();
    document.getElementById("planeCheckerBtn")?.click();
  });
  document.getElementById("setPlaneValidator")?.addEventListener("click", () => {
    closeChatSettings();
    document.getElementById("planeValidatorBtn")?.click();
  });
  document.getElementById("setPlaneWatcher")?.addEventListener("click", () => {
    closeChatSettings();
    document.getElementById("planeWatcherBtn")?.click();
  });
  document.getElementById("menuBackdrop")?.addEventListener("click", () => {
    if (app.classList.contains("rail-open") && window.matchMedia("(max-width: 1100px)").matches) {
      app.classList.remove("rail-open");
    }
  });
  const _railObs = new MutationObserver(() => {
    const bd = document.getElementById("menuBackdrop");
    if (!bd) return;
    const narrow = window.matchMedia("(max-width: 1100px)").matches;
    if (app.classList.contains("rail-open") && narrow) {
      bd.hidden = false;
      bd.dataset.railBackdrop = "1";
    } else if (bd.dataset.railBackdrop) {
      delete bd.dataset.railBackdrop;
      // leave hidden state to other menus unless they need it
      if (!document.getElementById("settingsMenu") || document.getElementById("settingsMenu").hidden) {
        if (!document.getElementById("modelMenu") || document.getElementById("modelMenu").hidden) bd.hidden = true;
      }
    }
  });
  _railObs.observe(app, { attributes: true, attributeFilter: ["class"] });
  
  btnFeatures?.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(btnFeatures, featuresMenu); });
  btnSettings?.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(btnSettings, settingsMenu); });
  setTemp?.addEventListener("input", () => {
    if (setTempVal) setTempVal.textContent = temperature().toFixed(2);
    saveState();
  });
  setDensity?.addEventListener("change", () => {
    app.dataset.density = setDensity.value;
    saveState();
  });
  setDepth?.addEventListener("change", () => { syncDepthToJudges(); saveState(); });
  setAutoRail?.addEventListener("change", saveState);
  setEnterSend?.addEventListener("change", saveState);
  setPrivateRoute?.addEventListener("change", () => { syncPrivateNote(); saveState(); });
  document.getElementById("toggleWebSearch")?.addEventListener("change", () => { saveState(); syncCompareUI(); });
  document.getElementById("toggleCompare")?.addEventListener("change", () => {
    saveState();
    syncCompareUI();
    if (window.__noetiSetCompare) window.__noetiSetCompare(!!document.getElementById("toggleCompare")?.checked);
  });
  document.getElementById("setSystemPrompt")?.addEventListener("change", saveState);
  document.getElementById("setSystemPrompt")?.addEventListener("blur", saveState);
  ["featSources", "featGraph", "featTimestamps", "featCompactMeta", "featFocus", "featSlash", "featAutoArtifacts"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", () => {
      saveState();
      applyModuleVisibility();
      const chat = activeChat();
      if (chat?.lastPayload) updateRail(chat.lastPayload);
      else if (chat?.lastInsights) updateRail({ insights: chat.lastInsights, sources: chat.lastSources });
      renderMessages();
    });
  });
  chatSearch?.addEventListener("input", () => renderSidebar(chatSearch.value));

  document.getElementById("btnExportChat")?.addEventListener("click", () => {
    const chat = activeChat();
    const blob = new Blob([JSON.stringify(chat || {}, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `noeti-chat-${activeId || "empty"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  document.getElementById("btnExportProof")?.addEventListener("click", async () => {
    const chat = activeChat();
    const pp = chat?.lastPayload?.proofpath || chat?.lastPayload;
    if (pp?.run_id) {
      await handlePacketAction("json", pp);
      return;
    }
    // fallback: dump last newsroom payload
    if (chat?.lastPayload) {
      const blob = new Blob([JSON.stringify(chat.lastPayload, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `proofpath-local-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  });
  document.getElementById("btnClearChat")?.addEventListener("click", () => {
    const chat = activeChat();
    if (!chat) return;
    chat.messages = [];
    chat.lastPayload = null;
    chat.title = "New chat";
    saveState();
    renderMessages();
    renderSidebar(chatSearch?.value || "");
    closeMenus();
  });
  
  
  
  document.getElementById("toolCopy")?.addEventListener("click", async () => {
    const chat = activeChat();
    const last = [...(chat?.messages || [])].reverse().find((m) => m.role === "assistant");
    if (!last) return;
    try { await navigator.clipboard.writeText(last.content); } catch (_) { /* ignore */ }
  });

  document.getElementById("featureTiles")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".ftile, .estrip");
    if (!btn) return;
    const a = btn.dataset.action;
    if (a === "open-models") openModelMenu();
    if (a === "open-desk") app.classList.add("rail-open");
    if (a === "open-settings") {
      toggleMenu(btnSettings, settingsMenu);
    }
  });

  applySettingsUI();
  // Init menus closed
  closeAllMenus();
  ensureChats();
  if (state.model) currentModel = state.model;
  if (!activeId && state.chats.length) activeId = state.chats[0].id;
  setMode(mode);
  renderSidebar();
  renderMessages();
  const chat = activeChat();
  if (chat?.lastPayload) updateRail(chat.lastPayload);
  else if (chat?.lastInsights) updateRail({ insights: chat.lastInsights, sources: chat.lastSources });
  loadModels().catch(() => { /* model list optional */ });
  
  // Model filters / search
  document.getElementById("modelFilters")?.addEventListener("click", (e) => {
    const b = e.target.closest(".mfilt");
    if (!b) return;
    e.preventDefault();
    modelFilter = b.dataset.filter || "all";
    document.querySelectorAll(".mfilt").forEach((x) => x.classList.toggle("is-on", x === b));
    const list = document.getElementById("modelMenuList");
    const keep = list ? list.scrollTop : 0;
    renderModelMenu();
    if (list) list.scrollTop = keep;
  });
  let _modelSearchTimer = null;
  document.getElementById("modelSearch")?.addEventListener("input", (e) => {
    modelQuery = e.target.value || "";
    clearTimeout(_modelSearchTimer);
    _modelSearchTimer = setTimeout(() => {
      const list = document.getElementById("modelMenuList");
      const keep = list ? list.scrollTop : 0;
      renderModelMenu();
      if (list) list.scrollTop = keep;
    }, 120);
  });
  document.getElementById("setShowPaid")?.addEventListener("change", () => { renderModelMenu(); saveState(); });
  document.getElementById("setAccent")?.addEventListener("change", () => {
    app.dataset.accent = document.getElementById("setAccent").value;
    saveState();
  });
  document.getElementById("toolRegen")?.addEventListener("click", () => {
    const chat = activeChat();
    if (!chat?.messages?.length) return;
    // drop last assistant, resend last user
    let lastUser = null;
    while (chat.messages.length && chat.messages[chat.messages.length - 1].role === "assistant") {
      chat.messages.pop();
    }
    if (chat.messages.length && chat.messages[chat.messages.length - 1].role === "user") {
      lastUser = chat.messages.pop().content;
    }
    saveState();
    renderMessages();
    if (lastUser) sendMessage(lastUser);
  });
  document.getElementById("toolPin")?.addEventListener("click", () => {
    const chat = activeChat();
    if (!chat) return;
    chat.pinned = !chat.pinned;
    if (chat.pinned) chat.updated = Date.now() + 1e12;
    saveState();
    renderSidebar(chatSearch?.value || "");
  });

  
  let abortWait = false;
  document.getElementById("toolStop")?.addEventListener("click", () => {
    abortWait = true;
    if (sendBtn) sendBtn.disabled = false;
    const note = document.querySelector(".composer-note");
    if (note) note.textContent = "Stopped — you can send again";
  });
  document.getElementById("toolShare")?.addEventListener("click", async () => {
    const chat = activeChat();
    const rid = chat?.lastRunId || chat?.lastPayload?.run_id || chat?.lastPayload?.proofpath?.run_id;
    let text;
    if (rid) {
      text = `Noeti ProofPath run ${rid}\n${location.origin}/api/proofpath/runs/${rid}\nExport: ${location.origin}/api/proofpath/runs/${rid}/export?format=json`;
    } else if (chat?.messages?.length) {
      text = chat.messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
    } else {
      return;
    }
    try { await navigator.clipboard.writeText(text); } catch (_) {}
    if (composerNote) composerNote.textContent = rid ? "ProofPath link copied" : "Thread copied to clipboard";
    setTimeout(() => syncPrivateNote(), 2200);
  });
  // Compare mode is handled by chat-plus.js (side-by-side streams).

  window.__noetiChatApi = {
    getModel: () => currentModel,
    getWitnessModels: () => ({ ...witnessModels }),
    setWitnessModel: (role, id) => {
      if (!role || !id || !(role in witnessModels)) return;
      witnessModels[role] = id;
      updatePlaneLabels();
      saveState();
    },
    setModel: (id) => {
      if (!id) return;
      currentModel = id;
      const chat = activeChat();
      if (chat) chat.model = currentModel;
      updateModelLabel();
      saveState();
      renderModelMenu();
    },
    getModels: () => models.slice(),
    getChats: () => { ensureChats(); return state.chats; },
    saveState,
    updateRail,
    maybeOpenRail,
    runDeskWitness,
    setArchStages,
    showProvenance,
    appendBubble,
    mergeChats,
    temperature,
    openModelMenu,
    sendMessage,
    regenLast: () => document.getElementById("toolRegen")?.click(),
    clearActive: () => document.getElementById("btnClearChat")?.click(),
  };

  try { loadJudges(); } catch (_) {}
})();
