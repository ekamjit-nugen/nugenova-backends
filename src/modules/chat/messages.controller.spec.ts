import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { MessagesController } from './messages.controller';
import { MessagesService } from './services/messages.service';
import { BookmarksService } from './services/bookmarks.service';
import { StorageService } from '../../bootstrap/storage/storage.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

/**
 * Unit specs for the chat attachment endpoints (`POST /chat/upload`,
 * `GET /chat/files/:fileId`) + the send attachment-gate. MessagesService +
 * StorageService are mocked, so no DB/S3 is required — the point is to pin the
 * returned upload shape, that a fileId-only send persists its attachment, and
 * that the file-serve gate 404s a non-participant while a participant is served
 * the bytes streamed through the authenticated endpoint (never a presigned URL).
 */
describe('MessagesController (attachments)', () => {
  let controller: MessagesController;
  let userCanAccessFile: jest.Mock;
  let sendMessage: jest.Mock;
  let save: jest.Mock;
  let getMeta: jest.Mock;
  let openStream: jest.Mock;

  const REQ = { user: { organizationId: 'orgA', userId: 'alice', firstName: 'Al' } };

  const mockRes = () => {
    const res: any = { headersSent: false };
    res.redirect = jest.fn().mockReturnValue(res);
    res.setHeader = jest.fn().mockReturnValue(res);
    res.status = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    res.end = jest.fn().mockReturnValue(res);
    return res;
  };

  beforeEach(async () => {
    userCanAccessFile = jest.fn();
    sendMessage = jest.fn().mockImplementation(async (...args: any[]) => {
      // Mirror the service: echo back the attachment fields + type the controller
      // hands it, so the presented message exposes fileId.
      const fileData = args[7] ?? {};
      return { id: 'msg1', _id: 'msg1', type: args[4], ...fileData };
    });
    save = jest.fn();
    getMeta = jest.fn();
    openStream = jest.fn();

    const moduleRef = await Test.createTestingModule({
      controllers: [MessagesController],
      providers: [
        { provide: MessagesService, useValue: { userCanAccessFile, sendMessage } },
        { provide: BookmarksService, useValue: {} },
        { provide: StorageService, useValue: { save, getMeta, openStream } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = moduleRef.get(MessagesController);
  });

  // ── upload ──────────────────────────────────────────────────────────────────

  it('upload returns the attachment metadata shape', async () => {
    save.mockResolvedValue({
      id: 'file-1',
      originalName: 'report.pdf',
      mimeType: 'application/pdf',
      size: 4242,
      createdAt: new Date(),
    });
    const file = {
      buffer: Buffer.from('hello'),
      originalname: 'report.pdf',
      mimetype: 'application/pdf',
    } as Express.Multer.File;

    const res: any = await controller.upload(file, REQ);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'orgA',
        uploadedBy: 'alice',
        originalName: 'report.pdf',
        mimeType: 'application/pdf',
      }),
    );
    expect(res.data).toEqual({
      fileId: 'file-1',
      fileName: 'report.pdf',
      fileSize: 4242,
      fileMimeType: 'application/pdf',
    });
  });

  it('upload rejects an empty/missing file (400)', async () => {
    await expect(
      controller.upload(undefined as unknown as Express.Multer.File, REQ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.upload({ buffer: Buffer.alloc(0) } as Express.Multer.File, REQ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });

  // ── send attachment-gate ──────────────────────────────────────────────────────

  it('send persists a fileId-only attachment (no fileUrl) and presents fileId', async () => {
    const res: any = await controller.send(
      'conv1',
      {
        type: 'image',
        fileId: 'file-7',
        fileName: 'shot.png',
        fileSize: 999,
        fileMimeType: 'image/png',
        // NB: no fileUrl — the real client never sends one.
      } as any,
      REQ,
    );
    // The controller built fileData off fileId and handed it to the service.
    const fileDataArg = sendMessage.mock.calls[0][7];
    expect(fileDataArg).toMatchObject({
      fileId: 'file-7',
      fileName: 'shot.png',
      fileSize: 999,
      fileMimeType: 'image/png',
    });
    // The presented message exposes fileId + type (what the FE renders on).
    expect(res.data).toMatchObject({ fileId: 'file-7', type: 'image' });
  });

  it('send with no attachment fields passes undefined fileData', async () => {
    await controller.send('conv1', { content: 'hi' } as any, REQ);
    expect(sendMessage.mock.calls[0][7]).toBeUndefined();
  });

  // ── serve (access-checked, streamed) ──────────────────────────────────────────

  it('serve 404s a caller with no access — file existence never leaked', async () => {
    userCanAccessFile.mockResolvedValue(false);
    const res = mockRes();
    await expect(controller.serveFile('file-1', REQ, res)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(userCanAccessFile).toHaveBeenCalledWith('file-1', 'orgA', 'alice');
    // Never touched storage for an unauthorised caller.
    expect(getMeta).not.toHaveBeenCalled();
    expect(openStream).not.toHaveBeenCalled();
  });

  // A stream whose pipe/on are mocked, so nothing actually flows into the fake res.
  const fakeStream = () => ({ on: jest.fn(), pipe: jest.fn() });

  it('serve streams the bytes inline for a viewable, never a redirect/URL', async () => {
    userCanAccessFile.mockResolvedValue(true);
    getMeta.mockResolvedValue({ id: 'file-1' });
    const stream = fakeStream();
    openStream.mockResolvedValue({
      stream,
      mimeType: 'image/png',
      filename: 'a b.png',
      size: 7,
    });
    const res = mockRes();

    await controller.serveFile('file-1', REQ, res);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'inline; filename="a_b.png"',
    );
    expect(res.setHeader).toHaveBeenCalledWith('Content-Length', '7');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(stream.pipe).toHaveBeenCalledWith(res);
    // Never a presigned/redirect path.
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('serve forces attachment disposition for a non-viewable type', async () => {
    userCanAccessFile.mockResolvedValue(true);
    getMeta.mockResolvedValue({ id: 'file-2' });
    const stream = fakeStream();
    openStream.mockResolvedValue({
      stream,
      mimeType: 'application/zip',
      filename: 'bundle.zip',
      size: 3,
    });
    const res = mockRes();

    await controller.serveFile('file-2', REQ, res);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="bundle.zip"',
    );
    expect(stream.pipe).toHaveBeenCalledWith(res);
  });
});
