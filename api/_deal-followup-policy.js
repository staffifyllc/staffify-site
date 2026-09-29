export const DEAL_PIPELINE='914670001';
export const DEAL_STAGES={'1390230872':'Contacted','1390230873':'Replied / Engaged','1390230874':'Call Booked','1390230876':'Lost'};
export function dealBlock(properties,now=Date.now()){
 if(properties.pipeline!==DEAL_PIPELINE||!DEAL_STAGES[properties.dealstage])return 'Deal is not an open or lost Staffify opportunity';
 if(properties.hs_next_activity_date&&Date.parse(properties.hs_next_activity_date)>now)return 'A future meeting or next activity is already scheduled';
 const reason=String(properties.closed_lost_reason||'');
 if(/unsubscribe|do not|don.t contact|not interested|no thanks|not a fit|not qualified|wrong fit|bad fit|spam|competitor|hired|went with|chose another/i.test(reason))return 'Loss reason requires exclusion or human review';
 return null;
}
export function dealEmail(row,touch=0){
 const paragraphs=[
  'A practical way to decide whether help would be worthwhile is to list the recurring tasks that interrupt your week, then choose one with a clear finish line. We put together 15 examples for real estate media agencies, including revision tracking and delivery checks:\nhttps://www.gostaffify.com/blog/real-estate-photography-tasks-to-delegate/\n\nWhich task, if any, would you most like off your plate right now?',
  'For a first handoff, a revision log can be a useful starting point: the requested change, the person responsible, the deadline, and who approves the result. That makes the work easier to delegate without losing visibility. Is revision follow-through still taking your time?',
  'Another useful starting point is the final delivery check: compare the order with the finished files, confirm naming and links, and flag anything missing before the client is notified. Would that help your team, or is the bottleneck somewhere else?',
  'I will leave it here after this note. If staffing becomes relevant, you can reply with one recurring task, roughly how much time it takes, and what a good result looks like. That gives us a concrete starting point instead of a generic staffing conversation.'
 ];
 return ['Hi '+(row.verifiedFirstName||'there')+',',paragraphs[Math.min(touch,3)],row.owner+'\nStaffify',"If you would prefer no more emails, just let me know."].join('\n\n');
}
export function historyBlock(messages,recipient,senders,classify,now=Date.now()){
 if(messages.some(m=>/mailer-daemon|postmaster/i.test(m.from||'')))return 'bounce_hold';
 const verdict=classify(messages,recipient,senders);if(verdict.status)return verdict.status;
 if(messages.some(m=>m.draft))return 'existing_draft_hold';
 if(verdict.sent.length>=4)return 'sequence_complete_hold';
 if(new Set(verdict.sent.map(m=>m.mailbox)).size>1)return 'cross_account_history_hold';
 if(verdict.sent.some(m=>now-m.date<48*3600000))return 'followup_not_due_hold';
 return null;
}
