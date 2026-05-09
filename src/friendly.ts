/**
 * Friendly one-liner helpers. Each is a thin composition over `core/` —
 * no compression logic lives here, just open/close ergonomics.
 */

import fs from 'node:fs';
import { gunzipBuffer, gzipBuffer } from './core/buffer';
import type { CompressionOptions, DecompressionOptions } from './core/types';

/** Compress `data` and write to `path`, replacing any existing file. */
export const write = async (
  path:    string,
  data:    Buffer | string | Uint8Array,
  options: CompressionOptions = {},
): Promise<void> => {
  const compressed = await gzipBuffer(data, options);

  await fs.promises.writeFile(path, compressed);
};

/** Compress `data` and append to `path` as one independent gzip member. */
export const append = async (
  path:    string,
  data:    Buffer | string | Uint8Array,
  options: CompressionOptions = {},
): Promise<void> => {
  const compressed = await gzipBuffer(data, options);

  await fs.promises.appendFile(path, compressed);
};

/** Read the entire decompressed contents of `path` as a Buffer. */
export const read = async (
  path:    string,
  options: DecompressionOptions = {},
): Promise<Buffer> => {
  const compressed = await fs.promises.readFile(path);

  return gunzipBuffer(compressed, options);
};

/** Read the entire decompressed contents of `path` as a string. */
export const readText = async (
  path:     string,
  encoding: BufferEncoding = 'utf-8',
  options:  DecompressionOptions = {},
): Promise<string> => {
  const buf = await read(path, options);

  return buf.toString(encoding);
};
