import type { SessionFixture } from '../../helpers/replay/session.js';
import { FAKE_ADDRESS } from '../../helpers/replay/session.js';

/**
 * Medisana BS44x / BS440 / BS430 time sync. Characterization: no frame comes,
 * the link drops after 2 s, and what the traces pin is the subscriptions and
 * the time sync written on connect, whose epoch follows the advertised name.
 * The frames of a real BS444 session are in bs444-511.ts.
 */

const SYNTH = 'characterization: the time sync per advertised name, no frames';
const CHARS = ['8a82', '8a21', '8a22', '8a20', '8a81'];

export const session: SessionFixture = {
  adapter: 'Medisana BS44x',
  chars: CHARS,
  traces: {
    // BS444/BS440 name: seconds since 2010-01-01.
    'bs444-time-sync': {
      provenance: 'characterization',
      source: SYNTH,
      advert: { localName: '013197', address: FAKE_ADDRESS, serviceUuids: ['78b2'] },
      steps: [],
      disconnectAtMs: 2000,
    },
    // BS430 name: Unix seconds.
    'bs430-time-sync': {
      provenance: 'characterization',
      source: SYNTH,
      advert: { localName: '0203B0001', address: FAKE_ADDRESS, serviceUuids: ['78b2'] },
      steps: [],
      disconnectAtMs: 2000,
    },
    // No name (a transport that saw none): Unix seconds.
    'nameless-time-sync': {
      provenance: 'characterization',
      source: SYNTH,
      steps: [],
      disconnectAtMs: 2000,
    },
  },
};
