# Hieronymus GEO Platform — Project Overview

## What this system does
An end-to-end GEO (Generative Engine Optimization) audit platform for Joe Shalita Consulting. Clients submit an intake form, and the system automatically generates AI-search prompts, runs those prompts against multiple AI engines to check brand citation, and produces a dashboard the client can view.

## One identity per customer
Every customer gets exactly one username + password, generated at creation in the Portal and never re-shown after that. That single credential pair is what the client uses to log into **all three** of their client-facing pages: `intake.html` (fill out/save the intake form), `prompt-review.html` (review/approve generated prompts), and `client-portal.html` (view their own dashboards). There is no separate credential system per page — this was a deliberate cohesiveness fix (previously each piece was drifting toward its own ad-hoc pattern).

## The workflow (in order)
1. **Portal (`portal.html`)** — Joe/Rene's internal control center. No explanatory header or numbered pipeline guide — it's an internal tool, not a walkthrough. "+ New Customer" opens a modal (company name + optional Claude/ChatGPT/Gemini API keys) — the New Customer form is not perpetually visible. Per-customer row actions: Copy/Open Intake Link, Copy/Open Review Link, Copy/Open Client Portal Link, "Open in Hieronymus →", toggle monthly monitoring, delete. **Generate Prompts and Run Audit are NOT in the Portal** — they live on the per-customer Hieronymus detail page (see below); the Portal only shows read-only status badges + live progress polling for whichever run is in flight.
2. **Intake form (`intake.html`)** — client-facing, username+password gated (same credential as the rest of that customer's pages). Client fills out company info, competitors, personas, etc. **Save** persists progress server-side via `netlify/functions/intake.js`, keyed by company — closing the link and coming back later (even a different day, different device) restores exactly where they left off. There is no JSON download/upload anywhere in this flow. No pre-filled example/placeholder text in any field.
3. **Prompt generation** — triggered from the per-customer page, handled server-side by `netlify/functions/generate-prompts-background.js` (a Background Function; the earlier `generate-prompts.js` name is gone) using the account-level `ANTHROPIC_API_KEY` env var, never entered in the browser. The modal asks for **count and language(s) only** — engine choice moved to Run Audit, because which engines to ask is a property of a run, not of a prompt set.

   It is a **three-stage pipeline**, and the staging is the point:
   - **Brief.** One call distils the intake into a searcher's-eye brief: category words real people use, place names, concrete failure symptoms, competitor names, job titles, near-verbatim customer questions — plus an explicit list of *forbidden facts* (years in business, awards, review counts, slogans) that a searcher could not know and must never appear in a prompt.
   - **Generate.** One call per category (5), from the brief only, never from the raw intake. Feeding the raw intake was the original defect: it produced prompts stuffed with company-only facts ("a company in Toluca with 38 years of experience"), bare keyword fragments, and symptoms with no equipment or place.
   - **Cold validation.** Every candidate is re-read *without* the brief and must pass four tests: self-sufficient with zero context, forces an answer to name companies, plausibly typed cold by a real person, correctly spelled and accented. Failures are rewritten or dropped. Deliberately blind — a validator holding the brief fills in the missing context itself and waves the prompt through.

   **The requested count is a commitment.** Generation over-produces ~1.6×; categories left short trigger up to three top-up rounds; validated surplus in one category fills a gap in another. Any residual shortfall is recorded in `stats` on the prompts record and surfaced on the customer page rather than being silent.
4. **Internal review, then customer review.** Two gates, in order.
   - **Internal release** — generated prompts are withheld from the customer until an Akore staff member reviews and releases them. Enforced in `prompts.js`, not the browser: the customer holds a working review link, so a gate that existed only in the page would be no gate at all. Staff review through `prompt-review.html` itself (the staff bypass), edit anything wrong, and click "Approve & release to customer"; edits save with the release. Regenerating sends a set back behind this gate.
   - **Customer approval (`prompt-review.html`)** — same login as intake. Grouped by category, editable, with comments. **Approval is one-way**: afterwards the prompts render read-only, the server refuses a second approval from a member account, and the client is returned to their portal. Staff can still revise and re-approve on a customer's behalf.

   Customer approval remains informational for Run Audit — Joe/Rene's judgment still takes priority over a hard gate. Internal release is not informational: it controls what the customer can see.
5. **Hieronymus audit engine** — triggered by "Run Audit" on the per-customer page, which opens a modal to choose engines for *this run* (only engines with a configured key are selectable) and states prompts × engines = rows before you commit. Runs entirely server-side (`netlify/functions/run-audit-background.js`, a Netlify Background Function). For each prompt: every active engine answers independently (company name withheld from the question sent to the engine, to avoid priming), then a single Claude call grades all of that prompt's answers together against the same rubric — "one engine doesn't grade its own homework." **This is the only place an audit ever runs** — there is no separate manual/browser-driven path anymore (see `index.html` below).
6. **Results storage** — each result row is its own Blob keyed by `run_id`, not a shared append-only file (a concurrent-write race was silently dropping rows). `GET /api/results` reconstructs the CSV. The audit writes rows **directly via `getStore()`**, not by POSTing to `/api/results` — that HTTP hop only existed for the old single-writer CSV, and keeping it forced the endpoint to accept unauthenticated writes, which let anyone inject fabricated rows into any customer's dataset. `POST /api/results` is now staff-only.

   **A fresh diagnostic run replaces the previous diagnosis** for that customer: its diagnostic rows are deleted first. Without that, re-running after regenerating prompts changed nothing on screen, because the diagnostic dashboard pins to the earliest snapshot it can see. Monitoring rows are never touched, and clearing is skipped on a resume.
7. **Dashboards** — two types, both reading live from `/api/results`, no separate "build" step needed:
   - **Diagnostic dashboard (`dashboard-diagnostic.html`)**: a single point-in-time snapshot. Note it pins to `BASELINE_DATE = DATES[0]`, the **earliest** diagnostic snapshot — which is why a diagnostic run now replaces the previous one. (This doc used to claim "latest run"; the code says earliest. Left as-is on purpose — see open items.)
   - **Monitoring dashboard (`dashboard-monitoring.html`)**: same prompts re-run over time, trended across every `snapshot_date`.
   - Both: no company picker (a dashboard is about one customer, and the picker let a viewer switch); the language filter offers only languages actually present in the run; the competitor leaderboard shows the top 25 with the rest combined into "Others", and the client's own brand always keeps a row at its true rank even below the cut.
   - **Brand names are canonicalised** before tallying, so "Bosch Rexroth", "Bosch Rexroth México" and "Bosch Rexroth S.A. de C.V." count as one competitor. Only legal-entity and geography tails are stripped — "Bosch" and "Bosch Rexroth" stay distinct. Splitting one company across rows was a numbers bug, not a cosmetic one: it divided that company's share of voice and inflated the client's position.
8. **Monitoring automation** — per-customer opt-in toggle in the Portal (`monitoringEnabled`, stored on the `intake-codes.js` record). `netlify/functions/monthly-audit-cron.js` is a Netlify Scheduled Function (`@monthly`) that lists opted-in customers with submitted intake + generated prompts, and triggers `/api/run-audit` for each — reusing the exact same background function from step 5, not a separate run path.
9. **Client-facing dashboard access (`client-portal.html`)** — same per-customer login again. A dashboard appears only when staff have **released** it: `diagnosisReleased` and `monitoringReleased` on the customer record, set from the per-customer page and independent of each other. Having audit data is not the same as being ready to show it, so until release the client sees a "being prepared" state. Every client-facing page carries a route home (logo and a back link); the intake form used to be a dead end.

## Per-customer detail page (`index.html`)
Originally "Hieronymus," the browser-driven manual audit tool with its own API-key text inputs typed straight into the page — **that original implementation has been retired** (deleted its client-side answer+grade pipeline and the `claude.js`/`chatgpt.js`/`gemini.js` edge-function proxies that only existed to serve it). `index.html` is now the **per-customer action page** (`?company=`): intake status (+ link to `intake-view.html`), a Prompts card with "Generate/Regenerate Prompts" (opens the same count/languages/engines modal previously on the Portal, now also including an **API Keys** sub-section — see Security below) and "Copy Review Link", an Audit status card with "▶ Run Audit" + live polling, a results table for that company, and links to both dashboards. **This is where Generate Prompts and Run Audit actually happen** — the Portal only lists customers and links here plus a few copy/open/delete actions.

## Key files
- `portal.html` — customer list/directory: create, copy/open links, monitoring toggle, delete, "Open in Hieronymus →"
- `index.html` — per-customer action page: generate prompts, set/update API keys, run audit, view results (see above)
- `intake.html` — client-facing intake form; username+password gated; save/resume server-side
- `prompt-review.html` — client-facing prompt approval page; same login as intake
- `client-portal.html` — client-facing dashboard access; same login again
- `intake-view.html` — internal-only read-only viewer of a customer's submitted intake responses
- `dashboard-diagnostic.html`, `dashboard-monitoring.html` — read live from `/api/results`, `?company=` deep-linkable
- `netlify/functions/intake-codes.js` — the customer registry: create (generates username=slug(company)+random password, returned once), login (GET by username+password, strips password from every response), list, mark-submitted + monitoring-toggle (PATCH), delete
- `netlify/functions/intake.js` — save/load full intake JSON per company (the same save-progress endpoint used by both the mid-fill "Save" button and the final submit)
- `netlify/functions/customer-keys.js` — stores each customer's 3 engine API keys. POST creates or updates (per-engine — a blank field leaves that engine's existing key untouched), settable at creation (Portal) or anytime after (Hieronymus's Generate Prompts modal → API Keys). Raw values are **never** returned by any request — GET returns only configured/not-configured booleans; the only place raw keys are ever read is server-to-server via `getStore()` inside `run-audit-background.js`
- `netlify/functions/generate-prompts-background.js` — three-stage prompt generation (brief → per-category → cold validation), Background Function, honours the requested count via top-up rounds, records `stats` and the `brief` on the prompts record
- `netlify/functions/prompts.js` — save/load prompts; withholds text until internal release; PATCH handles both the staff release and the (one-way) customer approval
- `js/results-auth.js` — the one place credentials are resolved for scoped endpoints (`resultsQuery`, `intakeQuery`, `apiQuery`, plus `homeHref`/`wireLogoHome` for navigation). Staff pages send staff credentials, client pages send that customer's login, dashboards try staff then fall back to the client session
- `netlify/functions/run-audit-background.js` — the one true audit-running implementation; Background Function, reads customer keys server-to-server, writes result rows via `/api/results`, tracks progress in a job-status Blob
- `netlify/functions/audit-job.js` — polling endpoint for live audit progress (used by both the Portal and the per-customer detail page)
- `netlify/functions/results.js` — per-row Blob storage, reconstructs CSV on GET
- `netlify/functions/monthly-audit-cron.js` — Scheduled Function, triggers `/api/run-audit` for monitoring-enabled customers
- `netlify.toml` — maps clean `/api/*` paths to the underlying `/.netlify/functions/*` files

## Which model does what
Three distinct jobs, deliberately on different models:
- **Prompt generation** (`generate-prompts-background.js`) — `claude-opus-5`. Writing convincingly human search queries is a judgment task, and generation is ~11 calls per run, so the tier costs almost nothing here.
- **Grading** (`run-audit-background.js`) — `claude-sonnet-5`. This is the call that *interprets* engine answers into the dataset; every dashboard number derives from it. `max_tokens` is generous because adaptive thinking shares that budget and a tight ceiling truncates the JSON.
- **Answering** (`run-audit-background.js`) — `claude-sonnet-4-6`, **deliberately pinned**. It simulates what a real person gets when they ask Claude, so changing it resets the monitoring baseline and makes this month incomparable to last. Change it only when you intend a new baseline.

## Storage
Netlify Blobs (`@netlify/blobs`, `getStore()`) throughout — not Google Sheets or Supabase. Revisit only if there's a reason to migrate off Blobs (e.g. needing relational queries or a non-Netlify host).

## Known technical constraints
- **A Background Function is capped at roughly 15 minutes by the platform.** That is not a value we configure, so no timeout setting makes a long run fit in one invocation. The run therefore **continues itself**: at ~11 minutes it stops before starting the next chunk and re-invokes itself from the next unprocessed prompt, carrying the engine selection and run type. Progress is accounted for the whole run, not per invocation. A continuation is allowed past the in-flight guard (the job it conflicts with is itself).
- **Outbound engine calls are bounded at 90s.** Node's `fetch` defaults to a 300-second headers timeout, so a wedged upstream request used to sit for five minutes; a few of those consumed the entire run budget. Timeouts and connection failures are retried; permanent quota errors fail fast.
- **`prompt_id` is positional** (`Q01`, `Q02`…). A regenerated prompt set reuses the same ids for different questions, so a monitoring customer whose prompts change should be treated as starting a **new baseline** rather than continuing the old trend.
- Regular Netlify functions have a ~10 second execution timeout — this is why the audit run is a **Background Function** (`run-audit-background.js`), not a regular one.
- Local `netlify dev`'s Blobs emulation has been observed to omit the `etag` on an existing blob (a dev-only gap, not seen in production) — `results.js` avoids depending on that path entirely by giving each row its own key rather than doing a shared read-modify-write.
- Netlify Scheduled Functions declare their cron via `export const config = { schedule: '@monthly' }` inside the function file itself, the same self-contained pattern already used by edge functions' `config.path` — no netlify.toml entry needed for the schedule itself.

## Security — per-customer data isolation
Every read endpoint is scoped server-side. This was not the original design: `/api/results`, `/api/intake`, `/api/prompts` and `/api/intake-codes` all answered anyone who named a company, and the dashboards filtered in the browser — so one customer's dashboard downloaded every other customer's data, and editing `?company=` in the URL showed a competitor's audit. **A client-side filter is not an access control.**

| Endpoint | Rule |
|---|---|
| `GET /api/results`, `/api/intake`, `/api/prompts`, `/api/intake-codes?company=` | Customer may read **only their own**, proven against the company they asked for; staff may read any |
| Listing forms (no `company`) | Staff only — they name every customer |
| `GET /api/customer-keys`, `/api/audit-job`, `/api/generate-job` | Staff only; every caller is an internal page |
| `POST /api/results` | Staff only (manual imports); the audit writes directly to the store |
| `GET /api/intake-codes?username=&password=` | **Open by necessity — this is the client login.** It authenticates itself |

Two ordering traps live here, both of which broke things once: a scoped read carries `username`+`password` *and* `company`, so the company form must be matched **before** the login form or a record read is answered as a login; and the staff-only list guard must sit **after** the login form, or every client login is refused.

## Security — credentials and gates
- Per-customer Claude/ChatGPT/Gemini API keys can be set at customer creation (Portal) and updated later from Hieronymus's Generate Prompts modal — **raw values are never returned by any endpoint under any circumstances**, only configured/not-configured status. This editability was a deliberate reversal of an earlier "immutable after creation" design, made after a real case of a customer being created without keys and needing them added later with no recovery path.
- The shared internal Claude API key (used for server-side prompt generation) lives only in a Netlify site environment variable (`ANTHROPIC_API_KEY`), never in any HTML/JS file.
- No browser-side raw-key *display* exists anywhere — key inputs are always blank/write-only, never pre-filled with an existing value.
- Destructive and outward-facing staff actions are password-gated through `js/confirm-gate.js`: run audit, resume, regenerate prompts, monitoring, dashboard release, clear results, delete customer. Cancel is deliberately *not* gated — it clears a display, deletes nothing.
- The intake form locks once either the customer approves their prompts **or** an audit has run against them (result rows are the signal — a job record can be cleared, rows cannot). Locked-ness is computed on the server and reported on the read, so the form cannot present itself as editable while a save would be refused. Staff can still correct a locked intake.
- Internal pages (`portal.html`, `index.html`, `intake-view.html`) share one session (`localStorage` key `hieronymus_internal_auth`) — logging in once keeps you logged into all three. This is a prototype-level access-code gate, not production auth.
- Client-facing pages (`intake.html`, `prompt-review.html`, `client-portal.html`) use per-customer username+password (`sessionStorage`, not shared with the internal pages or each other's storage keys, but the same credential values work on all three since they validate against the same `intake-codes.js` record). **Explicit exception**: if the visitor already has valid internal Portal auth (`localStorage` `hieronymus_internal_auth`), these three pages skip the customer password entirely and log straight in using just `?username=` from the URL — this was a deliberate, explicitly-approved tradeoff (staff needing access when a client's password was lost/never saved) that means the internal Portal password effectively grants access to every customer's intake/review/dashboard data. Not something to casually extend further without re-confirming.

## Project status: this is a DEV/PROTOTYPE version
This build will be handed off to a professional developer for final launch. Decisions below don't need to be finalized now — flag them clearly for the developer rather than guessing or over-building a permanent solution.

## Open decisions / not-yet-built (for developer at handoff — not final yet)
- [ ] **Nothing has been verified against the live API.** All automated coverage uses stubs. One real generation plus one real audit on a real customer is the highest-value outstanding check — particularly that the cold validator rejects the prompt shapes it is meant to, and that grading returns parseable JSON inside its token ceiling.
- [ ] **`sentiment: error` rows.** A row whose engine call or grading failed is written as a placeholder, and every dashboard counts it as not-cited — so a run with many of them deflates share of voice and looks like poor visibility rather than a failed measurement. The cause is recorded in that row's `answer_excerpt`, prefixed `ERROR (answer)` or `ERROR (grading)`. The per-customer page now breaks failures down by engine with the message, and flags an engine where *every* row failed as configuration rather than bad luck.
- [ ] **`BASELINE_DATE = DATES[0]`** — the diagnostic dashboard shows the earliest snapshot, while this doc previously said "latest". Effectively moot now that a diagnostic run replaces the prior one, but it must be settled before keeping several diagnostic snapshots side by side.
- [ ] Full bilingual EN/ES across every page — the client-facing pages and dashboards are covered; check `portal.html` and `index.html` for gaps.
- [ ] Production-grade auth. Read scoping is now real and enforced server-side, but the staff side is still a shared access code plus `localStorage`, and credentials travel as query parameters.
- [ ] API keys/access confirmed for: Claude ✅ / ChatGPT ⬜ / Gemini ⬜. ChatGPT has been observed failing every row in a run — check the `answer_excerpt` prefix before assuming rate limits.
- [ ] **Mobile is structurally fixed, not visually confirmed.** Overflow causes and unusable controls were fixed and every rule verified to target a live selector, but nobody has looked at a rendered page. `intake.html` has the least mobile CSS and is the most-used client page.
- [ ] Pre-existing customers created under the older single-access-code scheme need recreating — their old links no longer work.
- [ ] **The test suites live outside the repo** (a scratch directory) and will be lost. ~17 suites / ~290 assertions cover the generator pipeline, every scoped endpoint, the audit status machine, self-continuation, retry/timeout, intake locking, and the leaderboard. Worth moving into the repo before handoff; they reference absolute paths and would need those made relative.

## Language requirement
**The entire platform must run in both English and Spanish** — Portal, the per-customer detail page, prompt generation, and dashboards all need a language toggle/support. This is not optional or limited to client-facing pages; internal tools need it too since the team works in both languages.

## Style/UX notes
- **One uniform look and feel across the entire platform** — Portal, per-customer detail page, intake form, prompt review, client portal, and dashboards should all share the same visual style. No separate "internal" vs "client-facing" theme beyond navy/teal (internal) vs. the lighter client-facing variant already established by `intake.html`.
- The **dashboard's design is the reference standard** — match its colors, fonts, and layout style everywhere else.

## Verification habit that has paid off
Several bugs in this codebase were introduced *while fixing something else* and caught only by running everything before committing: a killed run reported as a clean success, self-continuation that would have been rejected on its first handoff, progress that rewound at each handoff, a staff-only guard that would have refused every client login, a leaderboard change that silently unhighlighted the client. **Run the full check before every push** — modules load, every page's inline JS parses, all suites green, and no unauthenticated call to a scoped endpoint. Twice a push went out with a suite red; both times it was recoverable, and both times the check would have caught it.

## When making changes
- Before editing, check this file for context so you don't need it re-explained.
- If a task requires a decision not covered here (e.g. which database, which engine), ask before proceeding rather than guessing.
- Keep changes scoped — this project has previously had issues where large multi-file changes were hard to verify were actually saved/deployed correctly.
- **No isolated/duplicate implementations.** If a new feature needs something an existing page/endpoint already does (auth gate, CSV parsing, job-status polling, audit-running), reuse it rather than writing a parallel version — this file exists partly because a prior "isolated legacy version" (the old manual-run `index.html`) undermined the security model built around it.
