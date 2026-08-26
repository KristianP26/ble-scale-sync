import { describe, it, expect, vi } from 'vitest';
import { removeDevice } from '../../src/ble/handler-node-ble/discovery.js';
import type { Adapter } from '../../src/ble/handler-node-ble/dbus.js';

const MAC = 'aa:bb:cc:dd:ee:ff';
const EXPECTED_PATH = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF';

/**
 * Build a mock node-ble Adapter exposing the surface removeDevice() touches:
 * `helper.object` + `helper.callMethod` (via helperOf) and `getDevice()`.
 */
function makeAdapter(opts: {
  paired?: boolean;
  deviceInCache?: boolean; // default true
  isPairedThrows?: boolean;
  removeThrows?: boolean;
}) {
  const callMethod = vi.fn(async (method: string) => {
    if (method === 'RemoveDevice' && opts.removeThrows) {
      throw new Error('org.bluez.Error.DoesNotExist');
    }
    return undefined;
  });
  const isPaired = vi.fn(async () => {
    if (opts.isPairedThrows) throw new Error('org.freedesktop.DBus.Error.NoReply');
    return opts.paired ?? false;
  });
  const getDevice = vi.fn(async () => {
    if (opts.deviceInCache === false) throw new Error('Device not found');
    return { isPaired };
  });
  const adapter = {
    helper: { object: '/org/bluez/hci0', callMethod },
    getDevice,
  } as unknown as Adapter;
  return { adapter, callMethod, isPaired, getDevice };
}

describe('removeDevice() bond guard (#168)', () => {
  it('does NOT call RemoveDevice when the device is bonded (preserves LTK)', async () => {
    const { adapter, callMethod, getDevice } = makeAdapter({ paired: true });
    await removeDevice(adapter, MAC);
    expect(callMethod).not.toHaveBeenCalled();
    // Paired state is queried with the colon-form MAC, distinct from the
    // underscore path passed to RemoveDevice; guards against swapping the two.
    expect(getDevice).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF');
  });

  it('calls RemoveDevice with the correct path when the device is unpaired', async () => {
    const { adapter, callMethod } = makeAdapter({ paired: false });
    await removeDevice(adapter, MAC);
    expect(callMethod).toHaveBeenCalledWith('RemoveDevice', EXPECTED_PATH);
  });

  it('removes when the device is not in the BlueZ cache (getDevice throws)', async () => {
    const { adapter, callMethod } = makeAdapter({ deviceInCache: false });
    await removeDevice(adapter, MAC);
    expect(callMethod).toHaveBeenCalledWith('RemoveDevice', EXPECTED_PATH);
  });

  it('does NOT remove on a transient paired-state query error (fail safe, #168)', async () => {
    // getDevice succeeds (device IS cached) but isPaired throws transiently.
    // Removing here could wipe a real bond, so the guard must skip removal.
    const { adapter, callMethod } = makeAdapter({ isPairedThrows: true });
    await removeDevice(adapter, MAC);
    expect(callMethod).not.toHaveBeenCalled();
  });

  // #335: a peripheral that has forgotten its half of the pairing leaves BlueZ
  // replaying a dead key forever, and this guard is what keeps it alive. The
  // opt-in recovery has to be able to get past it.
  it('removes a bonded device when includeBonded is set', async () => {
    const { adapter, callMethod } = makeAdapter({ paired: true });
    await removeDevice(adapter, MAC, { includeBonded: true });
    expect(callMethod).toHaveBeenCalledWith('RemoveDevice', EXPECTED_PATH);
  });

  it('still fails safe on a transient paired-state query error with includeBonded', async () => {
    const { adapter, callMethod } = makeAdapter({ isPairedThrows: true });
    await removeDevice(adapter, MAC, { includeBonded: true });
    expect(callMethod).not.toHaveBeenCalled();
  });

  it('does not reject when RemoveDevice itself fails', async () => {
    const { adapter } = makeAdapter({ paired: false, removeThrows: true });
    await expect(removeDevice(adapter, MAC)).resolves.toBeUndefined();
  });
});
