// Check only newly authored content; quoted historic messages are an audit trail.
import {replyText} from './_outreach-policy.js';
export function copyIssue(row,body=row.bodyText,subject=row.subject){
 const authored=replyText(String(subject||'')+'\n'+String(body||''));
 if(/\bflylisteopd\b/i.test(authored))return 'Brand spelling: use Flylisted';
 if(row.owner==='Madison'&&(/\bmy own agency\b/i.test(authored)||/\bI\s+(?:(?:built|founded|grew|own|started)\s+Flylisted|am\s+(?:the\s+)?founder\s+of\s+Flylisted)/i.test(authored)))return 'Madison must attribute Flylisted ownership and founder results to Paul';
 return null;
}

export function introduction(owner, firstName) {
 const intro=owner==='Madison'
  ? "I'm Madison with Staffify. I work with Paul, who runs Flylisted, a real estate media agency. We help owners hand off the work around their shoots."
  : "I'm Paul. I run Flylisted, a real estate media agency, and Staffify, where we help owners hand off the work around their shoots.";
 return ['Hi '+(firstName||'there')+',',intro,
  "One small thing you can try: keep photo revision requests in one shared list, with a person and a due date beside each change. It gives the team one place to check before anything comes back to you.",
  "We put together a few more practical handoffs here, if useful:\nhttps://www.gostaffify.com/blog/real-estate-photography-tasks-to-delegate/",
  "What tends to pull you away from running the business most: scheduling, revisions, or client follow-ups?",
  owner+'\nStaffify',"If you'd prefer no more emails, just let me know."].join('\n\n');
}
