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
    try { if (window.va) window.va('event', { name: name }); } catch (e) {}          // Vercel — works now
    try { if (window.gtag && CFG.GA4_ID) window.gtag('event', name, meta || {}); } catch (e) {} // GA4
  }
  function fireDiscoveryCall() {
    track('book_discovery_call', { event_category: 'cta', event_label: 'calendly' });
    try { if (window.gtag && CFG.GA4_ID) window.gtag('event', 'generate_lead', { value: 1, currency: 'USD' }); } catch (e) {}
    try { if (window.gtag && CFG.ADS_ID && CFG.ADS_DISCOVERY_LABEL) window.gtag('event', 'conversion', { send_to: CFG.ADS_ID + '/' + CFG.ADS_DISCOVERY_LABEL }); } catch (e) {}
    try { if (window.fbq && CFG.META_PIXEL_ID) window.fbq('track', 'Schedule'); } catch (e) {}
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
    if (href.indexOf('calendly.com') !== -1) { fireDiscoveryCall(); return; }
    if (href.indexOf('mailto:') === 0)        { track('email_click', { event_label: href.replace('mailto:', '') }); return; }
    if (href.indexOf('/apply') !== -1)        { fireApply(); return; }
  }, true);

  /* expose for manual/one-off use */
  window.staffifyTrack = track;
})();
