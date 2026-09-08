import { describe, expect, it } from 'vitest';

import { formatBuildLabel } from '../src/lib/buildLabel';

describe('formatBuildLabel', () => {
  it('returns local-dev when the commit SHA is missing or empty', () => {
    expect(formatBuildLabel(undefined, '2026-09-09')).toBe('local-dev');
    expect(formatBuildLabel('', '2026-09-09')).toBe('local-dev');
  });

  it('uses only the first seven characters of a full commit SHA', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';

    expect(formatBuildLabel(sha, '2026-09-09')).toBe('v2026-09-09.0123456');
  });

  it('passes the build date through unchanged', () => {
    expect(formatBuildLabel('abcdef1234567890', '2099-12-31')).toBe('v2099-12-31.abcdef1');
  });
});
