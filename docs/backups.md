# Firestore backups (runbook)

Encrypted nightly export of Firestore (DESIGN D17). Code: `src/lib/backup/`, job
`src/worker/jobs/backup-firestore.ts`, restore `scripts/restore-firestore.ts`.

## Nightly job

- `backup-firestore`, 03:30 UTC on the worker's `system` queue, one attempt. Reads through the Admin SDK,
  counted in `firestore.reads`.
- Pass 1, incremental: per collection with a time field (`updatedAt`, else `createdAt`), the documents at or
  after the collection's cursor, in (time, path) order, up to 20 000 a night. A cut scan resumes strictly
  after the last exported (time, path), so documents sharing a timestamp are never skipped. The next pass
  starts with the collection that was cut (round robin).
- Pass 2, rolling full: up to 10 000 documents a night in document-path order, continued per collection;
  one cycle covers every collection in the backup table (`export.ts`, `TABLE`). It gets what the incremental
  left of the run limit below.
- One run reads at most 20 000 documents (40 % of the Spark daily read quota) across both passes, and scans
  stop when the daily read quota reaches 75 %; the cursors keep the progress.
- Cursors live in `system/backup` and move only after the manifest is stored: a failed run is redone the
  next night. One run per UTC date (a second run, or a manifest already there, is skipped).
- Alerts: P1 when `BACKUP_AGE_RECIPIENT` is missing or invalid, or R2 is not configured (once a day,
  nothing written), and on any failure; P2 when the read quota stopped the run, or when a rolling full
  cycle is still unfinished after 60 days (past the 98-day retention some documents would have no copy).
  The result (counts, parts, bytes, reads, duration) is logged as `backup-firestore`.

## Files

Private bucket (`R2_BUCKET_PRIVATE`):

```
backups/<YYYY-MM-DD>/incremental/<collection>[-<n>].ndjson.gz.age
backups/<YYYY-MM-DD>/full/<collection>[-<n>].ndjson.gz.age
backups/<YYYY-MM-DD>/manifest.json.age
```

A part is NDJSON (one line per document: `{"p": path, "d": data, "u": updateTime}`, Firestore types as
tagged objects) -> gzip -> age, at most 20 000 documents or 16 MiB of NDJSON. The manifest (age only)
lists each part with its document count, size and SHA-256, plus the cursors. Nothing is ever written in
clear text, on the VM or in the bucket.

Retention: 98 days, by an R2 lifecycle rule on the `backups/` prefix of each private bucket (infra item,
DESIGN section 7; not set by this code):
`{"rules":[{"id":"backups-98d","enabled":true,"conditions":{"prefix":"backups/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":8467200}}}]}`.

## Keys

- The owner generates the pair offline: `age-keygen -o joutiya-backup.key` (age v1.3+). The printed
  public key (`age1...`, 62 chars) goes to `BACKUP_AGE_RECIPIENT` in the worker's `app.env`.
- The key file (`AGE-SECRET-KEY-1...`) stays offline with the owner (password manager plus an offline
  copy): never on the VM, in the repo, in CI or in a chat. Without it no backup can be read.
- Rotation: new pair, new `BACKUP_AGE_RECIPIENT`; keep the old key file 98 days for the older backups.
- Manual look: `age -d -i joutiya-backup.key manifest.json.age`, or
  `age -d -i joutiya-backup.key users.ndjson.gz.age | gunzip | head`.

## Restore

From the owner's machine (the key file never leaves it), with Node 24:

```
# 1. Dry run: decrypts and checks every part in memory, prints counts only.
node scripts/restore-firestore.ts --identity joutiya-backup.key --from ./backups --project <project-id>
# Straight from the bucket instead of a download (R2_* variables in .env.local):
node --env-file=.env.local scripts/restore-firestore.ts --identity joutiya-backup.key --from-bucket --project <project-id>
# 2. Write.
node scripts/restore-firestore.ts ... --apply
```

- Target: with `FIRESTORE_EMULATOR_HOST` set, the local emulator (any project id). Otherwise a project
  recorded in `infra/targets.json`; the production one also needs `--allow-production`. Credentials:
  `gcloud auth application-default login`.
- Options: `--collections users,listings` (backup table ids, `private` = `users/{uid}/private/*`),
  `--until YYYY-MM-DD` (state as of that night, e.g. before a bad deploy).
- Each document gets its newest captured version (highest update time across all dates and passes),
  written with `set()` in batches of 500. A date whose manifest is missing (run that did not finish) is
  restored unverified, with a warning; a part that does not match its manifest stops the restore; days
  without any backup are reported.
- `set()` replaces whole documents: restoring into a live database reverts what changed since the backup.
  Prefer an empty project, or narrow with `--collections`.
- Spark allows 20 000 writes a day: split a larger restore with `--collections` over several days.

After a restore:

1. Deletions are not in the backups: documents deleted outright after a backup are back. A purged listing
   comes back as its tombstone (it carries `updatedAt`) once the incremental that followed the purge is
   restored; before that, its full text is back. Run `retention-purge` and `purge-unactivated`, and check
   legal holds, before reopening.
2. Not in the backups: Firebase Auth accounts (export them separately), `config/legal`
   (`scripts/legal-config.ts`), `quotaDaily`, `system/*` cursors (rebuilt), R2 objects (photos).
3. Rebuild the search index from Firestore (phase 4).

## Known limits

- A change to a document without `updatedAt` (journals, `listingStats`, `searchOutbox`, `private`) or with
  `createdAt` only (`emailIndex`, `staff`, `moderationDecisions`) reaches the backups through the rolling
  full only: within one cycle (documents / 10 000 nights).
- A collection's first incremental covers its last 24 h; older documents come with the rolling full.
- age files are encrypted, not signed: anyone holding the public key and write access to the bucket could
  plant a part. Restore only from the environment's own private bucket (R2 token scoped to it).
- Restore on real data (prod backups into staging) is a pending phase 3 check on the live environment.
