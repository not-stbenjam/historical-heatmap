(() => {
  'use strict';
  const DAY = 86400000;
  const $ = id => document.getElementById(id);
  const iso = time => new Date(time).toISOString().slice(0, 10);
  const padYear = year => String(year).padStart(4, '0');
  const parseDate = date => Date.parse(date + 'T00:00:00Z');
  const pretty = date => new Date(parseDate(date)).toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric', timeZone:'UTC'});
  const short = date => new Date(parseDate(date)).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric', timeZone:'UTC'});
  const pct = p => p == null ? 'Missing' : (p * 100).toFixed(1) + '%';
  const palette = [[240,236,227],[237,203,165],[233,160,107],[207,102,61],[168,50,36]];
  function color(p) {
    if (p == null) return '#bbb8b1';
    const scaled = Math.min(1, Math.max(0, p)) * 4, i = Math.min(3, Math.floor(scaled)), f = scaled - i;
    return 'rgb(' + palette[i].map((n,j) => Math.round(n + (palette[i+1][j]-n)*f)).join(',') + ')';
  }
  let data, start, end, selected = '1969-07-20', from, to, threshold = 0, expanded = false, geometry;
  const eventsByDate = new Map(), monthDays = [], columns = new Map();
  for (let t = parseDate('2000-01-01'); t <= parseDate('2000-12-31'); t += DAY) {
    const md = iso(t).slice(5); columns.set(md, monthDays.length); monthDays.push(md);
  }
  const probability = date => {
    const index = Math.round((parseDate(date) - start) / DAY);
    return index >= 0 && index < data.probabilities.length ? data.probabilities[index] : null;
  };
  const inBounds = date => parseDate(date) >= start && parseDate(date) <= end;
  function dateAt(year, column) {
    if (column < 0 || column > 365) return null;
    const date = padYear(year) + '-' + monthDays[column];
    return iso(parseDate(date)) === date && inBounds(date) ? date : null;
  }
  function renderMap() {
    const canvas = $('heatmap'), width = Math.max(300, canvas.parentElement.clientWidth), years = to - from + 1;
    const row = Math.max(1, Math.min(9, 535 / years)), left = 48, top = 25, bottom = 8;
    const height = Math.ceil(top + years * row + bottom), gridWidth = width - left, cell = gridWidth / 366;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    canvas.style.height = height + 'px';
    const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
    ctx.fillStyle = '#faf8f3'; ctx.fillRect(0, 0, width, height);
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#777268';
    const monthLabels = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    for (let m = 0; m < 12; m++) {
      const first = columns.get(String(m + 1).padStart(2,'0') + '-01');
      ctx.fillText(monthLabels[m], left + first * cell + 2, 10);
    }
    const tick = years > 200 ? 50 : years > 80 ? 20 : years > 30 ? 10 : years > 10 ? 5 : 1;
    for (let year = from; year <= to; year++) {
      const y = top + (year - from) * row;
      if (year === from || year === to || (year % tick === 0 && year - from > tick / 4 && to - year > tick / 4)) {
        ctx.fillStyle = '#777268'; ctx.fillText(String(year), 0, y + row / 2);
      }
      for (let c = 0; c < 366; c++) {
        const date = dateAt(year,c); if (!date) continue;
        const p = probability(date);
        ctx.fillStyle = p != null && p < threshold ? '#eeeae2' : color(p);
        ctx.fillRect(left + c * cell, y, cell + .1, row + .05);
      }
    }
    for (let m = 1; m < 12; m++) {
      const c = columns.get(String(m + 1).padStart(2,'0') + '-01');
      ctx.strokeStyle = 'rgba(250,248,243,0.20)';ctx.lineWidth = .5;ctx.beginPath();ctx.moveTo(left+c*cell,top);ctx.lineTo(left+c*cell,top+years*row);ctx.stroke();
    }
    if (selected && +selected.slice(0,4) >= from && +selected.slice(0,4) <= to) {
      const c = columns.get(selected.slice(5)), y = top + (+selected.slice(0,4) - from)*row;
      ctx.strokeStyle = '#282620';ctx.lineWidth = 1.5;
      ctx.strokeRect(left+c*cell-1, y-1, cell+2, row+2);
    }
    geometry = {width,height,row,left,top,cell};
    $('range-description').textContent = `${from}–${to}`;
  }
  function setRange(a,b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
    a = Math.trunc(a); b = Math.trunc(b);
    from = Math.max(+data.start.slice(0,4), Math.min(a,b)); to = Math.min(+data.end.slice(0,4), Math.max(a,b));
    if (from > to) { from = +data.start.slice(0,4);to = +data.end.slice(0,4); }
    $('year-from').value = from; $('year-to').value = to;
    document.querySelectorAll('[data-range]').forEach(btn => btn.classList.toggle('active',btn.dataset.range === 'all' ? from === +data.start.slice(0,4) && to === +data.end.slice(0,4) : btn.dataset.range === '1900' ? from === 1900 && to === +data.end.slice(0,4) : from === +btn.dataset.range && to === +btn.dataset.range));
    renderMap();renderRanking();
  }
  function selectDate(date, reveal = false) {
    if (!inBounds(date)) return;
    selected = date; $('selected-heading').textContent = pretty(date);$('selected-probability').textContent = pct(probability(date));$('date-input').value = date;
    const container = $('selected-event');container.replaceChildren();
    const events = eventsByDate.get(date) || [];
    if (!events.length) container.textContent = 'No event label';
    for (const event of events) {
      const row = document.createElement('div'),title=document.createElement('strong');title.textContent=event.title;row.append(title);
      if (event.source && /^https?:\/\//.test(event.source)) {const link=document.createElement('a');link.href=event.source;link.target='_blank';link.rel='noopener';link.textContent='Source ↗';row.append(link);}
      if(event.note){const note=document.createElement('span');note.className='event-note';note.textContent=event.note;row.append(note);}container.append(row);
    }
    const strip = $('neighbor-strip');strip.replaceChildren();
    for(let n=-7;n<=7;n++){
      const d=iso(parseDate(date)+n*DAY),button=document.createElement('button');button.style.background=inBounds(d)?color(probability(d)):'#faf8f3';button.disabled=!inBounds(d);button.title=pretty(d)+': '+pct(probability(d));button.setAttribute('aria-label',button.title);button.classList.toggle('selected',n===0);button.addEventListener('click',()=>selectDate(d,true));strip.append(button);
    }
    $('neighbor-start').textContent=short(iso(parseDate(date)-7*DAY));$('neighbor-end').textContent=short(iso(parseDate(date)+7*DAY));
    if (reveal && (+date.slice(0,4)<from || +date.slice(0,4)>to)) setRange(+date.slice(0,4),+date.slice(0,4));else renderMap();
  }
  function renderEvents() {
    const container=$('event-buttons');container.replaceChildren();
    for(const event of data.events || []) {
      const button=document.createElement('button');button.className='event-button';
      const top=document.createElement('span');top.className='event-top';const date=document.createElement('span');date.textContent=short(event.date);const p=document.createElement('span');p.className='event-p';p.textContent=pct(probability(event.date));top.append(date,p);
      const title=document.createElement('span');title.className='event-title';title.textContent=event.title;button.append(top,title);button.addEventListener('click',()=>{selectDate(event.date,true);$('selected-heading').scrollIntoView({behavior:'smooth',block:'center'});});container.append(button);
    }
  }
  function renderRanking() {
    const ranks=[];
    const low=Math.max(0,Math.round((parseDate(padYear(from)+'-01-01')-start)/DAY)),high=Math.min(data.probabilities.length-1,Math.round((parseDate(padYear(to)+'-12-31')-start)/DAY));
    for(let i=low;i<=high;i++){const p=data.probabilities[i];if(p != null && p >= threshold)ranks.push({i,p});}
    ranks.sort((a,b)=>b.p-a.p||a.i-b.i);
    const container=$('top-dates');container.replaceChildren();
    for(const [rank,item] of ranks.slice(0,expanded?60:12).entries()) {
      const date=iso(start+item.i*DAY),link=document.createElement('a');link.className='rank-item';
      link.href='https://www.google.com/search?q='+encodeURIComponent(pretty(date)+' historical events');link.target='_blank';link.rel='noopener noreferrer';link.setAttribute('aria-label','Google historical events on '+pretty(date));
      for(const [className,value] of [['rank-number',String(rank+1).padStart(2,'0')],['rank-date',short(date)],['rank-confidence',pct(item.p)]]){const span=document.createElement('span');span.className=className;span.textContent=value;link.append(span);}
      const swatch=document.createElement('span');swatch.className='rank-swatch';swatch.style.background=color(item.p);link.append(swatch);container.append(link);
    }
    $('toggle-ranked').textContent=expanded?'Show top 12':'Show top 60';
  }
  function download(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function init() {
    try {
      if(window.HISTORY_DATA)data=window.HISTORY_DATA;else{const response=await fetch('./data.json');if(!response.ok)throw new Error('Data request returned '+response.status);data=await response.json();}
      start=parseDate(data.start);end=parseDate(data.end);from=+data.start.slice(0,4);to=+data.end.slice(0,4);
      for(const event of data.events || []){if(!eventsByDate.has(event.date))eventsByDate.set(event.date,[]);eventsByDate.get(event.date).push(event);}
      const stats=data.stats || {}, count=data.probabilities.filter(p=>p!=null).length, high=data.probabilities.filter(p=>p!=null&&p>=.9).length;
      $('dates-count').textContent=count.toLocaleString('en-US');$('high-count').textContent=high.toLocaleString('en-US');$('mean-confidence').textContent=pct(stats.mean ?? data.probabilities.reduce((sum,p)=>sum+(p||0),0)/Math.max(count,1));$('run-cost').textContent=stats.cost == null?'—':'$'+Number(stats.cost).toFixed(2);
      $('date-input').min=data.start;$('date-input').max=data.end;$('year-from').min=from;$('year-from').max=to;$('year-to').min=from;$('year-to').max=to;
      $('loading').hidden=true;$('loading').style.display='none';setRange(from,to);renderEvents();selectDate(inBounds(selected)?selected:data.start);
      document.querySelectorAll('[data-range]').forEach(button=>button.addEventListener('click',()=>{const value=button.dataset.range;setRange(value==='all'?+data.start.slice(0,4):+value,value==='all'||value==='1900'?+data.end.slice(0,4):+value);}));
      $('apply-range').addEventListener('click',()=>setRange(+$('year-from').value,+$('year-to').value));
      for(const id of ['year-from','year-to'])$(id).addEventListener('keydown',event=>{if(event.key==='Enter')setRange(+$('year-from').value,+$('year-to').value);});
      const updateThreshold=()=>{threshold=+$('threshold').value/100;$('threshold-label').textContent=Math.round(threshold*100)+'%';renderMap();renderRanking();};
      $('threshold').addEventListener('input',updateThreshold);$('threshold-reset').addEventListener('click',()=>{$('threshold').value=0;updateThreshold();});
      $('date-input').addEventListener('change',()=>{const date=$('date-input').value;if(date&&inBounds(date))selectDate(date,true);});
      $('toggle-ranked').addEventListener('click',()=>{expanded=!expanded;renderRanking();});
      function pointerDate(event){const rect=$('heatmap').getBoundingClientRect(),x=(event.clientX-rect.left)*geometry.width/rect.width,y=(event.clientY-rect.top)*geometry.height/rect.height;return dateAt(from+Math.floor((y-geometry.top)/geometry.row),Math.floor((x-geometry.left)/geometry.cell));}
      $('heatmap').addEventListener('mousemove',event=>{const date=pointerDate(event),tooltip=$('tooltip');if(!date||+date.slice(0,4)<from||+date.slice(0,4)>to){tooltip.hidden=true;return;}tooltip.textContent=short(date)+' · P(yes) '+pct(probability(date));tooltip.hidden=false;const rect=$('heatmap').getBoundingClientRect();tooltip.style.left=Math.max(0,Math.min(rect.width-tooltip.offsetWidth,event.clientX-rect.left+10))+'px';tooltip.style.top=Math.max(0,event.clientY-rect.top-35)+'px';});
      $('heatmap').addEventListener('mouseleave',()=>{$('tooltip').hidden=true;});$('heatmap').addEventListener('click',event=>{const date=pointerDate(event);if(date&&+date.slice(0,4)>=from&&+date.slice(0,4)<=to)selectDate(date);});
      $('heatmap').addEventListener('keydown',event=>{const offset={ArrowLeft:-1,ArrowRight:1,ArrowUp:-365,ArrowDown:365}[event.key];if(offset===undefined)return;event.preventDefault();let date;if(event.key==='ArrowUp'||event.key==='ArrowDown'){const year=+selected.slice(0,4)+(offset>0?1:-1);if(year<1||year>9999)return;date=padYear(year)+selected.slice(4);if(iso(parseDate(date))!==date)date=padYear(year)+'-02-28';}else date=iso(parseDate(selected)+offset*DAY);selectDate(date,true);});
      $('export-png').addEventListener('click',()=>{
        const source=$('heatmap'),canvas=document.createElement('canvas');canvas.width=source.width;canvas.height=source.height+120;
        const ctx=canvas.getContext('2d');ctx.fillStyle='#faf8f3';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#282620';ctx.font='bold 28px sans-serif';ctx.fillText('How Jev sees history · '+from+'–'+to,20,40);ctx.drawImage(source,0,65);ctx.font='12px sans-serif';ctx.fillStyle='#777268';ctx.fillText('P(yes) · 0–100%',20,canvas.height-20);canvas.toBlob(blob=>download(blob,`jev-history-${from}-${to}.png`));
      });
      $('export-csv').addEventListener('click',()=>{const rows=['date,probability_yes'];data.probabilities.forEach((p,i)=>rows.push(iso(start+i*DAY)+','+(p??'')));download(new Blob([rows.join('\n')],{type:'text/csv'}),'jev-history-all-dates.csv');});
      let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(renderMap,100);});
      window.HISTORY_VIEW={selectDate,setRange,color,get data(){return data;}};
    } catch(error) {$('loading').textContent='Could not load the experiment: '+error.message;console.error(error);}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
