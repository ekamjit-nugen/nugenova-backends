---
module: auth
title: Authentication (Login)
owner: platform
status: live
phase: 1
migratedAt: 2026-08-21
source: nugenova-monolith/src/modules/auth
---

# Auth — Login

The first module migrated onto the Postgres stack. Passwordless **email-OTP**
login with an optional **TOTP second factor**, JWT issue / refresh / revoke, and
post-login routing. Ported faithfully from the Mongo monolith's auth core; only
the persistence layer changed (Mongoose → TypeORM, `_id` → `id`).

## Overview & endpoints

All routes are under the global `/api/v1` prefix.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/auth/send-otp` | — | Email a 6-digit OTP (hashed at rest). Never reveals whether the email exists. |
| POST | `/auth/verify-otp` | — | Verify the OTP. Returns session tokens + post-login route, or an MFA challenge. |
| POST | `/auth/mfa/authenticate` | challenge token | Complete login by clearing the TOTP / backup-code second factor. |
| POST | `/auth/refresh` | refresh token | Rotate the refresh-token family and mint a new access token. |
| POST | `/auth/logout` | access token | Revoke the current access token (jti) + refresh family. |
| GET | `/auth/me` | access token | The authenticated user's public profile. |
| GET | `/auth/check-email` | — | `{exists, isActive}` for an email (onboarding UX). |
| POST | `/auth/mfa/setup` | access token | Begin TOTP enrolment → `{secret, otpauthUrl}`. |
| POST | `/auth/mfa/verify` | access token | Confirm enrolment with a TOTP code → 10 backup codes. |
| DELETE | `/auth/mfa` | access token | Disable MFA. |
| GET/DELETE | `/auth/sessions[/:id]` | access token | List / revoke refresh-token sessions. |

### Data model (entities → tables)

- **`users`** — the global login identity (email, OTP state, MFA secret/backup codes, roles, `isPlatformAdmin`, `setupStage`, `defaultOrganizationId`). *Pre-existing table (seeded Phase 0).*
- **`org_memberships`** — user↔org join carrying the enforced `role`, optional custom `roleId`/`secondaryRoleId`, client/vendor scoping, invite state. *Pre-existing.*
- **`sessions`** — one row per refresh-token family; rotation revokes the old row. *Created this migration.*
- **`roles`** — per-org custom role definitions (permission matrix folded into the JWT for non-admin custom roles). *Created this migration.*
- **`revoked_tokens`** — the jti deny-list checked by the JWT guard on every request (logout / forced sign-out). *Created this migration.*

### Post-login routing

`determinePostLoginRoute` decides where the client lands: platform admins →
`/platform`; client-only memberships → `/portal`; vendor-only → `/vendor-portal`;
brand-new users → `/auth/setup-organization`; **any pending/invited membership →
`/auth/accept-invite` (wins over an active membership)**; a fully-onboarded user
with one active org → `/dashboard`; multiple active orgs → `/auth/select-organization`.

## Migration status & steps

- **Status:** ✅ live on Postgres. Login verified end-to-end for the seeded
  super-admin (`accounts@nugeninfo.com` → `/platform`) and manager
  (`ekamjit@`, `lovish@` → `/dashboard`) accounts.
- **Entities:** `UserEntity`, `OrgMembershipEntity` (brought from the monolith),
  plus new `SessionEntity`, `RoleEntity`, `RevokedTokenEntity`.
- **Migrations:** `AuthUsersInitial` (users + org_memberships, Phase 0) and
  `AuthSessionsRolesTokens` (sessions + roles + revoked_tokens, Phase 1).
- **Run migrations:** `npm run migration:run`
- **ETL (already done, gated on explicit per-account authorisation):** the 3
  accounts above were migrated from Mongo via `auth-users.etl.ts`. Bulk user
  migration remains a separately-authorised step.

## Rollback

The new stack runs alongside the untouched Mongo monolith, so rollback is
"stop pointing clients at the new stack" — no data rewrite needed.

1. Point the web admin's `NEXT_PUBLIC_API_URL` back at the monolith.
2. To remove the Phase-1 tables only: `npm run migration:revert` (drops
   `sessions`, `roles`, `revoked_tokens`; leaves `users` / `org_memberships`
   intact and shared).
3. No destructive change to `users` / `org_memberships` — the monolith keeps
   reading Mongo; these Postgres rows are additive.

## Security notes

- OTPs are bcrypt-hashed at rest; 5 attempts then a 15-minute lockout; 5
  requests/hour rate limit + 30s resend cooldown.
- Unknown-email verify returns the **same** generic `INVALID_OTP` / 400 as a
  wrong code — no email-enumeration oracle.
- MFA challenge tokens carry a `purpose` claim so they can never be used as a
  real access token.
- Refresh-token reuse after rotation is treated as compromise and rejected.
- Access tokens are short-lived (15m); logout adds the jti to the deny-list.
- **Dev only:** `DEV_OTP_BYPASS=true` (+ non-prod) accepts the magic code
  `DEV_OTP_CODE` (default `000000`) and skips OTP email. MUST be off in prod.

## Deferred (not in Phase 1)

Password `/login` + `/register`, OAuth/SAML SSO, SCIM provisioning, GDPR
deletion, webhooks, API keys, the invite/org-creation flow, and a durable
`audit_events` table (audit currently logs to the app log). These land with
later modules.

## Scenarios & tests

Gherkin scenarios live in `src/modules/auth/features/*.feature` and are bound to
supertest integration specs (`*.e2e-spec.ts`, jest-cucumber) plus pure unit
specs (`*.spec.ts`). Live pass/fail + coverage for the latest CI run are merged
into this playbook by the `admin-playbooks` API from the published
`ci-status.json`.
