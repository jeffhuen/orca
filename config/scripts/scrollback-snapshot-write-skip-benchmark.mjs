#!/usr/bin/env node
// Benchmarks what `setLocalWorkspaceSession` pays to republish unchanged scrollback snapshots —
// a write that fires on something as ordinary as clicking between two terminal split panes.
// The baseline resets the write memory each round so every leaf reaches disk, which is exactly
// what the pre-change writer did.
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import fs from 'node:fs'
import nodeModule from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

if (!process.execArgv.includes('--experimental-transform-types')) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', import.meta.filename],
    { stdio: 'inherit' }
  )
  process.exit(result.status ?? 1)
}

// The app's TS sources import siblings without an extension; Node's ESM resolver needs it.
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL)
      if (fs.existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  }
})

const ROOT = path.resolve(import.meta.dirname, '../..')
const ROUNDS = Number(process.env.ORCA_SNAPSHOT_BENCH_ROUNDS ?? '9')
const LEAVES = Number(process.env.ORCA_SNAPSHOT_BENCH_LEAVES ?? '8')

for (const [name, value] of [
  ['ORCA_SNAPSHOT_BENCH_ROUNDS', ROUNDS],
  ['ORCA_SNAPSHOT_BENCH_LEAVES', LEAVES]
]) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`)
  }
}

const { TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT } = await import(
  path.join(ROOT, 'src/shared/terminal-scrollback-limits.ts')
)
const { writeTerminalScrollbackSnapshotSync, resetTerminalScrollbackSnapshotWriteMemoryForTest } =
  await import(path.join(ROOT, 'src/main/terminal-scrollback-snapshots.ts'))

function median(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function timeRounds(run) {
  const samples = []
  run()
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = performance.now()
    run()
    samples.push(performance.now() - start)
  }
  return median(samples)
}

// A terminal that has been running a while sits at the cap, which is the worst case per leaf.
const scrollbackLine = `${'[0m'}build output line with a path /Users/dev/project/src/index.ts and a status ok\n`
let atCapBuffer = ''
while (atCapBuffer.length < TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT) {
  atCapBuffer += scrollbackLine
}
atCapBuffer = atCapBuffer.slice(0, TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT)

const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-snapshot-write-skip-bench-'))
try {
  const storage = { snapshotRoot, fallbackSnapshotRoot: null }
  const leaves = Array.from({ length: LEAVES }, (_, index) => ({
    tabId: 'slept-tab',
    leafId: `leaf-${index}`,
    buffer: atCapBuffer,
    storage
  }))
  const writeAll = () => {
    for (const leaf of leaves) {
      writeTerminalScrollbackSnapshotSync(leaf)
    }
  }
  const alwaysWriteMs = timeRounds(() => {
    resetTerminalScrollbackSnapshotWriteMemoryForTest()
    writeAll()
  })
  writeAll()
  const republishMs = timeRounds(writeAll)
  const writtenFiles = fs.readdirSync(snapshotRoot).filter((name) => !name.endsWith('.tmp'))
  if (writtenFiles.length !== LEAVES) {
    throw new Error(`expected ${LEAVES} snapshot files, found ${writtenFiles.length}`)
  }
  const republishedBytes = writtenFiles.reduce(
    (total, name) => total + fs.statSync(path.join(snapshotRoot, name)).size,
    0
  )
  console.log(
    `Scrollback snapshot republish — ${LEAVES} unchanged leaves per session write\n` +
      `  before ${alwaysWriteMs.toFixed(3)} ms → after ${republishMs.toFixed(3)} ms  (${(alwaysWriteMs / republishMs).toFixed(1)}x)` +
      `  — ${(republishedBytes / 1024 / 1024).toFixed(2)} MB of disk writes per session write become 0`
  )
} finally {
  fs.rmSync(snapshotRoot, { recursive: true, force: true })
}
