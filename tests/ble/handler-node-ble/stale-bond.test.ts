import { describe, it, expect } from 'vitest';
import {
  classifyAttempt,
  describeAttempt,
  isAuthClassConnectFailure,
  shouldSettle,
  staleBondMessage,
  STALE_BOND_EVIDENCE_ATTEMPTS,
} from '../../../src/ble/handler-node-ble/stale-bond.js';

describe('isAuthClassConnectFailure (#290)', () => {
  it.each([
    'le-connection-abort-by-local',
    'Connect error: le-connection-abort-by-local',
    'Authentication Failed',
    'org.bluez.Error.AuthenticationFailed',
  ])('recognises %s', (msg) => {
    expect(isAuthClassConnectFailure(new Error(msg))).toBe(true);
  });

  it.each([
    'Connection timed out',
    'Device not found',
    'GATT server acquisition timed out',
    'interface not found in proxy object',
    'br-connection-page-timeout',
  ])('does not recognise %s', (msg) => {
    expect(isAuthClassConnectFailure(new Error(msg))).toBe(false);
  });
});

describe('staleBondMessage', () => {
  const msg = staleBondMessage('5C:CA:D3:88:D0:EC', 6, 'le-connection-abort-by-local');

  it('names the peer, the cause and the remedy', () => {
    expect(msg).toContain('5C:CA:D3:88:D0:EC');
    expect(msg).toContain('rejected the stored pairing key');
    expect(msg).toContain('bluetoothctl');
    expect(msg).toContain('remove 5C:CA:D3:88:D0:EC');
    expect(msg).toContain('pair 5C:CA:D3:88:D0:EC');
  });

  it('keeps the underlying BlueZ error for anyone diffing older logs', () => {
    expect(msg).toContain('le-connection-abort-by-local');
  });
});

describe('evidence threshold', () => {
  it('requires a run of failures, not a single one', () => {
    // A single abort has documented benign producers (a connect issued while
    // discovery is still active, or a second D-Bus client holding a session),
    // so one occurrence must never be treated as a stale bond.
    expect(STALE_BOND_EVIDENCE_ATTEMPTS).toBeGreaterThan(1);
  });
});

const ABORT = new Error('le-connection-abort-by-local');
const TIMEOUT = new Error('Connection timed out');
const AUTH = 'org.bluez.Reason.Authentication';

const up = (downAfterErrorMs?: number, reason?: string) => ({
  linkUp: true,
  linkUpAfterMs: 400,
  downAfterErrorMs,
  reasonSupported: reason !== undefined,
  reason,
});

describe('classifyAttempt (#471, D066)', () => {
  it.each([
    ['a lost link, 39 ms', ABORT, up(39), 'dropped'],
    ['a refused key on older BlueZ, 40 ms', ABORT, up(40), 'outlived'],
    ['#290 timings, 95 ms', ABORT, up(95), 'outlived'],
    ['1500 ms', ABORT, up(1500), 'outlived'],
    ['1501 ms', ABORT, up(1501), 'lingered'],
    ['not seen going down', ABORT, up(undefined), 'lingered'],
    ['down before the error', ABORT, up(-3), 'dropped'],
    ['Authentication, whatever the gap', ABORT, up(2, AUTH), 'refused'],
    ['Authentication with a timeout error', TIMEOUT, up(undefined, AUTH), 'refused'],
    [
      'Authentication without Connected=true',
      ABORT,
      { linkUp: false, reasonSupported: true, reason: AUTH },
      'refused',
    ],
    ['Timeout with a 95 ms gap', ABORT, up(95, 'org.bluez.Reason.Timeout'), 'dropped'],
    ['Remote with a 95 ms gap', ABORT, up(95, 'org.bluez.Reason.Remote'), 'dropped'],
    ['Local with a 95 ms gap', ABORT, up(95, 'org.bluez.Reason.Local'), 'outlived'],
    ['no connection', ABORT, { linkUp: false, reasonSupported: false }, 'never-up'],
    ['no observer', ABORT, undefined, 'never-up'],
    ['AuthenticationFailed', new Error('org.bluez.Error.AuthenticationFailed'), up(95), 'outlived'],
    ['a timeout', TIMEOUT, up(95), 'other'],
  ])('%s', (_name, err, link, expected) => {
    expect(classifyAttempt(err, link)).toBe(expected);
  });
});

describe('shouldSettle', () => {
  it('waits only for an auth-class failure whose connection is still up', () => {
    expect(shouldSettle(ABORT, up(undefined))).toBe(true);
    expect(shouldSettle(ABORT, up(95))).toBe(false);
    expect(shouldSettle(ABORT, { linkUp: false, reasonSupported: false })).toBe(false);
    expect(shouldSettle(TIMEOUT, up(undefined))).toBe(false);
    expect(shouldSettle(ABORT, undefined)).toBe(false);
  });
});

describe('describeAttempt', () => {
  const line = (outcome: Parameters<typeof describeAttempt>[0]['outcome'], link?: object) =>
    describeAttempt({
      attempt: 3,
      total: 6,
      ms: 1234,
      error: 'le-connection-abort-by-local',
      outcome,
      link: link as Parameters<typeof describeAttempt>[0]['link'],
    });

  it('names the attempt, the time and the error', () => {
    expect(line('never-up', { linkUp: false, reasonSupported: false })).toBe(
      'Connect attempt 3/6 failed after 1234 ms (le-connection-abort-by-local): ' +
        'the connection never came up',
    );
  });

  it('says how long the connection outlived the error', () => {
    expect(line('outlived', up(95))).toContain(
      'the connection came up after 400 ms and stayed up 95 ms after the error',
    );
  });

  it('gives BlueZ its word on a refused key', () => {
    expect(line('refused', up(90, AUTH))).toContain(
      'BlueZ: org.bluez.Reason.Authentication, the scale refused the stored pairing key',
    );
  });

  it('says what another reason means', () => {
    expect(line('dropped', up(3, 'org.bluez.Reason.Timeout'))).toContain(
      'went down 3 ms after the error; BlueZ: org.bluez.Reason.Timeout (the radio link timed out)',
    );
  });

  it('says when the connection was not seen going down', () => {
    expect(line('lingered', up(undefined))).toContain('was not seen going down after the error');
  });

  it('says nothing for an error that is not auth-class and had no connection', () => {
    expect(line('other', { linkUp: false, reasonSupported: false })).toBeUndefined();
  });
});
