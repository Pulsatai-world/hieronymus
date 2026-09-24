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
        // Every store operation is a network round trip in production. Counting them is the only
        // honest way to talk about how an endpoint scales, since an in-memory store hides the cost.
        const ops = (globalThis.__BLOB_OPS__ = globalThis.__BLOB_OPS__ || { get: 0, set: 0, list: 0, delete: 0 });
        const bucket = name => (all[name] = all[name] || {});
        const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

        export function getStore(name) {
          return {
            async get(key, opts) {
              ops.get++;
              const b = bucket(name);
              if (!(key in b)) return null;
              return opts && opts.type === 'json' ? clone(b[key]) : b[key];
            },
            async setJSON(key, value) { ops.set++; bucket(name)[key] = clone(value); },
            async set(key, value) { ops.set++; bucket(name)[key] = value; },
            async delete(key) { ops.delete++; delete bucket(name)[key]; },
            async list(opts) {
              ops.list++;
              const prefix = (opts && opts.prefix) || '';
              return { blobs: Object.keys(bucket(name))
                .filter(key => !prefix || key.indexOf(prefix) === 0)
                .map(key => ({ key })) };
            }
          };
        }
      `
    };
  }
  return next(url, context);
}
