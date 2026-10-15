# SlashTasks

A calmer place to capture tasks, plan small steps, and find one thing to start. Built around quick capture, manageable next actions, and a little less friction.

## Open the app on this Mac

1. Stop an older SlashTasks server with **Control+C** if one is running.
2. Double-click **start.command** in the project folder.
3. Keep its Terminal window open. SlashTasks opens at **http://127.0.0.1:4173**.

The launcher uses an installed Node.js runtime, or the runtime already bundled with Codex on this Mac. It does not install dependencies. On another computer, install Node.js 18 or newer and run:

```sh
node server.js
```

Tasks are stored in this browser, under the same `slashtasks-v1` key as earlier versions. Existing task IDs, steps, recurrence links, and reminder history are retained.

## A simpler daily flow

- **Today** includes overdue work and steps due today, even when their parent task is due later.
- **Upcoming** shows future dates and offers a little planning help.
- **Unscheduled** gives undated tasks a home. **All tasks** shows everything.
- **Tasks / Steps** changes what you organize by; **List / Table** changes the layout. Both use explicit selected states.
- Both task layouts expand steps inline. The global Steps view orders steps by date and time, with a link and matching color to the parent task.
- **Help me choose** gives an inline suggestion. When nothing is due, it helps you plan other captured work.
- Click a task title to edit it. **N** creates a task; **/** opens search; **Enter** saves the editor; **Escape** closes it.
- Dates and times can be set on individual steps. A step without its own date appears under its parent task’s date and is labeled **Task: [date]**.
- Finishing the last step asks whether to complete the parent or add more steps.
- Complete, delete, and reschedule actions offer **Undo**. Completed work can be shown with the toolbar checkbox.

## AI suggestions, without Terminal key setup

Open **Settings & backup → AI step suggestions**, paste an OpenAI API key, and choose **Save API key**. No server restart is needed.

The key is written to a private `.env` file in the project folder with owner-only permissions. That file is ignored by Git and is never served as a web asset or included in task backups. A saved key takes precedence over a shell-provided key so replacement from Settings survives restarts.

When you choose **Suggest steps** in a new or existing task:

1. The server sends that task’s name, list, energy, and existing step titles to OpenAI.
2. Suggestions appear in a separate review area.
3. Select and edit the steps you want, then choose **Add selected steps**.
4. Set dates or times if useful, then save the task.

You can cancel a request. Closing the editor or changing the task name invalidates pending results. Suggestions are never silently added to a different task. Model output is validated and duplicates are removed.

AI is optional. API requests require the project to have access and available quota. Billing, credit, rate-limit, network, timeout, and model errors are explained in the app. Temporary limits respect OpenAI’s retry interval; the app does not automatically retry paid requests.

Advanced: `OPENAI_API_KEY` and `OPENAI_MODEL` environment variables are supported. The default model remains `gpt-4o-mini`. The API uses the Responses endpoint with structured output and `store: false`.

## Reminders

Reminders are explicitly enabled per task under **Reminders & repeat**. Selecting a due date prefills the reminder date; the time starts blank. A blank reminder time uses **9:00 AM in the browser’s local timezone**.

Dated, incomplete steps fire their own reminders when the parent’s reminders are enabled. A step’s own time is used first, then the task’s reminder time, then 9:00 AM. Undated steps do not fire separate reminders.

Keep the app open to receive reminders. Allow browser notifications in Settings if you want them while the tab is in the background. This prototype does not yet provide push notifications or cross-device sync.

## Backups and moving from the old file version

Use **Settings & backup → Export backup** to download tasks and lists. Import merges task IDs and keeps current tasks when an ID matches.

A browser treats `file://`, `http://localhost:4173`, and `http://127.0.0.1:4173` as different storage locations. If your tasks were in the old file version, open that same `index.html` file, export a backup, then import it into the running app. Prefer the launcher's `127.0.0.1` address consistently.

Opening `index.html` directly still supports task management and backups. AI settings and suggestions require the local server. Unreadable saved data is left untouched; Settings can export a recovery copy before restoring a valid backup.

## Development

No package installation or build step is needed. Use `npm start`, `npm test`, or `npm run check` when Node/npm are installed; the same checks can run directly with Node:

```sh
node --test tests/*.test.cjs
node --check app.js
node --check task-model.js
node --check server.js
```

- `task-model.js`: shared, independently tested rules for dates, filtering, selection, recurrence, reminders, and legacy data.
- `app.js`: task views, editor, staged AI review, settings, and backups.
- `server.js`: localhost-only static server and OpenAI proxy, persistent private settings, input validation, and error handling.
- `index.html` and `styles.css`: responsive UI, native modal focus handling, accessible labels, and one consolidated stylesheet.
- `tests/`: state regressions, HTML/controller contracts, and HTTP endpoint checks with mocked OpenAI responses. The suite makes no paid API calls.

This is a local prototype. Publishing the repository to GitHub does not deploy its AI server.
