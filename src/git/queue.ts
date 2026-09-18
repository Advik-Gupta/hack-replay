import * as vscode from 'vscode';
import { GitHubAuth } from '../auth/github';
import { ReplayError, ReplaySession } from './replayCommit';
import type { CommitInfo, QueueItem, QueueOptions, ReplayRun, RunState } from '../types';

const STATE_KEY = 'hackReplay.run.v3';
const MAX_TIMEOUT = 2_147_483_000;

export interface SchedulerEvent {
  run: ReplayRun | null;
  changedItemId?: string;
  detail?: string;
}

const EDITABLE: QueueItem['status'][] = ['queued', 'armed', 'failed', 'cancelled'];

export class ReplayScheduler implements vscode.Disposable {
  private current: ReplayRun | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  private session: ReplaySession | undefined;
  private chain: Promise<void> = Promise.resolve();

  private readonly emitter = new vscode.EventEmitter<SchedulerEvent>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly auth: GitHubAuth,
    private readonly log: (message: string) => void
  ) {
    this.current = this.context.globalState.get<ReplayRun>(STATE_KEY) ?? null;
  }

  get run(): ReplayRun | null {
    return this.current;
  }

  async syncSelection(
    repoPath: string,
    sourceBranch: string,
    commits: CommitInfo[],
    options: QueueOptions
  ): Promise<ReplayRun | null> {
    const selected = new Map(commits.map((c) => [c.sha, c]));

    if (!this.current) {
      this.current = {
        id: `run-${Date.now().toString(36)}`,
        repoPath,
        sourceBranch,
        targetRepoUrl: options.targetRepoUrl,
        targetBranch: options.targetBranch,
        author: options.author,
        items: [],
        state: 'idle',
        createdAt: new Date().toISOString(),
      };
    }

    const run = this.current;
    run.repoPath = repoPath;
    run.sourceBranch = sourceBranch;
    run.targetRepoUrl = options.targetRepoUrl;
    run.targetBranch = options.targetBranch;
    run.author = options.author;

    const kept: QueueItem[] = [];
    for (const item of run.items) {
      const stillSelected = selected.has(item.sha);
      const isHistory = item.status === 'sent' || item.status === 'live' || item.status === 'failed';
      if (stillSelected || isHistory) {
        kept.push(item);
      } else {
        this.clearTimer(item.id);
      }
    }

    const present = new Set(kept.map((i) => i.sha));
    const additions = commits
      .filter((c) => !present.has(c.sha))
      .sort((a, b) => Date.parse(a.authorDate) - Date.parse(b.authorDate))
      .map((commit, index) => this.createItem(commit, options, kept.length + index));

    run.items = [...kept, ...additions];

    if (!run.manualOrder) {
      run.items.sort((a, b) => Date.parse(a.originalDate) - Date.parse(b.originalDate));
    }

    this.recomputeRelativePushTimes();
    if (run.state === 'running') {
      for (const item of this.pendingItems()) {
        this.armTimer(item);
      }
    }

    await this.persist();
    return this.current;
  }

  private createItem(commit: CommitInfo, options: QueueOptions, position: number): QueueItem {
    return {
      id: `${commit.sha.slice(0, 12)}-${Date.now().toString(36)}-${position}`,
      sha: commit.sha,
      shortSha: commit.shortSha,
      subject: commit.subject,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      originalDate: commit.authorDate,
      commitDateMode: options.commitDateMode,
      pushMode: 'relative',
      relativeOffsetMinutes: Math.max(0, options.staggerMinutes),
      pushAt: new Date().toISOString(),
      status: 'queued',
      attempts: 0,
    };
  }

  async updateItem(id: string, patch: Partial<QueueItem>): Promise<void> {
    if (!this.current) {
      return;
    }
    const item = this.current.items.find((i) => i.id === id);
    if (!item || !EDITABLE.includes(item.status)) {
      return;
    }
    Object.assign(item, patch);
    this.recomputeRelativePushTimes();
    if (this.current.state === 'running') {
      this.armTimer(item);
    }
    await this.persist(id);
  }

  async removeItem(id: string): Promise<void> {
    if (!this.current) {
      return;
    }
    this.clearTimer(id);
    this.current.items = this.current.items.filter((i) => i.id !== id);
    this.recomputeRelativePushTimes();
    await this.persist();
  }

  async reorder(ids: string[]): Promise<void> {
    if (!this.current) {
      return;
    }
    const byId = new Map(this.current.items.map((i) => [i.id, i]));
    const reordered: QueueItem[] = [];
    for (const id of ids) {
      const item = byId.get(id);
      if (item) {
        reordered.push(item);
        byId.delete(id);
      }
    }

    this.current.items = [...reordered, ...byId.values()];
    this.current.manualOrder = true;
    this.recomputeRelativePushTimes();
    if (this.current.state === 'running') {
      for (const item of this.pendingItems()) {
        this.armTimer(item);
      }
    }
    await this.persist();
  }

  async stagger(ids: string[], startAt: string, minutesBetween: number): Promise<void> {
    if (!this.current) {
      return;
    }
    const start = Date.parse(startAt);
    const gapMs = Math.max(0, minutesBetween) * 60_000;
    let index = 0;
    for (const id of ids) {
      const item = this.current.items.find((i) => i.id === id);
      if (!item || !EDITABLE.includes(item.status)) {
        continue;
      }
      item.pushMode = index === 0 ? 'absolute' : 'relative';
      item.relativeOffsetMinutes = index === 0 ? undefined : minutesBetween;
      item.pushAt = new Date(start + index * gapMs).toISOString();
      if (this.current.state === 'running') {
        this.armTimer(item);
      }
      index += 1;
    }
    await this.persist();
  }

  private recomputeRelativePushTimes(): void {
    if (!this.current) {
      return;
    }
    let previous = Date.now();
    let isFirstPending = true;
    for (const item of this.current.items) {
      if (item.status === 'sent' || item.status === 'cancelled' || item.status === 'live') {
        previous = Date.parse(item.completedAt ?? item.pushAt) || previous;
        isFirstPending = false;
        continue;
      }
      if (item.pushMode === 'now') {
        item.pushAt = new Date().toISOString();
      } else if (item.pushMode === 'relative') {
        const offset = isFirstPending ? 0 : Math.max(0, item.relativeOffsetMinutes ?? 0) * 60_000;
        item.pushAt = new Date(previous + offset).toISOString();
      }
      previous = Date.parse(item.pushAt) || previous;
      isFirstPending = false;
    }
  }

  async start(): Promise<void> {
    if (!this.current || this.current.items.length === 0) {
      return;
    }
    this.current.state = 'running';
    this.current.missedPushes = undefined;
    this.current.pausedReason = undefined;
    for (const item of this.current.items) {
      if (item.status === 'cancelled') {
        item.status = 'queued';
      }
    }
    this.recomputeRelativePushTimes();
    for (const item of this.pendingItems()) {
      this.armTimer(item);
    }
    await this.persist();
  }

  async pause(reason?: string): Promise<void> {
    if (!this.current) {
      return;
    }
    this.clearTimers();
    for (const item of this.current.items) {
      if (item.status === 'armed') {
        item.status = 'queued';
      }
    }
    this.current.state = 'paused';
    this.current.pausedReason = reason;
    await this.persist();
  }

  async cancel(): Promise<void> {
    if (!this.current) {
      return;
    }
    this.clearTimers();
    for (const item of this.current.items) {
      if (item.status === 'queued' || item.status === 'armed') {
        item.status = 'cancelled';
      }
    }
    this.current.state = 'idle';
    await this.disposeSession();
    await this.persist();
  }

  async clear(): Promise<void> {
    this.clearTimers();
    await this.disposeSession();
    this.current = null;
    await this.persist();
  }

  async retry(id: string): Promise<void> {
    if (!this.current) {
      return;
    }
    const item = this.current.items.find((i) => i.id === id);
    if (!item || item.status === 'live') {
      return;
    }
    item.status = 'queued';
    item.error = undefined;
    item.pushMode = 'now';
    item.pushAt = new Date().toISOString();
    this.current.state = 'running';
    this.current.pausedReason = undefined;
    await this.persist(id);
    this.enqueue(item.id);
  }

  async replayNow(id: string): Promise<void> {
    if (!this.current) {
      return;
    }
    const item = this.current.items.find((i) => i.id === id);
    if (!item || item.status === 'live' || item.status === 'sent') {
      return;
    }
    if (this.current.state !== 'running') {
      this.current.state = 'running';
    }
    this.enqueue(id);
  }

  private pendingItems(): QueueItem[] {
    return this.current?.items.filter((i) => i.status === 'queued' || i.status === 'armed') ?? [];
  }

  private armTimer(item: QueueItem): void {
    this.clearTimer(item.id);
    if (!this.current || this.current.state !== 'running') {
      return;
    }
    if (item.status !== 'queued' && item.status !== 'armed') {
      return;
    }

    const delay = Date.parse(item.pushAt) - Date.now();
    if (Number.isNaN(delay) || delay <= 0) {
      item.status = 'armed';
      this.enqueue(item.id);
      return;
    }

    item.status = 'armed';

    const timer = setTimeout(() => {
      this.timers.delete(item.id);
      const fresh = this.current?.items.find((i) => i.id === item.id);
      if (fresh) {
        this.armTimer(fresh);
      }
    }, Math.min(delay, MAX_TIMEOUT));
    this.timers.set(item.id, timer);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private enqueue(id: string): void {
    this.chain = this.chain.then(() => this.execute(id)).catch((err) => {
      this.log(`Unexpected scheduler error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async ensureSession(): Promise<ReplaySession> {
    if (this.session) {
      return this.session;
    }
    const run = this.current!;
    this.session = new ReplaySession({
      repoPath: run.repoPath,
      targetRepoUrl: run.targetRepoUrl,
      targetBranch: run.targetBranch,
      author: run.author,
      getToken: () => this.auth.getToken(),
      log: this.log,
    });
    return this.session;
  }

  private async disposeSession(): Promise<void> {
    if (this.session) {
      await this.session.dispose();
      this.session = undefined;
    }
  }

  private async execute(id: string): Promise<void> {
    const run = this.current;
    if (!run || run.state === 'paused' || run.state === 'idle') {
      return;
    }
    const item = run.items.find((i) => i.id === id);
    if (!item || item.status === 'sent' || item.status === 'live') {
      return;
    }

    item.status = 'live';
    item.attempts += 1;
    item.error = undefined;
    await this.persist(id, `Replaying ${item.shortSha}`);

    const keepTemp = vscode.workspace
      .getConfiguration('hackReplay')
      .get<boolean>('keepTempOnFailure', true);

    try {
      const session = await this.ensureSession();
      const result = await session.replay(item, keepTemp);
      item.status = 'sent';
      item.completedAt = new Date().toISOString();
      item.replayedSha = result.sha;
      item.tempDir = undefined;
      this.log(`SENT ${item.shortSha} as ${result.sha.slice(0, 7)} on ${result.branch}`);
      await this.persist(id, `Pushed as ${result.sha.slice(0, 7)}`);
    } catch (err) {
      item.status = 'failed';
      item.error = err instanceof Error ? err.message : String(err);
      item.tempDir = err instanceof ReplayError ? err.tempDir : undefined;
      this.log(`FAILED ${item.shortSha}: ${item.error}`);

      await this.pause(`${item.shortSha} failed — the rest of the queue is held.`);
      await this.persist(id, item.error);
      return;
    }

    if (this.pendingItems().length === 0 && !run.items.some((i) => i.status === 'live')) {
      run.state = 'done';
      await this.disposeSession();
      await this.persist();
    }
  }

  private async persist(changedItemId?: string, detail?: string): Promise<void> {
    await this.context.globalState.update(STATE_KEY, this.current ?? undefined);
    this.emitter.fire({ run: this.current, changedItemId, detail });
  }

  async restore(): Promise<{ missed: QueueItem[]; run: ReplayRun | null }> {
    if (!this.current) {
      return { missed: [], run: null };
    }
    const now = Date.now();
    const missed = this.current.items.filter(
      (i) => (i.status === 'armed' || i.status === 'queued') && Date.parse(i.pushAt) <= now
    );

    for (const item of this.current.items) {
      if (item.status === 'live') {
        item.status = 'failed';
        item.error =
          'VS Code closed while this commit was being pushed. Check the target repository before retrying.';
      }
    }

    if (this.current.state === 'running') {
      if (missed.length > 0) {
        this.current.state = 'paused';
        this.current.missedPushes = missed.map((i) => i.id);
        for (const item of missed) {
          item.status = 'queued';
        }
      } else {
        for (const item of this.pendingItems()) {
          this.armTimer(item);
        }
      }
    }

    await this.persist();
    return { missed, run: this.current };
  }

  get hasPending(): boolean {
    return this.pendingItems().length > 0;
  }

  get armedCount(): number {
    return this.current?.items.filter((i) => i.status === 'armed').length ?? 0;
  }

  get nextDue(): Date | null {
    const times = this.pendingItems()
      .map((i) => Date.parse(i.pushAt))
      .filter((t) => !Number.isNaN(t))
      .sort((a, b) => a - b);
    return times.length ? new Date(times[0]) : null;
  }

  get runState(): RunState {
    return this.current?.state ?? 'idle';
  }

  dispose(): void {
    this.clearTimers();
    this.emitter.dispose();
    void this.disposeSession();
  }
}
