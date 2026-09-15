// SALES LIVE: the owner control tower on gostaffify.com/hub/.
// One request a minute to /api/sales-live/ (a signed-in proxy to the lead-gen engine, which caches the
// summary for 60 seconds), only while the view is mounted and the browser tab is visible. A value the
// engine could not establish arrives as 'UNKNOWN' with a reason in unknown[] and is drawn as a muted
// "Unknown" with that reason on hover, never as 0.
(function(){
  const CSS = "  /* ================= SALES LIVE (owner control tower) ================= */\n  .sl-root{ --ink:#fff; --muted:#9ba1ab; --dim:#6e6e73; --line:rgba(255,255,255,.08); --line2:rgba(255,255,255,.14);\n    --warm:#34d399; --warm-soft:rgba(52,211,153,.13); --va:#5fe0fa; --sans:\"Inter\",-apple-system,sans-serif; --amber:#f5b83d; --amber-soft:rgba(245,184,61,.12); --orange:#fb923c; --orange-soft:rgba(251,146,60,.12);\n    --red:#f87171; --red-soft:rgba(248,113,113,.12); --grey:#7d8899; --grey-soft:rgba(125,136,153,.12);\n    --ch-email:#1abde1; --ch-call:#8b7cff; --ch-sms:#d9b779; --card:rgba(255,255,255,.035); --card2:#0d0f13; }\n  .sl-root{font-family:var(--sans);color:var(--ink)}\n  .sl-root button{font-family:inherit}\n  .sl-top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:0 0 16px}\n  .sl-title h2{font-size:28px;letter-spacing:-.02em;margin:0;font-weight:900;color:var(--ink);text-transform:none}\n  .sl-title .date{color:var(--muted);font-size:13px;margin-top:2px}\n  .sl-pill{display:inline-flex;align-items:center;gap:9px;border-radius:999px;padding:8px 14px;font-weight:700;font-size:13px;letter-spacing:.3px}\n  .sl-pill i{width:9px;height:9px;border-radius:50%;display:block}\n  .st-FLOWING{color:var(--warm);background:var(--warm-soft)} .st-FLOWING i{background:var(--warm)}\n  .st-BEHIND_PACE{color:var(--amber);background:var(--amber-soft)} .st-BEHIND_PACE i{background:var(--amber)}\n  .st-DEGRADED{color:var(--orange);background:var(--orange-soft)} .st-DEGRADED i{background:var(--orange)}\n  .st-BLOCKED{color:var(--red);background:var(--red-soft)} .st-BLOCKED i{background:var(--red)}\n  .st-OUTSIDE_WINDOW,.st-UNKNOWN{color:var(--grey);background:var(--grey-soft)} .st-OUTSIDE_WINDOW i,.st-UNKNOWN i{background:var(--grey)}\n  .sl-statusline{display:flex;flex-direction:column;align-items:flex-end;gap:4px}\n  .sl-statusline .detail{font-size:12.5px;color:var(--muted);text-align:right;max-width:52ch}\n  .sl-statusline .fresh{font-size:11.5px;color:var(--dim)}\n\n  .sl-layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:16px;align-items:start}\n  .sl-main{display:flex;flex-direction:column;gap:16px;min-width:0}\n  .sl-rail{position:sticky;top:84px}\n  .sl-row{display:grid;grid-template-columns:1.7fr 1fr;gap:16px}\n  .sl-row.even{grid-template-columns:1fr 1fr}\n  .sl-card{background:var(--card);border:1px solid rgba(255,255,255,.09);border-radius:16px;padding:16px 18px;min-width:0}\n  .sl-card h3{flex-wrap:wrap;margin:0 0 12px;font-size:11.5px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);font-weight:650;display:flex;justify-content:space-between;align-items:center;gap:10px}\n  .sl-card h3 small{text-transform:none;letter-spacing:0;font-weight:500;color:var(--dim);font-size:12px}\n  .sl-note{font-size:12.5px;color:var(--muted);line-height:1.5;margin-top:10px}\n  .sl-dim{color:var(--dim)}\n  .sl-unk{color:var(--dim);font-weight:600;border-bottom:1px dotted var(--dim);cursor:help}\n  .sl-num .sl-unk{font-size:.62em;font-weight:650;letter-spacing:0}\n  .sl-link{background:none;border:0;padding:0;color:inherit;font:inherit;cursor:pointer;text-align:inherit}\n  .sl-link:hover .sl-num,.sl-link:hover{color:#fff}\n  .sl-link:focus-visible{outline:2px solid var(--va);outline-offset:3px;border-radius:6px}\n  .tnum,.sl-num{font-variant-numeric:tabular-nums}\n\n  /* KPI strip */\n  .sl-kpis{margin-bottom:16px;display:grid;grid-template-columns:1.25fr repeat(6,minmax(0,1fr));background:var(--card);border:1px solid rgba(255,255,255,.09);border-radius:16px;overflow:hidden}\n  .sl-kpi{padding:14px 14px;border-left:1px solid var(--line);min-width:0}\n  .sl-kpi:first-child{border-left:0}\n  .sl-kpi .k{font-size:10.5px;letter-spacing:.35px;text-transform:uppercase;color:var(--muted);font-weight:600;line-height:1.3;min-height:2.6em}\n  .sl-kpi .sl-link{display:block;width:100%}\n  .sl-kpi .sl-num{font-size:28px;font-weight:750;letter-spacing:-.8px;line-height:1.1;margin-top:6px;display:block}\n  .sl-kpi .s{font-size:12px;color:var(--dim);margin-top:3px}\n  .sl-kpi.hero{background:linear-gradient(160deg,rgba(26,189,225,.12),rgba(26,189,225,.02))}\n  .sl-kpi.hero .sl-num{font-size:34px}\n  .sl-kpi.hero .s b{color:var(--ink);font-weight:600}\n  .sl-pace{display:inline-block;font-size:10.5px;font-weight:750;letter-spacing:.6px;text-transform:uppercase;border-radius:99px;padding:2px 8px;margin-left:6px;vertical-align:2px}\n  .pace-ON_PACE,.pace-AHEAD{color:var(--warm);background:var(--warm-soft)} .pace-BEHIND{color:var(--amber);background:var(--amber-soft)} .pace-UNKNOWN{color:var(--grey);background:var(--grey-soft)}\n  .sl-bar{height:4px;background:var(--line);border-radius:99px;overflow:hidden;margin-top:9px;position:relative}\n  .sl-bar i{display:block;height:100%;background:linear-gradient(90deg,#5fe0fa,#1abde1);border-radius:99px}\n  .sl-bar b{position:absolute;top:-3px;width:2px;height:10px;background:var(--muted);border-radius:1px}\n\n  /* chart */\n  .sl-chart svg{display:block;width:100%;height:auto}\n  .sl-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted);font-weight:500;text-transform:none;letter-spacing:0}\n  .sl-legend span{display:inline-flex;align-items:center;gap:6px}\n  .sl-legend i{width:9px;height:9px;border-radius:2px;display:block}\n  .sl-legend .exp{width:14px;height:0;border-top:2px dashed var(--muted);border-radius:0}\n\n  /* limiting factor */\n  .sl-limit .head{display:flex;align-items:center;gap:10px;margin-bottom:10px}\n  .sl-limit .head i{width:10px;height:10px;border-radius:50%;flex:0 0 auto}\n  .sl-limit .head b{font-size:18px;letter-spacing:-.2px;line-height:1.25}\n  .sev-ok i{background:var(--warm)} .sev-watch i{background:var(--amber)} .sev-blocked i{background:var(--red)}\n  .sl-facts{display:grid;grid-template-columns:1fr auto;gap:6px 14px;margin:4px 0 2px;font-size:13.5px}\n  .sl-facts dt{color:var(--muted)} .sl-facts dd{margin:0;font-weight:650;text-align:right}\n  .sl-action{margin-top:12px;padding-top:10px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted)}\n  .sl-action b{color:var(--ink)}\n\n  /* channels */\n  .sl-channels{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}\n  .sl-ch .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}\n  .sl-ch .name{display:flex;align-items:center;gap:8px;font-weight:700;font-size:14px}\n  .sl-ch .name i{width:8px;height:8px;border-radius:2px}\n  .sl-chip{font-size:10.5px;font-weight:750;letter-spacing:.5px;text-transform:uppercase;border-radius:99px;padding:3px 8px;white-space:nowrap}\n  .chip-ON_PACE,.chip-ok{color:var(--warm);background:var(--warm-soft)}\n  .chip-CAPPED,.chip-PAUSED_UNTIL_RESET,.chip-BEHIND{color:var(--amber);background:var(--amber-soft)}\n  .chip-DEGRADED{color:var(--orange);background:var(--orange-soft)}\n  .chip-NOT_ACTIVE,.chip-UNKNOWN{color:var(--grey);background:var(--grey-soft)}\n  .sl-ch .big{display:flex;align-items:baseline;gap:6px;margin:2px 0}\n  .sl-ch .big .sl-num{font-size:26px;font-weight:750;letter-spacing:-.6px}\n  .sl-ch .big small{color:var(--dim);font-size:13px}\n  .sl-kv{display:grid;grid-template-columns:1fr auto;gap:5px 12px;font-size:13px;margin-top:12px}\n  .sl-kv dt{color:var(--muted)} .sl-kv dd{margin:0;font-weight:600;text-align:right}\n  .sl-kv .sep{grid-column:1/-1;border-top:1px solid var(--line);margin:4px 0}\n  .sl-rates{display:flex;gap:18px;margin-top:10px;font-size:12px;color:var(--muted)}\n  .sl-rates b{display:block;font-size:17px;color:var(--ink);font-weight:700}\n  .sl-mini{font-size:12px;color:var(--dim);margin-top:10px;line-height:1.45}\n\n  /* funnel */\n  .sl-funnel{display:flex;align-items:stretch;gap:0}\n  .sl-fstep{flex:1;min-width:0;text-align:center;padding:4px 2px}\n  .sl-fstep .sl-num{font-size:24px;font-weight:750;display:block;letter-spacing:-.5px}\n  .sl-fstep .l{font-size:11px;color:var(--ink);line-height:1.3;font-weight:550}\n  .sl-fstep .c{font-size:11px;color:var(--dim);line-height:1.3;margin-top:2px}\n  .sl-farrow{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--dim);font-size:11px;padding:0 2px;min-width:12px}\n  .sl-farrow span{font-size:16px;line-height:1}\n  .sl-fbars{display:flex;gap:3px;height:6px;margin:10px 0 2px}\n  .sl-fbars i{flex:1;border-radius:2px;background:var(--ch-call)}\n  .sl-responses{display:flex;gap:18px;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}\n  .sl-responses b{color:var(--ink)}\n\n  /* drop-off */\n  .sl-conv{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px}\n  .sl-conv .sl-num{font-size:26px;font-weight:750}\n  .sl-drops{display:flex;flex-direction:column;gap:6px}\n  .sl-drop{display:grid;grid-template-columns:minmax(0,1fr) 44px;gap:10px;align-items:center;font-size:13px}\n  .sl-drop .lbl{display:flex;flex-direction:column;gap:3px;min-width:0}\n  .sl-drop .lbl span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n  .sl-drop .track2{height:5px;background:var(--line);border-radius:99px;overflow:hidden}\n  .sl-drop .track2 i{display:block;height:100%;background:#6f7d92;border-radius:99px}\n  .sl-drop .v{text-align:right;font-weight:650;font-variant-numeric:tabular-nums}\n  .sl-opener{margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}\n  .sl-opener table{width:100%;border-collapse:collapse;font-size:12.5px}\n  .sl-opener th{font-weight:600;color:var(--dim);text-align:right;padding:3px 0;font-size:11px;text-transform:uppercase;letter-spacing:.4px}\n  .sl-opener th:first-child,.sl-opener td:first-child{text-align:left}\n  .sl-opener th+th,.sl-opener td+td{padding-left:10px}\n  .sl-opener td{text-align:right;padding-top:4px;padding-bottom:4px;border-top:1px solid var(--line);font-variant-numeric:tabular-nums}\n\n  /* new import flow */\n  .sl-flow{display:flex;flex-direction:column;gap:7px}\n  .sl-flowrow{display:grid;grid-template-columns:130px minmax(0,1fr) 62px;gap:10px;align-items:center;font-size:13px}\n  .sl-flowrow .n{color:var(--muted)}\n  .sl-flowrow .t{height:8px;background:var(--line);border-radius:99px;overflow:hidden}\n  .sl-flowrow .t i{display:block;height:100%;background:#1abde1;border-radius:99px}\n  .sl-flowrow .v{text-align:right;font-weight:650;font-variant-numeric:tabular-nums}\n\n  /* lists */\n  .sl-list{display:grid;grid-template-columns:1fr auto;gap:6px 14px;font-size:13.5px}\n  .sl-list dt{color:var(--muted)} .sl-list dd{margin:0;text-align:right;font-weight:650;font-variant-numeric:tabular-nums}\n  .sl-list dd.warn{color:var(--amber)} .sl-list dd.bad{color:var(--red)}\n  .sl-followbig{display:flex;align-items:baseline;gap:10px;margin-bottom:10px}\n  .sl-followbig .sl-num{font-size:30px;font-weight:750}\n\n  /* system */\n  .sl-system{display:flex;align-items:center;gap:8px 18px;flex-wrap:wrap;padding:12px 18px}\n  .sl-system h3{margin:0 8px 0 0}\n  .sl-sys:hover{color:#5fe0fa}\n  .sl-sys{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:var(--ink);background:none;border:0;padding:0;cursor:pointer}\n  .sl-sys i{width:8px;height:8px;border-radius:50%}\n  .sys-ok i{background:var(--warm)} .sys-watch i{background:var(--amber)} .sys-bad i{background:var(--red)} .sys-unknown i{background:var(--grey)}\n  .sl-sys small{color:var(--dim)}\n  .sl-syslink{margin-left:auto;font-size:12.5px;color:var(--muted)}\n\n  /* activity feed */\n  .sl-feed ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}\n  .sl-feed li{display:grid;grid-template-columns:58px minmax(0,1fr);gap:8px;padding:8px 0;border-top:1px solid var(--line);font-size:13px}\n  .sl-feed li:first-child{border-top:0}\n  .sl-feed time{color:var(--dim);font-variant-numeric:tabular-nums;font-size:12px;padding-top:1px}\n  .sl-feed li>div{min-width:0}\n  .sl-feed .what{display:flex;align-items:center;gap:6px;font-weight:600}\n  .sl-feed .what i{width:7px;height:7px;border-radius:2px;flex:0 0 auto}\n  .sl-feed .who{color:var(--muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n  .fk-email i{background:var(--ch-email)} .fk-call_human i{background:var(--warm)} .fk-call_voicemail i{background:var(--ch-call)}\n  .fk-enrolled i{background:#9aa6ba} .fk-reply i{background:var(--amber)} .fk-dnc i{background:var(--red)} .fk-meeting i{background:var(--warm)}\n\n  /* drawer */\n  dialog.sl-drawer{margin:auto;inset:0;border:1px solid var(--line2);border-radius:16px;background:var(--card2);font-family:var(--sans);color:var(--ink);padding:0;width:min(640px,92vw);max-height:80vh}\n  dialog.sl-drawer::backdrop{background:rgba(5,8,14,.6)}\n  .sl-drawer header{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--line)}\n  .sl-drawer header b{font-size:15px}\n  .sl-drawer .body{padding:6px 18px 16px;overflow:auto;max-height:calc(80vh - 60px)}\n  .sl-drawer .r{display:grid;grid-template-columns:1fr auto;gap:2px 12px;padding:10px 0;border-top:1px solid var(--line);font-size:13.5px}\n  .sl-drawer .r:first-child{border-top:0}\n  .sl-drawer .r .d{grid-column:1/-1;color:var(--muted);font-size:12.5px}\n  .sl-drawer .r a{color:var(--va);text-decoration:none}\n  .sl-x{background:rgba(255,255,255,.06);border:1px solid var(--line2);color:var(--ink);border-radius:8px;padding:6px 10px;cursor:pointer;font:600 13px var(--sans)}\n\n  @media (max-width:1180px){\n    .sl-layout{grid-template-columns:minmax(0,1fr)} .sl-rail{position:static}\n    .sl-kpis{grid-template-columns:repeat(4,minmax(0,1fr))} .sl-kpi:nth-child(5){border-left:0}\n    .sl-kpi{border-top:1px solid var(--line)} .sl-kpi:nth-child(-n+4){border-top:0}\n  }\n  @media (max-width:820px){\n    .sl-layout,.sl-main,.sl-row,.sl-rail{display:contents}\n    .sl-root{display:flex;flex-direction:column;gap:14px}\n    .sl-title h2{font-size:24px}\n    .sl-top{margin-bottom:0}\n    #sl-kpis{order:2} #sl-limit{order:3} #sl-channels{order:4} #sl-funnel{order:5} #sl-feed{order:6}\n    #sl-chart{order:7} #sl-dropoff{order:8} #sl-followup{order:9} #sl-newimport{order:10} #sl-inventory{order:11} #sl-verify{order:12} #sl-system{order:13}\n    .sl-channels{grid-template-columns:minmax(0,1fr)}\n    .sl-kpis{grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--line);margin-bottom:0}\n    .sl-kpi,.sl-kpi:nth-child(n){border:0;background:#0b0c0f}\n    .sl-kpi.hero{grid-column:1/-1;background:linear-gradient(160deg,#0b2129,#0a1216)}\n    .sl-kpi .k{min-height:0}\n    .sl-funnel{flex-direction:column;gap:0}\n    .sl-farrow{display:none}\n    .sl-fstep{text-align:left;padding:7px 0;border-top:1px solid var(--line)} .sl-fstep:first-child{border-top:0}\n    .sl-fstep>.sl-link,.sl-fstep{display:grid;grid-template-columns:56px minmax(0,1fr) auto;align-items:baseline;gap:10px;width:100%}\n    .sl-fstep:has(>.sl-link){display:block}\n    .sl-fstep>.sl-link{padding:0}\n    .sl-fstep .sl-num{font-size:20px}\n    .sl-fstep .l{font-size:13.5px} .sl-fstep .c{margin:0;text-align:right}\n    .sl-kpi[data-m=\"1\"]{order:1} .sl-kpi[data-m=\"2\"]{order:2} .sl-kpi[data-m=\"3\"]{order:3} .sl-kpi[data-m=\"4\"]{order:4} .sl-kpi[data-m=\"5\"]{order:5} .sl-kpi[data-m=\"6\"]{order:6} .sl-kpi[data-m=\"7\"]{order:7}\n    .sl-statusline{align-items:flex-start} .sl-statusline .detail{text-align:left}\n    .sl-flowrow{grid-template-columns:104px minmax(0,1fr) 54px}\n  }\n  @media (prefers-reduced-motion:no-preference){ .sl-bar i,.sl-flowrow .t i,.sl-drop .track2 i{transition:width .4s ease} }\n\n";
  const MARKUP = "    <div class=\"sl-top\" id=\"sl-top\">\n      <div class=\"sl-title\"><h2 id=\"sl-day\">Today</h2><div class=\"date\" id=\"sl-date\">Loading\u2026</div></div>\n      <div class=\"sl-statusline\"><span class=\"sl-pill st-UNKNOWN\" id=\"sl-pill\"><i></i><span>Checking</span></span>\n        <div class=\"detail\" id=\"sl-detail\"></div><div class=\"fresh\" id=\"sl-fresh\"></div></div>\n    </div>\n    <section class=\"sl-kpis\" id=\"sl-kpis\" aria-label=\"Today at a glance\"></section>\n    <div class=\"sl-layout\">\n      <div class=\"sl-main\">\n        <div class=\"sl-row\">\n          <section class=\"sl-card sl-chart\" id=\"sl-chart\"><h3>Today's pace</h3></section>\n          <section class=\"sl-card sl-limit\" id=\"sl-limit\"><h3>What limits outreach right now</h3></section>\n        </div>\n        <section class=\"sl-channels\" id=\"sl-channels\" aria-label=\"Channels today\"></section>\n        <div class=\"sl-row\">\n          <section class=\"sl-card\" id=\"sl-funnel\"><h3>Today's human funnel</h3></section>\n          <section class=\"sl-card\" id=\"sl-dropoff\"><h3>Call conversion</h3></section>\n        </div>\n        <div class=\"sl-row even\">\n          <section class=\"sl-card\" id=\"sl-newimport\"><h3>The new list</h3></section>\n          <section class=\"sl-card\" id=\"sl-inventory\"><h3>REP inventory</h3></section>\n        </div>\n        <div class=\"sl-row even\">\n          <section class=\"sl-card\" id=\"sl-followup\"><h3>Human follow-up</h3></section>\n          <section class=\"sl-card\" id=\"sl-verify\"><h3>Contact verification</h3></section>\n        </div>\n        <section class=\"sl-card sl-system\" id=\"sl-system\"><h3>System</h3></section>\n      </div>\n      <aside class=\"sl-rail\"><section class=\"sl-card sl-feed\" id=\"sl-feed\"><h3>Live <small>commercial events</small></h3></section></aside>\n    </div>\n    <dialog class=\"sl-drawer\" id=\"sl-drawer\" aria-labelledby=\"sl-drawer-title\">\n      <header><b id=\"sl-drawer-title\">Details</b><button type=\"button\" class=\"sl-x\" id=\"sl-drawer-close\">Close</button></header>\n      <div class=\"body\" id=\"sl-drawer-body\"></div>\n    </dialog>\n";
  let root = null, timer = null;
  const q = s => root.querySelector(s);
  const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  // ================= SALES LIVE: THE OWNER CONTROL TOWER =================
  // One request (/api/sales-live-summary, cached 60s on the server) draws the whole tab. A value the
  // server could not establish arrives as 'UNKNOWN' with a reason in unknown[]; it is drawn as a muted
  // "Unknown" with that reason on hover, never as 0.
  let SL = null, SL_AT = 0, SL_ERR = '', SL_SYS = [];
  const SL_STATE = { FLOWING:'Flowing', BEHIND_PACE:'Behind pace', DEGRADED:'Degraded', BLOCKED:'Blocked', OUTSIDE_WINDOW:'Outside calling hours', UNKNOWN:'Unknown' };
  const SL_CHIP = { ON_PACE:'On pace', AHEAD:'Ahead', BEHIND:'Behind', CAPPED:'At limit', DEGRADED:'Degraded', NOT_ACTIVE:'Not active',
    PAUSED_UNTIL_RESET:'Used up', UNKNOWN:'Unknown', UNDER:'Under budget', OVER:'Over budget' };
  const slReason = f => { const u = SL && (SL.unknown||[]).find(x => x.field === f || (f && x.field.startsWith(f+'.'))); return u ? u.reason : 'Could not be read this refresh'; };
  const slKnown = v => typeof v === 'number' && isFinite(v);
  const slUnk = f => '<span class="sl-unk" title="'+esc(slReason(f))+'">Unknown</span>';
  // null means there is nothing to compute yet (no calls today, nobody waiting); only 'UNKNOWN' or a
  // missing field is a failed read.
  const sv = (v, f) => slKnown(v) ? esc(v.toLocaleString()) : v === null ? '<span class="sl-dim">None</span>' : (typeof v === 'string' && v && v !== 'UNKNOWN') ? esc(v) : slUnk(f);
  const spct = (v, f) => slKnown(v) ? esc((Math.round(v*10)/10)+'%') : v === null ? '<span class="sl-dim">None yet</span>' : slUnk(f);
  const schip = st => '<span class="sl-chip chip-'+esc(st||'UNKNOWN')+'">'+esc(SL_CHIP[st]||String(st||'Unknown').replace(/_/g,' ').toLowerCase())+'</span>';
  const drillBtn = (name, inner, label) => '<button type="button" class="sl-link" data-drill="'+esc(name)+'" aria-label="'+esc(label||name)+'">'+inner+'</button>';
  const kv = rows => '<dl class="sl-kv">'+rows.map(r => r==='sep' ? '<div class="sep"></div>' : '<dt>'+r[0]+'</dt><dd>'+r[1]+'</dd>').join('')+'</dl>';
  const etTime = iso => { try { return new Date(iso).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}); } catch(e){ return ''; } };

  async function slLoad(){
    try{
      const r = await fetch('/api/sales-live/',{cache:'no-store',credentials:'same-origin'});
      const d = await r.json().catch(() => null);
      if(!r.ok || !d || d.ok === false) throw new Error((d && d.error) || ('the server answered '+r.status));
      SL = d; SL_AT = Date.now(); SL_ERR = '';
      if(root) slRender();
    }catch(e){
      SL_ERR = String((e && e.message) || e);
      if(!root) return;
      if(!SL) slRenderFailure(); else slFresh();
    }
  }
  function slRenderFailure(){
    q('#sl-pill').className='sl-pill st-UNKNOWN'; q('#sl-pill').innerHTML='<i></i><span>Unknown</span>';
    q('#sl-detail').textContent='Sales Live could not load: '+SL_ERR+'. Retrying every minute.';
    for(const id of ['sl-kpis','sl-channels']) q('#'+id).innerHTML='';
  }
  function slFresh(){
    const el=q('#sl-fresh'); if(!el) return;
    if(!SL_AT){ el.textContent=''; return; }
    const s=Math.round((Date.now()-SL_AT)/1000);
    const age = s<60 ? 'just now' : Math.round(s/60)+' min ago';
    el.textContent = (SL_ERR ? 'Last refresh failed ('+SL_ERR+'). Showing data from ' : 'Updated ')+age;
  }

  function slRender(){
    const d=SL, t=d.today||{}, st=(d.status&&d.status.state)||'UNKNOWN';
    q('#sl-day').textContent = d.dayLabel||'Today';
    q('#sl-date').textContent = 'Business day since midnight ET';
    q('#sl-pill').className='sl-pill st-'+st; q('#sl-pill').innerHTML='<i></i><span>'+esc(SL_STATE[st]||st)+'</span>';
    q('#sl-detail').textContent = (d.status&&d.status.detail)||'';
    slFresh();

    // KPI strip. data-m is the phone order: pace first, then people, then volume.
    const pctTarget = slKnown(t.uniqueOwnersTouched)&&slKnown(t.target)&&t.target>0 ? Math.min(100, t.uniqueOwnersTouched/t.target*100) : null;
    const expPct = slKnown(t.expectedByNow)&&slKnown(t.target)&&t.target>0 ? Math.min(100, t.expectedByNow/t.target*100) : null;
    q('#sl-kpis').innerHTML =
      '<div class="sl-kpi hero" data-m="1"><div class="k">Owners touched</div><span class="sl-num">'+sv(t.uniqueOwnersTouched,'today.uniqueOwnersTouched')+'</span>'
        +'<div class="s">of <b>'+sv(t.target,'today.target')+'</b> target <span class="sl-pace pace-'+esc(t.pace||'UNKNOWN')+'">'+esc(SL_CHIP[t.pace]||'Pace unknown')+'</span></div>'
        +'<div class="sl-bar" title="'+(slKnown(t.expectedByNow)?esc(t.expectedByNow+' expected by now'):'')+'">'+(pctTarget!==null?'<i style="width:'+pctTarget.toFixed(1)+'%"></i>':'')+(expPct!==null?'<b style="left:'+expPct.toFixed(1)+'%"></b>':'')+'</div>'
        +'<div class="s">'+(slKnown(t.expectedByNow)?esc(t.expectedByNow)+' expected by now':'Expected by now: '+slUnk('today.expectedByNow'))+'</div></div>'
      +'<div class="sl-kpi" data-m="7"><div class="k">Qualified</div><span class="sl-num">'+sv(t.qualifiedInventory,'today.qualifiedInventory')+'</span><div class="s">REP inventory</div></div>'
      +'<div class="sl-kpi" data-m="6"><div class="k">Total touches</div><span class="sl-num">'+sv(t.totalTouches,'today.totalTouches')+'</span><div class="s">email, calls, texts</div></div>'
      +'<div class="sl-kpi" data-m="2">'+drillBtn('humans','<div class="k">Conversations</div><span class="sl-num">'+sv(t.humanConversations,'today.humanConversations')+'</span>','Human conversations today')
        +'<div class="s">'+drillBtn('substantive',sv(t.substantiveConversations,'today.substantiveConversations')+' substantive','Substantive conversations today')+'</div></div>'
      +'<div class="sl-kpi" data-m="3">'+drillBtn('positive','<div class="k">Positive</div><span class="sl-num">'+sv(t.positive,'today.positive')+'</span>','Positive responses')+'<div class="s">interested or warm</div></div>'
      +'<div class="sl-kpi" data-m="4">'+drillBtn('madison','<div class="k">To Madison</div><span class="sl-num">'+sv(t.madisonHandoffs,'today.madisonHandoffs')+'</span>','Handed to Madison')+'<div class="s">human handoffs</div></div>'
      +'<div class="sl-kpi" data-m="5"><div class="k">Meetings</div><span class="sl-num">'+sv(t.meetings,'today.meetings')+'</span><div class="s">booked today</div></div>';

    slChart(d.touchesByHour||[], d.overnight);
    slLimit(d.limitingFactor||{});
    slChannels((d.channels)||{});
    slFunnel(d.humanFunnel||{});
    slDropoff(d.callConversion||{}, d.openerTest||{});
    slNewImport(d.newImport||{});
    slInventory(d.inventory||{});
    slFollowUp(d.humanFollowUp||{});
    slVerify(d.contactVerification||{});
    slSystem(d.system||[]);
    slFeed(d.activity||[]);
  }

  function slChart(hours, overnight){
    const el=q('#sl-chart');
    const head='<h3>Today\'s pace <span class="sl-legend"><span><i style="background:var(--ch-email)"></i>Email</span><span><i style="background:var(--ch-call)"></i>Calls</span><span><i style="background:var(--ch-sms)"></i>Texts</span><span><i class="exp"></i>Expected</span></span></h3>';
    if(!hours.length){ el.innerHTML=head+'<div class="sl-note">The business day has not started. Touches appear here from 8 AM ET.</div>'; return; }
    const W=Math.max(300, Math.round((el.clientWidth||676)-36)), H=W<480?190:210, L=30, R=6, T=10, B=26, cw=W-L-R, ch=H-T-B;
    const tot = h => (slKnown(h.email)?h.email:0)+(slKnown(h.call)?h.call:0)+(slKnown(h.sms)?h.sms:0);
    let max = Math.max(1, ...hours.map(tot), ...hours.map(h=>slKnown(h.expected)?h.expected:0));
    const step = max<=5?1:max<=12?2:max<=30?5:max<=60?10:max<=150?25:50;
    max = Math.ceil(max/step)*step;
    const y = v => T + ch - v/max*ch;
    const slot = cw/hours.length, bw = Math.min(34, slot*0.62);
    let g='';
    for(let v=0; v<=max; v+=step){ g+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(v).toFixed(1)+'" y2="'+y(v).toFixed(1)+'" stroke="var(--line)" stroke-width="1"/>'
      +'<text x="'+(L-6)+'" y="'+(y(v)+3.5).toFixed(1)+'" text-anchor="end" font-size="10" fill="var(--dim)">'+v+'</text>'; }
    const every = Math.max(1, Math.ceil(hours.length/Math.floor(cw/34)));
    let bars='', exp=[];
    hours.forEach((h,i)=>{
      const cx = L + slot*i + slot/2, x = cx-bw/2;
      let base = 0;
      const unknownHour = !slKnown(h.email) && !slKnown(h.call) && !slKnown(h.sms);
      for(const [k,col] of [['email','var(--ch-email)'],['call','var(--ch-call)'],['sms','var(--ch-sms)']]){
        const v = slKnown(h[k]) ? h[k] : 0; if(!v) continue;
        bars+='<rect x="'+x.toFixed(1)+'" y="'+y(base+v).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+(y(base)-y(base+v)).toFixed(1)+'" fill="'+col+'" rx="1.5"><title>'+esc(h.label+': '+(h.email??'?')+' email, '+(h.call??'?')+' calls, '+(h.sms??'?')+' texts'+(slKnown(h.expected)?', '+h.expected+' expected':''))+'</title></rect>';
        base+=v;
      }
      if(unknownHour) bars+='<text x="'+cx.toFixed(1)+'" y="'+(y(0)-6)+'" text-anchor="middle" font-size="10" fill="var(--dim)">?</text>';
      if(i%every===0) bars+='<text x="'+cx.toFixed(1)+'" y="'+(H-8)+'" text-anchor="middle" font-size="10" fill="var(--muted)">'+esc(String(h.label||'').replace(' AM','a').replace(' PM','p'))+'</text>';
      if(slKnown(h.expected)) exp.push([L+slot*i, L+slot*(i+1), y(h.expected)]);
    });
    const expPath = exp.map((e,i)=>(i?'L':'M')+e[0].toFixed(1)+' '+e[2].toFixed(1)+' L'+e[1].toFixed(1)+' '+e[2].toFixed(1)).join(' ');
    const sum = hours.reduce((s,h)=>s+tot(h),0);
    const expSum = hours.reduce((s,h)=>s+(slKnown(h.expected)?h.expected:0),0);
    const on = overnight && (slKnown(overnight.email)||slKnown(overnight.call)||slKnown(overnight.sms)) ? ((overnight.email||0)+(overnight.call||0)+(overnight.sms||0)) : 0;
    el.innerHTML = head
      +'<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc(sum+' touches today by hour, '+expSum+' expected')+'">'+g+bars
      +(expPath?'<path d="'+expPath+'" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 3"/>':'')+'</svg>'
      +'<div class="sl-note">Business hours ET. '+esc(sum.toLocaleString())+' touches so far'+(expSum?' against '+esc(expSum.toLocaleString())+' expected':'')+'.'
      +(on?' Before 8 AM: '+esc(on)+' touches'+(overnight.note?' ('+esc(overnight.note.charAt(0).toLowerCase()+overnight.note.slice(1))+')':'')+'.':'')+'</div>';
  }

  function slLimit(f){
    const sev = f.severity||'watch';
    q('#sl-limit').innerHTML = '<h3>What limits outreach right now</h3>'
      +'<div class="head sev-'+esc(sev)+'"><i></i><b>'+esc(f.title||'Unknown')+'</b></div>'
      +(f.facts&&f.facts.length?'<dl class="sl-facts">'+f.facts.map(x=>'<dt>'+esc(x[0])+'</dt><dd class="tnum">'+(x[1]==='UNKNOWN'?slUnk('limitingFactor'):esc(x[1]))+'</dd>').join('')+'</dl>':'')
      +(f.explanation?'<div class="sl-note">'+esc(f.explanation)+'</div>':'')
      +'<div class="sl-action">Your action: <b>'+esc(f.paulAction||'None')+'</b></div>';
  }

  function slChannels(c){
    const e=c.email||{}, k=c.calls||{}, m=c.sms||{}, p=k.pacing||{}, cc=k.capacityCase||{}, tot=e.staffifyTotal||{};
    const card = (name, color, status, big, body) => '<section class="sl-card sl-ch"><div class="top"><span class="name"><i style="background:'+color+'"></i>'+name+'</span>'+schip(status)+'</div>'+big+body+'</section>';
    const email = card('Email', 'var(--ch-email)', e.status,
      '<div class="big"><span class="sl-num">'+sv(e.sent,'channels.email.sent')+'</span><small>of '+sv(e.safeCapacity,'channels.email.safeCapacity')+' safe today</small></div>',
      kv([['First emails',sv(e.firstTouches,'channels.email.firstTouches')],['Follow-ups',sv(e.followUps,'channels.email.followUps')],['Owners reached',sv(e.uniqueOwners,'channels.email.uniqueOwners')],
          ['Replies',sv(e.replies,'channels.email.replies')],['Positive',sv(e.positive,'channels.email.positive')]])
      +'<div class="sl-mini">REP campaign only. All Staffify email today: '+sv(tot.sent,'channels.email.staffifyTotal.sent')+' sent of '+sv(tot.safeCapacity,'channels.email.staffifyTotal.safeCapacity')+' safe.</div>');
    const pace = p.state==='PAUSED_UNTIL_RESET'
      ? 'Today\'s calls are used up. Calling resumes after '+esc(p.resetsAtEt||'the reset')+'.'
      : [slKnown(p.expectedByNow)?esc(p.expectedByNow)+' expected by now':'', slKnown(p.remaining)?esc(p.remaining)+' left today':'', p.nextRelease?'next: '+esc(p.nextRelease):''].filter(Boolean).join(' · ');
    const calls = card('Calls', 'var(--ch-call)', p.state||k.status,
      '<div class="big"><span class="sl-num">'+sv(k.attempts,'channels.calls.attempts')+'</span><small>of '+sv(k.dailyAllowance,'channels.calls.dailyAllowance')+' today</small></div>',
      '<div class="sl-rates"><div><b>'+spct(k.answerRatePct,'channels.calls.answerRatePct')+'</b>answered by a person</div><div><b>'+spct(k.substantiveRatePct,'channels.calls.substantiveRatePct')+'</b>real conversation</div></div>'
      +kv([[drillBtn('humans','Answered by a person','Human answers'),drillBtn('humans',sv(k.humanAnswers,'channels.calls.humanAnswers'),'Human answers')],
          [drillBtn('substantive','Real conversations','Substantive calls'),drillBtn('substantive',sv(k.substantive,'channels.calls.substantive'),'Substantive calls')],
          ['Voicemails left',sv(k.voicemails,'channels.calls.voicemails')],['Callbacks',sv(k.callbacks,'channels.calls.callbacks')],
          ['Positive',sv(k.positive,'channels.calls.positive')],['Asked not to be called',sv(k.dnc,'channels.calls.dnc')]])
      +(pace?'<div class="sl-mini">'+pace+'</div>':'')
      +'<div class="sl-mini">'+(cc.available
          ? 'Capacity case: '+sv(cc.demandPerDay)+' owners a day want calls, the plan allows '+sv(cc.currentPlanPerDay)+'. Build plan adds about $'+sv(cc.incrementalMonthly)+'/mo'+(slKnown(cc.costPerSubstantive)?', $'+esc(cc.costPerSubstantive)+' per real conversation':'')+'.'
          : esc(cc.note||'Full-day call benchmark available after the first corrected 100-call day.'))+'</div>');
    const sms = m.status==='NOT_ACTIVE'
      ? card('Texts', 'var(--ch-sms)', 'NOT_ACTIVE', '<div class="big"><span class="sl-num" style="font-size:20px">Not active</span></div>',
          '<div class="sl-note">'+esc(m.reason||'Business texting approval pending')+'.</div><div class="sl-mini">Impact: '+esc(m.impact||'Email and calling unaffected')+'.'
          +(slKnown(m.eligible)?' '+esc(m.eligible.toLocaleString())+' owners are ready to text once it is approved.':'')+'</div>')
      : card('Texts', 'var(--ch-sms)', m.status, '<div class="big"><span class="sl-num">'+sv(m.sent,'channels.sms.sent')+'</span><small>sent today</small></div>',
          kv([['Ready to text',sv(m.eligible,'channels.sms.eligible')],['Replies',sv(m.replies,'channels.sms.replies')],['Positive',sv(m.positive,'channels.sms.positive')]]));
    q('#sl-channels').innerHTML = email+calls+sms;
  }

  function slFunnel(f){
    const c=f.calls||{}, r=f.responses||{};
    const steps=[['Calls',c.attempts,'humanFunnel.calls.attempts'],['Answered',c.humanAnswers,'humanFunnel.calls.humanAnswers','humans'],['Conversation',c.substantive,'humanFunnel.calls.substantive','substantive'],
      ['Positive',c.positive,'humanFunnel.calls.positive','positive'],['Madison',c.madison,'humanFunnel.calls.madison','madison'],['Meeting',c.meetings,'humanFunnel.calls.meetings']];
    let html='<div class="sl-funnel">';
    steps.forEach((s,i)=>{
      let conv='';
      if(i){ const a=steps[i-1][1], b=s[1]; conv = slKnown(a)&&slKnown(b)&&a>0 ? Math.round(b/a*100)+'% of previous' : ''; html+='<div class="sl-farrow" aria-hidden="true"><span>›</span></div>'; }
      const inner='<span class="sl-num">'+sv(s[1],s[2])+'</span><div class="l">'+s[0]+'</div><div class="c">'+(conv||'&nbsp;')+'</div>';
      html+='<div class="sl-fstep">'+(s[3]?drillBtn(s[3],inner,s[0]):inner)+'</div>';
    });
    html+='</div>';
    q('#sl-funnel').innerHTML='<h3>Today\'s human funnel <small>REP calls</small></h3>'+html
      +'<div class="sl-responses"><span>Email replies <b>'+sv(r.emailReplies,'humanFunnel.responses.emailReplies')+'</b></span><span>Text replies <b>'+sv(r.smsReplies,'humanFunnel.responses.smsReplies')+'</b></span><span>People who responded, all channels <b>'+sv(r.humanResponsesTotal,'humanFunnel.responses.humanResponsesTotal')+'</b></span></div>';
  }

  function slDropoff(cv, ot){
    const drops=(cv.dropOff||[]).filter(x=>slKnown(x[1])&&x[1]>0).slice().sort((a,b)=>b[1]-a[1]);
    const max=Math.max(1,...drops.map(x=>x[1]));
    const rows=drops.map(x=>{ const inner='<div class="lbl"><span>'+esc(x[0])+'</span><div class="track2"><i style="width:'+(x[1]/max*100).toFixed(1)+'%"></i></div></div><div class="v">'+esc(x[1])+'</div>';
      return x[2]==='HUNG_UP_AFTER_OPENER' ? drillBtn('hungup','<div class="sl-drop">'+inner+'</div>','Calls that hung up after the opener') : '<div class="sl-drop">'+inner+'</div>'; }).join('');
    let opener='';
    const vars=ot.variants||[];
    if(vars.length){
      opener='<div class="sl-opener"><h3>Opener test '+(ot.state==='LEADER'&&ot.leader?schip('ON_PACE').replace('On pace','Leader: '+esc(ot.leader)):'<small>'+(ot.state==='TIE'?'Tied so far':'Insufficient data')+'</small>')+'</h3>'
        +'<div style="overflow-x:auto"><table><thead><tr><th>Opener</th><th>Calls</th><th>Answered</th><th>Conv.</th><th>Rate</th><th>Hung up</th></tr></thead><tbody>'
        +vars.map(v=>'<tr><td>'+esc(v.label||v.key)+'</td><td>'+sv(v.calls)+'</td><td>'+sv(v.humanAnswers)+'</td><td>'+sv(v.substantive)+'</td><td>'+(ot.state==='INSUFFICIENT_DATA'?'<span class="sl-dim">not yet</span>':spct(v.substantivePct))+'</td><td>'+(ot.state==='INSUFFICIENT_DATA'?'<span class="sl-dim">not yet</span>':spct(v.hangUpPct))+'</td></tr>').join('')
        +'</tbody></table></div><div class="sl-mini">'+esc(ot.note||('Needs '+(ot.minHumanAnswersPerVariant||30)+' answered calls per opener before calling a winner.'))+'</div></div>';
    }
    q('#sl-dropoff').innerHTML='<h3>Call conversion <small>'+esc(cv.window||'')+'</small></h3>'
      +'<div class="sl-conv"><span class="sl-num">'+spct(cv.conversionPct,'callConversion.conversionPct')+'</span><span class="sl-dim">'+sv(cv.substantive,'callConversion.substantive')+' of '+sv(cv.humanAnswers,'callConversion.humanAnswers')+' people who answered had a real conversation</span></div>'
      +(rows?'<div class="sl-note" style="margin:0 0 8px">Why the rest ended early</div><div class="sl-drops">'+rows+'</div>':'<div class="sl-note">No answered calls to explain yet.</div>');
    q('#sl-funnel').insertAdjacentHTML('beforeend', opener);
  }

  function slNewImport(n){
    const total = slKnown(n.owners)?n.owners:null;
    const row=(label,v,f)=>'<div class="sl-flowrow"><span class="n">'+label+'</span><span class="t">'+(total&&slKnown(v)?'<i style="width:'+Math.min(100,v/total*100).toFixed(1)+'%"></i>':'')+'</span><span class="v">'+sv(v,'newImport.'+f)+'</span></div>';
    q('#sl-newimport').innerHTML='<h3>'+esc(n.label||'The new list')+' '+drillBtn('newImport','<small>'+sv(n.owners,'newImport.owners')+' owners ›</small>','Owners in the new list')+'</h3>'
      +'<div class="sl-flow">'+row('In HubSpot',n.inHubSpot,'inHubSpot')+row('Contact verified',n.verified,'verified')+row('Can email',n.emailEligible,'emailEligible')
      +row('Can call',n.callEligible,'callEligible')+row('Can text',n.smsEligible,'smsEligible')+row('In email sequence',n.instantlyEnrolled,'instantlyEnrolled')+row('Touched',n.touched,'touched')+'</div>';
  }

  function slInventory(v){
    const warn=(x)=>slKnown(x)&&x>0?' class="warn"':'';
    q('#sl-inventory').innerHTML='<h3>REP inventory <small>'+(slKnown(v.coverageOfEligiblePct)?esc(v.coverageOfEligiblePct)+'% of eligible owners covered':'')+'</small></h3>'
      +'<dl class="sl-list"><dt>Qualified owners</dt><dd>'+sv(v.qualified,'inventory.qualified')+'</dd><dt>Ready to contact now</dt><dd>'+sv(v.readyNow,'inventory.readyNow')+'</dd>'
      +'<dt>Added in the last 7 days</dt><dd>'+sv(v.newWithin7Days,'inventory.newWithin7Days')+'</dd><dt>In active outreach</dt><dd>'+sv(v.activeOutreach,'inventory.activeOutreach')+'</dd>'
      +'<dt>Due for the next quarter</dt><dd>'+sv(v.quarterlyDue,'inventory.quarterlyDue')+'</dd><dt>With a person (Madison)</dt><dd>'+sv(v.humanOwned,'inventory.humanOwned')+'</dd>'
      +'<dt>Do not contact</dt><dd>'+sv(v.suppressed,'inventory.suppressed')+'</dd><dt>Overdue for first touch</dt><dd'+warn(v.overdue)+'>'+sv(v.overdue,'inventory.overdue')+'</dd>'
      +'<dt>Stuck with no next step</dt><dd'+warn(v.orphaned)+'>'+sv(v.orphaned,'inventory.orphaned')+'</dd></dl>';
  }

  function slFollowUp(h){
    q('#sl-followup').innerHTML='<h3>Human follow-up '+drillBtn('madison','<small>Open list ›</small>','People waiting on Madison')+'</h3>'
      +'<div class="sl-followbig"><span class="sl-num">'+sv(h.needsMadisonNow,'humanFollowUp.needsMadisonNow')+'</span><span class="sl-dim">need Madison now</span></div>'
      +'<dl class="sl-list"><dt>Due today</dt><dd>'+sv(h.dueToday,'humanFollowUp.dueToday')+'</dd><dt>Overdue</dt><dd'+(slKnown(h.overdue)&&h.overdue>0?' class="bad"':'')+'>'+sv(h.overdue,'humanFollowUp.overdue')+'</dd>'
      +'<dt>Meetings today</dt><dd>'+sv(h.meetingsToday,'humanFollowUp.meetingsToday')+'</dd><dt>Oldest waiting</dt><dd>'+(slKnown(h.oldestActionableHours)?esc(h.oldestActionableHours)+'h':h.oldestActionableHours===null?'<span class="sl-dim">None</span>':slUnk('humanFollowUp.oldestActionableHours'))+'</dd></dl>'
      +(h.summary?'<div class="sl-note">'+esc(h.summary)+'</div>':'');
  }

  function slVerify(v){
    q('#sl-verify').innerHTML='<h3>Contact verification '+schip(v.status)+'</h3>'
      +(v.plain?'<div class="sl-note" style="margin:0 0 10px;color:var(--ink)">'+esc(v.plain)+'</div>':'')
      +'<dl class="sl-list"><dt>Checked this cycle</dt><dd>'+sv(v.verifiedThisCycle,'contactVerification.verifiedThisCycle')+'</dd><dt>Checks left</dt><dd>'+sv(v.creditsRemaining,'contactVerification.creditsRemaining')+'</dd>'
      +'<dt>Expected left at reset'+(v.resetLabel?' ('+esc(v.resetLabel)+')':'')+'</dt><dd>'+sv(v.projectedAtReset,'contactVerification.projectedAtReset')+'</dd><dt>Email-finding credits</dt><dd>'+sv(v.finderCredits,'contactVerification.finderCredits')+'</dd></dl>';
  }

  function slSystem(rows){
    SL_SYS = rows;
    q('#sl-system').innerHTML='<h3>System</h3>'+rows.map((r,i)=>'<button type="button" class="sl-sys sys-'+esc(r.state||'unknown')+'" data-sys="'+i+'" title="'+esc(r.detail||'')+'"><i></i>'+esc(r.label)+(r.key==='database'&&r.detail?' <small>'+esc(r.detail)+'</small>':'')+'</button>').join('')
      +'<button type="button" class="sl-link sl-syslink" data-sys="all">Details ›</button>';
  }
  function slSystemDrawer(){
    const dlg=q('#sl-drawer');
    q('#sl-drawer-title').textContent='System';
    const word={ok:'Working',watch:'Watch',bad:'Failing',unknown:'Unknown'};
    q('#sl-drawer-body').innerHTML=(SL_SYS||[]).map(r=>'<div class="r"><b><span class="sl-sys sys-'+esc(r.state||'unknown')+'" style="cursor:default"><i></i>'+esc(r.label)+'</span></b><span class="sl-dim">'+esc(word[r.state]||'Unknown')+'</span><div class="d">'+esc(r.detail||'No detail reported.')+'</div></div>').join('')||'<div class="sl-note">No system checks reported.</div>';
    if(typeof dlg.showModal==='function' && !dlg.open) dlg.showModal();
  }

  const SL_KIND = { email:'Email sent', call_human:'Person answered', call_voicemail:'Voicemail left', call_machine:'Call, no answer', enrolled:'Added to sequence', reply:'Reply', dnc:'Do not contact', meeting:'Meeting booked' };
  function slFeed(items){
    const list = items.slice(0,25).map(a=>'<li class="fk-'+esc(a.kind)+'"><time datetime="'+esc(a.at)+'">'+esc(etTime(a.at))+'</time><div><div class="what"><i></i>'+esc(a.label||SL_KIND[a.kind]||a.kind)+'</div>'
      +'<div class="who" title="'+esc([a.who,a.detail].filter(Boolean).join(' · '))+'">'+esc(a.who||'')+(a.detail?' · '+esc(a.detail):'')+'</div></div></li>').join('');
    q('#sl-feed').innerHTML='<h3>Live <small>commercial events, ET</small></h3>'+(list?'<ol>'+list+'</ol>':'<div class="sl-note">No commercial events yet today.</div>');
  }

  // DRILL-DOWNS. Numbers with a list behind them open it; the list is fetched only when opened.
  async function slDrill(name){
    const dlg=q('#sl-drawer'), body=q('#sl-drawer-body');
    q('#sl-drawer-title').textContent='Loading…'; body.innerHTML='<div class="sl-note">Loading…</div>';
    if(typeof dlg.showModal==='function' && !dlg.open) dlg.showModal();
    try{
      const r=await fetch('/api/sales-live/?drill='+encodeURIComponent(name),{cache:'no-store',credentials:'same-origin'});
      const d=await r.json();
      if(!r.ok||!d||d.ok===false) throw new Error((d&&d.error)||('the server answered '+r.status));
      if(!root) return;
      q('#sl-drawer-title').textContent=d.title||name;
      const safe = u => /^https:\/\//i.test(String(u||'')) ? u : '';
      body.innerHTML = (d.rows||[]).length ? d.rows.map(x=>'<div class="r"><b>'+esc(x.who||x.company||'Unnamed')+(x.who&&x.company?' <span class="sl-dim">· '+esc(x.company)+'</span>':'')+'</b>'
          +'<span class="sl-dim tnum">'+(x.at?esc(new Date(x.at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/New_York'})):'')+'</span>'
          +(x.detail||safe(x.link)?'<div class="d">'+esc(x.detail||'')+(safe(x.link)?' <a href="'+esc(safe(x.link))+'" target="_blank" rel="noopener noreferrer">Open ›</a>':'')+'</div>':'')+'</div>').join('')
        : '<div class="sl-note">Nobody here right now.</div>';
    }catch(e){ q('#sl-drawer-title').textContent='Could not load'; body.innerHTML='<div class="sl-note">'+esc(String((e&&e.message)||e))+'. Close and try again.</div>'; }
  }
  function onClick(e){
    const s=e.target.closest('[data-sys]'); if(s){ e.preventDefault(); slSystemDrawer(); return; }
    const b=e.target.closest('[data-drill]'); if(b){ e.preventDefault(); slDrill(b.dataset.drill); return; }
    if(e.target.id==='sl-drawer-close' || e.target.id==='sl-drawer') q('#sl-drawer').close();
  }
  let resizeT=null;
  function onResize(){ clearTimeout(resizeT); resizeT=setTimeout(()=>{ if(root && SL) slChart(SL.touchesByHour||[], SL.overnight); }, 200); }
  function onVisible(){ if(root && !document.hidden && Date.now()-SL_AT >= 60000) slLoad(); }

  function mount(el){
    if(root) unmount();
    if(!document.getElementById('sl-css')){ const st=document.createElement('style'); st.id='sl-css'; st.textContent=CSS; document.head.appendChild(st); }
    root = el; root.classList.add('sl-root'); root.innerHTML = MARKUP;
    root.addEventListener('click', onClick);
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisible);
    if(SL){ slRender(); }
    slLoad();
    timer = setInterval(()=>{ if(root && !document.hidden) { if(Date.now()-SL_AT >= 55000) slLoad(); else slFresh(); } }, 15000);
  }
  function unmount(){
    if(!root) return;
    clearInterval(timer); timer=null;
    root.removeEventListener('click', onClick);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisible);
    root.innerHTML=''; root.classList.remove('sl-root'); root=null;
  }
  window.StaffifySalesLive = { mount, unmount };
})();
