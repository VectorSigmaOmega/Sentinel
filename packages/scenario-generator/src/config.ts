import type { LaneMode, LocationKind, PenaltyCurve, Priority } from '@sentinel/ontology';

export type Range = readonly [number, number];

export type NodeTierConfig = {
  kind: LocationKind;
  count: number;
  xRange: Range;
  yRange: Range;
  handlingTimeHoursRange: Range;
  capacityUnitsPerHourRange: Range;
};

export type ProductConfig = {
  id: string;
  name: string;
  requiresColdChain: boolean;
  requiresHazmat: boolean;
  shelfLifeHours?: number;
};

export type SubstitutionGroupConfig = {
  id: string;
  name: string;
  productIds: string[];
};

export type LaneRuleConfig = {
  fromKind: LocationKind;
  toKind: LocationKind;
  mode: LaneMode;
  minDegree: number;
  maxDegree: number;
  speedUnitsPerHour: number;
  costPerDistanceUnit: number;
  reliabilityRange: Range;
  capacityRange: Range;
};

export type HeroCommitmentSpec = {
  priority: Priority;
  productId: string;
  destinationKind?: Extract<LocationKind, 'destination' | 'warehouse'>;
  minDisjointPaths: number;
  quantityRange?: Range;
};

export type ScenarioGeneratorConfig = {
  seed: string;
  name: string;
  scenarioStart: number;
  nodeTiers: NodeTierConfig[];
  products: ProductConfig[];
  substitutionGroups: SubstitutionGroupConfig[];
  laneRules: LaneRuleConfig[];
  commitmentCount: number;
  shipmentCount: number;
  priorityDistribution: Record<Priority, number>;
  penaltyCurveByPriority: Record<Priority, PenaltyCurve>;
  inventoryPoolFraction: number;
  heroCommitmentSpecs?: HeroCommitmentSpec[];
};

export const defaultDemoConfig: ScenarioGeneratorConfig = {
  seed: '42',
  name: 'Sentinel Demo Network',
  scenarioStart: 1_714_219_200_000,
  nodeTiers: [
    {
      kind: 'supplier',
      count: 4,
      xRange: [0, 10],
      yRange: [15, 85],
      handlingTimeHoursRange: [1, 4],
      capacityUnitsPerHourRange: [200, 600],
    },
    {
      kind: 'factory',
      count: 3,
      xRange: [20, 30],
      yRange: [15, 85],
      handlingTimeHoursRange: [2, 6],
      capacityUnitsPerHourRange: [180, 500],
    },
    {
      kind: 'hub',
      count: 5,
      xRange: [45, 55],
      yRange: [10, 90],
      handlingTimeHoursRange: [1, 5],
      capacityUnitsPerHourRange: [150, 450],
    },
    {
      kind: 'warehouse',
      count: 4,
      xRange: [70, 80],
      yRange: [10, 90],
      handlingTimeHoursRange: [1, 4],
      capacityUnitsPerHourRange: [160, 500],
    },
    {
      kind: 'destination',
      count: 12,
      xRange: [92, 100],
      yRange: [0, 100],
      handlingTimeHoursRange: [0.5, 2],
      capacityUnitsPerHourRange: [100, 350],
    },
  ],
  products: [
    { id: 'prod-a', name: 'Critical Load A', requiresColdChain: true, requiresHazmat: false, shelfLifeHours: 96 },
    { id: 'prod-b', name: 'Critical Load B', requiresColdChain: true, requiresHazmat: false, shelfLifeHours: 120 },
    { id: 'prod-c', name: 'Priority Load C', requiresColdChain: false, requiresHazmat: false },
    { id: 'prod-d', name: 'Controlled Load D', requiresColdChain: false, requiresHazmat: true },
  ],
  substitutionGroups: [
    { id: 'sub-a-b', name: 'Critical A/B Substitute Group', productIds: ['prod-a', 'prod-b'] },
  ],
  laneRules: [
    laneRule('supplier', 'factory', 'truck', 1, 2, 3.8, 18),
    laneRule('factory', 'hub', 'rail', 1, 3, 5.5, 13),
    laneRule('hub', 'warehouse', 'truck', 1, 3, 4.8, 16),
    laneRule('warehouse', 'destination', 'truck', 2, 4, 4.2, 20),
  ],
  commitmentCount: 120,
  shipmentCount: 80,
  priorityDistribution: { P0: 0.15, P1: 0.3, P2: 0.35, P3: 0.2 },
  penaltyCurveByPriority: { P0: 'cliff', P1: 'exponential', P2: 'ramp', P3: 'ramp' },
  inventoryPoolFraction: 0.5,
  heroCommitmentSpecs: [
    { priority: 'P0', productId: 'prod-a', destinationKind: 'destination', minDisjointPaths: 2, quantityRange: [1500, 3500] },
    { priority: 'P0', productId: 'prod-b', destinationKind: 'destination', minDisjointPaths: 2, quantityRange: [1000, 3000] },
    { priority: 'P1', productId: 'prod-c', destinationKind: 'destination', minDisjointPaths: 2, quantityRange: [800, 2500] },
  ],
};

function laneRule(
  fromKind: LocationKind,
  toKind: LocationKind,
  mode: LaneMode,
  minDegree: number,
  maxDegree: number,
  speedUnitsPerHour: number,
  costPerDistanceUnit: number,
): LaneRuleConfig {
  return {
    fromKind,
    toKind,
    mode,
    minDegree,
    maxDegree,
    speedUnitsPerHour,
    costPerDistanceUnit,
    reliabilityRange: [0.88, 0.99],
    capacityRange: [80, 320],
  };
}
