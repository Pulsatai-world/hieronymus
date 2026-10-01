# Per-customer dashboard specs

One file per customised customer, named for their slug (the same slug
`netlify/functions/intake-codes.js` derives from the company name:
lowercase, non-alphanumerics to `-`, trimmed).

A customer only gets a file when they need one. Everyone else renders the base design.

## Making a dashboard customisable

1. Add the slug to `index.js`.
2. Create `<slug>.js`.

```js
AkoreSpec.register('acme', {
  diagnostic: {
    // Arrays REPLACE — name the whole region, in order.
    layouts:      { summary: ['geoScoreHero', 'perEngine', 'kpiCategories'] },
    // Tune a block without replacing it.
    blockOptions: { competitorLeaderboard: { rowLimit: 10 } },
    // Any translation key the page uses; both languages.
    copy:         { yourRank: { en: 'Your position', es: 'Tu posición' } },
    // Any custom property from styles/akore-tokens.css.
    theme:        { '--navy': '#123456' },
    // Rename, reorder or drop a tab.
    tabs:         { prompts: { hidden: true }, competitors: { order: 0 } }
  },
  monitoring: { /* same shape, independent of diagnostic */ },

  // A visual only this customer gets. Same contract as any core block.
  blocks: {
    acmeSupplierSplit: {
      render(ctx) {
        const el = ctx.doc.createElement('div');
        el.className = 'cat';
        el.innerHTML = '<div class="cat-h"><div class="cat-titles"><span class="q">Suppliers</span></div></div>';
        return el;
      }
    }
  },

  // Or swap a core block outright, keeping its place in every layout.
  replaces: {
    // sentimentDonut: { render(ctx) { ... } }
  }
});
```

## Regions

| Dashboard | Regions |
|---|---|
| `diagnostic` | `summary`, `competitors`, `prompts` |
| `monitoring` | `trends`, `competitors`, `prompts` |

Run `npm test` after any change: `test/dashboard-parity.test.cjs` will fail if a spec
changes what an *uncustomised* customer sees.

## What must never go in here

These files are served as static assets and are publicly fetchable. They hold presentation
config only — never customer data, never credentials, never anything from `/api/results`.
