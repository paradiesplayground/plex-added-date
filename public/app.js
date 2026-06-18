const form = document.querySelector("#form");
const dbPath = document.querySelector("#dbPath");
const mediaType = document.querySelector("#mediaType");
const defaultDate = document.querySelector("#defaultDate");
const recentDays = document.querySelector("#recentDays");
const ids = document.querySelector("#ids");
const backup = document.querySelector("#backup");
const managePlex = document.querySelector("#managePlex");
const recentBtn = document.querySelector("#recentBtn");
const previewBtn = document.querySelector("#previewBtn");
const applyBtn = document.querySelector("#applyBtn");
const selectAllBtn = document.querySelector("#selectAllBtn");
const clearSelectionBtn = document.querySelector("#clearSelectionBtn");
const statusEl = document.querySelector("#status");
const rowsEl = document.querySelector("#rows");
const summaryEl = document.querySelector("#summary");
const resultsTitle = document.querySelector("#resultsTitle");

let lastPreview = [];
let selectedIds = new Set();
let mediaLabels = {
  movie: "movies",
  show: "TV shows",
};

function setStatus(message, kind = "neutral") {
  statusEl.textContent = message;
  statusEl.style.color = kind === "error" ? "#a33a3a" : kind === "success" ? "#2e7654" : "#687066";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function localDateValue(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function sixMonthsAgo() {
  const date = new Date();
  date.setMonth(date.getMonth() - 6);
  return date;
}

function formatDisplay(iso) {
  if (!iso) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

function payload() {
  const selectedText = [...selectedIds].join("\n");
  return {
    dbPath: dbPath.value,
    mediaType: mediaType.value,
    defaultDate: defaultDate.value,
    ids: selectedText || ids.value,
    backup: backup.checked,
    managePlex: managePlex.checked,
  };
}

function currentMediaLabel() {
  return mediaLabels[mediaType.value] || "items";
}

function titleCaseLabel(label) {
  return label.replace(/^./, (letter) => letter.toUpperCase());
}

function updateMediaText() {
  const label = currentMediaLabel();
  resultsTitle.textContent = titleCaseLabel(label);
  recentBtn.textContent = `Load recent ${label}`;
}

async function postJson(url, data) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || "Request failed.");
    error.logPath = body.logPath || "";
    throw error;
  }
  return body;
}

function renderRows(rows, autoSelect = false) {
  lastPreview = rows;
  const missing = rows.filter((row) => row.status === "missing").length;
  const selectable = rows.filter((row) => row.status === "found").map((row) => Number(row.id));
  selectedIds = new Set([...selectedIds].filter((id) => selectable.includes(id)));
  if (autoSelect && selectedIds.size === 0 && selectable.length > 0) {
    selectedIds = new Set(selectable);
  }
  syncSelectionText();
  updateSelectionControls(missing);

  const selectedCount = selectedIds.size;
  summaryEl.textContent = rows.length
    ? `${selectedCount} selected of ${rows.length}${missing ? `, ${missing} missing` : ""}`
    : "No rows loaded";

  if (!rows.length) {
    rowsEl.innerHTML = `<tr><td colspan="7" class="empty">No rows matched.</td></tr>`;
    return;
  }

  rowsEl.innerHTML = rows.map((row) => `
    <tr>
      <td class="select-col">
        <input class="row-select" type="checkbox" data-id="${escapeHtml(row.id)}" ${selectedIds.has(Number(row.id)) ? "checked" : ""} ${row.status === "missing" ? "disabled" : ""}>
      </td>
      <td class="mono">${escapeHtml(row.id)}</td>
      <td><span class="pill ${escapeHtml(row.status)}">${escapeHtml(row.status)}</span></td>
      <td>${escapeHtml(row.title || "Unknown")}</td>
      <td>${escapeHtml(row.librarySectionId || "")}</td>
      <td class="mono">${escapeHtml(formatDisplay(row.currentAddedAtIso))}</td>
      <td class="mono">${escapeHtml(formatDisplay(row.newAddedAtIso))}</td>
    </tr>
  `).join("");
}

function syncSelectionText() {
  ids.value = [...selectedIds].join("\n");
}

function updateSelectionControls(missing = 0) {
  const foundCount = lastPreview.filter((row) => row.status === "found").length;
  applyBtn.disabled = foundCount === 0 || selectedIds.size === 0 || missing > 0;
  selectAllBtn.disabled = foundCount === 0;
  clearSelectionBtn.disabled = selectedIds.size === 0;
}

function updateSummary() {
  const missing = lastPreview.filter((row) => row.status === "missing").length;
  summaryEl.textContent = lastPreview.length
    ? `${selectedIds.size} selected of ${lastPreview.length}${missing ? `, ${missing} missing` : ""}`
    : "No rows loaded";
  updateSelectionControls(missing);
}

async function loadConfig() {
  try {
    const result = await postJson("/api/config", {});
    if (Array.isArray(result.mediaTypes)) {
      mediaLabels = Object.fromEntries(result.mediaTypes.map((item) => [item.value, item.label]));
    }
    updateMediaText();
    dbPath.value = result.defaultDbPath || "";
    if (dbPath.value) {
      await loadRecent();
    } else {
      setStatus("Set database path");
    }
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function loadRecent() {
  setStatus(`Loading recent ${currentMediaLabel()}...`);
  applyBtn.disabled = true;
  try {
    const result = await postJson("/api/recent", {
      dbPath: dbPath.value,
      mediaType: mediaType.value,
      days: recentDays.value || 7,
    });
    dbPath.value = result.dbPath;
    selectedIds = new Set(result.rows.filter((row) => row.status === "found").map((row) => Number(row.id)));
    renderRows(result.rows, true);
    setStatus(`Recent ${currentMediaLabel()} loaded`, "success");
  } catch (error) {
    renderRows([]);
    setStatus(error.message, "error");
  }
}

async function preview() {
  setStatus("Previewing...");
  applyBtn.disabled = true;
  try {
    const result = await postJson("/api/preview", payload());
    renderRows(result.rows, true);
    setStatus("Preview ready", "success");
  } catch (error) {
    renderRows([]);
    setStatus(error.message, "error");
  }
}

previewBtn.addEventListener("click", preview);
recentBtn.addEventListener("click", loadRecent);
mediaType.addEventListener("change", () => {
  selectedIds.clear();
  syncSelectionText();
  renderRows([]);
  updateMediaText();
  loadRecent();
});
selectAllBtn.addEventListener("click", () => {
  selectedIds = new Set(lastPreview.filter((row) => row.status === "found").map((row) => Number(row.id)));
  renderRows(lastPreview);
});
clearSelectionBtn.addEventListener("click", () => {
  selectedIds.clear();
  syncSelectionText();
  renderRows(lastPreview);
});
rowsEl.addEventListener("change", (event) => {
  if (!event.target.classList.contains("row-select")) return;
  const id = Number(event.target.dataset.id);
  if (event.target.checked) {
    selectedIds.add(id);
  } else {
    selectedIds.delete(id);
  }
  syncSelectionText();
  updateSummary();
});
dbPath.addEventListener("change", () => {
  selectedIds.clear();
  syncSelectionText();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!lastPreview.length) {
    await preview();
    if (applyBtn.disabled) return;
  }

  const count = selectedIds.size || ids.value.split(/\s|,/).filter(Boolean).length;
  const ok = window.confirm(`Update ${count} Plex item${count === 1 ? "" : "s"}?`);
  if (!ok) return;

  setStatus("Applying...");
  applyBtn.disabled = true;
  try {
    const result = await postJson("/api/apply", payload());
    renderRows(result.rows);
    const plexNote = result.plexRestarted ? " Plex restarted." : "";
    setStatus(result.backupPath ? `Updated. Backup created.${plexNote}` : `Updated.${plexNote}`, "success");
    if (result.backupPath) {
      summaryEl.textContent = `${result.updated} updated. Backup: ${result.backupPath}${result.logPath ? ` Log: ${result.logPath}` : ""}`;
    }
  } catch (error) {
    setStatus(error.logPath ? `${error.message} Log: ${error.logPath}` : error.message, "error");
  }
});

defaultDate.value = localDateValue(sixMonthsAgo());
loadConfig();
