const state = {
  family: "E5",
  rows: [],
  running: false,
  events: null,
  subscribedRegions: [],
  selectedRegions: new Set()
};

const SHAPE_LIMITS = {
  E5: { maxOcpus: 94, maxMemoryGbs: 1049 },
  E6: { maxOcpus: 126, maxMemoryGbs: 1454 }
};
const MAX_SELECTED_REGIONS = 6;

const familyButtons = [...document.querySelectorAll("[data-family]")];
const regionChips = document.getElementById("regionChips");
const regionToggle = document.getElementById("regionToggle");
const regionsValue = document.getElementById("regionsValue");
const ocpus = document.getElementById("ocpus");
const memoryGbs = document.getElementById("memoryGbs");
const ocpusValue = document.getElementById("ocpusValue");
const memoryValue = document.getElementById("memoryValue");
const runReport = document.getElementById("runReport");
const runState = document.getElementById("runState");
const reportMeta = document.getElementById("reportMeta");
const regions = document.getElementById("regions");
const availableCount = document.getElementById("availableCount");
const capacityCount = document.getElementById("capacityCount");
const errorCount = document.getElementById("errorCount");
const regionCount = document.getElementById("regionCount");

function updateRangeLabels() {
  applySliderLimits();
  ocpusValue.textContent = ocpus.value;
  memoryValue.textContent = memoryGbs.value;
}

async function populateRegions() {
  runReport.disabled = true;
  regionToggle.disabled = true;
  regionChips.innerHTML = "";
  regionsValue.textContent = "Loading";

  try {
    const response = await fetch("/api/regions");
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Could not load subscribed regions");
    }

    const subscribedRegions = payload.regions || [];
    state.subscribedRegions = subscribedRegions;
    state.selectedRegions = new Set(subscribedRegions.slice(0, MAX_SELECTED_REGIONS));
    if (!subscribedRegions.length) {
      regionChips.innerHTML = '<span class="chip-placeholder">No subscribed regions found</span>';
    } else {
      renderRegionChips();
    }
  } catch (error) {
    regionChips.innerHTML = '<span class="chip-placeholder">Region discovery failed</span>';
    showError(error.message);
  } finally {
    regionToggle.disabled = false;
    updateRegionSelection();
  }
}

function renderRegionChips() {
  regionChips.innerHTML = state.subscribedRegions
    .map((region) => {
      const selected = state.selectedRegions.has(region);
      return `<button class="region-chip${selected ? " is-selected" : ""}" type="button" data-region="${region}" aria-pressed="${selected}">${region}</button>`;
    })
    .join("");

  regionChips.querySelectorAll("[data-region]").forEach((button) => {
    button.addEventListener("click", () => toggleRegion(button.dataset.region));
  });
}

function toggleRegion(region) {
  if (state.selectedRegions.has(region)) {
    state.selectedRegions.delete(region);
  } else if (state.selectedRegions.size < MAX_SELECTED_REGIONS) {
    state.selectedRegions.add(region);
  }

  renderRegionChips();
  updateRegionSelection();
}

function toggleAllRegions() {
  if (state.selectedRegions.size === Math.min(state.subscribedRegions.length, MAX_SELECTED_REGIONS)) {
    state.selectedRegions.clear();
  } else {
    state.selectedRegions = new Set(state.subscribedRegions.slice(0, MAX_SELECTED_REGIONS));
  }

  renderRegionChips();
  updateRegionSelection();
}

function selectedRegions() {
  return [...state.selectedRegions];
}

function updateRegionSelection() {
  if (state.selectedRegions.size > MAX_SELECTED_REGIONS) {
    state.selectedRegions = new Set([...state.selectedRegions].slice(0, MAX_SELECTED_REGIONS));
    renderRegionChips();
  }

  const count = selectedRegions().length;
  const maxSelectable = Math.min(state.subscribedRegions.length || MAX_SELECTED_REGIONS, MAX_SELECTED_REGIONS);
  regionsValue.textContent = `${count} / ${MAX_SELECTED_REGIONS}`;
  regionToggle.textContent = maxSelectable > 0 && count === maxSelectable ? "Clear" : "Select all";
  regionToggle.disabled = state.running || state.subscribedRegions.length === 0;
  runReport.disabled = state.running || count === 0;
}

function setDefaultMemoryForOcpus() {
  const limits = SHAPE_LIMITS[state.family];
  const currentOcpus = Math.min(Number(ocpus.value), limits.maxOcpus);
  const maxMemory = Math.min(limits.maxMemoryGbs, Math.max(1, currentOcpus * 64));
  const defaultMemory = Math.min(maxMemory, Math.max(currentOcpus, currentOcpus * 4));
  memoryGbs.value = String(defaultMemory);
}

function setFamily(family) {
  state.family = family;
  familyButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.family === family);
  });
  applySliderLimits();
  setDefaultMemoryForOcpus();
  updateRangeLabels();
}

function applySliderLimits() {
  const limits = SHAPE_LIMITS[state.family];
  const currentOcpus = Math.min(Number(ocpus.value), limits.maxOcpus);
  const minMemory = Math.max(1, currentOcpus);
  const maxMemory = Math.min(limits.maxMemoryGbs, Math.max(1, currentOcpus * 64));

  ocpus.max = String(limits.maxOcpus);
  ocpus.value = String(currentOcpus);
  memoryGbs.min = String(minMemory);
  memoryGbs.max = String(maxMemory);

  if (Number(memoryGbs.value) > maxMemory) {
    memoryGbs.value = String(maxMemory);
  }
  if (Number(memoryGbs.value) < minMemory) {
    memoryGbs.value = String(minMemory);
  }
}

function handleOcpuInput() {
  applySliderLimits();
  setDefaultMemoryForOcpus();
  updateRangeLabels();
}

function handleMemoryInput() {
  updateRangeLabels();
}

function statusClass(status) {
  if (status === "AVAILABLE") {
    return "status-available";
  }
  if (status === "OUT_OF_HOST_CAPACITY") {
    return "status-capacity";
  }
  if (status === "ERROR") {
    return "status-error";
  }
  return "status-info";
}

function statusLabel(status) {
  return String(status || "UNKNOWN").replace(/_/g, " ");
}

function groupRows(rows) {
  return rows.reduce((groups, row) => {
    const region = row.region || "unknown";
    if (!groups[region]) {
      groups[region] = [];
    }
    groups[region].push(row);
    return groups;
  }, {});
}

function summarize(rows) {
  const regionsSeen = new Set(rows.map((row) => row.region).filter(Boolean));
  const available = rows.filter((row) => row.status === "AVAILABLE").length;
  const capacity = rows.filter((row) => row.status === "OUT_OF_HOST_CAPACITY").length;
  const errors = rows.filter((row) => row.status === "ERROR").length;

  availableCount.textContent = available;
  capacityCount.textContent = capacity;
  errorCount.textContent = errors;
  regionCount.textContent = regionsSeen.size;
}

function clearSummary() {
  availableCount.textContent = "";
  capacityCount.textContent = "";
  errorCount.textContent = "";
  regionCount.textContent = "";
}

function regionScore(rows) {
  const available = rows.filter((row) => row.status === "AVAILABLE").length;
  return rows.length ? Math.round((available / rows.length) * 100) : 0;
}

function renderRows(rows) {
  summarize(rows);

  if (!rows.length) {
    regions.className = "regions empty";
    regions.innerHTML = `
      <div class="empty-state">
        <strong>No matching rows</strong>
        <span>Try another shape family or size.</span>
      </div>
    `;
    return;
  }

  regions.className = "regions";
  const grouped = groupRows(rows);
  regions.innerHTML = Object.keys(grouped)
    .sort()
    .map((region) => renderRegion(region, grouped[region]))
    .join("");
}

function renderRegion(region, rows) {
  const score = regionScore(rows);
  const byAd = rows.reduce((groups, row) => {
    const ad = row.availability_domain || "unknown";
    if (!groups[ad]) {
      groups[ad] = [];
    }
    groups[ad].push(row);
    return groups;
  }, {});

  return `
    <article class="region-card">
      <header class="region-header">
        <div>
          <h3>${escapeHtml(region)}</h3>
          <span>${rows.length} checks</span>
        </div>
        <div class="score" aria-label="${score}% available">
          <strong>${score}%</strong>
          <span>available</span>
        </div>
      </header>
      <div class="score-bar"><span style="width: ${score}%"></span></div>
      <div class="ad-list">
        ${Object.keys(byAd)
          .sort()
          .map((ad) => renderAd(ad, byAd[ad]))
          .join("")}
      </div>
    </article>
  `;
}

function renderAd(ad, rows) {
  return `
    <section class="ad-block">
      <div class="ad-title">${escapeHtml(ad)}</div>
      <div class="shape-list">
        ${rows.map(renderShape).join("")}
      </div>
    </section>
  `;
}

function renderShape(row) {
  const message = row.message ? `<span class="message">${escapeHtml(row.message)}</span>` : "";
  const size = row.ocpus ? `<span>${escapeHtml(row.ocpus)} OCPU / ${escapeHtml(row.memory_gbs)} GB</span>` : "";

  return `
    <div class="shape-row">
      <span class="status-dot ${statusClass(row.status)}"></span>
      <div class="shape-main">
        <strong>${escapeHtml(row.shape || "Unknown shape")}</strong>
        <span>${escapeHtml(row.fault_domain || "all")}</span>
      </div>
      <div class="shape-meta">
        ${size}
        <b class="${statusClass(row.status)}">${escapeHtml(statusLabel(row.status))}</b>
        ${message}
      </div>
    </div>
  `;
}

async function loadReport() {
  if (state.running) {
    return;
  }

  if (selectedRegions().length === 0) {
    showError("Select at least one OCI region.");
    return;
  }

  if (state.events) {
    state.events.close();
    state.events = null;
  }

  state.running = true;
  runReport.disabled = true;
  clearSummary();
  runState.textContent = "Running";
  runState.classList.add("is-running");
  reportMeta.textContent = `${state.family} at ${ocpus.value} OCPU / ${memoryGbs.value} GB`;
  regions.className = "regions loading";
  regions.innerHTML = `
    <div class="empty-state">
      <div class="spinner" aria-hidden="true"></div>
      <strong>Running OCI report</strong>
      <span id="progressText">Starting report...</span>
    </div>
  `;

  const params = new URLSearchParams({
    family: state.family,
    ocpus: ocpus.value,
    memoryGbs: memoryGbs.value,
    regions: selectedRegions().join(",")
  });

  state.events = new EventSource(`/api/report/events?${params.toString()}`);

  state.events.addEventListener("start", (event) => {
    const payload = JSON.parse(event.data);
    reportMeta.textContent = `${payload.family} at ${payload.ocpus} OCPU / ${payload.memoryGbs} GB`;
    setProgress("Discovering subscribed regions...");
  });

  state.events.addEventListener("progress", (event) => {
    const payload = JSON.parse(event.data);
    setProgress(payload.message || "Working...");
  });

  state.events.addEventListener("done", (event) => {
    const payload = JSON.parse(event.data);
    state.rows = payload.rows || [];
    reportMeta.textContent = `${payload.query.family} at ${payload.query.ocpus} OCPU / ${payload.query.memoryGbs} GB`;
    renderRows(state.rows);
    runState.textContent = "Complete";
    finishRun();
  });

  state.events.addEventListener("report-error", (event) => {
    let message = "Report failed";
    if (event.data) {
      try {
        const payload = JSON.parse(event.data);
        message = payload.error || message;
      } catch {
        message = event.data;
      }
    }
    showError(message);
    finishRun();
  });

  state.events.onerror = () => {
    if (!state.running) {
      return;
    }
    showError("The report stream closed before completion. Make sure this page is served by npm start and the /api/report/events route is available.");
    finishRun();
  };
}

function setProgress(message) {
  const progressText = document.getElementById("progressText");
  if (progressText) {
    progressText.textContent = message;
  }
}

function showError(message) {
  state.rows = [];
  summarize([]);
  runState.textContent = "Failed";
  regions.className = "regions empty";
  regions.innerHTML = `
    <div class="empty-state error-state">
      <strong>Report failed</strong>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
}

function finishRun() {
  if (state.events) {
    state.events.close();
    state.events = null;
  }
  state.running = false;
  updateRegionSelection();
  runState.classList.remove("is-running");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

familyButtons.forEach((button) => {
  button.addEventListener("click", () => setFamily(button.dataset.family));
});

regionToggle.addEventListener("click", toggleAllRegions);
ocpus.addEventListener("input", handleOcpuInput);
memoryGbs.addEventListener("input", handleMemoryInput);
runReport.addEventListener("click", loadReport);

populateRegions();
setDefaultMemoryForOcpus();
updateRangeLabels();
