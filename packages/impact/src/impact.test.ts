import { describe, expect, it } from 'vitest';
import type { Disruption, GeneratedScenario } from '@sentinel/ontology';
import { defaultDemoConfig, generateScenario } from '@sentinel/scenario-generator';
import {
  applyPenaltyCurve,
  calculateShipmentEtas,
  commitmentCompletionEta,
  runImpact,
} from './index.js';

const HOUR_MS = 3_600_000;

describe('impact engine', () => {
  it('recalculates affected shipment and commitment risk for a node closure', () => {
    const scenario = generateScenario(defaultDemoConfig);
    const fulfillment = scenario.fulfillments[0]!;
    const shipment = scenario.shipments.find((item) => item.id === fulfillment.shipmentId)!;
    const firstLane = scenario.lanes.find((lane) => lane.id === shipment.laneSequence[0])!;
    const disruption: Disruption = {
      id: `${scenario.scenario.id}:test-closure`,
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

    const impact = runImpact(scenario, [disruption], { includeUnaffected: false });
    const shipmentObservation = impact.shipmentObservations.find((item) => item.shipmentId === shipment.id);
    const commitmentObservation = impact.commitmentObservations.find((item) => item.commitmentId === fulfillment.commitmentId);

    expect(impact.summary.impactedShipmentCount).toBeGreaterThan(0);
    expect(impact.summary.impactedCommitmentCount).toBeGreaterThan(0);
    expect(shipmentObservation?.etaDeltaHours).toBeGreaterThan(300);
    expect(commitmentObservation?.affected).toBe(true);
    expect(commitmentObservation?.causePath?.at(-1)?.id).toBe(fulfillment.commitmentId);
  });

  it('uses completion ETA for partially fulfilled commitments', () => {
    const scenario = generateScenario(defaultDemoConfig);
    const commitment = { ...scenario.commitments[0]!, quantity: 100 };

    expect(commitmentCompletionEta(commitment, [
      { shipmentEta: 20, allocatedQuantity: 40 },
      { shipmentEta: 10, allocatedQuantity: 60 },
    ])).toBe(20);
  });

  it('implements the named penalty curves', () => {
    expect(applyPenaltyCurve('cliff', 0)).toBe(0);
    expect(applyPenaltyCurve('cliff', 0.01)).toBe(1);
    expect(applyPenaltyCurve('ramp', 0.25)).toBe(0.25);
    expect(applyPenaltyCurve('exponential', 1)).toBe(1);
  });

  it('orders capacity reservations by lane-entry event time so idle resources drain', () => {
    const scenario = minimalCapacityScenario();
    const etas = calculateShipmentEtas(scenario, [], { now: scenario.scenario.scenarioStart });

    expect((etas.get('s:event-1')! - scenario.scenario.scenarioStart) / HOUR_MS).toBeCloseTo(1.1, 6);
    expect((etas.get('s:event-2')! - scenario.scenario.scenarioStart) / HOUR_MS).toBeCloseTo(2, 6);
  });

  it('supports explicit queue reprioritization at a shared capacity resource', () => {
    const scenario = reprioritizedCapacityScenario();
    const baseline = runImpact(scenario, [], { now: scenario.scenario.scenarioStart, includeUnaffected: true });
    const prioritized = runImpact(scenario, [], {
      now: scenario.scenario.scenarioStart,
      includeUnaffected: true,
      resourcePriorityOverrides: {
        's:pool': ['s:ship-c', 's:ship-b', 's:ship-a'],
      },
    });

    const baselineCommitment = baseline.commitmentObservations.find((item) => item.commitmentId === 's:commitment-c')!;
    const prioritizedCommitment = prioritized.commitmentObservations.find((item) => item.commitmentId === 's:commitment-c')!;

    expect(baseline.queueObservations.some((item) => item.resourceId === 's:pool' && item.queueDelayHours > 0)).toBe(true);
    expect(baselineCommitment.atRiskAfter).toBe(true);
    expect(prioritizedCommitment.atRiskAfter).toBe(false);
    expect((prioritizedCommitment.etaDeltaHours ?? 0) < (baselineCommitment.etaDeltaHours ?? 0)).toBe(true);
  });
});

function minimalCapacityScenario(): GeneratedScenario {
  const scenarioStart = 1_700_000_000_000;
  return {
    scenario: {
      id: 's',
      seed: 'event',
      name: 'Event ordering',
      scenarioStart,
      createdAt: scenarioStart,
      version: 0,
      generatorConfigHash: 'test',
    },
    locations: [
      location('s:o1', 'supplier'),
      location('s:o2', 'supplier'),
      location('s:h', 'hub'),
      location('s:d', 'destination'),
    ],
    lanes: [
      lane('s:l1', 's:o1', 's:h', 0.1, 1000),
      lane('s:l2', 's:o2', 's:h', 1, 1000),
      lane('s:l3', 's:h', 's:d', 1, 100),
    ],
    products: [
      {
        id: 's:p',
        scenarioId: 's',
        name: 'Product',
        requiresColdChain: false,
        requiresHazmat: false,
        shelfLifeHours: null,
      },
    ],
    substitutionGroups: [],
    commitments: [],
    shipments: [
      shipment('s:event-1', ['s:l1', 's:l3'], scenarioStart),
      shipment('s:event-2', ['s:l2', 's:l3'], scenarioStart),
    ],
    fulfillments: [],
    inventoryPools: [],
    capacityPools: [],
    produces: [{ locationId: 's:o1', productId: 's:p' }],
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
      reprioLocation('s:o1', 'supplier', 0),
      reprioLocation('s:o2', 'supplier', 0.5),
      reprioLocation('s:o3', 'supplier', 1),
      reprioLocation('s:d', 'destination', 0),
    ],
    lanes: [
      lane('s:l1', 's:o1', 's:d', 0, 500),
      lane('s:l2', 's:o2', 's:d', 0, 500),
      lane('s:l3', 's:o3', 's:d', 0, 500),
    ],
    products: [
      {
        id: 's:p',
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
      shipmentWithOrigin('s:ship-a', 's:o1', 200, ['s:l1'], scenarioStart),
      shipmentWithOrigin('s:ship-b', 's:o2', 100, ['s:l2'], scenarioStart),
      shipmentWithOrigin('s:ship-c', 's:o3', 100, ['s:l3'], scenarioStart),
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
      { locationId: 's:o1', productId: 's:p' },
      { locationId: 's:o2', productId: 's:p' },
      { locationId: 's:o3', productId: 's:p' },
    ],
  };
}

function location(id: string, kind: 'supplier' | 'hub' | 'destination') {
  return {
    id,
    scenarioId: 's',
    kind,
    name: id,
    x: 0,
    y: 0,
    handlingTimeHours: 0,
    capacityUnitsPerHour: 1000,
    status: 'open' as const,
    tags: [],
  };
}

function reprioLocation(id: string, kind: 'supplier' | 'destination', handlingTimeHours: number) {
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

function shipment(id: string, laneSequence: string[], scenarioStart: number) {
  return {
    id,
    scenarioId: 's',
    quantity: 50,
    originType: 'location' as const,
    status: 'pending' as const,
    baselineEta: scenarioStart,
    currentEta: scenarioStart,
    currentLaneIndex: 0,
    progressFraction: 0,
    productId: 's:p',
    originId: laneSequence[0] === 's:l1' ? 's:o1' : 's:o2',
    destinationId: 's:d',
    laneSequence,
  };
}

function shipmentWithOrigin(
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
    productId: 's:p',
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
    requiredProductId: 's:p',
    deliveredToId: 's:d',
    tags: [],
  };
}
