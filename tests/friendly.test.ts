import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { append, read, readText, write } from '../src/friendly';
import { isPigzAvailable } from '../src/core/detect';

const backends = ['zlib', ...(isPigzAvailable() ? ['pigz'] : [])] as const;

describe.each(backends)('friendly helpers [%s]', (backend) => {
  let tmpDir:   string;
  let filePath: string;

  beforeEach(() => {
    tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'zipper-friendly-'));
    filePath = path.join(tmpDir, 'file.gz');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('write() + read() round-trip', async () => {
    await write(filePath, 'hello\nworld\n', { implementation: backend });

    const out = await read(filePath, { implementation: backend });

    expect(out.toString()).toBe('hello\nworld\n');
  });

  it('write() replaces an existing file', async () => {
    await write(filePath, 'first',  { implementation: backend });
    await write(filePath, 'second', { implementation: backend });

    const text = await readText(filePath, 'utf-8', { implementation: backend });

    expect(text).toBe('second');
  });

  it('append() concatenates gzip members readable as one stream', async () => {
    await append(filePath, 'a\n', { implementation: backend });
    await append(filePath, 'b\n', { implementation: backend });
    await append(filePath, 'c\n', { implementation: backend });

    const text = await readText(filePath, 'utf-8', { implementation: backend });

    expect(text).toBe('a\nb\nc\n');
  });

  it('readText() supports custom encoding', async () => {
    await write(filePath, 'data', { implementation: backend });

    const text = await readText(filePath, 'utf-8', { implementation: backend });

    expect(text).toBe('data');
  });

  it('write() accepts a Buffer', async () => {
    const data = Buffer.from('binary\x00data');

    await write(filePath, data, { implementation: backend });

    const out = await read(filePath, { implementation: backend });

    expect(out.equals(data)).toBe(true);
  });
});
