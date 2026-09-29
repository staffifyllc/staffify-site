// Financial data is private to the two named operators, regardless of general sales roles.
const FINANCE_EMAILS=new Set(['hello@gostaffify.com','paul@gostaffify.com','paul@staffifyhq.com','paul@trystaffify.com','paul@hirestaffify.com','madison@gostaffify.com']);
export const financeAccess=rep=>!!rep&&FINANCE_EMAILS.has(String(rep.email||'').toLowerCase());
export const financeMachine=req=>!!process.env.CRON_SECRET&&req.headers?.authorization==='Bearer '+process.env.CRON_SECRET;
