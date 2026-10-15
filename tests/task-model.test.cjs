'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../task-model.js');
const day = '2026-10-15';
const state = tasks => M.normalize({ tasks });

test('normalizes legacy string steps, task dates, and reminder state without losing fields', () => {
  const data = state([{ id: 'old', title: 'Legacy', when: 'today', steps: ['Find notes'], reminderDate: day, seriesId: 'keep' }]);
  const task = data.tasks[0];
  assert.equal(task.dueDate, M.today());
  assert.equal(task.steps[0].title, 'Find notes');
  assert.equal(task.steps[0].done, false);
  assert.equal(task.remindersEnabled, true);
  assert.equal(task.seriesId, 'keep');
});
test('explicit reminder opt-out stays off even with a prefilled date', () => {
  assert.equal(state([{ title: 'Task', reminderDate: day, remindersEnabled: false }]).tasks[0].remindersEnabled, false);
});
test('Today includes a dated step under a future parent task', () => {
  const data = state([{ title: 'Trip', dueDate: '2026-11-01', steps: [{ title: 'Book train', dueDate: day }] }]);
  assert.equal(M.tasksFor(data, { view: 'today' }, day).length, 1);
  assert.equal(M.stepsFor(data, { view: 'today' }, day)[0].step.title, 'Book train');
});
test('overdue steps remain actionable in Today', () => {
  const data = state([{ title: 'Task', dueDate: '2026-11-01', steps: [{ title: 'Call', dueDate: '2026-10-14' }] }]);
  assert.equal(M.stepsFor(data, { view: 'today' }, day).length, 1);
});
test('steps without dates inherit the parent date for visibility, explicitly marked', () => {
  const data = state([{ title: 'Parent', dueDate: day, steps: ['First action'] }]);
  assert.equal(M.stepsFor(data, { view: 'today' }, day)[0].inherited, true);
});
test('steps sort globally by date then time and link back to the right parent', () => {
  const data = state([
    { id: 'late', title: 'Later task', steps: [{ title: 'Evening', dueDate: day, dueTime: '18:00' }] },
    { id: 'early', title: 'Earlier task', steps: [{ title: 'Morning', dueDate: day, dueTime: '08:00' }] }
  ]);
  const rows = M.stepsFor(data, { view: 'today' }, day);
  assert.deepEqual(rows.map(row => row.task.id), ['early', 'late']);
});
test('Today completion filtering never leaks steps from completed parents', () => {
  const data = state([{ title: 'Done parent', done: true, dueDate: day, steps: ['Open step'] }]);
  assert.equal(M.stepsFor(data, { view: 'today' }, day).length, 0);
  assert.equal(M.stepsFor(data, { view: 'today', completed: true }, day).length, 1);
});
test('Upcoming and Unscheduled have distinct meanings', () => {
  const data = state([{ title: 'Later', dueDate: '2026-10-16' }, { title: 'Someday' }, { title: 'Now', dueDate: day }]);
  assert.deepEqual(M.tasksFor(data, { view: 'upcoming' }, day).map(t => t.title), ['Later']);
  assert.deepEqual(M.tasksFor(data, { view: 'unscheduled' }, day).map(t => t.title), ['Someday']);
});
test('search finds child steps and list names', () => {
  const data = state([{ title: 'Trip', list: 'Travel', steps: ['Book a train'] }]);
  assert.equal(M.tasksFor(data, { view: 'all', query: 'TRAIN' }, day).length, 1);
  assert.equal(M.tasksFor(data, { view: 'all', query: 'travel' }, day).length, 1);
});
test('help me choose finds future work when Today has nothing', () => {
  const data = state([{ title: 'Plan garden', dueDate: '2026-10-20' }]);
  assert.equal(M.choose(data, day).planning, true);
  assert.equal(M.choose(data, day).task.title, 'Plan garden');
});
test('help me choose prefers actionable tasks and can choose another', () => {
  const data = state([{ id: 'a', title: 'A', dueDate: day, energy: 'small' }, { id: 'b', title: 'B', dueDate: day }]);
  assert.equal(M.choose(data, day).task.id, 'a');
  assert.equal(M.choose(data, day, 'a').task.id, 'b');
});
test('completing a recurring task creates one next occurrence and reopening removes it', () => {
  const data = state([{ id: 'repeat', title: 'Water plants', dueDate: day, reminderDate: day, repeat: 'daily', steps: [{ title: 'Kitchen', dueDate: day, done: true }] }]);
  const task = data.tasks[0];
  M.toggleTask(data, task, day);
  assert.equal(data.tasks.length, 2);
  const next = data.tasks.find(t => t.id !== task.id);
  assert.equal(next.dueDate, '2026-10-16');
  assert.equal(next.steps[0].dueDate, '2026-10-16');
  assert.equal(next.steps[0].done, false);
  assert.notEqual(next.steps[0].id, task.steps[0].id);
  M.toggleTask(data, task, day);
  assert.equal(data.tasks.length, 1);
  M.toggleTask(data, task, day);
  assert.equal(data.tasks.length, 2);
});
test('after-completion recurrence uses completion day even when the task has a later due date', () => {
  assert.equal(M.nextRepeatDate({ repeat: 'after1day', dueDate: '2026-11-30' }, day), '2026-10-16');
});
test('weekday recurrence skips a weekend', () => {
  assert.equal(M.nextRepeatDate({ repeat: 'weekdays', dueDate: '2026-10-16' }, '2026-10-16'), '2026-10-19');
});
test('recurrence preserves a reminder scheduled before the parent due date', () => {
  const data = state([{ title: 'Weekly', dueDate: day, reminderDate: '2026-10-14', repeat: 'weekly' }]);
  M.toggleTask(data, data.tasks[0], day);
  assert.equal(data.tasks[0].reminderDate, '2026-10-21');
});
test('reminders honor opt-out, step times, completion and notification flags', () => {
  const data = state([
    { title: 'Off', remindersEnabled: false, reminderDate: day },
    { title: 'Done', done: true, reminderDate: day },
    { title: 'On', remindersEnabled: true, steps: [{ title: 'Morning', dueDate: day, dueTime: '08:00' }, { title: 'Evening', dueDate: day, dueTime: '18:00' }] }
  ]);
  const rows = M.reminders(data, new Date(day + 'T10:00:00').getTime());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].step.title, 'Morning');
  rows[0].step.reminderNotifiedAt = 'already sent';
  assert.equal(M.reminders(data, new Date(day + 'T10:00:00').getTime()).length, 0);
});
test('reminder default time is 09:00 local and snooze postpones it', () => {
  const data = state([{ title: 'On', reminderDate: day }]);
  assert.equal(M.reminders(data, new Date(day + 'T08:59:00').getTime()).length, 0);
  assert.equal(M.reminders(data, new Date(day + 'T09:00:00').getTime()).length, 1);
  data.tasks[0].snoozedUntil = new Date(day + 'T10:00:00').toISOString();
  assert.equal(M.reminders(data, new Date(day + 'T09:30:00').getTime()).length, 0);
});
test('calendar helpers reject impossible dates and keep local dates over DST', () => {
  assert.equal(M.validDate('2026-02-30'), '');
  assert.equal(M.validTime('25:00'), '');
  assert.equal(M.addDays('2026-03-08', 1), '2026-03-09');
  assert.equal(M.addDays('2026-12-31', 1), '2027-01-01');
});
test('normalization repairs duplicate imported task and step IDs', () => {
  const data = state([{ id: 'same', title: 'A', steps: [{ id: 'same', title: 'One' }, { id: 'same', title: 'Two' }] }, { id: 'same', title: 'B' }]);
  assert.equal(new Set(data.tasks.map(t => t.id)).size, 2);
  assert.equal(new Set(data.tasks[0].steps.map(s => s.id)).size, 2);
});
test('reopening and recompleting a recurring parent does not duplicate an already completed successor', () => {
  const data = state([{ id: 'series', title: 'Daily', dueDate: day, repeat: 'daily' }]);
  const task = data.tasks[0];
  M.toggleTask(data, task, day);
  const next = data.tasks[0];
  next.done = true;
  M.toggleTask(data, task, day);
  M.toggleTask(data, task, day);
  assert.equal(data.tasks.length, 2);
  assert.equal(task.nextOccurrenceId, next.id);
});
test('a parent with all steps done remains reviewable in the Steps view until completed', () => {
  const data = state([{ title: 'Nearly there', dueDate: day, steps: [{ title: 'Done', done: true }] }]);
  const rows = M.stepsFor(data, { view: 'today' }, day);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].step, null);
  assert.equal(rows[0].task.title, 'Nearly there');
});
