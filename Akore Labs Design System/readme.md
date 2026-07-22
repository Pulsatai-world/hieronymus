# Akore Labs — Design System

**Akore Labs** is a Mexico-based marketing agency specialising in **GEO (Generative Engine Optimization)** and **AI visibility consulting** — making brands the source that AI answer engines (ChatGPT, Claude, Perplexity, Gemini, Google AI Overviews) *cite and recommend*, not just link. The positioning tagline is **"GEO & AI Visibility Consulting."**

This design system captures the brand's visual language — derived from the Akore Labs logo — and packages tokens, components, foundation specimens, a sales-deck kit, and a report template for reuse.

## Sources provided
- `uploads/WhatsApp Image 2026-07-19 at 12.34.24 PM.jpeg` — the official Akore Labs brand sheet (icon mark, horizontal & stacked lockups, favicon, single-color variants, on dark and light). All logo assets in `assets/` are cropped directly from this sheet.
- `uploads/GEO_B2B_Pitch_Deck_ES.pptx` — a 10-slide GEO B2B sales deck (Spanish), originally branded "Joe Shalita Consulting." Rebranded to Akore Labs and re-skinned in this system → `slides/index.html`.
- `uploads/FIACSA_Fase1_Implementacion_ES.pdf` — a 9-page technical audit for the client FIAC (Fuerza Industrial y Administrativa del Centro), a Toluca hydraulic-systems distributor. Re-skinned as a branded report → `docs/FIACSA_Fase1.html`.

## Brand at a glance
The mark is a violet chevron **"A"** (no crossbar) with an emerald **locator dot** at its base — reading simultaneously as a letter, an upward arrow, and a map pin, which nods to *GEO*. Two brand colours: **violet** (`#6d4fe0`) and **emerald** (`#1ea97c`), on a near-black **ink** ground.

---

## CONTENT FUNDAMENTALS
How Akore writes:
- **Voice:** confident, plain-spoken, consultative. Sells a *system*, not hype. "El proceso ES el producto."
- **Person:** speaks to the client as **"tú/tu"** (Spanish primary; English secondary). Frames value around the reader's outcome ("logramos que **te** citen").
- **Bilingual:** Spanish is the primary language (LatAm market); English is secondary. Deliverables ship in both.
- **Casing:** Headlines in sentence case; **eyebrow labels in UPPERCASE with wide tracking** (echoes the wordmark). Metrics are large and tabular.
- **Sharp claims, sourced:** big stats (58%, 527%, 4.4×) always carry a small mono source line.
- **Analogies over jargon:** "antes de pintar una casa, hay que reparar las paredes." Technical points are explained in lay terms, then given a concrete action + time estimate.
- **No emoji.** Emphasis via **bold**, colour accents, and the tick/dot eyebrow marker — never emoji or exclamation spam.
- **Vibe:** modern, elegant, tech-first — precise and credible, never "AI-slop." Tone is a trusted specialist, not a growth-hacker.

## VISUAL FOUNDATIONS
- **Colour:** Violet `#6d4fe0` (primary/brand) + Emerald `#1ea97c` (accent — reserved for one high-emphasis moment, the "dot"). Ink near-black `#08090c` grounds hero/dark surfaces. Cool-slate neutrals (`--ink-*`) for text and borders. Max 1–2 background colours per artifact: **ink-950 dark** and **white / ink-50 light**.
- **Type:** Display = **Montserrat** (geometric caps, tracked, mirrors the wordmark). Body/UI = **Manrope**. Data/technical = **JetBrains Mono**. See font note below.
- **Backgrounds:** solid ink or white; dark heroes carry a subtle **violet radial glow** top-right + faint emerald glow bottom-left. No busy patterns, no photo washes, no aggressive full-page gradients.
- **Gradients:** used sparingly — the violet ramp (`--grad-violet`) on emphasis cards/tiles, and violet→emerald (`--grad-violet-emerald`) as an occasional brand flourish. Never as a page background.
- **Eyebrow device:** wide-tracked uppercase label preceded by a short violet **tick** rule (or emerald **dot**). This is the signature section-labeling motif.
- **Cards:** 16px radius (`--radius-lg`), 1px hairline border (`--border-subtle`), low, cool-tinted shadow (`--shadow-sm/md`). On dark, cards are `rgba(255,255,255,.04)` with a faint white hairline, no shadow. Calm elevation — never heavy drop-shadows.
- **Corner radii:** pill (999px) for buttons/badges; 12–16px for cards; 8px for small callouts.
- **Borders:** 1px hairlines in ink-100/200; a 3px violet left-rule marks callouts/quotes.
- **Shadows:** cool-tinted, low-spread (`0 6px 16px rgba(16,19,25,.08)`); brand-tinted shadow (`--shadow-brand`) only on violet CTAs/hero cards.
- **Motion:** quick and eased, never bouncy. `--ease-standard` (cubic-bezier(.2,.6,.2,1)), 120–360ms. Entrance = fade + small rise; no spring/overshoot, no infinite decorative loops.
- **Hover:** buttons darken one step (violet-600→700) and gain brand shadow; cards lift 2px with a stronger shadow; ghost buttons get a violet-50 tint.
- **Press:** 1px downward nudge (`translateY(1px)`), no colour flash.
- **Transparency & blur:** translucent white fills on dark surfaces (`rgba(255,255,255,.04–.18)`); no heavy glassmorphism/backdrop-blur.
- **Imagery vibe:** cool, precise, tech-forward. When photos are used, favour cool tones; the palette leans blue-violet + green, never warm.
- **Layout:** 4px spacing grid; generous 64–88px slide/section padding; 1200px max content width. Metrics and eyebrows anchor the top-left reading order.

## ICONOGRAPHY
- **No icon set was provided with the brand.** Akore standardises on **[Lucide](https://lucide.dev)** — clean, tech-forward line icons at **1.75px stroke, rounded caps, no fills**. This matches the geometric, minimal wordmark. *(Intentional addition — see below.)*
- Loaded from CDN: `<script src="https://unpkg.com/lucide@latest"></script>`, then `lucide.createIcons()` (or the `Icon` component).
- Favour GEO/AI-flavoured glyphs: `map-pin`, `radar`, `sparkles`, `search-check`, `trending-up`, `git-compare`.
- **No emoji.** No unicode-glyph icons. The emerald **dot** and violet **tick** are the only brand-native "glyphs," used as list/eyebrow markers.
- The **logo mark** is never redrawn — always use the packaged `assets/` PNGs (or the `Logo` component).

## ⚠️ Font substitution — needs your input
The wordmark uses **custom geometric lettering**. I substituted the closest Google Fonts: **Montserrat** (display), **Manrope** (body), **JetBrains Mono** (data). If Akore has licensed brand fonts, please share the files and I'll swap them into `tokens/fonts.css`.

---

## Components (`window.AkoreLabsDesignSystem_*`)
Reusable React primitives (`components/`):
- **Button** — pill button; primary (violet) / accent (emerald) / secondary / ghost / inverse.
- **Badge** — pill tag/status label; violet / emerald / neutral / solid / outline tones.
- **Card** — surface container; default / raised / subtle / inverse / brand-gradient.
- **Input** — labeled text field with focus ring, hint & error states.
- **Eyebrow** — the wide-tracked uppercase kicker with tick/dot marker.
- **Stat** — large display metric for results/proof points.
- **Icon** — Lucide wrapper (the brand icon set).
- **Logo** — renders official logo assets (mark / horizontal / stacked, dark / light).

### Intentional additions (not in the provided sources)
- **Icon** — no icon set was supplied; Lucide adopted as the standard. Flag for approval.
- **Logo** — convenience wrapper over the packaged image assets so the mark is never redrawn.

---

## Index / manifest
- `styles.css` — global entry point (@import list only).
- `tokens/` — `fonts.css`, `colors.css`, `typography.css`, `spacing.css`, `effects.css`.
- `components/core/` — Button, Badge, Card, Input, Eyebrow, Stat, Icon (+ `core.card.html`).
- `components/brand/` — Logo (+ `brand.card.html`).
- `guidelines/` — foundation specimen cards (Colors, Type, Spacing, Brand).
- `slides/` — `index.html` GEO B2B pitch deck (10 slides) + `deck-stage.js`.
- `docs/` — `FIACSA_Fase1.html` branded audit report + `doc-page.js`.
- `assets/` — logo PNGs (mark, horizontal, stacked; dark & light; transparent marks).
- `thumbnail.html` — homepage tile. `SKILL.md` — Agent Skill wrapper.
