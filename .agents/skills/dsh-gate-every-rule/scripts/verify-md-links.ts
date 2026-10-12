/**
 * Verify that relative Markdown links, images, and reference definitions
 * resolve: the target file must exist, and a `#fragment` onto a Markdown
 * target (including a same-file `#anchor`) must name a real heading slug or an
 * explicit `<a id>`. Scheme URLs and root-absolute paths are not checked.
 *
 * A zero-dependency port of DeepSeek Harness `scripts/verify-md-links.ts`
 * (regex scanning in place of the mdast parser). Scans every `.md` under the
 * host root (cwd) except `node_modules`, `.git`, `vendor`, `dist`, `build`,
 * and `.agents/notes/archived` (frozen; links *into* it are still checked).
 * `AGENT_MD_LINKS_EXCLUDE` adds comma-separated path prefixes to skip.
 *
 * Run: npx tsx <skill-dir>/scripts/verify-md-links.ts [root-relative dirs...]
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

const root = process.cwd()
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'coverage'])
const SKIP_PREFIXES = ['.agents/notes/archived/', ...(process.env.AGENT_MD_LINKS_EXCLUDE ?? '').split(',').map(s => s.trim()).filter(Boolean)]

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

function listMarkdown(dir: string, out: string[], seen: Set<string>): void {
  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    // A dangling symlink or unreadable directory contributes no sources.
    return
  }
  if (seen.has(real)) return
  seen.add(real)
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name)
    const rel = toPosix(relative(root, abs))
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (SKIP_PREFIXES.some(prefix => `${rel}/`.startsWith(prefix))) continue
      // A skill's templates/ holds scaffolds with placeholder links, not documents.
      if (entry.name === 'templates' && existsSync(resolve(dir, 'SKILL.md'))) continue
      listMarkdown(abs, out, seen)
    } else if (entry.name.endsWith('.md')) {
      if (SKIP_PREFIXES.some(prefix => rel.startsWith(prefix))) continue
      // Instruction symlinks (CLAUDE.md -> AGENTS.md) are checked once, under whichever name is listed first.
      let target: string
      try {
        target = realpathSync(abs)
      } catch {
        // A dangling symlink is reported by the link check of whoever links to it.
        continue
      }
      if (seen.has(target)) continue
      seen.add(target)
      out.push(abs)
    }
  }
}

/** True for targets this gate must not check: scheme URLs, protocol-relative, root-absolute. */
function isExternal(url: string): boolean {
  return url.startsWith('//') || url.startsWith('/') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)
}

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    // A malformed percent-escape names no file; the raw text is reported broken.
    return raw
  }
}

function pathPart(url: string): string {
  return decode(url.replace(/[#?].*$/, ''))
}

function fragmentPart(url: string): string | null {
  const hash = url.indexOf('#')
  return hash === -1 ? null : decode(url.slice(hash + 1).replace(/\?.*$/, ''))
}

/** GitHub's heading-slug algorithm: lowercase; keep letters, numbers, `_`, space, `-`; spaces become hyphens. */
export function githubSlug(heading: string): string {
  return heading.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replaceAll(' ', '-')
}

/** Strip fenced code blocks so headings and links inside samples do not count. */
function withoutFences(source: string): string {
  return source.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gmu, '')
}

/** Rendered heading text: links keep their label, inline code keeps its text, emphasis markers drop. */
function renderHeading(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_~]+/g, '')
    .replace(/\s+#+\s*$/, '')
    .trim()
}

/** Every anchor a document exposes: heading slugs with GitHub's `-1`, `-2` collision suffixes, plus explicit `<a id>`. */
export function documentAnchors(source: string): Set<string> {
  const anchors = new Set<string>()
  const occurrences = new Map<string, number>()
  const body = withoutFences(source)
  for (const match of body.matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*$/gmu)) {
    const base = githubSlug(renderHeading(match[1] ?? ''))
    let result = base
    let bump = occurrences.get(base) ?? 0
    while (anchors.has(result)) {
      bump += 1
      result = `${base}-${bump}`
    }
    occurrences.set(base, bump)
    anchors.add(result)
  }
  for (const match of body.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<a\s+id="([^"]+)"/g)) anchors.add(match[1] ?? '')
  return anchors
}

interface Violation {
  file: string
  line: number
  url: string
  reason: 'target' | 'anchor'
}

const anchorCache = new Map<string, Set<string>>()
function anchorsOf(abs: string): Set<string> {
  let hit = anchorCache.get(abs)
  if (hit === undefined) {
    hit = documentAnchors(readFileSync(abs, 'utf8'))
    anchorCache.set(abs, hit)
  }
  return hit
}

/** Inline links/images `[x](url "title")`, and reference definitions `[x]: url`. */
const INLINE = /!?\[(?:[^\[\]]|\[[^\]]*\])*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g
const DEFINITION = /^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm

export function findViolations(abs: string): Violation[] {
  const file = toPosix(relative(root, abs))
  const dir = dirname(abs)
  const source = withoutFences(readFileSync(abs, 'utf8'))
  const out: Violation[] = []
  const lineOf = (offset: number): number => source.slice(0, offset).split('\n').length

  const check = (url: string, offset: number): void => {
    if (isExternal(url) || url.includes('…')) return
    const target = pathPart(url)
    const resolved = target === '' ? abs : resolve(dir, target)
    if (!existsSync(resolved)) {
      out.push({ file, line: lineOf(offset), url, reason: 'target' })
      return
    }
    const fragment = fragmentPart(url)
    if (fragment === null || !resolved.endsWith('.md') || !statSync(resolved).isFile()) return
    if (!anchorsOf(resolved).has(fragment)) out.push({ file, line: lineOf(offset), url, reason: 'anchor' })
  }

  for (const match of source.matchAll(INLINE)) check(match[1] ?? '', match.index ?? 0)
  for (const match of source.matchAll(DEFINITION)) check(match[1] ?? '', match.index ?? 0)
  return out
}

const dirs = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const files: string[] = []
const seen = new Set<string>()
for (const dir of dirs.length > 0 ? dirs.map(d => resolve(root, d)) : [root]) listMarkdown(dir, files, seen)

const all = files.sort().flatMap(findViolations)
if (all.length === 0) {
  console.log(`verify-md-links: ${files.length} file(s) checked, all relative links and fragments resolve.`)
  process.exit(0)
}
console.error('verify-md-links: broken relative links found:')
for (const v of all) {
  console.error(`  ${v.file}:${v.line}  ${v.url}  (${v.reason === 'target' ? 'target does not exist' : 'no such anchor in target'})`)
}
process.exit(1)
