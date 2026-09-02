// requireStaff / requireStaffAdmin / requireCompany all report a refusal by CALLING the responder
// they are handed. If that identifier does not exist in the file, nothing complains until a real
// request arrives — and then every request to that endpoint is a ReferenceError, which Netlify
// serves as a 502. /api/geo-report did exactly this: the call was copied from geo-scan-job.js,
// which defines `json`, into geo-report.js, which defines `page`.
//
// It cannot be caught by `node --check`: the file parses perfectly. Only calling it fails, and the
// happy path never runs because the refusal is what invokes the responder.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'netlify', 'functions');
const GUARDS = ['requireStaff', 'requireStaffAdmin', 'requireCompany'];

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};

console.log('Every responder handed to an authorize guard is defined in its own file:\n');

let checked = 0;
for (const file of fs.readdirSync(DIR).filter(f => f.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8');

  for (const guard of GUARDS) {
    // The responder is the third argument: guard(url, body, responder[, ...]).
    const calls = [...src.matchAll(new RegExp(guard + '\\s*\\(\\s*[^,()]+,\\s*[^,()]+,\\s*([A-Za-z_$][\\w$]*)', 'g'))];
    for (const call of calls) {
      const responder = call[1];
      checked++;

      // Defined in this file as a function, a const/let binding, or an imported name.
      const defined =
        new RegExp('function\\s+' + responder + '\\s*\\(').test(src) ||
        new RegExp('(?:const|let|var)\\s+' + responder + '\\s*=').test(src) ||
        new RegExp('import\\s*\\{[^}]*\\b' + responder + '\\b[^}]*\\}').test(src);

      check(file + ' — ' + guard + '(..., ' + responder + ')', defined,
        responder + ' is not defined in ' + file + '; the endpoint will throw on every refusal');
    }
  }
}

console.log('\n' + checked + ' guard call(s) checked');
console.log(failures ? failures + ' FAILURE(S)' : 'every responder resolves');
process.exit(failures ? 1 : 0);
