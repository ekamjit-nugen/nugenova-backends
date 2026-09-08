---
module: ai
title: AI Runtime (LLM provider abstraction + credit metering)
owner: platform
status: live
phase: 1
migratedAt: 2026-09-08
source: nexora-api/src/modules/ai + src/common/llm/llm-endpoint.ts
---

# AI Runtime

The platform's **one seam for every LLM call** plus the **AI-credit metering**
that §15 bills against. Ported from the legacy Mongo `ai` module + the
`common/llm/llm-endpoint.ts` helper to Postgres/TypeORM. Backend only.

Two halves:

1. **Provider abstraction** — every completion goes through an `LlmProvider`
   (`complete(messages, opts) → text + normalised token usage`). The live
   adapter is chosen by env and injected under the `LLM_PROVIDER` token, so call
   sites never know the vendor and specs bind a stub (no live API call in tests).
2. **Credit metering (§15)** — each call is written to an append-only **event
   ledger** and folded into a per-org/period **counter** (the "balance" a tier
   ceiling is compared against).

Person = `User` + `OrgMembership` (`userId` is the auth id). Every endpoint is
JWT-guarded and org-scoped; the acting org/user come from `req.user` only.

## Why it changed from the legacy module

The legacy module was hard-wired to a single **RunPod/vLLM** OpenAI-compatible
endpoint (`llm-endpoint.ts`) and stored usage in Mongoose with `costUsd: null`
(self-hosted → tokens only). The port:

- replaces the single-endpoint helper with a **pluggable `LlmProvider`**
  (Anthropic default, OpenAI-compatible, Ollama/local), selected by env;
- makes the Mongoose usage schemas **TypeORM entities** on Postgres;
- **estimates a USD cost** per call (the default provider, Claude, is hosted +
  per-token-priced) via a one-file price table;
- adds a **tier-ceiling / consent policy seam** (`AI_POLICY`) checked before
  every call — a no-op today, real check merges from `feat/lms-p0`.

Streaming, tool use, RAG and the many per-feature prompt helpers of the legacy
`AiService` (project plans, onboarding structure, …) are intentionally **not**
ported here — see **Deferred**.

## Provider abstraction

- `providers/llm-provider.ts` — the `LlmProvider` interface, message/usage
  types, `LLM_PROVIDER` DI token.
- `providers/anthropic.provider.ts` — **default**. Claude Messages API
  (`POST /v1/messages`), `x-api-key` + `anthropic-version`, system prompt split
  out of the messages array. Maps `usage.input_tokens/output_tokens`.
- `providers/openai.provider.ts` — OpenAI **Chat Completions** shape; also the
  path for any OpenAI-compatible gateway (Azure, the legacy RunPod/vLLM
  endpoint, OpenRouter) via `OPENAI_BASE_URL`.
- `providers/ollama.provider.ts` — local/self-hosted (`POST /api/chat`), no
  auth, zero marginal cost.
- `providers/llm-provider.factory.ts` — builds the one live adapter from env and
  binds it to `LLM_PROVIDER`.

All adapters use **global `fetch`** (Node ≥18), matching how `MailService` calls
ZeptoMail — **no axios / vendor SDK dependency** was added. **Network I/O lives
only inside `complete()`**, so unit specs bind a fake provider to the token and
never hit the wire.

### Config / env

| Env | Meaning | Default |
| --- | --- | --- |
| `AI_PROVIDER` (or legacy `CHATBOT_LLM_PROVIDER`) | `anthropic` \| `openai` \| `ollama`/`local` | `anthropic` |
| `AI_MODEL` | force a model for the active provider | per-provider default below |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL` | Anthropic | model `claude-sonnet-5` |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` | OpenAI/compatible | model `gpt-4o-mini` |
| `OLLAMA_MODEL`, `OLLAMA_BASE_URL` | Ollama | model `llama3.1`, url `http://localhost:11434` |

**Default model ids** (`providers/llm-config.ts`, all named constants):

- Anthropic default **`claude-sonnet-5`** — the balanced current Claude for
  high-volume org features (chat/summarise/drafting): strong quality at ~½ the
  token price of Opus. Set `AI_MODEL=claude-opus-5` for the most capable current
  model or `claude-haiku-4-5` for the cheapest. These are the current-generation
  ids from the bundled claude-api reference (cached 2026-06); a newer id is a
  one-line bump in `llm-config.ts` + a price row in `model-pricing.ts`.
- OpenAI default **`gpt-4o-mini`**, Ollama default **`llama3.1`** — **best-effort
  ids, verify** (see **Landmines**).

## Credit-metering model (§15)

- **`ai_usage_events`** (`AiUsageEventEntity`) — append-only ledger, **one row
  per call**: `organizationId`, `userId`, `feature` (purpose), `provider`,
  `model`, `promptTokens`/`completionTokens`/`totalTokens`, `costUsd` (est.),
  `streamed`, `status` (`success`|`error`), and `prompt`/`output` (full audit
  text for §09). Indexed by (org, createdAt), (org, user), (org, feature).
- **`ai_usage_counters`** (`AiUsageCounterEntity`) — pre-aggregated rollup, **one
  row per (org, period)** where `period` is `YYYY-MM` (UTC). Holds the running
  token totals, est. `costUsd`, and `requestCount` — the O(1) **balance** a tier
  ceiling / credit allowance is compared against. **Unique (org, period)**, which
  is the `ON CONFLICT` target for the atomic upsert-increment.
- `AiUsageService.record(...)` writes the event AND increments the counter with
  an atomic `INSERT … ON CONFLICT (org, period) DO UPDATE SET x = x + EXCLUDED.x`
  (parallel calls never lose a write). It is **best-effort / never throws** —
  usage logging must not break an AI response — and **skips calls with no
  `organizationId`** (attribution is per-org).
- **Cost is an estimate**, not billing truth. `providers/model-pricing.ts` keeps
  USD/1M input+output prices in ONE table; an unknown model falls back to a
  mid-range price (flagged, never dropped). Token counts remain the record.

`bigint`/`numeric` columns come back as **strings** from TypeORM — the read path
(`getOrgBalance`/`getOrgSeries`) coerces with `Number()`. Keep that.

## Endpoints (`/api/v1/ai`, JWT-guarded, org-scoped)

- **`POST /ai/complete`** — run a completion through the active provider, meter
  it, return `{ text, provider, model, usage }`. Body: `messages[]` (1–100,
  role+content), optional `model`, `temperature` (0–2), `maxTokens` (1–8192).
- **`GET /ai/usage`** — the caller's org AI-credit **balance** for the current
  (or `?period=YYYY-MM`) month + the full monthly **series**. Org comes from the
  JWT, never the client, so one tenant can't read another's usage.

`AiService.complete()` is the exported entry point other modules use (with a
`feature` tag) — e.g. `AiService.summarize()` demonstrates the pattern.

## Tier-ceiling / consent seam (the deferred gate)

`AiService.complete()` calls `AiPolicy.check(ctx)` **before** every provider
call. The interface + `AI_POLICY` token live in `policy/ai-policy.ts`; the module
binds the default **`AllowAllAiPolicy`** (permits everything).

> **TODO(feat/lms-p0):** the vertical-pack `aiTierCeiling` and the guardian
> `isConsented` gate live on branch `feat/lms-p0` and **cannot be imported
> here** yet. When that merges, bind a **real** `AiPolicy` to `AI_POLICY` in
> `ai.module.ts` that (a) consults `aiTierCeiling` + guardian consent and (b)
> enforces per-period token/credit ceilings by reading `AiUsageService`
> counters. **No `AiService` change is needed** — the call site already exists,
> a deny already returns HTTP 403, and the e2e `@policy` scenario already pins
> it (by forcing the stub to deny).

## Isolation (the #1 rule)

Every read/write is scoped to `organizationId` (from the trusted JWT). A member
can only ever read/spend against **their own** org's ledger; `GET /ai/usage`
takes the org from `req.user`, never the body. Covered by the `@security` e2e
scenario.

## Tests

- **Unit** (`npx jest src/modules/ai`, **19 tests, green**): `ai.service.spec`
  (policy gate allow/deny, provider invoked, success+error recorded, overrides
  passed, safe error message), `ai-usage.service.spec` (event write + atomic
  counter increment, cost math, no-org skip, never-throws, string coercion),
  `model-pricing.spec` (cost math + fallback + clamp), `ai-policy.spec` (default
  allows).
- **Gherkin + e2e** (`features/ai.feature`, `features/ai.e2e-spec.ts`) —
  **typecheck only, NOT executed** in this port (per instructions). The e2e
  **spies on the wired `LLM_PROVIDER` + `AI_POLICY` singletons** (`app.get(...)`
  then `jest.spyOn`) so no live LLM call is made; auth/org-scoping/metering/DB
  run for real if ever executed.

## Deferred (what COMPLETE AI still needs)

- **Wire the tier ceiling + guardian consent** — bind a real `AiPolicy` once
  `feat/lms-p0` merges (see the seam above).
- **Credit top-up / billing** — the counters are consumption only; no
  allowance/top-up/reset ledger yet, and `costUsd` is an estimate, not invoiced.
- **Streaming (SSE)** responses — the legacy `chatStream` + record-once-on-any-
  end logic is not ported; the `streamed` column + interface are reserved for it.
- **RAG doubt-tutor + generative narratives (§09)** — retrieval, prompt
  templates, and the per-feature helpers (project plan, onboarding structure,
  milestones) from the legacy `AiService`.
- **Model-routing for cost** — pick model per feature/tier (cheap model for
  bulk, capable model for hard tasks); the seam is `opts.model` + the price table.
- **Prompt/response audit logging per §09 guardrails** — `prompt`/`output` are
  already captured on every event; the review/redaction/retention surface over
  them is not built.
- Swap adapters to the **official `@anthropic-ai/sdk` / `openai`** clients if a
  dependency is acceptable (adds thinking, tool use, structured outputs).

## Landmines

- **Model ids drift.** The Anthropic defaults are current per the claude-api
  reference; **OpenAI/Ollama default ids are best-effort — verify** against the
  vendor's current list before relying on cost/behaviour. All ids are named
  constants in `llm-config.ts`; prices in `model-pricing.ts`. Bump both together.
- **`costUsd` is an estimate** (list price, non-batch, non-cached). Do not treat
  it as invoiced spend; token counts are the source of truth.
- **`record()` swallows errors by design** — a metering failure must never break
  a response. Watch the logs (`AiUsageService`) for silent drops.
- **`numeric`/`bigint` read back as strings** — always `Number()` them (the read
  path already does).
- **New migration ordering** — this migration is `1788090000000`; the timestamp
  must exceed every existing one AND be registered in **both** arrays of
  `test/global-setup.ts` (entities + migrations), or CI's fresh DB lacks the
  tables. Already done.
- **No live API calls in specs** — always mock the `LLM_PROVIDER` token (unit) or
  spy the singleton (e2e). Never let a spec reach a provider's `complete()`.
