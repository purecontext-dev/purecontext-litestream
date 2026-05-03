import { execFileSync, type ChildProcess, spawn } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLitestreamEnv } from './env.js'

export interface LitestreamOptions {
  dbPath: string
  replicaPath: string
  bucket?: string
  endpoint?: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  syncInterval?: string
  snapshotInterval?: string
  retention?: string
  envFile?: string
}

interface LitestreamState {
  child: ChildProcess
  configPath: string
}

let state: LitestreamState | null = null

function resolveEnv(opts: LitestreamOptions) {
  return {
    bucket: opts.bucket ?? process.env.LITESTREAM_BUCKET,
    endpoint: opts.endpoint ?? process.env.LITESTREAM_ENDPOINT,
    region: opts.region ?? process.env.LITESTREAM_REGION ?? 'auto',
    accessKeyId: opts.accessKeyId ?? process.env.LITESTREAM_ACCESS_KEY_ID,
    secretAccessKey:
      opts.secretAccessKey ?? process.env.LITESTREAM_SECRET_ACCESS_KEY,
  }
}

function generateConfigMulti(dbs: LitestreamOptions[]): string {
  const sections = dbs.map((opts) => {
    const env = resolveEnv(opts)
    return `  - path: ${opts.dbPath}
    replicas:
      - type: s3
        bucket: ${env.bucket}
        path: ${opts.replicaPath}
        endpoint: ${env.endpoint}
        region: ${env.region}
        access-key-id: ${env.accessKeyId}
        secret-access-key: ${env.secretAccessKey}
        force-path-style: true
        retention: ${opts.retention ?? '720h'}
        snapshot-interval: ${opts.snapshotInterval ?? '24h'}
        sync-interval: ${opts.syncInterval ?? '1s'}`
  })
  return `dbs:\n${sections.join('\n')}\n`
}

function reapStaleLitestreams(): void {
  let pids: number[]
  try {
    const out = execFileSync('pgrep', ['-f', 'litestream replicate'], {
      encoding: 'utf8',
    }).trim()
    pids = out
      .split('\n')
      .map((p) => Number.parseInt(p, 10))
      .filter((p) => Number.isFinite(p) && p !== process.pid)
  } catch {
    return
  }

  if (pids.length === 0) return

  console.error(
    `[litestream] reaping ${pids.length} stale replicator(s): ${pids.join(', ')}`,
  )

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }

  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })
    if (alive.length === 0) return
    execFileSync('sleep', ['0.1'])
  }

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

export function startLitestream(opts: LitestreamOptions): boolean {
  return startLitestreamAll([opts])
}

export function startLitestreamAll(dbs: LitestreamOptions[]): boolean {
  if (dbs.length === 0) return false

  loadLitestreamEnv(dbs[0].envFile)
  const env = resolveEnv(dbs[0])
  const missing = (['bucket', 'endpoint', 'accessKeyId', 'secretAccessKey'] as const).filter(
    (k) => !env[k],
  )

  if (missing.length > 0) {
    console.error(
      `[litestream] not started — missing: ${missing.join(', ')}. Backups are OFF.`,
    )
    return false
  }

  reapStaleLitestreams()

  const configPath = join(tmpdir(), `litestream-${process.pid}.yml`)
  writeFileSync(configPath, generateConfigMulti(dbs))

  const child = spawn('litestream', ['replicate', '-config', configPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  child.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim()
    if (msg) console.error(`[litestream] ${msg}`)
  })

  child.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      console.error(
        '[litestream] binary not found. Install: brew install benbjohnson/litestream/litestream',
      )
    } else {
      console.error('[litestream] failed to start:', err.message)
    }
    cleanup()
  })

  child.on('exit', () => {
    cleanup()
  })

  state = { child, configPath }

  process.on('SIGINT', stopLitestream)
  process.on('SIGTERM', stopLitestream)

  for (const db of dbs) {
    console.error(
      `[litestream] replicating ${db.dbPath} → s3://${env.bucket}/${db.replicaPath}`,
    )
  }
  return true
}

function cleanup(): void {
  if (!state) return
  try {
    unlinkSync(state.configPath)
  } catch {
    // temp file already gone
  }
  state = null
}

export function stopLitestream(): void {
  if (!state) return
  state.child.kill('SIGTERM')
  cleanup()
}
