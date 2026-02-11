/** Convert an unknown caught value to a human-readable error message. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
