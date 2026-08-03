/**
 * Noeti Chat Plus — streaming, assistants, web search, multimodal,
 * artifacts, model cards, compare, cloud history sync.
 * Loaded after chat.js; patches window.__noetiChat hooks if present,
 * otherwise self-binds to DOM.
 */
(() => {
  const app = document.getElementById("chatApp");
  if (!app) return;

  let assistants = [];
  let assistantId = localStorage.getItem("noeti_assistant") || "default";
  // One-time: Code workbench was sticky and made everyday Qs into scripts — reset to normal chat
  if (!localStorage.getItem("noeti_assistant_norm_v1")) {
    if (assistantId === "coder") assistantId = "default";
    localStorage.setItem("noeti_assistant", assistantId);
    localStorage.setItem("noeti_assistant_norm_v1", "1");
  }
  let pendingImages = []; // data URLs
  let compareMode = false;
  let compareModelB = localStorage.getItem("noeti_compare_b") || "anthropic/claude-sonnet-4";
  let streamAbort = null;

  const els = {
    assistantSel: document.getElementById("assistantSelect"),
    webSearch: document.getElementById("toggleWebSearch"),
    compareToggle: document.getElementById("toggleCompare"),
    systemPrompt: document.getElementById("setSystemPrompt"),
    imgInput: document.getElementById("chatImageInput"),
    imgBtn: document.getElementById("btnAttachImage"),
    imgPreview: document.getElementById("imagePreview"),
    artifacts: document.getElementById("artifactsPanel"),
    artifactsBody: document.getElementById("artifactsBody"),
    comparePane: document.getElementById("comparePane"),
    compareA: document.getElementById("compareOutA"),
    compareB: document.getElementById("compareOutB"),
    syncBtn: document.getElementById("btnSyncHistory"),
    syncStatus: document.getElementById("syncStatus"),
    stopBtn: document.getElementById("toolStop"),
    modelCard: document.getElementById("modelCardPop"),
  };

  compareMode = !!els.compareToggle?.checked || !!window.__noetiCompareMode;

  function setStopVisible(on) {
    if (els.stopBtn) els.stopBtn.hidden = !on;
  }

  function refreshFlags() {
    const note = document.getElementById("composerNote");
    if (!note) return;
    const bits = ["Public · non-sensitive"];
    if (els.webSearch?.checked) bits.push("web");
    if (compareMode || els.compareToggle?.checked) bits.push("compare");
    if (pendingImages.length) bits.push(`${pendingImages.length} image${pendingImages.length > 1 ? "s" : ""}`);
    bits.push("/ for commands");
    note.textContent = bits.join(" · ");
  }
  window.__noetiRefreshComposerNote = refreshFlags;

  async function refreshAccountUI() {
    const out = document.getElementById("accountSignedOut");
    const inn = document.getElementById("accountSignedIn");
    const label = document.getElementById("accountUserLabel");
    try {
      const res = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok && data.username) {
        if (out) out.hidden = true;
        if (inn) inn.hidden = false;
        if (label) label.textContent = data.username;
        if (els.syncStatus && els.syncStatus.textContent === "Local only") {
          els.syncStatus.textContent = `Signed in · ${data.username}`;
        }
        return data.username;
      }
    } catch (_) { /* ignore */ }
    if (out) out.hidden = false;
    if (inn) inn.hidden = true;
    return null;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function richFormat(text) {
    const raw = String(text || "");
    // pick up completed fences for artifacts panel
    raw.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const id = "art_" + Math.random().toString(36).slice(2, 8);
      queueMicrotask(() => addArtifact(lang || "txt", code, id));
      return "";
    });
    if (window.__noetiFormatContent) return window.__noetiFormatContent(raw);
    return escapeHtml(raw).replace(/\n/g, "<br>");
  }

  function addArtifact(lang, code, id) {
    if (!els.artifacts || !els.artifactsBody) return;
    const auto = document.getElementById("featAutoArtifacts");
    if (auto && !auto.checked) {
      // still store silently? skip panel
      return;
    }
    els.artifacts.hidden = false;
    const name = guessFilename(lang, code);
    const wrap = document.createElement("article");
    wrap.className = "artifact-card";
    wrap.innerHTML = `<header><strong>${escapeHtml(name)}</strong><span>${escapeHtml(lang || "text")}</span>
      <button type="button" class="btn-chip" data-dl>Download</button></header>
      <pre><code></code></pre>`;
    wrap.querySelector("code").textContent = code;
    wrap.querySelector("[data-dl]").addEventListener("click", () => {
      const blob = new Blob([code], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    els.artifactsBody.prepend(wrap);
  }

  function guessFilename(lang, code) {
    const first = (code || "").split("\n")[0] || "";
    const m = first.match(/(?:\/\/|#)\s*([\w./-]+\.\w+)/);
    if (m) return m[1];
    const map = { python: "main.py", py: "main.py", javascript: "app.js", js: "app.js", ts: "app.ts", html: "index.html", css: "styles.css", json: "data.json", bash: "run.sh", sh: "run.sh" };
    return map[(lang || "").toLowerCase()] || "snippet.txt";
  }

  async function loadAssistants() {
    try {
      const res = await fetch("/api/chat/assistants", { cache: "no-store" });
      const data = await res.json();
      assistants = data.assistants || [];
      if (els.assistantSel) {
        els.assistantSel.innerHTML = assistants.map((a) =>
          `<option value="${escapeHtml(a.id)}" ${a.id === assistantId ? "selected" : ""}>${escapeHtml(a.name)}</option>`
        ).join("");
      }
    } catch (_) { /* ignore */ }
  }

  function buildUserContent(text) {
    if (!pendingImages.length) return text;
    const parts = [{ type: "text", text }];
    pendingImages.slice(0, 4).forEach((url) => {
      parts.push({ type: "image_url", image_url: { url } });
    });
    return parts;
  }

  function renderImagePreview() {
    if (!els.imgPreview) return;
    els.imgPreview.innerHTML = "";
    pendingImages.forEach((url, i) => {
      const chip = document.createElement("div");
      chip.className = "img-chip";
      chip.innerHTML = `<img src="${url}" alt=""><button type="button" aria-label="Remove">×</button>`;
      chip.querySelector("button").addEventListener("click", () => {
        pendingImages.splice(i, 1);
        renderImagePreview();
      });
      els.imgPreview.appendChild(chip);
    });
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
        try {
          onEvent(JSON.parse(line.slice(5).trim()));
        } catch (_) { /* ignore */ }
      }
    }
  }

  function getApi() {
    return window.__noetiChatApi || null;
  }

  async function streamToBubble(payload, bubbleEl) {
    const contentEl = bubbleEl.querySelector(".msg-content");
    contentEl.classList.remove("thinking");
    contentEl.innerHTML = "";
    let full = "";
    let meta = "";
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
      signal: streamAbort?.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    let streamError = null;
    await readSSE(res, (ev) => {
      if (ev.event === "error") {
        streamError = new Error(ev.message || "Stream failed");
        return;
      }
      if (ev.event === "meta") {
        meta = `${ev.label || "Noeti"} · ${ev.model || ""}`;
        if (ev.web_search) meta += " · web";
      }
      if (ev.event === "token") {
        full += ev.text || "";
        contentEl.innerHTML = richFormat(full);
        const log = document.getElementById("chatLog");
        if (log) log.scrollTop = log.scrollHeight;
      }
      if (ev.event === "done") done = ev;
    });
    if (streamError) throw streamError;
    return { full: (done?.reply || full), done, meta };
  }

  // Hook send path used by chat.js via global bridge
  window.__noetiStreamSend = async function noetiStreamSend({ text, chat, thinking, model, temperature }) {
    const api = getApi();
    const content = buildUserContent(text);
    // Replace last user message content if multimodal
    if (Array.isArray(content) && chat.messages?.length) {
      const last = [...chat.messages].reverse().find((m) => m.role === "user");
      if (last) last.content = typeof content === "string" ? content : text;
      last._parts = content;
    }
    const payloadMessages = (chat.messages || [])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role,
        content: m._parts || m.content,
      }));
    // Ensure last user has multimodal parts
    if (payloadMessages.length) {
      const last = payloadMessages[payloadMessages.length - 1];
      if (last.role === "user") last.content = content;
    }

    const priv = !!document.getElementById("setPrivateRoute")?.checked;
    let assistantForSend = assistantId;
    const brain = window.NoetiBrain;
    let systemExtra = (els.systemPrompt?.value || "").trim();
    if (brain?.getStatus?.().enabled) {
      const block = await brain.buildContextBlock(text);
      if (brain.getStatus().codingHelper) {
        assistantForSend = "coding_helper";
        systemExtra = [brain.codingSystemPrompt(), systemExtra, block].filter(Boolean).join("\n\n---\n\n");
      } else if (block) {
        systemExtra = [systemExtra, block].filter(Boolean).join("\n\n---\n\n");
      }
    }
    const payload = {
      messages: payloadMessages,
      model: model || api?.getModel?.() || "openai/gpt-4o-mini",
      temperature: temperature ?? 0.55,
      assistant_id: assistantForSend,
      web_search: !!els.webSearch?.checked && !priv,
      prefer_local: priv,
      private: priv,
      system_prompt: systemExtra || undefined,
    };

    compareMode = !!els.compareToggle?.checked || !!window.__noetiCompareMode;

    if (compareMode) {
      thinking.remove();
      return runCompare(payload, chat, text);
    }

    streamAbort = new AbortController();
    setStopVisible(true);
    try {
      const { full, done, meta } = await streamToBubble(payload, thinking);
      const finalMeta = `${meta} · ${done?.latency_ms || "?"}ms`;
      const metaEl = thinking.querySelector(".msg-meta");
      if (metaEl) metaEl.textContent = finalMeta;
      else {
        const m = document.createElement("div");
        m.className = "msg-meta";
        m.textContent = finalMeta;
        thinking.querySelector(".msg-body")?.appendChild(m);
      }
      chat.messages.push({
        role: "assistant",
        content: full,
        meta: finalMeta,
        sources: done?.sources,
      });
      chat.lastSources = done?.sources;
      chat.lastInsights = done?.insights;
      chat.lastPayload = { insights: done?.insights, sources: done?.sources };
      chat.updated = Date.now();
      pendingImages = [];
      renderImagePreview();
      refreshFlags();
      api?.saveState?.();
      // Desk fills the rail after chat (web search + planes). Skip premature bars-only rail.
      api?.maybeOpenRail?.();
      if (typeof api?.runDeskWitness !== "function") {
        api?.updateRail?.(chat.lastPayload);
      }
      scheduleCloudSync();
      return done;
    } catch (err) {
      thinking.querySelector(".msg-content").textContent = String(err.message || err);
      throw err;
    } finally {
      streamAbort = null;
      setStopVisible(false);
    }
  };

  async function runCompare(basePayload, chat, text) {
    const pane = els.comparePane;
    if (pane) pane.hidden = false;
    if (els.compareA) els.compareA.innerHTML = "<em>Streaming…</em>";
    if (els.compareB) els.compareB.innerHTML = "<em>Streaming…</em>";
    const modelA = basePayload.model;
    const modelB = compareModelB;
    const mkBubble = (el) => {
      // fake bubble-like target
      el.innerHTML = `<div class="msg-content"></div>`;
      return el;
    };
    const [a, b] = await Promise.all([
      streamToBubble({ ...basePayload, model: modelA }, mkBubble(els.compareA)),
      streamToBubble({ ...basePayload, model: modelB }, mkBubble(els.compareB)),
    ]);
    const summary = `Compare\nA (${modelA}):\n${a.full}\n\nB (${modelB}):\n${b.full}`;
    chat.messages.push({ role: "assistant", content: summary, meta: `compare · ${modelA} vs ${modelB}` });
    getApi()?.saveState?.();
    scheduleCloudSync();
    // also show in thread
    const log = document.getElementById("chatLog");
    if (log && getApi()?.appendBubble) {
      getApi().appendBubble("assistant", summary, `compare · ${modelA} vs ${modelB}`);
    }
  }

  let syncTimer = null;
  function scheduleCloudSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(pushHistory, 1200);
  }

  async function pushHistory() {
    const api = getApi();
    const chats = api?.getChats?.() || [];
    try {
      const res = await fetch("/api/chat/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ chats }),
      });
      const data = await res.json();
      if (els.syncStatus) {
        els.syncStatus.textContent = data.ok ? "Synced" : (res.status === 401 ? "Sign in to sync" : "Sync failed");
      }
    } catch (_) {
      if (els.syncStatus) els.syncStatus.textContent = "Sync offline";
    }
  }

  async function pullHistory() {
    try {
      const res = await fetch("/api/chat/history", { credentials: "same-origin", cache: "no-store" });
      if (res.status === 401) {
        if (els.syncStatus) els.syncStatus.textContent = "Sign in to sync";
        return;
      }
      const data = await res.json();
      if (data.ok && data.chats?.length && getApi()?.mergeChats) {
        getApi().mergeChats(data.chats);
        if (els.syncStatus) els.syncStatus.textContent = `Loaded ${data.chats.length} cloud threads`;
      } else if (els.syncStatus) {
        els.syncStatus.textContent = data.ok ? "Cloud empty" : "Sync n/a";
      }
    } catch (_) {
      if (els.syncStatus) els.syncStatus.textContent = "Sync offline";
    }
  }

  // Model card on hover/select — enhance picker options after models load
  window.__noetiEnhanceModelOption = function (m, opt) {
    const card = m.card || {};
    const bits = [];
    if (card.context_length) bits.push(`${Math.round(card.context_length / 1000)}k ctx`);
    if (card.can_self_host) bits.push("self-host");
    else bits.push("centralized");
    if (card.free_route) bits.push("free route");
    else if (card.paid) bits.push("paid");
    if (card.on_node) bits.push("on node");
    if (bits.length) {
      const line = document.createElement("div");
      line.className = "model-card-line";
      line.textContent = bits.join(" · ");
      opt.querySelector(".model-option-main")?.appendChild(line);
    }
  };

  els.assistantSel?.addEventListener("change", () => {
    assistantId = els.assistantSel.value;
    localStorage.setItem("noeti_assistant", assistantId);
  });
  window.__noetiSetCompare = (on) => {
    compareMode = !!on;
    if (els.comparePane && !on) els.comparePane.hidden = true;
    refreshFlags();
  };
  els.compareToggle?.addEventListener("change", () => {
    compareMode = !!els.compareToggle.checked;
    window.__noetiCompareMode = compareMode;
    if (els.comparePane && !compareMode) els.comparePane.hidden = true;
    const wrap = document.getElementById("compareModelBWrap");
    if (wrap) wrap.hidden = !compareMode;
    refreshFlags();
  });
  async function ingestImageFiles(fileList) {
    const files = [...(fileList || [])].slice(0, 4 - pendingImages.length);
    for (const f of files) {
      if (!f.type?.startsWith("image/")) continue;
      if (f.size > 4_500_000) continue;
      const url = await new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.readAsDataURL(f);
      });
      pendingImages.push(url);
    }
    renderImagePreview();
    refreshFlags();
  }

  els.imgBtn?.addEventListener("click", () => els.imgInput?.click());
  els.imgInput?.addEventListener("change", async () => {
    await ingestImageFiles(els.imgInput.files);
    els.imgInput.value = "";
  });

  // Paste images (ChatGPT-like)
  document.getElementById("chatInput")?.addEventListener("paste", async (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const files = items.filter((it) => it.type?.startsWith("image/")).map((it) => it.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    await ingestImageFiles(files);
  });

  // Drag & drop onto composer
  const wrap = document.querySelector(".composer-wrap");
  if (wrap) {
    ["dragenter", "dragover"].forEach((ev) => wrap.addEventListener(ev, (e) => {
      e.preventDefault();
      wrap.classList.add("is-drop");
    }));
    ["dragleave", "drop"].forEach((ev) => wrap.addEventListener(ev, (e) => {
      if (ev === "drop") e.preventDefault();
      wrap.classList.remove("is-drop");
    }));
    wrap.addEventListener("drop", async (e) => {
      e.preventDefault();
      wrap.classList.remove("is-drop");
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) await ingestImageFiles(files);
    });
  }

  // Allow send with image-only (no text) — patch required attr dynamically
  const chatInput = document.getElementById("chatInput");
  const chatForm = document.getElementById("chatForm");
  chatForm?.addEventListener("submit", (e) => {
    if (pendingImages.length && !(chatInput?.value || "").trim()) {
      // chat.js requires text — inject a caption
      if (chatInput) {
        chatInput.value = "What do you see in this image?";
        chatInput.removeAttribute("required");
      }
    }
  }, true);
  document.getElementById("compareModelB")?.addEventListener("change", (e) => {
    compareModelB = e.target.value;
    localStorage.setItem("noeti_compare_b", compareModelB);
  });
  els.webSearch?.addEventListener("change", refreshFlags);
  els.syncBtn?.addEventListener("click", async () => {
    if (els.syncStatus) els.syncStatus.textContent = "Syncing…";
    await pushHistory();
    await pullHistory();
  });
  document.getElementById("btnChatLogin")?.addEventListener("click", async () => {
    const username = document.getElementById("chatLoginUser")?.value?.trim();
    const password = document.getElementById("chatLoginPass")?.value || "";
    if (!username || !password) return;
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!data.ok) {
        if (els.syncStatus) els.syncStatus.textContent = data.error || "Login failed";
        return;
      }
      if (els.syncStatus) els.syncStatus.textContent = `Signed in · ${data.username}`;
      await refreshAccountUI();
      await pushHistory();
      await pullHistory();
    } catch (_) {
      if (els.syncStatus) els.syncStatus.textContent = "Login offline";
    }
  });
  document.getElementById("btnChatLogout")?.addEventListener("click", async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", body: "{}" });
    } catch (_) { /* ignore */ }
    if (els.syncStatus) els.syncStatus.textContent = "Local only";
    await refreshAccountUI();
  });
  document.getElementById("toolStop")?.addEventListener("click", () => {
    streamAbort?.abort();
    setStopVisible(false);
  });

  function syncBrainChip() {
    const btn = document.getElementById("btnBrainOpen");
    const hint = document.getElementById("brainComposerHint");
    const st = window.NoetiBrain?.getStatus?.();
    if (!btn || !st) return;
    btn.classList.toggle("is-on", !!st.enabled);
    btn.textContent = st.enabled
      ? (st.count ? `Brain · ${st.count}` : "Brain · on")
      : "Brain";
    if (hint) {
      hint.textContent = st.enabled
        ? (st.codingHelper ? "Coding helper · map-first" : "Second Brain on")
        : "Allow files · cached map for coding";
    }
  }
  document.getElementById("btnBrainOpen")?.addEventListener("click", () => {
    window.NoetiBrain?.open?.();
  });
  window.NoetiBrain?.onChange?.(syncBrainChip);
  syncBrainChip();

  loadAssistants();
  refreshFlags();
  refreshAccountUI().then((user) => { if (user) pullHistory(); });
})();
