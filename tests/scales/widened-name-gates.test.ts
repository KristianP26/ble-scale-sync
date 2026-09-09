import { describe, it, expect } from 'vitest';
import { mockPeripheral } from '../helpers/scale-test-utils.js';
import { HoffenAdapter } from '../../src/scales/hoffen.js';
import { StandardGattScaleAdapter } from '../../src/scales/standard-gatt.js';
import { MedisanaBs44xAdapter } from '../../src/scales/medisana-bs44x.js';
import { QnScaleAdapter } from '../../src/scales/qn-scale/index.js';
import { XiaomiS400Adapter } from '../../src/scales/xiaomi-s400.js';
import { XiaomiMiScaleLegacyAdapter } from '../../src/scales/xiaomi-mi-scale-legacy.js';

/**
 * #409: six name gates were narrower than openScale's for scales whose
 * protocol this project already implements. Widening a gate can hijack a
 * sibling, so each case asserts both what is now claimed and what is still
 * refused.
 */
describe('widened name gates', () => {
  it('Hoffen claims the rebadged ProfiCare', () => {
    const adapter = new HoffenAdapter();
    expect(adapter.matches(mockPeripheral('PC-PW 3008 BT'))).toBe(true);
    expect(adapter.matches(mockPeripheral('hoffen bs-8107'))).toBe(true);
    // Exact, so a longer name is not swallowed.
    expect(adapter.matches(mockPeripheral('PC-PW 3008 BT Pro'))).toBe(false);
  });

  it('standard GATT claims BF1000, SBF76 and SBF77', () => {
    const adapter = new StandardGattScaleAdapter();
    for (const name of ['BF1000', 'Sanitas SBF76', 'SBF77']) {
      expect(adapter.matches(mockPeripheral(name))).toBe(true);
    }
    // The FFE1-protocol Sanitas models are NOT claimed by name here: they
    // belong to beurer-sanitas.ts.
    expect(adapter.matches(mockPeripheral('SBF70'))).toBe(false);
    expect(adapter.matches(mockPeripheral('sanitas sbf75'))).toBe(false);
  });

  it('Medisana matches its numeric names by prefix', () => {
    const adapter = new MedisanaBs44xAdapter();
    for (const name of ['013197', '0131970', '013198_A', '0202b6', '0203b1']) {
      expect(adapter.matches(mockPeripheral(name))).toBe(true);
    }
    expect(adapter.matches(mockPeripheral('013196'))).toBe(false);
  });

  it('QN claims seb-scale and the exact GE "Fit Plus"', () => {
    const adapter = new QnScaleAdapter();
    expect(adapter.matches(mockPeripheral('SEB-Scale'))).toBe(true);
    expect(adapter.matches(mockPeripheral('Fit Plus'))).toBe(true);
    // Exact for that one: as a substring it would claim anything fitness
    // branded that happens to contain the words.
    expect(adapter.matches(mockPeripheral('MyFit Plus Tracker'))).toBe(false);
  });

  it('Xiaomi S400 claims its raw model name without hijacking the Mi Scale 2', () => {
    const s400 = new XiaomiS400Adapter();
    expect(s400.matches(mockPeripheral('XMTZC14HM'))).toBe(true);
    // XMTZC04HM is the Mi Scale 2 legacy variant, which has its own adapter.
    // openScale matches the bare XMTZC prefix; that would take this one too.
    expect(s400.matches(mockPeripheral('XMTZC04HM'))).toBe(false);
    expect(new XiaomiMiScaleLegacyAdapter().matches(mockPeripheral('MI SCALE2'))).toBe(true);
  });
});
