import { describe, it, expect, beforeEach } from 'vitest';
import { _test_resetCache, getActiveBackend, isPigzAvailable } from '../../src/core/detect';

describe('detect', () => {
  beforeEach(() => {
    _test_resetCache();
  });

  it('isPigzAvailable returns a boolean', () => {
    const result = isPigzAvailable();

    expect(typeof result).toBe('boolean');
  });

  it('caches the result across calls', () => {
    const first  = isPigzAvailable();
    const second = isPigzAvailable();

    expect(first).toBe(second);
  });

  it('getActiveBackend honours explicit zlib choice', () => {
    expect(getActiveBackend('zlib')).toBe('zlib');
  });

  it('getActiveBackend honours auto and picks something', () => {
    const backend = getActiveBackend('auto');

    expect(['pigz', 'zlib']).toContain(backend);
  });

  it('getActiveBackend defaults to auto when no argument given', () => {
    const backend = getActiveBackend();

    expect(['pigz', 'zlib']).toContain(backend);
  });

  it('getActiveBackend throws when forcing pigz and it is not installed', () => {
    if (isPigzAvailable()) {
      // Skip — we can't test the throw path on a system that has pigz.
      expect(getActiveBackend('pigz')).toBe('pigz');

      return;
    }

    expect(() => getActiveBackend('pigz')).toThrow(/pigz.*not installed/);
  });
});
