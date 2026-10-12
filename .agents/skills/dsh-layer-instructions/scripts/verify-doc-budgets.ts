/**
 * Enforce `wc -w`-style word ceilings on standing instruction files.
 * Ported from DeepSeek Harness `scripts/verify-doc-budgets.ts`.
 *
 * Manifest: `.agents/doc-budgets.json` under the host root (cwd), or the path
 * given by `AGENT_DOC_BUDGETS` / the first positional argument. Keys are
 * host-relative file paths, values are positive-integer ceilings.
 * `--list` prints current usage without failing.
 *
 * Run: npx tsx <skill-dir>/scripts/verify-doc-budgets.ts [--list] [manifest]
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const positional = args.find(arg => !arg.startsWith('--'))
const manifestPath = resolve(root, positional ?? process.env.AGENT_DOC_BUDGETS ?? '.agents/doc-budgets.json')

/** `wc -w` equivalent: count whitespace-delimited tokens. CJK prose counts characters instead, so a mixed file reports whichever is larger. */
function countWords(text: string): number {
  const tokens = text.split(/\s+/).filter(Boolean).length
  const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).length
  return Math.max(tokens, cjk)
}

if (!existsSync(manifestPath)) {
  console.error(`verify-doc-budgets: manifest not found: ${manifestPath}`)
  console.error('create it from <skill-dir>/templates/doc-budgets.json, listing each standing instruction file and its ceiling')
  process.exit(1)
}

const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
  console.error('verify-doc-budgets: manifest must be a JSON object of { "path": ceiling }')
  process.exit(1)
}
const manifest = parsed as Record<string, unknown>

const failures: string[] = []
const rows: string[] = []

for (const [path, ceiling] of Object.entries(manifest)) {
  if (!Number.isInteger(ceiling) || (ceiling as number) <= 0) {
    rows.push(`BAD   ${'—'.padStart(6)} / ${String(ceiling).padEnd(6)} ${path}`)
    failures.push(`${path}: ceiling must be a positive integer, got ${String(ceiling)}`)
    continue
  }
  const limit = ceiling as number
  const abs = resolve(root, path)
  if (!existsSync(abs)) {
    rows.push(`MISS  ${'—'.padStart(6)} / ${String(limit).padEnd(6)} ${path}`)
    failures.push(`${path}: budgeted file does not exist (renamed or deleted? update the manifest in the same change)`)
    continue
  }
  const words = countWords(readFileSync(abs, 'utf8'))
  rows.push(`${words <= limit ? 'ok  ' : 'OVER'}  ${String(words).padStart(6)} / ${String(limit).padEnd(6)} ${path}`)
  if (words > limit) {
    failures.push(`${path}: ${words} words exceeds the ${limit}-word ceiling — relocate detail behind a link or condense; raising a ceiling needs a stated reason in the change`)
  }
}

if (listOnly) {
  console.log(rows.join('\n'))
  process.exit(0)
}

if (failures.length > 0) {
  console.error('verify-doc-budgets failed:\n')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`verify-doc-budgets: ${Object.keys(manifest).length} budgeted file(s) within ceiling.`)
