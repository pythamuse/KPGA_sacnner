import { describe, expect, it, vi } from 'vitest';

import { withTimeout } from '../src/lib/pdf/withTimeout';

describe('withTimeout', () => {
  it('returns the resolved value when the promise completes before the timeout', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'timed out')).resolves.toBe('ok');
  });

  it('rejects with the timeout message when the promise does not complete in time', async () => {
    vi.useFakeTimers();

    try {
      const result = withTimeout(new Promise<string>(() => {}), 100, 'PDF render timed out');

      vi.advanceTimersByTime(100);

      await expect(result).rejects.toThrow('PDF render timed out');
    } finally {
      vi.useRealTimers();
    }
  });
});
