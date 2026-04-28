import {
  objectivePresetSchema,
  recoveryActionSchema,
  type Disruption,
  type Fulfillment,
  type GeneratedScenario,
  type ObjectivePreset,
  type RecoveryAction,
  type Shipment,
} from '@sentinel/ontology';
import {
  runImpact,
  type CommitmentImpactObservation,
  type ImpactRun,
  type ResourcePriorityOverrides,
} from '@sentinel/impact';
import {
  buildRoutingProjection,
  computeExclusionsFromDisruptions,
  dijkstraRoute,
  generateRerouteCandidates,
} from '@sentinel/routing';

export type RecommendationWeights = {
  risk: number;
  saved: number;
  resilience: number;
  cost: number;
  complexity: number;
};

export type RecommendationAction = {
  action: RecoveryAction;
  commitmentsSaved: string[];
  commitmentsHarmed: string[];
  impact?: ImpactRun;
};

export type RecommendationRunSummary = {
  candidateCount: number;
  topScore: number | null;
  bestActionId: string | null;
  supportedGenerators: Array<'reroute' | 'reallocate_inventory' | 'reprioritize_capacity'>;
};

export type RecommendationRun = {
  id: string;
  scenarioId: string;
  scenarioVersion: number;
  objective: ObjectivePreset;
  createdAt: number;
  disruptions: Disruption[];
  baselineImpact: ImpactRun;
  actions: RecommendationAction[];
  summary: RecommendationRunSummary;
};

export type RecommendationRunOptions = {
  id?: string;
  now?: number;
  objective?: ObjectivePreset;
  rerouteK?: number;
  topKCommitments?: number;
  maxCandidates?: number;
  includeImpactRuns?: boolean;
  enableReroute?: boolean;
  enableInventoryReallocation?: boolean;
  enableCapacityReprioritization?: boolean;
  baseResourcePriorityOverrides?: ResourcePriorityOverrides;
};

export type RecommendationState = {
  scenario: GeneratedScenario;
  resourcePriorityOverrides?: ResourcePriorityOverrides;
};

type CandidateSpec = {
  action: RecoveryAction;
  apply: (state: RecommendationState) => RecommendationState;
};

type CandidateEvaluation = RecommendationAction & {
  riskReduction: number;
  addedCost: number;
  etaImprovementHours: number;
};

const OBJECTIVE_WEIGHTS: Record<ObjectivePreset, RecommendationWeights> = {
  protect_p0: { risk: 0.4, saved: 0.5, resilience: 0, cost: 0.05, complexity: 0.05 },
  min_total_risk: { risk: 0.6, saved: 0.2, resilience: 0, cost: 0.1, complexity: 0.1 },
  min_cost: { risk: 0.1, saved: 0.1, resilience: 0, cost: 0.7, complexity: 0.1 },
  max_resilience: { risk: 0.2, saved: 0.2, resilience: 0.5, cost: 0.05, complexity: 0.05 },
  balanced: { risk: 0.3, saved: 0.25, resilience: 0.15, cost: 0.2, complexity: 0.1 },
};

export function generateRecommendationRun(
  scenario: GeneratedScenario,
  disruptions: readonly Disruption[],
  options: RecommendationRunOptions = {},
): RecommendationRun {
  const objective = objectivePresetSchema.parse(options.objective ?? 'balanced');
  const now = options.now ?? scenario.scenario.scenarioStart;
  const baseState: RecommendationState = {
    scenario,
    ...(options.baseResourcePriorityOverrides ? { resourcePriorityOverrides: options.baseResourcePriorityOverrides } : {}),
  };
  const baselineImpact = runImpact(scenario, disruptions, {
    now,
    includeUnaffected: true,
    ...(baseState.resourcePriorityOverrides ? { resourcePriorityOverrides: baseState.resourcePriorityOverrides } : {}),
  });
  const candidateSpecs = generateCandidates(scenario, disruptions, baselineImpact, {
    now,
    rerouteK: options.rerouteK ?? 3,
    topKCommitments: options.topKCommitments ?? 20,
    maxCandidates: options.maxCandidates ?? 25,
    enableReroute: options.enableReroute ?? true,
    enableInventoryReallocation: options.enableInventoryReallocation ?? true,
    enableCapacityReprioritization: options.enableCapacityReprioritization ?? true,
  });

  const evaluations = candidateSpecs.map((candidate) =>
    evaluateCandidate(candidate, baseState, disruptions, baselineImpact, now, options.includeImpactRuns ?? false, objective),
  );
  const norms = computeNorms(evaluations);
  const actions = evaluations
    .map((evaluation) => {
      const action = recoveryActionSchema.parse({
        ...evaluation.action,
        score: round(scoreCandidate(evaluation, OBJECTIVE_WEIGHTS[objective], norms), 6),
        riskReduction: round(evaluation.riskReduction, 6),
        addedCost: round(evaluation.addedCost, 3),
        etaImprovementHours: round(evaluation.etaImprovementHours, 3),
      });
      return {
        action,
        commitmentsSaved: evaluation.commitmentsSaved,
        commitmentsHarmed: evaluation.commitmentsHarmed,
        ...(evaluation.impact ? { impact: evaluation.impact } : {}),
      };
    })
    .sort(
      (a, b) =>
        b.action.score - a.action.score ||
        b.action.riskReduction - a.action.riskReduction ||
        a.action.addedCost - b.action.addedCost ||
        a.action.id.localeCompare(b.action.id),
    );

  return {
    id: options.id ?? `${scenario.scenario.id}:recommendation-${objective}-${now}`,
    scenarioId: scenario.scenario.id,
    scenarioVersion: scenario.scenario.version,
    objective,
    createdAt: now,
    disruptions: [...disruptions],
    baselineImpact,
    actions,
    summary: {
      candidateCount: actions.length,
      topScore: actions[0]?.action.score ?? null,
      bestActionId: actions[0]?.action.id ?? null,
      supportedGenerators: [
        ...(options.enableReroute === false ? [] : ['reroute' as const]),
        ...(options.enableInventoryReallocation === false ? [] : ['reallocate_inventory' as const]),
        ...(options.enableCapacityReprioritization === false ? [] : ['reprioritize_capacity' as const]),
      ],
    },
  };
}

function generateCandidates(
  scenario: GeneratedScenario,
  disruptions: readonly Disruption[],
  baselineImpact: ImpactRun,
  options: {
    now: number;
    rerouteK: number;
    topKCommitments: number;
    maxCandidates: number;
    enableReroute: boolean;
    enableInventoryReallocation: boolean;
    enableCapacityReprioritization: boolean;
  },
): CandidateSpec[] {
  const candidates: CandidateSpec[] = [];
  let candidateCounter = 0;

  if (options.enableReroute) {
    const projection = buildRoutingProjection(scenario);
    const exclusions = computeExclusionsFromDisruptions(disruptions);
    const impactedShipments = baselineImpact.shipmentObservations
      .filter((observation) => observation.affected)
      .sort((a, b) => (b.etaDeltaHours ?? 0) - (a.etaDeltaHours ?? 0) || a.shipmentId.localeCompare(b.shipmentId));

    for (const observation of impactedShipments) {
      const shipment = scenario.shipments.find((item) => item.id === observation.shipmentId);
      if (!shipment || shipment.originType !== 'location') continue;
      const reroutes = generateRerouteCandidates(projection, shipment, { exclusions }, options.rerouteK);
      for (const reroute of reroutes) {
        candidateCounter += 1;
        const action = recoveryActionSchema.parse({
          id: `${scenario.scenario.id}:action-reroute-${pad(candidateCounter)}`,
          scenarioId: scenario.scenario.id,
          type: 'reroute',
          status: 'proposed',
          summary: `Reroute ${shipment.id} to ${reroute.path.laneIds.join(' -> ')}`,
          score: 0,
          riskReduction: 0,
          addedCost: Math.max(0, round(reroute.costDelta, 3)),
          etaImprovementHours: round(-reroute.etaDeltaHours, 3),
          complexity: 2,
          createdAt: options.now,
          appliedAt: null,
          payload: {
            shipmentId: shipment.id,
            previousLaneSequence: [...shipment.laneSequence],
            newLaneSequence: [...reroute.path.laneIds],
            estimatedTransitHours: round(reroute.path.totalTransitHours, 3),
            estimatedEtaDeltaHours: round(reroute.etaDeltaHours, 3),
            estimatedCostDelta: round(reroute.costDelta, 3),
          },
        });
        candidates.push({
          action,
          apply: (inputState) => applyRerouteAction(inputState, shipment.id, reroute.path.laneIds),
        });
        if (candidates.length >= options.maxCandidates) return dedupeCandidates(candidates);
      }
    }
  }

  if (options.enableInventoryReallocation) {
    const impactedCommitments = baselineImpact.commitmentObservations
      .filter((observation) => observation.atRiskAfter)
      .sort((a, b) => b.riskAfter - a.riskAfter || a.commitmentId.localeCompare(b.commitmentId))
      .slice(0, options.topKCommitments);

    for (const observation of impactedCommitments) {
      const candidate = buildInventoryCandidate(scenario, disruptions, baselineImpact, observation, options.now, candidateCounter + 1);
      if (!candidate) continue;
      candidateCounter += 1;
      candidates.push(candidate);
      if (candidates.length >= options.maxCandidates) return dedupeCandidates(candidates);
    }
  }

  if (options.enableCapacityReprioritization) {
    const impactedResources = baselineImpact.queueObservations
      .filter((observation) => observation.queueDelayHours > 0)
      .map((observation) => observation.resourceId)
      .filter((resourceId, index, values) => values.indexOf(resourceId) === index)
      .sort();

    for (const resourceId of impactedResources) {
      candidateCounter += 1;
      const candidate = buildCapacityReprioritizationCandidate(
        scenario,
        baselineImpact,
        options.now,
        candidateCounter,
        resourceId,
      );
      if (!candidate) {
        candidateCounter -= 1;
        continue;
      }
      candidates.push(candidate);
      if (candidates.length >= options.maxCandidates) return dedupeCandidates(candidates);
    }
  }

  return dedupeCandidates(candidates);
}

function buildInventoryCandidate(
  scenario: GeneratedScenario,
  disruptions: readonly Disruption[],
  baselineImpact: ImpactRun,
  observation: CommitmentImpactObservation,
  now: number,
  actionIndex: number,
): CandidateSpec | null {
  const commitment = scenario.commitments.find((item) => item.id === observation.commitmentId);
  if (!commitment) return null;

  const pool = scenario.inventoryPools
    .filter(
      (item) =>
        item.storedAtId === commitment.deliveredToId &&
        item.productId === commitment.requiredProductId &&
        item.quantityOnHand > item.safetyStock,
    )
    .sort(
      (a, b) =>
        b.quantityOnHand - b.safetyStock - (a.quantityOnHand - a.safetyStock) ||
        a.poolTransferCostPerUnit - b.poolTransferCostPerUnit ||
        a.id.localeCompare(b.id),
    )[0];
  if (!pool) return null;

  const fulfillments = scenario.fulfillments
    .filter((item) => item.commitmentId === commitment.id)
    .map((fulfillment) => {
      const shipment = scenario.shipments.find((item) => item.id === fulfillment.shipmentId);
      const impact = baselineImpact.shipmentObservations.find((item) => item.shipmentId === fulfillment.shipmentId);
      return shipment && impact
        ? { fulfillment, shipment, etaAfter: impact.etaAfter ?? Number.POSITIVE_INFINITY }
        : null;
    })
    .filter((item): item is { fulfillment: Fulfillment; shipment: Shipment; etaAfter: number } => Boolean(item))
    .sort((a, b) => b.etaAfter - a.etaAfter || a.shipment.id.localeCompare(b.shipment.id));
  const lateQuantity = fulfillments
    .filter((item) => item.etaAfter > commitment.mustArriveBy)
    .reduce((sum, item) => sum + item.fulfillment.quantity, 0);
  const allocatedQuantity = Math.min(commitment.quantity, pool.quantityOnHand - pool.safetyStock, lateQuantity || commitment.quantity);
  if (allocatedQuantity <= 0) return null;

  const projection = buildRoutingProjection(scenario);
  const syntheticRoute = pool.storedAtId === commitment.deliveredToId
    ? { laneIds: [] as string[], totalTransitHours: 0, totalCost: 0 }
    : dijkstraRoute(projection, pool.storedAtId, commitment.deliveredToId, {
      shipment: {
        id: `${scenario.scenario.id}:inventory-preview`,
        scenarioId: scenario.scenario.id,
        quantity: allocatedQuantity,
        originType: 'location',
        status: 'pending',
        baselineEta: now,
        currentEta: now,
        currentLaneIndex: 0,
        progressFraction: 0,
        productId: commitment.requiredProductId,
        originId: pool.storedAtId,
        destinationId: commitment.deliveredToId,
        laneSequence: [],
      },
      exclusions: computeExclusionsFromDisruptions(disruptions),
    });
  if (!syntheticRoute) return null;

  let remaining = allocatedQuantity;
  const allocationDelta: Array<{ shipmentId: string; quantity: number }> = [];
  for (const item of fulfillments) {
    if (remaining <= 0) break;
    const quantity = Math.min(remaining, item.fulfillment.quantity);
    allocationDelta.push({ shipmentId: item.shipment.id, quantity });
    remaining -= quantity;
  }
  if (remaining > 0) return null;

  const syntheticShipmentId = `${scenario.scenario.id}:ship-inv-${pad(actionIndex)}`;
  const action = recoveryActionSchema.parse({
    id: `${scenario.scenario.id}:action-reallocate-${pad(actionIndex)}`,
    scenarioId: scenario.scenario.id,
    type: 'reallocate_inventory',
    status: 'proposed',
    summary: `Reallocate ${allocatedQuantity} units from ${pool.id} to ${commitment.id}`,
    score: 0,
    riskReduction: 0,
    addedCost: round(allocatedQuantity * (pool.poolTransferCostPerUnit + syntheticRoute.totalCost), 3),
    etaImprovementHours: round(observation.latenessHoursAfter ?? 0, 3),
    complexity: 3,
    createdAt: now,
    appliedAt: null,
    payload: {
      poolId: pool.id,
      commitmentId: commitment.id,
      allocatedQuantity,
      syntheticShipmentId,
      laneSequence: [...syntheticRoute.laneIds],
      allocationDelta,
    },
  });
  return {
    action,
    apply: (inputState) =>
      applyInventoryReallocationAction(inputState, {
        poolId: pool.id,
        commitmentId: commitment.id,
        allocatedQuantity,
        syntheticShipmentId,
        laneSequence: [...syntheticRoute.laneIds],
        allocationDelta,
        now,
      }),
  };
}

function buildCapacityReprioritizationCandidate(
  scenario: GeneratedScenario,
  baselineImpact: ImpactRun,
  now: number,
  actionIndex: number,
  resourceId: string,
): CandidateSpec | null {
  const queueEntries = baselineImpact.queueObservations
    .filter((observation) => observation.resourceId === resourceId)
    .sort((a, b) => a.arrivalAt - b.arrivalAt || a.shipmentId.localeCompare(b.shipmentId));
  if (queueEntries.length < 2) return null;

  const baselineOrder = queueEntries.map((entry) => entry.shipmentId);
  const overrideOrder = [...baselineOrder].sort((a, b) => compareShipmentPriority(scenario, a, b));
  if (sameShipmentOrder(baselineOrder, overrideOrder)) return null;

  const action = recoveryActionSchema.parse({
    id: `${scenario.scenario.id}:action-reprioritize-${pad(actionIndex)}`,
    scenarioId: scenario.scenario.id,
    type: 'reprioritize_capacity',
    status: 'proposed',
    summary: `Reprioritize queue at ${resourceId}`,
    score: 0,
    riskReduction: 0,
    addedCost: 0,
    etaImprovementHours: 0,
    complexity: 3,
    createdAt: now,
    appliedAt: null,
    payload: {
      resourceId,
      baselineOrder,
      order: overrideOrder,
    },
  });

  return {
    action,
    apply: (inputState) => ({
      scenario: structuredClone(inputState.scenario),
      resourcePriorityOverrides: {
        ...(inputState.resourcePriorityOverrides ?? {}),
        [resourceId]: overrideOrder,
      },
    }),
  };
}

function evaluateCandidate(
  candidate: CandidateSpec,
  baseState: RecommendationState,
  disruptions: readonly Disruption[],
  baselineImpact: ImpactRun,
  now: number,
  includeImpactRun: boolean,
  objective: ObjectivePreset,
): CandidateEvaluation {
  const applied = candidate.apply(baseState);
  const nextImpact = runImpact(applied.scenario, disruptions, {
    now,
    includeUnaffected: true,
    ...(applied.resourcePriorityOverrides ? { resourcePriorityOverrides: applied.resourcePriorityOverrides } : {}),
  });
  const baselineByCommitment = new Map(baselineImpact.commitmentObservations.map((item) => [item.commitmentId, item]));
  const nextByCommitment = new Map(nextImpact.commitmentObservations.map((item) => [item.commitmentId, item]));
  const commitmentsSaved: string[] = [];
  const commitmentsHarmed: string[] = [];

  for (const [commitmentId, baseline] of baselineByCommitment) {
    const next = nextByCommitment.get(commitmentId);
    if (!next) continue;
    if (baseline.atRiskAfter && !next.atRiskAfter && shouldCountSavedCommitment(objective, baseline.priority)) {
      commitmentsSaved.push(commitmentId);
    }
    if (!baseline.atRiskAfter && next.atRiskAfter) {
      commitmentsHarmed.push(commitmentId);
    }
  }

  return {
    action: candidate.action,
    commitmentsSaved,
    commitmentsHarmed,
    ...(includeImpactRun ? { impact: nextImpact } : {}),
    riskReduction: round(baselineImpact.summary.totalRiskAfter - nextImpact.summary.totalRiskAfter, 6),
    addedCost: candidate.action.addedCost,
    etaImprovementHours: round(averageEtaImprovementHours(baselineImpact, nextImpact), 3),
  };
}

function computeNorms(evaluations: readonly CandidateEvaluation[]): { risk: number; saved: number; cost: number } {
  return {
    risk: Math.max(1, ...evaluations.map((item) => Math.abs(item.riskReduction))),
    saved: Math.max(1, ...evaluations.map((item) => item.commitmentsSaved.length)),
    cost: Math.max(1, ...evaluations.map((item) => Math.abs(item.addedCost))),
  };
}

function scoreCandidate(
  evaluation: CandidateEvaluation,
  weights: RecommendationWeights,
  norms: { risk: number; saved: number; cost: number },
): number {
  return (
    weights.risk * (evaluation.riskReduction / norms.risk) +
    weights.saved * (evaluation.commitmentsSaved.length / norms.saved) -
    weights.cost * (evaluation.addedCost / norms.cost) -
    weights.complexity * (evaluation.action.complexity / 5)
  );
}

function applyRerouteAction(
  state: RecommendationState,
  shipmentId: string,
  laneSequence: readonly string[],
): RecommendationState {
  const nextScenario = structuredClone(state.scenario);
  const shipment = nextScenario.shipments.find((item) => item.id === shipmentId);
  if (!shipment) throw new Error(`Unknown shipment for reroute: ${shipmentId}`);
  shipment.laneSequence = [...laneSequence];
  shipment.currentLaneIndex = 0;
  shipment.progressFraction = 0;
  return {
    scenario: nextScenario,
    ...(state.resourcePriorityOverrides ? { resourcePriorityOverrides: structuredClone(state.resourcePriorityOverrides) } : {}),
  };
}

function applyInventoryReallocationAction(
  state: RecommendationState,
  action: {
    poolId: string;
    commitmentId: string;
    allocatedQuantity: number;
    syntheticShipmentId: string;
    laneSequence: string[];
    allocationDelta: Array<{ shipmentId: string; quantity: number }>;
    now: number;
  },
): RecommendationState {
  const nextScenario = structuredClone(state.scenario);
  const pool = nextScenario.inventoryPools.find((item) => item.id === action.poolId);
  const commitment = nextScenario.commitments.find((item) => item.id === action.commitmentId);
  if (!pool || !commitment) throw new Error(`Unknown inventory reallocation target: ${action.poolId}/${action.commitmentId}`);
  pool.quantityOnHand = round(pool.quantityOnHand - action.allocatedQuantity, 3);

  for (const delta of action.allocationDelta) {
    const fulfillment = nextScenario.fulfillments.find(
      (item) => item.shipmentId === delta.shipmentId && item.commitmentId === action.commitmentId,
    );
    if (!fulfillment) throw new Error(`Missing fulfillment for reallocation: ${delta.shipmentId}/${action.commitmentId}`);
    fulfillment.quantity = round(fulfillment.quantity - delta.quantity, 3);
  }
  nextScenario.fulfillments = nextScenario.fulfillments.filter((item) => item.quantity > 0);

  nextScenario.shipments.push({
    id: action.syntheticShipmentId,
    scenarioId: nextScenario.scenario.id,
    quantity: action.allocatedQuantity,
    originType: 'inventory_pool',
    status: 'pending',
    baselineEta: action.now,
    currentEta: action.now,
    currentLaneIndex: 0,
    progressFraction: 0,
    productId: commitment.requiredProductId,
    originId: pool.id,
    destinationId: commitment.deliveredToId,
    laneSequence: [...action.laneSequence],
  });
  nextScenario.fulfillments.push({
    shipmentId: action.syntheticShipmentId,
    commitmentId: action.commitmentId,
    quantity: action.allocatedQuantity,
  });
  return {
    scenario: nextScenario,
    ...(state.resourcePriorityOverrides ? { resourcePriorityOverrides: structuredClone(state.resourcePriorityOverrides) } : {}),
  };
}

function averageEtaImprovementHours(baseline: ImpactRun, next: ImpactRun): number {
  const nextByCommitment = new Map(next.commitmentObservations.map((item) => [item.commitmentId, item]));
  let total = 0;
  let count = 0;
  for (const observation of baseline.commitmentObservations) {
    const candidate = nextByCommitment.get(observation.commitmentId);
    if (!candidate) continue;
    if (observation.completionEtaAfter === null || candidate.completionEtaAfter === null) continue;
    total += (observation.completionEtaAfter - candidate.completionEtaAfter) / 3_600_000;
    count += 1;
  }
  return count === 0 ? 0 : total / count;
}

export function applyRecoveryAction(
  scenario: GeneratedScenario,
  action: RecoveryAction,
  resourcePriorityOverrides?: ResourcePriorityOverrides,
): RecommendationState {
  return applyRecoveryActionState(
    {
      scenario,
      ...(resourcePriorityOverrides ? { resourcePriorityOverrides } : {}),
    },
    action,
  );
}

export function applyRecoveryActionState(
  state: RecommendationState,
  action: RecoveryAction,
): RecommendationState {
  if (action.type === 'reroute') {
    const shipmentId = stringPayload(action.payload, 'shipmentId');
    const laneSequence = stringArrayPayload(action.payload, 'newLaneSequence');
    return applyRerouteAction(state, shipmentId, laneSequence);
  }

  if (action.type === 'reallocate_inventory') {
    return applyInventoryReallocationAction(state, {
      poolId: stringPayload(action.payload, 'poolId'),
      commitmentId: stringPayload(action.payload, 'commitmentId'),
      allocatedQuantity: numberPayload(action.payload, 'allocatedQuantity'),
      syntheticShipmentId: stringPayload(action.payload, 'syntheticShipmentId'),
      laneSequence: stringArrayPayload(action.payload, 'laneSequence'),
      allocationDelta: allocationDeltaPayload(action.payload),
      now: action.createdAt,
    });
  }

  if (action.type === 'reprioritize_capacity') {
    const resourceId = stringPayload(action.payload, 'resourceId');
    const order = stringArrayPayload(action.payload, 'order');
    return {
      scenario: structuredClone(state.scenario),
      resourcePriorityOverrides: {
        ...(state.resourcePriorityOverrides ?? {}),
        [resourceId]: order,
      },
    };
  }

  throw new Error(`Unsupported recovery action type: ${action.type}`);
}

function dedupeCandidates(candidates: readonly CandidateSpec[]): CandidateSpec[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = JSON.stringify({ type: candidate.action.type, payload: candidate.action.payload });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function shouldCountSavedCommitment(objective: ObjectivePreset, priority: string): boolean {
  if (objective !== 'protect_p0') return true;
  return priority === 'P0' || priority === 'P1';
}

function compareShipmentPriority(
  scenario: GeneratedScenario,
  shipmentIdA: string,
  shipmentIdB: string,
): number {
  const keyA = shipmentPriorityKey(scenario, shipmentIdA);
  const keyB = shipmentPriorityKey(scenario, shipmentIdB);
  return (
    keyA.priorityRank - keyB.priorityRank ||
    keyA.mustArriveBy - keyB.mustArriveBy ||
    keyB.quantity - keyA.quantity ||
    keyA.commitmentId.localeCompare(keyB.commitmentId) ||
    shipmentIdA.localeCompare(shipmentIdB)
  );
}

function shipmentPriorityKey(
  scenario: GeneratedScenario,
  shipmentId: string,
): {
  priorityRank: number;
  mustArriveBy: number;
  quantity: number;
  commitmentId: string;
} {
  const keys = scenario.fulfillments
    .filter((item) => item.shipmentId === shipmentId)
    .map((fulfillment) => {
      const commitment = scenario.commitments.find((item) => item.id === fulfillment.commitmentId);
      if (!commitment) return null;
      return {
        priorityRank: priorityRank(commitment.priority),
        mustArriveBy: commitment.mustArriveBy,
        quantity: commitment.quantity,
        commitmentId: commitment.id,
      };
    })
    .filter(
      (
        item,
      ): item is { priorityRank: number; mustArriveBy: number; quantity: number; commitmentId: string } => Boolean(item),
    )
    .sort(
      (a, b) =>
        a.priorityRank - b.priorityRank ||
        a.mustArriveBy - b.mustArriveBy ||
        b.quantity - a.quantity ||
        a.commitmentId.localeCompare(b.commitmentId),
    );
  return keys[0] ?? {
    priorityRank: Number.MAX_SAFE_INTEGER,
    mustArriveBy: Number.MAX_SAFE_INTEGER,
    quantity: 0,
    commitmentId: shipmentId,
  };
}

function priorityRank(priority: string): number {
  if (priority === 'P0') return 0;
  if (priority === 'P1') return 1;
  if (priority === 'P2') return 2;
  return 3;
}

function sameShipmentOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function stringPayload(payload: RecoveryAction['payload'], key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid recovery action payload field: ${key}`);
  }
  return value;
}

function numberPayload(payload: RecoveryAction['payload'], key: string): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid recovery action payload field: ${key}`);
  }
  return value;
}

function stringArrayPayload(payload: RecoveryAction['payload'], key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Invalid recovery action payload field: ${key}`);
  }
  return [...value];
}

function allocationDeltaPayload(payload: RecoveryAction['payload']): Array<{ shipmentId: string; quantity: number }> {
  const value = payload.allocationDelta;
  if (!Array.isArray(value)) throw new Error('Invalid recovery action payload field: allocationDelta');
  return value.map((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof item.shipmentId !== 'string' ||
      typeof item.quantity !== 'number'
    ) {
      throw new Error('Invalid recovery action payload field: allocationDelta');
    }
    return { shipmentId: item.shipmentId, quantity: item.quantity };
  });
}

function pad(value: number): string {
  return String(value).padStart(3, '0');
}

function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
