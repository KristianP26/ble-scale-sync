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
