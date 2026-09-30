// Check only newly authored content; quoted historic messages are an audit trail.
import {replyText} from './_outreach-policy.js';
export function copyIssue(row,body=row.bodyText,subject=row.subject){
 const authored=replyText(String(subject||'')+'\n'+String(body||''));
 if(/\bflylisteopd\b/i.test(authored))return 'Brand spelling: use Flylisted';
 if(row.owner==='Madison'&&(/\bmy own agency\b/i.test(authored)||/\bI\s+(?:(?:built|founded|grew|own|started)\s+Flylisted|am\s+(?:the\s+)?founder\s+of\s+Flylisted)/i.test(authored)))return 'Madison must attribute Flylisted ownership and founder results to Paul';
 return null;
}
