/**
 * Noeti Second Brain — allowlisted files + filesystem map for coding helper.
 * Models get a cached map so they don't re-search the tree every turn.
 * Only user-selected files are readable.
 */
(function () {
  const META_KEY = "noeti_brain_meta_v1";
  const IDB_NAME = "noeti_brain_v1";
  const IDB_STORE = "files";

  const DEFAULT_IGNORE = [
    ".git",
    "node_modules",
    "__pycache__",
    ".DS_Store",
    "dist",
    "build",
    ".next",
    ".venv",
    "venv",
    "*.min.js",
    "*.min.css",
    "*.map",
    "*.lock",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "*.png",
    "*.jpg",
    "*.jpeg",
    "*.gif",
    "*.webp",
    "*.ico",
    "*.pdf",
    "*.zip",
    "*.woff",
    "*.woff2",
    // App bundles / heavy IDE junk (Desktop picks)
    "*.app",
    "Contents",
    "Frameworks",
    "Resources",
    "MacOS",
    "*.pak",
    "*.dylib",
    "*.so",
    "*.dll",
    "*.exe",
    "*.bin",
    "*.wasm",
    "*.node",
    "*.o",
    "*.a",
    "*.jar",
    "*.class",
    "*.pyc",
    "*.pyo",
    "*.wasm",
    "Pods",
    ".cache",
    "coverage",
    "vendor",
  ];

  const TEXT_EXT = new Set([
    "py", "js", "ts", "tsx", "jsx", "mjs", "cjs", "json", "md", "txt", "html", "css", "scss",
    "rs", "go", "java", "kt", "c", "h", "cpp", "hpp", "cc", "rb", "php", "lua", "r", "pl",
    "sh", "bash", "zsh", "yml", "yaml", "toml", "ini", "cfg", "env", "sql", "graphql",
    "vue", "svelte", "swift", "dart", "scala", "cmake", "makefile", "dockerfile", "gitignore",
  ]);

  let meta = loadMeta();
  /** @type {Map<string, string>} */
  const contentMem = new Map();
  let idb = null;

  function loadMeta() {
    try {
      const raw = JSON.parse(localStorage.getItem(META_KEY) || "null");
      if (raw && typeof raw === "object") {
        return {
          enabled: !!raw.enabled,
          codingHelper: raw.codingHelper !== false,
          ignore: Array.isArray(raw.ignore) && raw.ignore.length ? raw.ignore : [...DEFAULT_IGNORE],
          maxFileBytes: Math.min(400000, Math.max(8000, Number(raw.maxFileBytes) || 120000)),
          maxIndexEntries: Math.min(2000, Math.max(50, Number(raw.maxIndexEntries) || 800)),
          maxContextBytes: Math.min(80000, Math.max(4000, Number(raw.maxContextBytes) || 28000)),
          autoPinMentioned: raw.autoPinMentioned !== false,
          roots: Array.isArray(raw.roots) ? raw.roots : [],
          files: raw.files && typeof raw.files === "object" ? raw.files : {},
          pinned: Array.isArray(raw.pinned) ? raw.pinned : [],
          updated: raw.updated || 0,
        };
      }
    } catch (_) {}
    return {
      enabled: false,
      codingHelper: true,
      ignore: [...DEFAULT_IGNORE],
      maxFileBytes: 120000,
      maxIndexEntries: 800,
      maxContextBytes: 28000,
      autoPinMentioned: true,
      roots: [],
      files: {},
      pinned: [],
      updated: 0,
    };
  }

  function saveMeta() {
    meta.updated = Date.now();
    try {
      localStorage.setItem(META_KEY, JSON.stringify({
        enabled: meta.enabled,
        codingHelper: meta.codingHelper,
        ignore: meta.ignore,
        maxFileBytes: meta.maxFileBytes,
        maxIndexEntries: meta.maxIndexEntries,
        maxContextBytes: meta.maxContextBytes,
        autoPinMentioned: meta.autoPinMentioned,
        roots: meta.roots,
        files: meta.files,
        pinned: meta.pinned,
        updated: meta.updated,
      }));
    } catch (_) {}
    notify();
  }

  const listeners = new Set();
  function notify() {
    listeners.forEach((fn) => {
      try { fn(getStatus()); } catch (_) {}
    });
  }

  function openIdb() {
    if (idb) return Promise.resolve(idb);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => {
        idb = req.result;
        resolve(idb);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPut(path, text) {
    contentMem.set(path, text);
    try {
      const db = await openIdb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(text, path);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (_) {}
  }

  async function idbGet(path) {
    if (contentMem.has(path)) return contentMem.get(path);
    try {
      const db = await openIdb();
      return await new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const req = tx.objectStore(IDB_STORE).get(path);
        req.onsuccess = () => {
          const v = req.result;
          if (typeof v === "string") contentMem.set(path, v);
          resolve(typeof v === "string" ? v : null);
        };
        req.onerror = () => resolve(null);
      });
    } catch (_) {
      return null;
    }
  }

  async function idbDel(path) {
    contentMem.delete(path);
    try {
      const db = await openIdb();
      await new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(path);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch (_) {}
  }

  function normPath(p) {
    return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  }

  function extOf(path) {
    const base = path.split("/").pop() || "";
    if (base.startsWith(".") && !base.slice(1).includes(".")) return base.slice(1).toLowerCase();
    const i = base.lastIndexOf(".");
    return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
  }

  function matchIgnore(path, patterns) {
    const parts = path.split("/");
    for (const pat of patterns) {
      const p = String(pat || "").trim();
      if (!p) continue;
      if (p.startsWith("*.")) {
        const ext = p.slice(1).toLowerCase();
        if (path.toLowerCase().endsWith(ext)) return true;
      } else if (p.includes("*")) {
        const re = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
        if (re.test(path) || parts.some((seg) => re.test(seg))) return true;
      } else if (parts.includes(p) || path === p || path.endsWith("/" + p)) {
        return true;
      }
    }
    return false;
  }

  function isTextPath(path) {
    const ext = extOf(path);
    if (!ext) return true;
    return TEXT_EXT.has(ext) || ["dockerfile", "makefile", "gitignore", "env"].includes(ext);
  }

  function summarize(text, max = 160) {
    const line = String(text || "").split(/\r?\n/).find((l) => l.trim()) || "";
    return line.trim().slice(0, max);
  }

  function kindOf(path) {
    const ext = extOf(path);
    if (["py", "js", "ts", "tsx", "jsx", "rs", "go", "java", "c", "cpp", "rb", "php"].includes(ext)) return "code";
    if (["md", "txt"].includes(ext)) return "doc";
    if (["json", "yml", "yaml", "toml"].includes(ext)) return "config";
    if (["html", "css", "scss"].includes(ext)) return "web";
    return "file";
  }

  async function readFileText(file) {
    if (file.size > meta.maxFileBytes) {
      const slice = file.slice(0, meta.maxFileBytes);
      const text = await slice.text();
      return text + `\n\n/* …truncated · file ${file.size} bytes · allowlist max ${meta.maxFileBytes} */\n`;
    }
    return file.text();
  }

  function isHeavyPath(rel) {
    const lower = rel.toLowerCase();
    if (lower.includes(".app/")) return true;
    if (lower.includes("/frameworks/")) return true;
    if (lower.includes("/contents/macos/")) return true;
    if (/\.(pak|dylib|so|dll|exe|bin|wasm|node|o|a|jar|class|pyc)$/i.test(lower)) return true;
    return false;
  }

  async function ingestFileList(fileList, { rootLabel } = {}) {
    const files = Array.from(fileList || []);
    if (!files.length) return { added: 0, skipped: 0 };
    let added = 0;
    let skipped = 0;
    const label = rootLabel || (files[0].webkitRelativePath ? files[0].webkitRelativePath.split("/")[0] : "files");
    if (!meta.roots.includes(label)) meta.roots.push(label);

    for (const file of files) {
      if (Object.keys(meta.files).length >= meta.maxIndexEntries) {
        skipped += files.length - added - skipped;
        break;
      }
      const rel = normPath(file.webkitRelativePath || file.name);
      if (!rel || matchIgnore(rel, meta.ignore) || isHeavyPath(rel)) {
        skipped += 1;
        continue;
      }
      // Skip binaries entirely — keep explorer fast and Cursor-like
      if (!isTextPath(rel)) {
        skipped += 1;
        continue;
      }
      try {
        const text = await readFileText(file);
        await idbPut(rel, text);
        meta.files[rel] = {
          size: file.size,
          kind: kindOf(rel),
          summary: summarize(text),
          mtime: file.lastModified || Date.now(),
          readable: true,
        };
        added += 1;
      } catch (_) {
        skipped += 1;
      }
    }
    saveMeta();
    return { added, skipped, total: Object.keys(meta.files).length };
  }

  async function clearAll() {
    meta.files = {};
    meta.pinned = [];
    meta.roots = [];
    contentMem.clear();
    try {
      const db = await openIdb();
      await new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch (_) {}
    saveMeta();
  }

  function setPinned(path, on) {
    const p = normPath(path);
    if (!p || !meta.files[p]) return;
    const has = meta.pinned.includes(p);
    if (on && !has) meta.pinned.push(p);
    if (!on && has) meta.pinned = meta.pinned.filter((x) => x !== p);
    saveMeta();
  }

  function mentionPins(userText) {
    if (!meta.autoPinMentioned) return [];
    const text = String(userText || "");
    const hits = [];
    for (const path of Object.keys(meta.files)) {
      if (text.includes(path) || text.includes(path.split("/").pop())) hits.push(path);
    }
    return hits.slice(0, 12);
  }

  function treeLines(paths) {
    const sorted = [...paths].sort((a, b) => a.localeCompare(b));
    return sorted.map((p) => {
      const f = meta.files[p];
      const pin = meta.pinned.includes(p) ? " ★" : "";
      const flag = f?.readable === false ? " [bin]" : "";
      return `- ${p}${pin}${flag} · ${f?.kind || "file"} · ${f?.size || 0}b`;
    });
  }

  async function buildContextBlock(userText) {
    if (!meta.enabled) return "";
    const paths = Object.keys(meta.files);
    if (!paths.length) {
      return [
        "SECOND BRAIN · enabled but empty.",
        "Ask the user to allow folders/files in Second Brain before coding against a repo.",
      ].join("\n");
    }

    const mapBudget = Math.min(12000, Math.floor(meta.maxContextBytes * 0.45));
    let map = [
      "WORKSPACE MAP (cached — do not re-search; paths below are already indexed)",
      `Roots: ${meta.roots.join(", ") || "(files)"}`,
      `Files indexed: ${paths.length}`,
      "Tree:",
      ...treeLines(paths),
    ].join("\n");
    if (map.length > mapBudget) map = map.slice(0, mapBudget) + "\n…(map truncated)";

    const want = new Set(meta.pinned);
    mentionPins(userText).forEach((p) => want.add(p));
    // If coding helper and few files, auto-include small set of likely entrypoints
    if (meta.codingHelper && want.size < 3) {
      const prefer = ["readme.md", "README.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "main.py", "app.py", "index.js", "index.ts", "src/main.rs"];
      for (const p of paths) {
        const base = p.split("/").pop();
        if (prefer.includes(base) || prefer.includes(p)) want.add(p);
        if (want.size >= 6) break;
      }
    }

    const bodies = [];
    let used = map.length;
    for (const path of [...want]) {
      if (!meta.files[path]?.readable) continue;
      const text = await idbGet(path);
      if (!text) continue;
      const chunk = `\n\n===== FILE: ${path} =====\n${text}\n===== END ${path} =====`;
      if (used + chunk.length > meta.maxContextBytes) {
        const room = meta.maxContextBytes - used - 80;
        if (room > 200) {
          bodies.push(`\n\n===== FILE: ${path} (truncated) =====\n${text.slice(0, room)}\n===== END ${path} =====`);
        }
        break;
      }
      bodies.push(chunk);
      used += chunk.length;
    }

    const helper = meta.codingHelper
      ? [
          "CODING HELPER MODE",
          "You are Noeti Coding Helper on an allowlisted workspace.",
          "Use the WORKSPACE MAP first. Do not invent a search over the whole disk.",
          "Only use ALLOWED files below. If you need another path, ask the user to allow it in Second Brain.",
          "When proposing edits, cite exact paths from the map. Prefer minimal diffs / fenced code with a first-line path comment.",
        ].join("\n")
      : [
          "SECOND BRAIN",
          "The user allowed the files in the map. Prefer map paths. Do not claim access outside the allowlist.",
        ].join("\n");

    return [helper, "", map, bodies.length ? "\nALLOWED FILE CONTENTS (pinned / mentioned / entrypoints):\n" + bodies.join("") : "\n(No file bodies attached this turn — map only. Pin files or mention paths to load contents.)"].join("\n");
  }

  async function injectMessages(messages, userText) {
    if (!meta.enabled) return messages || [];
    const block = await buildContextBlock(userText || "");
    if (!block) return messages || [];
    const out = Array.isArray(messages) ? messages.slice() : [];
    // Merge with existing leading system if present
    if (out[0]?.role === "system") {
      out[0] = { role: "system", content: `${out[0].content}\n\n---\n${block}` };
    } else {
      out.unshift({ role: "system", content: block });
    }
    return out;
  }

  function codingSystemPrompt() {
    return [
      "You are Noeti Coding Helper.",
      "A WORKSPACE MAP of allowlisted files is injected when Second Brain is on.",
      "Trust the map — do not burn tokens inventing directory searches for listed paths.",
      "Stay inside the allowlist. Ask to expand Second Brain for anything outside it.",
      "Return working code in fenced blocks; put the path as a first-line comment when writing files.",
    ].join(" ");
  }

  function getStatus() {
    return {
      enabled: meta.enabled,
      codingHelper: meta.codingHelper,
      count: Object.keys(meta.files).length,
      pinned: meta.pinned.length,
      roots: meta.roots.slice(),
      updated: meta.updated,
      ignore: meta.ignore.slice(),
      maxFileBytes: meta.maxFileBytes,
      maxContextBytes: meta.maxContextBytes,
      autoPinMentioned: meta.autoPinMentioned,
    };
  }

  function getMapText() {
    const paths = Object.keys(meta.files);
    if (!paths.length) return "Second Brain · empty · allow a folder or files to build the map.";
    return [
      `Second Brain map · ${paths.length} files · roots: ${meta.roots.join(", ") || "—"}`,
      ...treeLines(paths),
      "",
      "Pinned: " + (meta.pinned.length ? meta.pinned.join(", ") : "(none)"),
    ].join("\n");
  }

  function listFiles() {
    return Object.keys(meta.files)
      .sort()
      .map((path) => ({ path, ...meta.files[path], pinned: meta.pinned.includes(path) }));
  }

  function updateSettings(patch) {
    if (!patch || typeof patch !== "object") return getStatus();
    if ("enabled" in patch) meta.enabled = !!patch.enabled;
    if ("codingHelper" in patch) meta.codingHelper = !!patch.codingHelper;
    if ("autoPinMentioned" in patch) meta.autoPinMentioned = !!patch.autoPinMentioned;
    if (typeof patch.maxFileBytes === "number") meta.maxFileBytes = Math.min(400000, Math.max(8000, patch.maxFileBytes));
    if (typeof patch.maxContextBytes === "number") meta.maxContextBytes = Math.min(80000, Math.max(4000, patch.maxContextBytes));
    if (typeof patch.ignoreText === "string") {
      meta.ignore = patch.ignoreText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
      if (!meta.ignore.length) meta.ignore = [...DEFAULT_IGNORE];
    }
    saveMeta();
    return getStatus();
  }

  async function removePath(path) {
    const p = normPath(path);
    delete meta.files[p];
    meta.pinned = meta.pinned.filter((x) => x !== p);
    await idbDel(p);
    saveMeta();
  }

  function openModal() {
    ensureModal();
    const modal = document.getElementById("brainModal");
    if (!modal) return;
    syncModalForm();
    renderFileList();
    if (window.openDrop) window.openDrop(modal);
    else {
      modal.hidden = false;
      modal.classList.add("is-open");
    }
  }

  function closeModal() {
    const modal = document.getElementById("brainModal");
    if (!modal) return;
    if (window.closeDrop) window.closeDrop(modal);
    else {
      modal.classList.remove("is-open");
      modal.hidden = true;
    }
  }

  function syncModalForm() {
    const st = getStatus();
    const ig = document.getElementById("brainIgnore");
    const mx = document.getElementById("brainMaxCtx");
    const stEl = document.getElementById("brainStatus");
    const en = document.getElementById("brainEnabled");
    if (en) en.checked = st.enabled;
    if (ig) ig.value = st.ignore.join("\n");
    if (mx) mx.value = String(st.maxContextBytes);
    if (stEl) {
      stEl.textContent = st.count
        ? `${st.count} files · ${st.roots[0] || "workspace"}`
        : "No folder open";
    }
  }

  function renderFileList() {
    const box = document.getElementById("brainFileList");
    if (!box) return;
    const rows = listFiles();
    if (!rows.length) {
      box.innerHTML = `<p class="brain-empty">Open a project folder to index it.</p>`;
      return;
    }
    box.innerHTML = rows.slice(0, 200).map((f) => {
      const name = f.path.split("/").pop() || f.path;
      return `
      <div class="brain-file ${f.pinned ? "is-pin" : ""}" data-path="${escapeAttr(f.path)}" title="${escapeAttr(f.path)}">
        <button type="button" class="brain-pin" data-pin title="Pin">${f.pinned ? "★" : "☆"}</button>
        <div class="brain-file-meta">
          <strong>${escapeHtml(name)}</strong>
          <span>${escapeHtml(f.path)}</span>
        </div>
        <button type="button" class="brain-rm" data-rm title="Remove">×</button>
      </div>`;
    }).join("");
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  function ensureModal() {
    const existing = document.getElementById("brainModal");
    if (existing && existing.dataset.v !== "3") existing.remove();
    if (document.getElementById("brainModal")) return;
    const el = document.createElement("div");
    el.id = "brainModal";
    el.className = "brain-modal";
    el.dataset.v = "3";
    el.hidden = true;
    el.innerHTML = `
      <div class="brain-card" role="dialog" aria-labelledby="brainTitle">
        <header class="brain-head">
          <h2 id="brainTitle">Open folder</h2>
          <button type="button" class="brain-x" id="brainClose" aria-label="Close">×</button>
        </header>
        <p class="brain-status" id="brainStatus">No folder open</p>
        <div class="brain-actions">
          <button type="button" class="brain-btn primary" id="brainPickFolder">Open Folder</button>
          <button type="button" class="brain-btn" id="brainPickFiles">Add files</button>
          <button type="button" class="brain-btn ghost" id="brainClear">Clear</button>
        </div>
        <input type="file" id="brainFolderInput" webkitdirectory multiple hidden />
        <input type="file" id="brainFilesInput" multiple hidden />
        <input type="checkbox" id="brainEnabled" hidden />
        <details class="brain-more">
          <summary>Advanced</summary>
          <label class="brain-label">Ignore</label>
          <textarea id="brainIgnore" rows="3" spellcheck="false"></textarea>
          <label class="brain-label">Max context / turn</label>
          <input type="number" id="brainMaxCtx" min="4000" max="80000" step="1000" />
          <button type="button" class="brain-btn" id="brainSave">Save</button>
        </details>
        <div class="brain-file-list" id="brainFileList"></div>
      </div>
    `;
    document.body.appendChild(el);

    el.addEventListener("click", (e) => {
      if (e.target === el) closeModal();
    });
    el.querySelector("#brainClose")?.addEventListener("click", closeModal);
    el.querySelector("#brainPickFolder")?.addEventListener("click", () => {
      document.getElementById("brainFolderInput")?.click();
    });
    el.querySelector("#brainPickFiles")?.addEventListener("click", () => {
      document.getElementById("brainFilesInput")?.click();
    });
    async function afterIngest(res) {
      if (res.added > 0) {
        updateSettings({ enabled: true, codingHelper: true });
      }
      syncModalForm();
      renderFileList();
      toast(res.added ? `Opened · ${res.added} files` : "Nothing indexed");
    }
    el.querySelector("#brainFolderInput")?.addEventListener("change", async (e) => {
      const input = e.target;
      const res = await ingestFileList(input.files);
      input.value = "";
      await afterIngest(res);
    });
    el.querySelector("#brainFilesInput")?.addEventListener("change", async (e) => {
      const input = e.target;
      const res = await ingestFileList(input.files, { rootLabel: "picked" });
      input.value = "";
      await afterIngest(res);
    });
    el.querySelector("#brainClear")?.addEventListener("click", async () => {
      if (!confirm("Clear workspace index?")) return;
      await clearAll();
      syncModalForm();
      renderFileList();
    });
    el.querySelector("#brainSave")?.addEventListener("click", () => {
      updateSettings({
        enabled: true,
        codingHelper: true,
        ignoreText: document.getElementById("brainIgnore")?.value || "",
        maxContextBytes: Number(document.getElementById("brainMaxCtx")?.value || 28000),
      });
      syncModalForm();
      toast("Saved");
    });
    el.querySelector("#brainFileList")?.addEventListener("click", async (e) => {
      const row = e.target.closest?.("[data-path]");
      if (!row) return;
      const path = row.getAttribute("data-path");
      if (e.target.closest?.("[data-pin]")) {
        setPinned(path, !meta.pinned.includes(path));
        renderFileList();
        syncModalForm();
      } else if (e.target.closest?.("[data-rm]")) {
        await removePath(path);
        renderFileList();
        syncModalForm();
      }
    });
  }

  function toast(msg) {
    try {
      if (typeof window.setStatus === "function") {
        window.setStatus(msg);
        setTimeout(() => window.setStatus("", false), 1800);
        return;
      }
    } catch (_) {}
    const note = document.getElementById("composerNote");
    if (note) {
      const prev = note.textContent;
      note.textContent = msg;
      setTimeout(() => { note.textContent = prev; }, 1800);
    }
  }

  function chipHtml() {
    const st = getStatus();
    if (!st.enabled) return "";
    return `<button type="button" class="brain-chip is-on" id="brainChip" title="Second Brain">${st.count ? `Brain · ${st.count}` : "Brain · on"}</button>`;
  }

  // Warm IDB
  openIdb().catch(() => {});

  window.NoetiBrain = {
    open: openModal,
    close: closeModal,
    getStatus,
    getMapText,
    listFiles,
    readFile: idbGet,
    async writeFile(path, text) {
      const p = normPath(path);
      if (!p) return false;
      const body = String(text ?? "");
      await idbPut(p, body);
      if (!meta.files[p]) {
        meta.files[p] = {
          bytes: body.length,
          kind: kindOf(p),
          summary: summarize(body),
          added: Date.now(),
        };
      } else {
        meta.files[p].bytes = body.length;
        meta.files[p].summary = summarize(body);
        meta.files[p].kind = kindOf(p);
      }
      if (!meta.enabled) meta.enabled = true;
      saveMeta();
      return true;
    },
    updateSettings,
    ingestFileList,
    clearAll,
    setPinned,
    removePath,
    async purgeHeavy() {
      const paths = Object.keys(meta.files);
      let n = 0;
      for (const p of paths) {
        const f = meta.files[p];
        if (isHeavyPath(p) || f?.readable === false || f?.kind === "binary") {
          await removePath(p);
          n += 1;
        }
      }
      // Merge new ignore defaults for older sessions
      const extra = DEFAULT_IGNORE.filter((x) => !meta.ignore.includes(x));
      if (extra.length) {
        meta.ignore = [...meta.ignore, ...extra];
        saveMeta();
      }
      return n;
    },
    injectMessages,
    buildContextBlock,
    codingSystemPrompt,
    chipHtml,
    onChange(fn) {
      if (typeof fn === "function") listeners.add(fn);
      return () => listeners.delete(fn);
    },
    DEFAULT_IGNORE: [...DEFAULT_IGNORE],
  };
})();
