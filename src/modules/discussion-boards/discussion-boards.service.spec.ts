import { DiscussionBoardsService } from './discussion-boards.service';

/** Chainable query-builder stub whose getRawMany resolves to `rows`. */
function qbReturning(rows: any[]) {
  const qb: any = {};
  for (const m of ['select', 'addSelect', 'where', 'groupBy']) qb[m] = jest.fn(() => qb);
  qb.getRawMany = jest.fn(async () => rows);
  return qb;
}

describe('DiscussionBoardsService', () => {
  let boardsRepo: { find: jest.Mock; findOne: jest.Mock };
  let notesRepo: { find: jest.Mock; findOne: jest.Mock; save: jest.Mock; createQueryBuilder: jest.Mock };
  let nodesRepo: { find: jest.Mock };
  let commentsRepo: { find: jest.Mock };
  let storage: { save: jest.Mock; getMeta: jest.Mock; getBytes: jest.Mock };
  let service: DiscussionBoardsService;

  beforeEach(() => {
    boardsRepo = { find: jest.fn(), findOne: jest.fn() };
    notesRepo = { find: jest.fn(), findOne: jest.fn(), save: jest.fn((n) => Promise.resolve(n)), createQueryBuilder: jest.fn() };
    nodesRepo = { find: jest.fn() };
    commentsRepo = { find: jest.fn() };
    storage = { save: jest.fn(), getMeta: jest.fn(), getBytes: jest.fn() };
    service = new DiscussionBoardsService(boardsRepo as any, notesRepo as any, nodesRepo as any, commentsRepo as any, storage as any);
  });

  const admin = { userId: 'admin1', isAdmin: true };
  const member = (userId: string) => ({ userId, isAdmin: false });

  it('listBoards: admins see every board with participant + grouped note counts', async () => {
    boardsRepo.find.mockResolvedValue([
      { id: 'b1', title: 'Retro', description: null, template: 'retro', background: '#fff', isArchived: false, participants: [{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }], updatedAt: new Date('2026-01-02') },
      { id: 'b2', title: 'Empty', description: null, template: 'blank', background: null, isArchived: true, participants: [], updatedAt: new Date('2026-01-01') },
    ]);
    notesRepo.createQueryBuilder.mockReturnValue(qbReturning([{ boardId: 'b1', cnt: '14' }]));

    const out = await service.listBoards('orgA', admin);

    expect(boardsRepo.find).toHaveBeenCalledWith({ where: { organizationId: 'orgA', isDeleted: false }, order: { updatedAt: 'DESC' } });
    expect(out.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(out[0]).toMatchObject({ id: 'b1', participantCount: 3, noteCount: 14 });
    expect(out[1]).toMatchObject({ id: 'b2', participantCount: 0, noteCount: 0, isArchived: true });
  });

  it('listBoards: a member sees ONLY boards they created or participate in', async () => {
    boardsRepo.find.mockResolvedValue([
      { id: 'b1', title: 'Mine (participant)', participants: [{ userId: 'nisha' }], createdBy: 'someoneElse', isArchived: false, updatedAt: new Date() },
      { id: 'b2', title: 'Not mine', participants: [{ userId: 'other' }], createdBy: 'other', isArchived: false, updatedAt: new Date() },
      { id: 'b3', title: 'Mine (creator)', participants: [], createdBy: 'nisha', isArchived: false, updatedAt: new Date() },
    ]);
    notesRepo.createQueryBuilder.mockReturnValue(qbReturning([]));

    const out = await service.listBoards('orgA', member('nisha'));
    expect(out.map((b) => b.id).sort()).toEqual(['b1', 'b3']); // b2 hidden
  });

  it('getBoard: a participant may open the board', async () => {
    boardsRepo.findOne.mockResolvedValue({ id: 'b1', organizationId: 'orgA', participants: [{ userId: 'nisha' }], createdBy: 'x' });
    notesRepo.find.mockResolvedValue([{ id: 'n1' }]);
    nodesRepo.find.mockResolvedValue([]);
    commentsRepo.find.mockResolvedValue([{ id: 'c1', noteId: 'n1' }]);

    const out = await service.getBoard('orgA', 'b1', member('nisha'));
    expect(out.notes).toHaveLength(1);
    expect(notesRepo.find).toHaveBeenCalledWith(expect.objectContaining({ where: { boardId: 'b1', organizationId: 'orgA', isDeleted: false } }));
  });

  it('getBoard: a non-participant member is forbidden (not 404 — the board exists)', async () => {
    boardsRepo.findOne.mockResolvedValue({ id: 'b1', organizationId: 'orgA', participants: [{ userId: 'other' }], createdBy: 'other' });
    await expect(service.getBoard('orgA', 'b1', member('nisha'))).rejects.toThrow('do not have access');
  });

  it('getBoard: an admin may open any board', async () => {
    boardsRepo.findOne.mockResolvedValue({ id: 'b1', organizationId: 'orgA', participants: [{ userId: 'other' }], createdBy: 'other' });
    notesRepo.find.mockResolvedValue([]);
    nodesRepo.find.mockResolvedValue([]);
    commentsRepo.find.mockResolvedValue([]);
    await expect(service.getBoard('orgA', 'b1', admin)).resolves.toBeDefined();
  });

  it('getBoard 404s when the board is not in the org', async () => {
    boardsRepo.findOne.mockResolvedValue(null);
    await expect(service.getBoard('orgA', 'nope', admin)).rejects.toThrow('Board not found');
  });

  describe('updateNote', () => {
    it('a participant edits a note text/title', async () => {
      boardsRepo.findOne.mockResolvedValue({ id: 'b1', organizationId: 'orgA', participants: [{ userId: 'nisha' }], createdBy: 'x' });
      notesRepo.findOne.mockResolvedValue({ id: 'n1', boardId: 'b1', organizationId: 'orgA', text: 'old', title: null });

      const out = await service.updateNote('orgA', member('nisha'), 'b1', 'n1', { text: 'new text', title: 'T' });

      expect(out.text).toBe('new text');
      expect(out.title).toBe('T');
      expect(notesRepo.save).toHaveBeenCalled();
      expect(notesRepo.findOne).toHaveBeenCalledWith({ where: { id: 'n1', boardId: 'b1', organizationId: 'orgA', isDeleted: false } });
    });

    it('a non-participant cannot edit (403)', async () => {
      boardsRepo.findOne.mockResolvedValue({ id: 'b1', organizationId: 'orgA', participants: [{ userId: 'other' }], createdBy: 'other' });
      await expect(service.updateNote('orgA', member('nisha'), 'b1', 'n1', { text: 'x' })).rejects.toThrow('do not have access');
      expect(notesRepo.save).not.toHaveBeenCalled();
    });

    it('404 when the note is not on the board', async () => {
      boardsRepo.findOne.mockResolvedValue({ id: 'b1', organizationId: 'orgA', participants: [], createdBy: 'nisha' });
      notesRepo.findOne.mockResolvedValue(null);
      await expect(service.updateNote('orgA', member('nisha'), 'b1', 'nope', { text: 'x' })).rejects.toThrow('Note not found');
    });
  });

  describe('assets', () => {
    it('uploadAsset stores a board-asset for a participant and returns a stable url', async () => {
      boardsRepo.findOne.mockResolvedValue({ id: 'b1', organizationId: 'orgA', participants: [{ userId: 'nisha' }], createdBy: 'x' });
      storage.save.mockResolvedValue({ id: 'asset1', mimeType: 'image/png' });
      const out = await service.uploadAsset('orgA', member('nisha'), 'b1', { buffer: Buffer.from('x'), originalname: 'a.png', mimetype: 'image/png' });
      expect(out).toEqual({ id: 'asset1', url: '/discussion-boards/assets/asset1', mimeType: 'image/png' });
      expect(storage.save).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'orgA', category: 'board-asset' }));
    });

    it('uploadAsset rejects non-image files', async () => {
      boardsRepo.findOne.mockResolvedValue({ id: 'b1', organizationId: 'orgA', participants: [{ userId: 'nisha' }] });
      await expect(service.uploadAsset('orgA', member('nisha'), 'b1', { buffer: Buffer.from('x'), originalname: 'a.exe', mimetype: 'application/octet-stream' })).rejects.toThrow('image');
    });

    it('getAssetBytes only serves files tagged board-asset (never other documents)', async () => {
      storage.getMeta.mockResolvedValue({ id: 'f1', category: 'onboarding', mimeType: 'application/pdf', originalName: 'secret.pdf' });
      await expect(service.getAssetBytes('f1')).rejects.toThrow('Asset not found');
      storage.getMeta.mockResolvedValue({ id: 'f2', category: 'board-asset', mimeType: 'image/png', originalName: 'x.png' });
      storage.getBytes.mockResolvedValue(Buffer.from('img'));
      await expect(service.getAssetBytes('f2')).resolves.toMatchObject({ mimeType: 'image/png' });
    });
  });
});
