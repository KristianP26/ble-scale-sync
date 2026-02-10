export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

let currentLevel = process.env.DEBUG ? LogLevel.DEBUG : LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`;
  const fmt = (msg: string): string => {
    const nl = msg.match(/^(\n+)/);
    return nl ? `${nl[1]}${prefix} ${msg.slice(nl[1].length)}` : `${prefix} ${msg}`;
  };
  return {
    debug: (msg) => {
      if (currentLevel <= LogLevel.DEBUG) console.log(fmt(msg));
    },
    info: (msg) => {
      if (currentLevel <= LogLevel.INFO) console.log(fmt(msg));
    },
    warn: (msg) => {
      if (currentLevel <= LogLevel.WARN) console.warn(fmt(msg));
    },
    error: (msg) => {
      if (currentLevel <= LogLevel.ERROR) console.error(fmt(msg));
    },
  };
}
