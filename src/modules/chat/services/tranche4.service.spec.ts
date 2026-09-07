import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { MessagesService } from './messages.service';
import { ChatSettingsService } from './chat-settings.service';
import { BookmarksService } from './bookmarks.service';
import { ConversationsService } from './conversations.service';
import { ConversationEntity } from '../entities/conversation.entity';
import { MessageEntity } from '../entities/message.entity';
import { ChatBookmarkEntity } from '../entities/chat-bookmark.entity';
import { NotifierService } from '../../notification/notifier.service';
import { PresenceService } from '../realtime/presence.service';
import { CHAT_MESSAGE_UPDATED } from '../realtime/chat-events';

/**
 * Unit specs for Tranche 4 (pin / forward / bookmark). All repositories are
 * mocked — no DB. The point is to pin the isolation gate + core semantics:
 *   - pin/unpin set/clear the fields, participant-only, and emit updated;
 *   - forward creates a `forwarded` copy ONLY in conversations the caller is a
 *     participant of (a non-participant target is skipped) and copies
 *     `forwardedFrom`;
 *   - bookmark save/unsave is idempotent per (user, message) and the read is
 *     scoped to the caller.
 */
const CONV = (over: Partial<ConversationEntity> = {}): ConversationEntity =>
  ({
    id: 'conv1',
    organizationId: 'orgA',
    type: 'group',
    name: 'Project X',
    isArchived: false,
    isDeleted: false,
    settings: null,
    participants: [{ userId: 'alice', role: 'member' } as any],
    ...over,
  }) as ConversationEntity;

const MSG = (over: Partial<MessageEntity> = {}): MessageEntity =>
  ({
    id: 'msg1',
    conversationId: 'conv1',
    organizationId: 'orgA',
    senderId: 'alice',
    senderName: 'Alice A',
    content: 'hello world',
    contentPlainText: 'hello world',
    type: 'text',
    isDeleted: false,
    isPinned: false,
    pinnedBy: null,
    pinnedAt: null,
    fileUrl: null,
    fileId: null,
    readBy: [],
    mentions: [],
    ...over,
  }) as MessageEntity;

describe('MessagesService — pin / unpin / pinned', () => {
  let service: MessagesService;
  let messageFindOne: jest.Mock;
  let messageFind: jest.Mock;
  let messageSave: jest.Mock;
  let convFindOne: jest.Mock;
  let emit: jest.Mock;

  const build = async () => {
    messageFindOne = jest.fn();
    messageFind = jest.fn();
    messageSave = jest.fn().mockImplementation((m) => m);
    convFindOne = jest.fn();
    emit = jest.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [
        MessagesService,
        {
          provide: ChatSettingsService,
          useValue: {
            load: jest.fn().mockResolvedValue({ allowDeleteOwn: true, adminCanDeleteAny: true }),
            isAdmin: () => false,
          },
        },
        {
          provide: getRepositoryToken(MessageEntity),
          useValue: { findOne: messageFindOne, find: messageFind, save: messageSave, create: (x: any) => x },
        },
        { provide: getRepositoryToken(ConversationEntity), useValue: { findOne: convFindOne } },
        { provide: ConversationsService, useValue: { updateLastMessage: jest.fn() } },
        { provide: NotifierService, useValue: { notify: jest.fn() } },
        { provide: PresenceService, useValue: { isOnline: jest.fn().mockReturnValue(false) } },
        { provide: EventEmitter2, useValue: { emit } },
      ],
    }).compile();
    service = moduleRef.get(MessagesService);
  };

  beforeEach(build);

  it('pin sets isPinned/pinnedBy/pinnedAt and emits chat.message.updated', async () => {
    messageFindOne.mockResolvedValue(MSG());
    convFindOne.mockResolvedValue(CONV());
    const res: any = await service.pinMessage('msg1', 'orgA', 'alice');
    expect(res.isPinned).toBe(true);
    expect(res.pinnedBy).toBe('alice');
    expect(res.pinnedAt).toBeInstanceOf(Date);
    expect(messageSave).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(CHAT_MESSAGE_UPDATED, expect.objectContaining({ conversationId: 'conv1' }));
  });

  it('unpin clears isPinned/pinnedBy/pinnedAt and emits chat.message.updated', async () => {
    messageFindOne.mockResolvedValue(MSG({ isPinned: true, pinnedBy: 'alice', pinnedAt: new Date() }));
    convFindOne.mockResolvedValue(CONV());
    const res: any = await service.unpinMessage('msg1', 'orgA', 'alice');
    expect(res.isPinned).toBe(false);
    expect(res.pinnedBy).toBeNull();
    expect(res.pinnedAt).toBeNull();
    expect(emit).toHaveBeenCalledWith(CHAT_MESSAGE_UPDATED, expect.anything());
  });

  it('pin is participant-only: a non-participant is refused (403)', async () => {
    messageFindOne.mockResolvedValue(MSG());
    convFindOne.mockResolvedValue(CONV({ participants: [{ userId: 'bob' } as any] }));
    await expect(service.pinMessage('msg1', 'orgA', 'alice')).rejects.toBeInstanceOf(ForbiddenException);
    expect(messageSave).not.toHaveBeenCalled();
  });

  it('pin refuses a missing message (404)', async () => {
    messageFindOne.mockResolvedValue(null);
    await expect(service.pinMessage('nope', 'orgA', 'alice')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getPinnedMessages returns pinned rows newest-first (participant-only)', async () => {
    convFindOne.mockResolvedValue(CONV());
    messageFind.mockResolvedValue([MSG({ id: 'p2', isPinned: true }), MSG({ id: 'p1', isPinned: true })]);
    const res: any = await service.getPinnedMessages('conv1', 'orgA', 'alice');
    expect(res.map((m: any) => m.id)).toEqual(['p2', 'p1']);
    expect(messageFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationId: 'conv1', isPinned: true, isDeleted: false },
        order: { pinnedAt: 'DESC' },
      }),
    );
  });
});

describe('MessagesService — forward', () => {
  let service: MessagesService;
  let messageFindOne: jest.Mock;
  let messageSave: jest.Mock;
  let convFindOne: jest.Mock;
  let updateLastMessage: jest.Mock;

  const build = async () => {
    // idempotency findOne (by key) returns null; the ORIGINAL lookup is the first
    // call. We disambiguate by argument shape in the mock below.
    messageSave = jest.fn().mockImplementation((m) => ({ ...m, id: 'newmsg' }));
    convFindOne = jest.fn();
    updateLastMessage = jest.fn();

    messageFindOne = jest.fn().mockImplementation((opts: any) => {
      // The original-message lookup carries { id: 'msg1', isDeleted: false }.
      if (opts?.where?.id === 'msg1') {
        return Promise.resolve(MSG({ content: 'forward me', contentPlainText: 'forward me' }));
      }
      // Idempotency-key lookups → no duplicate.
      return Promise.resolve(null);
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        MessagesService,
        {
          provide: ChatSettingsService,
          useValue: {
            load: jest.fn().mockResolvedValue({ allowDeleteOwn: true, adminCanDeleteAny: true }),
            isAdmin: () => false,
          },
        },
        {
          provide: getRepositoryToken(MessageEntity),
          useValue: { findOne: messageFindOne, find: jest.fn(), save: messageSave, create: (x: any) => x },
        },
        { provide: getRepositoryToken(ConversationEntity), useValue: { findOne: convFindOne } },
        { provide: ConversationsService, useValue: { updateLastMessage } },
        { provide: NotifierService, useValue: { notify: jest.fn() } },
        { provide: PresenceService, useValue: { isOnline: jest.fn().mockReturnValue(false) } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(MessagesService);
  };

  beforeEach(build);

  it('creates a forwarded copy only in conversations the caller belongs to; skips a non-participant target', async () => {
    // source conv (conv1) + target convT: caller participates. convX: caller NOT a participant.
    convFindOne.mockImplementation((opts: any) => {
      const id = opts?.where?.id;
      if (id === 'conv1') return Promise.resolve(CONV({ id: 'conv1' }));
      if (id === 'convT') return Promise.resolve(CONV({ id: 'convT' }));
      if (id === 'convX') return Promise.resolve(CONV({ id: 'convX', participants: [{ userId: 'bob' } as any] }));
      return Promise.resolve(null);
    });

    const res: any = await service.forwardMessage('msg1', 'orgA', 'alice', ['convT', 'convX'], 'Alice A');

    // Only the participant target got a message.
    expect(res).toHaveLength(1);
    expect(messageSave).toHaveBeenCalledTimes(1);
    const saved = messageSave.mock.calls[0][0];
    expect(saved.conversationId).toBe('convT');
    expect(saved.type).toBe('forwarded');
    expect(saved.content).toBe('forward me');
    expect(saved.forwardedFrom).toMatchObject({
      messageId: 'msg1',
      conversationId: 'conv1',
      senderId: 'alice',
      content: 'forward me',
    });
  });

  it('refuses forwarding a message the caller cannot see in the source (403)', async () => {
    convFindOne.mockImplementation((opts: any) => {
      if (opts?.where?.id === 'conv1') return Promise.resolve(CONV({ participants: [{ userId: 'bob' } as any] }));
      return Promise.resolve(null);
    });
    await expect(
      service.forwardMessage('msg1', 'orgA', 'alice', ['convT'], 'Alice A'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(messageSave).not.toHaveBeenCalled();
  });

  it('refuses forwarding a missing message (404)', async () => {
    messageFindOne.mockResolvedValue(null);
    await expect(
      service.forwardMessage('gone', 'orgA', 'alice', ['convT'], 'Alice A'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('BookmarksService — save / unsave / list', () => {
  let service: BookmarksService;
  let bookmarkFindOne: jest.Mock;
  let bookmarkSave: jest.Mock;
  let bookmarkFind: jest.Mock;
  let bookmarkDelete: jest.Mock;
  let messageFindOne: jest.Mock;
  let messageFind: jest.Mock;
  let convFind: jest.Mock;
  let requireMember: jest.Mock;

  const build = async () => {
    bookmarkFindOne = jest.fn();
    bookmarkSave = jest.fn().mockImplementation((b) => ({ ...b, id: 'bm1' }));
    bookmarkFind = jest.fn();
    bookmarkDelete = jest.fn().mockResolvedValue({ affected: 1 });
    messageFindOne = jest.fn();
    messageFind = jest.fn();
    convFind = jest.fn();
    requireMember = jest.fn().mockResolvedValue(CONV());

    const moduleRef = await Test.createTestingModule({
      providers: [
        BookmarksService,
        {
          provide: getRepositoryToken(ChatBookmarkEntity),
          useValue: { findOne: bookmarkFindOne, save: bookmarkSave, find: bookmarkFind, delete: bookmarkDelete, create: (x: any) => x },
        },
        { provide: getRepositoryToken(MessageEntity), useValue: { findOne: messageFindOne, find: messageFind } },
        { provide: getRepositoryToken(ConversationEntity), useValue: { find: convFind } },
        { provide: MessagesService, useValue: { requireConversationMember: requireMember } },
      ],
    }).compile();
    service = moduleRef.get(BookmarksService);
  };

  beforeEach(build);

  it('save creates a bookmark scoped to the caller org+user and the message conversation', async () => {
    messageFindOne.mockResolvedValue(MSG());
    bookmarkFindOne.mockResolvedValue(null);
    const res: any = await service.saveBookmark('orgA', 'alice', 'msg1');
    expect(requireMember).toHaveBeenCalledWith('conv1', 'orgA', 'alice');
    expect(res.id).toBe('bm1');
    const saved = bookmarkSave.mock.calls[0][0];
    expect(saved).toMatchObject({ organizationId: 'orgA', userId: 'alice', messageId: 'msg1', conversationId: 'conv1' });
  });

  it('save is idempotent per (user, message): a repeat returns the existing row without a second write', async () => {
    messageFindOne.mockResolvedValue(MSG());
    bookmarkFindOne.mockResolvedValue({ id: 'bmExisting', userId: 'alice', messageId: 'msg1' });
    const res: any = await service.saveBookmark('orgA', 'alice', 'msg1');
    expect(res.id).toBe('bmExisting');
    expect(bookmarkSave).not.toHaveBeenCalled();
  });

  it('save refuses a non-participant (403 from the gate)', async () => {
    messageFindOne.mockResolvedValue(MSG());
    requireMember.mockRejectedValue(new ForbiddenException());
    await expect(service.saveBookmark('orgA', 'alice', 'msg1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(bookmarkSave).not.toHaveBeenCalled();
  });

  it('save refuses a missing message (404)', async () => {
    messageFindOne.mockResolvedValue(null);
    await expect(service.saveBookmark('orgA', 'alice', 'gone')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('unsave is idempotent — deletes scoped to org+user+message and returns success', async () => {
    const res: any = await service.removeBookmark('orgA', 'alice', 'msg1');
    expect(bookmarkDelete).toHaveBeenCalledWith({ organizationId: 'orgA', userId: 'alice', messageId: 'msg1' });
    expect(res.message).toContain('removed');
  });

  it('getBookmarks is scoped to the caller and enriched with message + conversation label', async () => {
    bookmarkFind.mockResolvedValue([
      { id: 'bm1', userId: 'alice', organizationId: 'orgA', messageId: 'msg1', conversationId: 'conv1' },
    ]);
    messageFind.mockResolvedValue([MSG()]);
    convFind.mockResolvedValue([CONV()]);
    const res: any = await service.getBookmarks('orgA', 'alice');
    expect(bookmarkFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'alice', organizationId: 'orgA' }, order: { createdAt: 'DESC' } }),
    );
    expect(res).toHaveLength(1);
    expect(res[0].message.id).toBe('msg1');
    expect(res[0].conversation).toMatchObject({ id: 'conv1', name: 'Project X' });
    expect(res[0].conversationLabel).toBe('Project X');
  });

  it('getBookmarks returns [] when the caller has none', async () => {
    bookmarkFind.mockResolvedValue([]);
    const res: any = await service.getBookmarks('orgA', 'alice');
    expect(res).toEqual([]);
    expect(messageFind).not.toHaveBeenCalled();
  });
});
