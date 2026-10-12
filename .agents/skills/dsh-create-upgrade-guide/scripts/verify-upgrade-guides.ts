/**
 * Enforce the `docs/upgrade-guide/v<version>/<item>/guide.md` layout, frontmatter,
 * sections, and word ceiling defined by the dsh-create-upgrade-guide skill.
 * Zero-dependency port of DeepSeek Harness `scripts/verify-upgrade-guides.ts`
 * (regex frontmatter and heading scan in place of js-yaml/mdast; no Chinese
 * sibling or pairing record — the host is monolingual).
 *
 * Root: `docs/upgrade-guide` under the host root (cwd), or `AGENT_UPGRADE_GUIDES`.
 * An absent tree passes. Section headings accept English or Chinese forms.
 *
 * Run: npx tsx <skill-dir>/scripts/verify-upgrade-guides.ts
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = process.cwd()
const GUIDE_ROOT = process.env.AGENT_UPGRADE_GUIDES ?? 'docs/upgrade-guide'
const MAX_WORDS = 500
const SECTIONS: readonly (readonly string[])[] = [['Change', '变更'], ['Migration', '迁移']]
const SEMVER = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`
const GUIDE_PATH = new RegExp(`^v${SEMVER}/[a-z0-9]+(?:-[a-z0-9]+)*/guide\\.md$`, 'u')

function countWords(text: string): number {
  const tokens = text.split(/\s+/u).filter(Boolean).length
  const cjk = (text.match(/\p{Script=Han}/gu) ?? []).length
  return Math.max(tokens, cjk)
}

/** Parse the two-key frontmatter without a YAML library: `kind: upgrade-guide` and a quoted or bare one-line `description`. */
function parseFrontmatter(block: string): Record<string, string> | null {
  const fields: Record<string, string> = {}
  for (const line of block.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/u.exec(line)
    if (match === null) return null
    const value = (match[2] ?? '').trim()
    fields[match[1] as string] = /^(["']).*\1$/u.test(value) ? value.slice(1, -1) : value
  }
  return fields
}

function guideViolations(source: string): string[] {
  const violations: string[] = []
  const words = countWords(source)
  if (words > MAX_WORDS) violations.push(`${String(words)} words exceeds the ${String(MAX_WORDS)}-word ceiling`)

  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(source)
  if (frontmatter === null) return [...violations, 'must start with YAML frontmatter']
  const fields = parseFrontmatter(frontmatter[1] as string)
  if (fields === null) return [...violations, 'frontmatter must be flat `key: value` lines']
  const keys = Object.keys(fields).sort()
  if (keys.join() !== 'description,kind') violations.push(`frontmatter keys must be exactly description, kind; got ${keys.join(', ') || 'none'}`)
  if (fields.kind !== 'upgrade-guide') violations.push('kind must be upgrade-guide')
  if ((fields.description ?? '').trim() === '') violations.push('description must be a non-empty string')

  const body = source.slice(frontmatter[0].length).replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gmu, '')
  const outline = [...body.matchAll(/^ {0,3}(#{1,2})[ \t]+(.+?)[ \t]*$/gmu)].map(m => [m[1] as string, (m[2] as string).trim()] as const)
  const expected = SECTIONS.map(names => names.map(n => `## ${n}`).join(' | '))
  const ok = outline.length === SECTIONS.length + 1
    && outline[0]?.[0] === '#'
    && outline.slice(1).every(([depth, text], index) => depth === '##' && (SECTIONS[index] as readonly string[]).includes(text))
  if (!ok) {
    violations.push(`headings must be one "#" title followed by ${expected.map(h => `"${h}"`).join(', ')}; got ${outline.map(([d, t]) => `"${d} ${t}"`).join(', ') || 'none'}`)
  }
  return violations
}

const directory = resolve(root, GUIDE_ROOT)
const violations: string[] = []
if (existsSync(directory)) {
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => !entry.isDirectory())
    .map(entry => join(entry.parentPath ?? entry.path, entry.name).slice(directory.length + 1).replaceAll('\\', '/'))
    .sort()
  for (const file of files) {
    const path = `${GUIDE_ROOT}/${file}`
    if (!GUIDE_PATH.test(file)) {
      violations.push(`${path}: only v<semver>/<kebab-case-item>/guide.md files belong in ${GUIDE_ROOT}`)
      continue
    }
    for (const violation of guideViolations(readFileSync(join(directory, file), 'utf8'))) violations.push(`${path}: ${violation}`)
  }
}

if (violations.length > 0) {
  console.error('verify-upgrade-guides: violations found (see .agents/skills/dsh-create-upgrade-guide/SKILL.md):')
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log(`verify-upgrade-guides: upgrade guides conform${existsSync(directory) ? '' : ' (no docs/upgrade-guide tree yet)'}.`)
