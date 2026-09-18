import * as fs from "fs";
import * as vscode from "vscode";
import { GitHubAuth, normalizeGitHubUrl, toFullName } from "../auth/github";
import { ReplayScheduler } from "../git/queue";
import {
  findRepoRoot,
  readCommitFiles,
  readHistory,
  readRepoInfo,
} from "../git/readHistory";
import type {
  AuthorConfig,
  CommitInfo,
  QueueOptions,
  ToHostMessage,
  ToWebviewMessage,
  WebviewConfig,
} from "../types";

const VIEW_TYPE = "hackReplay.panel";
const LAST_TARGET_KEY = "hackReplay.lastTargetRepoUrl";

export class HackReplayPanel {
  private static instance: HackReplayPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private commits: CommitInfo[] = [];
  private repoPath: string | undefined;
  private sourceBranch = "";

  static show(
    context: vscode.ExtensionContext,
    scheduler: ReplayScheduler,
    auth: GitHubAuth,
    log: (message: string) => void,
  ): HackReplayPanel {
    const column =
      vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (HackReplayPanel.instance) {
      HackReplayPanel.instance.panel.reveal(column);
      return HackReplayPanel.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "Hack Replay",
      column,
      {
        enableScripts: true,

        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "media"),
        ],
      },
    );
    HackReplayPanel.instance = new HackReplayPanel(
      panel,
      context,
      scheduler,
      auth,
      log,
    );
    return HackReplayPanel.instance;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly scheduler: ReplayScheduler,
    private readonly auth: GitHubAuth,
    private readonly log: (message: string) => void,
  ) {
    this.panel.webview.html = this.render();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: ToHostMessage) => void this.handle(message),
      null,
      this.disposables,
    );

    this.disposables.push(
      this.scheduler.onDidChange((event) => {
        this.post({ type: "RUN_STATE", run: event.run });
        if (event.changedItemId && event.run) {
          const item = event.run.items.find(
            (i) => i.id === event.changedItemId,
          );
          if (item) {
            this.post({
              type: "REPLAY_PROGRESS",
              id: item.id,
              sha: item.sha,
              status: item.status,
              detail: event.detail,
            });
          }
        }
      }),
    );
  }

  reveal(): void {
    this.panel.reveal();
  }

  post(message: ToWebviewMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async handle(message: ToHostMessage): Promise<void> {
    try {
      switch (message.type) {
        case "READY":
          this.post({ type: "INIT", config: this.readConfig() });
          await this.loadHistory();
          this.post({ type: "RUN_STATE", run: this.scheduler.run });
          this.post({
            type: "GITHUB_SESSION",
            account: await this.auth.getAccount(false),
          });
          break;

        case "LOAD_HISTORY":
        case "REFRESH":
          await this.loadHistory(
            "branch" in message ? message.branch : undefined,
          );
          break;

        case "LOAD_COMMIT_DETAIL": {
          if (!this.repoPath) {
            break;
          }
          const files = await readCommitFiles(this.repoPath, message.sha);
          this.post({ type: "COMMIT_DETAIL", sha: message.sha, files });
          break;
        }

        case "SIGN_IN_GITHUB": {
          const account = await this.auth.getAccount(true);
          this.post({ type: "GITHUB_SESSION", account });
          break;
        }

        case "LIST_GITHUB_REPOS": {
          this.post({ type: "LOADING", scope: "repos", value: true });
          try {
            this.post({
              type: "GITHUB_REPOS",
              repos: await this.auth.listRepos(),
            });
          } finally {
            this.post({ type: "LOADING", scope: "repos", value: false });
          }
          break;
        }

        case "CREATE_GITHUB_REPO": {
          const repo = await this.auth.createRepo(
            message.name,
            message.isPrivate,
          );
          this.post({
            type: "GITHUB_REPOS",
            repos: [repo, ...(await this.auth.listRepos())],
          });
          this.post({
            type: "TOAST",
            level: "info",
            message: `Created ${repo.fullName}.`,
          });
          break;
        }

        case "CHECK_TARGET": {
          const fullName = toFullName(message.targetRepoUrl);
          if (!fullName || !(await this.auth.getAccount(false))) {
            break;
          }
          const repo = await this.auth.getRepo(fullName).catch(() => null);
          this.post({
            type: "CONNECTION",
            state: repo ? "signed-in" : "unreachable",
          });
          if (!repo) {
            this.post({
              type: "TOAST",
              level: "warn",
              message: `TARGET UNREACHABLE - ${fullName} was not found, or your account cannot push to it.`,
            });
          }
          break;
        }

        case "SET_SELECTION":
          await this.syncSelection(message.shas, message.options);
          break;

        case "UPDATE_QUEUE_ITEM":
          await this.scheduler.updateItem(message.id, message.patch);
          break;

        case "REORDER_QUEUE":
          await this.scheduler.reorder(message.ids);
          break;

        case "STAGGER_QUEUE":
          await this.scheduler.stagger(
            message.ids,
            message.startAt,
            message.minutesBetween,
          );
          break;

        case "CLEAR_QUEUE":
          await this.scheduler.clear();
          break;

        case "START_RUN":
          await this.startRun();
          break;

        case "PAUSE_RUN":
          await this.scheduler.pause();
          break;

        case "CANCEL_RUN":
          await this.scheduler.cancel();
          break;

        case "RETRY_ITEM":
          await this.scheduler.retry(message.id);
          break;

        case "REPLAY_COMMIT": {
          const item = this.scheduler.run?.items.find(
            (i) => i.sha === message.sha,
          );
          if (item) {
            await this.auth.getToken();
            await this.scheduler.replayNow(item.id);
          }
          break;
        }

        case "OPEN_TEMP_DIR": {
          const item = this.scheduler.run?.items.find(
            (i) => i.id === message.id,
          );
          if (item?.tempDir && fs.existsSync(item.tempDir)) {
            await vscode.env.openExternal(vscode.Uri.file(item.tempDir));
          } else {
            this.post({
              type: "TOAST",
              level: "warn",
              message: "That temp folder has already been cleaned up.",
            });
          }
          break;
        }

        case "OPEN_EXTERNAL":
          await vscode.env.openExternal(vscode.Uri.parse(message.url));
          break;

        case "SET_TARGET":
          await this.context.globalState.update(
            LAST_TARGET_KEY,
            normalizeGitHubUrl(message.targetRepoUrl),
          );
          break;

        case "SET_AUTHOR": {
          const config = vscode.workspace.getConfiguration("hackReplay");
          const target = vscode.ConfigurationTarget.Global;
          await config.update("authorMode", message.author.mode, target);
          await config.update(
            "customAuthorName",
            message.author.name.trim(),
            target,
          );
          await config.update(
            "customAuthorEmail",
            message.author.email.trim(),
            target,
          );
          break;
        }

        case "LOG":
          this.log(`[webview] ${message.message}`);
          break;
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.log(`Error handling ${message.type}: ${text}`);
      this.post({ type: "TOAST", level: "error", message: text });
    }
  }

  private readConfig(): WebviewConfig {
    const config = vscode.workspace.getConfiguration("hackReplay");
    return {
      version: String(this.context.extension?.packageJSON?.version ?? ""),
      defaultCommitDateMode: config.get("defaultCommitDateMode", "now"),
      defaultStaggerMinutes: config.get("defaultStaggerMinutes", 30),
      author: {
        mode: config.get("authorMode", "original"),
        name: config.get("customAuthorName", ""),
        email: config.get("customAuthorEmail", ""),
      },
      targetBranch: config.get("targetBranch", ""),
      lastTargetRepoUrl: this.context.globalState.get<string>(
        LAST_TARGET_KEY,
        "",
      ),
    };
  }

  private resolveRepoPath(): string | undefined {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = findRepoRoot(folder.uri.fsPath);
      if (root) {
        return root;
      }
    }
    return undefined;
  }

  private async loadHistory(branch?: string): Promise<void> {
    const repoPath = this.resolveRepoPath();
    if (!repoPath) {
      this.post({
        type: "HISTORY_ERROR",
        message:
          "No git repository found in this workspace. Open a folder that contains a git repository.",
      });
      return;
    }

    this.post({ type: "LOADING", scope: "history", value: true });
    try {
      const repo = await readRepoInfo(repoPath);
      const maxCount = vscode.workspace
        .getConfiguration("hackReplay")
        .get("maxCommits", 500);
      const commits = await readHistory(repoPath, {
        branch: branch || repo.currentBranch,
        maxCount,
        withStats: true,
      });
      this.repoPath = repo.rootPath;
      this.sourceBranch = branch || repo.currentBranch;
      this.commits = commits;
      this.post({ type: "HISTORY", repo, commits });
    } catch (err) {
      this.post({
        type: "HISTORY_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.post({ type: "LOADING", scope: "history", value: false });
    }
  }

  private async syncSelection(
    shas: string[],
    options: QueueOptions,
  ): Promise<void> {
    if (!this.repoPath) {
      return;
    }
    const selected = this.commits.filter((c) => shas.includes(c.sha));
    const targetRepoUrl = options.targetRepoUrl
      ? normalizeGitHubUrl(options.targetRepoUrl)
      : "";

    const previousMerges = this.knownMerges;
    const merges = selected.filter((c) => c.parents.length > 1).length;
    if (merges > 0 && merges !== previousMerges) {
      this.post({
        type: "TOAST",
        level: "warn",
        message: `${merges} merge commit${
          merges === 1 ? "" : "s"
        } will replay as ordinary single-parent commits.`,
      });
    }
    this.knownMerges = merges;

    await this.scheduler.syncSelection(
      this.repoPath,
      this.sourceBranch,
      selected,
      {
        ...options,
        targetRepoUrl,
      },
    );
  }

  private knownMerges = 0;

  private async startRun(): Promise<void> {
    const run = this.scheduler.run;
    if (!run) {
      throw new Error("Nothing is queued.");
    }
    if (!run.targetRepoUrl) {
      this.post({
        type: "TOAST",
        level: "error",
        message: "Set a target repository before going on air.",
      });
      return;
    }

    const authorProblem = describeAuthorProblem(run.author);
    if (authorProblem) {
      this.post({ type: "TOAST", level: "error", message: authorProblem });
      return;
    }

    await this.auth.getToken();
    this.post({
      type: "GITHUB_SESSION",
      account: await this.auth.getAccount(false),
    });
    await this.scheduler.start();
  }

  private render(): string {
    const webview = this.panel.webview;
    const asset = (...parts: string[]) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "media", ...parts),
      );
    const nonce = createNonce();

    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} https://fonts.googleapis.com`,
      "font-src https://fonts.gstatic.com",
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Silkscreen:wght@400;700&family=Space+Grotesk:wght@400..700&display=swap" />
  <link rel="stylesheet" href="${asset("dist", "styles.css")}" />
  <title>Hack Replay</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${asset("dist", "main.js")}"></script>
</body>
</html>`;
  }

  dispose(): void {
    HackReplayPanel.instance = undefined;
    this.panel.dispose();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}

export function describeAuthorProblem(author: AuthorConfig): string | null {
  if (author.mode !== "custom") {
    return null;
  }
  if (!author.name.trim()) {
    return "Enter a name for the custom author on the SETUP tab.";
  }
  if (!isEmail(author.email)) {
    return "Enter a valid email address for the custom author on the SETUP tab.";
  }
  return null;
}

function isEmail(value: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.trim());
}

function createNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
