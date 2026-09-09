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
  let notesRepo: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let nodesRepo: { find: jest.Mock };
  let commentsRepo: { find: jest.Mock };
  let service: DiscussionBoardsService;

  beforeEach(() => {
    boardsRepo = { find: jest.fn(), findOne: jest.fn() };
    notesRepo = { find: jest.fn(), createQueryBuilder: jest.fn() };
    nodesRepo = { find: jest.fn() };
    commentsRepo = { find: jest.fn() };
    service = new DiscussionBoardsService(boardsRepo as any, notesRepo as any, nodesRepo as any, commentsRepo as any);
  });

  it('listBoards returns summaries with participant + grouped note counts', async () => {
    boardsRepo.find.mockResolvedValue([
      { id: 'b1', title: 'Retro', description: null, template: 'retro', background: '#fff', isArchived: false, participants: [{}, {}, {}], updatedAt: new Date('2026-01-02') },
      { id: 'b2', title: 'Empty', description: null, template: 'blank', background: null, isArchived: true, participants: [], updatedAt: new Date('2026-01-01') },
    ]);
    notesRepo.createQueryBuilder.mockReturnValue(qbReturning([{ boardId: 'b1', cnt: '14' }]));

    const out = await service.listBoards('orgA');

    expect(boardsRepo.find).toHaveBeenCalledWith({ where: { organizationId: 'orgA', isDeleted: false }, order: { updatedAt: 'DESC' } });
    expect(out[0]).toMatchObject({ id: 'b1', participantCount: 3, noteCount: 14 });
    expect(out[1]).toMatchObject({ id: 'b2', participantCount: 0, noteCount: 0, isArchived: true }); // no notes → 0
  });

  it('getBoard returns the board with its notes, nodes and comments (org-scoped)', async () => {
    boardsRepo.findOne.mockResolvedValue({ id: 'b1', title: 'Retro', organizationId: 'orgA' });
    notesRepo.find.mockResolvedValue([{ id: 'n1' }]);
    nodesRepo.find.mockResolvedValue([]);
    commentsRepo.find.mockResolvedValue([{ id: 'c1', noteId: 'n1' }]);

    const out = await service.getBoard('orgA', 'b1');

    expect(boardsRepo.findOne).toHaveBeenCalledWith({ where: { id: 'b1', organizationId: 'orgA', isDeleted: false } });
    expect(out.notes).toHaveLength(1);
    expect(out.comments).toHaveLength(1);
    expect(notesRepo.find).toHaveBeenCalledWith(expect.objectContaining({ where: { boardId: 'b1', organizationId: 'orgA', isDeleted: false } }));
  });

  it('getBoard 404s when the board is not in the org', async () => {
    boardsRepo.findOne.mockResolvedValue(null);
    await expect(service.getBoard('orgA', 'nope')).rejects.toThrow('Board not found');
  });
});
