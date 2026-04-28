import { describe, expect, it } from 'vitest';
import type { Disruption } from '@sentinel/ontology';
import { defaultDemoConfig, generateScenario } from '@sentinel/scenario-generator';
import {
  buildRoutingProjection,
  computeExclusionsFromDisruptions,
  dijkstraRoute,
  generateRerouteCandidates,
  isLaneExcluded,
  kShortestRoutes,
} from './index.js';

describe('routing', () => {
  it('finds a compatible route for a generated shipment', () => {
    const scenario = generateScenario(defaultDemoConfig);
    const projection = buildRoutingProjection(scenario);
    const shipment = scenario.shipments.find((item) => item.laneSequence.length > 0)!;
    const route = dijkstraRoute(projection, shipment.originId, shipment.destinationId, { shipment });

    expect(route).not.toBeNull();
    expect(route!.laneIds.length).toBeGreaterThan(0);
    expect(route!.locationIds[0]).toBe(shipment.originId);
    expect(route!.locationIds.at(-1)).toBe(shipment.destinationId);
  });

  it('computes node closure exclusions for all incident lanes', () => {
    const scenario = generateScenario(defaultDemoConfig);
    const projection = buildRoutingProjection(scenario);
    const hub = scenario.locations.find((item) => item.kind === 'hub')!;
    const disruption = closureDisruption(scenario.scenario.id, hub.id);
    const exclusions = computeExclusionsFromDisruptions([disruption]);
    const incident = scenario.lanes.filter((lane) => lane.originId === hub.id || lane.destinationId === hub.id);

    expect(exclusions.locationIds.has(hub.id)).toBe(true);
    expect(incident.length).toBeGreaterThan(0);
    expect(incident.every((lane) => isLaneExcluded(lane, exclusions))).toBe(true);
    expect(scenario.lanes.filter((lane) => !isLaneExcluded(lane, exclusions)).length).toBeLessThan(scenario.lanes.length);
    expect(projection.lanesById.size).toBe(scenario.lanes.length);
  });

  it('returns k unique paths when alternatives exist', () => {
    const scenario = generateScenario(defaultDemoConfig);
    const projection = buildRoutingProjection(scenario);
    const shipment = scenario.shipments.find((item) => item.laneSequence.length >= 3)!;
    const routes = kShortestRoutes(projection, shipment.originId, shipment.destinationId, { shipment }, 3);
    const unique = new Set(routes.map((route) => route.laneIds.join(',')));

    expect(routes.length).toBeGreaterThan(0);
    expect(unique.size).toBe(routes.length);
  });

  it('generates reroutes that avoid a closed node', () => {
    const scenario = generateScenario(defaultDemoConfig);
    const projection = buildRoutingProjection(scenario);
    const shipment = scenario.shipments.find((item) => {
      const lanes = item.laneSequence.map((laneId) => projection.lanesById.get(laneId)!);
      return lanes.some((lane) => scenario.locations.find((loc) => loc.id === lane.destinationId)?.kind === 'hub');
    })!;
    const closedHubId = shipment.laneSequence
      .map((laneId) => projection.lanesById.get(laneId)!)
      .map((lane) => scenario.locations.find((loc) => loc.id === lane.destinationId))
      .find((loc) => loc?.kind === 'hub')!.id;
    const exclusions = computeExclusionsFromDisruptions([closureDisruption(scenario.scenario.id, closedHubId)]);
    const candidates = generateRerouteCandidates(projection, shipment, { exclusions }, 3);

    for (const candidate of candidates) {
      expect(candidate.path.locationIds.includes(closedHubId)).toBe(false);
    }
  });
});

function closureDisruption(scenarioId: string, locationId: string): Disruption {
  return {
    id: `${scenarioId}:disruption-test`,
    scenarioId,
    type: 'node_closure',
    targetKind: 'Location',
    targetId: locationId,
    startsAt: 0,
    endsAt: 1,
    severity: 1,
    effects: [{ kind: 'closure' }],
    status: 'active',
  };
}
