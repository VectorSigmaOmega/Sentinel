import {
  PRIORITY_WEIGHTS,
  type Commitment,
  type Disruption,
  type DisruptionEffect,
  type Fulfillment,
  type GeneratedScenario,
  type InventoryPool,
  type Lane,
  type Location,
  type PenaltyCurve,
  type Shipment,
} from '@sentinel/ontology';
import { HOUR_MS } from '@sentinel/shared';

type Projection = {
  locationsById: Map<string, Location>;
  lanesById: Map<string, Lane>;
  shipmentsById: Map<string, Shipment>;
  inventoryPoolsById: Map<string, InventoryPool>;
  productsById: Set<string>;
  capacityPools: GeneratedScenario['capacityPools'];
  fulfillmentsByCommitment: Map<string, Fulfillment[]>;
  fulfillmentsByShipment: Map<string, Fulfillment[]>;
};

type CapacityResource = {
  id: string;
  unitsPerHour: number;
};

type LaneEntryEvent = {
  shipmentId: string;
  laneIndex: number;
  laneId: string;
  resourceId: string;
  arrivalAt: number;
};

type Replenishment = {
  eta: number;
  quantity: number;
};

export type ImpactEntityRef = {
  label: 'Disruption' | 'Location' | 'Lane' | 'Shipment' | 'Commitment' | 'InventoryPool' | 'Product';
  id: string;
  relationship?: string;
};

export type ShipmentImpactObservation = {
  shipmentId: string;
  productId: string;
  destinationId: string;
  laneSequence: string[];
  etaBefore: number | null;
  etaAfter: number | null;
  etaDeltaHours: number | null;
  affected: boolean;
  causePath?: ImpactEntityRef[];
};

export type CommitmentImpactObservation = {
  commitmentId: string;
  priority: Commitment['priority'];
  productId: string;
  deliveredToId: string;
  quantity: number;
  mustArriveBy: number;
  delayToleranceHours: number;
  completionEtaBefore: number | null;
  completionEtaAfter: number | null;
  etaDeltaHours: number | null;
  latenessHoursBefore: number | null;
  latenessHoursAfter: number | null;
  toleranceConsumedBefore: number | null;
  toleranceConsumedAfter: number | null;
  riskBefore: number;
  riskAfter: number;
  riskDelta: number;
  atRiskBefore: boolean;
  atRiskAfter: boolean;
  breachedToleranceBefore: boolean;
  breachedToleranceAfter: boolean;
  affected: boolean;
  causePath?: ImpactEntityRef[];
};

export type ImpactSummary = {
  shipmentCount: number;
  impactedShipmentCount: number;
  commitmentCount: number;
  impactedCommitmentCount: number;
  atRiskCommitmentCountBefore: number;
  atRiskCommitmentCountAfter: number;
  p0AtRiskCommitmentCountAfter: number;
  breachedToleranceCommitmentCountAfter: number;
  totalRiskBefore: number;
  totalRiskAfter: number;
  riskDelta: number;
  maxLatenessHoursAfter: number | null;
};

export type CapacityQueueObservation = {
  resourceId: string;
  shipmentId: string;
  laneId: string;
  arrivalAt: number;
  serviceStart: number;
  serviceEnd: number;
  queueDelayHours: number;
};

export type ResourcePriorityOverrides = Record<string, string[]>;

export type ImpactRun = {
  id: string;
  scenarioId: string;
  triggeredBy: string;
  createdAt: number;
  now: number;
  disruptionIds: string[];
  disruptions: Disruption[];
  summary: ImpactSummary;
  shipmentObservations: ShipmentImpactObservation[];
  commitmentObservations: CommitmentImpactObservation[];
  queueObservations: CapacityQueueObservation[];
  affectedEntityIds: string[];
};

export type ImpactRunOptions = {
  id?: string;
  now?: number;
  includeUnaffected?: boolean;
  resourcePriorityOverrides?: ResourcePriorityOverrides;
};

export class ImpactInputError extends Error {
  readonly code = 'impact_input_invalid';
  readonly statusCode = 400;
}

export function runImpact(
  scenario: GeneratedScenario,
  disruptions: readonly Disruption[],
  options: ImpactRunOptions = {},
): ImpactRun {
  const now = options.now ?? scenario.scenario.scenarioStart;
  const projection = buildProjection(scenario);
  validateDisruptions(scenario, projection, disruptions);

  const baselineSimulation = simulateShipmentFlow(scenario, [], {
    now,
    projection,
  });
  const nextSimulation = simulateShipmentFlow(scenario, disruptions, {
    now,
    projection,
    ...(options.resourcePriorityOverrides ? { resourcePriorityOverrides: options.resourcePriorityOverrides } : {}),
  });
  const etaBeforeByShipment = baselineSimulation.etas;
  const etaAfterByShipment = nextSimulation.etas;
  const directCauseByShipment = new Map<string, ImpactEntityRef[]>();
  const shipmentObservationsAll = scenario.shipments.map((shipment) => {
    const etaBefore = etaBeforeByShipment.get(shipment.id) ?? shipment.baselineEta;
    const etaAfter = etaAfterByShipment.get(shipment.id) ?? Number.POSITIVE_INFINITY;
    const causePath = directCauseForShipment(projection, shipment, disruptions);
    if (causePath) directCauseByShipment.set(shipment.id, causePath);
    const affected = hasEtaChanged(etaBefore, etaAfter) || Boolean(causePath);
    return buildShipmentObservation(shipment, etaBefore, etaAfter, affected, causePath);
  });

  const commitmentObservationsAll = scenario.commitments.map((commitment) => {
    const before = calculateCommitmentObservation({
      scenario,
      projection,
      commitment,
      etaByShipment: etaBeforeByShipment,
      disruptions: [],
    });
    const after = calculateCommitmentObservation({
      scenario,
      projection,
      commitment,
      etaByShipment: etaAfterByShipment,
      disruptions,
    });
    const etaDeltaHours = hourDelta(before.completionEta, after.completionEta);
    const causePath = causePathForCommitment(projection, commitment, directCauseByShipment, etaAfterByShipment, after.completionEta);
    const affected =
      hasEtaChanged(before.completionEta, after.completionEta) ||
      Math.abs(before.risk - after.risk) > 0.000001 ||
      Boolean(causePath);
    return buildCommitmentObservation(commitment, before, after, etaDeltaHours, affected, causePath);
  });

  const includeUnaffected = options.includeUnaffected ?? true;
  const shipmentObservations = includeUnaffected
    ? shipmentObservationsAll
    : shipmentObservationsAll.filter((observation) => observation.affected);
  const commitmentObservations = includeUnaffected
    ? commitmentObservationsAll
    : commitmentObservationsAll.filter((observation) => observation.affected);
  const summary = summarizeImpact(shipmentObservationsAll, commitmentObservationsAll);
  const disruptionIds = disruptions.map((disruption) => disruption.id);

  return {
    id: options.id ?? makeImpactRunId(scenario.scenario.id, disruptionIds, now),
    scenarioId: scenario.scenario.id,
    triggeredBy: disruptionIds.length === 0 ? 'baseline' : disruptionIds.join(','),
    createdAt: now,
    now,
    disruptionIds,
    disruptions: [...disruptions],
    summary,
    shipmentObservations,
    commitmentObservations,
    queueObservations: nextSimulation.queueObservations,
    affectedEntityIds: collectAffectedEntityIds(disruptions, shipmentObservationsAll, commitmentObservationsAll),
  };
}

export function calculateShipmentEtas(
  scenario: GeneratedScenario,
  disruptions: readonly Disruption[],
  options: { now?: number; projection?: Projection; resourcePriorityOverrides?: ResourcePriorityOverrides } = {},
): Map<string, number> {
  return simulateShipmentFlow(scenario, disruptions, options).etas;
}

export function simulateShipmentFlow(
  scenario: GeneratedScenario,
  disruptions: readonly Disruption[],
  options: { now?: number; projection?: Projection; resourcePriorityOverrides?: ResourcePriorityOverrides } = {},
): { etas: Map<string, number>; queueObservations: CapacityQueueObservation[] } {
  const now = options.now ?? scenario.scenario.scenarioStart;
  const projection = options.projection ?? buildProjection(scenario);
  const resourceState = new Map<string, number>();
  const etas = new Map<string, number>();
  const queue: LaneEntryEvent[] = [];
  const queueObservations: CapacityQueueObservation[] = [];

  for (const shipment of scenario.shipments) {
    if (shipment.status === 'delivered') {
      etas.set(shipment.id, shipment.currentEta);
      continue;
    }
    if (shipment.status === 'failed' || shipment.status === 'cancelled') {
      etas.set(shipment.id, Number.POSITIVE_INFINITY);
      continue;
    }
    const event = firstLaneEntryEvent(projection, shipment, disruptions, now);
    if (!event) {
      etas.set(shipment.id, now);
      continue;
    }
    pushEvent(queue, event);
  }

  while (queue.length > 0) {
    const event = takeNextEvent(queue, resourceState, options.resourcePriorityOverrides, now);
    const shipment = projection.shipmentsById.get(event.shipmentId);
    const lane = projection.lanesById.get(event.laneId);
    if (!shipment || !lane) {
      etas.set(event.shipmentId, Number.POSITIVE_INFINITY);
      continue;
    }

    let t = event.arrivalAt;
    t += closureWaitForLane(lane, disruptions, t);
    if (!Number.isFinite(t)) {
      etas.set(shipment.id, Number.POSITIVE_INFINITY);
      continue;
    }

    const reservation = reserveCapacity(lane, projection, resourceState, disruptions, t, shipment, now);
    if (!Number.isFinite(reservation.queueDelay)) {
      etas.set(shipment.id, Number.POSITIVE_INFINITY);
      continue;
    }
    queueObservations.push({
      resourceId: reservation.resourceId,
      shipmentId: shipment.id,
      laneId: lane.id,
      arrivalAt: t,
      serviceStart: t + reservation.queueDelay,
      serviceEnd: reservation.serviceEnd,
      queueDelayHours: round(reservation.queueDelay / HOUR_MS, 6),
    });
    t += reservation.queueDelay;
    t += laneTransitDelay(lane, disruptions, t);

    const destination = projection.locationsById.get(lane.destinationId);
    if (!destination) {
      etas.set(shipment.id, Number.POSITIVE_INFINITY);
      continue;
    }
    t += handlingDelay(destination, disruptions, t);

    const nextLaneIndex = event.laneIndex + 1;
    if (nextLaneIndex >= shipment.laneSequence.length) {
      etas.set(shipment.id, t);
      continue;
    }

    const nextLaneId = shipment.laneSequence[nextLaneIndex]!;
    const nextLane = projection.lanesById.get(nextLaneId);
    if (!nextLane) {
      etas.set(shipment.id, Number.POSITIVE_INFINITY);
      continue;
    }
    pushEvent(queue, {
      shipmentId: shipment.id,
      laneIndex: nextLaneIndex,
      laneId: nextLane.id,
      resourceId: capacityResourceForLane(nextLane, projection).id,
      arrivalAt: t,
    });
  }

  return { etas, queueObservations };
}

export function commitmentCompletionEta(
  commitment: Commitment,
  allocations: readonly { shipmentEta: number; allocatedQuantity: number }[],
): number {
  const sorted = [...allocations].sort((a, b) => a.shipmentEta - b.shipmentEta);
  let cumulative = 0;
  for (const allocation of sorted) {
    cumulative += allocation.allocatedQuantity;
    if (cumulative >= commitment.quantity) return allocation.shipmentEta;
  }
  return Number.POSITIVE_INFINITY;
}

export function calculateCommitmentRisk(
  commitment: Commitment,
  completionEta: number,
  scenarioStats: { maxQuantity: number },
): number {
  const lateness = Math.max(0, hoursBetween(completionEta, commitment.mustArriveBy));
  const tolerance = Math.max(1, commitment.delayToleranceHours);
  const ratio = lateness / tolerance;
  const priority = PRIORITY_WEIGHTS[commitment.priority];
  const quantity = quantityWeight(commitment.quantity, scenarioStats.maxQuantity);
  const penalty = applyPenaltyCurve(commitment.penaltyCurve, ratio);
  return round(penalty * priority * quantity, 6);
}

export function applyPenaltyCurve(curve: PenaltyCurve, ratio: number): number {
  const r = Math.max(0, Math.min(1, ratio));
  if (curve === 'cliff') return r === 0 ? 0 : 1;
  if (curve === 'ramp') return r;
  const k = 3;
  return (Math.exp(k * r) - 1) / (Math.exp(k) - 1);
}

export function quantityWeight(quantity: number, maxQuantity: number): number {
  const numerator = 1 + Math.log10(Math.max(1, quantity));
  const denominator = 1 + Math.log10(Math.max(1, maxQuantity));
  return Math.max(0.1, Math.min(1, numerator / denominator));
}

export function computeStockoutTime(
  pool: InventoryPool,
  scenarioStart: number,
  inbound: readonly Replenishment[],
): number {
  const sorted = [...inbound].filter((item) => Number.isFinite(item.eta)).sort((a, b) => a.eta - b.eta);
  let cursor = scenarioStart;
  let level = pool.quantityOnHand;
  const demandUnitsPerMs = pool.demandUnitsPerHour / HOUR_MS;

  if (level <= pool.safetyStock) return scenarioStart;
  if (demandUnitsPerMs <= 0) return Number.POSITIVE_INFINITY;

  for (const replenishment of sorted) {
    if (replenishment.eta < cursor) {
      level += replenishment.quantity;
      continue;
    }
    const stockoutAt = cursor + (level - pool.safetyStock) / demandUnitsPerMs;
    if (stockoutAt <= replenishment.eta) return stockoutAt;
    level -= (replenishment.eta - cursor) * demandUnitsPerMs;
    level += replenishment.quantity;
    cursor = replenishment.eta;
  }

  return cursor + (level - pool.safetyStock) / demandUnitsPerMs;
}

function buildProjection(scenario: GeneratedScenario): Projection {
  const fulfillmentsByCommitment = new Map<string, Fulfillment[]>();
  const fulfillmentsByShipment = new Map<string, Fulfillment[]>();
  for (const fulfillment of scenario.fulfillments) {
    const byCommitment = fulfillmentsByCommitment.get(fulfillment.commitmentId) ?? [];
    byCommitment.push(fulfillment);
    fulfillmentsByCommitment.set(fulfillment.commitmentId, byCommitment);

    const byShipment = fulfillmentsByShipment.get(fulfillment.shipmentId) ?? [];
    byShipment.push(fulfillment);
    fulfillmentsByShipment.set(fulfillment.shipmentId, byShipment);
  }

  return {
    locationsById: new Map(scenario.locations.map((location) => [location.id, location])),
    lanesById: new Map(scenario.lanes.map((lane) => [lane.id, lane])),
    shipmentsById: new Map(scenario.shipments.map((shipment) => [shipment.id, shipment])),
    inventoryPoolsById: new Map(scenario.inventoryPools.map((pool) => [pool.id, pool])),
    productsById: new Set(scenario.products.map((product) => product.id)),
    capacityPools: scenario.capacityPools,
    fulfillmentsByCommitment,
    fulfillmentsByShipment,
  };
}

function validateDisruptions(
  scenario: GeneratedScenario,
  projection: Projection,
  disruptions: readonly Disruption[],
): void {
  for (const disruption of disruptions) {
    if (disruption.scenarioId !== scenario.scenario.id) {
      throw new ImpactInputError(`Disruption ${disruption.id} belongs to ${disruption.scenarioId}, not ${scenario.scenario.id}`);
    }
    if (disruption.endsAt <= disruption.startsAt) {
      throw new ImpactInputError(`Disruption ${disruption.id} must end after it starts`);
    }
    if (disruption.targetKind === 'Location' && !projection.locationsById.has(disruption.targetId)) {
      throw new ImpactInputError(`Unknown disruption location target: ${disruption.targetId}`);
    }
    if (disruption.targetKind === 'Lane' && !projection.lanesById.has(disruption.targetId)) {
      throw new ImpactInputError(`Unknown disruption lane target: ${disruption.targetId}`);
    }
    if (disruption.targetKind === 'InventoryPool' && !projection.inventoryPoolsById.has(disruption.targetId)) {
      throw new ImpactInputError(`Unknown disruption inventory target: ${disruption.targetId}`);
    }
    if (disruption.targetKind === 'Product' && !projection.productsById.has(disruption.targetId)) {
      throw new ImpactInputError(`Unknown disruption product target: ${disruption.targetId}`);
    }
    if (disruption.targetKind === 'ProductAtLocation') {
      if (!disruption.targetProductId || !projection.productsById.has(disruption.targetProductId)) {
        throw new ImpactInputError(`Unknown product-at-location product target on ${disruption.id}`);
      }
      if (!disruption.targetLocationId || !projection.locationsById.has(disruption.targetLocationId)) {
        throw new ImpactInputError(`Unknown product-at-location location target on ${disruption.id}`);
      }
    }
  }
}

function firstLaneEntryEvent(
  projection: Projection,
  shipment: Shipment,
  disruptions: readonly Disruption[],
  now: number,
): LaneEntryEvent | null {
  const laneIndex = shipment.currentLaneIndex;
  const laneId = shipment.laneSequence[laneIndex];
  if (!laneId) return null;
  const lane = projection.lanesById.get(laneId);
  if (!lane) return null;
  const origin = projection.locationsById.get(lane.originId);
  if (!origin) return null;
  const arrivalAt = Math.max(now, shipmentReadyAt(shipment, now)) + handlingDelay(origin, disruptions, now);
  return {
    shipmentId: shipment.id,
    laneIndex,
    laneId,
    resourceId: capacityResourceForLane(lane, projection).id,
    arrivalAt,
  };
}

function shipmentReadyAt(shipment: Shipment, now: number): number {
  if (shipment.status === 'in_transit') return now;
  return now;
}

function pushEvent(queue: LaneEntryEvent[], event: LaneEntryEvent): void {
  queue.push(event);
  queue.sort(compareLaneEntryEvents);
}

function takeNextEvent(
  queue: LaneEntryEvent[],
  resourceState: Map<string, number>,
  resourcePriorityOverrides: ResourcePriorityOverrides | undefined,
  now: number,
): LaneEntryEvent {
  const first = queue.shift()!;
  const overrideOrder = resourcePriorityOverrides?.[first.resourceId];
  if (!overrideOrder || overrideOrder.length === 0) return first;

  const availableAt = resourceState.get(first.resourceId) ?? now;
  const cutoff = Math.max(first.arrivalAt, availableAt);
  let best = first;
  let bestIndex = -1;

  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index]!;
    if (candidate.resourceId !== first.resourceId) continue;
    if (candidate.arrivalAt > cutoff) continue;
    if (compareQueueOverride(candidate, best, overrideOrder) < 0) {
      best = candidate;
      bestIndex = index;
    }
  }

  if (bestIndex >= 0) {
    queue.splice(bestIndex, 1);
  }
  return best;
}

function compareLaneEntryEvents(a: LaneEntryEvent, b: LaneEntryEvent): number {
  return a.arrivalAt - b.arrivalAt || a.resourceId.localeCompare(b.resourceId) || a.shipmentId.localeCompare(b.shipmentId);
}

function compareQueueOverride(a: LaneEntryEvent, b: LaneEntryEvent, overrideOrder: readonly string[]): number {
  const aRank = shipmentOverrideRank(a.shipmentId, overrideOrder);
  const bRank = shipmentOverrideRank(b.shipmentId, overrideOrder);
  if (aRank !== bRank) return aRank - bRank;
  return compareLaneEntryEvents(a, b);
}

function shipmentOverrideRank(shipmentId: string, overrideOrder: readonly string[]): number {
  const index = overrideOrder.indexOf(shipmentId);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function reserveCapacity(
  lane: Lane,
  projection: Projection,
  resourceState: Map<string, number>,
  disruptions: readonly Disruption[],
  arrivalAt: number,
  shipment: Shipment,
  now: number,
): { resourceId: string; queueDelay: number; serviceEnd: number } {
  const resource = capacityResourceForLane(lane, projection);
  const unitsPerHour = effectiveCapacityUnitsPerHour(resource, lane, disruptions, arrivalAt);
  if (unitsPerHour <= 0) {
    return {
      resourceId: resource.id,
      queueDelay: Number.POSITIVE_INFINITY,
      serviceEnd: Number.POSITIVE_INFINITY,
    };
  }
  const availableAt = resourceState.get(resource.id) ?? now;
  const serviceStart = Math.max(arrivalAt, availableAt);
  const serviceDuration = (shipment.quantity / unitsPerHour) * HOUR_MS;
  const serviceEnd = serviceStart + serviceDuration;
  resourceState.set(resource.id, serviceEnd);
  return {
    resourceId: resource.id,
    queueDelay: serviceStart - arrivalAt,
    serviceEnd,
  };
}

function capacityResourceForLane(lane: Lane, projection: Projection): CapacityResource {
  const pools = projection.capacityPools
    .filter((pool) => {
      if (pool.scope === 'lane') return pool.constrainedEntityIds.includes(lane.id);
      return pool.constrainedEntityIds.includes(lane.originId) || pool.constrainedEntityIds.includes(lane.destinationId);
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const pool = pools[0];
  if (pool) return { id: pool.id, unitsPerHour: pool.unitsPerHour };
  return { id: `lane:${lane.id}`, unitsPerHour: lane.capacityUnitsPerHour };
}

function handlingDelay(location: Location, disruptions: readonly Disruption[], t: number): number {
  const base = location.handlingTimeHours * HOUR_MS;
  const closureWait = closureWaitForLocation(location, disruptions, t);
  return base + closureWait + sumAddDelayMsForLocation(location, disruptions, t);
}

function closureWaitForLocation(location: Location, disruptions: readonly Disruption[], t: number): number {
  return closureWait(disruptions, t, (disruption) => disruption.targetKind === 'Location' && disruption.targetId === location.id);
}

function closureWaitForLane(lane: Lane, disruptions: readonly Disruption[], t: number): number {
  return closureWait(disruptions, t, (disruption) => disruption.targetKind === 'Lane' && disruption.targetId === lane.id);
}

function closureWait(
  disruptions: readonly Disruption[],
  t: number,
  matchesTarget: (disruption: Disruption) => boolean,
): number {
  const activeClosures = disruptions.filter(
    (disruption) =>
      disruption.status !== 'resolved' &&
      disruption.startsAt <= t &&
      t < disruption.endsAt &&
      matchesTarget(disruption) &&
      disruption.effects.some((effect) => effect.kind === 'closure'),
  );
  if (activeClosures.length === 0) return 0;
  return Math.max(...activeClosures.map((disruption) => disruption.endsAt)) - t;
}

function laneTransitDelay(lane: Lane, disruptions: readonly Disruption[], t: number): number {
  return lane.transitHours * HOUR_MS + sumAddDelayMsForLane(lane, disruptions, t);
}

function sumAddDelayMsForLocation(location: Location, disruptions: readonly Disruption[], t: number): number {
  return activeEffects(disruptions, t, 'add_delay')
    .filter(({ disruption }) => disruption.targetKind === 'Location' && disruption.targetId === location.id)
    .reduce((sum, item) => sum + item.effect.hours * HOUR_MS, 0);
}

function sumAddDelayMsForLane(lane: Lane, disruptions: readonly Disruption[], t: number): number {
  return activeEffects(disruptions, t, 'add_delay')
    .filter(({ disruption }) => disruption.targetKind === 'Lane' && disruption.targetId === lane.id)
    .reduce((sum, item) => sum + item.effect.hours * HOUR_MS, 0);
}

function effectiveCapacityUnitsPerHour(
  resource: CapacityResource,
  lane: Lane,
  disruptions: readonly Disruption[],
  t: number,
): number {
  let multiplier = 1;
  for (const { disruption, effect } of activeEffects(disruptions, t, 'capacity_multiplier')) {
    if (disruption.targetKind === 'Lane' && disruption.targetId === lane.id) multiplier *= effect.multiplier;
    if (
      disruption.targetKind === 'Location' &&
      (disruption.targetId === lane.originId || disruption.targetId === lane.destinationId)
    ) {
      multiplier *= effect.multiplier;
    }
    if (disruption.targetId === resource.id) multiplier *= effect.multiplier;
  }
  return resource.unitsPerHour * multiplier;
}

function activeEffects<K extends DisruptionEffect['kind']>(
  disruptions: readonly Disruption[],
  t: number,
  kind: K,
): Array<{ disruption: Disruption; effect: Extract<DisruptionEffect, { kind: K }> }> {
  const result: Array<{ disruption: Disruption; effect: Extract<DisruptionEffect, { kind: K }> }> = [];
  for (const disruption of disruptions) {
    if (disruption.status === 'resolved' || disruption.startsAt > t || t >= disruption.endsAt) continue;
    for (const effect of disruption.effects) {
      if (effect.kind === kind) {
        result.push({ disruption, effect: effect as Extract<DisruptionEffect, { kind: K }> });
      }
    }
  }
  return result;
}

function calculateCommitmentObservation(args: {
  scenario: GeneratedScenario;
  projection: Projection;
  commitment: Commitment;
  etaByShipment: Map<string, number>;
  disruptions: readonly Disruption[];
}): {
  completionEta: number;
  latenessHours: number;
  toleranceConsumed: number;
  risk: number;
} {
  const stats = scenarioStats(args.scenario);
  const fulfillments = args.projection.fulfillmentsByCommitment.get(args.commitment.id) ?? [];
  const allocations = fulfillments.map((fulfillment) => ({
    shipmentEta: args.etaByShipment.get(fulfillment.shipmentId) ?? Number.POSITIVE_INFINITY,
    allocatedQuantity: fulfillment.quantity,
  }));
  const completionEta = commitmentCompletionEta(args.commitment, allocations);
  const pool = inventoryPoolForCommitment(args.scenario, args.projection, args.commitment);
  const risk = finalCommitmentRisk({
    scenario: args.scenario,
    projection: args.projection,
    commitment: args.commitment,
    completionEta,
    pool,
    etaByShipment: args.etaByShipment,
    disruptions: args.disruptions,
    stats,
  });
  const latenessHours = Math.max(0, hoursBetween(completionEta, args.commitment.mustArriveBy));
  const toleranceConsumed = latenessHours / Math.max(1, args.commitment.delayToleranceHours);
  return {
    completionEta,
    latenessHours,
    toleranceConsumed,
    risk,
  };
}

function finalCommitmentRisk(args: {
  scenario: GeneratedScenario;
  projection: Projection;
  commitment: Commitment;
  completionEta: number;
  pool: InventoryPool | null;
  etaByShipment: Map<string, number>;
  disruptions: readonly Disruption[];
  stats: { maxQuantity: number };
}): number {
  const baseRisk = calculateCommitmentRisk(args.commitment, args.completionEta, args.stats);
  if (!args.pool) return baseRisk;

  const inbound = args.scenario.shipments
    .filter(
      (shipment) =>
        shipment.originType === 'location' &&
        shipment.destinationId === args.pool!.storedAtId &&
        shipment.productId === args.pool!.productId,
    )
    .map((shipment) => ({ eta: args.etaByShipment.get(shipment.id) ?? Number.POSITIVE_INFINITY, quantity: shipment.quantity }));
  const stockoutAt = computeStockoutTime(args.pool, args.scenario.scenario.scenarioStart, inbound);
  if (!Number.isFinite(stockoutAt)) return baseRisk;

  const stockoutRatio = Math.max(
    0,
    Math.min(1, (args.completionEta - stockoutAt) / (Math.max(1, args.commitment.delayToleranceHours) * HOUR_MS)),
  );
  const stockoutRisk = round(stockoutRatio * PRIORITY_WEIGHTS[args.commitment.priority], 6);
  return Math.max(baseRisk, stockoutRisk);
}

function inventoryPoolForCommitment(
  scenario: GeneratedScenario,
  projection: Projection,
  commitment: Commitment,
): InventoryPool | null {
  const byDestination = scenario.inventoryPools.find(
    (pool) => pool.storedAtId === commitment.deliveredToId && pool.productId === commitment.requiredProductId,
  );
  if (byDestination) return byDestination;

  const fulfillments = projection.fulfillmentsByCommitment.get(commitment.id) ?? [];
  for (const fulfillment of fulfillments) {
    const shipment = projection.shipmentsById.get(fulfillment.shipmentId);
    if (!shipment || shipment.originType !== 'inventory_pool') continue;
    const byId = projection.inventoryPoolsById.get(shipment.originId);
    if (byId) return byId;
  }
  return null;
}

function buildShipmentObservation(
  shipment: Shipment,
  etaBefore: number,
  etaAfter: number,
  affected: boolean,
  causePath?: ImpactEntityRef[],
): ShipmentImpactObservation {
  const base = {
    shipmentId: shipment.id,
    productId: shipment.productId,
    destinationId: shipment.destinationId,
    laneSequence: shipment.laneSequence,
    etaBefore: finiteOrNull(etaBefore),
    etaAfter: finiteOrNull(etaAfter),
    etaDeltaHours: hourDelta(etaBefore, etaAfter),
    affected,
  };
  return causePath ? { ...base, causePath } : base;
}

function buildCommitmentObservation(
  commitment: Commitment,
  before: { completionEta: number; latenessHours: number; toleranceConsumed: number; risk: number },
  after: { completionEta: number; latenessHours: number; toleranceConsumed: number; risk: number },
  etaDeltaHours: number | null,
  affected: boolean,
  causePath?: ImpactEntityRef[],
): CommitmentImpactObservation {
  const base = {
    commitmentId: commitment.id,
    priority: commitment.priority,
    productId: commitment.requiredProductId,
    deliveredToId: commitment.deliveredToId,
    quantity: commitment.quantity,
    mustArriveBy: commitment.mustArriveBy,
    delayToleranceHours: commitment.delayToleranceHours,
    completionEtaBefore: finiteOrNull(before.completionEta),
    completionEtaAfter: finiteOrNull(after.completionEta),
    etaDeltaHours,
    latenessHoursBefore: finiteOrNull(round(before.latenessHours, 3)),
    latenessHoursAfter: finiteOrNull(round(after.latenessHours, 3)),
    toleranceConsumedBefore: finiteOrNull(round(before.toleranceConsumed, 6)),
    toleranceConsumedAfter: finiteOrNull(round(after.toleranceConsumed, 6)),
    riskBefore: before.risk,
    riskAfter: after.risk,
    riskDelta: round(after.risk - before.risk, 6),
    atRiskBefore: before.risk > 0,
    atRiskAfter: after.risk > 0,
    breachedToleranceBefore: before.toleranceConsumed > 1,
    breachedToleranceAfter: after.toleranceConsumed > 1,
    affected,
  };
  return causePath ? { ...base, causePath } : base;
}

function directCauseForShipment(
  projection: Projection,
  shipment: Shipment,
  disruptions: readonly Disruption[],
): ImpactEntityRef[] | undefined {
  const laneIds = new Set(shipment.laneSequence);
  const locationIds = new Set<string>([shipment.originId, shipment.destinationId]);
  for (const laneId of shipment.laneSequence) {
    const lane = projection.lanesById.get(laneId);
    if (!lane) continue;
    locationIds.add(lane.originId);
    locationIds.add(lane.destinationId);
  }

  for (const disruption of disruptions) {
    if (disruption.targetKind === 'Lane' && laneIds.has(disruption.targetId)) {
      return [
        { label: 'Disruption', id: disruption.id },
        { label: 'Lane', id: disruption.targetId, relationship: 'AFFECTS' },
        { label: 'Shipment', id: shipment.id, relationship: 'USES_LANE' },
      ];
    }
    if (disruption.targetKind === 'Location' && locationIds.has(disruption.targetId)) {
      return [
        { label: 'Disruption', id: disruption.id },
        { label: 'Location', id: disruption.targetId, relationship: 'AFFECTS' },
        { label: 'Shipment', id: shipment.id, relationship: 'ROUTE_TOUCHES' },
      ];
    }
    if (disruption.targetKind === 'Product' && disruption.targetId === shipment.productId) {
      return [
        { label: 'Disruption', id: disruption.id },
        { label: 'Product', id: disruption.targetId, relationship: 'AFFECTS' },
        { label: 'Shipment', id: shipment.id, relationship: 'CARRIES' },
      ];
    }
    if (
      disruption.targetKind === 'ProductAtLocation' &&
      disruption.targetProductId === shipment.productId &&
      disruption.targetLocationId &&
      locationIds.has(disruption.targetLocationId)
    ) {
      return [
        { label: 'Disruption', id: disruption.id },
        { label: 'Product', id: disruption.targetProductId, relationship: 'AFFECTS_PRODUCT_AT_LOCATION' },
        { label: 'Shipment', id: shipment.id, relationship: 'CARRIES_THROUGH_LOCATION' },
      ];
    }
  }
  return undefined;
}

function causePathForCommitment(
  projection: Projection,
  commitment: Commitment,
  directCauseByShipment: Map<string, ImpactEntityRef[]>,
  etaByShipment: Map<string, number>,
  completionEta: number,
): ImpactEntityRef[] | undefined {
  const fulfillments = projection.fulfillmentsByCommitment.get(commitment.id) ?? [];
  const caused = fulfillments
    .map((fulfillment) => {
      const cause = directCauseByShipment.get(fulfillment.shipmentId);
      const shipment = projection.shipmentsById.get(fulfillment.shipmentId);
      return cause && shipment ? { cause, shipment, fulfillment } : null;
    })
    .filter((item): item is { cause: ImpactEntityRef[]; shipment: Shipment; fulfillment: Fulfillment } => Boolean(item))
    .sort((a, b) => {
      const aEta = etaByShipment.get(a.shipment.id) ?? Number.POSITIVE_INFINITY;
      const bEta = etaByShipment.get(b.shipment.id) ?? Number.POSITIVE_INFINITY;
      const aEtaDistance = Math.abs(aEta - completionEta);
      const bEtaDistance = Math.abs(bEta - completionEta);
      return aEtaDistance - bEtaDistance || a.shipment.id.localeCompare(b.shipment.id);
    });
  const first = caused[0];
  if (!first) return undefined;
  return [
    ...first.cause,
    { label: 'Commitment', id: commitment.id, relationship: `FULFILLS:${first.fulfillment.quantity}` },
  ];
}

function summarizeImpact(
  shipmentObservations: readonly ShipmentImpactObservation[],
  commitmentObservations: readonly CommitmentImpactObservation[],
): ImpactSummary {
  const impactedCommitments = commitmentObservations.filter((observation) => observation.affected);
  const atRiskBefore = commitmentObservations.filter((observation) => observation.atRiskBefore);
  const atRiskAfter = commitmentObservations.filter((observation) => observation.atRiskAfter);
  const totalRiskBefore = round(commitmentObservations.reduce((sum, observation) => sum + observation.riskBefore, 0), 6);
  const totalRiskAfter = round(commitmentObservations.reduce((sum, observation) => sum + observation.riskAfter, 0), 6);
  const finiteLateness = commitmentObservations
    .map((observation) => observation.latenessHoursAfter)
    .filter((value): value is number => value !== null);

  return {
    shipmentCount: shipmentObservations.length,
    impactedShipmentCount: shipmentObservations.filter((observation) => observation.affected).length,
    commitmentCount: commitmentObservations.length,
    impactedCommitmentCount: impactedCommitments.length,
    atRiskCommitmentCountBefore: atRiskBefore.length,
    atRiskCommitmentCountAfter: atRiskAfter.length,
    p0AtRiskCommitmentCountAfter: atRiskAfter.filter((observation) => observation.priority === 'P0').length,
    breachedToleranceCommitmentCountAfter: commitmentObservations.filter((observation) => observation.breachedToleranceAfter).length,
    totalRiskBefore,
    totalRiskAfter,
    riskDelta: round(totalRiskAfter - totalRiskBefore, 6),
    maxLatenessHoursAfter: finiteLateness.length === 0 ? null : Math.max(...finiteLateness),
  };
}

function collectAffectedEntityIds(
  disruptions: readonly Disruption[],
  shipmentObservations: readonly ShipmentImpactObservation[],
  commitmentObservations: readonly CommitmentImpactObservation[],
): string[] {
  const ids = new Set<string>();
  for (const disruption of disruptions) {
    ids.add(disruption.id);
    ids.add(disruption.targetId);
    if (disruption.targetProductId) ids.add(disruption.targetProductId);
    if (disruption.targetLocationId) ids.add(disruption.targetLocationId);
  }
  for (const observation of shipmentObservations) {
    if (observation.affected) ids.add(observation.shipmentId);
  }
  for (const observation of commitmentObservations) {
    if (observation.affected) ids.add(observation.commitmentId);
  }
  return [...ids].sort();
}

function scenarioStats(scenario: GeneratedScenario): { maxQuantity: number } {
  return {
    maxQuantity: Math.max(1, ...scenario.commitments.map((commitment) => commitment.quantity)),
  };
}

function hasEtaChanged(before: number, after: number): boolean {
  if (Number.isFinite(before) !== Number.isFinite(after)) return true;
  if (!Number.isFinite(before) && !Number.isFinite(after)) return false;
  return Math.abs(after - before) > 1;
}

function hoursBetween(later: number, earlier: number): number {
  return (later - earlier) / HOUR_MS;
}

function hourDelta(before: number, after: number): number | null {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  return round(hoursBetween(after, before), 3);
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function round(value: number, places = 3): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function makeImpactRunId(scenarioId: string, disruptionIds: readonly string[], now: number): string {
  const suffix = disruptionIds.length === 0 ? 'baseline' : disruptionIds.map((id) => id.split(':').pop() ?? id).join('-');
  return `${scenarioId}:impact-${suffix}-${now}`;
}
