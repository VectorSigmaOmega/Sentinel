import { describe, expect, it } from 'vitest';
import { defaultDemoConfig } from './config.js';
import { generateScenario } from './generator.js';
import { countEdgeDisjointPaths } from './graph.js';
import { validateScenario } from './validation.js';

describe('scenario generator', () => {
  it('is deterministic for the same seed', () => {
    const first = generateScenario(defaultDemoConfig);
    const second = generateScenario(defaultDemoConfig);
    expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
  });

  it('namespaces generated IDs so multiple scenarios can coexist', () => {
    const first = generateScenario({ ...defaultDemoConfig, seed: '42' });
    const second = generateScenario({ ...defaultDemoConfig, seed: '99' });
    const firstIds = allEntityIds(first);
    const secondIds = allEntityIds(second);

    expect([...firstIds].every((id) => id.startsWith('s42:'))).toBe(true);
    expect([...secondIds].every((id) => id.startsWith('s99:'))).toBe(true);
    expect([...firstIds].some((id) => secondIds.has(id))).toBe(false);
  });

  it('generates a graph that satisfies core ontology invariants', () => {
    const scenario = generateScenario(defaultDemoConfig);
    const validation = validateScenario(scenario);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it('fully allocates every commitment without over-allocating shipments', () => {
    const scenario = generateScenario(defaultDemoConfig);
    for (const commitment of scenario.commitments) {
      const allocated = scenario.fulfillments
        .filter((fulfillment) => fulfillment.commitmentId === commitment.id)
        .reduce((sum, fulfillment) => sum + fulfillment.quantity, 0);
      expect(allocated).toBe(commitment.quantity);
    }

    for (const shipment of scenario.shipments) {
      const allocated = scenario.fulfillments
        .filter((fulfillment) => fulfillment.shipmentId === shipment.id)
        .reduce((sum, fulfillment) => sum + fulfillment.quantity, 0);
      expect(allocated).toBeLessThanOrEqual(shipment.quantity);
    }
  });

  it('creates redundant paths for hero commitments', () => {
    const scenario = generateScenario(defaultDemoConfig);
    const shipmentById = new Map(scenario.shipments.map((shipment) => [shipment.id, shipment]));
    for (const commitment of scenario.commitments.filter((item) => item.tags.includes('hero'))) {
      const min = Number(commitment.tags.find((tag) => tag.startsWith('minDisjointPaths:'))?.split(':')[1] ?? 2);
      const fulfillment = scenario.fulfillments.find((item) => item.commitmentId === commitment.id);
      expect(fulfillment).toBeDefined();
      const shipment = shipmentById.get(fulfillment!.shipmentId);
      expect(shipment).toBeDefined();
      expect(countEdgeDisjointPaths(scenario.lanes, shipment!.originId, commitment.deliveredToId)).toBeGreaterThanOrEqual(min);
    }
  });
});

function allEntityIds(scenario: ReturnType<typeof generateScenario>): Set<string> {
  return new Set([
    ...scenario.locations.map((item) => item.id),
    ...scenario.lanes.map((item) => item.id),
    ...scenario.products.map((item) => item.id),
    ...scenario.substitutionGroups.map((item) => item.id),
    ...scenario.commitments.map((item) => item.id),
    ...scenario.shipments.map((item) => item.id),
    ...scenario.inventoryPools.map((item) => item.id),
    ...scenario.capacityPools.map((item) => item.id),
  ]);
}
