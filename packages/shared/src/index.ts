export const HOUR_MS = 3_600_000;

export function assertUnreachable(value: never): never {
  throw new Error(`Unreachable value: ${JSON.stringify(value)}`);
}
