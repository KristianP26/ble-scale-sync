/**
 * Hostnames/IPs treated as loopback for the embedded MQTT broker bind check.
 * Used by both the Zod schema refine (config validation) and the broker runtime
 * auth-warning path, so the two stay in sync.
 */
export const LOOPBACK_BINDS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '0:0:0:0:0:0:0:1',
]);

export function isLoopback(host: string): boolean {
  return LOOPBACK_BINDS.has(host.trim().toLowerCase());
}
