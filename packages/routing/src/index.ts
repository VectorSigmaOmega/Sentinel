import type { Disruption, GeneratedScenario, Lane, Product, Shipment } from '@sentinel/ontology';

export type RoutingWeights = {
  time: number;
  cost: number;
  risk: number;
};

export type RoutingExclusions = {
  laneIds: Set<string>;
  locationIds: Set<string>;
};

export type RoutingProjection = {
  scenario: GeneratedScenario;
  lanesByOrigin: Map<string, Lane[]>;
  lanesById: Map<string, Lane>;
  productsById: Map<string, Product>;
};

export type RoutePath = {
  laneIds: string[];
  locationIds: string[];
  totalWeight: number;
  totalTransitHours: number;
  totalCost: number;
  reliabilityPenalty: number;
};

export type RouteSearchOptions = {
  shipment: Shipment;
  exclusions?: RoutingExclusions;
  weights?: RoutingWeights;
  bannedLaneIds?: Set<string>;
  bannedLocationIds?: Set<string>;
};

export type RerouteCandidate = {
  shipmentId: string;
  path: RoutePath;
  etaDeltaHours: number;
  costDelta: number;
  reason?: string;
};

const DEFAULT_WEIGHTS: RoutingWeights = { time: 0.7, cost: 0.2, risk: 0.1 };

export function buildRoutingProjection(scenario: GeneratedScenario): RoutingProjection {
  const lanesByOrigin = new Map<string, Lane[]>();
  for (const lane of scenario.lanes) {
    const lanes = lanesByOrigin.get(lane.originId) ?? [];
    lanes.push(lane);
    lanesByOrigin.set(lane.originId, lanes);
  }
  for (const lanes of lanesByOrigin.values()) {
    lanes.sort((a, b) => a.id.localeCompare(b.id));
  }
  return {
    scenario,
    lanesByOrigin,
    lanesById: new Map(scenario.lanes.map((lane) => [lane.id, lane])),
    productsById: new Map(scenario.products.map((product) => [product.id, product])),
  };
}

export function computeExclusionsFromDisruptions(disruptions: readonly Disruption[]): RoutingExclusions {
  const laneIds = new Set<string>();
  const locationIds = new Set<string>();
  for (const disruption of disruptions) {
    if (disruption.status === 'resolved') continue;
    if (!disruption.effects.some((effect) => effect.kind === 'closure')) continue;
    if (disruption.targetKind === 'Lane') laneIds.add(disruption.targetId);
    if (disruption.targetKind === 'Location') locationIds.add(disruption.targetId);
  }
  return { laneIds, locationIds };
}

export function emptyExclusions(): RoutingExclusions {
  return { laneIds: new Set(), locationIds: new Set() };
}

export function isLaneExcluded(lane: Lane, exclusions: RoutingExclusions): boolean {
  return (
    exclusions.laneIds.has(lane.id) ||
    exclusions.locationIds.has(lane.originId) ||
    exclusions.locationIds.has(lane.destinationId)
  );
}

export function dijkstraRoute(
  projection: RoutingProjection,
  originId: string,
  destinationId: string,
  options: RouteSearchOptions,
): RoutePath | null {
  const exclusions = options.exclusions ?? emptyExclusions();
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const bannedLaneIds = options.bannedLaneIds ?? new Set<string>();
  const bannedLocationIds = options.bannedLocationIds ?? new Set<string>();
  const dist = new Map<string, number>([[originId, 0]]);
  const prev = new Map<string, { locationId: string; laneId: string }>();
  const visited = new Set<string>();

  while (true) {
    const current = nextUnvisited(dist, visited);
    if (!current) return null;
    if (current === destinationId) break;
    visited.add(current);

    for (const lane of projection.lanesByOrigin.get(current) ?? []) {
      if (bannedLaneIds.has(lane.id)) continue;
      if (bannedLocationIds.has(lane.destinationId)) continue;
      if (isLaneExcluded(lane, exclusions)) continue;
      if (!isCompatible(projection, lane, options.shipment)) continue;
      const weight = laneWeight(lane, options.shipment, weights);
      if (!Number.isFinite(weight)) continue;
      const next = lane.destinationId;
      const candidate = dist.get(current)! + weight;
      if (candidate < (dist.get(next) ?? Number.POSITIVE_INFINITY)) {
        dist.set(next, candidate);
        prev.set(next, { locationId: current, laneId: lane.id });
      }
    }
  }

  return hydratePath(projection, originId, destinationId, prev, dist.get(destinationId)!);
}

export function kShortestRoutes(
  projection: RoutingProjection,
  originId: string,
  destinationId: string,
  options: RouteSearchOptions,
  k = 3,
): RoutePath[] {
  const first = dijkstraRoute(projection, originId, destinationId, options);
  if (!first) return [];

  const accepted: RoutePath[] = [first];
  const candidates: RoutePath[] = [];

  for (let kth = 1; kth < k; kth += 1) {
    const previous = accepted[kth - 1]!;
    for (let spurIndex = 0; spurIndex < previous.locationIds.length - 1; spurIndex += 1) {
      const spurNode = previous.locationIds[spurIndex]!;
      const rootLaneIds = previous.laneIds.slice(0, spurIndex);
      const rootLocationIds = previous.locationIds.slice(0, spurIndex + 1);
      const bannedLaneIds = new Set(options.bannedLaneIds ?? []);
      const bannedLocationIds = new Set(options.bannedLocationIds ?? []);

      for (const path of accepted) {
        if (samePrefix(path.laneIds, rootLaneIds) && path.laneIds[spurIndex]) {
          bannedLaneIds.add(path.laneIds[spurIndex]!);
        }
      }
      for (const locationId of rootLocationIds.slice(0, -1)) {
        bannedLocationIds.add(locationId);
      }

      const spur = dijkstraRoute(projection, spurNode, destinationId, {
        ...options,
        bannedLaneIds,
        bannedLocationIds,
      });
      if (!spur) continue;

      const combined = combineRootAndSpur(projection, rootLaneIds, rootLocationIds, spur);
      if (!combined) continue;
      if (accepted.some((path) => samePath(path, combined))) continue;
      if (candidates.some((path) => samePath(path, combined))) continue;
      candidates.push(combined);
    }

    candidates.sort((a, b) => a.totalWeight - b.totalWeight || a.laneIds.join(',').localeCompare(b.laneIds.join(',')));
    const next = candidates.shift();
    if (!next) break;
    accepted.push(next);
  }

  return accepted;
}

export function generateRerouteCandidates(
  projection: RoutingProjection,
  shipment: Shipment,
  options: Omit<RouteSearchOptions, 'shipment'> = {},
  k = 3,
): RerouteCandidate[] {
  const baselinePath = routeFromLaneSequence(projection, shipment.laneSequence);
  const routes = kShortestRoutes(
    projection,
    shipment.originId,
    shipment.destinationId,
    { ...options, shipment },
    k,
  );
  return routes
    .filter((route) => !sameLaneSequence(route.laneIds, shipment.laneSequence))
    .map((route) => ({
      shipmentId: shipment.id,
      path: route,
      etaDeltaHours: route.totalTransitHours - baselinePath.totalTransitHours,
      costDelta: (route.totalCost - baselinePath.totalCost) * shipment.quantity,
    }));
}

export function routeFromLaneSequence(projection: RoutingProjection, laneSequence: readonly string[]): RoutePath {
  const laneIds = [...laneSequence];
  if (laneIds.length === 0) {
    return {
      laneIds: [],
      locationIds: [],
      totalWeight: 0,
      totalTransitHours: 0,
      totalCost: 0,
      reliabilityPenalty: 0,
    };
  }
  const lanes = laneIds.map((id) => {
    const lane = projection.lanesById.get(id);
    if (!lane) throw new Error(`Unknown lane in sequence: ${id}`);
    return lane;
  });
  const locationIds = [lanes[0]!.originId, ...lanes.map((lane) => lane.destinationId)];
  return {
    laneIds,
    locationIds,
    totalWeight: lanes.reduce((sum, lane) => sum + lane.transitHours, 0),
    totalTransitHours: lanes.reduce((sum, lane) => sum + lane.transitHours, 0),
    totalCost: lanes.reduce((sum, lane) => sum + lane.costPerUnit, 0),
    reliabilityPenalty: lanes.reduce((sum, lane) => sum + -Math.log(Math.max(0.001, lane.reliability)), 0),
  };
}

export function laneWeight(lane: Lane, shipment: Shipment, weights: RoutingWeights = DEFAULT_WEIGHTS): number {
  const time = lane.transitHours;
  const cost = lane.costPerUnit * shipment.quantity;
  const risk = -Math.log(Math.max(0.001, lane.reliability));
  return weights.time * time + weights.cost * (cost / 1000) + weights.risk * risk;
}

export function isCompatible(projection: RoutingProjection, lane: Lane, shipment: Shipment): boolean {
  if (lane.status !== 'open') return false;
  const product = projection.productsById.get(shipment.productId);
  if (!product) return false;
  if (product.requiresColdChain && !lane.supportsColdChain) return false;
  if (product.requiresHazmat && !lane.supportsHazmat) return false;
  return true;
}

function nextUnvisited(dist: Map<string, number>, visited: Set<string>): string | null {
  let bestId: string | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const [id, distance] of dist) {
    if (!visited.has(id) && distance < best) {
      bestId = id;
      best = distance;
    }
  }
  return bestId;
}

function hydratePath(
  projection: RoutingProjection,
  originId: string,
  destinationId: string,
  prev: Map<string, { locationId: string; laneId: string }>,
  totalWeight: number,
): RoutePath | null {
  const laneIds: string[] = [];
  const locationIds = [destinationId];
  let cursor = destinationId;

  while (cursor !== originId) {
    const step = prev.get(cursor);
    if (!step) return null;
    laneIds.unshift(step.laneId);
    locationIds.unshift(step.locationId);
    cursor = step.locationId;
  }

  let totalTransitHours = 0;
  let totalCost = 0;
  let reliabilityPenalty = 0;
  for (const laneId of laneIds) {
    const lane = projection.lanesById.get(laneId);
    if (!lane) return null;
    totalTransitHours += lane.transitHours;
    totalCost += lane.costPerUnit;
    reliabilityPenalty += -Math.log(Math.max(0.001, lane.reliability));
  }

  return { laneIds, locationIds, totalWeight, totalTransitHours, totalCost, reliabilityPenalty };
}

function combineRootAndSpur(
  projection: RoutingProjection,
  rootLaneIds: string[],
  rootLocationIds: string[],
  spur: RoutePath,
): RoutePath | null {
  const laneIds = [...rootLaneIds, ...spur.laneIds];
  if (laneIds.length === 0) return spur;
  const root = routeFromLaneSequence(projection, rootLaneIds);
  const locationIds = rootLocationIds.length === 0 ? spur.locationIds : [...rootLocationIds, ...spur.locationIds.slice(1)];
  return {
    laneIds,
    locationIds,
    totalWeight: root.totalWeight + spur.totalWeight,
    totalTransitHours: root.totalTransitHours + spur.totalTransitHours,
    totalCost: root.totalCost + spur.totalCost,
    reliabilityPenalty: root.reliabilityPenalty + spur.reliabilityPenalty,
  };
}

function samePrefix(path: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((item, index) => path[index] === item);
}

function samePath(a: RoutePath, b: RoutePath): boolean {
  return sameLaneSequence(a.laneIds, b.laneIds);
}

function sameLaneSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => b[index] === item);
}
