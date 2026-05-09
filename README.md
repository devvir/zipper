# @devvir/zipper

Read and write gzip-compressed files **as if they were ordinary files**. Uses
[`pigz`](https://zlib.net/pigz/) for parallel compression when available;
falls back to Node's built-in `zlib` otherwise. The choice is automatic — you
never see it.

## Install

```bash
pnpm add @devvir/zipper
```

For parallel compression, install `pigz` on the host:

```bash
# Debian/Ubuntu
sudo apt install pigz

# macOS
brew install pigz
```

## The 90% case

```ts
import { write, read, readText, append } from '@devvir/zipper';

// Write a whole file
await write('/data/log.gz', 'hello\nworld\n');

// Read a whole file
const buffer = await read('/data/log.gz');         // Buffer
const text   = await readText('/data/log.gz');     // string

// Append one independent unit (each call is durable on its own)
await append('/data/log.gz', 'event A\n');
await append('/data/log.gz', 'event B\n');
```

That's it. No streams, no handles, no calls to `close()`.

## Path-bound writers and readers

When you want to keep a handle open and write/read across many calls:

```ts
import { createWriter, createReader } from '@devvir/zipper';

// Writer: discrete writes (one durable unit per call)
const writer = createWriter('/data/events.gz', { level: 6 });
await writer.write('event 1\n');
await writer.write('event 2\n');
await writer.flush();    // await everything queued so far; writer stays open
await writer.close();    // finalise: drain, close any streams, rename temp file
// ...or writer.abort() to discard — drop the (temp) file without renaming.

// Writer: streaming (many writes funnel into one compressed unit)
const stream = writer.stream();
stream.write('chunk 1');
stream.write('chunk 2');
// stream.close() is optional — writer.close() will finalise it for you.
// Call it explicitly if you want errors to surface earlier.

// Reader: pick whichever shape fits
const reader = createReader('/data/events.gz');

const all      = await reader.read();              // Buffer
const text     = await reader.readText();          // string
for await (const chunk of reader) { /* Buffer */ }
for await (const line  of reader.lines()) { /* string */ }
const stream   = reader.stream();                  // Node Readable
```

## Durable writes

Discrete `write()` calls are crash-aware. A failed member append is retried
(`retries`), and a member that fails every retry is handled by the `recovery`
policy:

```ts
const writer = createWriter('/data/events.gz', {
  retries:  2,
  recovery: 'auto',                          // 'auto' | 'none' | 'safe'
  onWriteFailure: (info) => log.warn(info),  // fires under 'auto' and 'safe'
});
```

- **`'auto'`** *(default)* — truncate the corrupt tail away, drop the member,
  keep the file healthy and continuous. `write()` resolves; the loss is
  reported through `onWriteFailure`. If the truncate itself fails, escalates
  to `'safe'`.
- **`'none'`** — leave the file untouched (corrupt tail and all) and reject
  `write()` with a `ZipperWriteError` carrying the in-memory `member` buffer
  and the `lastGoodOffset`, so the caller can recover the file however it
  likes.
- **`'safe'`** — rename the file aside to `path.failed.N`, start a fresh one,
  and re-append the failed member to it. Never truncates, so it survives the
  failure mode that defeats `'auto'`. `write()` resolves; reported through
  `onWriteFailure`.

In every mode the live file is left healthy — "knowingly leaving it corrupt"
is never the default. The modes differ only in what happens to the failed
member's data and how the caller is told.

### Temp-file lifecycle

With `tmpExtension`, the writer writes to `path + tmpExtension` while open and
renames to `path` on `close()`. An existing temp file is resumed. Use it when
file existence — or the final name — is itself a "done" signal:

```ts
const writer = createWriter('/data/day.gz', { tmpExtension: '.tmp' });
await writer.write('row\n');   // lands in /data/day.gz.tmp
await writer.close();          // renamed to /data/day.gz
// writer.abort() instead would delete /data/day.gz.tmp and rename nothing.
```

### Backpressure

A soft signal — `write()` keeps accepting — for callers that propagate
pressure upstream rather than blocking:

```ts
const writer = createWriter('/data/events.gz', {
  highWaterMark: 32,                        // pending depth that trips the signal
  lowWaterMark:  8,                         // depth it clears at (hysteresis)
  onBackpressure: (active, count) => { /* throttle the source */ },
});
```

## Composing with existing Node streams

When you need to plug compression into a larger pipeline:

```ts
import { createGzipStream, createGunzipStream } from '@devvir/zipper';
import { pipeline } from 'node:stream/promises';

// Gzip on the way out
await pipeline(
  process.stdin,
  createGzipStream({ level: 9 }),
  fs.createWriteStream('/tmp/compressed.gz'),
);

// Gunzip on the way in
await pipeline(
  fs.createReadStream('/tmp/compressed.gz'),
  createGunzipStream(),
  csvParser,
);
```

## One-shot buffer ops

```ts
import { gzipBuffer, gunzipBuffer } from '@devvir/zipper';

const compressed = await gzipBuffer(Buffer.from('hello'), { level: 6 });
const original   = await gunzipBuffer(compressed);
```

## Diagnostics

```ts
import { isPigzAvailable, getActiveBackend } from '@devvir/zipper';

if (isPigzAvailable()) {
  log.info('zipper: using pigz (parallel)');
} else {
  log.warn('zipper: using zlib (single-threaded). Install pigz for ~Nx speedup.');
}

getActiveBackend();          // 'pigz' | 'zlib' — what 'auto' would pick
```

## Options

```ts
interface CompressionOptions {
  level?:          number;                    // 1-9, default 6
  threads?:        number;                    // pigz only, default os.cpus().length
  implementation?: 'auto' | 'pigz' | 'zlib';  // default 'auto'
}

interface DecompressionOptions {
  implementation?: 'auto' | 'pigz' | 'zlib';  // default 'auto'
}

// createWriter — extends CompressionOptions with durability + lifecycle knobs
interface WriterOptions extends CompressionOptions {
  tmpExtension?:   string | null;             // default null (write to path directly)
  retries?:        number;                    // default 0
  backoffMs?:      number;                    // default 100 (grows linearly)
  recovery?:       'auto' | 'none' | 'safe';  // default 'auto'
  highWaterMark?:  number;                    // backpressure trip depth
  lowWaterMark?:   number;                    // backpressure clear depth
  onWriteFailure?: (info: WriteFailure) => void;
  onBackpressure?: (active: boolean, count: number) => void;
}
```

`'auto'` picks pigz when available, otherwise zlib. `'pigz'` throws if pigz
isn't installed (no silent fallback when explicitly forced). `'zlib'` is
useful for tests / CI where you don't want a pigz dependency.

Every `WriterOptions` field is optional and defaults to the simple case — a
bare `createWriter(path)` behaves exactly as a plain append writer.

Defaults are chosen so output is reproducible — same input bytes → same
output bytes. (Pigz internally is given `-n` so the gzip header carries no
filename or mtime, matching zlib's default.)

## Async semantics

Every `await`-able method resolves only when the operation is genuinely
complete. With pigz, that means the subprocess has exited cleanly **and** the
output stream has fully drained. Nothing is fire-and-forget — if you want
fire-and-forget, just don't `await` the promise.

## Layered API

The package is structured so simple users never see complexity:

- **Friendly** — `write`, `append`, `read`, `readText`. One-liners.
- **File** — `createWriter`, `createReader`. Path-bound objects.
- **Core** — `createGzipStream`, `createGunzipStream`, `gzipBuffer`,
  `gunzipBuffer`. Stream and buffer primitives that compose with anything.

Each layer is built on the one below — no logic is duplicated. If you find
yourself reaching past the friendly layer, that's the intended path.
