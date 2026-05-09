/**
 * @devvir/zipper — read and write gzip-compressed files as if they were
 * ordinary files. Uses pigz for parallel compression when available, falls
 * back to Node's built-in zlib otherwise.
 *
 * The public surface is layered. Most callers only need the friendly layer
 * (top section). The file and core layers are exported for callers that
 * need finer control.
 *
 * @example
 * ```ts
 * import { write, read, createWriter, createReader } from '@devvir/zipper';
 *
 * // One-liners
 * await write('/data/log.gz', 'hello\nworld\n');
 * const text = await readText('/data/log.gz');
 *
 * // Path-bound, append-as-events
 * const writer = createWriter('/data/log.gz');
 * await writer.write('event 1\n');
 * await writer.write('event 2\n');
 * await writer.close();
 *
 * // Path-bound, streaming
 * const reader = createReader('/data/log.gz');
 * for await (const line of reader.lines()) {
 *   console.log(line);
 * }
 * ```
 */

// ── Friendly layer (the 90% case) ────────────────────────────────────────────
export {
  write,
  append,
  read,
  readText,
} from './friendly';

// ── File layer (path-bound writers/readers) ──────────────────────────────────
export { createWriter }    from './file/writer';
export { createReader }    from './file/reader';
export { ZipperWriteError } from './file/errors';

export type { Writer, WriterStream } from './file/writer';
export type { Reader }               from './file/reader';

// ── Core layer (stream Transforms, buffer ops, backend control) ──────────────
export {
  createGzipStream,
  createGunzipStream,
} from './core/stream';

export {
  gzipBuffer,
  gunzipBuffer,
} from './core/buffer';

export {
  isPigzAvailable,
  getActiveBackend,
} from './core/detect';

export type {
  Backend,
  BackendChoice,
  CompressionOptions,
  DecompressionOptions,
  Recovery,
  WriterOptions,
  WriteFailure,
} from './core/types';
