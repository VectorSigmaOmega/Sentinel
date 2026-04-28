import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { defaultDemoConfig } from './config.js';
import { generateScenario } from './generator.js';
import { validateScenario } from './validation.js';

const outputPath = resolve(process.cwd(), 'data/scenarios/demo-scenario.json');
const scenario = generateScenario(defaultDemoConfig);
const validation = validateScenario(scenario);

if (!validation.valid) {
  console.error(validation.errors.join('\n'));
  process.exit(1);
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');

console.log(`Wrote ${outputPath}`);
console.log(`${scenario.locations.length} locations, ${scenario.lanes.length} lanes, ${scenario.shipments.length} shipments, ${scenario.commitments.length} commitments`);
