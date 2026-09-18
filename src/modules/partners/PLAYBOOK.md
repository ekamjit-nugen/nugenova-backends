# Partners

The companies an org works with, on either side of the delivery relationship:

- **client** — we supply people *to* them;
- **vendor** — they supply people *to* us.

Everything else the two need is the same — profile, contacts, portal access,
documents, agreements — so they are one table with a `category`, not two tables
that drift apart. The category is chosen when the partner is added and never
changes: it decides which way people flow, and the children are built on it.

## How the merge works

`partners` is a single table with TypeORM **single-table inheritance**:

```
PartnerEntity        @Entity('partners') + @TableInheritance('category')
  ClientEntity       @ChildEntity('client')   — adds `industry`
  VendorEntity       @ChildEntity('vendor')   — adds serviceCategory, taxId,
                                                currency, onboardingStatus,
                                                onboardedAt, timeTrackingEnabled,
                                                billingAddress
```

That is what made the merge cheap: a child repository adds `category = '…'` to
every query on its own, so `ClientsService` and `VendorsService` kept working
unchanged — a client repository can never return a vendor, and vice versa. Reads
across both go through the base `PartnerEntity` repository.

**Writes must go through a child repository** — that is what sets the
discriminator. `PartnersService.repoFor(category)` does this; saving a new row
through the base repository would leave `category` null.

The migration (`1788590000000-Partners`) copies `clients` and `vendors` into
`partners` keeping their ids, so every child row — documents, agreements, bills,
tickets, board shares, assignments, contacts — still resolves untouched. It
refuses to run if an id exists in both tables, and renames the old tables to
`clients_premerge` / `vendors_premerge` rather than dropping them, so there is a
way back while the merged code settles.

## Routes

```
GET   /partners                 both sides (?category=client|vendor, status, q, tag)
GET   /partners/stats           totals: clients, vendors, active, portals open
GET   /partners/:id
POST  /partners                 category chosen here, once
PATCH /partners/:id             the shared profile fields
```

`/clients/*` and `/vendors/*` are unchanged and still the place for what differs:
bills and supplied people on a vendor; tickets, shared boards and the delivery
team on a client.

## Permissions

There is no `partners` resource. A client row needs `clients:<action>`, a vendor
row needs `vendors:<action>` — so an existing role keeps exactly the access it
had. Listing needs either, and a role granted only one side sees only that side
(tested). It also means the two sides can stay on separate permissions for orgs
that want that.

## Shared vs category-specific

| | Client | Vendor |
|---|---|---|
| Profile, contacts, portal, documents, agreements | shared | shared |
| Direction of people | delivery team we assign (`client_assignments`) | contractors they supply (`vendor_employees`) |
| Extras | tickets, shared boards | bills, onboarding clearance |
| Sector wording | `industry` | `serviceCategory` — both read as `sector` in the partner view |

## Contacts

`partner_contacts` is merged the same way, with `ClientContactEntity` and
`VendorContactEntity` as the children. One wrinkle: the two services still name
the owning company differently in code (`clientId` / `vendorId`), so both columns
exist and each child maps its own. **`partner_id` is a Postgres generated column
over the pair** (`COALESCE(client_id, vendor_id)`), which is what a combined query
reads — the partner list counts contacts through it without caring which side a
company is on. When the services move to the shared name, the two columns
collapse into that one.

## Secondary members

A contractor a vendor supplies can be brought into the org:
`POST /vendors/:id/employees/:employeeId/promote` creates a membership with
`personType = 'vendor'`, `vendorId` and `vendorEmployeeId`. They then appear in
the Directory (`GET /org/members?includeSecondary=true`) badged "Supplied by
<vendor>", so everyone can see who is working here.

`personType` is what makes this safe: payroll, the attendance roster, seat
counts, leave and the notifier all run through `staffScope()`, which is
`personType = 'staff'` — so a secondary member is invisible to every one of them
by construction rather than by remembering to filter. The plain
`GET /org/members` is unchanged and still staff-only.

Two rules worth keeping:

- **An email is required.** A membership hangs off a user record; without one
  there is nobody to be a member.
- **A contractor is not a portal user.** `vendorIdForUser` refuses a membership
  carrying `vendorEmployeeId`: the vendor portal is the vendor's own office, and
  a contractor we host would otherwise see their bills and agreements. Tested.

`DELETE` on the same path takes them back out — the membership goes inactive and
their record at the vendor is untouched.

## Still to come

1. Documents, agreements and the portal move onto partner ids in name as well as
   value.
2. A partner detail page rendering the shared tabs plus the category-specific
   ones, replacing the two detail pages.
3. Retire `/clients` and `/vendors` once the UI is on partners, and drop the
   `_premerge` tables.

## Tests

`features/partners.feature` — 8 scenarios: adding either side, the category
filter, the category being fixed for life, the same name allowed on both sides
but not twice on one, one `sector` field covering both wordings, contacts counted
from the merged table and still invisible across the two sides, a role granted
one side seeing only that side, and cross-org isolation.

The existing client and vendor suites (75 scenarios) pass unchanged against the
merged tables — that is the check that matters for these phases.
