/* Illustrative headcounts only; the client's operations owner is additional. */
(function () {
  'use strict';
  var presets = {10: [8, 1, 1], 20: [17, 2, 1], 30: [25, 3, 2]};
  var cells = document.querySelector('.org-cells');
  var legend = document.querySelector('.org-legend');
  var buttons = document.querySelectorAll('[data-team-size]');
  if (!cells || !legend) return;
  function group(title, count, type) {
    var section = document.createElement('section');
    section.className = 'seat-group ' + type;
    var heading = document.createElement('h3');
    heading.textContent = title;
    var badge = document.createElement('span');
    badge.textContent = count + (count === 1 ? ' seat' : ' seats');
    heading.appendChild(badge);
    section.appendChild(heading);
    var seats = document.createElement('div');
    seats.className = 'seat-grid';
    seats.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < count; i++) {
      var seat = document.createElement('span');
      seat.className = 'brand-seat';
      var icon = document.createElement('img');
      icon.src = '/assets/brand/icon.svg';
      icon.alt = '';
      icon.width = 26;
      icon.height = 26;
      seat.appendChild(icon);
      seats.appendChild(seat);
    }
    section.appendChild(seats);
    return section;
  }
  function render(n) {
    var counts = presets[n];
    if (!counts) return;
    cells.replaceChildren(
      group('Team managers / leads', counts[1], 'manager-seats'),
      group('Customer-support specialists', counts[0], 'specialist-seats'),
      group('Quality assurance', counts[2], 'quality-seats')
    );
    legend.textContent = n + ' total seats · Every Staffify mark represents one person';
    buttons.forEach(function (b) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.teamSize) === n));
    });
  }
  buttons.forEach(function (b) {
    b.addEventListener('click', function () { render(Number(b.dataset.teamSize)); });
  });
  render(10);
})();
