/**
 * Minimal ambient types for `pdf-parse` (ships no @types). We only use the
 * default export: `pdf(buffer) -> Promise<{ text, numpages, ... }>`.
 */
declare module 'pdf-parse' {
  interface PdfParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: unknown;
    metadata: unknown;
    version: string;
  }
  function pdfParse(dataBuffer: Buffer, options?: Record<string, unknown>): Promise<PdfParseResult>;
  export = pdfParse;
}
