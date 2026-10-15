/* Shared task rules. Works directly in a browser and in Node without a build. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SlashTasksModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const id = () => globalThis.crypto?.randomUUID?.() || 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  function today(date = new Date()) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
    const d = new Date(value + 'T12:00:00');
    return !Number.isNaN(d.getTime()) && today(d) === value ? value : '';
  }
  const validTime = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : '';
  function addDays(value, days) {
    if (!validDate(value)) return '';
    const d = new Date(value + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return today(d);
  }
  function step(value) {
    const s = typeof value === 'string' ? { title: value } : value || {};
    return { id: String(s.id || id()), title: String(s.title || '').slice(0, 120), dueDate: validDate(s.dueDate),
      dueTime: validTime(s.dueTime), done: !!s.done, reminderNotifiedAt: s.reminderNotifiedAt || null };
  }
  function normalize(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const tasks = (Array.isArray(source.tasks) ? source.tasks : []).filter(t => t && typeof t.title === 'string').map((t, i) => {
      let reminderDate = validDate(t.reminderDate), reminderTime = validTime(t.reminderTime);
      if (!reminderDate && t.reminderAt) {
        const d = new Date(t.reminderAt);
        if (!Number.isNaN(d.getTime())) {
          reminderDate = today(d);
          reminderTime = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        }
      }
      return { ...t, id: String(t.id || id()), title: t.title.slice(0, 120), list: String(t.list || 'Personal'),
        dueDate: validDate(t.dueDate) || (t.when === 'today' ? today() : ''), reminderDate, reminderTime,
        remindersEnabled: t.remindersEnabled === undefined ? !!reminderDate : !!t.remindersEnabled,
        repeat: ['daily', 'weekdays', 'weekly', 'after1day'].includes(t.repeat) ? t.repeat : 'none',
        energy: ['small', 'medium', 'big'].includes(t.energy) ? t.energy : 'medium',
        steps: (Array.isArray(t.steps) ? t.steps : []).map(step), done: !!t.done,
        priority: Number.isFinite(t.priority) ? t.priority : i };
    });
    const lists = [...new Set(['Personal', 'Work', 'Home', ...(Array.isArray(source.lists) ? source.lists : []),
      ...tasks.map(t => t.list)].filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()))];
    const ids = new Set();
    for (const task of tasks) {
      if (ids.has(task.id)) task.id = id();
      ids.add(task.id);
      const stepIds = new Set();
      for (const s of task.steps) {
        if (stepIds.has(s.id)) s.id = id();
        stepIds.add(s.id);
      }
    }
    return { version: 2, tasks, lists };
  }
  const effectiveDate = (task, s) => s?.dueDate || task.dueDate || '';
  function dateMatches(date, view, now = today()) {
    if (view === 'today') return !!date && date <= now;
    if (view === 'upcoming') return !!date && date > now;
    if (view === 'unscheduled') return !date;
    return true;
  }
  function taskMatches(task, view, now = today()) {
    if (!['today', 'upcoming', 'unscheduled', 'all'].includes(view)) return task.list === view;
    if (view === 'all') return true;
    return dateMatches(task.dueDate, view, now) || task.steps.some(s => !s.done && dateMatches(effectiveDate(task, s), view, now));
  }
  function matchesSearch(task, query) {
    const text = query.trim().toLocaleLowerCase();
    return !text || [task.title, task.list, ...task.steps.map(s => s.title)].some(v => v.toLocaleLowerCase().includes(text));
  }
  function tasksFor(state, { view = 'today', query = '', completed = false, sort = 'due' } = {}, now = today()) {
    return state.tasks.filter(t => (completed || !t.done) && taskMatches(t, view, now) && matchesSearch(t, query))
      .sort((a, b) => Number(a.done) - Number(b.done) || (sort === 'energy'
        ? ['small', 'medium', 'big'].indexOf(a.energy) - ['small', 'medium', 'big'].indexOf(b.energy)
        : (a.dueDate || '9999').localeCompare(b.dueDate || '9999')) || a.priority - b.priority);
  }
  function stepsFor(state, options = {}, now = today()) {
    const view = options.view || 'today', query = (options.query || '').trim().toLocaleLowerCase();
    const rows = [];
    for (const task of state.tasks) {
      if (task.done && !options.completed) continue;
      if (!['today', 'upcoming', 'unscheduled', 'all'].includes(view) && task.list !== view) continue;
      for (const s of task.steps) {
        if ((s.done && !options.completed) || !dateMatches(effectiveDate(task, s), view, now)) continue;
        if (query && ![task.title, task.list, s.title].some(v => v.toLocaleLowerCase().includes(query))) continue;
        rows.push({ task, step: s, date: effectiveDate(task, s), inherited: !s.dueDate && !!task.dueDate });
      }
      if ((!task.steps.length || (!options.completed && !task.done && task.steps.every(s => s.done))) && taskMatches(task, view, now) && matchesSearch(task, options.query || '')) {
        rows.push({ task, step: null, date: task.dueDate, inherited: false });
      }
    }
    return rows.sort((a, b) => Number(a.task.done || a.step?.done) - Number(b.task.done || b.step?.done) ||
      (a.date || '9999').localeCompare(b.date || '9999') ||
      (a.step?.dueTime || '23:59').localeCompare(b.step?.dueTime || '23:59') || a.task.priority - b.task.priority);
  }
  function choose(state, now = today(), excludeId = '') {
    const open = state.tasks.filter(t => !t.done);
    const candidates = open.filter(t => t.id !== excludeId);
    const pool = candidates.length ? candidates : open;
    const ranked = pool.slice().sort((a, b) => {
      const score = t => taskMatches(t, 'today', now) ? 0 : 1;
      return score(a) - score(b) || ['small', 'medium', 'big'].indexOf(a.energy) - ['small', 'medium', 'big'].indexOf(b.energy)
        || (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.priority - b.priority;
    });
    const task = ranked[0];
    if (!task) return null;
    const next = task.steps.filter(s => !s.done).sort((a, b) => (effectiveDate(task, a) || '9999').localeCompare(effectiveDate(task, b) || '9999'))[0];
    return { task, step: next || null, planning: !taskMatches(task, 'today', now) };
  }
  function nextRepeatDate(task, now = today()) {
    const base = task.repeat === 'after1day' ? now : (task.dueDate && task.dueDate > now ? task.dueDate : now);
    let next = addDays(base, task.repeat === 'weekly' ? 7 : 1);
    if (task.repeat === 'weekdays') {
      while ([0, 6].includes(new Date(next + 'T12:00:00').getDay())) next = addDays(next, 1);
    }
    return next;
  }
  function toggleTask(state, task, now = today()) {
    task.done = !task.done;
    if (task.done) {
      task.completedAt = new Date().toISOString();
      if (task.repeat !== 'none' && !state.tasks.some(t => t.id === task.nextOccurrenceId)) {
        const nextDate = nextRepeatDate(task, now), base = task.dueDate || now;
        const shift = Math.round((new Date(nextDate + 'T12:00:00') - new Date(base + 'T12:00:00')) / 86400000);
        const reminderOffset = task.reminderDate ? Math.round((new Date(task.reminderDate + 'T12:00:00') - new Date(base + 'T12:00:00')) / 86400000) : 0;
        const next = { ...task, id: id(), done: false, completedAt: null, nextOccurrenceId: null, seriesId: task.seriesId || task.id,
          dueDate: nextDate, reminderDate: task.reminderDate ? addDays(nextDate, reminderOffset) : '',
          reminderNotifiedAt: null, snoozedUntil: null, priority: Date.now(),
          steps: task.steps.map(s => ({ ...s, id: id(), done: false, dueDate: s.dueDate ? addDays(s.dueDate, shift) : '', reminderNotifiedAt: null })) };
        state.tasks.unshift(next);
        task.nextOccurrenceId = next.id;
      }
    } else {
      const next = state.tasks.find(t => t.id === task.nextOccurrenceId);
      if (!next || !next.done) {
        state.tasks = state.tasks.filter(t => t.id !== task.nextOccurrenceId);
        task.nextOccurrenceId = null;
      }
      task.completedAt = null;
    }
  }
  function reminders(state, at = Date.now()) {
    const due = [];
    const instant = (date, time) => date ? new Date(date + 'T' + (time || '09:00') + ':00').getTime() : Infinity;
    for (const task of state.tasks) {
      if (task.done || !task.remindersEnabled) continue;
      const snooze = task.snoozedUntil ? new Date(task.snoozedUntil).getTime() : null;
      if (!task.reminderNotifiedAt && (snooze || instant(task.reminderDate, task.reminderTime)) <= at) due.push({ task, step: null });
      for (const s of task.steps) {
        if (!s.done && !s.reminderNotifiedAt && s.dueDate && instant(s.dueDate, s.dueTime || task.reminderTime) <= at) due.push({ task, step: s });
      }
    }
    return due;
  }
  return { id, today, validDate, validTime, addDays, step, normalize, effectiveDate, dateMatches, taskMatches,
    matchesSearch, tasksFor, stepsFor, choose, nextRepeatDate, toggleTask, reminders };
});
