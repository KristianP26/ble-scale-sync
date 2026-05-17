import { describe, it, expect } from 'vitest';
import { adapters } from '../../src/scales/index.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';

// Regression for #177: a Eufy/1byone T9146 advertises name "eufy T9146" and the
// generic 0xFFF0 vendor service. Before the fix, Inlife (earlier in the adapter
// array) shadowed the 1byone adapter via its bare 0xFFF0 fallback. Once
// characteristics are known post-discovery, Inlife must yield so the device
// resolves to "1byone (Eufy)".
describe('adapter resolution (#177 0xFFF0 collision)', () => {
  it('resolves a T9146 (name + 0xFFF1/0xFFF4 chars) to "1byone (Eufy)"', () => {
    const info: BleDeviceInfo = {
      localName: 'eufy T9146',
      serviceUuids: [uuid16(0xfff0)],
      characteristicUuids: [uuid16(0xfff1), uuid16(0xfff4)],
    };
    const matched = adapters.find((a) => a.matches(info));
    expect(matched?.name).toBe('1byone (Eufy)');
  });

  it('does not regress a real Inlife device (known name) -> "Inlife"', () => {
    const info: BleDeviceInfo = {
      localName: '000fatscale01',
      serviceUuids: [uuid16(0xfff0)],
      characteristicUuids: [uuid16(0xfff1), uuid16(0xfff2)],
    };
    const matched = adapters.find((a) => a.matches(info));
    expect(matched?.name).toBe('Inlife');
  });

  // #168: BF720 exposes Body Composition 0x181B post-connect (shared with Mi
  // Scale 2) and advertises Beurer company id 0x0611. It must resolve to the
  // Beurer adapter, not "Xiaomi Mi Scale 2".
  it('resolves a BF720 (Beurer cid 0x0611 + 0x181B) to the Beurer adapter', () => {
    const info: BleDeviceInfo = {
      localName: 'BF720',
      serviceUuids: [uuid16(0x181d), uuid16(0x181b)],
      manufacturerData: { id: 0x0611, data: Buffer.alloc(0) },
    };
    const matched = adapters.find((a) => a.matches(info));
    expect(matched?.name).toBe('Beurer BF720/BF105');
  });
});
