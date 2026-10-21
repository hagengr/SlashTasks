# SlashTasks

A calmer place to capture tasks, plan small steps, and find one thing to start.

This revision connects the web app to Supabase Auth and Postgres. Accounts sign in with an email link, get a profile, and own their tasks, steps, and lists. New accounts start empty. No browser data is migrated automatically. Email codes are also supported when custom SMTP is configured.

**Deployment status:** the SlashTasks Free project is provisioned in US West and the database migration is applied. The local connection is configured in the ignored `.env` file, and Auth's Site URL is set to the local app. A public website has not been deployed. See [Cloud setup](docs/cloud-setup.md) for the current project and remaining rollout steps. The local prototype remains on `main` while this cloud revision is reviewed.

## What you can do

- Use **Today**, **Upcoming**, **Unscheduled**, or **All tasks**. Today includes overdue work and steps due today, even when the parent task is due later.
- Switch between **Tasks / Steps** and **List / Table**. Both task layouts expand steps inline; the Steps view links back to the parent task.
- Use **Help me choose** for an inline starting suggestion, or plan other captured work when today is clear.
- Click a task title to edit. **N** creates a task, **/** opens search, **Enter** saves the task editor, and **Escape** closes it.
- Give steps their own dates and times. Finishing the last step offers to complete the task or add more steps.
- Set a display name and default reminder time in your profile.
- Edit while disconnected after the app has loaded. Changes are saved in an account-specific IndexedDB journal before the app confirms the save. They upload when connectivity returns.
- See pending saves, retry sync, and resolve conflicts explicitly. Changes to different fields merge; competing changes to the same field require a choice.
- Export a task backup, including changes still waiting to sync. Import merges tasks by ID and keeps existing tasks when IDs match.

## Run locally against your cloud project

1. Complete the Auth URL setup in [Cloud setup](docs/cloud-setup.md).
2. Copy `.env.example` to `.env` and set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`.
3. Run `node server.js`, or double-click `start.command` on this Mac.
4. Open **http://127.0.0.1:4173**, enter your Supabase team email, then open the emailed sign-in link on this Mac.

The launcher uses Node.js on your PATH or the runtime bundled with Codex on this Mac. Node 18 or newer is required. Frontend dependencies are vendored, so running the app needs no package installation. Opening `index.html` directly is not the supported launch path.

The browser receives the project URL and public publishable key. Database policies and authenticated RPCs protect each account. A service-role or Supabase secret key must never be placed in frontend configuration.

### Use another device on your local network

Local-network access is enabled on this Mac. Open **http://192.168.68.100:4173** from a device on the same network while the server remains running. For email sign-in, add **http://192.168.68.100:4173/** to Supabase Auth's additional Redirect URLs first.

This address can change when the Mac changes networks. The launcher prints the current available network addresses. On another installation, opt in with `SLASHTASKS_LAN_ENABLED=true` in `.env` and restart the server. The default in `.env.example` is disabled. The app's data still lives in Supabase; the Mac serves the web interface.

## Optional AI suggestions

Cloud suggestions run through the authenticated `suggest-subtasks` Supabase Edge Function. The OpenAI key is an Edge Function secret, configured by the operator, and is never requested in the web app. Task saving and manual steps work with AI disabled.

Suggestions are staged for review: select and edit them, choose **Add selected steps**, then save the task. Requests send the task title, list, energy, and existing step titles. Output is validated and duplicates are removed. Closing the editor or changing the task title cancels stale requests. The handler uses `store: false`, enforces per-account request limits, and does not automatically retry paid requests.

See [Cloud setup](docs/cloud-setup.md#optional-ai) for deployment and secrets. The old localhost AI proxy remains a development utility; it is not included in the cloud release.

## Reminders and offline use

Reminders are enabled per task. Selecting a due date prefills the reminder date with no time. A blank time uses the profile's default, initially 9:00 AM, in the current device's timezone. Dated incomplete steps use their own time, then the task's time, then the profile default.

Reminders currently require the app to remain open. Notification delivery history stays on each device. Background push, native iOS/Watch notifications, and installing an offline app shell are future work. A loaded tab can edit offline; opening a fresh tab without internet is not guaranteed.

Signing out hides that account's data and keeps its pending journal on that browser for the next sign-in to the same account. The local cache is not encrypted. Clearing browser storage removes unsynced changes. Wait for **Saved to cloud**, or export a backup, before clearing it.

## Development

```sh
npm ci
npm run check
npm test
npm run build
```

The build requires public Supabase configuration and creates a static `dist/` directory for Cloudflare Pages. It uses a strict file allowlist and excludes `.env`, the local server, tests, and private keys.

The existing regression suite covers task behavior, UI element contracts, the local HTTP server, authenticated AI handling, the sync journal, and the migration against embedded PostgreSQL. Tests make no live Supabase or paid OpenAI calls. Database cases use the pinned PGlite development dependency. See [Sync protocol](docs/sync-protocol.md) for conflict and retry rules.

### Source map

| File | Purpose |
| --- | --- |
| `app.js`, `index.html`, `styles.css` | Task views, editor, staged AI review, profile, and backups |
| `task-model.js` | Date filtering, reminders, recurrence, selection, and normalization |
| `cloud.js` | Supabase authentication, account lifecycle, status UI, realtime hints |
| `cloud-sync.js` | Durable journal, field patches, retry, acknowledgement, conflict resolution |
| `supabase/migrations/` | Schema, ownership policies, atomic sync RPCs, AI quota |
| `supabase/functions/suggest-subtasks/` | Authenticated cloud AI handler |
| `scripts/build-cloud.cjs` | Static release builder and security headers |
| `server.js`, `start.command` | Local development launcher and configuration |
| `vendor/` | Official Supabase JavaScript SDK 2.118.0 and its MIT license |
