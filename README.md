# @purecontext/litestream

Continuous SQLite backup via [Litestream](https://litestream.io). Spawns Litestream as a sidecar process that replicates your database to S3-compatible storage with point-in-time recovery.

Designed for Node.js servers and MCP servers that use SQLite. Gracefully no-ops when Litestream is not installed or credentials are missing. Your app runs fine either way.

## Install

```bash
npm install @purecontext/litestream
```

Litestream must be installed separately:

```bash
brew install benbjohnson/litestream/litestream
```

## Quick Start

```ts
import { startLitestream } from '@purecontext/litestream'

startLitestream({
  name: 'my-app',
  configDir: './data',
  dbPath: './data/my-app.db',
  replicaPath: 'my-app/my-app.db',
})
```

Litestream runs as a child process. When your server exits, the sidecar exits with it.

## Process Isolation

Each caller provides a `name` that uniquely identifies its Litestream instance. The name controls two things:

1. **Config filename.** The generated Litestream YAML config is written as `litestream-{name}.yml` in the `configDir` directory.
2. **Orphan detection.** On startup, the library runs `pgrep -f litestream-{name}.yml` to find and kill stale processes from prior abnormal exits before spawning a new one.

This means multiple projects can run Litestream simultaneously without interfering with each other. A project named `platform` only cleans up `litestream-platform.yml` processes. A project named `recall` only cleans up `litestream-recall.yml` processes.

If `name` is omitted, it falls back to `pid-{process.pid}`, which is unique per run but cannot detect orphans from prior runs. Always provide a stable name in production.

## Config Directory

The `configDir` option controls where the generated Litestream YAML config is written. This keeps each project's runtime state self-contained:

```ts
startLitestream({
  name: 'my-app',
  configDir: './data',          // config written to ./data/litestream-my-app.yml
  dbPath: './data/my-app.db',
  replicaPath: 'backups/my-app.db',
})
```

The config file contains S3 credentials (resolved from env vars or the credentials file). Placing it in a project-local directory that is already gitignored keeps credentials out of world-readable locations like `/tmp`.

If `configDir` is omitted, the config is written to the system temp directory for backward compatibility.

## Multi-Database Replication

Use `startLitestreamAll` to replicate multiple databases with a single Litestream process:

```ts
import { startLitestreamAll } from '@purecontext/litestream'

startLitestreamAll([
  {
    name: 'my-app',
    configDir: './data',
    dbPath: './data/main.db',
    replicaPath: 'my-app/main.db',
  },
  {
    dbPath: './data/analytics.db',
    replicaPath: 'my-app/analytics.db',
  },
])
```

The `name` and `configDir` are read from the first entry in the array. All databases share a single Litestream process and config file.

## Credentials

Credentials resolve in order:

1. **Options** passed directly to `startLitestream()` / `restoreDatabase()`
2. **Environment variables**: `LITESTREAM_BUCKET`, `LITESTREAM_ENDPOINT`, `LITESTREAM_REGION`, `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`
3. **Env file** at `~/.config/purecontext/litestream.env` (loaded automatically, override with `envFile` option)

Example env file:

```env
LITESTREAM_BUCKET=my-backups
LITESTREAM_ENDPOINT=https://your-storage-endpoint.com/storage/v1/s3
LITESTREAM_REGION=us-west-2
LITESTREAM_ACCESS_KEY_ID=your-access-key
LITESTREAM_SECRET_ACCESS_KEY=your-secret-key
```

Environment variables are loaded non-destructively. If a variable is already set in `process.env`, the env file value is ignored.

## Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `name` | | `pid-{process.pid}` | Stable identifier for this instance. Controls config filename and orphan detection. |
| `configDir` | | system temp dir | Directory for the generated Litestream config file. |
| `dbPath` | yes | | Path to your SQLite database. |
| `replicaPath` | yes | | Path within the S3 bucket. |
| `bucket` | | env var | S3 bucket name. |
| `endpoint` | | env var | S3-compatible endpoint URL. |
| `region` | | `auto` | S3 region. |
| `accessKeyId` | | env var | S3 access key. |
| `secretAccessKey` | | env var | S3 secret key. |
| `syncInterval` | | `1s` | How often WAL frames are replicated. |
| `snapshotInterval` | | `24h` | How often full snapshots are taken. |
| `retention` | | `720h` | How long to keep backup history (30 days). |
| `envFile` | | `~/.config/purecontext/litestream.env` | Custom env file path. |
| `logFile` | | | File path for Litestream stderr output. Appended with timestamps. |

## Restore

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

## Stop

```ts
import { stopLitestream } from '@purecontext/litestream'

stopLitestream()
```

Also stops automatically on `SIGINT` / `SIGTERM`. The config file is cleaned up on exit.

## Optional Integration

For projects where backup is nice-to-have, use dynamic import and list the package as `optionalDependencies`:

```ts
async function maybeStartBackup(dbPath: string) {
  try {
    const { startLitestream } = await import('@purecontext/litestream')
    startLitestream({
      name: 'my-app',
      configDir: './data',
      dbPath,
      replicaPath: 'my-app/my-app.db',
    })
  } catch {
    // package not installed
  }
}
```

## Orphan Cleanup

When a parent process dies without cleanup (force quit, `SIGKILL`, crash), the Litestream child process becomes an orphan. On the next startup:

1. `pgrep -f litestream-{name}.yml` finds all processes matching this instance's config filename.
2. Each orphan receives `SIGTERM`.
3. The library polls for up to 2 seconds, waiting for graceful exit.
4. Any process still running after the deadline receives `SIGKILL`.
5. A new Litestream process is spawned with a fresh config.

If `pgrep` fails or returns no results, startup proceeds normally. The mechanism is self-healing: orphans are always cleaned up on the next startup, regardless of how the previous process died.

## License

MIT
