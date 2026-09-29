// Shared reply queue: a human reply stays visible until a later sent message is recorded.
(function(){
 function latestReply(row){return (row.events||[]).filter(e=>e.kind==='received'&&(!e.from||String(e.from).toLowerCase()===String(row.recipient).toLowerCase())).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0]||null;}
 function waiting(row){if(row.status!=='human_reply_hold')return false;const reply=latestReply(row);if(!reply)return true;return !(row.events||[]).some(e=>e.kind==='sent'&&Date.parse(e.at)>Date.parse(reply.at));}
 function queue(rows){return rows.filter(waiting).sort((a,b)=>Date.parse(latestReply(a)?.at||0)-Date.parse(latestReply(b)?.at||0));}
 window.StaffifyReplies={latestReply,waiting,queue};
})();
