import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzipStream, createGunzipStream } from '../../src/core/stream';
import { isPigzAvailable } from '../../src/core/detect';

const SAMPLE = 'streaming sample line\n'.repeat(500);

const backends = ['zlib', ...(isPigzAvailable() ? ['pigz'] : [])] as const;

const collect = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks);
};

describe.each(backends)('stream transforms [%s]', (backend) => {
  it('round-trips via gzip → gunzip pipeline', async () => {
    const source     = Readable.from([Buffer.from(SAMPLE)]);
    const gzip       = createGzipStream({ implementation: backend });
    const gunzip     = createGunzipStream({ implementation: backend });

    source.pipe(gzip).pipe(gunzip);

    const result = await collect(gunzip);

    expect(result.toString()).toBe(SAMPLE);
  });

  it('compresses input that the other backend can decompress', async () => {
    if (! isPigzAvailable()) return;

    const otherBackend = backend === 'zlib' ? 'pigz' : 'zlib';
    const source       = Readable.from([Buffer.from(SAMPLE)]);
    const gzip         = createGzipStream({ implementation: backend });
    const gunzip       = createGunzipStream({ implementation: otherBackend });

    source.pipe(gzip).pipe(gunzip);

    const result = await collect(gunzip);

    expect(result.toString()).toBe(SAMPLE);
  });

  it('handles many small writes', async () => {
    const gzip   = createGzipStream({ implementation: backend });
    const gunzip = createGunzipStream({ implementation: backend });

    const collected = collect(gunzip);

    gzip.pipe(gunzip);

    for (let i = 0; i < 100; i++) {
      gzip.write(`line ${i}\n`);
    }

    gzip.end();

    const result = await collected;
    const expected = Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join('');

    expect(result.toString()).toBe(expected);
  });

  it('surfaces decompression errors on corrupt input', async () => {
    const gunzip = createGunzipStream({ implementation: backend });
    const garbage = Buffer.from('this is not a valid gzip stream at all');

    Readable.from([garbage]).pipe(gunzip);

    await expect(collect(gunzip)).rejects.toThrow();
  });

  it('round-trips through a stream.pipeline', async () => {
    const source = Readable.from([Buffer.from(SAMPLE)]);

    let collected = Buffer.alloc(0);

    const sink = new (await import('node:stream')).Writable({
      write(chunk, _enc, cb) {
        collected = Buffer.concat([collected, chunk]);
        cb();
      },
    });

    await pipeline(
      source,
      createGzipStream({ implementation: backend }),
      createGunzipStream({ implementation: backend }),
      sink,
    );

    expect(collected.toString()).toBe(SAMPLE);
  });
});
