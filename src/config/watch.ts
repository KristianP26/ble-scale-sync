import { watch, readFileSync, type FSWatcher } from 'node:fs';
import { dirname, basename } from 'node:path';
import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';
import { isSelfWrite } from './write.js';

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
 * within ~50 ms. The file itself is watched too, for edits that reach it
 * through another directory entry (a Docker single-file mount).
 *
 * Events that leave the file's content unchanged are ignored: FSEvents on macOS
 * replays directory history from just before the watch started, so the file's
 * own creation would otherwise arrive as an edit.
 *
 * Self-writes from updateLastKnownWeight() are recognised by their content
 * (`isSelfWrite` in write.ts), not by a time window, so this never re-fires
 * for our own bumps while an edit landing right after one still reloads. Errors from
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
    if (isSelfWrite(lastContent)) {
      // Only OUR OWN bytes are skipped. Dropping everything that arrived inside
      // the time window discarded real edits: `lastContent` had already been
      // advanced when the event came in, so no later event looked like a change
      // and an edit made in the same two seconds as a last_known_weight bump
      // never took effect until a restart or a SIGHUP.
      log.debug('Skipping reload trigger: this is our own last_known_weight write');
      return;
    }
    onChange();
  };

  const onEvent = () => {
    const content = readContent(configPath);
    if (content === lastContent) return;
    lastContent = content;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fire, DEBOUNCE_MS);
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(dir, { persistent: false }, (_eventType, filename) => {
      // filename can be null on some platforms / edge events. Without it we
      // cannot tell whether the change is for our config file, so ignore.
      if (!filename) return;
      if (filename !== base) return;
      onEvent();
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

  // The file itself is watched as well. With a Docker single-file mount
  // (`-v ./config.yaml:/app/config.yaml`) an edit on the host goes through the
  // host's directory entry, and the kernel reports it to watchers of the file
  // and of the HOST directory only, so the directory watch above never fires
  // (verified with inotify in a container). This watch follows the inode: it
  // goes quiet after an atomic replace on a normal filesystem, which the
  // directory watch covers. An editor that saves by rename on the host leaves
  // the mount on the old inode, so no watch in the container can see that; the
  // content compare in onEvent keeps the two watches from double-firing.
  let fileWatcher: FSWatcher | null = null;
  try {
    fileWatcher = watch(configPath, { persistent: false }, () => onEvent());
    fileWatcher.on('error', (err) => {
      log.debug(`Config file watcher stopped: ${errMsg(err)}`);
    });
  } catch {
    // File missing right now: the directory watch still sees it appear.
  }

  log.info(`Watching ${configPath} for changes (auto-reload enabled)`);

  return {
    close() {
      closed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      for (const w of [watcher, fileWatcher]) {
        try {
          w?.close();
        } catch {
          /* ignore: watcher may already be closed */
        }
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
