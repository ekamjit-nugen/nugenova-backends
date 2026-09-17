import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CandidateFilesService, isWordDocument } from './candidate-files.service';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function build(file: Record<string, unknown>, bytes: Buffer) {
  const storage = { getMeta: jest.fn().mockResolvedValue(file), getBytes: jest.fn().mockResolvedValue(bytes) };
  const svc = new CandidateFilesService(storage as any, {} as any);
  return { svc, storage };
}

describe('CandidateFilesService', () => {
  it('only returns files of the caller’s organization', async () => {
    const { svc } = build({ id: 'f1', organizationId: 'org2', originalName: 'cv.pdf', mimeType: 'application/pdf' }, Buffer.from(''));
    await expect(svc.requireOrgFile('org1', 'f1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.requireOrgFile('org2', 'f1')).resolves.toMatchObject({ id: 'f1' });
  });

  it('renders a Word CV as HTML for viewing', async () => {
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'features', 'fixtures', 'nugenova-sample-cv.docx'));
    const file = { id: 'f1', organizationId: 'org1', originalName: 'cv.docx', mimeType: DOCX, size: bytes.length };
    const { svc } = build(file, bytes);
    const html = await svc.previewHtml(file as any);
    expect(html).toContain('Aarav Sharma');
    expect(html).not.toMatch(/<script/i);
  });

  it('refuses to convert anything that is not a Word document', async () => {
    const file = { id: 'f1', organizationId: 'org1', originalName: 'cv.pdf', mimeType: 'application/pdf' };
    const { svc, storage } = build(file, Buffer.from('%PDF'));
    await expect(svc.previewHtml(file as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.getBytes).not.toHaveBeenCalled();
  });

  it('reports a broken Word file as a friendly error', async () => {
    const file = { id: 'f1', organizationId: 'org1', originalName: 'broken.docx', mimeType: DOCX };
    const { svc } = build(file, Buffer.from('not a zip'));
    await expect(svc.previewHtml(file as any)).rejects.toThrow(/could not be previewed/);
  });

  it('recognises Word files by extension or mime type', () => {
    expect(isWordDocument({ originalName: 'a.DOCX', mimeType: '' })).toBe(true);
    expect(isWordDocument({ originalName: 'a', mimeType: DOCX })).toBe(true);
    expect(isWordDocument({ originalName: 'a.pdf', mimeType: 'application/pdf' })).toBe(false);
  });
});
