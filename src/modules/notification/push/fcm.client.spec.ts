import { generateKeyPairSync, createPublicKey, createVerify } from 'crypto';
import { FcmClient } from './fcm.client';

describe('FcmClient (HTTP v1, no firebase-admin)', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const env = (over: Record<string, string | undefined> = {}) => ({
    get: (k: string) => ({ FCM_PROJECT_ID: 'nugenova-test', FCM_CLIENT_EMAIL: 'push@nugenova-test.iam.gserviceaccount.com', FCM_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'), ...over } as Record<string, string | undefined>)[k],
  });
  const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  let fetchMock: jest.Mock;

  beforeEach(() => { fetchMock = jest.fn(); (global as any).fetch = fetchMock; });

  it('is not configured without a complete service account (e.g. a truncated key)', () => {
    expect(new FcmClient(env({ FCM_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nMIIEv' }) as any).isConfigured()).toBe(false);
    expect(new FcmClient(env({ FCM_CLIENT_EMAIL: undefined }) as any).isConfigured()).toBe(false);
    expect(new FcmClient(env() as any).isConfigured()).toBe(true);
  });

  it('signs a service-account JWT, caches the access token, and sends a data-only webpush message', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { access_token: 'ya29.test', expires_in: 3600 }))
      .mockResolvedValue(json(200, { name: 'projects/nugenova-test/messages/1' }));
    const fcm = new FcmClient(env() as any);

    expect(await fcm.send('tok-1', { kind: 'notification', title: 'Hi' })).toBe('ok');
    expect(await fcm.send('tok-2', { kind: 'notification' })).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(3); // one auth + two sends (token cached)

    const [authUrl, authInit] = fetchMock.mock.calls[0];
    expect(authUrl).toBe('https://oauth2.googleapis.com/token');
    const assertion = new URLSearchParams(authInit.body.toString()).get('assertion')!;
    const [h, p, sig] = assertion.split('.');
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toMatchObject({ iss: 'push@nugenova-test.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token' });
    const valid = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(createPublicKey(privateKey), Buffer.from(sig, 'base64url'));
    expect(valid).toBe(true);

    const [sendUrl, sendInit] = fetchMock.mock.calls[1];
    expect(sendUrl).toBe('https://fcm.googleapis.com/v1/projects/nugenova-test/messages:send');
    expect(sendInit.headers.Authorization).toBe('Bearer ya29.test');
    const msg = JSON.parse(sendInit.body).message;
    expect(msg).toMatchObject({ token: 'tok-1', data: { kind: 'notification', title: 'Hi' }, webpush: { headers: { Urgency: 'high' } } });
    expect(msg.notification).toBeUndefined(); // data-only: the service worker decides how to show it
  });

  it('classifies unregistered / invalid tokens so they can be dropped', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { access_token: 't', expires_in: 3600 }));
    const fcm = new FcmClient(env() as any);
    fetchMock.mockResolvedValueOnce(json(404, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }));
    expect(await fcm.send('dead', {})).toBe('invalid');
    fetchMock.mockResolvedValueOnce(json(400, { error: { status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token' } }));
    expect(await fcm.send('garbage', {})).toBe('invalid');
    fetchMock.mockResolvedValueOnce(json(503, { error: { status: 'UNAVAILABLE', message: 'try later' } }));
    expect(await fcm.send('ok-but-busy', {})).toBe('error');
  });

  it('never throws when auth fails', async () => {
    fetchMock.mockResolvedValueOnce(json(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }));
    expect(await new FcmClient(env() as any).send('tok', {})).toBe('error');
  });
});
