---
module: sales
title: Sales & Leads (CRM)
owner: revenue
status: live
phase: 1
migratedAt: 2026-09-11
source: nexora-api/nugenova-admin (reference only — rebuilt in the Nexora stack)
---

# Sales & Leads (CRM) — Phase 1

A lightweight CRM in the active Nexora stack (Postgres/TypeORM). Phase 1 is the
**foundation**: the pipeline, leads, accounts, contacts, and a shared
activity/follow-up timeline. Deals, requirements + effort estimation, quotes, and
analytics land in later phases (see **Roadmap**). Rebuilt from the legacy Mongo
`nexora-api`/`nugenova-admin` CRM as reference — this one integrates with the
platform's auth, notifications, and the delivery **Clients** module.

## Entities (migration `1788360000000-SalesPhase1`)

- **`sales_pipeline_stages`** — the funnel, seeded per org on first use from
  `DEFAULT_STAGES` (New → Contacted → Qualified → Proposal → Negotiation → Won →
  Lost) with `order`, `probability` (feeds the weighted forecast), `isWon`/`isLost`.
- **`leads`** — name, company, email, phone, title, `source`, `stageId`,
  `status` (open|won|lost|on_hold), `value`+`currency`, `assignedTo`, `score`,
  `tags`, `notes`, `lastActivityAt`, `nextFollowUpAt`, and dormant
  `convertedToDealId`/`clientId` columns for the Phase 2/3 bridges.
- **`sales_accounts`** / **`sales_contacts`** — companies + people (CRM side,
  distinct from the delivery Clients module).
- **`sales_activities`** — polymorphic timeline (note/call/email/meeting/whatsapp/
  visit/stage_change/system) on a lead/deal/account/contact.
- **`sales_followups`** — scheduled follow-ups/tasks with a due date + status.

## Behaviour

- **Stages auto-seed** the first time an org lists stages or creates a lead —
  no setup step.
- **Moving a lead** to a stage flagged `isWon`/`isLost` sets the lead status to
  `won`/`lost` and drops a `stage_change` activity on the timeline; every activity
  bumps `lastActivityAt`.
- **Assignment** notifies the new owner (`lead_assigned`, in-app + email).
- **Overview** returns open pipeline value, weighted forecast (Σ value×probability
  of open leads), won value, win rate, and a per-stage funnel.

## REST — `/api/v1/sales` (JWT, org-scoped; org-member access)

Stages `GET/POST /stages`; dashboard `GET /overview`; follow-ups
`GET /followups?mine=1`, `PATCH /followups/:id`; leads `GET /leads`,
`GET /leads/board`, `POST /leads`, `GET/PATCH/DELETE /leads/:id`,
`POST /leads/:id/move`, `POST /leads/:id/activities`, `POST /leads/:id/followups`;
accounts + contacts `GET/POST/PATCH/DELETE`.

## Frontend (`_wt-clouddrive-fe`, admin nav "Sales" section)

`/sales` (dashboard: KPIs + funnel + due follow-ups), `/sales/leads`
(kanban board with **drag-to-move-stage** + list toggle + create),
`/sales/leads/[id]` (hero + stage stepper + activity timeline/composer +
follow-ups + quick edit), `/sales/accounts`, `/sales/contacts`.

## Gaps found in the legacy (addressed later)

The legacy had no first-class **effort/work estimation** on requirements, no
**quotes/proposals**, no **services rate-card**, no **Won→Client handoff**, and no
loss-reason/BANT qualification. Phase 1 adds `tags` on leads and a clean bridge
column (`clientId`) toward the delivery module.

## Phase 2 (DONE) — deals + requirements/effort

- **Deals** (`deals`, migration `1788370000000`) — qualified opportunities on the
  same pipeline: amount, currency, stage, status (open/won/lost), assignee,
  expected close, loss reason, `sourceLeadId` + dormant `clientId`. Kanban board
  with drag-to-move; won/lost stages set status + stamp wonAt/lostAt.
- **Requirements** (`sales_requirements`) — first-class **effort estimation** on a
  lead or deal: title, role, skills, MoSCoW priority, status, and
  `unit`(hours|days|fixed)·`quantity`·`rate` → line amount. Rolls up to total
  effort (hours/days) + value; `POST /deals/:id/rollup` sets the deal amount from it.
- **Lead→Deal conversion** (`POST /leads/:id/convert`) — creates the deal, moves
  the lead's requirements onto it, optionally spins up an account + contact, and
  stamps the lead `convertedToDealId`.
- Overview now also returns a **deals** block (open value, weighted forecast, won
  value, win rate, funnel).
- Routes: `/deals` (+ `/board`, `:id`, `:id/move|rollup|activities|followups|
  requirements`), `/leads/:id/requirements|convert`, `/requirements/:id`.
- Frontend: `/sales/deals` (board+list+create), `/sales/deals/[id]` (detail with
  the **Requirements & effort** panel + roll-up), the panel is reused on the lead
  detail, and a **Convert to deal** button on leads.

## Phase 3 (DONE) — quotes + Won→Client bridge

- **Quotes/proposals** (`sales_quotes`, migration `1788380000000`) for a lead or
  deal: line items (`items` jsonb: description·unit·quantity·rate), `discountType`
  (percent|amount) + `discountValue`, `taxPercent` → `subtotal`/`discountAmount`/
  `taxAmount`/`total` recomputed on every save; auto `number` (Q-0001); status
  draft→sent→accepted|rejected|expired. **Build from requirements**
  (`POST /:entity/:id/quotes/from-requirements`) maps non-dropped requirements to
  line items. Routes: `/quotes/:id` (`GET/PATCH/DELETE`, `send|accept|reject`).
- **Won→Client bridge** (`POST /deals/:id/convert-to-client`) — creates a client
  in the delivery **Clients module** (`ClientsService.create`) from the deal's
  account (name/industry/website) + contact (primary contact), links
  `deal.clientId` and the source lead's `clientId`, and drops a timeline note.
  Guarded against double-linking. SalesModule imports ClientsModule for this.
- Frontend: `components/sales/quotes-panel.tsx` (list + build-from-requirements +
  a full quote editor with live totals, send/accept/reject) on lead + deal detail;
  a **Create client** button on won deals (→ Clients module).

## Roadmap

- **Phase 4** — analytics/leaderboard, lead scoring, follow-up reminder cron,
  import/export, portal quote acceptance, and `@RequireModule('sales')` once the
  vertical guard reaches main.
- **Phase 4** — analytics (forecast/leaderboard), lead scoring, follow-up
  reminder cron, import/export, and `@RequireModule('sales')` once the vertical
  guard reaches main.

## Tests

- Unit — `sales.service.spec.ts`: stage seeding, create-lead default stage,
  move→won/lost, overview math, unknown-stage guard.
