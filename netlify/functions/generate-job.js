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
  const store = getStore('hieronymus-generate-jobs');
  const key = slugify(company);

  if (request.method === 'GET') {
    const data = await store.get(key, { type: 'json' });
    if (!data) return json({ status: 'none' }, 200);
    return json(data, 200);
  }

  if (request.method === 'DELETE') {
    await store.delete(key);
    return json({ status: 'ok' }, 200);
  }

  return new Response('Method Not Allowed', { status: 405 });
};
