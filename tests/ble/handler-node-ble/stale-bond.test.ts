import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  announceBondOnce,
  classifyAttempt,
  describeAttempt,
  isAuthClassConnectFailure,
  provesRefusedKey,
  shouldSettle,
  staleBondClearNotice,
  staleBondKeptNotice,
  staleBondLooksStaleNotice,
  staleBondMessage,
  staleBondPossibleMessage,
  StaleBondEvidence,
  STALE_BOND_EVIDENCE_ATTEMPTS,
  _resetStaleBondAnnouncementsForTests,
} from '../../../src/ble/handler-node-ble/stale-bond.js';
import { bleLog } from '../../../src/ble/types.js';

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
  reasonSignal: reason === undefined ? ('absent' as const) : ('declared' as const),
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
      { linkUp: false, reasonSignal: 'declared' as const, reason: AUTH },
      'refused',
    ],
    ['Timeout with a 95 ms gap', ABORT, up(95, 'org.bluez.Reason.Timeout'), 'dropped'],
    ['Remote with a 95 ms gap', ABORT, up(95, 'org.bluez.Reason.Remote'), 'dropped'],
    ['Local with a 95 ms gap', ABORT, up(95, 'org.bluez.Reason.Local'), 'outlived'],
    ['no connection', ABORT, { linkUp: false, reasonSignal: 'absent' as const }, 'never-up'],
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
    expect(shouldSettle(ABORT, { linkUp: false, reasonSignal: 'absent' })).toBe(false);
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
    expect(line('never-up', { linkUp: false, reasonSignal: 'absent' })).toBe(
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

  it('does not say the connection never came up when BlueZ gave a reason for ending it', () => {
    const l = line('never-up', {
      linkUp: false,
      reasonSignal: 'declared',
      reason: 'org.bluez.Reason.Timeout',
    });
    expect(l).toContain(
      'BlueZ never reported the connection as up; BlueZ: org.bluez.Reason.Timeout',
    );
    expect(l).not.toContain('the connection never came up');
  });

  it('says nothing for an error that is not auth-class and had no connection', () => {
    expect(line('other', { linkUp: false, reasonSignal: 'absent' })).toBeUndefined();
  });
});

describe('StaleBondEvidence (#471, D066)', () => {
  const MAC = '5C:CA:D3:88:D0:EC';
  const refusedLink = up(95, AUTH);

  it('reports a refused key on three refusals in any order, timeouts in between included', () => {
    const e = new StaleBondEvidence();
    e.record(ABORT, refusedLink, 95);
    e.record(TIMEOUT, undefined);
    e.record(ABORT, up(3));
    e.record(ABORT, refusedLink, 95);
    expect(e.verdict().kind).not.toBe('reported');
    e.record(ABORT, refusedLink);
    expect(e.verdict()).toEqual({ kind: 'reported', refused: 3 });
  });

  it('counts connections that outlived the error, confirmed only when the retry Disconnect waited too', () => {
    const e = new StaleBondEvidence();
    e.record(ABORT, up(95), 39);
    e.record(ABORT, up(90), 40);
    e.record(ABORT, up(94));
    expect(e.verdict()).toEqual({
      kind: 'outlived',
      count: 3,
      confirmed: 1,
      typicalMs: 94,
      reasonSignal: 'absent',
    });
  });

  it('learns whether BlueZ gives reasons from any attempt whose probe got an answer', () => {
    const signalAfter = (signals: readonly ('declared' | 'absent' | 'unknown')[]): unknown => {
      const e = new StaleBondEvidence();
      for (const reasonSignal of signals) e.record(ABORT, { ...up(95), reasonSignal }, 95);
      return e.verdict();
    };
    expect(signalAfter(['unknown', 'unknown', 'unknown'])).toMatchObject({
      reasonSignal: 'unknown',
    });
    expect(signalAfter(['unknown', 'absent', 'unknown'])).toMatchObject({
      reasonSignal: 'absent',
    });
    expect(signalAfter(['absent', 'declared', 'absent'])).toMatchObject({
      reasonSignal: 'declared',
    });
  });

  it('calls three link-up failures without a verdict possible', () => {
    const e = new StaleBondEvidence();
    for (let i = 0; i < 3; i++) e.record(ABORT, up(5));
    expect(e.verdict()).toEqual({ kind: 'possible', linkUps: 3 });
  });

  it('does not count a connection BlueZ says the radio link or the scale ended as possible', () => {
    const e = new StaleBondEvidence();
    for (let i = 0; i < 6; i++) e.record(ABORT, up(3, 'org.bluez.Reason.Timeout'));
    expect(e.verdict()).toEqual({ kind: 'none' });
    expect(e.keptWhy()).toEqual({ why: 'link-reason', reason: 'org.bluez.Reason.Timeout' });
  });

  it.each([
    ['never-up', [[ABORT, { linkUp: false, reasonSignal: 'absent' }]]],
    ['at-once', [[ABORT, up(5)]]],
    ['lingered', [[ABORT, up(2000)]]],
    [
      'few',
      [
        [ABORT, up(95)],
        [ABORT, up(5)],
      ],
    ],
  ] as const)('says why the bond is kept: %s', (why, attempts) => {
    const e = new StaleBondEvidence();
    for (const [err, link] of attempts) e.record(err, link);
    expect(e.keptWhy().why).toBe(why);
  });

  it('keeps the bond for the reason BlueZ gave, not "never asked", when the up was merged away', () => {
    const e = new StaleBondEvidence();
    for (let i = 0; i < 3; i++) {
      e.record(ABORT, {
        linkUp: false,
        reasonSignal: 'declared',
        reason: 'org.bluez.Reason.Timeout',
      });
    }
    expect(e.keptWhy()).toEqual({ why: 'link-reason', reason: 'org.bluez.Reason.Timeout' });
  });

  it('counts only auth-class failures as aborts', () => {
    const e = new StaleBondEvidence();
    e.record(TIMEOUT, undefined);
    e.record(ABORT, undefined);
    expect(e.abortCount).toBe(1);
  });

  it.each([
    ['reported', { kind: 'reported', refused: 3 }, true],
    [
      '3 confirmed, no reasons',
      { kind: 'outlived', count: 3, confirmed: 3, typicalMs: 90, reasonSignal: 'absent' },
      true,
    ],
    [
      '2 confirmed of 3, no reasons',
      { kind: 'outlived', count: 3, confirmed: 2, typicalMs: 90, reasonSignal: 'absent' },
      false,
    ],
    [
      '3 confirmed, BlueZ gives reasons',
      { kind: 'outlived', count: 3, confirmed: 3, typicalMs: 90, reasonSignal: 'declared' },
      false,
    ],
    [
      '3 confirmed, the reason probe never answered',
      { kind: 'outlived', count: 3, confirmed: 3, typicalMs: 90, reasonSignal: 'unknown' },
      false,
    ],
    ['possible', { kind: 'possible', linkUps: 6 }, false],
    ['none', { kind: 'none' }, false],
  ] as const)('proves a refused key: %s', (_name, verdict, expected) => {
    expect(provesRefusedKey(verdict)).toBe(expected);
  });

  describe('messages', () => {
    it('without a verdict, keeps the wording from before D066', () => {
      expect(staleBondMessage(MAC, 6, 'x')).toContain(
        'rejected the stored pairing key on every attempt',
      );
    });

    it('a reported refusal names the count, the cause and the remedy', () => {
      const m = staleBondMessage(MAC, 6, 'le-connection-abort-by-local', {
        kind: 'reported',
        refused: 5,
      });
      expect(m).toContain(
        'rejected the stored pairing key on 5 attempts (BlueZ reported an authentication failure)',
      );
      expect(m).toContain(`remove ${MAC}`);
      expect(m).toContain(`pair ${MAC}`);
      expect(m).toContain('#335');
      expect(m).toContain('Last error: le-connection-abort-by-local');
    });

    it('an outlived verdict says what was seen, not that BlueZ said so', () => {
      const v = {
        kind: 'outlived',
        count: 4,
        confirmed: 4,
        typicalMs: 92,
        reasonSignal: 'absent',
      } as const;
      const m = staleBondMessage(MAC, 6, 'x', v);
      expect(m).toContain('on 4 attempts the connection came up and stayed up after');
      expect(m).not.toContain('BlueZ reported');
      expect(m).toContain(`remove ${MAC}`);
      const w = staleBondLooksStaleNotice(MAC, { ...v, confirmed: 2 });
      expect(w).toContain('on 4 connect attempts');
      expect(w).toContain('stayed up about 92 ms');
      expect(w).toContain(
        'ble.auto_clear_stale_bond needs 3 such attempts before the last one, timed reliably by ' +
          'this host, and had 2, so it left the bond alone. Clear it by hand:',
      );
      expect(w).toContain(`remove ${MAC}`);
      expect(w).toContain('ble.adapter_privacy (#417)');
      expect(staleBondLooksStaleNotice(MAC, { ...v, reasonSignal: 'declared' })).toContain(
        'BlueZ did not report an authentication failure on enough of them',
      );
      expect(staleBondLooksStaleNotice(MAC, { ...v, reasonSignal: 'unknown' })).toContain(
        'This host could not learn whether BlueZ says why a connection ended, so ' +
          'ble.auto_clear_stale_bond leaves the bond alone. Clear it by hand:',
      );
    });

    it('the clear warning names its proof, and the kept notice says what it takes', () => {
      expect(staleBondClearNotice(MAC, { kind: 'reported', refused: 3 })).toBe(
        `${MAC} rejected the stored pairing key on 3 attempts (BlueZ reported an authentication ` +
          'failure), so the bond is being cleared and re-established (ble.auto_clear_stale_bond). ' +
          'Put the scale into pairing mode if it asks. If a Beurer scale needs this after every ' +
          'session, turn on ble.adapter_privacy (#417).',
      );
      const outlived = {
        kind: 'outlived',
        count: 3,
        confirmed: 3,
        typicalMs: 92,
        reasonSignal: 'absent',
      } as const;
      expect(staleBondClearNotice(MAC, outlived)).toContain(
        `${MAC} most likely rejected the stored pairing key on 3 attempts (each time the ` +
          'connection stayed up about 92 ms after le-connection-abort-by-local',
      );
      const kept = staleBondKeptNotice(MAC, 4, { why: 'at-once' });
      expect(kept).toContain(
        `${MAC} failed 4 connect attempts with le-connection-abort-by-local, but its bond is kept: ` +
          'the connection went down at once with the error',
      );
      expect(kept).toContain('with older BlueZ, a connection that stays up 40 ms to 1.5 s');
    });

    it('a possible verdict hedges and gives the remedy', () => {
      const m = staleBondPossibleMessage(MAC, 6, 4, 'le-connection-abort-by-local');
      expect(m).toContain(`on 4 of them after the connection to ${MAC} came up`);
      expect(m).toContain('A weak radio link does that');
      expect(m).toContain(`remove ${MAC}`);
      expect(m).not.toContain('rejected the stored pairing key');
    });
  });
});

describe('announceBondOnce', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _resetStaleBondAnnouncementsForTests();
  });

  it('logs at its level once per process, scale and kind, at debug after', () => {
    const info = vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    announceBondOnce('kept', 'AA:BB:CC:DD:EE:FF', 'info', 'a');
    announceBondOnce('kept', 'aa-bb-cc-dd-ee-ff', 'info', 'b');
    announceBondOnce('kept', '11:22:33:44:55:66', 'info', 'c');
    announceBondOnce('looks-stale', 'AA:BB:CC:DD:EE:FF', 'info', 'd');
    expect(info.mock.calls.map((c) => c[0])).toEqual(['a', 'c', 'd']);
    expect(debug.mock.calls.map((c) => c[0])).toEqual(['b']);
  });
});
