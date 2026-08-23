import { watch, readFileSync, type FSWatcher } from 'node:fs';
import { dirname, basename } from 'node:path';
import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';
import { isReloadSuppressed } from './write.js';

const log = createLogger('ConfigWatch');

const DEBOUNCE_MS = 500;

export interface ConfigWatcherHandle {
  close(): void;
}

/**
 * Watch the parent directory of `configPath` for changes to its basename and
 * invoke `onChange` after a 500 ms trailing-edge debounce. Watching the parent
 * (not the file itself) survives atomic writes (tmp+rename) which replace the
 * inode, plus editor save patterns (vim `:w`, VS Code) that trigger 2+ events
 * within ~50 ms.
 *
 * Events that leave the file's content unchanged are ignored: FSEvents on macOS
 * replays directory history from just before the watch started, so the file's
 * own creation would otherwise arrive as an edit.
 *
 * Self-writes from updateLastKnownWeight() are suppressed via the suppress
 * window in write.ts, so this never re-fires for our own bumps. Errors from
 * fs.watch (e.g. parent directory unmounted) are logged and the watcher
 * silently stops; the SIGHUP path remains a manual fallback.
 */
export function startConfigWatcher(configPath: string, onChange: () => void): ConfigWatcherHandle {
  const dir = dirname(configPath);
  const base = basename(configPath);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let lastContent = readContent(configPath);

  const fire = () => {
    debounceTimer = null;
    if (closed) return;
    if (isReloadSuppressed()) {
      log.debug('Skipping reload trigger: self-write suppress window active');
      return;
    }
    onChange();
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(dir, { persistent: false }, (_eventType, filename) => {
      // filename can be null on some platforms / edge events. Without it we
      // cannot tell whether the change is for our config file, so ignore.
      if (!filename) return;
      if (filename !== base) return;
      const content = readContent(configPath);
      if (content === lastContent) return;
      lastContent = content;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fire, DEBOUNCE_MS);
    });
  } catch (err) {
    log.warn(
      `Failed to start config watcher on ${dir}: ${errMsg(err)}. ` +
        'SIGHUP still works as a manual fallback.',
    );
    return { close: () => {} };
  }

  watcher.on('error', (err) => {
    log.warn(`Config watcher error: ${errMsg(err)}. Stopping watcher.`);
  });

  log.info(`Watching ${configPath} for changes (auto-reload enabled)`);

  return {
    close() {
      closed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      try {
        watcher.close();
      } catch {
        /* ignore: watcher may already be closed */
      }
    },
  };
}

/** Current file content, or null while it is absent (mid atomic rename, deleted). */
function readContent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
