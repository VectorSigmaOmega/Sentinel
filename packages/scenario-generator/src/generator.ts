import {
  generatedScenarioSchema,
  type Commitment,
  type GeneratedScenario,
  type Lane,
  type Location,
  type LocationKind,
  type Product,
  type Produces,
  type Shipment,
  type SubstitutionGroup,
} from '@sentinel/ontology';
import { createHash } from 'node:crypto';
import { createRng, type Rng } from './rng.js';
import type { HeroCommitmentSpec, LaneRuleConfig, ScenarioGeneratorConfig } from './config.js';
import { countEdgeDisjointPaths, euclidean, routeTransitHours, shortestPath } from './graph.js';

type PlannedCommitment = {
  commitment: Commitment;
  originId: string;
  laneSequence: string[];
};

export function generateScenario(config: ScenarioGeneratorConfig): GeneratedScenario {
  const rng = createRng(config.seed);
  const scenarioId = scenarioIdFromSeed(config.seed);
  const ns = (suffix: string) => `${scenarioId}:${suffix}`;

  const locations = generateLocations(config, scenarioId, rng);
  const products = config.products.map<Product>((product) => ({
    id: ns(product.id),
    scenarioId,
    name: product.name,
    requiresColdChain: product.requiresColdChain,
    requiresHazmat: product.requiresHazmat,
    shelfLifeHours: product.shelfLifeHours ?? null,
  }));
  const productIdByRaw = new Map(config.products.map((product) => [product.id, ns(product.id)]));
  const substitutionGroups = config.substitutionGroups.map<SubstitutionGroup>((group) => ({
    id: ns(group.id),
    scenarioId,
    name: group.name,
    notes: '',
    productIds: group.productIds.map((id) => requireMapped(productIdByRaw, id)),
  }));

  let laneCounter = 0;
  let lanes = generateInitialLanes(config, scenarioId, locations, rng, () => {
    laneCounter += 1;
    return ns(`lane-${pad(laneCounter)}`);
  });

  const produces = generateProduces(config, scenarioId, locations, productIdByRaw, rng);
  const planned: PlannedCommitment[] = [];
  let commitmentCounter = 0;

  for (const spec of config.heroCommitmentSpecs ?? []) {
    const result = createHeroCommitment({
      spec,
      config,
      scenarioId,
      ns,
      locations,
      products,
      produces,
      lanes,
      rng,
      nextCommitmentId: () => {
        commitmentCounter += 1;
        return ns(`comm-${pad(commitmentCounter)}`);
      },
      nextLaneId: () => {
        laneCounter += 1;
        return ns(`lane-${pad(laneCounter)}`);
      },
    });
    lanes = result.lanes;
    planned.push(result.planned);
  }

  while (planned.length < config.commitmentCount) {
    const product = rng.pick(products);
    const destination = rng.pick(locations.filter((loc) => loc.kind === 'destination'));
    const route = chooseOriginAndRoute(product.id, destination.id, produces, lanes);
    if (!route) continue;
    commitmentCounter += 1;
    planned.push({
      commitment: makeCommitment({
        id: ns(`comm-${pad(commitmentCounter)}`),
        scenarioId,
        productId: product.id,
        destinationId: destination.id,
        priority: samplePriority(config, rng),
        quantity: logUniformInt(rng, 50, 5000),
        scenarioStart: config.scenarioStart,
        penaltyCurveByPriority: config.penaltyCurveByPriority,
        tags: [],
        rng,
      }),
      originId: route.originId,
      laneSequence: route.laneSequence,
    });
  }

  const { shipments, fulfillments } = generateShipments({
    scenarioId,
    ns,
    planned,
    products,
    locations,
    lanes,
    shipmentCount: config.shipmentCount,
    scenarioStart: config.scenarioStart,
    rng,
  });

  const inventoryPools = generateInventoryPools({
    scenarioId,
    ns,
    locations,
    products,
    fraction: config.inventoryPoolFraction,
    rng,
  });
  const capacityPools = generateCapacityPools({ scenarioId, ns, locations });

  const scenario: GeneratedScenario = {
    scenario: {
      id: scenarioId,
      seed: config.seed,
      name: config.name,
      scenarioStart: config.scenarioStart,
      createdAt: config.scenarioStart,
      version: 0,
      generatorConfigHash: hashConfig(config),
    },
    locations,
    lanes,
    products,
    substitutionGroups,
    commitments: planned.map((entry) => entry.commitment),
    shipments,
    fulfillments,
    inventoryPools,
    capacityPools,
    produces,
  };

  return generatedScenarioSchema.parse(scenario);
}

function generateLocations(config: ScenarioGeneratorConfig, scenarioId: string, rng: Rng): Location[] {
  const locations: Location[] = [];
  const counters = new Map<LocationKind, number>();
  for (const tier of config.nodeTiers) {
    for (let i = 0; i < tier.count; i += 1) {
      const next = (counters.get(tier.kind) ?? 0) + 1;
      counters.set(tier.kind, next);
      locations.push({
        id: `${scenarioId}:loc-${tier.kind}-${pad(next)}`,
        scenarioId,
        kind: tier.kind,
        name: `${title(tier.kind)} ${next}`,
        x: round(rng.float(tier.xRange[0], tier.xRange[1]), 3),
        y: round(rng.float(tier.yRange[0], tier.yRange[1]), 3),
        handlingTimeHours: round(rng.float(tier.handlingTimeHoursRange[0], tier.handlingTimeHoursRange[1]), 2),
        capacityUnitsPerHour: round(rng.float(tier.capacityUnitsPerHourRange[0], tier.capacityUnitsPerHourRange[1]), 2),
        status: 'open',
        tags: [],
      });
    }
  }
  return locations;
}

function generateInitialLanes(
  config: ScenarioGeneratorConfig,
  scenarioId: string,
  locations: Location[],
  rng: Rng,
  nextLaneId: () => string,
): Lane[] {
  const lanes: Lane[] = [];
  for (const rule of config.laneRules) {
    const sources = locations.filter((location) => location.kind === rule.fromKind);
    const targets = locations.filter((location) => location.kind === rule.toKind);
    for (const source of sources) {
      const degree = rng.int(rule.minDegree, rule.maxDegree);
      for (const target of rng.shuffle(targets).slice(0, degree)) {
        addLaneIfMissing(lanes, scenarioId, source, target, rule, rng, nextLaneId);
      }
    }
    for (const target of targets) {
      if (!lanes.some((lane) => lane.destinationId === target.id)) {
        addLaneIfMissing(lanes, scenarioId, rng.pick(sources), target, rule, rng, nextLaneId);
      }
    }
  }
  return lanes;
}

function generateProduces(
  config: ScenarioGeneratorConfig,
  scenarioId: string,
  locations: Location[],
  productIdByRaw: Map<string, string>,
  rng: Rng,
): Produces[] {
  const producers = locations.filter((location) => location.kind === 'supplier' || location.kind === 'factory');
  const result: Produces[] = [];

  for (const product of config.products) {
    result.push({ locationId: rng.pick(producers).id, productId: requireMapped(productIdByRaw, product.id) });
  }
  for (const producer of producers) {
    const count = rng.int(1, Math.min(2, config.products.length));
    for (const product of rng.shuffle(config.products).slice(0, count)) {
      result.push({ locationId: producer.id, productId: requireMapped(productIdByRaw, product.id) });
    }
  }

  return uniqueBy(result, (entry) => `${entry.locationId}|${entry.productId}`).map((entry) => ({
    ...entry,
    locationId: entry.locationId,
    productId: entry.productId,
  }));
}

function createHeroCommitment(args: {
  spec: HeroCommitmentSpec;
  config: ScenarioGeneratorConfig;
  scenarioId: string;
  ns: (suffix: string) => string;
  locations: Location[];
  products: Product[];
  produces: Produces[];
  lanes: Lane[];
  rng: Rng;
  nextCommitmentId: () => string;
  nextLaneId: () => string;
}): { planned: PlannedCommitment; lanes: Lane[] } {
  const productId = args.ns(args.spec.productId);
  const product = args.products.find((item) => item.id === productId);
  if (!product) throw new Error(`Hero product not found: ${args.spec.productId}`);
  const destinations = args.locations.filter((location) => location.kind === (args.spec.destinationKind ?? 'destination'));
  const producers = args.produces.filter((entry) => entry.productId === productId);
  let lanes = args.lanes;

  for (const destination of args.rng.shuffle(destinations)) {
    for (const producer of args.rng.shuffle(producers)) {
      const origin = args.locations.find((location) => location.id === producer.locationId);
      if (!origin) continue;
      lanes = ensureDisjointPaths({
        config: args.config,
        scenarioId: args.scenarioId,
        locations: args.locations,
        lanes,
        origin,
        destination,
        minDisjointPaths: args.spec.minDisjointPaths,
        rng: args.rng,
        nextLaneId: args.nextLaneId,
      });
      const path = shortestPath(lanes, origin.id, destination.id);
      if (!path) continue;
      const quantityRange = args.spec.quantityRange ?? [500, 3000];
      return {
        lanes,
        planned: {
          commitment: makeCommitment({
            id: args.nextCommitmentId(),
            scenarioId: args.scenarioId,
            productId,
            destinationId: destination.id,
            priority: args.spec.priority,
            quantity: args.rng.int(quantityRange[0], quantityRange[1]),
            scenarioStart: args.config.scenarioStart,
            penaltyCurveByPriority: args.config.penaltyCurveByPriority,
            tags: ['hero', `minDisjointPaths:${args.spec.minDisjointPaths}`],
            rng: args.rng,
          }),
          originId: origin.id,
          laneSequence: path.laneIds,
        },
      };
    }
  }
  throw new Error(`Unable to create hero commitment for ${args.spec.productId}`);
}

function ensureDisjointPaths(args: {
  config: ScenarioGeneratorConfig;
  scenarioId: string;
  locations: Location[];
  lanes: Lane[];
  origin: Location;
  destination: Location;
  minDisjointPaths: number;
  rng: Rng;
  nextLaneId: () => string;
}): Lane[] {
  let lanes = [...args.lanes];
  while (countEdgeDisjointPaths(lanes, args.origin.id, args.destination.id) < args.minDisjointPaths) {
    const pathNodes = chooseTierPath(args.config, args.locations, args.origin, args.destination, args.rng);
    for (let i = 0; i < pathNodes.length - 1; i += 1) {
      const from = pathNodes[i]!;
      const to = pathNodes[i + 1]!;
      const rule = args.config.laneRules.find((item) => item.fromKind === from.kind && item.toKind === to.kind);
      if (!rule) continue;
      addLaneIfMissing(lanes, args.scenarioId, from, to, rule, args.rng, args.nextLaneId);
    }
  }
  return lanes;
}

function chooseTierPath(
  config: ScenarioGeneratorConfig,
  locations: Location[],
  origin: Location,
  destination: Location,
  rng: Rng,
): Location[] {
  const tierKinds = config.nodeTiers.map((tier) => tier.kind);
  const start = tierKinds.indexOf(origin.kind);
  const end = tierKinds.indexOf(destination.kind);
  if (start < 0 || end < 0 || start >= end) return [origin, destination];
  const nodes = [origin];
  for (const kind of tierKinds.slice(start + 1, end)) {
    nodes.push(rng.pick(locations.filter((location) => location.kind === kind)));
  }
  nodes.push(destination);
  return nodes;
}

function chooseOriginAndRoute(
  productId: string,
  destinationId: string,
  produces: Produces[],
  lanes: Lane[],
): { originId: string; laneSequence: string[] } | null {
  let best: { originId: string; laneSequence: string[]; totalHours: number } | null = null;
  for (const producer of produces.filter((entry) => entry.productId === productId)) {
    const path = shortestPath(lanes, producer.locationId, destinationId);
    if (!path) continue;
    if (!best || path.totalHours < best.totalHours) {
      best = { originId: producer.locationId, laneSequence: path.laneIds, totalHours: path.totalHours };
    }
  }
  return best;
}

function makeCommitment(args: {
  id: string;
  scenarioId: string;
  productId: string;
  destinationId: string;
  priority: Commitment['priority'];
  quantity: number;
  scenarioStart: number;
  penaltyCurveByPriority: Record<Commitment['priority'], Commitment['penaltyCurve']>;
  tags: string[];
  rng: Rng;
}): Commitment {
  const leadHours = args.rng.int(24, 168);
  const tolerance = Math.min(args.rng.int(2, 48), leadHours);
  return {
    id: args.id,
    scenarioId: args.scenarioId,
    quantity: args.quantity,
    priority: args.priority,
    mustArriveBy: args.scenarioStart + leadHours * 3_600_000,
    delayToleranceHours: tolerance,
    penaltyCurve: args.penaltyCurveByPriority[args.priority],
    status: 'open',
    baselineRisk: 0,
    currentRisk: 0,
    requiredProductId: args.productId,
    deliveredToId: args.destinationId,
    tags: args.tags,
  };
}

function generateShipments(args: {
  scenarioId: string;
  ns: (suffix: string) => string;
  planned: PlannedCommitment[];
  products: Product[];
  locations: Location[];
  lanes: Lane[];
  shipmentCount: number;
  scenarioStart: number;
  rng: Rng;
}): { shipments: Shipment[]; fulfillments: { shipmentId: string; commitmentId: string; quantity: number }[] } {
  const groups = new Map<string, PlannedCommitment[]>();
  for (const entry of args.planned) {
    const key = [
      entry.commitment.requiredProductId,
      entry.commitment.deliveredToId,
      entry.originId,
      entry.laneSequence.join(','),
    ].join('|');
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  const chunks: PlannedCommitment[][] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += 3) chunks.push(group.slice(i, i + 3));
  }
  while (chunks.length < args.shipmentCount) {
    const splittable = chunks.find((chunk) => chunk.length > 1);
    if (!splittable) break;
    chunks.push([splittable.pop()!]);
  }

  const shipments: Shipment[] = [];
  const fulfillments: { shipmentId: string; commitmentId: string; quantity: number }[] = [];
  let shipmentCounter = 0;
  for (const chunk of chunks) {
    shipmentCounter += 1;
    const first = chunk[0]!;
    const quantity = chunk.reduce((sum, entry) => sum + entry.commitment.quantity, 0);
    const eta = args.scenarioStart + Math.round(routeTransitHours(args.lanes, first.laneSequence) * 3_600_000);
    const shipment: Shipment = {
      id: args.ns(`ship-${pad(shipmentCounter)}`),
      scenarioId: args.scenarioId,
      quantity: Math.ceil(quantity * 1.05),
      originType: 'location',
      status: 'pending',
      baselineEta: eta,
      currentEta: eta,
      currentLaneIndex: 0,
      progressFraction: 0,
      productId: first.commitment.requiredProductId,
      originId: first.originId,
      destinationId: first.commitment.deliveredToId,
      laneSequence: first.laneSequence,
    };
    shipments.push(shipment);
    for (const entry of chunk) {
      fulfillments.push({
        shipmentId: shipment.id,
        commitmentId: entry.commitment.id,
        quantity: entry.commitment.quantity,
      });
    }
  }

  while (shipments.length < args.shipmentCount) {
    shipmentCounter += 1;
    const product = args.rng.pick(args.products);
    const origin = args.rng.pick(args.locations.filter((loc) => loc.kind === 'supplier' || loc.kind === 'factory'));
    const destination = args.rng.pick(args.locations.filter((loc) => loc.kind === 'destination'));
    const path = shortestPath(args.lanes, origin.id, destination.id);
    if (!path) continue;
    const eta = args.scenarioStart + Math.round(path.totalHours * 3_600_000);
    shipments.push({
      id: args.ns(`ship-${pad(shipmentCounter)}`),
      scenarioId: args.scenarioId,
      quantity: args.rng.int(100, 1500),
      originType: 'location',
      status: 'pending',
      baselineEta: eta,
      currentEta: eta,
      currentLaneIndex: 0,
      progressFraction: 0,
      productId: product.id,
      originId: origin.id,
      destinationId: destination.id,
      laneSequence: path.laneIds,
    });
  }

  return { shipments, fulfillments };
}

function generateInventoryPools(args: {
  scenarioId: string;
  ns: (suffix: string) => string;
  locations: Location[];
  products: Product[];
  fraction: number;
  rng: Rng;
}) {
  const destinations = args.locations.filter((location) => location.kind === 'destination');
  const count = Math.max(1, Math.round(destinations.length * args.fraction));
  return args.rng.shuffle(destinations).slice(0, count).map((location, index) => {
    const product = args.rng.pick(args.products);
    return {
      id: args.ns(`inv-${pad(index + 1)}`),
      scenarioId: args.scenarioId,
      quantityOnHand: args.rng.int(1000, 8000),
      safetyStock: args.rng.int(200, 1200),
      demandUnitsPerHour: round(args.rng.float(10, 60), 2),
      storedAtId: location.id,
      productId: product.id,
      poolTransferCostPerUnit: round(args.rng.float(0.5, 4), 2),
    };
  });
}

function generateCapacityPools(args: { scenarioId: string; ns: (suffix: string) => string; locations: Location[] }) {
  return args.locations
    .filter((location) => location.kind === 'hub')
    .slice(0, 2)
    .map((location, index) => ({
      id: args.ns(`cap-${pad(index + 1)}`),
      scenarioId: args.scenarioId,
      unitsPerHour: Math.max(100, Math.round(location.capacityUnitsPerHour * 0.8)),
      scope: 'location' as const,
      constrainedEntityIds: [location.id],
    }));
}

function addLaneIfMissing(
  lanes: Lane[],
  scenarioId: string,
  source: Location,
  target: Location,
  rule: LaneRuleConfig,
  rng: Rng,
  nextLaneId: () => string,
): void {
  if (lanes.some((lane) => lane.originId === source.id && lane.destinationId === target.id && lane.mode === rule.mode)) return;
  const distance = Math.max(1, euclidean(source, target));
  lanes.push({
    id: nextLaneId(),
    scenarioId,
    originId: source.id,
    destinationId: target.id,
    mode: rule.mode,
    transitHours: round(distance / rule.speedUnitsPerHour, 2),
    capacityUnitsPerHour: round(rng.float(rule.capacityRange[0], rule.capacityRange[1]), 2),
    costPerUnit: round(distance * rule.costPerDistanceUnit, 2),
    reliability: round(rng.float(rule.reliabilityRange[0], rule.reliabilityRange[1]), 4),
    supportsColdChain: rng.next() > 0.15,
    supportsHazmat: rng.next() > 0.8,
    status: 'open',
  });
}

function samplePriority(config: ScenarioGeneratorConfig, rng: Rng): Commitment['priority'] {
  const roll = rng.next();
  let cumulative = 0;
  for (const priority of ['P0', 'P1', 'P2', 'P3'] as const) {
    cumulative += config.priorityDistribution[priority];
    if (roll <= cumulative) return priority;
  }
  return 'P3';
}

function logUniformInt(rng: Rng, min: number, max: number): number {
  const value = 10 ** rng.float(Math.log10(min), Math.log10(max));
  return Math.round(value);
}

export function scenarioIdFromSeed(seed: string): string {
  const cleaned = seed.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  return `s${cleaned || 'default'}`;
}

function hashConfig(config: ScenarioGeneratorConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

function requireMapped(map: Map<string, string>, key: string): string {
  const value = map.get(key);
  if (!value) throw new Error(`Missing mapped ID for ${key}`);
  return value;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function title(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function pad(value: number): string {
  return String(value).padStart(3, '0');
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
