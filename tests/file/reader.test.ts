import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipBuffer } from '../../src/core/buffer';
import { isPigzAvailable } from '../../src/core/detect';
import { createReader } from '../../src/file/reader';

const backends = ['zlib', ...(isPigzAvailable() ? ['pigz'] : [])] as const;

describe.each(backends)('createReader [%s]', (backend) => {
  let tmpDir:   string;
  let filePath: string;

  const writeCompressed = async (text: string): Promise<void> => {
    const compressed = await gzipBuffer(text, { implementation: backend });

    fs.writeFileSync(filePath, compressed);
  };

  const writeMultiMember = async (parts: string[]): Promise<void> => {
    const compressedParts = await Promise.all(
      parts.map(p => gzipBuffer(p, { implementation: backend })),
    );

    fs.writeFileSync(filePath, Buffer.concat(compressedParts));
  };

  beforeEach(() => {
    tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'zipper-reader-'));
    filePath = path.join(tmpDir, 'in.gz');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('read() returns the entire decompressed Buffer', async () => {
    await writeCompressed('hello, world!\n');

    const reader = createReader(filePath, { implementation: backend });
    const data   = await reader.read();

    expect(data.toString()).toBe('hello, world!\n');
  });

  it('readText() returns a string', async () => {
    await writeCompressed('text content here');

    const reader = createReader(filePath, { implementation: backend });
    const text   = await reader.readText();

    expect(text).toBe('text content here');
  });

  it('iterates chunks via for-await', async () => {
    await writeCompressed('chunked iteration test\n');

    const reader = createReader(filePath, { implementation: backend });

    let collected = Buffer.alloc(0);

    for await (const chunk of reader) {
      collected = Buffer.concat([collected, chunk]);
    }

    expect(collected.toString()).toBe('chunked iteration test\n');
  });

  it('iterates lines via lines()', async () => {
    await writeCompressed('line one\nline two\nline three\n');

    const reader = createReader(filePath, { implementation: backend });
    const lines: string[] = [];

    for await (const line of reader.lines()) {
      lines.push(line);
    }

    expect(lines).toEqual(['line one', 'line two', 'line three']);
  });

  it('handles \\r\\n line endings', async () => {
    await writeCompressed('a\r\nb\r\nc\r\n');

    const reader = createReader(filePath, { implementation: backend });
    const lines: string[] = [];

    for await (const line of reader.lines()) {
      lines.push(line);
    }

    expect(lines).toEqual(['a', 'b', 'c']);
  });

  it('stream() returns a Readable yielding decompressed bytes', async () => {
    await writeCompressed('stream content\n');

    const reader = createReader(filePath, { implementation: backend });
    const stream = reader.stream();

    let collected = Buffer.alloc(0);

    for await (const chunk of stream) {
      collected = Buffer.concat([collected, chunk as Buffer]);
    }

    expect(collected.toString()).toBe('stream content\n');
  });

  it('reads multi-member gzip files transparently', async () => {
    await writeMultiMember(['part-1\n', 'part-2\n', 'part-3\n']);

    const reader = createReader(filePath, { implementation: backend });
    const text   = await reader.readText();

    expect(text).toBe('part-1\npart-2\npart-3\n');
  });
});
