const DEFAULT_API_BASE = `${window.location.protocol}//${window.location.hostname}:8080`;
const STORED_API_BASE = localStorage.getItem("sentinel-api-base");
const INITIAL_API_BASE = shouldUseStoredApiBase(STORED_API_BASE) ? STORED_API_BASE : DEFAULT_API_BASE;

const DISRUPTION_CONFIG = {
  node_closure: { label: "Node closure", targetLabel: "Location" },
  lane_closure: { label: "Lane closure", targetLabel: "Lane" },
  add_delay: { label: "Add delay", targetLabel: "Lane" },
  capacity_reduction: { label: "Capacity reduction", targetLabel: "Location" },
  cost_increase: { label: "Cost increase", targetLabel: "Lane" },
  inventory_loss: { label: "Inventory loss", targetLabel: "InventoryPool" },
  demand_spike: { label: "Demand spike", targetLabel: "Product" },
  reliability_drop: { label: "Reliability drop", targetLabel: "Lane" },
};

const OBJECTIVES = [
  ["protect_p0", "Protect P0"],
  ["balanced", "Balanced"],
  ["min_total_risk", "Min total risk"],
  ["min_cost", "Min cost"],
  ["max_resilience", "Max resilience"],
];

const MARAUDER_EVENT_TEMPLATES = [
  {
    id: "hub-blackout",
    title: "Hub Blackout",
    detail: "Close the busiest hub for fourteen days.",
    type: "node_closure",
    targetKind: "Location",
    durationHours: 336,
    severity: 1,
    pickTarget: ({ locations }) => locations.find((node) => node.kind === "hub") ?? locations[0],
  },
  {
    id: "port-strike",
    title: "Port Strike",
    detail: "Close a high-volume ocean lane for six days.",
    type: "lane_closure",
    targetKind: "Lane",
    durationHours: 144,
    severity: 1,
    pickTarget: ({ lanes }) => lanes.find((node) => node.kind === "ocean") ?? lanes[0],
  },
  {
    id: "factory-fire",
    title: "Factory Fire",
    detail: "Reduce factory capacity by seventy percent.",
    type: "capacity_reduction",
    targetKind: "Location",
    durationHours: 240,
    severity: 0.7,
    pickTarget: ({ locations }) => locations.find((node) => node.kind === "factory") ?? locations[0],
  },
  {
    id: "warehouse-loss",
    title: "Inventory Loss",
    detail: "Destroy half of a warehouse inventory pool.",
    type: "inventory_loss",
    targetKind: "InventoryPool",
    durationHours: 72,
    severity: 0.5,
    pickTarget: ({ inventoryPools }) => inventoryPools[0],
  },
];

const LANE_COLORS = {
  truck: "#63b2ff",
  rail: "#7fd3ff",
  ocean: "#3ace95",
  air: "#f0b35d",
};

const LOCATION_COLORS = {
  supplier: "#64bbff",
  factory: "#ffb359",
  hub: "#7c8dff",
  port: "#37d69b",
  warehouse: "#dc8cff",
  destination: "#ff8798",
};

const LABEL_COLORS = {
  Scenario: "#54606d",
  Location: "#2a5572",
  Lane: "#245f68",
  Product: "#4a4f79",
  Shipment: "#5f5d34",
  Commitment: "#74494e",
  InventoryPool: "#49556a",
  CapacityPool: "#4e5f3e",
  Disruption: "#7b333d",
};

const MAP_STYLE = {
  version: 8,
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "&copy; OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

const MAP_WORLD = {
  west: 68,
  east: 128,
  south: 0,
  north: 42,
};

const state = {
  apiBase: INITIAL_API_BASE,
  scenarioId: null,
  scenarioSummary: null,
  scenarioMeta: null,
  now: null,
  graph: null,
  impactRun: null,
  recommendationRun: null,
  recommendationPreview: null,
  draftDisruption: null,
  draftDisruptionLabel: null,
  draftImpactRun: null,
  selectedEntityId: null,
  entityContext: null,
  neo4jCounts: null,
  disruptions: [],
  activeDisruption: null,
  selectedDisruptionId: null,
  selectedDisruptionIds: [],
  activeSurface: "sentinel",
  map: null,
  mapReady: false,
  mapFitted: false,
  graphViewport: { x: 0, y: 0, width: 1000, height: 640 },
  graphPan: null,
  disruptionPollTimer: null,
  busy: false,
};

const dom = {
  workspaceSurface: document.querySelector("#workspace-surface"),
  surfaceSentinelButton: document.querySelector("#surface-sentinel-button"),
  surfaceMarauderButton: document.querySelector("#surface-marauder-button"),
  apiBaseInput: document.querySelector("#api-base-input"),
  apiStatus: document.querySelector("#api-status"),
  scenarioName: document.querySelector("#scenario-name"),
  scenarioVersion: document.querySelector("#scenario-version"),
  scenarioClock: document.querySelector("#scenario-clock"),
  surfaceTitle: document.querySelector("#surface-title"),
  surfaceCopy: document.querySelector("#surface-copy"),
  incidentBanner: document.querySelector("#incident-banner"),
  graphFocusLabel: document.querySelector("#graph-focus-label"),
  map: document.querySelector("#network-map"),
  causalityGraph: document.querySelector("#causality-graph"),
  entityPanel: document.querySelector("#entity-panel"),
  impactPanel: document.querySelector("#impact-panel"),
  disruptionFeed: document.querySelector("#disruption-feed"),
  disruptionFeedMeta: document.querySelector("#disruption-feed-meta"),
  recommendationPanel: document.querySelector("#recommendation-panel"),
  recommendationPreview: document.querySelector("#recommendation-preview"),
  recommendationMeta: document.querySelector("#recommendation-meta"),
  neo4jPanel: document.querySelector("#neo4j-panel"),
  neo4jStatus: document.querySelector("#neo4j-status"),
  draftEventPanel: document.querySelector("#draft-event-panel"),
  resetScenarioButton: document.querySelector("#reset-scenario-button"),
  disruptionType: document.querySelector("#disruption-type"),
  disruptionTarget: document.querySelector("#disruption-target"),
  disruptionDuration: document.querySelector("#disruption-duration"),
  disruptionSeverity: document.querySelector("#disruption-severity"),
  objectivePreset: document.querySelector("#objective-preset"),
  previewCustomEventButton: document.querySelector("#preview-custom-event-button"),
  runRecommendationsButton: document.querySelector("#run-recommendations-button"),
  injectCustomEventButton: document.querySelector("#inject-custom-event-button"),
  injectPreviewedEventButton: document.querySelector("#inject-previewed-event-button"),
  clearDraftEventButton: document.querySelector("#clear-draft-event-button"),
  advanceTimeButton: document.querySelector("#advance-time-button"),
  marauderEvents: document.querySelector("#marauder-events"),
  marauderStatus: document.querySelector("#marauder-status"),
  neo4jIngestButton: document.querySelector("#neo4j-ingest-button"),
  neo4jCountsButton: document.querySelector("#neo4j-counts-button"),
  neo4jResetButton: document.querySelector("#neo4j-reset-button"),
};

boot().catch((error) => {
  setApiStatus("Load failed", true);
  dom.entityPanel.replaceChildren(renderMessage(error.message));
});

async function boot() {
  dom.apiBaseInput.value = state.apiBase;
  for (const [value, config] of Object.entries(DISRUPTION_CONFIG)) {
    dom.disruptionType.append(new Option(config.label, value));
  }
  for (const [value, label] of OBJECTIVES) {
    dom.objectivePreset.append(new Option(label, value));
  }
  dom.objectivePreset.value = "balanced";
  setSurface(window.location.hash === "#marauder" ? "marauder" : "sentinel");

  bindEvents();
  await loadScenario();
  startDisruptionPolling();
}

function bindEvents() {
  dom.surfaceSentinelButton.addEventListener("click", () => setSurface("sentinel"));
  dom.surfaceMarauderButton.addEventListener("click", () => setSurface("marauder"));
  dom.apiBaseInput.addEventListener("change", async () => {
    state.apiBase = normalizeBase(dom.apiBaseInput.value);
    localStorage.setItem("sentinel-api-base", state.apiBase);
    await loadScenario();
  });
  dom.disruptionType.addEventListener("change", renderTargetOptions);
  dom.resetScenarioButton.addEventListener("click", () => resetScenario());
  dom.runRecommendationsButton.addEventListener("click", () => runRecommendations());
  dom.previewCustomEventButton.addEventListener("click", () => previewCustomEvent());
  dom.injectCustomEventButton.addEventListener("click", () => injectCustomEvent());
  dom.injectPreviewedEventButton.addEventListener("click", () => injectPreviewedEvent());
  dom.clearDraftEventButton.addEventListener("click", clearDraftPreview);
  dom.advanceTimeButton.addEventListener("click", () => advanceScenarioTime(24));
  dom.causalityGraph.addEventListener("wheel", onGraphWheel, { passive: false });
  dom.causalityGraph.addEventListener("pointerdown", onGraphPointerDown);
  dom.causalityGraph.addEventListener("pointermove", onGraphPointerMove);
  dom.causalityGraph.addEventListener("pointerup", onGraphPointerUp);
  dom.causalityGraph.addEventListener("pointerleave", onGraphPointerUp);
  dom.causalityGraph.addEventListener("click", (event) => {
    if (event.target === dom.causalityGraph) {
      clearSelectedEntity();
    }
  });
  dom.neo4jIngestButton.addEventListener("click", () => runNeo4jIngest());
  dom.neo4jCountsButton.addEventListener("click", () => fetchNeo4jCounts());
  dom.neo4jResetButton.addEventListener("click", () => resetNeo4j());
}

function setSurface(surface) {
  if (surface === "sentinel") {
    clearDraftPreview({ preserveStatus: true });
  }
  state.activeSurface = surface;
  dom.surfaceSentinelButton.classList.toggle("active", surface === "sentinel");
  dom.surfaceMarauderButton.classList.toggle("active", surface === "marauder");
  document.body.dataset.surface = surface;
  if (window.location.hash !== `#${surface}`) {
    window.history.replaceState(null, "", `#${surface}`);
  }
  if (state.map) {
    window.requestAnimationFrame(() => state.map.resize());
  }
  renderAll();
}

async function loadScenario() {
  setBusy(true);
  try {
    setApiStatus("Connecting", false);
    const scenarios = await request("/api/scenarios");
    if (!Array.isArray(scenarios) || scenarios.length === 0) {
      throw new Error("No scenarios available");
    }

    state.scenarioId = scenarios[0].id;
    state.scenarioSummary = scenarios[0];
    const [scenarioMeta, graph, disruptions, timeState] = await Promise.all([
      request(`/api/scenarios/${state.scenarioId}`),
      request(`/api/scenarios/${state.scenarioId}/graph`),
      request(`/api/scenarios/${state.scenarioId}/disruptions`),
      request(`/api/scenarios/${state.scenarioId}/time`),
    ]);
    state.scenarioMeta = scenarioMeta;
    state.graph = graph;
    state.disruptions = disruptions;
    state.now = timeState.now;
    state.impactRun = null;
    state.recommendationRun = null;
    state.recommendationPreview = null;
    state.draftDisruption = null;
    state.draftDisruptionLabel = null;
    state.draftImpactRun = null;
    state.neo4jCounts = null;
    state.entityContext = null;
    state.selectedEntityId = null;
    state.selectedDisruptionIds = getDefaultSelectedDisruptionIds();
    state.activeDisruption = getLatestOngoingDisruption();
    state.selectedDisruptionId = state.activeDisruption?.id ?? null;
    setApiStatus("API ready", false);
    renderTargetOptions();
    renderAll();
  } catch (error) {
    setApiStatus("API unavailable", true);
    throw error;
  } finally {
    setBusy(false);
  }
}

function startDisruptionPolling() {
  if (state.disruptionPollTimer) {
    window.clearInterval(state.disruptionPollTimer);
  }
  state.disruptionPollTimer = window.setInterval(() => {
    refreshDisruptionFeed({ autoImpact: true }).catch(() => {});
  }, 5000);
}

async function refreshDisruptionFeed({ autoImpact = false } = {}) {
  if (!state.scenarioId) return;
  const [disruptions, timeState] = await Promise.all([
    request(`/api/scenarios/${state.scenarioId}/disruptions`),
    request(`/api/scenarios/${state.scenarioId}/time`),
  ]);
  const previousActiveId = state.activeDisruption?.id ?? null;
  const previousNow = state.now;
  state.disruptions = disruptions;
  state.now = timeState.now;
  syncSelectedDisruptionIds();
  const selected = state.selectedDisruptionId
    ? disruptions.find((item) => item.id === state.selectedDisruptionId)
    : null;
  const latest = selected ?? getLatestOngoingDisruption();
  state.activeDisruption = latest;
  state.selectedDisruptionId = latest?.id ?? null;
  renderDisruptionFeed();
  renderIncidentBanner();
  renderHeader();
  renderMap();
  renderCausalityGraph();

  const timeChanged = previousNow !== null && previousNow !== state.now;
  if (autoImpact && (latest?.id !== previousActiveId || timeChanged)) {
    state.recommendationRun = null;
    state.recommendationPreview = null;
    if (state.activeSurface === "marauder" && state.draftDisruption) {
      await previewDraftDisruption(state.draftDisruption, state.draftDisruptionLabel ?? "Draft event");
    } else if (getScopedDisruptions().length > 0) {
      await runImpact();
    } else {
      state.impactRun = null;
      renderImpactPanel();
    }
  }
}

async function loadScenarioResources() {
  const scenarios = await request("/api/scenarios");
  const summary = scenarios.find((item) => item.id === state.scenarioId) ?? scenarios[0];
  const [scenarioMeta, graph, disruptions, timeState] = await Promise.all([
    request(`/api/scenarios/${state.scenarioId}`),
    request(`/api/scenarios/${state.scenarioId}/graph`),
    request(`/api/scenarios/${state.scenarioId}/disruptions`),
    request(`/api/scenarios/${state.scenarioId}/time`),
  ]);
  state.scenarioSummary = summary;
  state.scenarioMeta = scenarioMeta;
  state.graph = graph;
  state.disruptions = disruptions;
  state.now = timeState.now;
  syncSelectedDisruptionIds();
  if (state.selectedDisruptionId) {
    state.activeDisruption = state.disruptions.find((item) => item.id === state.selectedDisruptionId) ?? getLatestOngoingDisruption();
    state.selectedDisruptionId = state.activeDisruption?.id ?? null;
  } else {
    state.activeDisruption = getLatestOngoingDisruption();
    state.selectedDisruptionId = state.activeDisruption?.id ?? null;
  }
  renderTargetOptions();
  renderAll();
}

function renderAll() {
  renderHeader();
  renderIncidentBanner();
  renderMap();
  renderCausalityGraph();
  renderDisruptionFeed();
  renderRecommendationControls();
  renderEntityPanel();
  renderImpactPanel();
  renderRecommendationPreview();
  renderRecommendations();
  renderNeo4jPanel();
  renderMarauderEvents();
  renderDraftEventPanel();
}

function renderHeader() {
  const summary = state.scenarioSummary;
  const meta = state.scenarioMeta;
  dom.scenarioName.textContent = summary ? `${summary.name} • seed ${summary.seed}` : "No scenario";
  dom.scenarioVersion.textContent = meta ? `Version ${meta.version}` : "Version -";
  dom.scenarioClock.textContent = state.now !== null ? `Scenario time ${formatTimestamp(state.now)} UTC` : "Scenario time -";
  if (state.activeSurface === "marauder") {
    dom.surfaceTitle.textContent = "Scenario Builder";
    dom.surfaceCopy.textContent = "Build adversarial events on the live map and graph, then reset the scenario when needed.";
  } else {
    dom.surfaceTitle.textContent = "Command Center";
    dom.surfaceCopy.textContent = "Track active disruptions, inspect causality, and preview recovery options.";
  }
}

function renderIncidentBanner() {
  const disruption = getFocusedDisruption();
  const scopedDisruptions = getScopedDisruptions();
  const ongoingDisruptions = getOngoingDisruptions();
  if (!disruption && ongoingDisruptions.length === 0) {
    dom.incidentBanner.className = "incident-banner incident-banner-muted";
    dom.incidentBanner.textContent = "No active disruption detected.";
    return;
  }

  const targetName = disruption ? displayName(getNodeById(disruption.targetId)) ?? disruption.targetId : "Network";
  const impact = getVisibleImpact()?.summary;
  const parts = [];
  if (scopedDisruptions.length > 1) {
    const mitigatedCount = scopedDisruptions.filter((item) => item.status === "mitigated").length;
    parts.push(`${scopedDisruptions.length} disruptions in scope`);
    if (mitigatedCount > 0) {
      parts.push(`${mitigatedCount} mitigated but still active`);
    }
  } else if (disruption) {
    parts.push(`${DISRUPTION_CONFIG[disruption.type].label} at ${targetName}`);
    parts.push(`${disruptionDurationHours(disruption)}h`);
    parts.push(disruption.status === "mitigated" ? `mitigated until ${formatTimestamp(disruption.endsAt)}` : `severity ${formatNumber(disruption.severity)}`);
  }
  if (impact) {
    parts.push(`${impact.impactedShipmentCount} shipments impacted`);
    parts.push(`${impact.atRiskCommitmentCountAfter} commitments at risk`);
  }
  dom.incidentBanner.className = "incident-banner";
  dom.incidentBanner.innerHTML = `
    <strong>${scopedDisruptions.length > 1 ? "Ongoing incident set" : "Ongoing incident"}</strong>
    <span>${escapeHtml(parts.join(" • "))}</span>
  `;
}

function renderDisruptionFeed() {
  const ongoing = getOngoingDisruptions();
  const scopedIds = new Set(getScopedDisruptionIds());
  const activeCount = ongoing.filter((item) => item.status === "active").length;
  const mitigatedCount = ongoing.filter((item) => item.status === "mitigated").length;
  dom.disruptionFeedMeta.textContent = ongoing.length
    ? `${activeCount} active${mitigatedCount ? ` • ${mitigatedCount} mitigated` : ""}`
    : "No ongoing events";

  if (!ongoing.length) {
    dom.disruptionFeed.className = "stack empty-state";
    dom.disruptionFeed.replaceChildren(renderMessage("Waiting for events from Marauder or Sentinel authoring."));
    return;
  }

  dom.disruptionFeed.className = "stack";
  dom.disruptionFeed.replaceChildren(
    ...ongoing.slice(0, 6).map((disruption) => {
      const isActionable = disruption.status === "active";
      const card = document.createElement("article");
      card.className = `item feed-card${scopedIds.has(disruption.id) ? " selected" : ""}${isActionable ? "" : " is-mitigated"}`;
      card.tabIndex = isActionable ? 0 : -1;
      card.setAttribute("aria-disabled", String(!isActionable));
      if (isActionable) {
        card.addEventListener("click", () => toggleDisruptionSelection(disruption.id));
      }

      const title = document.createElement("button");
      title.className = "feed-title";
      title.type = "button";
      title.disabled = !isActionable;
      if (isActionable) {
        title.addEventListener("click", (event) => {
          event.stopPropagation();
          toggleDisruptionSelection(disruption.id);
        });
      }
      const target = displayName(getNodeById(disruption.targetId)) || disruption.targetId;
      title.innerHTML = `
        <span>${escapeHtml(DISRUPTION_CONFIG[disruption.type].label)}</span>
        <strong>${escapeHtml(target)}</strong>
      `;

      const meta = document.createElement("div");
      meta.className = "tag-row";
      const lifecycle = disruptionPhase(disruption);
      meta.append(
        renderTag(lifecycle.label, lifecycle.tone),
        renderTag(`${hoursBetween(disruption.startsAt, disruption.endsAt)}h`),
        renderTag(`Ends ${formatTimestamp(disruption.endsAt)}`),
        renderTag(`Severity ${formatNumber(disruption.severity)}`, disruption.severity >= 0.75 ? "bad" : ""),
      );

      card.append(title, meta);
      return card;
    }),
  );
}

function renderRecommendationControls() {
  const actionableCount = getActionableScopedDisruptions().length;
  dom.runRecommendationsButton.disabled = state.busy || actionableCount === 0;
  dom.runRecommendationsButton.title = actionableCount === 0
    ? "No active disruption requires a new recommendation"
    : "";
}

function renderMarauderEvents() {
  if (!state.graph) return;
  dom.marauderEvents.replaceChildren(
    ...MARAUDER_EVENT_TEMPLATES.map((template) => {
      const event = buildMenuEvent(template);
      const card = document.createElement("article");
      const isSelected = Boolean(state.draftDisruption && state.draftDisruptionLabel === template.title);
      card.className = `marauder-card${isSelected ? " selected" : ""}`;
      card.tabIndex = 0;
      card.addEventListener("click", () => previewMenuEvent(template));

      const target = event ? displayName(getNodeById(event.targetId)) || event.targetId : "No valid target";
      card.innerHTML = `
        <div>
          <h3>${escapeHtml(template.title)}</h3>
          <p>${escapeHtml(template.detail)}</p>
        </div>
        <dl class="kv compact-kv">
          <dt>Target</dt><dd>${escapeHtml(target)}</dd>
          <dt>Duration</dt><dd>${template.durationHours}h</dd>
          <dt>Severity</dt><dd>${formatNumber(template.severity)}</dd>
        </dl>
      `;
      return card;
    }),
  );
}

function renderDraftEventPanel() {
  if (!state.draftDisruption) {
    dom.draftEventPanel.className = "detail-list empty-state";
    dom.draftEventPanel.replaceChildren(renderMessage("Preview an event before injecting it."));
    dom.injectPreviewedEventButton.disabled = true;
    dom.clearDraftEventButton.disabled = true;
    return;
  }

  const target = displayName(getNodeById(state.draftDisruption.targetId)) || state.draftDisruption.targetId;
  const summary = state.draftImpactRun?.summary;
  dom.draftEventPanel.className = "detail-list";
  dom.draftEventPanel.replaceChildren(
    renderKeyValueCard("Draft Event", {
      Event: state.draftDisruptionLabel ?? DISRUPTION_CONFIG[state.draftDisruption.type].label,
      Target: target,
      Scope: `${getOngoingDisruptions().length} ongoing + draft`,
      Duration: `${disruptionDurationHours(state.draftDisruption)}h`,
      Severity: formatNumber(state.draftDisruption.severity),
      ...(summary
        ? {
            "Impacted shipments": summary.impactedShipmentCount,
            "At-risk commitments": summary.atRiskCommitmentCountAfter,
          }
        : {}),
    }),
  );
  dom.injectPreviewedEventButton.disabled = state.busy;
  dom.clearDraftEventButton.disabled = state.busy;
}

function renderTargetOptions() {
  if (!state.graph) return;
  const type = dom.disruptionType.value || "node_closure";
  const targetLabel = DISRUPTION_CONFIG[type].targetLabel;
  const nodes = state.graph.nodes
    .filter((node) => node.label === targetLabel)
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  dom.disruptionTarget.replaceChildren(...nodes.map((node) => new Option(displayName(node), node.id)));
}

function renderMap() {
  if (!state.graph || !dom.map) return;
  ensureMap();
  if (!state.mapReady || !state.map) return;

  const { nodeFeatures, laneFeatures, incidentFeatures, bounds } = buildMapCollections();
  updateMapSource("sentinel-lanes", laneFeatures);
  updateMapSource("sentinel-nodes", nodeFeatures);
  updateMapSource("sentinel-incidents", incidentFeatures);

  if (!state.mapFitted && bounds) {
    state.map.fitBounds(bounds, { padding: 42, duration: 0 });
    state.mapFitted = true;
  }
}

function renderCausalityGraph() {
  const svg = dom.causalityGraph;
  svg.replaceChildren();
  applyGraphViewBox();
  if (!state.graph) return;

  const focusedDisruption = getFocusedDisruption();
  const focusId = state.selectedEntityId ?? focusedDisruption?.targetId ?? state.graph.nodes.find((node) => node.label === "Location")?.id ?? null;
  if (!focusId) return;

  const focusNode = getNodeById(focusId);
  dom.graphFocusLabel.textContent = focusNode
    ? `${focusNode.label} • ${displayName(focusNode)}`
    : "Focused on disruption target";

  const neighborhood = buildNeighborhood(focusId);
  const incoming = neighborhood.incoming.slice(0, 7);
  const outgoing = neighborhood.outgoing.slice(0, 7);

  const layout = new Map();
  const ySlots = (count) => distributeY(count, 120, 540);

  incoming.forEach((node, index) => {
    layout.set(node.id, { x: 170, y: ySlots(incoming.length)[index] });
  });
  outgoing.forEach((node, index) => {
    layout.set(node.id, { x: 830, y: ySlots(outgoing.length)[index] });
  });
  layout.set(focusId, { x: 500, y: 320 });
  if (focusedDisruption) {
    layout.set("__disruption__", { x: 500, y: 110 });
  }

  const sectionLabels = [
    ["Upstream", 120],
    ["Focus", 470],
    ["Downstream", 760],
  ];
  for (const [labelText, x] of sectionLabels) {
    const label = createSvg("text");
    label.setAttribute("x", String(x));
    label.setAttribute("y", "42");
    label.setAttribute("class", "graph-section-label");
    label.textContent = labelText;
    svg.append(label);
  }

  for (const edge of neighborhood.edges) {
    const source = layout.get(edge.source);
    const target = layout.get(edge.target);
    if (!source || !target) continue;
    const line = createSvg("line");
    line.setAttribute("x1", String(source.x));
    line.setAttribute("y1", String(source.y));
    line.setAttribute("x2", String(target.x));
    line.setAttribute("y2", String(target.y));
    line.setAttribute("class", `graph-edge${edge.source === focusId || edge.target === focusId ? " emphasis" : ""}${edgeTouchesVisibleDisruptions(edge) ? " disrupted" : ""}`);
    svg.append(line);
  }

  if (focusedDisruption) {
    const disruptor = createSvg("line");
    disruptor.setAttribute("x1", "500");
    disruptor.setAttribute("y1", "150");
    disruptor.setAttribute("x2", "500");
    disruptor.setAttribute("y2", "278");
    disruptor.setAttribute("class", "graph-edge disrupted");
    svg.append(disruptor);
    svg.append(renderGraphNode({
      id: "__disruption__",
      label: "Disruption",
      kind: focusedDisruption.type,
      name: DISRUPTION_CONFIG[focusedDisruption.type].label,
      properties: {},
    }, layout.get("__disruption__"), true));
  }

  for (const node of [...incoming, focusNode, ...outgoing].filter(Boolean)) {
    const position = layout.get(node.id);
    if (!position) continue;
    svg.append(renderGraphNode(node, position, node.id === focusId));
  }
  applyGraphViewBox();
}

function renderGraphNode(node, position, isFocus) {
  const focusedDisruption = getFocusedDisruption();
  const group = createSvg("g");
  group.setAttribute("class", `graph-node${state.selectedEntityId === node.id ? " active" : ""}${node.id === focusedDisruption?.targetId || node.id === "__disruption__" || nodeTouchedByVisibleDisruptions(node.id) ? " disrupted" : ""}`);
  group.addEventListener("click", () => {
    if (node.id !== "__disruption__") {
      selectEntity(node.id);
    }
  });

  if (node.label === "Disruption") {
    const rect = createSvg("rect");
    rect.setAttribute("x", String(position.x - 88));
    rect.setAttribute("y", String(position.y - 28));
    rect.setAttribute("width", "176");
    rect.setAttribute("height", "56");
    rect.setAttribute("rx", "8");
    rect.setAttribute("fill", LABEL_COLORS.Disruption);
    group.append(rect);
  } else if (isFocus) {
    const rect = createSvg("rect");
    rect.setAttribute("x", String(position.x - 96));
    rect.setAttribute("y", String(position.y - 32));
    rect.setAttribute("width", "192");
    rect.setAttribute("height", "64");
    rect.setAttribute("rx", "8");
    rect.setAttribute("fill", LABEL_COLORS[node.label] ?? "#465160");
    group.append(rect);
  } else {
    const rect = createSvg("rect");
    rect.setAttribute("x", String(position.x - 82));
    rect.setAttribute("y", String(position.y - 26));
    rect.setAttribute("width", "164");
    rect.setAttribute("height", "52");
    rect.setAttribute("rx", "8");
    rect.setAttribute("fill", LABEL_COLORS[node.label] ?? "#465160");
    group.append(rect);
  }

  const title = createSvg("text");
  title.setAttribute("x", String(position.x));
  title.setAttribute("y", String(position.y - 4));
  title.setAttribute("text-anchor", "middle");
  title.setAttribute("class", "graph-label");
  title.textContent = graphNodeTitle(node, isFocus);

  const subtitle = createSvg("text");
  subtitle.setAttribute("x", String(position.x));
  subtitle.setAttribute("y", String(position.y + 14));
  subtitle.setAttribute("text-anchor", "middle");
  subtitle.setAttribute("class", "graph-section-label");
  subtitle.textContent = node.label === "Disruption"
    ? focusedDisruption?.targetId ?? ""
    : node.kind ?? node.label;

  group.append(title, subtitle);
  return group;
}

function renderEntityPanel() {
  if (!state.selectedEntityId) {
    dom.entityPanel.className = "detail-list empty-state";
    dom.entityPanel.replaceChildren(renderMessage("Select a node from the map or graph."));
    return;
  }

  const node = getNodeById(state.selectedEntityId);
  if (!state.entityContext || !node) {
    dom.entityPanel.className = "detail-list empty-state";
    dom.entityPanel.replaceChildren(renderMessage("Loading entity context..."));
    return;
  }

  dom.entityPanel.className = "detail-list";
  const properties = summarizeProperties(node.properties);
  dom.entityPanel.replaceChildren(
    renderKeyValueCard("Entity", {
      Id: node.id,
      Label: node.label,
      Name: displayName(node),
      ...(node.kind ? { Kind: node.kind } : {}),
      ...properties,
    }),
    renderRefCard("Upstream", state.entityContext.upstream),
    renderRefCard("Downstream", state.entityContext.downstream),
  );
}

function renderImpactPanel() {
  const impactRun = getVisibleImpact();
  if (!impactRun) {
    dom.impactPanel.className = "detail-list empty-state";
    dom.impactPanel.replaceChildren(renderMessage("Run an impact preview."));
    return;
  }

  const summary = impactRun.summary;
  const topCommitments = [...impactRun.commitmentObservations]
    .filter((item) => item.affected || item.atRiskAfter)
    .sort((a, b) => b.riskAfter - a.riskAfter || a.commitmentId.localeCompare(b.commitmentId))
    .slice(0, 5);

  dom.impactPanel.className = "detail-list";
  dom.impactPanel.replaceChildren(
    renderKeyValueCard("Summary", {
      "Impacted shipments": summary.impactedShipmentCount,
      "Impacted commitments": summary.impactedCommitmentCount,
      "P0 at risk": summary.p0AtRiskCommitmentCountAfter,
      "Total risk": formatNumber(summary.totalRiskAfter),
      "Risk delta": signed(summary.riskDelta),
      "Max lateness (h)": summary.maxLatenessHoursAfter ?? "0",
    }),
    renderObservationCard("Most exposed commitments", topCommitments.map((item) => ({
      title: item.commitmentId,
      detail: `${item.priority} • risk ${formatNumber(item.riskAfter)} • ETA delta ${signed(item.etaDeltaHours ?? 0)}h`,
    }))),
  );
}

function renderRecommendations() {
  if (!state.recommendationRun) {
    const actionableCount = getActionableScopedDisruptions().length;
    dom.recommendationMeta.textContent = actionableCount === 0 ? "No active action needed" : "No run yet";
    dom.recommendationPanel.className = "stack empty-state";
    dom.recommendationPanel.replaceChildren(
      renderMessage(
        actionableCount === 0
          ? "Mitigated incidents remain in scope until they end, but they do not request new actions."
          : "Select an active disruption and run Recommend.",
      ),
    );
    return;
  }

  const run = state.recommendationRun;
  dom.recommendationMeta.textContent = `${run.summary.candidateCount} candidates • ${run.objective}`;
  dom.recommendationPanel.className = "stack";
  dom.recommendationPanel.replaceChildren(
    ...run.actions.slice(0, 8).map((entry, index) => {
      const card = document.createElement("article");
      card.className = `item recommendation-card${state.recommendationPreview?.action.id === entry.action.id ? " selected" : ""}`;
      card.tabIndex = 0;
      card.addEventListener("click", () => previewRecommendation(entry));

      const header = document.createElement("div");
      header.className = "recommendation-header";
      header.innerHTML = `
        <div>
          <h3>${index + 1}. ${escapeHtml(entry.action.summary)}</h3>
          <div class="subtle">${entry.action.type}</div>
        </div>
      `;

      const tags = document.createElement("div");
      tags.className = "tag-row";
      tags.append(
        renderTag(`Risk reduced ${formatNumber(entry.action.riskReduction)}`, metricTone(entry.action.riskReduction, "higher")),
        renderTag(`Extra cost ${signed(entry.action.addedCost)}`, metricTone(entry.action.addedCost, "lower")),
        renderTag(`ETA ${signed(entry.action.etaImprovementHours)}h`, metricTone(entry.action.etaImprovementHours, "higher")),
      );

      const impact = document.createElement("div");
      impact.className = "subtle";
      impact.textContent = `Saved commitments ${entry.commitmentsSaved.length} • Harmed commitments ${entry.commitmentsHarmed.length}`;

      card.append(header, tags, impact);
      return card;
    }),
  );
}

function renderRecommendationPreview() {
  const entry = state.recommendationPreview;
  if (!entry) {
    dom.recommendationPreview.className = "detail-list empty-state";
    dom.recommendationPreview.replaceChildren(renderMessage("Select a recommendation to preview it on the map."));
    return;
  }

  dom.recommendationPreview.className = "detail-list preview-panel";
  const clearButton = document.createElement("button");
  clearButton.className = "button button-secondary";
  clearButton.textContent = "Clear Preview";
  clearButton.disabled = state.busy;
  clearButton.addEventListener("click", clearRecommendationPreview);

  const applyButton = document.createElement("button");
  applyButton.className = "button";
  applyButton.textContent = "Apply Previewed Action";
  applyButton.disabled = state.busy;
  applyButton.addEventListener("click", () => applyRecoveryAction(entry.action.id));

  dom.recommendationPreview.replaceChildren(
    renderKeyValueCard("Preview", {
      Action: entry.action.summary,
      Type: entry.action.type,
      "Rank score": formatNumber(entry.action.score),
      "Risk reduced": formatNumber(entry.action.riskReduction),
      "Extra cost": signed(entry.action.addedCost),
      "ETA change (h)": signed(entry.action.etaImprovementHours),
      "Commitments saved": entry.commitmentsSaved.length,
      "Commitments harmed": entry.commitmentsHarmed.length,
    }),
    clearButton,
    applyButton,
  );
}

function renderNeo4jPanel() {
  if (!state.neo4jCounts) {
    dom.neo4jPanel.className = "detail-list empty-state";
    dom.neo4jPanel.replaceChildren(renderMessage("Database counts will appear here."));
    return;
  }

  dom.neo4jPanel.className = "detail-list";
  dom.neo4jPanel.replaceChildren(
    renderKeyValueCard("Node labels", state.neo4jCounts.nodes),
    renderKeyValueCard("Relationship types", state.neo4jCounts.relationships),
  );
}

async function runImpact() {
  if (!state.scenarioId) return;
  await guarded(async () => {
    const disruptions = requireScopedDisruptions();
    const payload = { includeUnaffected: true, disruptions };
    state.impactRun = await request(`/api/scenarios/${state.scenarioId}/impact-runs`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.activeDisruption = getFocusedDisruption() ?? disruptions[0] ?? null;
    renderAll();
    if (state.activeDisruption?.targetId) {
      await selectEntity(state.activeDisruption.targetId, { quiet: true });
    }
  });
}

async function runRecommendations() {
  if (!state.scenarioId) return;
  if (getActionableScopedDisruptions().length === 0) return;
  await guarded(async () => {
    const disruptions = requireScopedDisruptions();
    const payload = {
      objective: dom.objectivePreset.value,
      includeImpactRuns: true,
      maxCandidates: 12,
      disruptions,
    };
    state.recommendationRun = await request(`/api/scenarios/${state.scenarioId}/recommendation-runs`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.impactRun = state.recommendationRun.baselineImpact;
    state.recommendationPreview = null;
    state.activeDisruption = getFocusedDisruption() ?? disruptions[0] ?? null;
    renderAll();
    if (state.activeDisruption?.targetId) {
      await selectEntity(state.activeDisruption.targetId, { quiet: true });
    }
  });
}

function previewRecommendation(entry) {
  if (state.recommendationPreview?.action.id === entry.action.id) {
    clearRecommendationPreview();
    return;
  }
  state.recommendationPreview = entry;
  renderRecommendationPreview();
  renderRecommendations();
  renderMap();
}

function clearRecommendationPreview() {
  state.recommendationPreview = null;
  renderRecommendationPreview();
  renderRecommendations();
  renderMap();
}

async function applyRecoveryAction(actionId) {
  if (!state.scenarioId) return;
  await guarded(async () => {
    const result = await request(`/api/scenarios/${state.scenarioId}/recovery-actions/${encodeURIComponent(actionId)}/apply`, {
      method: "POST",
    });
    state.impactRun = result.postImpact;
    state.recommendationRun = null;
    state.recommendationPreview = null;
    state.disruptions = result.disruptions;
    syncSelectedDisruptionIds();
    await loadScenarioResources();
    if (state.selectedEntityId) {
      await selectEntity(state.selectedEntityId, { quiet: true });
    } else if (state.activeDisruption?.targetId) {
      await selectEntity(state.activeDisruption.targetId, { quiet: true });
    }
  });
}

async function resetScenario() {
  if (!state.scenarioId) return;
  await guarded(async () => {
    const reset = await request(`/api/scenarios/${state.scenarioId}/reset`, {
      method: "POST",
    });
    state.now = reset.now;
    state.impactRun = null;
    state.recommendationRun = null;
    state.recommendationPreview = null;
    state.draftDisruption = null;
    state.draftDisruptionLabel = null;
    state.draftImpactRun = null;
    state.entityContext = null;
    state.selectedEntityId = null;
    state.activeDisruption = null;
    state.selectedDisruptionId = null;
    state.selectedDisruptionIds = [];
    state.disruptions = [];
    await loadScenarioResources();
  });
}

async function previewCustomEvent() {
  await previewDraftDisruption(buildDisruptionPayload(), "Custom event");
}

async function injectCustomEvent() {
  if (state.draftDisruption) {
    await injectDisruption(state.draftDisruption);
    return;
  }
  await previewCustomEvent();
}

async function previewMenuEvent(template) {
  const disruption = buildMenuEvent(template);
  if (!disruption) return;
  await previewDraftDisruption(disruption, template.title);
}

async function injectPreviewedEvent() {
  if (!state.draftDisruption) return;
  await injectDisruption(state.draftDisruption);
}

async function injectDisruption(disruption) {
  if (!state.scenarioId) return;
  await guarded(async () => {
    const created = await request(`/api/scenarios/${state.scenarioId}/disruptions`, {
      method: "POST",
      body: JSON.stringify(disruption),
    });
    state.disruptions = [created, ...state.disruptions.filter((item) => item.id !== created.id)];
    state.activeDisruption = created;
    state.selectedDisruptionId = created.id;
    state.selectedDisruptionIds = getDefaultSelectedDisruptionIds();
    state.impactRun = null;
    state.recommendationRun = null;
    state.recommendationPreview = null;
    state.draftDisruption = null;
    state.draftDisruptionLabel = null;
    state.draftImpactRun = null;
    dom.marauderStatus.textContent = "Event injected";
    renderAll();
    await runImpact();
  });
}

async function previewDraftDisruption(disruption, label = null) {
  if (!state.scenarioId || !disruption) return;
  await guarded(async () => {
    state.draftDisruption = disruption;
    state.draftDisruptionLabel = label;
    state.recommendationRun = null;
    state.recommendationPreview = null;
    const disruptions = [...getOngoingDisruptions(), disruption];
    state.draftImpactRun = await request(`/api/scenarios/${state.scenarioId}/impact-runs`, {
      method: "POST",
      body: JSON.stringify({ includeUnaffected: true, disruptions }),
    });
    state.activeDisruption = disruption;
    state.selectedDisruptionId = disruption.id ?? null;
    dom.marauderStatus.textContent = "Draft preview ready";
    renderAll();
    if (disruption.targetId) {
      await selectEntity(disruption.targetId, { quiet: true });
    }
  });
}

function clearDraftPreview(options = {}) {
  state.draftDisruption = null;
  state.draftDisruptionLabel = null;
  state.draftImpactRun = null;
  state.activeDisruption = state.selectedDisruptionId
    ? state.disruptions.find((item) => item.id === state.selectedDisruptionId) ?? getLatestOngoingDisruption()
    : getLatestOngoingDisruption();
  state.selectedDisruptionId = state.activeDisruption?.id ?? null;
  if (!options.preserveStatus) {
    dom.marauderStatus.textContent = "Ready";
  }
  renderDraftEventPanel();
  renderIncidentBanner();
  renderMap();
  renderCausalityGraph();
  renderImpactPanel();
  renderMarauderEvents();
}

async function advanceScenarioTime(hours) {
  if (!state.scenarioId || state.now === null) return;
  await guarded(async () => {
    const next = await request(`/api/scenarios/${state.scenarioId}/time`, {
      method: "POST",
      body: JSON.stringify({ now: state.now + hours * 3_600_000 }),
    });
    state.now = next.now;
    state.recommendationRun = null;
    state.recommendationPreview = null;
    await loadScenarioResources();
    if (state.draftDisruption) {
      await previewDraftDisruption(
        { ...state.draftDisruption, startsAt: Math.max(state.draftDisruption.startsAt, state.now) },
        state.draftDisruptionLabel,
      );
    } else if (getScopedDisruptions().length > 0) {
      await runImpact();
    }
    dom.marauderStatus.textContent = `Time advanced to ${formatTimestamp(state.now)}`;
  });
}

async function resolveDisruption(disruptionId) {
  if (!state.scenarioId) return;
  await guarded(async () => {
    const resolved = await request(`/api/scenarios/${state.scenarioId}/disruptions/${encodeURIComponent(disruptionId)}/resolve`, {
      method: "POST",
    });
    state.disruptions = state.disruptions.map((item) => (item.id === resolved.id ? resolved : item));
    if (state.selectedDisruptionId === resolved.id) {
      syncSelectedDisruptionIds();
      state.activeDisruption = getLatestOngoingDisruption();
      state.selectedDisruptionId = state.activeDisruption?.id ?? null;
      state.impactRun = null;
      state.recommendationRun = null;
      state.recommendationPreview = null;
    }
    renderAll();
  }, { quiet: true });
}

function toggleDisruptionSelection(disruptionId) {
  const disruption = state.disruptions.find((item) => item.id === disruptionId);
  if (!disruption || !isDisruptionOngoing(disruption) || disruption.status !== "active") return;
  const selectedIds = new Set(getScopedDisruptionIds());
  if (selectedIds.has(disruptionId)) {
    selectedIds.delete(disruptionId);
  } else {
    selectedIds.add(disruptionId);
  }
  state.selectedDisruptionIds = [...selectedIds].filter((id) => state.disruptions.some((item) => item.id === id));
  state.activeDisruption = disruption;
  state.selectedDisruptionId = disruption.id;
  state.recommendationPreview = null;
  state.draftImpactRun = null;
  renderAll();
  if (disruption.targetId) {
    selectEntity(disruption.targetId, { quiet: true });
  }
  const scoped = getScopedDisruptions();
  if (scoped.length > 0) {
    runImpact();
  } else {
    state.impactRun = null;
    renderImpactPanel();
  }
}

async function fetchNeo4jCounts() {
  if (!state.scenarioId) return;
  await guarded(async () => {
    const response = await request(`/api/scenarios/${state.scenarioId}/neo4j/counts`);
    state.neo4jCounts = response;
    dom.neo4jStatus.textContent = "Counts loaded";
    renderNeo4jPanel();
  });
}

async function runNeo4jIngest() {
  if (!state.scenarioId) return;
  await guarded(async () => {
    const response = await request(`/api/scenarios/${state.scenarioId}/neo4j/ingest`, {
      method: "POST",
    });
    state.neo4jCounts = response.counts;
    dom.neo4jStatus.textContent = "Scenario persisted";
    renderNeo4jPanel();
  });
}

async function resetNeo4j() {
  if (!state.scenarioId) return;
  await guarded(async () => {
    const response = await request(`/api/scenarios/${state.scenarioId}/neo4j/reset`, {
      method: "POST",
    });
    state.neo4jCounts = response.counts;
    dom.neo4jStatus.textContent = "Scenario removed";
    renderNeo4jPanel();
  });
}

async function selectEntity(entityId, options = {}) {
  if (!state.scenarioId) return;
  state.selectedEntityId = entityId;
  renderMap();
  renderCausalityGraph();
  renderEntityPanel();
  await guarded(async () => {
    state.entityContext = await request(`/api/scenarios/${state.scenarioId}/entities/${encodeURIComponent(entityId)}/context`);
    renderEntityPanel();
  }, { quiet: options.quiet ?? true });
}

function clearSelectedEntity() {
  state.selectedEntityId = null;
  state.entityContext = null;
  renderMap();
  renderCausalityGraph();
  renderEntityPanel();
}

function buildDisruptionPayload() {
  const type = dom.disruptionType.value;
  const targetId = dom.disruptionTarget.value;
  const targetKind = DISRUPTION_CONFIG[type].targetLabel;
  return {
    type,
    targetKind,
    targetId,
    startsAt: state.now ?? Date.now(),
    durationHours: Number(dom.disruptionDuration.value),
    severity: Number(dom.disruptionSeverity.value),
  };
}

function buildMenuEvent(template) {
  const buckets = graphBuckets();
  const target = template.pickTarget(buckets);
  if (!target) return null;
  return {
    type: template.type,
    targetKind: template.targetKind,
    targetId: target.id,
    startsAt: state.now ?? Date.now(),
    durationHours: template.durationHours,
    severity: template.severity,
  };
}

function graphBuckets() {
  const nodes = state.graph?.nodes ?? [];
  return {
    locations: nodes.filter((node) => node.label === "Location"),
    lanes: nodes.filter((node) => node.label === "Lane"),
    inventoryPools: nodes.filter((node) => node.label === "InventoryPool"),
    products: nodes.filter((node) => node.label === "Product"),
  };
}

function requireScopedDisruptions() {
  const disruptions = getScopedDisruptions();
  if (!disruptions.length) {
    throw new Error("No ongoing disruption in scope");
  }
  return disruptions;
}

function getFocusedDisruption() {
  if (state.activeSurface === "marauder" && state.draftDisruption) {
    return state.draftDisruption;
  }
  return state.activeDisruption ?? getLatestOngoingDisruption();
}

function getLatestOngoingDisruption() {
  return getOngoingDisruptions()
    .sort((a, b) => b.startsAt - a.startsAt || a.id.localeCompare(b.id))[0] ?? null;
}

function getDefaultSelectedDisruptionIds() {
  return getOngoingDisruptions().map((item) => item.id);
}

function getScopedDisruptionIds() {
  const ongoingIds = new Set(getOngoingDisruptions().map((item) => item.id));
  const selected = state.selectedDisruptionIds.filter((id) => ongoingIds.has(id));
  return selected.length ? selected : [...ongoingIds];
}

function getScopedDisruptions() {
  const scopedIds = new Set(getScopedDisruptionIds());
  return getOngoingDisruptions().filter((item) => scopedIds.has(item.id));
}

function getActionableScopedDisruptions() {
  return getScopedDisruptions().filter((item) => item.status === "active");
}

function syncSelectedDisruptionIds() {
  const ongoingIds = new Set(getOngoingDisruptions().map((item) => item.id));
  state.selectedDisruptionIds = state.selectedDisruptionIds.filter((id) => ongoingIds.has(id));
  if (state.selectedDisruptionIds.length === 0) {
    state.selectedDisruptionIds = [...ongoingIds];
  }
}

function getOngoingDisruptions() {
  return [...(state.disruptions ?? [])].filter((item) => isDisruptionOngoing(item));
}

function isDisruptionOngoing(disruption) {
  const now = state.now ?? state.scenarioMeta?.scenarioStart ?? Date.now();
  return disruption.status !== "resolved" && disruption.startsAt <= now && now < disruption.endsAt;
}

function disruptionPhase(disruption) {
  if (disruption.status === "resolved") return { label: "resolved", tone: "" };
  if (!isDisruptionOngoing(disruption)) return { label: "ended", tone: "" };
  if (disruption.status === "mitigated") return { label: "mitigated", tone: "warn" };
  return { label: "active", tone: "bad" };
}

function buildLaneInfo() {
  const nodesById = new Map(state.graph.nodes.map((node) => [node.id, node]));
  const starts = new Map();
  const ends = new Map();
  for (const edge of state.graph.edges) {
    if (edge.type === "LANE_START") starts.set(edge.target, edge.source);
    if (edge.type === "LANE_END") ends.set(edge.source, edge.target);
  }
  return state.graph.nodes
    .filter((node) => node.label === "Lane")
    .map((node) => ({
      id: node.id,
      mode: node.kind,
      originId: starts.get(node.id),
      destinationId: ends.get(node.id),
      properties: node.properties,
    }))
    .filter((lane) => lane.originId && lane.destinationId);
}

function buildNeighborhood(focusId) {
  const nodesById = new Map(state.graph.nodes.map((node) => [node.id, node]));
  const incomingEdges = state.graph.edges.filter((edge) => edge.target === focusId);
  const outgoingEdges = state.graph.edges.filter((edge) => edge.source === focusId);
  return {
    incoming: incomingEdges.map((edge) => nodesById.get(edge.source)).filter(Boolean),
    outgoing: outgoingEdges.map((edge) => nodesById.get(edge.target)).filter(Boolean),
    edges: [
      ...incomingEdges.filter((edge) => nodesById.has(edge.source)),
      ...outgoingEdges.filter((edge) => nodesById.has(edge.target)),
    ],
  };
}

function layoutLocations(nodes, width, height, padding) {
  const xs = nodes.map((node) => Number(node.properties.x));
  const ys = nodes.map((node) => Number(node.properties.y));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scaleX = (value) => padding + ((value - minX) / Math.max(maxX - minX, 1)) * (width - padding * 2);
  const scaleY = (value) => padding + ((value - minY) / Math.max(maxY - minY, 1)) * (height - padding * 2);

  return new Map(
    nodes.map((node) => [
      node.id,
      {
        x: scaleX(Number(node.properties.x)),
        y: scaleY(Number(node.properties.y)),
      },
    ]),
  );
}

function ensureMap() {
  if (state.map || !dom.map) return;
  if (!window.maplibregl) {
    dom.map.textContent = "MapLibre failed to load.";
    return;
  }

  let map;
  try {
    map = new window.maplibregl.Map({
      container: dom.map,
      style: MAP_STYLE,
      center: [96, 18],
      zoom: 2.7,
      attributionControl: false,
    });
  } catch (error) {
    dom.map.innerHTML = `<div class="map-error">${escapeHtml(error instanceof Error ? error.message : "MapLibre initialization failed.")}</div>`;
    return;
  }

  map.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.on("error", (event) => {
    const message = event?.error instanceof Error ? event.error.message : "";
    if (/webgl/i.test(message)) {
      dom.map.innerHTML = `<div class="map-error">${escapeHtml(message)}</div>`;
    }
  });
  map.on("load", () => {
    state.mapReady = true;
    addMapLayers(map);
    renderMap();
  });
  attachMapInteractions(map);
  state.map = map;
}

function addMapLayers(map) {
  map.addSource("sentinel-lanes", { type: "geojson", data: emptyGeoJson() });
  map.addSource("sentinel-nodes", { type: "geojson", data: emptyGeoJson() });
  map.addSource("sentinel-incidents", { type: "geojson", data: emptyGeoJson() });

  map.addLayer({
    id: "lanes-base",
    type: "line",
    source: "sentinel-lanes",
    paint: {
      "line-color": [
        "match",
        ["get", "mode"],
        "truck", "#2d8ef0",
        "rail", "#62b7ff",
        "ocean", "#1fbe7c",
        "air", "#d79a41",
        "#577185",
      ],
      "line-width": 2,
      "line-opacity": 0.55,
    },
  });

  map.addLayer({
    id: "lanes-affected",
    type: "line",
    source: "sentinel-lanes",
    filter: ["==", ["get", "affected"], 1],
    paint: {
      "line-color": "#7fd3ff",
      "line-width": 4,
      "line-opacity": 0.8,
    },
  });

  map.addLayer({
    id: "lanes-disrupted",
    type: "line",
    source: "sentinel-lanes",
    filter: ["==", ["get", "disrupted"], 1],
    paint: {
      "line-color": "#ef6b6b",
      "line-width": 5,
      "line-opacity": 0.95,
    },
  });

  map.addLayer({
    id: "lanes-preview",
    type: "line",
    source: "sentinel-lanes",
    filter: ["==", ["get", "preview"], 1],
    paint: {
      "line-color": "#ffe08a",
      "line-width": 6,
      "line-opacity": 0.95,
    },
  });

  map.addLayer({
    id: "nodes-halo",
    type: "circle",
    source: "sentinel-nodes",
    filter: ["any", ["==", ["get", "affected"], 1], ["==", ["get", "disrupted"], 1]],
    paint: {
      "circle-color": [
        "case",
        ["==", ["get", "disrupted"], 1],
        "#ef6b6b",
        "#5db6ff",
      ],
      "circle-radius": [
        "case",
        ["==", ["get", "disrupted"], 1],
        18,
        14,
      ],
      "circle-opacity": 0.18,
    },
  });

  map.addLayer({
    id: "nodes-base",
    type: "circle",
    source: "sentinel-nodes",
    paint: {
      "circle-color": [
        "match",
        ["get", "kind"],
        "supplier", "#4da9ff",
        "factory", "#f0aa52",
        "hub", "#7e84ff",
        "port", "#33c98d",
        "warehouse", "#d68dff",
        "destination", "#ff7d8d",
        "#9ba8b6",
      ],
      "circle-radius": [
        "case",
        ["==", ["get", "preview"], 1], 10,
        ["==", ["get", "selected"], 1], 9,
        ["==", ["get", "disrupted"], 1], 10,
        6,
      ],
      "circle-stroke-color": [
        "case",
        ["==", ["get", "preview"], 1], "#fff1c2",
        ["==", ["get", "selected"], 1], "#ffffff",
        ["==", ["get", "disrupted"], 1], "#ffd5d5",
        "rgba(255,255,255,0.35)",
      ],
      "circle-stroke-width": [
        "case",
        ["==", ["get", "preview"], 1], 2.6,
        ["==", ["get", "selected"], 1], 2.5,
        ["==", ["get", "disrupted"], 1], 2.2,
        1.1,
      ],
    },
  });

  map.addLayer({
    id: "node-labels",
    type: "symbol",
    source: "sentinel-nodes",
    layout: {
      "text-field": ["get", "label"],
      "text-size": 11,
      "text-offset": [0, 1.2],
      "text-anchor": "top",
      "text-font": ["Open Sans Semibold"],
    },
    paint: {
      "text-color": "#eef4fb",
      "text-halo-color": "rgba(17, 28, 39, 0.88)",
      "text-halo-width": 1,
    },
  });

  map.addLayer({
    id: "incident-rings",
    type: "circle",
    source: "sentinel-incidents",
    paint: {
      "circle-radius": 20,
      "circle-color": "rgba(239, 107, 107, 0.08)",
      "circle-stroke-color": "#ef6b6b",
      "circle-stroke-width": 2,
    },
  });

  map.addLayer({
    id: "incident-labels",
    type: "symbol",
    source: "sentinel-incidents",
    layout: {
      "text-field": ["get", "label"],
      "text-size": 11,
      "text-offset": [0, -2.1],
      "text-font": ["Open Sans Bold"],
    },
    paint: {
      "text-color": "#ffd5d5",
      "text-halo-color": "rgba(17, 28, 39, 0.9)",
      "text-halo-width": 1,
    },
  });
}

function attachMapInteractions(map) {
  for (const layerId of ["nodes-base", "lanes-base", "lanes-affected", "lanes-disrupted", "lanes-preview"]) {
    map.on("mouseenter", layerId, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
    });
  }

  map.on("click", "nodes-base", (event) => {
    const id = event.features?.[0]?.properties?.id;
    if (id) {
      selectEntity(String(id));
    }
  });

  for (const layerId of ["lanes-base", "lanes-affected", "lanes-disrupted", "lanes-preview"]) {
    map.on("click", layerId, (event) => {
      const id = event.features?.[0]?.properties?.id;
      if (id) {
        selectEntity(String(id));
      }
    });
  }

  map.on("click", (event) => {
    const features = map.queryRenderedFeatures(event.point, {
      layers: ["nodes-base", "lanes-base", "lanes-affected", "lanes-disrupted", "lanes-preview"],
    });
    if (features.length === 0) {
      clearSelectedEntity();
    }
  });
}

function buildMapCollections() {
  const locationNodes = state.graph.nodes.filter((node) => node.label === "Location");
  const laneInfo = buildLaneInfo();
  const geoPoints = projectLocationsToMap(locationNodes);
  const affectedSet = new Set(getVisibleImpact()?.affectedEntityIds ?? []);
  const disruptions = getVisibleDisruptions();
  const disruptedLocationIds = new Set(disruptions.filter((item) => item.targetKind === "Location").map((item) => item.targetId));
  const disruptedLaneIds = new Set(disruptions.filter((item) => item.targetKind === "Lane").map((item) => item.targetId));
  const previewLaneIds = getPreviewLaneIds();
  const previewNodeIds = getPreviewNodeIds(laneInfo);

  const nodeFeatures = {
    type: "FeatureCollection",
    features: locationNodes
      .map((node) => {
        const point = geoPoints.get(node.id);
        if (!point) return null;
        return {
          type: "Feature",
          properties: {
            id: node.id,
            kind: node.kind,
            label: shortName(node),
            selected: state.selectedEntityId === node.id ? 1 : 0,
            disrupted: disruptedLocationIds.has(node.id) ? 1 : 0,
            affected: affectedSet.has(node.id) ? 1 : 0,
            preview: previewNodeIds.has(node.id) ? 1 : 0,
          },
          geometry: { type: "Point", coordinates: point },
        };
      })
      .filter(Boolean),
  };

  const laneFeatures = {
    type: "FeatureCollection",
    features: laneInfo
      .map((lane) => {
        const start = geoPoints.get(lane.originId);
        const end = geoPoints.get(lane.destinationId);
        if (!start || !end) return null;
        return {
          type: "Feature",
          properties: {
            id: lane.id,
            mode: lane.mode,
            affected: affectedSet.has(lane.id) ? 1 : 0,
            disrupted: disruptedLaneIds.has(lane.id) ? 1 : 0,
            preview: previewLaneIds.has(lane.id) ? 1 : 0,
          },
          geometry: { type: "LineString", coordinates: [start, end] },
        };
      })
      .filter(Boolean),
  };

  const incidentFeatures = {
    type: "FeatureCollection",
    features: disruptions.flatMap((item) => buildIncidentFeatures(item, geoPoints, laneInfo)),
  };

  return {
    nodeFeatures,
    laneFeatures,
    incidentFeatures,
    bounds: buildMapBounds(geoPoints),
  };
}

function projectLocationsToMap(nodes) {
  const xs = nodes.map((node) => Number(node.properties.x));
  const ys = nodes.map((node) => Number(node.properties.y));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return new Map(
    nodes.map((node) => {
      const xNorm = (Number(node.properties.x) - minX) / Math.max(maxX - minX, 1);
      const yNorm = (Number(node.properties.y) - minY) / Math.max(maxY - minY, 1);
      const lon = MAP_WORLD.west + xNorm * (MAP_WORLD.east - MAP_WORLD.west);
      const lat = MAP_WORLD.north - yNorm * (MAP_WORLD.north - MAP_WORLD.south);
      return [node.id, [lon, lat]];
    }),
  );
}

function buildIncidentFeatures(disruption, geoPoints, laneInfo) {
  const anchor = resolveDisruptionGeoAnchor(disruption, geoPoints, laneInfo);
  if (!anchor) return [];
  return [{
    type: "Feature",
    properties: { label: anchor.label },
    geometry: { type: "Point", coordinates: anchor.point },
  }];
}

function resolveDisruptionGeoAnchor(disruption, geoPoints, laneInfo) {
  if (!disruption) return null;
  const label = DISRUPTION_CONFIG[disruption.type].label;
  if (disruption.targetKind === "Location") {
    const point = geoPoints.get(disruption.targetId);
    return point ? { point, label } : null;
  }
  if (disruption.targetKind === "Lane") {
    const lane = laneInfo.find((item) => item.id === disruption.targetId);
    if (!lane) return null;
    const start = geoPoints.get(lane.originId);
    const end = geoPoints.get(lane.destinationId);
    if (!start || !end) return null;
    return {
      point: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2],
      label,
    };
  }

  const node = getNodeById(disruption.targetId);
  if (!node) return null;
  if (disruption.targetKind === "InventoryPool" && node.properties.storedAtId) {
    const point = geoPoints.get(String(node.properties.storedAtId));
    return point ? { point, label } : null;
  }
  return null;
}

function buildMapBounds(geoPoints) {
  const points = [...geoPoints.values()];
  if (!points.length) return null;
  const lons = points.map((point) => point[0]);
  const lats = points.map((point) => point[1]);
  return [
    [Math.min(...lons) - 4, Math.min(...lats) - 3],
    [Math.max(...lons) + 4, Math.max(...lats) + 3],
  ];
}

function getVisibleImpact() {
  return state.recommendationPreview?.impact ?? (state.activeSurface === "marauder" ? state.draftImpactRun : null) ?? state.impactRun;
}

function getVisibleDisruptions() {
  const disruptions = [...(state.activeSurface === "marauder" ? getOngoingDisruptions() : getScopedDisruptions())];
  if (state.activeSurface === "marauder" && state.draftDisruption) {
    disruptions.push(state.draftDisruption);
  }
  return disruptions;
}

function getPreviewLaneIds() {
  const action = state.recommendationPreview?.action;
  if (!action) return new Set();
  if (action.type === "reroute") {
    return new Set(Array.isArray(action.payload.newLaneSequence) ? action.payload.newLaneSequence : []);
  }
  if (action.type === "reallocate_inventory") {
    return new Set(Array.isArray(action.payload.laneSequence) ? action.payload.laneSequence : []);
  }
  return new Set();
}

function getPreviewNodeIds(laneInfo) {
  const nodes = new Set();
  for (const laneId of getPreviewLaneIds()) {
    const lane = laneInfo.find((item) => item.id === laneId);
    if (!lane) continue;
    nodes.add(lane.originId);
    nodes.add(lane.destinationId);
  }
  return nodes;
}

function updateMapSource(id, data) {
  const source = state.map?.getSource(id);
  if (source) {
    source.setData(data);
  }
}

function emptyGeoJson() {
  return { type: "FeatureCollection", features: [] };
}

function drawMapBackdrop(svg) {
  for (let x = 80; x <= 920; x += 120) {
    const line = createSvg("line");
    line.setAttribute("x1", String(x));
    line.setAttribute("y1", "32");
    line.setAttribute("x2", String(x));
    line.setAttribute("y2", "608");
    line.setAttribute("class", "map-grid");
    svg.append(line);
  }
  for (let y = 60; y <= 580; y += 100) {
    const line = createSvg("line");
    line.setAttribute("x1", "40");
    line.setAttribute("y1", String(y));
    line.setAttribute("x2", "960");
    line.setAttribute("y2", String(y));
    line.setAttribute("class", "map-grid");
    svg.append(line);
  }

  const regionA = createSvg("path");
  regionA.setAttribute("d", "M80 150 C240 70, 370 90, 470 180 S660 320, 760 250 L760 420 C650 470, 470 480, 300 430 S120 320, 80 150 Z");
  regionA.setAttribute("class", "map-region");
  const regionB = createSvg("path");
  regionB.setAttribute("d", "M620 120 C720 90, 840 130, 900 220 L900 520 C820 560, 720 540, 650 470 S560 250, 620 120 Z");
  regionB.setAttribute("class", "map-region");
  svg.append(regionA, regionB);
}

function drawMapDisruptionOverlay(layer, disruption, coords, laneInfo) {
  const anchor = resolveDisruptionAnchor(disruption, coords, laneInfo);
  if (anchor?.point) {
    const point = anchor.point;
    const ring = createSvg("circle");
    ring.setAttribute("cx", String(point.x));
    ring.setAttribute("cy", String(point.y));
    ring.setAttribute("r", disruption.targetKind === "Lane" ? "24" : "42");
    ring.setAttribute("class", "map-incident-ring");
    const label = createSvg("text");
    label.setAttribute("x", String(point.x));
    label.setAttribute("y", String(point.y - (disruption.targetKind === "Lane" ? 30 : 54)));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "map-incident-label");
    label.textContent = anchor.label;
    layer.append(ring, label);
    return;
  }

  if (disruption.targetKind === "Location") {
    const point = coords.get(disruption.targetId);
    if (!point) return;
    const ring = createSvg("circle");
    ring.setAttribute("cx", String(point.x));
    ring.setAttribute("cy", String(point.y));
    ring.setAttribute("r", "42");
    ring.setAttribute("class", "map-incident-ring");
    const label = createSvg("text");
    label.setAttribute("x", String(point.x));
    label.setAttribute("y", String(point.y - 54));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "map-incident-label");
    label.textContent = DISRUPTION_CONFIG[disruption.type].label;
    layer.append(ring, label);
    return;
  }
}

function curvedPath(start, end) {
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const controlOffsetX = -dy * 0.08;
  const controlOffsetY = dx * 0.08;
  return `M ${start.x} ${start.y} Q ${midX + controlOffsetX} ${midY + controlOffsetY} ${end.x} ${end.y}`;
}

function selectedOrDisruptedNodeRadius(nodeId, disruption, affectedSet) {
  if (disruption && disruption.targetKind === "Location" && disruption.targetId === nodeId) return "13";
  if (state.selectedEntityId === nodeId) return "12";
  if (affectedSet.has(nodeId)) return "11";
  return "9";
}

function graphNodeTitle(node, isFocus) {
  const base = node.label === "Disruption" ? node.name : displayName(node);
  const maxLength = isFocus ? 24 : 18;
  return base.length > maxLength ? `${base.slice(0, maxLength)}…` : base;
}

function summarizeProperties(properties) {
  const keys = [
    "transitHours",
    "handlingTimeHours",
    "capacityUnitsPerHour",
    "unitsPerHour",
    "costPerUnit",
    "quantity",
    "currentEta",
    "mustArriveBy",
    "status",
  ];
  const summary = {};
  for (const key of keys) {
    if (properties[key] !== undefined && properties[key] !== null) {
      summary[key] = typeof properties[key] === "number" ? formatPropertyNumber(key, properties[key]) : String(properties[key]);
    }
  }
  return summary;
}

function formatPropertyNumber(key, value) {
  if (key.endsWith("At") || key === "mustArriveBy" || key === "currentEta") {
    return formatTimestamp(value);
  }
  return formatNumber(value);
}

function renderKeyValueCard(title, values) {
  const card = document.createElement("article");
  card.className = "item";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const list = document.createElement("dl");
  list.className = "kv";
  for (const [key, value] of Object.entries(values)) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    list.append(dt, dd);
  }
  card.append(heading, list);
  return card;
}

function renderRefCard(title, refs) {
  return renderObservationCard(
    title,
    refs.length
      ? refs.map((ref) => ({
          title: `${ref.relationship} • ${ref.id}`,
          detail: [ref.label, ref.name ?? ref.kind].filter(Boolean).join(" • "),
        }))
      : [{ title: "None", detail: "No linked entities" }],
  );
}

function renderObservationCard(title, rows) {
  const card = document.createElement("article");
  card.className = "item";
  const heading = document.createElement("strong");
  heading.textContent = title;
  card.append(heading);
  for (const row of rows) {
    const block = document.createElement("div");
    block.className = "subtle";
    block.style.marginTop = "8px";
    block.innerHTML = `<div>${escapeHtml(row.title)}</div><div>${escapeHtml(row.detail)}</div>`;
    card.append(block);
  }
  return card;
}

function renderTag(text, tone = "") {
  const tag = document.createElement("span");
  tag.className = `tag${tone ? ` ${tone}` : ""}`;
  tag.textContent = text;
  return tag;
}

function metricTone(value, direction) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) return "";
  if (direction === "higher") return numeric > 0 ? "good" : "bad";
  return numeric > 0 ? "warn" : "good";
}

function hoursBetween(start, end) {
  return Math.max(0, Math.round((Number(end) - Number(start)) / 3_600_000));
}

function disruptionDurationHours(disruption) {
  return disruption.durationHours ?? hoursBetween(disruption.startsAt, disruption.endsAt);
}

function applyGraphViewBox() {
  const { x, y, width, height } = state.graphViewport;
  dom.causalityGraph.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
}

function zoomGraph(factor, center) {
  const viewport = state.graphViewport;
  const nextWidth = clamp(viewport.width * factor, 360, 1400);
  const nextHeight = clamp(viewport.height * factor, 230, 900);
  const cx = center?.x ?? viewport.x + viewport.width / 2;
  const cy = center?.y ?? viewport.y + viewport.height / 2;
  state.graphViewport = {
    x: cx - ((cx - viewport.x) / viewport.width) * nextWidth,
    y: cy - ((cy - viewport.y) / viewport.height) * nextHeight,
    width: nextWidth,
    height: nextHeight,
  };
  applyGraphViewBox();
}

function resetGraphZoom() {
  state.graphViewport = { x: 0, y: 0, width: 1000, height: 640 };
  applyGraphViewBox();
}

function onGraphWheel(event) {
  event.preventDefault();
  const point = svgPoint(event);
  zoomGraph(event.deltaY < 0 ? 0.88 : 1.14, point);
}

function onGraphPointerDown(event) {
  dom.causalityGraph.setPointerCapture(event.pointerId);
  state.graphPan = {
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
  };
}

function onGraphPointerMove(event) {
  if (!state.graphPan || state.graphPan.pointerId !== event.pointerId) return;
  const rect = dom.causalityGraph.getBoundingClientRect();
  const dx = ((event.clientX - state.graphPan.clientX) / Math.max(rect.width, 1)) * state.graphViewport.width;
  const dy = ((event.clientY - state.graphPan.clientY) / Math.max(rect.height, 1)) * state.graphViewport.height;
  state.graphViewport = {
    ...state.graphViewport,
    x: state.graphViewport.x - dx,
    y: state.graphViewport.y - dy,
  };
  state.graphPan.clientX = event.clientX;
  state.graphPan.clientY = event.clientY;
  applyGraphViewBox();
}

function onGraphPointerUp(event) {
  if (state.graphPan?.pointerId === event.pointerId) {
    state.graphPan = null;
  }
}

function svgPoint(event) {
  const rect = dom.causalityGraph.getBoundingClientRect();
  return {
    x: state.graphViewport.x + ((event.clientX - rect.left) / Math.max(rect.width, 1)) * state.graphViewport.width,
    y: state.graphViewport.y + ((event.clientY - rect.top) / Math.max(rect.height, 1)) * state.graphViewport.height,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function renderMessage(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div;
}

function getNodeById(id) {
  return state.graph?.nodes.find((node) => node.id === id) ?? null;
}

function displayName(node) {
  if (!node) return "";
  return node.name ?? node.id;
}

function shortName(node) {
  const base = displayName(node).replace(/^s\d+:/, "");
  return base.length > 18 ? `${base.slice(0, 18)}…` : base;
}

function distributeY(count, top, bottom) {
  if (count <= 1) return [(top + bottom) / 2];
  const step = (bottom - top) / (count - 1);
  return Array.from({ length: count }, (_, index) => top + step * index);
}

function nodeTouchedByVisibleDisruptions(nodeId) {
  return getVisibleDisruptions().some((disruption) => disruption.targetId === nodeId);
}

function edgeTouchesVisibleDisruptions(edge) {
  return getVisibleDisruptions().some((disruption) => edge.source === disruption.targetId || edge.target === disruption.targetId);
}

function resolveDisruptionAnchor(disruption, coords, laneInfo) {
  if (!disruption) return null;
  const label = DISRUPTION_CONFIG[disruption.type].label;
  if (disruption.targetKind === "Location") {
    const point = coords.get(disruption.targetId);
    return point ? { point, label } : null;
  }
  if (disruption.targetKind === "Lane") {
    const lane = laneInfo.find((item) => item.id === disruption.targetId);
    if (!lane) return null;
    const start = coords.get(lane.originId);
    const end = coords.get(lane.destinationId);
    if (!start || !end) return null;
    return {
      point: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
      label,
    };
  }

  const node = getNodeById(disruption.targetId);
  if (!node) return null;
  if (disruption.targetKind === "InventoryPool" && node.properties.storedAtId) {
    const point = coords.get(String(node.properties.storedAtId));
    return point ? { point, label } : null;
  }
  if (disruption.targetKind === "Product") {
    const producerEdge = state.graph.edges.find(
      (edge) => edge.type === "PRODUCES" && edge.target === disruption.targetId && coords.has(edge.source),
    );
    if (producerEdge) {
      return { point: coords.get(producerEdge.source), label };
    }
  }
  return null;
}

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  if (Math.abs(numeric) >= 100) return numeric.toFixed(0);
  if (Math.abs(numeric) >= 10) return numeric.toFixed(1);
  return numeric.toFixed(2);
}

function formatTimestamp(value) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function signed(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `${numeric >= 0 ? "+" : ""}${formatNumber(numeric)}`;
}

function normalizeBase(input) {
  return input.trim().replace(/\/+$/, "");
}

function shouldUseStoredApiBase(value) {
  if (!value) return false;
  const currentHost = window.location.hostname;
  if (currentHost !== "127.0.0.1" && currentHost !== "localhost" && /127\.0\.0\.1|localhost/.test(value)) {
    return false;
  }
  return true;
}

async function request(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${state.apiBase}${path}`, {
    headers,
    ...init,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(body?.message ?? body?.error ?? `Request failed: ${response.status}`);
  }
  return body;
}

async function guarded(work, options = {}) {
  setBusy(true);
  try {
    await work();
    if (!options.quiet) setApiStatus("API ready", false);
  } catch (error) {
    if (!options.quiet) setApiStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

function setBusy(nextBusy) {
  state.busy = nextBusy;
  for (const element of [
    dom.resetScenarioButton,
    dom.previewCustomEventButton,
    dom.runRecommendationsButton,
    dom.injectCustomEventButton,
    dom.injectPreviewedEventButton,
    dom.clearDraftEventButton,
    dom.advanceTimeButton,
    dom.neo4jIngestButton,
    dom.neo4jCountsButton,
    dom.neo4jResetButton,
  ]) {
    if (element) {
      element.disabled = nextBusy;
    }
  }
  renderRecommendationControls();
}

function setApiStatus(text, isError) {
  if (isError) {
    dom.apiStatus.textContent = text;
    dom.apiStatus.className = "status-dot pill-danger";
    dom.apiStatus.title = text;
    dom.apiStatus.setAttribute("aria-label", text);
    return;
  }

  if (text === "Connecting") {
    dom.apiStatus.textContent = text;
    dom.apiStatus.className = "status-dot pill-muted";
    dom.apiStatus.title = text;
    dom.apiStatus.setAttribute("aria-label", text);
    return;
  }

  dom.apiStatus.textContent = "";
  dom.apiStatus.className = "status-dot status-dot-quiet pill-muted";
  dom.apiStatus.title = "Connected";
  dom.apiStatus.setAttribute("aria-label", "Connected");
}

function createSvg(tag) {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
