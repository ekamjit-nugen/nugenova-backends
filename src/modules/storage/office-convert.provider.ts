import { Injectable } from '@nestjs/common';

/**
 * Office → PDF conversion seam.
 *
 * The legacy Mongo module shelled out to a headless LibreOffice (`soffice`) to
 * render pptx/docx/xlsx to PDF for in-app preview, caching the result in S3. That
 * heavy, host-dependent converter is intentionally NOT ported here. Instead we
 * expose this provider interface with a no-op default: PDFs preview directly and
 * every other type reports "not convertible", so the product runs everywhere with
 * zero native dependencies.
 *
 * To restore rich office previews later, bind `OFFICE_CONVERT_PROVIDER` to a real
 * implementation (LibreOffice sidecar, Gotenberg, or a cloud conversion API) —
 * nothing else in the drive changes.
 */
export interface OfficeConvertProvider {
  /** Whether this provider can turn the given filename's type into a PDF. */
  isConvertible(filename: string): boolean;
  /** Convert office bytes to a PDF buffer. Throws if unsupported. */
  convertToPdf(input: Buffer, filename: string): Promise<Buffer>;
}

export const OFFICE_CONVERT_PROVIDER = Symbol('OFFICE_CONVERT_PROVIDER');

/**
 * Default no-op provider. Nothing is convertible; any attempt throws. This is the
 * safe default for environments without a LibreOffice/Gotenberg sidecar.
 */
@Injectable()
export class NoopOfficeConvertProvider implements OfficeConvertProvider {
  isConvertible(): boolean {
    return false;
  }

  async convertToPdf(): Promise<Buffer> {
    throw new Error('Office-to-PDF conversion is not configured in this build');
  }
}
