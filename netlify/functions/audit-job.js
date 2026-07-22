import { getStore } from '@netlify/blobs';

function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
}

export default async (request) => {
  const url = new URL(request.url);
  const company = url.searchParams.get('company');
  if (!company) return json({ error: 'Missing company param' }, 400);
  const store = getStore('hieronymus-audit-jobs');
  const key = slugify(company);

  if (request.method === 'GET') {
    const data = await store.get(key, { type: 'json' });
    if (!data) return json({ status: 'none' }, 200);
    return json(data, 200);
  }

  if (request.method === 'DELETE') {
    // This clears the displayed status only — it cannot actually kill an in-flight
    // background function invocation (Netlify has no API for that). Safe to use once a
    // run has genuinely stalled (no progress for a long stretch); if a run were still
    // truly active this would just make the UI lose track of it, not stop it.
    await store.delete(key);
    return json({ status: 'ok' }, 200);
  }

  return new Response('Method Not Allowed', { status: 405 });
};
