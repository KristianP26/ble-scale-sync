import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, setLogLevel, LogLevel } from '../src/logger.js';

describe('createLogger()', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setLogLevel(LogLevel.DEBUG);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setLogLevel(LogLevel.INFO);
  });

  it('includes scope prefix in info messages', () => {
    const log = createLogger('Test');
    log.info('hello');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[Test] hello'));
  });

  it('includes scope:debug prefix in debug messages', () => {
    const log = createLogger('BLE');
    log.debug('scanning');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[BLE:debug] scanning'));
  });

  it('uses console.warn for warn level', () => {
    const log = createLogger('Sync');
    log.warn('low battery');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[Sync] low battery'));
  });

  it('uses console.error for error level', () => {
    const log = createLogger('Sync');
    log.error('failed');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[Sync] failed'));
  });

  it('prepends timestamp in ISO-like format', () => {
    const log = createLogger('X');
    log.info('msg');
    const output = logSpy.mock.calls[0][0] as string;
    // Timestamp format: "2026-02-13 12:34:56.789 [X] msg"
    expect(output).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[X\] msg$/);
  });

  it('handles messages starting with newlines', () => {
    const log = createLogger('S');
    log.info('\nstarting');
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/^\n\d{4}-\d{2}-\d{2} .+ \[S\] starting$/);
  });

  // The last net under every caller that logs err.message or a stack itself
  // rather than going through errMsg().
  it('hides URL credentials at every level', () => {
    const log = createLogger('Sync');
    log.debug('probe https://u:pw1@h/x');
    log.info('probe https://u:pw2@h/x');
    log.warn('probe https://u:pw3@h/x');
    log.error('probe https://u:pw4@h/x');
    const lines = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].map(
      (c) => c[0] as string,
    );
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line).not.toMatch(/pw\d/);
      expect(line).toMatch(/\[Sync(:debug)?\] probe https:\/\/\*\*\*@h\/x$/);
    }
  });

  describe('terminal control characters', () => {
    const out = (): string => logSpy.mock.calls[0][0] as string;

    it('escapes ESC and OSC sequences so they cannot reach the terminal', () => {
      createLogger('X').info('x\x1b[2J\x1b]0;title\x07y');
      expect(out()).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
      expect(out()).toContain('x\\x1b[2J\\x1b]0;title\\x07y');
    });

    it('escapes a lone CR and folds CRLF to LF', () => {
      const log = createLogger('X');
      log.info('a\rb');
      log.info('a\r\nb');
      expect(logSpy.mock.calls[0][0]).toMatch(/\[X\] a\\x0db$/);
      expect(logSpy.mock.calls[1][0]).toMatch(/\[X\] a\nb$/);
    });

    it('keeps LF and TAB, so stack traces and multi-line messages stay intact', () => {
      createLogger('X').info('x\n    at f (file:1:1)\n\tz');
      expect(out().endsWith('x\n    at f (file:1:1)\n\tz')).toBe(true);
    });

    it('escapes C1 controls and Unicode line separators', () => {
      createLogger('X').info('a\u009bb\u2028c\u2029d');
      expect(out().endsWith('a\\x9bb\\u2028c\\u2029d')).toBe(true);
    });

    it('does not double backslashes in paths', () => {
      createLogger('X').info('C:\\Users\\x\\y');
      expect(out().endsWith('C:\\Users\\x\\y')).toBe(true);
    });

    it('turns a leading CRLF into the leading-newline layout', () => {
      createLogger('X').info('\r\nfoo');
      expect(out()).toMatch(/^\n\d{4}-\d{2}-\d{2} .+ \[X\] foo$/);
    });

    it('escapes after redaction, so a secret is still hidden', () => {
      createLogger('X').info('probe https://u:pw@h/x\x1b[2J');
      expect(out()).not.toContain('pw');
      expect(out()).toContain('\\x1b[2J');
    });

    it.each(['debug', 'info', 'warn', 'error'] as const)('applies at the %s level', (level) => {
      createLogger('X')[level]('a\x1bb');
      const spy = level === 'warn' ? warnSpy : level === 'error' ? errorSpy : logSpy;
      expect(spy.mock.calls[0][0]).toContain('a\\x1bb');
    });
  });

  it('hides a header value echoed into a stack that spans lines', () => {
    const log = createLogger('Run');
    log.error(
      'Unhandled promise rejection: TypeError: Headers.append: "Bearer drv_SECRET\nX" is an invalid header value.\n    at fetch',
    );
    const output = errorSpy.mock.calls[0][0] as string;
    expect(output).not.toContain('drv_SECRET');
    expect(output).toContain('"***" is an invalid header value.\n    at fetch');
  });
});

describe('setLogLevel()', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setLogLevel(LogLevel.INFO);
  });

  it('suppresses debug when level is INFO', () => {
    setLogLevel(LogLevel.INFO);
    const log = createLogger('T');
    log.debug('hidden');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('suppresses info and debug when level is WARN', () => {
    setLogLevel(LogLevel.WARN);
    const log = createLogger('T');
    log.debug('hidden');
    log.info('hidden');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('allows warn when level is WARN', () => {
    setLogLevel(LogLevel.WARN);
    const log = createLogger('T');
    log.warn('visible');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('suppresses everything except error when level is ERROR', () => {
    setLogLevel(LogLevel.ERROR);
    const log = createLogger('T');
    log.debug('hidden');
    log.info('hidden');
    log.warn('hidden');
    log.error('visible');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('suppresses everything when level is SILENT', () => {
    setLogLevel(LogLevel.SILENT);
    const log = createLogger('T');
    log.debug('hidden');
    log.info('hidden');
    log.warn('hidden');
    log.error('hidden');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// The starting level is read from DEBUG when the module loads. Any non-empty
// value used to switch debug ON, so DEBUG=false and DEBUG=0 did the opposite
// of what they say; the words now match the DEBUG override in env-overrides.
describe('initial level from DEBUG', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const debugOnLoad = async (value: string): Promise<boolean> => {
    vi.stubEnv('DEBUG', value);
    vi.resetModules();
    const fresh = await import('../src/logger.js');
    return fresh.isDebugEnabled();
  };

  it.each(['false', '0', 'no', 'off', ''])('DEBUG=%j starts at INFO', async (value) => {
    expect(await debugOnLoad(value)).toBe(false);
  });

  it.each(['true', '1', 'yes', 'on', 'TRUE'])('DEBUG=%j starts at DEBUG', async (value) => {
    expect(await debugOnLoad(value)).toBe(true);
  });
});
