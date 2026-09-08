import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  CreatedOrg,
  OrgTestHarness,
} from '../../organization/features/support/org-harness';
import { DriveFolderEntity } from '../entities/drive-folder.entity';
import { DriveFileEntity } from '../entities/drive-file.entity';
import { DriveShareEntity } from '../entities/drive-share.entity';
import { DriveQuotaEntity } from '../entities/drive-quota.entity';

const feature = loadFeature('./cloud-drive.feature', { loadRelativePath: true });
const API = '/api/v1';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let folders: Repository<DriveFolderEntity>;
  let files: Repository<DriveFileEntity>;
  let shares: Repository<DriveShareEntity>;
  let quotas: Repository<DriveQuotaEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    folders = h.app.get(getRepositoryToken(DriveFolderEntity));
    files = h.app.get(getRepositoryToken(DriveFileEntity));
    shares = h.app.get(getRepositoryToken(DriveShareEntity));
    quotas = h.app.get(getRepositoryToken(DriveQuotaEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await shares.delete({ organizationId: In(ids) }).catch(() => undefined);
      await files.delete({ organizationId: In(ids) }).catch(() => undefined);
      await folders.delete({ organizationId: In(ids) }).catch(() => undefined);
      await quotas.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const grant = (org: CreatedOrg, userId: string) =>
    h
      .api()
      .put(`${API}/storage/access/${userId}`)
      .set(auth(org.ownerToken))
      .send({ enabled: true });

  const makeFolder = (token: string, name: string, parentId?: string) =>
    h
      .api()
      .post(`${API}/storage/folders`)
      .set(auth(token))
      .send({ name, scope: 'team', parentId: parentId ?? null });

  const upload = (
    token: string,
    filename: string,
    contents: string,
    folderId?: string,
  ) => {
    const req = h
      .api()
      .post(`${API}/storage/files`)
      .set(auth(token))
      .field('scope', 'team');
    if (folderId) req.field('folderId', folderId);
    return req.attach('file', Buffer.from(contents), filename);
  };

  // ── scenarios ────────────────────────────────────────────────────

  test('an org owner creates a folder and uploads a file into it', ({
    given,
    when,
    and,
    then,
  }) => {
    let org: CreatedOrg;
    let folderId: string;

    given('an organization with an owner', async () => {
      org = await h.createOrg();
      orgIds.add(org.orgId);
    });
    when('the owner creates a team folder named "Contracts"', async () => {
      const res = await makeFolder(org.ownerToken, 'Contracts');
      expect(res.status).toBeLessThan(300);
      folderId = res.body.id;
      expect(folderId).toBeDefined();
    });
    and('the owner uploads a file "nda.txt" into that folder', async () => {
      const res = await upload(org.ownerToken, 'nda.txt', 'nda body', folderId);
      expect(res.status).toBeLessThan(300);
      expect(res.body.storageFileId).toBeDefined();
    });
    then('the folder lists the uploaded file', async () => {
      const res = await h
        .api()
        .get(`${API}/storage/files?scope=team&folderId=${folderId}`)
        .set(auth(org.ownerToken));
      const names = (res.body.data as any[]).map((f) => f.name);
      expect(names).toContain('nda.txt');
    });
    and('the team overview reports one file and non-zero usage', async () => {
      const res = await h
        .api()
        .get(`${API}/storage/overview`)
        .set(auth(org.ownerToken));
      expect(res.body.team.fileCount).toBeGreaterThanOrEqual(1);
      expect(res.body.team.usedBytes).toBeGreaterThan(0);
    });
  });

  test('a plain member without a grant is denied the drive', ({
    given,
    when,
    then,
  }) => {
    let org: CreatedOrg;
    let member: { userId: string; token: string };
    let status = 0;

    given('an organization with an owner and a member', async () => {
      org = await h.createOrg();
      orgIds.add(org.orgId);
      member = await h.createEmployeeMember(org);
    });
    when('the member lists the team folders', async () => {
      const res = await h
        .api()
        .get(`${API}/storage/folders?scope=team`)
        .set(auth(member.token));
      status = res.status;
    });
    then('the request is denied with CLOUD_DRIVE_NO_ACCESS', () => {
      expect(status).toBe(403);
    });
  });

  test('an admin grants a member access and the member can then use the drive', ({
    given,
    when,
    then,
  }) => {
    let org: CreatedOrg;
    let member: { userId: string; token: string };

    given('an organization with an owner and a member', async () => {
      org = await h.createOrg();
      orgIds.add(org.orgId);
      member = await h.createEmployeeMember(org);
    });
    when('the owner grants the member Cloud Drive access', async () => {
      const res = await grant(org, member.userId);
      expect(res.status).toBeLessThan(300);
    });
    then('the member can list the team folders', async () => {
      const res = await h
        .api()
        .get(`${API}/storage/folders?scope=team`)
        .set(auth(member.token));
      expect(res.status).toBeLessThan(300);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  test('personal drives are isolated between members', ({
    given,
    when,
    then,
  }) => {
    let org: CreatedOrg;
    let a: { userId: string; token: string };
    let b: { userId: string; token: string };

    given('an organization with two granted members', async () => {
      org = await h.createOrg();
      orgIds.add(org.orgId);
      a = await h.createEmployeeMember(org);
      b = await h.createEmployeeMember(org);
      await grant(org, a.userId);
      await grant(org, b.userId);
    });
    when('the first member creates a personal folder named "Private"', async () => {
      const res = await h
        .api()
        .post(`${API}/storage/folders`)
        .set(auth(a.token))
        .send({ name: 'Private', scope: 'personal' });
      expect(res.status).toBeLessThan(300);
    });
    then('the second member does not see it in their personal folders', async () => {
      const res = await h
        .api()
        .get(`${API}/storage/folders?scope=personal`)
        .set(auth(b.token));
      const names = (res.body as any[]).map((f) => f.name);
      expect(names).not.toContain('Private');
    });
  });

  test('an uploaded file streams back its bytes through the authenticated proxy', ({
    given,
    when,
    then,
  }) => {
    let org: CreatedOrg;
    let fileId: string;

    given('an organization with an owner', async () => {
      org = await h.createOrg();
      orgIds.add(org.orgId);
    });
    when('the owner uploads a file "hello.txt" with contents "hello drive"', async () => {
      const res = await upload(org.ownerToken, 'hello.txt', 'hello drive');
      fileId = res.body.id;
      expect(fileId).toBeDefined();
    });
    then('downloading that file\'s raw bytes returns "hello drive"', async () => {
      const res = await h
        .api()
        .get(`${API}/storage/files/${fileId}/raw`)
        .set(auth(org.ownerToken));
      expect(res.status).toBe(200);
      expect(res.text || res.body.toString()).toContain('hello drive');
    });
  });

  test('an external share link exposes a file without a login', ({
    given,
    when,
    and,
    then,
  }) => {
    let org: CreatedOrg;
    let fileId: string;
    let token: string;

    given('an organization with an owner', async () => {
      org = await h.createOrg();
      orgIds.add(org.orgId);
    });
    when('the owner uploads a file "public.txt" and creates a download share for it', async () => {
      const up = await upload(org.ownerToken, 'public.txt', 'shared bytes');
      fileId = up.body.id;
      const share = await h
        .api()
        .post(`${API}/storage/shares`)
        .set(auth(org.ownerToken))
        .send({ targetType: 'file', targetId: fileId, scope: 'team', permission: 'download' });
      token = share.body.token;
      expect(token).toBeDefined();
    });
    then('the public share metadata reports the file name without authentication', async () => {
      const res = await h.api().get(`${API}/storage/share/${token}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('public.txt');
    });
    and('the shared file can be downloaded through the public link', async () => {
      const res = await h
        .api()
        .post(`${API}/storage/share/${token}/download`)
        .send({ fileId });
      expect(res.status).toBe(200);
      expect(res.text || res.body.toString()).toContain('shared bytes');
    });
  });

  test('a password-protected share rejects the wrong password', ({
    given,
    when,
    then,
    and,
  }) => {
    let org: CreatedOrg;
    let token: string;

    given('an organization with an owner', async () => {
      org = await h.createOrg();
      orgIds.add(org.orgId);
    });
    when('the owner uploads a file "secret.txt" and shares it with password "letmein"', async () => {
      const up = await upload(org.ownerToken, 'secret.txt', 'top secret');
      const share = await h
        .api()
        .post(`${API}/storage/shares`)
        .set(auth(org.ownerToken))
        .send({ targetType: 'file', targetId: up.body.id, scope: 'team', password: 'letmein' });
      token = share.body.token;
    });
    then('opening the share with the wrong password is rejected', async () => {
      const res = await h
        .api()
        .post(`${API}/storage/share/${token}/open`)
        .send({ password: 'nope' });
      expect(res.status).toBe(403);
    });
    and('opening the share with "letmein" succeeds', async () => {
      const res = await h
        .api()
        .post(`${API}/storage/share/${token}/open`)
        .send({ password: 'letmein' });
      expect(res.status).toBeLessThan(300);
      expect(res.body.ok).toBe(true);
    });
  });

  test('deleting a folder removes its files and revokes its shares', ({
    given,
    when,
    then,
    and,
  }) => {
    let org: CreatedOrg;
    let folderId: string;
    let fileId: string;
    let shareId: string;

    given('an organization with an owner', async () => {
      org = await h.createOrg();
      orgIds.add(org.orgId);
    });
    when(
      'the owner creates a folder, uploads a file into it, shares the file, then deletes the folder',
      async () => {
        const folder = await makeFolder(org.ownerToken, 'Temp');
        folderId = folder.body.id;
        const up = await upload(org.ownerToken, 'doomed.txt', 'bye', folderId);
        fileId = up.body.id;
        const share = await h
          .api()
          .post(`${API}/storage/shares`)
          .set(auth(org.ownerToken))
          .send({ targetType: 'file', targetId: fileId, scope: 'team' });
        shareId = share.body.shareId;
        const del = await h
          .api()
          .delete(`${API}/storage/folders/${folderId}?scope=team`)
          .set(auth(org.ownerToken));
        expect(del.status).toBeLessThan(300);
      },
    );
    then('the folder no longer lists any files', async () => {
      const res = await h
        .api()
        .get(`${API}/storage/files?scope=team&folderId=${folderId}`)
        .set(auth(org.ownerToken));
      expect((res.body.data as any[]).length).toBe(0);
    });
    and('the share for that file is revoked', async () => {
      const row = await shares.findOne({ where: { id: shareId } });
      expect(row?.revoked).toBe(true);
    });
  });
});
