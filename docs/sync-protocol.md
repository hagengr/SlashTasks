# Sync protocol, version 1

The cloud uses Supabase Auth user IDs and authenticated Postgres RPCs. Web, future iOS, and future Apple Watch clients can use the same protocol. They must preserve operation IDs and field versions; writing directly to the task tables bypasses the required consistency rules and is not granted to clients.

## Data and ownership

Profiles, lists, tasks, and subtasks are separate records keyed by `(user_id, id)`. Subtasks refer to a parent task in the same account. Record contents are JSON objects validated by the database. Each record has a server-issued version, a version for each changed field, and an optional deletion marker. Completion timestamps are assigned by the database. Profiles hold display name, timezone, and default reminder time; the authoritative email address remains in Auth.

A monotonically increasing `sync_heads.version` belongs to each account. Every accepted batch runs in one transaction and advances the head once. A per-account database lock serializes writes and gives pulls a consistent cursor. Client clocks never decide which edit wins.

## Pull

Call `sync_pull({p_cursor: 0})` for the initial snapshot. The response is `{cursor, changes}`, where each record has `kind`, `id`, `data`, `version`, `fieldVersions`, and `deleted`. Persist the records and cursor together. Subsequent pulls supply the last persisted cursor. Deleted records are included as tombstones, so reconnecting clients can remove them.

Realtime only prompts another pull. The web client also polls every 30 seconds and pulls on focus/reconnect. A push acknowledgement never advances the pull cursor: other records may have changed between the client's last pull and its write.

## Commit and push

The web client writes an operation to IndexedDB before displaying save success. Its account journal contains the last cloud snapshot, cursor, ordered outbox, acknowledgement metadata, and local reminder delivery stamps. The visible state overlays pending edits onto the cloud snapshot. The journal is namespaced by project and account. IndexedDB transactions serialize local journal changes; Web Locks serialize network flushing across supported browser tabs.

Each user action gets one UUID and a set of mutations. A mutation contains `kind`, `id`, `patch`, `baseFields`, and `baseVersion`; optional flags request `delete` or explicit `restore`. `baseFields` records the server versions the user edited. Separate task and step mutations avoid rewriting an entire steps array when one checkbox changes. Task and step changes within an action are atomic.

Call `apply_sync_batch({p_batch_id: UUID, p_mutations: [...]})`. Batches have a maximum of 200 mutations and 256 KiB; individual records have a 64 KiB limit. The web client rejects oversized actions before queueing them, preserving an open editor draft or allowing a smaller backup import. The database validates again, preflights the entire batch, and returns either `{ok:true, changes}` or `{ok:false, conflicts}`. No rows are written on a conflict. Malformed requests receive an error. Ordinary task editing fits these limits; a very large backup import may need splitting before import.

The server stores a receipt for each accepted operation UUID and request body hash. If a response is lost after commit, retry the exact same UUID and body. The saved result is returned once more without repeating the write. Reusing an accepted UUID with different contents is rejected. Acknowledgement and outbox removal are persisted atomically on the client.

Pending edits can depend on earlier local changes. The web journal temporarily uses `local:<batch UUID>` field references, then replaces them with the versions acknowledged by the server. It never sends these local references to Postgres. Editors open across an acknowledgement retain their original base version so a later remote edit cannot be overwritten accidentally.

## Conflicts and deletes

Patches to distinct fields merge. For an edited field, a changed base version causes a conflict unless the desired value already matches the cloud value. The interface offers **Keep my change** or **Use cloud version** for the whole conflicting action. Keeping a change rebases it onto the current cloud versions with a new UUID. Taking the cloud version discards that pending action and rebases dependent operations. Later queued actions wait behind an unresolved conflict.

Deletion requires the record's current version and soft-deletes its children in the same transaction. Updates against deleted tasks or deleted parents cannot resurrect them. Those cases disable **Keep my change**; the pending local state can be exported before accepting the deletion. Undo can explicitly restore a deletion with the correct base version. Undo also refuses to overwrite a field that has since changed, while preserving unrelated edits.

Recurring occurrences and their steps use deterministic identities. Two devices completing the same occurrence produce the same next occurrence. A database uniqueness constraint prevents multiple live follow-ups for one source occurrence. A changed recurrence plan is surfaced as a conflict.

## Failure and account lifecycle

Network errors retain the outbox and retry with exponential backoff, capped at roughly one minute. Requests time out. Signing out stops the engine, cancels its requests, closes account UI, and hides its journal. RPCs snapshot the expected account's token, so a queued operation cannot borrow a new account's session. Signing back into the same account restores its journal. The client does not send local data as a different user.

Authentication requires connectivity. A loaded authenticated app can edit offline, but this revision has no service worker for offline first launch. IndexedDB and Auth session storage are browser-managed, not application-encrypted. Device notification delivery history does not sync. Background push and native app scheduling are separate future work.

Receipts and tombstones currently remain indefinitely to support arbitrarily old devices. Large-scale retention/compaction will need a protocol for expired cursors and operation receipts before records can be safely pruned. Each pull currently returns all changed records in one response; pagination and server-side archival can be added when dataset size warrants it.
