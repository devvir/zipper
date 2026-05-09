/**
 * Errors thrown by the file layer.
 */

/**
 * Thrown by a `Writer` under `recovery: 'none'` when a member append fails
 * every retry. The data file is left untouched — corrupt tail and all — so
 * the caller can decide how to recover it.
 *
 * `member` is the complete, in-memory compressed buffer that never landed;
 * `lastGoodOffset` is where the file was known-good before the failed append.
 * Between them the caller can truncate-and-retry, run `gzrecover`, or do
 * whatever its situation calls for.
 */
export class ZipperWriteError extends Error {
  readonly lastGoodOffset: number;
  readonly member:         Buffer;

  constructor(
    message:        string,
    lastGoodOffset: number,
    member:         Buffer,
    options?:       { cause?: unknown },
  ) {
    super(message, options);

    this.name           = 'ZipperWriteError';
    this.lastGoodOffset = lastGoodOffset;
    this.member         = member;
  }
}
