/** Default hold window after a complete reading while capturing trailing frames. */
const RAW_CAPTURE_DEFAULT_HOLD_MS = 20_000;

/** Format a buffer as a space-separated lowercase hex string (e.g. "e7 58 01"). */
export function toHex(buf: Buffer | number[]): string {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/**
 * Env-gated raw BLE frame capture for protocol reverse-engineering (#211).
 *
 * When enabled, `waitForRawReading()` logs every notify frame as hex (including
 * frames the adapter parses to null, e.g. the Beurer/Sanitas 0x59 composition
 * frame) and holds the GATT connection open past the weight-stable point so the
 * scale actually transmits its trailing frames before we disconnect.
 *
 *   BLE_RAW_CAPTURE          truthy enables (off for unset/empty/0/false/no/off)
 *   BLE_RAW_CAPTURE_HOLD_SEC optional hold window in seconds (default 20)
 *
 * Read from the environment on each call so tests can toggle it without a module
 * reload. Off by default; has no effect on normal runs.
 */
export function getRawCaptureConfig(): { enabled: boolean; holdMs: number } {
  const raw = (process.env.BLE_RAW_CAPTURE ?? '').trim().toLowerCase();
  const enabled = raw !== '' && raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off';
  const holdSec = Number(process.env.BLE_RAW_CAPTURE_HOLD_SEC);
  const holdMs =
    Number.isFinite(holdSec) && holdSec > 0 ? holdSec * 1000 : RAW_CAPTURE_DEFAULT_HOLD_MS;
  return { enabled, holdMs };
}
