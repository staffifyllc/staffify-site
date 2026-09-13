/* Open a draft in the mail client the rep actually uses.
 *
 * Paul, 2026-09-08: "we are using FRONT app to send emails, its right now opening the default mail app".
 * Paul, 2026-09-12: "the emailing button should be wired to the users gmail ... ideally front, as thats
 * what we currently use, but its through gmail that these emails are getting sent."
 *
 * A mailto: link hands off to whatever the operating system registered, which on these Macs is Apple
 * Mail, which nobody here uses. Four targets, in the order they are worth trying:
 *
 *   front-web      https://app.frontapp.com/compose?mailto=<encoded mailto>   works anywhere, no setup
 *   gmail          https://mail.google.com/mail/u/<n>/?view=cm&fs=1&to=…      the account underneath Front
 *   front-desktop  mailto-frontapp:…                                          needs the Front desktop app
 *   default        mailto:…                                                   the OS handler, Apple Mail here
 *
 * front-web is the default because it is the only one that cannot silently do nothing: an unhandled
 * custom scheme fails invisibly, and a rep staring at a dead button just stops using it.
 *
 * Front's plain-text body parameter is `text`; its `body` is treated as HTML and eats line breaks.
 * Gmail's are `su` and `body`. Getting this wrong produces a draft with the whole message on one line.
 *
 * Only load this on rep tools. On a public marketing page a visitor's own mail app is correct.
 */
(function () {
  'use strict';
  var KEY = 'sfy_mailclient';
  var GMAIL_USER_KEY = 'sfy_gmail_user';   // which Google account, for anyone signed into several

  var OPTIONS = [
    ['front-web', 'Front (browser)'],
    ['gmail', 'Gmail'],
    ['front-desktop', 'Front (desktop app)'],
    ['default', 'System default'],
  ];

  function get() { try { return localStorage.getItem(KEY) || 'front-web'; } catch (e) { return 'front-web'; } }
  function set(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  function gmailUser() { try { return localStorage.getItem(GMAIL_USER_KEY) || '0'; } catch (e) { return '0'; } }

  /** Split a mailto: href into its address and its query, whatever shape it arrived in. */
  function parse(href) {
    var rest = String(href || '').replace(/^mailto:/i, '');
    var cut = rest.indexOf('?');
    var addr = decodeURIComponent(cut === -1 ? rest : rest.slice(0, cut));
    var qs = cut === -1 ? '' : rest.slice(cut + 1);
    var out = { to: addr, subject: '', body: '' };
    qs.split('&').forEach(function (pair) {
      var i = pair.indexOf('=');
      if (i === -1) return;
      var k = pair.slice(0, i).toLowerCase();
      var v = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
      if (k === 'subject' || k === 'su') out.subject = v;
      else if (k === 'body' || k === 'text') out.body = v;
    });
    return out;
  }

  /** Build the compose URL for the rep's chosen client. Returns null to leave it to the OS. */
  function compose(to, subject, body, who) {
    who = who || get();
    var addr = String(to || '').trim();
    var sub = encodeURIComponent(subject || '');
    var txt = encodeURIComponent(body || '');
    if (who === 'default') return null;
    if (who === 'gmail') {
      // Gmail uses su/body, and /u/<n>/ picks the account when several are signed in.
      return 'https://mail.google.com/mail/u/' + encodeURIComponent(gmailUser()) +
        '/?view=cm&fs=1&to=' + encodeURIComponent(addr) + '&su=' + sub + '&body=' + txt;
    }
    var inner = 'mailto:' + addr + '?subject=' + sub + '&text=' + txt;   // Front wants `text`
    if (who === 'front-desktop') return 'mailto-frontapp:' + addr + '?subject=' + sub + '&text=' + txt;
    return 'https://app.frontapp.com/compose?mailto=' + encodeURIComponent(inner);
  }

  /**
   * Open a compose URL. A custom scheme needs a real anchor click; window.open orphans a blank tab.
   *
   * A CUSTOM SCHEME CAN FAIL SILENTLY, which is what "Front (desktop app)" did to Paul on
   * 2026-09-12: if nothing on the machine is registered for mailto-frontapp: the click does
   * nothing at all, or the OS quietly hands it to Apple Mail. Either way the rep sees a button
   * that appears dead and stops trusting it.
   *
   * There is no API that reports whether a scheme was handled. The one reliable signal is focus:
   * a successful handoff moves the OS to another app, so this page loses focus. Still focused a
   * moment later means nothing caught it, so fall through to the browser version and say so.
   */
  function open_(url, opts) {
    if (!url) return false;
    if (url.indexOf('https:') === 0) { window.open(url, '_blank', 'noopener'); return true; }
    var fallback = opts && opts.fallback;
    var handedOff = false;
    function noteHandoff() { handedOff = true; }
    window.addEventListener('blur', noteHandoff, { once: true });
    document.addEventListener('visibilitychange', noteHandoff, { once: true });

    var a = document.createElement('a');
    a.href = url; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); }, 0);

    if (fallback) {
      setTimeout(function () {
        window.removeEventListener('blur', noteHandoff);
        if (handedOff || document.hidden) return;      // the app took it, nothing to do
        // Nothing caught the scheme. Open the browser version rather than leaving them stuck.
        window.open(fallback, '_blank', 'noopener');
        if (window.sfyMail && window.sfyMail.onFallback) window.sfyMail.onFallback();
      }, 1500);
    }
    return true;
  }

  // Every mailto link on the page is rewritten at click time, so a page does not have to know
  // anything about this to benefit from it.
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href^="mailto:"]') : null;
    if (!a) return;
    var m = parse(a.getAttribute('href') || '');
    var url = compose(m.to, m.subject, m.body);
    if (!url) return;                       // 'default': let the operating system have it
    ev.preventDefault();
    // If the desktop app is not registered, land in Front in the browser rather than nowhere.
    var fb = get() === 'front-desktop' ? compose(m.to, m.subject, m.body, 'front-web') : null;
    open_(url, { fallback: fb });
  }, true);

  /**
   * Render a picker into any element with [data-mail-client-picker]. Until 2026-09-12 the setter
   * existed but nothing ever called it, so the only way to change clients was the devtools console.
   */
  function mountPickers() {
    var hosts = document.querySelectorAll('[data-mail-client-picker]');
    Array.prototype.forEach.call(hosts, function (host) {
      if (host.dataset.mounted) return;
      host.dataset.mounted = '1';
      var sel = document.createElement('select');
      sel.setAttribute('aria-label', 'Which app opens email drafts');
      OPTIONS.forEach(function (o) {
        var op = document.createElement('option');
        op.value = o[0]; op.textContent = o[1];
        if (o[0] === get()) op.selected = true;
        sel.appendChild(op);
      });
      sel.addEventListener('change', function () { set(sel.value); });
      host.appendChild(sel);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountPickers);
  else mountPickers();
  // Rep tools render their panels from JS after data loads, so a picker can appear late.
  new MutationObserver(mountPickers).observe(document.documentElement, { childList: true, subtree: true });

  window.sfyMail = { get: get, set: set, compose: compose, open: open_, options: OPTIONS, parse: parse };
})();
