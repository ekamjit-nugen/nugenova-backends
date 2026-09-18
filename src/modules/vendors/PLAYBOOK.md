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

GET    /vendors/:id/employees                list (status, q, skill)
POST   /vendors/:id/employees                add contractor (duplicate email per vendor → 409)
PATCH  /vendors/:id/employees/:employeeId
DELETE /vendors/:id/employees/:employeeId
```

## Onboarding status

`invited` → `agreements_pending` → `active` → (`suspended`). `onboardedAt` is
stamped the first time a vendor reaches `active` and never moved again, so a
vendor that is suspended and reinstated keeps its original onboarding date.
Nothing enforces the sequence yet — agreements (Phase 2) will drive it.

## Not here yet (phases)

2. **Agreements** — templates, e-signature and document clearance, reusing
   `client_agreements` / `client_agreement_templates` and the PDF field designer.
3. **Bills** — vendor bills with line items per contractor, draft-from-assignment,
   approve and mark-paid. The platform has no invoice/payment model at all today,
   so this is a new subsystem rather than a port.
4. **Vendor portal** — `role='vendor'` logins. `auth.service.ts` already routes an
   all-vendor member to `/vendor-portal`, but the frontend has no such route
   (`KNOWN_ROUTES` in `login/page.tsx`, `BARE_ROUTES` in `app-frame.tsx`), so a
   vendor login currently lands in the staff app. Fix those two arrays with the
   portal.
5. **Assignments** — linking a contractor to a project/requirement, and the cost
   summary that reads from it.

## Tests

- `vendors.service.spec.ts` — 19 unit tests: dedup, trimming, currency casing,
  onboarding stamping, cascade delete, primary-contact exclusivity, skill filter,
  stats maths, list counts.
- `features/vendors.feature` + `vendors.e2e-spec.ts` — 10 scenarios over a real
  Postgres: CRUD, the permission gates (no grant → 403; `vendors:view` reads but
  cannot create), cross-org isolation, cascade delete, and the check that a
  contractor never becomes an org member.
