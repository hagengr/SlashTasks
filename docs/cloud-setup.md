# Cloud setup

This is the deployment checklist for the cloud revision. It does not indicate that a project already exists. Use a Supabase Free project and a Cloudflare Pages site. No legacy browser-data migration is required.

## 1. Create the project and database

Create **SlashTasks** in your Supabase organization on the Free plan, using a US West region unless you prefer another. Keep the database password in your password manager.

Apply `supabase/migrations/202610200001_cloud_sync.sql` to the new project through the connected Supabase management tools or the dashboard SQL Editor. The migration creates profiles, lists, tasks, separate subtasks, version cursors, write receipts, ownership policies, and the sync functions. It is for a fresh database and should be applied once. With the Supabase CLI you can instead link the project and run:

```sh
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

New Auth users get a profile and Personal, Work, and Home lists automatically. Tasks start empty. All application tables have row level security. Signed-in clients can select their own rows; writes go through the authenticated sync functions. Do not add broad insert/update/delete policies to make a client error disappear.

The migration adds `sync_heads` to the Realtime publication when available. Realtime events are hints to fetch changes, with polling as a fallback. Full task records are not broadcast between accounts.

References: [database functions](https://supabase.com/docs/guides/database/functions), [row level security](https://supabase.com/docs/guides/database/postgres/row-level-security).

## 2. Configure email codes

Enable the Email provider and signups in Supabase Auth. Keep anonymous accounts disabled. Set email OTP length to **6** and expiry to **600 seconds**.

Update both the **Confirm signup** and **Magic Link** email templates using `supabase/templates/sign-in.html`. Both must display `{{ .Token }}`. The app calls `signInWithOtp`, then `verifyOtp` with type `email`; it expects a code rather than a link. Set the Auth Site URL to the published HTTPS app address when it is known. `supabase/config.toml` records these settings, but editing that file alone does not configure a hosted project's dashboard settings.

**For a private pilot:** Supabase's default email sender currently only delivers to addresses on the project's organization team and limits sending to two messages per hour. Use your Supabase account email for the initial sign-in. For other users, configure custom SMTP and a verified sender; an email provider's free allowance may be enough for a small pilot. This is separate from upgrading Supabase.

References: [email passwordless sign-in](https://supabase.com/docs/guides/auth/auth-email-passwordless), [SMTP setup and default-sender restrictions](https://supabase.com/docs/guides/auth/auth-smtp).

## 3. Connect the local app

Copy `.env.example` to `.env`. Fill in only the public project connection for the initial rollout:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_PUBLIC_KEY
SLASHTASKS_AI_ENABLED=false
```

Find these values in the project's connection/API settings. A legacy `anon` key is also supported. Never use `sb_secret_...` or a `service_role` key here. The public key is intentionally delivered to the browser; ownership is enforced by the authenticated API and database.

Run `node server.js` or `start.command` and visit `http://127.0.0.1:4173`. Sign in with a code and create a task. Do not commit `.env` or paste secret keys into chat.

## 4. Publish the website

Create a Cloudflare Pages project connected to this GitHub repository and the cloud revision's branch. Configure:

| Setting | Value |
| --- | --- |
| Build command | `node scripts/build-cloud.cjs` |
| Output directory | `dist` |
| Root directory | Repository root |
| Environment | Node 18 or newer |
| Variables | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SLASHTASKS_AI_ENABLED=false` |

The builder pins the public Supabase URL into the release and generates Cloudflare security headers. It rejects secret/service-role keys and excludes private server files. The site serves static assets; the database, Auth, and optional Edge Function run in Supabase. GitHub repository publication alone does not host the app.

Add the final site URL to Supabase Auth's Site URL. If a custom domain is added later, update Auth settings and the optional AI origin allowlist. Credentials for configuring Cloudflare Pages have not been supplied as part of this revision.

## Optional AI

Core task management needs no OpenAI key. To enable suggestions:

1. Apply the migration, including `reserve_ai_request`.
2. Deploy the `suggest-subtasks` Edge Function. The committed function config sets `verify_jwt=false` because the handler validates the bearer token with Supabase Auth before accessing the quota or OpenAI. Keep that explicit verification in place.
3. Store `OPENAI_API_KEY` in Supabase Edge Function secrets, with optional `OPENAI_MODEL` (defaults to `gpt-4o-mini`). The function uses Supabase's built-in `SUPABASE_URL` and `SUPABASE_ANON_KEY` environment variables. It does not need a service-role key.
4. Set `APP_ORIGINS` to a comma-separated list of exact allowed origins, for example `https://YOUR_SITE.pages.dev,http://127.0.0.1:4173`. Do not include paths or a trailing slash. Native clients may omit Origin; they still need a valid user token.
5. Rebuild the frontend with `SLASHTASKS_AI_ENABLED=true`.

With the CLI, deploy from the repository root:

```sh
supabase functions deploy suggest-subtasks --project-ref YOUR_PROJECT_REF
```

Use the dashboard secret editor for the OpenAI key so it does not enter shell history. The function currently permits 3 requests per account per minute and 20 per UTC day. These are application limits; OpenAI requests have their own billing and account limits. Failed upstream requests consume a quota slot. Canceled requests may already have reached OpenAI.

## Checks before rollout

- Sign in using a real delivered code. Confirm a new account starts with zero tasks and the three built-in lists.
- Open the same account in two browsers. Create a task and dated steps, then edit different fields on each device.
- Edit the same field while one device is disconnected. On reconnect, confirm the app asks which change to keep.
- Disconnect a loaded tab, add a task, reload only after reconnecting, and confirm the queued task reaches the other device once.
- Delete a task on one device while editing one of its steps on another. Confirm it is not silently recreated.
- Sign out with pending edits, sign into another account, then return to the original. Confirm the accounts remain separate.
- Use a second account to confirm it cannot read the first account's records through the data API.
- If AI is enabled, confirm unauthenticated requests fail and suggestions still need user confirmation before saving.

The repository contains protocol and PostgreSQL regression coverage. Live email delivery, hosted permissions, Realtime, browser IndexedDB behavior, and deployment settings still need these end-to-end checks after provisioning.
