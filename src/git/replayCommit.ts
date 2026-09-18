import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import simpleGit, { SimpleGit } from 'simple-git';
import { redact, withToken } from '../auth/github';
import type { AuthorConfig, CommitDateMode, QueueItem } from '../types';

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const unsafe of ['GIT_EDITOR', 'EDITOR', 'VISUAL', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER']) {
    delete env[unsafe];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return { ...env, ...extra };
}

function gitAt(dir: string, extraEnv: Record<string, string> = {}): SimpleGit {
  return simpleGit({ baseDir: dir }).env(childEnv(extraEnv));
}

export class ReplayError extends Error {
  constructor(
    message: string,
    readonly tempDir?: string,
    override readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ReplayError';
  }
}

export interface ReplaySessionOptions {
  repoPath: string;
  targetRepoUrl: string;
  targetBranch: string;
  author: AuthorConfig;
  getToken: () => Promise<string>;
  log: (message: string) => void;
}

export interface ReplayResult {
  sha: string;
  branch: string;
}

export class ReplaySession {
  private readonly tempRoot: string;
  private targetDir: string | undefined;
  private resolvedBranch: string | undefined;

  constructor(private readonly options: ReplaySessionOptions) {
    this.tempRoot = path.join(os.tmpdir(), `hack-replay-${Date.now().toString(36)}`);
  }

  get workRoot(): string {
    return this.tempRoot;
  }

  private async ensureTarget(): Promise<{ dir: string; branch: string }> {
    if (this.targetDir && this.resolvedBranch) {
      return { dir: this.targetDir, branch: this.resolvedBranch };
    }

    await fsp.mkdir(this.tempRoot, { recursive: true });
    const dir = path.join(this.tempRoot, 'target');
    const token = await this.options.getToken();
    const authedUrl = withToken(this.options.targetRepoUrl, token);

    this.options.log(`Cloning target ${redact(this.options.targetRepoUrl)}...`);
    const bare = gitAt(this.tempRoot);
    try {
      await bare.raw(['clone', '--quiet', authedUrl, dir]);
    } catch (err) {
      throw new ReplayError(
        `Could not clone the target repository ${redact(this.options.targetRepoUrl)}. ` +
          'Check the URL exists and that your GitHub account has push access.',
        undefined,
        err
      );
    }

    const git = gitAt(dir);

    await git.raw(['remote', 'set-url', 'origin', this.options.targetRepoUrl]);

    const branch = await this.checkoutTargetBranch(git);

    this.targetDir = dir;
    this.resolvedBranch = branch;
    return { dir, branch };
  }

  private async checkoutTargetBranch(git: SimpleGit): Promise<string> {
    const requested = this.options.targetBranch.trim();

    let currentHead = '';
    try {
      currentHead = (await git.raw(['symbolic-ref', '--short', 'HEAD'])).trim();
    } catch {
      currentHead = '';
    }

    const branch = requested || currentHead || 'main';

    const hasCommits = await git
      .raw(['rev-parse', '--verify', 'HEAD'])
      .then(() => true)
      .catch(() => false);

    if (!hasCommits) {
      await git.raw(['checkout', '-q', '-B', branch]);
      return branch;
    }

    const localExists = await git
      .raw(['rev-parse', '--verify', `refs/heads/${branch}`])
      .then(() => true)
      .catch(() => false);
    const remoteExists = await git
      .raw(['rev-parse', '--verify', `refs/remotes/origin/${branch}`])
      .then(() => true)
      .catch(() => false);

    if (localExists) {
      await git.raw(['checkout', '-q', branch]);
    } else if (remoteExists) {
      await git.raw(['checkout', '-q', '-b', branch, `refs/remotes/origin/${branch}`]);
    } else {
      await git.raw(['checkout', '-q', '-b', branch]);
    }
    return branch;
  }

  private async extractSnapshot(sha: string): Promise<string> {
    await fsp.mkdir(this.tempRoot, { recursive: true });
    const extractDir = path.join(this.tempRoot, `snapshot-${sha.slice(0, 10)}`);
    await fsp.rm(extractDir, { recursive: true, force: true });

    const git = gitAt(this.options.repoPath);
    try {
      await git.raw(['worktree', 'add', '--detach', '--force', extractDir, sha]);
      return extractDir;
    } catch (worktreeErr) {
      this.options.log(
        `worktree extraction failed for ${sha.slice(0, 7)}, falling back to git archive: ${
          worktreeErr instanceof Error ? worktreeErr.message : String(worktreeErr)
        }`
      );
    }

    await fsp.mkdir(extractDir, { recursive: true });
    const tarPath = path.join(this.tempRoot, `${sha.slice(0, 10)}.tar`);
    try {
      await git.raw(['archive', '--format=tar', '-o', tarPath, sha]);
      const { execFile } = await import('child_process');
      await new Promise<void>((resolve, reject) => {
        execFile('tar', ['-xf', tarPath, '-C', extractDir], (err) =>
          err ? reject(err) : resolve()
        );
      });
      return extractDir;
    } finally {
      await fsp.rm(tarPath, { force: true });
    }
  }

  private async releaseSnapshot(extractDir: string): Promise<void> {
    const git = gitAt(this.options.repoPath);
    try {
      await git.raw(['worktree', 'remove', '--force', extractDir]);
    } catch {
      await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
    }
    await git.raw(['worktree', 'prune']).catch(() => undefined);
  }

  async replay(item: QueueItem, keepTempOnFailure: boolean): Promise<ReplayResult> {
    const { dir: targetDir, branch } = await this.ensureTarget();
    let extractDir: string | undefined;

    try {
      extractDir = await this.extractSnapshot(item.sha);

      await mirrorDirectory(extractDir, targetDir);

      const git = gitAt(targetDir);

      await git.raw(['add', '-A']);

      const stamp = resolveCommitDate(item);
      const identity = await this.resolveIdentity(item);

      const messageFile = path.join(this.tempRoot, `message-${item.sha.slice(0, 10)}.txt`);
      await fsp.writeFile(messageFile, await this.readMessage(item), 'utf8');

      await gitAt(targetDir, {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_AUTHOR_DATE: stamp,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
        GIT_COMMITTER_DATE: stamp,
      }).raw([
        'commit',
        '--allow-empty',
        '--allow-empty-message',
        '--no-verify',
        '--cleanup=verbatim',
        '--file',
        messageFile,
      ]);
      await fsp.rm(messageFile, { force: true });

      const newSha = (await git.raw(['rev-parse', 'HEAD'])).trim();

      const token = await this.options.getToken();
      const authedUrl = withToken(this.options.targetRepoUrl, token);
      this.options.log(`Pushing ${item.shortSha} -> ${branch} as ${newSha.slice(0, 7)}`);
      try {
        await git.raw(['push', authedUrl, `HEAD:refs/heads/${branch}`]);
      } catch (pushErr) {
        const message = pushErr instanceof Error ? pushErr.message : String(pushErr);

        await git.raw(['reset', '--hard', 'HEAD~1']).catch(() => undefined);
        throw new ReplayError(
          describePushFailure(message, this.options.targetRepoUrl),
          keepTempOnFailure ? this.tempRoot : undefined,
          pushErr
        );
      }

      return { sha: newSha, branch };
    } catch (err) {
      if (err instanceof ReplayError) {
        throw err;
      }
      throw new ReplayError(
        err instanceof Error ? err.message : String(err),
        keepTempOnFailure ? this.tempRoot : undefined,
        err
      );
    } finally {
      if (extractDir) {
        await this.releaseSnapshot(extractDir);
      }
    }
  }

  private async resolveIdentity(item: QueueItem): Promise<{ name: string; email: string }> {
    const author = this.options.author;

    if (author.mode === 'custom') {
      const name = author.name.trim();
      const email = author.email.trim();
      if (!name || !email) {
        throw new ReplayError(
          'The custom author needs both a name and an email address. Set them on the SETUP tab.'
        );
      }
      return { name, email };
    }

    if (author.mode === 'original' && item.authorName && item.authorEmail) {
      return { name: item.authorName, email: item.authorEmail };
    }

    const git = gitAt(this.options.repoPath);
    const read = (key: string) =>
      git
        .raw(['config', '--get', key])
        .then((value) => value.trim())
        .catch(() => '');
    const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
    if (!name || !email) {
      throw new ReplayError(
        'No git identity is configured. Run git config user.name and user.email, or pick a different author on the SETUP tab.'
      );
    }
    return { name, email };
  }

  private async readMessage(item: QueueItem): Promise<string> {
    try {
      const raw = await gitAt(this.options.repoPath).raw(['log', '-1', '--format=%B', item.sha]);

      const message = raw.replace(/\n$/, '');
      return message.trim() ? message : item.subject || item.shortSha;
    } catch {
      return item.subject || item.shortSha;
    }
  }

  async dispose(): Promise<void> {
    this.targetDir = undefined;
    this.resolvedBranch = undefined;
    if (fs.existsSync(this.tempRoot)) {
      await fsp.rm(this.tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function resolveCommitDate(item: {
  commitDateMode: CommitDateMode;
  customCommitDate?: string;
  originalDate: string;
}): string {
  switch (item.commitDateMode) {
    case 'original':
      return item.originalDate;
    case 'custom':
      return item.customCommitDate || new Date().toISOString();
    case 'now':
    default:
      return new Date().toISOString();
  }
}

async function mirrorDirectory(src: string, dest: string): Promise<void> {
  for (const entry of await fsp.readdir(dest)) {
    if (entry === '.git') {
      continue;
    }
    await fsp.rm(path.join(dest, entry), { recursive: true, force: true });
  }
  for (const entry of await fsp.readdir(src)) {
    if (entry === '.git') {
      continue;
    }
    await fsp.cp(path.join(src, entry), path.join(dest, entry), {
      recursive: true,
      force: true,

      verbatimSymlinks: true,
    });
  }
}

function describePushFailure(message: string, targetUrl: string): string {
  const url = redact(targetUrl);
  if (/non-fast-forward|fetch first|rejected/i.test(message)) {
    return (
      `Push to ${url} was rejected because the remote has commits this replay does not. ` +
      'Pull or pick an empty branch, then retry.'
    );
  }
  if (/Authentication failed|403|could not read Username|Permission to .* denied/i.test(message)) {
    return `GitHub rejected the push to ${url}. Re-authenticate (the "repo" scope is required) and retry.`;
  }
  if (/Could not resolve host|network|timed out|Connection reset/i.test(message)) {
    return `Network error while pushing to ${url}. Check your connection and retry.`;
  }
  if (/repository .* not found|404/i.test(message)) {
    return `The target repository ${url} was not found, or your account cannot push to it.`;
  }
  return `Push to ${url} failed: ${message.split('\n').slice(0, 4).join(' ').trim()}`;
}
