// Runs in the staff member's own browser, on the site being analysed.
//
// A server cannot fetch a site whose bot protection filters by IP range: the request is refused
// before it reaches the site's web server, and no user-agent or retry logic changes that. A person
// looking at the page in their own browser has already been let through. This does the same thing
// that person would do by hand, on the same connection, with the same session.
//
// It asks for the raw server response for each page, not the rendered DOM. The rendered DOM would
// include everything JavaScript built after loading, which would make the "readable without
// JavaScript" check pass on a page where a crawler sees nothing. What the server sent is what a
// crawler gets, so that is what gets measured.
(function () {
  var MAX_PAGES = 20;

  function sameOriginLinks() {
    var here = location.origin;
    var seen = {};
    var out = [];
    var anchors = document.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      var href = anchors[i].href;
      var u;
      try { u = new URL(href); } catch (e) { continue; }
      if (u.origin !== here) continue;
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = '';
      var clean = u.href;
      if (clean === location.href) continue;
      if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|mp4|mp3)$/i.test(u.pathname)) continue;
      if (seen[clean]) continue;
      seen[clean] = 1;
      out.push(clean);
    }
    return out;
  }

  // Spread the sample across the list instead of taking the first N, so a long navigation does not
  // mean twenty variations of the same section. Mirrors how the server samples a sitemap.
  function spread(list, n) {
    if (list.length <= n) return list;
    var step = list.length / n;
    var out = [];
    for (var i = 0; i < n; i++) out.push(list[Math.floor(i * step)]);
    return out;
  }

  function overlay(msg, payload) {
    var old = document.getElementById('akore-capture-box');
    if (old) old.parentNode.removeChild(old);
    var box = document.createElement('div');
    box.id = 'akore-capture-box';
    box.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:24px;transform:translateX(-50%);' +
      'background:#0b0d12;color:#e9ecf2;font:14px/1.5 system-ui,sans-serif;padding:16px 18px;' +
      'border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,.4);max-width:min(560px,92vw)';
    var text = document.createElement('div');
    text.textContent = msg;
    box.appendChild(text);
    if (payload) {
      var ta = document.createElement('textarea');
      ta.value = payload;
      ta.style.cssText = 'width:100%;height:90px;margin-top:10px;font:11px monospace;padding:8px;border-radius:6px;border:1px solid #333;background:#15181f;color:#c3cad6';
      box.appendChild(ta);
      ta.select();
    }
    document.body.appendChild(box);
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, payload ? 60000 : 6000);
  }

  var urls = [location.href].concat(spread(sameOriginLinks(), MAX_PAGES - 1));
  overlay('Akore: leyendo ' + urls.length + ' página(s)…');

  var jobs = urls.map(function (u) {
    return fetch(u, { credentials: 'include' })
      .then(function (r) { return r.ok ? r.text().then(function (h) { return { url: u, html: h }; }) : null; })
      .catch(function () { return null; });
  });

  Promise.all(jobs).then(function (results) {
    var pages = results.filter(function (p) { return p && p.html && p.html.length > 200; });
    if (!pages.length) {
      overlay('Akore: no se pudo leer ninguna página. Revisa que la página haya cargado bien.');
      return;
    }
    var bundle = JSON.stringify({ akoreCapture: 1, url: location.href, pages: pages });
    var done = function () {
      overlay('Akore: listo, ' + pages.length + ' página(s) copiadas. Pégalas en el escáner del portal.');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(bundle).then(done, function () {
        overlay('Akore: copia esto y pégalo en el escáner del portal (' + pages.length + ' páginas):', bundle);
      });
    } else {
      overlay('Akore: copia esto y pégalo en el escáner del portal (' + pages.length + ' páginas):', bundle);
    }
  });
})();
