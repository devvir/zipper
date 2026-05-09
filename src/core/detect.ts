/**
 * Backend detection. `pigz --version` is run once and the result cached for
 * the process lifetime — pigz won't appear or disappear during a process.
 */

import { spawnSync } from 'node:child_process';
import type { Backend, BackendChoice } from './types';

let cached: boolean | undefined;

/** Returns true if `pigz` is on PATH. Result is cached after the first call. */
export function isPigzAvailable(): boolean {
  if (cached !== undefined) return cached;

  try {
    const result = spawnSync('pigz', ['--version'], { stdio: 'ignore' });

    cached = result.status === 0;
  } catch {
    cached = false;
  }

  return cached;
}

/**
 * Resolves a backend choice to a concrete backend. Throws if the caller
 * forced `'pigz'` but it isn't installed — silent fallback would defeat the
 * purpose of forcing it.
 */
export function getActiveBackend(choice: BackendChoice = 'auto'): Backend {
  if (choice === 'pigz') {
    if (! isPigzAvailable()) {
      throw new Error('pigz backend was forced but `pigz` is not installed (or not on PATH)');
    }

    return 'pigz';
  }

  if (choice === 'zlib') return 'zlib';

  return isPigzAvailable() ? 'pigz' : 'zlib';
}

// ── Test exports ─────────────────────────────────────────────────────────────

export const _test_resetCache = (): void => { cached = undefined; };
