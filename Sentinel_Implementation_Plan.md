# Sentinel Implementation Plan

## 1. Stack

### Frontend

- React 18 + TypeScript + Vite.
- Two frontend surfaces: **Sentinel** (main operator UI) and **Marauder** (separate adversarial/demo console for curated menu events), both backed by the same API.
- **Cytoscape.js** for the ontology/impact graph.
- **MapLibre GL** (required, not optional) for the geographic view, brushing-linked to the graph.
- TanStack Query for API state.
- Zustand for local UI state.
- Tailwind CSS.

### Backend

- Node.js 20 + TypeScript.
- **Fastify** for HTTP.
- **Zod** for I/O validation.
- **Neo4j JavaScript Driver** (5.x).
- **Drizzle ORM** for PostgreSQL (lighter than Prisma; faster cold starts).
- **BullMQ** + Redis for async jobs (Monte Carlo, parallel candidate evaluation).
- Pino for logs.
- Vitest for tests.

### Data

- Neo4j Community Edition 5.x.
- PostgreSQL 16.
- Redis 7.

### AI

- **Gemini via Vertex AI** behind an `AiCommandService` interface. Falls back to direct Gemini API for local dev. All outputs Zod-validated; no untyped LLM data ever reaches the graph.

### Auth

- **Firebase Auth** for the hosted demo. Local dev uses dev-only JWT.

### Local Dev Networking

- When running inside **WSL**, bind the API and web dev servers to `0.0.0.0`, not `127.0.0.1`.
- Reason: binding to `127.0.0.1` inside WSL can make the service unreachable or flaky from the Windows host browser, even when the process is healthy inside Linux.
- Sentinel dev entrypoints should therefore default to `HOST=0.0.0.0`; the browser can then use `localhost` or the WSL IP depending on the machine setup.

## 2. Repository Structure

```txt
apps/
  web/             # React frontend: Sentinel command center + Marauder console
  api/             # Fastify HTTP API
  worker/          # BullMQ workers (Monte Carlo, recommendation evaluation)
packages/
  ontology/        # Zod schemas, TypeScript types, shared constants
  scenario-generator/
  routing/         # Dijkstra, Yen, in-memory projection
  impact/          # ETA recalculation, risk scoring, propagation
  recommendations/ # Candidate generators + evaluator
  monte-carlo/     # Sampler + aggregation
  ai/              # Vertex AI gateway, intent parser, tool registry
  shared/          # Logging, ID gen, time utils
data/
  scenarios/       # Demo seed configs, golden snapshots
docker/
  compose.yml
```

## 3. Build Order

Eight milestones. Phase 1 ends at M4 (demo viable). M5–M7 add Phase 2 features. Each milestone keeps a runnable demo.

### Phase 1 — locked demo target

#### M1: Ontology and Scenario Generator (week 1–2)

Deliver:
- TypeScript Zod entity schemas (including `:PRODUCES`, `FULFILLS {quantity}`, shipment `originType`, disruption `targetKind`, and recovery-action apply status fields).
- Scenario generator config schema.
- Deterministic seeded generator with product-availability constraints (Suppliers/Factories produce specific products; commitments only generated for reachable origin-product pairs).
- Scenario JSON export.
- Neo4j ingestion script (idempotent) that prefixes all entity IDs with `${scenarioId}:` before persistence.
- Constraints, indexes, and seed-replay test.

Acceptance:
- Same seed → identical graph (hash test).
- Two scenarios generated from different seeds coexist in the same Neo4j without unique-constraint violations (ID-namespacing test).
- Every commitment's required product is produced by ≥1 reachable origin.
- Hero-scenario commitments have ≥2 edge-disjoint paths from origin to destination.
- Sum of `FULFILLS.quantity` for each commitment equals `commitment.quantity` (full allocation).
- For every `(Shipment S)-[:FULFILLS]->(Commitment C)`: `S.destination == C.deliveredTo` and `S.product` shares a SubstitutionGroup with `C.requiresProduct` (or is equal). Generator rejects/regenerates on violation.

#### M2: Graph Explorer (week 3)

Deliver:
- API: `getEntity`, `getEntityContext(id)` returning per-entity-type traversal (no generic depth-walking — see §5.1).
- `getIncidentSubgraph(disruptionId)`.
- Cytoscape view with click-to-explore, expand/collapse.
- Right-side entity inspector showing allocation quantities, predecessor/successor entities by category.

Acceptance:
- Clicking a Commitment surfaces fulfilling shipments (with allocated quantity each), required product, destination, inventory pool at destination.
- Clicking a Lane surfaces shipments using it and commitments they fulfill.
- Clicking a Location surfaces incoming and outgoing lanes, commitments delivered here, inventory pools stored here.

#### M3: Node Closure + Impact Engine (week 4)

Deliver:
- Disruption creation endpoint, **node closure type only** in this milestone.
- Sentinel event-authoring route and separate Marauder demo console route, both posting to the same disruption endpoint.
- Scenario clock endpoint and in-memory active-state tracking so runs happen at stored `now`, not just at `scenarioStart`.
- Affected-entity traversal driven by per-entity rules.
- Deterministic ETA recalculation with corrected handling semantics (intermediate handling counted once — see §5.2).
- Commitment risk scoring with three named penalty curves (§5.3).
- Replenishment-aware inventory stockout time (§5.4).
- ImpactRun persistence (Neo4j + PostgreSQL summary).
- Incident view (focused subgraph).

Acceptance:
- Closing a hub changes ETAs for shipments routed through it.
- Choosing a curated menu event in Marauder creates the same disruption object Sentinel would create through its own authoring controls.
- Applying a recovery action moves affected incidents to `mitigated`, but they remain in the active analysis set until `endsAt`.
- Affected commitments show before/after ETA, lateness hours, tolerance consumed, risk score.
- For inventory-served commitments, stockout ETA reflects scheduled replenishments.
- Root-cause path renders from commitment back to disruption.

#### M4: Routing + Reroute + Plan Comparison (week 5) — **end of Phase 1, demo viable**

Deliver:
- In-memory graph projection from Neo4j.
- Dijkstra + Yen's K-shortest paths (K=3).
- Effective lane weight function with `RoutingWeights` type (§5.6).
- Routing exclusions derived from active disruptions: closed lanes plus all lanes incident to closed locations (§5.6).
- Constraint filtering (cold chain, mode, hazmat).
- Reroute candidate generator producing {ETA, cost, risk} deltas vs baseline.
- Cloned-state evaluator running impact propagation against each candidate.
- Plan comparison view: graph diff with shared layout, node coloring by `(in-baseline-at-risk, in-candidate-at-risk)` membership, edge styling for changed routes.
- Single objective preset (`protect_p0`) wired end-to-end.

Acceptance:
- Hero hub-closure scenario produces ≥1 reroute candidate per affected shipment that has an alternate path.
- When no alternate exists, the generator returns zero candidates with a typed reason.
- Plan comparison renders baseline vs reroute with explicit improved/harmed commitments and the score breakdown.

### Phase 2 — additive once Phase 1 is solid

#### M5: Additional Disruption Types + Inventory Reallocation (week 6)

Deliver:
- Lane closure, add-delay, capacity reduction, cost increase, inventory loss, demand spike, reliability drop disruption types.
- Inventory reallocation candidate generator (with SubstitutionGroup lookup).

Acceptance:
- Each disruption type produces a deterministic ImpactRun and at least one reroute or reallocate candidate where applicable.
- For an at-risk commitment with available substitute inventory, the reallocate candidate covers the commitment with the surplus pool's quantity.

#### M6: Capacity Reprioritization + Map Dual View (week 7)

Deliver:
- Capacity reprioritization generator with sharpened semantics (§5.5): reorders the queue at each affected CapacityPool (or Lane if no pool) by `(priority asc, mustArriveBy asc, quantity desc, commitmentId asc)`. Tracks improved (lateness reduced past tolerance) and harmed (lateness pushed past tolerance).
- MapLibre view of locations and lanes (rendered as arcs).
- Brushing: selection in graph highlights map; selection in map highlights graph.
- Sentinel live feed/refresh path for newly created disruptions, including events injected from Marauder.
- Multi-incident scope selection in Sentinel so impact/recommendation runs can evaluate the full ongoing disruption set or a selected subset.
- Marauder draft-preview flow before injection.

Acceptance:
- Capacity reprio produces deterministic improved/harmed sets.
- Selecting any entity in either view highlights it in the other.
- A disruption injected from Marauder appears in Sentinel's disruption feed and updates the map/graph state without requiring a full scenario reset.
- Combined impact/recommendation runs evaluate multiple ongoing disruptions together.
- Marauder can preview a draft event on the shared map/graph before the disruption is committed.

#### M7: AI Command Layer (week 8)

Deliver:
- Vertex AI Gemini gateway.
- Intent parser (Zod-validated tool calls).
- Entity-resolution typeahead component.
- Tool registry: `createDisruption`, `blastRadius`, `rootCause`, `generateRecommendations`, `compareRecoveryPlans`, `summarizeIncident`.
- Grounded summary renderer.
- Multiple objective presets surfaced in UI.

Acceptance:
- "Close Singapore Hub for 24 hours and protect P0 commitments" parses to a structured tool call, executes the flow, and returns a summary citing actual IDs and numbers.
- Ambiguous entity references trigger a disambiguation prompt; never a silent guess.

#### M8: Polish + Deployment (week 9)

Deliver:
- Animated propagation: when a disruption is added, downstream nodes pulse-color in dependency order.
- Docker Compose with all services.
- Caddy reverse proxy with TLS.
- One-command seed/reset.
- Firebase Auth integration.
- Backup script for Neo4j + Postgres.
- Demo regression script.

Acceptance:
- Full system runs on the 16 GB VPS specified in §7.
- Demo can be reset to baseline in one command.
- Hero scenario plays end-to-end in <3 minutes with no manual repair.

## 4. Neo4j Setup

### Constraints

```cypher
CREATE CONSTRAINT location_id IF NOT EXISTS FOR (n:Location) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT lane_id IF NOT EXISTS FOR (n:Lane) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT product_id IF NOT EXISTS FOR (n:Product) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT subgroup_id IF NOT EXISTS FOR (n:SubstitutionGroup) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT shipment_id IF NOT EXISTS FOR (n:Shipment) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT commitment_id IF NOT EXISTS FOR (n:Commitment) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT inventory_id IF NOT EXISTS FOR (n:InventoryPool) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT capacity_id IF NOT EXISTS FOR (n:CapacityPool) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT disruption_id IF NOT EXISTS FOR (n:Disruption) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT action_id IF NOT EXISTS FOR (n:RecoveryAction) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT impact_run_id IF NOT EXISTS FOR (n:ImpactRun) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT recommendation_run_id IF NOT EXISTS FOR (n:RecommendationRun) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT scenario_id IF NOT EXISTS FOR (n:Scenario) REQUIRE n.id IS UNIQUE;
```

### Indexes

```cypher
CREATE INDEX location_scenario IF NOT EXISTS FOR (n:Location) ON (n.scenarioId);
CREATE INDEX lane_scenario IF NOT EXISTS FOR (n:Lane) ON (n.scenarioId);
CREATE INDEX shipment_scenario IF NOT EXISTS FOR (n:Shipment) ON (n.scenarioId);
CREATE INDEX commitment_scenario IF NOT EXISTS FOR (n:Commitment) ON (n.scenarioId);
CREATE INDEX commitment_priority IF NOT EXISTS FOR (n:Commitment) ON (n.priority);
CREATE INDEX commitment_risk IF NOT EXISTS FOR (n:Commitment) ON (n.currentRisk);
CREATE INDEX disruption_status IF NOT EXISTS FOR (n:Disruption) ON (n.status);
```

## 5. Core Algorithms

### 5.1 Per-Entity Traversal Rules

A generic variable-depth Cypher walk over all relationship types produces meaningless paths and gets the direction wrong (a Commitment's required Product is reached *outgoing* via `REQUIRES`, but it is conceptually upstream of the commitment). Sentinel uses **per-entity-type traversal rules**, not a generic `getUpstream(id, depth)`.

```ts
type RelStep = { rel: string; direction: 'in' | 'out' };

const TRAVERSAL: Record<string, { upstream: RelStep[]; downstream: RelStep[] }> = {
  Commitment: {
    upstream:   [{ rel: 'FULFILLS',     direction: 'in'  },   // shipments
                 { rel: 'REQUIRES',     direction: 'out' }],  // product
    downstream: [{ rel: 'DELIVERS_TO',  direction: 'out' },   // destination
                 { rel: 'IMPROVES',     direction: 'in'  },   // recovery actions
                 { rel: 'HARMS',        direction: 'in'  }],
  },
  Shipment: {
    upstream:   [{ rel: 'ORIGIN',       direction: 'out' },
                 { rel: 'USES_LANE',    direction: 'out' }],  // walked, then -> origin location
    downstream: [{ rel: 'DESTINATION',  direction: 'out' },
                 { rel: 'FULFILLS',     direction: 'out' },
                 { rel: 'CONTAINS',     direction: 'out' }],
  },
  Lane: {
    upstream:   [{ rel: 'LANE_START',   direction: 'in'  }],  // origin location
    downstream: [{ rel: 'LANE_END',     direction: 'out' },   // destination location
                 { rel: 'USES_LANE',    direction: 'in'  },   // shipments using it
                 { rel: 'AFFECTS',      direction: 'in'  }],  // disruptions
  },
  Location: {
    upstream:   [{ rel: 'LANE_END',     direction: 'in'  },   // lanes ending here
                 { rel: 'PRODUCES',     direction: 'out' },   // products produced here
                 { rel: 'STORED_AT',    direction: 'in'  }],  // inventory pools here
    downstream: [{ rel: 'LANE_START',   direction: 'in'  },   // lanes leaving here
                 { rel: 'DELIVERS_TO',  direction: 'in'  },   // commitments delivered here
                 { rel: 'AFFECTS',      direction: 'in'  }],
  },
  InventoryPool: {
    upstream:   [{ rel: 'STORED_AT',    direction: 'out' },
                 { rel: 'OF_PRODUCT',   direction: 'out' }],
    downstream: [{ rel: 'AFFECTS',      direction: 'in'  }],
  },
  Disruption: {
    upstream:   [],
    downstream: [{ rel: 'AFFECTS',             direction: 'out' },
                 { rel: 'AFFECTS_DEMAND_FOR',  direction: 'out' }],
  },
};
```

The API exposes one endpoint that dispatches by node label:

```ts
async function getEntityContext(entityId: string) {
  const labels = await getLabels(entityId);
  const label = primaryLabel(labels);
  const rules = TRAVERSAL[label];
  if (!rules) throw new ValidationError(`No traversal rules for label ${label}`);
  return {
    upstream:   await runRelSteps(entityId, rules.upstream),
    downstream: await runRelSteps(entityId, rules.downstream),
  };
}
```

For blast radius from a Location or Lane, use the curated multi-hop queries in System Design §5.1; do not build them from `runRelSteps`.

### 5.2 ETA Recalculation

Intermediate handling is counted exactly once. The destination of lane `i` *is* the origin of lane `i+1`; charging both would double-count. Capacity queueing uses an event-driven `availableAt` model so resources actually drain after a shipment finishes and lane-entry events are ordered by actual arrival time at each resource.

```ts
const HOUR = 3_600_000; // ms

interface DelayContext {
  graph: GraphProjection;
  disruptions: Disruption[];
  now: number;                              // unix ms; in MVP equals scenarioStart
  resourceState: Map<string, number>;       // resourceId -> availableAt
}

function runImpactPropagation(state: ImpactState, ctx: DelayContext): ImpactRun {
  // Initialize availableAt for every resource to ctx.now.
  ctx.resourceState = new Map();

  // Process lane-entry events in chronological order. Final baseline ETA is not
  // sufficient: a shipment with a later final ETA can still reach an early shared
  // resource before another shipment.
  const queue = new MinHeap<LaneEntryEvent>((a, b) =>
    a.arrivalAt - b.arrivalAt
    || a.resourceId.localeCompare(b.resourceId)
    || a.shipmentId.localeCompare(b.shipmentId)
  );

  for (const s of state.shipments) queue.push(firstLaneEntryEvent(s, ctx));
  while (!queue.isEmpty()) {
    const ev = queue.pop();
    const next = processLaneEntryEvent(ev, state, ctx);
    if (next) queue.push(next);
  }

  // ... commitment ETA + risk recomputation follows (§5.4)
  return persistImpactRun(state, ctx);
}

type LaneEntryEvent = {
  shipmentId: string;
  laneIndex: number;
  laneId: string;
  resourceId: string;
  arrivalAt: number;
};

function recalculateEta(shipment: Shipment, ctx: DelayContext): number {
  let t = Math.max(ctx.now, shipmentReadyAt(shipment, ctx.now));
  const lanes = remainingLanes(shipment).map(id => ctx.graph.lanes.get(id)!);
  if (lanes.length === 0) return t;

  // Origin handling: charged once, at the very start.
  const firstOrigin = ctx.graph.locations.get(lanes[0].originId)!;
  t += handlingDelay(firstOrigin, ctx.disruptions, t);

  for (const lane of lanes) {
    t += closureWait(lane, ctx.disruptions, t);

    // Queue for capacity; t advances by queueDelay only.
    const { queueDelay } = reserveCapacity(lane, ctx, t, shipment);
    if (queueDelay === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
    t += queueDelay;

    // Transit happens in parallel with the resource being held by this shipment.
    t += laneTransitDelay(lane, ctx.disruptions, t);

    // Destination handling — also acts as next-hop's origin (no double charge).
    const dest = ctx.graph.locations.get(lane.destinationId)!;
    t += handlingDelay(dest, ctx.disruptions, t);
  }
  return t;
}

function remainingLanes(s: Shipment): string[] {
  return s.laneSequence.slice(s.currentLaneIndex);
}
```

**Delay function semantics** (all return milliseconds unless noted):

```ts
function handlingDelay(loc: Location, disruptions: Disruption[], t: number): number {
  const base = loc.handlingTimeHours * HOUR;
  const closure = activeClosure(loc, disruptions, t);
  if (closure) return base + Math.max(0, closure.endsAt - t);
  return base + sumActiveAddDelays(loc, disruptions, t);
}

function closureWait(lane: Lane, disruptions: Disruption[], t: number): number {
  const closure = activeClosure(lane, disruptions, t);
  return closure ? Math.max(0, closure.endsAt - t) : 0;
}

function laneTransitDelay(lane: Lane, disruptions: Disruption[], t: number): number {
  return lane.transitHours * HOUR + sumActiveAddDelays(lane, disruptions, t);
}

// Reserves the lane (or its CapacityPool) for this shipment. Mutates ctx.resourceState.
// Returns the queue delay this shipment incurs and the time the resource becomes free.
function reserveCapacity(
  lane: Lane,
  ctx: DelayContext,
  arrivalAt: number,
  shipment: Shipment,
): { queueDelay: number; serviceEnd: number } {
  const resourceId = capacityResourceFor(lane);   // CapacityPool.id or `lane:${lane.id}`
  const effectiveCap =
    effectiveCapacityUnitsPerHour(lane, ctx.disruptions, arrivalAt);
  if (effectiveCap <= 0) {
    return { queueDelay: Number.POSITIVE_INFINITY, serviceEnd: Number.POSITIVE_INFINITY };
  }
  const availableAt = ctx.resourceState.get(resourceId) ?? ctx.now;
  const serviceStart = Math.max(arrivalAt, availableAt);
  const serviceDuration = (shipment.quantity / effectiveCap) * HOUR;
  const serviceEnd = serviceStart + serviceDuration;
  ctx.resourceState.set(resourceId, serviceEnd);
  return { queueDelay: serviceStart - arrivalAt, serviceEnd };
}
```

`recalculateEta` is still useful for a single isolated shipment simulation. A full impact run uses the lane-entry event queue above so shared CapacityPool/Lane resources are reserved in actual arrival order.

**Why available-at instead of unitsAhead**: the naive `unitsAhead = sum(units arriving since scenarioStart)` model never drains. With capacity 100 u/h and five 50-u shipments arriving at hourly intervals, shipment 5 sees `unitsAhead=200` and gets a 2 h delay even though the lane has been idle since t+3.5h. The available-at model assigns shipment 5 a 0 h delay, which is correct.

**Closure semantics**: while a closure is active, in-progress traversals complete (a shipment already on the lane is not teleported back); upcoming traversals wait at the upstream node until `endsAt`.

### 5.3 Penalty Curves

```ts
type PenaltyCurveType = 'cliff' | 'ramp' | 'exponential';

function applyPenaltyCurve(curve: PenaltyCurveType, ratio: number): number {
  const r = Math.max(0, Math.min(1, ratio));
  switch (curve) {
    case 'cliff':
      return r === 0 ? 0 : 1;
    case 'ramp':
      return r;
    case 'exponential': {
      const k = 3;
      return (Math.exp(k * r) - 1) / (Math.exp(k) - 1);
    }
  }
}
```

### 5.4 Commitment Risk

A commitment can be fulfilled by multiple shipments via partial allocations (`FULFILLS.quantity`). The commitment's effective ETA is the **completion ETA** — the moment cumulative `FULFILLS.quantity` first reaches `commitment.quantity` when fulfilling shipments are sorted by their own ETA ascending.

```ts
type Allocation = { shipmentEta: number; allocatedQuantity: number };

function commitmentCompletionEta(commitment: Commitment, allocs: Allocation[]): number {
  const sorted = [...allocs].sort((a, b) => a.shipmentEta - b.shipmentEta);
  let cumulative = 0;
  for (const a of sorted) {
    cumulative += a.allocatedQuantity;
    if (cumulative >= commitment.quantity) return a.shipmentEta;
  }
  return Number.POSITIVE_INFINITY; // unreachable when full-allocation invariant holds
}

const PRIORITY_WEIGHTS = { P0: 1.0, P1: 0.7, P2: 0.4, P3: 0.15 } as const;

function calculateCommitmentRisk(
  commitment: Commitment,
  completionEta: number,
  scenario: ScenarioStats
): number {
  const lateness = Math.max(0, hoursBetween(completionEta, commitment.mustArriveBy));
  const tolerance = Math.max(1, commitment.delayToleranceHours);
  const ratio = lateness / tolerance;

  const priority = PRIORITY_WEIGHTS[commitment.priority];
  const quantity = quantityWeight(commitment.quantity, scenario.maxQuantity);
  const penalty = applyPenaltyCurve(commitment.penaltyCurve, ratio);

  return penalty * priority * quantity;
}

function quantityWeight(qty: number, maxQty: number): number {
  const numer = 1 + Math.log10(Math.max(1, qty));
  const denom = 1 + Math.log10(Math.max(1, maxQty));
  return Math.max(0.1, Math.min(1.0, numer / denom));
}
```

The risk pass over the impact run:

```ts
for (const c of state.commitments) {
  const allocs = fulfillingShipments(c).map(s => ({
    shipmentEta: s.currentEta,
    allocatedQuantity: fulfillsQuantity(s, c),
  }));
  const completionEta = commitmentCompletionEta(c, allocs);
  c.currentRisk = finalCommitmentRisk(c, completionEta, ...);
}
```

For commitments served by an InventoryPool, stockout time accounts for **scheduled replenishments** (incoming shipments that target the pool), not just `quantityOnHand - safetyStock`:

```ts
type Replenishment = { eta: number; quantity: number };

function finalCommitmentRisk(
  commitment: Commitment,
  completionEta: number,              // from commitmentCompletionEta()
  pool: InventoryPool | null,
  inbound: Replenishment[],           // shipments delivering to this pool, sorted ascending
  scenario: ScenarioStats,
  scenarioStart: number
): number {
  const baseRisk = calculateCommitmentRisk(commitment, completionEta, scenario);
  if (!pool) return baseRisk;

  const stockoutAt = computeStockoutTime(pool, scenarioStart, inbound);
  if (stockoutAt === Number.POSITIVE_INFINITY) return baseRisk;

  const stockoutRatio = Math.max(0, Math.min(1,
    (completionEta - stockoutAt) / (commitment.delayToleranceHours * HOUR)
  ));
  const stockoutRisk = stockoutRatio * PRIORITY_WEIGHTS[commitment.priority];

  return Math.max(baseRisk, stockoutRisk);
}

function computeStockoutTime(
  pool: InventoryPool,
  scenarioStart: number,
  inbound: Replenishment[]
): number {
  // Walk forward; between events deplete at demandUnitsPerHour.
  // Return the first instant the level drops below safetyStock.
  let level = pool.quantityOnHand;
  let t = scenarioStart;

  for (const ev of inbound) {
    const elapsedH = (ev.eta - t) / HOUR;
    const consumed = pool.demandUnitsPerHour * elapsedH;
    const projectedAtEvent = level - consumed;

    if (projectedAtEvent < pool.safetyStock) {
      const consumedToStockout = level - pool.safetyStock;
      const hoursToStockout = consumedToStockout / pool.demandUnitsPerHour;
      return t + hoursToStockout * HOUR;
    }
    level = projectedAtEvent + ev.quantity;
    t = ev.eta;
  }

  if (level < pool.safetyStock) return t;
  if (pool.demandUnitsPerHour === 0) return Number.POSITIVE_INFINITY;
  const hoursToStockout = (level - pool.safetyStock) / pool.demandUnitsPerHour;
  return t + hoursToStockout * HOUR;
}
```

### 5.5 Recommendation Evaluation

```ts
type RecommendationWeights = {
  risk: number; saved: number; resilience: number; cost: number; complexity: number;
};

interface CandidateEvaluation {
  candidate: RecoveryAction;
  riskReduction: number;
  commitmentsSaved: string[];   // IDs that moved from at-risk to safe
  commitmentsHarmed: string[];  // IDs that moved from safe to at-risk
  addedCost: number;
  etaImprovementHours: number;
  complexity: number;           // 1..5
}

function evaluateCandidate(
  candidate: RecoveryAction,
  baseline: ImpactState
): CandidateEvaluation {
  const cloned = cloneState(baseline);
  applyCandidate(cloned, candidate);
  const next = runImpactPropagation(cloned);

  return {
    candidate,
    riskReduction: baseline.totalRisk - next.totalRisk,
    commitmentsSaved: diffCommitments(baseline, next, 'saved'),
    commitmentsHarmed: diffCommitments(baseline, next, 'harmed'),
    addedCost: next.totalCost - baseline.totalCost,
    etaImprovementHours: avgEtaImprovementHours(baseline, next),
    complexity: candidateComplexity(candidate),
  };
}

interface NormBasis { risk: number; saved: number; cost: number; resilience: number; }

function score(
  e: CandidateEvaluation,
  weights: RecommendationWeights,
  norms: NormBasis,
  mcReduction = 0
): number {
  return weights.risk * (e.riskReduction / norms.risk)
       + weights.saved * (e.commitmentsSaved.length / norms.saved)
       + weights.resilience * (mcReduction / norms.resilience)
       - weights.cost * (e.addedCost / norms.cost)
       - weights.complexity * (e.complexity / 5);
}
```

**Normalization basis**: computed once per recommendation run. Each `norms.X = max(|X_i|)` over candidates, floored at 1.

### Capacity Reprioritization (sharpened)

The reprioritize-capacity generator operates **per CapacityPool** when a pool exists, otherwise per Lane.

```ts
function reprioritizeQueue(
  pool: CapacityPool | { laneId: string },
  queue: QueueEntry[],
  baseline: ImpactState,
  scenario: ScenarioStats
): RecoveryAction {
  const sorted = [...queue].sort((a, b) => {
    const pa = priorityRank(a.commitment.priority);  // P0=0, P1=1, ...
    const pb = priorityRank(b.commitment.priority);
    if (pa !== pb) return pa - pb;
    if (a.commitment.mustArriveBy !== b.commitment.mustArriveBy)
      return a.commitment.mustArriveBy - b.commitment.mustArriveBy;
    if (a.commitment.quantity !== b.commitment.quantity)
      return b.commitment.quantity - a.commitment.quantity;  // larger first
    return a.commitment.id.localeCompare(b.commitment.id);    // deterministic
  });
  return buildRecoveryAction(pool, sorted);
}
```

`commitmentsImproved` = commitments whose new lateness ≤ tolerance and old lateness > tolerance.
`commitmentsHarmed` = commitments whose new lateness > tolerance and old lateness ≤ tolerance.

### 5.6 Effective Lane Weight (Routing)

`RoutingWeights` is distinct from `RecommendationWeights`.

```ts
type RoutingWeights = { time: number; cost: number; risk: number; };

type RoutingExclusions = {
  laneIds: Set<string>;       // lanes explicitly closed by a disruption
  locationIds: Set<string>;   // locations closed; any lane incident to one is excluded
};

function computeExclusionsFromDisruptions(disruptions: Disruption[]): RoutingExclusions {
  const laneIds = new Set<string>();
  const locationIds = new Set<string>();
  for (const d of disruptions) {
    if (d.status !== 'active') continue;
    if (!d.effects.some(e => e.kind === 'closure')) continue;
    if (d.targetKind === 'Lane') laneIds.add(d.targetId);
    else if (d.targetKind === 'Location') locationIds.add(d.targetId);
  }
  return { laneIds, locationIds };
}

function isLaneExcluded(lane: Lane, excl: RoutingExclusions): boolean {
  return excl.laneIds.has(lane.id)
      || excl.locationIds.has(lane.originId)
      || excl.locationIds.has(lane.destinationId);
}

function laneWeight(
  lane: Lane,
  shipment: Shipment,
  ctx: DelayContext,
  excl: RoutingExclusions,
  obj: RoutingWeights,
  norms: ScenarioStats
): number {
  if (!isCompatible(lane, shipment)) return Number.POSITIVE_INFINITY;
  if (isLaneExcluded(lane, excl)) return Number.POSITIVE_INFINITY;

  const time = lane.transitHours * HOUR
             + closureWait(lane, ctx.disruptions, ctx.now)
             + sumActiveAddDelays(lane, ctx.disruptions, ctx.now);
  const cost = lane.costPerUnit * shipment.quantity
             * costMultiplier(lane, ctx.disruptions, ctx.now);
  const risk = -Math.log(Math.max(0.001, lane.reliability))
             + disruptionRiskPenalty(lane, ctx.disruptions, ctx.now);

  return obj.time * (time / norms.maxLaneTime)
       + obj.cost * (cost / norms.maxLaneCost)
       + obj.risk * (risk / norms.maxLaneRisk);
}
```

`isCompatible` enforces cold-chain support, hazmat support, and mode constraints. The reroute generator passes the exclusion set computed from active disruptions, so a node closure correctly removes the closed Location and all incident lanes from candidate paths.

## 6. Demo Scenario

Generic critical-goods network. Avoid hardcoded medical or military framing — keep it neutral so judges can project their own domain.

| Tier         | Count |
|--------------|-------|
| Suppliers    | 4     |
| Factories    | 3     |
| Hubs/Ports   | 5     |
| Warehouses   | 4     |
| Destinations | 12    |

- 4 product/load classes; 2 of them belong to the same SubstitutionGroup.
- 80 shipments fulfilling 120 commitments (many-to-many: each shipment fulfills 1–3 commitments by quantity match).
- Priority distribution: 15% P0, 30% P1, 35% P2, 20% P3.
- Penalty curves by priority: P0 → cliff, P1 → exponential, P2 → ramp, P3 → ramp.

**Hero disruption**: close Singapore Hub for 24 hours, objective: `protect_p0`.

Expected demo state at trigger:
- Hub turns red on map and graph.
- 18–25 shipments highlight as affected.
- 6–10 commitments enter at-risk; 2–3 of them P0.
- Root-cause path renders for each at-risk commitment.
- Recommendations panel shows ranked: reroute / reallocate inventory / reprioritize capacity.
- Applying the best recommendation drops the P0 at-risk count to ≤1.

## 7. VPS

Pin one target. Do not over-provision.

```txt
CPU:     4 vCPU
RAM:     16 GB
Storage: 100 GB SSD
OS:      Ubuntu 24.04 LTS
Swap:    8 GB
```

Comfortably hosts Neo4j, Postgres, Redis, API, worker, web behind Caddy. Supports interactive Monte Carlo at N=200 and a demo audience of ~30 concurrent users.

## 8. Docker Compose

```txt
caddy
web
api
worker
neo4j
postgres
redis
```

Public ports: 22 SSH, 80 HTTP, 443 HTTPS.
Private (do not expose): 3000 web, 8080 api, 7474/7687 neo4j, 5432 postgres, 6379 redis.

## 9. Environment Variables

```txt
NODE_ENV=production
APP_URL=https://sentinel.example.com
DATABASE_URL=postgres://...
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=...
REDIS_URL=redis://redis:6379
GEMINI_PROVIDER=vertex|direct
GOOGLE_APPLICATION_CREDENTIALS=/secrets/sa.json
GEMINI_API_KEY=...                 # used only when GEMINI_PROVIDER=direct
FIREBASE_PROJECT_ID=...
FIREBASE_AUTH_API_KEY=...
JWT_SECRET=...                     # local dev only
LOG_LEVEL=info
```

## 10. Testing

### Unit
- Scenario connectivity (every destination reachable; hero commitments have ≥2 disjoint paths).
- Neo4j ingestion idempotency.
- Upstream/downstream traversal shape.
- Dijkstra/Yen pathfinding.
- ETA recalculation per delay function (handling, closure, transit, queue).
- Capacity queue event ordering where a later final-ETA shipment reaches a shared resource earlier.
- Each penalty curve at boundaries (r=0, r=1, mid).
- Quantity weight normalization.
- Each candidate generator's output schema.
- Candidate evaluator state cloning (no mutation leak into baseline).
- Monte Carlo seed reproducibility.
- LLM tool-call schema validation.
- Entity resolution (top-1, ambiguous top-2, no match).

### Scenario tests

```txt
Given the base demo scenario (seed = 42)
When Singapore Hub closes for 24h
Then affectedShipments ∈ [18, 25]
And affectedCommitments ∈ [6, 10]
And p0AtRisk ≥ 2
And recommendationRun.candidates.length ≥ 3
And bestCandidateBy('protect_p0').commitmentsSaved (P0|P1) ≥ 1
```

### Demo regression (CI step)
- Reset scenario.
- Trigger hero disruption.
- Assert blast-radius shape.
- Assert root-cause path exists for each at-risk commitment.
- Assert recommendation ranks change between `protect_p0` and `min_cost`.
- Apply best recommendation under `protect_p0`.
- Assert P0 risk metrics improve as expected.

## 11. Demo Script

3-minute target. Practiced exact wording.

| Time | Action | Beat |
|------|--------|------|
| 0:00 | Open scenario at baseline | "This is a working supply chain — 80 shipments fulfilling 120 commitments across 28 nodes." |
| 0:15 | Click a P0 commitment | "Sentinel models commitments as the unit of risk. This one delivers 4000 units to Mumbai by Friday." |
| 0:30 | Trigger Singapore Hub closure | "Now suppose the hub goes down for 24 hours." |
| 0:40 | Show propagation animation | "Sentinel traces dependencies: 22 shipments affected, 8 commitments at risk, 3 of them P0." |
| 1:00 | Click an at-risk P0 commitment | "And it shows the cause path — exactly which shipment, which lane, which disruption." |
| 1:20 | Open recommendations panel | "Three options: reroute, reallocate inventory, reprioritize capacity." |
| 1:35 | Compare under `protect_p0` | "Reroute saves 2 of 3 P0s but adds $14K cost. Reprioritize saves all 3 but harms 4 P3s." |
| 2:00 | Switch objective to `min_cost` | "Switch the objective — ranking changes. Reroute now wins." |
| 2:15 | Apply reprioritize | "Apply the protect-P0 plan. P0 risk drops; the chain heals visibly." |
| 2:30 | NL command | "Or just ask: 'why is Dallas at risk now?' — grounded answer with citations." |
| 2:55 | Close | — |
