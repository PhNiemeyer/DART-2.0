import { describe, expect, it } from 'vitest';
import { contrastPairs, contrastRatio, tokens } from './index';
describe('Farbkontraste WCAG 2.2 AA', () => {
  it.each(contrastPairs)('%s auf %s ≥ 4,5:1', (fg, bg) => {
    expect(contrastRatio(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(4.5);
  });
});
