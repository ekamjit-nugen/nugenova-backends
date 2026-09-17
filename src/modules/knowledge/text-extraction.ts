/**
 * Text extraction for the RAG corpus.
 *
 * Extraction coverage in this build:
 *   - txt / markdown / json / csv / plain text → decoded natively (no dep).
 *   - PDF                                       → `pdf-parse` (added dependency).
 *   - xlsx / docx / other office               → NOT extracted here — reported as
 *     `unextractable` (a documented seam; a lightweight lib can be added later
 *     without touching call sites).
 *
 * Binary / empty / oversized files are skipped gracefully. Nothing here throws
 * on unsupported input — the caller decides how to record a skip.
 */

/** Upper bound on bytes we will try to extract (protects the indexer). */
export const MAX_EXTRACT_BYTES = 20 * 1024 * 1024; // 20 MB

export type ExtractionStatus = 'ok' | 'empty' | 'unextractable' | 'too_large' | 'error';

export interface ExtractionResult {
  status: ExtractionStatus;
  text: string;
  /** Short machine reason when not `ok` (for the skipped ledger). */
  reason?: string;
}

const TEXT_EXTENSIONS = new Set(['txt', 'text', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'yaml', 'yml']);
const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_EXACT = new Set([
  'application/json',
  'application/csv',
  'application/xml',
  'application/x-ndjson',
  'application/markdown',
]);
const PDF_EXTENSIONS = new Set(['pdf']);
const OFFICE_EXTENSIONS = new Set(['xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'odt', 'ods', 'odp']);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function looksTextual(mime: string, ext: string): boolean {
  const m = (mime || '').toLowerCase();
  if (TEXT_MIME_EXACT.has(m)) return true;
  if (TEXT_MIME_PREFIXES.some((p) => m.startsWith(p))) return true;
  return TEXT_EXTENSIONS.has(ext);
}

function isPdf(mime: string, ext: string): boolean {
  return (mime || '').toLowerCase().includes('pdf') || PDF_EXTENSIONS.has(ext);
}

function isOffice(ext: string, mime: string): boolean {
  const m = (mime || '').toLowerCase();
  return (
    OFFICE_EXTENSIONS.has(ext) ||
    m.includes('officedocument') ||
    m.includes('msword') ||
    m.includes('ms-excel') ||
    m.includes('ms-powerpoint') ||
    m.includes('opendocument')
  );
}

/**
 * Heuristic: does this buffer look like binary (control bytes / NUL) rather than
 * decodable UTF-8 text? A NUL byte or a high ratio of non-printable control
 * characters in the first block means "don't treat as text".
 */
function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  if (sample.length === 0) return false;
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return true; // NUL → binary
    // Allow tab(9), LF(10), CR(13), and printable >= 32.
    if (byte < 9 || (byte > 13 && byte < 32)) control++;
  }
  return control / sample.length > 0.3;
}

/**
 * Make extracted text safe to store and index. PDFs with custom font encodings
 * often yield NUL bytes (U+0000) for some glyphs — Postgres text/jsonb reject
 * them outright ("invalid byte sequence for encoding UTF8: 0x00"), which used
 * to fail the whole CV upload. Also drops other C0 control characters (keeping
 * tab/newline/CR), unpaired surrogates and replacement characters, and tidies
 * the runs of spaces the removed glyphs leave behind.
 */
export function sanitizeExtractedText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/[ \t]{3,}/g, '  ')
    .trim();
}

/** Decode a textual buffer to a UTF-8 string. */
function decodeText(buf: Buffer): string {
  return buf.toString('utf8');
}

/**
 * Extract plain text from a stored file's bytes by mime/extension. Never throws:
 * unsupported/binary/empty/oversized inputs return a non-`ok` status the caller
 * records as a skip.
 */
export async function extractText(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<ExtractionResult> {
  if (!buffer || buffer.length === 0) {
    return { status: 'empty', text: '', reason: 'empty file' };
  }
  if (buffer.length > MAX_EXTRACT_BYTES) {
    return { status: 'too_large', text: '', reason: `exceeds ${MAX_EXTRACT_BYTES} bytes` };
  }

  const ext = extensionOf(fileName || '');
  const mime = mimeType || '';

  // PDF first — a PDF is binary but extractable.
  if (isPdf(mime, ext)) {
    try {
      // Lazy require so the pdf-parse module is only loaded when actually needed.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pdfParse = require('pdf-parse') as (b: Buffer | Uint8Array) => Promise<{ text: string }>;
      // Hand pdf.js a Uint8Array created in the current JS realm: its `instanceof
      // Uint8Array` check fails for a Buffer from another realm (e.g. under Jest's
      // VM sandbox) and it then misreads the xref table ("bad XRef entry").
      const bytes = new Uint8Array(buffer.length);
      bytes.set(buffer);
      const parsed = await pdfParse(bytes);
      const text = sanitizeExtractedText(parsed?.text || '');
      if (!text) return { status: 'empty', text: '', reason: 'pdf had no extractable text' };
      return { status: 'ok', text };
    } catch (err) {
      return { status: 'error', text: '', reason: `pdf parse failed: ${(err as Error)?.message}` };
    }
  }

  // Office formats are a documented seam — not extracted in this build.
  if (isOffice(ext, mime)) {
    return { status: 'unextractable', text: '', reason: `office format .${ext} not supported in this build` };
  }

  // Native textual formats.
  if (looksTextual(mime, ext)) {
    if (looksBinary(buffer)) {
      return { status: 'unextractable', text: '', reason: 'declared text but bytes look binary' };
    }
    const text = sanitizeExtractedText(decodeText(buffer));
    if (!text) return { status: 'empty', text: '', reason: 'no text content' };
    return { status: 'ok', text };
  }

  // Unknown type: accept only if it decodes as clean text, else skip.
  if (!looksBinary(buffer)) {
    const text = sanitizeExtractedText(decodeText(buffer));
    if (text) return { status: 'ok', text };
    return { status: 'empty', text: '', reason: 'no text content' };
  }

  return { status: 'unextractable', text: '', reason: `unsupported/binary type (.${ext || '?'}, ${mime || '?'})` };
}
