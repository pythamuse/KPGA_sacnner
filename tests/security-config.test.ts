import { describe, expect, it } from 'vitest';

import nextConfig from '../next.config.mjs';

describe('Content Security Policy', () => {
  it('does not allow the removed third-party runtime asset hosts', async () => {
    if (!nextConfig.headers) {
      throw new Error('next.config.mjs does not define headers().');
    }

    const headerGroups = await nextConfig.headers();
    const csp = headerGroups
      .flatMap(({ headers }) => headers)
      .find(({ key }) => key.toLowerCase() === 'content-security-policy')?.value;

    expect(csp).toBeTypeOf('string');
    expect(csp).not.toContain('cdnjs.cloudflare.com');
    expect(csp).not.toContain('unpkg.com');
    expect(csp).not.toContain('docs.opencv.org');
  });
});
