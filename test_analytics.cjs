'use strict';
const assert = require('node:assert/strict');
const {analyze} = require('./web/analytics.js');
const DAY = 86400000;
const time = date => Date.parse(date + 'T00:00:00Z');
function fixture(start, end, score = .2) {
  return {start, end, probabilities: Array(Math.round((time(end) - time(start)) / DAY) + 1).fill(score)};
}
function set(data, date, score) { data.probabilities[Math.round((time(date) - time(data.start)) / DAY)] = score; }
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

// Complete coverage excludes partial boundaries, missing scores and invalid data.
const boundaries = fixture('1999-12-31', '2002-04-01');
set(boundaries, '2001-07-01', null);
assert.deepEqual(analyze(boundaries).years.map(year => year.year), [2000]);
set(boundaries, '2000-01-01', NaN);
assert.equal(analyze(boundaries).years.length, 0);
assert.equal(analyze(boundaries).decades.length, 0);

// Gregorian century rules and pooled daily weights include leap years correctly.
const centuries = analyze(fixture('1899-01-01', '1900-12-31'));
assert.deepEqual(centuries.years.map(year => year.count), [365, 365]);
const weighted = fixture('2000-01-01', '2001-12-31', .8);
for (let index = 0; index < 366; index++) weighted.probabilities[index] = .1;
const weightedResult = analyze(weighted);
assert.deepEqual(weightedResult.years.map(year => year.count), [366, 365]);
assert.equal(weightedResult.decades[0].numberYears, 2);
close(weightedResult.decades[0].mean, (366 * .1 + 365 * .8) / 731);

// Outlier baseline leaves its own year out, with raw confidence preserved.
const outlier = fixture('1999-01-01', '2001-12-31');
set(outlier, '2000-07-20', .98);
set(outlier, '2000-07-21', .95);
const outlierResult = analyze(outlier);
assert.equal(outlierResult.unusual[0].date, '2000-07-20');
close(outlierResult.unusual[0].baseline, .2);
close(outlierResult.unusual[0].delta, .78);
assert.equal(outlierResult.unusual[0].probability, .98);
assert.equal(outlierResult.unusual[0].comparisonCount, 2);
const calendarDay = outlierResult.calendar.find(day => day.monthDay === '07-20');
assert.equal(calendarDay.templateDate, '2000-07-20');
close(calendarDay.mean, (.2 + .98 + .2) / 3);
assert.deepEqual(calendarDay.topDates.map(day => day.date), ['2000-07-20', '1999-07-20', '2001-07-20']);
assert.equal(outlierResult.calendar.find(day => day.monthDay === '02-29').count, 1);
assert.ok(!outlierResult.unusual.some(day => day.date === '2000-02-29'));

// The bounded top list matches a complete reference sort, including ties.
const varied = fixture('2000-01-01', '2003-12-31');
varied.probabilities = varied.probabilities.map((_, index) => ((index * 17) % 101) / 100);
const groups = new Map();
varied.probabilities.forEach((probability, index) => {
  const date = new Date(time(varied.start) + index * DAY).toISOString().slice(0, 10);
  const key = date.slice(5);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({date, probability});
});
const reference = [];
for (const days of groups.values()) {
  const sum = days.reduce((total, day) => total + day.probability, 0);
  if (days.length < 2) continue;
  for (const day of days) reference.push({...day, delta: day.probability - (sum - day.probability) / (days.length - 1)});
}
reference.sort((a, b) => b.delta - a.delta || b.probability - a.probability || a.date.localeCompare(b.date));
assert.deepEqual(analyze(varied).unusual.map(day => day.date), reference.slice(0, 60).map(day => day.date));
assert.equal(analyze(fixture('2000-03-01', '2000-03-01')).calendar.find(day => day.monthDay === '02-29').mean, null);
assert.throws(() => analyze({start: '2000-02-30', probabilities: []}), TypeError);
console.log('Analytics checks passed');
