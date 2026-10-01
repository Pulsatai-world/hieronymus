/* A fixture, not a real customer spec. It deliberately exercises every axis at once —
 * layout, block options, copy, theme, tabs, a new block, and replacing a core block —
 * so the test proves the whole capability rather than one convenient corner of it. */
AkoreSpec.register('fiacsa', {
  diagnostic: {
    layouts: {
      // Drops sentimentDonut and the dual group, adds a customer-only block, reorders.
      summary: ['fixtureBanner', 'perEngine', 'geoScoreHero', 'invisiblePrompts']
    },
    blockOptions: {
      competitorLeaderboard: { rowLimit: 3 }
    },
    copy: {
      yourRank: { en: 'Fixture rank label', es: 'Etiqueta de prueba' }
    },
    theme: {
      '--navy': '#0a7d55',
      '--bogus key': 'ignored',
      '--injection': 'red;} body{display:none'
    },
    tabs: {
      prompts: { hidden: true },
      competitors: { label: { en: 'Rivals', es: 'Rivales' }, order: 0 }
    }
  },
  blocks: {
    fixtureBanner: {
      render(ctx) {
        const el = ctx.doc.createElement('div');
        el.className = 'cat fixture-banner';
        el.textContent = 'FIXTURE BANNER for ' + ctx.company;
        return el;
      }
    }
  },
  replaces: {
    perEngine: {
      render(ctx) {
        const el = ctx.doc.createElement('div');
        el.className = 'cat fixture-replaced-engines';
        el.textContent = 'REPLACED perEngine';
        return el;
      }
    }
  }
});
