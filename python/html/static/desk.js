(() => {
  const authGate = document.getElementById("authGate");
  const deskApp = document.getElementById("deskApp");
  const authForm = document.getElementById("authForm");
  const authMsg = document.getElementById("authMsg");
  const authUser = document.getElementById("authUser");
  const authPass = document.getElementById("authPass");
  const authSubmit = document.getElementById("authSubmit");
  let mode = "login";
  let me = null;
  let summary = null;
  let currentProject = null;

  document.querySelectorAll(".auth-tabs button").forEach((b) => {
    b.addEventListener("click", () => {
      mode = b.dataset.tab;
      document.querySelectorAll(".auth-tabs button").forEach((x) => x.classList.toggle("active", x === b));
      authSubmit.textContent = mode === "login" ? "Log in" : "Create desk";
      authPass.autocomplete = mode === "login" ? "current-password" : "new-password";
    });
  });

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data.message && !data.error) data.message = `HTTP ${res.status}`;
    return { res, data };
  }

  function showApp(on) {
    authGate.hidden = on;
    deskApp.hidden = !on;
  }

  function setView(name) {
    document.querySelectorAll(".desk-nav .nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  }

  function renderQuota() {
    const d = summary?.desk;
    const el = document.getElementById("quotaBar");
    if (!d || !el) return;
    el.innerHTML = `<strong>${d.plan_name}</strong><br/>${d.runs_used} / ${d.runs_limit} runs · ${d.seats.length}/${d.seat_limit} seats`;
  }

  function renderOverview() {
    const d = summary?.desk;
    const box = document.getElementById("overviewStats");
    if (!d || !box) return;
    box.innerHTML = `
      <div class="stat"><em>Plan</em><strong>${d.plan_name}</strong></div>
      <div class="stat"><em>Runs left</em><strong>${d.runs_remaining}</strong></div>
      <div class="stat"><em>Seats</em><strong>${d.seats.length}/${d.seat_limit}</strong></div>
      <div class="stat"><em>Month</em><strong>${d.month}</strong></div>`;
    document.getElementById("deskUser").textContent = me?.username || "";
    renderQuota();
  }

  function renderBilling() {
    const grid = document.getElementById("planGrid");
    const seatList = document.getElementById("seatList");
    if (!summary || !grid) return;
    grid.innerHTML = "";
    for (const p of summary.plans || []) {
      const card = document.createElement("div");
      card.className = "plan-card" + (summary.desk.plan === p.id ? " current" : "");
      card.innerHTML = `
        <h3>${p.name}</h3>
        <div class="amount">$${p.price_usd}<small>/mo</small></div>
        <p>${p.runs} runs · ${p.seats} seats · overage $${p.overage_usd}</p>
        <button type="button" class="btn" data-plan="${p.id}" ${p.id === "trial" || summary.desk.plan === p.id ? "disabled" : ""}>
          ${summary.desk.plan === p.id ? "Current" : p.id === "trial" ? "Included" : "Choose"}
        </button>`;
      card.querySelector("button")?.addEventListener("click", () => checkout(p.id));
      grid.appendChild(card);
    }
    seatList.innerHTML = "";
    for (const s of summary.desk.seats || []) {
      const li = document.createElement("li");
      li.textContent = `${s.username} · ${s.role}`;
      seatList.appendChild(li);
    }
  }

  async function checkout(planId) {
    const msg = document.getElementById("billingMsg");
    msg.textContent = "Starting checkout…";
    const { data } = await api("/api/desk/checkout", {
      method: "POST",
      body: JSON.stringify({
        plan: planId,
        success_url: location.origin + "/desk?billing=success",
        cancel_url: location.origin + "/desk?billing=cancel",
      }),
    });
    if (data.url) {
      location.href = data.url;
      return;
    }
    if (data.ok) {
      summary = data.summary || (await refreshSummary());
      renderBilling();
      renderOverview();
      msg.textContent = data.message || "Plan updated.";
    } else {
      msg.textContent = data.message || data.error || "Checkout failed";
    }
  }

  async function refreshSummary() {
    const { data } = await api("/api/desk/summary");
    if (data.ok) summary = data;
    return summary;
  }

  async function refreshProjects() {
    const { data } = await api("/api/desk/projects");
    const list = document.getElementById("projectList");
    const sel = document.getElementById("projectSelect");
    const exp = document.getElementById("exportSelect");
    list.innerHTML = "";
    sel.innerHTML = "";
    exp.innerHTML = "";
    for (const p of data.projects || []) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "project-item";
      row.textContent = `${p.title} · ${p.claim_count} claims · gate ${p.publish_gate}`;
      row.addEventListener("click", () => openProject(p.id));
      list.appendChild(row);
      const o1 = document.createElement("option");
      o1.value = p.id;
      o1.textContent = p.title;
      sel.appendChild(o1.cloneNode(true));
      exp.appendChild(o1);
    }
    if (currentProject) {
      sel.value = currentProject.id;
      exp.value = currentProject.id;
    }
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** Soft markdown → HTML (no raw ### ** --- left visible) */
  function formatMd(text) {
    if (window.__noetiFormatContent) return window.__noetiFormatContent(text);
    let raw = String(text || "").replace(/\r\n/g, "\n");
    const fences = [];
    raw = raw.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const i = fences.length;
      fences.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
      return `\u0000FENCE${i}\u0000`;
    });
    let html = escapeHtml(raw);
    html = html.replace(/\u0000FENCE(\d+)\u0000/g, (_, i) => fences[Number(i)]);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/^#{1,6}\s+(.+)$/gm, "<strong>$1</strong>");
    html = html.replace(/^\s*-{3,}\s*$/gm, "<hr>");
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    html = html.replace(/^(?:[-*•])\s+(.+)$/gm, "• $1");
    html = html.replace(/(^|\n)\s*#{1,6}\s+/g, "$1");
    html = html.replace(/\*{1,3}/g, "");
    return html.replace(/\n/g, "<br>");
  }

  function renderWitness(project) {
    currentProject = project;
    const gate = document.getElementById("gateBadge");
    const board = document.getElementById("witnessBoard");
    gate.textContent = `Publish gate: ${project.publish_gate}`;
    gate.className = "gate " + (project.publish_gate === "ready" ? "ok" : "blocked");
    board.innerHTML = "";
    for (const c of project.claims || []) {
      const card = document.createElement("article");
      card.className = "claim-card " + (c.status || "pending");
      const witnesses = (c.witnesses || [])
        .map((w) => `<li><strong>${escapeHtml(w.class)}</strong> ${escapeHtml(w.result)} — ${formatMd(w.note || "")}</li>`)
        .join("");
      const cons = (c.contradictions || []).map((x) => `<li>contradiction: ${formatMd(x)}</li>`).join("");
      const negs = (c.negative_evidence || []).map((x) => `<li>negative: ${formatMd(x)}</li>`).join("");
      card.innerHTML = `
        <header><span>${escapeHtml(c.id)}</span><em>${escapeHtml(c.status)}</em></header>
        <p>${formatMd(c.text)}</p>
        <ul>${witnesses}${cons}${negs}</ul>`;
      board.appendChild(card);
    }
  }

  async function openProject(id) {
    const { data } = await api(`/api/desk/projects/${id}`);
    if (!data.ok) return;
    renderWitness(data.project);
    setView("witness");
    document.getElementById("projectSelect").value = id;
    document.getElementById("exportSelect").value = id;
  }

  async function boot() {
    const { data } = await api("/api/auth/me");
    if (!data.ok || !data.username) {
      showApp(false);
      return;
    }
    me = data;
    await refreshSummary();
    showApp(true);
    renderOverview();
    renderBilling();
    await refreshProjects();
  }

  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    authMsg.textContent = "";
    const body = JSON.stringify({ username: authUser.value.trim(), password: authPass.value });
    const path = mode === "login" ? "/api/auth/login" : "/api/desk/signup";
    const { data } = await api(path, { method: "POST", body });
    if (!data.ok) {
      authMsg.textContent = data.error || data.message || "Auth failed";
      return;
    }
    await boot();
  });

  document.getElementById("btnLogout")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
    me = null;
    summary = null;
    showApp(false);
  });

  document.querySelectorAll(".desk-nav .nav-btn").forEach((b) => {
    b.addEventListener("click", () => setView(b.dataset.view));
  });
  document.querySelectorAll("[data-goto]").forEach((b) => {
    b.addEventListener("click", () => setView(b.dataset.goto));
  });

  document.getElementById("docFile")?.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    document.getElementById("docBody").value = text;
    if (!document.getElementById("docTitle").value) {
      document.getElementById("docTitle").value = f.name.replace(/\.[^.]+$/, "");
    }
  });

  document.getElementById("atomizeForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("atomizeMsg");
    msg.textContent = "Atomizing…";
    const { data } = await api("/api/desk/atomize", {
      method: "POST",
      body: JSON.stringify({
        title: document.getElementById("docTitle").value,
        body: document.getElementById("docBody").value,
      }),
    });
    if (!data.ok) {
      msg.textContent = data.message || "Failed";
      return;
    }
    msg.textContent = `Created ${data.claim_count} claims.`;
    summary = await refreshSummary();
    renderOverview();
    await refreshProjects();
    renderWitness(data.project);
    setView("witness");
  });

  document.getElementById("btnWitness")?.addEventListener("click", async () => {
    const id = document.getElementById("projectSelect").value;
    if (!id) return;
    const { data } = await api(`/api/desk/projects/${id}/witness`, { method: "POST", body: "{}" });
    if (!data.ok) {
      alert(data.message || "Witness run failed");
      return;
    }
    summary = await refreshSummary();
    renderOverview();
    renderWitness(data.project);
  });

  document.getElementById("seatForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("billingMsg");
    const { data } = await api("/api/desk/seats", {
      method: "POST",
      body: JSON.stringify({ username: document.getElementById("seatUser").value }),
    });
    if (!data.ok) {
      msg.textContent = data.message || "Could not add seat";
      return;
    }
    summary = data;
    renderBilling();
    renderOverview();
    msg.textContent = "Seat added.";
  });

  async function doExport(fmt) {
    const id = document.getElementById("exportSelect").value;
    if (!id) return;
    const { data } = await api(`/api/desk/projects/${id}/export?format=${fmt}`);
    if (!data.ok) return;
    const preview = document.getElementById("exportPreview");
    if (fmt === "json") {
      const blob = new Blob([JSON.stringify(data.trail, null, 2)], { type: "application/json" });
      preview.textContent = JSON.stringify(data.trail, null, 2);
      downloadBlob(blob, `proofpath-${id}.json`);
    } else {
      preview.textContent = data.content || "";
      downloadBlob(new Blob([data.content || ""], { type: "text/plain" }), data.filename || `proofpath-${id}.txt`);
    }
  }

  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  document.getElementById("btnExportJson")?.addEventListener("click", () => doExport("json"));
  document.getElementById("btnExportTxt")?.addEventListener("click", () => doExport("txt"));

  boot();
})();
