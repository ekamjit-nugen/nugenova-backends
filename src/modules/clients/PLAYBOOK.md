---
module: clients
title: Clients & Client Portal
owner: delivery
status: live
phase: 1
migratedAt: 2026-09-11
source: nugenova-monolith (reference only — rebuilt)
---

# Clients & Client Portal

An organization manages the **client companies** it serves and gives them a
read-mostly **portal** to follow the work shared with them. A client has a
profile + tags + notes, one or more **contacts**, a **delivery team** (staff
**assignments**), and a set of **discussion boards** shared with it. A contact
can be promoted to a **portal login** — an `OrgMembership` with `role='client'`,
`personType='client'`, and `clientId` set — so the client can sign in, see their
overview, read shared boards, and (when granted) comment.

This module was rebuilt fresh; the legacy Nugenova had only partial client
records and no portal, so it is a reference point, not a migration source.

## Entities (Postgres / TypeORM, all `PgBaseEntity` 24-char ObjectId ids)

- **`clients`** — `organizationId`, `companyName` (unique per org, case-insensitive),
  `displayName`, `industry`, `website`, `status` (`active`|`archived`), `tags`
  (jsonb), `notes`, `primaryContact` (jsonb), `createdBy`/`updatedBy`,
  `isDeleted` (soft delete).
- **`client_contacts`** — a person at the client: `name`, `email`, `phone`,
  `designation`, and `userId` (null = record only; set once invited to the portal).
- **`client_assignments`** — a staff member on the delivery team:
  unique `(clientId, userId)`, optional `assignmentRole`.
- **`board_client_shares`** — a discussion board shared with a client:
  unique `(boardId, clientId)`, `permission` (`view`|`comment`), `sharedBy`.

Migration `1788300000000-Clients.ts` creates all four tables.

## Access model (the rules)

- **Management** (create/update/archive/delete, contacts, invites, assignments,
  board sharing) is **owner/admin only** — `requireAdmin()` in the controller.
  A non-admin management call is a **403**.
- **`GET /clients/mine`** serves any staff member their own assignments
  ("My clients"), read-only.
- **`portal/*`** is for `role='client'` sessions. The `clientId` comes from the
  caller's client-role membership; a portal user only ever sees **their own**
  client's data.
- **Sharing gate:** you can only share a board you can access — admin, the board
  creator, or a listed participant (`canAccessBoard`). Otherwise **403**.
- **Comment gate:** a portal comment needs the share to be `permission='comment'`;
  a view-only share is a **403**, an empty body a **400**.
- **Isolation:** a cross-org client id is a **404** (never confirm it exists
  elsewhere). Reads/writes are always `organizationId`-scoped.

## Lifecycle & cascades

- **Archive** → `status='archived'` and every portal login for the client is set
  `status='deactivated'`; shares are kept. **Restore** reverses both.
- **Delete** (soft) → `isDeleted=true`, portal logins deactivated, **shares +
  assignments hard-deleted**, contacts soft-deleted. The client leaves every
  list (including `?status=all`).
- **Invite** → finds or creates the `User` for the contact's email, creates (or
  re-activates) a `role='client'` membership bound to that `clientId`, links
  `contact.userId`, and sends a best-effort portal-invite email. Guards: the
  email must not already be a **staff** member of the org (**409**), nor a portal
  user of a **different** client (**409**).

## REST surface — `/api/v1/clients`

Management: `POST /`, `GET /?status=&q=&tag=`, `GET /:id`, `PATCH /:id`,
`POST /:id/archive`, `POST /:id/restore`, `DELETE /:id`;
contacts `POST /:id/contacts`, `PATCH|DELETE /:id/contacts/:contactId`,
`POST /:id/contacts/:contactId/invite`,
`POST /:id/portal-users/:userId/deactivate`;
assignments `POST /:id/assignments`, `DELETE /:id/assignments/:userId`;
sharing `POST /:id/boards`, `DELETE /:id/boards/:boardId`.
Employee: `GET /mine`.
Portal (client-role): `GET /portal/overview`, `GET /portal/boards/:boardId`,
`POST /portal/boards/:boardId/comments`.
Agreements (admin): `GET/POST /:id/agreements`, `PATCH /:id/agreements/:aid`,
`POST /:id/agreements/:aid/send|void`, `DELETE /:id/agreements/:aid`.
Agreements (portal): `GET /portal/agreements`, `GET /portal/agreements/:aid`,
`POST /portal/agreements/:aid/sign`.
Documents (admin): `GET/POST /:id/documents`, `DELETE /:id/documents/:docId`.
Documents (portal): `GET /portal/documents`.
Templates (admin): `GET/POST /agreement-templates`, `PATCH/DELETE /agreement-templates/:tid`.
Reminders (admin): `POST /:id/agreements/:aid/remind` (manual nudge).
Tickets (admin): `GET /tickets?status=` (org queue), `GET /:id/tickets`, `POST /:id/tickets`,
`GET/PATCH /tickets/:tid`, `POST /tickets/:tid/messages`.
Tickets (portal): `GET/POST /portal/tickets`, `GET /portal/tickets/:tid`, `POST /portal/tickets/:tid/messages`.

## Support tickets

Two-way requests: a client raises a ticket from the portal (or an org opens one
for them), and the conversation lives in `client_ticket_messages`. Tables
`client_tickets` + `client_ticket_messages` (migration `1788350000000`). Status
`open → in_progress → resolved → closed`; a **client reply reopens** a
resolved/closed ticket, and a **staff reply** moves `open → in_progress`.
Notifications: a client action notifies the delivery team (assignments + assignee)
via `client_ticket_created`/`client_ticket_reply`; a staff action notifies the
client's portal users. Frontend: admin **Requests** section on `/clients/[id]`
(list + a thread modal with status/priority + reply), and an org-wide queue
endpoint for a future inbox; client `/portal/tickets` (list + new request) and
`/portal/tickets/[tid]` (thread). Deleting a client soft-deletes its tickets.
Dashboard: `GET /overview` (admin) — client counts, agreement activity, and the
clients-without-a-signed-agreement nudge set.

## Document vault

Files an org shares with a client — deliverables, reports, contracts. The bytes
live in the shared storage (upload to `/media/upload` → `fileId`); table
`client_documents` (migration `1788330000000`) is the per-client vault entry with
denormalised name/type/size so listing needs no storage round-trip. Every vault
entry for a client is visible in that client's portal (`GET /portal/documents`),
and the client downloads via the same-org `/media/files/:id/download`. Frontend:
admin **Documents** section on `/clients/[id]` (upload/list/delete); client
**Documents** section on the portal home (download). Deleting a client
soft-deletes its documents (the underlying files are retained in storage).

## Agreements (e-signing)

An org sends a client an **agreement** (NDA/SOW/MSA/contract) to e-sign — rich
text (`bodyHtml`) and/or an attached PDF (`sourceFileId`). Lifecycle:
`draft → sent → signed | declined`; `sent → void` (withdrawn). The portal shows
only `sent`/`signed` (drafts stay internal). Signing captures the same
`AgreementSignature` audit record the onboarding module uses — `signerName`,
`signedByUserId`, `signedAt`, `ipAddress`, `userAgent`, `method` (`drawn`/`typed`),
and a `signatureFileId` for the drawn-image (uploaded to `/media` by the client,
same-org access). A signed agreement can't be edited, re-sent, voided, or
re-signed. Tables/columns: `client_agreements` (migrations `1788310000000` +
`1788320000000` — the latter adds `fields` + `signed_file_id`); deleting a client
soft-deletes its agreements. Frontend: admin manages them in an **Agreements**
section on `/clients/[id]`; the client reviews + signs at `/portal/agreements/[id]`,
with pending ones surfaced on the portal home.

**Templates & reminders:** reusable `client_agreement_templates` (name + title +
category + bodyHtml and/or a stored PDF with placed `fields`) let an org author an
NDA/SOW once and spin up per-client agreements from it (the create form prefills
from a template, and can save the current agreement back as one). Unsigned `sent`
agreements get **reminders**: a manual "nudge" (`POST …/remind`) and a daily cron
(`ClientsCronService.runAgreementReminders` → after 3 days, then every 3, capped
at 3) that emails + in-app-notifies the client's active portal users; each fires
`client_agreement_reminder` and stamps `lastReminderAt`/`reminderCount`.
Migration `1788340000000` adds the templates table + the reminder columns.

**In-PDF signing (DocuSign-style):** when the org attaches a PDF it can place
signature/name/date boxes on it (`fields`, page-relative %) via
`AgreementPreparePdf` (reuses `PdfCanvas` + `@/lib/pdf-fields`). The client fills
them on the rendered PDF via `AgreementPdfSign`, and the signature is **flattened
into the PDF with `pdf-lib`** (`@/lib/pdf-flatten` → `flattenSignedPdf`), uploaded,
and stored as `signedFileId`; typed values go to `signature.fieldValues`. No new
deps — `pdf-lib`/`pdfjs-dist` were already in the tree (shared with onboarding).
Agreements without placed fields fall back to the simple draw/type-and-sign pad.

> **Module gating:** `clients` is registered in `vertical-packs` (CORE_MODULES).
> The `@RequireModule('clients')` guard will be added to the controller once the
> `ModuleEnabledGuard` infra merges to main (it currently lives on the
> meetings/activity branches). Until then the controller is `JwtAuthGuard` only.

## Frontend

- **Admin** — `/clients` (list + create), `/clients/[id]` (contacts, delivery
  team, shared boards, portal logins; archive/restore/delete). Nav item is
  admin-only.
- **Employee** — `/clients/mine` ("My clients" roster), a `memberVisible`,
  `hideForAdmin` nav item mirroring the Onboarding lifecycle/`me` split.
- **Portal** — `/portal` (overview: profile, team, shared boards) and
  `/portal/boards/[boardId]` (notes + threaded discussion, comment composer when
  permitted). A dedicated `PortalLayout` (brand header + sign-out, no staff
  AppShell) guards the route to `role='client'` sessions only. The backend routes
  a client login to `/portal` (`determinePostLoginRoute`); the frontend login
  `KNOWN_ROUTES` includes `/portal`.

## Tests

- **E2E** — `features/clients.feature` + `clients.e2e-spec.ts` (jest-cucumber):
  create/dedup/non-admin-403, contact→invite→portal sign-in, assignment→My
  clients, board share→portal overview/read, comment permission gates,
  unshared-board 403, archive suspends logins, delete cascades, cross-org 404.
  Entities + migration are registered in `test/global-setup.ts` (incl. the
  discussion-board tables the portal reads).
- **Unit** — `clients.service.spec.ts`: dedup, share/assign/invite guards,
  portal-comment permission gates, archive cascade, `myClients` mapping, and the
  agreement lifecycle (create validation, send gate, portal sign audit trail +
  double-sign/draft guards, portal listing filter).

## Deferred

- **Assignee board auto-access** — an assigned employee does **not** yet
  auto-gain discussion-board access to boards shared with their client; that
  requires making the boards `canAccess` async across its ~10 call sites. Add the
  employee as a board participant in the meantime.
- **`@RequireModule('clients')`** — pending the vertical guard on main (above).
