// Every /api/* path the front end calls must have a redirect in netlify.toml, and every redirect
// must point at a function that exists.
//
// This suite exists because /api/two-factor shipped with no route. The function was correct, its
// tests passed, the pages called it correctly — and it answered 404 in production, so the enrollment
// dialog could never fetch a secret. With enrollment mandatory at every login, that locked every
// account out of the platform. Modules loading and pages parsing says nothing about whether the
// path between them is wired up.
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '   -> ' + detail));
  if (!cond) failures++;
};

const toml = fs.readFileSync('netlify.toml', 'utf8');
const routes = {};
for (const m of toml.matchAll(/from = "(\/api\/[\w-]+)"\s*\n\s*to = "\/\.netlify\/functions\/([\w-]+)"/g)) {
  routes[m[1]] = m[2];
}

// What the browser actually asks for.
const called = {};
const files = [...fs.readdirSync('.').filter(f => f.endsWith('.html')),
               ...fs.readdirSync('js').filter(f => f.endsWith('.js')).map(f => 'js/' + f)];
for (const f of files) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/['"`](\/api\/[\w-]+)/g)) {
    (called[m[1]] = called[m[1]] || new Set()).add(f);
  }
}

console.log('Every path the front end calls is routed:');
for (const p of Object.keys(called).sort()) {
  check(p + '  (' + [...called[p]].sort().join(', ') + ')', !!routes[p], 'no redirect in netlify.toml');
}

console.log('\nEvery route points at a function that exists:');
for (const [p, fn] of Object.entries(routes).sort()) {
  check(p + ' -> ' + fn, fs.existsSync(path.join('netlify/functions', fn + '.js')), 'no such function file');
}

console.log('\nThe login endpoints specifically, since a missing route locked everyone out once:');
for (const [path, fn] of [['/api/login', 'login'], ['/api/enroll', 'enroll'], ['/api/confirm-password', 'confirm-password']]) {
  check(path + ' is routed', routes[path] === fn, JSON.stringify(routes[path]));
}
check('the browser calls those exact paths', ['/api/login', '/api/enroll', '/api/confirm-password']
  .every(p => (fs.readFileSync('js/auth.js', 'utf8') + fs.readFileSync('js/enroll-dialog.js', 'utf8')).includes("'" + p + "'")),
  'a page calls something else');

// Server-side calls to our own API count too — a cron that posts to an unrouted path fails monthly,
// quietly, in the middle of the night.
console.log('\nServer-side calls to our own API are routed as well:');
for (const f of fs.readdirSync('netlify/functions').filter(f => f.endsWith('.js'))) {
  const src = fs.readFileSync('netlify/functions/' + f, 'utf8');
  for (const m of src.matchAll(/base \+ '(\/api\/[\w-]+)'/g)) {
    check(f + ' -> ' + m[1], !!routes[m[1]], 'no redirect in netlify.toml');
  }
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
process.exit(failures ? 1 : 0);
