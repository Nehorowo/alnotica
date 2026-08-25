/**
 * Exhaustiveness helper. Placing `assertNever(x)` in a `default:` branch turns a
 * missing union member into a compile-time error and a loud runtime error.
 */
export function assertNever(value: never, context = 'value'): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}

export function assertDefined<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what} to be defined`);
  }
  return value;
}
