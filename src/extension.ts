import * as vscode from 'vscode';
import { GitHubAuth } from './auth/github';
import { ReplayScheduler } from './git/queue';
import { HackReplayPanel } from './webview/panel';

let output: vscode.OutputChannel;
let scheduler: ReplayScheduler;
let statusBar: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Hack Replay');
  context.subscriptions.push(output);

  const log = (message: string) => output.appendLine(`[${timestamp()}] ${message}`);
  const auth = new GitHubAuth();
  scheduler = new ReplayScheduler(context, auth, log);
  context.subscriptions.push(scheduler);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'hackReplay.showQueueStatus';
  context.subscriptions.push(statusBar);
  context.subscriptions.push(scheduler.onDidChange(() => updateStatusBar()));

  const ticker = setInterval(updateStatusBar, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(ticker) });

  context.subscriptions.push(
    vscode.commands.registerCommand('hackReplay.open', () => {
      HackReplayPanel.show(context, scheduler, auth, log);
    }),
    vscode.commands.registerCommand('hackReplay.cancelQueue', async () => {
      await scheduler.cancel();
      vscode.window.showInformationMessage('Hack Replay: scheduled pushes cancelled.');
    }),
    vscode.commands.registerCommand('hackReplay.showQueueStatus', () => {
      HackReplayPanel.show(context, scheduler, auth, log).reveal();
    })
  );

  const { missed, run } = await scheduler.restore();
  updateStatusBar();

  if (missed.length > 0 && run) {
    const count = missed.length;
    const choice = await vscode.window.showWarningMessage(
      `Hack Replay: ${count} scheduled push${count === 1 ? '' : 'es'} came due while VS Code was closed.`,
      'Replay now',
      'Reschedule from now',
      'Leave paused'
    );
    if (choice === 'Replay now') {
      await scheduler.start();
    } else if (choice === 'Reschedule from now') {
      const minutes = vscode.workspace
        .getConfiguration('hackReplay')
        .get<number>('defaultStaggerMinutes', 30);
      await scheduler.stagger(
        missed.map((i) => i.id),
        new Date().toISOString(),
        minutes
      );
      await scheduler.start();
    }
  }
}

function updateStatusBar(): void {
  if (!statusBar || !scheduler) {
    return;
  }
  const run = scheduler.run;
  if (!run || run.state === 'idle' || run.state === 'done') {
    statusBar.hide();
    return;
  }

  const live = run.items.find((i) => i.status === 'live');
  if (live) {
    statusBar.text = `$(sync~spin) Hack Replay: ${live.shortSha} live`;
    statusBar.tooltip = live.subject;
    statusBar.show();
    return;
  }

  const pending = run.items.filter((i) => i.status === 'queued' || i.status === 'armed').length;
  if (pending === 0) {
    statusBar.hide();
    return;
  }

  if (run.state === 'paused') {
    statusBar.text = `$(debug-pause) Hack Replay: paused · ${pending} held`;
    statusBar.tooltip = run.pausedReason ?? 'The queue is paused. Open the panel to resume.';
  } else {
    const armed = scheduler.armedCount;
    const next = scheduler.nextDue;
    statusBar.text = `$(radio-tower) Hack Replay: ${armed || pending} armed`;
    statusBar.tooltip = next
      ? `Next push ${relative(next)} (${next.toLocaleTimeString()}). Scheduled pushes require VS Code to stay running.`
      : 'Scheduled pushes require VS Code to stay running.';
  }
  statusBar.show();
}

function relative(date: Date): string {
  const ms = date.getTime() - Date.now();
  if (ms <= 0) {
    return 'now';
  }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return `in ${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `in ${hours}h`;
  }
  return `in ${Math.round(hours / 24)}d`;
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export function deactivate(): void {}
