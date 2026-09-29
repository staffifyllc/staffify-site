const ONBOARD_ITEMS=new Set(['VA Staffing','Direct Hire VA (deleted)','Ai Agent (Sales) + VA Recruitment + VA','A List Staffing (deleted)','Training (deleted)','VA Change Processing Fee (deleted)']);
const DISCOUNTS=new Set(['Action Taker Price','Administrative Discount','Discount (deleted)','Credits Applied (deleted)']);
export function onboardingAmount(invoice){let amount=0,discount=0;for(const line of invoice.Line||[]){const name=line.SalesItemLineDetail?.ItemRef?.name;if(ONBOARD_ITEMS.has(name))amount+=Number(line.Amount)||0;else if(DISCOUNTS.has(name)||line.DetailType==='DiscountLineDetail')discount+=Math.abs(Number(line.Amount)||0);}return Math.max(0,amount-discount);}
export function invoicePayments(payment){return (payment.Line||[]).flatMap(line=>{const links=(line.LinkedTxn||[]).filter(x=>x.TxnType==='Invoice');return links.length===1?[{invoiceId:String(links[0].TxnId),amount:Number(line.Amount)||0}]:[];});}

export function commissionDeal(deal){return !/\bdiscovery\s+call\b/i.test(deal.name||deal.company||'');}

const PLACEMENT_ITEMS=new Set(['VA Staffing','Direct Hire VA (deleted)','Ai Agent (Sales) + VA Recruitment + VA','A List Staffing (deleted)']);
export function placementUnits(invoice){const units=[];for(const line of invoice.Line||[]){if(!PLACEMENT_ITEMS.has(line.SalesItemLineDetail?.ItemRef?.name))continue;const qty=Number(line.SalesItemLineDetail.Qty??1);if(!Number.isInteger(qty)||qty<1||qty>100)return [];for(let i=0;i<qty;i++)units.push(Math.max(0,Number(line.Amount)||0)/qty);}return units.filter(x=>x>0);}
