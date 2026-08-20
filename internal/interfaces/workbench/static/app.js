"use strict";

const app = {
  snapshot: null,
  view: "jobs",
  queue: "",
  search: "",
  stateFilter: "",
  stageFilter: "",
  selectedJobId: "",
  selectedSubject: null,
  selectedSubjectDetail: null,
  selectedRuleId: "",
  repairPlan: null,
  selectedJobs: new Set(),
  bulkPlan: null,
  savedViews: [],
  realtime: null,
  realtimeFallback: null,
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
  recurring: [],
  recurringTenant: "",
};

const viewDefinitions = {
  jobs: {
    eyebrow: "OPERATIONS / TASKS",
    title: "Tasks",
    description: "Monitor background work, investigate failures, and verify outcomes.",
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
    title: "Findings",
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

viewDefinitions.recurring = {
  eyebrow: "AUTOMATE",
  title: "Recurring schedules",
  description: "Inspect and safely pause or resume durable task schedules.",
  placeholder: "Search schedule, task or owner...",
};

const elements = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  restorePreferences();
  configurePlatformKeys();
  app.queue = new URLSearchParams(window.location.search).get("queue") || "";
  app.recurringTenant = new URLSearchParams(window.location.search).get("tenant") || "";
  const initialParams = new URLSearchParams(window.location.search);
  app.view = viewDefinitions[initialParams.get("view")] ? initialParams.get("view") : "jobs";
  app.stateFilter = initialParams.get("state") || "";
  app.stageFilter = initialParams.get("stage") || "";
  app.search = initialParams.get("q") || "";
  bindEvents();
  elements["search-input"].value = app.search;
  renderPalette();
  loadSnapshot({ initial: true });
});

function cacheElements() {
  [
    "source-label", "source-mode", "connection-label", "jobs-count", "attention-count",
    "findings-count", "rules-count", "recurring-count", "queue-list", "clear-queue", "view-eyebrow",
    "view-title", "view-description", "refresh-button", "flow-commit", "flow-run",
    "flow-verify", "flow-recover", "search-input", "state-filters", "density-button",
    "density-menu", "columns-button", "columns-menu", "active-context",
    "active-context-copy", "clear-context", "table-scroll", "data-table", "table-head",
    "table-body", "table-loading", "table-empty", "table-empty-title", "table-empty-copy", "empty-clear", "row-summary",
    "generated-at", "evidence-rail", "rail-resizer", "rail-empty", "rail-content", "rail-queue",
    "rail-title", "rail-close", "rail-id", "copy-job-id", "truth-request",
    "truth-request-copy", "truth-effect", "truth-effect-copy", "truth-outcome",
    "truth-outcome-copy", "rail-state", "job-context", "flight-total",
    "flight-timeline", "attempt-diff-panel", "attempt-from", "attempt-to", "attempt-diff-content",
    "progress-content", "progress-updated", "bulk-toolbar", "bulk-selection-count", "clear-selection-button", "bulk-preview-button",
    "views-button", "views-menu", "save-view-button", "copy-view-button", "saved-view-list",
    "bulk-dialog", "bulk-dialog-content", "bulk-approve-button", "bulk-execute-button",
    "effect-total", "effect-list", "outcome-total", "outcome-list",
    "audit-section", "audit-total", "audit-list", "rail-subject", "rail-notice",
    "command-trigger",
    "command-palette", "palette-input", "palette-results",
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
  // A stored preference from an older build must not override the current
  // daylight operator surface.
  localStorage.removeItem("rhinoq.theme");
  document.documentElement.dataset.theme = "light";

  const density = localStorage.getItem("rhinoq.density") || "compact";
  document.documentElement.dataset.density = density;

  try {
    const storedColumns = JSON.parse(localStorage.getItem("rhinoq.columns") || "{}");
    app.columns = { ...app.columns, ...storedColumns };
  } catch (_) {
    // Corrupt local preferences should never block the local inspector.
  }
  try {
    app.savedViews = JSON.parse(localStorage.getItem("rhinoq.savedViews") || "[]");
  } catch (_) {
    app.savedViews = [];
  }
  document.querySelectorAll("[data-column-toggle]").forEach((input) => {
    input.checked = app.columns[input.dataset.columnToggle] !== false;
  });

  const storedRailWidth = Number(localStorage.getItem("rhinoq.railWidth"));
  if (Number.isFinite(storedRailWidth) && storedRailWidth >= 360) {
    setRailWidth(storedRailWidth);
  }
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
  document.querySelectorAll("[data-stage]").forEach((button) => {
    button.addEventListener("click", () => {
      app.stageFilter = app.stageFilter === button.dataset.stage ? "" : button.dataset.stage;
      app.stateFilter = "";
      syncURLQuery();
      setView("jobs", { preserveFilters: true });
    });
  });
  document.querySelectorAll("[data-state]").forEach((button) => {
    button.addEventListener("click", () => {
      app.stateFilter = button.dataset.state;
      app.stageFilter = "";
      syncURLQuery();
      renderCurrentView();
    });
  });
  elements["search-input"].addEventListener("input", (event) => {
    app.search = event.target.value.trim().toLocaleLowerCase();
    syncURLQuery();
    renderCurrentView();
  });
  elements["refresh-button"].addEventListener("click", () => loadSnapshot());
  elements["clear-queue"].addEventListener("click", clearQueue);
  elements["clear-context"].addEventListener("click", clearFilters);
  elements["empty-clear"].addEventListener("click", clearFilters);
  elements["table-body"].addEventListener("click", onTableClick);
  elements["table-body"].addEventListener("change", onTableSelectionChange);
  elements["clear-selection-button"].addEventListener("click", clearSelection);
  elements["bulk-preview-button"].addEventListener("click", openBulkPreview);
  elements["bulk-approve-button"].addEventListener("click", approveBulkPlan);
  elements["bulk-execute-button"].addEventListener("click", executeBulkPlan);
  elements["rail-close"].addEventListener("click", closeRail);
  elements["rail-subject"].addEventListener("click", onSubjectAction);
  elements["rail-subject"].addEventListener("submit", onRailFormSubmit);
  elements["copy-job-id"].addEventListener("click", copySelectedJobID);
  elements["attempt-from"].addEventListener("change", renderAttemptDiff);
  elements["attempt-to"].addEventListener("change", renderAttemptDiff);

  bindMenu(elements["density-button"], elements["density-menu"]);
  bindMenu(elements["columns-button"], elements["columns-menu"]);
  bindMenu(elements["views-button"], elements["views-menu"]);
  elements["save-view-button"].addEventListener("click", saveCurrentView);
  elements["copy-view-button"].addEventListener("click", copyCurrentViewLink);
  elements["saved-view-list"].addEventListener("click", onSavedViewClick);
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

  elements["command-trigger"].addEventListener("click", openPalette);
  elements["palette-input"].addEventListener("input", renderPalette);
  elements["palette-input"].addEventListener("keydown", onPaletteKeydown);
  elements["palette-results"].addEventListener("click", onPaletteClick);

  elements["mobile-nav-button"].addEventListener("click", openMobileNavigation);
  elements["mobile-scrim"].addEventListener("click", closeMobileLayers);
  elements["rail-resizer"].addEventListener("pointerdown", beginRailResize);
  elements["rail-resizer"].addEventListener("keydown", resizeRailWithKeyboard);
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
    renderSavedViews();
    if (options.initial) startRealtime();
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

function startRealtime() {
  if (!window.EventSource || app.realtime) return;
  const params = new URLSearchParams({ limit: "150" });
  if (app.queue) params.set("queue", app.queue);
  app.realtime = new EventSource(`/api/v1/stream?${params}`);
  app.realtime.addEventListener("snapshot", (event) => {
    try {
      app.snapshot = JSON.parse(event.data);
      renderSnapshotChrome();
      renderQueueList();
      renderCurrentView();
      elements["connection-label"].textContent = "Live updates";
    } catch (_) {
      // Keep the last valid snapshot when a frame cannot be decoded.
    }
  });
  app.realtime.onerror = () => {
    elements["connection-label"].textContent = "Reconnecting…";
    if (!app.realtimeFallback) {
      app.realtimeFallback = window.setInterval(() => loadSnapshot(), 12000);
    }
  };
  app.realtime.onopen = () => {
    elements["connection-label"].textContent = "Live updates";
    if (app.realtimeFallback) {
      window.clearInterval(app.realtimeFallback);
      app.realtimeFallback = null;
    }
  };
}

function restartRealtime() {
  if (app.realtime) {
    app.realtime.close();
    app.realtime = null;
  }
  startRealtime();
}

async function fetchJSON(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
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
  elements["connection-label"].textContent = snapshot.source.readOnly ? "Read-only" : "Connected";
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
  const visibleTotal = Object.values(visibleCounts).reduce((sum, value) => sum + value, 0);
  elements["clear-queue"].hidden = !app.queue;
  const allQueues = `<button class="queue-item queue-item-all ${app.queue ? "" : "is-active"}" type="button" data-queue="">
    <span class="queue-all-mark" aria-hidden="true"></span>
    <span>All queues</span>
    <span class="queue-visible-count">${visibleTotal}</span>
  </button>`;
  elements["queue-list"].innerHTML = allQueues + snapshot.queues.map((queue) => `
    <button class="queue-item ${queue === app.queue ? "is-active" : ""}" type="button" data-queue="${escapeAttribute(queue)}">
      <span class="queue-dot"></span>
      <span title="${escapeAttribute(queue)}">${escapeHTML(queue)}</span>
      <span class="queue-visible-count">${visibleCounts[queue] || ""}</span>
    </button>
  `).join("");
  elements["queue-list"].querySelectorAll("[data-queue]").forEach((button) => {
    button.addEventListener("click", async () => {
      app.view = "jobs";
      app.queue = button.dataset.queue;
      syncURLQuery();
      app.stateFilter = "";
      app.stageFilter = "";
      restartRealtime();
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
  const resetQueue = app.queue && (view === "findings" || view === "rules" || view === "recurring");
  if (resetQueue) {
    app.queue = "";
    syncURLQuery();
  }
  if (!options.preserveFilters) {
    app.stateFilter = "";
    app.stageFilter = "";
  }
  syncURLQuery();
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
  closeMobileLayers();
  if (resetQueue) {
    loadSnapshot();
  } else {
    renderCurrentView();
  }
  if (view === "recurring") loadRecurring();
}

async function loadRecurring() {
  if (!app.recurringTenant) {
    app.recurring = [];
    elements["recurring-count"].textContent = "--";
    renderCurrentView();
    showToast("Add ?tenant=<tenant-id> to inspect recurring schedules");
    return;
  }
  try {
    const params = new URLSearchParams({ tenantId: app.recurringTenant, limit: "150" });
    app.recurring = await fetchJSON(`/api/v1/recurring-schedules?${params}`);
    elements["recurring-count"].textContent = compactNumber(app.recurring.length);
    renderCurrentView();
  } catch (error) {
    showToast(error.message);
  }
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
  elements["state-filters"].hidden = app.view === "rules" || app.view === "recurring";

  const rows = filterRows(sourceRowsForView());
  app.visibleRows = rows;
  if (app.selectedIndex >= rows.length) {
    app.selectedIndex = rows.length - 1;
  }
  elements["table-head"].innerHTML = tableHeadForView(app.view);
  elements["table-body"].innerHTML = rows.map((row, index) => tableRowForView(app.view, row, index)).join("");
  elements["table-empty"].hidden = rows.length > 0;
  if (app.view === "recurring" && !app.recurringTenant) {
    elements["table-empty-title"].textContent = "Choose a tenant to inspect schedules";
    elements["table-empty-copy"].textContent = "Open Workbench with ?tenant=<tenant-id>. RhinoQ never guesses a tenant for operator actions.";
  } else if (app.view === "recurring") {
    elements["table-empty-title"].textContent = "No recurring schedules in this tenant";
    elements["table-empty-copy"].textContent = "Create a durable interval schedule or search another tenant.";
  } else {
    elements["table-empty-title"].textContent = "No rows match this lens";
    elements["table-empty-copy"].textContent = "Clear the filter or search another correlation id.";
  }
  elements["row-summary"].textContent = `${rows.length} ${rows.length === 1 ? "row" : "rows"} · bounded local read`;
  renderActiveContext();
  renderBulkToolbar();
  const selectAll = document.querySelector("#select-all-jobs");
  if (selectAll && rows.length) selectAll.checked = rows.every((row) => app.selectedJobs.has(row.id));
}

function sourceRowsForView() {
  switch (app.view) {
    case "attention": return app.snapshot.attention;
    case "findings": return app.snapshot.findings;
    case "rules": return app.snapshot.rules;
    case "recurring": return app.recurring;
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
  if (view === "recurring") {
    return `<tr>
      <th style="width:25%">Task / schedule</th>
      <th style="width:14%">State</th>
      <th style="width:14%">Interval</th>
      <th style="width:20%">Next run</th>
      <th style="width:12%">Version</th>
      <th style="width:15%">Action</th>
    </tr>`;
  }
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
    <th class="select-column"><input type="checkbox" id="select-all-jobs" aria-label="Select all visible jobs"></th>
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
  if (view === "recurring") {
    const state = row.enabled ? "enabled" : "disabled";
    const action = row.enabled ? "pause" : "resume";
    const disabled = app.snapshot?.source?.readOnly ? "disabled" : "";
    return `<tr data-row-index="${index}">
      <td><div class="cell-stack"><strong>${escapeHTML(row.taskName)}</strong><small title="${escapeAttribute(row.id)}">${escapeHTML(row.id)} · ${escapeHTML(row.ownerId)}</small></div></td>
      <td>${stateBadge(state)}</td>
      <td><span class="mono">${row.cron ? `${escapeHTML(row.cron)} · ${escapeHTML(row.timezone)}` : formatDuration(row.every)}</span></td>
      <td title="${escapeAttribute(formatDate(row.nextRunAt))}">${relativeTime(row.nextRunAt)}</td>
      <td><span class="mono">v${row.version}</span></td>
      <td><button class="secondary-button" type="button" data-recurring-action="${action}" ${disabled}>${humanize(action)}</button></td>
    </tr>`;
  }
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
    return `<tr data-row-index="${index}" data-subject-type="${escapeAttribute(row.subjectType)}" data-subject-id="${escapeAttribute(row.subjectId)}" class="${isSelectedSubject(row) ? "is-selected" : ""}">
      <td><span class="cell-primary"><span class="state-mark" data-state="${escapeAttribute(row.status)}"></span>${stateBadge(row.status)}</span></td>
      <td><div class="cell-stack"><strong>${escapeHTML(row.ruleId)}</strong><small>contract v${row.invariantVersion}</small></div></td>
      <td><div class="cell-stack"><strong>${escapeHTML(row.subjectId)}</strong><small>${escapeHTML(row.subjectType)}</small></div></td>
      <td><span class="mono">${row.occurrenceCount}×</span></td>
      <td title="${escapeAttribute(formatDate(row.lastSeen))}">${relativeTime(row.lastSeen)}</td>
      <td class="mono muted" title="${escapeAttribute(row.latestEvidence || "")}">${escapeHTML(row.latestEvidence || "—")}</td>
    </tr>`;
  }
  if (view === "rules") {
    return `<tr data-row-index="${index}" data-rule-id="${escapeAttribute(row.id)}" class="${row.id === app.selectedRuleId ? "is-selected" : ""}">
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
    <td class="select-column"><input class="row-select" type="checkbox" data-job-select="${escapeAttribute(row.id)}" aria-label="Select ${escapeAttribute(row.jobName)}" ${app.selectedJobs.has(row.id) ? "checked" : ""}></td>
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
  syncURLQuery();
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
  if (app.view !== "jobs") url.searchParams.set("view", app.view); else url.searchParams.delete("view");
  if (app.stateFilter) url.searchParams.set("state", app.stateFilter); else url.searchParams.delete("state");
  if (app.stageFilter) url.searchParams.set("stage", app.stageFilter); else url.searchParams.delete("stage");
  if (app.search) url.searchParams.set("q", app.search); else url.searchParams.delete("q");
  window.history.replaceState(null, "", url);
}

function currentViewState() {
  return { view: app.view, queue: app.queue, state: app.stateFilter, stage: app.stageFilter, q: app.search };
}

function saveCurrentView() {
  const name = window.prompt("Name this saved view", `${viewDefinitions[app.view].title}${app.queue ? ` · ${app.queue}` : ""}`);
  if (!name?.trim()) return;
  const view = { id: `view_${Date.now()}`, name: name.trim(), state: currentViewState() };
  app.savedViews = [view, ...app.savedViews.filter((item) => item.name !== view.name)].slice(0, 12);
  localStorage.setItem("rhinoq.savedViews", JSON.stringify(app.savedViews));
  renderSavedViews();
  closeMenus();
  showToast("View saved. The link can be shared with the same filters.");
}

function renderSavedViews() {
  if (!elements["saved-view-list"]) return;
  elements["saved-view-list"].innerHTML = app.savedViews.length ? app.savedViews.map((item) => `<button type="button" class="saved-view-item" data-saved-view="${escapeAttribute(item.id)}"><span>${escapeHTML(item.name)}</span><small>${escapeHTML(viewDefinitions[item.state.view]?.title || "Tasks")}</small></button>`).join("") : `<small class="saved-view-empty">No saved views yet</small>`;
}

function onSavedViewClick(event) {
  const button = event.target.closest("[data-saved-view]");
  if (!button) return;
  const saved = app.savedViews.find((item) => item.id === button.dataset.savedView);
  if (!saved) return;
  const state = saved.state;
  app.view = state.view || "jobs";
  app.queue = state.queue || "";
  app.stateFilter = state.state || "";
  app.stageFilter = state.stage || "";
  app.search = state.q || "";
  elements["search-input"].value = app.search;
  syncURLQuery();
  closeMenus();
  if (app.view === "jobs" && app.queue) loadSnapshot(); else renderCurrentView();
}

async function copyCurrentViewLink() {
  syncURLQuery();
  try {
    await navigator.clipboard.writeText(window.location.href);
    showToast("Share link copied");
  } catch (_) {
    showToast(window.location.href);
  }
  closeMenus();
}

function onTableClick(event) {
  if (event.target.closest(".row-select, #select-all-jobs")) return;
  const rowElement = event.target.closest("tr[data-row-index]");
  if (!rowElement) return;
  const index = Number(rowElement.dataset.rowIndex);
  app.selectedIndex = index;
  const row = app.visibleRows[index];
  const recurringAction = event.target.closest("[data-recurring-action]");
  if (app.view === "recurring" && recurringAction && row) {
    changeRecurring(row, recurringAction.dataset.recurringAction, recurringAction);
    return;
  }
  const jobID = app.view === "jobs" ? row?.id : app.view === "attention" ? row?.jobId : "";
  if (jobID) {
    selectJob(jobID);
  } else if (app.view === "findings" && row?.subjectType && row?.subjectId) {
    selectSubject({ type: row.subjectType, id: row.subjectId });
  } else if (app.view === "rules" && row) {
    selectRule(row);
  }
}

function onTableSelectionChange(event) {
  const selectAll = event.target.closest("#select-all-jobs");
  if (selectAll) {
    app.visibleRows.forEach((row) => selectAll.checked ? app.selectedJobs.add(row.id) : app.selectedJobs.delete(row.id));
  }
  const checkbox = event.target.closest("[data-job-select]");
  if (checkbox) {
    if (checkbox.checked) app.selectedJobs.add(checkbox.dataset.jobSelect);
    else app.selectedJobs.delete(checkbox.dataset.jobSelect);
  }
  renderCurrentView();
}

function clearSelection() {
  app.selectedJobs.clear();
  app.bulkPlan = null;
  renderCurrentView();
}

function renderBulkToolbar() {
  const visible = app.view === "jobs" && app.selectedJobs.size > 0;
  elements["bulk-toolbar"].hidden = !visible;
  elements["bulk-selection-count"].textContent = `${app.selectedJobs.size} selected`;
}

async function openBulkPreview() {
  if (!app.selectedJobs.size) return;
  elements["bulk-preview-button"].disabled = true;
  try {
    const plan = await fetchJSON("/api/v1/bulk/preview", {
      method: "POST", body: { action: "recheck", jobIds: Array.from(app.selectedJobs) },
    });
    app.bulkPlan = plan;
    renderBulkPlan(plan);
    elements["bulk-dialog"].showModal();
  } catch (error) {
    showToast(error.message);
  } finally {
    elements["bulk-preview-button"].disabled = false;
  }
}

function renderBulkPlan(plan) {
  const group = (label, items, tone) => `<section class="bulk-group" data-tone="${tone}"><div><strong>${label}</strong><span>${items.length}</span></div>${items.length ? `<ul>${items.map((item) => `<li><code>${escapeHTML(shortID(item.jobId))}</code><span>${escapeHTML(item.reason)}</span></li>`).join("")}</ul>` : `<p>None</p>`}</section>`;
  elements["bulk-dialog-content"].innerHTML = `<div class="bulk-summary"><div><span>Selected</span><strong>${plan.total}</strong></div><div data-tone="safe"><span>Safe</span><strong>${plan.safe.length}</strong></div><div data-tone="uncertain"><span>Uncertain</span><strong>${plan.uncertain.length}</strong></div><div data-tone="blocked"><span>Blocked</span><strong>${plan.blocked.length}</strong></div></div>${group("Safe to recheck", plan.safe, "safe")}${group("Uncertain evidence", plan.uncertain, "uncertain")}${group("Blocked by state", plan.blocked, "blocked")}<p class="bulk-safety-note">Only safe items can be approved. Uncertain and blocked items remain untouched until their evidence is resolved.</p>`;
  elements["bulk-approve-button"].disabled = !app.snapshot?.capabilities?.bulkActions || !plan.safe.length || plan.state !== "previewed";
  elements["bulk-execute-button"].disabled = !app.snapshot?.capabilities?.bulkActions || plan.state !== "approved";
}

async function approveBulkPlan() {
  if (!app.bulkPlan) return;
  const actor = window.prompt("Approver identity", "reviewer@example.com");
  const reason = actor && window.prompt("Approval reason", "Reviewed Safe / Uncertain / Blocked grouping");
  if (!actor || !reason) return;
  try {
    app.bulkPlan = await fetchJSON(`/api/v1/bulk/${encodeURIComponent(app.bulkPlan.id)}/approve`, { method: "POST", body: { actor, reason } });
    renderBulkPlan(app.bulkPlan);
    showToast("Bulk plan approved. Safe items are ready for execution.");
  } catch (error) { showToast(error.message); }
}

async function executeBulkPlan() {
  if (!app.bulkPlan) return;
  try {
    app.bulkPlan = await fetchJSON(`/api/v1/bulk/${encodeURIComponent(app.bulkPlan.id)}/execute`, { method: "POST", body: {} });
    renderBulkPlan(app.bulkPlan);
    showToast("Bulk action completed with post-verification.");
  } catch (error) { showToast(error.message); }
}

function selectRule(rule) {
  app.selectedRuleId = rule.id;
  app.selectedJobId = "";
  app.selectedSubject = null;
  setRailMode("subject");
  elements["rail-empty"].hidden = true;
  elements["rail-content"].hidden = false;
  elements["evidence-rail"].classList.add("is-open");
  if (window.innerWidth <= 1120) elements["mobile-scrim"].hidden = false;
  elements["rail-queue"].textContent = "RULE";
  elements["rail-title"].textContent = rule.name;
  elements["rail-id"].textContent = rule.id;
  elements["rail-notice"].textContent = "Rule inspection is read-only. Rule evaluation and mutations stay behind Application commands.";
  renderRuleDetail(rule);
  renderCurrentView();
}

function renderRuleDetail(rule) {
  const findings = (app.snapshot?.findings || []).filter((item) => item.ruleId === rule.id);
  const findingCards = findings.map((finding) => `<article class="evidence-card">
    <div class="evidence-card-head">
      <strong>${escapeHTML(finding.subjectId)}</strong>
      ${stateBadge(finding.status)}
    </div>
    <dl>
      <div><dt>Subject</dt><dd>${escapeHTML(finding.subjectType)}</dd></div>
      <div><dt>Occurrences</dt><dd>${finding.occurrenceCount}</dd></div>
      <div><dt>Last seen</dt><dd>${escapeHTML(formatDate(finding.lastSeen))}</dd></div>
    </dl>
  </article>`).join("");
  elements["rail-subject"].innerHTML = `
    <section class="rail-section rule-overview">
      <div class="rail-section-heading"><h3>Rule overview</h3>${stateBadge(rule.status)}</div>
      <dl class="detail-grid">
        <div><dt>Scope</dt><dd>${escapeHTML(humanize(rule.scope))}</dd></div>
        <div><dt>Subject type</dt><dd>${escapeHTML(rule.subjectType)}</dd></div>
        <div><dt>Job filter</dt><dd>${escapeHTML(rule.jobName || "All business records")}</dd></div>
        <div><dt>Schedule</dt><dd>${escapeHTML(formatDuration(rule.every))}</dd></div>
        <div><dt>Version</dt><dd>v${rule.version}</dd></div>
        <div><dt>Updated</dt><dd>${escapeHTML(formatDate(rule.updatedAt))}</dd></div>
      </dl>
    </section>
    <section class="rail-section rule-console">
      <div class="rail-section-heading"><div><h3>Test this Rule</h3><small class="section-kicker">Read-only preview against one subject</small></div><span>${rule.status === "enabled" ? "registered" : "draft"}</span></div>
      <form class="rule-test-form" data-rule-action="test"><label>Subject id<input name="subjectId" type="text" placeholder="report_3Q1N" required></label><button class="secondary-button" type="submit">Run preview</button></form>
      <div id="rule-test-result" class="rule-test-result" hidden></div>
    </section>
    <section class="rail-section">
      <div class="rail-section-heading"><h3>Version history</h3><span>${plural((rule.versions || []).length || 1, "version")}</span></div>
      <div class="version-list">${(rule.versions || [{version: rule.version, status: rule.status, updatedAt: rule.updatedAt}]).map((version) => `<div class="version-row"><span class="version-dot ${version.version === rule.version ? "is-current" : ""}"></span><div><strong>v${version.version}</strong><small>${escapeHTML(humanize(version.status))}${version.note ? ` · ${escapeHTML(version.note)}` : ""}</small></div><time>${escapeHTML(relativeTime(version.updatedAt))}</time></div>`).join("")}</div>
    </section>
    <section class="rail-section">
      <div class="rail-section-heading"><h3>Related findings</h3><span>${plural(findings.length, "finding")}</span></div>
      <div class="evidence-list">${findingCards || `<div class="empty-evidence">No finding in this bounded snapshot references this Rule.</div>`}</div>
    </section>`;
}

async function onRailFormSubmit(event) {
  const form = event.target.closest("[data-rule-action=\"test\"]");
  if (!form) return;
  event.preventDefault();
  const subjectID = new FormData(form).get("subjectId");
  const resultElement = form.parentElement.querySelector("#rule-test-result");
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const result = await fetchJSON(`/api/v1/rules/${encodeURIComponent(app.selectedRuleId)}/test`, { method: "POST", body: { subjectId: subjectID } });
    resultElement.hidden = false;
    resultElement.innerHTML = `<div class="rule-test-head"><strong>${escapeHTML(humanize(result.status))}</strong>${stateBadge(result.status === "pass" ? "succeeded" : "open")}</div><p>${escapeHTML(result.reason)}</p>${(result.samples || []).length ? `<ul>${result.samples.slice(0, 5).map((sample) => `<li><code>${escapeHTML(sample)}</code></li>`).join("")}</ul>` : ""}<small>Evaluated ${escapeHTML(relativeTime(result.evaluatedAt))} · Rule v${result.ruleVersion || "?"}</small>`;
  } catch (error) {
    resultElement.hidden = false;
    resultElement.innerHTML = `<p class="error-copy">${escapeHTML(error.message)}</p>`;
  } finally {
    button.disabled = false;
  }
}

async function changeRecurring(schedule, action, button) {
  const verb = action === "pause" ? "pause" : "resume";
  if (!window.confirm(`${humanize(verb)} recurring schedule ${schedule.id}?`)) return;
  button.disabled = true;
  try {
    const updated = await fetchJSON(`/api/v1/recurring-schedules/${encodeURIComponent(schedule.id)}/${verb}`, {
      method: "POST",
      body: { tenantId: app.recurringTenant, version: schedule.version },
    });
    app.recurring = app.recurring.map((item) => item.id === updated.id ? updated : item);
    renderCurrentView();
    showToast(`Schedule ${verb === "pause" ? "paused" : "resumed"}`);
  } catch (error) {
    button.disabled = false;
    showToast(error.message);
  }
}

async function selectJob(id, options = {}) {
  if (!id) return;
  app.selectedJobId = id;
  app.selectedSubject = null;
  setRailMode("job");
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

  renderProgress(job.progress);

  const flight = detail.flight || [];
  elements["flight-total"].textContent = plural(flight.length, "event");
  elements["flight-timeline"].innerHTML = flight.length
    ? flight.map(renderFlightEvent).join("")
    : `<li class="empty-evidence">No execution event has been recorded yet.</li>`;
  renderAttemptDiffControls(detail.attempts);

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

function renderProgress(progress) {
  if (!progress?.hasData) {
    elements["progress-content"].innerHTML = `<div class="progress-empty"><span class="progress-empty-mark">—</span><div><strong>No progress data available</strong><p>This Task has not reported a bounded completed/total value. RhinoQ will not invent an ETA.</p></div></div>`;
    elements["progress-updated"].textContent = "No data";
    return;
  }
  const completed = Number(progress.completed || 0);
  const total = progress.total == null ? null : Number(progress.total);
  const percent = total && total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : null;
  elements["progress-updated"].textContent = progress.updatedAt ? `Updated ${relativeTime(progress.updatedAt)}` : "Live value";
  elements["progress-content"].innerHTML = `<div class="progress-hero"><div class="progress-value"><strong>${total == null ? escapeHTML(String(completed)) : `${escapeHTML(String(completed))} / ${escapeHTML(String(total))}`}</strong>${percent == null ? `<span>completed</span>` : `<span>${percent}%</span>`}</div>${percent == null ? `<div class="progress-track is-indeterminate"><span></span></div>` : `<div class="progress-track"><span style="width:${percent}%"></span></div>`}<p>${escapeHTML(progress.message || "Worker reported progress")}</p></div>`;
}

function renderFlightEvent(item) {
  const detail = [item.detail, item.actor ? `by ${item.actor}` : "", item.reference].filter(Boolean).join(" · ");
  return `<li class="timeline-item flight-event" data-kind="${escapeAttribute(item.kind)}" data-status="${escapeAttribute(item.status || "")}">
    <span class="timeline-dot"></span><div class="timeline-copy"><strong>${escapeHTML(item.title)}</strong><small>${escapeHTML(detail || "Recorded by RhinoQ")}</small></div><time class="timeline-time" title="${escapeAttribute(formatDate(item.occurredAt))}">${relativeTime(item.occurredAt)}</time>
  </li>`;
}

function renderAttemptDiffControls(attempts) {
  const options = attempts.map((item) => `<option value="${item.sequence}">Attempt ${item.attempt} · ${escapeHTML(humanize(item.kind))}</option>`).join("");
  elements["attempt-from"].innerHTML = options;
  elements["attempt-to"].innerHTML = options;
  if (attempts.length > 1) {
    elements["attempt-from"].value = String(attempts[0].sequence);
    elements["attempt-to"].value = String(attempts[attempts.length - 1].sequence);
    elements["attempt-diff-panel"].hidden = false;
    elements["attempt-diff-panel"].open = false;
    app.currentAttempts = attempts;
  } else {
    elements["attempt-diff-panel"].hidden = true;
  }
}

function renderAttemptDiff() {
  const attempts = app.currentAttempts || [];
  const from = attempts.find((item) => String(item.sequence) === elements["attempt-from"].value);
  const to = attempts.find((item) => String(item.sequence) === elements["attempt-to"].value);
  if (!from || !to) return;
  const rows = [["State", from.resultState || "—", to.resultState || "—"], ["Failure", from.failureClass || "—", to.failureClass || "—"], ["Lease owner", from.leaseOwner || "—", to.leaseOwner || "—"], ["Blocked reason", from.blockedReason || "—", to.blockedReason || "—"]];
  elements["attempt-diff-content"].innerHTML = `<div class="diff-header"><span></span><strong>Attempt ${from.attempt}</strong><strong>Attempt ${to.attempt}</strong></div>${rows.map((row) => `<div class="diff-row"><span>${row[0]}</span><span>${escapeHTML(row[1])}</span><span class="${row[1] !== row[2] ? "is-changed" : ""}">${escapeHTML(row[2])}</span></div>`).join("")}`;
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
    app.selectedRuleId = "";
    app.selectedSubject = null;
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

function setRailWidth(width) {
  const maximum = Math.min(720, Math.max(420, window.innerWidth - 720));
  const next = Math.max(360, Math.min(maximum, Math.round(width)));
  document.documentElement.style.setProperty("--rail-width", `${next}px`);
  localStorage.setItem("rhinoq.railWidth", String(next));
  elements["rail-resizer"].setAttribute("aria-valuenow", String(next));
}

function beginRailResize(event) {
  if (window.innerWidth <= 1120) return;
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = elements["evidence-rail"].getBoundingClientRect().width;
  document.body.classList.add("is-resizing-rail");
  elements["rail-resizer"].setPointerCapture(event.pointerId);
  const move = (moveEvent) => setRailWidth(startWidth + startX - moveEvent.clientX);
  const finish = () => {
    document.body.classList.remove("is-resizing-rail");
    elements["rail-resizer"].removeEventListener("pointermove", move);
    elements["rail-resizer"].removeEventListener("pointerup", finish);
    elements["rail-resizer"].removeEventListener("pointercancel", finish);
  };
  elements["rail-resizer"].addEventListener("pointermove", move);
  elements["rail-resizer"].addEventListener("pointerup", finish);
  elements["rail-resizer"].addEventListener("pointercancel", finish);
}

function resizeRailWithKeyboard(event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const current = elements["evidence-rail"].getBoundingClientRect().width;
  setRailWidth(current + (event.key === "ArrowLeft" ? 32 : -32));
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

function paletteCommandDefinitions() {
  return [
    { id: "jobs", group: "Navigate", label: "Tasks", detail: "Inspect background work and execution state", icon: "01", run: () => setView("jobs") },
    { id: "attention", group: "Navigate", label: "Needs attention", detail: "Open the bounded recovery inbox", icon: "04", run: () => setView("attention") },
    { id: "findings", group: "Navigate", label: "Findings", detail: "Review persistent business drift", icon: "03", run: () => setView("findings") },
    { id: "rules", group: "Navigate", label: "Rules", detail: "Review deterministic invariant checks", icon: "R", run: () => setView("rules") },
    { id: "recurring", group: "Navigate", label: "Recurring schedules", detail: "Inspect, pause or resume durable schedules", icon: "S", run: () => setView("recurring") },
    { id: "refresh", group: "Actions", label: "Refresh local evidence", detail: "Read the bounded snapshot again", icon: "↻", run: () => loadSnapshot() },
    { id: "search", group: "Actions", label: "Focus table search", detail: "Search the current view", icon: "/", run: () => elements["search-input"].focus() },
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

/*
 * Subject investigation.
 *
 * The Workbench had every table it needed and no way to connect them: an
 * operator asking "what happened to report_3912" had to join findings, effects
 * and executions by eye. This view is where the layers meet from the user's
 * side rather than the engine's, so it is deliberately one narrative in time
 * order rather than another set of panels.
 */

function isSelectedSubject(row) {
  return (
    app.selectedSubject &&
    app.selectedSubject.type === row.subjectType &&
    app.selectedSubject.id === row.subjectId
  );
}

async function selectSubject(subject) {
  if (!subject?.type || !subject?.id) return;
  app.selectedSubject = subject;
  app.selectedJobId = null;
  elements["rail-empty"].hidden = true;
  elements["rail-content"].hidden = false;
  elements["evidence-rail"].classList.add("is-open");
  if (window.innerWidth <= 1120) {
    elements["mobile-scrim"].hidden = false;
  }
  setRailMode("subject");
  elements["rail-queue"].textContent = subject.type.toLocaleUpperCase();
  elements["rail-title"].textContent = "Loading subject…";
  elements["rail-id"].textContent = subject.id;
  renderCurrentView();

  try {
    const detail = await fetchJSON(
      `/api/v1/subjects/${encodeURIComponent(subject.type)}/${encodeURIComponent(subject.id)}`,
    );
    renderSubjectDetail(detail);
  } catch (error) {
    elements["rail-title"].textContent = "Could not read this subject";
    elements["rail-notice"].textContent = error.message;
  }
}

function renderSubjectDetail(detail) {
  app.selectedSubjectDetail = detail;
  const summary = detail.summary || {};
  elements["rail-queue"].textContent = detail.subject.type.toLocaleUpperCase();
  elements["rail-title"].textContent = detail.subject.id;
  elements["rail-id"].textContent = `${detail.subject.type}/${detail.subject.id}`;
  elements["rail-state"].className = "state-badge";
  elements["rail-state"].dataset.state = summary.state === "drift" ? "open" : summary.state;
  elements["rail-state"].textContent = humanize(summary.state || "clean");

  elements["job-context"].innerHTML = [
    ["Verdict", summary.headline || "—"],
    ["Open findings", String(summary.openFindings ?? 0)],
    ["Findings recorded", String(summary.findings ?? 0)],
    ["Effects pending", String(summary.pendingEffects ?? 0)],
    ["Effects uncertain", String(summary.uncertainEffects ?? 0)],
    ["First seen", summary.firstSeen ? formatDate(summary.firstSeen) : "—"],
    ["Last seen", summary.lastSeen ? formatDate(summary.lastSeen) : "—"],
  ]
    .map(
      ([term, value]) =>
        `<div><dt>${escapeHTML(term)}</dt><dd>${escapeHTML(value)}</dd></div>`,
    )
    .join("");

  const executions = (detail.executions || [])
    .map(
      (item) => `<article class="evidence-card">
        <div class="evidence-card-head">
          <strong>${escapeHTML(item.sourceSystem)}</strong>
          ${stateBadge(item.sourceSystem === "rhinoq" ? "leased" : "external")}
        </div>
        <dl>
          <div><dt>Run</dt><dd class="mono">${escapeHTML(item.sourceId)}</dd></div>
          <div><dt>Effects</dt><dd>${item.effects}</dd></div>
          <div><dt>Last touched</dt><dd>${escapeHTML(formatDate(item.lastSeen))}</dd></div>
        </dl>
      </article>`,
    )
    .join("");

  const history = (detail.history || [])
    .map((event) => {
      const detailLine =
        event.kind === "effect"
          ? `<small class="mono">${escapeHTML(event.execution || "")}</small>`
          : `<small>${escapeHTML(
              [event.ruleId, event.actor, event.reason].filter(Boolean).join(" · ") ||
                event.toStatus ||
                "",
            )}</small>`;
      return `<li class="timeline-entry" data-kind="${escapeAttribute(event.kind)}">
        <span class="timeline-time" title="${escapeAttribute(formatDate(event.occurredAt))}">${relativeTime(event.occurredAt)}</span>
        <div class="cell-stack">
          <strong>${escapeHTML(humanize(event.label || event.kind))}</strong>
          ${detailLine}
        </div>
      </li>`;
    })
    .join("");

  elements["rail-subject"].innerHTML = `
    ${renderSubjectActions(detail)}
    <section class="rail-section">
      <h3>What ran</h3>
      ${executions || `<p class="muted">No execution has recorded an effect for this subject.</p>`}
    </section>
    <section class="rail-section">
      <h3>What happened, in order</h3>
      ${history ? `<ol class="timeline subject-history">${history}</ol>` : `<p class="muted">No observations or decisions recorded.</p>`}
    </section>`;

  elements["rail-notice"].textContent = (detail.notices || []).join(" ");
}

function renderSubjectActions(detail) {
  if (app.snapshot?.source?.readOnly) return "";
  const finding = detail.findings?.[0];
  const plan = app.repairPlan;
  return `<section class="rail-section">
    <div class="rail-section-heading"><h3>Safe recovery</h3><span>${plan ? escapeHTML(humanize(plan.state)) : "application callbacks"}</span></div>
    <p class="muted">Recheck first. Repair is previewed as a dry-run, approved by another actor, then re-verified automatically.</p>
    <div class="safe-action-row">
      <button class="secondary-button" type="button" data-subject-action="recheck" ${finding ? "" : "disabled"}>Recheck</button>
      <button class="secondary-button" type="button" data-subject-action="propose" ${finding ? "" : "disabled"}>Preview repair</button>
      <button class="secondary-button" type="button" data-subject-action="approve" ${plan?.state === "previewed" ? "" : "disabled"}>Approve</button>
      <button class="secondary-button" type="button" data-subject-action="execute" ${plan?.state === "approved" ? "" : "disabled"}>Execute + verify</button>
    </div>
    ${plan ? `<dl class="detail-grid"><div><dt>Plan</dt><dd class="mono">${escapeHTML(plan.id)}</dd></div><div><dt>Dry-run</dt><dd>${plan.dryRun ? "yes" : "complete"}</dd></div><div><dt>Preview</dt><dd>${escapeHTML(plan.preview || "â€”")}</dd></div><div><dt>Precondition</dt><dd class="mono">${escapeHTML(plan.precondition || "â€”")}</dd></div><div><dt>Outcome</dt><dd>${escapeHTML(plan.outcome || "â€”")}</dd></div></dl>` : ""}
  </section>`;
}

async function onSubjectAction(event) {
  const button = event.target.closest("[data-subject-action]");
  if (!button || button.disabled || !app.selectedSubjectDetail) return;
  const detail = app.selectedSubjectDetail;
  const finding = detail.findings?.[0];
  if (!finding) return;
  button.disabled = true;
  try {
    switch (button.dataset.subjectAction) {
      case "recheck": {
        const result = await fetchJSON(`/api/v1/subjects/${encodeURIComponent(detail.subject.type)}/${encodeURIComponent(detail.subject.id)}/recheck`, { method: "POST", body: { ruleId: finding.ruleId } });
        showToast(`Recheck: ${result.status}. ${result.detail}`);
        break;
      }
      case "propose": {
        const handler = window.prompt("Registered repair handler", "repair-order-mapping");
        const actor = handler && window.prompt("Proposer identity", "developer@example.com");
        if (!handler || !actor) return;
        let plan = await fetchJSON("/api/v1/repairs", { method: "POST", body: { finding: { ruleId: finding.ruleId, subjectType: finding.subjectType, subjectId: finding.subjectId, invariantVersion: finding.invariantVersion }, handler, parameters: {}, actor } });
        plan = await fetchJSON(`/api/v1/repairs/${encodeURIComponent(plan.id)}/preview`, { method: "POST" });
        app.repairPlan = plan;
        showToast("Dry-run preview ready. A different actor must approve it.");
        break;
      }
      case "approve": {
        const actor = window.prompt("Approver identity (must differ from proposer)", "reviewer@example.com");
        const reason = actor && window.prompt("Approval reason", "Reviewed precondition and dry-run output");
        if (!actor || !reason) return;
        app.repairPlan = await fetchJSON(`/api/v1/repairs/${encodeURIComponent(app.repairPlan.id)}/approve`, { method: "POST", body: { actor, reason } });
        showToast("Repair approved. Execution still requires an explicit click.");
        break;
      }
      case "execute": {
        if (!window.confirm("Execute this registered callback, then automatically re-verify?")) return;
        app.repairPlan = await fetchJSON(`/api/v1/repairs/${encodeURIComponent(app.repairPlan.id)}/execute`, { method: "POST" });
        showToast(`Repair ${app.repairPlan.state}: ${app.repairPlan.outcome || "verification recorded"}`);
        break;
      }
    }
    renderSubjectDetail(detail);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

/*
 * The rail answers one question at a time. A job view and a subject view show
 * different evidence, and leaving the other one's panels on screen would invite
 * an operator to read a job's outcome as if it belonged to the subject.
 */
function setRailMode(mode) {
  document.querySelectorAll("[data-rail-mode]").forEach((node) => {
    node.hidden = node.dataset.railMode !== mode;
  });
}
