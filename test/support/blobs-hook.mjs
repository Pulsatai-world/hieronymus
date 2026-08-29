// A module loader hook that replaces @netlify/blobs with an in-memory store.
//
// Every earlier suite here loaded the function files by reading them as text, stripping their
// imports and running the result in a vm. That flattens modules into one scope, so two libraries
// that each declare a private constant collide, and a suite can fail for a reason that has nothing
// to do with the code under test. It also means the tests never exercise the real import graph.
//
// With this hook the suites `import()` the real ES modules, with real module scope, and only the
// storage is substituted. The data lives on globalThis.__BLOBS__ so a test can inspect and reset it.

export async function resolve(specifier, context, next) {
  if (specifier === '@netlify/blobs') {
    return { url: 'netlify-blobs-memory:store', shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === 'netlify-blobs-memory:store') {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        const all = (globalThis.__BLOBS__ = globalThis.__BLOBS__ || {});
        const bucket = name => (all[name] = all[name] || {});
        const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

        export function getStore(name) {
          return {
            async get(key, opts) {
              const b = bucket(name);
              if (!(key in b)) return null;
              return opts && opts.type === 'json' ? clone(b[key]) : b[key];
            },
            async setJSON(key, value) { bucket(name)[key] = clone(value); },
            async set(key, value) { bucket(name)[key] = value; },
            async delete(key) { delete bucket(name)[key]; },
            async list() {
              return { blobs: Object.keys(bucket(name)).map(key => ({ key })) };
            }
          };
        }
      `
    };
  }
  return next(url, context);
}
