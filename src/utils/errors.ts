/**
 * Ensures the value is an Error instance.
 * Useful for catch blocks where the error type is unknown.
 */
export function ensureError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
