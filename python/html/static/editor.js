/**
 * Noeti Editor — Cursor-grade desk. Power through menus + ⌘K.
 */
(() => {
  const WS_KEY = "noeti_editor_ws_v1";
  const RUN_CACHE_KEY = "noeti_editor_runs_v1";
  const CHAT_CACHE_KEY = "noeti_editor_chat_v1";
  const CTRL_KEY = "noeti_editor_ctrl_v1";
  const PINS_KEY = "noeti_editor_pins_v1";
  const MAX_RUNS = 40;
  const MAX_RECENT = 12;
  const MAX_TABS = 10;

  const EXT_LANG = {
    py: "python", js: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "javascript", jsx: "javascript", tsx: "javascript",
    rb: "ruby", php: "php", pl: "perl", lua: "lua",
    go: "go", rs: "rust", java: "java", c: "c", h: "c", cpp: "cpp", cc: "cpp",
    r: "r", sh: "bash", bash: "bash", zsh: "bash",
  };

  const brain = () => window.NoetiBrain;
  const $ = (id) => document.getElementById(id);
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || "");

  const els = {
    list: $("edFileList"), recent: $("edRecent"), search: $("edSearch"),
    code: $("edCode"), tabs: $("edTabs"), shell: $("edShell"),
    explorer: $("edExplorer"), side: $("edSide"),
    save: $("edSave"), run: $("edRun"), run2: $("edRun2"), stop: $("edStop"),
    graphBtn: $("edGraph"), memoryBtn: $("edMemory"), brainBtn: $("edBrain"),
    allow: $("edAllow"), status: $("edStatus"),
    out: $("edOut"), term: $("edTerm"), termWrap: $("edTermWrap"),
    termInput: $("edTermInput"), termForm: $("edTermForm"), termPrompt: $("edTermPrompt"),
    termHost: $("edTermHost"), termCwd: $("edTermCwd"), termLive: $("edTermLive"),
    fsRoot: $("edFsRoot"), fsHost: $("edFsHost"), fsPath: $("edFsPath"),
    problems: $("edProblems"),
    bottom: $("edBottom"), bottomToggle: $("edBottomToggle"),
    codeWrap: $("edCodeWrap"), graphWrap: $("edGraphWrap"),
    graphCanvas: $("edGraphCanvas"), miniGraph: $("edMiniGraph"),
    graphHint: $("edGraphHint"),
    graphClose: $("edGraphClose"), graphLabel: $("edGraphLabel"),
    graphExpand: $("edGraphExpand"),
    splitVert: $("edSplitVert"), splitLeft: $("edSplitLeft"), splitBottom: $("edSplitBottom"),
    splitViews: $("edSplitViews"), splitRight: $("edSplitRight"),
    center: $("edCenter") || document.querySelector(".ed-center"),
    views: $("edViews"),
    leftGraph: $("edLeftGraph"),
    right: $("edRight"), rightBody: $("edRightBody"), rightClose: $("edRightClose"),
    chat: $("edChat"), chatLog: $("edChatLog"), chatForm: $("edChatForm"),
    chatIn: $("edChatIn"), chatSend: $("edChatSend"), chatStop: $("edChatStop"),
    chatFile: $("edChatFile"), chatClear: $("edChatClear"), chatClose: $("edChatClose"),
    chatApplyBar: $("edChatApplyBar"), chatApply: $("edChatApply"),
    chatInsert: $("edChatInsert"), chatApplyHint: $("edChatApplyHint"),
    chatChips: $("edChatChips"),
    layoutBar: $("edLayoutBar"),
    bottomTabs: $("edBottomTabs"),
    log: $("edAssistLog"), form: $("edAssistForm"), prompt: $("edPrompt"),
    ask: $("edAsk"), apply: $("edApply"), model: $("edModel"),
    lang: $("edLang"), stdin: $("edStdin"), timeout: $("edTimeout"),
    memStats: $("edMemStats"), memList: $("edMemList"),
    memRefresh: $("edMemRefresh"), memClearRuns: $("edMemClearRuns"),
    memClearChat: $("edMemClearChat"), memPin: $("edMemPin"),
    where: $("edWhere"), device: $("edDevice"), deviceList: $("edDeviceList"),
    autoSave: $("edAutoSave"), temp: $("edTemp"), tempVal: $("edTempVal"),
    refreshDevices: $("edRefreshDevices"), brainOpen: $("edBrainOpen"),
    brainStatus: $("edBrainStatus"), modelBtn: $("edModelBtn"),
    whereSeg: $("edWhereSeg"), autoSeg: $("edAutoSeg"), langSeg: $("edLangSeg"),
    timeoutVal: $("edTimeoutVal"),
    ctxChars: $("edCtxChars"), pins: $("edPins"),
    titleFile: $("edTitleFile"),
    statLang: $("edStatLang"), statWhere: $("edStatWhere"),
    statMem: $("edStatMem"), statPos: $("edStatPos"),
    menubar: $("edMenubar"),
    cmd: $("edCmd"), cmdInput: $("edCmdInput"), cmdList: $("edCmdList"), cmdBtn: $("edCmdBtn"),
    findbar: $("edFindbar"), findInput: $("edFindInput"),
    findNext: $("edFindNext"), findPrev: $("edFindPrev"), findClose: $("edFindClose"),
    findCase: $("edFindCase"), replaceInput: $("edReplaceInput"),
    replaceOne: $("edReplaceOne"), replaceAll: $("edReplaceAll"), findCount: $("edFindCount"),
    logout: $("btnAuthLogout"), gate: $("authGate"),
    app: document.querySelector("[data-auth-app]"),
  };

  /** @type {{path:string, text:string, saved:string}[]} */
  let tabs = [];
  let activePath = "";
  let filter = "";
  let lastCodeBlock = "";
  let chatLastCode = "";
  let busy = false;
  let chatBusy = false;
  let runAbort = null;
  /** @type {AbortController|null} */
  let chatAbort = null;
  const LAYOUT_KEY = "noeti_editor_layout_v2";
  const THEME_KEY = "noeti_theme";
  let graphMode = false;
  let graphKind = "memory";
  /** @type {{explorer:boolean, bottom:boolean, fs:boolean, explorerSide:'left'|'right', helperDock:'bottom'|'right', chatRight:boolean, viewMode:'code'|'graph'|'split', preset:string, leftW:number, leftGraphH:number, bottomH:number, rightW:number, viewSplit:number, tabOrder:string[]}} */
  let layoutState = {
    explorer: true,
    bottom: true,
    fs: true,
    explorerSide: "left",
    helperDock: "bottom",
    chatRight: true,
    viewMode: "code",
    preset: "default",
    leftW: 300,
    leftGraphH: 58,
    bottomH: 240,
    rightW: 340,
    viewSplit: 48,
    tabOrder: ["helper", "out", "term", "problems", "memory", "brain", "run"],
  };
  /** @type {any} */
  let graphState = null;
  /** @type {any} */
  let miniState = null;
  let miniRunning = false;
  let openMenu = "";
  let cmdIndex = 0;
  let findPos = 0;

  function loadJson(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || "null");
      return v == null ? fallback : v;
    } catch (_) { return fallback; }
  }
  function saveJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
  }
  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/'/g, "&#39;"); }
  function basename(path) { return String(path || "").split("/").pop() || path; }
  function extOf(path) {
    const base = basename(path);
    const i = base.lastIndexOf(".");
    return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
  }
  function langOf(path) { return EXT_LANG[extOf(path)] || "python"; }
  function runnable(path) { return !!EXT_LANG[extOf(path)]; }
  function activeTab() { return tabs.find((t) => t.path === activePath) || null; }
  function kbd(s) { return isMac ? s.replace(/⌘/g, "⌘").replace(/Ctrl/g, "⌘") : s.replace(/⌘/g, "Ctrl"); }

  function ctrl() {
    return {
      where: "pc",
      deviceId: "",
      autoSave: true,
      temp: 0.35,
      ctxChars: 24000,
      ...loadJson(CTRL_KEY, {}),
    };
  }
  function saveCtrl(patch) {
    const next = { ...ctrl(), ...patch };
    saveJson(CTRL_KEY, next);
    syncControlForm();
    updateStatusbar();
  }

  function pins() { return loadJson(PINS_KEY, []); }
  function setPins(arr) { saveJson(PINS_KEY, arr.slice(0, 20)); renderPins(); renderMemory(); updateStatusbar(); }

  function setStatus(msg) {
    if (els.status) els.status.textContent = msg;
  }

  function updateStatusbar() {
    const t = activeTab();
    const c = ctrl();
    const runs = loadJson(RUN_CACHE_KEY, []);
    const chat = loadJson(CHAT_CACHE_KEY, []);
    if (els.titleFile) els.titleFile.textContent = t ? t.path : "";
    if (els.chatFile) els.chatFile.textContent = t ? t.path : "No file open";
    syncDeskChrome();
    if (els.statLang) els.statLang.textContent = t ? langOf(t.path) : "—";
    if (els.statWhere) {
      const w = c.where === "runtime" ? "pc" : c.where;
      els.statWhere.textContent = w === "pc" || w === "private"
        ? `where · PC${c.deviceId ? " · " + c.deviceId : ""}`
        : "where · " + w;
    }
    if (els.statMem) els.statMem.textContent = `mem ${pins().length}p · ${runs.length}r · ${chat.length}h`;
    updateCursorPos();
  }

  function setEditorTheme(theme) {
    if (window.NoetiTheme?.apply) {
      window.NoetiTheme.apply(theme);
      setStatus(theme === "black" ? "Theme · dark" : "Theme · light");
      return;
    }
    const next = theme === "black" ? "black" : "white";
    document.documentElement.setAttribute("data-theme", next);
    document.body.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
      localStorage.setItem("noeti_editor_theme", next);
    } catch (_) {}
    setStatus(next === "black" ? "Theme · dark" : "Theme · light");
  }

  function openEditorSettings(open) {
    const sheet = document.getElementById("edSettingsSheet");
    const backdrop = document.getElementById("edSettingsBackdrop");
    const btn = document.getElementById("edSettingsBtn");
    const on = open !== false;
    if (sheet) sheet.hidden = !on;
    if (backdrop) backdrop.hidden = !on;
    btn?.setAttribute("aria-expanded", on ? "true" : "false");
    if (on) syncLayoutChrome();
  }

  function initTheme() {
    const t = window.NoetiTheme?.read?.() || (() => {
      try { return localStorage.getItem(THEME_KEY) || localStorage.getItem("noeti_editor_theme") || "white"; } catch (_) { return "white"; }
    })();
    setEditorTheme(t);
    window.addEventListener("noeti:theme", (e) => {
      const next = e.detail?.theme || "white";
      setStatus(next === "black" ? "Theme · dark" : "Theme · light");
    });
  }

  function syncDeskChrome() {
    const c = ctrl();
    const st = brain()?.getStatus?.() || {};
    const root = st.rootLabel || st.label || st.root || "";
    const rootName = root ? basename(String(root).replace(/\/$/, "")) || String(root) : "No folder";
    const where = c.where === "runtime" ? "pc" : (c.where || "pc");
    const hostLabel =
      where === "server" ? "Server" :
      where === "private" ? "Private PC" :
      where === "brain" ? "Brain only" :
      (c.deviceId ? `PC · ${c.deviceId}` : "This PC");
    const hostLive = where === "pc" || where === "private";

    if (els.fsRoot) els.fsRoot.textContent = root ? rootName : "No folder";
    if (els.fsPath) els.fsPath.textContent = root || "Allow a project folder";
    if (els.fsHost) {
      els.fsHost.textContent = hostLabel;
      els.fsHost.classList.toggle("is-live", hostLive && where !== "brain");
      els.fsHost.classList.toggle("is-warn", where === "brain" || where === "server");
    }
    if (els.termHost) els.termHost.textContent = hostLabel;
    if (els.termCwd) {
      els.termCwd.textContent = activePath
        ? basename(activePath)
        : (root ? rootName : "—");
      els.termCwd.title = activePath || root || "No path";
    }
  }

  function updateCursorPos() {
    if (!els.statPos || !els.code) return;
    const v = els.code.value || "";
    const pos = els.code.selectionStart || 0;
    const lines = v.slice(0, pos).split("\n");
    els.statPos.textContent = `Ln ${lines.length}, Col ${lines[lines.length - 1].length + 1}`;
  }

  function syncControlForm() {
    const c = ctrl();
    if (c.where === "runtime") c.where = "pc";
    if (els.where) els.where.value = c.where === "runtime" ? "pc" : c.where;
    if (els.autoSave) els.autoSave.value = c.autoSave ? "1" : "0";
    if (els.temp) els.temp.value = String(c.temp);
    if (els.tempVal) els.tempVal.textContent = Number(c.temp).toFixed(2);
    if (els.ctxChars) els.ctxChars.value = String(c.ctxChars);
    document.querySelectorAll("#edWhereSeg .ed-seg-btn").forEach((btn) => {
      btn.classList.toggle("is-on", btn.getAttribute("data-where") === (els.where?.value || "pc"));
    });
    document.querySelectorAll("#edAutoSeg .ed-seg-btn").forEach((btn) => {
      btn.classList.toggle("is-on", btn.getAttribute("data-auto") === (c.autoSave ? "1" : "0"));
    });
    const st = brain()?.getStatus?.();
    if (els.brainStatus) {
      els.brainStatus.textContent = st?.count
        ? `${st.count} files · ${st.roots?.[0] || "workspace"}`
        : "No folder indexed — Open Folder";
    }
  }

  async function loadDevices() {
    if (!els.device && !els.deviceList) return;
    try {
      const res = await fetch("/api/canvas/device/list", { credentials: "same-origin", cache: "no-store" });
      const data = await res.json();
      const devices = data.devices || [];
      const c = ctrl();
      if (els.device) {
        if (!devices.length) {
          els.device.innerHTML = `<option value="">No PC paired</option>`;
        } else {
          els.device.innerHTML = devices.map((d) => {
            const id = d.device_id || "";
            const label = d.label || d.hostname || id;
            return `<option value="${escapeAttr(id)}" ${id === c.deviceId ? "selected" : ""}>${escapeHtml(label)}</option>`;
          }).join("");
        }
      }
      if (els.deviceList) {
        if (!devices.length) {
          els.deviceList.innerHTML = `<button type="button" class="ed-device-chip" disabled>No PC paired</button>`;
        } else {
          els.deviceList.innerHTML = devices.map((d) => {
            const id = d.device_id || "";
            const label = d.label || d.hostname || id;
            const on = id === c.deviceId || (!c.deviceId && d.online);
            return `<button type="button" class="ed-device-chip ${on ? "is-on" : ""} ${d.online ? "is-live" : ""}" data-device="${escapeAttr(id)}">${escapeHtml(label)}${d.online ? " · live" : ""}</button>`;
          }).join("");
        }
      }
      const online = devices.find((d) => d.online);
      if (!c.deviceId && online) saveCtrl({ deviceId: online.device_id });
      else if (c.deviceId && els.device) els.device.value = c.deviceId;
      updateStatusbar();
    } catch (_) {
      if (els.deviceList) els.deviceList.innerHTML = `<button type="button" class="ed-device-chip" disabled>Unavailable</button>`;
    }
  }

  function renderPins() {
    if (!els.pins) return;
    const list = pins();
    if (!list.length) {
      els.pins.innerHTML = `<div class="ed-pin"><span style="color:#aaa">No pins</span></div>`;
      return;
    }
    els.pins.innerHTML = list.map((p) =>
      `<div class="ed-pin"><span title="${escapeAttr(p)}">${escapeHtml(basename(p))}</span><button type="button" data-unpin="${escapeAttr(p)}">×</button></div>`
    ).join("");
  }

  /* ---- Menus ---- */
  function closeMenus() {
    openMenu = "";
    document.querySelectorAll(".ed-menu").forEach((m) => m.classList.remove("is-open"));
    document.querySelectorAll(".ed-menu-drop").forEach((d) => { d.hidden = true; });
  }

  function openMenuNamed(name) {
    closeMenus();
    openMenu = name;
    const menu = document.querySelector(`.ed-menu-btn[data-menu="${name}"]`)?.closest(".ed-menu");
    const drop = document.querySelector(`.ed-menu-drop[data-drop="${name}"]`);
    if (menu) menu.classList.add("is-open");
    if (drop) drop.hidden = false;
  }

  const COMMANDS = [
    { id: "cmd-palette", label: "Command palette", kbd: "⌘K" },
    { id: "allow", label: "Allow folder / files…" },
    { id: "brain", label: "Second Brain settings…" },
    { id: "save", label: "Save", kbd: "⌘S" },
    { id: "save-all", label: "Save all tabs" },
    { id: "close-tab", label: "Close tab" },
    { id: "close-all", label: "Close all tabs" },
    { id: "recent", label: "Open recent…" },
    { id: "find", label: "Find in file", kbd: "⌘F" },
    { id: "goto-line", label: "Go to line…" },
    { id: "apply-helper", label: "Apply last helper code" },
    { id: "format-soft", label: "Normalize whitespace" },
    { id: "toggle-explorer", label: "Toggle Explorer" },
    { id: "toggle-side", label: "Toggle Side panel" },
    { id: "toggle-bottom", label: "Toggle Bottom panel" },
    { id: "toggle-fs-pane", label: "Toggle Filesystem pane" },
    { id: "layout-default", label: "Layout · Default" },
    { id: "layout-code", label: "Layout · Code focus" },
    { id: "layout-split", label: "Layout · Code | Graph" },
    { id: "layout-term", label: "Layout · Terminal focus" },
    { id: "layout-helper-right", label: "Layout · Chat on right" },
    { id: "explorer-right", label: "Move Explorer left/right" },
    { id: "layout-reset", label: "Reset pane sizes" },
    { id: "view-code", label: "View · Code" },
    { id: "view-fs-graph", label: "Filesystem graph", kbd: "⌘G" },
    { id: "view-mem-graph", label: "Memory graph" },
    { id: "view-split", label: "Code + Graph split" },
    { id: "graph-reset", label: "Reset graph layout" },
    { id: "graph-run-hot", label: "Run hot graph nodes" },
    { id: "side-helper", label: "Side → Helper" },
    { id: "toggle-chat", label: "Toggle coding chat" },
    { id: "side-memory", label: "Side → Memory" },
    { id: "side-control", label: "Side → Control" },
    { id: "side-run", label: "Side → Run" },
    { id: "term", label: "Terminal" },
    { id: "run", label: "Run file", kbd: "⌘↵" },
    { id: "run-stdin", label: "Run with stdin…" },
    { id: "stop", label: "Stop" },
    { id: "run-config", label: "Run configuration…" },
    { id: "clear-output", label: "Clear output" },
    { id: "mem-pin", label: "Pin current file" },
    { id: "mem-refresh", label: "Refresh memory" },
    { id: "mem-clear-runs", label: "Clear run cache" },
    { id: "mem-clear-chat", label: "Clear helper cache" },
    { id: "mem-clear-all", label: "Clear all editor caches" },
    { id: "helper-focus", label: "Focus coding helper" },
    { id: "control-where", label: "Control · Where routing…" },
  ];

  function runCmd(id) {
    closeMenus();
    closeCmd();
    switch (id) {
      case "cmd-palette": openCmd(); break;
      case "allow":
      case "brain": brain()?.open?.(); break;
      case "save": saveFile(); break;
      case "save-all": saveAll(); break;
      case "close-tab": if (activePath) closeTab(activePath); break;
      case "close-all": closeAll(); break;
      case "recent": openRecentPicker(); break;
      case "find": showFind(true); break;
      case "goto-line": gotoLine(); break;
      case "apply-helper": applyLast(); break;
      case "format-soft": formatSoft(); break;
      case "toggle-explorer":
        layoutState.explorer = !(layoutState.explorer !== false);
        layoutState.preset = "custom";
        applyLayout(layoutState);
        persistLayout();
        break;
      case "toggle-side":
      case "toggle-bottom":
        layoutState.bottom = !layoutState.bottom;
        layoutState.preset = "custom";
        applyLayout(layoutState);
        persistLayout();
        break;
      case "toggle-chat":
        layoutState.chatRight = !(layoutState.chatRight !== false);
        layoutState.preset = "custom";
        applyLayout(layoutState);
        persistLayout();
        break;
      case "toggle-fs-pane":
        layoutState.fs = !(layoutState.fs !== false);
        layoutState.preset = "custom";
        applyLayout(layoutState);
        persistLayout();
        break;
      case "explorer-right":
        layoutState.explorerSide = layoutState.explorerSide === "right" ? "left" : "right";
        layoutState.preset = "custom";
        applyLayout(layoutState);
        persistLayout();
        break;
      case "layout-default": applyPreset("default"); break;
      case "layout-code": applyPreset("code"); break;
      case "layout-split": applyPreset("split"); break;
      case "layout-term": applyPreset("term"); break;
      case "layout-helper-right": applyPreset("helper-right"); break;
      case "layout-reset": resetLayoutSizes(); break;
      case "view-code": setViewMode("code"); layoutState.preset = "custom"; persistLayout(); break;
      case "view-fs-graph": graphKind = "fs"; setViewMode("split"); layoutState.preset = "custom"; persistLayout(); break;
      case "view-mem-graph": graphKind = "memory"; setViewMode("graph"); layoutState.preset = "custom"; persistLayout(); break;
      case "view-split": graphKind = graphKind || "fs"; setViewMode("split"); layoutState.preset = "custom"; persistLayout(); break;
      case "graph-reset":
        graphState = null;
        miniState = null;
        if (graphMode || layoutState.viewMode === "split") drawGraph(true);
        drawMini(true);
        break;
      case "graph-run-hot": runHotNodes(); break;
      case "side-helper": showBottomPanel("helper"); break;
      case "side-memory": showBottomPanel("memory"); break;
      case "side-control": showBottomPanel("brain"); break;
      case "side-run": showBottomPanel("run"); break;
      case "term": showBottomPanel("term"); break;
      case "run": runFile(); break;
      case "run-stdin": showBottomPanel("run"); els.stdin?.focus(); break;
      case "stop": stopRun(); break;
      case "run-config": showBottomPanel("run"); break;
      case "clear-output":
        els.out.textContent = "Ready. Run → Run file.";
        if (els.term) {
          els.term.innerHTML = TERM_BOOT_HTML;
          els.term.dataset.booted = "1";
        }
        els.problems.textContent = "";
        break;
      case "mem-pin": pinCurrent(); break;
      case "mem-refresh": renderMemory(); updateStatusbar(); break;
      case "mem-clear-runs": saveJson(RUN_CACHE_KEY, []); renderMemory(); updateStatusbar(); break;
      case "mem-clear-chat": saveJson(CHAT_CACHE_KEY, []); renderMemory(); updateStatusbar(); break;
      case "mem-clear-all":
        saveJson(RUN_CACHE_KEY, []);
        saveJson(CHAT_CACHE_KEY, []);
        setPins([]);
        renderMemory();
        break;
      case "helper-focus": showBottomPanel("helper"); els.prompt?.focus(); break;
      case "control-where": showBottomPanel("brain"); break;
      default: break;
    }
  }

  function openCmd() {
    if (!els.cmd) return;
    els.cmd.hidden = false;
    els.cmdInput.value = "";
    cmdIndex = 0;
    renderCmdList("");
    els.cmdInput.focus();
  }
  function closeCmd() {
    if (els.cmd) els.cmd.hidden = true;
  }
  function renderCmdList(q) {
    const query = (q || "").trim().toLowerCase();
    const items = COMMANDS.filter((c) => !query || c.label.toLowerCase().includes(query) || c.id.includes(query));
    if (cmdIndex >= items.length) cmdIndex = 0;
    els.cmdList.innerHTML = items.map((c, i) =>
      `<button type="button" class="ed-cmd-item ${i === cmdIndex ? "is-on" : ""}" data-cmd="${escapeAttr(c.id)}">
        <span>${escapeHtml(c.label)}</span>${c.kbd ? `<kbd>${escapeHtml(kbd(c.kbd))}</kbd>` : ""}
      </button>`
    ).join("") || `<div class="ed-cmd-item">No matches</div>`;
  }

  function openRecentPicker() {
    const recent = loadJson(WS_KEY, {}).recent || [];
    if (!recent.length) { setStatus("No recent files"); return; }
    openCmd();
    els.cmdInput.value = "";
    els.cmdList.innerHTML = recent.map((p, i) =>
      `<button type="button" class="ed-cmd-item ${i === 0 ? "is-on" : ""}" data-open="${escapeAttr(p)}">
        <span>${escapeHtml(p)}</span>
      </button>`
    ).join("");
    cmdIndex = 0;
  }

  /* ---- Tabs / files ---- */
  function persistWs() {
    const ws = loadJson(WS_KEY, {});
    saveJson(WS_KEY, {
      ...ws,
      tabs: tabs.map((t) => ({ path: t.path })),
      active: activePath,
    });
  }
  function pushRecent(path) {
    const ws = loadJson(WS_KEY, {});
    const recent = [path, ...(ws.recent || []).filter((p) => p !== path)].slice(0, MAX_RECENT);
    saveJson(WS_KEY, { ...ws, recent, tabs: tabs.map((t) => ({ path: t.path })), active: activePath });
    renderRecent();
  }

  function syncCodeFromTab() {
    const empty = document.getElementById("edCodeEmpty");
    const t = activeTab();
    if (!t) {
      els.code.value = "";
      els.code.disabled = true;
      if (els.save) els.save.disabled = true;
      if (empty) empty.hidden = false;
      updateStatusbar();
      return;
    }
    if (empty) empty.hidden = true;
    els.code.disabled = false;
    els.code.value = t.text;
    if (els.save) els.save.disabled = t.text === t.saved;
    if (els.lang) els.lang.value = langOf(t.path);
    updateStatusbar();
  }

  function renderTabs() {
    if (!tabs.length) {
      els.tabs.innerHTML = `<span class="ed-tab" style="cursor:default;color:#aaa">No file open</span>`;
      return;
    }
    els.tabs.innerHTML = tabs.map((t) => `
      <button type="button" class="ed-tab ${t.path === activePath ? "is-on" : ""} ${t.text !== t.saved ? "is-dirty" : ""}" data-tab="${escapeAttr(t.path)}">
        <span>${escapeHtml(basename(t.path))}</span>
        <span class="ed-tab-x" data-close="${escapeAttr(t.path)}" title="Close">×</span>
      </button>`).join("");
  }

  function buildTree(files) {
    const root = { name: "", path: "", kids: new Map(), file: null };
    for (const f of files) {
      const parts = f.path.split("/").filter(Boolean);
      let cur = root;
      let acc = "";
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        acc = acc ? acc + "/" + part : part;
        const isFile = i === parts.length - 1;
        if (!cur.kids.has(part)) {
          cur.kids.set(part, { name: part, path: acc, kids: new Map(), file: null });
        }
        const node = cur.kids.get(part);
        if (isFile) node.file = f;
        cur = node;
      }
    }
    return root;
  }

  function iconFor(name, isDir, open) {
    if (isDir) {
      return open
        ? `<svg class="ed-ico" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1.5 3.5h5l1 1.5H14.5v7.5h-13z"/></svg>`
        : `<svg class="ed-ico" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1.5 2.5h5l1 1.5h7v9h-13z" opacity=".85"/></svg>`;
    }
    const ext = (name.split(".").pop() || "").toLowerCase();
    const tone =
      ["js", "mjs", "cjs", "jsx"].includes(ext) ? "#a67c00" :
      ["ts", "tsx"].includes(ext) ? "#2f6fad" :
      ["py"].includes(ext) ? "#3b7a57" :
      ["json", "yml", "yaml", "toml"].includes(ext) ? "#8a6d3b" :
      ["md", "txt"].includes(ext) ? "#666" :
      ["html", "css", "scss"].includes(ext) ? "#8b4513" :
      ["rs", "go", "c", "h", "cpp"].includes(ext) ? "#444" :
      "#777";
    return `<svg class="ed-ico" viewBox="0 0 16 16" aria-hidden="true"><path fill="${tone}" d="M3.5 1.5h6l3 3V14.5h-9z"/><path fill="#fff" opacity=".35" d="M9.5 1.5v3h3z"/></svg>`;
  }

  const TREE_KEY = "noeti_editor_tree_exp_v1";
  function loadExpanded() {
    const arr = loadJson(TREE_KEY, null);
    if (Array.isArray(arr)) return new Set(arr);
    return null; // first run — expand roots only
  }
  function saveExpanded(set) {
    saveJson(TREE_KEY, [...set].slice(0, 400));
  }
  let expanded = loadExpanded();
  let treeRoot = null;
  let renderGen = 0;

  function ensureExpandedDefaults(root) {
    if (expanded) return;
    expanded = new Set();
    for (const [, child] of root.kids) {
      if (!child.file) expanded.add(child.path);
    }
    saveExpanded(expanded);
  }

  function sortedKids(node) {
    return [...node.kids.values()].sort((a, b) => {
      const af = !!a.file && a.kids.size === 0;
      const bf = !!b.file && b.kids.size === 0;
      if (af !== bf) return af ? 1 : -1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }

  function nodeMatches(node, q) {
    if (!q) return true;
    if (node.path.toLowerCase().includes(q)) return true;
    for (const child of node.kids.values()) {
      if (nodeMatches(child, q)) return true;
    }
    return false;
  }

  function renderNode(node, depth, budget) {
    if (budget.count <= 0) return "";
    const isDir = node.kids.size > 0 && !(node.file && node.kids.size === 0);
    const hasKids = node.kids.size > 0;
    const isFileOnly = !!node.file && !hasKids;
    const q = filter;

    if (q && !nodeMatches(node, q)) return "";

    let html = "";
    if (node.path) {
      budget.count -= 1;
      if (isFileOnly) {
        const f = node.file;
        const canRun = runnable(f.path);
        const pinned = pins().includes(f.path);
        html += `<div class="ed-row ${f.path === activePath ? "is-open" : ""}" style="--d:${depth}" data-path="${escapeAttr(f.path)}" title="${escapeAttr(f.path)}" role="treeitem">
          <span class="ed-twist spacer"></span>
          ${iconFor(node.name, false, false)}
          <span class="ed-name">${pinned ? "★ " : ""}${escapeHtml(node.name)}</span>
          ${canRun ? `<button type="button" class="ed-file-run" data-run="${escapeAttr(f.path)}" title="Run">▶</button>` : ""}
        </div>`;
      } else {
        const open = q ? true : expanded.has(node.path);
        html += `<div class="ed-row is-dir ${open ? "is-expanded" : ""}" style="--d:${depth}" data-dir="${escapeAttr(node.path)}" title="${escapeAttr(node.path)}" role="treeitem" aria-expanded="${open}">
          <button type="button" class="ed-twist" data-toggle="${escapeAttr(node.path)}" aria-label="Toggle">${open ? "▾" : "▸"}</button>
          ${iconFor(node.name, true, open)}
          <span class="ed-name">${escapeHtml(node.name)}</span>
          <span class="ed-count">${node.kids.size}</span>
        </div>`;
        if (open) {
          for (const child of sortedKids(node)) {
            html += renderNode(child, depth + 1, budget);
            if (budget.count <= 0) break;
          }
        }
      }
    } else {
      for (const child of sortedKids(node)) {
        html += renderNode(child, 0, budget);
        if (budget.count <= 0) break;
      }
    }
    return html;
  }

  function renderList() {
    const b = brain();
    if (!b) {
      els.list.innerHTML = `<p class="ed-file-empty">Second Brain loading…</p>`;
      return;
    }
    const gen = ++renderGen;
    // Prefer readable source files; drop heavy/binary leftovers
    let files = (b.listFiles() || []).filter((f) => {
      if (f.readable === false || f.kind === "binary") return false;
      const p = f.path.toLowerCase();
      if (p.includes(".app/")) return false;
      if (p.includes("/frameworks/")) return false;
      if (/\.(pak|dylib|so|dll|exe|bin|wasm)$/i.test(p)) return false;
      return true;
    });

    if (!files.length) {
      els.list.innerHTML = `<p class="ed-file-empty">File → Allow folder (a project, not Desktop). Heavy app bundles are skipped.</p>`;
      return;
    }

    // Defer heavy tree build off the click path
    requestAnimationFrame(() => {
      if (gen !== renderGen) return;
      treeRoot = buildTree(files);
      ensureExpandedDefaults(treeRoot);
      const budget = { count: filter ? 250 : 450 };
      let html = renderNode(treeRoot, 0, budget);
      if (budget.count <= 0) {
        html += `<p class="ed-file-empty">Showing partial tree — filter or collapse folders.</p>`;
      }
      if (gen !== renderGen) return;
      els.list.innerHTML = html || `<p class="ed-file-empty">No files match filter.</p>`;
    });
  }

  function renderRecent() {
    const recent = loadJson(WS_KEY, {}).recent || [];
    if (!recent.length) {
      els.recent.innerHTML = `<p class="ed-file-empty" style="padding:0.4rem 0.7rem">—</p>`;
      return;
    }
    els.recent.innerHTML = recent.map((p) =>
      `<div class="ed-row" style="--d:0" data-path="${escapeAttr(p)}" title="${escapeAttr(p)}">
        <span class="ed-twist spacer"></span>
        ${iconFor(basename(p), false, false)}
        <span class="ed-name">${escapeHtml(basename(p))}</span>
      </div>`
    ).join("");
  }

  async function openFile(path, opts = {}) {
    const b = brain();
    if (!b || !path) return;
    let tab = tabs.find((t) => t.path === path);
    if (!tab) {
      const text = await b.readFile(path);
      if (text == null) { setStatus("Unreadable: " + path); return; }
      if (tabs.length >= MAX_TABS) {
        const victim = tabs.find((t) => t.path !== activePath && t.text === t.saved);
        if (!victim) {
          setStatus("Too many dirty tabs — save or close one first");
          return;
        }
        tabs = tabs.filter((t) => t.path !== victim.path);
      }
      tab = { path, text, saved: text };
      tabs.push(tab);
    }
    activePath = path;
    pushRecent(path);
    persistWs();
    renderTabs();
    renderList();
    syncCodeFromTab();
    if (opts.run) runFile(path);
    if (graphMode) drawGraph(false);
    setStatus(path);
  }

  async function closeTab(path) {
    const tab = tabs.find((t) => t.path === path);
    if (tab && tab.text !== tab.saved && !confirm("Discard unsaved changes in " + basename(path) + "?")) return;
    tabs = tabs.filter((t) => t.path !== path);
    if (activePath === path) activePath = tabs.length ? tabs[tabs.length - 1].path : "";
    persistWs();
    renderTabs();
    syncCodeFromTab();
    renderList();
  }

  async function closeAll() {
    if (tabs.some((t) => t.text !== t.saved) && !confirm("Close all tabs? Unsaved changes will be lost.")) return;
    tabs = [];
    activePath = "";
    persistWs();
    renderTabs();
    syncCodeFromTab();
  }

  function onCodeInput() {
    const t = activeTab();
    if (!t) return;
    t.text = els.code.value;
    if (els.save) els.save.disabled = t.text === t.saved;
    renderTabs();
    updateCursorPos();
  }

  async function saveFile() {
    const b = brain();
    const t = activeTab();
    if (!b || !t) return;
    await b.writeFile(t.path, t.text);
    t.saved = t.text;
    if (els.save) els.save.disabled = true;
    renderTabs();
    setStatus("Saved · " + t.path);
  }

  async function saveAll() {
    const b = brain();
    if (!b) return;
    for (const t of tabs) {
      if (t.text !== t.saved) {
        await b.writeFile(t.path, t.text);
        t.saved = t.text;
      }
    }
    renderTabs();
    syncCodeFromTab();
    setStatus("Saved all");
  }

  function formatSoft() {
    const t = activeTab();
    if (!t) return;
    t.text = t.text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
    els.code.value = t.text;
    renderTabs();
  }

  function showFind(on) {
    if (!els.findbar) return;
    els.findbar.hidden = !on;
    if (on) {
      const sel = els.code?.value?.slice(els.code.selectionStart, els.code.selectionEnd) || "";
      if (sel && !sel.includes("\n") && sel.length < 80) els.findInput.value = sel;
      els.findInput.focus();
      els.findInput.select();
      findPos = 0;
      updateFindCount();
    } else if (els.findCount) els.findCount.textContent = "";
  }

  function findMatches(q) {
    if (!q) return [];
    const v = els.code.value || "";
    const caseOn = !!els.findCase?.checked;
    const hay = caseOn ? v : v.toLowerCase();
    const needle = caseOn ? q : q.toLowerCase();
    const out = [];
    let from = 0;
    while (from <= hay.length) {
      const i = hay.indexOf(needle, from);
      if (i < 0) break;
      out.push(i);
      from = i + Math.max(1, needle.length);
    }
    return out;
  }

  function updateFindCount() {
    if (!els.findCount) return;
    const q = els.findInput?.value || "";
    if (!q) { els.findCount.textContent = ""; return; }
    const matches = findMatches(q);
    if (!matches.length) { els.findCount.textContent = "0"; return; }
    const cur = els.code.selectionStart;
    let idx = matches.findIndex((i) => i >= cur);
    if (idx < 0) idx = 0;
    if (matches.includes(cur) || (els.code.selectionEnd - cur === q.length && matches.includes(cur))) {
      idx = matches.indexOf(cur);
    }
    els.findCount.textContent = `${idx + 1}/${matches.length}`;
  }

  function findStep(dir) {
    const q = els.findInput?.value || "";
    if (!q) return;
    const matches = findMatches(q);
    if (!matches.length) { setStatus("Not found"); if (els.findCount) els.findCount.textContent = "0"; return; }
    const cur = els.code.selectionStart;
    let idx;
    if (dir > 0) {
      idx = matches.findIndex((i) => i > cur || (i === cur && els.code.selectionEnd === cur));
      if (idx < 0) idx = 0;
      if (matches[idx] === cur && els.code.selectionEnd === cur + q.length) {
        idx = (idx + 1) % matches.length;
      }
    } else {
      idx = -1;
      for (let i = matches.length - 1; i >= 0; i--) {
        if (matches[i] < cur) { idx = i; break; }
      }
      if (idx < 0) idx = matches.length - 1;
    }
    const i = matches[idx];
    els.code.focus();
    els.code.setSelectionRange(i, i + q.length);
    findPos = i + q.length;
    if (els.findCount) els.findCount.textContent = `${idx + 1}/${matches.length}`;
    updateCursorPos();
  }

  function findNext() { findStep(1); }
  function findPrev() { findStep(-1); }

  function replaceOne() {
    const q = els.findInput?.value || "";
    const rep = els.replaceInput?.value ?? "";
    if (!q) return;
    const start = els.code.selectionStart;
    const end = els.code.selectionEnd;
    const sel = els.code.value.slice(start, end);
    const caseOn = !!els.findCase?.checked;
    const hit = caseOn ? sel === q : sel.toLowerCase() === q.toLowerCase();
    if (hit) {
      const v = els.code.value;
      els.code.value = v.slice(0, start) + rep + v.slice(end);
      els.code.setSelectionRange(start, start + rep.length);
      onCodeInput();
    }
    findNext();
  }

  function replaceAll() {
    const q = els.findInput?.value || "";
    const rep = els.replaceInput?.value ?? "";
    if (!q) return;
    const matches = findMatches(q);
    if (!matches.length) { setStatus("Not found"); return; }
    const v = els.code.value;
    let out = "";
    let last = 0;
    for (const i of matches) {
      out += v.slice(last, i) + rep;
      last = i + q.length;
    }
    out += v.slice(last);
    els.code.value = out;
    onCodeInput();
    if (els.findCount) els.findCount.textContent = `0/${matches.length}`;
    setStatus(`Replaced ${matches.length}`);
  }

  function gotoLine() {
    const n = prompt("Go to line");
    const line = Number(n);
    if (!line || line < 1) return;
    const parts = els.code.value.split("\n");
    let pos = 0;
    for (let i = 0; i < Math.min(line - 1, parts.length); i++) pos += parts[i].length + 1;
    els.code.focus();
    els.code.setSelectionRange(pos, pos);
    updateCursorPos();
  }

  function pinCurrent() {
    if (!activePath) return;
    const list = pins();
    if (!list.includes(activePath)) setPins([activePath, ...list]);
    else setStatus("Already pinned");
    renderList();
  }

  /* ---- Bottom panels (helper lives here, not on the right) ---- */
  function showBottomPanel(name) {
    if (!name) return;
    layoutState.bottom = true;
    els.center?.classList.remove("is-bottom-collapsed");
    els.bottom?.classList.remove("is-collapsed");
    document.querySelectorAll(".ed-bottom-tabs button[data-panel]").forEach((btn) => {
      btn.classList.toggle("is-on", btn.getAttribute("data-panel") === name);
    });
    // Hide every bottom pane, then show the requested one explicitly
    document.querySelectorAll(".ed-bottom-body[data-panel], .ed-bottom > .ed-out[data-panel], .ed-term-wrap[data-panel]").forEach((el) => {
      el.hidden = true;
      el.classList.remove("is-on");
    });
    const panel =
      name === "term" ? (els.termWrap || document.getElementById("edTermWrap"))
      : name === "out" ? els.out
      : name === "problems" ? els.problems
      : document.querySelector(`.ed-bottom-body[data-panel="${name}"]`);
    if (panel) {
      panel.hidden = false;
      panel.classList.add("is-on");
    }
    if (name === "memory") renderMemory();
    if (name === "brain") { syncControlForm(); renderPins(); loadDevices(); }
    if (name === "helper") els.prompt?.focus?.();
    if (name === "term") {
      ensureTermBoot();
      // keep bottom tall enough that the input row is visible
      const h = parseFloat(getComputedStyle(els.shell || document.documentElement).getPropertyValue("--bottom-h")) || 0;
      if (h < 200 && els.shell) {
        els.shell.style.setProperty("--bottom-h", "260px");
        layoutState.bottomH = 260;
        persistLayout();
      }
      requestAnimationFrame(() => {
        els.termInput?.focus?.();
        els.termForm?.scrollIntoView?.({ block: "nearest" });
      });
    }
  }

  const TERM_BOOT_HTML = `<div class="ed-term-boot"><strong>PC shell · commands run on your machine</strong>Builtins: help · clear · ls · open &lt;file&gt; · run · where · pwd<br>Anything else is bash on This PC / Private.</div>`;

  let termHistory = [];
  let termHistIdx = -1;
  let termBusy = false;

  function setTermLive(state) {
    if (els.termLive) els.termLive.textContent = state;
    els.termWrap?.classList.toggle("is-busy", state === "busy");
  }

  function ensureTermBoot() {
    if (!els.term) return;
    if (!els.term.dataset.booted) {
      els.term.innerHTML = TERM_BOOT_HTML;
      els.term.dataset.booted = "1";
    }
  }

  function termLine(kind, text, { prefix } = {}) {
    ensureTermBoot();
    if (!els.term) return;
    const line = document.createElement("div");
    line.className = `ed-term-line is-${kind || "out"}`;
    if (prefix) {
      const p = document.createElement("span");
      p.className = "ed-term-prefix";
      p.textContent = prefix;
      line.appendChild(p);
    }
    line.appendChild(document.createTextNode(String(text ?? "")));
    els.term.appendChild(line);
    els.term.scrollTop = els.term.scrollHeight;
  }

  function appendTerm(line) {
    const stamp = new Date().toLocaleTimeString();
    termLine("meta", `[${stamp}] ${line}`);
  }

  function termWrite(text, { kind = "out" } = {}) {
    ensureTermBoot();
    if (!els.term) return;
    const raw = String(text ?? "");
    String(raw).split("\n").forEach((part) => termLine(kind, part));
  }

  function termBuiltin(cmd, args) {
    const c = ctrl();
    if (cmd === "help" || cmd === "?") {
      termWrite(`help     this text
clear    clear scrollback
ls       list Second Brain files
pwd      active file / workspace
open p   open path in editor
run      run current file
where    show Where routing
<cmd>    run shell on your PC via bash`, { kind: "meta" });
      return true;
    }
    if (cmd === "clear" || cmd === "cls") {
      if (els.term) {
        els.term.innerHTML = TERM_BOOT_HTML;
        els.term.dataset.booted = "1";
      }
      return true;
    }
    if (cmd === "where") {
      termWrite(`where=${c.where || "pc"} · device=${c.deviceId || "(default)"} · autoSave=${c.autoSave !== false}`, { kind: "meta" });
      return true;
    }
    if (cmd === "pwd") {
      const st = brain()?.getStatus?.() || {};
      termWrite(activePath || st.rootLabel || st.label || "(no file · File → Open Folder)", { kind: "ok" });
      return true;
    }
    if (cmd === "ls" || cmd === "dir") {
      const files = brain()?.listFiles?.() || [];
      if (!files.length) {
        termWrite("Second Brain empty · File → Open Folder", { kind: "err" });
        return true;
      }
      const q = (args[0] || "").toLowerCase();
      const rows = files.filter((f) => !q || String(f.path).toLowerCase().includes(q)).slice(0, 200);
      termWrite(rows.map((f) => f.path).join("\n") + (files.length > rows.length ? `\n… ${files.length - rows.length} more` : ""), { kind: "out" });
      return true;
    }
    if (cmd === "open" || cmd === "ed") {
      const path = args.join(" ").trim();
      if (!path) { termWrite("usage: open <path>", { kind: "err" }); return true; }
      const files = brain()?.listFiles?.() || [];
      const hit = files.find((f) => f.path === path)
        || files.find((f) => f.path.endsWith("/" + path) || basename(f.path) === path);
      if (!hit) { termWrite("not found: " + path, { kind: "err" }); return true; }
      openFile(hit.path);
      termWrite("opened " + hit.path, { kind: "ok" });
      return true;
    }
    if (cmd === "run") {
      if (!activePath) { termWrite("no active file", { kind: "err" }); return true; }
      termWrite("running " + activePath + " …", { kind: "meta" });
      runFile(activePath, { keepTerm: true });
      return true;
    }
    return false;
  }

  async function runTermCommand(raw) {
    const line = String(raw || "").trim();
    if (!line) return;
    termHistory.push(line);
    if (termHistory.length > 80) termHistory.shift();
    termHistIdx = termHistory.length;
    termLine("cmd", line, { prefix: "›" });

    const parts = line.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((p) => p.replace(/^"|"$/g, "")) || [line];
    const cmd = (parts[0] || "").toLowerCase();
    const args = parts.slice(1);
    if (termBuiltin(cmd, args)) return;

    if (termBusy) {
      termWrite("busy · wait for the current command", { kind: "err" });
      return;
    }
    const c = ctrl();
    if (c.where === "brain") {
      termWrite("Where=brain · shell disabled · switch Brain / Where → This PC", { kind: "err" });
      showBottomPanel("brain");
      return;
    }
    termBusy = true;
    setTermLive("busy");
    if (els.termPrompt) els.termPrompt.textContent = "…";
    setStatus("Terminal · running on PC");
    const source = `#!/usr/bin/env bash
# Noeti editor terminal one-shot
set +e
${line}
`;
    try {
      const res = await fetch("/api/canvas/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          lang: "bash",
          source,
          input: "",
          timeout: Number(els.timeout?.value || 25),
          where: c.where === "server" ? "server" : "pc",
          device_id: c.deviceId || undefined,
          prefer_device: c.where !== "server",
          meta: { surface: "editor-terminal", cwd: activePath || "" },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.need_device) {
        termWrite(String(data.message || "Connect your PC first (Brain → Connect PC / Canvas → PC)."), { kind: "err" });
        showBottomPanel("brain");
        setStatus("Need PC agent");
        return;
      }
      const out = String(data.output ?? data.stdout ?? data.stderr ?? data.message ?? "").trimEnd();
      if (out) termWrite(out, { kind: data.ok === false ? "err" : "out" });
      else termWrite(data.ok ? "(no output)" : "✗ " + (data.message || "failed"), { kind: data.ok ? "meta" : "err" });
      if (!data.ok && data.explain) termWrite("explain: " + data.explain, { kind: "meta" });
      setStatus(data.ok ? "Terminal · ok" : "Terminal · fail");
    } catch (err) {
      termWrite("error: " + (err.message || err), { kind: "err" });
      setStatus("Terminal · error");
    } finally {
      termBusy = false;
      setTermLive("idle");
      if (els.termPrompt) els.termPrompt.textContent = "›";
    }
  }

  function showSide(name) {
    const map = { helper: "helper", memory: "memory", brain: "brain", control: "brain", run: "run" };
    showBottomPanel(map[name] || name);
  }

  /* ---- Resizable / reorganizable panes ---- */
  function loadLayoutState() {
    const L = loadJson(LAYOUT_KEY, {});
    layoutState = { ...layoutState, ...L };
    // migrate v1
    if (!L.preset && (L.leftW || L.bottomH)) layoutState.preset = "default";
    // Memory/FS graph as main view was sticky — default back to code
    if (layoutState.viewMode === "graph") {
      layoutState.viewMode = "code";
      layoutState.preset = layoutState.preset === "custom" ? "custom" : "default";
    }
    // Old "helper docked right" → dedicated coding chat on the right
    if (L.helperDock === "right" && L.chatRight == null) {
      layoutState.chatRight = true;
      layoutState.helperDock = "bottom";
    }
    if (layoutState.chatRight == null) layoutState.chatRight = true;
  }

  function applyLayout(layout) {
    if (layout) layoutState = { ...layoutState, ...layout };
    else loadLayoutState();
    const L = layoutState;
    if (!els.shell) return;

    els.shell.style.setProperty("--left-w", `${Math.round(L.leftW || 300)}px`);
    els.shell.style.setProperty("--left-graph-h", `${Math.round(L.leftGraphH || 58)}%`);
    els.shell.style.setProperty("--bottom-h", `${Math.round(L.bottomH || 240)}px`);
    els.shell.style.setProperty("--right-w", `${Math.round(L.rightW || 340)}px`);
    els.shell.style.setProperty("--view-split", `${Math.round(L.viewSplit || 48)}%`);

    els.shell.classList.toggle("is-no-explorer", L.explorer === false);
    els.shell.classList.toggle("is-no-fs", L.fs === false);
    els.shell.classList.toggle("is-explorer-right", L.explorerSide === "right");
    els.shell.classList.toggle("is-chat-right", L.chatRight !== false);
    els.shell.classList.remove("is-helper-right");
    els.center?.classList.toggle("is-bottom-collapsed", L.bottom === false);

    // Bottom panes stay in the center; chat is its own right dock
    placeBottomDock(false);
    applyTabOrder(L.tabOrder);

    if (L.viewMode === "split") setViewMode("split");
    else if (L.viewMode === "graph") setViewMode("graph");
    else {
      layoutState.viewMode = "code";
      showGraph(false);
    }

    syncLayoutChrome();
    requestAnimationFrame(() => {
      drawMini(true);
      if (graphMode || layoutState.viewMode === "split") drawGraph(true);
    });
  }

  function persistLayout() {
    if (!els.shell) return;
    const cs = getComputedStyle(els.shell);
    layoutState.leftW = parseFloat(cs.getPropertyValue("--left-w")) || layoutState.leftW;
    layoutState.leftGraphH = parseFloat(cs.getPropertyValue("--left-graph-h")) || layoutState.leftGraphH;
    layoutState.bottomH = parseFloat(cs.getPropertyValue("--bottom-h")) || layoutState.bottomH;
    layoutState.rightW = parseFloat(cs.getPropertyValue("--right-w")) || layoutState.rightW;
    layoutState.viewSplit = parseFloat(cs.getPropertyValue("--view-split")) || layoutState.viewSplit;
    layoutState.explorer = !els.shell.classList.contains("is-no-explorer");
    layoutState.fs = !els.shell.classList.contains("is-no-fs");
    layoutState.explorerSide = els.shell.classList.contains("is-explorer-right") ? "right" : "left";
    layoutState.chatRight = els.shell.classList.contains("is-chat-right");
    layoutState.helperDock = "bottom";
    layoutState.bottom = !els.center?.classList.contains("is-bottom-collapsed");
    saveJson(LAYOUT_KEY, layoutState);
    syncLayoutChrome();
  }

  function syncLayoutChrome() {
    const preset = layoutState.preset || "default";
    document.querySelectorAll("[data-layout]").forEach((btn) => {
      btn.classList.toggle("is-on", btn.getAttribute("data-layout") === preset);
    });
    document.querySelectorAll("[data-layout-toggle]").forEach((btn) => {
      const t = btn.getAttribute("data-layout-toggle");
      let on = false;
      if (t === "explorer") on = layoutState.explorer !== false;
      if (t === "bottom") on = layoutState.bottom !== false;
      if (t === "fs") on = layoutState.fs !== false;
      if (t === "chat") on = layoutState.chatRight !== false;
      if (t === "explorer-side") on = layoutState.explorerSide === "right";
      btn.classList.toggle("is-on", on);
    });
  }

  function placeBottomDock(toRight) {
    if (!els.bottom || !els.center) return;
    if (toRight && els.rightBody) {
      if (els.bottom.parentElement !== els.rightBody) els.rightBody.appendChild(els.bottom);
      if (els.right) { els.right.hidden = false; }
      if (els.splitRight) els.splitRight.hidden = false;
      els.center.classList.add("is-bottom-moved");
      els.center.classList.remove("is-bottom-collapsed");
      if (els.right) {
        const title = els.right.querySelector("#edRightTitle");
        if (title) title.textContent = "Bottom dock";
      }
    } else {
      if (els.splitBottom && els.bottom.parentElement !== els.center) {
        els.splitBottom.after(els.bottom);
      }
      if (els.right) els.right.hidden = true;
      if (els.splitRight) els.splitRight.hidden = true;
      els.center.classList.remove("is-bottom-moved");
    }
  }

  function applyTabOrder(order) {
    const tabs = els.bottomTabs || document.getElementById("edBottomTabs");
    if (!tabs || !order?.length) return;
    const toggle = tabs.querySelector("#edBottomToggle");
    order.forEach((id) => {
      const btn = tabs.querySelector(`button[data-panel="${id}"]`);
      if (btn) tabs.insertBefore(btn, toggle || null);
    });
  }

  function applyPreset(name) {
    layoutState.preset = name;
    if (name === "default") {
      layoutState.explorer = true;
      layoutState.bottom = true;
      layoutState.fs = true;
      layoutState.helperDock = "bottom";
      layoutState.chatRight = true;
      layoutState.viewMode = "code";
      layoutState.bottomH = 240;
      layoutState.leftGraphH = 58;
      layoutState.rightW = 340;
    } else if (name === "code") {
      layoutState.explorer = true;
      layoutState.bottom = false;
      layoutState.fs = false;
      layoutState.helperDock = "bottom";
      layoutState.chatRight = true;
      layoutState.viewMode = "code";
      layoutState.leftW = 240;
      layoutState.rightW = 320;
    } else if (name === "split") {
      layoutState.explorer = true;
      layoutState.bottom = true;
      layoutState.fs = true;
      layoutState.helperDock = "bottom";
      layoutState.chatRight = true;
      layoutState.viewMode = "split";
      layoutState.bottomH = 200;
      graphKind = "fs";
    } else if (name === "term") {
      layoutState.explorer = true;
      layoutState.bottom = true;
      layoutState.fs = true;
      layoutState.helperDock = "bottom";
      layoutState.chatRight = false;
      layoutState.viewMode = "code";
      layoutState.bottomH = 360;
    } else if (name === "helper-right" || name === "chat") {
      layoutState.explorer = true;
      layoutState.bottom = true;
      layoutState.fs = true;
      layoutState.helperDock = "bottom";
      layoutState.chatRight = true;
      layoutState.viewMode = "code";
      layoutState.rightW = 360;
      layoutState.preset = "helper-right";
    }
    applyLayout(layoutState);
    persistLayout();
    if (name === "term") showBottomPanel("term");
    if (name === "helper-right" || name === "chat") {
      els.chatIn?.focus?.();
      setStatus("Coding chat · right");
    } else {
      setStatus("Layout · " + name);
    }
  }

  function resetLayoutSizes() {
    layoutState.leftW = 300;
    layoutState.leftGraphH = 58;
    layoutState.bottomH = 240;
    layoutState.rightW = 340;
    layoutState.viewSplit = 48;
    applyLayout(layoutState);
    persistLayout();
    setStatus("Pane sizes reset");
  }

  function bindSplitter(el, onMove, onReset) {
    if (!el) return;
    el.addEventListener("pointerdown", (e) => {
      if (e.detail >= 2) return;
      e.preventDefault();
      el.classList.add("is-drag");
      document.body.classList.add("ed-resizing");
      el.setPointerCapture?.(e.pointerId);
      const move = (ev) => onMove(ev);
      const up = () => {
        el.classList.remove("is-drag");
        document.body.classList.remove("ed-resizing");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        persistLayout();
        drawMini(false);
        if (graphMode || layoutState.viewMode === "split") drawGraph(false);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      onMove(e);
    });
    el.addEventListener("dblclick", (e) => {
      e.preventDefault();
      onReset?.();
      persistLayout();
      drawMini(true);
      if (graphMode || layoutState.viewMode === "split") drawGraph(true);
      setStatus("Pane reset");
    });
  }

  function expandLeftGraph(alsoCenter) {
    if (els.shell) els.shell.style.setProperty("--left-graph-h", "68%");
    layoutState.leftGraphH = 68;
    persistLayout();
    drawMini(true);
    if (alsoCenter) {
      graphKind = "fs";
      setViewMode("split");
    }
  }

  function bindBottomTabReorder() {
    const tabs = els.bottomTabs || document.getElementById("edBottomTabs");
    if (!tabs) return;
    let dragId = null;
    tabs.querySelectorAll("button[data-panel][draggable]").forEach((btn) => {
      btn.addEventListener("dragstart", (e) => {
        dragId = btn.getAttribute("data-panel");
        e.dataTransfer?.setData("text/plain", dragId || "");
        btn.classList.add("is-dragging");
      });
      btn.addEventListener("dragend", () => {
        btn.classList.remove("is-dragging");
        tabs.querySelectorAll(".is-drag-over").forEach((x) => x.classList.remove("is-drag-over"));
        dragId = null;
      });
      btn.addEventListener("dragover", (e) => {
        e.preventDefault();
        btn.classList.add("is-drag-over");
      });
      btn.addEventListener("dragleave", () => btn.classList.remove("is-drag-over"));
      btn.addEventListener("drop", (e) => {
        e.preventDefault();
        btn.classList.remove("is-drag-over");
        const from = dragId || e.dataTransfer?.getData("text/plain");
        const to = btn.getAttribute("data-panel");
        if (!from || !to || from === to) return;
        const order = [...tabs.querySelectorAll("button[data-panel]")].map((b) => b.getAttribute("data-panel"));
        const fi = order.indexOf(from);
        const ti = order.indexOf(to);
        if (fi < 0 || ti < 0) return;
        order.splice(fi, 1);
        order.splice(ti, 0, from);
        layoutState.tabOrder = order;
        applyTabOrder(order);
        persistLayout();
      });
    });
  }

  /* ---- Run ---- */
  function cacheRun(entry) {
    const runs = loadJson(RUN_CACHE_KEY, []);
    runs.unshift(entry);
    saveJson(RUN_CACHE_KEY, runs.slice(0, MAX_RUNS));
  }

  async function runFile(path, opts = {}) {
    const b = brain();
    const c = ctrl();
    if (c.where === "brain") {
      setStatus("Where=brain · run disabled");
      showSide("control");
      return;
    }
    const target = path || activePath;
    if (!target) { setStatus("No file to run"); return; }
    let source = "";
    const tab = tabs.find((t) => t.path === target);
    if (tab) source = tab.text;
    else if (b) source = (await b.readFile(target)) || "";
    if (!source.trim()) { setStatus("Empty file"); return; }

    if (c.autoSave !== false && tab && b) {
      await b.writeFile(target, tab.text);
      tab.saved = tab.text;
      renderTabs();
    }

    const lang = (els.lang?.value || langOf(target)).trim();
    const stdin = els.stdin?.value || "";
    const timeout = Number(els.timeout?.value || 25);
    busy = true;
    if (els.run) els.run.disabled = true;
    if (els.run2) els.run2.disabled = true;
    if (els.stop) els.stop.disabled = false;
    if (!opts.keepTerm) showBottomPanel("out");
    setStatus("Running on PC · " + basename(target));
    appendTerm(`run ${lang} ${target} where=${c.where}`);
    els.out.textContent = `▶ ${lang} · ${target}\nWhere · your PC\n…\n`;
    if (opts.keepTerm) termWrite(`▶ ${lang} · ${target}`);

    runAbort = new AbortController();
    const t0 = performance.now();
    try {
      const res = await fetch("/api/canvas/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        signal: runAbort.signal,
        body: JSON.stringify({
          lang, source, input: stdin, timeout,
          where: c.where === "server" ? "server" : "pc",
          device_id: c.deviceId || undefined,
          prefer_device: c.where !== "server",
          meta: { path: target, surface: "editor", where: c.where },
        }),
      });
      const data = await res.json().catch(() => ({}));
      const ms = Math.round(performance.now() - t0);
      const ok = !!data.ok;
      if (data.need_device) {
        els.out.textContent = `✗ Connect your PC\n\n${data.message || ""}\n\n${data.explain || "Canvas → PC → run the agent on this computer."}`;
        showSide("control");
        appendTerm("need device agent");
        setStatus("Need PC agent");
        return;
      }
      const output = data.output ?? data.stdout ?? data.message ?? JSON.stringify(data, null, 2);
      const explain = data.explain ? `\n\nexplain: ${data.explain}` : "";
      const metrics = data.metrics ? `\nmetrics: ${JSON.stringify(data.metrics)}` : "";
      const whereLine = data.where ? `\nwhere: ${data.where}` : "";
      els.out.textContent = `${ok ? "✓" : "✗"} ${lang} · ${ms}ms · ${target}${whereLine}\n\n${output}${explain}${metrics}`;
      if (opts.keepTerm) termWrite(`${ok ? "✓" : "✗"} ${ms}ms\n${String(output).slice(0, 8000)}`);
      if (!ok) {
        renderProblems(String(data.message || data.stderr || output || "Run failed"));
        if (!opts.keepTerm) showBottomPanel("problems");
      }
      appendTerm(`${ok ? "ok" : "fail"} ${ms}ms · ${data.where || c.where}`);
      cacheRun({ at: Date.now(), path: target, lang, ok, ms, output: String(output).slice(0, 4000), where: data.where || c.where });
      setStatus((ok ? "OK" : "Fail") + " · " + ms + "ms · " + (data.where || "PC"));
      renderMemory();
      updateStatusbar();
    } catch (err) {
      if (err.name === "AbortError") {
        els.out.textContent = "■ Stopped";
        appendTerm("stopped");
        setStatus("Stopped");
      } else {
        els.out.textContent = "Error: " + (err.message || err);
        els.problems.textContent = String(err.message || err);
        showBottomPanel("problems");
        setStatus("Error");
      }
    } finally {
      busy = false;
      if (els.run) els.run.disabled = false;
      if (els.run2) els.run2.disabled = false;
      if (els.stop) els.stop.disabled = true;
      runAbort = null;
    }
  }

  function stopRun() { try { runAbort?.abort(); } catch (_) {} }

  function renderProblems(text) {
    if (!els.problems) return;
    const raw = String(text || "");
    const lines = raw.split("\n");
    const re = /(?:^|\s)(?:File\s+".*?",\s+line\s+(\d+)|:(\d+):(?:\d+:)?|\bline\s+(\d+)\b)/i;
    let html = "";
    let any = false;
    for (const line of lines) {
      const m = line.match(re);
      const ln = m ? Number(m[1] || m[2] || m[3]) : 0;
      if (ln > 0) {
        any = true;
        html += `<button type="button" class="ed-prob-line" data-line="${ln}">${escapeHtml(line)}</button>\n`;
      } else {
        html += `${escapeHtml(line)}\n`;
      }
    }
    if (any) {
      els.problems.innerHTML = html.trim() || escapeHtml(raw);
      els.problems.querySelectorAll("[data-line]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const n = Number(btn.getAttribute("data-line"));
          if (!n) return;
          const parts = els.code.value.split("\n");
          let pos = 0;
          for (let i = 0; i < Math.min(n - 1, parts.length); i++) pos += parts[i].length + 1;
          const end = pos + (parts[n - 1]?.length || 0);
          els.code.focus();
          els.code.setSelectionRange(pos, end);
          updateCursorPos();
          showBottomPanel("out");
          setStatus(`Line ${n}`);
        });
      });
    } else {
      els.problems.textContent = raw;
    }
  }

  async function runHotNodes() {
    const files = (brain()?.listFiles?.() || []).filter((f) => runnable(f.path)).slice(0, 5);
    if (!files.length) { setStatus("No runnable files"); return; }
    showBottomPanel("term");
    for (const f of files) {
      await openFile(f.path);
      await runFile(f.path);
    }
  }

  /* ---- Graphs ---- */
  function graphNodesFs() {
    const files = brain()?.listFiles?.() || [];
    const dirs = new Map();
    const nodes = [];
    const links = [];
    function ensureDir(path) {
      if (!path) path = "·";
      if (dirs.has(path)) return dirs.get(path);
      const n = { id: "d:" + path, path, label: path === "·" ? "root" : basename(path), kind: "dir", x: 0, y: 0, vx: 0, vy: 0 };
      dirs.set(path, n); nodes.push(n); return n;
    }
    const root = ensureDir("·");
    for (const f of files) {
      const parts = f.path.split("/");
      let parent = root; let acc = "";
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? acc + "/" + parts[i] : parts[i];
        const d = ensureDir(acc);
        if (parent !== d) {
          const key = parent.id + "->" + d.id;
          if (!links.find((l) => l.key === key)) links.push({ key, a: parent, b: d });
        }
        parent = d;
      }
      const fileNode = {
        id: "f:" + f.path, path: f.path, label: basename(f.path), kind: "file",
        run: runnable(f.path), pinned: pins().includes(f.path),
        x: 0, y: 0, vx: 0, vy: 0,
      };
      nodes.push(fileNode);
      links.push({ key: parent.id + "->" + fileNode.id, a: parent, b: fileNode });
    }
    seed(nodes);
    return { nodes, links };
  }

  function graphNodesMemory() {
    const nodes = [];
    const links = [];
    const hub = { id: "mem", path: "", label: "memory", kind: "dir", x: 0, y: 0, vx: 0, vy: 0 };
    nodes.push(hub);
    const runs = loadJson(RUN_CACHE_KEY, []).slice(0, 18);
    const chat = loadJson(CHAT_CACHE_KEY, []).slice(0, 12);
    const pinList = pins();
    pinList.forEach((p, i) => {
      const n = { id: "pin:" + p, path: p, label: "★ " + basename(p), kind: "file", run: runnable(p), pinned: true, x: 0, y: 0, vx: 0, vy: 0 };
      nodes.push(n); links.push({ key: "hub-pin-" + i, a: hub, b: n });
    });
    runs.forEach((r, i) => {
      const n = {
        id: "run:" + i, path: r.path || "", label: `${r.ok ? "✓" : "✗"} ${basename(r.path || "run")}`,
        kind: "run", run: !!r.path && runnable(r.path), x: 0, y: 0, vx: 0, vy: 0,
      };
      nodes.push(n); links.push({ key: "hub-run-" + i, a: hub, b: n });
    });
    chat.forEach((c, i) => {
      const n = {
        id: "chat:" + i, path: c.path || "", label: "h · " + String(c.q || "").slice(0, 18),
        kind: "chat", x: 0, y: 0, vx: 0, vy: 0,
      };
      nodes.push(n); links.push({ key: "hub-chat-" + i, a: hub, b: n });
    });
    seed(nodes);
    return { nodes, links };
  }

  function seed(nodes) {
    const n = nodes.length || 1;
    nodes.forEach((node, i) => {
      const a = (i / n) * Math.PI * 2;
      const b = (i * 0.7) % Math.PI - Math.PI / 2;
      const r = 0.85 + (node.kind === "dir" ? 0.45 : 1.05) * (0.55 + Math.random() * 0.55);
      node.x = Math.cos(a) * Math.cos(b) * r;
      node.y = Math.sin(b) * r * 0.85;
      node.z = Math.sin(a) * Math.cos(b) * r;
      node.vx = 0; node.vy = 0; node.vz = 0;
    });
  }

  function showGraph(on, kind) {
    if (kind) graphKind = kind;
    if (on) showFind(false);
    if (layoutState.viewMode === "split" && on) {
      graphMode = true;
      els.graphWrap.hidden = false;
      els.codeWrap.hidden = false;
      els.views?.classList.add("is-split");
      if (els.splitViews) els.splitViews.hidden = false;
    } else {
      graphMode = !!on;
      if (els.graphWrap) els.graphWrap.hidden = !on;
      if (els.codeWrap) els.codeWrap.hidden = !!on;
      els.views?.classList.remove("is-split");
      if (els.splitViews) els.splitViews.hidden = true;
      if (on) layoutState.viewMode = "graph";
      else layoutState.viewMode = "code";
    }
    if (els.graphLabel) {
      els.graphLabel.textContent = graphKind === "memory"
        ? "3D memory · Close × to return to code"
        : "3D filesystem · Close × to return to code";
    }
    if (graphMode || layoutState.viewMode === "split") {
      graphState = null;
      drawGraph(true);
    }
    syncLayoutChrome();
    persistLayout();
  }

  function setViewMode(mode) {
    layoutState.viewMode = mode;
    if (mode === "split") {
      showGraph(true, graphKind || "fs");
    } else if (mode === "graph") {
      layoutState.viewMode = "graph";
      showGraph(true, graphKind || "memory");
    } else {
      layoutState.viewMode = "code";
      showGraph(false);
    }
  }

  function paintGraphScene(canvas, stateRef, kind, opts) {
    const canvasEl = canvas;
    if (!canvasEl) return null;
    const reset = !!opts?.reset;
    const interactive = opts?.interactive !== false;
    const ctx = canvasEl.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvasEl.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    if (w < 2 || h < 2) return stateRef;
    canvasEl.width = Math.floor(w * dpr);
    canvasEl.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let g = stateRef;
    if (reset || !g) {
      const built = kind === "memory" ? graphNodesMemory() : graphNodesFs();
      g = {
        ...built,
        camX: 0, camY: 0,
        scale: opts?.scale || (kind === "fs" && opts?.mini ? 1.45 : 1.35),
        yaw: opts?.mini ? 0.75 : 0.55,
        pitch: opts?.mini ? 0.38 : 0.32,
        pan: null, orbit: null,
        autoSpin: true,
        mini: !!opts?.mini,
      };
      if (opts?.onEmpty) opts.onEmpty(built.nodes.length <= 1);
    }
    if (g.autoSpin && !g.orbit && !g.pan) g.yaw += opts?.mini ? 0.006 : 0.004;

    const iters = opts?.mini ? 6 : 10;
    for (let iter = 0; iter < iters; iter++) {
      for (const n of g.nodes) {
        n.vx *= 0.86; n.vy *= 0.86; n.vz *= 0.86;
        n.vx -= n.x * 0.008; n.vy -= n.y * 0.008; n.vz -= n.z * 0.008;
      }
      for (let i = 0; i < g.nodes.length; i++) {
        for (let j = i + 1; j < g.nodes.length; j++) {
          const a = g.nodes[i]; const b = g.nodes[j];
          let dx = b.x - a.x; let dy = b.y - a.y; let dz = b.z - a.z;
          let dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
          const min = a.kind === "dir" || b.kind === "dir" ? 0.48 : 0.32;
          if (dist < min) {
            const f = ((min - dist) / dist) * 0.08;
            dx *= f; dy *= f; dz *= f;
            a.vx -= dx; a.vy -= dy; a.vz -= dz;
            b.vx += dx; b.vy += dy; b.vz += dz;
          }
        }
      }
      for (const l of g.links) {
        const dx = l.b.x - l.a.x; const dy = l.b.y - l.a.y; const dz = l.b.z - l.a.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
        const ideal = l.b.kind === "file" ? 0.55 : 0.72;
        const f = ((dist - ideal) / dist) * 0.02;
        l.a.vx += dx * f; l.a.vy += dy * f; l.a.vz += dz * f;
        l.b.vx -= dx * f; l.b.vy -= dy * f; l.b.vz -= dz * f;
      }
      for (const n of g.nodes) {
        n.x += n.vx; n.y += n.vy; n.z += n.vz;
      }
    }

    const projected = g.nodes.map((n) => ({ n, p: project3(n, g, w, h) }));
    projected.sort((a, b) => a.p.depth - b.p.depth);

    const dark = document.documentElement.getAttribute("data-theme") === "black"
      || document.body?.getAttribute("data-theme") === "black";
    ctx.clearRect(0, 0, w, h);
    if (opts?.mini) {
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, dark ? "#0e1218" : "#f7f7f5");
      bg.addColorStop(1, dark ? "#090c11" : "#efefed");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = dark ? "rgba(148,163,184,0.06)" : "rgba(17,17,17,0.04)";
      ctx.lineWidth = 1;
      for (let y = 16; y < h; y += 16) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
    } else {
      const grd = ctx.createRadialGradient(w * 0.5, h * 0.5, 40, w * 0.5, h * 0.5, Math.min(w, h) * 0.55);
      grd.addColorStop(0, dark ? "rgba(45,212,191,0.04)" : "rgba(255,255,255,0)");
      grd.addColorStop(1, dark ? "rgba(7,9,13,0.75)" : "rgba(247,247,245,0.55)");
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, w, h);
    }

    for (const l of g.links) {
      const a = project3(l.a, g, w, h);
      const b = project3(l.b, g, w, h);
      const alpha = Math.max(0.05, Math.min(0.28, 0.32 - (a.depth + b.depth) * 0.05));
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.strokeStyle = dark ? `rgba(148,163,184,${alpha + 0.08})` : `rgba(17,17,17,${alpha})`;
      ctx.lineWidth = opts?.mini ? 0.9 : 1;
      ctx.stroke();
    }

    for (const { n, p } of projected) {
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, opts?.mini ? p.r * 0.9 : p.r, 0, Math.PI * 2);
      if (dark) {
        if (n.path === activePath) ctx.fillStyle = "#5eead4";
        else if (n.pinned) ctx.fillStyle = "#2dd4bf";
        else if (n.kind === "dir") ctx.fillStyle = "#94a3b8";
        else if (n.kind === "run") ctx.fillStyle = "#64748b";
        else if (n.kind === "chat") ctx.fillStyle = "#475569";
        else if (n.run) ctx.fillStyle = "#38bdf8";
        else ctx.fillStyle = "#334155";
      } else if (n.path === activePath) ctx.fillStyle = "#111";
      else if (n.pinned) ctx.fillStyle = "#3a3a3a";
      else if (n.kind === "dir") ctx.fillStyle = "#6e6e6e";
      else if (n.kind === "run") ctx.fillStyle = "#555";
      else if (n.kind === "chat") ctx.fillStyle = "#aaa";
      else if (n.run) ctx.fillStyle = "#2a2a2a";
      else ctx.fillStyle = "#b5b5b5";
      ctx.fill();
      if (n.path === activePath) {
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, (opts?.mini ? p.r * 0.9 : p.r) + 3, 0, Math.PI * 2);
        ctx.strokeStyle = dark ? "rgba(94,234,212,0.45)" : "rgba(17,17,17,0.35)";
        ctx.stroke();
      }
      const labelDepth = opts?.mini ? 3.2 : 3.4;
      const showLabel = interactive && p.depth < labelDepth && (
        n.kind === "dir" || n.path === activePath || n.pinned || n.run || !opts?.mini || projected.length < 48
      );
      if (showLabel) {
        ctx.fillStyle = dark
          ? (n.path === activePath ? "#5eead4" : "rgba(226,232,240,0.82)")
          : (n.path === activePath ? "#111" : "rgba(40,40,40,0.78)");
        ctx.font = `${Math.max(opts?.mini ? 10 : 11, (opts?.mini ? 11 : 13) * (1.35 / Math.max(0.75, p.depth)))}px "IBM Plex Sans", sans-serif`;
        ctx.fillText(n.label, p.sx + p.r + 4, p.sy + 4);
      }
    }

    g._proj = projected;
    return g;
  }

  function drawMini(reset) {
    const empty = document.getElementById("edMiniEmpty");
    miniState = paintGraphScene(els.miniGraph, miniState, "fs", {
      reset,
      mini: true,
      interactive: true,
      onEmpty: (isEmpty) => { if (empty) empty.hidden = !isEmpty; },
    });
    if (!miniRunning) {
      miniRunning = true;
      const tick = () => {
        if (!els.miniGraph || !document.body.contains(els.miniGraph)) { miniRunning = false; return; }
        miniState = paintGraphScene(els.miniGraph, miniState, "fs", { mini: true, interactive: true });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }

  function hitMini(clientX, clientY) {
    if (!miniState?._proj || !els.miniGraph) return null;
    const rect = els.miniGraph.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = null;
    let bestD = 16;
    for (let i = miniState._proj.length - 1; i >= 0; i--) {
      const { n, p } = miniState._proj[i];
      const d = Math.hypot(p.sx - x, p.sy - y);
      if (d < Math.max(bestD, p.r + 4)) { bestD = d; best = n; }
    }
    return best;
  }

  function project3(n, g, w, h) {
    // yaw/pitch camera
    const cy = Math.cos(g.yaw); const sy = Math.sin(g.yaw);
    const cp = Math.cos(g.pitch); const sp = Math.sin(g.pitch);
    let x = n.x * cy - n.z * sy;
    let z = n.x * sy + n.z * cy;
    let y = n.y;
    const y2 = y * cp - z * sp;
    z = y * sp + z * cp;
    y = y2;
    const depth = z + 2.4;
    const fit = optsMiniBoost(g);
    const scale = (Math.min(w, h) * fit * g.scale) / Math.max(0.45, depth);
    return {
      sx: w * 0.5 + g.camX + x * scale,
      sy: h * 0.5 + g.camY + y * scale,
      depth,
      r: Math.max(3.2, (n.kind === "dir" ? 10 : 6.2) * (1.15 / Math.max(0.55, depth)) * g.scale),
    };
  }

  function optsMiniBoost(g) {
    return g?.mini ? 0.72 : 0.62;
  }

  function drawGraph(reset) {
    graphState = paintGraphScene(els.graphCanvas, graphState, graphKind, {
      reset,
      onEmpty: (isEmpty) => { if (els.graphHint) els.graphHint.hidden = !isEmpty; },
    });
    if (graphMode) requestAnimationFrame(() => drawGraph(false));
  }

  function hitGraph(clientX, clientY) {
    if (!graphState?._proj) return null;
    const rect = els.graphCanvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = null;
    let bestD = 18;
    for (let i = graphState._proj.length - 1; i >= 0; i--) {
      const { n, p } = graphState._proj[i];
      const d = Math.hypot(p.sx - x, p.sy - y);
      if (d < Math.max(bestD, p.r + 5)) { bestD = d; best = n; }
    }
    return best;
  }

  /* ---- Memory ---- */
  function renderMemory() {
    const files = brain()?.listFiles?.() || [];
    const bytes = files.reduce((s, f) => s + (f.bytes || 0), 0);
    const runs = loadJson(RUN_CACHE_KEY, []);
    const chat = loadJson(CHAT_CACHE_KEY, []);
    const ws = loadJson(WS_KEY, {});
    els.memStats.innerHTML = [
      `<div><strong>${files.length}</strong> files · ${(bytes / 1024).toFixed(1)} KB brain</div>`,
      `<div><strong>${pins().length}</strong> pins · <strong>${tabs.length}</strong> tabs · <strong>${(ws.recent || []).length}</strong> recent</div>`,
      `<div><strong>${runs.length}</strong> run cache · <strong>${chat.length}</strong> helper cache</div>`,
    ].join("");
    const items = [
      ...pins().map((p) => ({ title: `★ pin · ${basename(p)}`, body: p, at: Date.now() })),
      ...runs.slice(0, 12).map((r) => ({ title: `${r.ok ? "✓" : "✗"} ${basename(r.path)} · ${r.lang} · ${r.ms}ms`, body: (r.output || "").slice(0, 160), at: r.at })),
      ...chat.slice(0, 8).map((c) => ({ title: `helper · ${(c.q || "").slice(0, 40)}`, body: (c.a || "").slice(0, 160), at: c.at })),
    ];
    els.memList.innerHTML = items.length
      ? items.map((it) => `<div class="ed-mem-item"><strong>${escapeHtml(it.title)}</strong><br>${escapeHtml(it.body)}</div>`).join("")
      : `<div class="ed-mem-item">Empty — pin files and run code to fill memory.</div>`;
    updateStatusbar();
  }

  /* ---- Helper ---- */
  function appendMsg(role, text) {
    const div = document.createElement("div");
    div.className = "ed-msg";
    div.innerHTML = `<div class="ed-msg-role">${escapeHtml(role)}</div><div class="ed-msg-body">${formatBody(text)}</div>`;
    els.log.appendChild(div);
    els.log.scrollTop = els.log.scrollHeight;
  }
  function formatBody(text) {
    const raw = String(text || "");
    const parts = [];
    const re = /```[\w.-]*\n?([\s\S]*?)```/g;
    let last = 0; let m;
    while ((m = re.exec(raw))) {
      if (m.index > last) parts.push(escapeHtml(raw.slice(last, m.index)));
      lastCodeBlock = m[1].replace(/\n$/, "");
      parts.push(`<pre>${escapeHtml(lastCodeBlock)}</pre>`);
      last = m.index + m[0].length;
    }
    if (last < raw.length) parts.push(escapeHtml(raw.slice(last)));
    if (lastCodeBlock) els.apply.hidden = false;
    return parts.join("") || escapeHtml(raw);
  }

  async function readSSE(res, onEvent) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const block of parts) {
        const line = block.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try { onEvent(JSON.parse(line.slice(5).trim())); } catch (_) {}
      }
    }
  }

  async function loadModels() {
    try {
      const res = await fetch("/api/chat/models", { cache: "no-store", credentials: "same-origin" });
      const data = await res.json();
      const models = data.models || data || [];
      const ids = (Array.isArray(models) ? models : []).map((m) => typeof m === "string" ? m : m.id || m.name).filter(Boolean);
      if (!ids.length) ids.push("openai/gpt-4o-mini");
      const cur = localStorage.getItem("noeti_editor_model") || ids[0];
      els.model.innerHTML = ids.map((id) => `<option value="${escapeAttr(id)}" ${id === cur ? "selected" : ""}>${escapeHtml(id)}</option>`).join("");
      if (els.modelBtn) els.modelBtn.textContent = (cur.split("/").pop() || cur).slice(0, 18);
    } catch (_) {
      els.model.innerHTML = `<option value="openai/gpt-4o-mini">openai/gpt-4o-mini</option>`;
      if (els.modelBtn) els.modelBtn.textContent = "gpt-4o-mini";
    }
  }

  async function loadLangs() {
    const fallback = ["python", "javascript", "ruby", "bash", "go", "c"];
    try {
      const res = await fetch("/api/canvas/languages", { cache: "no-store", credentials: "same-origin" });
      const data = await res.json();
      const ids = (data.languages || []).map((l) => l.id || l).filter(Boolean);
      const list = (ids.length ? ids : fallback).slice(0, 10);
      els.lang.innerHTML = list.map((id) => `<option value="${escapeAttr(id)}">${escapeHtml(id)}</option>`).join("");
      if (els.langSeg) {
        const cur = els.lang.value || list[0];
        els.langSeg.innerHTML = list.map((id) =>
          `<button type="button" class="ed-seg-btn ${id === cur ? "is-on" : ""}" data-lang="${escapeAttr(id)}">${escapeHtml(id)}</button>`
        ).join("");
      }
    } catch (_) {
      els.lang.innerHTML = fallback.map((id) => `<option value="${id}">${id}</option>`).join("");
      if (els.langSeg) {
        els.langSeg.innerHTML = fallback.map((id) =>
          `<button type="button" class="ed-seg-btn" data-lang="${id}">${id}</button>`
        ).join("");
      }
    }
  }

  async function ask(e) {
    e?.preventDefault?.();
    if (busy) return;
    const text = (els.prompt.value || "").trim();
    if (!text) return;
    const b = brain();
    const c = ctrl();
    busy = true;
    els.ask.disabled = true;
    appendMsg("you", text);
    els.prompt.value = "";
    showSide("helper");

    const t = activeTab();
    const maxChars = Number(c.ctxChars || 24000);
    let fileNote = "";
    if (t) fileNote += `\n\nOpen file: ${t.path}\n\`\`\`\n${t.text.slice(0, maxChars)}\n\`\`\``;
    for (const p of pins().slice(0, 4)) {
      if (t && p === t.path) continue;
      const body = await b?.readFile?.(p);
      if (body) fileNote += `\n\nPinned: ${p}\n\`\`\`\n${String(body).slice(0, 6000)}\n\`\`\``;
    }
    let system = "You are Noeti Coding Helper in the Editor. Prefer concrete edits. Put final file contents in a single fenced code block when rewriting.";
    if (b?.getStatus?.().enabled) {
      const block = await b.buildContextBlock(text);
      system = [b.codingSystemPrompt(), system, block].filter(Boolean).join("\n\n---\n\n");
    }

    const bubble = document.createElement("div");
    bubble.className = "ed-msg";
    bubble.innerHTML = `<div class="ed-msg-role">helper</div><div class="ed-msg-body">…</div>`;
    els.log.appendChild(bubble);
    const bodyEl = bubble.querySelector(".ed-msg-body");

    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          messages: [{ role: "user", content: text + fileNote }],
          model: els.model.value || "openai/gpt-4o-mini",
          temperature: Number(c.temp ?? 0.35),
          assistant_id: "coding_helper",
          system_prompt: system,
          prefer_local: c.where === "private",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${res.status}`);
      }
      let full = "";
      await readSSE(res, (ev) => {
        if (ev.event === "error") throw new Error(ev.message || "Stream failed");
        if (ev.event === "token") {
          full += ev.text || "";
          bodyEl.innerHTML = formatBody(full);
          els.log.scrollTop = els.log.scrollHeight;
        }
        if (ev.event === "done" && ev.reply) {
          full = ev.reply;
          bodyEl.innerHTML = formatBody(full);
        }
      });
      if (!full) bodyEl.textContent = "(empty reply)";
      const chat = loadJson(CHAT_CACHE_KEY, []);
      chat.unshift({ at: Date.now(), q: text, a: full.slice(0, 6000), path: activePath });
      saveJson(CHAT_CACHE_KEY, chat.slice(0, 50));
      updateStatusbar();
    } catch (err) {
      bodyEl.textContent = err.message || String(err);
    } finally {
      busy = false;
      els.ask.disabled = false;
    }
  }

  function applyLast() {
    const t = activeTab();
    if (!lastCodeBlock || !t) return;
    t.text = lastCodeBlock;
    els.code.value = lastCodeBlock;
    if (els.save) els.save.disabled = false;
    renderTabs();
  }

  /* ---- Right coding chat (Cursor-like) ---- */
  function appendChatMsg(role, text) {
    if (!els.chatLog) return null;
    const div = document.createElement("div");
    div.className = `ed-chat-msg ${role === "you" || role === "user" ? "user" : "bot"}`;
    const label = role === "you" || role === "user" ? "you" : "chat";
    div.innerHTML = `<div class="ed-chat-role">${escapeHtml(label)}</div><div class="ed-chat-body">${formatChatBody(text)}</div>`;
    els.chatLog.appendChild(div);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
    return div;
  }

  function formatChatBody(text) {
    const raw = String(text || "");
    const parts = [];
    const re = /```[\w.-]*\n?([\s\S]*?)```/g;
    let last = 0; let m;
    while ((m = re.exec(raw))) {
      if (m.index > last) parts.push(escapeHtml(raw.slice(last, m.index)));
      chatLastCode = m[1].replace(/\n$/, "");
      lastCodeBlock = chatLastCode;
      parts.push(`<pre>${escapeHtml(chatLastCode)}</pre>`);
      last = m.index + m[0].length;
    }
    if (last < raw.length) parts.push(escapeHtml(raw.slice(last)));
    if (chatLastCode && els.chatApplyBar) {
      els.chatApplyBar.hidden = false;
      if (els.chatApplyHint) {
        const lines = chatLastCode.split("\n").length;
        els.chatApplyHint.textContent = `Code ready · ${lines} lines`;
      }
    }
    if (lastCodeBlock && els.apply) els.apply.hidden = false;
    return parts.join("") || escapeHtml(raw);
  }

  async function askChat(e, presetText) {
    e?.preventDefault?.();
    if (chatBusy) return;
    const text = (presetText || els.chatIn?.value || "").trim();
    if (!text) return;
    const b = brain();
    const c = ctrl();
    chatBusy = true;
    if (els.chatSend) els.chatSend.disabled = true;
    if (els.chatStop) els.chatStop.hidden = false;
    appendChatMsg("you", text);
    if (els.chatIn) els.chatIn.value = "";
    if (layoutState.chatRight === false) {
      layoutState.chatRight = true;
      applyLayout(layoutState);
      persistLayout();
    }

    const t = activeTab();
    const maxChars = Number(c.ctxChars || 24000);
    let fileNote = "";
    if (t) {
      fileNote += `\n\nOpen file: ${t.path}\n\`\`\`\n${t.text.slice(0, maxChars)}\n\`\`\``;
    } else {
      fileNote += "\n\n(No file open — answer generally, or ask the user to open a file.)";
    }
    for (const p of pins().slice(0, 4)) {
      if (t && p === t.path) continue;
      const body = await b?.readFile?.(p);
      if (body) fileNote += `\n\nPinned: ${p}\n\`\`\`\n${String(body).slice(0, 6000)}\n\`\`\``;
    }
    let system = [
      "You are Noeti Coding Chat in the Editor — like Cursor's side chat.",
      "Edit the open file when asked. Prefer concrete edits.",
      "When rewriting a file, put the FULL updated file contents in a single fenced code block.",
      "Keep explanations short unless asked to explain.",
    ].join(" ");
    if (b?.getStatus?.().enabled) {
      const block = await b.buildContextBlock(text);
      system = [b.codingSystemPrompt(), system, block].filter(Boolean).join("\n\n---\n\n");
    }

    const bubble = appendChatMsg("chat", "…");
    const bodyEl = bubble?.querySelector(".ed-chat-body");
    chatAbort = new AbortController();

    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        signal: chatAbort.signal,
        body: JSON.stringify({
          messages: [{ role: "user", content: text + fileNote }],
          model: els.model?.value || "openai/gpt-4o-mini",
          temperature: Number(c.temp ?? 0.35),
          assistant_id: "coding_helper",
          system_prompt: system,
          prefer_local: c.where === "private",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${res.status}`);
      }
      let full = "";
      await readSSE(res, (ev) => {
        if (ev.event === "error") throw new Error(ev.message || "Stream failed");
        if (ev.event === "token") {
          full += ev.text || "";
          if (bodyEl) bodyEl.innerHTML = formatChatBody(full);
          if (els.chatLog) els.chatLog.scrollTop = els.chatLog.scrollHeight;
        }
        if (ev.event === "done" && ev.reply) {
          full = ev.reply;
          if (bodyEl) bodyEl.innerHTML = formatChatBody(full);
        }
      });
      if (!full && bodyEl) bodyEl.textContent = "(empty reply)";
      const chat = loadJson(CHAT_CACHE_KEY, []);
      chat.unshift({ at: Date.now(), q: text, a: full.slice(0, 6000), path: activePath, src: "side" });
      saveJson(CHAT_CACHE_KEY, chat.slice(0, 50));
      updateStatusbar();
      setStatus(chatLastCode ? "Chat · code ready to apply" : "Chat · done");
    } catch (err) {
      if (err?.name === "AbortError") {
        if (bodyEl) bodyEl.textContent = "(stopped)";
      } else if (bodyEl) {
        bodyEl.textContent = err.message || String(err);
      }
    } finally {
      chatBusy = false;
      chatAbort = null;
      if (els.chatSend) els.chatSend.disabled = false;
      if (els.chatStop) els.chatStop.hidden = true;
    }
  }

  function applyChatCode() {
    const t = activeTab();
    const code = chatLastCode || lastCodeBlock;
    if (!code || !t) {
      setStatus(t ? "No code to apply" : "Open a file first");
      return;
    }
    t.text = code;
    els.code.value = code;
    if (els.save) els.save.disabled = false;
    renderTabs();
    setStatus(`Applied to ${basename(t.path)}`);
  }

  function insertChatCode() {
    const t = activeTab();
    const code = chatLastCode || lastCodeBlock;
    if (!code || !t || !els.code) {
      setStatus(t ? "No code to insert" : "Open a file first");
      return;
    }
    const start = els.code.selectionStart ?? t.text.length;
    const end = els.code.selectionEnd ?? start;
    const next = t.text.slice(0, start) + code + t.text.slice(end);
    t.text = next;
    els.code.value = next;
    const pos = start + code.length;
    els.code.focus();
    els.code.setSelectionRange(pos, pos);
    if (els.save) els.save.disabled = false;
    renderTabs();
    updateCursorPos();
    setStatus(`Inserted into ${basename(t.path)}`);
  }

  function clearChatLog() {
    if (els.chatLog) els.chatLog.innerHTML = "";
    chatLastCode = "";
    if (els.chatApplyBar) els.chatApplyBar.hidden = true;
  }

  async function restoreTabs() {
    const ws = loadJson(WS_KEY, {});
    const b = brain();
    if (!b || !ws.tabs?.length) return;
    for (const row of ws.tabs.slice(0, MAX_TABS)) {
      const text = await b.readFile(row.path);
      if (text == null) continue;
      tabs.push({ path: row.path, text, saved: text });
    }
    activePath = (ws.active && tabs.find((t) => t.path === ws.active)) ? ws.active : (tabs[0]?.path || "");
    renderTabs();
    syncCodeFromTab();
  }

  /* ---- Events ---- */
  els.menubar?.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".ed-menu-btn");
    if (btn) {
      const name = btn.getAttribute("data-menu");
      if (openMenu === name) closeMenus();
      else openMenuNamed(name);
      return;
    }
    const item = e.target.closest?.("[data-cmd]");
    if (item) runCmd(item.getAttribute("data-cmd"));
  });
  els.menubar?.addEventListener("mouseover", (e) => {
    if (!openMenu) return;
    const btn = e.target.closest?.(".ed-menu-btn");
    if (btn) openMenuNamed(btn.getAttribute("data-menu"));
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.(".ed-menubar") && !e.target.closest?.(".ed-cmd")) closeMenus();
  });

  els.cmdBtn?.addEventListener("click", openCmd);
  els.cmd?.addEventListener("click", (e) => { if (e.target === els.cmd) closeCmd(); });
  els.cmdInput?.addEventListener("input", () => { cmdIndex = 0; renderCmdList(els.cmdInput.value); });
  els.cmdInput?.addEventListener("keydown", (e) => {
    const items = [...els.cmdList.querySelectorAll("[data-cmd], [data-open]")];
    if (e.key === "Escape") { closeCmd(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); cmdIndex = Math.min(items.length - 1, cmdIndex + 1); renderCmdList(els.cmdInput.value); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); cmdIndex = Math.max(0, cmdIndex - 1); renderCmdList(els.cmdInput.value); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const el = items[cmdIndex];
      if (!el) return;
      if (el.hasAttribute("data-open")) openFile(el.getAttribute("data-open"));
      else runCmd(el.getAttribute("data-cmd"));
      closeCmd();
    }
  });
  els.cmdList?.addEventListener("click", (e) => {
    const open = e.target.closest?.("[data-open]");
    if (open) { openFile(open.getAttribute("data-open")); closeCmd(); return; }
    const cmd = e.target.closest?.("[data-cmd]");
    if (cmd) runCmd(cmd.getAttribute("data-cmd"));
  });

  els.list?.addEventListener("click", (e) => {
    const toggle = e.target.closest?.("[data-toggle]");
    if (toggle) {
      e.preventDefault();
      e.stopPropagation();
      const dir = toggle.getAttribute("data-toggle");
      if (!expanded) expanded = new Set();
      if (expanded.has(dir)) expanded.delete(dir);
      else expanded.add(dir);
      saveExpanded(expanded);
      renderList();
      return;
    }
    const runBtn = e.target.closest?.("[data-run]");
    if (runBtn) {
      e.preventDefault();
      e.stopPropagation();
      openFile(runBtn.getAttribute("data-run"), { run: true });
      return;
    }
    const row = e.target.closest?.("[data-path]");
    if (row) {
      openFile(row.getAttribute("data-path"));
      return;
    }
    const dirRow = e.target.closest?.("[data-dir]");
    if (dirRow) {
      const dir = dirRow.getAttribute("data-dir");
      if (!expanded) expanded = new Set();
      if (expanded.has(dir)) expanded.delete(dir);
      else expanded.add(dir);
      saveExpanded(expanded);
      renderList();
    }
  });
  els.recent?.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-path]");
    if (btn) openFile(btn.getAttribute("data-path"));
  });
  els.tabs?.addEventListener("click", (e) => {
    const close = e.target.closest?.("[data-close]");
    if (close) { e.stopPropagation(); closeTab(close.getAttribute("data-close")); return; }
    const tab = e.target.closest?.("[data-tab]");
    if (tab) {
      activePath = tab.getAttribute("data-tab");
      persistWs(); renderTabs(); syncCodeFromTab(); renderList();
    }
  });
  let searchTimer = 0;
  els.search?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      filter = (els.search.value || "").trim().toLowerCase();
      renderList();
    }, 120);
  });
  els.code?.addEventListener("input", onCodeInput);
  els.code?.addEventListener("click", updateCursorPos);
  els.code?.addEventListener("keyup", updateCursorPos);
  els.save?.addEventListener("click", saveFile);
  els.run?.addEventListener("click", () => runFile());
  els.run2?.addEventListener("click", () => runFile());
  els.stop?.addEventListener("click", stopRun);
  els.graphBtn?.addEventListener("click", () => {
    graphKind = "fs";
    setViewMode(layoutState.viewMode === "split" ? "code" : "split");
    layoutState.preset = "custom";
    persistLayout();
  });
  els.memoryBtn?.addEventListener("click", () => showSide("memory"));
  els.brainBtn?.addEventListener("click", () => brain()?.open?.());
  els.allow?.addEventListener("click", () => brain()?.open?.());
  document.getElementById("edEmptyOpen")?.addEventListener("click", () => brain()?.open?.());
  els.form?.addEventListener("submit", ask);
  els.apply?.addEventListener("click", applyLast);
  els.model?.addEventListener("change", () => localStorage.setItem("noeti_editor_model", els.model.value));
  els.memRefresh?.addEventListener("click", () => runCmd("mem-refresh"));
  els.memClearRuns?.addEventListener("click", () => runCmd("mem-clear-runs"));
  els.memClearChat?.addEventListener("click", () => runCmd("mem-clear-chat"));
  els.memPin?.addEventListener("click", pinCurrent);
  els.pins?.addEventListener("click", (e) => {
    const u = e.target.closest?.("[data-unpin]");
    if (u) setPins(pins().filter((p) => p !== u.getAttribute("data-unpin")));
  });
  els.where?.addEventListener("change", () => saveCtrl({ where: els.where.value }));
  els.device?.addEventListener("change", () => saveCtrl({ deviceId: els.device.value }));
  els.refreshDevices?.addEventListener("click", () => loadDevices());
  els.brainOpen?.addEventListener("click", () => brain()?.open?.());
  els.whereSeg?.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-where]");
    if (!btn) return;
    saveCtrl({ where: btn.getAttribute("data-where") });
  });
  els.autoSeg?.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-auto]");
    if (!btn) return;
    saveCtrl({ autoSave: btn.getAttribute("data-auto") === "1" });
  });
  els.deviceList?.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-device]");
    if (!btn) return;
    saveCtrl({ deviceId: btn.getAttribute("data-device") });
    loadDevices();
  });
  els.langSeg?.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-lang]");
    if (!btn) return;
    const id = btn.getAttribute("data-lang");
    if (els.lang) els.lang.value = id;
    els.langSeg.querySelectorAll(".ed-seg-btn").forEach((b) => b.classList.toggle("is-on", b === btn));
  });
  els.modelBtn?.addEventListener("click", () => {
    const opts = [...(els.model?.options || [])];
    if (!opts.length) return;
    const i = Math.max(0, opts.findIndex((o) => o.selected));
    const next = opts[(i + 1) % opts.length];
    els.model.value = next.value;
    localStorage.setItem("noeti_editor_model", next.value);
    els.modelBtn.textContent = (next.value.split("/").pop() || next.value).slice(0, 18);
  });
  els.temp?.addEventListener("input", () => {
    if (els.tempVal) els.tempVal.textContent = Number(els.temp.value).toFixed(2);
  });
  els.temp?.addEventListener("change", () => saveCtrl({ temp: Number(els.temp.value) }));
  els.timeout?.addEventListener("input", () => {
    if (els.timeoutVal) els.timeoutVal.textContent = String(els.timeout.value);
  });
  document.querySelectorAll("[data-cmd-graph]").forEach((btn) => {
    btn.addEventListener("click", () => {
      graphKind = btn.getAttribute("data-cmd-graph") || "fs";
      if (layoutState.viewMode === "split") {
        showGraph(true, graphKind);
      } else {
        setViewMode("graph");
      }
      layoutState.preset = "custom";
      persistLayout();
    });
  });
  els.autoSave?.addEventListener("change", () => saveCtrl({ autoSave: els.autoSave.value === "1" }));
  els.ctxChars?.addEventListener("change", () => saveCtrl({ ctxChars: Number(els.ctxChars.value) }));
  els.findNext?.addEventListener("click", findNext);
  els.findPrev?.addEventListener("click", findPrev);
  els.replaceOne?.addEventListener("click", replaceOne);
  els.replaceAll?.addEventListener("click", replaceAll);
  els.findClose?.addEventListener("click", () => showFind(false));
  els.findInput?.addEventListener("input", updateFindCount);
  els.findCase?.addEventListener("change", () => { updateFindCount(); });
  els.findInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) findPrev(); else findNext(); }
    if (e.key === "Escape") showFind(false);
  });
  els.replaceInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) replaceAll(); else replaceOne(); }
    if (e.key === "Escape") showFind(false);
  });
  document.querySelectorAll(".ed-bottom-tabs button[data-panel]").forEach((btn) => {
    btn.addEventListener("click", () => showBottomPanel(btn.getAttribute("data-panel")));
  });
  els.termForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = els.termInput?.value || "";
    if (els.termInput) els.termInput.value = "";
    runTermCommand(v);
  });
  els.termInput?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!termHistory.length) return;
      termHistIdx = Math.max(0, termHistIdx - 1);
      els.termInput.value = termHistory[termHistIdx] || "";
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      termHistIdx = Math.min(termHistory.length, termHistIdx + 1);
      els.termInput.value = termHistIdx >= termHistory.length ? "" : (termHistory[termHistIdx] || "");
    }
  });
  // click log focuses input
  els.term?.addEventListener("click", () => els.termInput?.focus?.());

  document.getElementById("edSettingsBtn")?.addEventListener("click", () => openEditorSettings(true));
  document.getElementById("edSettingsClose")?.addEventListener("click", () => openEditorSettings(false));
  document.getElementById("edSettingsBackdrop")?.addEventListener("click", () => openEditorSettings(false));
  document.getElementById("edSettingsSheet")?.addEventListener("click", (e) => {
    const cmd = e.target.closest?.("[data-cmd]");
    if (cmd) {
      e.preventDefault();
      runCmd(cmd.getAttribute("data-cmd"));
    }
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("edSettingsSheet")?.hidden) {
      openEditorSettings(false);
    }
  });

  applyLayout();
  bindBottomTabReorder();
  initTheme();

  document.querySelectorAll("[data-layout]").forEach((btn) => {
    btn.addEventListener("click", () => applyPreset(btn.getAttribute("data-layout")));
  });
  document.querySelectorAll("[data-layout-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.getAttribute("data-layout-toggle");
      if (t === "explorer") runCmd("toggle-explorer");
      if (t === "bottom") runCmd("toggle-bottom");
      if (t === "fs") runCmd("toggle-fs-pane");
      if (t === "chat") runCmd("toggle-chat");
      if (t === "explorer-side") runCmd("explorer-right");
    });
  });
  document.querySelectorAll("[data-cmd='layout-reset']").forEach((btn) => {
    btn.addEventListener("click", () => resetLayoutSizes());
  });
  els.rightClose?.addEventListener("click", () => {
    layoutState.chatRight = false;
    layoutState.helperDock = "bottom";
    layoutState.bottom = true;
    layoutState.preset = "custom";
    applyLayout(layoutState);
    persistLayout();
  });
  els.chatForm?.addEventListener("submit", (e) => askChat(e));
  els.chatApply?.addEventListener("click", applyChatCode);
  els.chatInsert?.addEventListener("click", insertChatCode);
  els.chatClear?.addEventListener("click", clearChatLog);
  els.chatClose?.addEventListener("click", () => runCmd("toggle-chat"));
  els.chatStop?.addEventListener("click", () => chatAbort?.abort?.());
  els.chatChips?.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-chat-chip]");
    if (!btn) return;
    askChat(null, btn.getAttribute("data-chat-chip") || "");
  });
  els.chatIn?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      askChat(e);
    }
  });

  bindSplitter(els.splitVert, (e) => {
    if (!els.shell) return;
    const rect = els.shell.getBoundingClientRect();
    const right = layoutState.explorerSide === "right";
    const w = right
      ? Math.max(180, Math.min(520, rect.right - e.clientX))
      : Math.max(180, Math.min(520, e.clientX - rect.left));
    els.shell.style.setProperty("--left-w", `${Math.round(w)}px`);
  }, () => {
    els.shell.style.setProperty("--left-w", "300px");
    layoutState.leftW = 300;
  });
  bindSplitter(els.splitLeft, (e) => {
    if (!els.explorer || !els.shell) return;
    const rect = els.explorer.getBoundingClientRect();
    const fromBottom = rect.bottom - e.clientY;
    const pct = Math.max(12, Math.min(80, (fromBottom / rect.height) * 100));
    els.shell.style.setProperty("--left-graph-h", `${Math.round(pct)}%`);
  }, () => {
    els.shell.style.setProperty("--left-graph-h", "58%");
    layoutState.leftGraphH = 58;
  });
  bindSplitter(els.splitBottom, (e) => {
    if (!els.center || !els.shell) return;
    const rect = els.center.getBoundingClientRect();
    const h = Math.max(100, Math.min(rect.height * 0.75, rect.bottom - e.clientY));
    els.shell.style.setProperty("--bottom-h", `${Math.round(h)}px`);
    els.center.classList.remove("is-bottom-collapsed");
    layoutState.bottom = true;
  }, () => {
    els.shell.style.setProperty("--bottom-h", "240px");
    layoutState.bottomH = 240;
  });
  bindSplitter(els.splitRight, (e) => {
    if (!els.shell) return;
    const rect = els.shell.getBoundingClientRect();
    const w = Math.max(220, Math.min(560, rect.right - e.clientX));
    els.shell.style.setProperty("--right-w", `${Math.round(w)}px`);
  }, () => {
    els.shell.style.setProperty("--right-w", "340px");
    layoutState.rightW = 340;
  });
  bindSplitter(els.splitViews, (e) => {
    if (!els.views || !els.shell) return;
    const rect = els.views.getBoundingClientRect();
    const pct = Math.max(20, Math.min(80, ((e.clientX - rect.left) / rect.width) * 100));
    els.shell.style.setProperty("--view-split", `${Math.round(pct)}%`);
  }, () => {
    els.shell.style.setProperty("--view-split", "48%");
    layoutState.viewSplit = 48;
  });
  els.graphExpand?.addEventListener("click", () => expandLeftGraph(true));
  els.graphClose?.addEventListener("click", () => {
    layoutState.viewMode = "code";
    setViewMode("code");
    layoutState.preset = "custom";
    persistLayout();
    setStatus("Back to code");
  });
  els.bottomToggle?.addEventListener("click", () => runCmd("toggle-bottom"));

  let miniTap = 0;
  els.miniGraph?.addEventListener("pointerdown", (e) => {
    if (!miniState) drawMini(true);
    if (!miniState) return;
    const hit = hitMini(e.clientX, e.clientY);
    const now = Date.now();
    if (hit && (hit.kind === "file" || hit.path)) {
      if (now - miniTap < 350 && runnable(hit.path)) openFile(hit.path, { run: true });
      else if (hit.path) openFile(hit.path);
      miniTap = now;
      return;
    }
    miniState.autoSpin = false;
    miniState.orbit = { x: e.clientX, y: e.clientY, yaw: miniState.yaw, pitch: miniState.pitch };
    els.miniGraph.setPointerCapture?.(e.pointerId);
  });
  els.miniGraph?.addEventListener("pointermove", (e) => {
    if (!miniState?.orbit) return;
    const dx = e.clientX - miniState.orbit.x;
    const dy = e.clientY - miniState.orbit.y;
    miniState.yaw = miniState.orbit.yaw + dx * 0.01;
    miniState.pitch = Math.max(-1.2, Math.min(1.2, miniState.orbit.pitch + dy * 0.01));
  });
  els.miniGraph?.addEventListener("pointerup", () => {
    if (miniState) { miniState.orbit = null; miniState.pan = null; }
  });
  els.miniGraph?.addEventListener("wheel", (e) => {
    if (!miniState) return;
    e.preventDefault();
    miniState.scale = Math.min(2.4, Math.max(0.45, miniState.scale * (e.deltaY > 0 ? 0.92 : 1.08)));
  }, { passive: false });

  let lastTap = 0;
  els.graphCanvas?.addEventListener("pointerdown", (e) => {
    if (!graphState) return;
    const hit = hitGraph(e.clientX, e.clientY);
    const now = Date.now();
    if (hit && (hit.kind === "file" || hit.path)) {
      if (now - lastTap < 350 && runnable(hit.path)) openFile(hit.path, { run: true });
      else if (hit.path) openFile(hit.path);
      lastTap = now;
      return;
    }
    graphState.autoSpin = false;
    graphState.orbit = { x: e.clientX, y: e.clientY, yaw: graphState.yaw, pitch: graphState.pitch };
    els.graphCanvas.setPointerCapture?.(e.pointerId);
  });
  els.graphCanvas?.addEventListener("pointermove", (e) => {
    if (!graphState?.orbit) return;
    const dx = e.clientX - graphState.orbit.x;
    const dy = e.clientY - graphState.orbit.y;
    graphState.yaw = graphState.orbit.yaw + dx * 0.008;
    graphState.pitch = Math.max(-1.2, Math.min(1.2, graphState.orbit.pitch + dy * 0.008));
  });
  els.graphCanvas?.addEventListener("pointerup", () => {
    if (graphState) { graphState.orbit = null; graphState.pan = null; }
  });
  els.graphCanvas?.addEventListener("wheel", (e) => {
    if (!graphState) return;
    e.preventDefault();
    graphState.scale = Math.min(2.6, Math.max(0.4, graphState.scale * (e.deltaY > 0 ? 0.92 : 1.08)));
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); openCmd(); }
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveFile(); }
    if (mod && e.key === "Enter") { e.preventDefault(); runFile(); }
    if (mod && e.key.toLowerCase() === "g") { e.preventDefault(); expandLeftGraph(true); }
    if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); showFind(true); }
    if (e.key === "Escape") {
      closeMenus();
      closeCmd();
      showFind(false);
      if (graphMode || layoutState.viewMode === "graph" || layoutState.viewMode === "split") {
        layoutState.viewMode = "code";
        setViewMode("code");
        persistLayout();
        setStatus("Graph closed");
      }
    }
  });

  els.code?.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const start = els.code.selectionStart;
      const end = els.code.selectionEnd;
      const v = els.code.value;
      if (e.shiftKey) {
        const lineStart = v.lastIndexOf("\n", start - 1) + 1;
        const block = v.slice(lineStart, end);
        const dedented = block.replace(/^ {1,2}/gm, "");
        els.code.value = v.slice(0, lineStart) + dedented + v.slice(end);
        const shrink = block.length - dedented.length;
        els.code.selectionStart = Math.max(lineStart, start - Math.min(2, shrink));
        els.code.selectionEnd = end - shrink;
      } else if (start !== end) {
        const lineStart = v.lastIndexOf("\n", start - 1) + 1;
        const block = v.slice(lineStart, end);
        const indented = block.replace(/^/gm, "  ");
        els.code.value = v.slice(0, lineStart) + indented + v.slice(end);
        els.code.selectionStart = start + 2;
        els.code.selectionEnd = end + (indented.length - block.length);
      } else {
        els.code.value = v.slice(0, start) + "  " + v.slice(end);
        els.code.selectionStart = els.code.selectionEnd = start + 2;
      }
      onCodeInput();
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (tabs.some((t) => t.text !== t.saved)) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  els.logout?.addEventListener("click", async () => {
    try { await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", body: "{}" }); } catch (_) {}
    location.href = "/login?next=/editor";
  });

  async function boot() {
    if (els.gate) els.gate.hidden = true;
    if (els.app) els.app.hidden = false;
    syncControlForm();
    renderPins();
    try {
      const n = await brain()?.purgeHeavy?.();
      if (n) setStatus(`Cleaned ${n} heavy/binary paths`);
    } catch (_) {}
    await Promise.all([loadModels(), loadLangs(), loadDevices()]);
    renderList();
    renderRecent();
    renderMemory();
    await restoreTabs();
    // Always land on code — graph is opt-in
    layoutState.viewMode = "code";
    setViewMode("code");
    showBottomPanel("term");
    if (els.chatLog && !els.chatLog.children.length) {
      appendChatMsg(
        "chat",
        "Open a file, then ask me to edit it. I’ll return a full code fence — use Apply to file or Insert. ⌘↵ to send."
      );
    }
    drawMini(true);
    brain()?.onChange?.(() => {
      renderList();
      renderMemory();
      syncDeskChrome();
      miniState = null;
      drawMini(true);
      if (graphMode) { graphState = null; drawGraph(true); }
    });
    updateStatusbar();
    setStatus("Ready · drag grey grips to resize · Layout bar to reorganize");
  }

  boot();
})();
