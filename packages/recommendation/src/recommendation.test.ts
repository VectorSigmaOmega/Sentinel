import { describe, expect, it } from 'vitest';
import type { Disruption, GeneratedScenario } from '@sentinel/ontology';
import { defaultDemoConfig, generateScenario } from '@sentinel/scenario-generator';
import { generateRecommendationRun } from './index.js';

const HOUR_MS = 3_600_000;

describe('recommendation engine', () => {
  it('generates reroute actions for a disruptive node closure', () => {
    const scenario = generateScenario(defaultDemoConfig);
    const shipment = scenario.shipments.find((item) => item.laneSequence.length > 0)!;
    const firstLane = scenario.lanes.find((lane) => lane.id === shipment.laneSequence[0])!;
    const disruption: Disruption = {
      id: `${scenario.scenario.id}:closure`,
      scenarioId: scenario.scenario.id,
      type: 'node_closure',
      targetKind: 'Location',
      targetId: firstLane.originId,
      startsAt: scenario.scenario.scenarioStart,
      endsAt: scenario.scenario.scenarioStart + 14 * 24 * HOUR_MS,
      severity: 1,
      effects: [{ kind: 'closure' }],
      status: 'active',
    };

    const run = generateRecommendationRun(scenario, [disruption], {
      objective: 'protect_p0',
      includeImpactRuns: true,
      maxCandidates: 10,
    });

    expect(run.actions.length).toBeGreaterThan(0);
    expect(run.actions.some((item) => item.action.type === 'reroute')).toBe(true);
    expect(run.summary.bestActionId).toBe(run.actions[0]?.action.id ?? null);
  });

  it('generates inventory reallocations that can save a delayed commitment', () => {
    const scenario = inventoryScenario();
    const run = generateRecommendationRun(scenario, [], {
      includeImpactRuns: true,
      enableReroute: false,
    });

    const action = run.actions.find((item) => item.action.type === 'reallocate_inventory');
    expect(action).toBeTruthy();
    expect(action?.commitmentsSaved).toContain('s:commitment');
    expect(action?.impact?.summary.atRiskCommitmentCountAfter).toBe(0);
  });

  it('generates capacity reprioritization candidates that improve priority outcomes', () => {
    const scenario = reprioritizedCapacityScenario();
    const run = generateRecommendationRun(scenario, [], {
      includeImpactRuns: true,
      enableReroute: false,
      enableInventoryReallocation: false,
    });

    const action = run.actions.find((item) => item.action.type === 'reprioritize_capacity');
    expect(action).toBeTruthy();
    expect(action?.commitmentsSaved).toContain('s:commitment-c');
    const commitment = action?.impact?.commitmentObservations.find((item) => item.commitmentId === 's:commitment-c');
    expect(commitment?.atRiskAfter).toBe(false);
  });
});

function inventoryScenario(): GeneratedScenario {
  const scenarioStart = 1_700_000_000_000;
  return {
    scenario: {
      id: 's',
      seed: 'inventory',
      name: 'Inventory save',
      scenarioStart,
      createdAt: scenarioStart,
      version: 0,
      generatorConfigHash: 'test',
    },
    locations: [
      {
        id: 's:supplier',
        scenarioId: 's',
        kind: 'supplier',
        name: 'Supplier',
        x: 0,
        y: 0,
        handlingTimeHours: 0,
        capacityUnitsPerHour: 1000,
        status: 'open',
        tags: [],
      },
      {
        id: 's:destination',
        scenarioId: 's',
        kind: 'destination',
        name: 'Destination',
        x: 1,
        y: 1,
        handlingTimeHours: 0,
        capacityUnitsPerHour: 1000,
        status: 'open',
        tags: [],
      },
    ],
    lanes: [
      {
        id: 's:lane',
        scenarioId: 's',
        originId: 's:supplier',
        destinationId: 's:destination',
        mode: 'truck',
        transitHours: 30,
        capacityUnitsPerHour: 500,
        costPerUnit: 1,
        reliability: 0.99,
        supportsColdChain: true,
        supportsHazmat: true,
        status: 'open',
      },
    ],
    products: [
      {
        id: 's:product',
        scenarioId: 's',
        name: 'Product',
        requiresColdChain: false,
        requiresHazmat: false,
        shelfLifeHours: null,
      },
    ],
    substitutionGroups: [],
    commitments: [
      {
        id: 's:commitment',
        scenarioId: 's',
        quantity: 100,
        priority: 'P0',
        mustArriveBy: scenarioStart + 10 * HOUR_MS,
        delayToleranceHours: 5,
        penaltyCurve: 'ramp',
        status: 'open',
        baselineRisk: 0,
        currentRisk: 0,
        requiredProductId: 's:product',
        deliveredToId: 's:destination',
        tags: [],
      },
    ],
    shipments: [
      {
        id: 's:shipment',
        scenarioId: 's',
        quantity: 100,
        originType: 'location',
        status: 'pending',
        baselineEta: scenarioStart + 30 * HOUR_MS,
        currentEta: scenarioStart + 30 * HOUR_MS,
        currentLaneIndex: 0,
        progressFraction: 0,
        productId: 's:product',
        originId: 's:supplier',
        destinationId: 's:destination',
        laneSequence: ['s:lane'],
      },
    ],
    fulfillments: [
      {
        shipmentId: 's:shipment',
        commitmentId: 's:commitment',
        quantity: 100,
      },
    ],
    inventoryPools: [
      {
        id: 's:pool',
        scenarioId: 's',
        quantityOnHand: 250,
        safetyStock: 50,
        demandUnitsPerHour: 0,
        storedAtId: 's:destination',
        productId: 's:product',
        poolTransferCostPerUnit: 2,
      },
    ],
    capacityPools: [],
    produces: [
      {
        locationId: 's:supplier',
        productId: 's:product',
      },
    ],
  };
}

function reprioritizedCapacityScenario(): GeneratedScenario {
  const scenarioStart = 1_700_000_000_000;
  return {
    scenario: {
      id: 's',
      seed: 'reprioritize',
      name: 'Capacity reprioritization',
      scenarioStart,
      createdAt: scenarioStart,
      version: 0,
      generatorConfigHash: 'test',
    },
    locations: [
      location('s:o1', 'supplier', 0),
      location('s:o2', 'supplier', 0.5),
      location('s:o3', 'supplier', 1),
      location('s:d', 'destination', 0),
    ],
    lanes: [
      lane('s:l1', 's:o1', 's:d', 0, 500),
      lane('s:l2', 's:o2', 's:d', 0, 500),
      lane('s:l3', 's:o3', 's:d', 0, 500),
    ],
    products: [
      {
        id: 's:product',
        scenarioId: 's',
        name: 'Product',
        requiresColdChain: false,
        requiresHazmat: false,
        shelfLifeHours: null,
      },
    ],
    substitutionGroups: [],
    commitments: [
      commitment('s:commitment-b', 'P3', scenarioStart + 10 * HOUR_MS, 2),
      commitment('s:commitment-c', 'P0', scenarioStart + 2.5 * HOUR_MS, 1),
    ],
    shipments: [
      shipment('s:ship-a', 's:o1', 200, ['s:l1'], scenarioStart),
      shipment('s:ship-b', 's:o2', 100, ['s:l2'], scenarioStart),
      shipment('s:ship-c', 's:o3', 100, ['s:l3'], scenarioStart),
    ],
    fulfillments: [
      { shipmentId: 's:ship-b', commitmentId: 's:commitment-b', quantity: 100 },
      { shipmentId: 's:ship-c', commitmentId: 's:commitment-c', quantity: 100 },
    ],
    inventoryPools: [],
    capacityPools: [
      {
        id: 's:pool',
        scenarioId: 's',
        unitsPerHour: 100,
        scope: 'location',
        constrainedEntityIds: ['s:d'],
      },
    ],
    produces: [
      { locationId: 's:o1', productId: 's:product' },
      { locationId: 's:o2', productId: 's:product' },
      { locationId: 's:o3', productId: 's:product' },
    ],
  };
}

function location(id: string, kind: 'supplier' | 'destination', handlingTimeHours: number) {
  return {
    id,
    scenarioId: 's',
    kind,
    name: id,
    x: 0,
    y: 0,
    handlingTimeHours,
    capacityUnitsPerHour: 1000,
    status: 'open' as const,
    tags: [],
  };
}

function lane(id: string, originId: string, destinationId: string, transitHours: number, capacityUnitsPerHour: number) {
  return {
    id,
    scenarioId: 's',
    originId,
    destinationId,
    mode: 'truck' as const,
    transitHours,
    capacityUnitsPerHour,
    costPerUnit: 1,
    reliability: 0.99,
    supportsColdChain: true,
    supportsHazmat: true,
    status: 'open' as const,
  };
}

function shipment(
  id: string,
  originId: string,
  quantity: number,
  laneSequence: string[],
  scenarioStart: number,
) {
  return {
    id,
    scenarioId: 's',
    quantity,
    originType: 'location' as const,
    status: 'pending' as const,
    baselineEta: scenarioStart,
    currentEta: scenarioStart,
    currentLaneIndex: 0,
    progressFraction: 0,
    productId: 's:product',
    originId,
    destinationId: 's:d',
    laneSequence,
  };
}

function commitment(id: string, priority: 'P0' | 'P3', mustArriveBy: number, delayToleranceHours: number) {
  return {
    id,
    scenarioId: 's',
    quantity: 100,
    priority,
    mustArriveBy,
    delayToleranceHours,
    penaltyCurve: 'ramp' as const,
    status: 'open' as const,
    baselineRisk: 0,
    currentRisk: 0,
    requiredProductId: 's:product',
    deliveredToId: 's:d',
    tags: [],
  };
}
