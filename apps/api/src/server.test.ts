import { describe, expect, it } from 'vitest';
import { defaultDemoConfig, generateScenario } from '@sentinel/scenario-generator';
import { getEntityContext } from './entity-context.js';
import { buildScenarioGraph } from './graph-response.js';
import { buildScenarioIngestStatements, constraintStatements } from './neo4j-ingest.js';
import type { Neo4jCounts, Neo4jDriverLike } from './neo4j-runtime.js';
import { buildServer } from './server.js';

describe('api server', () => {
  it('serves scenario summaries and entity context from the fixture store', async () => {
    const app = await buildServer({ logger: false });
    try {
      const listResponse = await app.inject({ method: 'GET', url: '/api/scenarios' });
      expect(listResponse.statusCode).toBe(200);
      const scenarios = listResponse.json<Array<{ id: string }>>();
      expect(scenarios[0]?.id).toBe('s42');

      const graphResponse = await app.inject({ method: 'GET', url: '/api/scenarios/s42/graph' });
      expect(graphResponse.statusCode).toBe(200);
      const graph = graphResponse.json<{ nodes: unknown[]; edges: unknown[] }>();
      expect(graph.nodes.length).toBeGreaterThan(0);
      expect(graph.edges.length).toBeGreaterThan(0);

      const scenario = generateScenario(defaultDemoConfig);
      const commitmentId = scenario.commitments[0]!.id;
      const contextResponse = await app.inject({
        method: 'GET',
        url: `/api/scenarios/s42/entities/${encodeURIComponent(commitmentId)}/context`,
      });
      expect(contextResponse.statusCode).toBe(200);
      const context = contextResponse.json<{ upstream: Array<{ relationship: string }>; downstream: Array<{ relationship: string }> }>();
      expect(context.upstream.some((item) => item.relationship === 'FULFILLS')).toBe(true);
      expect(context.upstream.some((item) => item.relationship === 'REQUIRES')).toBe(true);
      expect(context.downstream.some((item) => item.relationship === 'DELIVERS_TO')).toBe(true);

      const shipment = scenario.shipments.find((item) => item.laneSequence.length > 0)!;
      const routeResponse = await app.inject({
        method: 'GET',
        url: `/api/scenarios/s42/shipments/${encodeURIComponent(shipment.id)}/reroute-candidates?k=3`,
      });
      expect(routeResponse.statusCode).toBe(200);
      expect(routeResponse.json<{ candidates: unknown[] }>().candidates.length).toBeGreaterThanOrEqual(0);
    } finally {
      await app.close();
    }
  });

  it('returns 404 for missing scenarios and entities', async () => {
    const app = await buildServer({ logger: false });
    try {
      const missingScenario = await app.inject({ method: 'GET', url: '/api/scenarios/missing' });
      expect(missingScenario.statusCode).toBe(404);

      const missingEntity = await app.inject({ method: 'GET', url: '/api/scenarios/s42/entities/s42:missing' });
      expect(missingEntity.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('previews impact runs for a node closure', async () => {
    const app = await buildServer({ logger: false });
    try {
      const scenario = generateScenario(defaultDemoConfig);
      const fulfillment = scenario.fulfillments[0]!;
      const shipment = scenario.shipments.find((item) => item.id === fulfillment.shipmentId)!;
      const firstLane = scenario.lanes.find((lane) => lane.id === shipment.laneSequence[0])!;
      const response = await app.inject({
        method: 'POST',
        url: '/api/scenarios/s42/impact-runs',
        payload: {
          includeUnaffected: false,
          disruption: {
            type: 'node_closure',
            targetKind: 'Location',
            targetId: firstLane.originId,
            durationHours: 14 * 24,
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        summary: { impactedShipmentCount: number; impactedCommitmentCount: number };
        commitmentObservations: Array<{ commitmentId: string; causePath?: Array<{ id: string }> }>;
      }>();
      expect(body.summary.impactedShipmentCount).toBeGreaterThan(0);
      expect(body.summary.impactedCommitmentCount).toBeGreaterThan(0);
      expect(body.commitmentObservations.some((item) => item.commitmentId === fulfillment.commitmentId && item.causePath)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('stores and resolves disruptions for the live Sentinel feed', async () => {
    const app = await buildServer({ logger: false });
    try {
      const scenario = generateScenario(defaultDemoConfig);
      const lane = scenario.lanes[0]!;
      const create = await app.inject({
        method: 'POST',
        url: '/api/scenarios/s42/disruptions',
        payload: {
          type: 'lane_closure',
          targetKind: 'Lane',
          targetId: lane.id,
          durationHours: 48,
          severity: 1,
        },
      });

      expect(create.statusCode).toBe(201);
      const created = create.json<{ id: string; status: string; targetId: string }>();
      expect(created.status).toBe('active');
      expect(created.targetId).toBe(lane.id);

      const list = await app.inject({
        method: 'GET',
        url: '/api/scenarios/s42/disruptions',
      });
      expect(list.statusCode).toBe(200);
      expect(list.json<Array<{ id: string }>>().some((item) => item.id === created.id)).toBe(true);

      const resolve = await app.inject({
        method: 'POST',
        url: `/api/scenarios/s42/disruptions/${encodeURIComponent(created.id)}/resolve`,
      });
      expect(resolve.statusCode).toBe(200);
      expect(resolve.json<{ status: string }>().status).toBe('resolved');
    } finally {
      await app.close();
    }
  });

  it('returns ranked recommendation runs for a node closure', async () => {
    const app = await buildServer({ logger: false });
    try {
      const scenario = generateScenario(defaultDemoConfig);
      const shipment = scenario.shipments.find((item) => item.laneSequence.length > 0)!;
      const firstLane = scenario.lanes.find((lane) => lane.id === shipment.laneSequence[0])!;
      const response = await app.inject({
        method: 'POST',
        url: '/api/scenarios/s42/recommendation-runs',
        payload: {
          objective: 'protect_p0',
          maxCandidates: 10,
          disruption: {
            type: 'node_closure',
            targetKind: 'Location',
            targetId: firstLane.originId,
            durationHours: 14 * 24,
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        summary: { candidateCount: number; bestActionId: string | null };
        actions: Array<{ action: { type: string; score: number } }>;
      }>();
      expect(body.summary.candidateCount).toBeGreaterThan(0);
      expect(body.summary.bestActionId).not.toBeNull();
      expect(body.actions.some((item) => item.action.type === 'reroute')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('applies a stored recovery action and can reset to baseline', async () => {
    const app = await buildServer({ logger: false });
    try {
      const scenario = generateScenario(defaultDemoConfig);
      const shipment = scenario.shipments.find((item) => item.laneSequence.length > 0)!;
      const firstLane = scenario.lanes.find((lane) => lane.id === shipment.laneSequence[0])!;
      const recommendation = await app.inject({
        method: 'POST',
        url: '/api/scenarios/s42/recommendation-runs',
        payload: {
          objective: 'protect_p0',
          maxCandidates: 12,
          disruption: {
            type: 'node_closure',
            targetKind: 'Location',
            targetId: firstLane.originId,
            durationHours: 14 * 24,
          },
        },
      });
      expect(recommendation.statusCode).toBe(200);
      const recommendationBody = recommendation.json<{
        summary: { bestActionId: string | null };
      }>();
      expect(recommendationBody.summary.bestActionId).not.toBeNull();

      const apply = await app.inject({
        method: 'POST',
        url: `/api/scenarios/s42/recovery-actions/${encodeURIComponent(recommendationBody.summary.bestActionId!)}/apply`,
      });
      expect(apply.statusCode).toBe(200);
      const applyBody = apply.json<{ scenario: { version: number }; postImpact: { scenarioId: string } }>();
      expect(applyBody.scenario.version).toBe(1);
      expect(applyBody.postImpact.scenarioId).toBe('s42');

      const staleApply = await app.inject({
        method: 'POST',
        url: `/api/scenarios/s42/recovery-actions/${encodeURIComponent(recommendationBody.summary.bestActionId!)}/apply`,
      });
      expect(staleApply.statusCode).toBe(409);

      const reset = await app.inject({
        method: 'POST',
        url: '/api/scenarios/s42/reset',
      });
      expect(reset.statusCode).toBe(200);
      expect(reset.json<{ scenario: { version: number } }>().scenario.version).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('keeps mitigated incidents in the active set until their end time', async () => {
    const app = await buildServer({ logger: false });
    try {
      const scenario = generateScenario(defaultDemoConfig);
      const shipment = scenario.shipments.find((item) => item.laneSequence.length > 0)!;
      const firstLane = scenario.lanes.find((lane) => lane.id === shipment.laneSequence[0])!;

      const create = await app.inject({
        method: 'POST',
        url: '/api/scenarios/s42/disruptions',
        payload: {
          type: 'node_closure',
          targetKind: 'Location',
          targetId: firstLane.originId,
          durationHours: 48,
          severity: 1,
        },
      });
      expect(create.statusCode).toBe(201);
      const created = create.json<{ id: string; endsAt: number }>();

      const recommendation = await app.inject({
        method: 'POST',
        url: '/api/scenarios/s42/recommendation-runs',
        payload: {
          objective: 'protect_p0',
          maxCandidates: 12,
        },
      });
      expect(recommendation.statusCode).toBe(200);
      const recommendationBody = recommendation.json<{
        summary: { bestActionId: string | null };
      }>();
      expect(recommendationBody.summary.bestActionId).not.toBeNull();

      const apply = await app.inject({
        method: 'POST',
        url: `/api/scenarios/s42/recovery-actions/${encodeURIComponent(recommendationBody.summary.bestActionId!)}/apply`,
      });
      expect(apply.statusCode).toBe(200);
      const applyBody = apply.json<{ disruptions: Array<{ id: string; status: string }> }>();
      expect(applyBody.disruptions.find((item) => item.id === created.id)?.status).toBe('mitigated');

      const impactWhileMitigated = await app.inject({
        method: 'POST',
        url: '/api/scenarios/s42/impact-runs',
        payload: {},
      });
      expect(impactWhileMitigated.statusCode).toBe(200);
      expect(impactWhileMitigated.json<{ disruptionIds: string[] }>().disruptionIds).toContain(created.id);

      const setTime = await app.inject({
        method: 'POST',
        url: '/api/scenarios/s42/time',
        payload: {
          now: created.endsAt + 3_600_000,
        },
      });
      expect(setTime.statusCode).toBe(200);
      expect(setTime.json<{ now: number }>().now).toBe(created.endsAt + 3_600_000);

      const impactAfterEnd = await app.inject({
        method: 'POST',
        url: '/api/scenarios/s42/impact-runs',
        payload: {},
      });
      expect(impactAfterEnd.statusCode).toBe(200);
      expect(impactAfterEnd.json<{ disruptionIds: string[] }>().disruptionIds).not.toContain(created.id);
    } finally {
      await app.close();
    }
  });

  it('persists scenario state to Neo4j through injected runtime operations', async () => {
    const countsByScenario = new Map<string, Neo4jCounts>();
    let createdDrivers = 0;
    let closedDrivers = 0;
    const app = await buildServer({
      logger: false,
      neo4j: {
        createDriver: () => {
          createdDrivers += 1;
          return {} as Neo4jDriverLike;
        },
        verifyConnectivity: async () => {},
        replaceScenario: async (_driver, scenario) => {
          countsByScenario.set(scenario.scenario.id, {
            scenarioId: scenario.scenario.id,
            nodes: {
              Scenario: 1,
              Location: scenario.locations.length,
              Lane: scenario.lanes.length,
              Shipment: scenario.shipments.length,
            },
            relationships: {
              CONTAINS: scenario.locations.length + scenario.lanes.length + scenario.shipments.length,
              FULFILLS: scenario.fulfillments.length,
            },
          });
        },
        resetScenario: async (_driver, scenarioId) => {
          countsByScenario.set(scenarioId, {
            scenarioId,
            nodes: {},
            relationships: {},
          });
        },
        readCounts: async (_driver, scenarioId) =>
          countsByScenario.get(scenarioId) ?? { scenarioId, nodes: {}, relationships: {} },
        closeDriver: async () => {
          closedDrivers += 1;
        },
      },
    });

    try {
      const ingest = await app.inject({
        method: 'POST',
        url: '/api/scenarios/s42/neo4j/ingest',
      });
      expect(ingest.statusCode).toBe(200);
      const ingestBody = ingest.json<{
        scenarioId: string;
        persisted: boolean;
        counts: Neo4jCounts;
      }>();
      expect(ingestBody.scenarioId).toBe('s42');
      expect(ingestBody.persisted).toBe(true);
      expect(ingestBody.counts.nodes.Location).toBeGreaterThan(0);
      expect(ingestBody.counts.relationships.FULFILLS).toBeGreaterThan(0);

      const counts = await app.inject({
        method: 'GET',
        url: '/api/scenarios/s42/neo4j/counts',
      });
      expect(counts.statusCode).toBe(200);
      expect(counts.json<Neo4jCounts>().nodes.Scenario).toBe(1);

      const reset = await app.inject({
        method: 'POST',
        url: '/api/scenarios/s42/neo4j/reset',
      });
      expect(reset.statusCode).toBe(200);
      const resetBody = reset.json<{ persisted: boolean; counts: Neo4jCounts }>();
      expect(resetBody.persisted).toBe(false);
      expect(resetBody.counts.nodes).toEqual({});

      expect(createdDrivers).toBe(3);
      expect(closedDrivers).toBe(3);
    } finally {
      await app.close();
    }
  });

  it('returns 503 when Neo4j is unavailable', async () => {
    const app = await buildServer({
      logger: false,
      neo4j: {
        createDriver: () => ({}) as Neo4jDriverLike,
        verifyConnectivity: async () => {
          throw new Error('connection refused');
        },
        closeDriver: async () => {},
      },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/scenarios/s42/neo4j/ingest',
      });
      expect(response.statusCode).toBe(503);
      expect(response.json<{ error: string }>().error).toBe('neo4j_unavailable');
    } finally {
      await app.close();
    }
  });
});

describe('entity context and graph response', () => {
  it('returns typed immediate context for a lane', () => {
    const scenario = generateScenario(defaultDemoConfig);
    const lane = scenario.lanes[0]!;
    const context = getEntityContext(scenario, lane.id);
    expect(context?.entity.label).toBe('Lane');
    expect(context?.upstream.some((ref) => ref.relationship === 'LANE_START')).toBe(true);
    expect(context?.downstream.some((ref) => ref.relationship === 'LANE_END')).toBe(true);
  });

  it('serializes ontology relationships into graph edges', () => {
    const scenario = generateScenario(defaultDemoConfig);
    const graph = buildScenarioGraph(scenario);
    expect(graph.nodes).toHaveLength(
      scenario.locations.length +
      scenario.lanes.length +
      scenario.products.length +
      scenario.substitutionGroups.length +
      scenario.shipments.length +
      scenario.commitments.length +
      scenario.inventoryPools.length +
      scenario.capacityPools.length,
    );
    expect(graph.edges.some((edge) => edge.type === 'FULFILLS')).toBe(true);
    expect(graph.edges.some((edge) => edge.type === 'PRODUCES')).toBe(true);
  });
});

describe('neo4j ingest', () => {
  it('builds schema and scenario ingest statements', () => {
    const scenario = generateScenario(defaultDemoConfig);
    const statements = buildScenarioIngestStatements(scenario);
    expect(constraintStatements.some((statement) => statement.query.includes('location_id'))).toBe(true);
    expect(statements.some((statement) => statement.query.includes('MERGE (n:Location'))).toBe(true);
    expect(statements.some((statement) => statement.query.includes('[r:FULFILLS]'))).toBe(true);
    const fulfills = statements.find((statement) => statement.query.includes('[r:FULFILLS]'));
    expect((fulfills?.params?.rows as Array<{ props: { quantity?: number } }>).some((row) => row.props.quantity)).toBe(true);
    expect(fulfills?.query.includes('SET r.scenarioId = $scenarioId')).toBe(true);
    expect(fulfills?.params?.scenarioId).toBe(scenario.scenario.id);
  });
});
