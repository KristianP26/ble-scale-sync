import type { Peripheral } from '@stoprocent/noble';
import { bleLog, errMsg, sleep, withTimeout, CONNECT_TIMEOUT_MS } from '../types.js';
import type { NobleApi } from './types.js';

export async function connectWithRetries(
  noble: NobleApi,
  peripheral: Peripheral,
  maxRetries: number,
): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      bleLog.debug(`Connect attempt ${attempt + 1}/${maxRetries + 1}...`);
      await withTimeout(peripheral.connectAsync(), CONNECT_TIMEOUT_MS, 'Connection timed out');
      bleLog.debug('Connected');
      return;
    } catch (err: unknown) {
      const msg = errMsg(err);
      if (attempt >= maxRetries) {
        throw new Error(`Connection failed after ${maxRetries + 1} attempts: ${msg}`);
      }
      const delay = 1000 + attempt * 500;
      bleLog.warn(
        `Connect error: ${msg}. Retrying (${attempt + 1}/${maxRetries}) in ${delay}ms...`,
      );
      try {
        await peripheral.disconnectAsync();
      } catch {
        /* ignore */
      }

      // On 3rd+ failure, restart scanning to reset noble's internal radio state
      if (attempt >= 2) {
        bleLog.debug('Restarting scan to reset radio state...');
        try {
          await noble.stopScanningAsync();
          await sleep(500);
          await noble.startScanningAsync([], true);
          await sleep(500);
          await noble.stopScanningAsync();
        } catch {
          bleLog.debug('Scan restart failed (ignored)');
        }
      }

      await sleep(delay);
    }
  }
}
