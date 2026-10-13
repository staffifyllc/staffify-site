export const DELAY=48*3600000;
export const SENDER='paul@trystaffify.com';
export function conversationEmail(firstName='',touch=1){
 const name=/^[\p{L}][\p{L} '\-]{0,35}$/u.test(firstName)?firstName:'there';
 const paragraphs=[
 ["Paul here, from Staffify. Curious what kind of business you run and what prompted you to grab the delegation playbook?","We help businesses find and support remote teammates. Sometimes that means freeing up the owner's time; sometimes it means adding capacity at a lower cost. I'd like to understand your setup before suggesting anything.","Could you tell me a little about your business and where things feel stretched right now? If it seems like we could help, would you be open to a quick 15-minute call to get to know each other?"],
 ["One thing that helps when looking at delegation: separate work that needs your judgment from work that just needs a reliable person and a clear process. The second list is usually where I'd start.","What does your team handle today, and what still keeps landing back on your plate? Happy to compare notes on a quick call if that's easier than typing it all out."],
 ["I'll leave this with you after this note. If you ever want to talk through where a remote teammate might fit, I'd be glad to learn more about your business and work out whether there's a sensible way to save you time or money.","Would a 15-minute chat be useful, or is this more of a later-on thing?"]
 ];
 return {subject:'What prompted you to grab the playbook?',body:['Hey '+name+',',...paragraphs[touch-1],'Paul\nStaffify',"If you'd like me to kick rocks and leave you alone, just say so :)"].join('\n\n')};
}
export function nextConversationAt(enrolledAt,events=[]){const sent=events.filter(e=>e.kind==='sent');return sent.length>=3?null:(sent.length?Date.parse(sent.at(-1).at):Number(enrolledAt))+DELAY;}
export function isWebsiteSource(source){return !/test|discovery-call-booked/i.test(String(source||''));}
