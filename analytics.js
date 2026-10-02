(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HISTORY_ANALYTICS = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const DAY = 86400000;
  const MONTH_OFFSETS = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  const validScore = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
  const leapYear = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const pad = value => String(value).padStart(2, '0');
  const better = (a, b) => a.delta > b.delta || (a.delta === b.delta && (a.probability > b.probability || (a.probability === b.probability && a.index < b.index)));

  // A bounded heap keeps the worst of the current top 60 at its root.
  function retainUnusual(heap, item) {
    if (heap.length < 60) {
      heap.push(item);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (!better(heap[parent], heap[index])) break;
        [heap[parent], heap[index]] = [heap[index], heap[parent]];
        index = parent;
      }
      return;
    }
    if (!better(item, heap[0])) return;
    heap[0] = item;
    let index = 0;
    while (index * 2 + 1 < heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < heap.length && better(heap[child], heap[child + 1])) child++;
      if (!better(heap[index], heap[child])) break;
      [heap[index], heap[child]] = [heap[child], heap[index]];
      index = child;
    }
  }

  function analyze(data) {
    if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data.start || '') || !Array.isArray(data.probabilities)) {
      throw new TypeError('Expected a start date and chronological probabilities array');
    }
    const start = Date.parse(data.start + 'T00:00:00Z');
    if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== data.start) {
      throw new TypeError('Invalid start date');
    }
    const isoAt = index => new Date(start + index * DAY).toISOString().slice(0, 10);
    const calendar = Array.from({length: 366}, (_, index) => {
      const date = new Date(Date.UTC(2000, 0, index + 1));
      const month = date.getUTCMonth() + 1, day = date.getUTCDate();
      const monthDay = pad(month) + '-' + pad(day);
      return {month, day, monthDay, templateDate: '2000-' + monthDay, count: 0, sum: 0, topDates: []};
    });
    const yearTotals = new Map();
    const date = new Date(start);
    for (let index = 0; index < data.probabilities.length; index++) {
      const probability = data.probabilities[index];
      if (validScore(probability)) {
        const year = date.getUTCFullYear();
        if (!yearTotals.has(year)) yearTotals.set(year, {year, count: 0, sum: 0, high: 0});
        const total = yearTotals.get(year);
        total.count++; total.sum += probability;
        if (probability >= .9) total.high++;
        const day = calendar[MONTH_OFFSETS[date.getUTCMonth()] + date.getUTCDate() - 1];
        day.count++; day.sum += probability;
        if (day.topDates.length < 3 || probability > day.topDates[day.topDates.length - 1].probability) {
          day.topDates.push({index, probability});
          day.topDates.sort((a, b) => b.probability - a.probability || a.index - b.index);
          day.topDates.length = Math.min(3, day.topDates.length);
        }
      }
      date.setUTCDate(date.getUTCDate() + 1);
    }

    const complete = Array.from(yearTotals.values()).filter(year => year.count === (leapYear(year.year) ? 366 : 365)).sort((a, b) => a.year - b.year);
    const decadeTotals = new Map();
    for (const year of complete) {
      const decade = Math.floor(year.year / 10) * 10;
      if (!decadeTotals.has(decade)) decadeTotals.set(decade, {decade, count: 0, sum: 0, numberYears: 0});
      const total = decadeTotals.get(decade);
      total.count += year.count; total.sum += year.sum; total.numberYears++;
    }

    const unusual = [];
    date.setTime(start);
    for (let index = 0; index < data.probabilities.length; index++) {
      const probability = data.probabilities[index];
      if (validScore(probability)) {
        const day = calendar[MONTH_OFFSETS[date.getUTCMonth()] + date.getUTCDate() - 1];
        // Each month/day occurs once per year: subtraction excludes this year.
        if (day.count > 1) {
          const baseline = (day.sum - probability) / (day.count - 1);
          retainUnusual(unusual, {index, probability, baseline, delta: probability - baseline, comparisonCount: day.count - 1});
        }
      }
      date.setUTCDate(date.getUTCDate() + 1);
    }
    unusual.sort((a, b) => b.delta - a.delta || b.probability - a.probability || a.index - b.index);
    return {
      years: complete.map(({year, count, sum, high}) => ({year, count, mean: sum / count, high})),
      calendar: calendar.map(({sum, topDates, ...day}) => ({...day, mean: day.count ? sum / day.count : null, topDates: topDates.map(({index, probability}) => ({date: isoAt(index), probability}))})),
      unusual: unusual.map(({index, ...item}) => ({date: isoAt(index), ...item})),
      decades: Array.from(decadeTotals.values()).sort((a, b) => a.decade - b.decade).map(({sum, ...decade}) => ({...decade, mean: sum / decade.count}))
    };
  }
  return {analyze};
});
