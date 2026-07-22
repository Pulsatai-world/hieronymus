# Hieronymus GEO Platform — Project Overview

## What this system does
An end-to-end GEO (Generative Engine Optimization) audit platform for Joe Shalita Consulting. Clients submit an intake form, and the system automatically generates AI-search prompts, runs those prompts against multiple AI engines to check brand citation, and produces a dashboard the client can view.

## One identity per customer
Every customer gets exactly one username + password, generated at creation in the Portal and never re-shown after that. That single credential pair is what the client uses to log into **all three** of their client-facing pages: `intake.html` (fill out/save the intake form), `prompt-review.html` (review/approve generated prompts), and `client-portal.html` (view their own dashboards). There is no separate credential system per page — this was a deliberate cohesiveness fix (previously each piece was drifting toward its own ad-hoc pattern).

## The workflow (in order)
1. **Portal (`portal.html`)** — Joe/Rene's internal control center. No explanatory header or numbered pipeline guide — it's an internal tool, not a walkthrough. "+ New Customer" opens a modal (company name + optional Claude/ChatGPT/Gemini API keys) — the New Customer form is not perpetually visible. Per-customer row actions: Copy/Open Intake Link, Copy/Open Review Link, Copy/Open Client Portal Link, "Open in Hieronymus →", toggle monthly monitoring, delete. **Generate Prompts and Run Audit are NOT in the Portal** — they live on the per-customer Hieronymus detail page (see below); the Portal only shows read-only status badges + live progress polling for whichever run is in flight.
2. **Intake form (`intake.html`)** — client-facing, username+password gated (same credential as the rest of that customer's pages). Client fills out company info, competitors, personas, etc. **Save** persists progress server-side via `netlify/functions/intake.js`, keyed by company — closing the link and coming back later (even a different day, different device) restores exactly where they left off. There is no JSON download/upload anywhere in this flow. No pre-filled example/placeholder text in any field.
3. **Prompt generation** — triggered from the Portal ("Generate Prompts" per customer), handled server-side by `netlify/functions/generate-prompts.js` using a Netlify-account-level `ANTHROPIC_API_KEY` env var (never entered in the browser). The Portal's modal lets Joe/Rene pick the prompt count (any number, default 100), which language(s) to generate in (multi-select), and which AI engines the eventual audit run should use — all three choices are stored alongside the generated prompts.
4. **Customer review step (`prompt-review.html`)** — client-facing, same login as intake. Shows the generated prompts grouped by category, lets the client add comments and click Approve. The Portal shows "Awaiting review" vs "Approved {date}" per customer, but **this is informational only** — Run Audit stays clickable regardless, since Joe/Rene's judgment takes priority over a hard gate.
5. **Hieronymus audit engine** — triggered from the Portal's "Run Audit" button, runs entirely server-side (`netlify/functions/run-audit-background.js`, a Netlify Background Function) against whichever of Claude/ChatGPT/Gemini are *both* selected at generation time *and* have a configured key for that customer. For each prompt: every active engine answers independently (company name withheld from the question sent to the engine, to avoid priming), then a single Claude call grades all of that prompt's answers together against the same rubric — "one engine doesn't grade its own homework." **This is the only place an audit ever runs** — there is no separate manual/browser-driven path anymore (see `index.html` below).
6. **Results storage** — each result row is its own Blob (`netlify/functions/results.js`, keyed by `run_id`), not a shared append-only file — this was a deliberate fix after a concurrent-write race was found to silently drop rows under real load. `GET /api/results` reconstructs the full CSV by listing and joining every row.
7. **Dashboards** — two types, both reading live from `/api/results`, no separate "build" step needed:
   - **Diagnostic dashboard (`dashboard-diagnostic.html`)**: single point-in-time snapshot of the latest run for a company.
   - **Monitoring dashboard (`dashboard-monitoring.html`)**: same prompts re-run over time, trended across every `snapshot_date`.
8. **Monitoring automation** — per-customer opt-in toggle in the Portal (`monitoringEnabled`, stored on the `intake-codes.js` record). `netlify/functions/monthly-audit-cron.js` is a Netlify Scheduled Function (`@monthly`) that lists opted-in customers with submitted intake + generated prompts, and triggers `/api/run-audit` for each — reusing the exact same background function from step 5, not a separate run path.
9. **Client-facing dashboard access (`client-portal.html`)** — same per-customer login again. Shows the Diagnostic Dashboard once at least one run exists, and the Monitoring Dashboard only if that customer has monitoring enabled.

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
- `netlify/functions/generate-prompts.js` — server-side prompt generation (count/languages/engines from the Portal modal), stores the engine selection alongside the prompts for `run-audit-background.js` to read back
- `netlify/functions/prompts.js` — save/load generated prompts; PATCH records client approval + comments
- `netlify/functions/run-audit-background.js` — the one true audit-running implementation; Background Function, reads customer keys server-to-server, writes result rows via `/api/results`, tracks progress in a job-status Blob
- `netlify/functions/audit-job.js` — polling endpoint for live audit progress (used by both the Portal and the per-customer detail page)
- `netlify/functions/results.js` — per-row Blob storage, reconstructs CSV on GET
- `netlify/functions/monthly-audit-cron.js` — Scheduled Function, triggers `/api/run-audit` for monitoring-enabled customers
- `netlify.toml` — maps clean `/api/*` paths to the underlying `/.netlify/functions/*` files

## Storage
Netlify Blobs (`@netlify/blobs`, `getStore()`) throughout — not Google Sheets or Supabase. Revisit only if there's a reason to migrate off Blobs (e.g. needing relational queries or a non-Netlify host).

## Known technical constraints
- Regular Netlify functions have a ~10 second execution timeout — this is why the audit run is a **Background Function** (`run-audit-background.js`), not a regular one.
- Local `netlify dev`'s Blobs emulation has been observed to omit the `etag` on an existing blob (a dev-only gap, not seen in production) — `results.js` avoids depending on that path entirely by giving each row its own key rather than doing a shared read-modify-write.
- Netlify Scheduled Functions declare their cron via `export const config = { schedule: '@monthly' }` inside the function file itself, the same self-contained pattern already used by edge functions' `config.path` — no netlify.toml entry needed for the schedule itself.

## Security
- Per-customer Claude/ChatGPT/Gemini API keys can be set at customer creation (Portal) and updated later from Hieronymus's Generate Prompts modal — **raw values are never returned by any endpoint under any circumstances**, only configured/not-configured status. This editability was a deliberate reversal of an earlier "immutable after creation" design, made after a real case of a customer being created without keys and needing them added later with no recovery path.
- The shared internal Claude API key (used for server-side prompt generation) lives only in a Netlify site environment variable (`ANTHROPIC_API_KEY`), never in any HTML/JS file.
- No browser-side raw-key *display* exists anywhere — key inputs are always blank/write-only, never pre-filled with an existing value.
- Internal pages (`portal.html`, `index.html`, `intake-view.html`) share one session (`localStorage` key `hieronymus_internal_auth`) — logging in once keeps you logged into all three. This is a prototype-level access-code gate, not production auth.
- Client-facing pages (`intake.html`, `prompt-review.html`, `client-portal.html`) use per-customer username+password (`sessionStorage`, not shared with the internal pages or each other's storage keys, but the same credential values work on all three since they validate against the same `intake-codes.js` record). **Explicit exception**: if the visitor already has valid internal Portal auth (`localStorage` `hieronymus_internal_auth`), these three pages skip the customer password entirely and log straight in using just `?username=` from the URL — this was a deliberate, explicitly-approved tradeoff (staff needing access when a client's password was lost/never saved) that means the internal Portal password effectively grants access to every customer's intake/review/dashboard data. Not something to casually extend further without re-confirming.

## Project status: this is a DEV/PROTOTYPE version
This build will be handed off to a professional developer for final launch. Decisions below don't need to be finalized now — flag them clearly for the developer rather than guessing or over-building a permanent solution.

## Open decisions / not-yet-built (for developer at handoff — not final yet)
- [ ] Full bilingual EN/ES support across Portal, the per-customer detail page, and both dashboards — `intake.html` already has an EN/ES toggle; the rest do not yet.
- [ ] Reconcile prompt count: current default is 100 (free-entry number field); original spec mentioned a fixed 120 (24 × 5 categories) — close enough that this may just be resolved already, worth a sanity check.
- [ ] Production-grade security/auth (current access-code + shared-storage approach is prototype-level only).
- [ ] API keys/access confirmed for: Claude ✅ / ChatGPT ⬜ / Gemini ⬜.
- [ ] Pre-existing customers created under an older single-access-code scheme (before the username+password model) need to be recreated — their old links no longer work. Not an issue going forward, only affects records created before this change.

## Language requirement
**The entire platform must run in both English and Spanish** — Portal, the per-customer detail page, prompt generation, and dashboards all need a language toggle/support. This is not optional or limited to client-facing pages; internal tools need it too since the team works in both languages.

## Style/UX notes
- **One uniform look and feel across the entire platform** — Portal, per-customer detail page, intake form, prompt review, client portal, and dashboards should all share the same visual style. No separate "internal" vs "client-facing" theme beyond navy/teal (internal) vs. the lighter client-facing variant already established by `intake.html`.
- The **dashboard's design is the reference standard** — match its colors, fonts, and layout style everywhere else.

## When making changes
- Before editing, check this file for context so you don't need it re-explained.
- If a task requires a decision not covered here (e.g. which database, which engine), ask before proceeding rather than guessing.
- Keep changes scoped — this project has previously had issues where large multi-file changes were hard to verify were actually saved/deployed correctly.
- **No isolated/duplicate implementations.** If a new feature needs something an existing page/endpoint already does (auth gate, CSV parsing, job-status polling, audit-running), reuse it rather than writing a parallel version — this file exists partly because a prior "isolated legacy version" (the old manual-run `index.html`) undermined the security model built around it.
