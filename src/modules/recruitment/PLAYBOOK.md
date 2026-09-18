---
module: recruitment
title: Recruitment (ATS) — candidates, CVs, pipeline, interviews & offers
owner: people
status: live
phase: 1
migratedAt: 2026-09-14
source: new module (replaces the team's "Candidates List.xlsx" + Google Drive CV links)
---

# Recruitment (ATS)

The hiring workspace. The team sources candidates on **Cutshort** (plus Naukri,
LinkedIn, referrals) and used to track them in an Excel sheet per role with CVs
pasted as Drive links. This module keeps one rich profile per person, stores CVs
in the platform (S3) and shows them in the portal, and runs every opening
on a stage pipeline with interviews, scorecards, offers and an onboarding handoff.

**Wording:** an *opening* is shown in the app as a **Category** (the team's sheets are capabilities: Data Engineer, SAP, DevOps…). Tables, routes, DTOs and payload fields keep `opening`; only the labels and user-facing messages say category.

**Counts:** a tile shows **one** number with the unit spelled out, never `a / b`. People and *category entries* are different things — one person can sit in several categories — so a number that counts entries says so (the funnel and Category health), and everything else counts people. Every count is a link to the list that produces it: KPI tiles carry `href`, funnel stages open `/recruitment/candidates?pool=pipeline&stageId=…`, client-submission numbers open `/recruitment/submissions?status=…`, and "Feedback due" opens `/recruitment/interviews?scope=all&tab=todo`. When a count and its list are computed in different places, keep the windows identical — `InterviewsService.FEEDBACK_WINDOW_DAYS` matches the interviews page's `LOOKBACK_DAYS`, covered by an e2e scenario.

## Entities (migration `1788430000000-Recruitment`)

| Table | Purpose |
|---|---|
| `recruitment_openings` | A role being hired for: title, code, location, work mode, experience + budget band, positions, skills, JD, hiring manager, recruiters, status (draft/open/on_hold/closed/filled), priority, target date, scorecard template. |
| `recruitment_stages` | Org-wide pipeline, seeded from `DEFAULT_STAGES` (Sourced → Screening → Shortlisted → Interview → Final Round → Offer → Hired / Rejected). `kind` = active/hired/rejected. |
| `candidates` | One row per person: contact (email/phone normalised to `email_norm`/`phone_norm`, **unique per org**), experience in months, company/designation, CTC current/expected, notice (days + status), education[] and workHistory[] (jsonb), skills, links, source + detail, legacy CV link, tags, rating, owner, status, consent. A generated **`search_tsv`** (GIN) powers full-text search over the profile (the legacy `ai_summary`/`resume_text` columns are no longer written). |
| `candidate_documents` | CV versions (one primary), cover/offer letters, ID proofs — `fileId` from `/media/upload`, version, primary flag (the legacy text/parse columns are no longer written). |
| `candidate_applications` | Candidate × opening (unique while not deleted): stage, status (active/hired/rejected/withdrawn), rejection reason, owner, timestamps. |
| `application_stage_events` | Append-only stage trail → funnel, time-in-stage, time-to-hire. |
| `recruitment_interviews` | Rounds: type, time, duration, interviewer ids (GIN), meeting link or built-in meeting id, criteria, status, reminder stamp. |
| `recruitment_interview_feedback` | One scorecard per interviewer per interview: 1–5 per criterion, overall, recommendation, strengths/concerns. |
| `recruitment_scorecard_templates` | Reusable criteria lists (one default, seeded on first read). |
| `candidate_offers` | Designation, CTC, joining/expiry, letter file, status (draft → sent → accepted/declined, or revoked), membership id after handoff. |
| `candidate_activities` | Candidate timeline: manual notes/calls/emails/WhatsApp + system entries (stage changes, interviews, feedback, offers, documents). |
| `recruitment_settings` | Per org: rejection reasons, suggested tags, feedback-reminder hours. |

The migration also appends `recruitment` (all actions) to existing `owner`,
`admin` and `hr` role rows; new orgs get it from `default-roles.ts`.

## Access — `RecruitmentAccessGuard`

- Tenant isolation + suspended/consent lifecycle gate (mirrors Leave/Attendance). Client-portal users are refused.
- `@RequirePermission('recruitment', action)` routes: owner/admin, or a role granting the action.
- **Undecorated = interviewer surface**: `GET /interviews` (scope=mine), `GET /interviews/:id`, `POST /interviews/:id/feedback`, `GET /candidates/:id`, `GET /candidates/:id/documents/:docId/access`, `GET /stages`, `GET /scorecards`. The service checks the caller is on that interview panel (404 otherwise). The candidate view is then `access: 'interviewer'`: no notes, offers or other documents.
- Interviewers see colleagues' scorecards **only after submitting their own**.
- **Salary figures** (candidate CTC, offer CTC, opening budget) are returned only with `recruitment:edit`.
- Every CV open (`…/access`), export and import writes to the org **Activity** feed (`category: recruitment`).
- Owners / interviewers / hiring managers must be active **staff** members.

## CVs (`CandidateFilesService`) — no AI, nothing read from the file

Recruitment uses **no AI**. A CV is stored and shown exactly as uploaded; profile details are typed in by the team.

1. `/media/upload` → `POST /candidates/:id/documents {fileId, kind: 'resume'}` (edit) adds a new **version** and makes it primary; `POST …/:docId/primary` switches back; `DELETE …/:docId` removes one (the newest remaining CV becomes primary). `POST /candidates/from-cv {fileId, data}` (create) creates a candidate with typed-in details and the CV, or attaches it to `candidateId` (edit; fills blanks unless `overwrite`). File must belong to the caller's org.
2. **Viewing in the portal:** `GET /candidates/:id/documents/:docId/file` streams the bytes inline (PDF/images render in the browser) and `GET …/preview` returns `{kind:'html', html}` for Word files (mammoth → HTML, shown in a sandboxed frame) or `{kind:'file'}` otherwise. Both use the same access as the profile (recruitment view, or an assigned interviewer for CVs only) and are audited as `recruitment.document_viewed`.
3. Cutshort file names (`Cutshort-<Name>-…`) set `source = cutshort`; duplicates are checked on the typed-in email/phone/name.

## Spreadsheet import (`POST /candidates/import`)

The frontend maps columns (auto-detected for the legacy sheet) and sends rows; all clean-up is server-side (`recruitment.utils.ts`, unit-tested):
"—"/N/A → blank · "5+ years" → 60 months · "Immediate Joiner" → 0 days/immediate · `[Role] Source: X; Notice period not mentioned` → opening + source detail (boilerplate dropped, real notes become a timeline note) · company date ranges stripped · sheet name → opening (created if missing) · people merged across sheets by email → phone → contact-less exact name (blanks filled, larger experience kept) · `dryRun: true` previews without writing.

Optional `Lead` / `Requirement` columns shortlist the row against a Sales lead (matched by company/name and requirement role/title); rows with no opening and no lead land in the **talent pool**. The preview flags duplicates per row (`duplicate: { kind: existing|file, action: merged|flagged, matchedOn }`): email/phone matches merge, a name-only match is **flagged** (created separately — review and merge), repeats inside the file merge into the earlier row. Summary adds `submissions`, `talentPool`, `duplicatesMerged`, `duplicatesFlagged`. The downloadable template (`buildImportTemplate` in the frontend) has Candidates / Instructions / Reference sheets.

## Background imports (migration `1788460000000-RecruitmentImportJobs`)

The UI previews synchronously (`POST /candidates/import` with `dryRun`, ≤ 5,000 rows per call, set-based lookups — no per-row queries) and commits through a **background job**:

- `POST /imports` → **202** at once. Stores the job + every mapped row (`recruitment_import_jobs`, `recruitment_import_rows`), ≤ 10,000 rows. The wizard sends an `idempotencyKey` per preview; a double-click, retry or second tab gets the same job back (partial unique index).
- **Worker** (`ImportJobsService`, every API instance): claims the oldest ready job with `FOR UPDATE SKIP LOCKED` under a transaction advisory lock, **one running job per organization**. Rows are saved one at a time with the same `ImportExportService.processRow` the preview uses; counters are recomputed from the row table every 25 rows (exact and restart-safe) and double as the heartbeat. A job whose heartbeat is older than 90 s is resumed by any instance; in-file identity is rebuilt from saved rows so resumed jobs don't duplicate people. Rows that crash the worker 3× are set aside as errors; a job interrupted 5× fails (retry continues from the last saved row). Env: `RECRUITMENT_IMPORT_WORKER=off` disables the worker on an instance, `RECRUITMENT_IMPORT_POLL_MS` (default 5000).
- `GET /imports` (running + last 7 days, not dismissed), `GET /imports/:id`, `GET /imports/:id/rows?filter=issues|skipped|error|flagged|all`, `POST /imports/:id/cancel|retry|dismiss`. Cancel/retry: the starter (with create) or a recruitment editor. Notification `recruitment_import_finished` to the starter; audit events `recruitment.import_*`.
- **Wrong data is never imported.** `ImportExportService.rowIssue` (pure) decides per row, and the same check runs in the preview, in the worker and as a pre-flight on `POST /imports`. A row is ignored, with the reason shown, when: it has no name; the name cell is a sheet note/total/banner (`looksLikeSheetNote`); any supplied email, phone, CV link or LinkedIn is invalid (the row is never saved half-filled); or nothing identifies the person (no email, phone, CV link or LinkedIn).
- **Bad files are refused whole:** `POST /imports` returns 400 when no row is usable, or when ≥ 25% of rows (`BAD_FILE_RATIO`) carry wrong or missing data, naming the first few rows to fix. The preview blocks the Import button on the same rule. Summary/master/generic sheets never become openings (frontend), and opening find-or-create is serialised with an advisory lock.
- Dashboard shows each file with a segmented bar (new / merged / ignored / failed), ETA, stop / retry / review rows / dismiss; the import page shows the same card and can be left while it runs.

**Database connections:** Supabase's session pooler caps clients for the whole project. The per-process pool is `DB_POOL_MAX` (default 5) with idle release and a connect timeout; the importer never holds one connection while waiting for another.

## Client leads & submissions (migration `1788440000000-RecruitmentLeadSubmissions`)

A **Sales lead** is client demand; its `sales_requirements` (now with `positions`) are the roles. Recruiters work leads from Recruitment without touching the Sales timeline (commit 977cac7 keeps system rows out of `sales_activities`).

- `recruitment_submissions` — one row per candidate × lead × requirement (partial unique index; 409 `DUPLICATE_SUBMISSION`). A candidate can run in **many leads at once, each with its own status**. Status machine (`submission-rules.ts`, unit-tested): `shortlisted → submitted → client_screening → client_interview → client_selected → onboarded`, side exits `on_hold`, `client_rejected`/`withdrawn` (reason required). Every change writes `recruitment_submission_events`, a candidate timeline entry and an org audit row; lead owner is notified.
- First submission moves the requirement `open → in_progress`; onboarded count ≥ `positions` marks it `fulfilled`.
- Client interviews: `POST /interviews { submissionId }` creates a `kind: 'client'` round and advances the submission to `client_interview`.
- Money: lead value, requirement rate/amount, submission cost and margin are hidden without `recruitment:edit`.
- An opening can be raised from a requirement (`openings.lead_id/requirement_id`, 409 `OPENING_EXISTS`).
- **Talent pool** (`POOL_SQL`): `unassigned` (no active application or submission), `pipeline`, `submitted`, `placed`.
- **Matching** (`matching.ts`, deterministic): skills 60 (aliases), experience 20, notice vs needed-by 10, location 10; blacklisted/archived excluded; each result carries `reasons[]`. Suggestions ≥ 40, dashboard "pool matches" ≥ 60.

## Pipeline behaviour

- Moving to a `rejected` stage **requires a reason**; hired/rejected set status + timestamps; every move writes a stage event + timeline entry and notifies the application owner, candidate owner and hiring manager.
- When hires reach `positions`, an `open` opening flips to `filled`.
- Offer `sent` auto-moves the card to a stage named "Offer" (if earlier in the flow); `accepted` moves it to the first hired stage.
- **Handoff**: the UI creates the employee through `POST /org/members` (Directory create permission), optionally starts `POST /onboarding/lifecycle/initiate`, then `POST /offers/:id/handoff {membershipId}` links the hire.
- Interviews can create a built-in **Meetings** room for the panel (kept in sync on reschedule/cancel). A cron (`*/30 * * * *`) nudges interviewers whose scorecard is overdue by `feedbackReminderHours` (0 = off), once per interview.

## REST — `/api/v1/recruitment` (JWT, org-scoped)

- Candidates: `GET /candidates` (q, openingId, stageId, applicationStatus, source, status, ownerId, expMin/expMax years, noticeMax, location, skills, tags, hasResume, updatedSince, sort, order, page, limit) · `GET /candidates/export` · `GET /candidates/duplicates` · `POST /candidates/import|from-cv|merge|bulk` · `POST /candidates` · `GET/PATCH/DELETE /candidates/:id` · documents `POST /candidates/:id/documents`, `GET …/:docId/access|file|preview`, `POST …/:docId/primary`, `DELETE …/:docId` · timeline `POST /candidates/:id/activities`, `DELETE …/:activityId`.
- Openings: `GET/POST /openings`, `GET/PATCH/DELETE /openings/:id`, `GET /openings/:id/board`.
- Applications: `POST /applications`, `POST /applications/bulk-move`, `PATCH /applications/:id/move`, `PATCH/DELETE /applications/:id`.
- Interviews: `GET/POST /interviews`, `GET/PATCH/DELETE /interviews/:id`, `POST /interviews/:id/feedback`.
- Offers: `GET/POST /offers`, `PATCH/DELETE /offers/:id`, `POST /offers/:id/status`, `POST /offers/:id/handoff`.
- Settings: `GET /stages`, `POST /stages`, `PUT /stages/order`, `PATCH/DELETE /stages/:id`, `GET/PATCH /settings`, `GET/POST /scorecards`, `PUT/DELETE /scorecards/:id`, `GET /people`.
- Talent pool & matching: `GET /candidates?pool=`, `GET /candidates/pool-counts`, `GET /candidates/:id/suggestions`, `GET /matches?openingId=|requirementId=`.
- Client leads: `GET /leads`, `GET/PATCH /leads/:id`, `POST /leads/:id/move`, `POST/PATCH/DELETE /leads/:id/requirements[/:reqId]`, `POST /leads/:id/requirements/:reqId/opening`, `POST /leads/:id/followups`, `PATCH /leads/:id/followups/:followupId`, `POST /leads/:id/notes`, `POST/DELETE /leads/:id/documents[/:docId]`.
- Submissions: `GET/POST /submissions`, `POST /submissions/bulk`, `GET/PATCH/DELETE /submissions/:id`, `PATCH /submissions/:id/move`.
- Dashboard: `GET /analytics?days=&openingId=` — totals, funnel (reached per stage), time in stage, sources, rejection reasons, 6-month trend, openings health, recruiter activity, stale candidates, upcoming interviews.

## Notifications & events

`recruitment_candidate_assigned`, `recruitment_stage_changed`, `recruitment_interview_scheduled`, `recruitment_interview_cancelled`, `recruitment_feedback_due`, `recruitment_feedback_submitted`, `recruitment_offer_accepted`, `recruitment_submission_created`, `recruitment_submission_decision` (catalogued, per-user controllable). Domain events: `candidate.created`, `application.stageChanged`, `candidate.hired`, `submission.created`, `submission.statusChanged`.

## Frontend

`/recruitment` dashboard · `/recruitment/candidates` (search, filters, bulk actions, Excel export) · `/recruitment/candidates/[id]` (profile, pipeline stepper, interviews + scorecards, offers + handoff, CV viewer with versions, documents, timeline, merge duplicates) · `/recruitment/candidates/upload` (bulk CV upload: view each CV beside a short form) · `/recruitment/candidates/import` (Excel wizard with preview) · `/recruitment/openings` + `/[id]` (drag-and-drop board, list, JD) · `/recruitment/interviews` + `/[id]` (panel view, scorecard) · `/recruitment/offers` · `/recruitment/settings` · `/recruitment/leads` (client leads list) + `/[id]` (workspace: stage, owner, requirements with a submission mini-board, find matches / submit / create opening, candidates, client interviews, follow-ups, notes, documents, timeline).
Candidates list has pool tabs and per-lead statuses; profiles have a **Client leads** tab and "Where they fit" suggestions; Upload CVs lets you choose Talent pool / Opening / Client lead and flags duplicates (existing by name/email/phone, and within the batch) before saving. Sample CVs live in `public/samples/` (regenerate with `node scripts/generate-recruitment-samples.mjs`). The Sales lead page shows a read-only Candidates panel.

## Tests

- Unit: `recruitment.utils.spec.ts` (normalisers), `services/candidate-files.service.spec.ts` (org isolation, Word preview), `matching.spec.ts` (scorer).
- e2e: `features/recruitment.feature` — search, duplicate guard, permission + cross-org isolation, CTC masking, rejection reason + stage trail, interviewer-only access + scorecards, Excel import dry-run/commit/merge, CV upload with typed-in details → viewable as stored (parse endpoint gone), offer → hired → opening filled + analytics, merge.
- e2e: `features/recruitment-team-access.feature` — recruiter CRUD end to end, CV versions (upload, new version, switch primary, remove) with byte-identical viewing, NUL-byte CV, create-with-CV, viewer read-only (403 on every write), employee 403 / other org 404, no AI usage recorded.
- e2e: `features/recruitment-leads.feature` — sample PDF/DOCX CVs view in the portal, submit + duplicate 409, full client path fills the requirement, client interview advances, 403/404/masking, talent pool, suggestions & matches, opening from requirement, import with Lead column, lead workspace edits, one candidate in 4 leads at different stages, import preview duplicate flags.

## Operations

- No AI provider is needed for recruitment.
- CV files follow `StorageService` (S3 when configured). The portal opens CVs through the recruitment `…/file` route (permission-checked and audited); the platform-wide `/media/files/:id` download is org-member scoped and not used for CVs.
- Data retention: candidates can be soft-deleted individually or in bulk; `consentAt` records consent when captured.
