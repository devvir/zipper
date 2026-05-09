/**
 * Path-bound writer. Two modes against the same file:
 *
 *   - `write(data)` — append `data` as one independent gzip member. Resolves
 *     when the bytes are on disk. Each member is self-contained, so the file
 *     is valid after every call.
 *
 *   - `stream()` — open a Writable; everything written to it goes into one
 *     gzip member, finalised when its own `close()` is awaited or implicitly
 *     when `writer.close()` is awaited. Best for bulk writes.
 *
 * Don't mix the two modes concurrently on the same writer — interleaved
 * `write()` calls and an open `stream()` would race on the file.
 *
 * Discrete `write()` calls are durable: a failed member append is retried
 * (`retries`), and a member that fails every retry is handled by the
 * `recovery` policy — see `WriterOptions`. `stream()` failures still surface
 * via `close()`.
 *
 * With `tmpExtension` set, writes go to `path + tmpExtension` and the file is
 * renamed to `path` on `close()`; an existing temp file is resumed. `abort()`
 * discards the temp file instead of renaming it.
 */

import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Writable } from 'node:stream';
import { gzipBuffer } from '../core/buffer';
import { createGzipStream } from '../core/stream';
import { ZipperWriteError } from './errors';
import type { WriterOptions, WriteFailure } from '../core/types';

/** Attempts to re-append the failed member to a fresh file under `'safe'`. */
const SAFE_REAPPEND_ATTEMPTS = 3;

/** A standard Node Writable plus a Promise-based `close()`. */
export type WriterStream = Writable & {
  /**
   * Finalise this gzip member. Resolves when the compressed bytes are
   * fully flushed to disk and any spawned pigz process has exited cleanly.
   * Idempotent — calling twice resolves immediately the second time.
   */
  close(): Promise<void>;
};

export interface Writer {
  /**
   * Append `data` as one independent gzip member. Resolves when the bytes
   * are on disk. Calls are queued in arrival order — fire-and-forget is
   * supported (the first error is captured and re-thrown on `close()`).
   *
   * Under `recovery: 'none'` a member that fails every retry rejects with a
   * `ZipperWriteError`; under `'auto'` / `'safe'` it resolves and the failure
   * is reported through `onWriteFailure` instead.
   */
  write(data: Buffer | string | Uint8Array): Promise<void>;

  /**
   * Open a streaming write. Write chunks to the returned stream; await its
   * `close()` to finalise the member, OR just await `writer.close()` later
   * — that finalises every still-open stream. Multiple `stream()` calls on
   * the same writer are fine sequentially; each adds one independent member.
   */
  stream(): WriterStream;

  /**
   * Await every pending discrete `write()` without finalising the writer.
   * The writer stays open for further writes. Use it to checkpoint — to know
   * everything queued so far is on disk before recording progress elsewhere.
   */
  flush(): Promise<void>;

  /**
   * Finalise the writer:
   *   - awaits any pending discrete `write()` calls,
   *   - finalises any streams from `stream()` the caller didn't close,
   *   - renames `path + tmpExtension` → `path` when `tmpExtension` is set.
   *
   * Throws the first error captured during any of the above — and skips the
   * rename, leaving the temp file in place for inspection. Idempotent, and
   * mutually exclusive with `abort()`.
   */
  close(): Promise<void>;

  /**
   * Discard the writer: await pending work, then delete the (temp) file
   * without renaming. Idempotent, and mutually exclusive with `close()` —
   * whichever runs first wins.
   */
  abort(): Promise<void>;
}

export const createWriter = (path: string, options: WriterOptions = {}): Writer => {
  const tmpExtension  = options.tmpExtension ?? null;
  const retries       = options.retries      ?? 0;
  const backoffMs     = options.backoffMs    ?? 100;
  const recovery      = options.recovery     ?? 'auto';
  const highWaterMark = options.highWaterMark;
  const lowWaterMark  = options.lowWaterMark ?? options.highWaterMark ?? 0;

  // The file we actually write to while open. With `tmpExtension` it differs
  // from `path`; `close()` renames it back. An existing `target` is resumed
  // implicitly — `appendFile` and `statSync` both pick up where it left off.
  const target = tmpExtension !== null ? path + tmpExtension : path;

  let chain:      Promise<void>        = Promise.resolve();
  let firstError: Error | null         = null;
  let terminal:   Promise<void> | null = null;
  let pending            = 0;
  let backpressureActive = false;

  const openStreams = new Set<WriterStream>();

  const captureError = (err: unknown): void => {
    if (! firstError) {
      firstError = asError(err);
    }
  };

  // ── Discrete write path ─────────────────────────────────────────────────────

  const enqueueWrite = (data: Buffer | string | Uint8Array): Promise<void> => {
    if (terminal) {
      return Promise.reject(new Error('cannot write to a closed writer'));
    }

    pending++;

    if (highWaterMark !== undefined && ! backpressureActive && pending >= highWaterMark) {
      backpressureActive = true;

      options.onBackpressure?.(true, pending);
    }

    const result = chain.then(() => writeMember(data));

    chain = result.catch(captureError);

    chain.then(() => {
      pending--;

      if (highWaterMark !== undefined && backpressureActive && pending <= lowWaterMark) {
        backpressureActive = false;

        options.onBackpressure?.(false, pending);
      }
    });

    return result;
  };

  /**
   * Compresses one member and appends it, retrying on failure. A member that
   * fails every retry is handed to the `recovery` policy.
   */
  const writeMember = async (data: Buffer | string | Uint8Array): Promise<void> => {
    const lastGoodOffset = currentSize();
    const compressed     = await gzipBuffer(data, options);

    const error = await tryAppend(compressed, lastGoodOffset);

    if (! error) return;

    await recover(compressed, lastGoodOffset, error);
  };

  /**
   * Appends `compressed` to `target`, retrying up to `retries` times and
   * truncating back to `lastGoodOffset` between attempts. Returns the final
   * append error, or null on success. A failed truncate aborts the retries —
   * `recover` takes it from there.
   */
  const tryAppend = async (compressed: Buffer, lastGoodOffset: number): Promise<Error | null> => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await fs.promises.appendFile(target, compressed);

        return null;
      } catch (err) {
        const error = asError(err);

        if (attempt === retries) return error;

        try {
          await fs.promises.truncate(target, lastGoodOffset);
        } catch {
          return error;
        }

        await delay(backoffMs * (attempt + 1));
      }
    }

    return null;
  };

  /** Applies the configured `recovery` policy to a member that failed every retry. */
  const recover = async (compressed: Buffer, lastGoodOffset: number, error: Error): Promise<void> => {
    if (recovery === 'none') {
      throw new ZipperWriteError(
        `write failed for ${target}`,
        lastGoodOffset,
        compressed,
        { cause: error },
      );
    }

    if (recovery === 'auto') {
      try {
        await fs.promises.truncate(target, lastGoodOffset);
      } catch (truncErr) {
        // The file can't be patched in place. Fall back to the safe routine,
        // which sidesteps truncation entirely.
        await runSafe(compressed, lastGoodOffset, error, asError(truncErr));

        return;
      }

      report({
        path,
        recovery:       'auto',
        bytesDropped:   compressed.length,
        lastGoodOffset,
        error,
      });

      return;
    }

    await runSafe(compressed, lastGoodOffset, error, undefined);
  };

  /**
   * Quarantines the current file as `path.failed.N`, then re-appends the
   * failed member to a fresh `target`. If the re-append also fails every
   * attempt, the member survives only as the corrupt tail of the quarantined
   * file — nothing more can be done, so it's reported and dropped.
   */
  const runSafe = async (
    compressed:     Buffer,
    lastGoodOffset: number,
    error:          Error,
    truncateError:  Error | undefined,
  ): Promise<void> => {
    const quarantinePath = await quarantine();

    let reappendError: Error | undefined;

    for (let attempt = 0; attempt < SAFE_REAPPEND_ATTEMPTS; attempt++) {
      try {
        await fs.promises.appendFile(target, compressed);

        reappendError = undefined;

        break;
      } catch (err) {
        reappendError = asError(err);

        if (attempt < SAFE_REAPPEND_ATTEMPTS - 1) {
          await delay(backoffMs * (attempt + 1));
        }
      }
    }

    report({
      path,
      recovery:      'safe',
      bytesDropped:  compressed.length,
      lastGoodOffset,
      error,
      truncateError,
      quarantinePath,
      reappendError,
    });
  };

  /**
   * Renames `target` aside to the first free `path.failed.N`. Returns the
   * quarantine path, or `undefined` when there was nothing to move (the
   * first write failed before the file was ever created).
   */
  const quarantine = async (): Promise<string | undefined> => {
    if (! fs.existsSync(target)) return undefined;

    let n    = 1;
    let dest = `${path}.failed.${n}`;

    while (fs.existsSync(dest)) {
      n++;
      dest = `${path}.failed.${n}`;
    }

    await fs.promises.rename(target, dest);

    return dest;
  };

  const report = (info: WriteFailure): void => {
    options.onWriteFailure?.(info);
  };

  /** Current size of `target` on disk, or 0 if it does not exist yet. */
  const currentSize = (): number => {
    try {
      return fs.statSync(target).size;
    } catch {
      return 0;
    }
  };

  // ── Streaming write path ────────────────────────────────────────────────────

  const openStream = (): WriterStream => {
    if (terminal) {
      throw new Error('cannot stream to a closed writer');
    }

    const gzip       = createGzipStream(options);
    const fileStream = fs.createWriteStream(target, { flags: 'a' });

    // Drive the pipeline now, but don't await — caller writes via `gzip`.
    const piped = pipeline(gzip, fileStream);

    let stream: WriterStream;
    let closed = false;

    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;

      try {
        // End the writable side; once gzip drains, pipeline resolves.
        await new Promise<void>((resolve) => {
          if (gzip.writableEnded) {
            resolve();

            return;
          }

          gzip.end(() => resolve());
        });

        await piped;
      } finally {
        openStreams.delete(stream);
      }
    };

    stream = Object.assign(gzip, { close });
    openStreams.add(stream);

    return stream;
  };

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  const flush = async (): Promise<void> => {
    await chain;
  };

  const closeAll = async (): Promise<void> => {
    // Finalise any streams the caller didn't close themselves. Each stream's
    // own close() is idempotent and removes itself from `openStreams`.
    const streamCloses = Array.from(openStreams).map(s =>
      s.close().catch(captureError),
    );

    await Promise.all([chain, ...streamCloses]);

    if (firstError) throw firstError;

    if (target !== path) {
      await fs.promises.rename(target, path);
    }
  };

  const abortAll = async (): Promise<void> => {
    // Let in-flight work settle so nothing races the unlink.
    await chain;

    for (const stream of openStreams) {
      await stream.close().catch(() => undefined);
    }

    try {
      await fs.promises.unlink(target);
    } catch {
      // Already gone — idempotent.
    }
  };

  return {
    write:  enqueueWrite,
    stream: openStream,
    flush,
    close: () => {
      if (terminal) return terminal;

      terminal = closeAll();

      return terminal;
    },
    abort: () => {
      if (terminal) return terminal;

      terminal = abortAll();

      return terminal;
    },
  };
};

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

const asError = (err: unknown): Error =>
  err instanceof Error ? err : new Error(String(err));
