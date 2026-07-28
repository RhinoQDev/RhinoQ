"use strict";

const app = {
  snapshot: null,
  view: "jobs",
  queue: "",
  search: "",
  stateFilter: "",
  stageFilter: "",
  selectedJobId: "",
  selectedIndex: -1,
  visibleRows: [],
  columns: {
    correlation: true,
    stage: true,
    attempts: true,
    priority: true,
    created: true,
  },
  paletteIndex: 0,
  paletteCommands: [],
  refreshTimer: null,
};

const viewDefinitions = {
  jobs: {
    eyebrow: "EXECUTION",
    title: "Execution worktable",
    description: "Trace queued work from durable commit to business evidence.",
    placeholder: "Search job, queue, correlation…",
  },
  attention: {
    eyebrow: "RECOVER",
    title: "Needs attention",
    description: "One bounded inbox for execution risk and business drift.",
    placeholder: "Search reason, kind, job or reference…",
  },
  findings: {
    eyebrow: "VERIFY",
    title: "Integrity findings",
    description: "Persistent business invariant drift, grouped by subject and Rule version.",
    placeholder: "Search Rule, subject or evidence…",
  },
  rules: {
    eyebrow: "VERIFY",
    title: "Rules",
    description: "Deterministic, versioned checks reviewed by developers — no LLM required.",
    placeholder: "Search Rule, scope or subject…",
  },
};

const elements = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  restorePreferences();
  configurePlatformKeys();
  app.queue = new URLSearchParams(window.location.search).get("queue") || "";
  bindEvents();
  renderPalette();
  loadSnapshot({ initial: true });
});

function cacheElements() {
  [
    "source-label", "source-mode", "connection-label", "jobs-count", "attention-count",
    "findings-count", "rules-count", "queue-list", "clear-queue", "view-eyebrow",
    "view-title", "view-description", "refresh-button", "flow-commit", "flow-run",
    "flow-verify", "flow-recover", "search-input", "state-filters", "density-button",
    "density-menu", "columns-button", "columns-menu", "active-context",
    "active-context-copy", "clear-context", "table-scroll", "data-table", "table-head",
    "table-body", "table-loading", "table-empty", "empty-clear", "row-summary",
    "generated-at", "evidence-rail", "rail-empty", "rail-content", "rail-queue",
    "rail-title", "rail-close", "rail-id", "copy-job-id", "truth-request",
    "truth-request-copy", "truth-effect", "truth-effect-copy", "truth-outcome",
    "truth-outcome-copy", "rail-state", "job-context", "attempt-total",
    "attempt-timeline", "effect-total", "effect-list", "outcome-total", "outcome-list",
    "audit-section", "audit-total", "audit-list", "rail-notice", "command-trigger",
    "command-palette", "palette-input", "palette-results", "theme-toggle", "theme-icon",
    "mobile-nav-button", "sidebar", "mobile-scrim", "toast",
  ].forEach((id) => {
    elements[id] = document.getElementById(id);
  });
}

function configurePlatformKeys() {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const commandKey = document.querySelector("#command-trigger kbd");
  if (commandKey) {
    commandKey.textContent = isMac ? "⌘ K" : "Ctrl K";
  }
}

function restorePreferences() {
  const storedTheme = localStorage.getItem("rhinoq.theme");
  const theme = storedTheme || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.dataset.theme = theme;
  updateThemeIcon();

  const density = localStorage.getItem("rhinoq.density") || "compact";
  document.documentElement.dataset.density = density;

  try {
    const storedColumns = JSON.parse(localStorage.getItem("rhinoq.columns") || "{}");
    app.columns = { ...app.columns, ...storedColumns };
  } catch (_) {
    // Corrupt local preferences should never block the local inspector.
  }
  document.querySelectorAll("[data-column-toggle]").forEach((input) => {
    input.checked = app.columns[input.dataset.columnToggle] !== false;
  });
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
  document.querySelectorAll("[data-stage]").forEach((button) => {
    button.addEventListener("click", () => {
      app.stageFilter = app.stageFilter === button.dataset.stage ? "" : button.dataset.stage;
      app.stateFilter = "";
      setView("jobs", { preserveFilters: true });
    });
  });
  document.querySelectorAll("[data-state]").forEach((button) => {
    button.addEventListener("click", () => {
      app.stateFilter = button.dataset.state;
      app.stageFilter = "";
      renderCurrentView();
    });
  });
  elements["search-input"].addEventListener("input", (event) => {
    app.search = event.target.value.trim().toLocaleLowerCase();
    renderCurrentView();
  });
  elements["refresh-button"].addEventListener("click", () => loadSnapshot());
  elements["clear-queue"].addEventListener("click", clearQueue);
  elements["clear-context"].addEventListener("click", clearFilters);
  elements["empty-clear"].addEventListener("click", clearFilters);
  elements["table-body"].addEventListener("click", onTableClick);
  elements["rail-close"].addEventListener("click", closeRail);
  elements["copy-job-id"].addEventListener("click", copySelectedJobID);

  bindMenu(elements["density-button"], elements["density-menu"]);
  bindMenu(elements["columns-button"], elements["columns-menu"]);
  document.querySelectorAll("[data-density-value]").forEach((button) => {
    button.addEventListener("click", () => {
      const density = button.dataset.densityValue;
      document.documentElement.dataset.density = density;
      localStorage.setItem("rhinoq.density", density);
      closeMenus();
    });
  });
  document.querySelectorAll("[data-column-toggle]").forEach((input) => {
    input.addEventListener("change", () => {
      app.columns[input.dataset.columnToggle] = input.checked;
      localStorage.setItem("rhinoq.columns", JSON.stringify(app.columns));
      renderCurrentView();
    });
  });

  elements["theme-toggle"].addEventListener("click", toggleTheme);
  elements["command-trigger"].addEventListener("click", openPalette);
  elements["palette-input"].addEventListener("input", renderPalette);
  elements["palette-input"].addEventListener("keydown", onPaletteKeydown);
  elements["palette-results"].addEventListener("click", onPaletteClick);

  elements["mobile-nav-button"].addEventListener("click", openMobileNavigation);
  elements["mobile-scrim"].addEventListener("click", closeMobileLayers);
  window.addEventListener("resize", syncResponsiveRail);
  document.addEventListener("keydown", onGlobalKeydown);
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".toolbar-menu-wrap")) {
      closeMenus();
    }
  });
}

function bindMenu(button, menu) {
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const willOpen = menu.hidden;
    closeMenus();
    menu.hidden = !willOpen;
    button.setAttribute("aria-expanded", String(willOpen));
  });
}

async function loadSnapshot(options = {}) {
  const button = elements["refresh-button"];
  const glyph = button.querySelector(".refresh-glyph");
  button.disabled = true;
  glyph.classList.add("is-spinning");
  if (options.initial) {
    elements["table-loading"].hidden = false;
  }
  try {
    const params = new URLSearchParams({ limit: "150" });
    if (app.queue) params.set("queue", app.queue);
    const snapshot = await fetchJSON(`/api/v1/snapshot?${params}`);
    app.snapshot = snapshot;
    renderSnapshotChrome();
    renderQueueList();
    renderCurrentView();
    if (options.initial && snapshot.jobs.length && window.innerWidth > 1120) {
      await selectJob(snapshot.jobs[0].id, { silentScroll: true });
    }
  } catch (error) {
    renderLoadError(error);
  } finally {
    button.disabled = false;
    glyph.classList.remove("is-spinning");
    elements["table-loading"].hidden = true;
  }
}

async function fetchJSON(path) {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  let body;
  try {
    body = await response.json();
  } catch (_) {
    throw new Error(`Workbench returned HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(body?.error?.message || `Workbench returned HTTP ${response.status}`);
  }
  return body;
}

function renderLoadError(error) {
  app.snapshot = null;
  elements["table-head"].innerHTML = "";
  elements["table-body"].innerHTML = "";
  elements["table-empty"].hidden = false;
  elements["table-empty"].querySelector("strong").textContent = "Workbench could not read this source";
  elements["table-empty"].querySelector("small").textContent = error.message;
  elements["row-summary"].textContent = "Connection failed";
  elements["connection-label"].textContent = "Connection unavailable";
  document.querySelector(".connection-dot").style.background = "var(--red)";
  showToast(error.message);
}

function renderSnapshotChrome() {
  const snapshot = app.snapshot;
  const count = sumCounts(snapshot.counts);
  const active = countStates(snapshot.counts, ["pending", "leased", "retry_wait"]);
  const attention = snapshot.attention.length;
  const verifyVisible = snapshot.jobs.filter((job) => job.stage === "verify").length;
  const attentionSuffix = attention >= (snapshot.limits?.attention || 50) ? "+" : "";

  elements["source-label"].textContent = snapshot.source.label;
  elements["source-mode"].textContent = snapshot.source.mode.toLocaleUpperCase();
  elements["connection-label"].textContent = snapshot.source.readOnly ? "Local · read-only" : "Local connection";
  elements["jobs-count"].textContent = compactNumber(count);
  elements["attention-count"].textContent = compactNumber(attention) + attentionSuffix;
  elements["findings-count"].textContent = compactNumber(snapshot.findings.length);
  elements["rules-count"].textContent = compactNumber(snapshot.rules.length);
  elements["flow-commit"].textContent = compactNumber(count);
  elements["flow-run"].textContent = compactNumber(active);
  elements["flow-verify"].textContent = verifyVisible ? compactNumber(verifyVisible) : "—";
  elements["flow-verify"].title = "Succeeded jobs visible in this bounded page; open a row for authoritative outcome evidence.";
  elements["flow-recover"].textContent = compactNumber(attention) + attentionSuffix;
  elements["generated-at"].textContent = `Updated ${relativeTime(snapshot.generatedAt)}`;
}

function renderQueueList() {
  const snapshot = app.snapshot;
  const visibleCounts = {};
  snapshot.jobs.forEach((job) => {
    visibleCounts[job.queueName] = (visibleCounts[job.queueName] || 0) + 1;
  });
  elements["queue-list"].innerHTML = snapshot.queues.map((queue) => `
    <button class="queue-item ${queue === app.queue ? "is-active" : ""}" type="button" data-queue="${escapeAttribute(queue)}">
      <span class="queue-dot"></span>
      <span title="${escapeAttribute(queue)}">${escapeHTML(queue)}</span>
      <span class="queue-visible-count">${visibleCounts[queue] || ""}</span>
    </button>
  `).join("") || `<div class="empty-evidence">No queues are visible in this bounded page.</div>`;
  elements["queue-list"].querySelectorAll("[data-queue]").forEach((button) => {
    button.addEventListener("click", async () => {
      app.view = "jobs";
      app.queue = button.dataset.queue;
      syncURLQuery();
      app.stateFilter = "";
      app.stageFilter = "";
      document.querySelectorAll("[data-view]").forEach((item) => {
        item.classList.toggle("is-active", item.dataset.view === "jobs");
      });
      await loadSnapshot();
    });
  });
}

function setView(view, options = {}) {
  if (!viewDefinitions[view]) return;
  app.view = view;
  const resetQueue = app.queue && (view === "findings" || view === "rules");
  if (resetQueue) {
    app.queue = "";
    syncURLQuery();
  }
  if (!options.preserveFilters) {
    app.stateFilter = "";
    app.stageFilter = "";
  }
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
  closeMobileLayers();
  if (resetQueue) {
    loadSnapshot();
    return;
  }
  renderCurrentView();
}

function renderCurrentView() {
  if (!app.snapshot) return;
  const definition = viewDefinitions[app.view];
  elements["view-eyebrow"].textContent = definition.eyebrow;
  elements["view-title"].textContent = definition.title;
  elements["view-description"].textContent = definition.description;
  elements["search-input"].placeholder = definition.placeholder;
  document.querySelectorAll("[data-stage]").forEach((button) => {
    button.classList.toggle("is-active", app.view === "jobs" && button.dataset.stage === app.stageFilter);
  });
  document.querySelectorAll("[data-state]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.state === app.stateFilter);
  });
  elements["state-filters"].hidden = app.view === "rules";

  const rows = filterRows(sourceRowsForView());
  app.visibleRows = rows;
  if (app.selectedIndex >= rows.length) {
    app.selectedIndex = rows.length - 1;
  }
  elements["table-head"].innerHTML = tableHeadForView(app.view);
  elements["table-body"].innerHTML = rows.map((row, index) => tableRowForView(app.view, row, index)).join("");
  elements["table-empty"].hidden = rows.length > 0;
  elements["row-summary"].textContent = `${rows.length} ${rows.length === 1 ? "row" : "rows"} · bounded local read`;
  renderActiveContext();
}

function sourceRowsForView() {
  switch (app.view) {
    case "attention": return app.snapshot.attention;
    case "findings": return app.snapshot.findings;
    case "rules": return app.snapshot.rules;
    default: return app.snapshot.jobs;
  }
}

function filterRows(rows) {
  return rows.filter((row) => {
    if (app.view === "jobs") {
      if (app.stageFilter && row.stage !== app.stageFilter) return false;
      if (app.stateFilter === "active" && !["pending", "leased", "retry_wait"].includes(row.state)) return false;
      if (app.stateFilter === "attention" && !["blocked", "dead"].includes(row.state)) return false;
      if (app.stateFilter === "succeeded" && row.state !== "succeeded") return false;
    }
    if (app.view === "attention" && app.stateFilter) {
      if (app.stateFilter === "attention" && true) {
        // Every row in this view already needs attention.
      } else if (app.stateFilter === "active" && row.jobState !== "blocked") {
        return false;
      } else if (app.stateFilter === "succeeded") {
        return false;
      }
    }
    if (!app.search) return true;
    return searchableText(row).includes(app.search);
  });
}

function searchableText(row) {
  return Object.values(row)
    .filter((value) => typeof value === "string" || typeof value === "number")
    .join(" ")
    .toLocaleLowerCase();
}

function tableHeadForView(view) {
  if (view === "attention") {
    return `<tr>
      <th style="width:18%">Kind</th>
      <th style="width:22%">Job / reference</th>
      <th style="width:37%">Reason</th>
      <th style="width:11%">State</th>
      <th style="width:12%">Observed</th>
    </tr>`;
  }
  if (view === "findings") {
    return `<tr>
      <th style="width:14%">Status</th>
      <th style="width:25%">Invariant</th>
      <th style="width:19%">Subject</th>
      <th style="width:10%">Seen</th>
      <th style="width:14%">Last seen</th>
      <th style="width:18%">Latest evidence</th>
    </tr>`;
  }
  if (view === "rules") {
    return `<tr>
      <th style="width:13%">Status</th>
      <th style="width:30%">Rule</th>
      <th style="width:11%">Scope</th>
      <th style="width:18%">Subject</th>
      <th style="width:12%">Schedule</th>
      <th style="width:7%">Version</th>
      <th style="width:9%">Updated</th>
    </tr>`;
  }
  return `<tr>
    <th style="width:25%">Job</th>
    <th style="width:12%">State</th>
    <th class="${columnClass("correlation")}" style="width:17%">Correlation</th>
    <th class="${columnClass("stage")}" style="width:10%">Stage</th>
    <th class="${columnClass("attempts")}" style="width:9%">Attempts</th>
    <th class="${columnClass("priority")}" style="width:9%">Priority</th>
    <th class="${columnClass("created")}" style="width:18%">Created</th>
  </tr>`;
}

function tableRowForView(view, row, index) {
  const selected = row.id && row.id === app.selectedJobId;
  if (view === "attention") {
    const reference = row.jobId || row.referenceId || "—";
    return `<tr data-row-index="${index}" data-job-id="${escapeAttribute(row.jobId || "")}" class="${row.jobId === app.selectedJobId ? "is-selected" : ""}">
      <td><span class="kind-badge" data-kind="${escapeAttribute(row.kind)}">${escapeHTML(humanize(row.kind))}</span></td>
      <td><div class="cell-stack"><strong>${escapeHTML(row.queue || "Business finding")}</strong><small title="${escapeAttribute(reference)}">${escapeHTML(reference)}</small></div></td>
      <td title="${escapeAttribute(row.reason)}">${escapeHTML(row.reason)}</td>
      <td>${stateBadge(row.jobState || "open")}</td>
      <td title="${escapeAttribute(formatDate(row.observedAt))}">${relativeTime(row.observedAt)}</td>
    </tr>`;
  }
  if (view === "findings") {
    return `<tr data-row-index="${index}">
      <td><span class="cell-primary"><span class="state-mark" data-state="${escapeAttribute(row.status)}"></span>${stateBadge(row.status)}</span></td>
      <td><div class="cell-stack"><strong>${escapeHTML(row.ruleId)}</strong><small>contract v${row.invariantVersion}</small></div></td>
      <td><div class="cell-stack"><strong>${escapeHTML(row.subjectId)}</strong><small>${escapeHTML(row.subjectType)}</small></div></td>
      <td><span class="mono">${row.occurrenceCount}×</span></td>
      <td title="${escapeAttribute(formatDate(row.lastSeen))}">${relativeTime(row.lastSeen)}</td>
      <td class="mono muted" title="${escapeAttribute(row.latestEvidence || "")}">${escapeHTML(row.latestEvidence || "—")}</td>
    </tr>`;
  }
  if (view === "rules") {
    return `<tr data-row-index="${index}">
      <td><span class="cell-primary"><span class="state-mark" data-state="${escapeAttribute(row.status)}"></span>${stateBadge(row.status)}</span></td>
      <td><div class="cell-stack"><strong>${escapeHTML(row.name)}</strong><small>${escapeHTML(row.id)}</small></div></td>
      <td><span class="stage-badge">${escapeHTML(row.scope)}</span></td>
      <td><div class="cell-stack"><strong>${escapeHTML(row.subjectType)}</strong><small>${escapeHTML(row.jobName || "business table")}</small></div></td>
      <td>${formatDuration(row.every)}</td>
      <td><span class="mono">v${row.version}</span></td>
      <td title="${escapeAttribute(formatDate(row.updatedAt))}">${relativeTime(row.updatedAt)}</td>
    </tr>`;
  }
  return `<tr data-row-index="${index}" data-job-id="${escapeAttribute(row.id)}" class="${selected ? "is-selected" : ""}">
    <td>
      <div class="cell-primary">
        <span class="state-mark" data-state="${escapeAttribute(row.state)}"></span>
        <div class="cell-stack">
          <strong>${escapeHTML(row.jobName)}</strong>
          <small title="${escapeAttribute(row.id)}">${escapeHTML(shortID(row.id))}</small>
        </div>
      </div>
    </td>
    <td>${stateBadge(row.state)}</td>
    <td class="${columnClass("correlation")}" title="${escapeAttribute(row.correlationId || "")}"><span class="mono">${escapeHTML(row.correlationId || "—")}</span></td>
    <td class="${columnClass("stage")}"><span class="stage-badge" data-stage="${escapeAttribute(row.stage)}">${escapeHTML(row.stage)}</span></td>
    <td class="${columnClass("attempts")}"><span class="mono">${row.attempts}</span>${row.crashCount ? ` <span class="muted">· ${row.crashCount} crash</span>` : ""}</td>
    <td class="${columnClass("priority")}"><span class="mono ${row.priority > 0 ? "priority-positive" : row.priority < 0 ? "priority-negative" : ""}">${formatPriority(row.priority)}</span></td>
    <td class="${columnClass("created")}" title="${escapeAttribute(formatDate(row.createdAt))}">${relativeTime(row.createdAt)}</td>
  </tr>`;
}

function columnClass(column) {
  return app.columns[column] === false ? "column-hidden" : "";
}

function stateBadge(state) {
  const value = state || "unknown";
  return `<span class="state-badge" data-state="${escapeAttribute(value)}">${escapeHTML(humanize(value))}</span>`;
}

function renderActiveContext() {
  const contexts = [];
  if (app.queue) contexts.push(`queue = ${app.queue}`);
  if (app.stageFilter) contexts.push(`stage = ${app.stageFilter.toLocaleUpperCase()}`);
  if (app.stateFilter) contexts.push(`lens = ${app.stateFilter}`);
  if (app.search) contexts.push(`search = “${app.search}”`);
  elements["active-context"].hidden = contexts.length === 0;
  elements["active-context-copy"].textContent = contexts.join("  ·  ");
}

function clearFilters() {
  app.search = "";
  app.stateFilter = "";
  app.stageFilter = "";
  elements["search-input"].value = "";
  if (app.queue) {
    clearQueue();
    return;
  }
  renderCurrentView();
}

async function clearQueue() {
  if (!app.queue) {
    renderCurrentView();
    return;
  }
  app.queue = "";
  syncURLQuery();
  await loadSnapshot();
}

function syncURLQuery() {
  const url = new URL(window.location.href);
  if (app.queue) {
    url.searchParams.set("queue", app.queue);
  } else {
    url.searchParams.delete("queue");
  }
  window.history.replaceState(null, "", url);
}

function onTableClick(event) {
  const rowElement = event.target.closest("tr[data-row-index]");
  if (!rowElement) return;
  const index = Number(rowElement.dataset.rowIndex);
  app.selectedIndex = index;
  const row = app.visibleRows[index];
  const jobID = app.view === "jobs" ? row?.id : app.view === "attention" ? row?.jobId : "";
  if (jobID) {
    selectJob(jobID);
  } else if (app.view === "findings") {
    showToast("Finding selected. A subject timeline is planned; no write action is hidden here.");
  } else if (app.view === "rules") {
    showToast("Rule details remain read-only in Workbench v0.");
  }
}

async function selectJob(id, options = {}) {
  if (!id) return;
  app.selectedJobId = id;
  elements["rail-empty"].hidden = true;
  elements["rail-content"].hidden = false;
  elements["evidence-rail"].classList.add("is-open");
  if (window.innerWidth <= 1120) {
    elements["mobile-scrim"].hidden = false;
  }
  elements["rail-title"].textContent = "Loading evidence…";
  elements["rail-id"].textContent = id;
  renderCurrentView();
  if (!options.silentScroll) {
    document.querySelector("tr.is-selected")?.scrollIntoView({ block: "nearest" });
  }
  try {
    const detail = await fetchJSON(`/api/v1/jobs/${encodeURIComponent(id)}`);
    if (app.selectedJobId !== id) return;
    renderJobDetail(detail);
  } catch (error) {
    elements["rail-title"].textContent = "Evidence unavailable";
    elements["rail-notice"].textContent = error.message;
    showToast(error.message);
  }
}

function renderJobDetail(detail) {
  const job = detail.job;
  elements["rail-queue"].textContent = job.stage.toLocaleUpperCase();
  elements["rail-title"].textContent = job.jobName;
  elements["rail-id"].textContent = job.id;
  elements["rail-state"].className = "state-badge";
  elements["rail-state"].dataset.state = job.state;
  elements["rail-state"].textContent = humanize(job.state);

  renderTruthSeparation(detail);
  elements["job-context"].innerHTML = [
    ["Correlation", job.correlationId || "Not declared"],
    ["Queue", job.queueName],
    ["Group", job.groupKey || "Not partitioned"],
    ["Resource class", job.resourceClass || "standard"],
    ["Priority", formatPriority(job.priority)],
    ["Attempts", String(job.attempts)],
    ["Created", formatDate(job.createdAt)],
    ["Not before", formatDate(job.notBefore)],
  ].map(([term, value]) => `
    <div><dt>${escapeHTML(term)}</dt><dd title="${escapeAttribute(value)}">${escapeHTML(value)}</dd></div>
  `).join("");

  elements["attempt-total"].textContent = plural(detail.attempts.length, "event");
  elements["attempt-timeline"].innerHTML = detail.attempts.length
    ? detail.attempts.map(renderAttempt).join("")
    : `<li class="empty-evidence">No execution event has been recorded yet.</li>`;

  elements["effect-total"].textContent = plural(detail.effects.length, "effect");
  elements["effect-list"].innerHTML = detail.effects.length
    ? detail.effects.map(renderEffect).join("")
    : `<div class="empty-evidence">No external effect is declared for this job. This does not imply an effect happened.</div>`;

  elements["outcome-total"].textContent = plural(detail.outcomes.length, "observation");
  elements["outcome-list"].innerHTML = detail.outcomes.length
    ? detail.outcomes.map(renderOutcome).join("")
    : `<div class="empty-evidence">No outcome contract has produced evidence for this job.</div>`;

  elements["audit-total"].textContent = plural(detail.audit.length, "entry", "entries");
  elements["audit-list"].innerHTML = detail.audit.length
    ? detail.audit.map(renderAudit).join("")
    : `<div class="empty-evidence">No human decision has been written to the replay audit.</div>`;
  elements["rail-notice"].textContent = (detail.notices || []).join(" ");
  elements["rail-notice"].hidden = !(detail.notices || []).length;
}

function renderTruthSeparation(detail) {
  setTruth("request", "true", "Recorded durably");
  const effects = detail.effects;
  if (!effects.length) {
    setTruth("effect", "empty", "No declared effect");
  } else if (effects.some((item) => ["uncertain", "rejected"].includes(item.state))) {
    const risky = effects.filter((item) => ["uncertain", "rejected"].includes(item.state)).length;
    setTruth("effect", "risk", `${risky} unresolved of ${effects.length}`);
  } else if (effects.every((item) => ["confirmed", "not_happened"].includes(item.state))) {
    const confirmed = effects.filter((item) => item.state === "confirmed").length;
    setTruth("effect", "true", `${confirmed}/${effects.length} confirmed`);
  } else {
    const confirmed = effects.filter((item) => item.state === "confirmed").length;
    setTruth("effect", "pending", `${confirmed}/${effects.length} confirmed`);
  }

  const outcomes = [...detail.outcomes].sort((a, b) => b.contractVersion - a.contractVersion);
  const latest = outcomes[0];
  if (!latest) {
    setTruth("outcome", "empty", "No observation");
  } else if (latest.state === "achieved") {
    setTruth("outcome", "true", `Contract v${latest.contractVersion} achieved`);
  } else if (latest.state === "pending") {
    setTruth("outcome", "pending", `Contract v${latest.contractVersion} pending`);
  } else {
    setTruth("outcome", "risk", `${humanize(latest.state)} · contract v${latest.contractVersion}`);
  }
}

function setTruth(name, status, copy) {
  const dot = elements[`truth-${name}`];
  dot.className = `truth-status is-${status}`;
  elements[`truth-${name}-copy`].textContent = copy;
}

function renderAttempt(item) {
  const context = [
    `attempt ${item.attempt}`,
    item.leaseOwner ? item.leaseOwner : "",
    item.failureClass ? `failure: ${item.failureClass}` : "",
    item.blockedReason ? `blocked: ${item.blockedReason}` : "",
  ].filter(Boolean).join(" · ");
  return `<li class="timeline-item" data-kind="${escapeAttribute(item.kind)}">
    <span class="timeline-dot"></span>
    <div class="timeline-copy">
      <strong>${escapeHTML(humanize(item.kind))}</strong>
      <small title="${escapeAttribute(context)}">${escapeHTML(context)}</small>
    </div>
    <time class="timeline-time" title="${escapeAttribute(formatDate(item.occurredAt))}">${relativeTime(item.occurredAt)}</time>
  </li>`;
}

function renderEffect(item) {
  return `<article class="evidence-card">
    <div class="evidence-card-head">
      <strong>${escapeHTML(item.name)}</strong>
      ${stateBadge(item.state)}
    </div>
    <dl>
      <div><dt>Idempotency</dt><dd title="${escapeAttribute(item.idempotencyKey)}">${escapeHTML(item.idempotencyKey)}</dd></div>
      <div><dt>External ref</dt><dd title="${escapeAttribute(item.externalRef || "")}">${escapeHTML(item.externalRef || "Not recorded")}</dd></div>
      <div><dt>Effect policy</dt><dd>${item.irreversible ? "irreversible" : "reversible / idempotent"}</dd></div>
      <div><dt>Lease epoch</dt><dd>${item.leaseEpoch}</dd></div>
    </dl>
  </article>`;
}

function renderOutcome(item) {
  return `<article class="evidence-card">
    <div class="evidence-card-head">
      <strong>Contract v${item.contractVersion}</strong>
      ${stateBadge(item.state)}
    </div>
    <dl>
      <div><dt>Reason</dt><dd title="${escapeAttribute(item.reason || "")}">${escapeHTML(item.reason || "No reason recorded")}</dd></div>
      <div><dt>Record version</dt><dd>${item.observedVersion || "—"}</dd></div>
      <div><dt>Observed</dt><dd>${escapeHTML(formatDate(item.updatedAt))}</dd></div>
    </dl>
  </article>`;
}

function renderAudit(item) {
  return `<article class="evidence-card">
    <div class="evidence-card-head">
      <strong>${escapeHTML(humanize(item.action))}</strong>
      <span class="mono muted">${escapeHTML(relativeTime(item.occurredAt))}</span>
    </div>
    <dl>
      <div><dt>Actor</dt><dd>${escapeHTML(item.actor)}</dd></div>
      <div><dt>Reason</dt><dd title="${escapeAttribute(item.reason)}">${escapeHTML(item.reason)}</dd></div>
      <div><dt>Row hash</dt><dd title="${escapeAttribute(item.rowHash)}">${escapeHTML(shortHash(item.rowHash))}</dd></div>
    </dl>
  </article>`;
}

function closeRail() {
  elements["evidence-rail"].classList.remove("is-open");
  if (window.innerWidth > 1120) {
    elements["rail-content"].hidden = true;
    elements["rail-empty"].hidden = false;
    app.selectedJobId = "";
    renderCurrentView();
  }
  elements["mobile-scrim"].hidden = true;
}

function syncResponsiveRail() {
  if (window.innerWidth > 1120) {
    elements["mobile-scrim"].hidden = true;
    if (app.selectedJobId) {
      elements["evidence-rail"].classList.add("is-open");
    }
  } else if (!elements["evidence-rail"].classList.contains("is-open")) {
    elements["mobile-scrim"].hidden = true;
  }
}

async function copySelectedJobID() {
  if (!app.selectedJobId) return;
  try {
    await navigator.clipboard.writeText(app.selectedJobId);
    showToast("Job id copied");
  } catch (_) {
    showToast("Clipboard permission was unavailable");
  }
}

function openMobileNavigation() {
  elements["sidebar"].classList.add("is-open");
  elements["mobile-scrim"].hidden = false;
}

function closeMobileLayers() {
  elements["sidebar"].classList.remove("is-open");
  if (window.innerWidth <= 1120) {
    elements["evidence-rail"].classList.remove("is-open");
  }
  elements["mobile-scrim"].hidden = true;
}

function closeMenus() {
  [elements["density-menu"], elements["columns-menu"]].forEach((menu) => {
    menu.hidden = true;
  });
  [elements["density-button"], elements["columns-button"]].forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
}

function toggleTheme() {
  document.documentElement.dataset.theme =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("rhinoq.theme", document.documentElement.dataset.theme);
  updateThemeIcon();
}

function updateThemeIcon() {
  elements["theme-icon"].textContent = document.documentElement.dataset.theme === "dark" ? "☼" : "◐";
}

function paletteCommandDefinitions() {
  return [
    { id: "jobs", group: "Navigate", label: "Execution worktable", detail: "Inspect jobs and execution state", icon: "01", run: () => setView("jobs") },
    { id: "attention", group: "Navigate", label: "Needs attention", detail: "Open the bounded recovery inbox", icon: "04", run: () => setView("attention") },
    { id: "findings", group: "Navigate", label: "Integrity findings", detail: "Review persistent business drift", icon: "03", run: () => setView("findings") },
    { id: "rules", group: "Navigate", label: "Rules", detail: "Review deterministic invariant checks", icon: "R", run: () => setView("rules") },
    { id: "refresh", group: "Actions", label: "Refresh local evidence", detail: "Read the bounded snapshot again", icon: "↻", run: () => loadSnapshot() },
    { id: "search", group: "Actions", label: "Focus table search", detail: "Search the current view", icon: "/", run: () => elements["search-input"].focus() },
    { id: "theme", group: "Preferences", label: "Toggle color theme", detail: "Switch between light and dark", icon: "◐", run: toggleTheme },
    { id: "density", group: "Preferences", label: "Toggle table density", detail: "Switch compact and comfortable rows", icon: "≡", run: toggleDensity },
  ];
}

function openPalette() {
  elements["palette-input"].value = "";
  app.paletteIndex = 0;
  renderPalette();
  elements["command-palette"].showModal();
  window.setTimeout(() => elements["palette-input"].focus(), 0);
}

function renderPalette() {
  if (!elements["palette-results"]) return;
  const query = elements["palette-input"]?.value.trim().toLocaleLowerCase() || "";
  app.paletteCommands = paletteCommandDefinitions().filter((command) =>
    `${command.label} ${command.detail} ${command.group}`.toLocaleLowerCase().includes(query)
  );
  if (app.paletteIndex >= app.paletteCommands.length) app.paletteIndex = 0;
  let group = "";
  const output = [];
  app.paletteCommands.forEach((command, index) => {
    if (command.group !== group) {
      group = command.group;
      output.push(`<p class="palette-group-label">${escapeHTML(group)}</p>`);
    }
    output.push(`<button class="palette-item ${index === app.paletteIndex ? "is-active" : ""}" type="button" data-command-index="${index}">
      <span class="palette-item-icon">${escapeHTML(command.icon)}</span>
      <span class="palette-item-copy"><strong>${escapeHTML(command.label)}</strong><small>${escapeHTML(command.detail)}</small></span>
      <kbd>↵</kbd>
    </button>`);
  });
  elements["palette-results"].innerHTML = output.join("") ||
    `<div class="empty-evidence">No local command matches this search.</div>`;
}

function onPaletteKeydown(event) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    app.paletteIndex = Math.min(app.paletteCommands.length - 1, app.paletteIndex + 1);
    renderPalette();
    scrollPaletteSelection();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    app.paletteIndex = Math.max(0, app.paletteIndex - 1);
    renderPalette();
    scrollPaletteSelection();
  } else if (event.key === "Enter") {
    event.preventDefault();
    runPaletteCommand(app.paletteIndex);
  }
}

function onPaletteClick(event) {
  const button = event.target.closest("[data-command-index]");
  if (!button) return;
  runPaletteCommand(Number(button.dataset.commandIndex));
}

function runPaletteCommand(index) {
  const command = app.paletteCommands[index];
  if (!command) return;
  elements["command-palette"].close();
  command.run();
}

function scrollPaletteSelection() {
  elements["palette-results"].querySelector(".palette-item.is-active")?.scrollIntoView({ block: "nearest" });
}

function toggleDensity() {
  const next = document.documentElement.dataset.density === "compact" ? "comfortable" : "compact";
  document.documentElement.dataset.density = next;
  localStorage.setItem("rhinoq.density", next);
}

function onGlobalKeydown(event) {
  const tag = document.activeElement?.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable;
  if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
    event.preventDefault();
    openPalette();
    return;
  }
  if (event.key === "/" && !typing) {
    event.preventDefault();
    elements["search-input"].focus();
    return;
  }
  if (event.key === "Escape") {
    closeMenus();
    if (elements["command-palette"].open) {
      elements["command-palette"].close();
    } else if (elements["sidebar"].classList.contains("is-open")) {
      closeMobileLayers();
    } else if (app.selectedJobId) {
      closeRail();
    }
    return;
  }
  if (typing || elements["command-palette"].open || !app.visibleRows.length) return;
  if (event.key.toLocaleLowerCase() === "j" || event.key === "ArrowDown") {
    event.preventDefault();
    moveSelection(1);
  } else if (event.key.toLocaleLowerCase() === "k" || event.key === "ArrowUp") {
    event.preventDefault();
    moveSelection(-1);
  } else if (event.key === "Enter") {
    const row = app.visibleRows[app.selectedIndex];
    const jobID = app.view === "jobs" ? row?.id : app.view === "attention" ? row?.jobId : "";
    if (jobID) selectJob(jobID);
  }
}

function moveSelection(delta) {
  const next = Math.max(0, Math.min(app.visibleRows.length - 1, app.selectedIndex + delta));
  app.selectedIndex = next;
  const row = app.visibleRows[next];
  const jobID = app.view === "jobs" ? row?.id : app.view === "attention" ? row?.jobId : "";
  if (jobID) {
    selectJob(jobID);
  } else {
    renderCurrentView();
    document.querySelector(`tr[data-row-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  }
}

function showToast(message) {
  elements["toast"].textContent = message;
  elements["toast"].hidden = false;
  window.clearTimeout(app.refreshTimer);
  app.refreshTimer = window.setTimeout(() => {
    elements["toast"].hidden = true;
  }, 2600);
}

function countStates(counts, states) {
  return states.reduce((sum, state) => sum + Number(counts[state] || 0), 0);
}

function sumCounts(counts) {
  return Object.values(counts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

function compactNumber(value) {
  return new Intl.NumberFormat(undefined, { notation: value > 9999 ? "compact" : "standard" }).format(value || 0);
}

function relativeTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 60) return formatter.format(seconds, "second");
  if (absolute < 3600) return formatter.format(Math.round(seconds / 60), "minute");
  if (absolute < 86400) return formatter.format(Math.round(seconds / 3600), "hour");
  return formatter.format(Math.round(seconds / 86400), "day");
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() <= 1) return "Immediately";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

function formatDuration(nanoseconds) {
  const seconds = Number(nanoseconds || 0) / 1e9;
  if (!seconds) return "Manual";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function formatPriority(value) {
  const number = Number(value || 0);
  return number > 0 ? `+${number}` : String(number);
}

function humanize(value) {
  return String(value || "unknown").replaceAll("_", " ").replaceAll("-", " ");
}

function shortID(value) {
  const text = String(value || "");
  if (text.length <= 24) return text;
  return `${text.slice(0, 13)}…${text.slice(-7)}`;
}

function shortHash(value) {
  const text = String(value || "");
  if (text.length <= 18) return text || "—";
  return `${text.slice(0, 10)}…${text.slice(-6)}`;
}

function plural(count, singular, pluralValue) {
  return `${count} ${count === 1 ? singular : (pluralValue || `${singular}s`)}`;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHTML(value).replaceAll("`", "&#096;");
}
