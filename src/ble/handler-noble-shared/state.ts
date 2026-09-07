import { bleLog, resetAdapterBtmgmt } from '../types.js';
import type { NobleApi } from './types.js';

/** Wait for the Bluetooth adapter to reach 'poweredOn' state. */
export async function waitForPoweredOn(noble: NobleApi, getState: () => string): Promise<void> {
  if (getState() === 'poweredOn') return;

  const waitOnce = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        noble.removeListener('stateChange', onState);
        resolve(false);
      }, 10_000);
      const onState = (state: string): void => {
        if (state === 'poweredOn') {
          clearTimeout(timeout);
          noble.removeListener('stateChange', onState);
          resolve(true);
        }
      };
      noble.on('stateChange', onState);
    });

  if (await waitOnce()) return;

  // Adapter not poweredOn — attempt btmgmt kernel-level reset
  bleLog.debug(`Adapter state '${getState()}', attempting btmgmt reset...`);
  if (await resetAdapterBtmgmt()) {
    if (getState() === 'poweredOn') return;
    if (await waitOnce()) return;
  }

  throw new Error(`Bluetooth adapter state: '${getState()}' (expected 'poweredOn')`);
}
