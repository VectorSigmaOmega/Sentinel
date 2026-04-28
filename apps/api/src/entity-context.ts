import type { GeneratedScenario } from '@sentinel/ontology';

export type EntityLabel =
  | 'Location'
  | 'Lane'
  | 'Product'
  | 'SubstitutionGroup'
  | 'Shipment'
  | 'Commitment'
  | 'InventoryPool'
  | 'CapacityPool'
  | 'Scenario';

export type EntityRef = {
  id: string;
  label: EntityLabel;
  relationship: string;
  direction: 'upstream' | 'downstream' | 'self';
  name?: string;
  kind?: string;
  properties?: Record<string, unknown>;
};

export type EntityLookupResult = {
  id: string;
  label: EntityLabel;
  entity: unknown;
};

export type EntityContext = {
  entity: EntityLookupResult;
  upstream: EntityRef[];
  downstream: EntityRef[];
};

export function getEntity(scenario: GeneratedScenario, entityId: string): EntityLookupResult | null {
  if (scenario.scenario.id === entityId) return { id: entityId, label: 'Scenario', entity: scenario.scenario };

  const collections = [
    ['Location', scenario.locations],
    ['Lane', scenario.lanes],
    ['Product', scenario.products],
    ['SubstitutionGroup', scenario.substitutionGroups],
    ['Shipment', scenario.shipments],
    ['Commitment', scenario.commitments],
    ['InventoryPool', scenario.inventoryPools],
    ['CapacityPool', scenario.capacityPools],
  ] as const;

  for (const [label, items] of collections) {
    const entity = items.find((item) => item.id === entityId);
    if (entity) return { id: entityId, label, entity };
  }
  return null;
}

export function getEntityContext(scenario: GeneratedScenario, entityId: string): EntityContext | null {
  const found = getEntity(scenario, entityId);
  if (!found) return null;

  const refs = refFactory(scenario);
  switch (found.label) {
    case 'Commitment': {
      const commitment = scenario.commitments.find((item) => item.id === entityId)!;
      const fulfillments = scenario.fulfillments.filter((item) => item.commitmentId === commitment.id);
      return {
        entity: found,
        upstream: [
          ...fulfillments.map((fulfillment) =>
            refs.shipment(fulfillment.shipmentId, 'FULFILLS', 'upstream', { quantity: fulfillment.quantity }),
          ),
          refs.product(commitment.requiredProductId, 'REQUIRES', 'upstream'),
        ].filter(isRef),
        downstream: [refs.location(commitment.deliveredToId, 'DELIVERS_TO', 'downstream')].filter(isRef),
      };
    }
    case 'Shipment': {
      const shipment = scenario.shipments.find((item) => item.id === entityId)!;
      const fulfillments = scenario.fulfillments.filter((item) => item.shipmentId === shipment.id);
      return {
        entity: found,
        upstream: [
          refs.location(shipment.originId, 'ORIGIN', 'upstream'),
          ...shipment.laneSequence.map((laneId, sequence) =>
            refs.lane(laneId, 'USES_LANE', 'upstream', { sequence }),
          ),
        ].filter(isRef),
        downstream: [
          refs.location(shipment.destinationId, 'DESTINATION', 'downstream'),
          refs.product(shipment.productId, 'CONTAINS', 'downstream'),
          ...fulfillments.map((fulfillment) =>
            refs.commitment(fulfillment.commitmentId, 'FULFILLS', 'downstream', { quantity: fulfillment.quantity }),
          ),
        ].filter(isRef),
      };
    }
    case 'Lane': {
      const lane = scenario.lanes.find((item) => item.id === entityId)!;
      return {
        entity: found,
        upstream: [refs.location(lane.originId, 'LANE_START', 'upstream')].filter(isRef),
        downstream: [
          refs.location(lane.destinationId, 'LANE_END', 'downstream'),
          ...scenario.shipments
            .filter((shipment) => shipment.laneSequence.includes(lane.id))
            .map((shipment) => refs.shipment(shipment.id, 'USES_LANE', 'downstream')),
        ].filter(isRef),
      };
    }
    case 'Location': {
      const locationId = entityId;
      return {
        entity: found,
        upstream: [
          ...scenario.lanes
            .filter((lane) => lane.destinationId === locationId)
            .map((lane) => refs.lane(lane.id, 'LANE_END', 'upstream')),
          ...scenario.produces
            .filter((entry) => entry.locationId === locationId)
            .map((entry) => refs.product(entry.productId, 'PRODUCES', 'upstream')),
          ...scenario.inventoryPools
            .filter((pool) => pool.storedAtId === locationId)
            .map((pool) => refs.inventoryPool(pool.id, 'STORED_AT', 'upstream')),
        ].filter(isRef),
        downstream: [
          ...scenario.lanes
            .filter((lane) => lane.originId === locationId)
            .map((lane) => refs.lane(lane.id, 'LANE_START', 'downstream')),
          ...scenario.commitments
            .filter((commitment) => commitment.deliveredToId === locationId)
            .map((commitment) => refs.commitment(commitment.id, 'DELIVERS_TO', 'downstream')),
          ...scenario.shipments
            .filter((shipment) => shipment.originId === locationId)
            .map((shipment) => refs.shipment(shipment.id, 'ORIGIN', 'downstream')),
        ].filter(isRef),
      };
    }
    case 'Product': {
      const productId = entityId;
      return {
        entity: found,
        upstream: [
          ...scenario.produces
            .filter((entry) => entry.productId === productId)
            .map((entry) => refs.location(entry.locationId, 'PRODUCES', 'upstream')),
          ...scenario.substitutionGroups
            .filter((group) => group.productIds.includes(productId))
            .map((group) => refs.substitutionGroup(group.id, 'MEMBER_OF', 'upstream')),
        ].filter(isRef),
        downstream: [
          ...scenario.commitments
            .filter((commitment) => commitment.requiredProductId === productId)
            .map((commitment) => refs.commitment(commitment.id, 'REQUIRES', 'downstream')),
          ...scenario.shipments
            .filter((shipment) => shipment.productId === productId)
            .map((shipment) => refs.shipment(shipment.id, 'CONTAINS', 'downstream')),
          ...scenario.inventoryPools
            .filter((pool) => pool.productId === productId)
            .map((pool) => refs.inventoryPool(pool.id, 'OF_PRODUCT', 'downstream')),
        ].filter(isRef),
      };
    }
    case 'InventoryPool': {
      const pool = scenario.inventoryPools.find((item) => item.id === entityId)!;
      return {
        entity: found,
        upstream: [
          refs.location(pool.storedAtId, 'STORED_AT', 'upstream'),
          refs.product(pool.productId, 'OF_PRODUCT', 'upstream'),
        ].filter(isRef),
        downstream: [],
      };
    }
    case 'CapacityPool': {
      const pool = scenario.capacityPools.find((item) => item.id === entityId)!;
      return {
        entity: found,
        upstream: [],
        downstream: pool.constrainedEntityIds.map((id) =>
          pool.scope === 'location'
            ? refs.location(id, 'CONSTRAINS', 'downstream')
            : refs.lane(id, 'CONSTRAINS', 'downstream'),
        ).filter(isRef),
      };
    }
    case 'SubstitutionGroup': {
      const group = scenario.substitutionGroups.find((item) => item.id === entityId)!;
      return {
        entity: found,
        upstream: [],
        downstream: group.productIds.map((id) => refs.product(id, 'MEMBER_OF', 'downstream')).filter(isRef),
      };
    }
    case 'Scenario':
      return { entity: found, upstream: [], downstream: [] };
  }
}

function refFactory(scenario: GeneratedScenario) {
  const make = (
    id: string,
    label: EntityLabel,
    relationship: string,
    direction: EntityRef['direction'],
    properties?: Record<string, unknown>,
  ): EntityRef | null => {
    const found = getEntity(scenario, id);
    if (!found) return null;
    const entity = found.entity as { name?: string; kind?: string };
    return {
      id,
      label,
      relationship,
      direction,
      ...(entity.name ? { name: entity.name } : {}),
      ...(entity.kind ? { kind: entity.kind } : {}),
      ...(properties ? { properties } : {}),
    };
  };
  return {
    location: (id: string, rel: string, dir: EntityRef['direction'], props?: Record<string, unknown>) =>
      make(id, 'Location', rel, dir, props),
    lane: (id: string, rel: string, dir: EntityRef['direction'], props?: Record<string, unknown>) =>
      make(id, 'Lane', rel, dir, props),
    product: (id: string, rel: string, dir: EntityRef['direction'], props?: Record<string, unknown>) =>
      make(id, 'Product', rel, dir, props),
    substitutionGroup: (id: string, rel: string, dir: EntityRef['direction'], props?: Record<string, unknown>) =>
      make(id, 'SubstitutionGroup', rel, dir, props),
    shipment: (id: string, rel: string, dir: EntityRef['direction'], props?: Record<string, unknown>) =>
      make(id, 'Shipment', rel, dir, props),
    commitment: (id: string, rel: string, dir: EntityRef['direction'], props?: Record<string, unknown>) =>
      make(id, 'Commitment', rel, dir, props),
    inventoryPool: (id: string, rel: string, dir: EntityRef['direction'], props?: Record<string, unknown>) =>
      make(id, 'InventoryPool', rel, dir, props),
  };
}

function isRef(ref: EntityRef | null): ref is EntityRef {
  return ref !== null;
}
