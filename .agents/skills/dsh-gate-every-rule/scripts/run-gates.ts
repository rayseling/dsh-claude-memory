/**
 * Run every gate listed in `.agents/gates.json` and report one summary.
 * A minimal port of DeepSeek Harness `scripts/run-gates.ts`: same contract
 * (every gate runs, failures are collected, exit code is non-zero if any
 * failed), without its concurrency scheduling and gate groups.
 *
 * Manifest: `{ "gates": [ { "name": "...", "command": "..." } ] }` under the
 * host root (cwd), or the path given by `AGENT_GATES` / the first positional
 * argument. Commands run through the shell from the host root.
 * `--only <name>` runs one gate; `--list` prints the manifest.
 *
 * Run: npx tsx <skill-dir>/scripts/run-gates.ts [--list] [--only <name>] [manifest]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface Gate {
  name: string
  command: string
}

const root = process.cwd()
const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const onlyIndex = args.indexOf('--only')
const only = onlyIndex === -1 ? undefined : args[onlyIndex + 1]
const positional = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--only')[0]
const manifestPath = resolve(root, positional ?? process.env.AGENT_GATES ?? '.agents/gates.json')

if (!existsSync(manifestPath)) {
  console.error(`run-gates: manifest not found: ${manifestPath}`)
  console.error('create it from <skill-dir>/templates/gates.json')
  process.exit(1)
}

function parseGates(text: string): Gate[] {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || !('gates' in parsed) || !Array.isArray((parsed as { gates: unknown }).gates)) {
    throw new Error('manifest must be { "gates": [ { "name", "command" } ] }')
  }
  const gates: Gate[] = []
  const names = new Set<string>()
  for (const entry of (parsed as { gates: unknown[] }).gates) {
    if (typeof entry !== 'object' || entry === null) throw new Error('each gate must be an object')
    const { name, command } = entry as Record<string, unknown>
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`gate name must be kebab-case: ${String(name)}`)
    if (typeof command !== 'string' || command.trim() === '') throw new Error(`gate ${name}: command must be a non-empty string`)
    if (names.has(name)) throw new Error(`duplicate gate name: ${name}`)
    names.add(name)
    gates.push({ name, command })
  }
  if (gates.length === 0) throw new Error('manifest lists no gates')
  return gates
}

let gates: Gate[]
try {
  gates = parseGates(readFileSync(manifestPath, 'utf8'))
} catch (error) {
  console.error(`run-gates: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

if (listOnly) {
  for (const gate of gates) console.log(`${gate.name.padEnd(32)} ${gate.command}`)
  process.exit(0)
}

if (only !== undefined) {
  const selected = gates.filter(gate => gate.name === only)
  if (selected.length === 0) {
    console.error(`run-gates: unknown gate "${only}"; --list shows the manifest`)
    process.exit(1)
  }
  gates = selected
}

const failed: string[] = []
const started = Date.now()
for (const gate of gates) {
  const begin = Date.now()
  const result = spawnSync(gate.command, { cwd: root, shell: true, stdio: 'inherit', env: process.env })
  const seconds = ((Date.now() - begin) / 1000).toFixed(1)
  if (result.error !== undefined) {
    failed.push(gate.name)
    console.error(`✗ ${gate.name} (${seconds}s): failed to start: ${result.error.message}`)
  } else if (result.status !== 0) {
    failed.push(gate.name)
    console.error(`✗ ${gate.name} (${seconds}s): exit ${String(result.status ?? result.signal)}`)
  } else {
    console.log(`✓ ${gate.name} (${seconds}s)`)
  }
}

const total = ((Date.now() - started) / 1000).toFixed(1)
if (failed.length > 0) {
  console.error(`\nrun-gates: ${failed.length}/${gates.length} gate(s) failed in ${total}s: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`\nrun-gates: ${gates.length} gate(s) passed in ${total}s`)
