import type { GeneratedScenario, Product } from '@sentinel/ontology';
import { countEdgeDisjointPaths, hasPath } from './graph.js';

export type ScenarioValidationResult = {
  valid: boolean;
  errors: string[];
};

const EPSILON = 0.000001;

export function validateScenario(scenario: GeneratedScenario): ScenarioValidationResult {
  const errors: string[] = [];
  const locationById = new Map(scenario.locations.map((item) => [item.id, item]));
  const productById = new Map(scenario.products.map((item) => [item.id, item]));
  const commitmentById = new Map(scenario.commitments.map((item) => [item.id, item]));
  const shipmentById = new Map(scenario.shipments.map((item) => [item.id, item]));
  const producedByProduct = new Map<string, string[]>();

  checkUnique('Location', scenario.locations.map((item) => item.id), errors);
  checkUnique('Lane', scenario.lanes.map((item) => item.id), errors);
  checkUnique('Product', scenario.products.map((item) => item.id), errors);
  checkUnique('Commitment', scenario.commitments.map((item) => item.id), errors);
  checkUnique('Shipment', scenario.shipments.map((item) => item.id), errors);

  for (const id of [
    ...scenario.locations.map((item) => item.id),
    ...scenario.lanes.map((item) => item.id),
    ...scenario.products.map((item) => item.id),
    ...scenario.commitments.map((item) => item.id),
    ...scenario.shipments.map((item) => item.id),
  ]) {
    if (!id.startsWith(`${scenario.scenario.id}:`)) {
      errors.push(`ID is not scenario-namespaced: ${id}`);
    }
  }

  for (const entry of scenario.produces) {
    const list = producedByProduct.get(entry.productId) ?? [];
    list.push(entry.locationId);
    producedByProduct.set(entry.productId, list);
  }

  const fulfillmentByCommitment = new Map<string, number>();
  const fulfillmentByShipment = new Map<string, number>();
  for (const fulfillment of scenario.fulfillments) {
    const shipment = shipmentById.get(fulfillment.shipmentId);
    const commitment = commitmentById.get(fulfillment.commitmentId);
    if (!shipment || !commitment) {
      errors.push(`Fulfillment references missing shipment or commitment: ${fulfillment.shipmentId} -> ${fulfillment.commitmentId}`);
      continue;
    }
    if (shipment.destinationId !== commitment.deliveredToId) {
      errors.push(`Fulfillment destination mismatch: ${shipment.id} -> ${commitment.id}`);
    }
    const shipmentProduct = productById.get(shipment.productId);
    const commitmentProduct = productById.get(commitment.requiredProductId);
    if (!shipmentProduct || !commitmentProduct || !areProductsCompatible(shipmentProduct, commitmentProduct, scenario)) {
      errors.push(`Fulfillment product mismatch: ${shipment.id} -> ${commitment.id}`);
    }
    fulfillmentByCommitment.set(
      commitment.id,
      (fulfillmentByCommitment.get(commitment.id) ?? 0) + fulfillment.quantity,
    );
    fulfillmentByShipment.set(
      shipment.id,
      (fulfillmentByShipment.get(shipment.id) ?? 0) + fulfillment.quantity,
    );
  }

  for (const commitment of scenario.commitments) {
    const allocated = fulfillmentByCommitment.get(commitment.id) ?? 0;
    if (Math.abs(allocated - commitment.quantity) > EPSILON) {
      errors.push(`Commitment ${commitment.id} allocation ${allocated} != quantity ${commitment.quantity}`);
    }
    const producers = producedByProduct.get(commitment.requiredProductId) ?? [];
    if (producers.length === 0) {
      errors.push(`Commitment ${commitment.id} product has no producer`);
    }
    if (!producers.some((originId) => hasPath(scenario.lanes, originId, commitment.deliveredToId))) {
      errors.push(`Commitment ${commitment.id} has no reachable producer`);
    }
    const minPathTag = commitment.tags.find((tag) => tag.startsWith('minDisjointPaths:'));
    if (minPathTag) {
      const min = Number(minPathTag.split(':')[1]);
      const shipment = scenario.fulfillments
        .filter((fulfillment) => fulfillment.commitmentId === commitment.id)
        .map((fulfillment) => shipmentById.get(fulfillment.shipmentId))
        .find((item): item is NonNullable<typeof item> => Boolean(item));
      if (shipment && countEdgeDisjointPaths(scenario.lanes, shipment.originId, commitment.deliveredToId) < min) {
        errors.push(`Hero commitment ${commitment.id} has fewer than ${min} edge-disjoint paths`);
      }
    }
  }

  for (const shipment of scenario.shipments) {
    const allocated = fulfillmentByShipment.get(shipment.id) ?? 0;
    if (allocated - shipment.quantity > EPSILON) {
      errors.push(`Shipment ${shipment.id} is over-allocated: ${allocated} > ${shipment.quantity}`);
    }
  }

  const origins = scenario.locations.filter((item) => item.kind === 'supplier' || item.kind === 'factory');
  for (const destination of scenario.locations.filter((item) => item.kind === 'destination')) {
    if (!origins.some((origin) => hasPath(scenario.lanes, origin.id, destination.id))) {
      errors.push(`Destination ${destination.id} is unreachable from all origins`);
    }
  }

  for (const lane of scenario.lanes) {
    if (!locationById.has(lane.originId) || !locationById.has(lane.destinationId)) {
      errors.push(`Lane ${lane.id} references missing endpoint`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function areProductsCompatible(a: Product, b: Product, scenario: GeneratedScenario): boolean {
  if (a.id === b.id) return true;
  return scenario.substitutionGroups.some((group) => group.productIds.includes(a.id) && group.productIds.includes(b.id));
}

function checkUnique(label: string, ids: string[], errors: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) errors.push(`${label} ID is duplicated: ${id}`);
    seen.add(id);
  }
}
