# Sentinel PRD

## 1. Product Definition

Sentinel is a graph-native supply-chain command system.

It models supply-chain operations as an ontology of connected entities, then lets users simulate disruptions, trace impact chains, and choose recovery actions based on priority, deadline risk, capacity, cost, and uncertainty.

Sentinel is not a shipment dashboard, route visualizer, or chatbot wrapper. The core product is **dependency intelligence**:

- What does this entity depend on?
- What depends on this entity?
- What breaks if this entity fails?
- What action reduces the most operational damage?

## 2. Core Thesis

The central business object is a **commitment**:

```txt
Deliver quantity Q of product/load X to destination D by deadline T,
with priority P, delay tolerance H, under penalty curve C.
```

Product category is secondary. Medical supplies, food, electronics, parts, and relief goods are demo skins. The system reasons over operational properties:

- Priority (P0/P1/P2/P3).
- Deadline (`mustArriveBy`).
- Delay tolerance (hours).
- Quantity.
- Handling constraints (cold chain, hazmat).
- Substitutability (modeled as substitution groups).
- Inventory coverage at destination.
- Capacity dependency on lanes/nodes.
- Penalty curve (cliff/ramp/exponential).

If two loads share constraints, priority, deadline, tolerance, and curve, Sentinel must reason about them identically regardless of product label.

## 3. Challenge Fit

Sentinel targets the Smart Supply Chains challenge by building a system that:

- Represents a supply chain as an operational knowledge graph.
- Simulates disruptions against the graph.
- Propagates impact from disrupted nodes and lanes to shipments and commitments.
- Quantifies risk using priority, deadlines, delay tolerance, and uncertainty.
- Recommends reroutes, reallocations, substitutions, and capacity reprioritization before localized disruption cascades.

The system answers "what breaks if X fails, what recovers fastest, and at what cost" — the prompt's preemptive-detection-and-dynamic-rerouting requirement, framed as a dependency-graph problem.

## 4. Users

### Operations Planner
Identifies at-risk commitments, traces causes, selects recovery plans against an objective.

### Incident Commander
Needs fast blast-radius understanding: what broke, who's affected, severity, what to approve.

### Strategy Analyst
Runs what-if simulations, compares scenarios, identifies fragile dependencies.

## 4.1 Product Surfaces

### Sentinel
The main command system. Sentinel is the operator-facing surface for monitoring the network, inspecting blast radius, tracing causality, previewing recovery plans, and applying approved actions.

### Sentinel Event Authoring
Disruption and scenario authoring are part of Sentinel itself. This is the shared ingestion/admin capability behind scenario updates, synthetic incident creation, and demo controls. It is not a separately branded product.

### Marauder
A separate bad-guy dashboard used in demo mode to inject curated **menu events** into Sentinel. Marauder does not replace the ingestion layer; it is an adversarial control surface that submits preconfigured or parameterized disruptions through the same Sentinel backend.

## 5. Core User Questions

Sentinel must answer these directly from graph state and computation, not LLM hallucination.

**Failure exploration**

- What breaks if this port, hub, supplier, lane, or warehouse fails?
- Which commitments will miss their deadlines?
- Which high-priority commitments remain safe?

**Causation**

- Why is this commitment risky?
- Which shipments, routes, inventory pools, and upstream nodes caused the risk?

**Impact scope**

- Which downstream destinations are impacted?

**Recovery**

- What recovery options exist?
- Which option minimizes priority-weighted failure?
- Which is cheapest?
- Which is most resilient under uncertainty?

## 6. Product Modules

### 6.1 Operational Knowledge Graph

The graph is the product center. Node types:

- Location (supplier, factory, hub, port, warehouse, destination).
- Lane (transport edge with identity, capacity, cost, reliability).
- Product.
- SubstitutionGroup (equivalence class for fungible products).
- Shipment.
- Commitment.
- InventoryPool.
- CapacityPool.
- Disruption.
- RecoveryAction.
- ImpactRun, RecommendationRun, Scenario.

Required graph behaviors:

- Downstream blast-radius traversal.
- Upstream root-cause traversal.
- Dependency visualization.
- Before/after comparison of recovery actions.
- Substitution lookup ("what else could fulfill this commitment?").

### 6.2 Scenario Generator

Sentinel operates over synthetic but coherent supply networks generated deterministically from a seed.

Requirements:

- Tiered location generation (suppliers → factories → hubs → warehouses → destinations).
- Deterministic random seed produces the same graph.
- Connectivity guarantee: every destination reachable from at least one origin.
- Redundancy guarantee: for the hero scenario's commitments, at least two edge-disjoint paths exist from origin to destination so reroute candidates are possible.
- Coherent lane parameters (transit time, cost, reliability, capacity).
- Commitments with realistic priority/deadline/quantity distributions.
- Inventory pools at destinations where stockout risk matters.
- Resettable in one operation.

The simulator is **not** a live tick engine. Time is still logical, but it is stateful: Sentinel stores a scenario `now` (initially `scenarioStart`), recomputes ETAs at that time, and lets operators advance time deliberately during a scenario. Applied recovery actions mutate the active scenario state, so later incidents are evaluated on top of earlier mitigations rather than as isolated one-off simulations. Shipments have a static `progressFraction = 0` at scenario start; they don't animate continuously yet.

### 6.3 Disruption Workbench

Disruptions enter the system through Sentinel's event-authoring capability. In demo mode, the separate Marauder dashboard can also inject curated menu events through the same backend path.

Supported disruption types:

- Node closure (location offline).
- Lane closure (route blocked).
- Added transit delay.
- Capacity reduction (multiplier).
- Cost increase (multiplier).
- Supplier outage.
- Inventory loss (quantity or fraction).
- Demand spike (multiplier).
- Reliability drop (multiplier).

Each disruption defines:

- Target entity (location, lane, inventory pool, or product-at-location).
- Start time.
- Duration.
- Severity (effect magnitude).
- Effects (typed payload).
- Optional uncertainty distribution for Monte Carlo.

Incident lifecycle:

- `active` — disruption is ongoing and unmanaged.
- `mitigated` — a recovery action has been applied, but the disruption still remains operationally active until its configured `endsAt`.
- `resolved` — manually closed or otherwise removed from active analysis.

Marauder must support **preview-before-inject**. Menu events and custom events are drafted first, Sentinel shows their projected blast radius on the map and graph, and only then can the draft be injected into the live disruption feed.

### 6.4 Impact Propagation

Sentinel propagates disruption impact deterministically:

```txt
Disruption
  -> affected node/lane/capacity/inventory
  -> shipments using affected entity
  -> recomputed ETAs
  -> commitment risk recomputation
  -> impacted destinations and downstream products
```

Impact output includes:

- Affected entities.
- Cause path (commitment ← shipment ← lane ← disruption).
- ETA before/after.
- Lateness (hours past `mustArriveBy`).
- Tolerance consumed (% of `delayToleranceHours`).
- Priority-weighted risk score.
- Probability of failure (when Monte Carlo is enabled).

### 6.5 Recommendation Engine

Sentinel generates recovery actions from graph state, simulates each by cloning state, applying the candidate, and re-running impact propagation, then ranks by objective.

Recommendation runs operate over the full current scenario state:

- all currently ongoing disruptions in scope, not just one selected event;
- any previously applied recovery actions already mutating the active scenario;
- the current scenario clock (`now`).

**P0 candidate generators (must ship):**

- **Reroute shipment** — alternate lane path.
- **Reallocate inventory** — cover commitment from surplus pool (including pools holding products in the same SubstitutionGroup).
- **Reprioritize capacity** — assign constrained lane/node capacity by priority. Lower-priority commitments are explicitly tracked as harmed.

**P1 candidate generators:**

- **Switch origin** — alternate supplier within same SubstitutionGroup.
- **Expedite** — faster mode if available and constraint-compatible.
- **Split shipment** — partial via faster route.

Every recommendation surfaces:

- What changes.
- Improved commitments (count + IDs).
- Harmed commitments (count + IDs).
- Risk reduction (delta).
- Cost increase.
- Delay reduction.
- Operational complexity (1–5).
- Objective score (composite).

The user interaction model is `recommend -> preview -> apply`. Applying a recommendation updates scenario state and marks the affected incidents as `mitigated`, but they remain active in Sentinel until their configured end time.

### 6.6 Monte Carlo Risk (P1)

Wraps deterministic impact propagation with sampled uncertainty.

Reports per commitment:

- Probability late.
- Probability failed (past tolerance).
- Expected lateness.
- p50 / p90 lateness.
- Expected priority-weighted loss.

Monte Carlo does not replace deterministic propagation; it samples uncertain inputs (disruption duration, transit multiplier, capacity multiplier, demand) and re-runs.

### 6.7 AI Command Layer

Gemini parses natural-language commands, executes whitelisted tools, and produces grounded summaries.

The LLM **must not**:

- Own the ontology.
- Invent graph facts.
- Compute routes, ETAs, or risk scores.
- Generate unsupported recommendations.
- Mutate state without backend validation.

**Entity resolution strategy** (no free-text-to-ID guessing):

1. **Primary**: typeahead picker over names of locations, lanes, commitments. The user selects targets before the LLM call. The LLM receives resolved IDs.
2. **Fallback**: backend fuzzy match (Levenshtein over names + tags). Top-1 score > 0.85 accepted automatically. Top-2 within 0.05 of top-1 returns an ambiguity error and asks the user to disambiguate. Never silently pick.

## 7. Primary User Flows

### Flow 1: Explore the Operating Graph
User clicks any entity. System shows upstream dependencies, downstream dependents, current risk, active disruptions, related commitments.

### Flow 2: Create or Inject a Disruption
An operator uses Sentinel's internal event-authoring controls, or a demo operator uses Marauder to trigger a curated menu event. Sentinel creates the disruption, runs impact propagation, and displays blast radius in both map and graph views.

### Flow 3: Investigate Root Cause
User clicks an at-risk commitment. System shows the upstream cause path:

```txt
Commitment C-104 at risk
  <- Shipment S-88 (ETA slipped 9h)
  <- Lane L-12 closed
  <- Disruption D-3 (Singapore Hub closure)
```

### Flow 4: Generate Recovery Plan
User selects an objective preset. System generates candidate actions, simulates each by cloning state, ranks them, shows side-by-side impact deltas in the plan comparison view.

### Flow 5: Ask Natural-Language Questions
User types a question. AI Command Layer parses intent, executes tools, returns grounded answers citing actual numbers and entity IDs.

## 8. MVP Requirements

Scope is structured as two phases. **Phase 1 is the locked demo target — the team ships it before starting Phase 2.** The demo is viable with only Phase 1.

### Phase 1: Demo Target (locked first deliverable)

- Scenario generator with one seeded deterministic demo network.
- Graph ontology covering all node types in §6.1.
- Graph exploration view (Cytoscape) with per-entity upstream/downstream traversal rules.
- Node closure as the demo's only disruption type.
- Deterministic ETA recalculation for affected shipments (intermediate handling counted once).
- Commitment risk scoring with named penalty curves.
- Reroute candidate generator. A node closure must translate into the closed node and its incident lanes being excluded from routing.
- Plan comparison view: baseline vs reroute, with graph diff.
- Single objective preset (`protect_p0`).
- Deployable on one VPS via Docker Compose.

### Phase 2: Full P0 (additive only after Phase 1 is solid)

- Remaining disruption types (lane closure, add delay, capacity reduction, cost increase, inventory loss, demand spike, reliability drop).
- Reallocate inventory candidate generator (with SubstitutionGroup lookup and replenishment-aware stockout).
- Reprioritize capacity candidate generator (with explicit harm tracking).
- Map view (MapLibre) with map+graph linked selection.
- AI command parsing with grounded explanation.
- Multiple objective presets surfaced in UI.

### P1

- Monte Carlo uncertainty runs.
- Switch origin, expedite, split shipment generators.
- Timeline scrubber across past disruption states.
- Scenario comparison.
- Animated propagation in dual view.
- Graph-based explanation export.

### P2

- Real logistics data import.
- Live weather/news feeds.
- ERP/TMS/WMS integrations.
- Multi-user collaboration.
- Notification workflows.

## 9. Non-Goals

MVP will not:

- Use real enterprise logistics data.
- Depend on Google Maps route planning (visual map, yes; routing, no).
- Send real SMS/email notifications.
- Autonomously execute logistics decisions.
- Claim production-grade supply-chain optimization.
- Simulate the entire world economy.

## 10. Success Criteria

A judge can trigger one disruption and within 60 seconds understand:

- What entity failed.
- What downstream entities are affected.
- Which commitments are at risk and why.
- Which recovery action is best under the chosen objective.
- What tradeoffs that action creates.

The demo must make the graph feel alive: disruption visibly propagates through dependency chains; recovery visibly reduces damage in both the map view and the ontology view.

The demo may use Marauder as the adversarial trigger surface, but Sentinel remains the system of record for displaying active disruptions, impact, and recovery.

## 11. Google Integration Footprint

Required:

- **Gemini via Vertex AI** for the AI command layer (intent parsing, grounded explanation, summary generation). Direct Gemini API used only for local development.

Recommended:

- **Firebase Auth** for hosted demo login (avoids hand-rolling JWT auth).
- **Cloud Run** for the API tier as a deployment target option (architecture is container-native).

The system is intentionally portable — Neo4j, PostgreSQL, Redis, and the Node/TS services run on any container host. Google integration is a deliberate footprint, not a lock-in.
