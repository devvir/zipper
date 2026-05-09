import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipBuffer } from '../../src/core/buffer';
import { isPigzAvailable } from '../../src/core/detect';
import { createWriter } from '../../src/file/writer';
import { ZipperWriteError } from '../../src/file/errors';
import type { WriteFailure } from '../../src/core/types';

const backends = ['zlib', ...(isPigzAvailable() ? ['pigz'] : [])] as const;

describe.each(backends)('createWriter [%s]', (backend) => {
  let tmpDir:   string;
  let filePath: string;

  beforeEach(() => {
    tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'zipper-writer-'));
    filePath = path.join(tmpDir, 'out.gz');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('write() persists each call as one gzip member', async () => {
    const writer = createWriter(filePath, { implementation: backend });

    await writer.write('hello\n');
    await writer.write('world\n');
    await writer.close();

    const compressed   = fs.readFileSync(filePath);
    const decompressed = await gunzipBuffer(compressed, { implementation: backend });

    expect(decompressed.toString()).toBe('hello\nworld\n');
  });

  it('write() preserves order even when not awaited individually', async () => {
    const writer = createWriter(filePath, { implementation: backend });

    void writer.write('a\n');
    void writer.write('b\n');
    void writer.write('c\n');

    await writer.close();

    const compressed   = fs.readFileSync(filePath);
    const decompressed = await gunzipBuffer(compressed, { implementation: backend });

    expect(decompressed.toString()).toBe('a\nb\nc\n');
  });

  it('stream() finalises one continuous member', async () => {
    const writer = createWriter(filePath, { implementation: backend });

    const stream = writer.stream();

    stream.write('chunk-1 ');
    stream.write('chunk-2 ');
    stream.write('chunk-3');

    await stream.close();
    await writer.close();

    const compressed   = fs.readFileSync(filePath);
    const decompressed = await gunzipBuffer(compressed, { implementation: backend });

    expect(decompressed.toString()).toBe('chunk-1 chunk-2 chunk-3');
  });

  it('stream() and write() can be used sequentially on the same file', async () => {
    const writer = createWriter(filePath, { implementation: backend });

    await writer.write('discrete-1\n');

    const stream = writer.stream();

    stream.write('streamed-portion\n');
    await stream.close();

    await writer.write('discrete-2\n');
    await writer.close();

    const compressed   = fs.readFileSync(filePath);
    const decompressed = await gunzipBuffer(compressed, { implementation: backend });

    expect(decompressed.toString()).toBe('discrete-1\nstreamed-portion\ndiscrete-2\n');
  });

  it("close() reports the first error from a failed write (recovery: 'none')", async () => {
    // Writing to a directory path fails at the appendFile step. Under the
    // 'none' policy that failure is captured and re-thrown by close().
    const writer = createWriter(tmpDir, { implementation: backend, recovery: 'none' });

    void writer.write('this should fail\n').catch(() => undefined);

    await expect(writer.close()).rejects.toThrow();
  });

  it('writer.close() finalises an open stream the caller did not close', async () => {
    const writer = createWriter(filePath, { implementation: backend });
    const stream = writer.stream();

    stream.write('a\n');
    stream.write('b\n');
    stream.write('c\n');

    // Caller does NOT call stream.close() — relies on writer.close() to do it.
    await writer.close();

    const compressed   = fs.readFileSync(filePath);
    const decompressed = await gunzipBuffer(compressed, { implementation: backend });

    expect(decompressed.toString()).toBe('a\nb\nc\n');
  });

  it('writer.close() is idempotent across repeated calls', async () => {
    const writer = createWriter(filePath, { implementation: backend });
    const stream = writer.stream();

    stream.write('once\n');

    await writer.close();
    await writer.close();
    await writer.close();

    const compressed   = fs.readFileSync(filePath);
    const decompressed = await gunzipBuffer(compressed, { implementation: backend });

    expect(decompressed.toString()).toBe('once\n');
  });

  it('stream.close() called explicitly still works alongside writer.close()', async () => {
    const writer = createWriter(filePath, { implementation: backend });
    const stream = writer.stream();

    stream.write('explicit\n');

    await stream.close();    // explicit; removes itself from tracking
    await writer.close();    // sees no open streams, just resolves

    const compressed   = fs.readFileSync(filePath);
    const decompressed = await gunzipBuffer(compressed, { implementation: backend });

    expect(decompressed.toString()).toBe('explicit\n');
  });
});

describe('createWriter — durability (zlib)', () => {
  let tmpDir:   string;
  let filePath: string;

  const readBack = async (p: string): Promise<string> => {
    const decompressed = await gunzipBuffer(fs.readFileSync(p), { implementation: 'zlib' });

    return decompressed.toString();
  };

  beforeEach(() => {
    tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'zipper-writer-dur-'));
    filePath = path.join(tmpDir, 'out.gz');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── tmpExtension ───────────────────────────────────────────────────────────

  it('tmpExtension: writes to the temp path, renames to the final path on close', async () => {
    const writer = createWriter(filePath, { tmpExtension: '.tmp', implementation: 'zlib' });

    await writer.write('hello\n');

    expect(fs.existsSync(filePath + '.tmp')).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);

    await writer.close();

    expect(fs.existsSync(filePath + '.tmp')).toBe(false);
    expect(await readBack(filePath)).toBe('hello\n');
  });

  it('tmpExtension: resumes an existing temp file', async () => {
    const first = createWriter(filePath, { tmpExtension: '.tmp', implementation: 'zlib' });

    await first.write('one\n');
    await first.flush();

    // Simulate a restart: a new writer over the same, still-open temp file.
    const second = createWriter(filePath, { tmpExtension: '.tmp', implementation: 'zlib' });

    await second.write('two\n');
    await second.close();

    expect(await readBack(filePath)).toBe('one\ntwo\n');
  });

  it('abort: deletes the temp file without renaming', async () => {
    const writer = createWriter(filePath, { tmpExtension: '.tmp', implementation: 'zlib' });

    await writer.write('discard me\n');
    await writer.abort();

    expect(fs.existsSync(filePath + '.tmp')).toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  // ── retries ────────────────────────────────────────────────────────────────

  it('retries: recovers when an append fails once then succeeds', async () => {
    const realAppend = fs.promises.appendFile.bind(fs.promises);
    const spy        = vi.spyOn(fs.promises, 'appendFile');

    spy.mockRejectedValueOnce(new Error('transient'));
    spy.mockImplementation(realAppend);

    const writer = createWriter(filePath, { implementation: 'zlib', retries: 2, backoffMs: 0 });

    await writer.write('survived\n');
    await writer.close();

    expect(await readBack(filePath)).toBe('survived\n');
  });

  // ── recovery: none ─────────────────────────────────────────────────────────

  it("recovery 'none': rejects with ZipperWriteError, leaves the file untouched", async () => {
    const writer = createWriter(filePath, { implementation: 'zlib', recovery: 'none' });

    await writer.write('good\n');

    const goodSize = fs.statSync(filePath).size;
    const spy      = vi.spyOn(fs.promises, 'appendFile').mockRejectedValue(new Error('io error'));

    const err = await writer.write('doomed\n').catch(e => e);

    spy.mockRestore();

    expect(err).toBeInstanceOf(ZipperWriteError);
    expect(err.lastGoodOffset).toBe(goodSize);
    expect(Buffer.isBuffer(err.member)).toBe(true);
    expect(fs.statSync(filePath).size).toBe(goodSize);   // file untouched
    expect(await readBack(filePath)).toBe('good\n');
  });

  // ── recovery: auto ─────────────────────────────────────────────────────────

  it("recovery 'auto': drops the failed member, truncates back, file stays valid", async () => {
    const failures: WriteFailure[] = [];
    const writer = createWriter(filePath, {
      implementation: 'zlib',
      onWriteFailure: (info) => failures.push(info),
    });

    await writer.write('good\n');

    const spy = vi.spyOn(fs.promises, 'appendFile').mockRejectedValue(new Error('disk full'));

    await writer.write('doomed\n');   // resolves — auto-recovered

    spy.mockRestore();
    await writer.close();

    expect(failures).toHaveLength(1);
    expect(failures[0].recovery).toBe('auto');
    expect(failures[0].error.message).toBe('disk full');
    expect(failures[0].bytesDropped).toBeGreaterThan(0);
    expect(await readBack(filePath)).toBe('good\n');
  });

  it("recovery 'auto': escalates to safe when truncate also fails", async () => {
    const failures: WriteFailure[] = [];
    const writer = createWriter(filePath, {
      implementation: 'zlib',
      backoffMs:      0,
      onWriteFailure: (info) => failures.push(info),
    });

    await writer.write('good\n');

    vi.spyOn(fs.promises, 'appendFile').mockRejectedValue(new Error('append fail'));
    vi.spyOn(fs.promises, 'truncate').mockRejectedValue(new Error('truncate fail'));

    await writer.write('doomed\n');   // auto → truncate fails → escalate to safe

    const f = failures[0];

    expect(f.recovery).toBe('safe');
    expect(f.truncateError?.message).toBe('truncate fail');
    expect(f.quarantinePath).toBeDefined();
    expect(fs.existsSync(f.quarantinePath!)).toBe(true);
    expect(f.reappendError?.message).toBe('append fail');
  });

  // ── recovery: safe ─────────────────────────────────────────────────────────

  it("recovery 'safe': quarantines the file and re-appends the member to a fresh one", async () => {
    const failures: WriteFailure[] = [];
    const writer = createWriter(filePath, {
      implementation: 'zlib',
      recovery:       'safe',
      backoffMs:      0,
      onWriteFailure: (info) => failures.push(info),
    });

    await writer.write('good\n');

    const realAppend = fs.promises.appendFile.bind(fs.promises);
    const spy        = vi.spyOn(fs.promises, 'appendFile');

    spy.mockRejectedValueOnce(new Error('glitch'));   // the original append fails
    spy.mockImplementation(realAppend);               // the safe re-append succeeds

    await writer.write('rescued\n');

    spy.mockRestore();
    await writer.close();

    const f = failures[0];

    expect(f.recovery).toBe('safe');
    expect(f.reappendError).toBeUndefined();          // re-append succeeded
    expect(f.quarantinePath).toBeDefined();
    expect(await readBack(f.quarantinePath!)).toBe('good\n');
    expect(await readBack(filePath)).toBe('rescued\n');
  });

  // ── backpressure ───────────────────────────────────────────────────────────

  it('backpressure: signals on crossing highWaterMark and clears at lowWaterMark', async () => {
    const events: Array<{ active: boolean; count: number }> = [];
    const writer = createWriter(filePath, {
      implementation: 'zlib',
      highWaterMark:  3,
      lowWaterMark:   1,
      onBackpressure: (active, count) => events.push({ active, count }),
    });

    const writes = [
      writer.write('a\n'),
      writer.write('b\n'),
      writer.write('c\n'),   // pending reaches 3 → backpressure on
      writer.write('d\n'),
    ];

    await Promise.all(writes);
    await writer.close();

    expect(events.some(e => e.active)).toBe(true);
    expect(events.some(e => ! e.active)).toBe(true);
    expect(events[events.length - 1].active).toBe(false);
  });

  // ── flush ──────────────────────────────────────────────────────────────────

  it('flush: awaits pending writes and leaves the writer usable', async () => {
    const writer = createWriter(filePath, { implementation: 'zlib' });

    void writer.write('before\n');
    await writer.flush();

    void writer.write('after\n');
    await writer.close();

    expect(await readBack(filePath)).toBe('before\nafter\n');
  });
});
