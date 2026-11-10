import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, bucketOf, compareTasks, daysBetween, emptyText, fmtDue, groupTasks, matches, summarize,
} from '../renderer/src/todo/model.js';

const TODAY = '2026-11-10'; // a Tuesday
const task = (due, extra = {}) => ({ id: due ?? 'none', content: 'x', due, time: null, priority: 1, order: 0, ...extra });

test('calendar arithmetic on YYYY-MM-DD days', () => {
  assert.equal(addDays('2026-11-10', 1), '2026-11-11');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-29', 1), '2026-03-30'); // DST switch in Europe – still one day
  assert.equal(addDays('2026-11-10', -10), '2026-10-31');
  assert.equal(daysBetween('2026-11-10', '2026-11-13'), 3);
  assert.equal(daysBetween('2026-11-10', '2026-11-01'), -9);
});

test('deadline buckets', () => {
  assert.equal(bucketOf(task(null), TODAY), 'none');
  assert.equal(bucketOf(task('2026-11-09'), TODAY), 'overdue');
  assert.equal(bucketOf(task('2026-11-10'), TODAY), 'today');
  assert.equal(bucketOf(task('2026-11-11'), TODAY), 'tomorrow');
  assert.equal(bucketOf(task('2026-11-16'), TODAY), 'week');
  assert.equal(bucketOf(task('2026-11-17'), TODAY), 'later');
});

test('filters by deadline: today includes the overdue, a date means due on or before', () => {
  const overdue = task('2026-11-01');
  const today = task('2026-11-10');
  const friday = task('2026-11-13');
  const later = task('2026-12-24');
  const none = task(null);
  const all = [overdue, today, friday, later, none];
  const pick = (f) => all.filter((t) => matches(t, f, TODAY)).map((t) => t.id);
  assert.deepEqual(pick('today'), ['2026-11-01', '2026-11-10']);
  assert.deepEqual(pick('week'), ['2026-11-01', '2026-11-10', '2026-11-13']);
  assert.deepEqual(pick('none'), ['none']);
  assert.deepEqual(pick('all'), all.map((t) => t.id));
  assert.deepEqual(pick({ until: '2026-11-13' }), ['2026-11-01', '2026-11-10', '2026-11-13']);
  assert.deepEqual(pick({ until: '2026-11-12' }), ['2026-11-01', '2026-11-10']);
});

test('ordering: deadline, then time, priority (4 = p1), Todoist order; no deadline last', () => {
  const list = [
    task(null, { id: 'n' }),
    task('2026-11-10', { id: 'b', priority: 1, order: 2 }),
    task('2026-11-10', { id: 'a', priority: 1, order: 1 }),
    task('2026-11-10', { id: 'p1', priority: 4, order: 9 }),
    task('2026-11-10', { id: 'noon', time: '12:00', priority: 1 }),
    task('2026-11-09', { id: 'y' }),
  ];
  assert.deepEqual([...list].sort(compareTasks).map((t) => t.id), ['y', 'noon', 'p1', 'a', 'b', 'n']);
});

test('groups in bucket order, empty ones left out, each sorted', () => {
  const groups = groupTasks([task('2026-11-20'), task('2026-11-10', { id: 'late', order: 2 }), task('2026-11-10', { id: 'first', order: 1 }), task('2026-11-02'), task(null)], 'all', TODAY);
  assert.deepEqual(groups.map((g) => [g.bucket, g.label, g.tasks.map((t) => t.id)]), [
    ['overdue', 'Po termínu', ['2026-11-02']],
    ['today', 'Dnes', ['first', 'late']],
    ['later', 'Později', ['2026-11-20']],
    ['none', 'Bez termínu', ['none']],
  ]);
  assert.deepEqual(groupTasks([task(null)], 'today', TODAY), []);
});

test('the director counts what is overdue, due today and due within the week', () => {
  const tasks = [task('2026-11-01'), task('2026-11-09'), task('2026-11-10'), task('2026-11-11'), task('2026-11-16'), task('2026-11-17'), task(null)];
  assert.deepEqual(summarize(tasks, TODAY), { overdue: 2, today: 1, week: 2, total: 7 });
});

test('deadline labels', () => {
  assert.equal(fmtDue(null, TODAY), 'bez termínu');
  assert.equal(fmtDue('2026-11-10', TODAY), 'dnes');
  assert.equal(fmtDue('2026-11-11', TODAY), 'zítra');
  assert.equal(fmtDue('2026-11-09', TODAY), 'včera');
  assert.equal(fmtDue('2026-11-13', TODAY), 'pá 13. 11.');
  assert.equal(fmtDue('2026-11-05', TODAY), 'čt 5. 11.');
  assert.equal(fmtDue('2026-11-17', TODAY), '17. 11.');
  assert.equal(fmtDue('2027-01-03', TODAY), '3. 1. 2027');
  assert.match(emptyText('today'), /nic nezbývá/);
  assert.match(emptyText({ until: '2026-11-13' }), /Do tohoto data/);
  assert.equal(emptyText('all'), 'Žádné úkoly.');
});
