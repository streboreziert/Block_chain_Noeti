import {
  createWallet,
  downloadWalletBackup,
  fetchBalance,
  getOrCreateWallet,
  importWalletBackup,
  loadWallet,
  requestFaucet,
  ensureStakeForNode,
  transferFromBrowser,
  autoOnboard,
  hubApi,
} from "./wallet.js";
import {
  logout as authLogout,
  tryRestoreSession,
  isLoggedIn,
  getSession,
  getActiveUsername,
  shortAddress,
  resolveRecipient,
} from "./auth.js";
import "./browser_compute.js";

const rawHubMeta = document.querySelector('meta[name="noetis-hub"]')?.content || "";
const HUB = rawHubMeta.includes("{{") ? "" : rawHubMeta.replace(/\/$/, "");
const LOCAL = window.location.origin;

const APP_VERSION = "0.5.35";
const PHONE_NODE_KEY = "noetis_phone_node_id";
const LOCAL_APP_ORIGIN = "http://127.0.0.1:5056";
const CHAT_HISTORY_KEY = "noetis_chat_history_v1"; // legacy → migrated once
const CONVERSATIONS_KEY = "noetis_conversations_v1";
const ACTIVE_CONVERSATION_KEY = "noetis_active_conversation_id";
const CHAT_MEMORY_KEY = "noetis_chat_memory";
const CHAT_SETTINGS_KEY = "noetis_chat_settings_v1";
const TRANSFER_LOG_KEY = "noetis_transfer_log_v1";
const SKIP_UPDATE_KEY = "noetis_skip_update_version";
const CHAT_MAX_TURNS = 16; // user+ai pairs
const CHAT_MAX_CHARS = 6000; // wire prompt budget for follow-ups
const CHAT_TURN_CHARS = 1800;
const CHAT_MAX_CONVERSATIONS = 40;
const TOKEN_CHOICES = [256, 512, 1024, 2048];

let lastData = null;
let browserWallet = null;
let localStatus = null;
let relaunchInFlight = null;
let bootHandledStagedRelaunch = false;
let relaunchGaveUp = false;
let lastRelaunchError = "";
let history = [];
let histIdx = -1;
let isDesktop = false;
let uiView = localStorage.getItem("noetis_view") || "chat";
let conversations = []; // [{ id, title, updatedAt, turns }]
let activeConversationId = null;
let chatHistory = []; // turns of the active conversation
let pendingUpdate = null; // { local, latest, remote }
let setupProgressDismissed = false;
let phoneEarnOn = false;
let phoneEarnStatus = "stopped"; // stopped | starting | loading_model | running | inferring
let phoneEarnProgressPct = null;
let authModalMode = "login"; // login | signup
let guestBannerDismissed = false;

function defaultChatSettings() {
  return { spendMode: "fast", internet: false, maxTokens: 512 };
}

function loadChatSettings() {
  try {
    const raw = localStorage.getItem(CHAT_SETTINGS_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    const base = defaultChatSettings();
    if (!obj || typeof obj !== "object") return base;
    const mode = obj.spendMode === "verified" ? "verified" : "fast";
    let maxTokens = Number(obj.maxTokens);
    if (!TOKEN_CHOICES.includes(maxTokens)) maxTokens = 512;
    return {
      spendMode: mode,
      internet: !!obj.internet,
      maxTokens,
    };
  } catch {
    return defaultChatSettings();
  }
}

function saveChatSettings(partial) {
  const next = { ...loadChatSettings(), ...(partial || {}) };
  if (next.spendMode !== "verified") next.spendMode = "fast";
  next.internet = !!next.internet;
  let mt = Number(next.maxTokens);
  if (!TOKEN_CHOICES.includes(mt)) mt = 512;
  next.maxTokens = mt;
  try {
    localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(next));
  } catch (_) {}
  paintChatSettings();
  updateChatMeta();
  return next;
}

function paintChatSettings() {
  const s = loadChatSettings();
  document.querySelectorAll("#spendModeGroup .seg-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.spend === s.spendMode);
  });
  const net = document.getElementById("internetToggle");
  if (net) net.checked = !!s.internet;
  const tok = document.getElementById("maxTokensSelect");
  if (tok) tok.value = String(s.maxTokens);
}

function setSettingsPanelOpen(open) {
  const panel = document.getElementById("chatSettingsPanel");
  const btn = document.getElementById("settingsBtn");
  if (!panel) return;
  panel.hidden = !open;
  if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) paintChatSettings();
}

function closeSettingsPanel() {
  setSettingsPanelOpen(false);
}

function toggleSettingsPanel() {
  const panel = document.getElementById("chatSettingsPanel");
  setSettingsPanelOpen(!!panel?.hidden);
}

function loadTransferLog() {
  try {
    const raw = localStorage.getItem(TRANSFER_LOG_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.slice(0, 20) : [];
  } catch {
    return [];
  }
}

function pushTransferLog(entry) {
  const list = loadTransferLog();
  list.unshift({
    to: entry.to,
    amount: entry.amount,
    ok: !!entry.ok,
    ts: Date.now(),
    note: entry.note || "",
  });
  try {
    localStorage.setItem(TRANSFER_LOG_KEY, JSON.stringify(list.slice(0, 20)));
  } catch (_) {}
  paintTransferLog();
}

function paintTransferLog() {
  const el = document.getElementById("transferLog");
  if (!el) return;
  const list = loadTransferLog();
  if (!list.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = list
    .slice(0, 6)
    .map((t) => {
      const to = String(t.to || "").slice(0, 18);
      const mark = t.ok ? "+" : "!";
      return `<div class="tx">${mark}${t.amount} → ${escapeHtml(to)}</div>`;
    })
    .join("");
}

function makeConversationId() {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeAttr(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function titleFromTurns(turns) {
  const first = (turns || []).find((t) => t.role === "user");
  if (!first) return "New chat";
  const t = String(first.text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "New chat";
  return t.length > 42 ? `${t.slice(0, 42)}…` : t;
}

function relativeTime(ts) {
  const t = Number(ts) || 0;
  const diff = Date.now() - t;
  if (!t || !Number.isFinite(diff) || diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  try {
    return new Date(t).toLocaleDateString();
  } catch {
    return "earlier";
  }
}

function normalizeTurns(turns) {
  if (!Array.isArray(turns)) return [];
  return turns
    .filter((t) => t && (t.role === "user" || t.role === "ai") && t.text != null)
    .map((t) => ({
      role: t.role,
      text: String(t.text).slice(0, CHAT_TURN_CHARS),
      ts: Number(t.ts) || Date.now(),
    }))
    .slice(-CHAT_MAX_TURNS * 2);
}

function conversationHasContent(turns) {
  return (turns || []).some((t) => t.role === "user" || t.role === "ai");
}

function migrateLegacyHistory() {
  try {
    const raw = localStorage.getItem(CHAT_HISTORY_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    localStorage.removeItem(CHAT_HISTORY_KEY);
    if (!Array.isArray(arr) || !arr.length) return null;
    const turns = normalizeTurns(arr);
    if (!turns.length) return null;
    return {
      id: makeConversationId(),
      title: titleFromTurns(turns),
      updatedAt: turns[turns.length - 1]?.ts || Date.now(),
      turns,
    };
  } catch {
    try {
      localStorage.removeItem(CHAT_HISTORY_KEY);
    } catch (_) {}
    return null;
  }
}

function emptyConversation() {
  return {
    id: makeConversationId(),
    title: "New chat",
    updatedAt: Date.now(),
    turns: [],
  };
}

function loadConversationsStore() {
  let list = [];
  try {
    const raw = localStorage.getItem(CONVERSATIONS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) {
      list = arr
        .filter((c) => c && typeof c.id === "string")
        .map((c) => ({
          id: c.id,
          title: String(c.title || titleFromTurns(c.turns) || "New chat"),
          updatedAt: Number(c.updatedAt) || Date.now(),
          turns: normalizeTurns(c.turns),
        }));
    }
  } catch {
    list = [];
  }

  const migrated = migrateLegacyHistory();
  if (migrated) list.unshift(migrated);

  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (list.length > CHAT_MAX_CONVERSATIONS) list = list.slice(0, CHAT_MAX_CONVERSATIONS);

  let activeId = null;
  try {
    activeId = localStorage.getItem(ACTIVE_CONVERSATION_KEY);
  } catch (_) {}

  if (!activeId || !list.some((c) => c.id === activeId)) {
    activeId = list.length ? list[0].id : null;
  }
  if (!list.length) {
    const fresh = emptyConversation();
    list = [fresh];
    activeId = fresh.id;
  }

  conversations = list;
  activeConversationId = activeId;
  syncActiveTurnsFromStore();
  persistConversations();
}

function syncActiveTurnsFromStore() {
  const c = conversations.find((x) => x.id === activeConversationId);
  chatHistory = c ? [...c.turns] : [];
}

function persistConversations() {
  const idx = conversations.findIndex((c) => c.id === activeConversationId);
  if (idx >= 0) {
    const turns = normalizeTurns(chatHistory);
    conversations[idx] = {
      ...conversations[idx],
      turns,
      title: turns.length ? titleFromTurns(turns) : "New chat",
      updatedAt: turns.length
        ? turns[turns.length - 1].ts || Date.now()
        : conversations[idx].updatedAt || Date.now(),
    };
  }

  conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (conversations.length > CHAT_MAX_CONVERSATIONS) {
    const active = conversations.find((c) => c.id === activeConversationId);
    let keep = conversations.slice(0, CHAT_MAX_CONVERSATIONS);
    if (active && !keep.some((c) => c.id === active.id)) {
      keep = keep.slice(0, CHAT_MAX_CONVERSATIONS - 1);
      keep.push(active);
      keep.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }
    conversations = keep;
  }

  try {
    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
    if (activeConversationId) {
      localStorage.setItem(ACTIVE_CONVERSATION_KEY, activeConversationId);
    }
  } catch (_) {}
}

function listConversations() {
  return [...conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function resolveConversationRef(key) {
  const items = listConversations();
  if (!key) return null;
  const n = parseInt(key, 10);
  if (String(n) === String(key) && n >= 1 && n <= items.length) return items[n - 1];
  return items.find((c) => c.id === key || c.id.startsWith(key)) || null;
}

function welcomeChatText() {
  return isDesktop
    ? "New chat. Follow-ups remember earlier turns on this device."
    : "New chat. Ask a follow-up anytime — prior messages go with the next request.";
}

function paintChatPane() {
  const box = document.getElementById("chatMessages");
  if (!box) return;
  if (!chatHistory.length) {
    box.innerHTML = `<div class="msg system" id="chatWelcome"><div class="msg-text">${welcomeChatText()}</div></div>`;
  } else {
    box.innerHTML = "";
    for (const t of chatHistory.slice(-20)) {
      if (t.role === "user") addMessage("user", t.text);
      else if (t.role === "ai") addMessage("ai", t.text);
    }
  }
  updateChatMeta();
}

function newConversation() {
  if (conversationHasContent(chatHistory)) {
    persistConversations();
    const fresh = emptyConversation();
    conversations.unshift(fresh);
    activeConversationId = fresh.id;
    chatHistory = [];
    persistConversations();
  } else {
    chatHistory = [];
    const idx = conversations.findIndex((c) => c.id === activeConversationId);
    if (idx >= 0) {
      conversations[idx] = {
        ...conversations[idx],
        turns: [],
        title: "New chat",
        updatedAt: Date.now(),
      };
    } else {
      const fresh = emptyConversation();
      conversations.unshift(fresh);
      activeConversationId = fresh.id;
    }
    persistConversations();
  }
  paintChatPane();
  closeHistoryPanel();
  renderHistoryList();
  toast("new chat");
  term("new chat", "ok");
}

function openConversation(id) {
  const c = conversations.find((x) => x.id === id);
  if (!c) return false;
  if (id === activeConversationId) {
    closeHistoryPanel();
    return true;
  }
  persistConversations();
  activeConversationId = id;
  syncActiveTurnsFromStore();
  persistConversations();
  paintChatPane();
  closeHistoryPanel();
  renderHistoryList();
  toast("chat opened");
  term(`opened ${c.title}`, "ok");
  return true;
}

function deleteConversation(id) {
  const wasActive = id === activeConversationId;
  conversations = conversations.filter((c) => c.id !== id);
  if (!conversations.length) {
    const fresh = emptyConversation();
    conversations = [fresh];
    activeConversationId = fresh.id;
    chatHistory = [];
  } else if (wasActive) {
    activeConversationId = conversations[0].id;
    syncActiveTurnsFromStore();
  }
  persistConversations();
  paintChatPane();
  renderHistoryList();
  toast("chat deleted");
  term("chat deleted", "ok");
  return true;
}

function setHistoryPanelOpen(open) {
  const panel = document.getElementById("chatHistoryPanel");
  const btn = document.getElementById("historyBtn");
  if (!panel) return;
  panel.hidden = !open;
  panel.classList.toggle("open", !!open);
  if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) renderHistoryList();
}

function closeHistoryPanel() {
  setHistoryPanelOpen(false);
}

function toggleHistoryPanel() {
  const panel = document.getElementById("chatHistoryPanel");
  setHistoryPanelOpen(!!panel?.hidden);
}

function conversationListHtml(classPrefix) {
  const items = listConversations();
  if (!items.length) {
    return `<div class="${classPrefix}-empty">No conversations yet</div>`;
  }
  return items
    .map((c) => {
      const active = c.id === activeConversationId ? " active" : "";
      const title = escapeHtml(c.title || "New chat").replace(/<br>/g, " ");
      const time = escapeAttr(relativeTime(c.updatedAt));
      const idAttr = escapeAttr(c.id);
      return `<div class="${classPrefix}-item${active}" data-id="${idAttr}" role="option" aria-selected="${
        c.id === activeConversationId ? "true" : "false"
      }">
      <button type="button" class="${classPrefix}-open" data-id="${idAttr}">
        <span class="${classPrefix}-title">${title}</span>
        <span class="${classPrefix}-time">${time}</span>
      </button>
      <button type="button" class="${classPrefix}-delete" data-id="${idAttr}" aria-label="Delete conversation" title="Delete">×</button>
    </div>`;
    })
    .join("");
}

function renderHistoryList() {
  const list = document.getElementById("chatHistoryList");
  if (!list) return;
  list.innerHTML = conversationListHtml("chat-history");
  renderConvList();
}

function renderConvList() {
  const list = document.getElementById("convList");
  if (!list) return;
  list.innerHTML = conversationListHtml("conv");
}

loadConversationsStore();

function isChatMemoryOn() {
  try {
    const v = localStorage.getItem(CHAT_MEMORY_KEY);
    if (v === null || v === undefined || v === "") return true;
    return v !== "0";
  } catch {
    return true;
  }
}

function setChatMemoryOn(on) {
  const enabled = !!on;
  try {
    localStorage.setItem(CHAT_MEMORY_KEY, enabled ? "1" : "0");
  } catch (_) {}
  paintMemoryToggle();
  updateChatMeta();
  return enabled;
}

function paintMemoryToggle() {
  const btn = document.getElementById("memoryToggleBtn");
  if (!btn) return;
  const on = isChatMemoryOn();
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.classList.toggle("memory-off", !on);
  btn.title = on
    ? "Chat memory on — prior turns go with requests"
    : "Chat memory off — only latest message is sent";
  btn.textContent = "Memory";
}

function currentAppVersion() {
  return String(localStatus?.app_version || APP_VERSION).replace(/^v/i, "");
}

function paintSyncLabel(version, latest = null) {
  const v = String(version || currentAppVersion()).replace(/^v/i, "");
  const latestClean = latest ? String(latest).replace(/^v/i, "") : null;
  const pkg = String(localStatus?.package_version || v).replace(/^v/i, "");
  const staged = !!(pkg && pkg !== v);
  let attemptedKey = false;
  try {
    attemptedKey = !!(pkg && sessionStorage.getItem(`noetis_relaunch_attempted_${pkg}`));
  } catch (_) {}
  const stuckAfterRelaunch = !!(
    staged && (relaunchGaveUp || (attemptedKey && !relaunchInFlight))
  );
  const relaunchRequired = !!(localStatus?.relaunch_required || staged);
  const hasUpdate = !!(latestClean && latestClean !== v && latestClean !== pkg && !relaunchRequired);

  const badge = document.getElementById("versionBadge");
  if (badge) {
    if (stuckAfterRelaunch) {
      badge.textContent = `app ${v} · staged · quit & reopen`;
      badge.classList.add("update");
      badge.title = `Running app ${v} — package ${pkg} is staged. Quit the app and reopen to finish.`;
    } else if (staged) {
      badge.textContent = `app ${v} · Updating — restarting…`;
      badge.classList.add("update");
      badge.title = `Running app ${v} — package ${pkg} is staged. Restarting automatically…`;
    } else {
      badge.textContent = hasUpdate ? `app ${v} · update` : `app ${v}`;
      badge.classList.toggle("update", hasUpdate);
      badge.title = hasUpdate
        ? `Installed app ${v} — newer app ${latestClean} available`
        : `Installed software version app ${v}`;
    }
  }

  const now = document.getElementById("versionNow");
  if (now) {
    now.textContent = stuckAfterRelaunch
      ? `app ${v} · staged · quit & reopen`
      : staged
        ? `app ${v} · Updating — restarting…`
        : `app ${v}`;
  }

  const latestEl = document.getElementById("versionLatest");
  if (latestEl) {
    if (stuckAfterRelaunch) {
      latestEl.textContent = "staged · quit app & reopen to finish";
      latestEl.classList.add("update-avail");
    } else if (staged) {
      latestEl.textContent = `staged · app ${pkg} — Updating — restarting…`;
      latestEl.classList.add("update-avail");
    } else if (!latestClean) {
      latestEl.textContent = "latest · checking…";
      latestEl.classList.remove("update-avail");
    } else if (hasUpdate) {
      latestEl.textContent = `newer available · app ${latestClean}`;
      latestEl.classList.add("update-avail");
    } else {
      latestEl.textContent = `latest · app ${latestClean} · up to date`;
      latestEl.classList.remove("update-avail");
    }
  }

  // Keep legacy id if present
  const el = document.getElementById("syncLabel");
  if (el) {
    el.textContent = stuckAfterRelaunch
      ? `app ${v} · staged · quit & reopen`
      : staged
        ? `app ${v} · Updating — restarting…`
        : `app ${v}`;
  }
}

function isLocalAppHost() {
  const h = window.location.hostname || "";
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

function isPhoneUserAgent() {
  return /iPhone|iPad|Android/i.test(navigator.userAgent || "");
}

function setDesktopMode(desktop) {
  isDesktop = !!desktop;
  document.body.classList.toggle("phone-mode", !isDesktop);
  document.body.classList.toggle("desktop-mode", isDesktop);
  const desk = document.getElementById("desktopControls");
  if (desk) desk.hidden = !isDesktop;
  const onboard = document.getElementById("onboard");
  if (onboard && !isDesktop) onboard.hidden = true;
  const hint = document.getElementById("termHint");
  if (hint) hint.textContent = isDesktop ? "live log" : "phone · chat + earn";
  const earnLead = document.getElementById("earnLead");
  if (earnLead) {
    earnLead.textContent = isDesktop
      ? "Your PC shares inference with the mesh and earns MLC."
      : "Phone Earn runs in this browser tab — keep it open while sharing compute for MLC.";
  }
  const earnHint = document.getElementById("earnHint");
  if (earnHint) {
    earnHint.textContent = isDesktop
      ? "Switch back with the Chat button anytime."
      : "Keep this tab open to earn. Switch back with Chat anytime.";
  }
  const welcome = document.querySelector("#chatWelcome .msg-text");
  if (welcome && !chatHistory.length) {
    welcome.textContent = isDesktop
      ? "Chat asks the mesh · Earn runs your PC as compute. Follow-ups keep this chat’s history."
      : "Ask anything — or tap Earn to share browser compute (keep this tab open).";
  }
  paintPhoneEarnUI();
  if (isDesktop) paintSyncLabel(localStatus?.app_version || APP_VERSION);
  updateChatMeta();
}

function saveChatHistory() {
  persistConversations();
}

function pushChatTurn(role, text) {
  chatHistory.push({ role, text: String(text || "").slice(0, CHAT_TURN_CHARS), ts: Date.now() });
  if (chatHistory.length > CHAT_MAX_TURNS * 2) {
    chatHistory = chatHistory.slice(-CHAT_MAX_TURNS * 2);
  }
  saveChatHistory();
  updateChatMeta();
  renderHistoryList();
}

function clearChatHistory() {
  newConversation();
}

function updateChatMeta() {
  const el = document.getElementById("chatMeta");
  if (!el) return;
  const mem = isChatMemoryOn() ? "memory on" : "memory off";
  const s = loadChatSettings();
  const spend = s.spendMode === "verified" ? "verified" : "fast";
  const net = s.internet ? " · web" : "";
  const turns = chatHistory.filter((t) => t.role === "user").length;
  if (!turns) {
    el.textContent = `new chat · ${mem} · ${spend}${net}`;
    return;
  }
  el.textContent = isDesktop
    ? `${turns} turn${turns === 1 ? "" : "s"} · ${mem} · ${spend}${net}`
    : `${turns} message${turns === 1 ? "" : "s"} · ${mem} · ${spend}${net}`;
}

/**
 * Flatten prior turns + latest user text into one wire `text`.
 * Compute nodes still receive a single string; history enables follow-ups.
 */
function buildWirePrompt(latestUserText) {
  if (!isChatMemoryOn()) {
    // Memory off: wire only the latest user message (UI history still saved).
    // Hub injects Noeti system + [time context] / [web context].
    return String(latestUserText || "");
  }
  const prior = chatHistory.filter((t) => t.role === "user" || t.role === "ai");
  // Continuity only — persona/system lives on the hub (Ollama system=).
  const lines = [
    "Multi-turn conversation. Use earlier turns for follow-ups; answer only the latest user message.",
    "",
  ];
  if (prior.length) {
    lines.push("Conversation so far:");
    for (const turn of prior) {
      if (turn.role === "user") lines.push(`User: ${turn.text}`);
      else lines.push(`Assistant: ${turn.text}`);
    }
    lines.push("");
    lines.push("Latest user message:");
  }
  lines.push(`User: ${latestUserText}`);
  lines.push("Assistant:");

  let wire = lines.join("\n");
  if (wire.length <= CHAT_MAX_CHARS) return wire;

  // Drop oldest prior turns first; always keep continuity header + latest
  const header = lines.slice(0, 2).join("\n");
  const latestBlock = [`User: ${latestUserText}`, "Assistant:"].join("\n");
  const priorBlocks = [];
  for (const turn of prior) {
    priorBlocks.push(turn.role === "user" ? `User: ${turn.text}` : `Assistant: ${turn.text}`);
  }
  while (priorBlocks.length) {
    const body = ["Conversation so far:", ...priorBlocks, "", "Latest user message:", latestBlock].join("\n");
    wire = `${header}\n${body}`;
    if (wire.length <= CHAT_MAX_CHARS) return wire;
    priorBlocks.shift();
  }
  return `${header}\nLatest user message:\n${latestBlock}`;
}

function applyView(view) {
  uiView = view === "earn" ? "earn" : "chat";
  try {
    localStorage.setItem("noetis_view", uiView);
  } catch (_) {}
  document.body.classList.toggle("view-earn", uiView === "earn");
  document.body.classList.toggle("view-chat", uiView === "chat");
  const btnChat = document.getElementById("btnChat");
  const btnEarn = document.getElementById("btnEarn");
  if (btnChat) btnChat.classList.toggle("active", uiView === "chat");
  if (btnEarn) {
    const on = isDesktop
      ? uiView === "earn" || !!localStatus?.compute_running
      : phoneEarnOn || !!window.NoetiBrowserCompute?.isRunning?.();
    btnEarn.classList.toggle("active", on);
    btnEarn.textContent = on ? "Earn · on" : "Earn";
  }
  const badge = document.getElementById("modeBadge");
  if (badge && !localStatus?.dual_mode) {
    const earning = isDesktop ? !!localStatus?.compute_running : phoneEarnOn;
    badge.textContent = earning || uiView === "earn" ? "earn" : "chat";
    badge.className = earning ? "badge ok" : "badge";
  }
  paintPhoneEarnUI();
}

function resolvePhoneNodeId() {
  try {
    const existing = localStorage.getItem(PHONE_NODE_KEY);
    if (existing && existing.startsWith("phone-")) return existing;
  } catch (_) {}
  const id =
    window.NoetiBrowserCompute?.phoneNodeId?.() ||
    `phone-${Math.random().toString(36).slice(2, 10)}`;
  try {
    localStorage.setItem(PHONE_NODE_KEY, id);
  } catch (_) {}
  return id;
}

function phoneEarnStatusCopy(status, pct) {
  if (status === "starting") return "Earn · connecting…";
  if (status === "loading_model") {
    if (pct != null && Number.isFinite(pct)) return `Earn · online · loading model ${Math.round(pct)}%`;
    return "Earn · online · loading model…";
  }
  if (status === "running" || status === "inferring") return "Earn · active";
  return "";
}

function paintPhoneEarnUI() {
  const bc = window.NoetiBrowserCompute;
  const status = bc?.getStatus?.() || phoneEarnStatus || "stopped";
  phoneEarnStatus = status;
  const active =
    status === "starting" ||
    status === "loading_model" ||
    status === "running" ||
    status === "inferring" ||
    !!bc?.isRunning?.();
  phoneEarnOn = active && status !== "stopped";

  const chip = document.getElementById("btnPhoneEarn");
  if (chip) {
    chip.hidden = isDesktop;
    chip.classList.toggle("on", phoneEarnOn);
    chip.classList.toggle("loading", status === "starting" || status === "loading_model");
    if (status === "loading_model" || status === "starting") chip.textContent = "Earn · …";
    else if (status === "running" || status === "inferring") chip.textContent = "Earn · on";
    else chip.textContent = "Earn";
    chip.setAttribute("aria-pressed", phoneEarnOn ? "true" : "false");
  }

  const statusEl = document.getElementById("phoneEarnStatus");
  if (statusEl) {
    const copy = phoneEarnStatusCopy(status, phoneEarnProgressPct);
    statusEl.hidden = isDesktop || !copy;
    statusEl.textContent = copy;
    statusEl.classList.toggle("on", status === "running" || status === "inferring");
    statusEl.classList.toggle("loading", status === "starting" || status === "loading_model");
  }

  const btnEarn = document.getElementById("btnEarn");
  if (btnEarn && !isDesktop) {
    btnEarn.classList.toggle("active", phoneEarnOn);
    btnEarn.textContent = phoneEarnOn ? "Earn · on" : "Earn";
  }
  const badge = document.getElementById("modeBadge");
  if (badge && !isDesktop && !localStatus?.dual_mode) {
    badge.textContent = phoneEarnOn ? "earn" : uiView === "earn" ? "earn" : "chat";
    badge.className = phoneEarnOn ? "badge ok" : "badge";
  }
}

function handlePhoneEarnStatus(status) {
  const prev = phoneEarnStatus;
  phoneEarnStatus = status;
  if (status === "stopped") {
    phoneEarnOn = false;
    phoneEarnProgressPct = null;
  } else {
    phoneEarnOn = true;
  }
  paintPhoneEarnUI();

  if (status === "starting" && prev !== "starting") toast("Earn · staking…");
  if (status === "loading_model" && prev !== "loading_model") {
    toast("Earn · online on hub · loading model…");
  }
  if ((status === "running" || status === "inferring") && prev !== "running" && prev !== "inferring") {
    toast("Earn · active — keep this tab open");
  }
}

async function togglePhoneEarn() {
  const bc = window.NoetiBrowserCompute;
  if (!bc?.start) {
    toast("browser compute not loaded");
    return;
  }

  const status = bc.getStatus?.() || phoneEarnStatus || "stopped";
  // While staking / loading model, ignore second tap — don't unregister mid-load.
  if (status === "starting" || status === "loading_model") {
    toast("Still loading model… keep tab open");
    paintPhoneEarnUI();
    return;
  }

  if (status === "running" || status === "inferring" || bc.isRunning?.()) {
    try {
      await bc.stop();
    } catch (e) {
      toast(e.message || "stop failed");
    }
    phoneEarnOn = false;
    phoneEarnStatus = "stopped";
    phoneEarnProgressPct = null;
    paintPhoneEarnUI();
    toast("stopped phone earn");
    await refreshHub().catch(() => {});
    return;
  }

  try {
    browserWallet = await getOrCreateWallet();
    const nodeId = resolvePhoneNodeId();
    const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent || "");
    const modelLabel = ios
      ? "transformersjs:Xenova/LaMini-Flan-T5-248M"
      : "webllm:Qwen2.5-0.5B-Instruct-q4f16_1";
    phoneEarnStatus = "starting";
    phoneEarnProgressPct = null;
    phoneEarnOn = true;
    paintPhoneEarnUI();
    toast("Keep this tab open to earn on phone");
    term(`phone earn · ${nodeId}`, "info");
    await bc.start({
      hub: HUB || "",
      nodeId,
      wallet: browserWallet,
      modelLabel,
      onLog: (msg, kind) => {
        term(msg, kind || "info");
        // Surface stake / register milestones as toasts when terminal is hidden on phone
        const m = String(msg || "");
        if (/ensuring stake/i.test(m)) toast("Earn · staking…");
        if (/registered · runtime=browser/i.test(m)) toast("Earn · registered (online)");
        if (/model online|browser model ready/i.test(m)) toast("Earn · model ready");
      },
      onStatus: (s) => handlePhoneEarnStatus(s),
      onProgress: (pct, detail) => {
        if (pct != null) phoneEarnProgressPct = pct;
        paintPhoneEarnUI();
        if (pct != null && pct > 0 && pct < 100 && detail) {
          // Throttle-ish: only toast decade milestones
          if (pct === 10 || pct === 25 || pct === 50 || pct === 75) {
            toast(`loading model ${Math.round(pct)}%`);
          }
        }
      },
    });
    phoneEarnOn = true;
    paintPhoneEarnUI();
    await refreshWalletUI().catch(() => {});
    await refreshHub().catch(() => {});
  } catch (e) {
    phoneEarnOn = false;
    phoneEarnStatus = "stopped";
    phoneEarnProgressPct = null;
    paintPhoneEarnUI();
    term(`phone earn: ${e.message}`, "err");
    toast(e.message || "phone earn failed");
  }
}

function toast(msg) {
  if (!msg) return;
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2800);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

function term(line, kind = "info") {
  const el = document.getElementById("termOut");
  if (!el) return;
  const row = document.createElement("div");
  row.className = `term-line ${kind}`;
  const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
  row.textContent = kind === "cmd" ? line : `[${ts}] ${line}`;
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
}

function addMessage(role, text, meta) {
  const box = document.getElementById("chatMessages");
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = meta
    ? `<div class="msg-text">${escapeHtml(text)}</div><div class="msg-meta">${meta}</div>`
    : `<div class="msg-text">${escapeHtml(text)}</div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function fetchLocalStatus(retries = 1, delayMs = 250) {
  for (let i = 0; i < retries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 900);
      const res = await fetch(`${LOCAL}/api/local/status`, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(t);
      if (res.ok) return await res.json();
    } catch {
      /* retry */
    }
    if (i < retries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

/** Unique per-machine id from local status — never invent "desktop" as a default. */
function localNodeId() {
  return (localStatus && localStatus.node_id) || "";
}

/** Earn/register must use the persistent pc-XXXXXXXX id; refetch if status not ready. */
async function resolveEarnNodeId() {
  let id = localNodeId();
  if (id) return id;
  const s = await fetchLocalStatus(8, 250);
  if (s) {
    paintLocal(s);
    id = localNodeId();
  }
  if (!id) {
    throw new Error("local node id not ready — wait a moment and try again");
  }
  return id;
}

/** If this tab is on the website but the desktop app is running, jump to it. */
async function redirectToLocalDesktopIfRunning() {
  if (isLocalAppHost() || isPhoneUserAgent()) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 700);
    const res = await fetch(`${LOCAL_APP_ORIGIN}/api/local/status`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (res.ok) {
      term("desktop app found — opening local UI for Earn…", "ok");
      window.location.href = `${LOCAL_APP_ORIGIN}/`;
      return true;
    }
  } catch {
    /* not running */
  }
  return false;
}

async function clearPhoneServiceWorker() {
  try {
    if (!("serviceWorker" in navigator)) return;
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* ignore */
  }
}

function paintLocal(s) {
  localStatus = s;
  if (!s) return;
  // Any successful /api/local/status means this IS the desktop app
  setDesktopMode(true);
  const dual = !!s.dual_mode;
  const earning = !!s.compute_running;

  // Never flip Chat/Earn panes from status polls — only buttons change view

  const badge = document.getElementById("modeBadge");
  if (dual && earning) {
    badge.textContent = "chat+earn";
    badge.className = "badge ok";
  } else if (uiView === "earn") {
    badge.textContent = earning ? "earn·on" : "earn";
    badge.className = earning ? "badge ok" : "badge";
  } else {
    badge.textContent = "chat";
    badge.className = "badge";
  }

  document.getElementById("stateMode").textContent =
    dual && earning ? "chat+earn" : uiView === "earn" ? (earning ? "earn·on" : "earn") : "chat";
  document.getElementById("stateModel").textContent = s.model || "—";
  document.getElementById("stateOllama").textContent = s.ollama_ok ? "online" : "off";
  document.getElementById("stateWorker").textContent = s.compute_running
    ? "running"
    : s.compute_binary
      ? "idle"
      : "missing binary";
  const ew = document.getElementById("earnWorker");
  const em = document.getElementById("earnModel");
  const eo = document.getElementById("earnOllama");
  if (ew) ew.textContent = document.getElementById("stateWorker").textContent;
  if (em) em.textContent = s.model || "—";
  if (eo) eo.textContent = s.ollama_ok ? "online" : "off";

  // Refresh button labels only — do not change uiView
  const btnChat = document.getElementById("btnChat");
  const btnEarn = document.getElementById("btnEarn");
  if (btnChat) btnChat.classList.toggle("active", uiView === "chat");
  if (btnEarn) {
    btnEarn.classList.toggle("active", uiView === "earn");
    btnEarn.textContent = earning ? "Earn · on" : "Earn";
  }

  const sel = document.getElementById("modelSelect");
  if (sel && s.model) {
    const exists = [...sel.options].some((o) => o.value === s.model);
    if (!exists) {
      const opt = document.createElement("option");
      opt.value = s.model;
      opt.textContent = s.model;
      sel.appendChild(opt);
    }
    if (document.activeElement !== sel) sel.value = s.model;
  }

  const both = document.getElementById("onboardBoth");
  if (both) both.hidden = !dual;

  paintSyncLabel(s.app_version || APP_VERSION);

  updateSetupProgress(s);
}

async function setModeButton(mode, extra = {}) {
  term(mode === "stop" || extra.stop_compute ? "stopping earn…" : `switching → ${mode}`, "info");
  let nodeId = localNodeId();
  if ((mode === "compute" || mode === "both") && isDesktop) {
    try {
      nodeId = await resolveEarnNodeId();
      browserWallet = await getOrCreateWallet();
      await postLocal("/api/local/wallet", {
        name: `compute-${nodeId}`,
        address: browserWallet.address,
        public_key: browserWallet.public_key,
        private_key_hex: browserWallet.private_key_hex,
        node_id: nodeId,
      });
      term(`earn wallet → ${browserWallet.address.slice(0, 18)}…`, "ok");
      term("ensuring stake (faucet if needed)…", "info");
      const stake = await ensureStakeForNode(browserWallet, nodeId, 10);
      await refreshWalletUI();
      term(stake.already ? "already staked · eligible" : `staked for ${nodeId} ✓`, "ok");
    } catch (e) {
      term(`earn blocked: ${e.message}`, "err");
      toast(e.message);
      return; // do not start compute without real stake
    }
  }
  try {
    const data = await postLocal("/api/local/mode", {
      mode,
      ...(nodeId ? { node_id: nodeId } : {}),
      model: document.getElementById("modelSelect")?.value || localStatus?.model,
      ...extra,
    });
    paintLocal(data.status);
    if (mode === "stop" || extra.stop_compute) {
      term("left network — compute unregistered", "ok");
      toast("stopped earning · left network");
      await refreshHub().catch(() => {});
    } else if (data.status?.last_error && (mode === "compute" || mode === "both")) {
      term(data.status.last_error, "err");
      toast(data.status.last_error);
    } else {
      term(data.status?.message || mode, "ok");
      toast(data.status?.message || "ok");
    }
    (data.status?.log || []).slice(-8).forEach((l) => {
      if (/compute:|register|ERROR|failed/i.test(l)) term(l, /ERROR|failed/i.test(l) ? "err" : "ok");
    });
    if (mode === "compute" || mode === "both") applyView("earn");
    if (mode === "stop") applyView("chat");
  } catch (e) {
    term(e.message, "err");
    toast(e.message);
  }
}

/** Map raw setup phase → clear Step X/4 label for humans. */
function mapSetupPhase(phase, pct) {
  const p = String(phase || "").toLowerCase();
  let step = 1;
  let title = "Preparing";
  if (/ollama|engine|binary|install|extract|xattr|daemon/.test(p)) {
    step = 1;
    title = "Install / start engine";
  } else if (/pull|model|download/.test(p)) {
    step = 2;
    title = "Download model";
  } else if (/stake|faucet|wallet|eligible/.test(p)) {
    step = 3;
    title = "Fund & stake wallet";
  } else if (/compute|register|worker|mesh|hub|earn/.test(p)) {
    step = 4;
    title = "Join mesh as compute";
  } else if (/chat ready|setup complete|ready/.test(p)) {
    step = 4;
    title = "Ready";
  } else if (pct >= 70) {
    step = 4;
    title = "Finish setup";
  } else if (pct >= 40) {
    step = 2;
    title = "Download model";
  }
  return {
    step,
    total: 4,
    label: `Step ${step}/4 · ${title}`,
    detail: phase || title,
  };
}

function updateSetupProgress(s) {
  const wrap = document.getElementById("setupProgress");
  const fill = document.getElementById("setupProgressFill");
  const label = document.getElementById("setupProgressLabel");
  const detail = document.getElementById("setupProgressDetail");
  const pctEl = document.getElementById("setupProgressPct");
  if (!wrap || !fill) return;
  const busy = !!s?.setup_busy;
  const pct = Math.max(0, Math.min(100, Number(s?.setup_percent) || 0));
  const phase = s?.setup_phase || "";
  const mapped = mapSetupPhase(phase, pct);
  if (busy) {
    setupProgressDismissed = false;
    wrap.hidden = false;
    fill.style.width = `${pct}%`;
    if (label) label.textContent = mapped.label;
    if (detail) detail.textContent = mapped.detail;
    if (pctEl) pctEl.textContent = `${pct}%`;
  } else if (pct > 0 && pct < 100) {
    wrap.hidden = false;
    fill.style.width = `${pct}%`;
    if (label) label.textContent = mapped.label;
    if (detail) detail.textContent = mapped.detail;
    if (pctEl) pctEl.textContent = `${pct}%`;
  } else if (pct >= 100 && phase) {
    if (setupProgressDismissed) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    fill.style.width = "100%";
    if (label) label.textContent = mapped.label;
    if (detail) detail.textContent = phase;
    if (pctEl) pctEl.textContent = "100%";
    setTimeout(() => {
      if (!localStatus?.setup_busy) {
        wrap.hidden = true;
        setupProgressDismissed = true;
      }
    }, 1800);
  } else {
    wrap.hidden = true;
  }
}

function setChatProgress(visible, text) {
  const wrap = document.getElementById("chatProgress");
  const label = document.getElementById("chatProgressLabel");
  const bar = document.getElementById("progressBar");
  if (wrap) wrap.hidden = !visible;
  if (label && text) label.textContent = text;
  if (bar) bar.classList.toggle("running", !!visible);
}

async function runOnboarding(mode) {
  const chatBtn = document.getElementById("onboardChat");
  const earnBtn = document.getElementById("onboardEarn");
  if (chatBtn) chatBtn.disabled = true;
  if (earnBtn) earnBtn.disabled = true;
  const overlay = document.getElementById("onboard");
  if (overlay) overlay.hidden = true;
  term(mode === "compute" || mode === "both" ? "starting Earn setup…" : "starting Chat setup…", "info");
  toast("setting up…");
  try {
    let nodeId = localNodeId();
    if (mode === "compute" || mode === "both") {
      nodeId = await resolveEarnNodeId();
      browserWallet = await getOrCreateWallet();
      await postLocal("/api/local/wallet", {
        name: `compute-${nodeId}`,
        address: browserWallet.address,
        public_key: browserWallet.public_key,
        private_key_hex: browserWallet.private_key_hex,
        node_id: nodeId,
      });
      term("ensuring stake (faucet if needed)…", "info");
      const stake = await ensureStakeForNode(browserWallet, nodeId, 10);
      await refreshWalletUI();
      term(stake.already ? "already staked · eligible" : `staked for ${nodeId} ✓`, "ok");
    }
    const data = await postLocal("/api/local/setup", {
      mode,
      model: "qwen2.5:0.5b",
      ...(nodeId ? { node_id: nodeId } : {}),
    });
    paintLocal(data.status);
    const seen = (data.status?.log || []).length;
    const finalStatus = data.started ? await pollSetupUntilDone(seen) : data.status;
    paintLocal(finalStatus);
    if (finalStatus?.last_error) throw new Error(finalStatus.last_error);
    term(finalStatus?.message || "ready", "ok");
    toast(mode === "compute" || mode === "both" ? "earning ready" : "chat ready");
  } catch (e) {
    term(e.message || String(e), "err");
    toast(e.message || "setup failed");
    if (overlay) overlay.hidden = false;
    if (chatBtn) chatBtn.disabled = false;
    if (earnBtn) earnBtn.disabled = false;
  }
}

function showOnboardingIfNeeded(s) {
  const overlay = document.getElementById("onboard");
  if (!overlay) return;
  overlay.hidden = !(s && s.needs_onboarding && s.desktop);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollSetupUntilDone(seenLogLen = 0) {
  let seen = seenLogLen;
  for (let i = 0; i < 900; i++) {
    await sleep(450);
    const s = await fetchLocalStatus();
    if (!s) continue;
    paintLocal(s);
    const log = s.log || [];
    while (seen < log.length) {
      const line = log[seen++];
      const kind = /error|failed/i.test(line) ? "err" : "ok";
      term(line, kind);
    }
    if (!s.setup_busy) {
      updateSetupProgress({ ...s, setup_percent: s.setup_percent || 100, setup_phase: s.setup_phase || "done" });
      return s;
    }
  }
  throw new Error("setup timed out — check status");
}

function paintHub(data) {
  lastData = data;
  const nodes = data.nodes || [];
  const computeN = Number(data.compute_count ?? 0);
  const relayN = Number(data.relay_count || 0);
  const taskN = Number(data.task_count || 0);
  document.getElementById("nodeCount").textContent = computeN;
  document.getElementById("blockCount").textContent =
    data.blockchain?.length || data.blockchain?.blocks?.length || 0;
  const nc = document.getElementById("netCompute");
  const nr = document.getElementById("netRelay");
  const nt = document.getElementById("netTasks");
  const na = document.getElementById("netActive");
  if (nc) nc.textContent = String(computeN);
  if (nr) nr.textContent = String(relayN);
  if (nt) nt.textContent = data.running_task ? "busy" : String(taskN);
  if (na) na.textContent = String(computeN + relayN);
  const badge = document.getElementById("chainBadge");
  const n = data.blockchain?.length || data.blockchain?.blocks?.length || 0;
  badge.textContent = `${n} blk`;
  badge.className = n ? "badge ok" : "badge";

  const status = document.getElementById("statusLine");
  if (computeN === 0) {
    status.textContent = `0 active compute · ${relayN} relay`;
  } else if (data.running_task) {
    status.textContent = `traffic · ${computeN} compute · ${relayN} relay · inferring`;
  } else {
    status.textContent = `${computeN} active compute · ${relayN} relay`;
  }

  const localId = localNodeId();
  let phoneId = "";
  try {
    phoneId = localStorage.getItem(PHONE_NODE_KEY) || "";
  } catch (_) {}
  const mine = nodes.find((x) => {
    const id = x.node_id || x.worker_id;
    if (!id) return false;
    if (localId && id === localId) return true;
    if (phoneId && id === phoneId) return true;
    // legacy: only treat shared "desktop" as you if this machine still is desktop
    return id === "desktop" && localId === "desktop";
  });
  const youEl = document.getElementById("netYou");
  if (youEl) {
    youEl.textContent = mine
      ? "online on hub"
      : isDesktop && localStatus?.compute_running
        ? "starting…"
        : phoneEarnOn
          ? "phone earn…"
          : "—";
  }

  document.getElementById("nodeCards").innerHTML =
    nodes
      .map(
        (n) => `<div class="node-card"><span class="dot ${n.status === "inferring" ? "busy" : ""}"></span><span>${n.node_id || n.worker_id}<br/><span class="dim">${n.last_action || n.status || n.model || ""}</span></span></div>`
      )
      .join("") || `<div class="hint">no active compute — start Earn (desktop Ollama or phone browser)</div>`;
}

function detectCpuArch() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  if (/aarch64|arm64|Apple Silicon/i.test(ua) || /arm64|aarch64/i.test(platform)) return "arm";
  if (/x86_64|Win64|WOW64|Intel|amd64/i.test(ua) || /x86_64|Intel/i.test(platform)) return "x64";
  // Apple Silicon Macs usually omit "Intel" in UA
  if (/Mac/i.test(platform) || /Mac OS|Macintosh/i.test(ua)) {
    return /Intel/i.test(ua) ? "x64" : "arm";
  }
  return "x64";
}

/** Map this machine → /api/version downloads key */
function detectPlatformKey() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  if (/iPhone|iPad|Android/i.test(ua)) return "phone";
  const arch = detectCpuArch();
  if (/Mac/i.test(platform) || /Mac OS|Macintosh/i.test(ua)) {
    return arch === "x64" ? "macos_x86_64" : "macos_aarch64";
  }
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return "windows_x86_64";
  if (/Linux/i.test(platform) || /Linux/i.test(ua)) {
    return arch === "arm" ? "linux_aarch64" : "linux_x86_64";
  }
  return "linux_x86_64";
}

function downloadUrlForKey(remote, key) {
  const map = remote?.downloads || {};
  const path =
    map[key] ||
    map.windows_x86_64 ||
    map.linux_x86_64 ||
    map.macos_aarch64 ||
    map.macos_x86_64 ||
    "/download";
  if (String(path).startsWith("http")) return path;
  return `${(HUB || window.location.origin).replace(/\/$/, "")}${path}`;
}

async function checkForUpdates(manual = false) {
  try {
    if (manual) toast("checking for updates…");
    const res = await fetch(hubApi("/api/version"), { cache: "no-store" });
    if (!res.ok) throw new Error(`version HTTP ${res.status}`);
    const remote = await res.json();
    const latest = String(remote.version || "").replace(/^v/i, "");
    const local = currentAppVersion();
    const pkg = String(localStatus?.package_version || local).replace(/^v/i, "");
    paintSyncLabel(local, latest || null);

    // Package already staged at latest — skip download, always auto-relaunch
    if (latest && pkg === latest && local !== latest) {
      hideUpdateModal();
      pendingUpdate = null;
      if (bootHandledStagedRelaunch && !manual) {
        paintSyncLabel(local, latest || null);
        return;
      }
      await relaunchToVersion(latest);
      return;
    }

    if (!latest || latest === local) {
      hideUpdateModal();
      pendingUpdate = null;
      try {
        localStorage.removeItem(SKIP_UPDATE_KEY);
      } catch (_) {}
      if (manual) {
        toast(`up to date · app ${local}`);
        term(`sync ok · you are on app ${local}`, "ok");
      }
      return;
    }

    pendingUpdate = { local, latest, remote };

    let skipped = "";
    try {
      skipped = localStorage.getItem(SKIP_UPDATE_KEY) || "";
    } catch (_) {}
    // Never re-open if user already said Not now for this version (even on manual badge spam)
    if (skipped === latest) {
      if (manual) {
        term(`update app ${latest} available — skipped earlier. Tap Update now below if you changed your mind.`, "info");
        showUpdateModal(local, latest); // manual Check for updates button may reopen intentionally
      }
      return;
    }

    const modal = document.getElementById("updateModal");
    if (modal && !modal.hidden) return; // already open — don't jump/re-render
    if (!manual && sessionStorage.getItem("noetis_update_prompted") === latest) return;

    if (manual) term(`update available · app ${local} → app ${latest}`, "info");
    try {
      sessionStorage.setItem("noetis_update_prompted", latest);
    } catch (_) {}
    showUpdateModal(local, latest);
  } catch (e) {
    paintSyncLabel(currentAppVersion());
    if (manual) {
      term(`sync: ${e.message}`, "err");
      toast(e.message || "sync failed");
    }
  }
}

function showUpdateModal(local, latest) {
  const modal = document.getElementById("updateModal");
  if (!modal) return;
  if (!modal.hidden) return;
  const loc = document.getElementById("updateLocal");
  const rem = document.getElementById("updateRemote");
  const body = document.getElementById("updateBody");
  if (loc) loc.textContent = `app ${local}`;
  if (rem) rem.textContent = `app ${latest}`;
  if (body) {
    body.textContent = isDesktop
      ? "A newer Noeti build is available. Update only if you want — you can keep this version."
      : "A newer shell is available. Update refreshes this phone page; you can stay on this version.";
  }
  modal.hidden = false;
}

function hideUpdateModal() {
  const modal = document.getElementById("updateModal");
  if (modal) modal.hidden = true;
}

function skipPendingUpdate() {
  if (pendingUpdate?.latest) {
    try {
      localStorage.setItem(SKIP_UPDATE_KEY, pendingUpdate.latest);
      sessionStorage.setItem("noetis_update_prompted", pendingUpdate.latest);
    } catch (_) {}
    term(`staying on app ${pendingUpdate.local} — skipped app ${pendingUpdate.latest}`, "info");
    toast(`kept app ${pendingUpdate.local}`);
  }
  hideUpdateModal();
}

function isFetchDropError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("load failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("networkerror") ||
    msg.includes("network request failed") ||
    msg.includes("fetch aborted") ||
    err?.name === "AbortError" ||
    err?.name === "TypeError"
  );
}

/** Probe local status on a specific port (relaunch may land on 5056–5060). */
async function probeLocalStatusOnPort(port) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 900);
    const res = await fetch(`http://127.0.0.1:${port}/api/local/status`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (res.ok) return await res.json();
  } catch {
    /* down / restarting */
  }
  return null;
}

function currentLocalPort() {
  const p = Number(window.location.port || 0);
  return p > 0 ? p : 5056;
}

/** Poll local status until the new binary is listening (45s; try 5056–5060). */
async function waitForRelaunch(expectedVersion, timeoutMs = 45000) {
  const expected = String(expectedVersion || "").replace(/^v/i, "");
  const deadline = Date.now() + timeoutMs;
  const currentPort = currentLocalPort();
  const ports = [currentPort, 5056, 5057, 5058, 5059, 5060].filter(
    (p, i, arr) => arr.indexOf(p) === i
  );
  let stagedMismatchSince = 0;
  lastRelaunchError = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    let sawAnyApi = false;
    for (const port of ports) {
      try {
        const status =
          port === currentPort ? await fetchLocalStatus(1, 0) : await probeLocalStatusOnPort(port);
        if (!status) continue;
        sawAnyApi = true;
        const appV = String(status.app_version || "").replace(/^v/i, "");
        const pkgV = String(status.package_version || "").replace(/^v/i, "");
        const matchExpected = !!(expected && appV === expected);
        const matchPkg = !!(appV && pkgV && appV === pkgV && (!expected || pkgV === expected));
        if (matchExpected || matchPkg) {
          if (port !== currentPort) {
            window.location.replace(`http://127.0.0.1:${port}/`);
            return status;
          }
          paintLocal(status);
          return status;
        }
        // API back but binary did not swap (old app, staged pkg matches expected)
        if (expected && pkgV === expected && appV && appV !== expected) {
          if (!stagedMismatchSince) stagedMismatchSince = Date.now();
          if (Date.now() - stagedMismatchSince >= 8000) {
            lastRelaunchError = "binary did not swap";
            term("relaunch: binary did not swap after restart", "err");
            return null;
          }
        } else {
          stagedMismatchSince = 0;
        }
      } catch {
        /* connection drop while restarting is expected */
      }
    }
    // API down (restarting) — reset fail-fast timer
    if (!sawAnyApi) stagedMismatchSince = 0;
  }
  return null;
}

/** Single-flight relaunch — all auto/manual restart paths must use this. */
async function relaunchToVersion(expected) {
  const expectedClean = String(expected || "").replace(/^v/i, "");
  if (!expectedClean) return null;
  if (relaunchInFlight) return relaunchInFlight;

  const key = `noetis_relaunch_attempted_${expectedClean}`;
  try {
    if (sessionStorage.getItem(key)) {
      relaunchGaveUp = true;
      paintSyncLabel(currentAppVersion(), expectedClean);
      return null;
    }
    sessionStorage.setItem(key, "1");
  } catch (_) {}

  relaunchInFlight = (async () => {
    hideUpdateModal();
    pendingUpdate = null;
    toast("Restarting…");
    term(`package ${expectedClean} staged — relaunching…`, "info");
    paintSyncLabel(currentAppVersion(), expectedClean);
    try {
      await postLocal("/api/local/relaunch", {});
    } catch (re) {
      if (!isFetchDropError(re)) {
        term(`relaunch: ${re.message}`, "info");
      }
    }
    const up = await waitForRelaunch(expectedClean);
    if (up) {
      relaunchGaveUp = false;
      toast(`Updated to ${up.app_version}`);
      term(`relaunch ok · now running app ${up.app_version}`, "ok");
      setTimeout(() => location.reload(), 400);
      return up;
    }
    relaunchGaveUp = true;
    const swapFail = lastRelaunchError === "binary did not swap";
    toast(
      swapFail
        ? "Binary did not swap — quit app & reopen to finish"
        : "Couldn't auto-restart — close the app and open it again"
    );
    term(
      swapFail
        ? "relaunch failed — binary did not swap; quit Noeti and reopen"
        : "relaunch timed out — close Noeti and open it again",
      "err"
    );
    paintSyncLabel(currentAppVersion(), expectedClean);
    return null;
  })();

  try {
    return await relaunchInFlight;
  } finally {
    relaunchInFlight = null;
  }
}

async function applyPendingUpdate() {
  if (!pendingUpdate) return;
  const { local, latest, remote } = pendingUpdate;
  hideUpdateModal();
  try {
    localStorage.removeItem(SKIP_UPDATE_KEY);
    sessionStorage.removeItem("noetis_update_prompted");
  } catch (_) {}

  if (isDesktop) {
    try {
      const fresh = await fetchLocalStatus(2, 200);
      if (fresh) paintLocal(fresh);
      const running = String(fresh?.app_version || currentAppVersion()).replace(/^v/i, "");
      const pkg = String(fresh?.package_version || running).replace(/^v/i, "");

      let data = null;
      // Already staged at latest — skip re-download, go straight to relaunch
      if (pkg === latest && running !== latest) {
        term(`package ${pkg} already staged — relaunching…`, "info");
      } else {
        toast("Updating…");
        term(`installing update app ${local} → app ${latest} (binaries + UI)…`, "info");
        data = await postLocal("/api/local/sync", { version: latest });
        const status = data.status || localStatus;
        paintLocal(status);
        term(data.message || "update installed", "ok");
      }

      const statusAfter = data?.status || localStatus;
      const runningAfter = String(statusAfter?.app_version || currentAppVersion()).replace(/^v/i, "");
      const pkgAfter = String(
        statusAfter?.package_version || data?.updated_to || latest
      ).replace(/^v/i, "");
      const needsBinaryRestart = !!(
        data?.relaunch_required ||
        statusAfter?.relaunch_required ||
        (pkgAfter && pkgAfter !== runningAfter) ||
        (pkg === latest && running !== latest)
      );
      paintSyncLabel(runningAfter, latest);

      if (needsBinaryRestart) {
        // Manual update may retry even if an earlier auto attempt failed this session
        try {
          sessionStorage.removeItem(`noetis_relaunch_attempted_${latest || pkgAfter}`);
        } catch (_) {}
        relaunchGaveUp = false;
        await relaunchToVersion(latest || pkgAfter);
        return;
      }
      toast("Update applied — refreshing…");
      setTimeout(() => {
        const u = new URL(window.location.href);
        u.searchParams.set("v", latest);
        window.location.replace(u.toString());
      }, 600);
    } catch (e) {
      const key = detectPlatformKey();
      const url = downloadUrlForKey(remote, key);
      term(`open download (${key}): ${url}`, "info");
      window.open(url, "_blank");
      toast("Couldn't auto-restart — download opened; replace folder and open again");
    }
  } else {
    toast("Updating…");
    await clearPhoneServiceWorker();
    location.reload();
  }
}

/** On load: if package > app, auto-relaunch once (sessionStorage guard against loops). */
async function maybeAutoRelaunchStaged() {
  if (!isDesktop || !localStatus) return;
  const v = String(localStatus.app_version || "").replace(/^v/i, "");
  const pkg = String(localStatus.package_version || "").replace(/^v/i, "");
  const needs =
    !!(localStatus.relaunch_required || (pkg && pkg !== v)) && !!(pkg && pkg !== v);
  if (!needs) return;
  bootHandledStagedRelaunch = true;
  await relaunchToVersion(pkg);
}

async function refreshHub() {
  // Don't thrash the UI under the update dialog (causes "jumping")
  const modal = document.getElementById("updateModal");
  if (modal && !modal.hidden) {
    const res = await fetch(hubApi("/api/status"));
    if (!res.ok) throw new Error(`hub HTTP ${res.status}`);
    lastData = await res.json();
    return lastData;
  }
  const res = await fetch(hubApi("/api/status"));
  if (!res.ok) throw new Error(`hub HTTP ${res.status}`);
  const data = await res.json();
  paintHub(data);
  return data;
}

function paintAccountUI() {
  const logged = isLoggedIn();
  const sess = getSession();
  const userEl = document.getElementById("accountUser");
  const addrEl = document.getElementById("accountAddrShort");
  const username = sess?.username || getActiveUsername() || "";
  if (userEl) userEl.textContent = logged ? username : "guest";
  const w = sess?.wallet || browserWallet || loadWallet();
  if (addrEl) addrEl.textContent = w?.address ? shortAddress(w.address) : "—";
  paintGuestBanner();
}

function paintGuestBanner() {
  const banner = document.getElementById("guestBanner");
  if (banner) banner.hidden = true;
}

function openAuthModal(_mode = "login") {
  /* Account login/signup UI removed — guest wallet is the default. */
}

function closeAuthModal() {
  const modal = document.getElementById("authModal");
  if (modal) modal.hidden = true;
}

async function refreshWalletUI() {
  browserWallet = loadWallet();
  const addr = document.getElementById("walletAddress");
  const bal = document.getElementById("walletBalance");
  paintAccountUI();
  if (!browserWallet) {
    if (addr) addr.textContent = "no wallet — run: wallet create";
    if (bal) bal.textContent = "";
    return;
  }
  if (addr) addr.textContent = browserWallet.address;
  const b = await fetchBalance(browserWallet.address);
  if (bal) {
    bal.textContent = `${b.total ?? b.balance ?? 0} MLC · ${b.staked ?? 0} staked${b.spv_verified ? " · SPV" : ""}`;
  }
}

async function doTransfer(toRaw, amountRaw) {
  const resolved = resolveRecipient(toRaw);
  if (!resolved) throw new Error("unknown recipient — use mlc… address or saved username");
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be > 0");
  browserWallet = loadWallet() || (await getOrCreateWallet());
  if (!browserWallet?.private_key_hex) throw new Error("login or create a wallet first");
  const r = await transferFromBrowser(browserWallet, resolved, amount);
  if (!r.ok) {
    pushTransferLog({ to: resolved, amount, ok: false, note: r.data?.error || "failed" });
    throw new Error(r.data?.error || "transfer failed");
  }
  pushTransferLog({ to: resolved, amount, ok: true });
  await refreshWalletUI();
  await loadTransactions();
  return { to: resolved, amount, data: r.data };
}

async function loadTransactions() {
  try {
    const res = await fetch(hubApi("/api/transactions"));
    const data = await res.json();
    document.getElementById("txLog").innerHTML =
      (data.transactions || [])
        .slice(0, 8)
        .map((tx) => {
          const sign = tx.amount >= 0 ? "+" : "";
          return `<div class="tx">${sign}${tx.amount} ${tx.type || "MLC"} · #${tx.block_index ?? "?"}</div>`;
        })
        .join("") || "";
  } catch {
    /* ignore */
  }
}

async function postLocal(path, body) {
  const res = await fetch(`${LOCAL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (res.status === 404 || res.status === 405) {
    throw new Error("desktop controls unavailable here — on phone just type in chat and hit send");
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function printHelp() {
  const lines = [
    "commands",
    "",
    "Chat: ask, chat, memory, settings, web",
    "  ask <prompt>",
    "  chat list | new | open <id|n> | delete <id|n> | clear",
    "  memory on | off | status",
    "  settings | settings show",
    "  settings mode fast|verified",
    "  settings internet on|off",
    "  settings tokens <256|512|1024|2048>",
    "  web on|off",
    "",
    "Account: login, logout, signup",
    "  login | signup | logout",
    "",
    "Network: status, nodes, mesh, route, task, offers, observer",
    "  status",
    "  nodes",
    "  mesh",
    "  route",
    "  task <id>",
    "  offers",
    "  observer",
    "",
    "Wallet: wallet …",
    "  wallet create | faucet | backup | balance",
    "  wallet transfer <addr|username> <amount>",
    "  faucet   # show faucet_enabled (does not claim)",
    "",
    "Compute: setup, mode, model",
    "  setup [user|compute] [model]",
    "  mode user | mode compute",
    "  model list | use <name> | pull <name>",
    "",
    "System: version, whoami, clear, help",
    "  version",
    "  whoami",
    "  clear",
    "  help",
    "",
    "model sizes:",
    "  qwen2.5:0.5b   Tiny    ~0.4 GB",
    "  llama3.2:1b    Small   ~1.3 GB",
    "  gemma2:2b      Medium  ~1.6 GB",
    "  llama3.2:3b    Large   ~2.0 GB",
    "  qwen2.5:7b     XL      ~4.7 GB",
    "",
    "example:  setup compute llama3.2:1b",
  ];
  lines.forEach((l) => term(l, l.startsWith(" ") || !l ? "info" : "ok"));
}

async function runCommand(raw) {
  const line = raw.trim();
  if (!line) return;
  term(`» ${line}`, "cmd");
  history.push(line);
  histIdx = history.length;
  const parts = line.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  try {
    if (cmd === "help" || cmd === "?") {
      printHelp();
      return;
    }
    if (cmd === "status") {
      const local = await fetchLocalStatus();
      if (local) {
        paintLocal(local);
        term(local.message || "ok", "ok");
        term(`model=${local.model} ollama=${local.ollama_ok} worker=${local.compute_running} bin=${local.compute_binary}`, "info");
        if (local.compute_path) term(`bin ${local.compute_path}`, "info");
        (local.log || []).slice(-6).forEach((l) => term(l, "info"));
      } else {
        term("remote / phone mode — download desktop app for local setup", "info");
      }
      await refreshHub();
      return;
    }
    if (cmd === "setup") {
      const mode = (args[0] || "user").toLowerCase();
      const model = args[1] || undefined;
      term("starting setup…", "info");
      toast("setup running…");
      let nodeId = localNodeId();
      if (mode === "compute" || mode === "both") {
        nodeId = await resolveEarnNodeId();
      }
      const data = await postLocal("/api/local/setup", {
        mode,
        model,
        ...(nodeId ? { node_id: nodeId } : {}),
      });
      paintLocal(data.status);
      const seen = (data.status?.log || []).length;
      (data.status?.log || []).slice(-4).forEach((l) => term(l, "ok"));
      const finalStatus = data.started
        ? await pollSetupUntilDone(seen)
        : data.status;
      paintLocal(finalStatus);
      if (finalStatus?.last_error) {
        throw new Error(finalStatus.last_error);
      }
      term(finalStatus?.message || "setup done", "ok");
      if (mode === "compute") {
        try {
          nodeId = nodeId || (await resolveEarnNodeId());
          browserWallet = await getOrCreateWallet();
          term("ensuring stake (faucet if needed)…", "info");
          const stake = await ensureStakeForNode(browserWallet, nodeId, 10);
          await refreshWalletUI();
          term(stake.already ? "already staked · eligible" : `staked for ${nodeId} ✓`, "ok");
        } catch (e) {
          term(`earn blocked: ${e.message}`, "err");
          toast(e.message);
        }
      }
      toast("setup complete");
      return;
    }
    if (cmd === "model") {
      const sub = (args[0] || "list").toLowerCase();
      if (sub === "list") {
        const local = await fetchLocalStatus();
        if (!local) throw new Error("desktop app required");
        paintLocal(local);
        term("installed:", "ok");
        (local.models || []).forEach((m) => term(`  ${m}`, "info"));
        term("suggested (pick one):", "ok");
        (local.suggested_models || []).forEach((m) => {
          if (typeof m === "string") term(`  ${m}`, "info");
          else term(`  ${(m.id || "").padEnd(14)} ${(m.label || "").padEnd(7)} ${m.size || ""}  — ${m.note || ""}`, "info");
        });
        return;
      }
      if (sub === "use") {
        const model = args[1];
        if (!model) throw new Error("usage: model use <name>");
        const data = await postLocal("/api/local/mode", { mode: localStatus?.mode || "user", model });
        paintLocal(data.status);
        term(`model → ${model}`, "ok");
        return;
      }
      if (sub === "pull") {
        const model = args[1];
        if (!model) throw new Error("usage: model pull <name>");
        term(`pulling ${model}…`, "info");
        toast(`pulling ${model}`);
        updateSetupProgress({ setup_busy: true, setup_percent: 5, setup_phase: `pulling ${model}…` });
        const data = await postLocal("/api/local/models/pull", { model });
        paintLocal(data.status);
        updateSetupProgress({ setup_busy: false, setup_percent: 100, setup_phase: "model ready" });
        term(`pulled ${model}`, "ok");
        toast("model ready");
        return;
      }
      throw new Error("usage: model list|use|pull");
    }
    if (cmd === "mode") {
      const mode = (args[0] || "").toLowerCase();
      if (mode !== "user" && mode !== "compute") throw new Error("usage: mode user|compute");
      term(`switching → ${mode}`, "info");
      let nodeId = localNodeId();
      if (mode === "compute") {
        nodeId = await resolveEarnNodeId();
      }
      const data = await postLocal("/api/local/mode", {
        mode,
        ...(nodeId ? { node_id: nodeId } : {}),
        model: localStatus?.model,
      });
      paintLocal(data.status);
      term(data.status?.message || mode, "ok");
      if (mode === "compute") {
        try {
          browserWallet = await getOrCreateWallet();
          term("ensuring stake (faucet if needed)…", "info");
          const stake = await ensureStakeForNode(browserWallet, nodeId, 10);
          await refreshWalletUI();
          term(stake.already ? "already staked · eligible" : `staked for ${nodeId} ✓`, "ok");
        } catch (e) {
          term(`earn blocked: ${e.message}`, "err");
          toast(e.message);
          return;
        }
      }
      return;
    }
    if (cmd === "wallet") {
      const sub = (args[0] || "balance").toLowerCase();
      if (sub === "create") {
        browserWallet = await createWallet();
        term(`wallet ${browserWallet.address}`, "ok");
        await refreshWalletUI();
        return;
      }
      if (sub === "faucet") {
        browserWallet = await getOrCreateWallet();
        const r = await requestFaucet(browserWallet.address);
        if (!r.ok) throw new Error(r.data.error || "faucet failed");
        term(`faucet +${r.data.amount} MLC`, "ok");
        await refreshWalletUI();
        await loadTransactions();
        return;
      }
      if (sub === "backup") {
        downloadWalletBackup();
        term("wallet backup downloaded", "ok");
        return;
      }
      if (sub === "balance") {
        await refreshWalletUI();
        term(document.getElementById("walletBalance").textContent || "—", "ok");
        return;
      }
      if (sub === "transfer" || sub === "send") {
        const to = args[1];
        const amt = args[2];
        if (!to || amt == null) throw new Error("usage: wallet transfer <addr|username> <amount>");
        const r = await doTransfer(to, amt);
        term(`sent ${r.amount} MLC → ${r.to}`, "ok");
        toast(`sent ${r.amount} MLC`);
        return;
      }
      throw new Error("usage: wallet create|faucet|backup|balance|transfer");
    }
    if (cmd === "settings") {
      const sub = (args[0] || "show").toLowerCase();
      if (sub === "show" || sub === "") {
        const s = loadChatSettings();
        term(
          `settings mode=${s.spendMode} internet=${s.internet ? "on" : "off"} tokens=${s.maxTokens}`,
          "ok"
        );
        return;
      }
      if (sub === "mode") {
        const m = (args[1] || "").toLowerCase();
        if (m !== "fast" && m !== "verified") throw new Error("usage: settings mode fast|verified");
        saveChatSettings({ spendMode: m });
        term(`settings mode=${m}`, "ok");
        toast(`spend ${m}`);
        return;
      }
      if (sub === "internet") {
        const v = (args[1] || "").toLowerCase();
        if (v !== "on" && v !== "off") throw new Error("usage: settings internet on|off");
        saveChatSettings({ internet: v === "on" });
        term(`settings internet=${v}`, "ok");
        toast(`internet ${v}`);
        return;
      }
      if (sub === "tokens" || sub === "max_tokens" || sub === "maxtokens") {
        const n = Number(args[1]);
        if (!TOKEN_CHOICES.includes(n)) {
          throw new Error("usage: settings tokens 256|512|1024|2048");
        }
        saveChatSettings({ maxTokens: n });
        term(`settings tokens=${n}`, "ok");
        toast(`tokens ${n}`);
        return;
      }
      throw new Error("usage: settings show|mode|internet|tokens");
    }
    if (cmd === "web") {
      const v = (args[0] || "").toLowerCase();
      if (v !== "on" && v !== "off") throw new Error("usage: web on|off");
      saveChatSettings({ internet: v === "on" });
      term(`internet ${v}`, "ok");
      toast(`internet ${v}`);
      return;
    }
    if (cmd === "login" || cmd === "signup") {
      term("account login removed — guest wallet works without signup", "info");
      return;
    }
    if (cmd === "logout") {
      authLogout();
      browserWallet = null;
      await refreshWalletUI();
      term("session cleared — guest wallet via auto-onboard", "ok");
      toast("session cleared");
      return;
    }
    if (cmd === "ask") {
      const prompt = args.join(" ");
      if (!prompt) throw new Error("usage: ask <text>");
      document.getElementById("promptInput").value = prompt;
      await submitPrompt();
      return;
    }
    if (cmd === "clear") {
      document.getElementById("termOut").innerHTML = "";
      return;
    }
    if (cmd === "chat") {
      const sub = (args[0] || "").toLowerCase();
      if (sub === "clear" || sub === "new") {
        newConversation();
        return;
      }
      if (sub === "list" || sub === "") {
        const items = listConversations();
        if (!items.length) {
          term("no conversations", "info");
          return;
        }
        term(`${items.length} conversation${items.length === 1 ? "" : "s"}`, "ok");
        items.forEach((c, i) => {
          const mark = c.id === activeConversationId ? "*" : " ";
          term(
            `${mark} ${String(i + 1).padStart(2)}  ${c.id}  ${c.title}  (${relativeTime(c.updatedAt)})`,
            "info"
          );
        });
        return;
      }
      if (sub === "open") {
        const key = args[1];
        if (!key) throw new Error("usage: chat open <id|n>");
        const found = resolveConversationRef(key);
        if (!found) throw new Error("conversation not found");
        openConversation(found.id);
        return;
      }
      if (sub === "delete") {
        const key = args[1];
        if (!key) throw new Error("usage: chat delete <id|n>");
        const found = resolveConversationRef(key);
        if (!found) throw new Error("conversation not found");
        deleteConversation(found.id);
        return;
      }
      throw new Error("usage: chat list|new|open|delete|clear");
    }
    if (cmd === "memory") {
      const sub = (args[0] || "status").toLowerCase();
      if (sub === "status" || sub === "") {
        const on = isChatMemoryOn();
        term(`memory ${on ? "on" : "off"}`, "ok");
        toast(`memory ${on ? "on" : "off"}`);
        return;
      }
      if (sub === "on") {
        setChatMemoryOn(true);
        term("memory on", "ok");
        toast("memory on");
        return;
      }
      if (sub === "off") {
        setChatMemoryOn(false);
        term("memory off", "ok");
        toast("memory off");
        return;
      }
      throw new Error("usage: memory on|off|status");
    }
    if (cmd === "nodes") {
      const data = lastData || (await refreshHub().catch(() => null));
      const nodes = data?.nodes || [];
      if (!nodes.length) {
        term("no compute nodes online", "info");
        return;
      }
      term(`compute nodes (${nodes.length})`, "ok");
      for (const n of nodes) {
        const id = n.node_id || n.worker_id || "?";
        const runtime = n.runtime || "—";
        const model = n.model || "—";
        const tier = n.capability_tier || n.tier || "—";
        term(`  ${id}  runtime=${runtime}  model=${model}  tier=${tier}`, "info");
      }
      return;
    }
    if (cmd === "mesh") {
      const data = lastData || (await refreshHub().catch(() => null));
      const mesh = data?.mesh || {};
      const peers = mesh.peers || mesh.mesh_peers || [];
      let gossip = mesh.task_gossip || data?.task_gossip || {};
      term("mesh", "ok");
      if (typeof mesh.mesh_port !== "undefined") term(`  mesh_port=${mesh.mesh_port}`, "info");
      if (peers.length) {
        term(`  peers (${peers.length})`, "info");
        for (const p of peers.slice(0, 24)) {
          if (typeof p === "string") term(`    ${p}`, "info");
          else term(`    ${p.peer || p.url || p.id || JSON.stringify(p)}`, "info");
        }
      } else {
        try {
          const dres = await fetch(hubApi("/api/discovery"), { cache: "no-store" });
          const disc = dres.ok ? await dres.json() : {};
          const dpeers = disc.mesh_peers || [];
          if (dpeers.length) {
            term(`  peers (${dpeers.length}) via discovery`, "info");
            for (const p of dpeers.slice(0, 24)) {
              if (typeof p === "string") term(`    ${p}`, "info");
              else term(`    ${p.peer || p.url || p.id || JSON.stringify(p)}`, "info");
            }
          } else {
            term("  peers=none", "info");
          }
          if (disc.task_gossip && !(gossip && Object.keys(gossip).length)) {
            gossip = disc.task_gossip;
          }
        } catch {
          term("  peers=none", "info");
        }
      }
      const gkeys = Object.keys(gossip || {});
      if (gkeys.length) {
        term(`  task_gossip keys=${gkeys.length}`, "info");
        const sample = gkeys.slice(0, 6).map((k) => {
          const v = gossip[k];
          if (v && typeof v === "object") return `${k}:${v.status || v.state || "ok"}`;
          return String(k);
        });
        term(`    ${sample.join(" · ")}`, "info");
      } else {
        term("  task_gossip=none", "info");
      }
      return;
    }
    if (cmd === "route") {
      const data = lastData || (await refreshHub().catch(() => null));
      const r = data?.last_route;
      if (!r) {
        term("no last_route yet — send a chat first", "info");
        return;
      }
      term("last_route", "ok");
      term(
        `  tokens≈${r.tokens_est ?? "?"}  complexity=${r.complexity ?? "?"}  tier=${r.tier ?? "?"}`,
        "info"
      );
      term(
        `  mode=${r.mode ?? "—"}  internet=${typeof r.internet === "boolean" ? (r.internet ? "on" : "off") : "—"}  web=${typeof r.web_context === "boolean" ? (r.web_context ? "ok" : "fail") : "—"}  num_predict=${r.num_predict ?? "—"}`,
        "info"
      );
      term(
        `  assigned=${r.assigned ?? "—"}  model=${r.model || r.preferred_model || "—"}  task=${r.task_id || "—"}`,
        "info"
      );
      return;
    }
    if (cmd === "task") {
      const taskId = args[0];
      if (!taskId) throw new Error("usage: task <id>");
      const taskUrl = isDesktop
        ? `${LOCAL}/api/local/task/${encodeURIComponent(taskId)}`
        : hubApi(`/api/task/${encodeURIComponent(taskId)}`);
      let tres = await fetch(taskUrl, { cache: "no-store" });
      if (isDesktop && (tres.status === 404 || tres.status === 405)) {
        tres = await fetch(hubApi(`/api/task/${encodeURIComponent(taskId)}`), { cache: "no-store" });
      }
      const task = await tres.json().catch(() => ({}));
      if (!tres.ok) throw new Error(task.error || `task HTTP ${tres.status}`);
      const state = task.status || "unknown";
      const snippet = String(task.consensus_response || task.response || "").replace(/\s+/g, " ").slice(0, 160);
      term(`task ${taskId}`, "ok");
      term(`  status=${state}  tier=${task.tier || "—"}  tokens≈${task.tokens_est ?? "—"}`, "info");
      if (task.assigned) {
        const a = Array.isArray(task.assigned) ? task.assigned.join(",") : task.assigned;
        term(`  assigned=${a || "—"}`, "info");
      }
      if (snippet) term(`  response: ${snippet}${snippet.length >= 160 ? "…" : ""}`, "info");
      else term("  response: (none yet)", "info");
      return;
    }
    if (cmd === "version") {
      const hub = lastData || (await refreshHub().catch(() => null));
      const local = localStatus || (await fetchLocalStatus());
      const appV = currentAppVersion();
      const pkg = String(local?.package_version || appV).replace(/^v/i, "");
      const hubV = String(hub?.app_version || "—").replace(/^v/i, "");
      term(`app ${appV}  package ${pkg}  hub ${hubV}`, "ok");
      return;
    }
    if (cmd === "observer") {
      const hubBase = (HUB || window.location.origin || "").replace(/\/$/, "");
      const publicObs = "https://noeticompute.com/observer";
      const localObs = hubBase ? `${hubBase}/observer` : "/observer";
      term(publicObs, "ok");
      if (localObs !== publicObs) term(`hub: ${localObs}`, "info");
      return;
    }
    if (cmd === "faucet") {
      const data = lastData || (await refreshHub().catch(() => null));
      let enabled = data?.faucet_enabled;
      let mode = data?.faucet_mode;
      if (typeof enabled === "undefined") {
        try {
          const dres = await fetch(hubApi("/api/discovery"), { cache: "no-store" });
          const disc = dres.ok ? await dres.json() : {};
          enabled = disc.faucet_enabled;
          mode = disc.faucet_mode;
        } catch (_) {}
      }
      if (enabled) {
        term(`faucet_enabled=true${mode ? `  mode=${mode}` : ""}`, "ok");
        term("claim with: wallet faucet", "info");
      } else {
        term(`faucet_enabled=false${mode ? `  mode=${mode}` : ""} — not claiming`, "info");
      }
      return;
    }
    if (cmd === "offers") {
      let nodeId = localNodeId();
      if (!nodeId) {
        try {
          nodeId = localStorage.getItem(PHONE_NODE_KEY) || "";
        } catch (_) {}
      }
      if (!nodeId) throw new Error("no node_id — start Earn / register first");
      const res = await fetch(hubApi(`/api/compute/offers?node_id=${encodeURIComponent(nodeId)}`), {
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `offers HTTP ${res.status}`);
      const offers = data.offers || [];
      term(`offers for ${nodeId}: ${data.count ?? offers.length}`, "ok");
      for (const o of offers.slice(0, 12)) {
        term(
          `  ${o.task_id || "?"}  tier=${o.tier || "—"}  tokens≈${o.tokens_est ?? "—"}  model=${o.preferred_model || "—"}`,
          "info"
        );
      }
      if (!offers.length) term("  (none open)", "info");
      return;
    }
    if (cmd === "whoami") {
      let nodeId = localNodeId();
      if (!nodeId) {
        try {
          nodeId = localStorage.getItem(PHONE_NODE_KEY) || "";
        } catch (_) {}
      }
      const w = browserWallet || loadWallet();
      const addr = w?.address ? shortAddress(w.address) : "—";
      const user = isLoggedIn() ? getSession()?.username || getActiveUsername() : "guest";
      const mode =
        localStatus?.dual_mode && localStatus?.compute_running
          ? "chat+earn"
          : localStatus?.compute_running
            ? "earn"
            : uiView || "chat";
      const s = loadChatSettings();
      term(
        `user=${user}  node_id=${nodeId || "—"}  wallet=${addr}  mode=${mode}  spend=${s.spendMode}`,
        "ok"
      );
      return;
    }
    throw new Error(`unknown command: ${cmd}  (try help)`);
  } catch (e) {
    term(e.message || String(e), "err");
    toast(e.message || "error");
  }
}

async function submitPrompt() {
  const input = document.getElementById("promptInput");
  const text = input.value.trim();
  if (!text) return;
  const btn = document.getElementById("sendBtn");
  btn.disabled = true;
  setChatProgress(true, "1/3 · Sending…");
  addMessage("user", text);
  input.value = "";
  input.style.height = "";
  // Build wire WITH prior turns, then store this user turn for the next follow-up
  const wireText = buildWirePrompt(text);
  pushChatTurn("user", text);
  const histN = chatHistory.filter((t) => t.role === "user").length;
  const memOn = isChatMemoryOn();
  term(
    !memOn
      ? `ask (memory off, ${wireText.length} chars) → ${text.slice(0, 50)}${text.length > 50 ? "…" : ""}`
      : histN > 1
        ? `ask (follow-up ${histN}, ${wireText.length} chars) → ${text.slice(0, 50)}${text.length > 50 ? "…" : ""}`
        : `ask → ${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`,
    "in"
  );

  try {
    const chatSettings = loadChatSettings();
    const sportsAsk =
      /\b(fifa|world\s*cup|uefa|nba|nfl|mlb|nhl|premier\s*league|match|score|champions\s*league)\b/i.test(
        wireText || text || ""
      );
    if (sportsAsk && !chatSettings.internet) {
      toast("Enable Internet for live sports facts");
    }
    const inferBody = {
      text: wireText,
      mode: chatSettings.spendMode === "verified" ? "verified" : "fast",
      internet: !!chatSettings.internet,
      max_tokens: chatSettings.maxTokens,
    };
    term(
      `spend=${inferBody.mode} internet=${inferBody.internet ? "on" : "off"} tokens=${inferBody.max_tokens}`,
      "info"
    );
    // Desktop: prefer local node proxy (mesh path); phone: entry bootstrap API
    const inferUrl = isDesktop ? `${LOCAL}/api/local/infer` : hubApi("/api/infer");
    let res = await fetch(inferUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inferBody),
    });
    // Fallback to hub if local proxy missing (old desktop build)
    if (isDesktop && (res.status === 404 || res.status === 405)) {
      res = await fetch(hubApi("/api/infer"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inferBody),
      });
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "request failed");
    const taskId = data.task_id;
    if (!taskId) throw new Error("no task_id from network — update hub");

    setChatProgress(true, `2/3 · Task ${taskId.slice(0, 6)}…`);
    let gotAnswer = false;
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const taskUrl = isDesktop
        ? `${LOCAL}/api/local/task/${encodeURIComponent(taskId)}`
        : hubApi(`/api/task/${encodeURIComponent(taskId)}`);
      let tres = await fetch(taskUrl, { cache: "no-store" });
      if (isDesktop && (tres.status === 404 || tres.status === 405)) {
        tres = await fetch(hubApi(`/api/task/${encodeURIComponent(taskId)}`), { cache: "no-store" });
      }
      const task = await tres.json().catch(() => ({}));
      if (!tres.ok && tres.status !== 404) throw new Error(task.error || `task HTTP ${tres.status}`);

      await refreshHub().catch(() => {});
      if (task.status === "running") {
        setChatProgress(
          true,
          task.workers_responded
            ? `3/3 · ${task.workers_responded} result(s)…`
            : "2/3 · Waiting for compute…"
        );
      }
      if (task.status === "done" && task.consensus_response) {
        const lr = task.last_route || lastData?.last_route;
        const metaBits = [];
        if (isDesktop) {
          metaBits.push(
            `task ${taskId.slice(0, 8)} · verified ${task.workers_matched ?? "?"}/${task.workers_responded ?? "?"}`
          );
        }
        if (lr && lr.internet && typeof lr.web_context === "boolean") {
          metaBits.push(`web=${lr.web_context ? "ok" : "fail"}`);
        }
        addMessage(
          "ai",
          task.consensus_response,
          metaBits.length ? metaBits.join(" · ") : undefined
        );
        pushChatTurn("ai", task.consensus_response);
        term(`consensus ok · task ${taskId}`, "ok");
        if (lr && (lr.task_id === taskId || !lr.task_id)) {
          const modeBit = lr.mode ? ` mode=${lr.mode}` : "";
          const netBit =
            lr.internet && typeof lr.web_context === "boolean"
              ? ` web=${lr.web_context ? "ok" : "fail"}`
              : typeof lr.internet === "boolean"
                ? ` web=${lr.internet ? "on" : "off"}`
                : "";
          term(
            `route tier=${lr.tier ?? "?"} tokens≈${lr.tokens_est ?? "?"}${modeBit}${netBit} → ${lr.assigned || lr.model || "—"}`,
            "info"
          );
        }
        await loadTransactions();
        gotAnswer = true;
        break;
      }
      if (i > 8 && (lastData?.compute_count || 0) === 0 && task.status !== "done") {
        // keep waiting if local fallback may finish
        setChatProgress(true, "2/3 · No remote compute — hub may use local fallback…");
      }
    }
    if (!gotAnswer) throw new Error("timed out waiting for network answer");
  } catch (err) {
    addMessage("system", err.message);
    term(err.message, "err");
    toast(err.message);
  } finally {
    btn.disabled = false;
    setChatProgress(false);
    await refreshHub().catch(() => {});
    input.focus();
  }
}

window.submitPrompt = submitPrompt;

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("hubPill").textContent = (HUB || window.location.host).replace(/^https?:\/\//, "");
  term("noeti", "ok");
  term("pick Chat or Earn — we install everything", "info");

  document.getElementById("onboardChat")?.addEventListener("click", () => {
    applyView("chat");
    runOnboarding("user");
  });
  document.getElementById("onboardEarn")?.addEventListener("click", () => {
    applyView("earn");
    runOnboarding("compute");
  });
  document.getElementById("onboardBoth")?.addEventListener("click", () => {
    applyView("chat");
    runOnboarding("both");
  });

  document.getElementById("btnChat")?.addEventListener("click", async () => {
    // View-only switch — never stop the earn worker
    applyView("chat");
    if (!isDesktop) {
      document.getElementById("promptInput")?.focus();
      toast("type below and hit send");
      return;
    }
    toast("chat");
  });
  document.getElementById("btnEarn")?.addEventListener("click", async () => {
    if (!isDesktop) {
      // PC opened the website by mistake — jump to local desktop app if running
      if (!isPhoneUserAgent() && (await redirectToLocalDesktopIfRunning())) return;
      if (isLocalAppHost()) {
        // Local shell but API not ready yet — keep trying, don't treat as phone
        setDesktopMode(true);
        toast("desktop engine starting — tap Earn again in a second");
        term("local API not ready yet — wait 1s and tap Earn again", "info");
        return;
      }
      // Phone / mobile browser — in-tab WebLLM / Transformers.js earn
      if (isPhoneUserAgent()) {
        await togglePhoneEarn();
        return;
      }
      toast("Earn needs the desktop app — open START from /download");
      term("Earn blocked: open the desktop zip UI at http://127.0.0.1:5056", "err");
      return;
    }
    applyView("earn");
    try {
      if (localStatus?.compute_running) {
        toast("earn · on");
        return;
      }
      if (localStatus?.dual_mode) {
        await setModeButton("both");
      } else {
        await setModeButton("compute");
      }
    } catch (e) {
      term(e.message, "err");
      toast(e.message);
    }
  });
  document.getElementById("btnPhoneEarn")?.addEventListener("click", async () => {
    await togglePhoneEarn();
  });
  document.getElementById("btnStopEarn")?.addEventListener("click", async () => {
    if (!isDesktop) {
      if (window.NoetiBrowserCompute?.isRunning?.()) await togglePhoneEarn();
      return;
    }
    try {
      await setModeButton("stop", { stop_compute: true });
      applyView("chat");
    } catch (e) {
      term(e.message, "err");
      toast(e.message);
    }
  });
  document.getElementById("btnSync")?.addEventListener("click", () => checkForUpdates(true));
  document.getElementById("versionBadge")?.addEventListener("click", () => checkForUpdates(false));
  document.getElementById("updateYes")?.addEventListener("click", () => applyPendingUpdate());
  document.getElementById("updateNo")?.addEventListener("click", () => skipPendingUpdate());
  document.getElementById("updateModal")?.addEventListener("click", (e) => {
    if (e.target?.id === "updateModal") skipPendingUpdate();
  });
  document.getElementById("modelSelect")?.addEventListener("change", async (e) => {
    if (!isDesktop) return;
    const model = e.target.value;
    try {
      term(`model → ${model}`, "info");
      const nodeId = localNodeId();
      const data = await postLocal("/api/local/mode", {
        mode: localStatus?.dual_mode && localStatus?.compute_running
          ? "both"
          : localStatus?.compute_running
            ? "compute"
            : "user",
        model,
        ...(nodeId ? { node_id: nodeId } : {}),
      });
      paintLocal(data.status);
      toast(`model ${model}`);
    } catch (err) {
      term(err.message, "err");
    }
  });
  document.getElementById("btnPullModel")?.addEventListener("click", async () => {
    if (!isDesktop) return;
    const model = document.getElementById("modelSelect")?.value;
    if (!model) return;
    try {
      term(`pulling ${model}…`, "info");
      toast(`pulling ${model}`);
      updateSetupProgress({ setup_busy: true, setup_percent: 5, setup_phase: `pulling ${model}…` });
      const data = await postLocal("/api/local/models/pull", { model });
      paintLocal(data.status);
      updateSetupProgress({ setup_busy: false, setup_percent: 100, setup_phase: "model ready" });
      term(`pulled ${model}`, "ok");
      toast("model ready");
    } catch (err) {
      term(err.message, "err");
      toast(err.message);
    }
  });

  document.getElementById("termForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("termInput");
    const v = input.value;
    input.value = "";
    runCommand(v);
  });

  const termInput = document.getElementById("termInput");
  termInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (histIdx > 0) {
        histIdx -= 1;
        termInput.value = history[histIdx] || "";
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histIdx < history.length - 1) {
        histIdx += 1;
        termInput.value = history[histIdx] || "";
      } else {
        histIdx = history.length;
        termInput.value = "";
      }
    }
  });

  document.getElementById("clearChatBtn")?.addEventListener("click", () => newConversation());
  document.getElementById("convNewBtn")?.addEventListener("click", () => newConversation());
  document.getElementById("historyBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeSettingsPanel();
    toggleHistoryPanel();
  });
  document.getElementById("settingsBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeHistoryPanel();
    toggleSettingsPanel();
  });
  document.getElementById("settingsClose")?.addEventListener("click", () => closeSettingsPanel());
  document.getElementById("spendModeGroup")?.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".seg-btn[data-spend]");
    if (!btn) return;
    saveChatSettings({ spendMode: btn.dataset.spend });
    toast(`spend ${btn.dataset.spend}`);
  });
  document.getElementById("internetToggle")?.addEventListener("change", (e) => {
    saveChatSettings({ internet: !!e.target.checked });
    toast(e.target.checked ? "internet on" : "internet off");
  });
  document.getElementById("maxTokensSelect")?.addEventListener("change", (e) => {
    saveChatSettings({ maxTokens: Number(e.target.value) });
    toast(`tokens ${e.target.value}`);
  });
  document.getElementById("chatHistoryClose")?.addEventListener("click", () => closeHistoryPanel());
  document.getElementById("chatHistoryBackdrop")?.addEventListener("click", () => closeHistoryPanel());
  const onConvClick = (e) => {
    const del = e.target.closest?.(".chat-history-delete, .conv-delete");
    if (del?.dataset?.id) {
      e.preventDefault();
      e.stopPropagation();
      deleteConversation(del.dataset.id);
      return;
    }
    const openBtn = e.target.closest?.(
      ".chat-history-open, .chat-history-item, .conv-open, .conv-item"
    );
    if (openBtn?.dataset?.id) {
      e.preventDefault();
      openConversation(openBtn.dataset.id);
    }
  };
  document.getElementById("chatHistoryList")?.addEventListener("click", onConvClick);
  document.getElementById("convList")?.addEventListener("click", onConvClick);
  document.addEventListener("click", (e) => {
    const hist = document.getElementById("chatHistoryPanel");
    if (hist && !hist.hidden) {
      if (!e.target.closest?.("#historyBtn") && !e.target.closest?.(".chat-history-sheet")) {
        closeHistoryPanel();
      }
    }
    const settings = document.getElementById("chatSettingsPanel");
    if (settings && !settings.hidden) {
      if (!e.target.closest?.("#settingsBtn") && !e.target.closest?.(".chat-settings-sheet")) {
        closeSettingsPanel();
      }
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeHistoryPanel();
      closeSettingsPanel();
      closeAuthModal();
    }
  });
  document.getElementById("memoryToggleBtn")?.addEventListener("click", () => {
    const on = setChatMemoryOn(!isChatMemoryOn());
    toast(on ? "memory on" : "memory off");
    term(`memory ${on ? "on" : "off"}`, "ok");
  });
  document.getElementById("accountBtn")?.addEventListener("click", () => {
    const w = browserWallet || loadWallet();
    if (w?.address) {
      toast(`guest · ${shortAddress(w.address)}`);
      term(`wallet ${shortAddress(w.address)}`, "ok");
    } else {
      toast("no wallet yet");
    }
  });
  document.getElementById("btnLogout")?.addEventListener("click", async () => {
    authLogout();
    browserWallet = null;
    await refreshWalletUI();
    toast("session cleared");
    term("session cleared", "ok");
  });
  document.getElementById("transferForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const to = document.getElementById("transferTo")?.value || "";
    const amount = document.getElementById("transferAmount")?.value || "";
    try {
      const r = await doTransfer(to, amount);
      term(`sent ${r.amount} MLC → ${r.to}`, "ok");
      toast(`sent ${r.amount} MLC`);
      const amtEl = document.getElementById("transferAmount");
      if (amtEl) amtEl.value = "";
    } catch (ex) {
      term(ex.message || String(ex), "err");
      toast(ex.message || "transfer failed");
    }
  });
  paintMemoryToggle();
  paintChatSettings();
  paintTransferLog();
  updateChatMeta();
  renderConvList();
  document.getElementById("sendBtn").addEventListener("click", () => submitPrompt());
  const promptInput = document.getElementById("promptInput");
  promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitPrompt();
    }
  });
  promptInput.addEventListener("input", () => {
    promptInput.style.height = "auto";
    promptInput.style.height = `${Math.min(140, promptInput.scrollHeight)}px`;
  });

  try {
    // Desktop must never be stuck in phone mode.
    if (isLocalAppHost()) await clearPhoneServiceWorker();
    else if (!isPhoneUserAgent()) await redirectToLocalDesktopIfRunning();

    const local = await fetchLocalStatus(isLocalAppHost() ? 20 : 2, 200);
    if (local) {
      paintLocal({ ...local, desktop: true });
      showOnboardingIfNeeded(local);
      applyView(uiView);
      if (!local.needs_onboarding) term("desktop ready — Earn is available", "ok");
      await maybeAutoRelaunchStaged();
      checkForUpdates(false).catch(() => {});
    } else if (isLocalAppHost()) {
      setDesktopMode(true);
      applyView(uiView);
      term("desktop shell — waiting for local API on :5056…", "info");
      paintSyncLabel(APP_VERSION);
    } else if (!isPhoneUserAgent()) {
      // PC browsing the website — not phone, but Earn needs local app
      setDesktopMode(false);
      applyView("chat");
      paintSyncLabel(APP_VERSION);
      term("PC detected — run START from /download (opens http://127.0.0.1:5056) to Earn", "info");
      await redirectToLocalDesktopIfRunning();
    } else {
      setDesktopMode(false);
      applyView("chat");
      term("phone mode — Chat + Earn (browser compute · keep tab open)", "info");
      paintSyncLabel(APP_VERSION);
      paintPhoneEarnUI();
    }
  } catch (_) {
    if (isLocalAppHost()) setDesktopMode(true);
    else setDesktopMode(false);
    applyView("chat");
    paintSyncLabel(APP_VERSION);
  }

  try {
    await refreshHub();
    term("hub connected", "ok");
  } catch (e) {
    term(`hub: ${e.message}`, "err");
  }

  tryRestoreSession();
  try {
    if (isLoggedIn()) {
      browserWallet = getSession()?.wallet || loadWallet();
      term(`logged in as ${getSession()?.username}`, "ok");
    } else {
      const result = await autoOnboard();
      browserWallet = result.wallet;
      if (result.faucet?.ok) term(`wallet + faucet ${result.faucet.data.amount} MLC`, "ok");
      else if (result.wallet) term(`wallet ${result.wallet.address.slice(0, 18)}…`, "ok");
    }
  } catch (e) {
    term(`wallet: ${e.message}`, "err");
  }
  await refreshWalletUI();
  await loadTransactions();
  paintGuestBanner();

  setInterval(() => refreshHub().catch(() => {}), 2500);
  setInterval(async () => {
    const s = await fetchLocalStatus();
    if (s) {
      const wasPhone = !isDesktop;
      paintLocal(s);
      showOnboardingIfNeeded(s);
      if (wasPhone && isDesktop) {
        term("desktop ready", "ok");
        checkForUpdates(false).catch(() => {});
      }
    }
  }, 2500);
  setInterval(loadTransactions, 10000);

  if ("serviceWorker" in navigator && !isLocalAppHost() && isPhoneUserAgent()) {
    navigator.serviceWorker.register(new URL("sw.js", window.location.href).pathname).catch(() => {});
  } else if (isLocalAppHost()) {
    clearPhoneServiceWorker();
  }
  applyView(uiView);
  paintChatPane();
  paintSyncLabel(localStatus?.app_version || APP_VERSION);

  // Periodic quiet sync (desktop only)
  setInterval(() => {
    if (isDesktop) checkForUpdates(false).catch(() => {});
  }, 30 * 60 * 1000);
  termInput.focus();
});
