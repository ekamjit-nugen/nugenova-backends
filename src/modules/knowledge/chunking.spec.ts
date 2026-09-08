import { chunkText, normalizeText } from './chunking';

/**
 * Unit specs for the passage chunker. Pins: overlap between consecutive chunks,
 * whole-word boundaries, and the empty/short degenerate cases.
 */
describe('chunkText', () => {
  it('returns no chunks for empty/whitespace input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\t  ')).toEqual([]);
  });

  it('returns a single chunk when the text fits in one window', () => {
    const out = chunkText('short document body', { chunkChars: 500, overlapChars: 75 });
    expect(out).toEqual(['short document body']);
  });

  it('splits long text into multiple overlapping chunks', () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const out = chunkText(words, { chunkChars: 300, overlapChars: 45 });
    expect(out.length).toBeGreaterThan(1);
    // Consecutive chunks must share overlapping text (the tail of one appears at
    // the head of the next), so a fact on a boundary survives in a chunk.
    for (let i = 1; i < out.length; i++) {
      const prevTailWord = out[i - 1].split(' ').slice(-1)[0];
      expect(out[i].includes(prevTailWord)).toBe(true);
    }
  });

  it('does not cut words in half at chunk boundaries', () => {
    const words = Array.from({ length: 300 }, (_, i) => `token${i}`).join(' ');
    const out = chunkText(words, { chunkChars: 250, overlapChars: 40 });
    for (const c of out) {
      // Every space-separated token in a chunk is a complete "token<N>" word.
      for (const tok of c.split(' ')) {
        expect(tok).toMatch(/^token\d+$/);
      }
    }
  });

  it('normalizes whitespace runs', () => {
    expect(normalizeText('a\r\n\r\n\r\nb   c\t\td')).toBe('a\n\nb c d');
  });

  it('always makes forward progress (terminates) on pathological input', () => {
    const blob = 'x'.repeat(10_000); // no whitespace to break on
    const out = chunkText(blob, { chunkChars: 300, overlapChars: 45 });
    expect(out.length).toBeGreaterThan(1);
    expect(out.join('').length).toBeGreaterThanOrEqual(blob.length);
  });
});
