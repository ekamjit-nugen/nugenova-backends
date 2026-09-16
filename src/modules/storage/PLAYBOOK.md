---
module: storage (Cloud Drive)
title: Cloud Drive
owner: collaboration
status: live
phase: 1
migratedAt: 2026-09-08
source: nexora-api/src/modules/storage
routeNamespace: /api/v1/storage
---

# Cloud Drive

A per-tenant file vault: **folders**, **files**, **quotas** and external
**share links**. Ported from the Nexora Mongo `storage` module to
Postgres/TypeORM. Person = `User` + `OrgMembership` (`userId` is the auth id).

Two drives, discriminated by `scope`:

- **`personal`** — a private "My Drive" per user. `ownerId` is the user; every
  read/write filters by it, so members never see each other's personal files.
  Counts against the user's My-Drive quota (membership override ?? org default).
- **`team`** — the shared org "Team Drive". `ownerId` is null; visible to every
  member with drive access. Counts against the org pool.

## Isolation (the #1 rule)

Every read AND write is scoped to `organizationId`, and personal-scope reads
additionally to `ownerId`. Folders/files are only ever loaded through
`getOwnedFolder` / `getOwnedFile`, which require **same org** AND (for personal)
**same owner** — a mismatch is a **404**, never a leak. Public share routes never
accept an org id from the caller; the org is read from the share row the opaque
token resolves to.

## Bytes: reuse, never a second store

The drive stores **only metadata**. The actual bytes live in the shared bootstrap
`StorageService` (`src/bootstrap/storage`) — S3 when configured, a Postgres
`bytea` fallback otherwise — referenced by `DriveFileEntity.storageFileId` (the
id of a `document_files` row). Upload calls `StorageService.save(...)`; every
download streams through `StorageService.openStream(...)` behind the
authenticated endpoint. **No presigned URLs are ever handed to a client** — this
matches the chat/media private-byte posture and is a deliberate divergence from
the legacy Mongo module (which returned presigned GETs for both in-app preview
and share downloads).

## Bridge: files shared elsewhere in the app

Chat attachments, onboarding docs, etc. are uploaded through the shared
`StorageService` and land in `document_files` — they would otherwise never show
up in Cloud Drive, which by design is the one vault for *all* the org's files. So
the drive **indexes** those existing bytes: a `drive_files` row pointing at the
**same `storageFileId`** (no byte copy).

**Routing — who sees a bridged file:**

- **Chat in a DIRECT (1:1) conversation → each participant's My Drive** (personal
  scope, one row per participant, in *their* `Shared in Chat` folder). A private
  DM attachment stays private to the two people — never the whole org.
- **Chat in a group/channel → Team Drive** (`Shared in Chat`), visible org-wide.
- **Onboarding / other categories → Team Drive** under a category folder
  (`Onboarding`, else `Org Files`).

Landing folders are `systemManaged: false` (so bridged files are browsable).
Indexing is idempotent per **(storageFileId, scope, ownerId)**.

- **Live** — `DriveChatBridge` (`@OnEvent(CHAT_MESSAGE_NEW)`, same in-process
  `EventEmitter2` bus the chat gateway uses) calls `bridgeChatMessage`, which
  looks up the conversation and routes DM vs group. Chat stays decoupled: it
  emits, the drive reacts. Best-effort; a bridge error never affects delivery.
- **Backfill** — `POST /storage/backfill` (DriveAdminGuard) is
  **message-driven** for chat (only files in a *live, non-deleted* sent message
  are bridged) and document-driven for other categories. It is **self-healing**:
  it re-routes a file to its correct scope and **prunes** any `Shared in Chat`
  index row no longer backed by a message at that scope — e.g. a DM file that an
  older build mirrored to Team Drive, or the attachment of a since-deleted
  message. Safe to run repeatedly.
- Deleting a bridged row soft-deletes the *index* only; the underlying
  `document_files` bytes are untouched (still owned by chat/onboarding).
- A DM-routed file counts against each participant's **My Drive** quota (it's in
  their drive); a group/onboarding file counts against the **Team** pool.
- Tenant isolation holds: the bridge only ever indexes a `document_files` row
  whose `organizationId` matches, so another tenant's files never leak in.
- **Seam:** deleting a chat message doesn't live-unbridge its attachment; the
  next backfill prunes it. A message-deleted → prune listener could close this.

## Internal sharing (share with org members)

Distinct from the external `drive_shares` token links: a **grant** (`drive_grants`)
gives another org member access to a file/folder WITHOUT a public link.

- Permissions: `view`, `download`, `edit`. **edit** = view + download + rename +
  replace content (`PUT /storage/files/:id/content`). Delete and move stay with
  the owner — an editor can change a document, not relocate or destroy it.
- The grant is the discoverability + authorization record: the grantee finds the
  item under **`GET /storage/shared-with-me`**, and `renameFile` /
  `replaceFileContent` authorize a non-owner holding an `edit` grant
  (`resolveFileForWrite`). View/download already work for any org member via the
  org-scoped byte endpoints.
- **Granting auto-enables the grantee's Cloud Drive access** (`cloudDrive.enabled`,
  `viaShare: true`) — you can't meaningfully share with someone who is then blocked
  by `CloudDriveAccessGuard`.
- Only the target's owner (personal) — or any member for a team item — may grant
  (`assertCanManageShares`). Grantor, owner, or the grantee themselves may revoke.
- Grants are cleaned up when the file/folder is deleted.
- Routes: `POST /storage/grants` · `GET /storage/grants?targetType=&targetId=` ·
  `DELETE /storage/grants/:id` · `GET /storage/shared-with-me`.
- Seam: browsing a shared *folder's* contents as a grantee isn't wired yet
  (listFiles is owner-scoped); shared files are fully functional.

## Access control

`CloudDriveAccessGuard` (runs after `JwtAuthGuard`) gates the authenticated
routes: owners/admins/platform-admins always pass; plain members need
`OrgMembership.cloudDrive.enabled` (a jsonb flag). On failure the service throws
`403 { code: CLOUD_DRIVE_NO_ACCESS }`, which the frontend detects to show an
"ask your admin" state. `GET /storage/access/me` is deliberately **not** behind
the access guard so the nav can decide whether to show the Drive link.

The admin surface (`GET /storage/access`, `PUT /storage/access/:userId`,
`PUT /storage/settings`) is gated by `DriveAdminGuard` — an org owner/admin or a
platform/super admin, mirroring the legacy `@Roles('admin','super_admin')`. It
always acts on the JWT's own org.

## Quota

`DriveQuotaEntity` holds the **limits**; **used** bytes are always summed live
from `drive_files` (never denormalised, so they can't drift):

- team-pool row (`ownerId = null`): `limitBytes` = Team-Drive cap;
  `defaultUserLimitBytes` = org default My-Drive cap.
- per-user row (`ownerId = uid`): a My-Drive override. (Also settable as
  `membership.cloudDrive.quotaGb`, which wins when present.)

Defaults when no row exists: **50 GB** team pool, **1 GB** My Drive. Uploads call
`assertScopeQuota` **before** delegating bytes; overflow is
`403 { code: STORAGE_QUOTA_EXCEEDED }`.

## Endpoints (all under `/api/v1/storage`)

Authenticated (JwtAuthGuard + CloudDriveAccessGuard unless noted):

- `GET  access/me` — nav self-check (no access guard).
- `GET  overview` / `GET quota` — My+Team usage / org-pool quota.
- `GET  folders` · `GET folders/:id/breadcrumb` · `POST folders` ·
  `PATCH folders/:id` (rename) · `PATCH folders/:id/move` · `DELETE folders/:id`.
- `GET  files` · `POST files` (multipart) · `PATCH files/:id` (rename) ·
  `PATCH files/:id/move` · `GET files/:id/raw` (inline byte stream) ·
  `GET files/:id/pdf` (preview) · `DELETE files/:id`.
- `POST shares` · `GET shares` · `DELETE shares/:id`.
- Admin (DriveAdminGuard): `GET access` · `PUT access/:userId` · `PUT settings` ·
  `POST backfill` (index existing chat/onboarding files — see Bridge above).

Public (no login — org from the token):

- `GET  share/:token` (metadata) · `POST share/:token/open` (password) ·
  `POST share/:token/list` (folder subtree) · `POST share/:token/download`
  (byte stream; `download` shares force a save, `view` shares stream inline).

## Seams / deferred (what a COMPLETE Cloud Drive still needs)

- **Office → PDF preview** is a provider interface (`OFFICE_CONVERT_PROVIDER`)
  bound to a **no-op** default: PDFs preview directly, other office types report
  "not convertible". The heavy LibreOffice shell-out from the legacy module was
  intentionally NOT ported. Restore rich previews by binding a real adapter
  (LibreOffice/Gotenberg sidecar or a cloud API) — nothing else changes.
- **Large-file direct upload.** Uploads currently pass through the server and are
  capped by the shared `StorageService` (25 MB; the legacy module allowed 100 MB
  and offered a presigned direct-to-S3 path). A presigned **multipart** upload
  seam (client → S3, then a `finalize` re-stat) is deferred; it must keep the
  quota pre-check and continue serving reads through the auth'd proxy.
- **Byte GC on delete.** `deleteFile`/`deleteFolder` soft-delete the drive rows
  and revoke shares, but do NOT hard-delete the underlying `document_files`
  bytes (`StorageService` exposes no delete yet). Add a `StorageService.delete`
  + a reaper.
- **Trash / restore & versioning.** Soft-delete exists (`isDeleted`); a
  user-facing trash bin, restore, and file versioning are not built.
- **Thumbnails / richer previews** (images beyond inline, video posters) —
  none generated; the viewer relies on the browser + the PDF path.
- **Virus scan** on upload — not wired (a pre-`save` scan hook is the seam).
- **Quota reconciliation with the media store.** The legacy `getQuota` folded
  chat/media/board bytes into the org pool (`breakdown.media`). Here `media` is
  reported as `0` — the drive counts only `drive_files`. If media should share
  the org cap, sum `document_files` (or the media module's rows) into the pool.
- **Cross-module public API.** The legacy `STORAGE_PUBLIC_API`
  (`assertWithinQuota` / `ensureSystemFolder` / `uploadFile` / `getFileStream`
  for other modules) is not re-exposed yet; `systemManaged` columns are in place
  for when it is. `DriveService` is exported from `DriveModule` for now.
- **Folio / portfolio** (a curated public-facing document collection) would be a
  separate module layered on the share primitives here.

## Tests

- `drive.service.spec.ts` — 15 unit tests (mocked repos + StorageService):
  quota defaults/override/enforcement, the access grant + notification, folder
  validation, byte delegation on upload, share password gating, PDF pass-through.
- `features/cloud-drive.feature` + `cloud-drive.e2e-spec.ts` — 8 Gherkin
  scenarios (folder+upload+overview, no-grant denial, grant, personal isolation,
  raw byte round-trip, public share, password share, cascade delete). Typechecked;
  run with `npm run test:e2e` against a provisioned Postgres.

## Per-file read access (fix)

`GET /drive/files/:id/raw` and `/pdf` used to check only that the file belonged to the
caller's org — any member with Cloud Drive access could read any personal file by id,
and `drive_grants` were recorded but never enforced on read. Both now go through
`DriveService.assertCanReadFile(orgId, fileId, userId, isAdmin)`:

| Case | Allowed |
|---|---|
| Team-scope file | any member with drive access (that is the shared drive) |
| Personal file, owner | yes |
| Personal file, granted directly (`drive_grants`, targetType `file`) | yes |
| Personal file inside a granted folder (any ancestor) | yes |
| Org owner/admin/platform admin | yes — they administer the drive |
| Anyone else | **403** |

Public share links keep working: they authorize by token and call with `userId = null`.

## Cloud Drive ↔ discussion boards

- **Copy FROM Drive onto a board** — `POST /discussion-boards/:boardId/assets/from-drive
  { fileId }`. Checked **both ways**: the caller must be on the board *and* pass
  `assertCanReadFile` for that drive file. The bytes are copied, so the drive original
  and its grants are untouched and later edits there don't leak onto the board.
- **Where the copy lives** — an image becomes a `board-asset` (publicly embeddable by
  unguessable id, so `<img>` in a card works); anything else is tagged **`board-file`**
  and is served only by `GET /discussion-boards/:boardId/files/:assetId/raw`
  (JWT + participant check). A copied document is therefore readable by board members
  only, never by URL alone.
- **Copy link** — board files expose a copy-link button in both surfaces (Cloud Drive →
  Board files, and the board's own Files panel) so a link can be pasted into a card.

