import { NotFoundException } from '@nestjs/common';

import { AiConversationEntity } from '../entities/ai-conversation.entity';
import { AiMessageEntity } from '../entities/ai-message.entity';
import { AiJobEntity } from '../entities/ai-job.entity';
import { AiChatService } from './ai-chat.service';
import { AiJobWorker } from './ai-job.service';
import { FakeRepo } from './test-fake-repo';

/**
 * Unit specs for AiChatService — the async, RAG-grounded chatbot flow. Repos are
 * in-memory fakes; AiJobService, AiService and KnowledgeRetrievalService are
 * stubs (NO network, NO real DB). Pins: send creates a pending assistant + a
 * queued job and returns WITHOUT awaiting the LLM; the worker moves
 * pending→done and writes sources (grounded + fallback); the error path sets
 * status='error'; and org/user isolation holds.
 */
describe('AiChatService', () => {
  let conversations: FakeRepo<AiConversationEntity>;
  let messages: FakeRepo<AiMessageEntity>;
  let submit: jest.Mock;
  let complete: jest.Mock;
  let search: jest.Mock;
  let service: AiChatService;
  let worker: AiJobWorker;

  const orgA = 'orgA';
  const u1 = 'user1';

  beforeEach(() => {
    conversations = new FakeRepo<AiConversationEntity>();
    messages = new FakeRepo<AiMessageEntity>();

    let jobSeq = 0;
    submit = jest.fn(async (p: any) => ({ id: `job${++jobSeq}`, status: 'queued', ...p }));
    const registerWorker = jest.fn();
    const jobs = { submit, registerWorker };

    complete = jest.fn().mockResolvedValue({
      text: 'the grounded answer',
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const ai = { complete };

    search = jest.fn().mockResolvedValue([
      { sourceId: 's1', sourceName: 'Handbook', chunkIndex: 0, content: 'policy text', rank: 0.9 },
    ]);
    const retrieval = { search };

    service = new AiChatService(
      conversations as any,
      messages as any,
      jobs as any,
      ai as any,
      retrieval as any,
    );
    service.onModuleInit();
    worker = registerWorker.mock.calls[0][1]; // the 'chat' worker callback
  });

  /** Run the registered worker with a job built from the last submit() input. */
  const runWorker = async () => {
    const input = submit.mock.calls[submit.mock.calls.length - 1][0].input;
    const job = { id: 'job1', organizationId: orgA, userId: u1, kind: 'chat', input } as AiJobEntity;
    return worker(job);
  };

  it('registers the chat worker on init', () => {
    expect(typeof worker).toBe('function');
  });

  it('sendMessage persists the user turn, a PENDING assistant + a job, and returns without calling the LLM', async () => {
    const conv = await service.createConversation(orgA, u1);
    const res = await service.sendMessage(orgA, u1, conv.id, 'what is the leave policy?');

    // user turn complete
    expect(res.userMessage.role).toBe('user');
    expect(res.userMessage.content).toBe('what is the leave policy?');
    // assistant turn is a pending placeholder with a jobId, empty content
    expect(res.assistantMessage.status).toBe('pending');
    expect(res.assistantMessage.content).toBe('');
    expect(res.assistantMessage.sources).toEqual([]);
    expect(res.assistantMessage.jobId).toBeTruthy();
    // a job was submitted; the LLM was NOT awaited in the request
    expect(submit).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();

    // auto-title derived from the first user message
    const reloaded = await conversations.findOne({ where: { id: conv.id } });
    expect(reloaded?.title).toBe('what is the leave policy?');
    expect(reloaded?.lastMessageAt).toBeInstanceOf(Date);
  });

  it('the worker retrieves context, grounds the answer, and moves the assistant pending→done with sources', async () => {
    const conv = await service.createConversation(orgA, u1);
    const res = await service.sendMessage(orgA, u1, conv.id, 'leave policy?');

    await runWorker();

    expect(search).toHaveBeenCalledWith(orgA, 'leave policy?', expect.any(Number));
    expect(complete).toHaveBeenCalledTimes(1);
    // the completion was tagged feature 'chatbot'
    expect(complete.mock.calls[0][1]).toEqual(expect.objectContaining({ feature: 'chatbot' }));

    const msg = await service.getMessage(orgA, u1, res.assistantMessage.id);
    expect(msg.status).toBe('done');
    expect(msg.content).toBe('the grounded answer');
    expect(msg.grounded).toBe(true);
    expect(msg.sources).toEqual([{ sourceId: 's1', sourceName: 'Handbook', chunkIndex: 0 }]);
  });

  it('grounded-with-fallback: no chunks → grounded=false, empty sources, still done', async () => {
    search.mockResolvedValueOnce([]);
    const conv = await service.createConversation(orgA, u1);
    const res = await service.sendMessage(orgA, u1, conv.id, 'unknown topic');

    await runWorker();

    const msg = await service.getMessage(orgA, u1, res.assistantMessage.id);
    expect(msg.status).toBe('done');
    expect(msg.grounded).toBe(false);
    expect(msg.sources).toEqual([]);
  });

  it('feeds prior conversation turns back as multi-turn history', async () => {
    const conv = await service.createConversation(orgA, u1);
    const first = await service.sendMessage(orgA, u1, conv.id, 'first question');
    await runWorker();
    // second turn — history should now include the first Q and its answer
    await service.sendMessage(orgA, u1, conv.id, 'follow up');
    await runWorker();

    const lastCallMessages = complete.mock.calls[1][0] as Array<{ role: string; content: string }>;
    const roles = lastCallMessages.map((m) => m.role);
    expect(roles[0]).toBe('system');
    // user/assistant/user history present after the system block
    expect(lastCallMessages.some((m) => m.content === 'first question')).toBe(true);
    expect(lastCallMessages.some((m) => m.content === 'the grounded answer')).toBe(true);
    expect(lastCallMessages[lastCallMessages.length - 1].content).toBe('follow up');
    void first;
  });

  it('error path: a failing LLM call flips the assistant message to status=error and rethrows', async () => {
    complete.mockRejectedValueOnce(new Error('runpod down'));
    const conv = await service.createConversation(orgA, u1);
    const res = await service.sendMessage(orgA, u1, conv.id, 'boom');

    await expect(runWorker()).rejects.toThrow(); // rethrown so the job row is errored too

    const msg = await service.getMessage(orgA, u1, res.assistantMessage.id);
    expect(msg.status).toBe('error');
    expect(msg.content).toBe('');
  });

  // ── isolation ───────────────────────────────────────────────────────────────

  it('a user cannot read another user\'s conversation (cross-user isolation)', async () => {
    const conv = await service.createConversation(orgA, u1);
    await expect(service.getConversation(orgA, 'user2', conv.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('a user cannot read a conversation from another org (cross-org isolation)', async () => {
    const conv = await service.createConversation(orgA, u1);
    await expect(service.getConversation('orgB', u1, conv.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('a user cannot poll a message belonging to another user', async () => {
    const conv = await service.createConversation(orgA, u1);
    const res = await service.sendMessage(orgA, u1, conv.id, 'hi');
    await expect(service.getMessage(orgA, 'user2', res.assistantMessage.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('listConversations returns only the caller\'s own threads', async () => {
    await service.createConversation(orgA, u1, 'mine');
    await service.createConversation(orgA, 'user2', 'theirs');
    const list = await service.listConversations(orgA, u1);
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('mine');
  });

  it('deleteConversation removes the thread and its messages', async () => {
    const conv = await service.createConversation(orgA, u1);
    await service.sendMessage(orgA, u1, conv.id, 'hi');
    const out = await service.deleteConversation(orgA, u1, conv.id);
    expect(out).toEqual({ deleted: true });
    expect(await conversations.findOne({ where: { id: conv.id } })).toBeNull();
    expect((await messages.find({ where: { conversationId: conv.id } })).length).toBe(0);
  });
});
