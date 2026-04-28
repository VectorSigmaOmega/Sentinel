import { ScenarioStore } from './scenario-store.js';
import {
  closeNeo4jDriver,
  createNeo4jDriver,
  readScenarioCounts,
  replaceScenarioInNeo4j,
  verifyNeo4jConnectivity,
} from './neo4j-runtime.js';

const scenarioId = process.env.SCENARIO_ID ?? 's42';

const store = new ScenarioStore();
await store.loadFixtures();
const scenario = store.get(scenarioId);
if (!scenario) {
  throw new Error(`Scenario not found: ${scenarioId}`);
}

const driver = createNeo4jDriver();

try {
  await verifyNeo4jConnectivity(driver);
  await replaceScenarioInNeo4j(driver, scenario);
  const counts = await readScenarioCounts(driver, scenarioId);
  console.log(JSON.stringify({
    ok: true,
    scenarioId,
    nodeLabels: counts.nodes,
    relationshipTypes: counts.relationships,
  }));
} finally {
  await closeNeo4jDriver(driver);
}
