/**
 * Report the explicit committed and worktree scope of a change as JSON.
 * Ported from DeepSeek Harness `scripts/change-scope.ts`; the report format
 * is unchanged. The command never guesses or fetches a base: pass the verified
 * PR base or stack parent with `--base`; `--head` defaults to HEAD.
 *
 * Run: npx tsx <skill-dir>/scripts/change-scope.ts --base <ref> [--head <ref>]
 */
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const FORMAT_VERSION = 1
const MAX_GIT_OUTPUT = 64 * 1024 * 1024
const UTF8 = new TextDecoder('utf-8', { fatal: true })

interface ChangeScopeReport {
  formatVersion: typeof FORMAT_VERSION
  repositoryRoot: string
  input: { base: string, head: string }
  resolved: { baseSha: string, headSha: string, mergeBaseSha: string }
  paths: { committed: string[], staged: string[], unstaged: string[], untracked: string[] }
}

function gitBytes(cwd: string, args: string[]): { status: number | null, stdout: Buffer, stderr: Buffer, error: Error | undefined } {
  const result = spawnSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LANG: 'C', LC_ALL: 'C' },
    maxBuffer: MAX_GIT_OUTPUT,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error }
}

function decode(output: Buffer, context: string): string {
  try {
    return UTF8.decode(output)
  } catch {
    throw new Error(`${context}: Git output is not valid UTF-8`)
  }
}

function git(cwd: string, args: string[], context: string): { status: number | null, stdout: string, stderr: string, error: Error | undefined } {
  const result = gitBytes(cwd, args)
  return { status: result.status, stdout: decode(result.stdout, context), stderr: decode(result.stderr, context), error: result.error }
}

function detail(result: { error: Error | undefined, stderr: string, status: number | null }): string {
  return result.error?.message ?? (result.stderr.trim() || `Git exited with status ${String(result.status)}`)
}

function requireGit(cwd: string, args: string[], context: string): string {
  const result = git(cwd, args, context)
  if (result.status !== 0) throw new Error(`${context}: ${detail(result)}`)
  return result.stdout
}

function requireGitBytes(cwd: string, args: string[], context: string): Buffer {
  const result = gitBytes(cwd, args)
  if (result.status !== 0) {
    throw new Error(`${context}: ${result.error?.message ?? (result.stderr.toString('utf8').trim() || `Git exited with status ${String(result.status)}`)}`)
  }
  return result.stdout
}

function resolveCommit(root: string, label: 'base' | 'head', ref: string): string {
  const context = `cannot resolve ${label} ref ${JSON.stringify(ref)}`
  const result = git(root, ['-c', 'core.warnAmbiguousRefs=true', 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], context)
  if (/\bambiguous\b/iu.test(result.stderr)) throw new Error(`${label} ref ${JSON.stringify(ref)} is ambiguous; use a fully qualified ref or commit ID`)
  if (result.status !== 0) throw new Error(`${label} ref ${JSON.stringify(ref)} does not resolve to a commit: ${detail(result)}`)
  const commits = result.stdout.trim().split(/\r?\n/u).filter(Boolean)
  if (commits.length !== 1) throw new Error(`${label} ref ${JSON.stringify(ref)} did not resolve to exactly one commit`)
  return commits[0] as string
}

function resolveMergeBase(root: string, baseSha: string, headSha: string): string {
  const result = git(root, ['merge-base', '--all', baseSha, headSha], 'cannot resolve the merge base')
  if (result.status !== 0) throw new Error(`base and head do not have a merge base: ${detail(result)}`)
  const bases = result.stdout.trim().split(/\r?\n/u).filter(Boolean)
  if (bases.length !== 1) throw new Error(`base and head do not have a unique merge base; found ${bases.length}`)
  return bases[0] as string
}

function parsePathSet(output: Buffer, context: string): string[] {
  const paths: string[] = []
  let start = 0
  for (let end = 0; end < output.length; end += 1) {
    if (output[end] !== 0) continue
    if (end > start) {
      try {
        paths.push(UTF8.decode(output.subarray(start, end)))
      } catch {
        throw new Error(`${context}: a Git path is not valid UTF-8`)
      }
    }
    start = end + 1
  }
  return [...new Set(paths)].sort()
}

function diffPaths(root: string, args: string[], context: string): string[] {
  return parsePathSet(requireGitBytes(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none', '--name-only', '-z', ...args, '--'], context), context)
}

function collect(base: string, head: string, cwd: string): ChangeScopeReport {
  const root = requireGit(cwd, ['rev-parse', '--show-toplevel'], 'cannot locate a Git worktree').replace(/\r?\n$/u, '')
  const baseSha = resolveCommit(root, 'base', base)
  const headSha = resolveCommit(root, 'head', head)
  const mergeBaseSha = resolveMergeBase(root, baseSha, headSha)
  return {
    formatVersion: FORMAT_VERSION,
    repositoryRoot: root,
    input: { base, head },
    resolved: { baseSha, headSha, mergeBaseSha },
    paths: {
      committed: diffPaths(root, [mergeBaseSha, headSha], 'cannot inspect committed paths'),
      staged: diffPaths(root, ['--cached'], 'cannot inspect staged paths'),
      unstaged: diffPaths(root, [], 'cannot inspect unstaged paths'),
      untracked: parsePathSet(requireGitBytes(root, ['ls-files', '--others', '--exclude-standard', '-z', '--'], 'cannot inspect untracked paths'), 'cannot inspect untracked paths'),
    },
  }
}

try {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: false,
    options: { base: { type: 'string' }, head: { type: 'string', default: 'HEAD' } },
    strict: true,
  })
  if (values.base === undefined) throw new Error('missing required --base <ref>')
  process.stdout.write(`${JSON.stringify(collect(values.base, values.head, process.cwd()), null, 2)}\n`)
} catch (error) {
  process.stderr.write(`change-scope: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
