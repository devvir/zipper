/**
 * Public types for the core layer.
 *
 * The whole package shares one option shape so callers don't need to learn
 * different vocabularies for the file, friendly, or stream layers.
 */

/** Concrete backend used for a given operation. */
export type Backend = 'pigz' | 'zlib';

/** Backend selection policy. `'auto'` picks pigz if available, else zlib. */
export type BackendChoice = 'auto' | Backend;

/**
 * Compression options. Every field is optional; defaults are chosen for
 * reproducibility and the common case.
 */
export interface CompressionOptions {
  /** Deflate level 1-9. Default 6. */
  level?:          number;
  /** Worker threads for pigz. Ignored on zlib. Default `os.cpus().length`. */
  threads?:        number;
  /** Backend selection. Default `'auto'`. */
  implementation?: BackendChoice;
}

/**
 * Decompression options. Decompression is decompression — the only knob is
 * which backend does the work, exposed mainly so tests can force `'zlib'`
 * without needing pigz installed.
 */
export interface DecompressionOptions {
  /** Backend selection. Default `'auto'`. */
  implementation?: BackendChoice;
}

/**
 * Recovery policy for a discrete `write()` whose member append fails every
 * retry. See `WriterOptions.recovery`.
 *
 *   - `'auto'` — truncate the failed member off, drop it, keep the same file.
 *     If the truncate itself fails, escalates to `'safe'`. Reports through
 *     `onWriteFailure`; the `write()` still resolves.
 *   - `'none'` — leave the file untouched (corrupt tail and all) and reject
 *     the `write()` with a `ZipperWriteError`, handing the caller the data
 *     and offset so it can recover the file however it likes.
 *   - `'safe'` — rename the file aside to `path.failed.N`, start a fresh one,
 *     and re-append the failed member to it. Never truncates, so it survives
 *     the failure mode that defeats `'auto'`. Reports through `onWriteFailure`;
 *     the `write()` still resolves.
 */
export type Recovery = 'auto' | 'none' | 'safe';

/**
 * Describes a discrete `write()` that failed every retry. Passed to
 * `WriterOptions.onWriteFailure` under the `'auto'` and `'safe'` policies
 * (`'none'` throws a `ZipperWriteError` instead).
 */
export interface WriteFailure {
  /** The writer's final path (not the temp path, if one is in use). */
  path:            string;
  /** Which policy handled the failure. `'auto'` reports `'safe'` here if it escalated. */
  recovery:        'auto' | 'safe';
  /** Byte length of the gzip member that did not land. */
  bytesDropped:    number;
  /** Offset the data file was known-good at before the failed append. */
  lastGoodOffset:  number;
  /** The underlying append failure. */
  error:           Error;
  /** Present when truncate-back also failed, forcing `'auto'` to escalate to `'safe'`. */
  truncateError?:  Error;
  /** Present under `'safe'`: where the pre-failure file was quarantined. */
  quarantinePath?: string;
  /**
   * Present under `'safe'` when re-appending the member to the fresh file
   * also failed every attempt — the member survives only as the corrupt tail
   * of `quarantinePath`, and nothing more can be done.
   */
  reappendError?:  Error;
}

/**
 * Options for a path-bound `Writer`. Extends `CompressionOptions`; every
 * added field is optional and defaults to the simple, no-frills case so a
 * bare `createWriter(path)` behaves exactly as before.
 */
export interface WriterOptions extends CompressionOptions {
  /**
   * While open, write to `path + tmpExtension` instead of `path`, and rename
   * to `path` on `close()`. An existing temp file is resumed (appended to).
   * When `null` (default), writes go straight to `path` — which stays valid
   * after every member anyway.
   */
  tmpExtension?:   string | null;
  /** Times to retry a failed member append before invoking `recovery`. Default 0. */
  retries?:        number;
  /** Base backoff between retries, in ms; grows linearly per attempt. Default 100. */
  backoffMs?:      number;
  /** Policy for a member that fails every retry. Default `'auto'`. */
  recovery?:       Recovery;
  /** Pending discrete-write depth at which `onBackpressure(true)` fires. */
  highWaterMark?:  number;
  /**
   * Pending depth at which `onBackpressure(false)` fires. Defaults to
   * `highWaterMark` (no hysteresis); set lower to add some.
   */
  lowWaterMark?:   number;
  /** Notified when a member fails every retry under `'auto'` / `'safe'`. */
  onWriteFailure?: (info: WriteFailure) => void;
  /** Notified when the pending-write count crosses `highWaterMark` / `lowWaterMark`. */
  onBackpressure?: (active: boolean, count: number) => void;
}
