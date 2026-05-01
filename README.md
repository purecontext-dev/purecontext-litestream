# @purecontext/litestream

Continuous SQLite backup via [Litestream](https://litestream.io). Spawns Litestream as a sidecar process that replicates your database to S3-compatible storage with point-in-time recovery.

Designed for Node.js servers and MCP servers that use SQLite. Gracefully no-ops when Litestream isn't installed or credentials are missing — your app runs fine either way.

## Install

```bash
npm install @purecontext/litestream
```

Litestream must be installed separately:

```bash
brew install benbjohnson/litestream/litestream
```

## Usage

### Start replication

```ts
import { startLitestream } from '@purecontext/litestream'

startLitestream({
  dbPath: './data/my-app.db',
  replicaPath: 'my-app/my-app.db', // path within the S3 bucket
})
```

Litestream runs as a child process. When your server exits, the sidecar exits with it.

### Restore from backup

```ts
import { restoreDatabase } from '@purecontext/litestream'

await restoreDatabase({
  dbPath: './data/my-app.db',
  replicaPath: 'my-app/my-app.db',
  outputPath: './data/my-app.restored.db',
  timestamp: '2026-04-15T14:30:00Z', // optional, omit for latest
})
```

Restores to a sidecar file. Inspect before promoting to live.

### Stop replication

```ts
import { stopLitestream } from '@purecontext/litestream'

stopLitestream()
```

Also stops automatically on `SIGINT` / `SIGTERM`.

## Credentials

Credentials resolve in order:

1. **Options** passed directly to `startLitestream()` / `restoreDatabase()`
2. **Environment variables**: `LITESTREAM_BUCKET`, `LITESTREAM_ENDPOINT`, `LITESTREAM_REGION`, `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`
3. **Env file** at `~/.config/purecontext/litestream.env` (loaded automatically)

Example env file:

```env
LITESTREAM_BUCKET=my-backups
LITESTREAM_ENDPOINT=https://your-storage-endpoint.com/storage/v1/s3
LITESTREAM_REGION=us-west-2
LITESTREAM_ACCESS_KEY_ID=your-access-key
LITESTREAM_SECRET_ACCESS_KEY=your-secret-key
```

## Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `dbPath` | yes | | Path to your SQLite database |
| `replicaPath` | yes | | Path within the S3 bucket |
| `bucket` | | env var | S3 bucket name |
| `endpoint` | | env var | S3-compatible endpoint URL |
| `region` | | `auto` | S3 region |
| `accessKeyId` | | env var | S3 access key |
| `secretAccessKey` | | env var | S3 secret key |
| `syncInterval` | | `1s` | How often WAL frames are replicated |
| `snapshotInterval` | | `24h` | How often full snapshots are taken |
| `retention` | | `720h` | How long to keep backup history (30 days) |
| `envFile` | | `~/.config/purecontext/litestream.env` | Custom env file path |

## Optional integration

For projects where backup is a nice-to-have (not a requirement), use dynamic import:

```ts
async function maybeStartBackup(dbPath: string) {
  try {
    const { startLitestream } = await import('@purecontext/litestream')
    startLitestream({ dbPath, replicaPath: 'my-app/my-app.db' })
  } catch {
    // package not installed — no backup, no problem
  }
}
```

Add as `optionalDependencies` in your `package.json` so installs don't fail if the package is unavailable.

## Behavior

- **Orphan cleanup**: Reaps stale Litestream processes from prior abnormal exits before starting a new one
- **Graceful degradation**: No-ops with a console message if Litestream binary is missing, env vars are unset, or credentials file doesn't exist
- **Config generation**: Litestream YAML config is generated in `/tmp` at startup and cleaned up on exit — no config files to manage
- **WAL-based recovery**: Sub-second point-in-time recovery within the retention window

## License

MIT
