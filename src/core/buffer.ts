/**
 * One-shot buffer compression / decompression. Backend is selected per call
 * based on `options.implementation`.
 */

import { spawnPigz } from './backend/pigz';
import { gzipBufferZlib, gunzipBufferZlib } from './backend/zlib';
import { getActiveBackend } from './detect';
import type { CompressionOptions, DecompressionOptions } from './types';

export const gzipBuffer = async (
  data:    Buffer | string | Uint8Array,
  options: CompressionOptions = {},
): Promise<Buffer> => {
  const backend = getActiveBackend(options.implementation);

  if (backend === 'zlib') return gzipBufferZlib(data, options);

  return gzipBufferPigz(data, options);
};

export const gunzipBuffer = async (
  data:    Buffer | Uint8Array,
  options: DecompressionOptions = {},
): Promise<Buffer> => {
  const backend = getActiveBackend(options.implementation);

  if (backend === 'zlib') return gunzipBufferZlib(data);

  return gunzipBufferPigz(data);
};

// ── pigz one-shot helpers (collect stdout while feeding stdin) ───────────────

const toBuffer = (data: Buffer | string | Uint8Array): Buffer => {
  if (typeof data === 'string') return Buffer.from(data);
  if (Buffer.isBuffer(data))    return data;

  return Buffer.from(data);
};

/**
 * Drain a Readable into a single Buffer using the standard async-iterator
 * pattern. Awaiting this resolves only after the stream has fully ended, so
 * it composes safely with `Promise.all([collected, pigz.exited])` — neither
 * promise resolves until its half is genuinely complete.
 */
const collectStream = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks);
};

const gzipBufferPigz = async (
  data: Buffer | string | Uint8Array,
  opts: CompressionOptions,
): Promise<Buffer> => {
  const input = toBuffer(data);
  const pigz  = spawnPigz(opts, 'compress');

  // Start collecting before writing so we never miss early stdout chunks.
  const collecting = collectStream(pigz.stdout);

  pigz.stdin.end(input);

  const [output] = await Promise.all([collecting, pigz.exited]);

  return output;
};

const gunzipBufferPigz = async (data: Buffer | Uint8Array): Promise<Buffer> => {
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const pigz  = spawnPigz({}, 'decompress');

  const collecting = collectStream(pigz.stdout);

  pigz.stdin.end(input);

  const [output] = await Promise.all([collecting, pigz.exited]);

  return output;
};
