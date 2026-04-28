import type { GeneratedScenario } from '@sentinel/ontology';

export type CypherStatement = {
  query: string;
  params?: Record<string, unknown>;
};

export type Neo4jSessionLike = {
  run(query: string, params?: Record<string, unknown>): Promise<unknown>;
};

export const constraintStatements: CypherStatement[] = [
  { query: 'CREATE CONSTRAINT location_id IF NOT EXISTS FOR (n:Location) REQUIRE n.id IS UNIQUE' },
  { query: 'CREATE CONSTRAINT lane_id IF NOT EXISTS FOR (n:Lane) REQUIRE n.id IS UNIQUE' },
  { query: 'CREATE CONSTRAINT product_id IF NOT EXISTS FOR (n:Product) REQUIRE n.id IS UNIQUE' },
  { query: 'CREATE CONSTRAINT subgroup_id IF NOT EXISTS FOR (n:SubstitutionGroup) REQUIRE n.id IS UNIQUE' },
  { query: 'CREATE CONSTRAINT shipment_id IF NOT EXISTS FOR (n:Shipment) REQUIRE n.id IS UNIQUE' },
  { query: 'CREATE CONSTRAINT commitment_id IF NOT EXISTS FOR (n:Commitment) REQUIRE n.id IS UNIQUE' },
  { query: 'CREATE CONSTRAINT inventory_id IF NOT EXISTS FOR (n:InventoryPool) REQUIRE n.id IS UNIQUE' },
  { query: 'CREATE CONSTRAINT capacity_id IF NOT EXISTS FOR (n:CapacityPool) REQUIRE n.id IS UNIQUE' },
  { query: 'CREATE CONSTRAINT disruption_id IF NOT EXISTS FOR (n:Disruption) REQUIRE n.id IS UNIQUE' },
  { query: 'CREATE CONSTRAINT action_id IF NOT EXISTS FOR (n:RecoveryAction) REQUIRE n.id IS UNIQUE' },
  { query: 'CREATE CONSTRAINT impact_run_id IF NOT EXISTS FOR (n:ImpactRun) REQUIRE n.id IS UNIQUE' },
  { query: 'CREATE CONSTRAINT recommendation_run_id IF NOT EXISTS FOR (n:RecommendationRun) REQUIRE n.id IS UNIQUE' },
  { query: 'CREATE CONSTRAINT scenario_id IF NOT EXISTS FOR (n:Scenario) REQUIRE n.id IS UNIQUE' },
  { query: 'CREATE INDEX location_scenario IF NOT EXISTS FOR (n:Location) ON (n.scenarioId)' },
  { query: 'CREATE INDEX lane_scenario IF NOT EXISTS FOR (n:Lane) ON (n.scenarioId)' },
  { query: 'CREATE INDEX shipment_scenario IF NOT EXISTS FOR (n:Shipment) ON (n.scenarioId)' },
  { query: 'CREATE INDEX commitment_scenario IF NOT EXISTS FOR (n:Commitment) ON (n.scenarioId)' },
  { query: 'CREATE INDEX commitment_priority IF NOT EXISTS FOR (n:Commitment) ON (n.priority)' },
  { query: 'CREATE INDEX commitment_risk IF NOT EXISTS FOR (n:Commitment) ON (n.currentRisk)' },
  { query: 'CREATE INDEX disruption_status IF NOT EXISTS FOR (n:Disruption) ON (n.status)' },
];

export function buildScenarioIngestStatements(scenario: GeneratedScenario): CypherStatement[] {
  const statements: CypherStatement[] = [];

  statements.push(nodeStatement('Scenario', [scenario.scenario]));
  statements.push(nodeStatement('Location', scenario.locations));
  statements.push(nodeStatement('Lane', scenario.lanes));
  statements.push(nodeStatement('Product', scenario.products));
  statements.push(nodeStatement('SubstitutionGroup', scenario.substitutionGroups));
  statements.push(nodeStatement('Shipment', scenario.shipments));
  statements.push(nodeStatement('Commitment', scenario.commitments));
  statements.push(nodeStatement('InventoryPool', scenario.inventoryPools));
  statements.push(nodeStatement('CapacityPool', scenario.capacityPools));

  statements.push(...containsStatements(scenario));
  statements.push(relStatement('Location', 'LANE_START', 'Lane', scenario.lanes.map((lane) => ({ from: lane.originId, to: lane.id }))));
  statements.push(relStatement('Lane', 'LANE_END', 'Location', scenario.lanes.map((lane) => ({ from: lane.id, to: lane.destinationId }))));
  statements.push(relStatement('Location', 'PRODUCES', 'Product', scenario.produces.map((entry) => ({ from: entry.locationId, to: entry.productId }))));

  statements.push(relStatement('Shipment', 'ORIGIN', 'Location', scenario.shipments.map((shipment) => ({ from: shipment.id, to: shipment.originId }))));
  statements.push(relStatement('Shipment', 'DESTINATION', 'Location', scenario.shipments.map((shipment) => ({ from: shipment.id, to: shipment.destinationId }))));
  statements.push(relStatement('Shipment', 'CONTAINS', 'Product', scenario.shipments.map((shipment) => ({ from: shipment.id, to: shipment.productId }))));
  statements.push(relStatement(
    'Shipment',
    'USES_LANE',
    'Lane',
    scenario.shipments.flatMap((shipment) =>
      shipment.laneSequence.map((laneId, sequence) => ({
        from: shipment.id,
        to: laneId,
        props: { sequence },
      })),
    ),
  ));
  statements.push(relStatement(
    'Shipment',
    'FULFILLS',
    'Commitment',
    scenario.fulfillments.map((fulfillment) => ({
      from: fulfillment.shipmentId,
      to: fulfillment.commitmentId,
      props: { quantity: fulfillment.quantity },
    })),
  ));

  statements.push(relStatement('Commitment', 'REQUIRES', 'Product', scenario.commitments.map((commitment) => ({ from: commitment.id, to: commitment.requiredProductId }))));
  statements.push(relStatement('Commitment', 'DELIVERS_TO', 'Location', scenario.commitments.map((commitment) => ({ from: commitment.id, to: commitment.deliveredToId }))));

  statements.push(relStatement(
    'Product',
    'MEMBER_OF',
    'SubstitutionGroup',
    scenario.substitutionGroups.flatMap((group) => group.productIds.map((productId) => ({ from: productId, to: group.id }))),
  ));
  statements.push(relStatement('InventoryPool', 'STORED_AT', 'Location', scenario.inventoryPools.map((pool) => ({ from: pool.id, to: pool.storedAtId }))));
  statements.push(relStatement('InventoryPool', 'OF_PRODUCT', 'Product', scenario.inventoryPools.map((pool) => ({ from: pool.id, to: pool.productId }))));

  const locationIds = new Set(scenario.locations.map((location) => location.id));
  const laneIds = new Set(scenario.lanes.map((lane) => lane.id));
  statements.push(relStatement(
    'CapacityPool',
    'CONSTRAINS',
    'Location',
    scenario.capacityPools.flatMap((pool) =>
      pool.constrainedEntityIds.filter((id) => locationIds.has(id)).map((id) => ({ from: pool.id, to: id })),
    ),
  ));
  statements.push(relStatement(
    'CapacityPool',
    'CONSTRAINS',
    'Lane',
    scenario.capacityPools.flatMap((pool) =>
      pool.constrainedEntityIds.filter((id) => laneIds.has(id)).map((id) => ({ from: pool.id, to: id })),
    ),
  ));

  return statements.filter((statement) => !('params' in statement) || ((statement.params?.rows as unknown[])?.length ?? 1) > 0);
}

export async function ensureNeo4jSchema(session: Neo4jSessionLike): Promise<void> {
  for (const statement of constraintStatements) {
    await session.run(statement.query, statement.params);
  }
}

export async function ingestScenario(session: Neo4jSessionLike, scenario: GeneratedScenario): Promise<void> {
  for (const statement of buildScenarioIngestStatements(scenario)) {
    await session.run(statement.query, statement.params);
  }
}

function nodeStatement(label: string, items: readonly Record<string, unknown>[]): CypherStatement {
  return {
    query: `
      UNWIND $rows AS row
      MERGE (n:${label} {id: row.id})
      SET n += row.props
    `,
    params: {
      rows: items.map((item) => ({ id: item.id, props: item })),
    },
  };
}

function relStatement(
  fromLabel: string,
  rel: string,
  toLabel: string,
  rows: Array<{ from: string; to: string; props?: Record<string, unknown> }>,
): CypherStatement {
  return {
    query: `
      UNWIND $rows AS row
      MATCH (a:${fromLabel} {id: row.from})
      MATCH (b:${toLabel} {id: row.to})
      MERGE (a)-[r:${rel}]->(b)
      SET r += row.props
      SET r.scenarioId = $scenarioId
    `,
    params: {
      scenarioId: rows[0]?.from.split(':')[0] ?? null,
      rows: rows.map((row) => ({ ...row, props: row.props ?? {} })),
    },
  };
}

function containsStatements(scenario: GeneratedScenario): CypherStatement[] {
  const contains = <T extends { id: string }>(label: string, items: readonly T[]) =>
    relStatement('Scenario', 'CONTAINS', label, items.map((item) => ({ from: scenario.scenario.id, to: item.id })));
  return [
    contains('Location', scenario.locations),
    contains('Lane', scenario.lanes),
    contains('Product', scenario.products),
    contains('SubstitutionGroup', scenario.substitutionGroups),
    contains('Shipment', scenario.shipments),
    contains('Commitment', scenario.commitments),
    contains('InventoryPool', scenario.inventoryPools),
    contains('CapacityPool', scenario.capacityPools),
  ];
}
