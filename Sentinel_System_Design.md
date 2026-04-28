# Sentinel System Design

## 1. System Model

```txt
Scenario Generator
  -> Operational Knowledge Graph (Neo4j)
  -> Routing Engine (in-memory projection)
  -> Disruption Engine
  -> Impact Propagation Engine
  -> Recommendation Engine
  -> Monte Carlo Engine (P1)
  -> AI Command Layer
```

The frontend visualizes graph state and decisions; it never computes routes, risk, or recommendations.

## 2. Architectural Bet

Sentinel is graph-first.

- **Neo4j** stores the operational graph and ontology.
- **PostgreSQL** stores transactional metadata: users, scenario versions, job metadata, run summaries, audit logs.
- **Redis + BullMQ** runs async jobs (Monte Carlo, parallel candidate evaluation when serial scoring is too slow).
- **In-memory graph projection** runs constrained route planning and impact propagation. Weights depend on time windows, disruption effects, capacity, and objectives — beyond what Cypher should compute.

Why the split:
- Neo4j fits dependency traversal, blast-radius, root-cause, and ontology exploration.
- PostgreSQL fits relational metadata, auditability, auth, and bookkeeping.
- The routing engine is application code; Neo4j projects the lane subgraph into memory once per run.

Neo4j is not decoration. It is the source of operational truth. The projection is a derived view.

## 3. High-Level Architecture

```txt
Browser (Sentinel) ----\
                        \
Browser (Marauder) -----> Fastify API
                        /
Internal admin flows ---/
  |
  +--> Graph/Ontology Service ----> Neo4j
  +--> Scenario Service ----------> Neo4j + PostgreSQL
  +--> Routing Service -----------> In-memory projection
  +--> Disruption Service --------> Neo4j
  +--> Impact Service ------------> Neo4j + PostgreSQL summaries
  +--> Recommendation Service ----> Neo4j + Redis (job submission)
  +--> Monte Carlo Service -------> Redis jobs + PostgreSQL summaries
  +--> AI Command Service --------> Vertex AI (Gemini) + Tool Registry

BullMQ Worker
  +--> Monte Carlo runner
  +--> Recommendation evaluator (parallel candidate scoring)
```

`Marauder` is a separate adversarial/demo dashboard, not a separate ingestion service. Both Sentinel and Marauder call the same Sentinel backend. Sentinel owns the shared disruption/event API; Marauder simply submits curated menu events through it.

## 4. Operational Ontology

### 4.0 Relationship Catalog

```txt
(Location)-[:LANE_START]->(Lane)
(Lane)-[:LANE_END]->(Location)
(Location)-[:PRODUCES]->(Product)              // suppliers and factories only
(Shipment)-[:USES_LANE {sequence:int}]->(Lane)
(Shipment)-[:ORIGIN]->(Location)
(Shipment)-[:DESTINATION]->(Location)
(Shipment)-[:CONTAINS]->(Product)
(Shipment)-[:FULFILLS {quantity:number}]->(Commitment)   // many-to-many with explicit allocation
(Commitment)-[:REQUIRES]->(Product)
(Commitment)-[:DELIVERS_TO]->(Location)
(Product)-[:MEMBER_OF]->(SubstitutionGroup)
(InventoryPool)-[:STORED_AT]->(Location)
(InventoryPool)-[:OF_PRODUCT]->(Product)
(CapacityPool)-[:CONSTRAINS]->(Location)
(CapacityPool)-[:CONSTRAINS]->(Lane)
(Disruption)-[:AFFECTS]->(Location)
(Disruption)-[:AFFECTS]->(Lane)
(Disruption)-[:AFFECTS]->(InventoryPool)
(Disruption)-[:AFFECTS_DEMAND_FOR]->(Product)
(Disruption)-[:AFFECTS_DEMAND_AT]->(Location)
(RecoveryAction)-[:MODIFIES]->(Shipment)
(RecoveryAction)-[:MODIFIES]->(Lane)
(RecoveryAction)-[:MODIFIES]->(InventoryPool)
(RecoveryAction)-[:IMPROVES]->(Commitment)
(RecoveryAction)-[:HARMS]->(Commitment)
(ImpactRun)-[:OBSERVED]->(Shipment|Commitment)
(RecommendationRun)-[:PRODUCED]->(RecoveryAction)
(Scenario)-[:CONTAINS]->(*)
```

`FULFILLS.quantity` is the allocation: how many units of `shipment.quantity` are reserved to satisfy `commitment.quantity`.

`PRODUCES` constrains which origins can supply which products. Suppliers and Factories produce a subset of products; commitments can only be served by shipments originating from a `PRODUCES`-bearing location for the required product (or a substitute via SubstitutionGroup).

**FULFILLS invariants** (must hold for every `(Shipment S)-[:FULFILLS {quantity}]->(Commitment C)` after generation and after every apply):

1. **Same destination**: `S.destination == C.deliveredTo`.
2. **Compatible product**: `S.product` is in the same `SubstitutionGroup` as `C.requiresProduct`, or equal to it.
3. **Full allocation per commitment**: `sum(FULFILLS.quantity) over shipments fulfilling C == C.quantity`.
4. **No over-commit per shipment**: `sum(FULFILLS.quantity) over commitments served by S ≤ S.quantity`.

**ID namespacing**: All generated entity IDs are prefixed with `scenarioId` — e.g. `s42:loc-001`, `s42:lane-007`, `s42:ship-042`. Neo4j Community Edition cannot enforce composite uniqueness (`NODE KEY` requires Enterprise Edition), so global uniqueness via namespacing is the only path that lets multiple scenarios coexist in the same database. The per-label `scenarioId` indexes still support per-scenario filtering. The generator emits stable per-scenario suffixes; the namespace prefix is applied during ingestion.

### 4.1 Node Types

`Location, Lane, Product, SubstitutionGroup, Shipment, Commitment, InventoryPool, CapacityPool, Disruption, RecoveryAction, ImpactRun, RecommendationRun, Scenario`

### 4.2 Location

Represents a supplier, factory, port, hub, warehouse, store, hospital, customer, or abstract destination.

```ts
{
  id: string;
  scenarioId: string;
  kind: 'supplier'|'factory'|'hub'|'port'|'warehouse'|'destination';
  name: string;
  x: number;                      // synthetic coords; visual + heuristic distance only
  y: number;
  handlingTimeHours: number;
  capacityUnitsPerHour: number;
  status: 'open'|'closed';
  tags: string[];
}
```

### 4.3 Lane

Lane is a node, not just a relationship, because it has identity, capacity, disruption state, shipments, costs, and risk.

```ts
{
  id: string;
  scenarioId: string;
  mode: 'truck'|'rail'|'ocean'|'air';
  transitHours: number;
  capacityUnitsPerHour: number;
  costPerUnit: number;
  reliability: number;            // [0,1]
  supportsColdChain: boolean;
  supportsHazmat: boolean;
  status: 'open'|'closed';
}
```

Topology:

```txt
(origin:Location)-[:LANE_START]->(lane:Lane)-[:LANE_END]->(destination:Location)
```

Note: every blast-radius traversal that begins at a Location and reaches a Lane is two hops. Use `WITH` clauses or named subqueries to keep Cypher readable.

### 4.4 Product

```ts
{
  id: string;
  scenarioId: string;
  name: string;
  requiresColdChain: boolean;
  requiresHazmat: boolean;
  shelfLifeHours: number | null;
}
```

### 4.5 SubstitutionGroup

A product belongs to zero or one SubstitutionGroup. Two products in the same group are interchangeable for fulfillment purposes (equivalent SKU, equivalent dose).

```ts
{
  id: string;
  scenarioId: string;
  name: string;
  notes: string;
}
```

Relationship: `(Product)-[:MEMBER_OF]->(SubstitutionGroup)`.

The Switch-Origin and Reallocate-Inventory generators query the substitution graph to find acceptable alternates.

### 4.6 Commitment

The core business object.

```ts
{
  id: string;
  scenarioId: string;
  quantity: number;
  priority: 'P0'|'P1'|'P2'|'P3';
  mustArriveBy: number;           // unix ms
  delayToleranceHours: number;
  penaltyCurve: 'cliff'|'ramp'|'exponential';
  status: 'open'|'fulfilled'|'failed';
  baselineRisk: number;
  currentRisk: number;
}
```

**Penalty curves** define how risk grows with lateness. With `r = clamp(lateness/tolerance, 0, 1)`:

- **cliff**: `f(r) = 0 if r==0 else 1`. Hard contractual deadlines (legal, court orders).
- **ramp**: `f(r) = r`. Linear SLA degradation.
- **exponential**: `f(r) = (e^(3r) - 1) / (e^3 - 1)`. Convex, accelerating; perishables and compounding business loss.

Relationships: `(commitment)-[:REQUIRES]->(product)`, `(commitment)-[:DELIVERS_TO]->(location)`, `(shipment)-[:FULFILLS {quantity}]->(commitment)`. The relationship's `quantity` is the explicit allocation; one shipment can serve multiple commitments and must satisfy the full-allocation invariant in §4.0.

### 4.7 Shipment

```ts
{
  id: string;
  scenarioId: string;
  quantity: number;
  originType: 'location'|'inventory_pool';
  status: 'pending'|'in_transit'|'delivered'|'failed'|'cancelled';
  baselineEta: number;
  currentEta: number;
  currentLaneIndex: number;       // 0-based; MVP starts all at 0
  progressFraction: number;       // [0,1] within current lane; MVP starts all at 0
}
```

Relationships:

```txt
(shipment)-[:CONTAINS]->(product)
(shipment)-[:ORIGIN]->(location)
(shipment)-[:DESTINATION]->(location)
(shipment)-[:USES_LANE {sequence}]->(lane)
(shipment)-[:FULFILLS {quantity}]->(commitment)
```

`USES_LANE.sequence` is read with `ORDER BY r.sequence` to produce the ordered lane path. `FULFILLS.quantity` is the explicit allocation; the full-allocation invariant in §4.0 must hold (sum of `FULFILLS.quantity` per commitment equals `commitment.quantity`; sum per shipment is ≤ `shipment.quantity`).

### 4.8 InventoryPool

```ts
{
  id: string;
  scenarioId: string;
  quantityOnHand: number;
  safetyStock: number;
  demandUnitsPerHour: number;
}
```

**Dynamics** are deterministic and computed at impact time; there is no live tick loop.

```txt
At time t (with scenarioStart as t0):
  consumed = demandUnitsPerHour * hoursBetween(t0, t)
           - sumOfReplenishmentsBefore(t)
  current = max(0, quantityOnHand - consumed)
  hoursUntilStockout = max(0, current - safetyStock) / demandUnitsPerHour
  stockoutAt = t + hoursUntilStockout
```

A shipment delivering Q units to the pool's location replenishes the pool by Q at the shipment's ETA. Stockout risk for a commitment served by this pool:

```txt
stockoutRisk = clamp((eta - stockoutAt) / delayToleranceHours, 0, 1)
             * priorityWeight
finalRisk = max(commitmentRisk, stockoutRisk)
```

Relationships: `(InventoryPool)-[:STORED_AT]->(Location)`, `(InventoryPool)-[:OF_PRODUCT]->(Product)`.

### 4.9 CapacityPool

Models shared throughput constraints (e.g., a port's berth capacity shared across multiple lanes).

```ts
{
  id: string;
  scenarioId: string;
  unitsPerHour: number;
  scope: 'location'|'lane';
}
```

Relationship: `(CapacityPool)-[:CONSTRAINS]->(Location|Lane)`. When multiple lanes share a CapacityPool, queueing is computed at the pool level, not per lane.

### 4.10 Disruption

```ts
{
  id: string;
  scenarioId: string;
  type: 'node_closure'|'lane_closure'|'add_delay'|'capacity_reduction'
       |'cost_increase'|'inventory_loss'|'demand_spike'|'reliability_drop';
  targetKind: 'Location'|'Lane'|'InventoryPool'|'Product'|'ProductAtLocation';
  targetId: string;               // ID of the primary target; for ProductAtLocation use `${productId}@${locationId}`
  targetProductId?: string;        // required for ProductAtLocation
  targetLocationId?: string;       // required for ProductAtLocation
  startsAt: number;               // unix ms
  endsAt: number;
  severity: number;               // [0,1]
  effects: DisruptionEffect[];
  uncertainty?: UncertaintyDistribution;
  status: 'active'|'mitigated'|'resolved';
}

type DisruptionEffect =
  | { kind: 'closure' }
  | { kind: 'add_delay'; hours: number }
  | { kind: 'capacity_multiplier'; multiplier: number }
  | { kind: 'cost_multiplier'; multiplier: number }
  | { kind: 'demand_multiplier'; multiplier: number }
  | { kind: 'inventory_loss'; mode: 'absolute'|'fraction'; amount: number }
  | { kind: 'reliability_multiplier'; multiplier: number };
```

`inventory_loss.mode` disambiguates units (`absolute`) versus proportion (`fraction` ∈ [0,1]).

Lifecycle semantics:

- `active`: disruption is ongoing and untreated.
- `mitigated`: an action has been applied, but the disruption still stays in the active incident set until `endsAt`.
- `resolved`: explicit closure; future impact/recommendation runs ignore it immediately.

**Closure semantics**: while a closure is active, in-progress traversals complete; upcoming traversals wait at the upstream node until `endsAt`.

Relationships: `(Disruption)-[:AFFECTS]->(Location|Lane|InventoryPool)`, `(Disruption)-[:AFFECTS_DEMAND_FOR]->(Product)`.

For `demand_spike`, use `targetKind='ProductAtLocation'` and create both
`(Disruption)-[:AFFECTS_DEMAND_FOR]->(Product)` and
`(Disruption)-[:AFFECTS_DEMAND_AT]->(Location)`. The effect applies only to
inventory pools at that location whose product equals the target product or is
in the same SubstitutionGroup. A product-only demand spike is P2 and should be
modeled as separate product-at-location disruptions for MVP/P1 behavior.

### 4.11 ImpactRun

```ts
{
  id: string;
  scenarioId: string;
  triggeredBy: string;            // disruption id, or 'baseline'
  computedAt: number;
  totalRisk: number;
  totalLatenessHours: number;
  affectedShipments: number;
  affectedCommitments: number;
}
```

Relationships: `(:ImpactRun)-[:OBSERVED {etaBefore, etaAfter, riskBefore, riskAfter}]->(:Shipment|:Commitment)`.

### 4.12 RecommendationRun

```ts
{
  id: string;
  scenarioId: string;
  triggeredByDisruption: string;
  objective: 'protect_p0'|'min_total_risk'|'min_cost'|'max_resilience'|'balanced';
  computedAt: number;
  candidateCount: number;
}
```

Relationships: `(:RecommendationRun)-[:PRODUCED]->(:RecoveryAction)`.

### 4.13 RecoveryAction

```ts
{
  id: string;
  scenarioId: string;
  type: 'reroute'|'reallocate_inventory'|'reprioritize_capacity'
      |'switch_origin'|'expedite'|'split_shipment';
  status: 'proposed'|'applied'|'rejected';
  summary: string;
  score: number;
  riskReduction: number;
  addedCost: number;
  etaImprovementHours: number;
  complexity: number;             // [1,5]
  createdAt: number;
  appliedAt: number | null;
  payload: object;                // type-specific applyCandidate input
}
```

Relationships: `(:RecoveryAction)-[:MODIFIES]->(:Shipment|:Lane|:InventoryPool)`, `[:IMPROVES]->(:Commitment)`, `[:HARMS]->(:Commitment)`.

### 4.14 Scenario

```ts
{
  id: string;
  seed: string;
  name: string;
  scenarioStart: number;          // unix ms; t0 for ETAs and inventory dynamics
  createdAt: number;
  version: number;
  generatorConfigHash: string;
}
```

## 5. Required Graph Queries

### 5.1 Downstream Blast Radius

Lane disruption:

```cypher
MATCH (d:Disruption {id: $disruptionId})-[:AFFECTS]->(lane:Lane)
MATCH (lane)<-[:USES_LANE]-(s:Shipment)-[:FULFILLS]->(c:Commitment)
MATCH (c)-[:DELIVERS_TO]->(dest:Location)
RETURN d, lane, s, c, dest
```

Location disruption (one query, no UNION):

```cypher
MATCH (d:Disruption {id: $disruptionId})-[:AFFECTS]->(loc:Location)
MATCH (loc)-[:LANE_START|LANE_END]-(lane:Lane)
MATCH (lane)<-[:USES_LANE]-(s:Shipment)-[:FULFILLS]->(c:Commitment)
MATCH (c)-[:DELIVERS_TO]->(dest:Location)
RETURN d, loc, lane, s, c, dest
```

### 5.2 Upstream Root Cause

```cypher
MATCH (c:Commitment {id: $commitmentId})<-[:FULFILLS]-(s:Shipment)
MATCH (s)-[:USES_LANE]->(lane:Lane)
OPTIONAL MATCH (d1:Disruption)-[:AFFECTS]->(lane)
WHERE d1.status <> 'resolved'
OPTIONAL MATCH (lane)-[:LANE_START|LANE_END]-(loc:Location)<-[:AFFECTS]-(d2:Disruption)
WHERE d2.status <> 'resolved'
RETURN c, s, lane, d1, loc, d2
```

### 5.3 Substitution Lookup

```cypher
MATCH (c:Commitment {id: $commitmentId})-[:REQUIRES]->(p:Product)
MATCH (p)-[:MEMBER_OF]->(g:SubstitutionGroup)<-[:MEMBER_OF]-(p2:Product)
MATCH (inv:InventoryPool)-[:OF_PRODUCT]->(p2)
WHERE inv.quantityOnHand > inv.safetyStock
MATCH (inv)-[:STORED_AT]->(loc:Location)
RETURN p, p2, inv, loc
```

### 5.4 Incident Subgraph

Returns: disruption, affected nodes/lanes, shipments, commitments, destinations, recommended recovery actions. Implemented as a composition of §5.1 + a query against `RecommendationRun`s for this disruption.

### 5.5 Recommendation Delta Graph

Returns: commitments improved, harmed, routes changed (lane sequence diff), cost and ETA deltas, new risk scores. Implementation reads two ImpactRuns (baseline and post-action) and diffs.

## 6. Scenario Generator

### Config

```ts
type ScenarioGeneratorConfig = {
  seed: string;
  scenarioStart: number;
  nodeTiers: Array<{
    kind: Location['kind'];
    count: number;
    xRange: [number, number];
    yRange: [number, number];
    handlingTimeHoursRange: [number, number];
    capacityUnitsPerHourRange: [number, number];
  }>;
  products: Array<{
    id: string;
    requiresColdChain: boolean;
    requiresHazmat: boolean;
    shelfLifeHours?: number;
  }>;
  substitutionGroups: Array<{
    id: string;
    productIds: string[];
  }>;
  laneRules: Array<{
    fromKind: Location['kind'];
    toKind: Location['kind'];
    mode: Lane['mode'];
    minDegree: number;            // min outgoing lanes per source node
    maxDegree: number;
    speedUnitsPerHour: number;
    costPerDistanceUnit: number;
    reliabilityRange: [number, number];
    capacityRange: [number, number];
  }>;
  commitmentCount: number;
  shipmentCount: number;
  priorityDistribution: Record<'P0'|'P1'|'P2'|'P3', number>; // proportions, sum = 1.0
  penaltyCurveByPriority: Record<'P0'|'P1'|'P2'|'P3', PenaltyCurveType>;
  inventoryPoolFraction: number;  // [0,1] — fraction of destinations with inventory tracking
  heroCommitmentSpecs?: Array<{
    priority: 'P0'|'P1'|'P2'|'P3';
    productId: string;             // must appear in `products`
    destinationKind?: 'destination'|'warehouse';
    minDisjointPaths: number;      // typically 2
    quantityRange?: [number, number];
  }>;
};
```

`heroCommitmentSpecs` cannot reference commitment IDs because commitments don't yet exist when the config is written. Instead, each spec describes the *kind* of commitment the demo needs guaranteed redundancy for. The generator constructs these commitments first (after lanes are built) and adds extra lanes if needed to satisfy `minDisjointPaths`. Other commitments are sampled afterward and inherit whatever connectivity the resulting graph happens to have.

### Algorithm

```txt
1.  Init deterministic RNG from seed.
2.  Generate tiered locations using xRange/yRange/handling/capacity ranges.
3.  Connect adjacent tiers using laneRules with minDegree/maxDegree, ensuring connectivity.
4.  transitHours = euclidean(x,y) / speedUnitsPerHour.
5.  cost = euclidean(x,y) * costPerDistanceUnit.
6.  Sample reliability and capacity uniformly within ranges.
7.  Generate products and substitution groups.
8.  Assign products to producers: for each Supplier and Factory, sample a subset of
    products it PRODUCES. Every product must be produced by ≥1 supplier or factory.
9.  For each heroCommitmentSpec (in declaration order):
    - choose origin: a PRODUCES-bearing location for spec.productId
    - choose destination: a location matching spec.destinationKind
    - count edge-disjoint paths from origin to destination
    - if < spec.minDisjointPaths, add direct lanes between intermediate tiers (using
      the matching laneRule for those tiers) until the count is satisfied; respect
      laneRules.maxDegree by adding intermediate hubs/warehouses if necessary
    - create a hero Commitment with spec.priority, sampled quantity from
      spec.quantityRange (default [500, 3000]), and standard deadline/tolerance/curve
      sampling. Tag it as a hero commitment for downstream tests.
10. Generate the remaining commitments to reach commitmentCount:
    - sample priority by distribution
    - sample required product
    - choose deliveredTo from kind='destination' locations
    - reject if no path exists from any producer-of-product to deliveredTo
    - sample quantity log-uniform [50, 5000]
    - mustArriveBy = scenarioStart + uniform[24h, 7d]
    - delayToleranceHours = uniform[2, 48], clamped ≤ deadline lead time
    - penaltyCurve = penaltyCurveByPriority[priority]
11. For each commitment (hero and ordinary), choose origin from PRODUCES-bearing
    locations for the required product (preferring nearest by lane-graph distance).
    Find baseline shortest-path route (Dijkstra, default weights).
12. Generate shipments to reach shipmentCount: each shipment's product, origin, and
    route match one or more commitments. Allocate FULFILLS.quantity per
    (shipment, commitment) pair so that for every commitment the sum of
    FULFILLS.quantity equals commitment.quantity, and for every shipment the sum is ≤
    shipment.quantity. Shipments may carry slack capacity.
13. Create inventory pools at inventoryPoolFraction of destinations.
14. Verify invariants:
    - every destination reachable from ≥1 origin
    - every commitment's required product is PRODUCES-ed by ≥1 reachable origin
    - every commitment has full FULFILLS.quantity allocation
    - every hero commitment has ≥ its spec.minDisjointPaths edge-disjoint paths
15. Export scenario JSON; ingest to Neo4j idempotently.
```

Coordinates serve visual layout and heuristic distance only. They are never used for real-world routing.

## 7. Routing Engine

The router operates on a projected lane graph in memory:

```txt
For each Location L:
  outgoingLanes(L) = lanes where L is LANE_START
  incomingLanes(L) = lanes where L is LANE_END
```

### Routing weights (distinct from recommendation weights)

`RoutingWeights = { time, cost, risk }` — used for shortest-path edge weighting.
`RecommendationWeights = { risk, saved, resilience, cost, complexity }` — used to score recovery candidates (§11). Do not unify the types.

### Routing exclusions from active disruptions

A node closure does **not** mark its incident lanes as closed; the router must derive lane exclusions itself. The exclusion set is computed once per routing run from active closure-effect disruptions:

```txt
exclusions.laneIds      = { d.targetId | d.targetKind == 'Lane'     and d has 'closure' effect }
exclusions.locationIds  = { d.targetId | d.targetKind == 'Location' and d has 'closure' effect }

A lane L is excluded if:
  L.id ∈ exclusions.laneIds
  OR L.originId ∈ exclusions.locationIds
  OR L.destinationId ∈ exclusions.locationIds
```

Excluded lanes have `weight = ∞` and are not traversed. The reroute candidate generator uses this so that a hub closure correctly removes the closed Location and all incident lanes from candidate paths.

### Effective lane weight (per shipment, per objective)

```txt
effectiveTime = lane.transitHours
              + closureWait(lane, disruptions, t)
              + capacityQueueDelay(lane, disruptions, t)
              + sumActiveAddDelays(lane, disruptions, t)

effectiveCost = lane.costPerUnit * shipment.quantity
              * costMultiplier(lane, disruptions, t)

effectiveRisk = -log(max(0.001, lane.reliability))
              + disruptionRiskPenalty(lane, disruptions, t)

weight = routing.time * (effectiveTime / scenarioStats.maxLaneTime)
       + routing.cost * (effectiveCost / scenarioStats.maxLaneCost)
       + routing.risk * (effectiveRisk / scenarioStats.maxLaneRisk)
```

Per-lane handling charges are intentionally absent from the weight: handling is per *node* and is added once per traversed location during ETA recalculation (§9.2 / Implementation Plan §5.2). Encoding it on the lane would double-count intermediate nodes.

`isCompatible(lane, shipment)` returns `false` for cold-chain, hazmat, or mode mismatches; weight is then `Infinity`.

### Algorithms

- **Dijkstra** for MVP shortest path.
- **Yen's K-shortest paths** (K=3) for multi-route candidates in reroute generation.
- **A\*** with euclidean heuristic if performance demands; not required at demo scale.
- **OR-Tools** deferred to P2 for multi-shipment capacity allocation.

### Capacity queue model

Per CapacityPool when one exists, otherwise per Lane. Each resource has an `availableAt` timestamp — the earliest moment it is free for the next shipment.

```txt
For each lane-arrival event, in chronological order:
  effectiveCapacity = baseCapacityUnitsPerHour * activeCapacityMultiplier(arrivalAt)
  serviceStart      = max(shipment.arrivalAt, resource.availableAt)
  serviceDuration   = (shipment.quantity / effectiveCapacity) * HOUR
  queueDelay        = serviceStart - shipment.arrivalAt
  resource.availableAt = serviceStart + serviceDuration
```

The shipment's lane traversal (transit time) happens *in parallel* with the resource being held — `serviceDuration` is the resource lock-in for the next shipment, not the shipment's own travel time. The shipment itself proceeds with `serviceStart + transitDelay + handling`.

This drains correctly: a shipment arriving after the resource has cleared sees `queueDelay = 0`. The naive `sum(units arriving since scenarioStart)` model never drains and produces nonsense. Worked example: capacity 100 u/h, five 50-u shipments at hourly intervals — the naive model says shipment 5 has 2 h delay; the correct model says 0 h, because the lane has been idle since t+3.5h.

Processing order across the lane DAG is event-based, not final-ETA-based. Initialize one event per shipment's next lane entry, pop the earliest event from a min-heap ordered by `(arrivalAt, resourceId, shipmentId)`, reserve capacity for that resource, compute the lane exit time, then push the shipment's next lane-entry event if one exists. This matters when a shipment with a later final baseline ETA reaches an early shared resource before another shipment. Reprioritization changes the ordering at the affected resource only and recomputes downstream events. O(E log E) at demo scale.

## 8. Disruption Engine

Disruption types map to effect kinds (see §4.10). The engine:

1. Validates the target entity exists and matches the disruption type.
2. Persists a Disruption node with `status='active'`.
3. Adds it to the current scenario's ongoing incident set if `startsAt <= now < endsAt`.
4. Triggers an ImpactRun.
5. Returns the disruption ID and the incident subgraph.

Mitigation: applying a recovery action sets the affected disruption(s) to `status='mitigated'`, but they continue to influence impact/routing until `endsAt`.

Resolution: setting `status='resolved'` causes the next ImpactRun to ignore it.

Example payload:

```json
{
  "type": "node_closure",
  "target": { "kind": "Location", "id": "loc-port-sg" },
  "startsAt": 1714219200000,
  "endsAt": 1714305600000,
  "severity": 1.0,
  "effects": [{ "kind": "closure" }],
  "uncertainty": {
    "duration": {
      "distribution": "triangular",
      "min": 12, "mode": 24, "max": 48
    }
  }
}
```

## 9. Impact Propagation

Two layers, fully deterministic.

### 9.1 Graph Traversal

```txt
Disruption -> affected Location/Lane/InventoryPool
Affected Location/Lane -> shipments using it (USES_LANE for lanes; LANE_START|LANE_END for locations)
Shipments -> commitments they fulfill (FULFILLS)
Commitments -> destinations and products (DELIVERS_TO, REQUIRES)
```

Produces the incident subgraph.

### 9.2 Calculation

Per affected shipment, recompute ETA via the algorithm in Implementation Plan §5.2.

A commitment can be fulfilled by multiple shipments via partial allocations, so the commitment's effective ETA is the **completion ETA** — the moment cumulative `FULFILLS.quantity` first reaches `commitment.quantity`:

```txt
sorted = fulfillingShipments(C) sorted by shipment.currentEta ascending
cumulative = 0
completionEta = +Infinity
for s in sorted:
  cumulative += FULFILLS.quantity(s, C)
  if cumulative >= C.quantity:
    completionEta = s.currentEta
    break
```

By the FULFILLS full-allocation invariant (§4.0), the loop always terminates with a finite ETA on a well-formed graph; `+Infinity` is a defensive default for malformed input.

Per affected commitment:

```txt
latenessHours = max(0, (completionEta - mustArriveBy) / HOUR)
ratio    = latenessHours / max(1, delayToleranceHours)
priority = PRIORITY_WEIGHTS[priority]
quantity = quantityWeight(commitment.quantity, scenarioStats.maxQuantity)
penalty  = penaltyCurves[penaltyCurve](min(1, ratio))
risk     = penalty * priority * quantity
```

Inventory-served commitments take `max(commitmentRisk, stockoutRisk)` per §4.8.

Outputs:
- ImpactRun node with totals.
- `currentRisk` updated on commitments.
- `(:ImpactRun)-[:OBSERVED {etaBefore, etaAfter, riskBefore, riskAfter}]->(:Shipment|:Commitment)` relationships.
- Summary row in PostgreSQL `impact_runs` for dashboards and audit.

## 10. Monte Carlo Engine (P1)

Wraps the deterministic engine.

```txt
1. Load scenario + ongoing disruption set.
2. For N samples:
   a. Clone graph state in memory (only mutated subgraph).
   b. Sample uncertain variables (duration, transit multiplier, capacity multiplier, demand).
   c. Apply sampled disruption effects.
   d. Run deterministic ETA calculation.
   e. Run deterministic risk scoring.
   f. Record per-commitment lateness and outcome.
3. Aggregate per commitment:
   - probabilityLate          = count(lateness>0) / N
   - probabilityFailed        = count(lateness>tolerance) / N
   - expectedLateness         = mean(lateness)
   - p50Lateness, p90Lateness
   - expectedPriorityWeightedLoss = mean(risk)
```

MVP sample sizes:
- Interactive: N=200.
- Precomputed demo confidence: N=1000.

Reproducibility: `seed = scenario.seed + ':' + disruption.id`.

## 11. Recommendation Engine

The engine evaluates actions, never guesses them.

```txt
1. Run baseline ImpactRun.
2. Use the full current scenario state: current scenario time, all ongoing disruptions in scope, and any already-applied recovery actions.
3. Identify top-K affected commitments (K = min(20, count of at-risk)).
4. For each enabled candidate generator, produce 0+ candidate actions.
5. For each candidate:
   a. Clone state.
   b. Apply candidate.
   c. Run impact propagation.
   d. Compute evaluation (riskReduction, saved, harmed, cost, complexity).
6. Compute normalization basis from candidate set.
7. Score candidates by objective preset.
8. Rank.
9. Persist RecommendationRun + RecoveryAction nodes.
```

### P0 candidate generators

**Reroute** — per affected shipment, run Yen's K-shortest paths over the projected graph with disrupted lanes excluded. Produce up to K reroute candidates.

**Reallocate Inventory** — per at-risk commitment, query inventory pools at the destination (and pools holding products in the same SubstitutionGroup). If a pool has surplus over `safetyStock` that covers any meaningful portion of the commitment, generate a candidate.

The candidate's effect on apply (and the same on cloned state during evaluation):

1. Decrement `InventoryPool.quantityOnHand` by the allocated amount.
2. Create a synthetic Shipment with `originType='inventory_pool'`, `origin = pool.location`, `destination = commitment.deliveredTo`, `quantity = allocated`, and a route from pool to destination (length zero if pool is co-located with destination).
3. Connect that synthetic shipment to the commitment via `(Shipment)-[:FULFILLS {quantity = allocated}]->(Commitment)`.
4. Reduce or remove existing `FULFILLS` allocations from delayed shipments to maintain the full-allocation invariant; the candidate's `payload.allocationDelta` carries the exact reassignment.

`cost = poolTransferCost + transitCost`, where `poolTransferCost` is a per-unit handling fee on the pool and `transitCost` follows from the lane traversal (zero if pool is at destination).

**Reprioritize Capacity** — when a lane or node has constrained capacity (queue > 0 in the affected zone), generate a candidate that reorders the queue at each affected resource. Resource scope is **per CapacityPool when one constrains the lane/location, otherwise per Lane**. Sort key: `(priority asc, mustArriveBy asc, quantity desc, commitmentId asc)`. The final tiebreak by `commitmentId` makes the order deterministic.

After re-running impact propagation with the reordered queue:

- `commitmentsImproved` = commitments whose new lateness ≤ tolerance and old lateness > tolerance.
- `commitmentsHarmed` = commitments whose new lateness > tolerance and old lateness ≤ tolerance.

Both sets are written as `(:RecoveryAction)-[:IMPROVES|:HARMS]->(:Commitment)` edges.

### P1 candidate generators

**Switch Origin** — query the substitution graph for alternate origin Locations holding fungible product. Generate a new shipment from that origin.

**Expedite** — if a faster mode (air for ocean, etc.) is constraint-compatible, generate a candidate using that mode at higher cost.

**Split Shipment** — send safety-stock-quantity via the fastest available route, remainder on the original route.

### Scoring

```txt
score = w.risk * (riskReduction / norm.risk)
      + w.saved * (commitmentsSaved.length / norm.saved)
      + w.resilience * (mcLossReduction / norm.resilience)   // 0 if MC disabled
      - w.cost * (addedCost / norm.cost)
      - w.complexity * (complexity / 5)
```

`norm.X = max(|X_i|)` across candidates in the run, floored at 1.

### Objective presets

| Preset           | risk | saved | resilience | cost | complexity |
|------------------|------|-------|------------|------|------------|
| protect_p0       | 0.4  | 0.5   | 0.0        | 0.05 | 0.05       |
| min_total_risk   | 0.6  | 0.2   | 0.0        | 0.1  | 0.1        |
| min_cost         | 0.1  | 0.1   | 0.0        | 0.7  | 0.1        |
| max_resilience   | 0.2  | 0.2   | 0.5        | 0.05 | 0.05       |
| balanced         | 0.3  | 0.25  | 0.15       | 0.2  | 0.1        |

For `protect_p0`, the `saved` count is computed only over P0+P1 commitments.

### Apply Semantics

Applying a recovery action mutates the live graph in Neo4j and produces a fresh ImpactRun on the post-application state. Per action type:

| Type                  | Mutation on apply                                                                                                                                                               |
|-----------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| reroute               | Replace the shipment's `USES_LANE` edges (with a new sequence) for the lanes that change. `currentLaneIndex` resets to 0.                                                       |
| reallocate_inventory  | Decrement `InventoryPool.quantityOnHand`; create the synthetic Shipment + `FULFILLS` per the generator's rules; adjust pre-existing `FULFILLS` allocations per `allocationDelta`.|
| reprioritize_capacity | Persist the new queue order on the affected resource. (Queue order is part of the routing projection, not a graph relationship; the new order is recorded in `payload.order`.)  |
| switch_origin (P1)    | Create a new Shipment from the alternate origin with `FULFILLS` for the served commitments. Set the original shipment's `status='cancelled'`.                                   |
| expedite (P1)         | Replace the shipment's `USES_LANE` with the faster-mode lane sequence. Update `CONTAINS` if mode constraints changed.                                                           |
| split_shipment (P1)   | Create a second Shipment with partial quantity on a faster route. Redistribute `FULFILLS.quantity` to maintain the full-allocation invariant.                                   |

Side effects on every apply:
- `Scenario.version` increments.
- `RecoveryAction.appliedAt` is set; `RecoveryAction.status='applied'`.
- A row is written to PostgreSQL `audit_log` with `(action_id, user_id, applied_at, baseline_impact_run_id, post_impact_run_id)`.
- A new ImpactRun is computed on the post-apply state.
- All FULFILLS invariants (§4.0) are validated; failure rolls back the apply transactionally.

`POST /api/scenarios/:scenarioId/reset` re-ingests the original generated JSON and resets `Scenario.version=0`. Past ImpactRuns and RecommendationRuns are retained as history rows in PostgreSQL but the active Neo4j graph returns to the deterministic baseline.

## 12. AI Command Layer

The LLM is a controller and explainer, never a calculator or store.

### Flow

```txt
User text + selected entity context (from typeahead)
  -> Gemini parses intent into a typed tool call
  -> Backend Zod-validates the tool call payload
  -> Backend executes the tool (graph query, disruption, recommendation)
  -> Backend returns structured facts
  -> Gemini renders a grounded summary citing IDs and numbers
```

### Tool Registry

```ts
type Tool =
  | { name: 'createDisruption'; args: DisruptionInput }
  | { name: 'blastRadius'; args: { entityId: string; depth?: number } }
  | { name: 'rootCause'; args: { commitmentId: string } }
  | { name: 'generateRecommendations'; args: { disruptionId: string; objective: ObjectivePreset } }
  | { name: 'compareRecoveryPlans'; args: { actionIds: string[] } }
  | { name: 'summarizeIncident'; args: { disruptionId: string } };
```

### Entity Resolution

The LLM never resolves free-text entity names to IDs.

1. **Primary**: typeahead component over names of locations, lanes, commitments. The user picks before submitting; the LLM receives resolved IDs.
2. **Fallback**: backend fuzzy match (Levenshtein over `name` + `tags`). Top-1 score > 0.85 accepted automatically. If the top-2 candidates are within 0.05, the API returns an ambiguity error and the UI prompts the user to disambiguate. Never silently pick.

### Bounded Context

The LLM receives:
- Resolved entity facts (name, kind, key properties).
- Incident subgraph trimmed to the relevant disruption.
- Impact summary numbers.
- Recommendation evaluations with score breakdown.

It never receives:
- The full graph.
- User auth state.
- Other users' scenarios.

Output validation: every tool call is Zod-parsed before execution. Every summary is plain text rendered server-side.

## 13. API Surface

```txt
POST   /api/scenarios/generate
GET    /api/scenarios
GET    /api/scenarios/:scenarioId
POST   /api/scenarios/:scenarioId/reset
GET    /api/scenarios/:scenarioId/graph

GET    /api/scenarios/:scenarioId/entities/:entityId
GET    /api/scenarios/:scenarioId/entities/:entityId/context

POST   /api/scenarios/:scenarioId/disruptions
DELETE /api/scenarios/:scenarioId/disruptions/:disruptionId
GET    /api/scenarios/:scenarioId/disruptions/:disruptionId/impact-subgraph

POST   /api/scenarios/:scenarioId/impact-runs
POST   /api/scenarios/:scenarioId/monte-carlo-runs

POST   /api/scenarios/:scenarioId/recommendation-runs
GET    /api/scenarios/:scenarioId/recommendation-runs/:runId
POST   /api/scenarios/:scenarioId/recovery-actions/:actionId/apply

POST   /api/scenarios/:scenarioId/command
```

`POST /api/scenarios/:scenarioId/disruptions` is the shared event-ingestion path. It is used by Sentinel's own authoring/admin controls and by the separate Marauder dashboard when injecting curated menu events during the demo.

`GET/POST /api/scenarios/:scenarioId/time` manages the scenario clock. Impact and recommendation runs default to the current stored `now` and the current ongoing disruption set when the caller does not send explicit disruptions.

There is no `/upstream?depth=N` or `/downstream?depth=N`. `entities/:entityId/context` dispatches by node label and runs the per-entity traversal rules defined in Implementation Plan §5.1, returning `{ entity, upstream[], downstream[] }`. Generic variable-depth walking was removed because it produces meaningless paths and gets direction wrong for entity types where conceptually-upstream relationships are stored as outgoing (e.g. `Commitment-[:REQUIRES]->Product`).

## 14. Frontend Views

### Command Center (default)

- **Linked Map+Graph dual view**: MapLibre on the left half (locations as markers, lanes as arcs), Cytoscape on the right half (full ontology). Selecting an entity in either pane highlights it in the other; hover states sync. Pan/zoom independent.
- Top bar: scenario picker, active disruption count, global P0 risk badge.
- Bottom panel: at-risk commitments list (sortable by priority, lateness, risk).
- Right rail: entity inspector when something is selected.
- Active-disruption feed: ongoing disruptions, status changes, and newly ingested events appear here whether they were authored inside Sentinel or injected by Marauder. `mitigated` incidents remain in this feed until their configured end time.
- Recommendation interaction is `recommend -> preview -> apply`, never immediate apply.

### Event Authoring

Sentinel includes an internal admin surface for creating/editing disruptions and scenario updates. This is the operational ingestion capability and uses the same disruption API as every other client.

### Marauder Console

Separate adversarial/demo surface:

- Presents curated **menu events** rather than the full Sentinel operator workflow.
- Previews menu/custom events against the current live scenario before injection.
- Submits chosen events through Sentinel's disruption/event API.
- Exists to create pressure on the system during demos and training exercises, not to replace Sentinel's core monitoring or decision-support experience.

### Graph Explorer

Pure ontology exploration:

- Click any entity → upstream + downstream traversal (depth selector 1–4).
- Expand/collapse impact paths.
- Filter by priority, product, destination, risk threshold.

### Incident View

Focused subgraph for one disruption:

- Disruption node centered, blast radius radiates outward.
- Affected nodes/lanes highlighted by severity.
- At-risk commitments listed with one-click root-cause drill-down.
- Recommendations panel embedded.

### Plan Comparison View

The demo's hero view. **Visual graph diff**:

- **Shared layout**: compute the union of baseline + candidate node sets, lay it out once per recommendation run; both views use the same coordinates.
- **Node coloring** by `(in-baseline-at-risk, in-candidate-at-risk)`:
  - Both at-risk → unchanged (gray).
  - Baseline only → improved (green).
  - Candidate only → harmed (red).
  - Neither → safe in both (faint).
- **Edge styling**: routes that change between baseline and candidate render dashed; unchanged routes solid.
- **Side panel scorecard**: `riskReduction`, `commitmentsSaved.length`, `addedCost`, `complexity`, `score`.
- **Tab strip** across the top to switch between candidates.
- **Bar chart** below: baseline-vs-candidate risk by priority bucket.

## 15. Deployment Architecture

### Docker Services

```txt
caddy    → terminates TLS; reverse-proxies web + api
web      → static React build
api      → Fastify (HTTP, AI command, sync graph queries)
worker   → BullMQ consumer (Monte Carlo, parallel candidate evaluation)
neo4j    → 5.x community
postgres → 16
redis    → 7
```

No GPU. Gemini calls go to Vertex AI. Firebase Auth runs remotely.

### Data Volumes

```txt
neo4j-data     /data/neo4j
postgres-data  /data/postgres
redis-data     /data/redis
```

### Backups

Cron job: nightly `neo4j-admin database dump` + `pg_dump` to `/data/backups`. Retain 7 nightly snapshots. Remote backup is P2.
