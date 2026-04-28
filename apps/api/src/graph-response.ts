import type { GeneratedScenario } from '@sentinel/ontology';

export type GraphNode = {
  id: string;
  label: string;
  kind?: string;
  name?: string;
  properties: Record<string, unknown>;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  type: string;
  properties?: Record<string, unknown>;
};

export type ScenarioGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export function buildScenarioGraph(scenario: GeneratedScenario): ScenarioGraph {
  const nodes: GraphNode[] = [
    ...scenario.locations.map((entity) => node(entity.id, 'Location', entity.kind, entity.name, entity)),
    ...scenario.lanes.map((entity) => node(entity.id, 'Lane', entity.mode, undefined, entity)),
    ...scenario.products.map((entity) => node(entity.id, 'Product', undefined, entity.name, entity)),
    ...scenario.substitutionGroups.map((entity) => node(entity.id, 'SubstitutionGroup', undefined, entity.name, entity)),
    ...scenario.shipments.map((entity) => node(entity.id, 'Shipment', entity.status, undefined, entity)),
    ...scenario.commitments.map((entity) => node(entity.id, 'Commitment', entity.priority, undefined, entity)),
    ...scenario.inventoryPools.map((entity) => node(entity.id, 'InventoryPool', undefined, undefined, entity)),
    ...scenario.capacityPools.map((entity) => node(entity.id, 'CapacityPool', entity.scope, undefined, entity)),
  ];

  const edges: GraphEdge[] = [];
  for (const lane of scenario.lanes) {
    edges.push(edge(lane.originId, lane.id, 'LANE_START'));
    edges.push(edge(lane.id, lane.destinationId, 'LANE_END'));
  }
  for (const entry of scenario.produces) edges.push(edge(entry.locationId, entry.productId, 'PRODUCES'));
  for (const shipment of scenario.shipments) {
    edges.push(edge(shipment.id, shipment.originId, 'ORIGIN'));
    edges.push(edge(shipment.id, shipment.destinationId, 'DESTINATION'));
    edges.push(edge(shipment.id, shipment.productId, 'CONTAINS'));
    shipment.laneSequence.forEach((laneId, sequence) => edges.push(edge(shipment.id, laneId, 'USES_LANE', { sequence })));
  }
  for (const fulfillment of scenario.fulfillments) {
    edges.push(edge(fulfillment.shipmentId, fulfillment.commitmentId, 'FULFILLS', { quantity: fulfillment.quantity }));
  }
  for (const commitment of scenario.commitments) {
    edges.push(edge(commitment.id, commitment.requiredProductId, 'REQUIRES'));
    edges.push(edge(commitment.id, commitment.deliveredToId, 'DELIVERS_TO'));
  }
  for (const group of scenario.substitutionGroups) {
    for (const productId of group.productIds) edges.push(edge(productId, group.id, 'MEMBER_OF'));
  }
  for (const pool of scenario.inventoryPools) {
    edges.push(edge(pool.id, pool.storedAtId, 'STORED_AT'));
    edges.push(edge(pool.id, pool.productId, 'OF_PRODUCT'));
  }
  for (const pool of scenario.capacityPools) {
    for (const id of pool.constrainedEntityIds) edges.push(edge(pool.id, id, 'CONSTRAINS'));
  }

  return { nodes, edges };
}

function node(
  id: string,
  label: string,
  kind: string | undefined,
  name: string | undefined,
  properties: Record<string, unknown>,
): GraphNode {
  return {
    id,
    label,
    ...(kind ? { kind } : {}),
    ...(name ? { name } : {}),
    properties,
  };
}

function edge(source: string, target: string, type: string, properties?: Record<string, unknown>): GraphEdge {
  return {
    id: `${source}:${type}:${target}:${JSON.stringify(properties ?? {})}`,
    source,
    target,
    type,
    ...(properties ? { properties } : {}),
  };
}
