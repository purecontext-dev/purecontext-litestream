import { execFileSync, type ChildProcess, spawn } from 'node:child_process'
import { writeFileSync, appendFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLitestreamEnv } from './env.js'

export interface LitestreamOptions {
  name?: string
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
  logFile?: string
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

function configFileName(name: string): string {
  return `litestream-${name}.yml`
}

function killOrphans(configName: string): void {
  let pids: string
  try {
    pids = execFileSync('pgrep', ['-f', configName], { encoding: 'utf-8' }).trim()
  } catch {
    return
  }
  if (!pids) return

  for (const line of pids.split('\n')) {
    const pid = parseInt(line.trim(), 10)
    if (isNaN(pid)) continue

    console.error(`[litestream] killing orphaned replicator (pid ${pid})`)
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }

  const deadline = Date.now() + 2000
  for (const line of pids.split('\n')) {
    const pid = parseInt(line.trim(), 10)
    if (isNaN(pid)) continue

    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
      } catch {
        break
      }
      execFileSync('sleep', ['0.1'])
    }

    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

function stopPreviousChild(): void {
  if (!state) return

  const { child } = state
  if (child.exitCode !== null || child.killed) return

  console.error(`[litestream] stopping previous replicator (pid ${child.pid})`)
  child.kill('SIGTERM')

  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    try {
      process.kill(child.pid!, 0)
    } catch {
      return
    }
    execFileSync('sleep', ['0.1'])
  }

  try {
    child.kill('SIGKILL')
  } catch {
    // already gone
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

  const name = dbs[0].name ?? `pid-${process.pid}`
  const cfgName = configFileName(name)

  stopPreviousChild()
  killOrphans(cfgName)

  const configPath = join(tmpdir(), cfgName)
  writeFileSync(configPath, generateConfigMulti(dbs))

  const child = spawn('litestream', ['replicate', '-config', configPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  const logFile = dbs.find((d) => d.logFile)?.logFile
  child.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim()
    if (!msg) return
    const line = `[${new Date().toISOString()}] ${msg}\n`
    console.error(`[litestream] ${msg}`)
    if (logFile) {
      try {
        appendFileSync(logFile, line)
      } catch {}
    }
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
  } catch {}
  state = null
}

export function stopLitestream(): void {
  if (!state) return
  state.child.kill('SIGTERM')
  cleanup()
}
