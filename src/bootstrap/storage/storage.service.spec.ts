import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

import { StorageService } from './storage.service';
import { StorageController } from './storage.controller';
import { DocumentFileEntity } from './document-file.entity';

/**
 * Security-invariant guard: confidential files must be served ONLY through the
 * authenticated byte-proxy. A presigned S3 URL is auth-free and copy-pasteable
 * from the Network tab, so StorageService must expose no way to mint one, and the
 * download endpoint must send raw bytes under `Cache-Control: private, no-store`
 * — never a shareable/presigned link in the response body.
 */
describe('StorageService confidential-serving invariant', () => {
  const build = async () => {
    const repo = {
      findOne: jest.fn(),
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn(async (v) => ({ id: 'f1', createdAt: new Date(), ...v })),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [StorageController],
      providers: [
        StorageService,
        { provide: ConfigService, useValue: { get: () => '' } },
        { provide: getRepositoryToken(DocumentFileEntity), useValue: repo },
      ],
    })
      // Controller pulls JwtAuthGuard (JwtService/TokenRevocation) — bypass for unit.
      .overrideGuard(require('../../modules/auth/guards/jwt-auth.guard').JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    return {
      service: moduleRef.get(StorageService),
      controller: moduleRef.get(StorageController),
    };
  };

  it('exposes no presigned-URL method (no auth-free shareable link can be minted)', async () => {
    const { service } = await build();
    // Nothing on the service should generate a presigned / signed / external URL.
    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(service)),
      ...Object.keys(service as any),
    ];
    const offenders = surface.filter((k) =>
      /presign|signedurl|getsignedurl/i.test(k),
    );
    expect(offenders).toEqual([]);
    expect((service as any).getPresignedUrl).toBeUndefined();
  });

  it('download streams raw bytes under Cache-Control: private, no-store (never a presigned URL)', async () => {
    const { service, controller } = await build();

    const file = {
      id: 'f1',
      organizationId: 'org1',
      uploadedBy: 'u1',
      originalName: 'payslip.pdf',
      mimeType: 'application/pdf',
      size: 3,
      driver: 'db',
      storageKey: null,
      content: Buffer.from('PDF'),
      isDeleted: false,
    } as unknown as DocumentFileEntity;

    jest.spyOn(service, 'getMeta').mockResolvedValue(file);

    const headers: Record<string, string> = {};
    let sent: Buffer | undefined;
    const res: any = {
      setHeader: (k: string, v: string) => (headers[k] = v),
      send: (b: Buffer) => (sent = b),
    };
    const req: any = { user: { userId: 'u1', organizationId: 'org1' } };

    await controller.download('f1', req, res);

    // Bytes, not a link.
    expect(Buffer.isBuffer(sent)).toBe(true);
    expect(sent!.toString()).toBe('PDF');

    // Confidential-safe headers.
    expect(headers['Cache-Control']).toBe('private, no-store');
    expect(headers['Content-Type']).toBe('application/pdf');
    expect(headers['Content-Disposition']).toContain('inline');

    // The response body carries no presigned/S3 URL.
    const bodyAsText = sent!.toString();
    expect(bodyAsText).not.toMatch(/https?:\/\/[^\s"]*(s3|X-Amz-Signature|Expires=)/i);
  });
});
