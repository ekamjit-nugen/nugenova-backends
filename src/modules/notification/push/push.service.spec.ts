import { PushService } from './push.service';

describe('PushService', () => {
  let repo: any; let fcm: any; let cfg: Record<string, string | undefined>; let service: PushService;

  beforeEach(() => {
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn((v) => Promise.resolve(v)),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    fcm = { isConfigured: jest.fn().mockReturnValue(true), projectId: 'nugenova-de742', send: jest.fn().mockResolvedValue('ok') };
    cfg = { FCM_WEB_API_KEY: 'AIza-test', FCM_WEB_APP_ID: '1:123:web:abc', FCM_MESSAGING_SENDER_ID: '123', VAPID_PUBLIC_KEY: 'BPub' };
    service = new PushService(repo, fcm, { get: (k: string) => cfg[k] } as any);
  });

  it('webConfig is enabled only with server credentials, the Firebase web config and a Web Push key', () => {
    expect(service.webConfig()).toEqual({
      enabled: true,
      firebase: { apiKey: 'AIza-test', appId: '1:123:web:abc', messagingSenderId: '123', projectId: 'nugenova-de742' },
      vapidKey: 'BPub',
    });
    cfg.VAPID_PUBLIC_KEY = '';
    expect(service.webConfig().enabled).toBe(false);
    cfg.VAPID_PUBLIC_KEY = 'BPub'; fcm.isConfigured.mockReturnValue(false);
    expect(service.webConfig().enabled).toBe(false);
  });

  it('register upserts by token and moves a shared browser to the new user', async () => {
    repo.findOne.mockResolvedValue({ id: 't1', token: 'tok', userId: 'old-user' });
    await service.register('u2', 'org1', ' tok ', 'web', 'Chrome');
    expect(repo.findOne).toHaveBeenCalledWith({ where: { token: 'tok' } });
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 't1', userId: 'u2', organizationId: 'org1', platform: 'web', userAgent: 'Chrome' }));
  });

  it('unregister only removes the caller’s own token', async () => {
    await service.unregister('u1', 'tok');
    expect(repo.delete).toHaveBeenCalledWith({ userId: 'u1', token: 'tok' });
  });

  it('sendToUser stringifies data, sends to every token and deletes dead ones', async () => {
    repo.find.mockResolvedValue([{ id: 'a', token: 'ta' }, { id: 'b', token: 'tb' }]);
    fcm.send.mockImplementation(async (t: string) => (t === 'tb' ? 'invalid' : 'ok'));
    const sent = await service.sendToUser('u1', { kind: 'notification', count: 3, skip: undefined, none: null });
    expect(sent).toBe(1);
    expect(fcm.send).toHaveBeenCalledWith('ta', { kind: 'notification', count: '3' });
    expect(repo.delete).toHaveBeenCalledWith(['b']);
  });

  it('does nothing when FCM is not configured', async () => {
    fcm.isConfigured.mockReturnValue(false);
    expect(await service.sendToUser('u1', { kind: 'x' })).toBe(0);
    expect(repo.find).not.toHaveBeenCalled();
  });
});
