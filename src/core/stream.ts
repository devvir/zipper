/**
 * Stream-based compression / decompression.
 *
 * Each function returns a Duplex you can pipe through:
 *
 *   sourceReadable.pipe(createGunzipStream()).pipe(parser)
 *   producer.pipe(createGzipStream({ level: 6 })).pipe(fileWriter)
 *
 * For zlib, the returned object is the native Transform from `zlib.createGzip`.
 * For pigz, a custom Duplex bridges the spawned process — it holds back
 * `'end'` until pigz exits cleanly so consumers can't miss a post-EOF
 * process failure.
 */

import { Duplex } from 'node:stream';
import { spawnPigz, type PigzProcess } from './backend/pigz';
import { createGunzipStreamZlib, createGzipStreamZlib } from './backend/zlib';
import { getActiveBackend } from './detect';
import type { CompressionOptions, DecompressionOptions } from './types';

export const createGzipStream = (options: CompressionOptions = {}): Duplex => {
  const backend = getActiveBackend(options.implementation);

  if (backend === 'zlib') return createGzipStreamZlib(options);

  return new PigzDuplex(spawnPigz(options, 'compress'));
};

export const createGunzipStream = (options: DecompressionOptions = {}): Duplex => {
  const backend = getActiveBackend(options.implementation);

  if (backend === 'zlib') return createGunzipStreamZlib();

  return new PigzDuplex(spawnPigz({}, 'decompress'));
};

/**
 * Bridge a pigz subprocess as a Duplex. Writes go to pigz's stdin; reads
 * come from pigz's stdout. The readable side only emits `'end'` after
 * BOTH stdout has ended AND the process has exited — guarantees that a
 * post-streaming pigz failure surfaces as `'error'` on the Duplex rather
 * than a silent "looks fine" completion.
 */
class PigzDuplex extends Duplex {
  private stdoutEnded   = false;
  private processExited = false;
  private processErr:   Error | null = null;

  constructor(private readonly pigz: PigzProcess) {
    super();

    pigz.stdout.on('data', (chunk: Buffer) => {
      if (! this.push(chunk)) {
        pigz.stdout.pause();
      }
    });

    pigz.stdout.on('end',   () => { this.stdoutEnded = true; this.settle(); });
    pigz.stdout.on('error', (err) => this.destroy(err));

    pigz.exited.then(
      () => { this.processExited = true; this.settle(); },
      (err: Error) => { this.processErr = err; this.processExited = true; this.settle(); },
    );
  }

  override _read(): void {
    this.pigz.stdout.resume();
  }

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
    this.pigz.stdin.write(chunk, encoding, callback);
  }

  override _final(callback: (err?: Error | null) => void): void {
    this.pigz.stdin.end(callback);
  }

  override _destroy(err: Error | null, callback: (err?: Error | null) => void): void {
    if (! this.processExited && ! this.pigz.process.killed) {
      this.pigz.process.kill('SIGTERM');
    }

    callback(err);
  }

  private settle(): void {
    if (! this.stdoutEnded || ! this.processExited) return;

    if (this.processErr) {
      this.destroy(this.processErr);
    } else {
      this.push(null);
    }
  }
}
