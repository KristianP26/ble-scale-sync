// Topic layout shared by every MQTT proxy module. Kept as a single source of
// truth so that adding a new proxy topic only requires editing one file.

export const COMMAND_TIMEOUT_MS = 30_000;

export function topics(prefix: string, deviceId: string) {
  const base = `${prefix}/${deviceId}`;
  return {
    base,
    status: `${base}/status`,
    scanResults: `${base}/scan/results`,
    config: `${base}/config`,
    beep: `${base}/beep`,
    // GATT proxy topics
    connect: `${base}/connect`,
    connected: `${base}/connected`,
    disconnect: `${base}/disconnect`,
    disconnected: `${base}/disconnected`,
    error: `${base}/error`,
  };
}

export type Topics = ReturnType<typeof topics>;
