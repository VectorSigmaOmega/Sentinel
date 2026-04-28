import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runImpact, type ResourcePriorityOverrides } from '@sentinel/impact';
import {
  applyRecoveryActionState,
  type RecommendationRun,
  type RecommendationState,
} from '@sentinel/recommendation';
import { validateScenario } from '@sentinel/scenario-generator';
import {
  generatedScenarioSchema,
  type Disruption,
  type GeneratedScenario,
  type RecoveryAction,
} from '@sentinel/ontology';

export type ScenarioSummary = {
  id: string;
  name: string;
  seed: string;
  version: number;
  counts: {
    locations: number;
    lanes: number;
    products: number;
    shipments: number;
    commitments: number;
    inventoryPools: number;
    capacityPools: number;
  };
};

type StoredRecommendationAction = {
  action: RecoveryAction;
  runId: string;
};

type ScenarioRuntimeState = {
  baseline: GeneratedScenario;
  active: RecommendationState;
  currentTime: number;
  disruptions: Map<string, Disruption>;
  recommendationRuns: Map<string, RecommendationRun>;
  actionsById: Map<string, StoredRecommendationAction>;
};

export class ScenarioStoreError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class ScenarioStore {
  private scenarios = new Map<string, ScenarioRuntimeState>();

  constructor(private readonly fixturePath = resolve(process.cwd(), 'data/scenarios/demo-scenario.json')) {}

  async loadFixtures(): Promise<void> {
    const raw = await readFile(this.fixturePath, 'utf8');
    const scenario = generatedScenarioSchema.parse(JSON.parse(raw));
    this.scenarios.set(scenario.scenario.id, {
      baseline: structuredClone(scenario),
      active: { scenario: structuredClone(scenario) },
      currentTime: scenario.scenario.scenarioStart,
      disruptions: new Map(),
      recommendationRuns: new Map(),
      actionsById: new Map(),
    });
  }

  list(): ScenarioSummary[] {
    return [...this.scenarios.values()].map(({ active }) => summarizeScenario(active.scenario));
  }

  get(scenarioId: string): GeneratedScenario | null {
    return this.scenarios.get(scenarioId)?.active.scenario ?? null;
  }

  getState(scenarioId: string): RecommendationState | null {
    const state = this.scenarios.get(scenarioId)?.active;
    if (!state) return null;
    return {
      scenario: state.scenario,
      ...(state.resourcePriorityOverrides ? { resourcePriorityOverrides: state.resourcePriorityOverrides } : {}),
    };
  }

  saveRecommendationRun(run: RecommendationRun): RecommendationRun {
    const state = this.scenarios.get(run.scenarioId);
    if (!state) {
      throw new ScenarioStoreError('scenario_not_found', 404, `Scenario not found: ${run.scenarioId}`);
    }
    state.recommendationRuns.set(run.id, run);
    for (const entry of run.actions) {
      state.actionsById.set(entry.action.id, { action: entry.action, runId: run.id });
    }
    return run;
  }

  listDisruptions(scenarioId: string): Disruption[] {
    const runtime = this.scenarios.get(scenarioId);
    if (!runtime) {
      throw new ScenarioStoreError('scenario_not_found', 404, `Scenario not found: ${scenarioId}`);
    }
    return [...runtime.disruptions.values()].sort((a, b) => b.startsAt - a.startsAt || a.id.localeCompare(b.id));
  }

  listOpenDisruptions(scenarioId: string): Disruption[] {
    const runtime = this.scenarios.get(scenarioId);
    if (!runtime) {
      throw new ScenarioStoreError('scenario_not_found', 404, `Scenario not found: ${scenarioId}`);
    }
    return [...runtime.disruptions.values()]
      .filter((disruption) => disruption.status !== 'resolved' && disruption.startsAt <= runtime.currentTime && runtime.currentTime < disruption.endsAt)
      .sort((a, b) => b.startsAt - a.startsAt || a.id.localeCompare(b.id));
  }

  addDisruption(disruption: Disruption): Disruption {
    const runtime = this.scenarios.get(disruption.scenarioId);
    if (!runtime) {
      throw new ScenarioStoreError('scenario_not_found', 404, `Scenario not found: ${disruption.scenarioId}`);
    }
    runtime.disruptions.set(disruption.id, disruption);
    return disruption;
  }

  getCurrentTime(scenarioId: string): number {
    const runtime = this.scenarios.get(scenarioId);
    if (!runtime) {
      throw new ScenarioStoreError('scenario_not_found', 404, `Scenario not found: ${scenarioId}`);
    }
    return runtime.currentTime;
  }

  setCurrentTime(scenarioId: string, now: number): number {
    const runtime = this.scenarios.get(scenarioId);
    if (!runtime) {
      throw new ScenarioStoreError('scenario_not_found', 404, `Scenario not found: ${scenarioId}`);
    }
    runtime.currentTime = now;
    return runtime.currentTime;
  }

  resolveDisruption(scenarioId: string, disruptionId: string): Disruption {
    const runtime = this.scenarios.get(scenarioId);
    if (!runtime) {
      throw new ScenarioStoreError('scenario_not_found', 404, `Scenario not found: ${scenarioId}`);
    }
    const disruption = runtime.disruptions.get(disruptionId);
    if (!disruption) {
      throw new ScenarioStoreError('disruption_not_found', 404, `Disruption not found: ${disruptionId}`);
    }
    const resolved = { ...disruption, status: 'resolved' as const };
    runtime.disruptions.set(disruptionId, resolved);
    return resolved;
  }

  applyRecoveryAction(scenarioId: string, actionId: string): {
    scenario: GeneratedScenario;
    action: RecoveryAction;
    recommendationRun: RecommendationRun;
    postImpact: ReturnType<typeof runImpact>;
    resourcePriorityOverrides?: ResourcePriorityOverrides;
  } {
    const runtime = this.scenarios.get(scenarioId);
    if (!runtime) {
      throw new ScenarioStoreError('scenario_not_found', 404, `Scenario not found: ${scenarioId}`);
    }
    const actionEntry = runtime.actionsById.get(actionId);
    if (!actionEntry) {
      throw new ScenarioStoreError('action_not_found', 404, `Recovery action not found: ${actionId}`);
    }
    const recommendationRun = runtime.recommendationRuns.get(actionEntry.runId);
    if (!recommendationRun) {
      throw new ScenarioStoreError('recommendation_run_not_found', 404, `Recommendation run not found for action: ${actionId}`);
    }
    if (recommendationRun.scenarioVersion !== runtime.active.scenario.scenario.version) {
      throw new ScenarioStoreError(
        'stale_recovery_action',
        409,
        `Recovery action ${actionId} targets scenario version ${recommendationRun.scenarioVersion}, current is ${runtime.active.scenario.scenario.version}`,
      );
    }

    const nextState = applyRecoveryActionState(runtime.active, actionEntry.action);
    const nextScenario = structuredClone(nextState.scenario);
    nextScenario.scenario.version = runtime.active.scenario.scenario.version + 1;

    const parsedScenario = generatedScenarioSchema.parse(nextScenario);
    const validation = validateScenario(parsedScenario);
    if (!validation.valid) {
      throw new ScenarioStoreError('scenario_validation_failed', 409, validation.errors.join('; '));
    }

    runtime.active = {
      scenario: parsedScenario,
      ...(nextState.resourcePriorityOverrides ? { resourcePriorityOverrides: nextState.resourcePriorityOverrides } : {}),
    };
    for (const disruption of recommendationRun.disruptions) {
      const current = runtime.disruptions.get(disruption.id);
      if (current && current.status !== 'resolved') {
        runtime.disruptions.set(disruption.id, { ...current, status: 'mitigated' });
      }
    }

    const postImpact = runImpact(parsedScenario, recommendationRun.disruptions, {
      now: runtime.currentTime,
      includeUnaffected: true,
      ...(runtime.active.resourcePriorityOverrides
        ? { resourcePriorityOverrides: runtime.active.resourcePriorityOverrides }
        : {}),
    });

    return {
      scenario: parsedScenario,
      action: actionEntry.action,
      recommendationRun,
      postImpact,
      ...(runtime.active.resourcePriorityOverrides
        ? { resourcePriorityOverrides: runtime.active.resourcePriorityOverrides }
        : {}),
    };
  }

  reset(scenarioId: string): GeneratedScenario {
    const runtime = this.scenarios.get(scenarioId);
    if (!runtime) {
      throw new ScenarioStoreError('scenario_not_found', 404, `Scenario not found: ${scenarioId}`);
    }
    const resetScenario = structuredClone(runtime.baseline);
    resetScenario.scenario.version = 0;
    runtime.active = { scenario: resetScenario };
    runtime.currentTime = resetScenario.scenario.scenarioStart;
    runtime.disruptions.clear();
    runtime.recommendationRuns.clear();
    runtime.actionsById.clear();
    return resetScenario;
  }
}

function summarizeScenario(scenario: GeneratedScenario): ScenarioSummary {
  return {
    id: scenario.scenario.id,
    name: scenario.scenario.name,
    seed: scenario.scenario.seed,
    version: scenario.scenario.version,
    counts: {
      locations: scenario.locations.length,
      lanes: scenario.lanes.length,
      products: scenario.products.length,
      shipments: scenario.shipments.length,
      commitments: scenario.commitments.length,
      inventoryPools: scenario.inventoryPools.length,
      capacityPools: scenario.capacityPools.length,
    },
  };
}
