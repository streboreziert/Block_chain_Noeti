/**
 * Cooler chat features — slash commands, on-node strip, focus, shortcuts.
 */
(() => {
  const app = document.getElementById("chatApp");
  const input = document.getElementById("chatInput");
  const slashMenu = document.getElementById("slashMenu");
  if (!app || !input) return;

  const COMMANDS = [
    { id: "web", label: "/web", hint: "Toggle live web search", run: () => flip("toggleWebSearch") },
    { id: "compare", label: "/compare", hint: "Toggle side-by-side compare", run: () => flip("toggleCompare") },
    { id: "image", label: "/image", hint: "Attach an image", run: () => document.getElementById("chatImageInput")?.click() },
    { id: "node", label: "/node", hint: "Switch to fastest on-node model", run: pickNode },
    { id: "models", label: "/models", hint: "Open model picker", run: () => window.__noetiChatApi?.openModelMenu?.() },
    { id: "desk", label: "/desk", hint: "Toggle desk rail", run: () => app.classList.toggle("rail-open") },
    { id: "focus", label: "/focus", hint: "Focus mode on/off", run: () => flip("featFocus") },
    { id: "clear", label: "/clear", hint: "Clear this thread", run: () => window.__noetiChatApi?.clearActive?.() },
    { id: "regen", label: "/regen", hint: "Regenerate last reply", run: () => window.__noetiChatApi?.regenLast?.() },
    { id: "copy", label: "/copy", hint: "Copy last reply", run: copyLast },
    { id: "stop", label: "/stop", hint: "Stop generation", run: () => document.getElementById("toolStop")?.click() },
  ];

  let slashIndex = 0;

  function feat(id) {
    const el = document.getElementById(id);
    return !el || el.checked;
  }

  function flip(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.checked = !el.checked;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    note(`${el.checked ? "On" : "Off"} · ${id.replace(/^toggle|^feat/, "").replace(/([A-Z])/g, " $1").trim()}`);
  }

  function note(text) {
    const n = document.getElementById("composerNote");
    if (!n) return;
    const prev = n.textContent;
    n.textContent = text;
    setTimeout(() => { if (n.textContent === text) n.textContent = prev; }, 2200);
  }

  function pickNode() {
    const models = window.__noetiChatApi?.getModels?.() || [];
    const node = models.find((m) => m.on_node && !m.locked) || models.find((m) => m.on_node);
    if (!node) {
      note("No on-node models available");
      return;
    }
    window.__noetiChatApi?.setModel?.(node.id);
    note(`On node · ${node.name || node.id}`);
  }

  async function copyLast() {
    try {
      const state = JSON.parse(localStorage.getItem("noeti_chat_v5") || "{}") || {};
      const chats = state.chats || window.__noetiChatApi?.getChats?.() || [];
      const active = chats.find((c) => c.id === state.activeId) || chats[0];
      const last = [...(active?.messages || [])].reverse().find((m) => m.role === "assistant");
      if (!last) return;
      await navigator.clipboard.writeText(last.content || "");
      note("Copied last reply");
    } catch (_) {
      note("Copy failed");
    }
  }

  function filteredSlash(q) {
    const needle = (q || "").toLowerCase().replace(/^\//, "");
    return COMMANDS.filter((c) => !needle || c.id.startsWith(needle) || c.label.includes(needle));
  }

  function showSlash(list) {
    if (!slashMenu || !feat("featSlash")) {
      hideSlash();
      return;
    }
    if (!list.length) {
      hideSlash();
      return;
    }
    slashMenu.hidden = false;
    slashMenu.innerHTML = `<p class="slash-head">Commands</p>` + list.map((c, i) =>
      `<button type="button" class="slash-item${i === slashIndex ? " is-on" : ""}" data-i="${i}" role="option">
        <code>${c.label}</code><span>${c.hint}</span>
      </button>`
    ).join("");
    slashMenu.querySelectorAll(".slash-item").forEach((btn) => {
      btn.addEventListener("click", () => runSlash(list[Number(btn.dataset.i)]));
    });
  }

  function hideSlash() {
    if (!slashMenu) return;
    slashMenu.hidden = true;
    slashMenu.innerHTML = "";
  }

  function runSlash(cmd) {
    if (!cmd) return;
    hideSlash();
    input.value = "";
    input.dispatchEvent(new Event("input"));
    cmd.run();
    input.focus();
  }

  function onInputSlash() {
    if (!feat("featSlash")) {
      hideSlash();
      return;
    }
    const v = input.value;
    if (!v.startsWith("/")) {
      hideSlash();
      return;
    }
    if (/\s/.test(v)) {
      hideSlash();
      return;
    }
    const list = filteredSlash(v);
    slashIndex = 0;
    showSlash(list);
  }

  input.addEventListener("input", onInputSlash);
  input.addEventListener("keydown", (e) => {
    if (slashMenu && !slashMenu.hidden) {
      const list = filteredSlash(input.value);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashIndex = Math.min(list.length - 1, slashIndex + 1);
        showSlash(list);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slashIndex = Math.max(0, slashIndex - 1);
        showSlash(list);
        return;
      }
      if (e.key === "Enter" && list[slashIndex] && input.value.startsWith("/") && !/\s/.test(input.value)) {
        e.preventDefault();
        e.stopPropagation();
        runSlash(list[slashIndex]);
        return;
      }
      if (e.key === "Escape") {
        hideSlash();
        return;
      }
      if (e.key === "Tab" && list[slashIndex]) {
        e.preventDefault();
        runSlash(list[slashIndex]);
      }
    }
  }, true);

  // Intercept form submit for slash-only
  document.getElementById("chatForm")?.addEventListener("submit", (e) => {
    const v = (input.value || "").trim();
    if (v.startsWith("/") && !/\s/.test(v) && feat("featSlash")) {
      const list = filteredSlash(v);
      const hit = list.find((c) => c.label === v || `/${c.id}` === v) || list[0];
      if (hit) {
        e.preventDefault();
        e.stopImmediatePropagation();
        runSlash(hit);
      }
    }
  }, true);

  document.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === "k") {
      e.preventDefault();
      window.__noetiChatApi?.openModelMenu?.();
    }
    if (meta && e.key === ".") {
      e.preventDefault();
      flip("featFocus");
    }
    if (meta && e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      flip("toggleCompare");
    }
    if (meta && e.shiftKey && e.key.toLowerCase() === "w") {
      e.preventDefault();
      flip("toggleWebSearch");
    }
  });

  // Respect auto-artifacts preference from Modules
  const _add = window.__noetiAddArtifact;
  // chat-plus owns artifacts; gate panel open
  const obs = new MutationObserver(() => {
    const panel = document.getElementById("artifactsPanel");
    if (!panel || panel.hidden) return;
    if (!feat("featAutoArtifacts")) panel.hidden = true;
  });
  const panel = document.getElementById("artifactsPanel");
  if (panel) obs.observe(panel, { attributes: true, attributeFilter: ["hidden"] });

  function syncVisTogs() { /* topbar quick toggles removed */ }

  document.getElementById("accentSwatches")?.addEventListener("click", (e) => {
    const sw = e.target.closest(".swatch");
    if (!sw) return;
    const accent = sw.dataset.accent;
    const sel = document.getElementById("setAccent");
    if (sel) {
      sel.value = accent;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    app.dataset.accent = accent;
    document.querySelectorAll("#accentSwatches .swatch").forEach((s) => {
      s.classList.toggle("is-on", s === sw);
    });
  });

  // Keep swatch UI in sync with saved accent
  const accent = app.dataset.accent || document.getElementById("setAccent")?.value || "moss";
  document.querySelectorAll("#accentSwatches .swatch").forEach((s) => {
    s.classList.toggle("is-on", s.dataset.accent === accent);
  });
})();
