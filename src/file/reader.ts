/**
 * Path-bound reader. Four shapes against the same file:
 *
 *   - `read()`        — entire decompressed contents as a Buffer.
 *   - `readText()`    — entire decompressed contents as a string.
 *   - `for await`     — iterate decompressed bytes as Buffer chunks.
 *   - `lines()`       — iterate decompressed text lines (handles \n / \r\n).
 *   - `stream()`      — get a Node Readable to pipe into existing infra.
 *
 * Multiple shapes can be used against the same reader — each opens its own
 * underlying file handle. `close()` destroys any streams still in flight.
 */

import fs from 'node:fs';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { gunzipBuffer } from '../core/buffer';
import { createGunzipStream } from '../core/stream';
import type { DecompressionOptions } from '../core/types';

export interface Reader {
  /** Read the entire decompressed file into memory. */
  read():     Promise<Buffer>;
  /** Read the entire decompressed file as text. Default encoding `utf-8`. */
  readText(encoding?: BufferEncoding): Promise<string>;
  /** Iterate decompressed bytes as Buffer chunks. */
  [Symbol.asyncIterator](): AsyncIterator<Buffer>;
  /** Iterate decompressed text lines. Handles `\n` and `\r\n`. */
  lines():    AsyncIterable<string>;
  /** Standard Node Readable yielding decompressed bytes. */
  stream():   Readable;
  /** Destroy any active streams. Idempotent. */
  close():    Promise<void>;
}

export const createReader = (path: string, options: DecompressionOptions = {}): Reader => {
  const active = new Set<Readable>();

  const openStream = (): Readable => {
    const file   = fs.createReadStream(path);
    const gunzip = createGunzipStream(options);

    file.on('error', (err) => gunzip.destroy(err));
    file.pipe(gunzip);

    active.add(gunzip);
    gunzip.on('close', () => active.delete(gunzip));

    return gunzip;
  };

  const read = async (): Promise<Buffer> => {
    const compressed = await fs.promises.readFile(path);

    return gunzipBuffer(compressed, options);
  };

  const readText = async (encoding: BufferEncoding = 'utf-8'): Promise<string> => {
    const buf = await read();

    return buf.toString(encoding);
  };

  async function* iterate(): AsyncGenerator<Buffer> {
    const stream = openStream();

    try {
      for await (const chunk of stream) {
        yield chunk as Buffer;
      }
    } finally {
      if (! stream.destroyed) stream.destroy();
    }
  }

  const lines = (): AsyncIterable<string> => ({
    [Symbol.asyncIterator]: async function* () {
      const stream = openStream();
      const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });

      try {
        for await (const line of rl) {
          yield line;
        }
      } finally {
        rl.close();

        if (! stream.destroyed) stream.destroy();
      }
    },
  });

  const close = async (): Promise<void> => {
    for (const stream of active) {
      if (! stream.destroyed) stream.destroy();
    }

    active.clear();
  };

  return {
    read,
    readText,
    [Symbol.asyncIterator]: iterate,
    lines,
    stream: openStream,
    close,
  };
};
