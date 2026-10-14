// Check only newly authored content; quoted historic messages are an audit trail.
import {replyText} from './_outreach-policy.js';
export function copyIssue(row,body=row.bodyText,subject=row.subject){
 const authored=replyText(String(subject||'')+'\n'+String(body||''));
 if(/\bflylisteopd\b/i.test(authored))return 'Brand spelling: use Flylisted';
 if(row.owner==='Madison'&&(/\bmy own agency\b/i.test(authored)||/\bI\s+(?:(?:built|founded|grew|own|started)\s+Flylisted|am\s+(?:the\s+)?founder\s+of\s+Flylisted)/i.test(authored)))return 'Madison must attribute Flylisted ownership and founder results to Paul';
 return null;
}

export const INTRO_SUBJECT = 'When a client needs something mid-shoot';
export const INTRO_VERSION = 'client-service-2026-10-13';
export function introduction(owner, firstName) {
 const experience=owner==='Madison'
  ? "Paul, our founder, built Flylisted into a seven-figure agency. One thing he learned is that growth isn't just chasing the next client. It's badass customer service: putting out a fire quickly so an agent can get back to selling houses."
  : "Building Flylisted into a seven-figure agency taught me that growth isn't just chasing the next client. It's badass customer service: putting out a fire quickly so an agent can get back to selling houses.";
 return ['Hey '+(firstName||'there')+',',
  'Ever had an agent text “can you fix this real quick?” while you’re halfway through a shoot? You’ve seen it, but doing anything about it has to wait until you’re back at your desk.',
  experience,
  'That’s where we help at Staffify. We recruit, train, and support someone who can stay on top of client messages, coordinate revisions, and keep things moving while you’re in the field.',
  'Are you still the person everyone texts when something needs fixing?',
  owner+'\nStaffify',
  'If you’d like me to kick rocks and leave you alone, just say so :)'].join('\n\n');
}
