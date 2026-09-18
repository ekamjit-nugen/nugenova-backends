# Vendors

The buy side of delivery: the supplier companies an org works with (staffing
partners, subcontractors, service vendors), the people those vendors supply, and
the contacts we deal with there. Clients is the mirror image — a client buys our
people, a vendor sells us theirs — so the two modules share a shape on purpose.

Ported from the legacy Nugenova `vendors` feature (Mongo `vendors`,
`vendoremployees`, `vendoragreementtemplates`, `vendoragreementsignatures`,
`vendorbills` + the `/vendor-portal` app).

## Model

| Table | What it holds |
|---|---|
| `vendors` | the supplier company: profile, service category, tax id, currency, status, onboarding status, billing address, inline primary contact, tags |
| `vendor_contacts` | people at the vendor we correspond with; one `isPrimary` per vendor; `userId` reserved for a portal login |
| `vendor_employees` | the contractors the vendor supplies, with the rate the vendor charges us (`rateAmount` / `rateUnit`) |
| `vendor_agreement_templates` | the org's reusable paperwork (MSA, NDA, code of conduct): `required`, and `appliesToCategories` (empty = every vendor) |
| `vendor_agreements` | the copy a vendor signs, with its signature audit record, expiry and `requiredForOnboarding` |
| `vendor_bills` | what a vendor charged us: a line per contractor, the computed money, and the approve/pay trail |

Everything is org-scoped and soft-deleted (`isDeleted`). Deleting a vendor
cascades to its contacts and people, so a later vendor of the same name starts
clean and no orphan contractor lingers in a picker.

### Contractors are not members

A supplied contractor is a row in `vendor_employees`, **not** an OrgMembership.
That is the whole reason for the separate table: an org member flows into
payroll runs, the attendance roster, seat counts and the Directory. If a
contractor is ever given a login it must be a membership with
`personType = 'vendor'` (added to `PersonType` with this module), which
`staffScope()` keeps out of every staff-assuming query — the same guard the
education vertical uses for students and guardians.

`org_memberships.vendor_id`, `org_memberships.vendor_employee_id` and
`attendance.vendor_employee_id` have existed since the first migrations, waiting
for these tables. No FK was added: those columns predate the tables and may hold
ids from the legacy system, so a constraint would fail on existing rows.

`vendors.timeTrackingEnabled` is off by default — most vendors bill from their
own timesheets, and a contractor in our attendance skews the org's own numbers.
Attendance's vendor clock-in gating (attendance PLAYBOOK G-C1) reads this flag.

## Access

`/api/v1/vendors`, JWT-guarded. Every route needs the matching `vendors`
permission — `view`, `create`, `edit`, `delete`. Owners and admins hold all four
from their tier; a custom role gets what the Roles page grants. There is no
self-service surface: rates are commercial terms, so nothing is readable without
`vendors:view`.

`vendors` is registered as a core module in `vertical-packs.ts`. As with
Clients, the `@RequireModule('vendors')` gate lands once ModuleEnabledGuard is
applied across the delivery modules.

## Routes

```
GET    /vendors                              list (status, q, category, tag)
POST   /vendors                              create
GET    /vendors/stats                        header counts
GET    /vendors/categories                   service categories in use
GET    /vendors/:id                          vendor + contacts + people
PATCH  /vendors/:id                          update (incl. status, onboardingStatus)
DELETE /vendors/:id                          soft-delete, cascading

POST   /vendors/:id/contacts                 add contact (isPrimary demotes the previous one)
PATCH  /vendors/:id/contacts/:contactId
DELETE /vendors/:id/contacts/:contactId

GET    /vendors/agreement-templates          templates (?includeArchived=true)
POST   /vendors/agreement-templates          author one
PATCH  /vendors/agreement-templates/:tid
DELETE /vendors/agreement-templates/:tid     archives it once issued

GET    /vendors/:id/agreements                agreements for this vendor
GET    /vendors/:id/clearance                 cleared? + a line per required item
POST   /vendors/:id/agreements                issue one (from a template, or ad hoc)
POST   /vendors/:id/agreements/issue-required raise every missing required one
PATCH  /vendors/:id/agreements/:aid           edit (not once signed)
POST   /vendors/:id/agreements/:aid/send      draft → sent
POST   /vendors/:id/agreements/:aid/sign      record the signature received
POST   /vendors/:id/agreements/:aid/decline
POST   /vendors/:id/agreements/:aid/void      withdraw an unsigned one
DELETE /vendors/:id/agreements/:aid           only while unsigned

GET    /vendors/bills                        the payables queue (?status=&vendorId=&from=&to=)
GET    /vendors/bills/:bid
PATCH  /vendors/bills/:bid                   only while a draft
POST   /vendors/bills/:bid/approve           draft → approved (records who)
POST   /vendors/bills/:bid/mark-paid         approved → paid (reference + date)
POST   /vendors/bills/:bid/cancel            draft/approved → cancelled
DELETE /vendors/bills/:bid                   only a draft or cancelled one

GET    /vendors/:id/bills                     this vendor's bills
GET    /vendors/:id/cost-summary              outstanding / paid / lifetime
POST   /vendors/:id/bills                     raise one

GET    /vendors/:id/employees                list (status, q, skill)
POST   /vendors/:id/employees                add contractor (duplicate email per vendor → 409)
PATCH  /vendors/:id/employees/:employeeId
DELETE /vendors/:id/employees/:employeeId
```

## Agreements and clearance

An org authors its paperwork once and issues a copy per vendor. Creating an
agreement **copies** the template's content, so editing a template never changes
what a vendor already agreed to — the `templateId` is kept only to show where it
came from. Deleting a template that has been issued archives it instead.

A vendor is **cleared** when every required agreement that applies to them is
signed and unexpired. `GET /vendors/:id/clearance` returns that verdict with a
line per item (`missing`, `draft`, `sent`, `signed`, `declined`, `expired`), and
`POST /vendors/:id/agreements/issue-required` raises the missing ones in one go.
A required agreement raised ad hoc, or one whose template was later archived or
made optional, still counts — it is binding on the vendor either way.

Until the vendor portal ships a vendor cannot sign in the app, so an admin
records the signature they received: `method: 'offline'` names the staff member
who recorded it rather than pretending the vendor clicked something, and
`signedAt` may be backdated to when they actually signed (never into the future).
A signed agreement cannot be edited or deleted — void supersedes, delete does not.

## Onboarding status

`invited` → `agreements_pending` → `active` → (`suspended`). The status follows
clearance automatically on every agreement change, so nobody has to remember to
move it; `onboardedAt` is stamped the first time a vendor reaches `active` and
never moved again, so a suspended vendor that is reinstated keeps its original
date. A **suspended** vendor is left alone by that sync: suspension is a
decision, not a consequence of paperwork.

## Bills

A bill is what a vendor charged us for the people they supplied — a line per
contractor (`quantity × rate`, hour/day/month/fixed), an optional tax percent,
and the vendor's own invoice number when they gave us one.

Two rules hold the money together:

1. **The server computes every figure.** `amount`, `subtotal`, `taxAmount` and
   `total` are recomputed from the lines on every write, rounded to two decimals.
   A line's `amount` isn't even in the DTO, so a client that sends one is
   refused rather than quietly ignored.
2. **A bill is editable only while it is a draft.** draft → approved → paid, and
   draft/approved → cancelled. After approval it is a financial record: a
   correction means cancelling it and raising a new one. Approve is idempotent
   (a double click doesn't re-stamp who approved it); delete is refused for
   anything approved or paid.

A line may name a supplied person (`vendorEmployeeId`), which is checked to
belong to the billing vendor — billing us for someone they don't supply is a
mistake worth stopping. `contractorName` is stored as typed, so an old bill
still reads correctly after that person's record changes.

`markPaid` records that we paid: when, by whom, and the reference (UTR, cheque
number). It moves no money — there is no payment or ledger model in the platform
yet, and this is the first billing surface in it.

`cost-summary` per vendor: `outstanding` is approved-but-unpaid (what we owe
today), `committed` adds what's paid, `lifetime` includes drafts. Cancelled
bills count nowhere — they never were a cost.

Bill numbers are `VB-00001` per org, allocated as count+1 (the house pattern)
with a unique index on `(organization_id, bill_number)`; a concurrent raise
fails on the index and simply takes the next number.

## The portal

`/api/v1/vendor-portal` — its own path, not `vendors/portal/*`, so these routes
can never be shadowed by the staff controller's `:id` routes.

A portal user is an OrgMembership with `role='vendor'`, `personType='vendor'`
and a `vendorId` — the vendor mirror of a client portal login. `personType` is
what keeps them out of `staffScope()`: payroll, the attendance roster, headcount
and the Directory never see them. Staff give access with
`POST /vendors/:id/contacts/:contactId/invite` (the contact needs an email; they
sign in with the normal OTP flow, so no password is ever set) and take it away
with the matching `DELETE`, which deactivates the membership but keeps the
contact record.

**No route here takes a vendor id.** The caller's own membership decides what
loads, so there is nothing to tamper with, and a vendor can only ever reach
their own rows.

```
GET    /vendor-portal/me                      their company, clearance, what we owe
GET    /vendor-portal/agreements               everything sent to them
POST   /vendor-portal/agreements/:aid/sign     they sign it themselves
GET    /vendor-portal/bills                    bills we have agreed
GET    /vendor-portal/people                   their roster
POST   /vendor-portal/people
PATCH  /vendor-portal/people/:eid
DELETE /vendor-portal/people/:eid
```

Three deliberate limits:

- **Drafts are ours.** A draft agreement or bill is our working copy, so it is
  filtered out of every portal list — and signing a draft returns 404, because
  as far as the vendor is concerned it doesn't exist.
- **Rates are not theirs to set.** A vendor can add and edit their own people,
  but `rateAmount` / `rateCurrency` / `rateUnit` are stripped on the way in: the
  rate is a commercial term agreed with us.
- **Signing in the portal is never `offline`.** That method means a staff member
  recorded a signature on the vendor's behalf; when the vendor signs here the
  method is `typed` (or `drawn`) and the signer is the person signed in.

`auth.service.ts` routes an all-vendor member to `/vendor-portal` at login, and
the frontend now knows that route (`KNOWN_ROUTES` in `login/page.tsx`,
`BARE_ROUTES` in `app-frame.tsx`) — before this phase such a login landed in the
staff app.

## Not here yet (phases)

5. **Assignments** — linking a contractor to a project or requirement. Bills are
   raised by hand today; with assignments they can be drafted from who worked
   where, and project cost attribution becomes possible.

Agreement fields (`VendorAgreementField`) and the signature record deliberately
match the client-side shapes, so the frontend PDF field designer and signature
pad serve both. Attaching the PDF itself and flattening a signed copy reuse
`document_files`, and land with the portal.

## Tests

- `features/vendor-portal.feature` — 9 scenarios covering the portal end to end,
  including the security ones: a staff email can't become a vendor login, a
  portal user holds no staff access, reaches nothing of another vendor, sees no
  drafts, can't set a rate, and loses the portal when access is revoked. The
  portal service is covered by these rather than by unit tests — its whole job
  is the scoping, which only a real request exercises.
- `vendor-bills.service.spec.ts` — 21 unit tests: computed totals and rounding,
  the number collision retry, cross-vendor lines, state guards, payment dates,
  and the cost-summary maths.
- `features/vendor-bills.feature` — 9 scenarios: raising and totalling a bill,
  the rejected client-supplied amount, approve → pay, paying before approval,
  cancelling, the cost summary, the permission split, and cross-org isolation.
- `vendor-agreements.service.spec.ts` — 22 unit tests: template copying, which
  templates apply, backdated/future signing dates, expiry, void vs delete, and
  the onboarding sync (including leaving a suspended vendor alone).
- `features/vendor-agreements.feature` — 8 scenarios: issue-required, the copied
  text surviving a template rewrite, recording a signature clearing the vendor,
  signed agreements being records, category targeting, expiry, the permission
  split, and cross-org isolation.
- `vendors.service.spec.ts` — 19 unit tests: dedup, trimming, currency casing,
  onboarding stamping, cascade delete, primary-contact exclusivity, skill filter,
  stats maths, list counts.
- `features/vendors.feature` + `vendors.e2e-spec.ts` — 10 scenarios over a real
  Postgres: CRUD, the permission gates (no grant → 403; `vendors:view` reads but
  cannot create), cross-org isolation, cascade delete, and the check that a
  contractor never becomes an org member.
