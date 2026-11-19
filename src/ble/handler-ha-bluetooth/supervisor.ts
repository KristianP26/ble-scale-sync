/** Paths under which the Supervisor proxies Home Assistant Core's websocket. */
const SUPERVISOR_WS_PATHS: ReadonlySet<string> = new Set([
  '/core/websocket',
  '/core/api/websocket',
]);

/** True only for the Supervisor's websocket proxy, as a Home Assistant add-on reaches it. */
export function isSupervisorUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      (u.protocol === 'ws:' || u.protocol === 'http:') &&
      u.hostname === 'supervisor' &&
      u.port === '' &&
      SUPERVISOR_WS_PATHS.has(u.pathname) &&
      u.username === '' &&
      u.password === '' &&
      u.search === '' &&
      u.hash === ''
    );
  } catch {
    return false;
  }
}

/**
 * The token to log in with: the configured one, else the add-on's own
 * SUPERVISOR_TOKEN, and that only for the Supervisor URL so it can never be
 * sent to another host.
 */
export function haAccessToken(
  config: { url: string; token?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (config.token) return config.token;
  return isSupervisorUrl(config.url) ? env.SUPERVISOR_TOKEN || undefined : undefined;
}
