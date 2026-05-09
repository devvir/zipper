/**
 * pigz backend. Spawns the `pigz` CLI and exposes its stdio plus a clean
 * `exited` promise that callers await to know the process finished
 * successfully.
 *
 * The `-n` flag is passed for compression so the gzip header carries no
 * filename or mtime — matches Node's zlib default and gives reproducible
 * output. Caller never has to think about it.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { CompressionOptions } from '../types';

const DEFAULT_LEVEL = 6;

/** A spawned pigz process with typed stdio and a settle-on-exit promise. */
export interface PigzProcess {
  process: ChildProcess;
  stdin:   Writable;
  stdout:  Readable;
  /** Resolves on clean exit (code 0). Rejects with stderr-enriched Error otherwise. */
  exited:  Promise<void>;
}

const buildArgs = (opts: CompressionOptions, mode: 'compress' | 'decompress'): string[] => {
  if (mode === 'decompress') return ['-d'];

  const level   = opts.level   ?? DEFAULT_LEVEL;
  const threads = opts.threads ?? os.cpus().length;

  return [`-${level}`, '-n', '-p', String(threads)];
};

/**
 * Spawn pigz in the given mode. Throws synchronously if the process can't be
 * launched (e.g. binary missing). Async failures (non-zero exit, killed by
 * signal) surface through the `exited` promise.
 */
export const spawnPigz = (opts: CompressionOptions, mode: 'compress' | 'decompress'): PigzProcess => {
  const proc = spawn('pigz', buildArgs(opts, mode), { stdio: ['pipe', 'pipe', 'pipe'] });

  if (! proc.stdin || ! proc.stdout || ! proc.stderr) {
    throw new Error('pigz: failed to open stdio pipes');
  }

  let stderrBuf = '';

  proc.stderr.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });

  const exited = new Promise<void>((resolve, reject) => {
    proc.once('error', reject);

    proc.once('close', (code, signal) => {
      if (code === 0) {
        resolve();

        return;
      }

      const reason  = signal ? `terminated by signal ${signal}` : `exited with code ${code}`;
      const detail  = stderrBuf.trim();
      const message = detail ? `pigz ${reason}: ${detail}` : `pigz ${reason}`;

      reject(new Error(message));
    });
  });

  return {
    process: proc,
    stdin:   proc.stdin,
    stdout:  proc.stdout,
    exited,
  };
};
