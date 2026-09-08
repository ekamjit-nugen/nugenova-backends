import { estimateCostUsd, FALLBACK_PRICE, MODEL_PRICES } from './model-pricing';

/** Pins the cost-estimation math + the unknown-model fallback + clamping. */
describe('estimateCostUsd', () => {
  it('prices a known model from the table', () => {
    // claude-sonnet-5: $2/1M in, $10/1M out.
    expect(estimateCostUsd('claude-sonnet-5', 1_000_000, 0)).toBeCloseTo(2, 6);
    expect(estimateCostUsd('claude-sonnet-5', 0, 1_000_000)).toBeCloseTo(10, 6);
    expect(estimateCostUsd('claude-sonnet-5', 500_000, 500_000)).toBeCloseTo(6, 6);
  });

  it('uses the fallback price for an unknown model', () => {
    const expected =
      (1_000_000 / 1e6) * FALLBACK_PRICE.inputPerMillion +
      (1_000_000 / 1e6) * FALLBACK_PRICE.outputPerMillion;
    expect(estimateCostUsd('some-future-model', 1_000_000, 1_000_000)).toBeCloseTo(expected, 6);
  });

  it('a local/zero-priced model costs 0', () => {
    expect(estimateCostUsd('llama3.1', 5000, 5000)).toBe(0);
  });

  it('clamps negative token counts to 0 and never returns NaN', () => {
    expect(estimateCostUsd('claude-sonnet-5', -100, -100)).toBe(0);
  });

  it('has a price entry for the default Claude models', () => {
    expect(MODEL_PRICES['claude-sonnet-5']).toBeDefined();
    expect(MODEL_PRICES['claude-opus-5']).toBeDefined();
  });
});
