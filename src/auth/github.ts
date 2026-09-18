import * as vscode from 'vscode';
import type { GitHubAccount, GitHubRepoSummary } from '../types';

const SCOPES = ['repo'];
const API = 'https://api.github.com';

export class GitHubAuth {
  private session: vscode.AuthenticationSession | undefined;

  async getSession(createIfNone: boolean): Promise<vscode.AuthenticationSession | undefined> {
    try {
      this.session = await vscode.authentication.getSession('github', SCOPES, { createIfNone });
    } catch {
      this.session = undefined;
    }
    return this.session;
  }

  async getAccount(createIfNone = false): Promise<GitHubAccount | null> {
    const session = await this.getSession(createIfNone);
    if (!session) {
      return null;
    }
    return { login: session.account.label };
  }

  async getToken(): Promise<string> {
    const session = await this.getSession(true);
    if (!session) {
      throw new Error('GitHub sign-in was cancelled. Hack Replay needs GitHub access to push.');
    }
    return session.accessToken;
  }

  private async api<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const token = await this.getToken();
    const response = await fetch(`${API}${pathname}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`GitHub API ${response.status} on ${pathname}: ${truncate(text, 300)}`);
    }
    return (await response.json()) as T;
  }

  async listRepos(): Promise<GitHubRepoSummary[]> {
    const raw = await this.api<GitHubApiRepo[]>(
      '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'
    );
    return raw
      .filter((repo) => repo.permissions?.push !== false)
      .map(toRepoSummary);
  }

  async createRepo(name: string, isPrivate: boolean): Promise<GitHubRepoSummary> {
    const raw = await this.api<GitHubApiRepo>('/user/repos', {
      method: 'POST',
      body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
    });
    return toRepoSummary(raw);
  }

  async getRepo(fullName: string): Promise<GitHubRepoSummary | null> {
    try {
      return toRepoSummary(await this.api<GitHubApiRepo>(`/repos/${fullName}`));
    } catch (err) {
      if (err instanceof Error && /\b404\b/.test(err.message)) {
        return null;
      }
      throw err;
    }
  }
}

interface GitHubApiRepo {
  full_name: string;
  clone_url: string;
  html_url: string;
  private: boolean;
  size: number;
  default_branch: string;
  permissions?: { push?: boolean };
}

function toRepoSummary(repo: GitHubApiRepo): GitHubRepoSummary {
  return {
    fullName: repo.full_name,
    cloneUrl: repo.clone_url,
    htmlUrl: repo.html_url,
    isPrivate: repo.private,

    isEmpty: repo.size === 0,
    defaultBranch: repo.default_branch || 'main',
  };
}

export function withToken(url: string, token: string): string {
  const normalized = normalizeGitHubUrl(url);
  return normalized.replace(/^https:\/\//, `https://x-access-token:${token}@`);
}

export function normalizeGitHubUrl(input: string): string {
  const value = input.trim().replace(/\/+$/, '');
  if (/^https?:\/\//.test(value)) {
    return value.endsWith('.git') ? value : `${value}.git`;
  }
  const sshMatch = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(value);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}.git`;
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) {
    return `https://github.com/${value}.git`;
  }
  return value;
}

export function toFullName(url: string): string | null {
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(normalizeGitHubUrl(url));
  return match ? `${match[1]}/${match[2]}` : null;
}

export function redact(url: string): string {
  return url.replace(/\/\/[^@/]+@/, '//');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
