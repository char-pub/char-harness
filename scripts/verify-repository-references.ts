/** Reject maintained references to repository commits and the disallowed organization URL. */

import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonicalReferenceText } from './verify-public-repository-links.ts'

const root = resolve(import.meta.dirname, '..')
const organization = ['deepseek', 'harness'].join('-')
const organizationUrl = new RegExp(`\\bgithub\\.com/${organization}(?![a-z0-9-])`)
// The independent kit repository owns the engine source and documentation.
const kitRepositoryUrl = new RegExp(`\\bgithub\\.com/${organization}/libreoffice-kit(?:\\.git)?(?=/|[^a-zA-Z0-9_.-]|$)`, 'g')
const commitCandidate = /(?<![a-z0-9])[\da-f]{7,40}(?![a-z0-9])/gi
const excludedPrefixes = ['vendor/', '.agents/notes/archived/']
const gitOutputLimit = 64 * 1024 * 1024

/** One prohibited reference in a maintained source file. */
export interface RepositoryReference {
  /** Repository-relative path, with forward slashes. */
  file: string
  /** One-based source line containing the reference. */
  line: number
  /** Whether the line names a repository commit or the disallowed organization URL. */
  kind: 'commit-hash' | 'organization-url'
}

function isMaintained(file: string): boolean {
  return !excludedPrefixes.some(prefix => file.startsWith(prefix))
}

function hasKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function isLedgerTime(value: unknown): boolean {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)
    && !value.startsWith('0000-')
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
}

// V3 writeMeta emits this exact JSON representation. Recognize its machine ledger,
// not a directory-wide documentation exception. Canonical round-trip equality also
// rejects duplicate keys and disguised string tokens before masking values.
function commitReferenceText(file: string, source: string): string {
  if (file !== 'llmdoc/meta.json') return source
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return source
  }
  if (!hasKeys(value, ['schema', 'baseline', 'documents', 'convergence'])
    || value.schema !== 'llmdoc.meta/v3' || `${JSON.stringify(value, null, 2)}\n` !== source) return source
  const { baseline, documents, convergence } = value
  const revision = (input: unknown): input is string => typeof input === 'string' && /^[\da-f]{40}$/.test(input)
  if (!hasKeys(baseline, ['revision', 'verifiedAt']) || !revision(baseline.revision)
    || !isLedgerTime(baseline.verifiedAt)
    || documents === null || typeof documents !== 'object' || Array.isArray(documents)
    || !hasKeys(convergence, ['capturedAt', 'source', 'documentCount', 'totalEstimatedTokens'])
    || !isLedgerTime(convergence.capturedAt)
    || (convergence.source !== 'init' && convergence.source !== 'prune')
    || typeof convergence.documentCount !== 'number' || !Number.isInteger(convergence.documentCount)
    || convergence.documentCount < 0
    || typeof convergence.totalEstimatedTokens !== 'number' || !Number.isInteger(convergence.totalEstimatedTokens)
    || convergence.totalEstimatedTokens < 0) return source
  const entries = Object.values(documents)
  if (!entries.every(entry => hasKeys(entry, ['validatedRevision'])
    && (entry.validatedRevision === null || revision(entry.validatedRevision)))) return source
  baseline.revision = ' '.repeat(40)
  for (const entry of entries) {
    if (hasKeys(entry, ['validatedRevision']) && entry.validatedRevision !== null) {
      entry.validatedRevision = ' '.repeat(40)
    }
  }
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Inspect a maintained source file against known commit identifiers.
 * @param file - Repository-relative path used in diagnostics and exclusions.
 * @param source - File text or a symlink's stored target.
 * @param commits - Lowercase, unambiguous full or abbreviated commit identifiers.
 * @returns One finding per line and reference kind; digests and other Git object types are accepted.
 */
export function findRepositoryReferences(
  file: string,
  source: string,
  commits: ReadonlySet<string>,
): RepositoryReference[] {
  if (!isMaintained(file)) return []
  const references: RepositoryReference[] = []
  const commitLines = commitReferenceText(file, source).split('\n')
  for (const [index, line] of source.split('\n').entries()) {
    if (organizationUrl.test(canonicalReferenceText(line).replace(kitRepositoryUrl, ''))) {
      references.push({ file, line: index + 1, kind: 'organization-url' })
    }
    if ([...(commitLines[index] ?? line).matchAll(commitCandidate)].some(match => commits.has(match[0].toLowerCase()))) {
      references.push({ file, line: index + 1, kind: 'commit-hash' })
    }
  }
  return references
}

function readMaintainedFiles(repoRoot: string): Map<string, string> {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: gitOutputLimit,
  }).split('\0').filter(file => file !== '' && isMaintained(file))
  const sources = new Map<string, string>()
  for (const file of files) {
    const path = resolve(repoRoot, file)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink() === true) sources.set(file, readlinkSync(path))
    else if (stat?.isFile() === true) sources.set(file, readFileSync(path, 'utf8'))
  }
  return sources
}

function repositoryCommits(repoRoot: string, sources: Iterable<string>): Set<string> {
  const candidates = [...new Set([...sources].flatMap(source =>
    [...source.matchAll(commitCandidate)].map(match => match[0].toLowerCase())))]
  if (candidates.length === 0) return new Set()
  const results = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    cwd: repoRoot,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    encoding: 'utf8',
    input: `${candidates.join('\n')}\n`,
    maxBuffer: gitOutputLimit,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trimEnd().split('\n')
  // Git resolves prefixes across all available objects, including unreachable ones.
  // Ambiguous prefixes do not identify one object and cannot establish a commit reference.
  return new Set(candidates.filter((candidate, index) => {
    const [object, type] = results[index]?.split(' ') ?? []
    return type === 'commit' && object?.startsWith(candidate) === true
  }))
}

/**
 * Scan tracked and nonignored new files using only the local Git object database.
 * @param repoRoot - Working tree whose files and Git objects are inspected.
 * @returns Prohibited references outside vendor and frozen Agent Notes; absent shallow-history objects cannot match.
 */
export function scanRepositoryReferences(repoRoot: string): RepositoryReference[] {
  const sources = readMaintainedFiles(repoRoot)
  const commits = repositoryCommits(repoRoot, sources.values())
  return [...sources].flatMap(([file, source]) => findRepositoryReferences(file, source, commits))
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const references = scanRepositoryReferences(root)
  if (references.length === 0) {
    console.log('verify-repository-references: maintained files contain no repository commit identifiers or disallowed organization URLs.')
  } else {
    console.error('verify-repository-references: use release tags or maintained repository links:')
    for (const { file, line, kind } of references) console.error(`  ${file}:${String(line)} ${kind}`)
    process.exitCode = 1
  }
}
