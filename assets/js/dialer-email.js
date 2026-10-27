// Compose as the signed-in rep, never the campaign mailbox or Gmail account 0.
export function repMailbox(viewer) {
  const email = String(viewer || '').trim().toLowerCase();
  return email === 'miltion@trystaffify.com' ? 'milton@trystaffify.com' : email;
}
export function emailCompose(viewer, recipient) {
  const from = repMailbox(viewer), to = String(recipient || '').trim();
  const valid = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (!valid(from) || !valid(to)) return null;
  const url = new URL('https://mail.google.com/mail/u/');
  url.search = new URLSearchParams({authuser: from, view: 'cm', fs: '1', to}).toString();
  return {from, to, url: url.toString()};
}
