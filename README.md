# SlashTasks

SlashTasks is a lightweight task management prototype designed around quick capture, manageable next steps, and gentle planning.

## Run it

Run the local server with Node.js 18 or newer:

```sh
node server.js
```

Then open <http://127.0.0.1:4173>. Tasks stay in the browser's local storage. Opening `index.html` directly still works for basic task management, but AI suggestions need the local server.

To enable ChatGPT-powered task breakdowns, set an OpenAI API key in the environment before starting the server:

```sh
OPENAI_API_KEY="your-api-key" node server.js
```

The key stays on the server and is never sent to the browser. Set `OPENAI_MODEL` to use a different model; the default is `gpt-4o-mini`. Suggestions appear as editable steps in the task form. Edit or remove them as needed, then save the task to confirm them.

## Prototype features

- Today, Upcoming, and All Tasks views
- Task lists, energy labels, and recurring schedules
- Optional due dates, reminders, and step-by-step breakdowns
- Task list and table layouts, plus Today, Upcoming, and All step-focused views
- Dated and timed subtasks linked visually to their parent task
- Subtask dates and reminder support when the parent task has reminders enabled
- Focus prompts, snoozing, and quick rescheduling
- Optional ChatGPT-generated subtask suggestions for new tasks

Reminders currently fire only while the app is open. A blank reminder time uses 9:00 AM local time.
