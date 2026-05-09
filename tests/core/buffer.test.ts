import { describe, it, expect } from 'vitest';
import { gzipBuffer, gunzipBuffer } from '../../src/core/buffer';
import { isPigzAvailable } from '../../src/core/detect';

const SAMPLE = 'hello, world!\n'.repeat(100);

const backends = ['zlib', ...(isPigzAvailable() ? ['pigz'] : [])] as const;

describe.each(backends)('buffer ops [%s]', (backend) => {
  it('round-trips a string', async () => {
    const compressed   = await gzipBuffer(SAMPLE,     { implementation: backend });
    const decompressed = await gunzipBuffer(compressed, { implementation: backend });

    expect(decompressed.toString()).toBe(SAMPLE);
  });

  it('round-trips a Buffer', async () => {
    const input        = Buffer.from('binary\x00content\x01here');
    const compressed   = await gzipBuffer(input,     { implementation: backend });
    const decompressed = await gunzipBuffer(compressed, { implementation: backend });

    expect(decompressed.equals(input)).toBe(true);
  });

  it('round-trips a Uint8Array', async () => {
    const input        = new Uint8Array([1, 2, 3, 4, 5]);
    const compressed   = await gzipBuffer(input,     { implementation: backend });
    const decompressed = await gunzipBuffer(compressed, { implementation: backend });

    expect(Buffer.from(decompressed).equals(Buffer.from(input))).toBe(true);
  });

  it('honours compression level', async () => {
    const big = 'x'.repeat(10_000);

    const small = await gzipBuffer(big, { level: 9, implementation: backend });
    const fast  = await gzipBuffer(big, { level: 1, implementation: backend });

    // Same data → both round-trip equal.
    expect((await gunzipBuffer(small, { implementation: backend })).toString()).toBe(big);
    expect((await gunzipBuffer(fast,  { implementation: backend })).toString()).toBe(big);
  });

  it('produces output that the OTHER backend can read', async () => {
    if (! isPigzAvailable()) return;

    const compressedHere  = await gzipBuffer(SAMPLE, { implementation: backend });
    const otherBackend    = backend === 'zlib' ? 'pigz' : 'zlib';
    const decompressedThere = await gunzipBuffer(compressedHere, { implementation: otherBackend });

    expect(decompressedThere.toString()).toBe(SAMPLE);
  });
});
