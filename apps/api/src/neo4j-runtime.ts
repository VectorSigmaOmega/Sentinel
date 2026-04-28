import neo4j, { type Driver } from 'neo4j-driver';
import type { GeneratedScenario } from '@sentinel/ontology';
import { ensureNeo4jSchema, ingestScenario, type Neo4jSessionLike } from './neo4j-ingest.js';

const DEFAULT_URI = 'bolt://127.0.0.1:7687';
const DEFAULT_USER = 'neo4j';
const DEFAULT_PASSWORD = 'sentinel-dev-password';

export type Neo4jConfig = {
  uri: string;
  user: string;
  password: string;
};

export type Neo4jCounts = {
  scenarioId: string;
  nodes: Record<string, number>;
  relationships: Record<string, number>;
};

export type Neo4jSessionRuntimeLike = Neo4jSessionLike & {
  close(): Promise<void>;
};

type Neo4jRecordLike = {
  get(key: string): unknown;
};

type Neo4jResultLike = {
  records: Neo4jRecordLike[];
};

export type Neo4jDriverLike = {
  verifyConnectivity(): Promise<unknown>;
  session(): Neo4jSessionRuntimeLike;
  close(): Promise<void>;
};

export function neo4jConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Neo4jConfig {
  return {
    uri: env.NEO4J_URI ?? DEFAULT_URI,
    user: env.NEO4J_USER ?? DEFAULT_USER,
    password: env.NEO4J_PASSWORD ?? DEFAULT_PASSWORD,
  };
}

export function createNeo4jDriver(config: Neo4jConfig = neo4jConfigFromEnv()): Driver {
  return neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
}

export async function verifyNeo4jConnectivity(driver: Neo4jDriverLike): Promise<void> {
  await driver.verifyConnectivity();
}

export async function resetScenarioInNeo4j(session: Neo4jSessionLike, scenarioId: string): Promise<void> {
  await session.run(
    `
      MATCH (n {scenarioId: $scenarioId})
      DETACH DELETE n
    `,
    { scenarioId },
  );
}

export async function replaceScenarioInNeo4j(driver: Neo4jDriverLike, scenario: GeneratedScenario): Promise<void> {
  const session = driver.session();
  try {
    await ensureNeo4jSchema(session);
    await resetScenarioInNeo4j(session, scenario.scenario.id);
    await ingestScenario(session, scenario);
  } finally {
    await session.close();
  }
}

export async function readScenarioCounts(driver: Neo4jDriverLike, scenarioId: string): Promise<Neo4jCounts> {
  const session = driver.session();
  try {
    const nodeResult = await session.run(
      `
        MATCH (n {scenarioId: $scenarioId})
        UNWIND labels(n) AS label
        RETURN label, count(*) AS count
        ORDER BY label
      `,
      { scenarioId },
    ) as Neo4jResultLike;
    const relationshipResult = await session.run(
      `
        MATCH ()-[r]-()
        WHERE r.scenarioId = $scenarioId
           OR (startNode(r).scenarioId IS NOT NULL AND startNode(r).scenarioId = $scenarioId)
        RETURN type(r) AS type, count(*) AS count
        ORDER BY type
      `,
      { scenarioId },
    ) as Neo4jResultLike;

    return {
      scenarioId,
      nodes: Object.fromEntries(
        nodeResult.records.map((record) => [
          record.get('label') as string,
          coerceNeo4jCount(record.get('count')),
        ]),
      ),
      relationships: Object.fromEntries(
        relationshipResult.records.map((record) => [
          record.get('type') as string,
          coerceNeo4jCount(record.get('count')),
        ]),
      ),
    };
  } finally {
    await session.close();
  }
}

export async function closeNeo4jDriver(driver: Neo4jDriverLike): Promise<void> {
  await driver.close();
}

function coerceNeo4jCount(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (
    typeof value === 'object' &&
    value !== null &&
    'toNumber' in value &&
    typeof (value as { toNumber: unknown }).toNumber === 'function'
  ) {
    const integerValue = value as Parameters<typeof neo4j.integer.inSafeRange>[0] & { toNumber(): number };
    return neo4j.integer.inSafeRange(integerValue) ? integerValue.toNumber() : Number(integerValue.toString());
  }
  return Number(value);
}
