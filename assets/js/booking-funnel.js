/* Scheduling diagnostics only. Provider webhooks remain the authority for booked/paid. */
(function () {
  'use strict';
  var seen = {};
  var names = {
    'calendly.event_type_viewed': 'scheduler_loaded',
    'calendly.date_and_time_selected': 'scheduler_time_selected',
    'calendly.event_scheduled': 'scheduler_completion_reported'
  };
  var cta = new URLSearchParams(location.search).get('utm_content') || 'book-direct';
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(cta)) cta = 'book-direct';
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
  window.addEventListener('message', function (e) {
    if (e.origin !== 'https://calendly.com' || !e.data || typeof e.data.event !== 'string') return;
    var frame = document.querySelector('.calendly-inline-widget iframe');
    if (!frame || e.source !== frame.contentWindow) return;
    var name = names[e.data.event];
    if (!name || seen[name]) return;
    seen[name] = true;
    // Deliberately exclude payload, invitee URLs, names, email and free text.
    window.va('event', { name: name, data: { page: '/book/', cta: cta, audience: 'employer', verification: 'browser_only' } });
  });
})();
