(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const svgNS = 'http://www.w3.org/2000/svg';
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const percent = value => (100 * value).toFixed(1) + '%';
  const dateLabel = (date, long = false) => new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', {month:long?'long':'short', day:'numeric', year:'numeric', timeZone:'UTC'});
  function googleLink(date) {
    const link = document.createElement('a');
    link.href = 'https://www.google.com/search?q=' + encodeURIComponent(dateLabel(date, true) + ' historical events');
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    return link;
  }
  function span(className, text) {
    const node = document.createElement('span'); node.className = className; node.textContent = text; return node;
  }
  function svgNode(name, attributes, text) {
    const node = document.createElementNS(svgNS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  let started = false;
  function init() {
    if (started || !window.HISTORY_VIEW?.data) return;
    started = true;
    const view = window.HISTORY_VIEW, analysis = window.HISTORY_ANALYTICS.analyze(view.data);
    let expanded = false, interval = 'years', selectedIndex = 0, chartGeometry, marker;
    const zoom = (from, to = from) => {
      view.setRange(from, to);
      $('map-heading').scrollIntoView({behavior:'smooth', block:'start'});
      $('heatmap').focus({preventScroll:true});
    };
    function renderYears() {
      const metric = $('year-metric').value;
      const ranks = [...analysis.years].sort((a,b) => b[metric] - a[metric] || a.year - b.year).slice(0,10);
      const max = Math.max(1, ...ranks.map(year => year.high));
      $('top-years').replaceChildren();
      for (const year of ranks) {
        const button = document.createElement('button'); button.className = 'year-rank';
        const value = metric === 'mean' ? percent(year.mean) : String(year.high);
        button.setAttribute('aria-label', `${year.year}: ${value}${metric === 'high' ? ' days scoring at least 90%' : ' average probability'}. View year`);
        button.append(span('year-label', String(year.year)));
        const track = span('year-track',''), bar = span('year-bar','');
        bar.style.width = (metric === 'mean' ? year.mean * 100 : year.high / max * 100) + '%';
        track.append(bar); button.append(track, span('year-value', value));
        button.addEventListener('click', () => zoom(year.year)); $('top-years').append(button);
      }
    }
    function renderUnusual() {
      $('unusual-dates').replaceChildren();
      for (const item of analysis.unusual.slice(0, expanded ? 60 : 10)) {
        const link = googleLink(item.date); link.className = 'unusual-date';
        const lift = '+' + (100 * item.delta).toFixed(1) + ' pp';
        link.title = `${dateLabel(item.date, true)}: ${percent(item.probability)}; other years' ${months[+item.date.slice(5,7)-1]} ${+item.date.slice(8)} average ${percent(item.baseline)} (${item.comparisonCount} dates)`;
        link.setAttribute('aria-label', `${dateLabel(item.date, true)}, ${percent(item.probability)}, ${lift} above the same calendar day's average. Google historical events`);
        link.append(span('unusual-label',dateLabel(item.date)), span('unusual-probability',percent(item.probability)), span('unusual-lift',lift));
        $('unusual-dates').append(link);
      }
      $('toggle-unusual').textContent = expanded ? 'Show top 10' : 'Show top 60';
    }
    function points() { return analysis[interval]; }
    function selectPoint(index) {
      const items = points();
      if (!items.length) return;
      selectedIndex = Math.max(0, Math.min(items.length - 1, index));
      const item = items[selectedIndex], {x,y,height,top} = chartGeometry;
      marker.replaceChildren(
        svgNode('line',{x1:x(selectedIndex),x2:x(selectedIndex),y1:top,y2:height-26,class:'trend-marker-line'}),
        svgNode('circle',{cx:x(selectedIndex),cy:y(item.mean),r:4,class:'trend-marker-dot'})
      );
      const label = interval === 'years' ? item.year : item.decade + 's';
      $('trend-selection').textContent = `${label} · Mean P(yes) ${percent(item.mean)}`;
      $('trend-selection').title = `${item.count.toLocaleString('en-US')} dates${interval === 'decades' ? ', ' + item.numberYears + ' complete years' : ''}`;
      $('trend-zoom').textContent = interval === 'years' ? 'View year' : 'View decade';
    }
    function renderTrend() {
      const chart = $('history-trend'), items = points();
      const width = Math.max(330, chart.parentElement.clientWidth), height = 230, left = 42, right = 15, top = 15, bottom = 26;
      const x = i => left + i / Math.max(1,items.length-1) * (width-left-right);
      const y = value => top + (1-value) * (height-top-bottom);
      chart.setAttribute('viewBox',`0 0 ${width} ${height}`); chart.replaceChildren();
      chart.append(svgNode('title',{},`Mean probability by ${interval === 'years' ? 'complete year' : 'decade'}`));
      for (const value of [0,.25,.5,.75,1]) {
        chart.append(svgNode('line',{x1:left,x2:width-right,y1:y(value),y2:y(value),class:'trend-grid'}));
        chart.append(svgNode('text',{x:left-8,y:y(value)+3,'text-anchor':'end',class:'trend-axis'},Math.round(value*100)+'%'));
      }
      if (!items.length) return;
      const path = items.map((item,i) => `${i ? 'L' : 'M'} ${x(i)} ${y(item.mean)}`).join(' ');
      chart.append(svgNode('path',{d:`${path} L ${x(items.length-1)} ${y(0)} L ${x(0)} ${y(0)} Z`,class:'trend-area'}));
      chart.append(svgNode('path',{d:path,class:'trend-line'}));
      const value = item => interval === 'years' ? item.year : item.decade;
      const first = value(items[0]), last = value(items[items.length-1]);
      const ticks = Math.max(2, Math.floor((width-left-right)/110));
      const used = new Set();
      for (let n = 0; n <= ticks; n++) {
        const i = Math.round(n/ticks*(items.length-1)); if (used.has(i)) continue; used.add(i);
        chart.append(svgNode('text',{x:x(i),y:height-5,'text-anchor':i===0?'start':i===items.length-1?'end':'middle',class:'trend-axis'},String(value(items[i]))));
      }
      chart.setAttribute('aria-label',`Mean probability ${first}–${last}, by ${interval}. Left and right arrows select; Enter zooms the heatmap.`);
      marker = svgNode('g',{}); chart.append(marker);
      chartGeometry = {x,y,width,height,left,right,top}; selectPoint(selectedIndex);
    }
    function changeInterval(next) {
      const current = points()[selectedIndex];
      const year = interval === 'years' ? current?.year : current?.decade;
      interval = next;
      selectedIndex = Math.max(0, points().findIndex(item => interval === 'years' ? item.year >= year : item.decade === Math.floor(year/10)*10));
      $('trend-years').setAttribute('aria-pressed',String(interval==='years'));
      $('trend-decades').setAttribute('aria-pressed',String(interval==='decades'));
      renderTrend();
    }
    function zoomPoint() {
      const item = points()[selectedIndex]; if (!item) return;
      if (interval === 'years') zoom(item.year);
      else {
        const years = analysis.years.filter(year => Math.floor(year.year/10)*10 === item.decade);
        zoom(years[0].year,years[years.length-1].year);
      }
    }
    function pointerIndex(event) {
      const rect = $('history-trend').getBoundingClientRect(), {width,left,right} = chartGeometry;
      const x = (event.clientX - rect.left) * width / rect.width;
      return Math.round((x-left)/(width-left-right)*(points().length-1));
    }
    let calendarSelected;
    function selectCalendar(item) {
      if (calendarSelected) calendarSelected.classList.remove('selected');
      calendarSelected = document.querySelector(`[data-calendar-day="${item.monthDay}"]`);
      calendarSelected.classList.add('selected');
      $('calendar-selection').textContent = `${months[item.month-1]} ${item.day} · ${item.mean == null ? 'Missing' : percent(item.mean)}`;
      $('calendar-selection').title = `Mean P(yes) across ${item.count} dates`;
      $('calendar-dates').replaceChildren();
      for (const date of item.topDates) {
        const link = googleLink(date.date); link.textContent = `${dateLabel(date.date)} · ${percent(date.probability)}`;
        link.title = 'Click to Google'; $('calendar-dates').append(link);
      }
    }
    function renderCalendar() {
      $('calendar-months').replaceChildren();
      for (let month = 1; month <= 12; month++) {
        const card = document.createElement('div'); card.className = 'calendar-month';
        const heading = document.createElement('h3'); heading.textContent = months[month-1];
        const grid = document.createElement('div'); grid.className = 'calendar-grid';
        const items = analysis.calendar.filter(day => day.month === month);
        for (const [index,item] of items.entries()) {
          const button = document.createElement('button'); button.className = 'calendar-day'; button.textContent = String(item.day);
          button.dataset.calendarDay = item.monthDay;
          if (!index) button.style.gridColumnStart = ((new Date(item.templateDate+'T00:00:00Z').getUTCDay()+6)%7)+1;
          button.style.background = view.color(item.mean);
          button.title = `${months[month-1]} ${item.day} · Mean ${item.mean == null ? 'Missing' : percent(item.mean)} · ${item.count} dates`;
          button.setAttribute('aria-label',button.title); button.disabled = !item.count;
          button.addEventListener('click',()=>selectCalendar(item)); grid.append(button);
        }
        card.append(heading,grid); $('calendar-months').append(card);
      }
      const highest = [...analysis.calendar].filter(day => day.count).sort((a,b)=>b.mean-a.mean)[0];
      if (highest) selectCalendar(highest);
    }
    $('year-metric').addEventListener('change',renderYears);
    $('toggle-unusual').addEventListener('click',()=>{expanded=!expanded;renderUnusual();});
    $('trend-years').addEventListener('click',()=>changeInterval('years'));
    $('trend-decades').addEventListener('click',()=>changeInterval('decades'));
    $('trend-zoom').addEventListener('click',zoomPoint);
    $('history-trend').addEventListener('mousemove',event=>selectPoint(pointerIndex(event)));
    $('history-trend').addEventListener('click',event=>{selectPoint(pointerIndex(event));zoomPoint();});
    $('history-trend').addEventListener('keydown',event=>{
      if (['ArrowLeft','ArrowRight','Home','End','Enter',' '].includes(event.key)) event.preventDefault();
      if (event.key==='ArrowLeft') selectPoint(selectedIndex-1);
      if (event.key==='ArrowRight') selectPoint(selectedIndex+1);
      if (event.key==='Home') selectPoint(0);
      if (event.key==='End') selectPoint(points().length-1);
      if (event.key==='Enter'||event.key===' ') zoomPoint();
    });
    selectedIndex = Math.max(0,analysis.years.findIndex(item=>item.year===1945));
    renderYears();renderUnusual();renderCalendar();renderTrend();
    let resizeTimer;
    window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(renderTrend,100);});
    window.HISTORY_INSIGHTS = {analysis};
  }
  window.addEventListener('history-ready',init);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init);
  else init();
})();
