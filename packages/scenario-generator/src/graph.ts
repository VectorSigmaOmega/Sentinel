import type { Lane, Location } from '@sentinel/ontology';

export type PathResult = {
  laneIds: string[];
  totalHours: number;
};

export function euclidean(a: Location, b: Location): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function shortestPath(lanes: readonly Lane[], originId: string, destinationId: string): PathResult | null {
  const outgoing = lanesByOrigin(lanes);
  const dist = new Map<string, number>([[originId, 0]]);
  const prev = new Map<string, { nodeId: string; laneId: string }>();
  const visited = new Set<string>();

  while (true) {
    let current: string | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const [nodeId, distance] of dist) {
      if (!visited.has(nodeId) && distance < best) {
        current = nodeId;
        best = distance;
      }
    }
    if (current === null) return null;
    if (current === destinationId) break;
    visited.add(current);

    for (const lane of outgoing.get(current) ?? []) {
      const next = lane.destinationId;
      const candidate = best + lane.transitHours;
      if (candidate < (dist.get(next) ?? Number.POSITIVE_INFINITY)) {
        dist.set(next, candidate);
        prev.set(next, { nodeId: current, laneId: lane.id });
      }
    }
  }

  const laneIds: string[] = [];
  let cursor = destinationId;
  while (cursor !== originId) {
    const step = prev.get(cursor);
    if (!step) return null;
    laneIds.unshift(step.laneId);
    cursor = step.nodeId;
  }
  return { laneIds, totalHours: dist.get(destinationId)! };
}

export function hasPath(lanes: readonly Lane[], originId: string, destinationId: string): boolean {
  return shortestPath(lanes, originId, destinationId) !== null;
}

export function countEdgeDisjointPaths(lanes: readonly Lane[], originId: string, destinationId: string): number {
  const residual = new Map<string, Map<string, { capacity: number; laneId: string | null }>>();
  for (const lane of lanes) {
    addResidual(residual, lane.originId, lane.destinationId, lane.id, 1);
    addResidual(residual, lane.destinationId, lane.originId, null, 0);
  }

  let flow = 0;
  while (true) {
    const parent = new Map<string, { prev: string; laneId: string | null }>();
    const queue = [originId];
    const seen = new Set([originId]);
    for (let i = 0; i < queue.length; i += 1) {
      const current = queue[i]!;
      if (current === destinationId) break;
      for (const [next, edge] of residual.get(current) ?? []) {
        if (edge.capacity <= 0 || seen.has(next)) continue;
        seen.add(next);
        parent.set(next, { prev: current, laneId: edge.laneId });
        queue.push(next);
      }
    }
    if (!seen.has(destinationId)) return flow;

    let cursor = destinationId;
    while (cursor !== originId) {
      const step = parent.get(cursor);
      if (!step) throw new Error('Broken residual parent chain');
      const forward = residual.get(step.prev)?.get(cursor);
      const reverse = residual.get(cursor)?.get(step.prev);
      if (!forward || !reverse) throw new Error('Broken residual edge pair');
      forward.capacity -= 1;
      reverse.capacity += 1;
      cursor = step.prev;
    }
    flow += 1;
  }
}

export function routeTransitHours(lanes: readonly Lane[], laneIds: readonly string[]): number {
  const byId = new Map(lanes.map((lane) => [lane.id, lane]));
  return laneIds.reduce((sum, laneId) => sum + (byId.get(laneId)?.transitHours ?? 0), 0);
}

function lanesByOrigin(lanes: readonly Lane[]): Map<string, Lane[]> {
  const result = new Map<string, Lane[]>();
  for (const lane of lanes) {
    const list = result.get(lane.originId) ?? [];
    list.push(lane);
    result.set(lane.originId, list);
  }
  return result;
}

function addResidual(
  graph: Map<string, Map<string, { capacity: number; laneId: string | null }>>,
  from: string,
  to: string,
  laneId: string | null,
  capacity: number,
): void {
  const edges = graph.get(from) ?? new Map<string, { capacity: number; laneId: string | null }>();
  const existing = edges.get(to);
  if (existing) existing.capacity += capacity;
  else edges.set(to, { capacity, laneId });
  graph.set(from, edges);
}
