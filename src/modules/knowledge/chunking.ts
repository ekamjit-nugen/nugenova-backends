/**
 * Passage chunking for the RAG corpus.
 *
 * Documents are split into ~500–800-token passages. We approximate tokens by
 * characters (~4 chars/token → ~2–3k chars) rather than pulling a tokenizer
 * dependency, and overlap consecutive chunks by ~15% so a fact split across a
 * boundary is still wholly present in at least one chunk. Splits prefer a nearby
 * whitespace boundary so we don't cut mid-word.
 */

export interface ChunkOptions {
  /** Target characters per chunk (~2–3k ≈ 500–800 tokens). */
  chunkChars?: number;
  /** Overlap characters carried from the previous chunk (~15% of chunkChars). */
  overlapChars?: number;
}

export const DEFAULT_CHUNK_CHARS = 2400;
export const DEFAULT_OVERLAP_CHARS = 360; // ~15% of 2400

/** Collapse runs of whitespace and trim — normalises extracted text. */
export function normalizeText(input: string): string {
  return (input || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split normalised text into overlapping character-window chunks. Empty/blank
 * input yields no chunks. Each window ends at the last whitespace before the
 * hard limit (when one exists in the back third) so words stay intact; the next
 * window starts `overlapChars` before the previous end.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const chunkChars = Math.max(200, opts.chunkChars ?? DEFAULT_CHUNK_CHARS);
  const overlapChars = Math.min(
    Math.max(0, opts.overlapChars ?? DEFAULT_OVERLAP_CHARS),
    Math.floor(chunkChars / 2), // overlap can never swallow a whole chunk
  );

  const clean = normalizeText(text);
  if (!clean) return [];
  if (clean.length <= chunkChars) return [clean];

  const chunks: string[] = [];
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(start + chunkChars, clean.length);

    // Prefer to break at a whitespace boundary in the back third of the window
    // so we don't cut a word in half (only when not already at the very end).
    if (end < clean.length) {
      const windowFloor = start + Math.floor(chunkChars * 0.66);
      const brk = Math.max(
        clean.lastIndexOf(' ', end),
        clean.lastIndexOf('\n', end),
      );
      if (brk > windowFloor) end = brk;
    }

    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);

    if (end >= clean.length) break;
    // Advance with overlap. `end - start >= 0.66*chunkChars > overlapChars`
    // (overlap ≤ 0.5*chunkChars), so `start` always moves forward.
    let next = end - overlapChars;
    // Snap the overlap start FORWARD to a word boundary so a chunk never begins
    // mid-word (the end boundary is already word-aligned above). If there is no
    // whitespace ahead of `next` before `end` (a giant unbroken token), keep the
    // raw offset — progress still holds.
    const sp = clean.indexOf(' ', next);
    if (sp !== -1 && sp < end) next = sp + 1;
    start = next;
  }

  return chunks;
}
