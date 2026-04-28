import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ImpactInputError, runImpact } from '@sentinel/impact';
import { generateRecommendationRun } from '@sentinel/recommendation';
import {
  disruptionEffectSchema,
  disruptionSchema,
  objectivePresetSchema,
  type GeneratedScenario,
  type Disruption,
} from '@sentinel/ontology';
import {
  closeNeo4jDriver,
  createNeo4jDriver,
  readScenarioCounts,
  replaceScenarioInNeo4j,
  resetScenarioInNeo4j,
  verifyNeo4jConnectivity,
  type Neo4jCounts,
  type Neo4jDriverLike,
} from './neo4j-runtime.js';
import {
  buildRoutingProjection,
  computeExclusionsFromDisruptions,
  generateRerouteCandidates,
} from '@sentinel/routing';
import { getEntity, getEntityContext } from './entity-context.js';
import { buildScenarioGraph } from './graph-response.js';
import { ScenarioStore, ScenarioStoreError } from './scenario-store.js';

const scenarioParamsSchema = z.object({ scenarioId: z.string().min(1) });
const entityParamsSchema = scenarioParamsSchema.extend({ entityId: z.string().min(1) });
const disruptionParamsSchema = scenarioParamsSchema.extend({ disruptionId: z.string().min(1) });
const routePreviewParamsSchema = scenarioParamsSchema.extend({ shipmentId: z.string().min(1) });
const actionParamsSchema = scenarioParamsSchema.extend({ actionId: z.string().min(1) });
const scenarioTimeBodySchema = z.object({ now: z.coerce.number().int() });
const routePreviewQuerySchema = z.object({
  closedLocationId: z.string().min(1).optional(),
  k: z.coerce.number().int().min(1).max(5).default(3),
});
const disruptionInputSchema = z.object({
  id: z.string().min(1).optional(),
  type: z.enum([
    'node_closure',
    'lane_closure',
    'add_delay',
    'capacity_reduction',
    'cost_increase',
    'inventory_loss',
    'demand_spike',
    'reliability_drop',
  ]),
  targetKind: z.enum(['Location', 'Lane', 'InventoryPool', 'Product', 'ProductAtLocation']),
  targetId: z.string().min(1),
  targetProductId: z.string().min(1).optional(),
  targetLocationId: z.string().min(1).optional(),
  startsAt: z.coerce.number().int().optional(),
  endsAt: z.coerce.number().int().optional(),
  durationHours: z.coerce.number().positive().optional(),
  severity: z.coerce.number().min(0).max(1).default(1),
  effects: z.array(disruptionEffectSchema).min(1).optional(),
  status: z.enum(['active', 'mitigated', 'resolved']).default('active'),
});
const impactRunBodySchema = z.object({
  id: z.string().min(1).optional(),
  now: z.coerce.number().int().optional(),
  includeUnaffected: z.boolean().default(true),
  disruption: disruptionInputSchema.optional(),
  disruptions: z.array(disruptionInputSchema).min(1).optional(),
});
const recommendationRunBodySchema = z.object({
  id: z.string().min(1).optional(),
  now: z.coerce.number().int().optional(),
  objective: objectivePresetSchema.default('balanced'),
  includeImpactRuns: z.boolean().default(false),
  rerouteK: z.coerce.number().int().min(1).max(5).default(3),
  topKCommitments: z.coerce.number().int().min(1).max(50).default(20),
  maxCandidates: z.coerce.number().int().min(1).max(100).default(25),
  enableReroute: z.boolean().default(true),
  enableInventoryReallocation: z.boolean().default(true),
  enableCapacityReprioritization: z.boolean().default(true),
  disruption: disruptionInputSchema.optional(),
  disruptions: z.array(disruptionInputSchema).min(1).optional(),
});

type DisruptionInput = z.infer<typeof disruptionInputSchema>;

type Neo4jOperations = {
  createDriver(): Neo4jDriverLike;
  verifyConnectivity(driver: Neo4jDriverLike): Promise<void>;
  replaceScenario(driver: Neo4jDriverLike, scenario: GeneratedScenario): Promise<void>;
  resetScenario(driver: Neo4jDriverLike, scenarioId: string): Promise<void>;
  readCounts(driver: Neo4jDriverLike, scenarioId: string): Promise<Neo4jCounts>;
  closeDriver(driver: Neo4jDriverLike): Promise<void>;
};

export type BuildServerOptions = {
  store?: ScenarioStore;
  logger?: boolean;
  neo4j?: Partial<Neo4jOperations>;
};

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });
  const store = options.store ?? new ScenarioStore();
  const neo4j: Neo4jOperations = {
    createDriver: () => createNeo4jDriver(),
    verifyConnectivity: verifyNeo4jConnectivity,
    replaceScenario: replaceScenarioInNeo4j,
    resetScenario: async (driver, scenarioId) => {
      const session = driver.session();
      try {
        await resetScenarioInNeo4j(session, scenarioId);
      } finally {
        await session.close();
      }
    },
    readCounts: readScenarioCounts,
    closeDriver: closeNeo4jDriver,
    ...options.neo4j,
  };
  await store.loadFixtures();

  await app.register(cors, { origin: true });

  app.get('/health', async () => ({ ok: true }));

  app.get('/api/scenarios', async () => store.list());

  app.get('/api/scenarios/:scenarioId', async (request, reply) => {
    const { scenarioId } = scenarioParamsSchema.parse(request.params);
    const scenario = store.get(scenarioId);
    if (!scenario) return reply.code(404).send({ error: 'scenario_not_found' });
    return scenario.scenario;
  });

  app.get('/api/scenarios/:scenarioId/graph', async (request, reply) => {
    const { scenarioId } = scenarioParamsSchema.parse(request.params);
    const scenario = store.get(scenarioId);
    if (!scenario) return reply.code(404).send({ error: 'scenario_not_found' });
    return buildScenarioGraph(scenario);
  });

  app.get('/api/scenarios/:scenarioId/disruptions', async (request, reply) => {
    const { scenarioId } = scenarioParamsSchema.parse(request.params);
    try {
      return store.listDisruptions(scenarioId);
    } catch (error) {
      if (error instanceof ScenarioStoreError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get('/api/scenarios/:scenarioId/time', async (request, reply) => {
    const { scenarioId } = scenarioParamsSchema.parse(request.params);
    try {
      return { now: store.getCurrentTime(scenarioId) };
    } catch (error) {
      if (error instanceof ScenarioStoreError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post('/api/scenarios/:scenarioId/time', async (request, reply) => {
    const { scenarioId } = scenarioParamsSchema.parse(request.params);
    const body = scenarioTimeBodySchema.parse(request.body ?? {});
    try {
      return { now: store.setCurrentTime(scenarioId, body.now) };
    } catch (error) {
      if (error instanceof ScenarioStoreError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post('/api/scenarios/:scenarioId/disruptions', async (request, reply) => {
    const { scenarioId } = scenarioParamsSchema.parse(request.params);
    const scenario = store.get(scenarioId);
    if (!scenario) return reply.code(404).send({ error: 'scenario_not_found' });
    const body = disruptionInputSchema.parse(request.body ?? {});
    const created = materializeDisruption(body, scenarioId, scenario.scenario.scenarioStart, Date.now());
    try {
      return reply.code(201).send(store.addDisruption(created));
    } catch (error) {
      if (error instanceof ScenarioStoreError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post('/api/scenarios/:scenarioId/disruptions/:disruptionId/resolve', async (request, reply) => {
    const { scenarioId, disruptionId } = disruptionParamsSchema.parse(request.params);
    try {
      return store.resolveDisruption(scenarioId, disruptionId);
    } catch (error) {
      if (error instanceof ScenarioStoreError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get('/api/scenarios/:scenarioId/entities/:entityId', async (request, reply) => {
    const { scenarioId, entityId } = entityParamsSchema.parse(request.params);
    const scenario = store.get(scenarioId);
    if (!scenario) return reply.code(404).send({ error: 'scenario_not_found' });
    const entity = getEntity(scenario, entityId);
    if (!entity) return reply.code(404).send({ error: 'entity_not_found' });
    return entity;
  });

  app.get('/api/scenarios/:scenarioId/entities/:entityId/context', async (request, reply) => {
    const { scenarioId, entityId } = entityParamsSchema.parse(request.params);
    const scenario = store.get(scenarioId);
    if (!scenario) return reply.code(404).send({ error: 'scenario_not_found' });
    const context = getEntityContext(scenario, entityId);
    if (!context) return reply.code(404).send({ error: 'entity_not_found' });
    return context;
  });

  app.get('/api/scenarios/:scenarioId/shipments/:shipmentId/reroute-candidates', async (request, reply) => {
    const { scenarioId, shipmentId } = routePreviewParamsSchema.parse(request.params);
    const { closedLocationId, k } = routePreviewQuerySchema.parse(request.query);
    const scenario = store.get(scenarioId);
    if (!scenario) return reply.code(404).send({ error: 'scenario_not_found' });
    const shipment = scenario.shipments.find((item) => item.id === shipmentId);
    if (!shipment) return reply.code(404).send({ error: 'shipment_not_found' });
    const projection = buildRoutingProjection(scenario);
    const exclusions = closedLocationId
      ? computeExclusionsFromDisruptions([
        {
          id: `${scenarioId}:preview-closure`,
          scenarioId,
          type: 'node_closure',
          targetKind: 'Location',
          targetId: closedLocationId,
          startsAt: scenario.scenario.scenarioStart,
          endsAt: scenario.scenario.scenarioStart + 24 * 3_600_000,
          severity: 1,
          effects: [{ kind: 'closure' }],
          status: 'active',
        },
      ])
      : undefined;

    return {
      shipmentId,
      candidates: generateRerouteCandidates(
        projection,
        shipment,
        exclusions ? { exclusions } : {},
        k,
      ),
    };
  });

  app.post('/api/scenarios/:scenarioId/impact-runs', async (request, reply) => {
    const { scenarioId } = scenarioParamsSchema.parse(request.params);
    const body = impactRunBodySchema.parse(request.body ?? {});
    const state = store.getState(scenarioId);
    if (!state) return reply.code(404).send({ error: 'scenario_not_found' });
    const scenario = state.scenario;
    const defaultNow = store.getCurrentTime(scenarioId);

    const inputs = [
      ...(body.disruptions ?? []),
      ...(body.disruption ? [body.disruption] : []),
    ];
    const disruptions = inputs.length > 0
      ? inputs.map((input, index) =>
        materializeDisruption(input, scenarioId, scenario.scenario.scenarioStart, index),
      )
      : store.listOpenDisruptions(scenarioId);

    try {
      return runImpact(scenario, disruptions, {
        ...(body.id ? { id: body.id } : {}),
        now: body.now ?? defaultNow,
        includeUnaffected: body.includeUnaffected,
        ...(state.resourcePriorityOverrides ? { resourcePriorityOverrides: state.resourcePriorityOverrides } : {}),
      });
    } catch (error) {
      if (error instanceof ImpactInputError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post('/api/scenarios/:scenarioId/recommendation-runs', async (request, reply) => {
    const { scenarioId } = scenarioParamsSchema.parse(request.params);
    const body = recommendationRunBodySchema.parse(request.body ?? {});
    const state = store.getState(scenarioId);
    if (!state) return reply.code(404).send({ error: 'scenario_not_found' });
    const scenario = state.scenario;
    const defaultNow = store.getCurrentTime(scenarioId);

    const inputs = [
      ...(body.disruptions ?? []),
      ...(body.disruption ? [body.disruption] : []),
    ];
    const disruptions = inputs.length > 0
      ? inputs.map((input, index) =>
        materializeDisruption(input, scenarioId, scenario.scenario.scenarioStart, index),
      )
      : store.listOpenDisruptions(scenarioId);

    try {
      const run = generateRecommendationRun(scenario, disruptions, {
        ...(body.id ? { id: body.id } : {}),
        now: body.now ?? defaultNow,
        objective: body.objective,
        includeImpactRuns: body.includeImpactRuns,
        rerouteK: body.rerouteK,
        topKCommitments: body.topKCommitments,
        maxCandidates: body.maxCandidates,
        enableReroute: body.enableReroute,
        enableInventoryReallocation: body.enableInventoryReallocation,
        enableCapacityReprioritization: body.enableCapacityReprioritization,
        ...(state.resourcePriorityOverrides ? { baseResourcePriorityOverrides: state.resourcePriorityOverrides } : {}),
      });
      return store.saveRecommendationRun(run);
    } catch (error) {
      if (error instanceof ImpactInputError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      if (error instanceof ScenarioStoreError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post('/api/scenarios/:scenarioId/recovery-actions/:actionId/apply', async (request, reply) => {
    const { scenarioId, actionId } = actionParamsSchema.parse(request.params);
    try {
      const result = store.applyRecoveryAction(scenarioId, actionId);
      return {
        scenario: result.scenario.scenario,
        action: result.action,
        recommendationRunId: result.recommendationRun.id,
        postImpact: result.postImpact,
        disruptions: store.listDisruptions(scenarioId),
      };
    } catch (error) {
      if (error instanceof ScenarioStoreError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post('/api/scenarios/:scenarioId/reset', async (request, reply) => {
    const { scenarioId } = scenarioParamsSchema.parse(request.params);
    try {
      const scenario = store.reset(scenarioId);
      return { scenario: scenario.scenario, now: store.getCurrentTime(scenarioId) };
    } catch (error) {
      if (error instanceof ScenarioStoreError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get('/api/scenarios/:scenarioId/neo4j/counts', async (request, reply) => {
    const { scenarioId } = scenarioParamsSchema.parse(request.params);
    const scenario = store.get(scenarioId);
    if (!scenario) return reply.code(404).send({ error: 'scenario_not_found' });
    return runNeo4jOperation(reply, neo4j, (driver) => neo4j.readCounts(driver, scenarioId));
  });

  app.post('/api/scenarios/:scenarioId/neo4j/ingest', async (request, reply) => {
    const { scenarioId } = scenarioParamsSchema.parse(request.params);
    const scenario = store.get(scenarioId);
    if (!scenario) return reply.code(404).send({ error: 'scenario_not_found' });
    return runNeo4jOperation(reply, neo4j, async (driver) => {
      await neo4j.replaceScenario(driver, scenario);
      const counts = await neo4j.readCounts(driver, scenarioId);
      return {
        scenarioId,
        persisted: true,
        counts,
      };
    });
  });

  app.post('/api/scenarios/:scenarioId/neo4j/reset', async (request, reply) => {
    const { scenarioId } = scenarioParamsSchema.parse(request.params);
    const scenario = store.get(scenarioId);
    if (!scenario) return reply.code(404).send({ error: 'scenario_not_found' });
    return runNeo4jOperation(reply, neo4j, async (driver) => {
      await neo4j.resetScenario(driver, scenarioId);
      const counts = await neo4j.readCounts(driver, scenarioId);
      return {
        scenarioId,
        persisted: false,
        counts,
      };
    });
  });

  return app;
}

async function runNeo4jOperation<T>(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  neo4j: Neo4jOperations,
  work: (driver: Neo4jDriverLike) => Promise<T>,
): Promise<T | unknown> {
  const driver = neo4j.createDriver();
  try {
    await neo4j.verifyConnectivity(driver);
    return await work(driver);
  } catch (error) {
    return reply.code(503).send({
      error: 'neo4j_unavailable',
      message: error instanceof Error ? error.message : 'Neo4j is unavailable',
    });
  } finally {
    await neo4j.closeDriver(driver);
  }
}

function materializeDisruption(
  input: DisruptionInput,
  scenarioId: string,
  scenarioStart: number,
  index: number,
): Disruption {
  const startsAt = input.startsAt ?? scenarioStart;
  const durationHours = input.durationHours ?? 24;
  const endsAt = input.endsAt ?? startsAt + durationHours * 3_600_000;
  const effects = input.effects ?? defaultEffectsForDisruption(input);
  const disruption = {
    id: input.id ?? `${scenarioId}:preview-disruption-${index + 1}`,
    scenarioId,
    type: input.type,
    targetKind: input.targetKind,
    targetId: input.targetId,
    ...(input.targetProductId ? { targetProductId: input.targetProductId } : {}),
    ...(input.targetLocationId ? { targetLocationId: input.targetLocationId } : {}),
    startsAt,
    endsAt,
    severity: input.severity,
    effects,
    status: input.status,
  };
  return disruptionSchema.parse(disruption);
}

function defaultEffectsForDisruption(input: DisruptionInput): Disruption['effects'] {
  if (input.type === 'node_closure' || input.type === 'lane_closure') return [{ kind: 'closure' }];
  if (input.type === 'add_delay') return [{ kind: 'add_delay', hours: Math.max(1, Math.round(input.severity * 24)) }];
  if (input.type === 'capacity_reduction') return [{ kind: 'capacity_multiplier', multiplier: Math.max(0, 1 - input.severity) }];
  if (input.type === 'cost_increase') return [{ kind: 'cost_multiplier', multiplier: 1 + input.severity }];
  if (input.type === 'inventory_loss') return [{ kind: 'inventory_loss', mode: 'fraction', amount: input.severity }];
  if (input.type === 'demand_spike') return [{ kind: 'demand_multiplier', multiplier: 1 + input.severity }];
  return [{ kind: 'reliability_multiplier', multiplier: Math.max(0, 1 - input.severity) }];
}
