# Persistent volume

## Governing rule

A container filesystem is replaced on every deploy. A mounted volume survives but is **not** backed up by the database backup and is **not** replicated.

**Anything written to the volume must be reconstructible from Postgres or object storage.**

The volume is a cache and bootstrap shortcut, never the only copy. If the volume were deleted entirely, the app must recover fully on the next boot with no data loss. Violating this is a bug.

## What lives on `/data`

Mount a Coolify / compose volume at `/data` and set `DATA_DIR=/data` (the image default).

| Path | Purpose | Reconstruct from |
| --- | --- | --- |
| `/data/config/observability.json` | Sentry runtime config (SDK reads this before the database is up) | Prisma `Integration` kind `SENTRY` |
| `/data/cache/` | GitHub installation tokens + expiry, provider health snapshots, template thumbnail derivatives | GitHub App / provider probes / object storage |
| `/data/tmp/` | Backup dumps before upload, zip scratch, import downloads | Deleted after use; safe to wipe |
| `/data/.volume-id` | Volume identity (uuid + createdAt) | Recreated on first write; change is recorded in `AppSetting` `runtime.volumeId` |

Must **not** live on the volume: checkpoint snapshots, generated images, database backups, integration secrets, user uploads, sessions, or `ENCRYPTION_KEY`. Those stay in object storage, Postgres, or env + a password manager.

## Coolify

1. On the Navroop compose application, add a persistent volume mounted at **`/data`** (compose already declares `navroop_data:/data`).
2. Set `DATA_DIR=/data` and `OBSERVABILITY_CONFIG_PATH=/data/config/observability.json` (image defaults).
3. The image creates `/data/config`, `/data/cache`, and `/data/tmp` and `chown`s them to the non-root `nextjs` user (uid **1001**). If you attach an existing volume owned by root, `chown -R 1001:1001 /data` on the host or the health page will name the ownership failure and the app will keep serving traffic in a degraded state.
4. Deleting the Coolify application deletes this volume. It is not in the database backup because everything on it is reconstructible. Use the **same volume mount** on staging (`/data`) so boot behavior matches production.
5. Hourly: `POST /api/cron/sweep-tmp` with `Authorization: Bearer $CRON_SECRET`.

## Recovery drill

Stop the app, delete the volume, restart. Directories are recreated, `observability.json` is rebuilt from the Sentry Integration, a new volume id is written, Sentry reports after the next restart, and no user data is lost. See [release.md](release.md).
