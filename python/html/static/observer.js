const POLL_MS = 2000;

/** @type {Set<string>} */
const seenFlowKeys = new Set();
let flowsBootstrapped = false;
let showAdminRaw = false;

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortId(id) {
  if (!id) return "—";
  const s = String(id);
  return s.length > 22 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;
}

function fmtTime(ts) {
  if (!ts) return "--:--:--";
  if (typeof ts === "string" && ts.includes(":")) return ts;
  const d = new Date((Number(ts) || 0) * (Number(ts) > 1e12 ? 1 : 1000));
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

function flowKey(f) {
  return [f.ts, f.kind, f.from, f.to, f.task_id || "", f.detail || ""].join("|");
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

function currentUsername() {
  try {
    return (window.NoetiSiteAuth && window.NoetiSiteAuth.getUser()) || "";
  } catch {
    return "";
  }
}

function setupRoleBadge() {
  const user = currentUsername();
  const badge = document.getElementById("obsRoleBadge");
  if (badge) {
    const isAdmin = user === "admin";
    badge.textContent = isAdmin ? "admin" : "team";
    badge.classList.toggle("obs-role-admin", isAdmin);
    badge.title = user ? `signed in as ${user}` : "team";
  }
  const rawPanel = document.getElementById("adminRawPanel");
  if (rawPanel) {
    rawPanel.hidden = user !== "admin";
  }
  const toggle = document.getElementById("adminRawToggle");
  if (toggle && !toggle._bound) {
    toggle._bound = true;
    toggle.addEventListener("change", () => {
      showAdminRaw = !!toggle.checked;
      const pre = document.getElementById("adminRawJson");
      if (pre) pre.hidden = !showAdminRaw;
    });
  }
}

function edgesFromStatus(status) {
  const flows = Array.isArray(status?.flows) ? status.flows : [];
  if (flows.length) {
    return flows
      .slice()
      .reverse()
      .slice(0, 60)
      .map((f) => ({
        ts: f.ts,
        kind: f.kind || "flow",
        from: f.from || "?",
        to: f.to || "?",
        task_id: f.task_id,
        detail: f.detail || "",
      }));
  }

  const events = Array.isArray(status?.events) ? status.events : [];
  return events
    .slice()
    .reverse()
    .slice(0, 60)
    .map((ev) => {
      const msg = ev.message || "";
      let from = "hub";
      let to = "mesh";
      let kind = ev.kind || "event";
      if (/joined|join/i.test(msg)) {
        from = ev.node_id ? `compute:${ev.node_id}` : "node";
        to = "hub";
        kind = "join";
      } else if (/left|leave/i.test(msg)) {
        from = ev.node_id ? `compute:${ev.node_id}` : "node";
        to = "hub";
        kind = "leave";
      } else if (/assign|route /i.test(msg)) {
        from = "hub";
        to = ev.node_id ? `compute:${ev.node_id}` : "compute";
        kind = "assign";
      } else if (/result/i.test(msg)) {
        from = ev.node_id ? `compute:${ev.node_id}` : "compute";
        to = "hub";
        kind = "result";
      } else if (/user\/chat|prompt|routing/i.test(msg)) {
        from = "user/chat";
        to = "hub";
        kind = "prompt";
      } else if (/finalize|consensus|winner/i.test(msg)) {
        from = "hub";
        to = "chain";
        kind = "settle";
      } else if (/relay/i.test(msg)) {
        from = ev.node_id ? `relay:${ev.node_id}` : "relay";
        to = "compute:pool";
        kind = "relay";
      } else if (/stake|reward|transfer|credit/i.test(msg)) {
        from = "chain";
        to = ev.node_id ? `wallet:${ev.node_id}` : "wallet";
        kind = "mlc";
      }
      return {
        ts: ev.time,
        kind,
        from,
        to,
        task_id: ev.task_id,
        detail: msg,
      };
    });
}

function kindClass(kind) {
  const k = String(kind || "").toLowerCase();
  if (/join|leave/.test(k)) return "kind-join";
  if (/assign|route|prompt/.test(k)) return "kind-route";
  if (/result|settle/.test(k)) return "kind-result";
  if (/mlc|stake|reward|transfer|credit/.test(k)) return "kind-mlc";
  if (/relay/.test(k)) return "kind-relay";
  return "kind-default";
}

function renderFlows(status) {
  const el = document.getElementById("flowList");
  const edges = edgesFromStatus(status);
  const flowCount = document.getElementById("stFlows");
  if (flowCount) flowCount.textContent = String(edges.length);

  if (!edges.length) {
    el.innerHTML = `<div class="obs-dim">no traffic yet — ask the mesh or wait for join/leave</div>`;
    return;
  }

  const keys = edges.map(flowKey);
  /** @type {Set<string>} */
  const newKeys = new Set();
  if (!flowsBootstrapped) {
    keys.forEach((k) => seenFlowKeys.add(k));
    flowsBootstrapped = true;
  } else {
    keys.forEach((k) => {
      if (!seenFlowKeys.has(k)) {
        newKeys.add(k);
        seenFlowKeys.add(k);
      }
    });
    if (seenFlowKeys.size > 400) {
      const keep = new Set(keys);
      seenFlowKeys.forEach((k) => {
        if (!keep.has(k)) seenFlowKeys.delete(k);
      });
    }
  }

  el.innerHTML = edges
    .map((e) => {
      const key = flowKey(e);
      const isNew = newKeys.has(key);
      const task = e.task_id ? ` · task=${esc(shortId(e.task_id))}` : "";
      const detail = e.detail
        ? `<div class="kind ${kindClass(e.kind)}">${esc(e.kind)}${task} · ${esc(e.detail)}</div>`
        : `<div class="kind ${kindClass(e.kind)}">${esc(e.kind)}${task}</div>`;
      return `<div class="obs-edge ${isNew ? "obs-edge-new" : ""}" data-flow-key="${esc(key)}">
        <span class="ts">${esc(fmtTime(e.ts))}</span>
        <div class="path">
          <span class="from">${esc(e.from)}</span>
          <span class="arrow">→</span>
          <span class="to">${esc(e.to)}</span>
          ${detail}
        </div>
      </div>`;
    })
    .join("");
}

function nodeKindLabel(n) {
  const id = String(n.node_id || "");
  const runtime = String(n.runtime || "ollama").toLowerCase();
  if (id === "site-01" || (id.startsWith("site") && (n.roles || []).includes("coordinator"))) {
    return "site";
  }
  if (runtime === "browser" || runtime === "wasm" || /browser/i.test(id)) return "browser";
  return "desktop";
}

function renderNodes(status, mesh) {
  const el = document.getElementById("nodeList");
  const rows = [];

  for (const n of status?.nodes || []) {
    const kind = nodeKindLabel(n);
    const roles = (n.roles || [n.role || "compute"]).join("+");
    const online = (n.status || "online") === "online";
    rows.push({
      id: n.node_id,
      kind,
      model: n.model || "—",
      runtime: n.runtime || "ollama",
      tier: n.capability_tier || "?",
      roles,
      online,
      meta: `stake=${n.mlc_staked ?? "—"} · tasks=${n.tasks_completed ?? 0}`,
    });
  }
  for (const r of status?.relays || []) {
    rows.push({
      id: r.relay_id || r.node_id,
      kind: "relay",
      model: "—",
      runtime: "relay",
      tier: "—",
      roles: "relay",
      online: (r.status || "online") === "online",
      meta: r.last_action || "online",
    });
  }
  for (const peer of mesh?.peers || status?.mesh?.peers || []) {
    rows.push({
      id: peer,
      kind: "mesh",
      model: "—",
      runtime: "gossip",
      tier: "—",
      roles: "peer",
      online: true,
      meta: "gossip peer",
    });
  }

  if (!rows.length) {
    el.innerHTML = `<div class="obs-dim">no online compute / relays / mesh peers</div>`;
    return;
  }

  const order = { site: 0, desktop: 1, browser: 2, relay: 3, mesh: 4 };
  rows.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));

  el.innerHTML = rows
    .map(
      (r) => `<div class="obs-node-card ${r.online ? "on" : "off"}">
        <div class="obs-node-top">
          <span class="obs-kind-tag kind-${esc(r.kind)}">${esc(r.kind)}</span>
          <span class="id">${esc(shortId(r.id))}</span>
          <span class="obs-pill ${r.online ? "on" : "off"}">${r.online ? "online" : "offline"}</span>
        </div>
        <div class="obs-node-meta">
          <span>${esc(r.model)}</span>
          <span>${esc(r.runtime)}</span>
          <span>tier=${esc(r.tier)}</span>
          <span>${esc(r.roles)}</span>
        </div>
        <div class="obs-dim">${esc(r.meta)}</div>
      </div>`
    )
    .join("");
}

function renderTasks(status) {
  const el = document.getElementById("taskBlock");
  const assignments = Array.isArray(status?.active_assignments) ? status.active_assignments : [];
  const running = Array.isArray(status?.running_tasks) ? status.running_tasks : [];

  if (!assignments.length && !running.length) {
    el.innerHTML = `<div class="obs-dim">no active tasks</div>`;
    return;
  }

  if (assignments.length) {
    el.innerHTML = assignments
      .map((t) => {
        const nodes = (t.assigned_node_ids || []).map(shortId).join(", ") || "—";
        const net = t.internet ? "on" : "off";
        return `<div class="obs-task-row">
          <div class="obs-task-id">
            <span class="obs-pill on">${esc(t.status || "active")}</span>
            <strong>${esc(shortId(t.task_id))}</strong>
          </div>
          <div class="obs-task-grid">
            <span><em>nodes</em> ${esc(nodes)}</span>
            <span><em>mode</em> ${esc(t.mode || "—")}</span>
            <span><em>internet</em> ${esc(net)}</span>
            <span><em>runtime</em> ${esc(t.runtime || "—")}</span>
            <span><em>tier</em> ${esc(t.tier || "—")}</span>
            <span><em>age</em> ${esc(fmtTime(t.created))}</span>
          </div>
        </div>`;
      })
      .join("");
    return;
  }

  el.innerHTML = running
    .map(
      (id) => `<div class="obs-task-row">
        <div class="obs-task-id"><span class="obs-pill on">running</span> <strong>${esc(shortId(id))}</strong></div>
      </div>`
    )
    .join("");
}

function renderMlc(status, chain, txs) {
  const el = document.getElementById("mlcBlock");
  const hints = [];

  const supply = status?.mlc_supply_distributed;
  if (supply != null) {
    hints.push(`<div class="obs-kv"><span class="k">supply</span><span class="v">${esc(supply)} MLC distributed</span></div>`);
  }
  const site = status?.site_compute;
  if (site) {
    hints.push(
      `<div class="obs-kv"><span class="k">site-01</span><span class="v">bal=${esc(site.mlc_balance ?? "—")} · staked=${esc(site.mlc_staked ?? "—")} · earned≈${esc(site.earned_hint ?? "—")}</span></div>`
    );
  }

  const txList = Array.isArray(txs?.transactions) ? txs.transactions : Array.isArray(txs) ? txs : [];
  const recent = txList.slice(0, 12);
  if (recent.length) {
    hints.push(`<div class="obs-mlc-list">`);
    for (const t of recent) {
      const type = (t.type || t.kind || "tx").toLowerCase();
      const amount = t.amount != null ? t.amount : t.value;
      const who = t.name || shortId(t.address || t.to || t.from || "");
      const reason = t.reason || t.data || "";
      const isHint = /stake|reward|transfer|credit|debit/i.test(type + " " + reason);
      hints.push(`<div class="obs-mlc-row ${isHint ? "hint" : ""}">
        <span class="ts">${esc(t.time_str || fmtTime(t.time))}</span>
        <span class="type ${kindClass(type)}">${esc(type)}</span>
        <span class="amt">${amount != null ? esc(amount) + " MLC" : "—"}</span>
        <span class="who">${esc(who)}</span>
        <span class="why">${esc(String(reason || "").slice(0, 72))}</span>
      </div>`);
    }
    hints.push(`</div>`);
  } else {
    const blocks = chain?.blocks || [];
    const withData = blocks
      .slice()
      .reverse()
      .filter((b) => b.data || (b.transactions && b.transactions.length))
      .slice(0, 8);
    if (withData.length) {
      hints.push(`<div class="obs-mlc-list">`);
      for (const b of withData) {
        hints.push(`<div class="obs-mlc-row">
          <span class="ts">#${esc(b.index)}</span>
          <span class="type kind-mlc">block</span>
          <span class="why">${esc((b.data || "sealed").slice(0, 80))}</span>
        </div>`);
      }
      hints.push(`</div>`);
    } else {
      hints.push(`<div class="obs-dim">no recent stake / reward / transfer hints</div>`);
    }
  }

  el.innerHTML = hints.join("") || `<div class="obs-dim">no MLC activity yet</div>`;
}

function renderSite(status) {
  const el = document.getElementById("siteBlock");
  const s = status?.site_compute;
  if (!s) {
    el.innerHTML = `<div class="obs-dim">site compute not reported</div>`;
    return;
  }
  const online = !!s.online;
  const ollama = !!s.ollama;
  el.innerHTML = `
    <div class="obs-kv"><span class="k">node</span><span class="v"><strong>${esc(s.node_id || "site-01")}</strong>
      <span class="obs-pill ${online ? "on" : "off"}">${online ? "online" : "offline"}</span></span></div>
    <div class="obs-kv"><span class="k">roles</span><span class="v">${esc((s.roles || []).join(", ") || s.role || "coordinator+compute")}</span></div>
    <div class="obs-kv"><span class="k">model</span><span class="v">${esc(s.model || "—")}</span></div>
    <div class="obs-kv"><span class="k">tier</span><span class="v">${esc(s.capability_tier || "—")}</span></div>
    <div class="obs-kv"><span class="k">wallet</span><span class="v">${esc(s.wallet_short || shortId(s.wallet) || "—")}</span></div>
    <div class="obs-kv"><span class="k">earned</span><span class="v">${esc(s.earned_hint ?? "—")} MLC · tasks=${esc(s.tasks_completed ?? 0)}</span></div>
    <div class="obs-kv"><span class="k">ollama</span><span class="v"><span class="obs-pill ${ollama ? "on" : "off"}">${ollama ? "on" : "off"}</span></span></div>
  `;
}

function renderRoutes(status) {
  const el = document.getElementById("routeBlock");
  const hist = Array.isArray(status?.route_history) ? status.route_history.slice().reverse() : [];
  const last = status?.last_route;
  const rows = hist.length ? hist.slice(0, 12) : last ? [last] : [];
  if (!rows.length) {
    el.innerHTML = `<div class="obs-dim">no prompts routed yet — ask the network</div>`;
    return;
  }
  el.innerHTML = rows
    .map((r) => {
      const c = Math.max(0, Math.min(100, Number(r.complexity) || 0));
      return `<div class="obs-route-row">
        <div><span class="obs-pill on">${esc(r.tier || "?")}</span>
          task=<strong>${esc(shortId(r.task_id))}</strong>
          · tokens≈${esc(r.tokens_est ?? "—")}
          · prefer=${esc(r.preferred_model || r.model || "—")}
          · assign=${esc(shortId(r.assigned) || "pending")}
        </div>
        <div class="obs-dim" style="margin-top:4px">complexity ${esc(c)} · ${esc(fmtTime(r.ts))}</div>
        <div class="obs-bar" aria-hidden="true"><i style="width:${c}%"></i></div>
      </div>`;
    })
    .join("");
}

function renderCoordinators(status) {
  const el = document.getElementById("coordBlock");
  const ids = status?.coordinators || [];
  if (!ids.length) {
    el.innerHTML = `<div class="obs-dim">site-01 will appear when Ollama / site compute is up</div>`;
    return;
  }
  const byId = Object.fromEntries((status?.nodes || []).map((n) => [n.node_id, n]));
  el.innerHTML = ids
    .map((id) => {
      const n = byId[id] || {};
      const stake = n.mlc_staked != null ? `${n.mlc_staked} staked` : "—";
      return `<div class="obs-node-row">
        <span class="id">${esc(id)}</span>
        <span class="meta">${esc((n.roles || ["coordinator"]).join("+"))} · ${esc(n.model || "—")} · ${esc(stake)}</span>
      </div>`;
    })
    .join("");
}

function renderAssign(status, mesh) {
  const el = document.getElementById("assignBlock");
  const a = status?.last_task_assignment;
  if (!a) {
    el.innerHTML = `<div class="obs-dim">no assignment yet</div>`;
  } else {
    const ids = (a.assigned_node_ids || []).map(shortId).join(", ") || a.node_id || "—";
    el.innerHTML = `<div>
      <span class="obs-pill on">assign</span>
      task=<strong>${esc(shortId(a.task_id))}</strong>
      → nodes=<strong>${esc(ids)}</strong>
      · runtime=${esc(a.runtime || "—")}
      · tier=${esc(a.tier || "—")}
      · ${esc(fmtTime(a.ts))}
    </div>`;
  }

  const g = mesh?.task_gossip || status?.mesh?.task_gossip || {};
  const gb = document.getElementById("gossipBlock");
  const recent = g.recent || [];
  gb.innerHTML = `<div>
    <span class="obs-pill">TASK_OFFER ${esc(g.offers ?? 0)}</span>
    <span class="obs-pill">TASK_CLAIM ${esc(g.claims ?? 0)}</span>
    <span class="obs-pill">TASK_RESULT ${esc(g.results ?? 0)}</span>
    <span class="obs-pill">TASK_FINALIZED ${esc(g.finalized ?? 0)}</span>
  </div>
  <div style="margin-top:8px" class="obs-dim">
    ${
      recent.length
        ? recent
            .slice()
            .reverse()
            .slice(0, 8)
            .map((m) => `${esc(fmtTime(m.ts))} ${esc(m.type)} task=${esc(shortId(m.task_id))} node=${esc(shortId(m.node_id))}`)
            .join("<br/>")
        : "no gossip task messages yet"
    }
  </div>`;
}

function renderEvents(status) {
  const log = document.getElementById("eventLog");
  const events = status?.events || [];
  if (!events.length) {
    log.innerHTML = `<span class="line dim">[..] waiting for hub events<span class="cursor"></span></span>`;
    return;
  }
  log.innerHTML = events
    .slice(-28)
    .reverse()
    .map((ev) => {
      const text = typeof ev === "string" ? ev : `${ev.time || ""} ${ev.message || ""}`.trim();
      return `<span class="line">[ev] ${esc(text)}</span>`;
    })
    .join("");
}

function renderValidators(validatorsPayload, status) {
  const el = document.getElementById("validatorBlock");
  const rows = validatorsPayload?.validators || [];
  const st = document.getElementById("stValidators");
  if (st) st.textContent = String(rows.length || status?.decentralization?.validators || status?.federation_peers || 0);
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = `<div class="obs-dim">no validators reported</div>`;
  } else {
    el.innerHTML = rows
      .map(
        (v) => `<div class="obs-node-row">
          <span class="id">${esc(shortId(v.validator_id || "hub-validator"))}</span>
          <span class="meta">${esc(v.hub_url || "—")} · ${esc(shortId(v.public_key || v.address || ""))}</span>
        </div>`
      )
      .join("");
  }
  const dEl = document.getElementById("decentBlock");
  if (dEl) {
    const d = status?.decentralization || {};
    dEl.innerHTML = `
      <div class="obs-kv"><span class="k">validators</span><span class="v">${esc(d.validators ?? rows.length)}</span></div>
      <div class="obs-kv"><span class="k">cosign_quorum</span><span class="v">${esc(d.cosign_quorum ?? status?.consensus_quorum ?? "—")}</span></div>
      <div class="obs-kv"><span class="k">mesh_consensus</span><span class="v">${esc(d.mesh_consensus ?? status?.mesh_consensus ?? false)}</span></div>
      <div class="obs-kv"><span class="k">hub_blind</span><span class="v">${esc(d.hub_blind ?? status?.hub_blind ?? false)}</span></div>
      <div class="obs-kv"><span class="k">faucet</span><span class="v">${esc(d.faucet ?? (status?.faucet_enabled ? status?.faucet_mode : "off"))}</span></div>
      <div class="obs-dim" style="margin-top:8px">entry point · validators cosign on mesh</div>
    `;
  }
}

function renderStats(status) {
  document.getElementById("stCompute").textContent = status?.compute_count ?? 0;
  document.getElementById("stBrowser").textContent = status?.browser_count ?? 0;
  document.getElementById("stOllama").textContent = status?.ollama_count ?? 0;
  document.getElementById("stRelay").textContent = status?.relay_count ?? 0;
  document.getElementById("stActive").textContent = status?.active_task_count ?? status?.running_tasks?.length ?? 0;
  document.getElementById("stCoords").textContent = (status?.coordinators || []).length;
  const faucetOn = !!status?.faucet_enabled;
  const faucetEl = document.getElementById("stFaucet");
  faucetEl.textContent = faucetOn ? status?.faucet_mode || "on" : "off";
  faucetEl.style.color = faucetOn ? "var(--warn)" : "var(--accent)";

  const banner = document.getElementById("observerBanner");
  if (banner && status?.observer_note) {
    banner.textContent = status.observer_note;
  }

  const clock = document.getElementById("obsClock");
  if (clock) clock.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function renderAdminRaw(status) {
  if (currentUsername() !== "admin") return;
  const pre = document.getElementById("adminRawJson");
  if (!pre || !showAdminRaw) return;
  try {
    pre.textContent = JSON.stringify(status, null, 2);
  } catch {
    pre.textContent = "(unable to stringify status)";
  }
}

async function tick() {
  try {
    const [status, mesh, chain, txs, validators] = await Promise.all([
      fetchJson("/api/status"),
      fetchJson("/api/mesh").catch(() => null),
      fetchJson("/api/chain").catch(() => null),
      fetchJson("/api/transactions").catch(() => null),
      fetchJson("/api/validators").catch(() => null),
    ]);
    setupRoleBadge();
    renderStats(status);
    renderValidators(validators, status);
    renderFlows(status);
    renderNodes(status, mesh || status?.mesh);
    renderTasks(status);
    renderMlc(status, chain, txs);
    renderSite(status);
    renderRoutes(status);
    renderCoordinators(status);
    renderAssign(status, mesh || status?.mesh);
    renderEvents(status);
    renderAdminRaw(status);
  } catch (err) {
    const log = document.getElementById("eventLog");
    if (log) {
      log.innerHTML = `<span class="line" style="color:var(--error)">[err] ${esc(err.message)}</span>`;
    }
  }
}

setupRoleBadge();
tick();
setInterval(tick, POLL_MS);

if (location.hash) {
  const target = document.querySelector(location.hash);
  if (target) {
    setTimeout(() => target.scrollIntoView({ behavior: "smooth", block: "start" }), 200);
  }
}
