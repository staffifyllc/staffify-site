// THE FOUNDER PILOT WORK QUEUE, on gostaffify.com/pilot/.
//
// One screen that answers "who is waiting on me, and what did they actually say". Everything it shows
// comes from /api/pilot-queue (signed-in proxy). Three rules are visible in the interface itself,
// because the last funnel failed by blurring them:
//
//   * A REQUEST IS NOT A BOOKING. The button that marks a call booked will not accept a state without
//     a calendar reference, and says so.
//   * A TASK IS NOT A SEND. Role map promised and role map sent are different rows and different counts.
//   * SILENCE IS NOT AN OBJECTION. No response is its own column, and a reason cannot be recorded
//     without the owner's own words.
(function () {
  var CSS = [
    '.pq{--ink:#fff;--muted:#9ba1ab;--dim:#6e6e73;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);',
    '--warm:#34d399;--warm-soft:rgba(52,211,153,.13);--amber:#f5b83d;--amber-soft:rgba(245,184,61,.12);',
    '--red:#f87171;--red-soft:rgba(248,113,113,.12);--cy:#5fe0fa;--grey:#7d8899;--grey-soft:rgba(125,136,153,.12);',
    '--card:rgba(255,255,255,.035);--sans:"Inter",-apple-system,sans-serif;font-family:var(--sans);color:var(--ink)}',
    '.pq button{font-family:inherit}',
    '.pq-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin:0 0 18px}',
    '.pq-top h2{font-size:28px;font-weight:900;letter-spacing:-.02em;margin:0}',
    '.pq-top .sub{color:var(--muted);font-size:13px;margin-top:3px}',
    '.pq-card{background:var(--card);border:1px solid rgba(255,255,255,.09);border-radius:16px;padding:16px 18px;margin-bottom:16px}',
    '.pq-card>h3{margin:0 0 12px;font-size:11.5px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);font-weight:650;display:flex;justify-content:space-between;align-items:center;gap:10px}',
    '.pq-card>h3 small{text-transform:none;letter-spacing:0;font-weight:500;color:var(--dim);font-size:12px}',
    '.pq-arms{display:grid;grid-template-columns:1fr 1fr;gap:16px}',
    '.pq-arm h4{font-size:13px;font-weight:800;margin:0 0 10px;letter-spacing:.02em}',
    '.pq-arm .who{color:var(--dim);font-weight:500;font-size:12px;display:block;margin-top:2px}',
    '.pq-rows{display:grid;grid-template-columns:1fr auto;gap:5px 12px;font-size:13.5px}',
    '.pq-rows dt{color:var(--muted)} .pq-rows dd{margin:0;text-align:right;font-weight:650;font-variant-numeric:tabular-nums}',
    '.pq-rows dd.z{color:var(--dim);font-weight:500}',
    '.pq-rows .sep{grid-column:1/-1;border-top:1px solid var(--line);margin:5px 0}',
    '.pq-unk{color:var(--dim);font-weight:600;border-bottom:1px dotted var(--dim);cursor:help}',
    '.pq-gap{color:var(--amber)}',
    '.pq-item{border-top:1px solid var(--line);padding:13px 0}',
    '.pq-item:first-of-type{border-top:0}',
    '.pq-h{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}',
    '.pq-h b{font-size:15px;font-weight:700}',
    '.pq-h .st{font-size:10.5px;font-weight:750;letter-spacing:.5px;text-transform:uppercase;border-radius:99px;padding:3px 9px;white-space:nowrap}',
    '.st-do{color:var(--cy);background:rgba(95,224,250,.12)} .st-late{color:var(--red);background:var(--red-soft)}',
    '.st-ok{color:var(--warm);background:var(--warm-soft)} .st-idle{color:var(--grey);background:var(--grey-soft)}',
    '.st-warn{color:var(--amber);background:var(--amber-soft)}',
    '.pq-meta{color:var(--dim);font-size:12px;margin-top:3px}',
    '.pq-said{margin:9px 0 0;padding:9px 12px;border-left:2px solid var(--cy);background:rgba(95,224,250,.05);',
    'font-size:13.5px;line-height:1.5;color:#dfe4ea;border-radius:0 8px 8px 0;white-space:pre-wrap}',
    '.pq-said b{display:block;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--cy);margin-bottom:4px;font-weight:800}',
    '.pq-act{margin-top:9px;font-size:13.5px;color:var(--ink)}',
    '.pq-act i{font-style:normal;color:var(--muted)}',
    '.pq-btns{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}',
    '.pq-btn{font-size:12px;font-weight:700;color:var(--ink);background:rgba(255,255,255,.06);border:1px solid var(--line2);',
    'border-radius:99px;padding:6px 13px;cursor:pointer}',
    '.pq-btn:hover{background:rgba(255,255,255,.11)} .pq-btn[disabled]{opacity:.45;cursor:default}',
    '.pq-btn.go{background:var(--cy);border-color:var(--cy);color:#04222b}',
    '.pq-msg{font-size:12.5px;margin-top:8px;padding:8px 11px;border-radius:9px;line-height:1.5}',
    '.pq-msg.bad{color:#ffb4a2;background:var(--red-soft);border:1px solid rgba(248,113,113,.3)}',
    '.pq-msg.ok{color:#a7f3d0;background:var(--warm-soft);border:1px solid rgba(52,211,153,.3)}',
    '.pq-empty{color:var(--dim);font-size:13.5px;padding:6px 0}',
    '.pq-note{font-size:12.5px;color:var(--muted);line-height:1.55;margin-top:11px;padding-top:10px;border-top:1px solid var(--line)}',
    '.pq-note b{color:var(--ink)}',
    '.pq-draft{border-top:1px solid var(--line);padding:11px 0}',
    '.pq-draft:first-of-type{border-top:0}',
    '.pq-draft summary{cursor:pointer;font-size:13.5px;font-weight:650;color:var(--cy);list-style:none}',
    '.pq-draft summary::-webkit-details-marker{display:none}',
    '.pq-draft summary::before{content:"+ ";color:var(--dim)}',
    '.pq-draft[open] summary::before{content:"- "}',
    '.pq-pre{white-space:pre-wrap;font-size:13.5px;line-height:1.6;color:#dfe4ea;background:rgba(255,255,255,.03);',
    'border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-top:9px}',
    '.pq-they{color:var(--muted);font-size:12.5px;margin-top:9px}',
    '.pq-then{color:var(--dim);font-size:12px;margin-top:5px;font-style:italic}',
    '.pq-form{display:grid;gap:7px;margin-top:9px}',
    '.pq-form input,.pq-form textarea{width:100%;font:inherit;font-size:13.5px;color:#fff;background:rgba(255,255,255,.045);',
    'border:1px solid var(--line2);border-radius:9px;padding:8px 11px;outline:none}',
    '.pq-form input:focus,.pq-form textarea:focus{border-color:var(--cy)}',
    '.pq-form textarea{min-height:60px;resize:vertical}',
    '.pq-form label{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);font-weight:700}',
    '@media (max-width:900px){.pq-arms{grid-template-columns:1fr}}'
  ].join('');

  var MARKUP = [
    '<div class="pq-top"><div><h2>Founder pilot</h2><div class="sub" id="pq-sub">Loading</div></div>',
    '<button type="button" class="pq-btn" id="pq-refresh">Refresh</button></div>',
    '<section class="pq-card" id="pq-health"><h3>Integration health</h3></section>',
    '<section class="pq-card" id="pq-do"><h3>What is waiting on you</h3></section>',
    '<section class="pq-card" id="pq-req"><h3>Requests from the page <small>inbound, never counted as warm or cold</small></h3></section>',
    '<section class="pq-card" id="pq-people"><h3>The batch <small>every owner, and what you know about them</small></h3></section>',
    '<section class="pq-card" id="pq-report"><h3>The cohort <small>warm and cold are never added together</small></h3></section>',
    '<section class="pq-card" id="pq-answers"><h3>What they actually said</h3></section>',
    '<section class="pq-card" id="pq-drafts"><h3>What to send, and what to say</h3></section>'
  ].join('');

  var root = null, DATA = null, busy = false;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var q = function (s) { return root.querySelector(s); };
  var when = function (iso) { if (!iso) return ''; var d = new Date(iso); return isNaN(d) ? '' :
    d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };

  // A number that is known prints. A number that is not prints as Unknown, with the reason on hover.
  function num(v, why) {
    if (v && typeof v === 'object' && 'known' in v) {
      if (v.known) return '<span' + (v.value === 0 ? ' class="z"' : '') + '>' + esc(String(v.value)) + '</span>';
      return '<span class="pq-unk" title="' + esc(v.why || why || 'could not be read') + '">Unknown</span>';
    }
    return '<span class="pq-unk" title="' + esc(why || 'not reported') + '">Unknown</span>';
  }

  // Three arms, and the interface has to say so, because the whole point of the third one is that
  // "they answered the phone once" and "Paul knows them" are different facts.
  var ARM = {
    warm:    { label: 'Warm',    who: 'Paul knows them: met, introduced, or worked together' },
    engaged: { label: 'Engaged', who: 'they responded to our outreach before, which is not the same as knowing us' },
    cold:    { label: 'Cold',    who: 'no prior response from anyone there' },
  };
  var ARM_ORDER = { warm: 0, engaged: 1, cold: 2 };
  var armLabel = function (k) { return (ARM[k] || { label: k || 'Unknown' }).label; };

  function armBlock(a) {
    if (!a) return '';
    var rows = [
      ['Owed an answer', a.owedAnAnswer], ['Times floated, never confirmed', a.tentativeTimesUnconfirmed],
      ['Held for review', a.heldForReview], 'sep',
      ['Selected', a.selected], ['Contacted', a.contacted], ['Replied', a.replied],
      ['Conversations', a.conversations], 'sep',
      ['Role map promised', a.roleMapsPromised], ['Role map actually sent', a.roleMapsSent], 'sep',
      ['Time requested', a.timeRequested], ['Meeting agreed', a.meetingsAgreed],
      ['On a calendar', a.meetingsBooked], ['Call held', a.meetingsHeld], 'sep',
      ['Proposals sent', a.proposalsSent],
      ['Paid onboarding', a.paidOnboarding],
      ['Reported wins, payment unverified', a.reportedWinsPendingPayment], 'sep',
      ['Upcoming calls', a.upcomingMeetings], ['Open actions', a.openActions], ['Overdue', a.overdueActions]
    ];
    var meta = ARM[a.arm] || { label: a.arm || 'Unknown', who: '' };
    var html = '<div class="pq-arm"><h4>' + esc(meta.label) +
      '<span class="who">' + esc(meta.who) + '</span></h4><dl class="pq-rows">';
    rows.forEach(function (r) {
      if (r === 'sep') { html += '<div class="sep"></div>'; return; }
      html += '<dt>' + esc(r[0]) + '</dt><dd>' + num(r[1]) + '</dd>';
    });
    return html + '</dl></div>';
  }

  function renderReport() {
    var el = q('#pq-report');
    var c = DATA && DATA.cohort;
    var head = '<h3>The cohort <small>warm and cold are never added together</small></h3>';
    if (!c || c.ok === false || c.status === 'UNKNOWN') {
      el.innerHTML = head + '<div class="pq-msg bad">The cohort could not be read: ' +
        esc((c && (c.why || c.error)) || 'no answer from the engine') +
        '. This is unknown, not an empty cohort. Nothing has been counted as zero.</div>';
      return;
    }
    if (c.status === 'EMPTY' || !c.report) {
      el.innerHTML = head + '<div class="pq-empty">No batch staged yet. The first 30 owners go in here, ' +
        'warm and cold marked separately, each with the evidence for why they are on the list.</div>';
      return;
    }
    var r = c.report;
    var armsHtml = (r.arms || []).map(armBlock).join('');
    var empty = (r.arms || []).filter(function (a) { return a.selected && a.selected.value === 0; })
      .map(function (a) { return armLabel(a.arm); });
    el.innerHTML = head + '<div class="pq-arms">' + armsHtml + '</div>' +
      (empty.length ? '<div class="pq-note">' + esc(empty.join(' and ')) +
        (empty.length === 1 ? ' is empty. That is the number, not a gap in the data.' : ' are empty. Those are the numbers, not gaps in the data.') +
        '</div>' : '') +
      '<div class="pq-note"><b>Tests excluded:</b> ' + num(r.testRecordsExcluded) + '. ' +
      (r.overclaimed && r.overclaimed.length
        ? '<span class="pq-gap"><b>' + r.overclaimed.length + ' record(s) claim a stage the evidence does not support:</b> ' +
          esc(r.overclaimed.slice(0, 4).map(function (g) { return (g.company || g.id) + ' needs ' + g.missing; }).join('; ')) + '</span>'
        : 'Every recorded stage has its evidence.') +
      '<br>' + esc(r.note || '') + ' As of ' + esc(when(r.asOf)) + '.</div>';
  }

  function renderAnswers() {
    var el = q('#pq-answers');
    var head = '<h3>What they actually said</h3>';
    var c = DATA && DATA.cohort;
    if (!c || !c.report) { el.innerHTML = head + '<div class="pq-empty">Nothing recorded yet.</div>'; return; }
    var labels = { NO_RESPONSE: 'No response', ALREADY_COVERED: 'Already covered', NOT_NOW: 'Not now',
      NO_NEED: 'No need', DECLINED: 'Declined', SUPPRESSED: 'Suppressed' };
    var html = head + '<div class="pq-arms">';
    (c.report.arms || []).forEach(function (a) {
      html += '<div class="pq-arm"><h4>' + esc(armLabel(a.arm)) + '</h4><dl class="pq-rows">';
      Object.keys(labels).forEach(function (k) {
        var n = (a.answers && a.answers[k]) || 0;
        html += '<dt>' + labels[k] + '</dt><dd' + (n === 0 ? ' class="z"' : '') + '>' + n + '</dd>';
      });
      html += '<div class="sep"></div><dt>Recorded without their words</dt><dd>' + num(a.answersWithoutWords) + '</dd>';
      html += '</dl></div>';
    });
    html += '</div><div class="pq-note"><b>No response means no response.</b> It is not skepticism, not a soft no, ' +
      'and not interest. Already covered, not now, no need and no thanks are four different answers and are never merged. ' +
      'A reason is only recorded when the owner said it, in their words.</div>';
    el.innerHTML = html;
  }

  // What each action is called on screen, and how urgently it reads. A debt we owe someone outranks
  // anything we want to say to them, so it is drawn first and drawn loudest.
  var ACTION = {
    REVIEW_BEFORE_CONTACT:   { label: 'Read this first', tone: 'st-warn', rank: 0 },
    ANSWER_THEIR_REQUEST:    { label: 'They asked, we never answered', tone: 'st-late', rank: 1 },
    RECONFIRM_TENTATIVE_TIME:{ label: 'Time floated, never confirmed', tone: 'st-late', rank: 2 },
    SEND_ROLE_MAP:           { label: 'Role map promised', tone: 'st-late', rank: 3 },
    PROPOSAL_DECISION:       { label: 'Proposal out, no decision', tone: 'st-do', rank: 4 },
    AFTER_THE_CALL:          { label: 'Call held, nothing sent', tone: 'st-do', rank: 5 },
    RECORD_OUTCOME:          { label: 'Was it held?', tone: 'st-do', rank: 6 },
    CONFIRM_BOOKING:         { label: 'Agreed, not calendared', tone: 'st-do', rank: 7 },
    OFFER_TIME:              { label: 'They want a time', tone: 'st-do', rank: 8 },
    REVISIT:                 { label: 'They asked us to come back', tone: 'st-do', rank: 9 },
    REPLY:                   { label: 'They wrote back', tone: 'st-do', rank: 10 },
    FIRST_MESSAGE:           { label: 'Not contacted yet', tone: 'st-idle', rank: 20 },
    FOLLOW_UP:               { label: 'No reply yet', tone: 'st-idle', rank: 21 },
  };
  var actionRank = function (a) { return a ? ((ACTION[a.kind] || {}).rank === undefined ? 15 : ACTION[a.kind].rank) : 99; };

  function actionChip(a) {
    if (!a) return '<span class="st st-ok">Nothing owed</span>';
    var m = ACTION[a.kind] || { label: a.kind.replace(/_/g, ' ').toLowerCase(), tone: 'st-do' };
    return '<span class="st ' + (a.overdue ? 'st-late' : m.tone) + '">' +
      esc(a.overdue ? 'Overdue: ' + m.label : m.label) + '</span>';
  }

  function contactLine(r) {
    var bits = [];
    if (r.email) bits.push('<a href="mailto:' + esc(r.email) + '" style="color:#5fe0fa">' + esc(r.email) + '</a>');
    if (r.phone) bits.push('<a href="tel:' + esc(r.phone) + '" style="color:#5fe0fa">' + esc(r.phone) + '</a>');
    if (r.website) bits.push('<a href="' + esc(r.website) + '" target="_blank" rel="noopener" style="color:#5fe0fa">site</a>');
    if (r.crmUrl) bits.push('<a href="' + esc(r.crmUrl) + '" target="_blank" rel="noopener" style="color:#5fe0fa">CRM</a>');
    return bits.length ? '<div class="pq-meta">' + bits.join(' &middot; ') + '</div>' : '';
  }

  function cohortCard(r, showAll) {
    var a = r.nextAction;
    return '<div class="pq-item" data-rec="' + esc(r.id) + '"><div class="pq-h"><b>' +
      esc(r.company || r.person || r.id) +
      (r.person && r.company ? ' <i style="color:#9ba1ab;font-weight:500;font-style:normal">' + esc(r.person) + '</i>' : '') +
      '</b>' + actionChip(a) + '</div>' +
      '<div class="pq-meta">' + esc(armLabel(r.arm)) + ' &middot; ' + esc(r.stage.replace(/_/g, ' ').toLowerCase()) +
      ' &middot; ' + esc(r.owner) + (r.touches ? ' &middot; ' + r.touches + ' touch' + (r.touches === 1 ? '' : 'es') : '') +
      (a && a.dueAt ? ' &middot; due ' + esc(when(a.dueAt)) : '') +
      (r.followUpAllowed ? '' : ' &middot; <span style="color:#f5b83d">follow-up stopped</span>') + '</div>' +
      contactLine(r) +
      (showAll && r.sourceEvidence ? '<div class="pq-meta">Why they are on the list: ' + esc(r.sourceEvidence) + '</div>' : '') +
      (r.painQuote ? '<div class="pq-said"><b>In their words</b>' + esc(r.painQuote) + '</div>' : '') +
      (r.replyQuote && r.replyQuote !== r.painQuote ? '<div class="pq-said"><b>They replied</b>' + esc(r.replyQuote) + '</div>' : '') +
      (r.answer && r.answer.words ? '<div class="pq-said"><b>' + esc(r.answer.kind.replace(/_/g, ' ').toLowerCase()) + '</b>' + esc(r.answer.words) + '</div>' : '') +
      (r.answer && r.answer.valid === false ? '<div class="pq-act pq-gap">' + esc(r.answer.why) + '</div>' : '') +
      (a ? '<div class="pq-act">' + esc(a.text) + '</div>' : '') +
      (r.evidenceGaps && r.evidenceGaps.length
        ? '<div class="pq-act pq-gap">Claims ' + esc(r.claimedStage || '') + ' but missing: ' +
          esc(r.evidenceGaps.map(function (g) { return g.missing; }).join('; ')) + '</div>' : '') +
      '<div class="pq-btns"><button type="button" class="pq-btn go" data-log="' + esc(r.id) + '">Log what happened</button>' +
      (r.email ? '<button type="button" class="pq-btn" data-startopp="' + esc(r.id) + '">Start opportunity</button>' : '') +
      '</div>' +
      '<div class="pq-form" data-start="' + esc(r.id) + '" style="display:none"></div>' +
      '<div class="pq-msg" data-cmsg="' + esc(r.id) + '" style="display:none"></div>' +
      '<div class="pq-form" data-cform="' + esc(r.id) + '" style="display:none"></div></div>';
  }

  // Every field Paul needs, grouped, so normal work never needs the API or a terminal.
  var LOG_FIELDS = [
    ['firstContactAt', 'First contact, when (leave blank if not yet)', 'date'],
    ['firstContactChannel', 'First contact, how (email, call, text, in person)', 'text'],
    ['replyAt', 'They replied, when', 'date'],
    ['replyQuote', 'What they wrote back, their words', 'area'],
    ['painQuote', 'What they said about their own workflow, their words', 'area'],
    ['painQuoteAt', 'When they said it', 'date'],
    ['roleMap.promisedAt', 'Role map promised, when', 'date'],
    ['roleMap.sentAt', 'Role map actually sent, when', 'date'],
    ['roleMap.artifact', 'What you sent (file name or subject line)', 'text'],
    ['meeting.requestedAt', 'They asked for a time, when', 'date'],
    ['meeting.agreedFor', 'Time you both agreed on', 'date'],
    ['meeting.bookingRef', 'Calendar or Calendly reference (a booking needs one)', 'text'],
    ['meeting.heldAt', 'The call actually happened, when', 'date'],
    ['proposal.sentAt', 'Proposal sent, when', 'date'],
    ['proposal.amount', 'Proposal amount', 'text'],
    ['payment.reference', 'Payment reference (paid needs one, a CRM stage is not payment)', 'text'],
    ['payment.paidAt', 'Payment cleared, when', 'date'],
    ['answer.kind', 'Their answer: ALREADY_COVERED NOT_NOW NO_NEED DECLINED SUPPRESSED', 'text'],
    ['answer.words', 'Their answer, in their words (required for any answer)', 'area'],
    ['answer.revisitAt', 'Only if they gave a date to come back. Never invent one.', 'date'],
    ['owner', 'Who owns this', 'text'],
    ['nextActionAt', 'Next action due', 'date'],
    ['notes', 'Notes', 'area']
  ];

  function openLogForm(id, btn) {
    var rec = ((DATA.cohort && DATA.cohort.records) || []).find(function (x) { return x.id === id; });
    if (!rec) return;
    var form = inCard(btn, '[data-cform="' + id + '"]');
    var msg = inCard(btn, '[data-cmsg="' + id + '"]');
    if (!form || !msg) return;
    msg.style.display = 'none';
    if (form.style.display === 'grid') { form.style.display = 'none'; form.innerHTML = ''; return; }
    var val = function (path) {
      var parts = path.split('.'), v = rec;
      for (var i = 0; i < parts.length; i++) { v = v && v[parts[i]]; }
      return v == null ? '' : String(v);
    };
    form.style.display = 'grid';
    form.innerHTML = LOG_FIELDS.map(function (f) {
      var fid = 'lf-' + id.replace(/[^a-z0-9]/gi, '') + '-' + f[0].replace(/\./g, '-');
      return '<label for="' + fid + '">' + esc(f[1]) + '</label>' +
        (f[2] === 'area' ? '<textarea id="' + fid + '" data-p="' + esc(f[0]) + '">' + esc(val(f[0])) + '</textarea>'
          : '<input id="' + fid + '" data-p="' + esc(f[0]) + '" type="text" value="' + esc(val(f[0])) + '">');
    }).join('') +
      '<label><input type="checkbox" data-p="suppressed" style="width:auto;margin-right:7px"' +
      (rec.suppressed ? ' checked' : '') + '>Suppressed: opt-out, wrong person, wrong company</label>' +
      '<label><input type="checkbox" data-p="answer.nothingFurther" style="width:auto;margin-right:7px"' +
      (rec.answer && rec.answer.nothingFurther ? ' checked' : '') + '>They said nothing further is needed</label>' +
      '<div class="pq-btns"><button type="button" class="pq-btn go" data-csave="' + esc(id) + '">Save</button>' +
      '<button type="button" class="pq-btn" data-ccancel="1">Cancel</button></div>';
    form.querySelector('[data-ccancel]').onclick = function () { form.style.display = 'none'; form.innerHTML = ''; };
    form.querySelector('[data-csave]').onclick = function (ev) { saveCohort(id, form, msg, ev.target, rec.rev); };
  }

  function saveCohort(id, form, msg, btn, rev) {
    if (busy) return;
    var update = {};
    Array.prototype.forEach.call(form.querySelectorAll('[data-p]'), function (i) {
      var path = i.getAttribute('data-p');
      var v = i.type === 'checkbox' ? i.checked : i.value.trim();
      if (v === '' ) return;
      var parts = path.split('.'), t = update;
      for (var k = 0; k < parts.length - 1; k++) { t[parts[k]] = t[parts[k]] || {}; t = t[parts[k]]; }
      t[parts[parts.length - 1]] = v;
    });
    busy = true; btn.disabled = true;
    fetch('/api/pilot-queue/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'cohort', id: id, update: update, rev: rev }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        busy = false; btn.disabled = false;
        if (!res.ok || !res.j.ok) {
          // The edit stays on screen. Nothing the operator typed is thrown away by a failed save.
          msg.style.display = 'block'; msg.className = 'pq-msg bad';
          msg.textContent = (res.j && res.j.error ? res.j.error : 'that did not save') +
            ' Your entries are still here, so you can try again.';
          return;
        }
        msg.style.display = 'block'; msg.className = 'pq-msg ok'; msg.textContent = 'Saved.';
        form.style.display = 'none'; form.innerHTML = '';
        load();
      })
      .catch(function () {
        busy = false; btn.disabled = false;
        msg.style.display = 'block'; msg.className = 'pq-msg bad';
        msg.textContent = 'That did not save and your entries are still here.';
      });
  }

  // ONE wiring pass, run after every section has drawn.
  //
  // This used to live inside renderRequests, after its early return for an empty list, and
  // renderPeople drew afterwards. So with no inbound requests nothing was bound at all, and the
  // cohort's Start opportunity button did nothing when clicked. A control that renders and does not
  // respond is worse than one that is missing.
  function wireAll() {
    Array.prototype.forEach.call(root.querySelectorAll('[data-log]'), function (b) {
      b.onclick = function () { openLogForm(b.getAttribute('data-log'), b); };
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-startopp]'), function (b) {
      b.onclick = function () {
        var recs = (DATA.cohort && DATA.cohort.records) || [];
        var rec = recs.find(function (x) { return x.id === b.getAttribute('data-startopp'); });
        if (rec) startOpportunity(rec, b);
      };
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-draftkind]'), function (b) {
      b.onclick = function () { openDraft(b.getAttribute('data-draftid'), b.getAttribute('data-draftkind'), b); };
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-payopen]'), function (b) {
      b.onclick = function () { paymentPanel(b.getAttribute('data-payopen'), b); };
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-sync]'), function (b) {
      b.onclick = function () {
        b.disabled = true; b.textContent = 'Queued';
        fetch('/api/pilot-queue/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'sync', id: b.getAttribute('data-sync') }) })
          .then(function (r) { return r.json(); })
          .then(function (j) { b.textContent = j && j.ok ? 'Queued' : ((j && j.error) || 'Failed'); setTimeout(load, 1200); })
          .catch(function () { b.disabled = false; b.textContent = 'Sync now'; });
      };
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-retry]'), function (b) {
      b.onclick = function () { retryAlert(b.getAttribute('data-retry'), b); };
    });
    wireRequestStageButtons();
  }

  function renderPeople() {
    var el = q('#pq-people');
    var head = '<h3>The batch <small>every owner, and what you know about them</small></h3>';
    var c = DATA && DATA.cohort;
    if (!c || c.ok === false || c.status === 'UNKNOWN') {
      el.innerHTML = head + '<div class="pq-msg bad">The batch could not be read: ' +
        esc((c && (c.why || c.error)) || 'no answer from the engine') + '. Unknown, not empty.</div>';
      return;
    }
    if (!c.records || !c.records.length) {
      el.innerHTML = head + '<div class="pq-empty">No owners staged yet.</div>';
      return;
    }
    var recs = c.records.slice().sort(function (x, y) {
      var d = (ARM_ORDER[x.arm] === undefined ? 9 : ARM_ORDER[x.arm]) - (ARM_ORDER[y.arm] === undefined ? 9 : ARM_ORDER[y.arm]);
      return d || String(x.company || '').localeCompare(String(y.company || ''));
    });
    el.innerHTML = head +
      (c.partial ? '<div class="pq-msg bad">' + esc(c.partial.missing) + ' record(s) are listed in this cohort but could not be read. What follows is partial.</div>' : '') +
      recs.map(function (r) { return cohortCard(r, true); }).join('');
  }

  function renderDo() {
    var el = q('#pq-do');
    var head = '<h3>What is waiting on you</h3>';
    var c = DATA && DATA.cohort;
    var rq = DATA && DATA.requests;
    var cohortDown = !c || c.ok === false || c.status === 'UNKNOWN';
    var requestsDown = !rq || rq.status === 'UNKNOWN';

    if (cohortDown && requestsDown) {
      el.innerHTML = head + '<div class="pq-msg bad">Neither the batch nor the inbound requests could be read, ' +
        'so this list is unavailable. It is not empty, and nothing here means nobody is waiting.</div>';
      return;
    }
    var warnings = '';
    if (cohortDown) warnings += '<div class="pq-msg bad">The batch could not be read (' +
      esc((c && (c.why || c.error)) || 'no answer') + '), so anything owed there is missing from this list.</div>';
    if (requestsDown) warnings += '<div class="pq-msg bad">Inbound requests could not be read, so any of those are missing from this list.</div>';
    if (rq && rq.status === 'PARTIAL') warnings += '<div class="pq-msg bad">' + esc(rq.why || 'some requests could not be read') + '. This list is partial.</div>';
    if (c && c.partial) warnings += '<div class="pq-msg bad">' + esc(c.partial.missing) + ' cohort record(s) could not be read. This list is partial.</div>';

    var items = [];
    if (!cohortDown && c.records) c.records.forEach(function (r) { if (r.nextAction) items.push({ kind: 'cohort', r: r }); });
    if (!requestsDown && rq.items) {
      rq.items.forEach(function (x) {
        if (x.state === 'REQUESTED' || (x.state === 'ANSWERED' && !x.roleMapSentAt) || (x.state === 'TIME_AGREED' && !x.bookingRef)) {
          items.push({ kind: 'request', r: x });
        }
      });
    }
    items.sort(function (a, b) {
      var rank = function (it) {
        if (it.kind === 'request') return 4;                       // an inbound ask sits near the top
        var act = it.r.nextAction;
        return (act && act.overdue ? -1 : 0) + actionRank(act);
      };
      return rank(a) - rank(b);
    });
    if (!items.length) {
      el.innerHTML = head + warnings + '<div class="pq-empty">' +
        (warnings ? 'Nothing is waiting in the sources that did answer.' : 'Nothing is waiting on you.') + '</div>';
      return;
    }
    el.innerHTML = head + warnings + items.slice(0, 40).map(function (it) {
      if (it.kind === 'request') {
        return '<div class="pq-item"><div class="pq-h"><b>' + esc(it.r.name) +
          (it.r.company ? ' <i style="color:#9ba1ab;font-weight:500;font-style:normal">' + esc(it.r.company) + '</i>' : '') +
          '</b><span class="st st-do">' + esc(it.r.state === 'REQUESTED' ? 'asked for a role map' :
            it.r.state === 'ANSWERED' ? 'role map still owed' : 'agreed, not booked') + '</span></div>' +
          '<div class="pq-meta">Came in from the page ' + esc(when(it.r.createdAt)) + '. Inbound.</div>' +
          (it.r.pain ? '<div class="pq-said"><b>What they said</b>' + esc(it.r.pain) + '</div>' : '') +
          '<div class="pq-act">Reply to them yourself at <a href="mailto:' + esc(it.r.email) + '" style="color:#5fe0fa">' +
          esc(it.r.email) + '</a>.' + (it.r.times ? ' They suggested: ' + esc(it.r.times) + '.' : '') + '</div></div>';
      }
      return cohortCard(it.r, false);
    }).join('');
  }

  function setRequest(id, state, extra, btn) {
    if (busy) return;
    busy = true; if (btn) btn.disabled = true;
    var body = { scope: 'request', id: id, set: Object.assign({ state: state }, extra || {}) };
    fetch('/api/pilot-queue/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        busy = false;
        if (!res.ok || !res.j.ok) {
          var box = root.querySelector('[data-msg="' + id + '"]');
          if (box) { box.className = 'pq-msg bad'; box.textContent = (res.j && res.j.error ? res.j.error : 'that did not save') +
            (res.j && res.j.hint ? ' ' + res.j.hint : ''); }
          if (btn) btn.disabled = false;
          return;
        }
        load();
      })
      .catch(function () { busy = false; if (btn) btn.disabled = false; });
  }

  // "Nobody was alerted" is only true when neither channel got through. One channel succeeding is a
  // different fact and says so, with the failed one named.
  function notifyLine(x) {
    var n = x.notify || {};
    if (n.state === 'delivered') return '';
    var say = function (v) {
      if (!v) return 'not attempted';
      return v.indexOf('unknown: ') === 0 ? 'unknown (' + esc(v.slice(9)) + ')' : esc(v);
    };
    var detail = 'Email ' + say(n.email) + ', Slack ' + say(n.slack) + '.';
    var head =
      n.state === 'partial'   ? 'One channel got through, one did not. ' + detail
      : n.state === 'uncertain' ? 'We do not know whether this alert went out. ' + detail
      : n.state === 'pending'   ? 'No alert has been attempted for this yet.'
      : 'Saved, but no alert was delivered. ' + detail;
    var warn = (n.state === 'uncertain' || (n.slack || '').indexOf('unknown: ') === 0)
      ? ' Retrying Slack after an uncertain result may post a second message, because Slack has no duplicate protection. The email is safe to retry for 24 hours.'
      : '';
    return '<div class="pq-act pq-gap">' + head + warn +
      ' <button type="button" class="pq-btn" data-retry="' + esc(x.id) + '" style="margin-left:6px">Try the alert again</button></div>';
  }

  function retryAlert(id, btn) {
    if (busy) return;
    busy = true; btn.disabled = true; btn.textContent = 'Sending';
    fetch('/api/pilot-queue/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'retry-alert', id: id }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        busy = false;
        var msg = root.querySelector('[data-msg="' + id + '"]');
        if (msg) {
          msg.style.display = 'block';
          msg.className = 'pq-msg ' + (j && j.ok && j.state === 'delivered' ? 'ok' : 'bad');
          msg.textContent = !j || !j.ok ? ((j && j.error) || 'the retry did not go through')
            : j.attempted && j.attempted.length
              ? 'Tried ' + j.attempted.join(' and ') + '. Now: ' + j.state + '.'
                + (j.resultsRecorded === false ? ' The result could not be written down, so what is stored may be behind.' : '')
                + (j.caution ? ' ' + j.caution + '.' : '')
              : (j.note || 'nothing needed sending');
        }
        load();
      })
      .catch(function () { busy = false; btn.disabled = false; btn.textContent = 'Try the alert again'; });
  }


  // ---- integration health: configured or not, said out loud ----------------------------------
  function renderHealth() {
    var el = q('#pq-health');
    var h = DATA && DATA.health;
    var head = '<h3>Integration health</h3>';
    if (!h) { el.innerHTML = head + '<div class="pq-empty">Health could not be read.</div>'; return; }
    var rows = [];
    var line = function (label, ok, detail) {
      rows.push('<dt>' + esc(label) + '</dt><dd class="' + (ok ? '' : 'z') + '">' +
        (ok ? 'configured' : '<span style="color:#f5b83d">not configured</span>') +
        (detail ? '<div style="font-weight:400;color:#6e6e73;font-size:12px;max-width:44ch;text-align:right">' + esc(detail) + '</div>' : '') + '</dd>');
    };
    line('CRM sync (HubSpot)', h.hubspot && h.hubspot.configured, '');
    line('Payment evidence (QuickBooks)', h.quickbooks && h.quickbooks.configured, h.quickbooks && h.quickbooks.note);
    line('Booking events (Calendly)', h.calendly && h.calendly.configured, h.calendly && h.calendly.note);
    var hp = h.hubspotPortal || {};
    rows.push('<dt>HubSpot account</dt><dd>' + (hp.configured ? esc('portal ' + hp.portalId) :
      '<span class="pq-unk" title="' + esc(hp.note || '') + '">Unknown</span>') +
      (hp.note ? '<div style="font-weight:400;color:#f5b83d;font-size:12px;max-width:44ch;text-align:right">' + esc(hp.note) + '</div>' : '') + '</dd>');
    line('Pilot task owner', h.owner && h.owner.configured, h.owner && h.owner.note);
    line('Request alerts by email', h.email && h.email.configured, '');
    line('Request alerts to Slack', h.slack && h.slack.configured, '');
    var g = h.clientGuard || {};
    line('Client guard', g.canAnswer, (g.problems && g.problems.length ? g.problems.join('; ') : '')
      + (g.snapshot ? ' shared snapshot ' + g.snapshot.emails + ' emails, ' + g.snapshot.ageHours + 'h old' : ''));
    var sync = h.crmSync || {};
    rows.push('<dt>CRM sync queue</dt><dd>' + (sync.ok
      ? esc(sync.queued + ' queued, ' + sync.dueNow + ' due now')
      : '<span class="pq-unk" title="' + esc(sync.why || '') + '">Unknown</span>') + '</dd>');
    el.innerHTML = head + '<dl class="pq-rows">' + rows.join('') + '</dl>' +
      '<div class="pq-note">Anything marked not configured is switched off, not quietly failing. ' +
      'Nothing is ever shown as booked or paid from a source that is not connected.</div>';
  }

  // ---- what the CRM link actually did ---------------------------------------------------------
  function crmLine(x) {
    var c = x.crm || {};
    var label = { ok: 'In the CRM', partial: 'Partly in the CRM', pending: 'Waiting to sync',
      failed: 'Sync failed', skipped: 'Not synced', 'needs-reconcile': 'Needs a person to check HubSpot' };
    var tone = c.state === 'ok' ? 'st-ok' : c.state === 'pending' ? 'st-idle' : 'st-warn';
    var bits = [];
    if (c.contactId) bits.push('contact ' + esc(c.contactId));
    if (c.dealId) bits.push('deal ' + esc(c.dealId));
    if (c.taskId) bits.push('task due ' + esc(when(c.dueAt)));
    if (c.dealSkipped) bits.push('no deal: ' + esc(c.dealSkipped));
    if (c.isClient) bits.push('EXISTING CLIENT, do not pitch');
    return '<div class="pq-act"><span class="st ' + tone + '">' + esc(label[c.state] || c.state || 'unknown') + '</span> ' +
      esc(bits.join(' · ')) +
      (c.error ? '<div class="pq-gap" style="margin-top:5px">' + esc(c.error) + '</div>' : '') +
      (c.needsReview ? '<div class="pq-gap" style="margin-top:5px">Held for review: ' + esc(c.reason || c.error || '') + '</div>' : '') +
      ' <button type="button" class="pq-btn" data-sync="' + esc(x.id) + '">Sync now</button></div>';
  }

  function paymentLine(x) {
    var p = x.payment || {};
    if (!p.status && !p.reference) return '';
    var ok = !!p.reference;
    return '<div class="pq-act"><span class="st ' + (ok ? 'st-ok' : 'st-idle') + '">' +
      esc(ok ? 'Paid, verified' : 'Payment: ' + p.status) + '</span> ' + esc(p.why || '') +
      (p.formerReference ? '<div class="pq-gap" style="margin-top:5px">Previously verified as paid (' +
        esc(p.formerReference) + '), cleared because: ' + esc(p.formerClearedWhy) + '</div>' : '') + '</div>';
  }

  // The structured pieces a role map or a proposal cannot honestly be written without. These feed
  // the generator, get saved on the record, and decide whether the send action is allowed to open.
  var DRAFT_FIELDS = {
    roleMap: [
      ['tasks', 'What a second person takes over, with how often'],
      ['hours', 'Hours a week'],
      ['assumption', 'The assumption the hours rest on'],
      ['successMeasure', 'What good looks like in month one, and the baseline'],
      ['nextStep', 'Next step: who, what, by when'],
    ],
    proposal: [
      ['role', 'Role title'],
      ['hours', 'Hours a week'],
      ['level', 'Level: C-List, B-List or A-List'],
    ],
    reply: [],
  };

  // The same cohort record is drawn twice, once in the waiting list and once in the batch, so every
  // lookup has to start from the button that was pressed. root.querySelector would find the first
  // copy on the page, which is usually not the card somebody clicked.
  function card(el) { return (el && el.closest) ? el.closest('.pq-item') : null; }
  function inCard(el, sel) {
    var c = card(el);
    return (c && c.querySelector(sel)) || (root && root.querySelector(sel));
  }

  function draftBox(id) { return root.querySelector('[data-draft="' + id + '"]'); }

  function renderDraft(id, kind, j) {
    var box = draftBox(id);
    var d = j.draft;
    var fields = DRAFT_FIELDS[kind] || [];
    var ready = d.ready !== false;
    box.style.display = 'grid';
    box.innerHTML =
      '<div class="pq-msg ' + (ready ? 'ok' : 'bad') + '">This is a draft. Nothing has been sent and nothing is marked sent.' +
        (ready ? '' : ' It is not ready to send: ' + esc((d.needs || []).join('; ')) + '.') + '</div>' +
      (d.operatorNotes ? '<div class="pq-then">' + esc(d.operatorNotes.join(' ')) + '</div>' : '') +
      fields.map(function (f) {
        var v = (j.values && j.values[f[0]]) || '';
        return '<label>' + esc(f[1]) + '</label><input type="text" data-dfield="' + esc(f[0]) + '" value="' + esc(v) + '">';
      }).join('') +
      (fields.length ? '<div class="pq-btns"><button type="button" class="pq-btn" data-drebuild="1">Rebuild with these</button></div>' : '') +
      '<label>Subject</label><input type="text" data-dsub="1" value="' + esc(d.subject) + '">' +
      '<label>Body, edit before you send</label><textarea style="min-height:260px" data-dbody="1">' + esc(d.body) + '</textarea>' +
      '<div class="pq-btns">' +
        '<button type="button" class="pq-btn go" data-dsave="1">Save draft</button>' +
        (ready
          ? '<button type="button" class="pq-btn" data-dmail="1">Open in your mail client</button>'
          : '<button type="button" class="pq-btn" disabled title="fill the fields above first">Open in your mail client</button>') +
        '<button type="button" class="pq-btn" data-dcopy="1">Copy</button>' +
        '<button type="button" class="pq-btn" data-dclose="1">Close</button>' +
      '</div>' +
      '<div class="pq-msg" data-dmsg="1" style="display:none"></div>';

    var msg = box.querySelector('[data-dmsg]');
    var current = function () {
      var o = { subject: box.querySelector('[data-dsub]').value, body: box.querySelector('[data-dbody]').value };
      Array.prototype.forEach.call(box.querySelectorAll('[data-dfield]'), function (i) { o[i.getAttribute('data-dfield')] = i.value.trim(); });
      return o;
    };
    box.querySelector('[data-dclose]').onclick = function () { box.style.display = 'none'; box.innerHTML = ''; };
    box.querySelector('[data-dcopy]').onclick = function (ev) {
      navigator.clipboard.writeText(current().body)
        .then(function () { ev.target.textContent = 'Copied'; })
        .catch(function () { ev.target.textContent = 'Could not copy'; });
    };
    var rebuild = box.querySelector('[data-drebuild]');
    if (rebuild) rebuild.onclick = function (ev) { openDraft(id, kind, ev.target, current()); };
    var mail = box.querySelector('[data-dmail]');
    if (mail) mail.onclick = function () {
      // Built at click time from the textarea, so an edit is never silently dropped.
      var c = current();
      window.location.href = 'mailto:' + encodeURIComponent(j.to || '') +
        '?subject=' + encodeURIComponent(c.subject) + '&body=' + encodeURIComponent(c.body);
    };
    box.querySelector('[data-dsave]').onclick = function (ev) {
      ev.target.disabled = true;
      var c = current();
      fetch('/api/pilot-queue/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ scope: 'save-draft', id: id, kind: kind }, c)) })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          ev.target.disabled = false;
          msg.style.display = 'block';
          msg.className = 'pq-msg ' + (res && res.ok ? 'ok' : 'bad');
          msg.textContent = res && res.ok ? 'Saved. It will still be here after a refresh.' : ((res && res.error) || 'that did not save');
          if (res && res.ok) {
            // Keep the in-memory copy in step, or closing and reopening before the next load would
            // show the generated draft again and quietly discard what was just saved.
            var items = (DATA.requests && DATA.requests.items) || [];
            var rec = items.find(function (y) { return y.id === id; });
            if (rec) {
              rec.draft = rec.draft || {};
              rec.draft.kind = kind;
              rec.draft.subject = c.subject;
              rec.draft.body = c.body;
              rec.draft.savedAt = res.savedAt || new Date().toISOString();
              Object.keys(c).forEach(function (k) { if (k !== 'subject' && k !== 'body') rec.draft[k] = c[k]; });
            }
          }
        })
        .catch(function () { ev.target.disabled = false; msg.style.display = 'block'; msg.className = 'pq-msg bad'; msg.textContent = 'that did not save'; });
    };
  }

  function openDraft(id, kind, btn, options) {
    var box = draftBox(id);
    if (!box) return;
    btn.disabled = true;
    fetch('/api/pilot-queue/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'draft', id: id, kind: kind, options: options || {} }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        btn.disabled = false;
        if (!j || !j.ok) {
          box.style.display = 'grid';
          box.innerHTML = '<div class="pq-msg bad">' + esc((j && j.error) || 'could not build that draft') + '</div>';
          return;
        }
        var rec = ((DATA.requests && DATA.requests.items) || []).find(function (x) { return x.id === id; }) || {};
        // Saved values come back from the record, so reopening shows what was typed last time.
        j.values = Object.assign({}, rec.draft || {}, options || {});
        j.to = rec.email || '';
        // A saved body wins over a freshly generated one unless this was an explicit rebuild.
        if (!options && rec.draft && rec.draft.body && rec.draft.kind === kind) {
          j.draft = Object.assign({}, j.draft, { subject: rec.draft.subject || j.draft.subject, body: rec.draft.body });
        }
        renderDraft(id, kind, j);
      })
      .catch(function () { btn.disabled = false; });
  }

  // ---- payment: candidates to review, one to link, and a refresh that can clear a stale verdict --
  function paymentPanel(id, btn) {
    var box = root.querySelector('[data-pay="' + id + '"]');
    if (!box) return;
    if (box.style.display === 'grid') { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = 'grid';
    box.innerHTML = '<div class="pq-empty">Reading QuickBooks</div>';
    fetch('/api/pilot-queue/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'payment-candidates', id: id }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) { box.innerHTML = '<div class="pq-msg bad">' + esc((j && j.error) || 'could not read QuickBooks') + '</div>'; return; }
        var c = j.candidates || {};
        // A verdict that was verified and has since been voided has to be re-checkable, and that
        // cannot depend on candidate discovery finding anything today.
        var rec = ((DATA.requests && DATA.requests.items) || []).find(function (y) { return y.id === id; }) || {};
        var linked = rec.payment && rec.payment.invoiceId
          ? '<div class="pq-item"><div class="pq-h"><b>Currently linked: invoice ' + esc(rec.payment.invoiceId) + '</b>' +
            '<span class="st ' + (rec.payment.reference ? 'st-ok' : 'st-warn') + '">' +
            esc(rec.payment.reference ? 'verified paid' : (rec.payment.status || 'not verified')) + '</span></div>' +
            (rec.payment.why ? '<div class="pq-meta">' + esc(rec.payment.why) + '</div>' : '') +
            (rec.payment.formerReference ? '<div class="pq-act pq-gap">Previously verified, then cleared: ' +
              esc(rec.payment.formerClearedWhy || '') + '</div>' : '') +
            '<div class="pq-btns"><button type="button" class="pq-btn go" data-refresh="1">Re-check this invoice</button>' +
            '<button type="button" class="pq-btn" data-unlink="1">Unlink</button></div></div>'
          : '';
        var wireLinked = function () {
          var rb = box.querySelector('[data-refresh]');
          if (rb) rb.onclick = function () { linkInvoice(id, rec.payment.realm || '', rec.payment.customerId || '', rec.payment.invoiceId, rb, box); };
          var ub = box.querySelector('[data-unlink]');
          if (ub) ub.onclick = function () { linkInvoice(id, '', '', '', ub, box, true); };
        };
        if (c.status !== 'candidates') {
          box.innerHTML = linked +
            '<div class="pq-msg bad">' + esc(c.status) + ': ' + esc(c.why || '') + '</div>' +
            '<div class="pq-msg" data-paymsg="1" style="display:none"></div>';
          wireLinked();
          return;
        }
        box.innerHTML = linked + '<div class="pq-msg ok">' + esc(c.why) + '</div>' +
          c.candidates.map(function (x, i) {
            return '<div class="pq-item"><div class="pq-h"><b>' + esc(x.customerName) + ' &middot; invoice ' +
              esc(x.invoiceNumber || x.invoiceId) + '</b><span class="st ' + (x.strength === 'strong' ? 'st-do' : 'st-warn') + '">' +
              esc(x.strength + ' match by ' + x.customerMatch) + '</span></div>' +
              '<div class="pq-meta">' + esc(x.txnDate) + ' &middot; total ' + esc(String(x.total)) +
              ' &middot; balance ' + esc(x.balanceKnown ? String(x.balance) : 'not reported') + '</div>' +
              (x.predatesRequest ? '<div class="pq-act pq-gap">' + esc(x.note) + '</div>' : '') +
              '<div class="pq-btns"><button type="button" class="pq-btn go" data-link="' + i + '">Link this invoice</button></div></div>';
          }).join('') +
          '<div class="pq-msg" data-paymsg="1" style="display:none"></div>';
        wireLinked();
        var msg = box.querySelector('[data-paymsg]');
        Array.prototype.forEach.call(box.querySelectorAll('[data-link]'), function (b) {
          b.onclick = function () {
            var x = c.candidates[Number(b.getAttribute('data-link'))];
            linkInvoice(id, c.realm, x.customerId, x.invoiceId, b, box);
          };
        });
      })
      .catch(function () { box.innerHTML = '<div class="pq-msg bad">QuickBooks did not answer</div>'; });
  }

  function linkInvoice(id, realm, customerId, invoiceId, btn, box, unlink) {
    var msg = box.querySelector('[data-paymsg]');
    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = unlink ? 'Unlinking' : 'Checking';
    fetch('/api/pilot-queue/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'payment-link', id: id, realm: realm, customerId: customerId,
        invoiceId: invoiceId, unlink: !!unlink }) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = label;
        if (msg) {
          msg.style.display = 'block';
          var v = res && res.verdict;
          msg.className = 'pq-msg ' + (res && res.recordedReference ? 'ok' : 'bad');
          msg.textContent = !res || !res.ok ? ((res && res.error) || 'that did not verify')
            : unlink ? 'Unlinked. Nothing is recorded as paid.'
            : (v.status === 'paid' ? 'Verified paid. ' + v.why : v.status + ': ' + (v.why || 'not recorded as paid')) +
              (res.clearedPrevious ? ' A previously verified payment was cleared and kept as history.' : '');
        }
        setTimeout(load, 1200);
      })
      .catch(function () { btn.disabled = false; btn.textContent = label; });
  }

  // ---- promote a cohort owner into the same linked journey, without faking a form submission ----
  function startOpportunity(rec, btn) {
    var box = inCard(btn, '[data-start="' + rec.id + '"]');
    if (!box) return;
    if (box.style.display === 'grid') { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = 'grid';
    box.innerHTML =
      '<div class="pq-msg ok">This opens an opportunity from the cohort. It does not pretend they filled in the form, ' +
      'and it sends nothing.</div>' +
      '<label>Their email</label><input type="text" data-sf="email" value="' + esc(rec.email || '') + '">' +
      '<label>What actually happened, one line. This is the evidence.</label>' +
      '<input type="text" data-sf="how" placeholder="Replied to my email on 22 Sep asking what it would cost">' +
      '<label>What they said, their words (optional)</label><textarea data-sf="pain"></textarea>' +
      '<div class="pq-btns"><button type="button" class="pq-btn go" data-sgo="1">Open the opportunity</button>' +
      '<button type="button" class="pq-btn" data-sx="1">Cancel</button></div>' +
      '<div class="pq-msg" data-smsg="1" style="display:none"></div>';
    var msg = box.querySelector('[data-smsg]');
    box.querySelector('[data-sx]').onclick = function () { box.style.display = 'none'; box.innerHTML = ''; };
    box.querySelector('[data-sgo]').onclick = function (ev) {
      var v = {};
      Array.prototype.forEach.call(box.querySelectorAll('[data-sf]'), function (i) { v[i.getAttribute('data-sf')] = i.value.trim(); });
      if (!v.how) { msg.style.display = 'block'; msg.className = 'pq-msg bad'; msg.textContent = 'Say what happened. Without it there is no evidence for this being an opportunity.'; return; }
      ev.target.disabled = true;
      fetch('/api/pilot-queue/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'start-opportunity', cohortId: rec.id, email: v.email, how: v.how,
          pain: v.pain, name: rec.person, company: rec.company }) })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          ev.target.disabled = false;
          msg.style.display = 'block';
          msg.className = 'pq-msg ' + (j && j.ok ? 'ok' : 'bad');
          msg.textContent = !j || !j.ok ? ((j && j.error) || 'that did not open')
            : 'Opened. ' + (j.queued ? 'Queued for the CRM.' : 'Not queued: ' + (j.queueError || 'unknown'));
          if (j && j.ok) setTimeout(load, 1200);
        })
        .catch(function () { ev.target.disabled = false; msg.style.display = 'block'; msg.className = 'pq-msg bad'; msg.textContent = 'that did not open'; });
    };
  }

  function wireRequestTools() {
    Array.prototype.forEach.call(root.querySelectorAll('[data-sync]'), function (b) {
      b.onclick = function () {
        b.disabled = true; b.textContent = 'Queued';
        fetch('/api/pilot-queue/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'sync', id: b.getAttribute('data-sync') }) })
          .then(function (r) { return r.json(); })
          .then(function (j) { b.textContent = j && j.ok ? 'Queued' : ((j && j.error) || 'Failed'); setTimeout(load, 1200); })
          .catch(function () { b.disabled = false; b.textContent = 'Sync now'; });
      };
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-draftkind]'), function (b) {
      b.onclick = function () { openDraft(b.getAttribute('data-draftid'), b.getAttribute('data-draftkind'), b); };
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-payopen]'), function (b) {
      b.onclick = function () { paymentPanel(b.getAttribute('data-payopen'), b); };
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-startopp]'), function (b) {
      b.onclick = function () {
        var recs = (DATA.cohort && DATA.cohort.records) || [];
        var rec = recs.find(function (x) { return x.id === b.getAttribute('data-startopp'); });
        if (rec) startOpportunity(rec);
      };
    });
  }

  function requestCard(x) {
      var done = x.state === 'HELD' || x.state === 'CLOSED';
      return '<div class="pq-item"><div class="pq-h"><b>' + esc(x.name) +
        (x.company ? ' <i style="color:#9ba1ab;font-weight:500;font-style:normal">' + esc(x.company) + '</i>' : '') +
        '</b><span class="st ' + (done ? 'st-idle' : x.state === 'REQUESTED' ? 'st-do' : 'st-warn') + '">' + esc(x.stateLabel) + '</span></div>' +
        '<div class="pq-meta">' + esc(x.email) + ' &middot; ' + esc(when(x.createdAt)) +
        ' &middot; ' + esc((x.origin && x.origin.kind) === 'cohort' ? 'opened from the cohort' : 'came in from the page') +
        (x.attribution ? ' &middot; ' + esc(x.attribution) : '') +
        (x.submissions > 1 ? ' &middot; asked ' + x.submissions + ' times, one record' : '') + '</div>' +
        ((x.origin && x.origin.evidence) ? '<div class="pq-meta">Why: ' + esc(x.origin.evidence) + '</div>' : '') +
        (x.pain ? '<div class="pq-said"><b>What still comes back to them</b>' + esc(x.pain) + '</div>' : '') +
        (x.times ? '<div class="pq-act"><i>They would talk:</i> ' + esc(x.times) + '</div>' : '') +
        (x.newSubmissionAfterClose ? '<div class="pq-act pq-gap">They submitted again after you closed this, on ' +
          esc(when(x.newSubmissionAfterClose)) + '. The record was not reopened.</div>' : '') +
        notifyLine(x) +
        crmLine(x) + paymentLine(x) +
        '<div class="pq-btns">' +
          '<button type="button" class="pq-btn" data-draftid="' + esc(x.id) + '" data-draftkind="reply">Draft the reply</button>' +
          '<button type="button" class="pq-btn" data-draftid="' + esc(x.id) + '" data-draftkind="roleMap">Draft the role map</button>' +
          '<button type="button" class="pq-btn" data-draftid="' + esc(x.id) + '" data-draftkind="proposal">Draft the proposal</button>' +
          '<button type="button" class="pq-btn" data-payopen="' + esc(x.id) + '">Payment evidence</button>' +
        '</div>' +
        '<div class="pq-form" data-draft="' + esc(x.id) + '" style="display:none"></div>' +
        '<div class="pq-form" data-pay="' + esc(x.id) + '" style="display:none"></div>' +
        '<div class="pq-btns" data-req="' + esc(x.id) + '">' +
          (x.state === 'REQUESTED' ? '<button type="button" class="pq-btn go" data-a="ANSWERED">I replied</button>' : '') +
          (!x.roleMapSentAt ? '<button type="button" class="pq-btn" data-a="ROLE_MAP_SENT">Role map sent</button>' : '') +
          (!x.agreedFor ? '<button type="button" class="pq-btn" data-a="TIME_AGREED">Time agreed</button>' : '') +
          (x.agreedFor && !x.bookingRef ? '<button type="button" class="pq-btn" data-a="BOOKED">Put it on a calendar</button>' : '') +
          (x.bookingRef && !x.heldAt ? '<button type="button" class="pq-btn" data-a="HELD">It was held</button>' : '') +
          '<button type="button" class="pq-btn" data-a="CLOSED">Close with what they said</button>' +
        '</div><div class="pq-msg" data-msg="' + esc(x.id) + '" style="display:none"></div>' +
        '<div class="pq-form" data-form="' + esc(x.id) + '" style="display:none"></div></div>';
  }

  function renderRequests() {
    var el = q('#pq-req');
    var items = (DATA && DATA.requests && DATA.requests.items) || [];
    var inbound = items.filter(function (x) { return (x.origin && x.origin.kind) !== 'cohort'; }).length;
    var promoted = items.length - inbound;
    var head = '<h3>Live opportunities <small>' + inbound + ' from the page, ' + promoted +
      ' opened from the cohort. Counted apart.</small></h3>';
    var rq = DATA && DATA.requests;
    if (!rq || rq.status === 'UNKNOWN') {
      el.innerHTML = head + '<div class="pq-msg bad">The request store did not answer. This is unknown, not zero requests.</div>';
      return;
    }
    var partial = rq.status === 'PARTIAL'
      ? '<div class="pq-msg bad">' + esc(rq.why || 'some requests could not be read') + '. What follows is partial.</div>' : '';
    if (!rq.items.length) {
      el.innerHTML = head + partial + (partial ? '' : '<div class="pq-empty">No role-map requests yet.</div>');
      return;
    }
    el.innerHTML = head + partial + rq.items.map(requestCard).join('') +
    '<div class="pq-note"><b>A request is not a booking.</b> Nothing here is on a calendar until you paste the ' +
    'calendar reference, and role map sent needs the name of what you actually sent. Closing needs their words ' +
    'unless the answer is no response.</div>';

  }

  function wireRequestStageButtons() {
    Array.prototype.forEach.call(root.querySelectorAll('[data-req] .pq-btn'), function (b) {
      b.onclick = function () {
        var id = b.parentNode.getAttribute('data-req'), a = b.getAttribute('data-a');
        var form = inCard(b, '[data-form="' + id + '"]');
        var msg = inCard(b, '[data-msg="' + id + '"]');
        msg.style.display = 'none';
        if (a === 'ANSWERED') { setRequest(id, 'ANSWERED', { answeredAt: new Date().toISOString() }, b); return; }
        var fields = a === 'ROLE_MAP_SENT' ? [['roleMapArtifact', 'What did you send? (file name or subject line)', 'input']]
          : a === 'TIME_AGREED' ? [['agreedFor', 'The time you both agreed (e.g. Tue 30 Sep, 2pm ET)', 'input']]
          : a === 'BOOKED' ? [['bookingRef', 'Calendar or Calendly reference', 'input']]
          : a === 'HELD' ? [['heldAt', 'When it happened', 'input']]
          : [['answerKind', 'One of: NO_RESPONSE ALREADY_COVERED NOT_NOW NO_NEED DECLINED SUPPRESSED', 'input'],
             ['answerWords', 'Their words, pasted', 'textarea']];
        form.style.display = 'grid';
        form.innerHTML = fields.map(function (f) {
          return '<label for="f-' + esc(id + f[0]) + '">' + esc(f[1]) + '</label>' +
            (f[2] === 'textarea' ? '<textarea id="f-' + esc(id + f[0]) + '" data-f="' + esc(f[0]) + '"></textarea>'
              : '<input id="f-' + esc(id + f[0]) + '" data-f="' + esc(f[0]) + '" type="text">');
        }).join('') + '<div class="pq-btns"><button type="button" class="pq-btn go" data-save="1">Save</button>' +
          '<button type="button" class="pq-btn" data-cancel="1">Cancel</button></div>';
        form.querySelector('[data-cancel]').onclick = function () { form.style.display = 'none'; form.innerHTML = ''; };
        form.querySelector('[data-save]').onclick = function (ev) {
          var extra = {};
          Array.prototype.forEach.call(form.querySelectorAll('[data-f]'), function (i) { extra[i.getAttribute('data-f')] = i.value.trim(); });
          if (a === 'ROLE_MAP_SENT') extra.roleMapSentAt = new Date().toISOString();
          msg.style.display = 'block';
          setRequest(id, a, extra, ev.target);
        };
      };
    });
  }

  function renderDrafts() {
    var el = q('#pq-drafts');
    var head = '<h3>What to send, and what to say</h3>';
    var d = DATA && DATA.cohort && DATA.cohort.drafts;
    if (!d) { el.innerHTML = head + '<div class="pq-empty">Drafts could not be loaded from the engine.</div>'; return; }
    var html = head;
    Object.keys(d.openers || {}).forEach(function (k) {
      var o = d.openers[k];
      html += '<details class="pq-draft"><summary>Opener: ' + esc(o.label || k) + '</summary>' +
        (o.subject ? '<div class="pq-they">Subject: ' + esc(o.subject) + '</div>' : '') +
        '<div class="pq-pre">' + esc(o.body) + '</div>' +
        (o.note ? '<div class="pq-then">' + esc(o.note) + '</div>' : '') + '</details>';
    });
    (d.followUps || []).forEach(function (f, i) {
      html += '<details class="pq-draft"><summary>Follow-up ' + (i + 1) + ', after ' + esc(f.after) + '</summary>' +
        '<div class="pq-pre">' + esc(f.body) + '</div>' +
        (f.note ? '<div class="pq-then">' + esc(f.note) + '</div>' : '') + '</details>';
    });
    html += '<details class="pq-draft"><summary>When they push back</summary>' +
      (d.replies || []).map(function (r) {
        return '<div class="pq-they">They say: ' + esc(r.they) + '</div><div class="pq-pre">' + esc(r.say) + '</div>' +
          '<div class="pq-then">' + esc(r.then) + '</div>';
      }).join('') + '</details>';
    html += '<details class="pq-draft"><summary>The role map to write</summary><div class="pq-pre">' +
      esc((d.roleMap && d.roleMap.sections || []).map(function (s) { return s.h + '\n    ' + s.hint; }).join('\n\n')) +
      '</div><div class="pq-then">' + esc((d.roleMap && d.roleMap.footer) || '') + '</div></details>';
    html += '<details class="pq-draft"><summary>The 15 minutes, if they want it</summary><div class="pq-pre">' +
      esc(d.nextStepOffer || '') + '</div><div class="pq-then">' + esc(d.nextStepRule || '') + '</div></details>';
    html += '<div class="pq-note"><b>Paul sends these himself.</b> Nothing in this tab is wired to a sender, ' +
      'and the pilot does not send on his behalf. ' + esc(d.observationRule || '') +
      '<br><b>Never write:</b> ' + esc((d.banned || []).join(', ')) + '.</div>';
    el.innerHTML = html;
  }

  function render() {
    var c = DATA && DATA.cohort;
    var n = (DATA && DATA.requests && DATA.requests.items ? DATA.requests.items.length : 0);
    q('#pq-sub').innerHTML = 'Paul conducts these conversations himself. ' +
      (c && c.cohort ? esc(c.cohort) + ' &middot; ' : '') + n + ' inbound request' + (n === 1 ? '' : 's') +
      ' &middot; automated prospect calling is off for this pilot';
    renderHealth(); renderDo(); renderRequests(); renderPeople(); renderReport(); renderAnswers(); renderDrafts();
    // Bind AFTER every section exists. Binding inside a section meant an early return for an empty
    // list left later sections' controls dead, which is how Start opportunity rendered and did nothing.
    wireAll();
  }

  function load() {
    fetch('/api/pilot-queue/', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.ok !== true) throw new Error((j && j.error) || 'no answer');
        DATA = j; render();
      })
      .catch(function (e) {
        root.innerHTML = '<div class="pq-card"><div class="pq-msg bad">The pilot queue did not load: ' +
          esc(e.message) + '</div></div>';
      });
  }

  function mount(el) {
    root = el;
    if (!document.getElementById('pq-css')) {
      var st = document.createElement('style'); st.id = 'pq-css'; st.textContent = CSS; document.head.appendChild(st);
    }
    root.className = 'pq';
    root.innerHTML = MARKUP;
    q('#pq-refresh').onclick = load;
    load();
  }
  function unmount() { root = null; DATA = null; }

  window.StaffifyPilotQueue = { mount: mount, unmount: unmount,
    // Exposed so a test can render the real templates rather than assert on their source text.
    _requestCard: requestCard, _cohortCard: cohortCard, _setData: function (d) { DATA = d; },
    _renderInto: function (el) { root = el; render(); } };
})();
