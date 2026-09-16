import { OnboardingService } from './onboarding.service';

/**
 * Org-onboarding document decisions used to reach the owner by EMAIL ONLY. They
 * now also land in the in-app inbox (which is what FCM pushes in real time).
 */
describe('OnboardingService — owner notifications', () => {
  let requests: any, orgs: any, users: any, templates: any, mail: any, config: any, notifier: any;
  let service: OnboardingService;

  const org = { id: 'orgA', name: 'Acme', ownerId: 'owner1', status: 'active' };
  const doc = (over: Record<string, unknown> = {}) => ({
    id: 'req1', organizationId: 'orgA', title: 'PAN card', status: 'submitted',
    isDeleted: false, requiresUpload: true, approval: null, ...over,
  });

  beforeEach(() => {
    requests = {
      findOne: jest.fn().mockResolvedValue(doc()),
      find: jest.fn().mockResolvedValue([doc({ status: 'approved' }), doc({ id: 'req2', status: 'pending' })]),
      save: jest.fn((v) => Promise.resolve(v)),
    };
    orgs = { findOne: jest.fn().mockResolvedValue(org), save: jest.fn((v) => Promise.resolve(v)) };
    users = { findOne: jest.fn().mockResolvedValue({ id: 'owner1', email: 'owner@acme.test' }) };
    templates = { list: jest.fn().mockResolvedValue([]) };
    mail = { send: jest.fn().mockResolvedValue(true) };
    config = { get: jest.fn(() => 'https://app.nugenova.com') };
    notifier = { notify: jest.fn().mockResolvedValue(undefined) };
    service = new OnboardingService(requests, orgs, users, templates, mail, notifier, config);
  });

  it('approving a document emails the owner AND files an in-app notification', async () => {
    await service.approveDocument('req1', 'admin1');
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'orgA', userId: 'owner1', type: 'onboarding_document_verified',
      title: 'Document approved: PAN card', data: { actionUrl: '/onboarding' }, email: false,
    }));
  });

  it('rejecting a document notifies the owner in-app with the reason', async () => {
    await service.rejectDocument('req1', 'admin1', 'Blurred scan');
    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({
      type: 'onboarding_document_rejected', title: 'Document rejected: PAN card', body: 'Blurred scan',
    }));
  });

  it('skips the in-app copy when the org has no owner (nobody to notify)', async () => {
    orgs.findOne.mockResolvedValue({ ...org, ownerId: null });
    users.findOne.mockResolvedValue(null);
    await service.rejectDocument('req1', 'admin1', 'Blurred scan');
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('a failing notification never breaks the decision', async () => {
    notifier.notify.mockRejectedValue(new Error('inbox down'));
    await expect(service.rejectDocument('req1', 'admin1', 'Blurred scan')).resolves.toBeDefined();
  });
});
