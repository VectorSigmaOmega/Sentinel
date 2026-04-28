import { z } from 'zod';

export const locationKindSchema = z.enum([
  'supplier',
  'factory',
  'hub',
  'port',
  'warehouse',
  'destination',
]);
export type LocationKind = z.infer<typeof locationKindSchema>;

export const laneModeSchema = z.enum(['truck', 'rail', 'ocean', 'air']);
export type LaneMode = z.infer<typeof laneModeSchema>;

export const prioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
export type Priority = z.infer<typeof prioritySchema>;

export const penaltyCurveSchema = z.enum(['cliff', 'ramp', 'exponential']);
export type PenaltyCurve = z.infer<typeof penaltyCurveSchema>;

export const objectivePresetSchema = z.enum([
  'protect_p0',
  'min_total_risk',
  'min_cost',
  'max_resilience',
  'balanced',
]);
export type ObjectivePreset = z.infer<typeof objectivePresetSchema>;

export const locationSchema = z.object({
  id: z.string().min(1),
  scenarioId: z.string().min(1),
  kind: locationKindSchema,
  name: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  handlingTimeHours: z.number().nonnegative(),
  capacityUnitsPerHour: z.number().positive(),
  status: z.enum(['open', 'closed']),
  tags: z.array(z.string()),
});
export type Location = z.infer<typeof locationSchema>;

export const laneSchema = z.object({
  id: z.string().min(1),
  scenarioId: z.string().min(1),
  originId: z.string().min(1),
  destinationId: z.string().min(1),
  mode: laneModeSchema,
  transitHours: z.number().positive(),
  capacityUnitsPerHour: z.number().positive(),
  costPerUnit: z.number().nonnegative(),
  reliability: z.number().min(0).max(1),
  supportsColdChain: z.boolean(),
  supportsHazmat: z.boolean(),
  status: z.enum(['open', 'closed']),
});
export type Lane = z.infer<typeof laneSchema>;

export const productSchema = z.object({
  id: z.string().min(1),
  scenarioId: z.string().min(1),
  name: z.string().min(1),
  requiresColdChain: z.boolean(),
  requiresHazmat: z.boolean(),
  shelfLifeHours: z.number().positive().nullable(),
});
export type Product = z.infer<typeof productSchema>;

export const substitutionGroupSchema = z.object({
  id: z.string().min(1),
  scenarioId: z.string().min(1),
  name: z.string().min(1),
  notes: z.string(),
  productIds: z.array(z.string().min(1)).min(1),
});
export type SubstitutionGroup = z.infer<typeof substitutionGroupSchema>;

export const commitmentSchema = z.object({
  id: z.string().min(1),
  scenarioId: z.string().min(1),
  quantity: z.number().positive(),
  priority: prioritySchema,
  mustArriveBy: z.number().int(),
  delayToleranceHours: z.number().positive(),
  penaltyCurve: penaltyCurveSchema,
  status: z.enum(['open', 'fulfilled', 'failed']),
  baselineRisk: z.number().nonnegative(),
  currentRisk: z.number().nonnegative(),
  requiredProductId: z.string().min(1),
  deliveredToId: z.string().min(1),
  tags: z.array(z.string()),
});
export type Commitment = z.infer<typeof commitmentSchema>;

export const shipmentSchema = z.object({
  id: z.string().min(1),
  scenarioId: z.string().min(1),
  quantity: z.number().positive(),
  originType: z.enum(['location', 'inventory_pool']),
  status: z.enum(['pending', 'in_transit', 'delivered', 'failed', 'cancelled']),
  baselineEta: z.number().int(),
  currentEta: z.number().int(),
  currentLaneIndex: z.number().int().nonnegative(),
  progressFraction: z.number().min(0).max(1),
  productId: z.string().min(1),
  originId: z.string().min(1),
  destinationId: z.string().min(1),
  laneSequence: z.array(z.string().min(1)),
});
export type Shipment = z.infer<typeof shipmentSchema>;

export const fulfillmentSchema = z.object({
  shipmentId: z.string().min(1),
  commitmentId: z.string().min(1),
  quantity: z.number().positive(),
});
export type Fulfillment = z.infer<typeof fulfillmentSchema>;

export const inventoryPoolSchema = z.object({
  id: z.string().min(1),
  scenarioId: z.string().min(1),
  quantityOnHand: z.number().nonnegative(),
  safetyStock: z.number().nonnegative(),
  demandUnitsPerHour: z.number().nonnegative(),
  storedAtId: z.string().min(1),
  productId: z.string().min(1),
  poolTransferCostPerUnit: z.number().nonnegative(),
});
export type InventoryPool = z.infer<typeof inventoryPoolSchema>;

export const capacityPoolSchema = z.object({
  id: z.string().min(1),
  scenarioId: z.string().min(1),
  unitsPerHour: z.number().positive(),
  scope: z.enum(['location', 'lane']),
  constrainedEntityIds: z.array(z.string().min(1)).min(1),
});
export type CapacityPool = z.infer<typeof capacityPoolSchema>;

export const disruptionEffectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('closure') }),
  z.object({ kind: z.literal('add_delay'), hours: z.number().positive() }),
  z.object({ kind: z.literal('capacity_multiplier'), multiplier: z.number().min(0) }),
  z.object({ kind: z.literal('cost_multiplier'), multiplier: z.number().min(0) }),
  z.object({ kind: z.literal('demand_multiplier'), multiplier: z.number().min(0) }),
  z.object({
    kind: z.literal('inventory_loss'),
    mode: z.enum(['absolute', 'fraction']),
    amount: z.number().min(0),
  }),
  z.object({ kind: z.literal('reliability_multiplier'), multiplier: z.number().min(0) }),
]);
export type DisruptionEffect = z.infer<typeof disruptionEffectSchema>;

export const disruptionSchema = z.object({
  id: z.string().min(1),
  scenarioId: z.string().min(1),
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
  startsAt: z.number().int(),
  endsAt: z.number().int(),
  severity: z.number().min(0).max(1),
  effects: z.array(disruptionEffectSchema).min(1),
  status: z.enum(['active', 'mitigated', 'resolved']),
});
export type Disruption = z.infer<typeof disruptionSchema>;

export const recoveryActionSchema = z.object({
  id: z.string().min(1),
  scenarioId: z.string().min(1),
  type: z.enum([
    'reroute',
    'reallocate_inventory',
    'reprioritize_capacity',
    'switch_origin',
    'expedite',
    'split_shipment',
  ]),
  status: z.enum(['proposed', 'applied', 'rejected']),
  summary: z.string(),
  score: z.number(),
  riskReduction: z.number(),
  addedCost: z.number().nonnegative(),
  etaImprovementHours: z.number(),
  complexity: z.number().min(1).max(5),
  createdAt: z.number().int(),
  appliedAt: z.number().int().nullable(),
  payload: z.record(z.unknown()),
});
export type RecoveryAction = z.infer<typeof recoveryActionSchema>;

export const scenarioSchema = z.object({
  id: z.string().min(1),
  seed: z.string().min(1),
  name: z.string().min(1),
  scenarioStart: z.number().int(),
  createdAt: z.number().int(),
  version: z.number().int().nonnegative(),
  generatorConfigHash: z.string().min(1),
});
export type Scenario = z.infer<typeof scenarioSchema>;

export const producesSchema = z.object({
  locationId: z.string().min(1),
  productId: z.string().min(1),
});
export type Produces = z.infer<typeof producesSchema>;

export const generatedScenarioSchema = z.object({
  scenario: scenarioSchema,
  locations: z.array(locationSchema),
  lanes: z.array(laneSchema),
  products: z.array(productSchema),
  substitutionGroups: z.array(substitutionGroupSchema),
  commitments: z.array(commitmentSchema),
  shipments: z.array(shipmentSchema),
  fulfillments: z.array(fulfillmentSchema),
  inventoryPools: z.array(inventoryPoolSchema),
  capacityPools: z.array(capacityPoolSchema),
  produces: z.array(producesSchema),
});
export type GeneratedScenario = z.infer<typeof generatedScenarioSchema>;

export const PRIORITY_WEIGHTS: Record<Priority, number> = {
  P0: 1,
  P1: 0.7,
  P2: 0.4,
  P3: 0.15,
};
