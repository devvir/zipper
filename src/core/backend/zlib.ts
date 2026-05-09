/**
 * zlib backend. Thin wrappers over Node's built-in `zlib` module that accept
 * the package's normalised options.
 */

import { promisify } from 'node:util';
import zlib from 'node:zlib';
import type { CompressionOptions } from '../types';

const gzipP   = promisify(zlib.gzip);
const gunzipP = promisify(zlib.gunzip);

const DEFAULT_LEVEL = 6;

/** Coerce any acceptable input shape into a Buffer. */
const toBuffer = (data: Buffer | string | Uint8Array): Buffer => {
  if (typeof data === 'string') return Buffer.from(data);
  if (Buffer.isBuffer(data))    return data;

  return Buffer.from(data);
};

const buildOptions = (opts: CompressionOptions): zlib.ZlibOptions => ({
  level: opts.level ?? DEFAULT_LEVEL,
});

export const gzipBufferZlib = async (data: Buffer | string | Uint8Array, opts: CompressionOptions = {}): Promise<Buffer> => {
  const out = await gzipP(toBuffer(data), buildOptions(opts));

  return out as Buffer;
};

export const gunzipBufferZlib = async (data: Buffer | Uint8Array): Promise<Buffer> => {
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const out   = await gunzipP(input);

  return out as Buffer;
};

export const createGzipStreamZlib = (opts: CompressionOptions = {}): zlib.Gzip =>
  zlib.createGzip(buildOptions(opts));

export const createGunzipStreamZlib = (): zlib.Gunzip =>
  zlib.createGunzip();
