/* Staffify — unified analytics + conversion tracking
 * Loaded on every page. One place to manage everything.
 *
 * Vercel Web Analytics custom events work immediately (no ID needed).
 * To light up GA4 and the Meta pixel, paste the two IDs below — that's it.
 * -------------------------------------------------------------------- */
(function () {
  var CFG = {
    GA4_ID:              '',                 // paste 'G-XXXXXXXXXX' to enable Google Analytics 4
    META_PIXEL_ID:       '',                 // paste the numeric Meta pixel id to enable Facebook/Instagram tracking
    ADS_ID:              'AW-18080348527',    // existing Google Ads tag (remarketing + conversions)
    ADS_DISCOVERY_LABEL: ''                  // Google Ads conversion label for discovery-call bookings (add when ads go live)
  };

  /* ---- gtag base: GA4 + Google Ads ---- */
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  if (!window.gtag) window.gtag = gtag;
  var gtagId = CFG.GA4_ID || CFG.ADS_ID;
  if (gtagId && !document.querySelector('script[src*="googletagmanager.com/gtag/js"]')) {
    var g = document.createElement('script');
    g.async = true;
    g.src = 'https://www.googletagmanager.com/gtag/js?id=' + gtagId;
    document.head.appendChild(g);
    window.gtag('js', new Date());
  }
  if (CFG.GA4_ID) window.gtag('config', CFG.GA4_ID);
  if (CFG.ADS_ID) window.gtag('config', CFG.ADS_ID);

  /* ---- Meta (Facebook/Instagram) pixel ---- */
  if (CFG.META_PIXEL_ID && !window.fbq) {
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', CFG.META_PIXEL_ID);
    window.fbq('track', 'PageView');
  }

  /* ---- unified conversion fire (all platforms that are live) ---- */
  function track(name, meta) {
    try { if (window.va) window.va('event', { name: name, data: meta || {} }); } catch (e) {}  // Vercel (safe labels only)
    try { if (window.gtag && CFG.GA4_ID) window.gtag('event', name, meta || {}); } catch (e) {} // GA4
  }
  /* CLICKING A LINK IS NOT A BOOKING.
   *
   * This used to fire book_discovery_call, generate_lead, a Google Ads conversion and a Meta
   * Schedule the moment somebody clicked a Calendly link. Most of those clicks never became a
   * booking, so every downstream number was inflated and no campaign could be judged.
   *
   * Three stages now, and each one means what it says:
   *   booking_link_clicked   they clicked. Intent, not outcome. No conversion, no lead.
   *   request_submitted      the form came back successful and the request is stored.
   *   booked / paid          only ever from a verified provider event, server side, never here.
   */
  function fireBookingLinkClick(a) {
    var cta = '';
    try { var m = /utm_content=([^&]+)/.exec((a && a.getAttribute('href')) || ''); if (m) { cta = decodeURIComponent(m[1]); if (!/^[a-zA-Z0-9_.~-]{1,100}$/.test(cta)) cta = ''; } } catch (e) {}
    track('booking_link_clicked', { event_category: 'cta', event_label: 'calendly', page: location.pathname, cta: cta });
  }

  /* Called by a page ONLY after the server has confirmed the request is durably stored. */
  function fireRequestSubmitted(meta) {
    // Never the email, never their free text. Marketing platforms get the stage and nothing personal.
    var safe = { event_category: 'form', event_label: (meta && meta.form) || 'role_map_request' };
    track('request_submitted', safe);
    try { if (window.gtag && CFG.GA4_ID) window.gtag('event', 'generate_lead', { value: 1, currency: 'USD' }); } catch (e) {}
    try { if (window.gtag && CFG.ADS_ID && CFG.ADS_DISCOVERY_LABEL) window.gtag('event', 'conversion', { send_to: CFG.ADS_ID + '/' + CFG.ADS_DISCOVERY_LABEL }); } catch (e) {}
    try { if (window.fbq && CFG.META_PIXEL_ID) window.fbq('track', 'Lead'); } catch (e) {}
  }

  /* What is actually switched on, so an empty id reads as unconfigured rather than as silence. */
  function analyticsStatus() {
    return {
      vercel: !!window.va,
      ga4: CFG.GA4_ID ? 'configured' : 'unconfigured: GA4_ID is empty, so no GA4 event is sent',
      googleAds: CFG.ADS_ID
        ? (CFG.ADS_DISCOVERY_LABEL ? 'configured' : 'unconfigured: ADS_DISCOVERY_LABEL is empty, so no Ads conversion is sent')
        : 'unconfigured: ADS_ID is empty',
      meta: CFG.META_PIXEL_ID ? 'configured' : 'unconfigured: META_PIXEL_ID is empty, so no Meta event is sent',
    };
  }
  function fireApply() {
    track('apply_click', { event_category: 'cta', event_label: 'va_application' });
    try { if (window.fbq && CFG.META_PIXEL_ID) window.fbq('track', 'SubmitApplication'); } catch (e) {}
  }

  /* ---- delegated click listener: catches the CTAs no matter which page ---- */
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
    if (!a) return;
    var href = (a.getAttribute('href') || '').toLowerCase();
    if (href.indexOf('calendly.com') !== -1) { fireBookingLinkClick(a); return; }
    if (href.indexOf('mailto:') === 0)        { track('email_click', { event_category: 'contact', event_label: 'email' }); return; }
    if (href.indexOf('/apply') !== -1)        { fireApply(); return; }
  }, true);

  /* expose for manual/one-off use */
  window.staffifyTrack = track;
  window.staffifyRequestSubmitted = fireRequestSubmitted;
  window.staffifyAnalyticsStatus = analyticsStatus;
})();

/* Staffify — lead behavior tracking
 * Emails carry a lead id (?lid=). We store it, strip it from the address bar,
 * and report what that person does on the site to our own collector. No
 * third party, no cookies for anonymous visitors: with no id, this does
 * nothing at all.
 * -------------------------------------------------------------------- */
(function () {
  var ENDPOINT = 'https://staffify-rsvp.vercel.app/api/track';
  var KEY = 'sf_lid';
  var YEAR = 60 * 60 * 24 * 365;

  function store(lid) {
    try { localStorage.setItem(KEY, lid); } catch (e) {}
    try { document.cookie = KEY + '=' + lid + ';path=/;max-age=' + YEAR + ';samesite=lax'; } catch (e) {}
  }
  function read() {
    try { var v = localStorage.getItem(KEY); if (v) return v; } catch (e) {}
    var m = document.cookie.match(/(?:^|;\s*)sf_lid=([^;]+)/);
    return m ? m[1] : null;
  }

  /* pick the id off the link, then clean the URL so it is not visible or shareable */
  try {
    var params = new URLSearchParams(location.search);
    var fromUrl = params.get('lid');
    if (fromUrl && /^[A-Za-z0-9_-]{6,32}$/.test(fromUrl)) {
      store(fromUrl);
      params.delete('lid');
      var q = params.toString();
      history.replaceState({}, '', location.pathname + (q ? '?' + q : '') + location.hash);
    }
  } catch (e) {}

  var LID = read();
  if (!LID) return;              /* anonymous visitor: track nothing */

  function send(event, meta) {
    var payload = JSON.stringify({
      lid: LID,
      event: event,
      page: location.href,
      referrer: document.referrer || null,
      meta: meta || null
    });
    try { if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, payload)) return; } catch (e) {}
    try { fetch(ENDPOINT, { method: 'POST', body: payload, keepalive: true, headers: { 'Content-Type': 'text/plain' } }); } catch (e) {}
  }

  send('pageview', { title: document.title });

  /* clicks that leave the site or start a conversation */
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
    if (!a || !a.href) return;
    var href = a.href;
    var kind = /calendly\.com/i.test(href) ? 'booking'
             : /^mailto:/i.test(href) ? 'email'
             : /^tel:/i.test(href) ? 'phone'
             : (a.host && a.host !== location.host) ? 'outbound' : null;
    if (!kind) return;           /* internal links show up as the next pageview */
    send('click', { kind: kind, href: href, text: (a.textContent || '').trim().slice(0, 80) });
  }, true);

  /* how far down the page they actually got */
  var depths = {};
  window.addEventListener('scroll', function () {
    var h = document.documentElement;
    var pct = (h.scrollTop + window.innerHeight) / (h.scrollHeight || 1) * 100;
    [50, 90].forEach(function (mark) {
      if (pct >= mark && !depths[mark]) { depths[mark] = 1; send('scroll', { depth: mark }); }
    });
  }, { passive: true });

  /* time on page, sent as they leave */
  var start = Date.now();
  window.addEventListener('pagehide', function () {
    send('time', { seconds: Math.round((Date.now() - start) / 1000) });
  });
})();
