export interface CommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerDate: string;
  parents: string[];
  refs: string[];
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}

export interface CommitFile {
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface RepoInfo {
  rootPath: string;
  currentBranch: string;
  branches: string[];
  remotes: { name: string; url: string }[];
  isDirty: boolean;
}

export type CommitDateMode = 'original' | 'now' | 'custom';

export type PushMode = 'now' | 'relative' | 'absolute';

export type AuthorMode = 'original' | 'self' | 'custom';

export interface AuthorConfig {
  mode: AuthorMode;
  name: string;
  email: string;
}

export type QueueItemStatus = 'queued' | 'armed' | 'live' | 'sent' | 'failed' | 'cancelled';

export interface QueueItem {
  id: string;
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  originalDate: string;

  commitDateMode: CommitDateMode;
  customCommitDate?: string;

  pushMode: PushMode;
  relativeOffsetMinutes?: number;
  pushAt: string;

  status: QueueItemStatus;
  error?: string;
  tempDir?: string;
  attempts: number;
  completedAt?: string;
  replayedSha?: string;
}

export type RunState = 'idle' | 'running' | 'paused' | 'done';

export interface ReplayRun {
  id: string;
  repoPath: string;
  sourceBranch: string;
  targetRepoUrl: string;
  targetBranch: string;
  author: AuthorConfig;
  items: QueueItem[];
  state: RunState;
  createdAt: string;
  manualOrder?: boolean;
  missedPushes?: string[];
  pausedReason?: string;
}

export interface GitHubAccount {
  login: string;
  avatarUrl?: string;
}

export interface GitHubRepoSummary {
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
  isPrivate: boolean;
  isEmpty: boolean;
  defaultBranch: string;
}

export type ConnectionState = 'signed-out' | 'signed-in' | 'unreachable';

export type ToHostMessage =
  | { type: 'READY' }
  | { type: 'LOAD_HISTORY'; branch?: string }
  | { type: 'REFRESH' }
  | { type: 'LOAD_COMMIT_DETAIL'; sha: string }
  | { type: 'SIGN_IN_GITHUB' }
  | { type: 'LIST_GITHUB_REPOS' }
  | { type: 'CREATE_GITHUB_REPO'; name: string; isPrivate: boolean }
  | { type: 'SET_SELECTION'; shas: string[]; options: QueueOptions }
  | { type: 'UPDATE_QUEUE_ITEM'; id: string; patch: Partial<QueueItem> }
  | { type: 'REORDER_QUEUE'; ids: string[] }
  | { type: 'STAGGER_QUEUE'; ids: string[]; startAt: string; minutesBetween: number }
  | { type: 'CLEAR_QUEUE' }
  | { type: 'START_RUN' }
  | { type: 'PAUSE_RUN' }
  | { type: 'CANCEL_RUN' }
  | { type: 'RETRY_ITEM'; id: string }
  | { type: 'REPLAY_COMMIT'; sha: string }
  | { type: 'OPEN_TEMP_DIR'; id: string }
  | { type: 'OPEN_EXTERNAL'; url: string }
  | { type: 'SET_TARGET'; targetRepoUrl: string; targetBranch: string }
  | { type: 'CHECK_TARGET'; targetRepoUrl: string }
  | { type: 'SET_AUTHOR'; author: AuthorConfig }
  | { type: 'LOG'; level: 'info' | 'warn' | 'error'; message: string };

export interface QueueOptions {
  targetRepoUrl: string;
  targetBranch: string;
  commitDateMode: CommitDateMode;
  author: AuthorConfig;
  staggerMinutes: number;
  startAt?: string;
}

export type ToWebviewMessage =
  | { type: 'INIT'; config: WebviewConfig }
  | { type: 'HISTORY'; repo: RepoInfo; commits: CommitInfo[] }
  | { type: 'HISTORY_ERROR'; message: string }
  | { type: 'COMMIT_DETAIL'; sha: string; files: CommitFile[] }
  | { type: 'RUN_STATE'; run: ReplayRun | null }
  | { type: 'REPLAY_PROGRESS'; id: string; sha: string; status: QueueItemStatus; detail?: string }
  | { type: 'GITHUB_SESSION'; account: GitHubAccount | null }
  | { type: 'GITHUB_REPOS'; repos: GitHubRepoSummary[] }
  | { type: 'CONNECTION'; state: ConnectionState; detail?: string }
  | { type: 'LOADING'; scope: string; value: boolean }
  | { type: 'TOAST'; level: 'info' | 'warn' | 'error'; message: string; itemId?: string };

export interface WebviewConfig {
  version: string;
  defaultCommitDateMode: CommitDateMode;
  defaultStaggerMinutes: number;
  author: AuthorConfig;
  targetBranch: string;
  lastTargetRepoUrl: string;
}
