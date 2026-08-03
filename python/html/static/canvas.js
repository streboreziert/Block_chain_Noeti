(() => {
  const STORAGE = "noeti_canvas_v1";
  const COLORS = {
    note: "#6b6b6b",
    prompt: "#1a1a1a",
    model: "#1f4e3d",
    vision: "#2a4a6b",
    phone: "#3d3a6b",
    brain: "#4a3a1f",
    calc: "#1a3a4a",
    atomize: "#3a4a2a",
    witness: "#4a2a3a",
    checker: "#2a3a4a",
    validator: "#3a2a4a",
    watcher: "#4a3a2a",
    gate: "#5a1f1f",
    output: "#1a1a1a",
    code: "#2a3a2a",
    system: "#444444",
    script: "#1f3d4e",
    script_py: "#1f3d4e",
    script_c: "#1f3d4e",
  };

  const FALLBACK_LANGS = [
    { id: "python", label: "Python", ready: true, group: "script", template: "" },
    { id: "javascript", label: "JavaScript", ready: false, group: "script", template: "" },
    { id: "ruby", label: "Ruby", ready: false, group: "script", template: "" },
    { id: "perl", label: "Perl", ready: false, group: "script", template: "" },
    { id: "bash", label: "Bash", ready: false, group: "script", template: "" },
    { id: "c", label: "C", ready: false, group: "compiled", template: "" },
    { id: "cpp", label: "C++", ready: false, group: "compiled", template: "" },
    { id: "rust", label: "Rust", ready: false, group: "compiled", template: "" },
    { id: "go", label: "Go", ready: false, group: "compiled", template: "" },
    { id: "java", label: "Java", ready: false, group: "compiled", template: "" },
    { id: "php", label: "PHP", ready: false, group: "script", template: "" },
    { id: "lua", label: "Lua", ready: false, group: "script", template: "" },
    { id: "r", label: "R", ready: false, group: "script", template: "" },
  ];

  let langCatalog = FALLBACK_LANGS.slice();
  const langTemplates = {};

  const JOBS = [
    { type: "note", label: "Sticky note", hint: "Instructions / labels", hasIn: false, hasOut: false, group: "elements", section: "Basics" },
    { type: "prompt", label: "Prompt", hint: "Text input for the graph", hasIn: true, hasOut: true, group: "elements", section: "Basics" },
    { type: "system", label: "System", hint: "System instructions", hasIn: false, hasOut: true, group: "elements", section: "Basics" },
    { type: "model", label: "Model run", hint: "Any catalog / on-node model", hasIn: true, hasOut: true, group: "elements", section: "Models" },
    { type: "vision", label: "Vision", hint: "Image + prompt → model", hasIn: true, hasOut: true, group: "elements", section: "Models" },
    { type: "phone", label: "Phone", hint: "Phone camera / on-device compute", hasIn: true, hasOut: true, group: "elements", section: "Models" },
    { type: "brain", label: "Second Brain", hint: "FS map · allowlisted files for coding", hasIn: false, hasOut: true, group: "elements", section: "Context" },
    { type: "calc", label: "Calc check", hint: "Catch arithmetic slips", hasIn: true, hasOut: true, group: "elements", section: "Transforms" },
    { type: "atomize", label: "Atomize", hint: "Split into claim atoms", hasIn: true, hasOut: true, group: "elements", section: "Transforms" },
    { type: "code", label: "Code extract", hint: "Pull fenced code blocks", hasIn: true, hasOut: true, group: "elements", section: "Transforms" },
    { type: "script", label: "Script", hint: "Any language · snap-in · local", hasIn: true, hasOut: true, group: "elements", section: "Scripts" },
    { type: "output", label: "Output", hint: "Final board result · seal", hasIn: true, hasOut: false, group: "elements", section: "Finish" },
    { type: "checker", label: "Checker", hint: "Fact plane · verify vs sources", hasIn: true, hasOut: true, group: "roles" },
    { type: "validator", label: "Validator", hint: "Publish-risk plane", hasIn: true, hasOut: true, group: "roles" },
    { type: "watcher", label: "Watcher", hint: "Contradiction hunter", hasIn: true, hasOut: true, group: "roles" },
    { type: "witness", label: "Witness", hint: "Generic support / contest probe", hasIn: true, hasOut: true, group: "roles" },
    { type: "gate", label: "Publish gate", hint: "Ready / review / blocked", hasIn: true, hasOut: true, group: "roles" },
  ];

  const DEMOS = [
    { id: "private", title: "Private summary", blurb: "On-node notes → summary → seal-ready output", tag: "Job" },
    { id: "journalism", title: "Verify a claim", blurb: "Draft → atoms → checker / validator / watcher → gate", tag: "Job" },
    { id: "scripts", title: "Script + math", blurb: "Paste any language · explainable I/O · wire into the board", tag: "Job" },
    { id: "vision", title: "Vision check", blurb: "OCR image → calc check → publish gate", tag: "Job" },
    { id: "planes", title: "Witness contest", blurb: "Three planes disagree in the open · gate holds", tag: "Job" },
    { id: "regions", title: "Where map", blurb: "Private / local / mesh / PC / phone / cloud lanes", tag: "Map" },
    { id: "splitdesk", title: "Split desk", blurb: "Sealed binder vs mesh · plane votes filled", tag: "Map" },
    { id: "phones", title: "Phone field", blurb: "Phone as camera + on-device compute zone", tag: "Map" },
  ];

  const HIST_KEY = "noeti_canvas_runs";
  const PLANE_PROMPTS = {
    checker: "You are the Checker plane. Verify concrete facts. For each claim say SUPPORT, CONTEST, or UNKNOWN with one plain sentence. No markdown.",
    validator: "You are the Validator (publish gate). Decide publish risk. For each claim say SUPPORT, CONTEST, or UNKNOWN and one sentence on publish risk. No markdown.",
    watcher: "You are the Watcher. Hunt contradictions and weak spots. Prefer CONTEST if unsure. One verdict word + one sentence per claim. No markdown.",
    witness: "You are a contradiction witness plane. For each claim, say SUPPORT, CONTEST, or UNKNOWN with one sentence of evidence or gap. Be terse.",
  };

  const els = {
    app: document.getElementById("canvasApp"),
    world: document.getElementById("world"),
    wires: document.getElementById("wires"),
    viewport: document.getElementById("viewport"),
    jobsList: document.getElementById("jobsListElements"),
    jobsListRoles: document.getElementById("jobsListRoles"),
    demoList: document.getElementById("demoList"),
    zoomLabel: document.getElementById("zoomLabel"),
    runStatus: document.getElementById("runStatus"),
    visionFile: document.getElementById("visionFile"),
    importFile: document.getElementById("importFile"),
    meta: document.getElementById("canvasMeta"),
    inspKind: document.getElementById("inspKind"),
    inspTitle: document.getElementById("inspTitle"),
    inspBody: document.getElementById("inspBody"),
    inspFoot: document.getElementById("inspFoot"),
    runProgress: document.getElementById("runProgress"),
    runProgressBar: document.getElementById("runProgressBar"),
  };

  /** @type {{ nodes: any[], edges: any[], regions: any[], cam: {x:number,y:number,z:number} }} */
  let state = { nodes: [], edges: [], regions: [], cam: { x: 80, y: 60, z: 1 } };
  let models = [];
  let modelFilter = "all";
  let selectedId = null;
  let running = false;
  let abort = null;
  let visionTarget = null;
  let connectFrom = null;
  let draftWire = null;
  let privateLocal = false;
  try { privateLocal = localStorage.getItem("noeti_canvas_private") === "1"; } catch (_) {}
  let undoStack = [];
  let redoStack = [];
  let spaceHeld = false;
  let lastRunMeta = null;
  let regionMode = false;
  let marquee = null; // {x0,y0,x1,y1} screen coords in viewport
  let pendingRegion = null; // world rect awaiting route assign
  let wherePreset = null; // auto-assign route after draw
  let selectedIds = new Set();
  let inspCollapsed = false;
  try { inspCollapsed = localStorage.getItem("noeti_canvas_insp") === "0"; } catch (_) {}
  let localCompute = { ready: false, message: "Local…", model: "", ollama: false };
  let camRaf = 0;
  let wireRaf = 0;
  let saveTimer = 0;

  function uid(prefix = "n") {
    return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function jobDef(type) {
    if (type === "script_py" || type === "script_c") {
      return JOBS.find((j) => j.type === "script") || JOBS[0];
    }
    return JOBS.find((j) => j.type === type) || JOBS[0];
  }

  function save(immediate = false) {
    const flush = () => {
      try {
        localStorage.setItem(STORAGE, JSON.stringify(state));
        if (els.meta) {
          const priv = privateLocal ? " · private" : "";
          const loc = localCompute.ready ? " · local" : "";
          els.meta.textContent = `${state.nodes.length} blocks · saved${priv}${loc}`;
        }
      } catch (_) {}
    };
    if (immediate || running) {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = 0;
      flush();
      return;
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = 0; flush(); }, 220);
  }

  function setLocalPill(status) {
    localCompute = { ...localCompute, ...(status || {}) };
    const pill = document.getElementById("localPill");
    if (!pill) return;
    const ready = !!localCompute.ready;
    const pulling = !!(localCompute.pull && localCompute.pull.active);
    const installing = !!(localCompute.install && localCompute.install.active);
    pill.hidden = false;
    pill.classList.toggle("is-ready", ready && !pulling && !installing);
    pill.classList.toggle("is-busy", pulling || installing || (!ready && !!localCompute.ollama));
    pill.classList.toggle("is-off", !localCompute.ollama && !installing);
    pill.textContent = installing
      ? (localCompute.install?.message || "Installing…")
      : pulling
        ? (localCompute.pull?.message || "Pulling…")
        : ready
          ? ("Local · " + ((localCompute.model || "ready").split(":")[0] || "ready"))
          : (localCompute.message || "Local setup");
    pill.title = [
      localCompute.host || "",
      localCompute.model || "",
      (localCompute.ready_languages || []).slice(0, 6).join(", "),
    ].filter(Boolean).join(" · ");
    renderSetupPanel();
  }

  function applyLangCatalog(langs, templates) {
    if (Array.isArray(langs) && langs.length) {
      langCatalog = langs.map((l) => ({
        ...l,
        ready: l.ready !== false && l.ready !== 0,
      }));
    }
    if (templates && typeof templates === "object") {
      Object.assign(langTemplates, templates);
    }
    for (const row of langCatalog) {
      if (row.template) langTemplates[row.id] = row.template;
    }
    renderLangGrid();
    renderSetupPanel();
  }

  function defaultSourceFor(lang) {
    const id = normalizeLang(lang);
    return langTemplates[id] || langCatalog.find((x) => x.id === id)?.template || `# ${id} snap-in\n`;
  }

  function normalizeLang(lang) {
    const l = String(lang || "python").toLowerCase();
    const map = {
      py: "python", python3: "python", js: "javascript", node: "javascript",
      rb: "ruby", sh: "bash", shell: "bash", "c++": "cpp", rs: "rust", golang: "go",
      script_py: "python", script_c: "c",
    };
    return map[l] || l;
  }

  function renderSetupPanel() {
    const title = document.getElementById("setupTitle");
    const msg = document.getElementById("setupMsg");
    const bar = document.getElementById("setupBar");
    const steps = document.getElementById("setupSteps");
    const langSum = document.getElementById("setupLangSummary");
    if (!title) return;
    const inst = localCompute.install || {};
    const pull = localCompute.pull || {};
    title.textContent = localCompute.ready ? "Local compute ready" : (inst.active ? "Installing Ollama" : "Local compute setup");
    msg.textContent = localCompute.message || "—";
    const pct = inst.active ? (inst.progress || 5) : (pull.active ? 70 : (localCompute.ready ? 100 : (localCompute.ollama ? 55 : 8)));
    if (bar) bar.style.width = `${pct}%`;
    if (steps) {
      const rows = [
        { ok: !!localCompute.ollama || inst.ok, label: "Ollama on this machine", detail: inst.message || (localCompute.ollama ? "Online" : "Will auto-install") },
        { ok: !!localCompute.ready || (!!localCompute.ollama && !pull.active), label: "Default model", detail: localCompute.model || "qwen2.5:0.5b" },
        { ok: !!(localCompute.ready_languages || []).length, label: "Script languages", detail: `${(localCompute.ready_languages || []).length} ready` },
      ];
      steps.innerHTML = rows.map((r) => `<li class="${r.ok ? "is-ok" : "is-wait"}"><span>${r.ok ? "●" : "○"}</span><div><strong>${escapeHtml(r.label)}</strong><em>${escapeHtml(r.detail)}</em></div></li>`).join("");
    }
    if (langSum) {
      const ready = langCatalog.filter((x) => x.ready).map((x) => x.label);
      const missing = langCatalog.filter((x) => !x.ready).map((x) => x.label);
      langSum.textContent = ready.length
        ? `Ready: ${ready.join(", ")}${missing.length ? ` · Missing: ${missing.join(", ")}` : ""}`
        : "No language runtimes detected yet.";
    }
  }

  function renderLangGrid() {
    const grid = document.getElementById("langGrid");
    if (!grid) return;
    const q = (document.getElementById("menuSearch")?.value || "").trim().toLowerCase();
    const rows = langCatalog.filter((l) => !q || l.label.toLowerCase().includes(q) || l.id.includes(q));
    if (!rows.length) {
      grid.innerHTML = `<p class="cv-menu-empty">No languages match</p>`;
      return;
    }
    // Always snap-ready in UI — site image ships every toolchain
    grid.innerHTML = rows.map((l) => `
      <button type="button" class="cv-lang-chip" data-lang="${escapeAttr(l.id)}" draggable="true" title="Snap ${escapeAttr(l.label)} onto the board">
        ${escapeHtml(l.label)}
      </button>
    `).join("");
    grid.querySelectorAll("[data-lang]").forEach((btn) => {
      btn.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("job", "script");
        e.dataTransfer.setData("lang", btn.dataset.lang);
      });
      btn.addEventListener("click", () => {
        const pt = screenToWorld(window.innerWidth * 0.45, window.innerHeight * 0.35);
        addNode("script", pt.x, pt.y, { lang: btn.dataset.lang, source: defaultSourceFor(btn.dataset.lang), route: "local" });
        setStatus(`${btn.dataset.lang} snapped`);
        setTimeout(() => setStatus("", false), 1100);
      });
    });
  }

  async function refreshLocalStatus() {
    try {
      const r = await fetch("/api/canvas/local/status", { credentials: "same-origin", cache: "no-store" });
      const d = await r.json();
      applyLangCatalog(d.languages || [], null);
      setLocalPill({
        ready: !!d.ready,
        ollama: !!d.ollama,
        model: d.model || "",
        host: d.host || "",
        message: d.message || "Local",
        pull: d.pull,
        install: d.install,
        scripts_ready: !!d.scripts_ready,
        ready_languages: d.ready_languages || [],
      });
      return d;
    } catch (_) {
      return null;
    }
  }

  async function bootLocalCompute() {
    setLocalPill({ message: "Auto local…", ready: false });
    try {
      const res = await fetch("/api/canvas/local/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ pull: true, ensure_site: true, install_ollama: true }),
      });
      const data = await res.json().catch(() => ({}));
      const st = data.status || data;
      applyLangCatalog(data.languages || st.languages || [], data.templates);
      setLocalPill({
        ready: !!st.ready,
        ollama: !!st.ollama,
        model: st.model || "",
        host: st.host || "",
        message: data.message || st.message || "Local",
        pull: st.pull,
        install: st.install || data.install?.install || data.install,
        scripts_ready: !!st.scripts_ready,
        ready_languages: st.ready_languages || [],
      });

      const needsPoll = !!(st.pull?.active || st.install?.active || data.install?.installing || data.install?.install?.active);
      if (needsPoll) {
        const poll = async () => {
          const d = await refreshLocalStatus();
          if (d && (d.pull?.active || d.install?.active)) setTimeout(poll, 2200);
          else {
            // Continue setup once install finishes
            if (d && !d.ready) {
              fetch("/api/canvas/local/setup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({ pull: true, ensure_site: true, install_ollama: true }),
              }).then(() => refreshLocalStatus()).then(() => loadModels().catch(() => {}));
            } else loadModels().catch(() => {});
          }
        };
        setTimeout(poll, 1800);
      } else {
        loadModels().catch(() => {});
      }
      let hadPrivPref = false;
      try { hadPrivPref = localStorage.getItem("noeti_canvas_private") != null; } catch (_) {}
      if (!hadPrivPref && st.ollama) {
        setPrivate(true);
        setStatus("Local compute armed · private on-node");
        setTimeout(() => setStatus("", false), 1800);
      } else if (st.ready) {
        setStatus(st.message || "Local ready");
        setTimeout(() => setStatus("", false), 1600);
      }
    } catch (_) {
      setLocalPill({ ready: false, ollama: false, message: "Local offline · scripts still run" });
    }
  }

  function pushUndo() {
    try {
      undoStack.push(JSON.stringify(state));
      if (undoStack.length > 40) undoStack.shift();
      redoStack = [];
    } catch (_) {}
  }

  function undo() {
    if (!undoStack.length) {
      setStatus("Nothing to undo");
      setTimeout(() => setStatus("", false), 1200);
      return;
    }
    try {
      redoStack.push(JSON.stringify(state));
      if (redoStack.length > 40) redoStack.shift();
      state = JSON.parse(undoStack.pop());
      selectedId = null;
      selectedIds = new Set();
      save();
      renderNodes();
      drawRegions();
      renderInspector();
      applyCam();
      setStatus("Undo");
      setTimeout(() => setStatus("", false), 1000);
    } catch (_) {}
  }

  function redo() {
    if (!redoStack.length) {
      setStatus("Nothing to redo");
      setTimeout(() => setStatus("", false), 1200);
      return;
    }
    try {
      undoStack.push(JSON.stringify(state));
      if (undoStack.length > 40) undoStack.shift();
      state = JSON.parse(redoStack.pop());
      selectedId = null;
      selectedIds = new Set();
      save();
      renderNodes();
      drawRegions();
      renderInspector();
      applyCam();
      setStatus("Redo");
      setTimeout(() => setStatus("", false), 1000);
    } catch (_) {}
  }

  function deleteNodesByIds(ids) {
    const set = ids instanceof Set ? ids : new Set(ids || []);
    if (!set.size) return false;
    pushUndo();
    state.nodes = state.nodes.filter((n) => !set.has(n.id));
    state.edges = state.edges.filter((ed) => !set.has(ed.from) && !set.has(ed.to));
    (state.regions || []).forEach((r) => {
      r.nodeIds = (r.nodeIds || []).filter((id) => !set.has(id));
    });
    selectedId = null;
    selectedIds = new Set();
    save();
    renderNodes();
    drawRegions();
    renderInspector();
    return true;
  }

  function syncNodeRegionMembership(n) {
    const regs = state.regions || [];
    const prev = regs.find((r) => (r.nodeIds || []).includes(n.id));
    const hit = resolveContainingRegion(n);
    if (prev && prev !== hit) {
      prev.nodeIds = (prev.nodeIds || []).filter((id) => id !== n.id);
    }
    if (hit) {
      hit.nodeIds = hit.nodeIds || [];
      if (!hit.nodeIds.includes(n.id)) hit.nodeIds.push(n.id);
      n.data.route = hit.route;
      n.data.machine = hit.machine || null;
      n.data.private = !!hit.private;
      if (hit.route === "phone") n.data.phone = hit.machine || null;
      const el = els.world?.querySelector?.(`.cv-node[data-id="${n.id}"]`);
      if (el) {
        el.dataset.route = hit.route || "";
        const badge = el.querySelector(".cv-route-badge");
        const whereLabel = routeDisplay(hit.route, hit.machine);
        if (badge) {
          badge.textContent = whereLabel;
          badge.className = `cv-route-badge ${hit.route || ""}${hit.placeholder ? " is-soon" : ""}`;
        } else if (hit.route) {
          const grow = el.querySelector(".cv-node-head .grow");
          if (grow) {
            const span = document.createElement("span");
            span.className = `cv-route-badge ${hit.route}${hit.placeholder ? " is-soon" : ""}`;
            span.textContent = whereLabel;
            grow.after(span);
          }
        }
        const where = el.querySelector("[data-where]");
        if (where) {
          where.hidden = false;
          where.textContent = `Where · ${whereLabel}`;
        }
      }
    } else if (prev && n.data.route && prev.route === n.data.route) {
      /* left zone without entering another — keep explicit route */
    }
    fitRegionsToNodes();
    drawRegions();
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!parsed?.nodes) return false;
      state = parsed;
      state.cam = state.cam || { x: 80, y: 60, z: 1 };
      state.edges = state.edges || [];
      state.regions = state.regions || [];
      return true;
    } catch (_) {
      return false;
    }
  }

  function applyCam() {
    if (camRaf) return;
    camRaf = requestAnimationFrame(() => {
      camRaf = 0;
      const { x, y, z } = state.cam;
      els.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
      const layer = document.getElementById("regionsLayer");
      if (layer) layer.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
      els.zoomLabel.textContent = `${Math.round(z * 100)}%`;
      scheduleWires();
      // regionsLayer shares cam transform — no full redraw on pan/zoom
    });
  }

  function scheduleWires() {
    if (wireRaf) return;
    wireRaf = requestAnimationFrame(() => {
      wireRaf = 0;
      drawWires();
    });
  }

  function screenToWorld(clientX, clientY) {
    const rect = els.viewport.getBoundingClientRect();
    const { x, y, z } = state.cam;
    return {
      x: (clientX - rect.left - x) / z,
      y: (clientY - rect.top - y) / z,
    };
  }

  function portWorld(node, which) {
    const el = els.world?.querySelector?.(`.cv-node[data-id="${node.id}"]`);
    if (el) {
      const port = el.querySelector(`.cv-port.${which === "in" ? "in" : "out"}`);
      if (port) {
        const nr = el.getBoundingClientRect();
        const pr = port.getBoundingClientRect();
        const z = state.cam.z || 1;
        return {
          x: node.x + (pr.left + pr.width / 2 - nr.left) / z,
          y: node.y + (pr.top + pr.height / 2 - nr.top) / z,
        };
      }
      const b = nodeBounds(node);
      return {
        x: which === "in" ? node.x : node.x + b.w,
        y: node.y + b.h / 2,
      };
    }
    const b = nodeBounds(node);
    return {
      x: which === "in" ? node.x : node.x + b.w,
      y: node.y + b.h / 2,
    };
  }

  function bezier(a, b) {
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.45);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }

  function drawWires() {
    const { x, y, z } = state.cam;
    const parts = [];
    for (const e of state.edges) {
      const a = state.nodes.find((n) => n.id === e.from);
      const b = state.nodes.find((n) => n.id === e.to);
      if (!a || !b) continue;
      const p1 = portWorld(a, "out");
      const p2 = portWorld(b, "in");
      // wire SVG is screen-space overlay — convert world to screen
      const s1 = { x: p1.x * z + x, y: p1.y * z + y };
      const s2 = { x: p2.x * z + x, y: p2.y * z + y };
      const rel = e.rel || "related";
      parts.push(`<path d="${bezier(s1, s2)}" class="${e.active ? "active" : ""} rel-${rel}" data-edge="${e.id}" data-rel="${rel}" />`);
    }
    if (draftWire) {
      parts.push(`<path d="${bezier(draftWire.a, draftWire.b)}" class="active" />`);
    }
    els.wires.innerHTML = parts.join("");
  }

  function bindJobButtons(root) {
    if (!root) return;
    root.querySelectorAll(".cv-job").forEach((btn) => {
      btn.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("job", btn.dataset.type);
      });
      btn.addEventListener("click", () => {
        const pt = screenToWorld(window.innerWidth * 0.45, window.innerHeight * 0.35);
        addNode(btn.dataset.type, pt.x, pt.y);
      });
    });
  }

  function jobButtonHtml(j) {
    return `<button type="button" class="cv-job" draggable="true" data-type="${j.type}" data-label="${escapeAttr(j.label)}">
      <span class="dot" aria-hidden="true"></span>
      <span><strong>${escapeHtml(j.label)}</strong><small>${escapeHtml(j.hint)}</small></span>
    </button>`;
  }

  function renderPalette() {
    const q = (document.getElementById("menuSearch")?.value || "").trim().toLowerCase();
    const match = (j) => !q || j.label.toLowerCase().includes(q) || j.hint.toLowerCase().includes(q) || j.type.includes(q) || (j.section || "").toLowerCase().includes(q);
    if (els.jobsList) {
      const jobs = JOBS.filter((j) => j.group === "elements" && match(j));
      const sections = [];
      const seen = new Set();
      for (const j of jobs) {
        const sec = j.section || "Blocks";
        if (!seen.has(sec)) { seen.add(sec); sections.push(sec); }
      }
      els.jobsList.innerHTML = sections.map((sec) => `
        <p class="cv-menu-section">${escapeHtml(sec)}</p>
        ${jobs.filter((j) => (j.section || "Blocks") === sec).map(jobButtonHtml).join("")}
      `).join("") || `<p class="cv-menu-empty">No matches</p>`;
      bindJobButtons(els.jobsList);
    }
    if (els.jobsListRoles) {
      els.jobsListRoles.innerHTML = JOBS.filter((j) => j.group === "roles" && match(j)).map(jobButtonHtml).join("")
        || `<p class="cv-menu-empty">No matches</p>`;
      bindJobButtons(els.jobsListRoles);
    }
    if (els.demoList) {
      els.demoList.innerHTML = DEMOS.filter((d) => !q || d.title.toLowerCase().includes(q) || d.blurb.toLowerCase().includes(q)).map((d) => `
        <button type="button" class="cv-demo" data-demo="${d.id}">
          <span class="cv-demo-tag">${escapeHtml(d.tag)}</span>
          <strong>${escapeHtml(d.title)}</strong>
          <em>${escapeHtml(d.blurb)}</em>
        </button>
      `).join("") || `<p class="cv-menu-empty">No matches</p>`;
      els.demoList.querySelectorAll("[data-demo]").forEach((btn) => {
        btn.addEventListener("click", () => applyTemplate(btn.dataset.demo));
      });
    }
    renderLangGrid();
  }

  function setMenuTab(tab) {
    document.querySelectorAll(".cv-menu-tab").forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".cv-menu-panel").forEach((p) => {
      const on = p.dataset.panel === tab;
      p.classList.toggle("is-on", on);
      p.hidden = !on;
    });
  }

  function startWhereDraw(preset = null) {
    wherePreset = preset || null;
    setRegionMode(true);
    setMenuTab("where");
    const label = preset ? (ROUTE_LABELS[preset] || preset) : "any";
    setStatus(preset
      ? `Draw a square · will mark as ${label}`
      : "Draw a square · then pick where");
  }

  function filteredModels() {
    let list = models.length ? models : [{ id: "on-node", name: "On-node default", on_node: true }];
    if (privateLocal) {
      const local = list.filter((m) => m.on_node);
      return local.length ? local : list;
    }
    if (modelFilter === "node") return list.filter((m) => m.on_node);
    if (modelFilter === "fast") return list.filter((m) => /mini|flash|0\.5|1\.5|small|haiku|lite/i.test(m.id + (m.name || "")));
    if (modelFilter === "flagship") return list.filter((m) => /gpt-4|claude-3|opus|sonnet|235|70b|405|o1|o3/i.test(m.id + (m.name || "")));
    return list;
  }

  function modelOptions(selected) {
    const list = filteredModels();
    const rows = list.slice(0, 400);
    if (selected && !rows.some((m) => m.id === selected)) {
      const hit = models.find((m) => m.id === selected);
      if (hit) rows.unshift(hit);
      else rows.unshift({ id: selected, name: selected });
    }
    return rows
      .map((m) => {
        const label = m.name || m.id;
        const tag = m.on_node ? " · node" : m.decentralized ? " · dec" : "";
        const sel = m.id === selected ? " selected" : "";
        return `<option value="${escapeAttr(m.id)}"${sel}>${escapeHtml(label)}${tag}</option>`;
      })
      .join("");
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

  function nodeBodyHtml(n) {
    const def = jobDef(n.type);
    if (n.type === "note") {
      return `<textarea data-field="text" rows="5" placeholder="Sticky note…">${escapeHtml(n.data.text || "")}</textarea>`;
    }
    if (n.type === "prompt" || n.type === "system") {
      return `<textarea data-field="text" rows="4" placeholder="${n.type === "system" ? "System instructions…" : "Write a prompt…"}">${escapeHtml(n.data.text || "")}</textarea>
        <div class="out" data-out data-placeholder="Passes text downstream"></div>`;
    }
    if (n.type === "model") {
      return `
        <select data-field="model">${modelOptions(n.data.model)}</select>
        <div class="meta-row">
          <span class="cv-chip">temp ${Number(n.data.temp ?? 0.55).toFixed(2)}</span>
          ${n.data.latency_ms ? `<span class="cv-chip">${n.data.latency_ms}ms</span>` : ""}
        </div>
        <div class="out" data-out data-placeholder="Model output appears here"></div>`;
    }
    if (n.type === "brain") {
      const st = window.NoetiBrain?.getStatus?.() || {};
      return `
        <p class="cv-phone-meta">${st.count ? `${st.count} files mapped` : "Allow a folder to build the map"} · ${st.enabled ? "on" : "off"}</p>
        <button type="button" class="cv-attach primary" data-brain-open>Open Second Brain</button>
        <button type="button" class="cv-attach" data-brain-surface>Open Files on Canvas</button>
        <button type="button" class="cv-attach" data-brain-refresh>Refresh map → out</button>
        <div class="out" data-out data-placeholder="Workspace map appears here"></div>`;
    }
    if (n.type === "vision") {
      return `
        <select data-field="model">${modelOptions(n.data.model)}</select>
        <textarea data-field="text" rows="2" placeholder="What should we see?">${escapeHtml(n.data.text || "")}</textarea>
        <button type="button" class="cv-attach" data-attach>Attach image</button>
        <button type="button" class="cv-attach" data-phone-pull>Pull from phone</button>
        <img class="cv-thumb ${n.data.image ? "is-on" : ""}" data-thumb alt="" src="${n.data.image || ""}" />
        <div class="out" data-out data-placeholder="Vision result"></div>`;
    }
    if (n.type === "phone") {
      const paired = !!(n.data.pair_session && (n.data.pair_live || n.data.live));
      const live = !!n.data.live;
      const hasImg = !!n.data.image;
      const device = n.data.device || n.data.phone || "Phone";
      return `
        <div class="meta-row">
          <span class="cv-chip ${live ? "is-live" : ""}">${live ? "LIVE" : paired ? "Paired" : "Pair phone"}</span>
          ${n.data.latency_ms ? `<span class="cv-chip">${n.data.latency_ms}ms</span>` : ""}
        </div>
        <p class="cv-phone-meta">${escapeHtml(device)} · ${live ? "live video on board" : paired ? "open phone → Go live" : "scan QR to connect"}</p>
        <img class="cv-phone-live ${live || hasImg ? "is-on" : ""}" data-phone-live alt="Phone live" src="${escapeHtml(n.data.image || "")}" />
        <button type="button" class="cv-attach primary" data-phone-pair>${paired || live ? "Re-pair / QR" : "Pair phone"}</button>
        <button type="button" class="cv-attach" data-phone-snap ${live || hasImg ? "" : "hidden"}>Freeze</button>
        <button type="button" class="cv-attach" data-phone-vision ${live || hasImg ? "" : "hidden"}>→ Vision</button>
        <button type="button" class="cv-attach" data-attach>Upload</button>
        <div class="out" data-out data-placeholder="Live video / still lands here"></div>`;
    }
    if (n.type === "calc") {
      return `<div class="out" data-out data-placeholder="Checks numbers in upstream text"></div>`;
    }
    if (n.type === "script" || n.type === "script_py" || n.type === "script_c") {
      const lang = normalizeLang(n.data.lang || (n.type === "script_c" ? "c" : n.type === "script_py" ? "python" : "python"));
      const lines = (n.data.source || "").split("\n").length;
      return `
        <div class="meta-row">
          <span class="cv-chip">${escapeHtml(lang)}</span>
          <span class="cv-chip">local snap-in</span>
          ${n.data.latency_ms != null ? `<span class="cv-chip">${n.data.latency_ms}ms</span>` : ""}
        </div>
        <p class="cv-script-hint">${lines} lines · double-click → Editor · Run on PC</p>
        <div class="out" data-out data-placeholder="Script output + explain"></div>
        ${n.data.explain ? `<p class="cv-script-explain" data-explain>${escapeHtml(n.data.explain)}</p>` : `<p class="cv-script-explain" data-explain hidden></p>`}`;
    }
    if (n.type === "atomize" || n.type === "witness" || n.type === "checker" || n.type === "validator" || n.type === "watcher" || n.type === "gate" || n.type === "code") {
      const modelBit = ["atomize", "witness", "checker", "validator", "watcher"].includes(n.type)
        ? `<select data-field="model">${modelOptions(n.data.model)}</select>`
        : "";
      return `${modelBit}<div class="out" data-out data-placeholder="${def.hint}"></div>`;
    }
    if (n.type === "output") {
      return `<div class="out" data-out data-placeholder="Final output"></div>`;
    }
    return `<div class="out" data-out></div>`;
  }


  const ROUTE_LABELS = {
    private: "Private",
    local: "Local",
    decentralized: "Decentralized",
    centralized: "Centralized",
    machine: "Specific PC",
    phone: "Phone",
  };
  const ROUTE_HINTS = {
    private: "On-node · no network",
    local: "This computer · on-node",
    decentralized: "Mesh / self-host",
    centralized: "Cloud catalog",
    machine: "Named computer",
    phone: "Phone camera + on-device compute",
  };
  const MACHINE_LABELS = {
    this: "This browser host",
    "site-01": "site-01",
    "peer-01": "peer-01",
    "desk-02": "desk-02",
    custom: "Custom host",
  };

  /** Imagined host cards for Specific PC zones (pin ships later — content is real-feeling now). */
  const MACHINE_PROFILES = {
    this: {
      name: "This browser host",
      where: "Local tab · this machine",
      specs: "Browser · on-node path",
      queue: "—",
      status: "Active",
      card: "HOST · this browser\nRuns in the open tab.\nNo peer pin required.",
    },
    "site-01": {
      name: "Newsroom rack A",
      where: "Edit bay · Floor 3 · cage 2",
      specs: "2× RTX 4090 · 128 GB · Ollama",
      queue: "Q-4412 warm · 1 polish job",
      status: "Online · pin pending",
      host: "nr-rack-a.floor3",
      card: `HOST CARD · site-01
nr-rack-a.floor3 · edit bay cage 2
2× RTX 4090 · 128 GB RAM · Ubuntu 24.04
GPU0 22/24 GB free · GPU1 idle
Ollama up · heartbeat 4s ago
Queue Q-4412 · draft polish waiting
Role: newsroom inference rack
Pin: placeholder until federation`,
    },
    "peer-01": {
      name: "Field laptop · Mira",
      where: "South approach · van Wi-Fi",
      specs: "M3 Max · 64 GB · on-battery 71%",
      queue: "field-check idle",
      status: "Reachable · pin pending",
      host: "mira-mbp.field",
      card: `HOST CARD · peer-01
mira-mbp.field · reporter Mira Chen
MacBook Pro M3 Max · 64 GB · 71% battery
LTE + van Wi-Fi · RTT ~48ms to site
Camera roll synced · GPS near south span
Role: field checker / contest soft claims
Pin: placeholder until federation`,
    },
    "desk-02": {
      name: "Night desk tower",
      where: "Newsroom · desk row B",
      specs: "4090 · 64 GB · always-on",
      queue: "night-queue empty",
      status: "Online · pin pending",
      host: "desk-02.newsroom",
      card: `HOST CARD · desk-02
desk-02.newsroom · night shift tower
RTX 4090 · 64 GB · always-on
Role: overflow polish + seal staging
Pin: placeholder until federation`,
    },
    custom: {
      name: "Custom host",
      where: "Named machine",
      specs: "User-defined",
      queue: "—",
      status: "Named · pin pending",
      card: "HOST CARD · custom\nName this computer in the zone picker.\nPin ships with federation.",
    },
  };

  const liveDevices = new Map(); // device_id -> list row

  function machineProfile(machine) {
    const key = machine || "";
    const live = liveDevices.get(key);
    if (live) {
      const host = live.hostname || live.label || key;
      const models = (live.models || []).slice(0, 4).join(", ") || "Ollama";
      return {
        name: live.label || host,
        where: live.online ? `Online · ${host}` : `Offline · ${host}`,
        specs: `${live.platform || "PC"} · ${models}`,
        queue: live.pending_jobs ? `${live.pending_jobs} queued` : "idle",
        status: live.online ? (live.ollama ? "Online · Ollama" : "Online · no Ollama") : "Offline",
        host,
        card: `HOST · ${key}
${host} · ${live.platform || "PC"}
${live.online ? "Agent connected" : "Agent offline"} · Ollama ${live.ollama ? "up" : "down"}
Models: ${(live.models || []).slice(0, 8).join(", ") || "(none)"}
Role: paired computer · Canvas Where target`,
      };
    }
    return MACHINE_PROFILES[key] || {
      name: key || "Named PC",
      where: "Specific computer",
      specs: "Pinned host",
      queue: "—",
      status: key.startsWith("pc-") ? "Paired · waiting for agent" : "Named · demo",
      card: `HOST CARD · ${key || "unnamed"}\n${key.startsWith("pc-") ? "Paired device · start agent on that PC." : "Demo host · Connect PC for real routing."}`,
    };
  }

  function refreshDevicePicker() {
    const sel = document.getElementById("machineSelect");
    if (!sel) return;
    const prev = sel.value;
    const liveOpts = [...liveDevices.values()]
      .sort((a, b) => (b.online - a.online) || String(a.label || "").localeCompare(String(b.label || "")))
      .map((d) => {
        const tag = d.online ? (d.ollama ? "online" : "online · no ollama") : "offline";
        const name = d.label || d.hostname || d.device_id;
        return `<option value="${escapeHtml(d.device_id)}">${escapeHtml(name)} · ${tag}</option>`;
      })
      .join("");
    const parts = [`<option value="">Choose a computer…</option>`];
    if (liveOpts) {
      parts.push(`<optgroup label="Paired PCs">${liveOpts}</optgroup>`);
    } else {
      parts.push(`<option value="" disabled>No paired PCs — use Connect PC</option>`);
    }
    parts.push(`<optgroup label="Demo hosts (Jobs samples only)">
      <option value="this">This browser host · demo</option>
      <option value="site-01">site-01 · demo rack</option>
      <option value="peer-01">peer-01 · demo laptop</option>
    </optgroup>`);
    sel.innerHTML = parts.join("");
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
    else if (liveDevices.size) {
      const firstOnline = [...liveDevices.values()].find((d) => d.online);
      if (firstOnline) sel.value = firstOnline.device_id;
    }
  }

  async function refreshLiveDevices() {
    try {
      const res = await fetch("/api/canvas/device/list", { credentials: "same-origin", cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) return;
      liveDevices.clear();
      (data.devices || []).forEach((d) => {
        if (d?.device_id) liveDevices.set(d.device_id, d);
      });
      refreshDevicePicker();
      renderDeviceLiveList();
    } catch (_) {}
  }

  function renderDeviceLiveList() {
    const box = document.getElementById("deviceLiveList");
    if (!box) return;
    const rows = [...liveDevices.values()];
    if (!rows.length) {
      box.innerHTML = `<p class="cv-machine-note" style="margin-top:0.75rem">No paired PCs yet. Copy the command below on the computer you want to use.</p>`;
      return;
    }
    box.innerHTML = `<p class="cv-machine-note" style="margin-top:0.75rem">Paired</p>` + rows.map((d) => {
      const on = d.online ? "is-on" : "";
      const name = escapeHtml(d.label || d.hostname || d.device_id);
      const meta = escapeHtml([d.hostname, d.platform, d.ollama ? "Ollama" : "no Ollama"].filter(Boolean).join(" · "));
      return `<div class="cv-device-row ${on}"><strong>${name}</strong><span>${d.online ? "Online" : "Offline"} · ${meta}</span></div>`;
    }).join("");
  }

  const PHONE_PROFILES = {
    "phone-mira": {
      name: "Mira's iPhone",
      where: "South approach · field",
      specs: "iPhone 15 Pro · A17 · Neural Engine",
      queue: "camera hot · 2 shots",
      status: "Online · pin pending",
      role: "Field camera + light contest",
      card: `PHONE · phone-mira
Mira Chen · iPhone 15 Pro
South approach · LTE + van Wi-Fi
Camera: 48MP · HDR on · GPS tagged
Battery 64% · Neural Engine idle
Role: capture + on-device soft check
Pin: placeholder until federation`,
    },
    "phone-desk": {
      name: "Desk Android",
      where: "Newsroom · desk row B",
      specs: "Pixel 8 · Titan M2",
      queue: "scan tray · 1 doc",
      status: "Online · pin pending",
      role: "Document scan → vision",
      card: `PHONE · phone-desk
Desk Android · Pixel 8
Newsroom row B · Wi-Fi 6
Camera: doc mode · glare reduce
Battery 88% · scan tray ready
Role: ledger / stamp photos
Pin: placeholder until federation`,
    },
    "phone-night": {
      name: "Night shift handset",
      where: "Night desk · overflow",
      specs: "Galaxy S24 · on-device LLM slot",
      queue: "idle · push ready",
      status: "Reachable · pin pending",
      role: "On-device polish overflow",
      card: `PHONE · phone-night
Night shift handset · Galaxy S24
On-device LLM slot warm
Role: overflow contest / quick graf
Pin: placeholder until federation`,
    },
  };

  function phoneProfile(id) {
    const key = id || "";
    return PHONE_PROFILES[key] || {
      name: key || "Phone",
      where: "Mobile device",
      specs: "Camera + on-device",
      queue: "—",
      status: "Named · pin pending",
      role: "Phone",
      card: `PHONE · ${key || "unnamed"}\nImagined handset until live pin ships.`,
    };
  }

  /** Tiny SVG stand-ins so phone→vision demos aren't empty shells. */
  function phoneSampleImage(kind) {
    const title = kind === "bridge" ? "BRIDGE SPAN" : "LEDGER PAGE";
    const sub = kind === "bridge" ? "south approach · 00:14" : "sum 14,200 · stamped";
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='640' height='480' viewBox='0 0 640 480'>
      <defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='%23f4f4f4'/><stop offset='100%' stop-color='%23dcdcdc'/></linearGradient></defs>
      <rect width='640' height='480' fill='url(%23g)'/>
      <rect x='40' y='40' width='560' height='400' fill='%23fff' stroke='%23111' stroke-width='2'/>
      <text x='60' y='90' font-family='IBM Plex Mono,monospace' font-size='22' fill='%23111'>PHONE CAPTURE</text>
      <text x='60' y='130' font-family='IBM Plex Sans,sans-serif' font-size='28' fill='%23111'>${title}</text>
      <text x='60' y='170' font-family='IBM Plex Mono,monospace' font-size='16' fill='%23666'>${sub}</text>
      <text x='60' y='220' font-family='IBM Plex Mono,monospace' font-size='14' fill='%23999'>placeholder · replace with live phone push</text>
      ${kind === "ledger" ? "<text x='420' y='380' font-family='IBM Plex Mono,monospace' font-size='26' fill='%23111'>14,200</text><circle cx='120' cy='340' r='36' fill='none' stroke='%23111' stroke-width='2'/><text x='98' y='346' font-size='12' fill='%23111'>STAMP</text>" : "<rect x='80' y='260' width='480' height='24' fill='%23111' opacity='0.12'/><rect x='80' y='300' width='360' height='16' fill='%23111' opacity='0.08'/>"}
    </svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  function routeDisplay(route, machine) {
    if (route === "machine") {
      const live = machine ? liveDevices.get(machine) : null;
      if (live) return live.label || live.hostname || machine;
      return machine ? `${machine}` : "Specific PC";
    }
    if (route === "phone") {
      const p = phoneProfile(machine);
      return machine ? `${machine}` : "Phone";
    }
    return ROUTE_LABELS[route] || route || "Auto";
  }

  function deviceProfile(route, id) {
    if (route === "phone") return phoneProfile(id);
    if (route === "machine") return machineProfile(id);
    return null;
  }


  function nodeBounds(n) {
    const el = els.world?.querySelector?.(`.cv-node[data-id="${n.id}"]`);
    if (el) {
      return {
        x: n.x,
        y: n.y,
        w: Math.max(el.offsetWidth || 0, n.type === "note" ? 260 : 300),
        h: Math.max(el.offsetHeight || 0, 120),
      };
    }
    const w = n.type === "note" ? 260 : 300;
    const text = String(n.data?.output || n.data?.text || "");
    const lines = Math.max(2, text.split("\n").length);
    const outExtra = n.data?.output ? Math.min(200, 36 + lines * 13) : 0;
    const body = n.type === "note" ? 88 : (n.type === "output" || n.type === "calc" || n.type === "code" || n.type === "gate" ? 70 : 100);
    const h = Math.min(460, 56 + body + outExtra);
    return { x: n.x, y: n.y, w, h };
  }

  function rectsIntersect(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  /** Grow / shrink each zone so it fully wraps its member blocks (chip + padding). */
  function fitRegionsToNodes() {
    const padX = 48;
    const padTop = 88;
    const padBot = 48;
    for (const r of state.regions || []) {
      const ids = r.nodeIds || [];
      if (!ids.length) continue;
      const members = state.nodes.filter((n) => ids.includes(n.id));
      if (!members.length) continue;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of members) {
        const b = nodeBounds(n);
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.w);
        maxY = Math.max(maxY, b.y + b.h);
      }
      r.x = Math.round(minX - padX);
      r.y = Math.round(minY - padTop);
      r.w = Math.round(Math.max(160, maxX - minX + padX * 2));
      r.h = Math.round(Math.max(120, maxY - minY + padTop + padBot));
    }
  }

  function drawRegions() {
    const layer = document.getElementById("regionsLayer");
    if (!layer) return;
    fitRegionsToNodes();
    const regs = state.regions || [];
    layer.innerHTML = regs.map((r) => {
      const n = (r.nodeIds || []).length;
      const where = routeDisplay(r.route, r.machine);
      const hint = r.title || ROUTE_HINTS[r.route] || "";
      const isPh = r.placeholder != null
        ? !!r.placeholder
        : (r.route === "phone" || (r.route === "machine" && !String(r.machine || "").startsWith("pc-")));
      const ph = isPh ? " is-placeholder" : "";
      const mp = deviceProfile(r.route, r.machine);
      const kind = r.route === "phone" ? "phone" : r.route === "machine" ? "specific PC" : "";
      const runs = r.runsOn || (
        r.route === "private" ? "This node only · sealed" :
        r.route === "local" ? "This computer" :
        r.route === "decentralized" ? "Network mesh" :
        r.route === "centralized" ? "Cloud catalog" :
        r.route === "phone" ? (mp ? `${mp.name} · ${mp.where}` : "Phone") :
        mp ? `${mp.name} · ${mp.where}` : ""
      );
      const meta = mp
        ? `${mp.specs} · ${mp.queue}`
        : `${r.title || ""}${r.title ? " · " : ""}${n ? n + " block" + (n === 1 ? "" : "s") : "empty"}`;
      const status = mp ? mp.status : "";
      return `
      <div class="cv-region route-${r.route || "local"}${ph}" data-region="${r.id}"
        style="left:${r.x}px;top:${r.y}px;width:${Math.max(24, r.w)}px;height:${Math.max(24, r.h)}px"
        title="Double-click to remove · ${escapeAttr(hint)}">
        <div class="cv-region-chip">
          <span class="cv-region-kicker">${escapeHtml(r.title ? "Zone" : "Where")}${kind ? " · " + kind : ""}</span>
          <span class="cv-region-label">${escapeHtml(mp ? (r.machine || where) : where)}</span>
          <span class="cv-region-runs">${escapeHtml(runs)}</span>
          <span class="cv-region-meta">${escapeHtml(meta)}</span>
          ${status ? `<span class="cv-region-status">${escapeHtml(status)}</span>` : ""}
        </div>
      </div>`;
    }).join("");
    layer.querySelectorAll("[data-region]").forEach((el) => {
      el.addEventListener("dblclick", () => {
        pushUndo();
        state.regions = (state.regions || []).filter((x) => x.id !== el.dataset.region);
        save();
        drawRegions();
        setStatus("Region removed");
        setTimeout(() => setStatus("", false), 1200);
      });
    });
  }

  function setRegionMode(on) {
    regionMode = !!on;
    const btn = document.getElementById("btnRegionSelect");
    btn?.classList.toggle("is-on", regionMode);
    btn?.setAttribute("aria-pressed", regionMode ? "true" : "false");
    els.viewport?.classList.toggle("is-region", regionMode);
    const pick = document.getElementById("machinePick");
    if (pick) pick.hidden = true;
    if (!regionMode) {
      const mq = document.getElementById("marquee");
      if (mq) mq.hidden = true;
      marquee = null;
      wherePreset = null;
    } else {
      setStatus(wherePreset
        ? `Draw around blocks · zone → ${ROUTE_LABELS[wherePreset] || wherePreset}`
        : "Draw around blocks · then choose where they run");
    }
    document.getElementById("btnRegionSelect")?.classList.toggle("is-on", regionMode);
  }

  function updateMarqueeEl() {
    const mq = document.getElementById("marquee");
    if (!mq || !marquee) return;
    const x = Math.min(marquee.x0, marquee.x1);
    const y = Math.min(marquee.y0, marquee.y1);
    const w = Math.abs(marquee.x1 - marquee.x0);
    const h = Math.abs(marquee.y1 - marquee.y0);
    mq.hidden = false;
    mq.style.left = `${x}px`;
    mq.style.top = `${y}px`;
    mq.style.width = `${w}px`;
    mq.style.height = `${h}px`;
  }

  function finishMarquee() {
    const mq = document.getElementById("marquee");
    if (!marquee) return;
    const rect = els.viewport.getBoundingClientRect();
    const { x: cx, y: cy, z } = state.cam;
    const sx = Math.min(marquee.x0, marquee.x1);
    const sy = Math.min(marquee.y0, marquee.y1);
    const sw = Math.abs(marquee.x1 - marquee.x0);
    const sh = Math.abs(marquee.y1 - marquee.y0);
    if (mq) mq.hidden = true;
    marquee = null;
    if (sw < 12 || sh < 12) {
      setStatus("Draw a larger square");
      setTimeout(() => setStatus("", false), 1400);
      return;
    }
    // Convert screen (viewport-local) to world
    const world = {
      x: (sx - cx) / z,
      y: (sy - cy) / z,
      w: sw / z,
      h: sh / z,
    };
    const hits = state.nodes.filter((n) => rectsIntersect(nodeBounds(n), world));
    selectedIds = new Set(hits.map((n) => n.id));
    selectedId = hits[0]?.id || null;
    renderNodes();
    pendingRegion = { ...world, nodeIds: [...selectedIds] };
    if (wherePreset) {
      const preset = wherePreset;
      wherePreset = null;
      assignRoute(preset);
      return;
    }
    const pop = document.getElementById("routePop");
    if (pop) {
      openDrop(pop);
      const lead = document.getElementById("routePopLead") || pop.querySelector("p");
      if (lead) {
        lead.textContent = hits.length
          ? `${hits.length} block(s) encircled — pick where they run`
          : "Empty zone — still save a where-capsule?";
      }
      const mp = document.getElementById("machinePick");
      if (mp) mp.hidden = true;
    }
    setStatus(`${hits.length} block(s) selected`);
  }

  function assignRoute(route, machine = null) {
    if (!pendingRegion || !route) return;
    if (route === "machine" && !machine) {
      const mp = document.getElementById("machinePick");
      const pp = document.getElementById("phonePick");
      if (pp) pp.hidden = true;
      if (mp) {
        mp.hidden = false;
        refreshDevicePicker();
      }
      setStatus("Pick a connected PC · or Connect another PC");
      return;
    }
    if (route === "phone" && !machine) {
      const mp = document.getElementById("machinePick");
      const pp = document.getElementById("phonePick");
      if (mp) mp.hidden = true;
      if (pp) {
        pp.hidden = false;
        const sel = document.getElementById("phoneSelect");
        if (sel && !sel.value) sel.selectedIndex = 0;
      }
      setStatus("Pick a live phone · or Pair a phone");
      return;
    }
    pushUndo();
    const ids = new Set(pendingRegion.nodeIds || []);
    const effective = (route === "machine" || route === "phone" || route === "private") ? "local" : route;
    state.nodes.forEach((n) => {
      if (ids.has(n.id)) {
        n.data.route = route;
        n.data.machine = machine || null;
        if (route === "phone") n.data.phone = machine || null;
        n.data.private = route === "private";
        n.data.route_placeholder = route === "phone" || (route === "machine" && !(machine || "").startsWith("pc-"));
        const pick = pickModelForRoute(effective, n.data.model);
        if (pick) n.data.model = pick;
      }
    });
    state.regions = state.regions || [];
    const profile = deviceProfile(route, machine);
    state.regions.push({
      id: uid("r"),
      x: pendingRegion.x,
      y: pendingRegion.y,
      w: pendingRegion.w,
      h: pendingRegion.h,
      route,
      machine: machine || null,
      private: route === "private",
      placeholder: route === "phone" || (route === "machine" && !(machine || "").startsWith("pc-")),
      title: profile?.name || null,
      runsOn: profile ? `${profile.name} · ${profile.where}` : null,
      nodeIds: [...ids],
    });
    pendingRegion = null;
    closeDrop(document.getElementById("routePop"), 160);
    const mp = document.getElementById("machinePick");
    if (mp) mp.hidden = true;
    const pp = document.getElementById("phonePick");
    if (pp) pp.hidden = true;
    save();
    renderNodes();
    drawRegions();
    renderInspector();
    const label = routeDisplay(route, machine);
    setStatus((route === "phone")
      ? `Zone → ${label}`
      : (route === "machine" && !(machine || "").startsWith("pc-"))
        ? `Zone → ${label} (demo host · Connect PC for real routing)`
        : `Zone → ${label}`);
    setTimeout(() => setStatus("", false), 2200);
    setRegionMode(false);
  }

  function pickModelForRoute(route, current) {
    const list = models.length ? models : [];
    const cur = list.find((m) => m.id === current);
    if (route === "local" || route === "private") {
      if (cur?.on_node) return current;
      return list.find((m) => m.on_node)?.id || current;
    }
    if (route === "decentralized") {
      if (cur && (cur.deployment === "decentralized" || cur.decentralized || cur.on_node)) return current;
      return list.find((m) => m.deployment === "decentralized" || m.decentralized || m.on_node)?.id || current;
    }
    if (route === "centralized") {
      if (cur && cur.deployment === "centralized") return current;
      return list.find((m) => m.deployment === "centralized" || (m.id && m.id.includes("/")))?.id || current;
    }
    if (route === "machine" || route === "phone") {
      if (cur?.on_node) return current;
      return list.find((m) => m.on_node)?.id || current;
    }
    return current;
  }

  function resolveContainingRegion(node) {
    const regs = state.regions || [];
    let hit = null;
    for (const r of regs) {
      if (rectsIntersect(nodeBounds(node), r)) hit = r;
    }
    return hit;
  }

  function resolveNodeRoute(node) {
    if (node?.data?.route) return node.data.route;
    const reg = resolveContainingRegion(node);
    if (reg?.route) {
      if (reg.machine && !node.data.machine) node.data.machine = reg.machine;
      return reg.route;
    }
    if (privateLocal) return "local";
    return null;
  }

  function renderNodes() {
    const frag = document.createDocumentFragment();
    for (const n of state.nodes) {
      const el = buildNodeEl(n);
      bindNode(el, n);
      frag.appendChild(el);
    }
    els.world.replaceChildren(frag);
    drawWires();
  }

  function buildNodeEl(n) {
    const def = jobDef(n.type);
    const el = document.createElement("div");
    const route = n.data.route || resolveNodeRoute(n);
    const multiSel = selectedIds.has(n.id);
    el.className = "cv-node" + (n.id === selectedId || multiSel ? " is-selected" : "");
    el.dataset.id = n.id;
    el.dataset.type = n.type;
    if (route) el.dataset.route = route;
    el.style.left = `${n.x}px`;
    el.style.top = `${n.y}px`;
    el.style.setProperty("--node-accent", COLORS[n.type] || "#3ecf9a");
    const whereLabel = routeDisplay(route, n.data.machine);
    const livePc = route === "machine" && String(n.data.machine || "").startsWith("pc-");
    const livePhone = route === "phone" && !!(n.data.pair_live || n.data.live);
    const soon = (route === "machine" && !livePc) || (route === "phone" && !livePhone);
    const routeBadge = route
      ? `<span class="cv-route-badge ${route}${soon ? " is-soon" : ""}" title="${escapeHtml(ROUTE_HINTS[route] || "")}">${escapeHtml(whereLabel)}</span>`
      : "";
    el.innerHTML = `
      <div class="cv-node-head" data-drag>
        <span class="kind" style="color:#999">${def.label}</span>
        <span class="grow"></span>
        ${routeBadge}
        ${n.data.latency_ms ? `<span class="cv-node-latency">${n.data.latency_ms}ms</span>` : ""}
        <button type="button" class="cv-node-del" data-del aria-label="Delete">×</button>
      </div>
      <div class="cv-node-body">${nodeBodyHtml(n)}</div>
      <div class="cv-node-where" data-where ${!(n.data.last_where || route) ? "hidden" : ""}>${escapeHtml(n.data.last_where ? `Ran · ${n.data.last_where}` : (route ? `Where · ${whereLabel}` : ""))}</div>
      ${def.hasIn ? '<div class="cv-port in" data-port="in"></div>' : ""}
      ${def.hasOut ? '<div class="cv-port out" data-port="out"></div>' : ""}
    `;
    const out = el.querySelector("[data-out]");
    if (out && n.data.output != null) out.textContent = n.data.output;
    return el;
  }

  function mountNode(n, { spawn = false } = {}) {
    const el = buildNodeEl(n);
    if (spawn) el.classList.add("is-spawn");
    bindNode(el, n);
    els.world.appendChild(el);
    scheduleWires();
    return el;
  }

  function bindNode(el, n) {
    el.addEventListener("dblclick", (e) => {
      if (e.target.closest("[data-port], button, .cv-attach")) return;
      e.preventDefault();
      e.stopPropagation();
      openSurface(n.id, "auto");
    });
    el.addEventListener("mousedown", (e) => {
      if (e.target.closest("[data-port], textarea, select, input, button, .cv-attach")) return;
      if (e.shiftKey) {
        if (selectedIds.has(n.id)) selectedIds.delete(n.id);
        else selectedIds.add(n.id);
        selectedId = n.id;
        document.querySelectorAll(".cv-node").forEach((x) => {
          x.classList.toggle("is-selected", x.dataset.id === selectedId || selectedIds.has(x.dataset.id));
        });
        renderInspector();
        return;
      }
      selectedIds = new Set([n.id]);
      if (selectedId !== n.id) selectNode(n.id);
      else {
        document.querySelectorAll(".cv-node").forEach((x) => x.classList.toggle("is-selected", x.dataset.id === n.id));
      }
    });

    el.querySelector("[data-del]")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const ids = selectedIds.has(n.id) && selectedIds.size > 1 ? selectedIds : new Set([n.id]);
      deleteNodesByIds(ids);
    });

    el.querySelectorAll("[data-field]").forEach((field) => {
      const sync = () => {
        const key = field.dataset.field;
        n.data[key] = field.type === "range" ? Number(field.value) : field.value;
        if (key === "phone") {
          n.data.machine = field.value;
          n.data.route = "phone";
        }
        save();
        if (key === "temp") {
          const chip = el.querySelector(".cv-chip");
          if (chip && chip.textContent.startsWith("temp")) chip.textContent = `temp ${Number(n.data.temp).toFixed(2)}`;
        }
        if (key === "phone") {
          renderNodes();
          selectNode(n.id);
          return;
        }
        renderInspector();
      };
      field.addEventListener("input", sync);
      field.addEventListener("change", sync);
    });

    el.querySelectorAll("[data-attach]").forEach((btn) => {
      btn.addEventListener("click", () => {
        visionTarget = n.id;
        els.visionFile.click();
      });
    });
    el.querySelector("[data-brain-open]")?.addEventListener("click", () => {
      window.NoetiBrain?.open?.();
    });
    el.querySelector("[data-brain-surface]")?.addEventListener("click", () => {
      openSurface(n.id, "fs");
    });
    el.querySelector("[data-brain-refresh]")?.addEventListener("click", () => {
      const map = window.NoetiBrain?.getMapText?.() || "Second Brain empty";
      n.data.output = map;
      n.data.text = map;
      save();
      writeOut(n, map);
      setStatus("Brain map → block");
      setTimeout(() => setStatus("", false), 1400);
    });
    el.querySelector("[data-phone-pair]")?.addEventListener("click", () => {
      openPhonePair(n.id);
    });
    el.querySelector("[data-phone-snap]")?.addEventListener("click", () => {
      freezePhoneFrame(n.id);
    });
    el.querySelector("[data-phone-vision]")?.addEventListener("click", () => {
      phoneToVision(n.id);
    });
    el.querySelector("[data-phone-pull]")?.addEventListener("click", () => {
      const src = state.nodes.find((x) => x.type === "phone" && x.data.image)
        || state.nodes.find((x) => x.type === "phone");
      if (!src) {
        setStatus("Add a Phone block first");
        setTimeout(() => setStatus("", false), 1600);
        return;
      }
      if (!src.data.image) {
        setStatus("Pair a phone and send a shot first");
        setTimeout(() => setStatus("", false), 1800);
        return;
      }
      n.data.image = src.data.image;
      n.data.phone = src.data.phone || src.data.machine || src.data.device || "phone";
      n.data.route = "phone";
      n.data.output = (n.data.output || "") || "Image pulled from phone · run Vision to read";
      save();
      renderNodes();
      selectNode(n.id);
      setStatus("Pulled image from phone block");
      setTimeout(() => setStatus("", false), 1600);
    });

    const head = el.querySelector("[data-drag]");
    head?.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (selectedId !== n.id) selectNode(n.id);
      el.classList.add("is-dragging");
      els.viewport?.classList.add("is-dragging");
      const start = screenToWorld(e.clientX, e.clientY);
      const ox = n.x;
      const oy = n.y;
      const move = (ev) => {
        const p = screenToWorld(ev.clientX, ev.clientY);
        n.x = ox + (p.x - start.x);
        n.y = oy + (p.y - start.y);
        el.style.left = `${n.x}px`;
        el.style.top = `${n.y}px`;
        scheduleWires();
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        el.classList.remove("is-dragging");
        els.viewport?.classList.remove("is-dragging");
        syncNodeRegionMembership(n);
        save();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });

    el.querySelectorAll("[data-port]").forEach((port) => {
      port.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (port.dataset.port !== "out") return;
        const def = jobDef(n.type);
        if (!def.hasOut) return;
        connectFrom = n.id;
        els.viewport.classList.add("is-connecting");
        const a = (() => {
          const p = portWorld(n, "out");
          return { x: p.x * state.cam.z + state.cam.x, y: p.y * state.cam.z + state.cam.y };
        })();
        const move = (ev) => {
          const rect = els.viewport.getBoundingClientRect();
          draftWire = {
            a,
            b: { x: ev.clientX - rect.left, y: ev.clientY - rect.top },
          };
          drawWires();
        };
        const up = (ev) => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          els.viewport.classList.remove("is-connecting");
          draftWire = null;
          const target = document.elementFromPoint(ev.clientX, ev.clientY);
          const portIn = target?.closest?.(".cv-port.in");
          const nodeEl = portIn?.closest(".cv-node") || target?.closest?.(".cv-node");
          if (nodeEl && nodeEl.dataset.id !== connectFrom) {
            const toId = nodeEl.dataset.id;
            const toNode = state.nodes.find((x) => x.id === toId);
            if (toNode && jobDef(toNode.type).hasIn) {
              const exists = state.edges.some((ed) => ed.from === connectFrom && ed.to === toId);
              if (!exists) {
                pushUndo();
                let rel = "related";
                if (ev.shiftKey) rel = "contests";
                else if (ev.altKey) rel = "supports";
                state.edges.push({ id: uid("e"), from: connectFrom, to: toId, rel });
                save();
              }
            }
          }
          connectFrom = null;
          drawWires();
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      });
    });
  }

  function addNode(type, x, y, data = {}, opts = {}) {
    if (!opts.silent) pushUndo();
    const prefer = privateLocal
      ? (models.find((m) => m.on_node)?.id || models[0]?.id || "")
      : (models.find((m) => m.on_node)?.id || models[0]?.id || "");
    const scriptDefaults = {};
    let typeNorm = type;
    if (type === "script_py") { typeNorm = "script"; scriptDefaults.lang = "python"; }
    if (type === "script_c") { typeNorm = "script"; scriptDefaults.lang = "c"; }
    if (typeNorm === "script") {
      const lang = normalizeLang(data.lang || scriptDefaults.lang || "python");
      scriptDefaults.lang = lang;
      scriptDefaults.source = data.source != null ? data.source : defaultSourceFor(lang);
      scriptDefaults.route = data.route || "local";
    }
    const n = {
      id: uid("n"),
      type: typeNorm,
      x,
      y,
      data: {
        text: "",
        model: prefer,
        temp: 0.55,
        output: "",
        image: "",
        explain: "",
        metrics: null,
        ...scriptDefaults,
        ...data,
        ...(typeNorm === "script" ? { lang: scriptDefaults.lang || normalizeLang(data.lang || "python"), source: data.source != null ? data.source : scriptDefaults.source } : {}),
      },
    };
    state.nodes.push(n);
    if (!opts.silent) {
      save();
      mountNode(n, { spawn: true });
      selectNode(n.id);
    }
    return n;
  }

  function seedWelcome() {
    setPrivate(true);
    const tip = addNode("note", 40, 40, {
      text: "Noeti · private AI you can prove\n1 Run this board\n2 Seal the ProofPath\n3 Share the link",
    }, { silent: true });
    const p = addNode("prompt", 320, 160, {
      text: "Summarize these private notes for my eyes only.\n\n• Shipping Canvas as a spatial AI workflow product\n• Local compute should arm itself with zero setup\n• Seal must produce a shareable proof link\n\nKeep it to 4 short bullets. Mark anything uncertain.",
      route: "private",
    }, { silent: true });
    const m = addNode("model", 700, 160, {
      text: "Private on-node summary. No network. Short bullets only.",
      route: "private",
    }, { silent: true });
    const o = addNode("output", 1080, 160, { route: "private" }, { silent: true });
    state.edges = [
      { id: uid("e"), from: p.id, to: m.id, rel: "related" },
      { id: uid("e"), from: m.id, to: o.id, rel: "related" },
    ];
    state.regions = [{
      id: uid("r"),
      x: 280,
      y: 100,
      w: 1080,
      h: 320,
      route: "private",
      label: "Private · on-node",
    }];
    void tip;
    state.cam = { x: 20, y: 10, z: 0.82 };
    save();
    renderNodes();
    drawRegions();
    setLoopStep("run");
    showLoopTray("Private board ready · Run → Seal → Share");
  }

  function seedWhereDemo() {
    setPrivate(false);
    const tip = addNode("note", 36, 24, {
      text: "Where sample · newsroom brief\nDrag zones · pair a PC · Run on This PC\nSeal when the trail matters",
    }, { silent: true });
    const p = addNode("prompt", 120, 160, {
      text: "Draft 4 bullets for counsel: what stays on our paired PC vs what may touch cloud.\n\nMatter: confidential source notes + public wire claims.",
      route: "local",
    }, { silent: true });
    const m = addNode("model", 480, 160, {
      text: "Local model · short bullets · no exfiltration of source notes.",
      route: "local",
    }, { silent: true });
    const check = addNode("checker", 820, 160, {
      text: "Flag anything that should not leave This PC.",
      route: "private",
    }, { silent: true });
    const o = addNode("output", 1120, 160, { route: "private" }, { silent: true });
    state.edges = [
      { id: uid("e"), from: p.id, to: m.id, rel: "related" },
      { id: uid("e"), from: m.id, to: check.id, rel: "related" },
      { id: uid("e"), from: check.id, to: o.id, rel: "related" },
    ];
    state.regions = [
      { id: uid("r"), x: 80, y: 100, w: 560, h: 300, route: "local", label: "This PC · paired" },
      { id: uid("r"), x: 760, y: 100, w: 520, h: 300, route: "private", label: "Private · review" },
      { id: uid("r"), x: 80, y: 440, w: 320, h: 140, route: "cloud", label: "Cloud · only if asked" },
    ];
    void tip;
    state.cam = { x: 10, y: 0, z: 0.78 };
    save();
    renderNodes();
    drawRegions();
    setLoopStep("run");
    showLoopTray("Where sample · Run on This PC → Seal ProofPath");
  }

  function loadSampleWhere() {
    try { localStorage.removeItem("noeti_canvas_loop_off"); } catch (_) {}
    state.nodes = [];
    state.edges = [];
    state.regions = [];
    seedWhereDemo();
    try {
      const u = new URL(location.href);
      u.searchParams.set("sample", "where");
      history.replaceState({}, "", u);
    } catch (_) {}
  }

  let lastSeal = null;
  let loopStep = "generate";

  function showLoopTray(lead) {
    const tray = document.getElementById("cvLoop");
    if (!tray) return;
    try {
      if (localStorage.getItem("noeti_canvas_loop_off") === "1") {
        tray.hidden = true;
        return;
      }
    } catch (_) {}
    tray.hidden = false;
    const el = document.getElementById("cvLoopLead");
    if (el && lead) el.textContent = lead;
    syncLoopSteps();
  }

  function hideLoopTray(persist) {
    const tray = document.getElementById("cvLoop");
    if (tray) tray.hidden = true;
    if (persist) {
      try { localStorage.setItem("noeti_canvas_loop_off", "1"); } catch (_) {}
    }
  }

  function setLoopStep(step) {
    loopStep = step || loopStep;
    syncLoopSteps();
  }

  function syncLoopSteps() {
    const order = ["generate", "run", "seal", "share"];
    const idx = order.indexOf(loopStep);
    document.querySelectorAll(".cv-loop-step").forEach((btn) => {
      const i = order.indexOf(btn.dataset.loop);
      btn.classList.toggle("is-on", btn.dataset.loop === loopStep);
      btn.classList.toggle("is-done", i >= 0 && i < idx);
    });
  }

  function proofShareUrl(runId, sharePath) {
    if (sharePath && /^https?:\/\//i.test(sharePath)) return sharePath;
    if (sharePath && sharePath.startsWith("/")) return `${window.location.origin}${sharePath}`;
    if (!runId) return "";
    return `${window.location.origin}/proof/${encodeURIComponent(runId)}`;
  }

  function showShareToast(data) {
    const toast = document.getElementById("shareToast");
    if (!toast || !data) return;
    const runId = data.run_id || data.proofpath?.run_id || "";
    const url = proofShareUrl(runId, data.share_path || data.proofpath?.share_path);
    const title = document.getElementById("shareToastTitle");
    const input = document.getElementById("shareToastUrl");
    const open = document.getElementById("shareToastOpen");
    if (title) title.textContent = runId ? `Sealed · ${runId}` : "Shareable link ready";
    if (input) input.value = url;
    if (open) open.href = url || "#";
    openDrop(toast);
  }

  function hideShareToast() {
    const toast = document.getElementById("shareToast");
    if (toast) closeDrop(toast, 180);
  }

  /** Drop-window open/close — backdrop + card motion without killing [hidden] permanently mid-anim */
  function openDrop(el) {
    if (!el) return;
    if (el._dropT) { clearTimeout(el._dropT); el._dropT = 0; }
    el.hidden = false;
    el.classList.remove("is-closing");
    // double rAF so CSS transitions run after display flips
    requestAnimationFrame(() => {
      requestAnimationFrame(() => el.classList.add("is-open"));
    });
  }

  function closeDrop(el, ms = 200) {
    if (!el) return;
    el.classList.remove("is-open");
    el.classList.add("is-closing");
    if (el._dropT) clearTimeout(el._dropT);
    el._dropT = setTimeout(() => {
      el.hidden = true;
      el.classList.remove("is-closing");
      el._dropT = 0;
    }, ms);
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  function hydrateCanvasFromPacket(packet) {
    const canvas = packet?.canvas;
    if (!canvas?.nodes?.length) {
      // Fallback: reconstruct a readable board from proof fields
      pushUndo();
      state = { nodes: [], edges: [], regions: [], cam: { x: 40, y: 40, z: 0.85 } };
      selectedId = null;
      const p = addNode("prompt", 80, 80, { text: packet.query || "Sealed run" }, { silent: true });
      const m = addNode("model", 440, 80, {
        model: packet.worker_model || "",
        output: packet.summary?.headline || packet.note || "",
        route: packet.routing === "private_local" ? "private" : "local",
      }, { silent: true });
      const o = addNode("output", 800, 80, {
        output: (packet.claims_raw || packet.claims || []).map((c) => (typeof c === "string" ? c : c.text || c.claim || "")).filter(Boolean).join("\n")
          || packet.note
          || "ProofPath replay",
      }, { silent: true });
      state.edges = [
        { id: uid("e"), from: p.id, to: m.id, rel: "related" },
        { id: uid("e"), from: m.id, to: o.id, rel: "related" },
      ];
    } else {
      pushUndo();
      state = {
        nodes: JSON.parse(JSON.stringify(canvas.nodes)),
        edges: JSON.parse(JSON.stringify(canvas.edges || [])),
        regions: JSON.parse(JSON.stringify(canvas.regions || [])),
        cam: canvas.cam || { x: 40, y: 40, z: 0.85 },
      };
      selectedId = null;
      if (typeof canvas.private === "boolean") setPrivate(canvas.private);
      else if (packet.routing === "private_local") setPrivate(true);
    }
    save();
    renderNodes();
    drawRegions();
    applyCam();
    fitView();
    renderInspector();
    lastSeal = { run_id: packet.run_id, share_path: packet.share_path, proofpath: packet };
    setLoopStep("share");
    showLoopTray(`Replaying sealed proof · ${packet.run_id || "ProofPath"}`);
  }

  async function loadProofFromUrl() {
    try {
      const q = new URLSearchParams(window.location.search);
      const proof = q.get("proof") || q.get("run") || "";
      if (!proof) return false;
      setStatus("Loading sealed proof…");
      const res = await fetch(`/api/proofpath/runs/${encodeURIComponent(proof)}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !data.packet) throw new Error(data.message || "Proof not found");
      hydrateCanvasFromPacket(data.packet);
      setStatus(`Opened proof · ${proof}`);
      setTimeout(() => setStatus("", false), 2200);
      if (window.history?.replaceState) {
        window.history.replaceState({}, "", window.location.pathname);
      }
      return true;
    } catch (err) {
      setStatus(err.message || "Could not open proof");
      setTimeout(() => setStatus("", false), 2400);
      return false;
    }
  }

  function detectScriptLang(source, preferred) {
    if (preferred && preferred !== "auto") return preferred;
    const s = String(source || "");
    const fence = s.match(/^```(\w+)/);
    if (fence) {
      const id = fence[1].toLowerCase();
      const map = { js: "javascript", ts: "javascript", py: "python", sh: "bash", shell: "bash", rb: "ruby", rs: "rust", cpp: "cpp", "c++": "cpp" };
      return map[id] || id;
    }
    if (/^\s*#!/.test(s) && /python/.test(s)) return "python";
    if (/^\s*#!/.test(s) && /(bash|sh)/.test(s)) return "bash";
    if (/\bdef\s+\w+\s*\(|\bprint\s*\(/.test(s)) return "python";
    if (/\bfunction\b|\bconst\b|\blet\b|\bconsole\.log/.test(s)) return "javascript";
    if (/\bfn\s+main\b|\blet\s+mut\b/.test(s)) return "rust";
    if (/\bpackage\s+main\b|\bfunc\s+main\b/.test(s)) return "go";
    if (/\bpublic\s+class\b|\bSystem\.out/.test(s)) return "java";
    if (/^\s*#include\s*<.*>/.test(s) && /std::/.test(s)) return "cpp";
    if (/^\s*#include\s*<.*>/.test(s)) return "c";
    if (/\bend\s*$/m.test(s) && /\bputs\b|\bdef\s+\w+/.test(s)) return "ruby";
    if (/\$[a-zA-Z_]/.test(s) && /;\s*$/m.test(s)) return "php";
    if (/\blocal\s+\w+\s*=/.test(s)) return "lua";
    if (/\b<-|\blibrary\(/.test(s)) return "r";
    return "python";
  }

  function stripCodeFence(source) {
    const s = String(source || "").trim();
    const m = s.match(/^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n?```$/);
    return m ? m[1].trim() : s;
  }

  function openPasteModal(prefill) {
    const modal = document.getElementById("pasteModal");
    if (!modal) return;
    openDrop(modal);
    const ta = document.getElementById("pasteSource");
    if (ta) {
      ta.value = prefill || "";
      ta.focus();
    }
  }

  function closePasteModal() {
    closeDrop(document.getElementById("pasteModal"));
  }

  function snapPastedScript() {
    const raw = document.getElementById("pasteSource")?.value || "";
    const preferred = document.getElementById("pasteLang")?.value || "auto";
    const source = stripCodeFence(raw);
    if (!source.trim()) {
      setStatus("Paste some code first");
      setTimeout(() => setStatus("", false), 1600);
      return;
    }
    const lang = detectScriptLang(source, preferred);
    const cam = state.cam || { x: 0, y: 0, z: 1 };
    const x = (-cam.x + 220) / (cam.z || 1);
    const y = (-cam.y + 180) / (cam.z || 1);
    const n = addNode("script", x, y, {
      lang,
      source,
      text: `Pasted ${lang} script`,
      route: privateLocal ? "private" : "local",
    });
    closePasteModal();
    selectNode(n.id);
    setStatus(`Snapped ${lang} script · edit in Inspect`);
    setTimeout(() => setStatus("", false), 2000);
  }

  let phonePairTargetId = null;
  let phonePollTimer = 0;
  const phonePcs = new Map(); // nodeId -> RTCPeerConnection
  const phoneLiveStreams = new Map(); // nodeId -> MediaStream
  const PHONE_ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }] };

  function stopPhonePoll() {
    if (phonePollTimer) {
      clearInterval(phonePollTimer);
      phonePollTimer = 0;
    }
  }

  function closePhonePairModal() {
    closeDrop(document.getElementById("phonePairModal"));
  }

  function freezePhoneFrame(nodeId) {
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const liveImg = els.world?.querySelector(`.cv-node[data-id="${nodeId}"] [data-phone-live]`);
    if (liveImg?.src && liveImg.src.startsWith("data:image")) {
      node.data.image = liveImg.src;
    }
    if (!node.data.image) {
      setStatus("No live frame yet — tap Go live on phone");
      setTimeout(() => setStatus("", false), 1800);
      return;
    }
    node.data.route = "phone";
    node.data.output = `PHONE FREEZE · ${node.data.device || "Phone"}\nStill from live video · ready for Vision / Seal`;
    save();
    updatePhoneLiveDom(nodeId, node.data.image, true);
    writeOut(node, node.data.output);
    setStatus("Frozen live frame");
    setTimeout(() => setStatus("", false), 1600);
  }

  function phoneToVision(nodeId) {
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    freezePhoneFrame(nodeId);
    const img = node.data.image;
    if (!img) return;
    let vision = state.nodes.find((n) => n.type === "vision" && state.edges.some((e) => e.from === nodeId && e.to === n.id));
    if (!vision) {
      vision = addNode("vision", node.x + 340, node.y, {
        text: "Describe the phone frame. Prefer UNKNOWN when unsure.",
        image: img,
        route: "phone",
        phone: node.data.device || "Phone",
      });
      state.edges.push({ id: uid("e"), from: nodeId, to: vision.id, rel: "related" });
    } else {
      vision.data.image = img;
      vision.data.route = "phone";
    }
    save();
    renderNodes();
    selectNode(vision.id);
    setStatus("Vision block ready · press Run");
    setTimeout(() => setStatus("", false), 1800);
  }

  function updatePhoneLiveDom(nodeId, image, live) {
    const root = els.world?.querySelector(`.cv-node[data-id="${nodeId}"]`);
    if (!root) return;
    const img = root.querySelector("[data-phone-live]");
    const chip = root.querySelector(".cv-chip");
    const meta = root.querySelector(".cv-phone-meta");
    if (img && image) {
      img.src = image;
      img.classList.add("is-on");
    }
    if (chip && live) {
      chip.textContent = "LIVE";
      chip.classList.add("is-live");
    }
    if (meta && live) {
      const node = state.nodes.find((n) => n.id === nodeId);
      meta.textContent = `${node?.data?.device || "Phone"} · live video on board`;
    }
    root.querySelectorAll("[data-phone-snap], [data-phone-vision]").forEach((b) => {
      b.hidden = false;
    });
  }

  async function handlePhoneCommands(node, commands) {
    if (!commands?.length) return;
    for (const c of commands) {
      const cmd = c.command;
      if (cmd === "run") {
        setStatus("Phone remote · Run");
        runGraph();
      } else if (cmd === "seal") {
        setStatus("Phone remote · Seal");
        sealBoard({ share: true }).catch(() => {});
      } else if (cmd === "freeze") {
        freezePhoneFrame(node.id);
      } else if (cmd === "vision") {
        phoneToVision(node.id);
        setTimeout(() => runGraph({ fromSelected: true }), 400);
      } else if (cmd === "hangup") {
        node.data.live = false;
        save();
        renderNodes();
      }
    }
  }

  function hangupPhoneLive(nodeId, { notify = true } = {}) {
    const pc = phonePcs.get(nodeId);
    if (pc) {
      try { pc.close(); } catch (_) {}
      phonePcs.delete(nodeId);
    }
    phoneLiveStreams.delete(nodeId);
    const node = state.nodes.find((n) => n.id === nodeId);
    if (node) {
      node.data.live = false;
      if (notify && node.data.pair_session) {
        fetch("/api/canvas/phone/signal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            session_id: node.data.pair_session,
            from_role: "desktop",
            type: "hangup",
          }),
        }).catch(() => {});
      }
      save();
      renderNodes();
    }
  }

  async function desktopPostSignal(sessionId, type, payload) {
    const res = await fetch("/api/canvas/phone/signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        session_id: sessionId,
        from_role: "desktop",
        type,
        payload: payload || null,
      }),
    });
    return res.json().catch(() => ({}));
  }

  async function ensureDesktopPc(node) {
    const id = node.id;
    let pc = phonePcs.get(id);
    if (pc) return pc;
    pc = new RTCPeerConnection(PHONE_ICE);
    phonePcs.set(id, pc);
    pc.ontrack = (ev) => {
      const stream = ev.streams?.[0] || new MediaStream([ev.track]);
      phoneLiveStreams.set(id, stream);
      node.data.live = true;
      node.data.pair_live = true;
      node.data.route = "phone";
      node.data.route_placeholder = false;
      node.data.last_where = `Phone · live · ${node.data.device || "handset"}`;
      node.data.output = `LIVE VIDEO · ${node.data.device || "Phone"}\nStreaming into Canvas · freeze a frame for Vision / Seal`;
      save();
      renderNodes();
      selectNode(id);
      const st = document.getElementById("phonePairStatus");
      if (st) st.textContent = `LIVE · ${node.data.device || "Phone"}`;
      setStatus("Live phone video on board");
      setTimeout(() => setStatus("", false), 2200);
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate && node.data.pair_session) {
        desktopPostSignal(node.data.pair_session, "ice", ev.candidate.toJSON?.() || ev.candidate);
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        const n = state.nodes.find((x) => x.id === id);
        if (n) n.data.live = false;
        renderNodes();
      }
    };
    return pc;
  }

  async function handleDesktopSignals(node, signals) {
    if (!signals?.length) return;
    const pc = await ensureDesktopPc(node);
    for (const s of signals) {
      if (s.type === "ready" && s.payload?.device) {
        node.data.device = s.payload.device;
        node.data.pair_live = true;
        const st = document.getElementById("phonePairStatus");
        if (st) st.textContent = `Phone ready · ${s.payload.device} · tap Go live on phone`;
      } else if (s.type === "offer" && s.payload) {
        try {
          await pc.setRemoteDescription(s.payload);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await desktopPostSignal(node.data.pair_session, "answer", {
            type: answer.type,
            sdp: answer.sdp,
          });
          const st = document.getElementById("phonePairStatus");
          if (st) st.textContent = "Accepting live video…";
        } catch (err) {
          setStatus(err.message || "Live connect failed");
        }
      } else if (s.type === "ice" && s.payload) {
        try { await pc.addIceCandidate(s.payload); } catch (_) {}
      } else if (s.type === "hangup") {
        hangupPhoneLive(node.id, { notify: false });
      }
    }
  }

  function applyPhoneCapture(node, item) {
    if (!node || !item) return;
    if (item.image) node.data.image = item.image;
    const device = item.device || node.data.device || "Phone";
    node.data.device = device;
    node.data.phone = device;
    node.data.machine = device;
    node.data.route = "phone";
    node.data.pair_live = true;
    node.data.route_placeholder = false;
    node.data.last_where = `Phone · ${device}`;
    const note = (item.text || "").trim();
    node.data.output = [
      `PHONE CAPTURE · ${device}`,
      note || "Still from paired phone",
      item.image ? "Image attached · wire to Vision or Run" : "Note only · no image",
    ].join("\n");
    node.data.latency_ms = 12;
    state.edges.filter((e) => e.from === node.id).forEach((e) => {
      const dest = state.nodes.find((x) => x.id === e.to);
      if (dest && (dest.type === "vision" || dest.type === "model") && item.image) {
        dest.data.image = item.image;
        dest.data.route = "phone";
        dest.data.phone = device;
      }
    });
  }

  async function pollPhoneSession(nodeId) {
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node?.data?.pair_session) return;
    try {
      const [statusRes, sigRes] = await Promise.all([
        fetch(`/api/canvas/phone/session/${encodeURIComponent(node.data.pair_session)}`, {
          credentials: "same-origin",
          cache: "no-store",
        }),
        fetch(`/api/canvas/phone/signal/${encodeURIComponent(node.data.pair_session)}?role=desktop`, {
          credentials: "same-origin",
          cache: "no-store",
        }),
      ]);
      const data = await statusRes.json().catch(() => ({}));
      const sigData = await sigRes.json().catch(() => ({}));
      if (statusRes.ok && data.ok) {
        const st = document.getElementById("phonePairStatus");
        if (data.device) {
          node.data.device = data.device;
          node.data.pair_live = true;
        }
        if (data.live_frame) {
          const wasLive = node.data.live;
          node.data.image = data.live_frame;
          node.data.live = true;
          node.data.pair_live = true;
          node.data.route = "phone";
          node.data.route_placeholder = false;
          node.data.last_where = `Phone · live · ${node.data.device || "handset"}`;
          if (!wasLive) {
            node.data.output = `LIVE VIDEO · ${node.data.device || "Phone"}\nStreaming into Canvas · Freeze / Vision / Seal`;
            save();
            const root = els.world?.querySelector(`.cv-node[data-id="${nodeId}"]`);
            if (!root?.querySelector("[data-phone-live].is-on")) renderNodes();
            if (st) st.textContent = `LIVE · ${data.device || node.data.device || "Phone"}`;
            setStatus("Live phone video on board");
            setTimeout(() => setStatus("", false), 1800);
          }
          updatePhoneLiveDom(nodeId, data.live_frame, true);
          const out = els.world?.querySelector(`.cv-node[data-id="${nodeId}"] [data-out]`);
          if (out && !wasLive) out.textContent = node.data.output;
        } else if (st && !node.data.live) {
          st.textContent = data.device
            ? `Phone linked · ${data.device} · tap Go live on phone`
            : "Waiting for phone… then tap Go live";
        }
        const items = data.items || [];
        if (items.length) {
          const ids = [];
          items.forEach((item) => {
            applyPhoneCapture(node, item);
            ids.push(item.id);
          });
          await fetch("/api/canvas/phone/ack", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ session_id: node.data.pair_session, item_ids: ids }),
          }).catch(() => {});
          save();
          updatePhoneLiveDom(nodeId, node.data.image, !!node.data.live);
          writeOut(node, node.data.output || "");
          if (st) st.textContent = `Still received · ${node.data.device || "Phone"}`;
        }
        await handlePhoneCommands(node, data.commands || []);
      }
      if (sigRes.ok && sigData.ok) {
        await handleDesktopSignals(node, sigData.signals || []);
      }
    } catch (_) {}
  }

  async function openPhonePair(nodeId) {
    let node = state.nodes.find((n) => n.id === nodeId);
    if (!node) {
      const cam = state.cam || { x: 0, y: 0, z: 1 };
      node = addNode("phone", (-cam.x + 200) / (cam.z || 1), (-cam.y + 160) / (cam.z || 1), {
        route: "phone",
        text: "Paired phone camera",
      });
      nodeId = node.id;
    }
    phonePairTargetId = nodeId;
    hangupPhoneLive(nodeId, { notify: false });
    setStatus("Creating phone link…");
    try {
      const res = await fetch("/api/canvas/phone/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ label: "Canvas phone live" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || "Could not create pair link");
      node = state.nodes.find((n) => n.id === nodeId);
      node.data.pair_session = data.session_id;
      node.data.pair_token = data.token;
      node.data.pair_url = data.pair_url;
      node.data.pair_live = false;
      node.data.live = false;
      node.data.route = "phone";
      save();
      const modal = document.getElementById("phonePairModal");
      const urlInput = document.getElementById("phonePairUrl");
      const open = document.getElementById("btnPhoneOpen");
      const qr = document.getElementById("phoneQr");
      const st = document.getElementById("phonePairStatus");
      const title = document.getElementById("phonePairTitle");
      const lead = document.querySelector(".cv-phone-pair-lead");
      if (title) title.textContent = "Connect phone · go live";
      if (lead) lead.innerHTML = "Scan or open the link. On the phone tap <strong>Go live → Canvas</strong> — video appears here as <strong>Where · Phone</strong>.";
      if (urlInput) urlInput.value = data.pair_url;
      if (open) open.href = data.pair_url;
      if (qr) {
        qr.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=8&data=${encodeURIComponent(data.pair_url)}`;
      }
      if (st) st.textContent = "Waiting for phone… then tap Go live on the phone";
      if (modal) openDrop(modal);
      renderNodes();
      selectNode(nodeId);
      stopPhonePoll();
      phonePollTimer = setInterval(() => pollPhoneSession(nodeId), 350);
      pollPhoneSession(nodeId);
      setStatus("Open link on phone · then Go live");
      setTimeout(() => setStatus("", false), 2400);
    } catch (err) {
      setStatus(err.message || "Phone pair failed");
      setTimeout(() => setStatus("", false), 2400);
    }
  }

  let devicePairPoll = 0;
  let devicePairSession = null;

  function stopDevicePairPoll() {
    if (devicePairPoll) {
      clearInterval(devicePairPoll);
      devicePairPoll = 0;
    }
  }

  function closeDevicePairModal() {
    closeDrop(document.getElementById("devicePairModal"));
  }

  async function pollDevicePairSession() {
    if (!devicePairSession?.session_id) return;
    try {
      const q = new URLSearchParams({
        token: devicePairSession.token || "",
      });
      const res = await fetch(
        `/api/canvas/device/session/${encodeURIComponent(devicePairSession.session_id)}?${q}`,
        { credentials: "same-origin", cache: "no-store" }
      );
      const data = await res.json().catch(() => ({}));
      const st = document.getElementById("devicePairStatus");
      if (res.ok && data.ok) {
        if (data.device_id) {
          liveDevices.set(data.device_id, {
            device_id: data.device_id,
            session_id: data.session_id,
            label: data.label || data.hostname || data.device_id,
            online: !!data.online,
            models: data.models || [],
            ollama: !!data.ollama,
            hostname: data.hostname || "",
            platform: data.platform || "",
            pending_jobs: data.pending_jobs || 0,
          });
          refreshDevicePicker();
          renderDeviceLiveList();
        }
        if (st) {
          st.textContent = data.online
            ? `Connected · ${data.hostname || data.label || data.device_id} · Ollama ${data.ollama ? "ready" : "not detected"}`
            : "Waiting for agent on that PC…";
        }
        if (data.online) {
          setStatus(`PC online · ${data.label || data.hostname || data.device_id}`);
          setTimeout(() => setStatus("", false), 2000);
        }
      }
    } catch (_) {}
    refreshLiveDevices();
  }

  async function openDevicePair() {
    setStatus("Creating PC link…");
    try {
      const res = await fetch("/api/canvas/device/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ label: "My PC" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || "Could not create PC link");
      const origin = location.origin;
      const pairUrl = data.pair_url || `${origin}${data.pair_path || `/device?s=${data.session_id}&t=${data.token}`}`;
      const agentCmd = data.agent_cmd
        || `curl -sSL ${origin}/device-agent.sh | bash -s -- ${data.session_id} ${data.token}`;
      devicePairSession = {
        session_id: data.session_id,
        token: data.token,
        device_id: data.device_id,
        pair_url: pairUrl,
      };
      if (data.device_id) {
        liveDevices.set(data.device_id, {
          device_id: data.device_id,
          session_id: data.session_id,
          label: data.label || "My PC",
          online: false,
          models: [],
          ollama: false,
          hostname: "",
          platform: "",
          pending_jobs: 0,
        });
      }
      const modal = document.getElementById("devicePairModal");
      const urlInput = document.getElementById("devicePairUrl");
      const open = document.getElementById("btnDeviceOpen");
      const qr = document.getElementById("deviceQr");
      const st = document.getElementById("devicePairStatus");
      const cmd = document.getElementById("deviceAgentCmd");
      if (urlInput) urlInput.value = pairUrl;
      if (open) open.href = pairUrl;
      if (cmd) cmd.value = agentCmd;
      if (qr) {
        qr.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=8&data=${encodeURIComponent(pairUrl)}`;
      }
      if (st) st.textContent = "Run the command on that PC (needs Ollama)";
      if (modal) openDrop(modal);
      refreshDevicePicker();
      renderDeviceLiveList();
      stopDevicePairPoll();
      devicePairPoll = setInterval(pollDevicePairSession, 2000);
      pollDevicePairSession();
      setStatus("Copy command · run on your PC");
      setTimeout(() => setStatus("", false), 2400);
    } catch (err) {
      setStatus(err.message || "PC pair failed");
      setTimeout(() => setStatus("", false), 2400);
    }
  }

  function openGenerateModal(prefill = "") {
    const modal = document.getElementById("genModal");
    if (!modal) return;
    openDrop(modal);
    const ta = document.getElementById("genBrief");
    if (ta) {
      if (prefill) ta.value = prefill;
      ta.focus();
    }
    const msg = document.getElementById("genMsg");
    if (msg) { msg.hidden = true; msg.textContent = ""; }
  }

  function closeGenerateModal() {
    closeDrop(document.getElementById("genModal"));
  }

  function applyGeneratedGraph(graph) {
    if (!graph?.nodes?.length) throw new Error("Empty workflow");
    pushUndo();
    state = { nodes: [], edges: [], regions: [], cam: graph.cam || { x: 40, y: 20, z: 0.62 } };
    selectedId = null;
    const idMap = {};
    for (const raw of graph.nodes) {
      const n = addNode(raw.type, raw.x, raw.y, { ...(raw.data || {}), route: raw.data?.route || "local" }, { silent: true });
      // addNode may remap script_py → script and mint a new id
      idMap[raw.id] = n.id;
    }
    state.edges = (graph.edges || []).map((e) => ({
      id: uid("e"),
      from: idMap[e.from] || e.from,
      to: idMap[e.to] || e.to,
      rel: e.rel || "related",
    })).filter((e) => state.nodes.some((n) => n.id === e.from) && state.nodes.some((n) => n.id === e.to));
    save();
    renderNodes();
    drawRegions();
    applyCam();
    fitView();
    renderInspector();
    setLoopStep("run");
    showLoopTray((graph.title || "Workflow ready") + " · Run → Seal → Share");
  }

  async function generateWorkflowFromBrief() {
    const ta = document.getElementById("genBrief");
    const msg = document.getElementById("genMsg");
    const go = document.getElementById("btnGenGo");
    const brief = (ta?.value || "").trim();
    if (!brief) {
      if (msg) { msg.hidden = false; msg.textContent = "Describe the workflow first."; }
      return;
    }
    if (go) go.disabled = true;
    if (msg) { msg.hidden = false; msg.textContent = "Generating board…"; }
    setStatus("Generating workflow…");
    try {
      const res = await fetch("/api/canvas/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          brief,
          use_model: !!document.getElementById("genUseModel")?.checked,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      applyGeneratedGraph(data);
      closeGenerateModal();
      setStatus(data.note || `Generated · ${data.title || "workflow"}`);
      setTimeout(() => setStatus("", false), 2200);
    } catch (err) {
      if (msg) { msg.hidden = false; msg.textContent = err.message || "Generate failed"; }
      setStatus(err.message || "Generate failed");
    } finally {
      if (go) go.disabled = false;
    }
  }

  /* -------- graph run -------- */
  function incoming(nodeId) {
    return state.edges.filter((e) => e.to === nodeId).map((e) => e.from);
  }

  function topoOrder() {
    const indeg = Object.fromEntries(state.nodes.map((n) => [n.id, 0]));
    for (const e of state.edges) {
      if (indeg[e.to] != null) indeg[e.to] += 1;
    }
    const q = state.nodes.filter((n) => indeg[n.id] === 0).map((n) => n.id);
    const out = [];
    while (q.length) {
      const id = q.shift();
      out.push(id);
      for (const e of state.edges.filter((x) => x.from === id)) {
        indeg[e.to] -= 1;
        if (indeg[e.to] === 0) q.push(e.to);
      }
    }
    const skipped = state.nodes.filter((n) => !out.includes(n.id)).map((n) => n.id);
    return { order: out, skipped };
  }

  function gatherInput(nodeId) {
    const parts = [];
    for (const fromId of incoming(nodeId)) {
      const n = state.nodes.find((x) => x.id === fromId);
      if (!n) continue;
      const t = (n.data.output || n.data.text || "").trim();
      if (t) parts.push(t);
    }
    return parts.join("\n\n");
  }

  function setStatus(text, show = true) {
    els.runStatus.hidden = !show;
    els.runStatus.textContent = text || "";
  }

  function markNode(id, cls, on) {
    const el = els.world.querySelector(`.cv-node[data-id="${id}"]`);
    if (!el) return;
    el.classList.toggle(cls, on);
  }

  function writeOut(node, text) {
    node.data.output = text;
    const el = els.world.querySelector(`.cv-node[data-id="${node.id}"] [data-out]`);
    if (el) el.textContent = text;
    const whereEl = els.world.querySelector(`.cv-node[data-id="${node.id}"] [data-where]`);
    if (whereEl) {
      const where = node.data.last_where || routeDisplay(node.data.route || resolveNodeRoute(node), node.data.machine);
      whereEl.textContent = where ? `Ran · ${where}` : "";
      whereEl.hidden = !where;
    }
    const explainEl = els.world.querySelector(`.cv-node[data-id="${node.id}"] [data-explain]`);
    if (explainEl) {
      const ex = (node.data.explain || "").trim();
      explainEl.textContent = ex ? `Why · ${ex}` : "";
      explainEl.hidden = !ex;
    }
  }

  async function callScript(node, upstream) {
    abort = new AbortController();
    const lang = normalizeLang(node.data.lang || (node.type === "script_c" ? "c" : "python"));
    const route = resolveNodeRoute(node);
    const machine = node.data.machine || "";
    // Prefer paired PC — scripts run on your machine, not the hub
    let deviceId = "";
    if (route === "machine" && String(machine).startsWith("pc-")) deviceId = machine;
    else if (route === "local" || route === "private" || !route) {
      const online = [...liveDevices.values()].find((d) => d.online);
      if (online) deviceId = online.device_id;
    }
    const res = await fetch("/api/canvas/script", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      signal: abort.signal,
      body: JSON.stringify({
        lang,
        source: node.data.source || defaultSourceFor(lang),
        input: upstream || "",
        where: route === "cloud" ? "server" : "pc",
        device_id: deviceId || undefined,
        prefer_device: route !== "cloud",
        meta: { node_id: node.id, type: node.type, lang, route },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.need_device) {
      throw new Error(data.message || "Connect your PC (Canvas → PC) so scripts run locally");
    }
    if (!res.ok || !data.ok) throw new Error(data.message || data.explain || `Script HTTP ${res.status}`);
    node.data.last_where = data.where || "PC";
    return data;
  }

  function applyModelResult(node, result) {
    const reply = typeof result === "string" ? result : (result?.reply || "");
    if (result && typeof result === "object") {
      node.data.last_where = result.where || routeDisplay(result.route, result.machine);
      node.data.last_route = result.route || null;
      if (result.placeholder) node.data.route_placeholder = true;
      else if (result.route === "machine" && String(result.machine || "").startsWith("pc-")) {
        node.data.route_placeholder = false;
      }
    }
    writeOut(node, reply);
  }


  function gatherUpstream(node) {
    const ins = state.edges.filter((e) => e.to === node.id).map((e) => state.nodes.find((n) => n.id === e.from)).filter(Boolean);
    return ins.map((n) => (n.data.output || n.data.text || "").trim()).filter(Boolean).join("\n\n");
  }

  async function callModel({ messages, model, temperature, route, machine }) {
    abort = new AbortController();
    const r = route || (privateLocal ? "local" : null);
    let msgs = messages || [];
    // Second Brain: inject cached FS map + allowlisted file bodies
    try {
      const brain = window.NoetiBrain;
      if (brain?.getStatus?.().enabled) {
        const userText = [...msgs].reverse().find((m) => m.role === "user")?.content;
        const ut = typeof userText === "string" ? userText : "";
        const block = await brain.buildContextBlock(ut);
        if (block) {
          if (msgs[0]?.role === "system") {
            msgs = [{ role: "system", content: `${msgs[0].content}\n\n---\n${block}` }, ...msgs.slice(1)];
          } else {
            const sys = brain.getStatus().codingHelper
              ? `${brain.codingSystemPrompt()}\n\n---\n${block}`
              : block;
            msgs = [{ role: "system", content: sys }, ...msgs];
          }
        }
      }
    } catch (_) {}
    // Live paired PC (device_id like pc-…) — run on that machine's Ollama
    const liveDevice = r === "machine" && machine && String(machine).startsWith("pc-");
    if (liveDevice) {
      const res = await fetch("/api/canvas/device/infer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        signal: abort.signal,
        body: JSON.stringify({
          device_id: machine,
          messages: msgs,
          model: model || undefined,
          temperature: temperature ?? 0.55,
          timeout: 120,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || `Device failed (${res.status})`);
      return {
        reply: data.reply || "",
        where: data.where || routeDisplay(r, machine),
        route: r,
        machine: machine || null,
        model: data.model || model || "",
        placeholder: false,
        latency_ms: data.latency_ms,
      };
    }
    const execRoute = (r === "machine" || r === "phone" || r === "private") ? "local" : r;
    let useModel = model;
    let preferLocal = !!privateLocal || execRoute === "local" || r === "private";
    if (r) {
      useModel = pickModelForRoute(r, model) || model;
      preferLocal = execRoute === "local" || r === "private" || !!privateLocal;
    }
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      signal: abort.signal,
      body: JSON.stringify({
        messages: msgs.filter((m) => m.role === "user" || m.role === "assistant"),
        model: useModel || undefined,
        temperature: temperature ?? 0.55,
        prefer_local: preferLocal,
        private: preferLocal,
        route: execRoute || undefined,
        machine: machine || undefined,
        system_prompt: (msgs.find((m) => m.role === "system")?.content) || undefined,
        assistant_id: (window.NoetiBrain?.getStatus?.().enabled && window.NoetiBrain.getStatus().codingHelper)
          ? "coding_helper"
          : undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
    return {
      reply: data.reply || data.message || "",
      where: routeDisplay(r, machine),
      route: r,
      machine: machine || null,
      model: data.model || useModel || "",
      placeholder: r === "phone" || (r === "machine" && !liveDevice),
    };
  }

  function calcCheck(text) {
    const nums = (text.match(/-?\d[\d,]*(?:\.\d+)?/g) || []).map((x) => Number(x.replace(/,/g, ""))).filter((n) => !Number.isNaN(n));
    const sum = nums.reduce((a, b) => a + b, 0);
    const lines = [
      `Numbers found: ${nums.length ? nums.join(", ") : "(none)"}`,
      `Sum of extracted numbers: ${sum}`,
      nums.length >= 2
        ? `Calc plane: verify prose totals against these figures before publish.`
        : `Calc plane: few numbers — treat arithmetic claims as review.`,
    ];
    return lines.join("\n");
  }

  function atomizeLocal(text) {
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 12);
    if (!sentences.length) return "No claim-sized sentences found.";
    return sentences.slice(0, 12).map((s, i) => `c${i + 1}: ${s}`).join("\n");
  }

  function gateLocal(text) {
    const contested = /maybe|allegedly|unconfirmed|rumor|might|could be/i.test(text);
    const hasClaims = /c\d+:/.test(text) || text.length > 40;
    if (!hasClaims) return "GATE: review\nReason: empty or thin packet.";
    if (contested) return "GATE: review\nReason: hedging / contested language detected.\nκ̂ elevated — human desk required.";
    return "GATE: ready\nReason: no obvious contest markers.\nExport allowed under non-strict policy.";
  }

  function codeExtract(text) {
    const blocks = [...text.matchAll(/```[\w]*\n([\s\S]*?)```/g)].map((m) => m[1].trim());
    if (!blocks.length) return "(no fenced code blocks)";
    return blocks.map((b, i) => `// artifact ${i + 1}\n${b}`).join("\n\n");
  }

  async function runNode(node) {
    markNode(node.id, "is-running", true);
    markNode(node.id, "is-error", false);
    try {
      const upstream = gatherInput(node.id);
      if (node.type === "note") return;
      if (node.type === "prompt" || node.type === "system") {
        writeOut(node, (node.data.text || "").trim());
        return;
      }
      if (node.type === "output") {
        writeOut(node, upstream || node.data.output || "");
        return;
      }
      if (node.type === "calc") {
        writeOut(node, calcCheck(upstream));
        return;
      }
      if (node.type === "atomize") {
        // Prefer model if available, else local
        try {
          const result = await callModel({
            model: node.data.model || models.find((m) => m.on_node)?.id,
            temperature: 0.2,
            route: resolveNodeRoute(node),
            machine: node.data.machine || resolveContainingRegion(node)?.machine || null,
            messages: [
              {
                role: "system",
                content: "Atomize the user text into numbered atomic claims c1, c2, … One claim per line. No preamble.",
              },
              { role: "user", content: upstream || "No input." },
            ],
          });
          applyModelResult(node, result);
          if (!(node.data.output || "").trim()) writeOut(node, atomizeLocal(upstream));
        } catch (_) {
          writeOut(node, atomizeLocal(upstream));
        }
        return;
      }
      if (node.type === "witness" || node.type === "checker" || node.type === "validator" || node.type === "watcher") {
        const t0 = performance.now();
        const result = await callModel({
          model: node.data.model || models.find((m) => m.on_node)?.id,
          temperature: 0.3,
          route: resolveNodeRoute(node),
          machine: node.data.machine || resolveContainingRegion(node)?.machine || null,
          messages: [
            {
              role: "system",
              content: PLANE_PROMPTS[node.type] || PLANE_PROMPTS.witness,
            },
            { role: "user", content: upstream || "No claims." },
          ],
        });
        node.data.latency_ms = Math.round(performance.now() - t0);
        applyModelResult(node, result);
        return;
      }
      if (node.type === "gate") {
        writeOut(node, gateLocal(upstream));
        return;
      }
      if (node.type === "code") {
        writeOut(node, codeExtract(upstream));
        return;
      }
      if (node.type === "script" || node.type === "script_py" || node.type === "script_c") {
        const t0 = performance.now();
        const data = await callScript(node, upstream);
        node.data.latency_ms = data.latency_ms != null ? data.latency_ms : Math.round(performance.now() - t0);
        node.data.explain = data.explain || "";
        node.data.metrics = data.metrics || null;
        node.data.lang = normalizeLang(data.lang || node.data.lang || "python");
        node.data.last_where = data.where || `Local · ${node.data.lang}`;
        node.data.route = "local";
        writeOut(node, data.output || "");
        return;
      }
      if (node.type === "phone") {
        const t0 = performance.now();
        if (!node.data.image && !node.data.pair_session) {
          writeOut(node, "PHONE · pair your phone (dock → Phone) and send a shot.");
          node.data.last_where = "Phone · unpaired";
          node.data.latency_ms = Math.round(performance.now() - t0);
          node.data.route = "phone";
          return;
        }
        if ((upstream || "").trim().length > 8) {
          const result = await callModel({
            messages: [
              { role: "system", content: "You are an on-device phone assistant. Be terse. Prefer UNKNOWN. No invented sources." },
              { role: "user", content: upstream.slice(0, 6000) },
            ],
            model: node.data.model || models.find((m) => m.on_node)?.id,
            temperature: node.data.temp ?? 0.4,
            route: "phone",
            machine: node.data.phone || node.data.machine || node.data.device,
          });
          applyModelResult(node, result);
        } else {
          writeOut(node, `PHONE READY · ${node.data.device || node.data.phone || "handset"}\nFrame attached · ${node.data.image ? "yes" : "no"}\nAwaiting Vision / Checker.`);
          node.data.last_where = routeDisplay("phone", node.data.phone || node.data.machine || node.data.device);
        }
        node.data.latency_ms = Math.round(performance.now() - t0);
        node.data.route = "phone";
        return;
      }
      if (node.type === "brain") {
        const map = window.NoetiBrain?.getMapText?.() || "Second Brain empty — allow a folder first";
        node.data.output = map;
        writeOut(node, map);
        node.data.latency_ms = 4;
        return;
      }
      if (node.type === "model" || node.type === "vision") {
        if (node.type === "vision" && !node.data.image) {
          const upPhone = incoming(node.id)
            .map((id) => state.nodes.find((x) => x.id === id))
            .find((x) => x && x.type === "phone" && x.data.image);
          if (upPhone?.data?.image) {
            node.data.image = upPhone.data.image;
            node.data.route = "phone";
            node.data.phone = upPhone.data.device || upPhone.data.phone;
          }
        }
        const sys = state.nodes
          .filter((n) => n.type === "system" && state.edges.some((e) => e.from === n.id && e.to === node.id))
          .map((n) => n.data.text)
          .filter(Boolean)
          .join("\n");
        const userText = [node.data.text, upstream].filter(Boolean).join("\n\n") || "Hello";
        let content = userText;
        if (node.type === "vision" && node.data.image) {
          content = [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: node.data.image } },
          ];
        }
        const messages = [];
        if (sys) messages.push({ role: "system", content: sys });
        messages.push({ role: "user", content });
        const t0 = performance.now();
        const result = await callModel({
          model: node.data.model,
          temperature: node.data.temp ?? 0.55,
          route: resolveNodeRoute(node),
          machine: node.data.machine || resolveContainingRegion(node)?.machine || null,
          messages,
        });
        node.data.latency_ms = Math.round(performance.now() - t0);
        applyModelResult(node, result);
        return;
      }
    } catch (err) {
      markNode(node.id, "is-error", true);
      writeOut(node, `Error: ${err.message || err}`);
      throw err;
    } finally {
      markNode(node.id, "is-running", false);
    }
  }

  function setProgress(pct, show = true) {
    if (!els.runProgress || !els.runProgressBar) return;
    els.runProgress.hidden = !show;
    els.runProgressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }

  function reachableFrom(startId) {
    const seen = new Set([startId]);
    const q = [startId];
    while (q.length) {
      const id = q.shift();
      for (const e of state.edges.filter((x) => x.from === id)) {
        if (!seen.has(e.to)) {
          seen.add(e.to);
          q.push(e.to);
        }
      }
    }
    // also include ancestors needed for inputs
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of state.edges) {
        if (seen.has(e.to) && !seen.has(e.from)) {
          seen.add(e.from);
          changed = true;
        }
      }
    }
    return seen;
  }


  function setPrivate(on) {
    privateLocal = !!on;
    try { localStorage.setItem("noeti_canvas_private", privateLocal ? "1" : "0"); } catch (_) {}
    document.body.classList.toggle("cv-private", privateLocal);
    const btn = document.getElementById("btnPrivateLocal");
    if (btn) btn.checked = privateLocal;
    btn?.closest(".cv-priv-toggle")?.classList.toggle("is-on", privateLocal);
    if (privateLocal && models.length) {
      const nodeId = models.find((m) => m.on_node)?.id;
      if (nodeId) {
        state.nodes.forEach((n) => {
          if (["model", "vision", "atomize", "witness", "checker", "validator", "watcher"].includes(n.type)) {
            const cur = models.find((m) => m.id === n.data.model);
            if (!cur?.on_node) n.data.model = nodeId;
          }
        });
        save();
        renderNodes();
        renderInspector();
      }
    }
    save();
    setStatus(privateLocal ? "Private local stack · on-node only" : "Public / catalog routing");
    setTimeout(() => setStatus("", false), 1800);
  }

  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HIST_KEY) || "[]") || [];
    } catch (_) {
      return [];
    }
  }

  function pushHistory(entry) {
    try {
      const list = loadHistory();
      list.unshift(entry);
      localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, 30)));
    } catch (_) {}
  }

  function renderHistory() {
    const list = document.getElementById("historyList");
    if (!list) return;
    const rows = loadHistory();
    if (!rows.length) {
      list.innerHTML = `<p class="cv-insp-empty">No sealed or finished runs yet.</p>`;
      return;
    }
    list.innerHTML = rows.map((r, i) => `
      <button type="button" class="cv-hist-item" data-hist="${i}">
        <strong>${escapeHtml(r.title || "Canvas run")}</strong>
        <span>${escapeHtml(r.at || "")}${r.private ? " · private" : ""}${r.run_id ? " · " + escapeHtml(r.run_id) : ""}</span>
      </button>
    `).join("");
    list.querySelectorAll("[data-hist]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = rows[Number(btn.dataset.hist)];
        if (!row?.snapshot) return;
        pushUndo();
        state = JSON.parse(JSON.stringify(row.snapshot));
        state.cam = state.cam || { x: 80, y: 60, z: 1 };
        selectedId = null;
        save();
        renderNodes();
        renderInspector();
        applyCam();
        setStatus("Replayed board snapshot");
        setTimeout(() => setStatus("", false), 1600);
        document.getElementById("historyPanel").hidden = true;
      });
    });
  }

  function collectSealPayload() {
    const prompt = state.nodes.find((n) => n.type === "prompt");
    const out = state.nodes.find((n) => n.type === "output");
    const gateN = state.nodes.find((n) => n.type === "gate");
    const modelN = state.nodes.find((n) => n.type === "model" || n.type === "vision");
    const gateText = gateN?.data?.output || "";
    let gate = "review";
    if (/GATE:\s*ready/i.test(gateText)) gate = "ready";
    else if (/GATE:\s*blocked/i.test(gateText)) gate = "blocked";
    const atom = state.nodes.find((n) => n.type === "atomize");
    const claims = [];
    const atomOut = atom?.data?.output || "";
    atomOut.split("\n").forEach((line) => {
      const m = line.match(/^c\d+:\s*(.+)/i) || line.match(/^\d+[.)]\s*(.+)/);
      if (m) claims.push(m[1].trim());
    });
    if (!claims.length && out?.data?.output) {
      out.data.output.split(/(?<=[.!?])\s+/).filter((s) => s.length > 20).slice(0, 6).forEach((s) => claims.push(s.trim()));
    }
    const judges = [];
    for (const role of ["checker", "validator", "watcher", "witness"]) {
      const n = state.nodes.find((x) => x.type === role);
      if (!n?.data?.output) continue;
      judges.push({
        role,
        label: role[0].toUpperCase() + role.slice(1),
        verdict: /CONTEST/i.test(n.data.output) ? "contested" : /SUPPORT/i.test(n.data.output) ? "supported" : "unknown",
        reason: String(n.data.output).slice(0, 400),
        model: n.data.model || "",
        latency_ms: n.data.latency_ms,
      });
    }
    const judgements = (claims.length ? claims : ["Canvas board output"]).map((claim) => ({
      claim,
      judges: judges.map((j) => ({ ...j })),
      aggregate: { final_verdict: gate === "ready" ? "supported" : "review", publish_gate: gate },
    }));
    return {
      title: (prompt?.data?.text || "Canvas board run").slice(0, 200),
      query: (prompt?.data?.text || out?.data?.output || "Canvas board run").slice(0, 600),
      claims,
      judgements,
      judges,
      gate,
      worker_model: modelN?.data?.model || "",
      roles: judges.map((j) => j.role),
      nodes: state.nodes,
      edges: state.edges,
      regions: state.regions,
      cam: state.cam,
      fx: document.body.dataset.fx,
      private: privateLocal,
      prefer_local: privateLocal,
      latency_ms: lastRunMeta?.ms || null,
      summary: { publish_gate: gate, blocks: state.nodes.length },
      activity: state.nodes.filter((n) => n.data.output).map((n) => ({
        actor: n.type,
        did: String(n.data.output).slice(0, 160),
      })),
    };
  }

  async function sealBoard({ share = false } = {}) {
    setStatus("Sealing ProofPath…");
    try {
      const payload = collectSealPayload();
      const res = await fetch("/api/canvas/seal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || `Seal failed (${res.status})`);
      const snap = JSON.parse(JSON.stringify(state));
      pushHistory({
        title: payload.title,
        at: new Date().toISOString().replace("T", " ").slice(0, 19),
        run_id: data.run_id,
        private: privateLocal,
        snapshot: snap,
        proofpath: data.proofpath,
      });
      lastSeal = data;
      const url = proofShareUrl(data.run_id, data.share_path);
      setLoopStep("share");
      showLoopTray("Sealed · copy the proof link or open it");
      setStatus(`Sealed · ${data.run_id}`);
      if (share) {
        const ok = await copyText(url);
        showShareToast(data);
        setStatus(ok ? "Proof link copied" : `Proof ready · ${url}`);
      } else {
        showShareToast(data);
      }
      setTimeout(() => setStatus("", false), 3200);
      return data;
    } catch (err) {
      setStatus(err.message || "Seal failed");
      throw err;
    }
  }

  async function shareBoard() {
    try {
      if (lastSeal?.run_id) {
        const url = proofShareUrl(lastSeal.run_id);
        const ok = await copyText(url);
        showShareToast(lastSeal);
        setStatus(ok ? "Proof link copied" : `Share · ${url}`);
        setTimeout(() => setStatus("", false), 2400);
        return lastSeal;
      }
      return await sealBoard({ share: true });
    } catch (_) {
      return null;
    }
  }


  /** Prefer recognizable catalog models for demos (not always the tiny on-node default). */
  function pickDemoModels() {
    const list = Array.isArray(models) ? models : [];
    const byId = new Map(list.map((m) => [m.id, m]));
    const has = (id) => byId.has(id);
    const first = (...ids) => {
      for (const id of ids) if (has(id)) return id;
      return null;
    };
    const onNode = () =>
      first("gemma2:2b", "qwen2.5:1.5b", "llama3.2:1b", "qwen2.5:0.5b", "tinyllama")
      || list.find((m) => m.on_node)?.id
      || "qwen2.5:0.5b";
    const mesh = (prefs, fallbackTier) => {
      const hit = first(...prefs);
      if (hit) return hit;
      const tierHit = list.find((m) =>
        (m.deployment === "decentralized" || m.decentralized)
        && !m.on_node
        && (!fallbackTier || m.tier === fallbackTier)
        && !String(m.id).includes(":free")
      );
      return tierHit?.id || list.find((m) => m.deployment === "decentralized" || m.decentralized)?.id || onNode();
    };
    const cloud = () =>
      first(
        "~anthropic/claude-sonnet-latest",
        "anthropic/claude-sonnet-4.5",
        "anthropic/claude-haiku-4.5",
        "~anthropic/claude-haiku-latest",
        "amazon/nova-pro-v1",
        "google/gemini-2.5-pro",
        "~google/gemini-flash-latest",
      )
      || list.find((m) => m.deployment === "centralized" && (m.tier === "flagship" || m.tier === "strong"))?.id
      || list.find((m) => m.deployment === "centralized")?.id
      || mesh(["deepseek/deepseek-v4-pro"], "flagship");
    const vision = () =>
      first(
        "qwen/qwen3-vl-32b-instruct",
        "qwen/qwen3-vl-8b-instruct",
        "qwen/qwen2.5-vl-72b-instruct",
        "nvidia/nemotron-nano-12b-v2-vl:free",
        "bytedance/ui-tars-1.5-7b",
      )
      || list.find((m) => /vl|vision|llava|pixtral/i.test(String(m.id || m.name || "")))?.id
      || onNode();

    return {
      local: onNode(),
      private: onNode(),
      writer: mesh([
        "meta-llama/llama-3.3-70b-instruct",
        "qwen/qwen3-32b",
        "mistralai/mistral-large-2512",
        "deepseek/deepseek-chat-v3.1",
        "mistral:7b",
        "llama3.1:8b",
      ], "flagship"),
      checker: mesh([
        "qwen/qwen3-14b",
        "google/gemma-3-27b-it",
        "mistralai/mistral-medium-3.1",
        "qwen2.5:7b",
        "gemma2:9b",
      ], "strong"),
      validator: mesh([
        "deepseek/deepseek-v4-pro",
        "qwen/qwen3-235b-a22b-2507",
        "google/gemma-4-31b-it",
        "deepseek/deepseek-chat",
        "llama3.1:8b",
      ], "flagship"),
      watcher: mesh([
        "deepseek/deepseek-r1",
        "deepseek/deepseek-r1-0528",
        "allenai/olmo-3-32b-think",
        "qwen/qwen3-235b-a22b-thinking-2507",
        "deepseek-r1:7b",
        "deepseek/deepseek-v4-flash",
      ], "flagship"),
      witness: mesh([
        "mistralai/mistral-medium-3",
        "google/gemma-2-27b-it",
        "phi3:mini",
        "llama3.2:3b",
      ], "strong"),
      rack: mesh([
        "qwen/qwen3-30b-a3b-instruct-2507",
        "meta-llama/llama-3.3-70b-instruct",
        "deepseek/deepseek-v3.2",
        "mistral:7b",
      ], "flagship"),
      field: mesh([
        "deepseek/deepseek-v4-flash",
        "google/gemma-3-12b-it",
        "aion-labs/aion-3.0-mini",
        "qwen2.5:3b",
        "llama3.2:3b",
      ], "fast"),
      cloud: cloud(),
      vision: vision(),
      atom: mesh([
        "qwen/qwen3-14b",
        "qwen2.5:7b",
        "mistral:7b",
        "phi3:mini",
      ], "strong"),
    };
  }


  const DEMO_COPY = {
    brief: `SOURCE MEMO · REDACTED · binder-only
Case: Harbor / pier contact · 12 Mar evening
Witness A reports Subject B arrived by water taxi ~21:40.
Alleged cash envelope exchange · amount UNKNOWN · no photo.
Third party overheard "tomorrow's vote" — uncorroborated.
Do not publish names, employers, or exact amounts.
Policy: Prefer UNKNOWN. Seal on-node. No mesh leave.`,

    draft: `WIRE DRAFT · Harbor bridge
Officials closed the harbor bridge at midnight after structural alarms triggered on the south span.
No casualties were confirmed by mid-morning, according to a municipal spokesman.
The same spokesman said repairs could take several days and that ferry diversions would continue.
Traffic cameras show emergency lighting only — no crowd footage released.
Desk note: hospital blotter still empty as of 10:12.`,

    atoms: `c1: Harbor bridge closed at midnight after structural alarms on the south span.
c2: No casualties were confirmed by mid-morning.
c3: Municipal spokesman said repairs could take several days.
c4: Ferry diversions continue while the span is closed.
c5: Hospital blotter empty as of 10:12 (desk note · not for wire yet).`,

    check: `CHECKER · fact plane
c1 SUPPORT · Port Authority bulletin PA-00:14 cites south-span alarms and midnight closure.
c2 UNKNOWN · no hospital / EMS statement on record by 10:12; "no casualties" is soft.
c3 SUPPORT · attributed quote in city wire 08:41; name of spokesman on file.
c4 SUPPORT · ferry diversion notice FERRY-07 matches closure window.
c5 UNKNOWN · internal desk note only — do not elevate to claim without blotter.`,

    valid: `VALIDATOR · publish risk
c1 SUPPORT · publish OK with time stamp + bulletin cite.
c2 CONTEST · casualty line still soft — hedge or cut before publish.
c3 SUPPORT · attribute spokesman; keep "could take several days" as quote.
c4 SUPPORT · operational diversion is low risk.
c5 CONTEST · desk-only note must not leak into public graf.
Overall: REVIEW — κ̂ elevated on casualties.`,

    watch: `WATCHER · contradiction hunt
c2 CONTEST · "no casualties confirmed" races ahead of hospital records; classic premature absolution.
c1/c3 related · repair timeline may drift if second alarm overnight — watch for PA updates.
c5 contests c2 · empty blotter ≠ confirmed zero injuries.
Pattern: desk is ahead of primary on human harm — force hedge.`,

    gate_review: `GATE: review
Reason: casualty claim unconfirmed; planes disagree on c2.
κ̂ elevated — human desk required before export.
Allowed: seal binder · hold wire · await hospital blotter.`,

    gate_ready: `GATE: ready
Reason: primary bulletin + attributed quote; soft claims hedged.
Export allowed under non-strict policy.
ProofPath: checker SUPPORT · validator SUPPORT · watcher notes logged.`,

    priv_out: `PRIVATE SUMMARY · on-node only
• Meeting alleged at pier · 12 Mar ~21:40
• Cash transfer alleged · amount unproven · no image
• "Tomorrow's vote" overheard · single source · UNKNOWN
• Hold all names · employers · exact figures
• Next: ledger photo if obtained · seal binder
[placeholder · ran Private · this node]`,

    mesh_out: `WIRE GRAF · mesh write
Harbor bridge shut overnight after south-span structural alarms; city says multi-day repairs and ferry diversions will continue.
Casualties remain unconfirmed — newsroom still checking hospitals.
No crowd footage released; cameras show emergency lighting only.
[placeholder · decentralized mesh · hedged]`,

    local_out: `DESK NOTE · this computer
Bridge closed 00:00 · south-span alarms cited (PA-00:14).
Casualties: unconfirmed as of 10:12.
Spokesman: repairs "several days" · ferry diversions active.
Next: hospital blotter + port bulletin refresh + camera stills request.
Do not elevate blotter emptiness to a wire claim.
[placeholder · local · on-node]`,

    site01: `SITE-01 · nr-rack-a.floor3
Host: Newsroom rack A · edit bay cage 2
GPU0 busy · polish job Q-4412 · 890ms
Kept: midnight closure + south-span alarms
Hedged: casualties → SOFT for desk
VRAM 22/24 GB free · heartbeat ok
Ready for editor queue · human edit next
[imagined host · pin pending]`,

    peer01: `PEER-01 · mira-mbp.field
Host: Field laptop · Mira Chen
South approach · van Wi-Fi · RTT 48ms
c2 CONTEST · no hospital / EMS staging in view
c1 SUPPORT · closure barriers confirm midnight
Battery 71% · GPS near south span
Recommend HOLD on "no casualties" absolute
[imagined host · pin pending]`,

    vision_out: `VISION READ · placeholder (no image attached)
Scene guess: document photo · stamped ledger page · desk lamp glare.
Visible marks: handwritten sum "14,200" in lower right · stamp oval top-left.
Faces: none clear.
Unverified: whether stamp is authentic · whether sum matches line items.
Attach a real image and ▶ Run to replace this placeholder.`,

    merge: `PROOFPATH MERGE · demo packet
Private binder …… HOLD · identities sealed
Local desk ……… draft notes + atoms + soft c2
Mesh wire ……… hedged graf · casualties unconfirmed
site-01 ……… rack draft Q-4412
peer-01 ……… CONTEST on casualties (placeholder pin)
Cloud polish …… CMS-tightened hedge
Gate hint ……… REVIEW until blotter lands
— where-tags preserved across lanes —`,

    cloud_out: `CENTRALIZED POLISH · catalog (placeholder)
Hedged wire graf tightened for CMS slug length.
Title suggestion: Harbor bridge closed after alarms; repairs multi-day
Dek: Casualties unconfirmed · ferry diversions continue
Do not harden soft claims in polish pass.
[cloud catalog · demo]`,

    code_out: `\`\`\`json
{
  "story_id": "harbor-bridge-0722",
  "claims": ["c1","c2","c3","c4"],
  "gate": "review",
  "soft": ["c2","c5"]
}
\`\`\`
[placeholder · code extract]`,
  };

  function stampDemo(n, { output, latency, where, route, machine, priv, explain } = {}) {
    if (output != null) n.data.output = output;
    if (latency != null) n.data.latency_ms = latency;
    if (where) n.data.last_where = where;
    if (route) n.data.route = route;
    if (machine) n.data.machine = machine;
    if (explain) n.data.explain = explain;
    if (priv) { n.data.private = true; n.data.route = n.data.route || "private"; }
    return n;
  }

  function applyTemplate(name) {
    const dm = pickDemoModels();
    const lm = dm.local;
    const short = (id) => {
      const m = models.find((x) => x.id === id);
      const label = (m?.name || id || "").replace(/^[^:]+:\s*/, "");
      return label.length > 28 ? label.slice(0, 26) + "…" : label;
    };
    // Roomier grid: nodes ~280×~320 → columns +420, rows +440
    const CX = 420;
    const RY = 440;
    pushUndo();
    state = { nodes: [], edges: [], regions: [], cam: { x: 40, y: 30, z: 0.55 } };
    selectedId = null;
    setPrivate(false);

    if (name === "regions") {
      state.cam = { x: -40, y: -40, z: 0.42 };
      const guide = addNode("note", 40, 20, { text: `COMPUTE MAP · filled demo\nInteresting models per lane (live catalog).\nPrivate/local: ${short(dm.private)} · Mesh writer: ${short(dm.writer)}\nWatcher: ${short(dm.watcher)} · Cloud: ${short(dm.cloud)}\n▶ Run re-computes; double-click a zone to remove.` }, { silent: true });

      // Private lane — top left, generous gaps
      const p1 = addNode("prompt", 80, 200, { text: DEMO_COPY.brief, route: "private", private: true, output: DEMO_COPY.brief }, { silent: true });
      const sys1 = addNode("system", 80, 200 + RY, { text: "Private lane. Never invent sources. Prefer UNKNOWN. No names outside binder. Refuse mesh leave.", route: "private", private: true, output: "SYSTEM · private\nPrefer UNKNOWN · seal only · no mesh" }, { silent: true });
      const m1 = stampDemo(addNode("model", 80 + CX, 200, { model: dm.private, route: "private", private: true }, { silent: true }), { output: DEMO_COPY.priv_out, latency: 420, where: "Private · this node", priv: true });
      const a1 = stampDemo(addNode("atomize", 80 + CX * 2, 200, { model: dm.atom, route: "private", private: true }, { silent: true }), { output: "c1: Meeting alleged at pier 12 Mar ~21:40.\nc2: Cash envelope unproven · amount UNKNOWN.\nc3: Vote remark overheard · single source.\nc4: Identities must stay sealed.", latency: 195, where: "Private · this node", priv: true });
      const g1 = stampDemo(addNode("gate", 80 + CX * 2, 200 + RY, { route: "private", private: true }, { silent: true }), { output: "GATE: hold\nReason: identities + unproven cash + soft vote remark.\nPrivate seal only — no export.", latency: 18, where: "Private · this node", priv: true });

      // Local lane — well below private
      const yLocal = 200 + RY * 2 + 120;
      const p2 = addNode("prompt", 80, yLocal, { text: "Turn the bridge bulletin into desk notes for the morning meeting.\nFlag soft claims. Keep ferry diversion as operational fact.", route: "local", output: "LOCAL ASK\nBridge bulletin → morning desk notes\nFlag soft claims · keep diversions" }, { silent: true });
      const m2 = stampDemo(addNode("model", 80 + CX, yLocal, { model: dm.local, route: "local" }, { silent: true }), { output: DEMO_COPY.local_out, latency: 380, where: "Local · this computer", route: "local" });
      const a2 = stampDemo(addNode("atomize", 80 + CX * 2, yLocal, { model: dm.atom, route: "local" }, { silent: true }), { output: DEMO_COPY.atoms, latency: 210, where: "Local · this computer", route: "local" });
      const code2 = stampDemo(addNode("code", 80 + CX, yLocal + RY, { route: "local" }, { silent: true }), { output: DEMO_COPY.code_out, latency: 12, where: "Local · this computer", route: "local" });
      const c2 = stampDemo(addNode("checker", 80 + CX * 2, yLocal + RY, { model: dm.checker, route: "local" }, { silent: true }), { output: DEMO_COPY.check, latency: 510, where: "Local · this computer", route: "local" });

      // Mesh lane — right of private, clear horizontal gap
      const xMesh = 80 + CX * 3 + 160;
      const p3 = addNode("prompt", xMesh, 200, { text: "Public wire graf from the same facts. Hedge anything soft. Mesh models OK. No private names.", route: "decentralized", output: "MESH ASK\nPublic wire graf · hedge soft claims\nNo private names · mesh OK" }, { silent: true });
      const m3 = stampDemo(addNode("model", xMesh + CX, 200, { model: dm.writer, route: "decentralized" }, { silent: true }), { output: DEMO_COPY.mesh_out, latency: 640, where: "Decentralized mesh", route: "decentralized" });
      const w3 = stampDemo(addNode("watcher", xMesh + CX * 2, 200, { model: dm.watcher, route: "decentralized" }, { silent: true }), { output: DEMO_COPY.watch, latency: 490, where: "Decentralized mesh", route: "decentralized" });
      const v3 = stampDemo(addNode("validator", xMesh + CX * 2, 200 + RY, { model: dm.validator, route: "decentralized" }, { silent: true }), { output: DEMO_COPY.valid, latency: 455, where: "Decentralized mesh", route: "decentralized" });

      // Specific PCs + cloud — under mesh, spaced
      const ySite = yLocal;
      const hostA = addNode("note", xMesh - 20, ySite - 20, { text: machineProfile("site-01").card, route: "machine", machine: "site-01" }, { silent: true });
      const p4a = addNode("prompt", xMesh, ySite + 200, { text: "Push draft inference to newsroom rack site-01.\nReturn queue-ready polish with soft claims marked.\nHost: nr-rack-a.floor3 · Q-4412.", route: "machine", machine: "site-01", output: "PIN → site-01\nnr-rack-a.floor3\nQueue Q-4412 · draft polish" }, { silent: true });
      const m4a = stampDemo(addNode("model", xMesh + CX, ySite + 200, { model: dm.rack, route: "machine", machine: "site-01" }, { silent: true }), { output: DEMO_COPY.site01, latency: 890, where: "site-01 · nr-rack-a.floor3", route: "machine", machine: "site-01" });
      const yPeer = ySite + RY + 280;
      const hostB = addNode("note", xMesh - 20, yPeer - 20, { text: machineProfile("peer-01").card, route: "machine", machine: "peer-01" }, { silent: true });
      const p4b = addNode("prompt", xMesh, yPeer + 200, { text: "Field checker on peer-01 laptop — contest soft casualty line from approach road.\nHost: mira-mbp.field · Mira Chen.", route: "machine", machine: "peer-01", output: "PIN → peer-01\nmira-mbp.field\nField contest on casualties" }, { silent: true });
      const m4b = stampDemo(addNode("checker", xMesh + CX, yPeer + 200, { model: dm.field, route: "machine", machine: "peer-01" }, { silent: true }), { output: DEMO_COPY.peer01, latency: 720, where: "peer-01 · mira-mbp.field", route: "machine", machine: "peer-01" });

      const yPhone = yPeer + RY + 280;
      const hostP = addNode("note", xMesh - 20, yPhone - 20, { text: phoneProfile("phone-mira").card, route: "phone", phone: "phone-mira", machine: "phone-mira" }, { silent: true });
      const phCap = stampDemo(addNode("phone", xMesh, yPhone + 200, { phone: "phone-mira", machine: "phone-mira", route: "phone", image: phoneSampleImage("bridge") }, { silent: true }), { output: "PHONE CAPTURE · phone-mira\nSouth approach frame · barriers visible\n[imagined handset · pin pending]", latency: 40, where: "phone-mira · field", route: "phone", machine: "phone-mira" });
      const phVis = stampDemo(addNode("vision", xMesh + CX, yPhone + 200, { model: dm.vision, route: "phone", phone: "phone-mira", machine: "phone-mira", image: phoneSampleImage("bridge"), text: "Read the phone frame. Prefer UNKNOWN on casualties." }, { silent: true }), { output: "VISION · phone-mira\nBarriers + emergency lighting.\nNo EMS staging in frame.\nCasualties: UNKNOWN from image.", latency: 880, where: "phone-mira → vision", route: "phone", machine: "phone-mira" });
      const xCloud = xMesh + CX * 2 + 80;
      const cloud = stampDemo(addNode("model", xCloud, ySite + 200, { model: dm.cloud, route: "centralized", text: "Optional catalog polish for CMS. Do not harden soft claims." }, { silent: true }), { output: DEMO_COPY.cloud_out, latency: 1100, where: "Centralized · cloud", route: "centralized" });
      const gateM = stampDemo(addNode("gate", xCloud, yPeer + 200, {}, { silent: true }), { output: DEMO_COPY.gate_review, latency: 22, where: "Publish gate · merge" });
      const out = stampDemo(addNode("output", xCloud + CX, ySite + RY, {}, { silent: true }), { output: DEMO_COPY.merge, latency: 12, where: "Merge · all lanes" });

      state.edges = [
        { id: uid("e"), from: p1.id, to: m1.id, rel: "related" },
        { id: uid("e"), from: sys1.id, to: m1.id, rel: "related" },
        { id: uid("e"), from: m1.id, to: a1.id, rel: "related" },
        { id: uid("e"), from: a1.id, to: g1.id, rel: "supports" },
        { id: uid("e"), from: p2.id, to: m2.id, rel: "related" },
        { id: uid("e"), from: m2.id, to: a2.id, rel: "related" },
        { id: uid("e"), from: a2.id, to: c2.id, rel: "related" },
        { id: uid("e"), from: a2.id, to: code2.id, rel: "related" },
        { id: uid("e"), from: p3.id, to: m3.id, rel: "related" },
        { id: uid("e"), from: m3.id, to: w3.id, rel: "contests" },
        { id: uid("e"), from: m3.id, to: v3.id, rel: "related" },
        { id: uid("e"), from: p4a.id, to: m4a.id, rel: "related" },
        { id: uid("e"), from: p4b.id, to: m4b.id, rel: "related" },
        { id: uid("e"), from: m4a.id, to: cloud.id, rel: "related" },
        { id: uid("e"), from: g1.id, to: out.id, rel: "related" },
        { id: uid("e"), from: c2.id, to: gateM.id, rel: "supports" },
        { id: uid("e"), from: code2.id, to: out.id, rel: "related" },
        { id: uid("e"), from: w3.id, to: gateM.id, rel: "contests" },
        { id: uid("e"), from: v3.id, to: gateM.id, rel: "related" },
        { id: uid("e"), from: m4b.id, to: gateM.id, rel: "contests" },
        { id: uid("e"), from: cloud.id, to: gateM.id, rel: "related" },
        { id: uid("e"), from: gateM.id, to: out.id, rel: "related" },
        { id: uid("e"), from: phCap.id, to: phVis.id, rel: "related" },
        { id: uid("e"), from: phVis.id, to: gateM.id, rel: "contests" },
      ];
      state.regions = [
        { id: uid("r"), x: 0, y: 0, w: 100, h: 100, route: "private", private: true, title: "Sensitive binder", runsOn: "This node only · sealed", nodeIds: [p1.id, sys1.id, m1.id, a1.id, g1.id] },
        { id: uid("r"), x: 0, y: 0, w: 100, h: 100, route: "local", title: "Editor laptop", runsOn: "This computer · on-node", nodeIds: [p2.id, m2.id, a2.id, c2.id, code2.id] },
        { id: uid("r"), x: 0, y: 0, w: 100, h: 100, route: "decentralized", title: "Public wire", runsOn: "Decentralized mesh", nodeIds: [p3.id, m3.id, w3.id, v3.id] },
        { id: uid("r"), x: 0, y: 0, w: 100, h: 100, route: "machine", machine: "site-01", placeholder: true, title: "Newsroom rack A", runsOn: "nr-rack-a.floor3 · edit bay cage 2", nodeIds: [hostA.id, p4a.id, m4a.id] },
        { id: uid("r"), x: 0, y: 0, w: 100, h: 100, route: "machine", machine: "peer-01", placeholder: true, title: "Field laptop Mira", runsOn: "mira-mbp.field · south approach", nodeIds: [hostB.id, p4b.id, m4b.id] },
        { id: uid("r"), x: 0, y: 0, w: 100, h: 100, route: "centralized", title: "Cloud polish", runsOn: "Centralized catalog", nodeIds: [cloud.id] },
        { id: uid("r"), x: 0, y: 0, w: 100, h: 100, route: "phone", machine: "phone-mira", placeholder: true, title: "Mira's iPhone", runsOn: "South approach · field", nodeIds: [hostP.id, phCap.id, phVis.id] },
      ];
      void guide;
    } else if (name === "splitdesk") {
      state.cam = { x: -20, y: -20, z: 0.5 };
      addNode("note", 40, 20, { text: `SPLIT DESK · filled demo\nBinder model: ${short(dm.private)} · Mesh writer: ${short(dm.writer)}\nWatcher: ${short(dm.watcher)} · Validator: ${short(dm.validator)}` }, { silent: true });
      const pL = addNode("prompt", 80, 200, { text: DEMO_COPY.brief, route: "private", private: true, output: DEMO_COPY.brief }, { silent: true });
      const mL = stampDemo(addNode("model", 80 + CX, 200, { model: dm.private, route: "private", private: true }, { silent: true }), { output: DEMO_COPY.priv_out, latency: 410, where: "Private · this node", priv: true });
      const aL = stampDemo(addNode("atomize", 80 + CX * 2, 200, { model: dm.atom, route: "private", private: true }, { silent: true }), { output: "c1: Meeting alleged at pier 12 Mar ~21:40.\nc2: Cash envelope unproven.\nc3: Vote remark overheard · single source.\nc4: Identities must stay sealed.", latency: 190, where: "Private · this node", priv: true });
      const wit = stampDemo(addNode("witness", 80 + CX, 200 + RY, { model: dm.witness, route: "private", private: true }, { silent: true }), { output: "WITNESS · private\nc2 CONTEST · cash claim lacks primary.\nc1 UNKNOWN · water-taxi time unverified.\nSeal — do not mesh.", latency: 460, where: "Private · this node", priv: true });
      const chk = stampDemo(addNode("checker", 80 + CX * 2, 200 + RY, { model: dm.checker, route: "private", private: true }, { silent: true }), { output: "c1 UNKNOWN · single source memo.\nc2 CONTEST · no ledger / photo.\nc3 UNKNOWN · overheard only.\nc4 SUPPORT · policy hold on names.", latency: 505, where: "Private · this node", priv: true });

      const yPub = 200 + RY * 2 + 140;
      const pR = addNode("prompt", 80, yPub, { text: "Public graf only — no names. Mesh OK.\n" + DEMO_COPY.draft, route: "decentralized", output: DEMO_COPY.draft }, { silent: true });
      const mR = stampDemo(addNode("model", 80 + CX, yPub, { model: dm.writer, route: "decentralized" }, { silent: true }), { output: DEMO_COPY.mesh_out, latency: 620, where: "Decentralized mesh", route: "decentralized" });
      const val = stampDemo(addNode("validator", 80 + CX * 2, yPub, { model: dm.validator, route: "decentralized" }, { silent: true }), { output: DEMO_COPY.valid, latency: 440, where: "Decentralized mesh", route: "decentralized" });
      const watch = stampDemo(addNode("watcher", 80 + CX * 2, yPub + RY, { model: dm.watcher, route: "decentralized" }, { silent: true }), { output: DEMO_COPY.watch, latency: 470, where: "Decentralized mesh", route: "decentralized" });
      const gate = stampDemo(addNode("gate", 80 + CX * 3 + 80, 200 + RY, {}, { silent: true }), { output: DEMO_COPY.gate_review, latency: 22, where: "Publish gate" });
      const o = stampDemo(addNode("output", 80 + CX * 4 + 80, 200 + RY, {}, { silent: true }), { output: "SPLIT RESULT · demo\nBinder lane: HOLD · seal on-node\nPublish lane: REVIEW — hedge casualties\nWhere tags: private + mesh preserved\nNext: hospital blotter before wire export", latency: 14 });
      state.edges = [
        { id: uid("e"), from: pL.id, to: mL.id, rel: "related" },
        { id: uid("e"), from: mL.id, to: aL.id, rel: "related" },
        { id: uid("e"), from: aL.id, to: chk.id, rel: "related" },
        { id: uid("e"), from: mL.id, to: wit.id, rel: "contests" },
        { id: uid("e"), from: pR.id, to: mR.id, rel: "related" },
        { id: uid("e"), from: mR.id, to: val.id, rel: "related" },
        { id: uid("e"), from: mR.id, to: watch.id, rel: "contests" },
        { id: uid("e"), from: chk.id, to: gate.id, rel: "supports" },
        { id: uid("e"), from: wit.id, to: gate.id, rel: "contests" },
        { id: uid("e"), from: val.id, to: gate.id, rel: "related" },
        { id: uid("e"), from: watch.id, to: gate.id, rel: "contests" },
        { id: uid("e"), from: gate.id, to: o.id, rel: "related" },
      ];
      state.regions = [
        { id: uid("r"), x: 0, y: 0, w: 100, h: 100, route: "private", private: true, title: "Binder lane", runsOn: "Private · this node", nodeIds: [pL.id, mL.id, aL.id, chk.id, wit.id] },
        { id: uid("r"), x: 0, y: 0, w: 100, h: 100, route: "decentralized", title: "Publish lane", runsOn: "Decentralized mesh", nodeIds: [pR.id, mR.id, val.id, watch.id] },
      ];
    } else if (name === "journalism") {
      state.cam = { x: -20, y: -30, z: 0.48 };
      addNode("note", 40, 20, { text: `JOURNALISM DESK · filled demo\nWriter ${short(dm.local)} · Atom ${short(dm.atom)}\nChecker ${short(dm.checker)} · Validator ${short(dm.validator)}\nWatcher ${short(dm.watcher)} · Witness ${short(dm.witness)}` }, { silent: true });
      const sys = addNode("system", 40, 200, { text: "Desk policy: Prefer UNKNOWN on human harm. Attribute spokesmen. Never invent hospital counts.", output: "SYSTEM · desk\nUNKNOWN on harm · attribute · no invented counts" }, { silent: true });
      const p = addNode("prompt", 40, 200 + RY, { text: DEMO_COPY.draft, output: DEMO_COPY.draft }, { silent: true });
      const m = stampDemo(addNode("model", 40 + CX, 200, { model: dm.local, route: "local" }, { silent: true }), { output: DEMO_COPY.local_out, latency: 390, where: "Local · this computer", route: "local" });
      const g = stampDemo(addNode("gate", 40 + CX, 200 + RY, { route: "local" }, { silent: true }), { output: DEMO_COPY.gate_review, latency: 20, where: "Local · this computer", route: "local" });
      const a = stampDemo(addNode("atomize", 40 + CX * 2 + 80, 200, { model: dm.atom, route: "decentralized" }, { silent: true }), { output: DEMO_COPY.atoms, latency: 205, where: "Decentralized mesh", route: "decentralized" });
      const c = stampDemo(addNode("checker", 40 + CX * 2 + 80, 200 + RY, { model: dm.checker, route: "decentralized" }, { silent: true }), { output: DEMO_COPY.check, latency: 520, where: "Decentralized mesh", route: "decentralized" });
      const v = stampDemo(addNode("validator", 40 + CX * 3 + 80, 200, { model: dm.validator, route: "decentralized" }, { silent: true }), { output: DEMO_COPY.valid, latency: 480, where: "Decentralized mesh", route: "decentralized" });
      const w = stampDemo(addNode("watcher", 40 + CX * 3 + 80, 200 + RY, { model: dm.watcher, route: "decentralized" }, { silent: true }), { output: DEMO_COPY.watch, latency: 500, where: "Decentralized mesh", route: "decentralized" });
      const wit = stampDemo(addNode("witness", 40 + CX * 4 + 80, 200 + RY, { model: dm.witness, route: "decentralized" }, { silent: true }), { output: "WITNESS · desk\nc2 CONTEST · premature zero-harm.\nc5 SUPPORT · blotter emptiness is desk-only.\nHold wire until EMS or hospital lands.", latency: 445, where: "Decentralized mesh", route: "decentralized" });
      const code = stampDemo(addNode("code", 40 + CX * 4 + 80, 200, { route: "local" }, { silent: true }), { output: DEMO_COPY.code_out, latency: 11, where: "Local · this computer", route: "local" });
      const o = stampDemo(addNode("output", 40 + CX * 5 + 120, 200 + Math.floor(RY / 2), {}, { silent: true }), { output: "DESK PACKET · demo\nGate: REVIEW\nPlanes disagree on casualties (c2).\nChecker soft · Validator hedges · Watcher contests.\nSeal when hospital blotter lands.\nWhere: local writer + mesh planes.", latency: 11 });
      state.edges = [
        { id: uid("e"), from: sys.id, to: m.id, rel: "related" },
        { id: uid("e"), from: p.id, to: m.id, rel: "related" },
        { id: uid("e"), from: m.id, to: a.id, rel: "related" },
        { id: uid("e"), from: a.id, to: code.id, rel: "related" },
        { id: uid("e"), from: a.id, to: c.id, rel: "related" },
        { id: uid("e"), from: a.id, to: v.id, rel: "related" },
        { id: uid("e"), from: a.id, to: w.id, rel: "related" },
        { id: uid("e"), from: a.id, to: wit.id, rel: "related" },
        { id: uid("e"), from: c.id, to: g.id, rel: "supports" },
        { id: uid("e"), from: v.id, to: g.id, rel: "related" },
        { id: uid("e"), from: w.id, to: g.id, rel: "contests" },
        { id: uid("e"), from: wit.id, to: g.id, rel: "contests" },
        { id: uid("e"), from: g.id, to: o.id, rel: "related" },
        { id: uid("e"), from: code.id, to: o.id, rel: "related" },
      ];
      state.regions = [
        { id: uid("r"), x: 0, y: 0, w: 100, h: 100, route: "local", title: "Desk writer", runsOn: "This computer · on-node", nodeIds: [m.id, g.id] },
        { id: uid("r"), x: 0, y: 0, w: 100, h: 100, route: "decentralized", title: "Plane mesh", runsOn: "Decentralized · interesting models", nodeIds: [a.id, c.id, v.id, w.id, wit.id] },
      ];
    } else if (name === "private") {
      setPrivate(true);
      state.cam = { x: 0, y: -10, z: 0.55 };
      addNode("note", 40, 20, { text: `PRIVATE STACK · filled demo\nOn-node only: ${short(dm.private)}\nGate HOLD — identities never leave.` }, { silent: true });
      const p = addNode("prompt", 80, 200, { text: DEMO_COPY.brief, route: "private", private: true, output: DEMO_COPY.brief }, { silent: true });
      const sys = addNode("system", 80, 200 + RY, { text: "Stay concise. Refuse invented sources. Prefer UNKNOWN. No network leave. Seal binder.", route: "private", private: true, output: "SYSTEM · private\nUNKNOWN preferred · no network leave · seal" }, { silent: true });
      const m = stampDemo(addNode("model", 80 + CX, 200, { model: dm.private, route: "private", private: true }, { silent: true }), { output: DEMO_COPY.priv_out, latency: 400, where: "Private · this node", priv: true });
      const a = stampDemo(addNode("atomize", 80 + CX * 2, 200, { model: dm.private, route: "private", private: true }, { silent: true }), { output: "c1: Meeting alleged at pier 12 Mar ~21:40.\nc2: Cash envelope unproven.\nc3: Vote remark overheard · single source.\nc4: Identities must stay sealed.", latency: 188, where: "Private · this node", priv: true });
      const chk = stampDemo(addNode("checker", 80 + CX * 2, 200 + RY, { model: dm.private, route: "private", private: true }, { silent: true }), { output: "c1 UNKNOWN · single memo.\nc2 CONTEST · cash unproven.\nc3 UNKNOWN · overheard only.\nc4 SUPPORT · hold names.", latency: 530, where: "Private · this node", priv: true });
      const g = stampDemo(addNode("gate", 80 + CX * 3, 200, { route: "private", private: true }, { silent: true }), { output: "GATE: hold\nPrivate seal · do not export.\nReason: identities + unproven cash.", latency: 16, where: "Private · this node", priv: true });
      const o = stampDemo(addNode("output", 80 + CX * 4, 200, { route: "private", private: true }, { silent: true }), { output: DEMO_COPY.priv_out + "\n\nSEAL READY · binder packet", latency: 9, where: "Private · this node", priv: true });
      state.edges = [
        { id: uid("e"), from: p.id, to: m.id, rel: "related" },
        { id: uid("e"), from: sys.id, to: m.id, rel: "related" },
        { id: uid("e"), from: m.id, to: a.id, rel: "related" },
        { id: uid("e"), from: a.id, to: chk.id, rel: "related" },
        { id: uid("e"), from: chk.id, to: g.id, rel: "supports" },
        { id: uid("e"), from: g.id, to: o.id, rel: "related" },
      ];
      state.regions = [
        { id: uid("r"), x: 0, y: 0, w: 100, h: 100, route: "private", private: true, title: "Private stack", runsOn: "This node only · sealed", nodeIds: [p.id, sys.id, m.id, a.id, chk.id, g.id, o.id] },
      ];
    } else if (name === "planes") {
      state.cam = { x: -10, y: -20, z: 0.55 };
      addNode("note", 40, 20, { text: `TRIPLE PLANE · filled demo\nChecker ${short(dm.checker)} · Validator ${short(dm.validator)}\nWatcher ${short(dm.watcher)} · Witness ${short(dm.witness)}\nVotes disagree — not averaged.` }, { silent: true });
      const p = addNode("prompt", 80, 200, { text: DEMO_COPY.draft, output: DEMO_COPY.draft }, { silent: true });
      const a = stampDemo(addNode("atomize", 80 + CX, 200, { model: dm.atom, route: "decentralized" }, { silent: true }), { output: DEMO_COPY.atoms, latency: 200, where: "Decentralized mesh", route: "decentralized" });
      const c = stampDemo(addNode("checker", 80 + CX * 2, 80, { model: dm.checker, route: "decentralized" }, { silent: true }), { output: DEMO_COPY.check, latency: 510, where: "Decentralized mesh", route: "decentralized" });
      const v = stampDemo(addNode("validator", 80 + CX * 2, 80 + RY, { model: dm.validator, route: "decentralized" }, { silent: true }), { output: DEMO_COPY.valid, latency: 470, where: "Decentralized mesh", route: "decentralized" });
      const w = stampDemo(addNode("watcher", 80 + CX * 2, 80 + RY * 2, { model: dm.watcher, route: "decentralized" }, { silent: true }), { output: DEMO_COPY.watch, latency: 495, where: "Decentralized mesh", route: "decentralized" });
      const wit = stampDemo(addNode("witness", 80 + CX * 3, 80 + RY, { model: dm.witness, route: "decentralized" }, { silent: true }), { output: "WITNESS\nc2 CONTEST · zero-harm claim premature.\nc5 SUPPORT keep desk-only.\nPattern matches Watcher.", latency: 430, where: "Decentralized mesh", route: "decentralized" });
      const g = stampDemo(addNode("gate", 80 + CX * 4, 80 + RY, {}, { silent: true }), { output: DEMO_COPY.gate_review, latency: 19, where: "Publish gate" });
      const o = stampDemo(addNode("output", 80 + CX * 5, 80 + RY, {}, { silent: true }), { output: "PLANE CONTEST · demo\nChecker: soft UNKNOWN on casualties\nValidator: REVIEW · hedge c2\nWatcher: CONTEST premature absolution\nWitness: aligns with Watcher\n→ Gate REVIEW — do not average votes", latency: 10 });
      state.edges = [
        { id: uid("e"), from: p.id, to: a.id, rel: "related" },
        { id: uid("e"), from: a.id, to: c.id, rel: "related" },
        { id: uid("e"), from: a.id, to: v.id, rel: "related" },
        { id: uid("e"), from: a.id, to: w.id, rel: "related" },
        { id: uid("e"), from: a.id, to: wit.id, rel: "related" },
        { id: uid("e"), from: c.id, to: g.id, rel: "supports" },
        { id: uid("e"), from: v.id, to: g.id, rel: "related" },
        { id: uid("e"), from: w.id, to: g.id, rel: "contests" },
        { id: uid("e"), from: wit.id, to: g.id, rel: "contests" },
        { id: uid("e"), from: g.id, to: o.id, rel: "related" },
      ];
      state.regions = [
        { id: uid("r"), x: 0, y: 0, w: 100, h: 100, route: "decentralized", title: "Plane rack", runsOn: "Decentralized · interesting models", nodeIds: [c.id, v.id, w.id, wit.id] },
      ];
    } else if (name === "vision") {
      state.cam = { x: -10, y: -20, z: 0.55 };
      addNode("note", 40, 20, { text: `VISION CHECK · filled placeholder\nVision model: ${short(dm.vision)}\nWatcher: ${short(dm.watcher)} · Checker: ${short(dm.checker)}\nAttach a real image to replace the OCR stub.` }, { silent: true });
      const p = addNode("prompt", 80, 200, { text: "Describe what is visible. List unverifiable claims separately. Flag arithmetic.", output: "VISION ASK\nDescribe visible content\nSeparate unverifiable claims\nFlag arithmetic" }, { silent: true });
      const vis = stampDemo(addNode("vision", 80 + CX, 200, { model: dm.vision, route: "decentralized", text: "Inspect the attached image. Flag arithmetic. Prefer UNKNOWN on authenticity." }, { silent: true }), { output: DEMO_COPY.vision_out, latency: 980, where: "Decentralized mesh", route: "decentralized" });
      const calc = stampDemo(addNode("calc", 80 + CX * 2, 120, { route: "local" }, { silent: true }), { output: "CALC CHECK\nNumbers found: 14,200\nSum of extracted numbers: 14200\nLine-item sum: (not provided in placeholder)\nVerdict: verify prose totals against these figures before publish.\n[placeholder · no real image yet]", latency: 8, where: "Local · this computer", route: "local" });
      const w = stampDemo(addNode("watcher", 80 + CX * 2, 120 + RY, { model: dm.watcher, route: "decentralized" }, { silent: true }), { output: "WATCHER · vision\nCONTEST · handwritten total lacks primary line items.\nUNKNOWN · stamp authenticity.\nSUPPORT · page appears to be a ledger photo.\nDo not publish 14,200 as verified.", latency: 430, where: "Decentralized mesh", route: "decentralized" });
      const chk = stampDemo(addNode("checker", 80 + CX * 2, 120 + RY * 2, { model: dm.checker, route: "decentralized" }, { silent: true }), { output: "CHECKER · vision\nAmount 14,200: UNKNOWN without line items.\nStamp: UNKNOWN.\nDocument type ledger: SUPPORT (visual class only).", latency: 410, where: "Decentralized mesh", route: "decentralized" });
      const g = stampDemo(addNode("gate", 80 + CX * 3, 120 + RY, {}, { silent: true }), { output: "GATE: review\nReason: arithmetic + authenticity soft.\nAttach real image → re-run before seal.", latency: 15 });
      const o = stampDemo(addNode("output", 80 + CX * 4, 120 + RY, {}, { silent: true }), { output: "VISION PACKET · demo\nPlaceholder OCR in place.\nAttach real image → ▶ Run replaces this.\nContest on 14,200 preserved.", latency: 9 });
      state.edges = [
        { id: uid("e"), from: p.id, to: vis.id, rel: "related" },
        { id: uid("e"), from: vis.id, to: calc.id, rel: "related" },
        { id: uid("e"), from: vis.id, to: w.id, rel: "contests" },
        { id: uid("e"), from: vis.id, to: chk.id, rel: "related" },
        { id: uid("e"), from: calc.id, to: g.id, rel: "supports" },
        { id: uid("e"), from: w.id, to: g.id, rel: "contests" },
        { id: uid("e"), from: chk.id, to: g.id, rel: "related" },
        { id: uid("e"), from: g.id, to: o.id, rel: "related" },
      ];
      state.regions = [
        { id: uid("r"), x: 0, y: 0, w: 100, h: 100, route: "decentralized", title: "Vision lane", runsOn: "Mesh · VL + plane models", nodeIds: [vis.id, calc.id, w.id, chk.id] },
      ];
    } else if (name === "phones") {
      state.cam = { x: -20, y: -30, z: 0.5 };
      addNode("note", 40, 20, { text: `PHONE FIELD · filled demo\nPhones as camera sources + on-device compute.\nMira: bridge shot · Desk Android: ledger scan.` }, { silent: true });
      const hostM = addNode("note", 80, 180, { text: phoneProfile("phone-mira").card, route: "phone", phone: "phone-mira", machine: "phone-mira" }, { silent: true });
      const phM = stampDemo(addNode("phone", 80 + CX, 200, { phone: "phone-mira", machine: "phone-mira", route: "phone", image: phoneSampleImage("bridge") }, { silent: true }), { output: "PHONE CAPTURE · phone-mira\nBridge south approach · 00:14\nGPS tagged · HDR on\nReady for Vision / Checker", latency: 38, where: "phone-mira · field", route: "phone", machine: "phone-mira" });
      const vis = stampDemo(addNode("vision", 80 + CX * 2, 200, { model: dm.vision, route: "phone", phone: "phone-mira", machine: "phone-mira", image: phoneSampleImage("bridge"), text: "Describe the phone capture. Flag unverifiable claims." }, { silent: true }), { output: "VISION · from phone-mira\n• Night bridge span · emergency lighting\n• Barriers confirm closure\n• No crowd / EMS visible\n• Casualty claim: UNKNOWN from image alone", latency: 920, where: "phone-mira → vision", route: "phone", machine: "phone-mira" });
      const hostD = addNode("note", 80, 200 + RY + 40, { text: phoneProfile("phone-desk").card, route: "phone", phone: "phone-desk", machine: "phone-desk" }, { silent: true });
      const phD = stampDemo(addNode("phone", 80 + CX, 200 + RY + 60, { phone: "phone-desk", machine: "phone-desk", route: "phone", image: phoneSampleImage("ledger") }, { silent: true }), { output: "PHONE CAPTURE · phone-desk\nLedger page · stamped\nHandwritten 14,200 visible\nDoc-mode scan ready", latency: 44, where: "phone-desk · newsroom", route: "phone", machine: "phone-desk" });
      const calc = stampDemo(addNode("calc", 80 + CX * 2, 200 + RY + 40, { route: "local" }, { silent: true }), { output: "CALC · from phone ledger\nNumbers: 14,200\nVerify before publish.", latency: 9, where: "Local", route: "local" });
      const chk = stampDemo(addNode("checker", 80 + CX * 2, 200 + RY + 40 + Math.floor(RY * 0.85), { model: dm.checker, route: "phone", phone: "phone-desk", machine: "phone-desk" }, { silent: true }), { output: "CHECKER · phone-desk\n14,200: UNKNOWN without line items\nStamp: UNKNOWN authenticity\nLedger class: SUPPORT (visual)", latency: 480, where: "phone-desk · on-device", route: "phone", machine: "phone-desk" });
      const g = stampDemo(addNode("gate", 80 + CX * 3 + 40, 200 + Math.floor(RY / 2), {}, { silent: true }), { output: "GATE: review\nPhone evidence soft on harm + arithmetic.\nKeep frames in ProofPath packet.", latency: 16 });
      const o = stampDemo(addNode("output", 80 + CX * 4 + 40, 200 + Math.floor(RY / 2), {}, { silent: true }), { output: "PHONE PACKET · demo\nMira bridge frame + desk ledger frame\nWhere-tags: phone-mira · phone-desk\nPin pending · samples filled", latency: 10 });
      state.edges = [
        { id: uid("e"), from: phM.id, to: vis.id, rel: "related" },
        { id: uid("e"), from: vis.id, to: g.id, rel: "related" },
        { id: uid("e"), from: phD.id, to: calc.id, rel: "related" },
        { id: uid("e"), from: phD.id, to: chk.id, rel: "related" },
        { id: uid("e"), from: calc.id, to: g.id, rel: "supports" },
        { id: uid("e"), from: chk.id, to: g.id, rel: "contests" },
        { id: uid("e"), from: g.id, to: o.id, rel: "related" },
      ];
      state.regions = [
        { id: uid("r"), x: 0, y: 0, w: 100, h: 100, route: "phone", machine: "phone-mira", placeholder: true, title: "Mira's iPhone", runsOn: "South approach · field", nodeIds: [hostM.id, phM.id, vis.id] },
        { id: uid("r"), x: 0, y: 0, w: 100, h: 100, route: "phone", machine: "phone-desk", placeholder: true, title: "Desk Android", runsOn: "Newsroom · desk row B", nodeIds: [hostD.id, phD.id, calc.id, chk.id] },
      ];

    } else if (name === "scripts") {
      state.cam = { x: 20, y: 10, z: 0.55 };
      setPrivate(true);
      addNode("note", 40, 20, {
        text: "MULTI-LANG SNAP-IN · local auto\nPython / JS / C / Rust / … any ready language.\nWebsite installs Ollama for you · Scripts menu places blocks.",
      }, { silent: true });
      const p = addNode("prompt", 80, 200, {
        text: "Desk note: ferry diverted 14,200 passengers overnight; two hospitals reported 48 and 61 arrivals. Verify arithmetic before publish.",
        route: "local",
        output: "Desk note: ferry diverted 14,200 passengers overnight; two hospitals reported 48 and 61 arrivals. Verify arithmetic before publish.",
      }, { silent: true });
      const py = stampDemo(addNode("script", 80 + CX, 160, { route: "local", lang: "python" }, { silent: true }), {
        output: "numbers=[14200, 48, 61]\nsum=14309",
        explain: "Python regex integers → sum (3 values).",
        latency: 18,
        where: "Local · python",
        route: "local",
      });
      const js = stampDemo(addNode("script", 80 + CX, 160 + RY, { route: "local", lang: "javascript" }, { silent: true }), {
        output: "numbers=[14200,48,61]\nsum=14309",
        explain: "Node parsed 3 integers locally.",
        latency: 22,
        where: "Local · javascript",
        route: "local",
      });
      const c = stampDemo(addNode("script", 80 + CX * 2, 160, { route: "local", lang: "c" }, { silent: true }), {
        output: "numbers=3 sum=14309",
        explain: "C walker summed ints locally.",
        latency: 24,
        where: "Local · c",
        route: "local",
      });
      const g = stampDemo(addNode("gate", 80 + CX * 2, 160 + RY, { route: "local" }, { silent: true }), {
        output: "GATE: review\nReason: script metrics agree on sum=14309 — still human-check prose totals.\nκ̂ from arithmetic path.",
        latency: 8,
        where: "Local · this computer",
        route: "local",
      });
      const o = stampDemo(addNode("output", 80 + CX * 3, 160 + Math.floor(RY / 2), { route: "local" }, { silent: true }), {
        output: "SCRIPT PACKET\nPython + JS + C agree on sum=14309.\nExplain fields preserved for ProofPath seal.",
        latency: 6,
        where: "Local · merge",
      });
      state.edges = [
        { id: uid("e"), from: p.id, to: py.id, rel: "related" },
        { id: uid("e"), from: p.id, to: js.id, rel: "related" },
        { id: uid("e"), from: p.id, to: c.id, rel: "related" },
        { id: uid("e"), from: py.id, to: g.id, rel: "supports" },
        { id: uid("e"), from: js.id, to: g.id, rel: "supports" },
        { id: uid("e"), from: c.id, to: g.id, rel: "supports" },
        { id: uid("e"), from: g.id, to: o.id, rel: "related" },
      ];
      state.regions = [
        { id: uid("r"), x: 0, y: 0, w: 100, h: 100, route: "local", title: "Local scripts", runsOn: "This computer · auto", nodeIds: [p.id, py.id, js.id, c.id, g.id] },
      ];

    } else {
      seedWelcome();
      return;
    }
    save();
    renderNodes();
    drawRegions();
    applyCam();
    fitView();
    renderInspector();
    setStatus(`Demo · ${name} · roomy layout`);
    setTimeout(() => setStatus("", false), 2200);
  }


  function importDeskPacket() {
    try {
      const raw = localStorage.getItem("noeti_canvas_desk_import");
      if (!raw) return false;
      const packet = JSON.parse(raw);
      localStorage.removeItem("noeti_canvas_desk_import");
      pushUndo();
      state = { nodes: [], edges: [], regions: [], cam: { x: 40, y: 40, z: 0.85 } };
      selectedId = null;
      const localModel = () => models.find((m) => m.on_node)?.id || models[0]?.id || "";
      const note = addNode("note", 20, 20, { text: "Imported from Desk\n" + (packet.query || "").slice(0, 180) }, { silent: true });
      const p = addNode("prompt", 280, 60, { text: packet.query || packet.reply || "Desk import" }, { silent: true });
      const m = addNode("model", 620, 40, { model: packet.worker_model || localModel(), output: packet.reply || "" }, { silent: true });
      const a = addNode("atomize", 960, 40, { model: localModel(), output: (packet.claims || []).map((c, i) => `c${i + 1}: ${typeof c === "string" ? c : c.text || c.claim || ""}`).filter((x) => x.length > 4).join("\n") }, { silent: true });
      const c = addNode("checker", 620, 280, { model: localModel() }, { silent: true });
      const v = addNode("validator", 960, 280, { model: localModel() }, { silent: true });
      const w = addNode("watcher", 1300, 280, { model: localModel() }, { silent: true });
      const g = addNode("gate", 1300, 60, { output: `GATE: ${packet.summary?.publish_gate || "review"}` }, { silent: true });
      const o = addNode("output", 1640, 80, { output: packet.reply || "" }, { silent: true });
      // Prefill plane outputs from judgements when present
      const rows = packet.judgements || [];
      if (rows.length) {
        const byRole = { checker: [], validator: [], watcher: [] };
        rows.forEach((row) => {
          (row.judges || []).forEach((j) => {
            const role = (j.role || j.label || "").toLowerCase();
            const line = `${row.claim}\n${(j.verdict || "").toUpperCase()} · ${(j.reason || "").slice(0, 160)}`;
            if (role.includes("check")) byRole.checker.push(line);
            else if (role.includes("valid")) byRole.validator.push(line);
            else if (role.includes("watch")) byRole.watcher.push(line);
          });
        });
        if (byRole.checker.length) c.data.output = byRole.checker.join("\n\n");
        if (byRole.validator.length) v.data.output = byRole.validator.join("\n\n");
        if (byRole.watcher.length) w.data.output = byRole.watcher.join("\n\n");
      }
      state.edges = [
        { id: uid("e"), from: p.id, to: m.id, rel: "related" },
        { id: uid("e"), from: m.id, to: a.id, rel: "related" },
        { id: uid("e"), from: a.id, to: c.id, rel: "related" },
        { id: uid("e"), from: a.id, to: v.id, rel: "related" },
        { id: uid("e"), from: a.id, to: w.id, rel: "related" },
        { id: uid("e"), from: c.id, to: g.id, rel: "supports" },
        { id: uid("e"), from: v.id, to: g.id, rel: "related" },
        { id: uid("e"), from: w.id, to: g.id, rel: "contests" },
        { id: uid("e"), from: g.id, to: o.id, rel: "related" },
      ];
      void note;
      save();
      renderNodes();
      applyCam();
      fitView();
      setStatus("Desk → Canvas import ready");
      setTimeout(() => setStatus("", false), 2200);
      return true;
    } catch (err) {
      console.warn("desk import failed", err);
      return false;
    }
  }

  async function runGraph(opts = {}) {
    if (running) return;
    running = true;
    document.getElementById("btnStop").hidden = false;
    document.getElementById("btnRun").disabled = true;
    document.getElementById("btnRunSelected").disabled = true;
    state.edges.forEach((e) => { e.active = false; });
    state.nodes.forEach((n) => {
      markNode(n.id, "is-done", false);
      markNode(n.id, "is-error", false);
    });
    let { order, skipped } = topoOrder();
    if (skipped.length) {
      setStatus(`Cycle detected · ${skipped.length} block(s) skipped until wires are acyclic`);
    }
    if (opts.fromSelected && selectedId) {
      const keep = reachableFrom(selectedId);
      order = order.filter((id) => keep.has(id));
    }
    const runnable = order.filter((id) => {
      const n = state.nodes.find((x) => x.id === id);
      return n && n.type !== "note";
    });
    setProgress(0, true);
    setStatus(`Running ${runnable.length} blocks…`);
    let done = 0;
    try {
      for (const id of order) {
        if (!running) break;
        const node = state.nodes.find((n) => n.id === id);
        if (!node || node.type === "note") continue;
        state.edges.forEach((e) => { e.active = e.to === id || e.from === id; });
        drawWires();
        setStatus(`Running · ${jobDef(node.type).label}`);
        await runNode(node);
        markNode(node.id, "is-done", true);
        done += 1;
        setProgress((done / Math.max(1, runnable.length)) * 100, true);
        save();
        if (selectedId === node.id) renderInspector();
      }
      setStatus(running ? `Done · ${done} blocks` : "Stopped");
      if (running && done > 0) {
        setLoopStep("seal");
        showLoopTray("Run complete · Seal to mint a shareable proof");
      }
      setTimeout(() => setStatus("", false), 2200);
    } catch (err) {
      setStatus(err.message || "Run failed");
    } finally {
      running = false;
      state.edges.forEach((e) => { e.active = false; });
      drawWires();
      setTimeout(() => setProgress(0, false), 600);
      document.getElementById("btnStop").hidden = true;
      document.getElementById("btnRun").disabled = false;
      document.getElementById("btnRunSelected").disabled = false;
      if (done > 0) {
        lastRunMeta = { ms: Date.now(), blocks: done, private: privateLocal };
        pushHistory({
          title: (state.nodes.find((n) => n.type === "prompt")?.data?.text || "Canvas run").slice(0, 80),
          at: new Date().toISOString().replace("T", " ").slice(0, 19),
          private: privateLocal,
          snapshot: JSON.parse(JSON.stringify(state)),
        });
      }
      renderNodes();
      renderInspector();
    }
  }

  function setInspectorCollapsed(on, { persist = true } = {}) {
    inspCollapsed = !!on;
    els.app?.classList.toggle("insp-collapsed", inspCollapsed);
    els.app?.classList.toggle("insp-open", !inspCollapsed);
    const reopen = document.getElementById("btnInspReopen");
    if (reopen) reopen.hidden = !inspCollapsed;
    const tog = document.getElementById("btnToggleInsp");
    if (tog) {
      tog.classList.toggle("is-on", !inspCollapsed);
      tog.setAttribute("aria-pressed", inspCollapsed ? "false" : "true");
      tog.textContent = inspCollapsed ? "Inspect" : "Inspect";
    }
    if (persist) {
      try { localStorage.setItem("noeti_canvas_insp", inspCollapsed ? "0" : "1"); } catch (_) {}
    }
    // Recenter wires after layout change
    requestAnimationFrame(() => { try { drawWires(); applyCam(); } catch (_) {} });
  }

  function selectNode(id) {
    const same = selectedId === id;
    selectedId = id;
    if (id) {
      if (!selectedIds.has(id) || selectedIds.size <= 1) selectedIds = new Set([id]);
    } else {
      selectedIds = new Set();
    }
    document.querySelectorAll(".cv-node").forEach((x) => {
      x.classList.toggle("is-selected", x.dataset.id === id || selectedIds.has(x.dataset.id));
    });
    if (id && inspCollapsed) setInspectorCollapsed(false);
    els.app?.classList.toggle("insp-open", !inspCollapsed);
    if (!same) renderInspector();
    updateOpenSurfaceBtn();
  }

  function surfaceKindFor(type) {
    if (type === "brain") return "fs";
    if (type === "script" || type === "script_py" || type === "script_c" || type === "code") return "editor";
    return "chat";
  }

  function updateOpenSurfaceBtn() {
    const btn = document.getElementById("btnOpenSurface");
    if (!btn) return;
    const n = state.nodes.find((x) => x.id === selectedId);
    if (!n) { btn.hidden = true; return; }
    btn.hidden = false;
    const kind = surfaceKindFor(n.type);
    btn.textContent = kind === "editor" ? "Open Editor" : kind === "fs" ? "Open Files" : "Open Chat";
  }

  let surfaceNodeId = null;
  let surfaceMode = "auto";
  let surfFsState = null;
  let surfFsRaf = 0;

  function closeSurface() {
    const el = document.getElementById("cvSurface");
    if (el) el.hidden = true;
    els.app?.classList.remove("surface-open");
    surfaceNodeId = null;
    surfFsState = null;
    if (surfFsRaf) { cancelAnimationFrame(surfFsRaf); surfFsRaf = 0; }
    requestAnimationFrame(() => { try { drawWires(); applyCam(); } catch (_) {} });
  }

  function openSurface(nodeId, forceMode) {
    const n = state.nodes.find((x) => x.id === nodeId);
    if (!n) return;
    selectNode(n.id);
    surfaceNodeId = n.id;
    surfaceMode = forceMode || "auto";
    const el = document.getElementById("cvSurface");
    if (!el) return;
    el.hidden = false;
    els.app?.classList.add("surface-open");
    setInspectorCollapsed(true);
    renderSurface();
    requestAnimationFrame(() => { try { drawWires(); applyCam(); } catch (_) {} });
  }

  function activeSurfaceMode() {
    if (surfaceMode && surfaceMode !== "auto") return surfaceMode;
    const n = state.nodes.find((x) => x.id === surfaceNodeId);
    return surfaceKindFor(n?.type || "prompt");
  }

  function renderSurface() {
    const n = state.nodes.find((x) => x.id === surfaceNodeId);
    if (!n) { closeSurface(); return; }
    const mode = activeSurfaceMode();
    const def = jobDef(n.type);
    const modeEl = document.getElementById("cvSurfaceMode");
    const titleEl = document.getElementById("cvSurfaceTitle");
    if (modeEl) modeEl.textContent = mode === "editor" ? "Editor" : mode === "fs" ? "Filesystem" : "Chat";
    if (titleEl) titleEl.textContent = def.label + (n.data.model ? ` · ${n.data.model}` : "");

    document.querySelectorAll("[data-surf-tab]").forEach((t) => {
      t.classList.toggle("is-on", t.getAttribute("data-surf-tab") === surfaceMode);
    });

    const ed = document.getElementById("cvSurfaceEditor");
    const ch = document.getElementById("cvSurfaceChat");
    const fs = document.getElementById("cvSurfaceFs");
    if (ed) ed.hidden = mode !== "editor";
    if (ch) ch.hidden = mode !== "chat";
    if (fs) fs.hidden = mode !== "fs";

    if (mode === "editor") fillSurfaceEditor(n);
    if (mode === "chat") fillSurfaceChat(n);
    if (mode === "fs") startSurfaceFs();
  }

  function fillSurfaceEditor(n) {
    const langSel = document.getElementById("cvSurfLang");
    const code = document.getElementById("cvSurfCode");
    const out = document.getElementById("cvSurfOut");
    if (langSel) {
      const langNow = normalizeLang(n.data.lang || (n.type === "code" ? "python" : "python"));
      langSel.innerHTML = (langCatalog.length ? langCatalog : FALLBACK_LANGS).map((l) =>
        `<option value="${escapeAttr(l.id)}" ${l.id === langNow ? "selected" : ""}>${escapeHtml(l.label)}</option>`
      ).join("");
    }
    if (code) {
      code.value = n.data.source || n.data.text || n.data.output || defaultSourceFor(n.data.lang || "python");
    }
    if (out) out.textContent = n.data.output ? String(n.data.output) : "Ready · Run on your PC.";
  }

  function fillSurfaceChat(n) {
    const log = document.getElementById("cvSurfChatLog");
    if (!log) return;
    const seed = (n.data.output || n.data.text || "").trim();
    log.innerHTML = "";
    const intro = document.createElement("div");
    intro.className = "cv-surf-msg bot";
    intro.textContent = seed
      ? `Block context loaded (${jobDef(n.type).label}). Ask to rewrite, contest, or expand.`
      : `Chat against this ${jobDef(n.type).label} block. Double-click any block to open its surface.`;
    log.appendChild(intro);
    if (seed) {
      const ctx = document.createElement("div");
      ctx.className = "cv-surf-msg bot";
      ctx.textContent = seed.slice(0, 1200);
      log.appendChild(ctx);
    }
  }

  function appendSurfMsg(role, text) {
    const log = document.getElementById("cvSurfChatLog");
    if (!log) return;
    const el = document.createElement("div");
    el.className = "cv-surf-msg " + (role === "user" ? "user" : "bot");
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  async function surfaceAsk(q) {
    const n = state.nodes.find((x) => x.id === surfaceNodeId);
    if (!n || !q.trim()) return;
    appendSurfMsg("user", q);
    const inEl = document.getElementById("cvSurfChatIn");
    if (inEl) inEl.value = "";
    appendSurfMsg("bot", "…");
    const log = document.getElementById("cvSurfChatLog");
    const pending = log?.lastElementChild;
    try {
      const ctx = [
        `You are helping inside Noeti Canvas on a "${n.type}" block.`,
        n.data.text ? `Block text:\n${n.data.text}` : "",
        n.data.output ? `Last output:\n${n.data.output}` : "",
        n.data.source ? `Source:\n${n.data.source.slice(0, 4000)}` : "",
      ].filter(Boolean).join("\n\n");
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          message: q,
          system: ctx,
          model: n.data.model || undefined,
          temperature: n.data.temp ?? 0.45,
          private: !!n.data.private || privateLocal,
        }),
      });
      const data = await res.json().catch(() => ({}));
      const reply = data.reply || data.output || data.message || JSON.stringify(data);
      if (pending) pending.textContent = String(reply);
      else appendSurfMsg("bot", String(reply));
      writeOut(n, String(reply));
      save();
    } catch (err) {
      if (pending) pending.textContent = String(err.message || err);
    }
  }

  async function surfaceRunScript() {
    const n = state.nodes.find((x) => x.id === surfaceNodeId);
    const code = document.getElementById("cvSurfCode");
    const langSel = document.getElementById("cvSurfLang");
    const out = document.getElementById("cvSurfOut");
    if (!n || !code) return;
    const source = code.value;
    const lang = normalizeLang(langSel?.value || n.data.lang || "python");
    n.data.source = source;
    n.data.lang = lang;
    if (out) out.textContent = "Running…";
    try {
      const res = await fetch("/api/canvas/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          lang, source, timeout: 30,
          where: n.data.route === "centralized" ? "server" : "pc",
          prefer_device: true,
          meta: { node: n.id, surface: "canvas-editor" },
        }),
      });
      const data = await res.json().catch(() => ({}));
      const text = data.output ?? data.stdout ?? data.message ?? JSON.stringify(data);
      if (out) out.textContent = (data.ok ? "✓ " : "✗ ") + String(text);
      if (data.explain) n.data.explain = data.explain;
      writeOut(n, String(text));
      save();
    } catch (err) {
      if (out) out.textContent = String(err.message || err);
    }
  }

  function surfaceApplyEditor() {
    const n = state.nodes.find((x) => x.id === surfaceNodeId);
    const code = document.getElementById("cvSurfCode");
    const langSel = document.getElementById("cvSurfLang");
    if (!n || !code) return;
    pushUndo();
    n.data.source = code.value;
    if (langSel) n.data.lang = normalizeLang(langSel.value);
    if (n.type === "code" || n.type === "note" || n.type === "prompt") n.data.text = code.value;
    save();
    renderNodes();
    selectNode(n.id);
    setStatus("Saved to block");
    setTimeout(() => setStatus("", false), 1200);
  }

  function buildSurfFsGraph() {
    const files = window.NoetiBrain?.listFiles?.() || [];
    const dirs = new Map();
    const nodes = [];
    const links = [];
    const ensure = (path) => {
      if (dirs.has(path)) return dirs.get(path);
      const n = { id: "d:" + path, path, label: path === "·" ? "root" : path.split("/").pop(), kind: "dir", x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
      dirs.set(path, n); nodes.push(n); return n;
    };
    const root = ensure("·");
    files.forEach((f) => {
      const parts = String(f.path || "").split("/");
      let parent = root; let acc = "";
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? acc + "/" + parts[i] : parts[i];
        const d = ensure(acc);
        if (parent !== d && !links.find((l) => l.a === parent && l.b === d)) links.push({ a: parent, b: d });
        parent = d;
      }
      const file = { id: "f:" + f.path, path: f.path, label: parts[parts.length - 1], kind: "file", x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
      nodes.push(file);
      links.push({ a: parent, b: file });
    });
    const n = nodes.length || 1;
    nodes.forEach((node, i) => {
      const a = (i / n) * Math.PI * 2;
      const b = (i * 0.7) % Math.PI - Math.PI / 2;
      const r = 0.9 + (node.kind === "dir" ? 0.4 : 1.0) * (0.5 + Math.random() * 0.5);
      node.x = Math.cos(a) * Math.cos(b) * r;
      node.y = Math.sin(b) * r * 0.85;
      node.z = Math.sin(a) * Math.cos(b) * r;
    });
    return { nodes, links, yaw: 0.7, pitch: 0.35, scale: 1.5, camX: 0, camY: 0, autoSpin: true };
  }

  function projectSurf(n, g, w, h) {
    const cy = Math.cos(g.yaw); const sy = Math.sin(g.yaw);
    const cp = Math.cos(g.pitch); const sp = Math.sin(g.pitch);
    let x = n.x * cy - n.z * sy;
    let z = n.x * sy + n.z * cy;
    let y = n.y;
    const y2 = y * cp - z * sp;
    z = y * sp + z * cp;
    y = y2;
    const depth = z + 2.4;
    const scale = (Math.min(w, h) * 0.74 * g.scale) / Math.max(0.45, depth);
    return {
      sx: w * 0.5 + g.camX + x * scale,
      sy: h * 0.5 + g.camY + y * scale,
      depth,
      r: Math.max(3.5, (n.kind === "dir" ? 11 : 6.5) * (1.2 / Math.max(0.55, depth)) * g.scale),
    };
  }

  function paintSurfFs() {
    const canvas = document.getElementById("cvSurfFsCanvas");
    if (!canvas || canvas.closest("[hidden]")) return;
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!surfFsState) surfFsState = buildSurfFsGraph();
    const g = surfFsState;
    if (g.autoSpin && !g.orbit) g.yaw += 0.005;

    for (let iter = 0; iter < 8; iter++) {
      for (const n of g.nodes) { n.vx *= 0.86; n.vy *= 0.86; n.vz *= 0.86; n.vx -= n.x * 0.008; n.vy -= n.y * 0.008; n.vz -= n.z * 0.008; }
      for (let i = 0; i < g.nodes.length; i++) {
        for (let j = i + 1; j < g.nodes.length; j++) {
          const a = g.nodes[i]; const b = g.nodes[j];
          let dx = b.x - a.x; let dy = b.y - a.y; let dz = b.z - a.z;
          let dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
          const min = a.kind === "dir" || b.kind === "dir" ? 0.5 : 0.34;
          if (dist < min) {
            const f = ((min - dist) / dist) * 0.08;
            a.vx -= dx * f; a.vy -= dy * f; a.vz -= dz * f;
            b.vx += dx * f; b.vy += dy * f; b.vz += dz * f;
          }
        }
      }
      for (const l of g.links) {
        const dx = l.b.x - l.a.x; const dy = l.b.y - l.a.y; const dz = l.b.z - l.a.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
        const ideal = l.b.kind === "file" ? 0.58 : 0.75;
        const f = ((dist - ideal) / dist) * 0.02;
        l.a.vx += dx * f; l.a.vy += dy * f; l.a.vz += dz * f;
        l.b.vx -= dx * f; l.b.vy -= dy * f; l.b.vz -= dz * f;
      }
      for (const n of g.nodes) { n.x += n.vx; n.y += n.vy; n.z += n.vz; }
    }

    const dark = document.documentElement.getAttribute("data-theme") === "black"
      || document.body?.getAttribute("data-theme") === "black";
    ctx.clearRect(0, 0, w, h);
    if (dark) {
      ctx.fillStyle = "#07090d";
      ctx.fillRect(0, 0, w, h);
      const grd = ctx.createRadialGradient(w * 0.5, h * 0.45, 20, w * 0.5, h * 0.5, Math.min(w, h) * 0.6);
      grd.addColorStop(0, "rgba(45,212,191,0.05)");
      grd.addColorStop(1, "rgba(7,9,13,0)");
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, w, h);
    }
    const projected = g.nodes.map((n) => ({ n, p: projectSurf(n, g, w, h) }));
    projected.sort((a, b) => a.p.depth - b.p.depth);
    g._proj = projected;

    for (const l of g.links) {
      const a = projectSurf(l.a, g, w, h);
      const b = projectSurf(l.b, g, w, h);
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.strokeStyle = dark ? "rgba(148,163,184,0.28)" : "rgba(17,17,17,0.16)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    for (const { n, p } of projected) {
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, p.r, 0, Math.PI * 2);
      ctx.fillStyle = dark
        ? (n.kind === "dir" ? "#94a3b8" : "#2dd4bf")
        : (n.kind === "dir" ? "#555" : "#222");
      ctx.fill();
      if (p.depth < 3.3) {
        ctx.fillStyle = dark ? "rgba(226,232,240,0.85)" : "rgba(30,30,30,0.8)";
        ctx.font = `${Math.max(11, 13 / Math.max(0.7, p.depth))}px "IBM Plex Sans", sans-serif`;
        ctx.fillText(n.label, p.sx + p.r + 4, p.sy + 4);
      }
    }
  }

  function startSurfaceFs() {
    const hint = document.getElementById("cvSurfFsHint");
    const files = window.NoetiBrain?.listFiles?.() || [];
    if (hint) hint.textContent = files.length
      ? `${files.length} files · drag to orbit · click a file → Editor`
      : "Open a folder to map files. Click a file to load it into Editor.";
    surfFsState = null;
    if (surfFsRaf) cancelAnimationFrame(surfFsRaf);
    const tick = () => {
      const fs = document.getElementById("cvSurfaceFs");
      if (!fs || fs.hidden) { surfFsRaf = 0; return; }
      paintSurfFs();
      surfFsRaf = requestAnimationFrame(tick);
    };
    surfFsRaf = requestAnimationFrame(tick);
  }

  function renderInspector() {
    if (!els.inspBody) return;
    const n = state.nodes.find((x) => x.id === selectedId);
    if (!n) {
      if (els.inspKind) els.inspKind.textContent = "Inspector";
      if (els.inspTitle) els.inspTitle.textContent = "Select a block";
      els.inspBody.innerHTML = `<p class="cv-insp-empty">Select a block — or double-click to open <strong>Editor</strong>, <strong>Chat</strong>, or <strong>Files</strong> by type.</p>`;
      if (els.inspFoot) els.inspFoot.hidden = true;
      updateOpenSurfaceBtn();
      return;
    }
    const def = jobDef(n.type);
    if (els.inspKind) els.inspKind.textContent = def.label;
    if (els.inspTitle) els.inspTitle.textContent = n.data.model || n.type;
    if (els.inspFoot) els.inspFoot.hidden = false;

    const wantsModel = ["model", "vision", "atomize", "witness", "checker", "validator", "watcher"].includes(n.type);
    const wantsText = ["note", "prompt", "system", "vision", "model"].includes(n.type);
    const wantsTemp = ["model", "vision"].includes(n.type);
    const wantsScript = n.type === "script" || n.type === "script_py" || n.type === "script_c";

    let html = "";
    const routeNow = n.data.route || resolveNodeRoute(n) || "";
    html += `<div class="cv-insp-stats">
      <div class="cv-insp-stat"><span>Type</span><strong>${escapeHtml(n.type === "script" ? "script" : n.type)}</strong></div>
      <div class="cv-insp-stat"><span>Latency</span><strong>${n.data.latency_ms != null ? n.data.latency_ms + "ms" : "—"}</strong></div>
    </div>
    <div class="cv-insp-section" style="margin-top:0.75rem">
      <label>Compute route</label>
      <select id="inspRoute">
        <option value="" ${!routeNow ? "selected" : ""}>Auto / board</option>
        <option value="private" ${routeNow === "private" ? "selected" : ""}>Private (on-node)</option>
        <option value="local" ${routeNow === "local" ? "selected" : ""}>Local (this computer)</option>
        <option value="decentralized" ${routeNow === "decentralized" ? "selected" : ""}>Decentralized (mesh)</option>
        <option value="centralized" ${routeNow === "centralized" ? "selected" : ""}>Centralized (cloud)</option>
        <option value="machine" ${routeNow === "machine" ? "selected" : ""}>Specific PC</option>
      </select>
      ${routeNow === "machine" || n.data.machine ? `<p class="cv-insp-where">Pinned · ${escapeHtml(routeDisplay("machine", n.data.machine) || "unnamed")}${String(n.data.machine || "").startsWith("pc-") ? "" : " <em>· demo</em>"}</p>` : ""}
      ${n.data.last_where ? `<p class="cv-insp-where">Last ran · ${escapeHtml(n.data.last_where)}</p>` : ""}
    </div>`;

    if (wantsScript) {
      const langNow = normalizeLang(n.data.lang || "python");
      html += `<div class="cv-insp-section">
        <label>Language</label>
        <select id="inspLang">${langCatalog.map((l) => `<option value="${escapeAttr(l.id)}" ${l.id === langNow ? "selected" : ""}>${escapeHtml(l.label)}${l.ready ? "" : " (missing)"}</option>`).join("")}</select>
        <label style="margin-top:0.65rem">Source · explainable stdin/stdout</label>
        <textarea id="inspSource" class="cv-insp-code" spellcheck="false">${escapeHtml(n.data.source || "")}</textarea>
        <p class="cv-insp-hint">Print {"ok","output","explain","metrics"} (or plain text). Wire like any block.</p>
        <button type="button" class="cv-insp-btn" id="inspResetScript">Reset template</button>
      </div>`;
      if (n.data.explain) {
        html += `<div class="cv-insp-section"><label>Why (interpretability)</label><pre class="cv-insp-out">${escapeHtml(n.data.explain)}</pre></div>`;
      }
      if (n.data.metrics && typeof n.data.metrics === "object") {
        html += `<div class="cv-insp-section"><label>Metrics</label><pre class="cv-insp-out">${escapeHtml(JSON.stringify(n.data.metrics, null, 2))}</pre></div>`;
      }
    }
    if (wantsModel) {
      html += `<div class="cv-insp-section" style="margin-top:0.85rem">
        <label>Model</label>
        <div class="cv-model-filters" id="inspModelFilters">
          <button type="button" data-mf="all" class="${modelFilter === "all" ? "is-on" : ""}">All</button>
          <button type="button" data-mf="node" class="${modelFilter === "node" ? "is-on" : ""}">On-node</button>
          <button type="button" data-mf="fast" class="${modelFilter === "fast" ? "is-on" : ""}">Fast</button>
          <button type="button" data-mf="flagship" class="${modelFilter === "flagship" ? "is-on" : ""}">Flagship</button>
        </div>
        <select id="inspModel">${modelOptions(n.data.model)}</select>
      </div>`;
    }
    if (wantsTemp) {
      html += `<div class="cv-insp-section">
        <label>Temperature</label>
        <input type="range" id="inspTemp" min="0" max="100" value="${Math.round((n.data.temp ?? 0.55) * 100)}" />
        <div class="cv-insp-row"><span>Creativity</span><em id="inspTempVal">${Number(n.data.temp ?? 0.55).toFixed(2)}</em></div>
      </div>`;
    }
    if (wantsText) {
      html += `<div class="cv-insp-section">
        <label>${n.type === "system" ? "System prompt" : n.type === "note" ? "Note" : "Text"}</label>
        <textarea id="inspText">${escapeHtml(n.data.text || "")}</textarea>
      </div>`;
    }
    html += `<div class="cv-insp-section">
      <label>Last output</label>
      <pre class="cv-insp-out">${escapeHtml(n.data.output || "(empty)")}</pre>
    </div>`;
    const edgesHere = state.edges.filter((e) => e.from === n.id || e.to === n.id);
    if (edgesHere.length) {
      html += `<div class="cv-insp-section"><label>Wires</label>`;
      edgesHere.forEach((e) => {
        const other = e.from === n.id ? e.to : e.from;
        const dir = e.from === n.id ? "→" : "←";
        html += `<div class="cv-insp-row" style="margin-top:0.35rem">
          <span>${dir} ${escapeHtml(other.slice(0, 10))} · ${escapeHtml(e.rel || "related")}</span>
          <button type="button" class="cv-insp-btn" data-cycle-edge="${e.id}" style="padding:0.2rem 0.45rem;font-size:0.7rem">Cycle</button>
        </div>`;
      });
      html += `</div>`;
    }
    if (n.type === "output") {
      html += `<div class="cv-insp-section"><button type="button" class="cv-insp-btn" id="inspSeal">Seal ProofPath</button></div>`;
    }

    els.inspBody.innerHTML = html;
    els.inspBody.querySelectorAll("[data-cycle-edge]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const edge = state.edges.find((x) => x.id === btn.dataset.cycleEdge);
        if (!edge) return;
        pushUndo();
        const order = ["related", "supports", "contests"];
        const i = order.indexOf(edge.rel || "related");
        edge.rel = order[(i + 1) % order.length];
        save();
        drawWires();
        renderInspector();
      });
    });
    document.getElementById("inspSeal")?.addEventListener("click", () => sealBoard().catch(() => {}));

    els.inspBody.querySelectorAll("[data-mf]").forEach((btn) => {
      btn.addEventListener("click", () => {
        modelFilter = btn.dataset.mf;
        renderInspector();
      });
    });
    const modelSel = document.getElementById("inspModel");
    modelSel?.addEventListener("change", () => {
      n.data.model = modelSel.value;
      save();
      renderNodes();
      selectNode(n.id);
    });
    document.getElementById("inspRoute")?.addEventListener("change", (e) => {
      pushUndo();
      const v = e.target.value;
      if (!v) {
        delete n.data.route;
        delete n.data.machine;
        delete n.data.route_placeholder;
      } else {
        n.data.route = v;
        if (v === "machine") {
          n.data.machine = n.data.machine || "this";
          n.data.route_placeholder = true;
        } else {
          delete n.data.machine;
          delete n.data.route_placeholder;
        }
        const pick = pickModelForRoute(v, n.data.model);
        if (pick) n.data.model = pick;
      }
      save();
      renderNodes();
      selectNode(n.id);
    });
    const temp = document.getElementById("inspTemp");
    temp?.addEventListener("input", () => {
      n.data.temp = Number(temp.value) / 100;
      const lab = document.getElementById("inspTempVal");
      if (lab) lab.textContent = n.data.temp.toFixed(2);
      save();
    });
    temp?.addEventListener("change", () => {
      renderNodes();
      selectNode(n.id);
    });
    const text = document.getElementById("inspText");
    text?.addEventListener("input", () => {
      n.data.text = text.value;
      save();
    });
    text?.addEventListener("change", () => {
      renderNodes();
      selectNode(n.id);
    });
    const src = document.getElementById("inspSource");
    src?.addEventListener("input", () => {
      n.data.source = src.value;
      save();
    });
    src?.addEventListener("change", () => {
      renderNodes();
      selectNode(n.id);
    });
    document.getElementById("inspResetScript")?.addEventListener("click", () => {
      pushUndo();
      const lang = normalizeLang(n.data.lang || "python");
      n.data.source = defaultSourceFor(lang);
      save();
      renderInspector();
      renderNodes();
      selectNode(n.id);
    });
    document.getElementById("inspLang")?.addEventListener("change", (e) => {
      pushUndo();
      const lang = normalizeLang(e.target.value);
      n.data.lang = lang;
      n.data.source = defaultSourceFor(lang);
      n.type = "script";
      save();
      renderInspector();
      renderNodes();
      selectNode(n.id);
    });
  }

  function duplicateSelected() {
    const n = state.nodes.find((x) => x.id === selectedId);
    if (!n) return;
    addNode(n.type, n.x + 36, n.y + 36, { ...n.data, output: "", latency_ms: undefined });
  }

  function importGraph(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || ""));
        if (!parsed?.nodes) throw new Error("Invalid canvas JSON");
        pushUndo();
        state = parsed;
        state.cam = state.cam || { x: 80, y: 60, z: 1 };
        state.edges = state.edges || [];
        state.regions = state.regions || [];
        selectedId = null;
        save();
        renderNodes();
        renderInspector();
        applyCam();
        setStatus(`Imported · ${state.nodes.length} blocks`);
        setTimeout(() => setStatus("", false), 1800);
      } catch (err) {
        setStatus(err.message || "Import failed");
      }
    };
    reader.readAsText(file);
  }

  /* -------- camera / input -------- */
  function bindViewport() {
    let panning = false;
    let last = null;
    // Touch: one-finger pan, two-finger pinch zoom
    let touchMode = null;
    let touchLast = null;
    let pinchStartDist = 0;
    let pinchStartZ = 1;
    const touchPoint = (t) => {
      const rect = els.viewport.getBoundingClientRect();
      return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    };
    const pinchDist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    els.viewport.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) {
        if (regionMode) return;
        touchMode = "pan";
        touchLast = touchPoint(e.touches[0]);
      } else if (e.touches.length === 2) {
        touchMode = "pinch";
        pinchStartDist = pinchDist(e.touches[0], e.touches[1]) || 1;
        pinchStartZ = state.cam.z;
        touchLast = null;
      }
    }, { passive: true });
    els.viewport.addEventListener("touchmove", (e) => {
      if (!touchMode) return;
      if (touchMode === "pan" && e.touches.length === 1 && touchLast) {
        e.preventDefault();
        const p = touchPoint(e.touches[0]);
        state.cam.x += p.x - touchLast.x;
        state.cam.y += p.y - touchLast.y;
        touchLast = p;
        applyCam();
      } else if (touchMode === "pinch" && e.touches.length === 2) {
        e.preventDefault();
        const dist = pinchDist(e.touches[0], e.touches[1]) || 1;
        const rect = els.viewport.getBoundingClientRect();
        const mx = ((e.touches[0].clientX + e.touches[1].clientX) / 2) - rect.left;
        const my = ((e.touches[0].clientY + e.touches[1].clientY) / 2) - rect.top;
        const oldZ = state.cam.z;
        const next = Math.min(2.2, Math.max(0.28, pinchStartZ * (dist / pinchStartDist)));
        const wx = (mx - state.cam.x) / oldZ;
        const wy = (my - state.cam.y) / oldZ;
        state.cam.z = next;
        state.cam.x = mx - wx * next;
        state.cam.y = my - wy * next;
        applyCam();
      }
    }, { passive: false });
    els.viewport.addEventListener("touchend", () => {
      if (touchMode) save();
      touchMode = null;
      touchLast = null;
    });
    els.viewport.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = els.viewport.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const oldZ = state.cam.z;
      const next = Math.min(2.2, Math.max(0.35, oldZ * (e.deltaY > 0 ? 0.92 : 1.08)));
      const wx = (mx - state.cam.x) / oldZ;
      const wy = (my - state.cam.y) / oldZ;
      state.cam.z = next;
      state.cam.x = mx - wx * next;
      state.cam.y = my - wy * next;
      applyCam();
      save();
    }, { passive: false });

    els.viewport.addEventListener("mousedown", (e) => {
      if (regionMode && e.button === 0 && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        const rect = els.viewport.getBoundingClientRect();
        marquee = {
          x0: e.clientX - rect.left,
          y0: e.clientY - rect.top,
          x1: e.clientX - rect.left,
          y1: e.clientY - rect.top,
        };
        updateMarqueeEl();
        const onMove = (ev) => {
          if (!marquee) return;
          marquee.x1 = ev.clientX - rect.left;
          marquee.y1 = ev.clientY - rect.top;
          updateMarqueeEl();
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          finishMarquee();
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return;
      }
      if (e.button === 1 || e.button === 0 && (e.metaKey || spaceHeld || els.viewport.classList.contains("force-pan") || e.target === els.viewport || e.target === els.wires || e.target?.id === "regionsLayer")) {
        panning = true;
        last = { x: e.clientX, y: e.clientY };
        els.viewport.classList.add("is-panning");
      }
    });
    window.addEventListener("mousemove", (e) => {
      if (!panning || !last) return;
      state.cam.x += e.clientX - last.x;
      state.cam.y += e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      applyCam();
    });
    window.addEventListener("mouseup", () => {
      if (panning) save();
      panning = false;
      last = null;
      els.viewport.classList.remove("is-panning");
    });

    els.viewport.addEventListener("dragover", (e) => {
      e.preventDefault();
      els.viewport.classList.add("is-drop-target");
    });
    els.viewport.addEventListener("dragleave", (e) => {
      if (e.target === els.viewport) els.viewport.classList.remove("is-drop-target");
    });
    els.viewport.addEventListener("drop", (e) => {
      e.preventDefault();
      els.viewport.classList.remove("is-drop-target");
      const type = e.dataTransfer.getData("job");
      if (!type) return;
      const p = screenToWorld(e.clientX, e.clientY);
      const lang = e.dataTransfer.getData("lang");
      if (type === "script" && lang) {
        addNode("script", p.x - 140, p.y - 40, { lang, source: defaultSourceFor(lang), route: "local" });
      } else {
        addNode(type, p.x - 140, p.y - 40);
      }
    });

    window.addEventListener("keydown", (e) => {
      const tag = document.activeElement?.tagName;
      const typing = tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || document.activeElement?.isContentEditable;
      if (e.key === " " && !typing) {
        e.preventDefault();
        spaceHeld = true;
        els.viewport?.classList.add("force-pan");
      }
      if (e.key === "Escape") {
        if (document.getElementById("cvSurface") && !document.getElementById("cvSurface").hidden) {
          closeSurface();
          return;
        }
        if (pendingRegion) {
          pendingRegion = null;
          closeDrop(document.getElementById("routePop"), 160);
        }
        closeGenerateModal();
        closePasteModal();
        closePhonePairModal();
        closeDevicePairModal();
        if (regionMode) setRegionMode(false);
        if (!typing) {
          selectedId = null;
          selectedIds = new Set();
          document.querySelectorAll(".cv-node.is-selected").forEach((x) => x.classList.remove("is-selected"));
          renderInspector();
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y" && !typing) {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.key === "Backspace" || e.key === "Delete") && (selectedId || selectedIds.size)) {
        if (typing) return;
        e.preventDefault();
        const ids = selectedIds.size ? selectedIds : new Set(selectedId ? [selectedId] : []);
        deleteNodesByIds(ids);
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.key === " ") {
        spaceHeld = false;
        if (!document.getElementById("btnDockPan")?.classList.contains("is-on")) {
          els.viewport?.classList.remove("force-pan");
        }
      }
    });
  }

  async function loadModels() {
    try {
      const res = await fetch("/api/chat/models", { cache: "no-store" });
      const data = await res.json();
      models = data.models || data || [];
      if (!Array.isArray(models)) models = [];
      if (els.meta) els.meta.textContent = `${models.length} models · board`;
    } catch (_) {
      models = [];
    }
  }

  function exportGraph() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `noeti-canvas-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function fitView() {
    if (!state.nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of state.nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + 280);
      maxY = Math.max(maxY, n.y + 160);
    }
    const rect = els.viewport.getBoundingClientRect();
    const pad = 80;
    const zw = (rect.width - pad * 2) / Math.max(200, maxX - minX);
    const zh = (rect.height - pad * 2) / Math.max(200, maxY - minY);
    state.cam.z = Math.min(1.2, Math.max(0.4, Math.min(zw, zh)));
    state.cam.x = pad - minX * state.cam.z;
    state.cam.y = pad - minY * state.cam.z;
    applyCam();
    save();
  }

  // boot
  renderPalette();
  bindViewport();
  document.getElementById("btnRun")?.addEventListener("click", () => runGraph());
  document.getElementById("btnRunSelected")?.addEventListener("click", () => {
    if (!selectedId) {
      setStatus("Select a node first");
      setTimeout(() => setStatus("", false), 1600);
      return;
    }
    runGraph({ fromSelected: true });
  });
  (function wireToolbarMore() {
    const btn = document.getElementById("btnMore");
    const menu = document.getElementById("moreMenu");
    const wrap = document.getElementById("toolbarMore");
    if (!btn || !menu) return;
    function closeMore() {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    }
    function openMore() {
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (menu.hidden) openMore();
      else closeMore();
    });
    menu.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.closest("button")) closeMore();
    });
    document.addEventListener("click", (e) => {
      if (!wrap?.contains(e.target)) closeMore();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeMore();
    });
  })();
  document.getElementById("btnStop")?.addEventListener("click", () => {
    running = false;
    abort?.abort();
    setStatus("Stopped");
  });
  document.getElementById("btnZoomIn")?.addEventListener("click", () => {
    state.cam.z = Math.min(2.2, state.cam.z * 1.1);
    applyCam(); save();
  });
  document.getElementById("btnZoomOut")?.addEventListener("click", () => {
    state.cam.z = Math.max(0.35, state.cam.z / 1.1);
    applyCam(); save();
  });
  document.getElementById("btnZoomFit")?.addEventListener("click", fitView);
  document.getElementById("btnExportGraph")?.addEventListener("click", exportGraph);
  document.getElementById("btnShareHint")?.addEventListener("click", () => {
    shareBoard();
  });
  document.getElementById("btnSeal")?.addEventListener("click", () => {
    sealBoard().catch(() => {});
  });
  document.getElementById("cvLoopDismiss")?.addEventListener("click", () => hideLoopTray(true));
  document.getElementById("loopGenerate")?.addEventListener("click", () => {
    setLoopStep("generate");
    openGenerateModal();
  });
  document.getElementById("loopRun")?.addEventListener("click", () => {
    setLoopStep("run");
    runGraph();
  });
  document.getElementById("loopSeal")?.addEventListener("click", () => {
    sealBoard().catch(() => {});
  });
  document.getElementById("loopShare")?.addEventListener("click", () => {
    shareBoard();
  });
  document.getElementById("shareToastCopy")?.addEventListener("click", async () => {
    const url = document.getElementById("shareToastUrl")?.value || "";
    const ok = await copyText(url);
    setStatus(ok ? "Copied" : "Copy failed");
    setTimeout(() => setStatus("", false), 1400);
  });
  document.getElementById("shareToastClose")?.addEventListener("click", hideShareToast);
  document.getElementById("btnDockPaste")?.addEventListener("click", () => openPasteModal());
  document.getElementById("btnDockPhone")?.addEventListener("click", () => openPhonePair(null));
  document.getElementById("btnDockDevice")?.addEventListener("click", () => openDevicePair());
  document.getElementById("btnDockBrain")?.addEventListener("click", () => {
    window.NoetiBrain?.open?.();
  });
  const syncBrainDock = () => {
    const btn = document.getElementById("btnDockBrain");
    const st = window.NoetiBrain?.getStatus?.();
    if (!btn || !st) return;
    btn.classList.toggle("brain-on", !!st.enabled);
    btn.title = st.enabled
      ? `Second Brain on · ${st.count} files`
      : "Second Brain · allow files + coding map";
  };
  window.NoetiBrain?.onChange?.(syncBrainDock);
  syncBrainDock();
  document.getElementById("btnMachineConnect")?.addEventListener("click", () => openDevicePair());
  document.getElementById("btnPhoneConnectFromZone")?.addEventListener("click", () => {
    closeDrop(document.getElementById("routePop"), 120);
    openPhonePair(null);
  });
  document.getElementById("btnDevicePairClose")?.addEventListener("click", () => {
    closeDevicePairModal();
    stopDevicePairPoll();
  });
  document.getElementById("btnDeviceCopyLink")?.addEventListener("click", async () => {
    const url = document.getElementById("devicePairUrl")?.value || "";
    const ok = await copyText(url);
    setStatus(ok ? "PC link copied" : "Copy failed");
    setTimeout(() => setStatus("", false), 1400);
  });
  document.getElementById("btnDeviceCopyCmd")?.addEventListener("click", async () => {
    const cmd = document.getElementById("deviceAgentCmd")?.value || "";
    const ok = await copyText(cmd);
    setStatus(ok ? "Command copied — paste in Terminal on that PC" : "Copy failed");
    setTimeout(() => setStatus("", false), 2200);
  });
  document.getElementById("devicePairModal")?.addEventListener("click", (e) => {
    if (e.target?.id === "devicePairModal") {
      closeDevicePairModal();
      stopDevicePairPoll();
    }
  });
  document.getElementById("btnPasteClose")?.addEventListener("click", closePasteModal);
  document.getElementById("btnPasteCancel")?.addEventListener("click", closePasteModal);
  document.getElementById("btnPasteGo")?.addEventListener("click", snapPastedScript);
  document.getElementById("btnPhonePairClose")?.addEventListener("click", closePhonePairModal);
  document.getElementById("btnPhoneCopy")?.addEventListener("click", async () => {
    const url = document.getElementById("phonePairUrl")?.value || "";
    const ok = await copyText(url);
    setStatus(ok ? "Phone link copied" : "Copy failed");
    setTimeout(() => setStatus("", false), 1400);
  });
  document.getElementById("phonePairModal")?.addEventListener("click", (e) => {
    if (e.target?.id === "phonePairModal") closePhonePairModal();
  });
  document.getElementById("btnNewCanvas")?.addEventListener("click", () => {
    if (!confirm("Clear this canvas and start fresh?")) return;
    pushUndo();
    state = { nodes: [], edges: [], regions: [], cam: { x: 80, y: 60, z: 1 } };
    selectedId = null;
    lastSeal = null;
    try { localStorage.removeItem("noeti_canvas_loop_off"); } catch (_) {}
    save();
    seedWelcome();
    applyCam();
    renderInspector();
  });
  document.getElementById("btnSampleWhere")?.addEventListener("click", () => {
    if (state.nodes?.length && !confirm("Replace this board with the Where sample?")) return;
    pushUndo();
    loadSampleWhere();
    applyCam();
    renderInspector();
  });
  document.getElementById("btnSearchCanvas")?.addEventListener("click", () => {
    els.app.classList.toggle("jobs-open");
  });
  document.getElementById("btnImportGraph")?.addEventListener("click", () => els.importFile?.click());
  els.importFile?.addEventListener("change", () => {
    const f = els.importFile.files?.[0];
    if (f) importGraph(f);
    els.importFile.value = "";
  });
  document.getElementById("fxMode")?.addEventListener("change", (e) => {
    document.body.dataset.fx = e.target.value || "flow";
    try { localStorage.setItem("noeti_canvas_fx", document.body.dataset.fx); } catch (_) {}
  });
  document.getElementById("btnInspClose")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    selectNode(null);
    setInspectorCollapsed(true);
  });
  document.getElementById("btnInspReopen")?.addEventListener("click", () => setInspectorCollapsed(false));
  document.getElementById("btnToggleInsp")?.addEventListener("click", () => {
    setInspectorCollapsed(!inspCollapsed);
  });
  document.getElementById("btnOpenSurface")?.addEventListener("click", () => {
    if (selectedId) openSurface(selectedId, "auto");
  });
  document.getElementById("cvSurfaceClose")?.addEventListener("click", closeSurface);
  document.querySelectorAll("[data-surf-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      surfaceMode = btn.getAttribute("data-surf-tab") || "auto";
      renderSurface();
    });
  });
  document.getElementById("cvSurfRun")?.addEventListener("click", () => surfaceRunScript());
  document.getElementById("cvSurfApply")?.addEventListener("click", () => surfaceApplyEditor());
  document.getElementById("cvSurfCode")?.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const ta = e.target;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const v = ta.value;
    ta.value = v.slice(0, start) + "  " + v.slice(end);
    ta.selectionStart = ta.selectionEnd = start + 2;
  });
  document.getElementById("cvSurfChatForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    surfaceAsk(document.getElementById("cvSurfChatIn")?.value || "");
  });
  document.getElementById("cvSurfFsOpen")?.addEventListener("click", async () => {
    await window.NoetiBrain?.open?.();
    surfFsState = null;
    startSurfaceFs();
  });
  (function bindSurfFsPointer() {
    const canvas = document.getElementById("cvSurfFsCanvas");
    if (!canvas) return;
    canvas.addEventListener("pointerdown", (e) => {
      if (!surfFsState) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      let hit = null;
      let best = 18;
      for (const row of (surfFsState._proj || []).slice().reverse()) {
        const d = Math.hypot(row.p.sx - x, row.p.sy - y);
        if (d < Math.max(best, row.p.r + 4)) { best = d; hit = row.n; }
      }
      if (hit?.kind === "file" && hit.path) {
        openSurface(surfaceNodeId, "editor");
        const code = document.getElementById("cvSurfCode");
        window.NoetiBrain?.readFile?.(hit.path).then((text) => {
          if (code && text != null) {
            code.value = text;
            const n = state.nodes.find((x) => x.id === surfaceNodeId);
            if (n) {
              n.data.source = text;
              n.data.text = text;
              save();
            }
          }
        });
        setStatus("Loaded · " + hit.path);
        setTimeout(() => setStatus("", false), 1600);
        return;
      }
      surfFsState.autoSpin = false;
      surfFsState.orbit = { x: e.clientX, y: e.clientY, yaw: surfFsState.yaw, pitch: surfFsState.pitch };
      canvas.setPointerCapture?.(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!surfFsState?.orbit) return;
      const dx = e.clientX - surfFsState.orbit.x;
      const dy = e.clientY - surfFsState.orbit.y;
      surfFsState.yaw = surfFsState.orbit.yaw + dx * 0.01;
      surfFsState.pitch = Math.max(-1.2, Math.min(1.2, surfFsState.orbit.pitch + dy * 0.01));
    });
    canvas.addEventListener("pointerup", () => { if (surfFsState) surfFsState.orbit = null; });
    canvas.addEventListener("wheel", (e) => {
      if (!surfFsState) return;
      e.preventDefault();
      surfFsState.scale = Math.min(2.8, Math.max(0.5, surfFsState.scale * (e.deltaY > 0 ? 0.92 : 1.08)));
    }, { passive: false });
  })();
  document.getElementById("btnDupNode")?.addEventListener("click", duplicateSelected);
  document.getElementById("btnDelNode")?.addEventListener("click", () => {
    if (!selectedId) return;
    pushUndo();
    state.nodes = state.nodes.filter((n) => n.id !== selectedId);
    state.edges = state.edges.filter((ed) => ed.from !== selectedId && ed.to !== selectedId);
    selectedId = null;
    save();
    renderNodes();
    renderInspector();
  });
  try {
    const fx = localStorage.getItem("noeti_canvas_fx");
    if (fx) {
      document.body.dataset.fx = fx;
      const sel = document.getElementById("fxMode");
      if (sel) sel.value = fx;
    }
  } catch (_) {}

  document.getElementById("btnUndo")?.addEventListener("click", undo);
  document.getElementById("btnRedo")?.addEventListener("click", redo);
  document.getElementById("btnRegionSelect")?.addEventListener("click", () => {
    if (regionMode) setRegionMode(false);
    else startWhereDraw(null);
  });
  document.querySelectorAll(".cv-menu-tab").forEach((btn) => {
    btn.addEventListener("click", () => setMenuTab(btn.dataset.tab));
  });
  document.getElementById("menuSearch")?.addEventListener("input", () => renderPalette());
  document.getElementById("btnAutoSetup")?.addEventListener("click", () => {
    setMenuTab("setup");
    setLocalPill({ message: "Installing / arming…", install: { active: true, progress: 5, message: "Starting…" } });
    bootLocalCompute().catch(() => {});
  });
  document.getElementById("btnRefreshSetup")?.addEventListener("click", () => {
    refreshLocalStatus().then(() => loadModels().catch(() => {}));
  });
  document.getElementById("localPill")?.addEventListener("click", () => {
    setMenuTab("setup");
    els.app?.classList.add("menu-open");
    document.getElementById("btnMenuToggle")?.setAttribute("aria-expanded", "true");
    const scrim = document.getElementById("menuScrim");
    if (scrim) { scrim.hidden = false; scrim.classList.add("is-on"); }
  });
  document.getElementById("btnOpenGenerate")?.addEventListener("click", () => openGenerateModal());
  document.getElementById("btnDockGenerate")?.addEventListener("click", () => openGenerateModal());
  document.getElementById("btnGenClose")?.addEventListener("click", closeGenerateModal);
  document.getElementById("btnGenCancel")?.addEventListener("click", closeGenerateModal);
  document.getElementById("btnGenGo")?.addEventListener("click", () => generateWorkflowFromBrief());
  document.getElementById("genChips")?.querySelectorAll("[data-chip]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ta = document.getElementById("genBrief");
      if (ta) ta.value = btn.dataset.chip || "";
    });
  });
  document.getElementById("btnDockAll")?.addEventListener("click", () => {
    setMenuTab("elements");
    els.app?.classList.add("menu-open");
    document.getElementById("btnMenuToggle")?.setAttribute("aria-expanded", "true");
  });
  document.querySelectorAll("[data-place]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.place;
      const pt = screenToWorld(window.innerWidth * 0.48, window.innerHeight * 0.42);
      if (type === "script") addNode("script", pt.x, pt.y, { lang: "python", route: "local" });
      else addNode(type, pt.x, pt.y, type === "model" || type === "prompt" ? { route: privateLocal ? "private" : "local" } : {});
    });
  });
  document.getElementById("btnDockPan")?.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    const on = !btn.classList.contains("is-on");
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    els.viewport?.classList.toggle("force-pan", on);
  });
  document.querySelectorAll("[data-where-preset]").forEach((btn) => {
    btn.addEventListener("click", () => startWhereDraw(btn.dataset.wherePreset));
  });
  document.getElementById("btnWhereDraw")?.addEventListener("click", () => startWhereDraw(null));
  document.getElementById("routePop")?.querySelectorAll("[data-route]").forEach((btn) => {
    btn.addEventListener("click", () => assignRoute(btn.dataset.route));
  });
  document.getElementById("machineConfirm")?.addEventListener("click", () => {
    const sel = document.getElementById("machineSelect");
    const mid = (sel?.value || "this").trim();
    if (!mid) {
      setStatus("Choose a computer");
      return;
    }
    assignRoute("machine", mid);
  });
  document.getElementById("phoneConfirm")?.addEventListener("click", () => {
    const sel = document.getElementById("phoneSelect");
    const pid = (sel?.value || "phone-mira").trim();
    if (!pid) {
      setStatus("Choose a phone");
      return;
    }
    assignRoute("phone", pid);
  });
  document.getElementById("routePopCancel")?.addEventListener("click", () => {
    pendingRegion = null;
    closeDrop(document.getElementById("routePop"), 160);
    const mp = document.getElementById("machinePick");
    if (mp) mp.hidden = true;
    const pp = document.getElementById("phonePick");
    if (pp) pp.hidden = true;
    selectedIds = new Set();
    renderNodes();
  });
  document.getElementById("btnHistory")?.addEventListener("click", () => {
    const panel = document.getElementById("historyPanel");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderHistory();
  });
  document.getElementById("btnHistClose")?.addEventListener("click", () => {
    const panel = document.getElementById("historyPanel");
    if (panel) panel.hidden = true;
  });
  document.getElementById("btnPrivateLocal")?.addEventListener("change", (e) => {
    setPrivate(!!e.target.checked);
    const mirror = document.getElementById("cvSetPrivate");
    if (mirror) mirror.checked = !!e.target.checked;
  });
  document.getElementById("tplSelect")?.addEventListener("change", (e) => {
    const v = e.target.value;
    if (!v) return;
    applyTemplate(v);
    e.target.value = "";
  });
  setPrivate(privateLocal);
  setInspectorCollapsed(inspCollapsed, { persist: false });

  function openCanvasSettings(on) {
    const sheet = document.getElementById("cvSettingsSheet");
    const backdrop = document.getElementById("cvSettingsBackdrop");
    const open = on !== false;
    if (sheet) sheet.hidden = !open;
    if (backdrop) backdrop.hidden = !open;
    if (open) {
      const priv = document.getElementById("btnPrivateLocal");
      const mirror = document.getElementById("cvSetPrivate");
      if (mirror && priv) mirror.checked = !!priv.checked;
    }
  }
  document.getElementById("btnCanvasSettings")?.addEventListener("click", () => openCanvasSettings(true));
  document.getElementById("cvSettingsClose")?.addEventListener("click", () => openCanvasSettings(false));
  document.getElementById("cvSettingsBackdrop")?.addEventListener("click", () => openCanvasSettings(false));
  document.getElementById("cvSetPrivate")?.addEventListener("change", (e) => {
    const priv = document.getElementById("btnPrivateLocal");
    if (priv) {
      priv.checked = !!e.target.checked;
      priv.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      setPrivate(!!e.target.checked);
    }
  });
  document.getElementById("cvSetWhere")?.addEventListener("click", () => {
    document.getElementById("btnRegionSelect")?.click();
    openCanvasSettings(false);
  });
  document.getElementById("cvSettingsSheet")?.addEventListener("click", (e) => {
    const act = e.target.closest?.("[data-cv-act]")?.getAttribute("data-cv-act");
    if (!act) return;
    const map = {
      runSelected: "btnRunSelected",
      undo: "btnUndo",
      redo: "btnRedo",
      fit: "btnZoomFit",
      zoomOut: "btnZoomOut",
      zoomIn: "btnZoomIn",
      history: "btnHistory",
      inspector: "btnToggleInsp",
      export: "btnExportGraph",
      phone: "btnDockPhone",
      device: "btnDockDevice",
      brain: "btnDockBrain",
    };
    const id = map[act];
    if (id) document.getElementById(id)?.click();
    if (act === "history" || act === "phone" || act === "device" || act === "brain") {
      openCanvasSettings(false);
    }
  });

  els.visionFile?.addEventListener("change", () => {
    const file = els.visionFile.files?.[0];
    if (!file || !visionTarget) return;
    const reader = new FileReader();
    reader.onload = () => {
      const node = state.nodes.find((n) => n.id === visionTarget);
      if (node) {
        node.data.image = String(reader.result || "");
        save();
        renderNodes();
      }
      visionTarget = null;
      els.visionFile.value = "";
    };
    reader.readAsDataURL(file);
  });

  window.addEventListener("resize", drawWires);

  (async () => {

  function isPhoneViewport() {
    return window.matchMedia("(max-width: 820px)").matches;
  }

  function setMenuOpen(on) {
    const app = els.app;
    if (!app) return;
    app.classList.toggle("menu-open", !!on);
    document.getElementById("btnMenuToggle")?.setAttribute("aria-expanded", on ? "true" : "false");
    const scrim = document.getElementById("menuScrim");
    if (scrim) {
      scrim.hidden = !on;
      scrim.classList.toggle("is-on", !!on);
    }
  }

  let phoneDefaultsApplied = false;
  function optimizeForPhone(force = false) {
    const phone = isPhoneViewport();
    els.app?.classList.toggle("is-phone", phone);
    if (!phone) {
      phoneDefaultsApplied = false;
      return;
    }
    if (phoneDefaultsApplied && !force) return;
    phoneDefaultsApplied = true;
    setInspectorCollapsed(true, { persist: false });
    setMenuOpen(false);
    if (state.cam && state.cam.z > 0.65) {
      state.cam.z = Math.min(state.cam.z, 0.5);
      applyCam();
    }
  }

  document.getElementById("btnMenuToggle")?.addEventListener("click", () => {
    const open = !els.app?.classList.contains("menu-open");
    setMenuOpen(open);
  });
  document.getElementById("menuScrim")?.addEventListener("click", () => setMenuOpen(false));
  document.getElementById("btnMenuClose")?.addEventListener("click", () => setMenuOpen(false));
  els.demoList?.addEventListener("click", (e) => {
    if (e.target.closest?.("[data-demo]") && isPhoneViewport()) setMenuOpen(false);
  });
  els.jobsList?.addEventListener("click", (e) => {
    if (e.target.closest?.("[data-type]") && isPhoneViewport()) setMenuOpen(false);
  });
  els.jobsListRoles?.addEventListener("click", (e) => {
    if (e.target.closest?.("[data-type]") && isPhoneViewport()) setMenuOpen(false);
  });
  const phoneMq = window.matchMedia("(max-width: 820px)");
  const onPhoneMq = () => optimizeForPhone(true);
  if (phoneMq.addEventListener) phoneMq.addEventListener("change", onPhoneMq);
  else phoneMq.addListener?.(onPhoneMq);


    optimizeForPhone();
    await loadModels();
    refreshLiveDevices().catch(() => {});
    bootLocalCompute().catch(() => {});
    const proofLoaded = await loadProofFromUrl();
    if (!proofLoaded) {
      const desk = importDeskPacket();
      if (!desk) {
        const wantSample = new URLSearchParams(location.search).get("sample") === "where";
        const had = load();
        const staleWelcome = (state.nodes || []).some((n) =>
          n.type === "note" && /Describe yourself|About Noeti Canvas|Connect the blocks/i.test(n.data?.text || "")
        );
        if (wantSample) loadSampleWhere();
        else if (!had || !state.nodes.length || staleWelcome) seedWelcome();
        else {
          renderNodes();
          showLoopTray("Run → Seal → Share when you're ready");
          setLoopStep("run");
        }
      }
    }
    applyCam();
    drawRegions();
    renderInspector();
    setPrivate(privateLocal);
  })();
})();
