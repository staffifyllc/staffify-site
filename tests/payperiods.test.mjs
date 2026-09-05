import { periodByIndex, periodForWorkDate, periodsBetween, weekKey, nextPayDate, PAY_ANCHOR }
  from '../api/_payperiods.js';
let fail=0;
const eq=(a,b,m)=>{ const ok=JSON.stringify(a)===JSON.stringify(b); if(!ok){console.log(`  FAIL ${m}\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`);fail++;} else console.log(`  ok   ${m}`); };

const p0=periodByIndex(0);
eq(p0.payDate,'2026-09-11','period 0 pays on the anchor, 11 Sep');
eq(p0.start,'2026-08-28','period 0 starts 28 Aug');
eq(p0.end,'2026-09-10','period 0 ends 10 Sep, the day before payday');
eq((Date.parse(p0.end+'T00:00:00Z')-Date.parse(p0.start+'T00:00:00Z'))/864e5+1,14,'period 0 is exactly 14 days');

const p1=periodByIndex(1);
eq(p1.payDate,'2026-09-25','period 1 pays 25 Sep, a fortnight later');
eq(p1.start,'2026-09-11','period 1 starts the day after period 0 ends');
eq(p1.end,'2026-09-24','period 1 ends 24 Sep');

eq(periodByIndex(2).payDate,'2026-10-09','period 2 pays 9 Oct');
eq(periodByIndex(3).payDate,'2026-10-23','period 3 pays 23 Oct');

// the boundary that decides which fortnight a day's work is paid in
eq(periodForWorkDate('2026-09-10').payDate,'2026-09-11','work on 10 Sep is paid on 11 Sep');
eq(periodForWorkDate('2026-09-11').payDate,'2026-09-25','work ON payday waits for the next run');
eq(periodForWorkDate('2026-08-28').payDate,'2026-09-11','work on 28 Aug is the first day of period 0');
eq(periodForWorkDate('2026-08-27').payDate,'2026-08-28','work on 27 Aug belongs to the prior period');
eq(periodForWorkDate('2026-09-24').payDate,'2026-09-25','work on 24 Sep is paid 25 Sep');

// no day may fall outside the period that claims it
for (const d of ['2026-08-28','2026-09-01','2026-09-10','2026-09-11','2026-09-24','2026-10-05']) {
  const p=periodForWorkDate(d);
  if(!(d>=p.start && d<=p.end)){ console.log(`  FAIL ${d} not inside ${p.start}..${p.end}`); fail++; }
}
console.log('  ok   every sampled work date sits inside the period that claims it');

// DST boundary: US clocks change 1 Nov 2026. Periods must stay exactly 14 days.
for (const i of [3,4,5]) {
  const p=periodByIndex(i);
  const len=(Date.parse(p.end+'T00:00:00Z')-Date.parse(p.start+'T00:00:00Z'))/864e5+1;
  if(len!==14){ console.log(`  FAIL period ${i} (${p.start}..${p.end}) is ${len} days`); fail++; }
}
console.log('  ok   periods spanning the 1 Nov DST change are still 14 days');

eq(periodsBetween('2026-08-28','2026-09-24').map(p=>p.payDate),['2026-09-11','2026-09-25'],'periodsBetween spans two payouts');
eq(weekKey('2026-09-11'),'2026-09-07','week key is the Monday of that week');
eq(weekKey('2026-09-07'),'2026-09-07','a Monday is its own week key');
eq(weekKey('2026-09-13'),'2026-09-07','Sunday belongs to the Monday that started it');
eq(nextPayDate('2026-09-04').payDate,'2026-09-11','next payday from today is 11 Sep');
eq(nextPayDate('2026-09-11').payDate,'2026-09-11','on payday, that payday is still next');
eq(nextPayDate('2026-09-12').payDate,'2026-09-25','day after payday rolls to the next run');

console.log(fail? `\n  ${fail} FAILED` : '\n  all pay-period assertions pass');
process.exit(fail?1:0);
