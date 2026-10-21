/* SlashTasks UI. Task rules live in task-model.js; account persistence lives in cloud-sync.js. */
(() => {
  'use strict';
  const M = window.SlashTasksModel;
  const C = window.SlashTasksCloud, S = window.SlashTasksSync;
  const $ = selector => document.querySelector(selector);
  const PREFS_KEY = 'slashtasks-preferences';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clone = value => JSON.parse(JSON.stringify(value));
  const listIcon = list => ({ Personal: '🌿', Work: '💼', Home: '🏠' })[list] || '📁';
  const energyText = energy => ({ small: '🌱 Small', medium: '🌿 Medium', big: '🔥 Big' })[energy] || '🌿 Medium';
  const repeats = { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', after1day: 'After completion' };
  let storageLocked = true, identityEpoch = 0, saving = false, profile = {};
  let state = M.normalize({});
  let prefs = { mode: 'tasks', layout: 'list', sort: 'due', completed: false };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { /* Preferences can reset safely. */ }
  if (!['tasks', 'steps'].includes(prefs.mode)) prefs.mode = 'tasks';
  if (!['list', 'table'].includes(prefs.layout)) prefs.layout = 'list';
  let activeView = 'today', query = '', focused = false, chosenId = null, undoState = null, toastTimer;
  let editingTaskId = null, editorOriginal = '', editorBaseline = null, editorObserved = {}, reminderManual = false, modalReturnFocus = null;
  let suggestionController = null, suggestionEpoch = 0, suggestions = [], cooldownUntil = 0;
  let completionTaskId = null, apiStatus = { available: true, configured: false };

  async function persist(previous, expected) {
    if (storageLocked || !C.engine) { toast('Sign in before saving changes.'); return false; }
    try {
      await C.commit(previous, clone(state), expected);
      $('#storageNotice').hidden = true;
      return true;
    } catch (error) {
      $('#storageNotice').hidden = false;
      $('#storageNotice').textContent = error.message || 'This device could not save the offline queue. Export a backup before leaving.';
      return false;
    }
  }
  async function change(action, message, allowUndo = true, expected) {
    if(saving || storageLocked || !C.engine) { toast('Please wait for your account to finish loading.'); return false; }
    const epoch = identityEpoch, previous = clone(state);
    saving = true;
    try {
      action();
      const after = clone(state);
      if (!await persist(previous, expected)) { if(epoch===identityEpoch)state=previous; render(); toast('Could not save that change on this device.'); return false; }
      if(epoch!==identityEpoch)return false;
      undoState = allowUndo ? {before:previous,after} : null;
      render();
      if (message) toast(message, allowUndo);
      return true;
    } finally { if(epoch===identityEpoch)saving = false; }
  }
  function toast(message, undo = false) {
    clearTimeout(toastTimer);
    $('#toastMessage').textContent = message;
    $('#undoButton').hidden = !undo;
    $('#toast').hidden = false;
    toastTimer = setTimeout(() => { $('#toast').hidden = true; }, undo ? 10000 : 6500);
  }
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* Tasks have their own error handling. */ } }
  function hash(value) { let n = 0; for (const c of value) n = (n * 31 + c.charCodeAt(0)) | 0; return n >>> 0; }
  const color = task => ['#648e72', '#8d88ad', '#b28c56', '#668eaa', '#b88283', '#719d97'][hash(task.id) % 6];
  const expansionId = task => 'steps-' + hash(task.id);
  const expanded = new Set();
  const taskById = id => state.tasks.find(task => task.id === id);
  function dateText(date) {
    if (!date) return 'No date';
    if (date === M.today()) return 'Today';
    if (date === M.addDays(M.today(), 1)) return 'Tomorrow';
    if (date < M.today()) return 'Overdue · ' + new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(date + 'T12:00:00'));
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(date + 'T12:00:00'));
  }
  function due(date, time = '', inherited = false) {
    const cls = date && date < M.today() ? 'overdue' : date === M.today() ? 'today' : date === M.addDays(M.today(), 1) ? 'soon' : '';
    const icon = cls === 'today' ? '⏰ ' : cls === 'soon' ? '↗ ' : '';
    return '<span class="due-badge ' + cls + '"' + (inherited ? ' title="Uses the parent task’s due date"' : '') + '>' +
      (inherited ? 'Task: ' : icon) + esc(dateText(date)) + (time ? ' · ' + esc(time) : '') + '</span>';
  }
  function parentLink(task) {
    return '<button class="parent-link" data-edit-task="' + esc(task.id) + '"><i class="task-dot" aria-hidden="true"></i>' + esc(task.title) + ' ↗</button>';
  }
  function checkTask(task) {
    return '<button class="check-button" data-complete-task="' + esc(task.id) + '" aria-label="' +
      (task.done ? 'Reopen ' : 'Complete ') + esc(task.title) + '" aria-pressed="' + task.done + '">' + (task.done ? '✓' : '') + '</button>';
  }
  function checkStep(task, s) {
    return '<input type="checkbox" data-task="' + esc(task.id) + '" data-step="' + esc(s.id) + '" aria-label="' +
      (s.done ? 'Reopen ' : 'Complete ') + esc(s.title) + '"' + (s.done ? ' checked' : '') + '>';
  }
  function stepsToggle(task) {
    const done = task.steps.filter(s => s.done).length;
    return '<button class="steps-toggle" data-toggle-steps="' + esc(task.id) + '" aria-controls="' + expansionId(task) +
      '" aria-expanded="' + expanded.has(task.id) + '">' + done + '/' + task.steps.length + ' steps ' + (expanded.has(task.id) ? '⌃' : '⌄') + '</button>';
  }
  function stepLine(task, s) {
    return '<div class="step-line ' + (s.done ? 'step-done' : '') + '">' + checkStep(task, s) + '<span class="step-name">' +
      esc(s.title) + '</span><button class="step-date-button" data-edit-task="' + esc(task.id) + '" data-focus-step="' + esc(s.id) +
      '" aria-label="Schedule ' + esc(s.title) + '">' + due(s.dueDate, s.dueTime) + '</button></div>';
  }
  function taskMenu(task) {
    return '<details class="task-actions"><summary aria-label="Actions for ' + esc(task.title) + '">⋯</summary><div class="action-menu">' +
      '<button data-edit-task="' + esc(task.id) + '">Edit task</button><button data-tomorrow="' + esc(task.id) + '">Move to tomorrow</button>' +
      (task.remindersEnabled ? '<button data-snooze="' + esc(task.id) + '">Snooze 10 minutes</button>' : '') +
      '<button class="danger" data-delete="' + esc(task.id) + '">Delete task</button></div></details>';
  }
  function taskCards(tasks) {
    return tasks.map(task => {
      const stepsToday = task.steps.filter(s => !s.done && s.dueDate && s.dueDate <= M.today()).length;
      return '<article class="task-card ' + (task.done ? 'done' : '') + '" style="--task-accent:' + color(task) + '">' +
        '<div class="task-main-row">' + checkTask(task) + '<div class="task-copy"><button class="task-title" data-edit-task="' + esc(task.id) + '">' +
        esc(task.title) + '</button><div class="task-meta"><span class="list-tag">' + listIcon(task.list) + ' ' + esc(task.list) +
        '</span><span class="energy-tag ' + task.energy + '">' + energyText(task.energy) + '</span>' +
        (task.repeat !== 'none' ? '<span>↻ ' + repeats[task.repeat] + '</span>' : '') +
        (task.remindersEnabled ? '<span title="Reminders enabled">⏰ Reminders</span>' : '') +
        (stepsToday && task.dueDate > M.today() ? '<span>' + stepsToday + ' step' + (stepsToday === 1 ? '' : 's') + ' due today</span>' : '') +
        '</div></div>' + due(task.dueDate) + taskMenu(task) + '</div>' + (task.steps.length ? stepsToggle(task) +
        '<div class="task-steps" id="' + expansionId(task) + '"' + (expanded.has(task.id) ? '' : ' hidden') + '>' +
        task.steps.map(s => stepLine(task, s)).join('') + '</div>' : '') + '</article>';
    }).join('');
  }
  function taskTable(tasks) {
    return '<div class="table-wrap"><table class="tasks-table"><caption class="sr-only">Your tasks</caption><thead><tr><th scope="col">Task</th><th scope="col">List</th><th scope="col">Energy</th><th scope="col">Due</th><th scope="col">Steps</th></tr></thead>' +
      tasks.map(task => '<tbody><tr class="' + (task.done ? 'done' : '') + '"><td><div class="table-title">' +
        checkTask(task) + '<button class="task-title" data-edit-task="' + esc(task.id) + '">' + esc(task.title) + '</button>' + taskMenu(task) +
        '</div></td><td>' + listIcon(task.list) + ' ' + esc(task.list) + '</td><td><span class="energy-tag ' + task.energy + '">' +
        energyText(task.energy) + '</span></td><td>' + due(task.dueDate) + '</td><td>' + stepsToggle(task) +
        '</td></tr></tbody><tbody id="' + expansionId(task) + '" style="--task-accent:' + color(task) + '"' +
        (expanded.has(task.id) ? '' : ' hidden') + '>' +
        (task.steps.length ? task.steps.map(s => '<tr class="child-row"><td><div class="step-line ' + (s.done ? 'step-done' : '') +
          '">' + checkStep(task, s) + '<span class="step-name">' + esc(s.title) + '</span></div></td><td class="child-parent">' +
          listIcon(task.list) + ' ' + esc(task.list) + '</td><td class="child-parent">↳ Step</td><td><button class="step-date-button" data-edit-task="' +
          esc(task.id) + '" data-focus-step="' + esc(s.id) + '">' + due(s.dueDate, s.dueTime) +
          '</button></td><td></td></tr>').join('') : '<tr class="child-row"><td colspan="5"><button class="text-button" data-breakdown="' +
          esc(task.id) + '">＋ Add the first step</button></td></tr>') + '</tbody>').join('') + '</table></div>';
  }
  function stepRows(rows) {
    const table = prefs.layout === 'table';
    const content = rows.map(({ task, step: s, date, inherited }) => {
      const stepName = s ? checkStep(task, s) + '<span class="step-name">' + esc(s.title) + '</span>' :
        task.steps.length ? '<button class="text-button" data-complete-task="' + esc(task.id) + '">All steps done · Complete task ✓</button><button class="text-button" data-breakdown="' + esc(task.id) + '">＋ Add more</button>' :
        '<button class="text-button" data-breakdown="' + esc(task.id) + '">＋ Break into smaller steps</button>';
      const when = '<button class="step-date-button" data-edit-task="' + esc(task.id) + '"' + (s ? ' data-focus-step="' + esc(s.id) + '"' : '') + '>' +
        due(date, s?.dueTime, inherited) + '</button>';
      if (table) return '<tr class="' + (s?.done ? 'step-done' : '') + '" style="--task-accent:' + color(task) + '"><td><div class="step-line">' +
        stepName + '</div></td><td>' + when + '</td><td>' + parentLink(task) + '</td></tr>';
      return '<article class="task-card step-card ' + (s?.done ? 'step-done' : '') + '" style="--task-accent:' + color(task) +
        '"><div class="step-line">' + stepName + when + '</div>' + parentLink(task) + '</article>';
    }).join('');
    return table ? '<div class="table-wrap"><table class="tasks-table"><caption class="sr-only">Steps and their parent tasks</caption><thead><tr><th scope="col">Next step</th><th scope="col">When</th><th scope="col">For task</th></tr></thead><tbody>' + content + '</tbody></table></div>' : content;
  }
  function currentOptions() { return { view: activeView, query, completed: prefs.completed, sort: prefs.sort }; }
  function renderFocus() {
    $('#focusCallout').hidden = activeView !== 'today' && !focused;
    const task = chosenId && taskById(chosenId);
    if (task && !task.done) {
      const selection = M.choose({ tasks: [task] });
      $('#calloutResult').hidden = false;
      $('#focusTitle').textContent = selection.planning ? 'Make tomorrow a little easier' : 'Here’s one small place to start';
      $('#focusHint').textContent = selection.planning ? 'Give this task a small next step and a date.' : 'You only need to do the next step.';
      $('#calloutResult').innerHTML = '<span class="result-context">' + (selection.step ? 'NEXT STEP' : 'YOUR TASK') + '</span><button class="task-title" data-edit-task="' +
        esc(task.id) + '" data-breakdown-focus="true">' + esc(selection.step?.title || task.title) + ' ↗</button>' +
        (selection.step ? '<span class="result-context">For ' + esc(task.title) + '</span>' : '<span class="result-context">Open to add a small step and choose a date.</span>');
      $('#calloutPick').textContent = 'Choose another ↻';
    } else {
      chosenId = null;
      $('#calloutResult').hidden = true;
      const open = state.tasks.some(t => !t.done);
      $('#focusTitle').textContent = open ? 'Start with one thing' : 'A little breathing room';
      $('#focusHint').textContent = open ? 'Let’s find a small next step, even if nothing is due today.' : 'Nothing left to choose. Add something whenever it comes to mind.';
      $('#calloutPick').textContent = 'Help me choose →';
      $('#calloutPick').disabled = !open;
    }
  }
  function render() {
    const names = { today: 'Today', upcoming: 'Upcoming', unscheduled: 'Unscheduled', all: 'All tasks' };
    const name = names[activeView] || activeView;
    $('#dateLine').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase();
    $('#viewCrumb').textContent = name;
    $('#pageTitle').textContent = name;
    $('#pageSubtitle').textContent = ({ today: 'One small step is a good place to start.', upcoming: 'Make a little room for what’s coming.', unscheduled: 'Captured for later. Add a date when you’re ready.', all: 'Everything you’ve captured, in one place.' })[activeView] || 'A little structure for the things that matter.';
    const todayTasks = state.tasks.filter(t => M.taskMatches(t, 'today'));
    const openToday = todayTasks.filter(t => !t.done).length;
    const todaySteps = M.stepsFor(state, { view: 'today' }).filter(r => r.step).length;
    $('#todayCount').textContent = openToday || '';
    $('#dayCard').hidden = activeView !== 'today';
    const doneToday = todayTasks.filter(t => t.done).length, total = todayTasks.length;
    $('#dayCard').innerHTML = '<span><strong>' + openToday + '</strong> tasks in reach</span><span><strong>' + todaySteps + '</strong> steps to take</span><span><strong>' +
      doneToday + '</strong> tasks done</span><span class="summary-progress" role="img" aria-label="' + doneToday + ' of ' + total + ' tasks complete"><span style="width:' +
      (total ? Math.round(doneToday / total * 100) : 0) + '%"></span></span>';
    renderFocus();
    $('#upcomingPlanner').hidden = activeView !== 'upcoming';
    if (activeView === 'upcoming') {
      const unplanned = M.tasksFor(state, { view: 'upcoming' }).filter(t => !t.steps.length || t.steps.some(s => !s.done && !s.dueDate)).slice(0, 2);
      $('#upcomingPlanner').innerHTML = '<h2>Give your future self a head start</h2><p class="muted">' +
        (unplanned.length ? 'A small step with a date can make these easier to begin.' : 'Your upcoming steps have dates. Switch to Steps to see them in order.') +
        '</p><div class="planner-actions">' + unplanned.map(t => '<button class="secondary compact" data-breakdown="' + esc(t.id) + '">🧩 ' + esc(t.title) + '</button>').join('') + '</div>';
    }
    const rows = prefs.mode === 'steps' ? M.stepsFor(state, currentOptions()) : M.tasksFor(state, currentOptions());
    $('#taskHeading').textContent = prefs.mode === 'steps' ? 'Your next steps' : 'Your tasks';
    $('#resultCount').textContent = rows.length + (prefs.mode === 'steps' ? ' steps & tasks' : ' tasks');
    $('#taskList').innerHTML = prefs.mode === 'steps' ? stepRows(rows) : prefs.layout === 'table' ? taskTable(rows) : taskCards(rows);
    $('#taskList').hidden = !rows.length;
    $('#emptyState').hidden = !!rows.length;
    $('#addTaskRow').hidden = !rows.length;
    $('#emptyTitle').textContent = query ? 'No matches yet' : activeView === 'today' ? 'A little breathing room' : 'A clear space';
    $('#emptyMessage').textContent = query ? 'Try a different word, or clear your search.' : activeView === 'today'
      ? 'Nothing due here. Use “Help me choose” to plan a small step from your other tasks.'
      : activeView === 'upcoming' ? 'No future dates yet. Add a task or schedule something from Unscheduled.' : 'Add a task whenever something comes to mind.';
    document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('active', b.dataset.view === activeView); b.setAttribute('aria-current', b.dataset.view === activeView ? 'page' : 'false'); });
    document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === prefs.mode));
    document.querySelectorAll('[data-layout]').forEach(b => b.setAttribute('aria-pressed', b.dataset.layout === prefs.layout));
    $('#sortSelect').value = prefs.sort;
    $('#sortSelect').disabled = prefs.mode === 'steps';
    $('#sortSelect').title = prefs.mode === 'steps' ? 'Steps are always ordered by date and time.' : 'Sort tasks';
    $('#showCompleted').checked = prefs.completed;
    $('#listNav').innerHTML = state.lists.map(list => '<button class="list-item ' + (list === activeView ? 'active' : '') + '" data-list="' +
      esc(list) + '"><span>' + listIcon(list) + '</span><span class="list-name">' + esc(list) + '</span><span class="count">' +
      (state.tasks.filter(t => t.list === list && !t.done).length || '') + '</span></button>').join('') + '<button class="text-button mobile-add-list" data-new-list="true" aria-label="Add a list">＋</button>';
  }

  function addStepEditorRow(value = {}) {
    const s = M.step(value), row = document.createElement('div');
    row.className = 'step-editor-row';
    row.dataset.id = s.id;
    row.dataset.done = String(s.done);
    row.innerHTML = '<label class="step-title-label"><span>Step</span><input class="step-title-input" maxlength="120" placeholder="One small, concrete action" value="' +
      esc(s.title) + '"></label><label class="step-date-field"><span>📅 Date</span><input class="step-date-input" type="date" value="' +
      esc(s.dueDate) + '"></label><label class="step-time-field"><span>⏰ Time</span><input class="step-time-input" type="time" value="' +
      esc(s.dueTime) + '"></label><button type="button" class="icon-button remove-step" aria-label="Remove step">×</button>';
    $('#stepEditor').append(row);
    return row;
  }
  function abortSuggestions() {
    suggestionEpoch++;
    suggestionController?.abort();
    suggestionController = null;
    $('#suggestStepsButton').textContent = '✦ Suggest steps';
    $('#suggestStepsButton').disabled = false;
  }
  function editorData() {
    return { title: $('#taskTitle').value.trim(), list: $('#taskListSelect').value, energy: $('#taskEnergy').value,
      dueDate: $('#taskDueDate').value, reminderDate: $('#taskReminderDate').value, reminderTime: $('#taskReminderTime').value,
      remindersEnabled: $('#taskReminderEnabled').checked, repeat: $('#taskRepeat').value,
      steps: [...$('#stepEditor').children].map(row => ({ id: row.dataset.id, title: row.querySelector('.step-title-input').value.trim(),
        dueDate: row.querySelector('.step-date-input').value, dueTime: row.querySelector('.step-time-input').value, done: row.dataset.done === 'true' })) };
  }
  function openModal(task = null, { addStep = false, breakdown = false, focusStep = '' } = {}) {
    abortSuggestions();
    editingTaskId = task?.id || null;
    modalReturnFocus = document.activeElement;
    suggestions = [];
    $('#taskForm').reset();
    $('#stepEditor').replaceChildren();
    $('#suggestionStatus').textContent = '';
    $('#suggestionStatus').classList.remove('error');
    $('#suggestionReview').hidden = true;
    $('#taskListSelect').innerHTML = state.lists.map(list => '<option value="' + esc(list) + '">' + listIcon(list) + ' ' + esc(list) + '</option>').join('');
    $('#taskTitle').value = task?.title || '';
    $('#taskListSelect').value = task?.list || (state.lists.includes(activeView) ? activeView : 'Personal');
    $('#taskEnergy').value = task?.energy || 'small';
    $('#taskDueDate').value = task ? task.dueDate : activeView === 'upcoming' ? M.addDays(M.today(), 1) : activeView === 'unscheduled' ? '' : M.today();
    $('#taskReminderDate').value = task?.reminderDate || $('#taskDueDate').value;
    $('#taskReminderTime').value = task?.reminderTime || '';
    $('#taskReminderEnabled').checked = !!task?.remindersEnabled;
    $('#taskRepeat').value = task?.repeat || 'none';
    reminderManual = !!task?.reminderDate && task.reminderDate !== task.dueDate;
    $('#modalKicker').textContent = task ? 'MAKE A LITTLE ROOM' : 'GET IT OUT OF YOUR HEAD';
    $('#modalTitle').textContent = task ? (breakdown ? 'Find the next small step' : 'Edit task') : 'Add a task';
    $('#saveTaskButton').textContent = task ? 'Save changes →' : 'Add task →';
    $('#deleteTaskButton').hidden = !task;
    $('#taskDetails').open = !!task?.remindersEnabled || (task?.repeat && task.repeat !== 'none');
    (task?.steps || []).forEach(addStepEditorRow);
    let newRow;
    if (addStep || (!task && !breakdown)) newRow = addStepEditorRow();
    updateReminderFields();
    editorBaseline = clone(editorData());
    editorObserved = C.observed;
    editorOriginal = JSON.stringify(editorBaseline);
    $('#taskModal').showModal();
    const targetRow = focusStep ? [...$('#stepEditor').children].find(r => r.dataset.id === focusStep) : newRow;
    if (targetRow && (breakdown || focusStep)) (targetRow.querySelector(focusStep ? '.step-date-input' : '.step-title-input')).focus();
    else if (breakdown && !task?.steps.length) $('#addStepButton').focus();
    else $('#taskTitle').focus();
  }
  function closeEditor(force = false) {
    if (!force && JSON.stringify(editorData()) !== editorOriginal && !confirm('Discard your unsaved changes?')) return;
    abortSuggestions();
    $('#taskModal').close();
    editingTaskId = null;
    modalReturnFocus?.isConnected && modalReturnFocus.focus();
  }
  function updateReminderFields() {
    $('#reminderFields').hidden = !$('#taskReminderEnabled').checked;
    const summary = [];
    if ($('#taskReminderEnabled').checked) summary.push('On');
    if ($('#taskRepeat').value !== 'none') summary.push(repeats[$('#taskRepeat').value]);
    $('#detailsSummary').textContent = summary.join(' · ');
  }
  async function saveTask(event) {
    event.preventDefault();
    const form = editorData();
    if (!form.title) { $('#taskTitle').setCustomValidity('Give this task a name.'); $('#taskTitle').reportValidity(); return; }
    if (!$('#suggestionReview').hidden) {
      $('#suggestionStatus').textContent = 'Add the selected suggestions, or dismiss them, before saving.';
      $('#acceptSuggestions').focus();
      return;
    }
    const task = editingTaskId && taskById(editingTaskId);
    if(editingTaskId && !task){toast('This task was deleted on another device. Your draft is still open.');return;}
    const savedId = task?.id || M.id();
    const data = { ...form, steps: form.steps.filter(s => s.title).map(s => {
      const old = task?.steps.find(v => v.id === s.id);
      return { ...s, reminderNotifiedAt: old && old.dueDate === s.dueDate && old.dueTime === s.dueTime ? old.reminderNotifiedAt : null };
    }), reminderDate: form.remindersEnabled ? form.reminderDate : '', reminderTime: form.remindersEnabled ? form.reminderTime : '' };
    if(task && editorBaseline){
      const baseline={...editorBaseline,reminderDate:editorBaseline.remindersEnabled?editorBaseline.reminderDate:'',reminderTime:editorBaseline.remindersEnabled?editorBaseline.reminderTime:''};
      for(const field of ['title','list','energy','dueDate','reminderDate','reminderTime','remindersEnabled','repeat']){
        if(S.equal(data[field],baseline[field]))data[field]=task[field];
      }
      const initial=new Map(editorBaseline.steps.map(step=>[step.id,step]));
      data.steps=data.steps.filter(step=>{
        const old=initial.get(step.id),current=task.steps.find(s=>s.id===step.id);
        if(old&&!current&&['title','dueDate','dueTime','done'].every(field=>S.equal(step[field],old[field])))return false;
        if(old&&current)for(const field of ['title','dueDate','dueTime','done'])if(S.equal(step[field],old[field]))step[field]=current[field];
        return true;
      });
      data.steps.push(...task.steps.filter(step=>!initial.has(step.id)&&!data.steps.some(s=>s.id===step.id)));
    }
    const ok = await change(() => {
      if (task) {
        const reminderChanged = task.reminderDate !== data.reminderDate || task.reminderTime !== data.reminderTime || task.remindersEnabled !== data.remindersEnabled;
        Object.assign(task, data);
        if (reminderChanged) { task.reminderNotifiedAt = null; task.snoozedUntil = null; task.steps.forEach(s => s.reminderNotifiedAt = null); }
      } else state.tasks.unshift({ ...data, id: savedId, done: false, priority: Date.now(), reminderNotifiedAt: null });
    }, task ? 'Changes saved on this device.' : 'Captured. Cloud sync will follow.', true, task ? editorObserved : undefined);
    if (ok) {
      closeEditor(true);
      const saved = taskById(savedId);
      if (query && !M.matchesSearch(saved, query)) { query = ''; $('#searchInput').value = ''; }
      if (!M.taskMatches(saved, activeView)) setView(state.lists.includes(activeView) ? saved.list :
        M.taskMatches(saved, 'today') ? 'today' : M.taskMatches(saved, 'upcoming') ? 'upcoming' : 'unscheduled');
      else render();
      if (form.remindersEnabled && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
    }
  }
  async function deleteTask() {
    const task = taskById(editingTaskId);
    if (!task) return;
    if (await change(() => { state.tasks = state.tasks.filter(t => t.id !== task.id); }, 'Task deleted.')) closeEditor(true);
  }
  async function toggleStep(task, s, checked) {
    if (!await change(() => { s.done = checked; }, checked ? 'One step done.' : 'Step reopened.')) return;
    task=taskById(task.id);
    if (checked && task && !task.done && task.steps.length && task.steps.every(step => step.done)) {
      completionTaskId = task.id;
      $('#completionMessage').textContent = 'Is “' + task.title + '” finished, or is there more to do?';
      $('#completionDialog').showModal();
    }
  }
  function chooseTask() {
    const chosen = M.choose(state, M.today(), chosenId);
    chosenId = chosen?.task.id || null;
    renderFocus();
  }
  function setView(view) {
    activeView = view; focused = false; document.body.classList.remove('focus-active');
    $('#focusButton').textContent = '◎ Focus mode'; $('#focusButton').setAttribute('aria-pressed', 'false'); render();
  }

  function showSuggestionError(message, canConfigure = false) {
    const status = $('#suggestionStatus');
    status.textContent = message;
    status.classList.add('error');
    if (canConfigure) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'text-button'; button.textContent = 'AI settings';
      button.addEventListener('click', openSettings); status.append(button);
    }
  }
  async function suggestSteps() {
    if (suggestionController) { abortSuggestions(); $('#suggestionStatus').textContent = 'Suggestions canceled. Your steps are unchanged.'; return; }
    const title = $('#taskTitle').value.trim();
    if (!title) { showSuggestionError('Add a task name first.'); $('#taskTitle').focus(); return; }
    if (!C.engine) { showSuggestionError('Sign in to request suggestions.'); return; }
    if (!C.aiEnabled) { showSuggestionError('AI suggestions have not been enabled for this workspace. You can add steps below.'); return; }
    if (Date.now() < cooldownUntil) { showSuggestionError('Please wait ' + Math.ceil((cooldownUntil - Date.now()) / 1000) + ' seconds before trying again.'); return; }
    abortSuggestions();
    const epoch = suggestionEpoch, controller = new AbortController();
    suggestionController = controller;
    const timer = setTimeout(() => controller.abort(), 35000);
    $('#suggestStepsButton').textContent = 'Cancel';
    $('#suggestionStatus').classList.remove('error');
    $('#suggestionStatus').textContent = 'Finding a few small, concrete steps…';
    $('#suggestionReview').hidden = true;
    const current = editorData();
    try {
      const response = await C.suggest({ title, list: current.list, energy: current.energy, existingSteps: current.steps.map(s => s.title).filter(Boolean) }, controller.signal);
      const data = await response.json();
      if (epoch !== suggestionEpoch || !$('#taskModal').open) return;
      if (!response.ok) {
        if (data.retryAfter) cooldownUntil = Date.now() + data.retryAfter * 1000;
        showSuggestionError(data.error || 'Suggestions are unavailable right now.', !!data.needsSetup);
        return;
      }
      if (!Array.isArray(data.steps)) throw new Error('The service returned an unreadable breakdown.');
      const existing = new Set(current.steps.map(s => s.title.toLocaleLowerCase()));
      suggestions = [...new Set(data.steps.filter(s => typeof s === 'string').map(s => s.trim()).filter(Boolean))].filter(s => !existing.has(s.toLocaleLowerCase())).slice(0, 6);
      if (!suggestions.length) { $('#suggestionStatus').textContent = 'No extra steps needed. You can add your own below.'; return; }
      $('#suggestionList').innerHTML = suggestions.map((s, i) => '<label class="suggestion-line"><input type="checkbox" checked aria-label="Include suggestion ' +
        (i + 1) + '"><input type="text" maxlength="120" value="' + esc(s) + '" aria-label="Suggested step ' + (i + 1) + '"></label>').join('');
      $('#suggestionReview').hidden = false;
      $('#suggestionStatus').textContent = 'Review these suggestions. They’re added only when you choose “Add selected steps”.';
    } catch (error) {
      if (epoch !== suggestionEpoch || !$('#taskModal').open) return;
      showSuggestionError(error.name === 'AbortError' ? 'That took too long. Try again when you’re ready.' : (error.message || 'Could not reach the suggestion service. Please try again.'));
    } finally {
      clearTimeout(timer);
      if (epoch === suggestionEpoch) { suggestionController = null; $('#suggestStepsButton').textContent = '✦ Suggest steps'; }
    }
  }
  function acceptSuggestions() {
    const values = [...$('#suggestionList').querySelectorAll('.suggestion-line')].filter(row => row.querySelector('input[type=checkbox]').checked)
      .map(row => row.querySelector('input[type=text]').value.trim()).filter(Boolean);
    const existing = new Set(editorData().steps.map(s => s.title.toLocaleLowerCase()));
    const additions = values.filter(value => { const key = value.toLocaleLowerCase(); if (existing.has(key)) return false; existing.add(key); return true; });
    [...$('#stepEditor').children].filter(row => !row.querySelector('.step-title-input').value.trim()).forEach(row => row.remove());
    additions.forEach(title => addStepEditorRow({ title }));
    $('#suggestionReview').hidden = true;
    $('#suggestionStatus').textContent = additions.length ? additions.length + ' steps added. Give them dates if helpful, then save your task.' : 'No steps added. Your existing steps are unchanged.';
  }

  async function refreshApiStatus() {
    apiStatus = {available:!!C.engine,configured:C.aiEnabled};
    $('#aiIndicator').classList.toggle('configured',apiStatus.configured);
    $('#aiIndicator').title=apiStatus.configured?'AI suggestions available':'AI is optional';
  }
  async function openSettings() {
    $('#backupStatus').textContent = '';
    if (!$('#settingsDialog').open) $('#settingsDialog').showModal();
    await refreshApiStatus();
    $('#aiConnectionStatus').textContent = C.aiEnabled ? 'AI suggestions are available through your account.' : 'AI suggestions have not been enabled for this workspace yet. You can always add steps yourself.';
    $('#profileName').value=profile.displayName||'';
    $('#profileReminderTime').value=profile.reminderTime||'09:00';
    C.captureProfileDraft?.();
    const permission = 'Notification' in window ? Notification.permission : 'unsupported';
    $('#notificationStatus').textContent = permission === 'granted' ? 'Browser notifications are enabled. Keep SlashTasks open to receive reminders.'
      : permission === 'denied' ? 'Notifications are blocked in browser settings. In-app reminders still appear while SlashTasks is open.'
      : permission === 'unsupported' ? 'This browser supports in-app reminders only.' : 'Allow browser notifications to see reminders while this tab is in the background.';
    $('#enableNotifications').hidden = permission !== 'default';
  }
  function exportTasks() {
    const text = JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'slashtasks-' + M.today() + '.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    $('#backupStatus').textContent = 'Backup downloaded. It includes tasks and lists only.';
  }
  async function importTasks(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Please choose a task backup smaller than 5 MB.');
      const raw = JSON.parse(await file.text());
      if (!Array.isArray(raw.tasks) || !raw.tasks.every(t => t && typeof t.title === 'string' && t.title.trim())) throw new Error('This file does not look like a SlashTasks task backup.');
      const incoming = M.normalize(raw);
      const added = incoming.tasks.filter(t => !state.tasks.some(existing => existing.id === t.id));
      if (await change(() => { state.tasks.push(...added); state.lists = [...new Set([...state.lists, ...incoming.lists])]; }, 'Backup merged.')) {
        $('#backupStatus').textContent = added.length + ' tasks added. Existing tasks were kept; matching task IDs were skipped.';
      }
    } catch (error) { $('#backupStatus').textContent = error.message || 'Could not read that backup.'; }
    finally { event.target.value = ''; }
  }
  async function checkReminders() {
    if(storageLocked||!C.engine)return;
    const previous=clone(state);
    const alerts = M.reminders(state, Date.now(), profile.reminderTime);
    if (!alerts.length) return;
    const stamp = new Date().toISOString();
    for (const { task, step } of alerts) {
      (step || task).reminderNotifiedAt = stamp;
      if (!step) task.snoozedUntil = null;
      if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification(step ? 'Step for ' + task.title : 'SlashTasks reminder', { body: step?.title || task.title }); } catch { /* The in-app reminder remains available. */ }
      }
    }
    await persist(previous);
    toast(alerts.length === 1 ? '⏰ ' + (alerts[0].step?.title || alerts[0].task.title) : '⏰ ' + alerts.length + ' reminders are ready. Check Today.');
  }

  document.addEventListener('click', event => {
    const target = event.target.closest('button, a');
    if (!target) return;
    if (target.dataset.newList) { $('#listForm').reset(); $('#listDialog').showModal(); $('#newListName').focus(); return; }
    if (target.dataset.view) { setView(target.dataset.view); return; }
    if (target.dataset.list) { setView(target.dataset.list); return; }
    if (target.dataset.mode) { prefs.mode = target.dataset.mode; savePrefs(); render(); return; }
    if (target.dataset.layout) { prefs.layout = target.dataset.layout; savePrefs(); render(); return; }
    if (target.dataset.close) { $('#' + target.dataset.close).close(); return; }
    if (target.dataset.action === 'home') { event.preventDefault(); setView('today'); return; }
    if (target.dataset.delete) {
      const id = target.dataset.delete;
      change(() => { state.tasks = state.tasks.filter(t => t.id !== id); }, 'Task deleted.'); return;
    }
    if (target.dataset.tomorrow) {
      const task = taskById(target.dataset.tomorrow);
      if (task) change(() => {
        const previous = task.dueDate;
        task.dueDate = M.addDays(M.today(), 1);
        if (task.reminderDate === previous) { task.reminderDate = task.dueDate; task.reminderNotifiedAt = null; }
      }, 'Moved to tomorrow.'); return;
    }
    if (target.dataset.snooze) {
      const task = taskById(target.dataset.snooze);
      if (task) change(() => { task.snoozedUntil = new Date(Date.now() + 600000).toISOString(); task.reminderNotifiedAt = null; }, 'Reminder snoozed for 10 minutes.'); return;
    }
    if (target.dataset.toggleSteps) { const id = target.dataset.toggleSteps; expanded.has(id) ? expanded.delete(id) : expanded.add(id); render(); return; }
    if (target.dataset.completeTask) { const task = taskById(target.dataset.completeTask); if (task) change(() => M.toggleTask(state, task), task.done ? 'Task reopened.' : 'Task complete. Nice work.'); return; }
    const taskId = target.dataset.editTask || target.dataset.breakdown;
    if (taskId) {
      const task = taskById(taskId); if (!task) return;
      const breakdown = !!target.dataset.breakdown || !!target.dataset.breakdownFocus;
      openModal(task, { addStep: breakdown && !task.steps.some(s => !s.done), breakdown, focusStep: target.dataset.focusStep || '' });
    }
  });
  $('#taskList').addEventListener('change', event => {
    const input = event.target.closest('[data-step]'); if (!input) return;
    const task = taskById(input.dataset.task), s = task?.steps.find(v => v.id === input.dataset.step);
    if (s) toggleStep(task, s, input.checked);
  });
  ['sideAdd', 'emptyAdd', 'addTaskRow'].forEach(id => $('#' + id).addEventListener('click', () => openModal()));
  $('#closeModal').addEventListener('click', () => closeEditor());
  $('#taskModal').addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
  $('#taskForm').addEventListener('submit', saveTask);
  $('#taskTitle').addEventListener('input', () => {
    $('#taskTitle').setCustomValidity('');
    if (suggestionController || !$('#suggestionReview').hidden) {
      abortSuggestions(); $('#suggestionReview').hidden = true;
      $('#suggestionStatus').textContent = 'Task name changed. Ask for fresh suggestions when you’re ready.';
    }
  });
  $('#taskDueDate').addEventListener('input', () => { if (!reminderManual) $('#taskReminderDate').value = $('#taskDueDate').value; });
  $('#taskReminderDate').addEventListener('input', () => { reminderManual = true; });
  $('#taskReminderEnabled').addEventListener('change', updateReminderFields);
  $('#taskRepeat').addEventListener('change', updateReminderFields);
  $('#addStepButton').addEventListener('click', () => addStepEditorRow().querySelector('input').focus());
  $('#stepEditor').addEventListener('click', event => { const remove = event.target.closest('.remove-step'); if (remove) remove.closest('.step-editor-row').remove(); });
  $('#suggestStepsButton').addEventListener('click', suggestSteps);
  $('#acceptSuggestions').addEventListener('click', acceptSuggestions);
  $('#dismissSuggestions').addEventListener('click', () => { $('#suggestionReview').hidden = true; $('#suggestionStatus').textContent = 'Suggestions dismissed. Your steps are unchanged.'; });
  $('#deleteTaskButton').addEventListener('click', deleteTask);
  $('#completeParent').addEventListener('click', () => {
    const task = taskById(completionTaskId); $('#completionDialog').close();
    if (task && !task.done) change(() => M.toggleTask(state, task), 'Task complete. Nice work.');
  });
  $('#addMoreSteps').addEventListener('click', () => { $('#completionDialog').close(); const task = taskById(completionTaskId); if (task) openModal(task, { addStep: true, breakdown: true }); });
  $('#calloutPick').addEventListener('click', chooseTask);
  $('#focusButton').addEventListener('click', () => {
    focused = !focused; document.body.classList.toggle('focus-active', focused);
    $('#focusButton').textContent = focused ? '× Exit focus' : '◎ Focus mode'; $('#focusButton').setAttribute('aria-pressed', String(focused));
    if (focused && !chosenId) chooseTask(); render();
  });
  $('#searchInput').addEventListener('input', event => { query = event.target.value; render(); });
  $('#sortSelect').addEventListener('change', event => { prefs.sort = event.target.value; savePrefs(); render(); });
  $('#showCompleted').addEventListener('change', event => { prefs.completed = event.target.checked; savePrefs(); render(); });
  $('#addList').addEventListener('click', () => { $('#listForm').reset(); $('#listDialog').showModal(); $('#newListName').focus(); });
  $('#listForm').addEventListener('submit', async event => {
    event.preventDefault(); const name = $('#newListName').value.trim();
    if (!name) return;
    if (['today', 'upcoming', 'unscheduled', 'all'].includes(name.toLowerCase()) || state.lists.some(v => v.toLowerCase() === name.toLowerCase())) {
      $('#newListName').setCustomValidity('Choose a different name. This one is already used.'); $('#newListName').reportValidity(); return;
    }
    if (await change(() => state.lists.push(name), 'List added.')) { $('#listDialog').close(); setView(name); }
  });
  $('#newListName').addEventListener('input', () => $('#newListName').setCustomValidity(''));
  $('#settingsButton').addEventListener('click', openSettings);
  $('#accountButton').addEventListener('click',openSettings);
  $('#exportTasks').addEventListener('click', exportTasks);
  $('#importTasks').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', importTasks);
  $('#enableNotifications').addEventListener('click', async () => { if ('Notification' in window) { await Notification.requestPermission(); openSettings(); } });
  $('#undoButton').addEventListener('click', async () => {
    if (!undoState || !C.userId) return;
    try {
      const next=S.undoState(state,undoState.before,undoState.after,C.userId);
      await change(()=>{state=next;},'Undone.',false);
    }catch(error){toast(error.message);}
  });
  document.addEventListener('keydown', event => {
    const typing = event.target.matches?.('input, textarea, select, [contenteditable]');
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    if (event.key === 'Enter' && $('#taskModal').open && dialog?.id === 'taskModal' && !event.shiftKey &&
        !event.target.closest('button, select, textarea, #suggestionReview')) {
      event.preventDefault(); $('#taskForm').requestSubmit(); return;
    }
    if (dialog || typing || storageLocked || !C.engine || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.toLowerCase() === 'n') { event.preventDefault(); openModal(); }
    if (event.key === '/') { event.preventDefault(); $('#searchInput').focus(); }
  });
  // Never leave a request alive after its editor has closed.
  $('#taskModal').addEventListener('close', abortSuggestions);
  render();
  C.start({
    account: user => {
      identityEpoch++;storageLocked=true;saving=false;abortSuggestions();undoState=null;chosenId=null;
      for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
      state=M.normalize({});profile={};render();
      if(!user)$('#syncDetail').textContent='';
    },
    state: (incoming, incomingProfile) => {state=incoming;profile=incomingProfile;storageLocked=false;render();},
    locked: locked=>{storageLocked=locked;}
  });
  checkReminders();
  let lastDay = M.today();
  setInterval(() => {
    checkReminders();
    if (lastDay !== M.today()) { lastDay = M.today(); render(); }
  }, 15000);
  window.addEventListener('focus', () => { checkReminders(); if (!$('#taskModal').open) render(); });
})();
