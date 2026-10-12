/**
 * Reject new type-system escape hatches while retiring recorded existing ones.
 * Generalizes DeepSeek Harness `scripts/verify-no-unknown-casts.ts`: that gate
 * fingerprints `as unknown` assertions through the TypeScript AST; this port
 * counts regex hits per file so it stays zero-dependency and language-neutral.
 *
 * Config `.agents/escape-hatches.json` under the host root (cwd), or the path
 * given by `AGENT_ESCAPE_HATCHES` / the first positional argument:
 *   {
 *     "patterns":   { "as-unknown": "\\bas unknown\\b", "ts-ignore": "@ts-ignore" },
 *     "extensions": [".ts", ".tsx"],
 *     "exclude":    ["vendor/", "dist/"],
 *     "baseline":   { "src/a.ts": { "as-unknown": 2 } }
 *   }
 * Files come from `git ls-files` (tracked plus non-ignored new files).
 * A count above the baseline fails and lists the lines. A count below the
 * baseline fails until `--prune` writes the lower count back. `--init` records
 * the current counts as the first baseline.
 *
 * Run: npx tsx <skill-dir>/scripts/verify-escape-hatch-baseline.ts [--init|--prune] [config]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

type Counts = Record<string, Record<string, number>>

interface Config {
  patterns: Record<string, string>
  extensions: string[]
  exclude: string[]
  baseline: Counts
}

const root = process.cwd()
const args = process.argv.slice(2)
const init = args.includes('--init')
const prune = args.includes('--prune')
const positional = args.find(arg => !arg.startsWith('--'))
const configPath = resolve(root, positional ?? process.env.AGENT_ESCAPE_HATCHES ?? '.agents/escape-hatches.json')

function fail(message: string): never {
  console.error(`verify-escape-hatch-baseline: ${message}`)
  process.exit(1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readConfig(): Config {
  if (!existsSync(configPath)) fail(`config not found: ${configPath}\ncreate it from <skill-dir>/templates/escape-hatches.json, then run with --init`)
  const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
  if (!isRecord(parsed) || !isRecord(parsed.patterns) || Object.keys(parsed.patterns).length === 0) fail('config.patterns must be a non-empty object of { name: regexSource }')
  const patterns: Record<string, string> = {}
  for (const [name, source] of Object.entries(parsed.patterns)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || typeof source !== 'string') fail(`invalid pattern entry: ${name}`)
    try {
      new RegExp(source, 'u')
    } catch (error) {
      fail(`pattern ${name} is not a valid regex: ${error instanceof Error ? error.message : String(error)}`)
    }
    patterns[name] = source
  }
  const extensions = Array.isArray(parsed.extensions) ? parsed.extensions.filter((e): e is string => typeof e === 'string') : []
  if (extensions.length === 0) fail('config.extensions must list at least one file extension')
  const exclude = Array.isArray(parsed.exclude) ? parsed.exclude.filter((e): e is string => typeof e === 'string') : []
  const baseline: Counts = {}
  if (parsed.baseline !== undefined) {
    if (!isRecord(parsed.baseline)) fail('config.baseline must be an object')
    for (const [file, counts] of Object.entries(parsed.baseline)) {
      if (!isRecord(counts)) fail(`invalid baseline entry: ${file}`)
      baseline[file] = {}
      for (const [name, count] of Object.entries(counts)) {
        if (!(name in patterns) || typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) fail(`invalid baseline count: ${file}:${name}`)
        baseline[file][name] = count
      }
    }
  }
  return { patterns, extensions, exclude, baseline }
}

function sourceFiles(config: Config): string[] {
  let listing: string
  try {
    listing = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    fail(`git ls-files failed (the host must be a Git worktree): ${error instanceof Error ? error.message : String(error)}`)
  }
  return [...new Set(listing.split('\0').filter(Boolean).map(f => f.replaceAll('\\', '/')))]
    .filter(file => config.extensions.some(ext => file.endsWith(ext)))
    .filter(file => !config.exclude.some(prefix => file.startsWith(prefix)))
    .filter(file => existsSync(resolve(root, file)))
    .sort()
}

interface Hit {
  file: string
  line: number
  pattern: string
}

function scan(config: Config, files: string[]): Hit[] {
  const regexes = Object.entries(config.patterns).map(([name, source]) => [name, new RegExp(source, 'u')] as const)
  const hits: Hit[] = []
  for (const file of files) {
    const lines = readFileSync(resolve(root, file), 'utf8').split('\n')
    lines.forEach((text, index) => {
      for (const [name, regex] of regexes) if (regex.test(text)) hits.push({ file, line: index + 1, pattern: name })
    })
  }
  return hits
}

function count(hits: Hit[]): Counts {
  const counts: Counts = {}
  for (const { file, pattern } of hits) {
    const perFile = counts[file] ??= {}
    perFile[pattern] = (perFile[pattern] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))
    .map(([file, perFile]) => [file, Object.fromEntries(Object.entries(perFile).sort(([a], [b]) => a.localeCompare(b)))]))
}

function writeBaseline(config: Config, baseline: Counts): void {
  const out = { patterns: config.patterns, extensions: config.extensions, exclude: config.exclude, baseline }
  writeFileSync(configPath, `${JSON.stringify(out, null, 2)}\n`)
}

const config = readConfig()
const hits = scan(config, sourceFiles(config))
const current = count(hits)

if (init) {
  if (Object.keys(config.baseline).length > 0) fail('baseline already exists; use --prune to lower counts, never --init to raise them')
  writeBaseline(config, current)
  console.log(`verify-escape-hatch-baseline: recorded ${hits.length} existing escape hatch(es) as the baseline.`)
  process.exit(0)
}

const added: Hit[] = []
const remaining: Counts = structuredClone(config.baseline)
for (const hit of hits) {
  const allowance = remaining[hit.file]?.[hit.pattern] ?? 0
  if (allowance > 0) (remaining[hit.file] as Record<string, number>)[hit.pattern] = allowance - 1
  else added.push(hit)
}
if (added.length > 0) {
  console.error('verify-escape-hatch-baseline: new escape hatches are forbidden. Use a typed value, narrow the input, or retire another hatch in the same change.')
  for (const hit of added) console.error(`  ${hit.file}:${hit.line} (${hit.pattern})`)
  process.exit(1)
}

const stale = Object.entries(remaining).flatMap(([file, perFile]) => Object.entries(perFile)
  .filter(([, left]) => left > 0).map(([pattern, left]) => `  ${file} (${pattern}: ${left} retired)`))
if (stale.length > 0) {
  if (!prune) {
    console.error('verify-escape-hatch-baseline: retired baseline entries must be removed with --prune so the ceiling ratchets down:')
    for (const line of stale) console.error(line)
    process.exit(1)
  }
  writeBaseline(config, current)
  console.log(`verify-escape-hatch-baseline: pruned ${stale.length} retired entr${stale.length === 1 ? 'y' : 'ies'}.`)
}

console.log(`verify-escape-hatch-baseline: no new escape hatches; ${hits.length} existing remain.`)
