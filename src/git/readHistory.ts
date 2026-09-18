import * as fs from 'fs';
import * as path from 'path';
import simpleGit, { SimpleGit } from 'simple-git';
import type { CommitFile, CommitInfo, RepoInfo } from '../types';

const FIELD = '\x1f';
const RECORD = '\x1e';

const LOG_FORMAT = [
  '%H',
  '%h',
  '%P',
  '%an',
  '%ae',
  '%aI',
  '%cI',
  '%D',
  '%s',
  '%b',
].join(FIELD);

export class GitNotAvailableError extends Error {}
export class NotARepositoryError extends Error {}

export async function createGit(repoPath: string): Promise<SimpleGit> {
  const git = simpleGit({ baseDir: repoPath, maxConcurrentProcesses: 4, trimmed: false });
  try {
    await git.raw(['--version']);
  } catch (err) {
    throw new GitNotAvailableError(
      'git was not found on your PATH. Install git (or add it to PATH) and reload VS Code.'
    );
  }
  return git;
}

export function findRepoRoot(startPath: string): string | null {
  let current = path.resolve(startPath);

  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export async function readRepoInfo(repoPath: string): Promise<RepoInfo> {
  const git = await createGit(repoPath);

  let root: string;
  try {
    root = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new NotARepositoryError(`${repoPath} is not inside a git repository.`);
  }

  const [branchSummary, remoteRaw, statusRaw] = await Promise.all([
    git.branchLocal(),
    git.raw(['remote', '-v']).catch(() => ''),
    git.raw(['status', '--porcelain']).catch(() => ''),
  ]);

  const remotes: { name: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const line of remoteRaw.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (match && !seen.has(match[1])) {
      seen.add(match[1]);
      remotes.push({ name: match[1], url: match[2] });
    }
  }

  return {
    rootPath: root,
    currentBranch: branchSummary.current || 'HEAD',
    branches: branchSummary.all,
    remotes,
    isDirty: statusRaw.trim().length > 0,
  };
}

export interface ReadHistoryOptions {
  branch?: string;
  maxCount?: number;
  withStats?: boolean;
}

export async function readHistory(
  repoPath: string,
  options: ReadHistoryOptions = {}
): Promise<CommitInfo[]> {
  const git = await createGit(repoPath);
  const maxCount = options.maxCount ?? 500;

  const args = [
    'log',
    `--max-count=${maxCount}`,
    `--format=${LOG_FORMAT}${RECORD}`,
    '--date-order',
  ];
  if (options.branch) {
    args.push(options.branch);
  }
  args.push('--');

  let raw: string;
  try {
    raw = await git.raw(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/does not have any commits yet|unknown revision/i.test(message)) {
      return [];
    }
    throw err;
  }

  const commits: CommitInfo[] = [];
  for (const record of raw.split(RECORD)) {
    const trimmed = record.replace(/^\n+/, '');
    if (!trimmed.trim()) {
      continue;
    }
    const fields = trimmed.split(FIELD);
    if (fields.length < 10) {
      continue;
    }
    const [sha, shortSha, parentsRaw, authorName, authorEmail, authorDate, committerDate, refsRaw, subject, body] =
      fields;

    commits.push({
      sha,
      shortSha,
      parents: parentsRaw.trim() ? parentsRaw.trim().split(/\s+/) : [],
      authorName,
      authorEmail,
      authorDate,
      committerDate,
      refs: refsRaw
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean),
      subject,
      body: body.trimEnd(),
    });
  }

  if (options.withStats) {
    await attachStats(git, commits);
  }

  return commits;
}

export async function readCommitFiles(repoPath: string, sha: string): Promise<CommitFile[]> {
  const git = await createGit(repoPath);

  const raw = await git.raw(['show', '--numstat', '--format=', '--no-renames', sha, '--']);

  const files: CommitFile[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const [added, removed, ...pathParts] = line.split('\t');
    const filePath = pathParts.join('\t');
    if (!filePath) {
      continue;
    }
    const binary = added === '-' || removed === '-';
    files.push({
      path: filePath,
      insertions: binary ? 0 : Number(added) || 0,
      deletions: binary ? 0 : Number(removed) || 0,
      binary,
    });
  }
  return files;
}

async function attachStats(git: SimpleGit, commits: CommitInfo[]): Promise<void> {
  if (commits.length === 0) {
    return;
  }
  try {
    const raw = await git.raw([
      'log',
      `--max-count=${commits.length}`,
      `--format=${RECORD}%H`,
      '--shortstat',
      commits[0].sha,
      '--',
    ]);
    const bySha = new Map(commits.map((c) => [c.sha, c]));
    for (const chunk of raw.split(RECORD)) {
      if (!chunk.trim()) {
        continue;
      }
      const [shaLine, ...rest] = chunk.split('\n');
      const commit = bySha.get(shaLine.trim());
      if (!commit) {
        continue;
      }
      const statLine = rest.join(' ');
      commit.filesChanged = numberAfter(statLine, /(\d+) files? changed/);
      commit.insertions = numberAfter(statLine, /(\d+) insertions?/);
      commit.deletions = numberAfter(statLine, /(\d+) deletions?/);
    }
  } catch {}
}

function numberAfter(text: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : undefined;
}
