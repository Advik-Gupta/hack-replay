import type {
  AuthorConfig,
  AuthorMode,
  CommitDateMode,
  CommitFile,
  CommitInfo,
  ConnectionState,
  GitHubAccount,
  GitHubRepoSummary,
  PushMode,
  QueueItem,
  QueueItemStatus,
  RepoInfo,
  ReplayRun,
  ToHostMessage,
  ToWebviewMessage,
  WebviewConfig,
} from '../../src/types';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
};

const vscode = acquireVsCodeApi();

const LANE_X0 = 20;
const LANE_W = 18;
const NODE_Y = 23;

type Tab = 'reel' | 'queue' | 'setup' | 'log';
type FilterKey = 'queued' | 'armed' | 'live' | 'sent' | 'failed' | 'merges';
type Status = QueueItemStatus | 'idle';

interface Modal {
  title: string;
  text?: string;
  code?: string;
  summary?: [string, string][];
  confirmLabel?: string;
  confirm?: () => void;
}

interface AppState {
  tab: Tab;
  config: WebviewConfig | null;
  version: string;
  repo: RepoInfo | null;
  commits: CommitInfo[];
  historyError: string | null;
  loading: Record<string, boolean>;
  selected: Set<string>;
  lastClickedIndex: number | null;
  expanded: string | null;
  details: Map<string, CommitFile[]>;
  search: string;
  filters: Set<FilterKey>;
  run: ReplayRun | null;
  account: GitHubAccount | null;
  connection: ConnectionState;
  repos: GitHubRepoSummary[] | null;
  showRepoPicker: boolean;
  modal: Modal | null;
  targetRepoUrl: string;
  targetBranch: string;
  commitDateMode: CommitDateMode;
  author: AuthorConfig;
  staggerMinutes: number;
}

const saved = vscode.getState<{ tab?: Tab }>() ?? {};

const state: AppState = {
  tab: saved.tab ?? 'reel',
  config: null,
  version: '',
  repo: null,
  commits: [],
  historyError: null,
  loading: {},
  selected: new Set(),
  lastClickedIndex: null,
  expanded: null,
  details: new Map(),
  search: '',
  filters: new Set(),
  run: null,
  account: null,
  connection: 'signed-out',
  repos: null,
  showRepoPicker: false,
  modal: null,
  targetRepoUrl: '',
  targetBranch: '',
  commitDateMode: 'now',
  author: { mode: 'original', name: '', email: '' },
  staggerMinutes: 30,
};

function post(message: ToHostMessage): void {
  vscode.postMessage(message);
}

function setTab(tab: Tab): void {
  state.tab = tab;
  vscode.setState({ tab });
  render();
}

function syncSelection(): void {
  post({
    type: 'SET_SELECTION',
    shas: [...state.selected],
    options: {
      targetRepoUrl: state.targetRepoUrl,
      targetBranch: state.targetBranch,
      commitDateMode: state.commitDateMode,
      author: state.author,
      staggerMinutes: state.staggerMinutes,
    },
  });
}

interface LaidOutCommit extends CommitInfo {
  lane: number;
  index: number;
  lanesBefore: number[];
  lanesAfter: number[];
  mergeLanes: number[];
}

function layout(commits: CommitInfo[]): { rows: LaidOutCommit[]; laneCount: number } {
  const reserved: (string | null)[] = [];
  const rows: LaidOutCommit[] = [];
  let laneCount = 1;

  const occupied = () =>
    reserved.reduce<number[]>((acc, sha, index) => {
      if (sha) {
        acc.push(index);
      }
      return acc;
    }, []);

  const claim = (sha: string): number => {
    const existing = reserved.indexOf(sha);
    if (existing !== -1) {
      return existing;
    }
    const free = reserved.indexOf(null);
    const lane = free === -1 ? reserved.length : free;
    reserved[lane] = sha;
    return lane;
  };

  commits.forEach((commit, index) => {
    const lane = claim(commit.sha);
    const lanesBefore = occupied();

    reserved[lane] = commit.parents[0] ?? null;
    const mergeLanes: number[] = [];
    for (const parent of commit.parents.slice(1)) {
      mergeLanes.push(claim(parent));
    }

    rows.push({ ...commit, lane, index, lanesBefore, lanesAfter: occupied(), mergeLanes });
    laneCount = Math.max(laneCount, reserved.length, lane + 1);
  });

  return { rows, laneCount };
}

function laneX(lane: number): number {
  return LANE_X0 + lane * LANE_W;
}

type Attrs = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

function el(tag: string, attrs: Attrs = {}, children: Child[] = []): HTMLElement {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  appendAll(node, children);
  return node;
}

function svgEl(tag: string, attrs: Attrs = {}): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  applyAttrs(node, attrs);
  return node;
}

function applyAttrs(node: Element, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) {
      continue;
    }
    if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'style') {
      applyStyle(node as HTMLElement | SVGElement, String(value));
    } else {
      node.setAttribute(key, String(value));
    }
  }
}

function applyStyle(node: HTMLElement | SVGElement, css: string): void {
  for (const declaration of css.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) {
      continue;
    }
    const property = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    if (property && value) {
      node.style.setProperty(property, value);
    }
  }
}

function appendAll(node: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

function button(
  label: string,
  className: string,
  onClick: () => void,
  opts: { disabled?: boolean; title?: string } = {}
): HTMLButtonElement {
  const node = el('button', { class: `btn ${className}`, text: label, title: opts.title }) as HTMLButtonElement;
  node.disabled = Boolean(opts.disabled);
  node.addEventListener('click', onClick);
  return node;
}

function empty(art: string, headline: string, hint: string, compact = false): HTMLElement {
  return el('div', { class: `empty${compact ? ' compact' : ''}` }, [
    el('div', { class: 'art', text: art }),
    el('div', { class: 'headline', text: headline }),
    el('div', { class: 'hint', text: hint }),
  ]);
}

function relativePast(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return iso;
  }
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  if (minutes < 60 * 36) {
    return `${Math.round(minutes / 60)}h ago`;
  }
  if (minutes < 60 * 24 * 45) {
    return `${Math.round(minutes / (60 * 24))}d ago`;
  }
  return `${Math.round(minutes / (60 * 24 * 30))}mo ago`;
}

function countdownTo(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms) || ms <= 0) {
    return 'due now';
  }
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) {
    return `in ${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `in ${hours}h ${minutes}m`;
  }
  return `in ${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function clockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });
}

function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function prettyTarget(url: string): string {
  const match = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url);
  return match ? match[1] : url;
}

function commitType(commit: CommitInfo): string | null {
  if (commit.parents.length > 1) {
    return 'merge';
  }
  const match = /^\s*([a-z][a-z ]{1,14}?)(\([^)]*\))?!?:/i.exec(commit.subject);
  if (!match) {
    return null;
  }
  const raw = match[1].toLowerCase().replace(/\s+/g, ' ').trim();
  const aliases: Record<string, string> = {
    feature: 'feat',
    'bug fix': 'fix',
    bugfix: 'fix',
    hotfix: 'fix',
    doc: 'docs',
    tests: 'test',
  };
  const type = aliases[raw] ?? raw;
  const known = ['feat', 'fix', 'refactor', 'perf', 'docs', 'test', 'style', 'chore', 'build', 'ci'];
  return known.includes(type) ? type : null;
}

function itemFor(sha: string): QueueItem | undefined {
  return state.run?.items.find((i) => i.sha === sha);
}

function statusFor(sha: string): Status {
  return itemFor(sha)?.status ?? 'idle';
}

const STATUS_COLOR: Record<Status, string> = {
  idle: 'var(--cream)',
  queued: 'var(--queued)',
  armed: 'var(--armed)',
  live: 'var(--live)',
  sent: 'var(--sent)',
  failed: 'var(--failed)',
  cancelled: 'var(--cancelled)',
};

function isImminent(item: QueueItem | undefined): boolean {
  return Boolean(item && item.status === 'armed' && Date.parse(item.pushAt) - Date.now() <= 60_000);
}

function counts(): Record<QueueItemStatus, number> {
  const result: Record<QueueItemStatus, number> = {
    queued: 0,
    armed: 0,
    live: 0,
    sent: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const item of state.run?.items ?? []) {
    result[item.status] += 1;
  }
  return result;
}

function pendingItems(): QueueItem[] {
  return (state.run?.items ?? []).filter((i) => i.status === 'queued' || i.status === 'armed');
}

function deckState(): Status {
  const c = counts();
  if (c.live) {
    return 'live';
  }
  if (state.run?.state === 'paused' && c.failed) {
    return 'failed';
  }
  if (c.armed) {
    return 'armed';
  }
  return 'idle';
}

function renderHeader(): HTMLElement {
  const c = counts();
  const repoName = state.repo?.rootPath.split(/[\\/]/).pop() ?? 'no repository';
  const sub = [
    repoName,
    `${state.commits.length} commits`,
    `${state.selected.size} selected`,
    `${c.sent} sent`,
    state.version ? `v${state.version}` : '',
  ]
    .filter(Boolean)
    .join('  ·  ');

  const controls = el('div', { class: 'head-controls' });

  if (state.repo) {
    const dirty = state.repo.isDirty;
    controls.appendChild(
      el(
        'div',
        {
          class: `tree-badge ${dirty ? 'dirty' : 'clean'}`,
          title: dirty
            ? 'Uncommitted changes exist. They are never included — replays push commit snapshots only.'
            : 'Working tree is clean. Hack Replay never writes to it either way.',
        },
        [el('span', { class: 'dot' }), dirty ? 'TREE DIRTY' : 'TREE CLEAN']
      )
    );

    const branch = el('select', { class: 'select-chunky', title: 'Source branch' }) as HTMLSelectElement;
    for (const name of state.repo.branches) {
      branch.appendChild(el('option', { value: name, text: name }));
    }
    branch.value = state.repo.currentBranch;
    branch.addEventListener('change', () => post({ type: 'LOAD_HISTORY', branch: branch.value }));
    controls.appendChild(branch);
  }

  return el('header', { class: 'dex-head' }, [
    el('div', { class: 'lights' }, [
      el('div', { class: `lens ${deckState()}` }),
      el('span', { class: 'led red' }),
      el('span', { class: 'led yellow' }),
      el('span', { class: 'led green' }),
    ]),
    el('div', { class: 'titles' }, [
      el('h1', { text: 'HACK REPLAY' }),
      el('div', { class: 'sub', title: state.repo?.rootPath ?? '', text: sub.toUpperCase() }),
    ]),
    controls,
  ]);
}

function renderTabs(): HTMLElement {
  const c = counts();
  const defs: [Tab, string, number | null][] = [
    ['reel', 'REEL', state.commits.length || null],
    ['queue', 'QUEUE', state.run?.items.length || null],
    ['setup', 'SETUP', null],
    ['log', 'LOG', c.sent + c.failed || null],
  ];
  const nav = el('nav', { class: 'tabs', role: 'tablist' });
  for (const [id, label, count] of defs) {
    const tab = el('button', { class: 'tab', role: 'tab', 'aria-selected': String(state.tab === id) }, [
      el('span', { class: 'sq' }),
      label,
      count !== null ? el('span', { class: 'count num', text: String(count) }) : null,
    ]);
    tab.addEventListener('click', () => setTab(id));
    nav.appendChild(tab);
  }
  return nav;
}

function renderReelStrip(): HTMLElement {
  const strip = el('div', { class: 'strip' });

  const search = el('input', {
    class: 'input search',
    type: 'text',
    id: 'search-field',
    placeholder: 'FIND COMMIT, SHA OR AUTHOR',
  }) as HTMLInputElement;
  search.value = state.search;
  search.addEventListener('input', () => {
    state.search = search.value;
    render();
  });
  strip.appendChild(search);

  const chips: [FilterKey, string][] = [
    ['queued', 'QUEUED'],
    ['armed', 'ARMED'],
    ['live', 'LIVE'],
    ['sent', 'SENT'],
    ['failed', 'FAILED'],
    ['merges', 'MERGES'],
  ];
  for (const [key, label] of chips) {
    const active = state.filters.has(key);
    const chip = el('button', { class: `chip ${key}`, 'aria-pressed': String(active), text: label });
    chip.addEventListener('click', () => {
      if (active) {
        state.filters.delete(key);
      } else {
        state.filters.add(key);
      }
      render();
    });
    strip.appendChild(chip);
  }

  strip.appendChild(el('div', { class: 'grow' }));

  const allSelected = state.commits.length > 0 && state.selected.size === state.commits.length;
  strip.appendChild(
    button(allSelected ? 'DESELECT ALL' : 'SELECT ALL', 'purple', () => {
      state.selected = allSelected ? new Set() : new Set(state.commits.map((c) => c.sha));
      syncSelection();
      render();
    }, { disabled: state.commits.length === 0 })
  );

  if (state.selected.size > 0) {
    strip.appendChild(
      button('CLEAR', '', () => {
        state.selected.clear();
        syncSelection();
        render();
      })
    );
  }

  strip.appendChild(
    button(state.loading.history ? 'LOADING…' : 'REFRESH', 'blue', () => post({ type: 'REFRESH' }), {
      disabled: Boolean(state.loading.history),
    })
  );
  return strip;
}

function passesFilter(commit: CommitInfo): boolean {
  const query = state.search.trim().toLowerCase();
  if (query) {
    const haystack = `${commit.subject} ${commit.sha} ${commit.authorName} ${commit.authorEmail}`.toLowerCase();
    if (!haystack.includes(query)) {
      return false;
    }
  }
  if (state.filters.size === 0) {
    return true;
  }
  const status = statusFor(commit.sha);
  for (const filter of state.filters) {
    if (filter === 'merges' ? commit.parents.length > 1 : filter === status) {
      return true;
    }
  }
  return false;
}

function renderReel(): HTMLElement {
  const reel = el('div', { class: 'reel' });
  reel.appendChild(renderReelScreen());
  reel.appendChild(renderRail());
  return reel;
}

function renderReelScreen(): HTMLElement {
  const screen = el('section', { class: 'reel-screen' });
  const list = el('div', { class: 'reel-list', id: 'reel-list' });
  screen.appendChild(list);

  if (state.historyError) {
    list.appendChild(empty('?!', 'NO REEL LOADED', state.historyError));
    return screen;
  }
  if (state.loading.history && state.commits.length === 0) {
    list.appendChild(empty('...', 'READING HISTORY', 'Walking the git log for this branch.'));
    return screen;
  }
  if (state.commits.length === 0) {
    list.appendChild(empty('0', 'EMPTY REEL', 'This branch has no commits yet.'));
    return screen;
  }

  const { rows, laneCount } = layout(state.commits);
  const gutterWidth = laneX(laneCount - 1) + 22;
  const visible = rows.filter(passesFilter);
  const maxFiles = Math.max(1, ...state.commits.map((c) => c.filesChanged ?? 0));

  if (visible.length === 0) {
    list.appendChild(empty('--', 'NO MATCHES', 'Nothing matches this search or filter. Clear a chip to widen it.'));
  } else {
    for (const row of visible) {
      list.appendChild(renderCommitRow(row, gutterWidth, maxFiles));
    }
  }

  const c = counts();
  const stats: [string, number, string][] = [
    ['QUEUED', c.queued, 'var(--queued)'],
    ['ARMED', c.armed, 'var(--armed)'],
    ['LIVE', c.live, 'var(--live)'],
    ['SENT', c.sent, 'var(--sent)'],
    ['FAILED', c.failed, 'var(--failed)'],
  ];
  screen.appendChild(
    el('div', { class: 'reel-foot' }, [
      el('div', { class: 'readout' }, [
        el('div', { class: 'statline' }, [
          el('span', {
            class: 'total num',
            text: `SHOWING ${visible.length} / ${state.commits.length} COMMITS`,
          }),
          ...stats.map(([label, value, color]) =>
            el('span', { class: 'stat num', style: `--c:${color}` }, [el('i'), `${label} ${value}`])
          ),
        ]),
      ]),
    ])
  );
  return screen;
}

function renderGutter(row: LaidOutCommit, width: number): HTMLElement {
  const holder = el('div', { class: 'gutter', style: `width:${width}px` });
  const svg = svgEl('svg', {
    width,
    height: '100%',
    style: 'position:absolute;inset:0;overflow:visible',
  });

  const y = NODE_Y + 12;
  const x = laneX(row.lane);

  for (const lane of row.lanesBefore) {
    if (lane !== row.lane && row.lanesAfter.includes(lane)) {
      svg.appendChild(svgEl('line', { class: 'edge', x1: laneX(lane), y1: 0, x2: laneX(lane), y2: '100%' }));
    }
  }
  if (row.index > 0 && row.lanesBefore.includes(row.lane)) {
    svg.appendChild(svgEl('line', { class: 'edge', x1: x, y1: 0, x2: x, y2: y }));
  }
  if (row.parents.length > 0) {
    svg.appendChild(svgEl('line', { class: 'edge', x1: x, y1: y, x2: x, y2: '100%' }));
  }
  for (const lane of row.mergeLanes) {
    const tx = laneX(lane);
    svg.appendChild(
      svgEl('path', {
        class: 'edge',
        d: `M ${x} ${y} C ${x} ${y + 18}, ${tx} ${y + 8}, ${tx} ${y + 30} L ${tx} 2000`,
      })
    );
  }

  const status = statusFor(row.sha);
  const item = itemFor(row.sha);
  const color = STATUS_COLOR[status];

  if (status === 'live' || status === 'armed') {
    svg.appendChild(
      svgEl('circle', {
        class: `pulse-ring${status === 'live' || isImminent(item) ? ' animate' : ''}`,
        cx: x,
        cy: y,
        r: 10,
        fill: 'none',
        stroke: color,
        'stroke-width': 3,
      })
    );
  }

  const selected = status !== 'idle';
  svg.appendChild(
    svgEl('circle', {
      cx: x,
      cy: y,
      r: selected ? 8 : 6,
      fill: color,
      stroke: 'var(--ink)',
      'stroke-width': selected ? 3 : 2.5,
    })
  );
  if (!selected) {
    svg.appendChild(svgEl('circle', { cx: x - 1.5, cy: y - 1.5, r: 1.6, fill: 'var(--ink)', opacity: 0.25 }));
  }
  if (status === 'sent') {
    svg.appendChild(
      svgEl('path', {
        d: `M ${x - 3.2} ${y + 0.2} l 2.2 2.3 l 4.2 -4.6`,
        fill: 'none',
        stroke: 'var(--ink)',
        'stroke-width': 2,
        'stroke-linecap': 'square',
      })
    );
  } else if (status === 'failed') {
    svg.appendChild(
      svgEl('path', {
        d: `M ${x} ${y - 3.5} v 4 M ${x} ${y + 2.5} v 1`,
        stroke: 'var(--white)',
        'stroke-width': 2,
        'stroke-linecap': 'square',
      })
    );
  }

  holder.appendChild(svg);
  return holder;
}

function renderCommitRow(row: LaidOutCommit, gutterWidth: number, maxFiles: number): HTMLElement {
  const status = statusFor(row.sha);
  const isExpanded = state.expanded === row.sha;
  const type = commitType(row);

  const node = el('div', {
    class: 'commit-row',
    'data-status': status,
    'data-sha': row.sha,
    role: 'button',
    tabindex: 0,
    'aria-pressed': String(state.selected.has(row.sha)),
    title: 'Click to add to or remove from the queue · Shift-click selects a range',
  });

  node.appendChild(renderGutter(row, gutterWidth));

  node.appendChild(
    el('div', { class: 'commit-main' }, [
      el('div', { class: 'commit-line' }, [
        type ? el('span', { class: `type ${type}`, text: type.toUpperCase() }) : null,
        el('span', { class: 'commit-subject', title: row.subject, text: row.subject }),
      ]),
      el('div', { class: 'commit-meta' }, [
        el('span', { class: 'sha', text: row.shortSha }),
        el('span', { class: 'sep' }),
        el('span', { class: 'author', text: row.authorName }),
        el('span', { class: 'sep' }),
        el('span', { title: new Date(row.authorDate).toLocaleString(), text: shortDate(row.authorDate) }),
        el('span', { class: 'rel', text: `(${relativePast(row.authorDate)})` }),
      ]),
    ])
  );

  const side = el('div', { class: 'commit-side' });
  for (const ref of row.refs.slice(0, 2)) {
    const isHead = ref.startsWith('HEAD');
    const isRemote = !isHead && ref.includes('/');
    side.appendChild(
      el('span', {
        class: `ref ${isHead ? 'head' : isRemote ? 'remote' : 'local'}`,
        title: ref,
        text: ref.replace('HEAD -> ', ''),
      })
    );
  }
  if (row.filesChanged !== undefined) {
    const fill = Math.max(8, Math.round((Math.log(row.filesChanged + 1) / Math.log(maxFiles + 1)) * 100));
    const pill = el('span', {
      class: 'files num',
      title: `${row.filesChanged} files · +${row.insertions ?? 0} −${row.deletions ?? 0}`,
    }, [`${row.filesChanged} FILE${row.filesChanged === 1 ? '' : 'S'}`]);
    pill.appendChild(el('span', { class: 'bar', style: `--fill:${fill}%` }));
    side.appendChild(pill);
  }
  if (status !== 'idle') {
    side.appendChild(el('span', { class: `pill ${status}`, text: status }));
  }

  const disclose = el('button', {
    class: 'disclose',
    'aria-expanded': String(isExpanded),
    'aria-label': isExpanded ? 'Hide commit detail' : 'Show commit detail',
    title: 'Inspect files',
    text: isExpanded ? '−' : '+',
  });
  disclose.addEventListener('click', (event) => {
    event.stopPropagation();
    state.expanded = isExpanded ? null : row.sha;
    if (!isExpanded && !state.details.has(row.sha)) {
      post({ type: 'LOAD_COMMIT_DETAIL', sha: row.sha });
    }
    render();
  });
  side.appendChild(disclose);
  node.appendChild(side);

  if (isExpanded) {
    node.appendChild(renderCommitDetail(row));
  }

  node.addEventListener('click', (event) => toggleSelection(row.index, event.shiftKey));
  node.addEventListener('keydown', (event) => {
    if (event.target === node && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      toggleSelection(row.index, event.shiftKey);
    }
  });
  return node;
}

function renderCommitDetail(row: LaidOutCommit): HTMLElement {
  const detail = el('div', { class: 'commit-detail' });
  detail.addEventListener('click', (event) => event.stopPropagation());

  if (row.body) {
    detail.appendChild(el('p', { class: 'detail-body', text: row.body }));
  }

  const grid = el('dl', { class: 'detail-grid' });
  const pair = (label: string, value: string, mono = false) => {
    grid.appendChild(el('dt', { text: label }));
    grid.appendChild(el('dd', { class: mono ? 'mono' : '', text: value }));
  };
  pair('SHA', row.sha, true);
  pair('AUTHOR', `${row.authorName} <${row.authorEmail}>`);
  pair('AUTHORED', new Date(row.authorDate).toLocaleString());
  if (row.parents.length > 0) {
    pair('PARENTS', row.parents.map((p) => p.slice(0, 7)).join(', '), true);
  }
  if (row.insertions !== undefined || row.deletions !== undefined) {
    pair('DIFF', `+${row.insertions ?? 0}  −${row.deletions ?? 0}`, true);
  }
  detail.appendChild(grid);

  const files = state.details.get(row.sha);
  if (!files) {
    detail.appendChild(el('div', { class: 'hint', text: 'Loading files…' }));
    return detail;
  }
  const list = el('div', { class: 'file-list' });
  for (const file of files.slice(0, 500)) {
    list.appendChild(
      el('div', { class: 'file-row' }, [
        el('span', { class: 'path', title: file.path, text: file.path }),
        el('span', { class: 'add num', text: file.binary ? 'bin' : `+${file.insertions}` }),
        el('span', { class: 'del num', text: file.binary ? '' : `−${file.deletions}` }),
      ])
    );
  }
  if (files.length === 0) {
    list.appendChild(el('div', { class: 'hint', text: 'No file changes in this commit.' }));
  }
  detail.appendChild(list);
  return detail;
}

function toggleSelection(index: number, shiftKey = false): void {
  const sha = state.commits[index].sha;
  if (shiftKey && state.lastClickedIndex !== null) {
    const [from, to] = [state.lastClickedIndex, index].sort((a, b) => a - b);
    for (let i = from; i <= to; i += 1) {
      state.selected.add(state.commits[i].sha);
    }
  } else if (state.selected.has(sha)) {
    state.selected.delete(sha);
  } else {
    state.selected.add(sha);
  }
  state.lastClickedIndex = index;
  syncSelection();
  render();
}

function renderRail(): HTMLElement {
  const rail = el('aside', { class: 'rail' });
  const scroll = el('div', { class: 'rail-scroll', id: 'rail-scroll' }, [
    renderMissionCard(),
    renderProgressCard(),
    renderUpNextCard(),
  ]);
  rail.appendChild(scroll);
  rail.appendChild(renderOnAir());
  return rail;
}

function renderMissionCard(): HTMLElement {
  const target = state.run?.targetRepoUrl || state.targetRepoUrl;
  const branch = state.run?.targetBranch || state.targetBranch || 'default';
  const dateLabel: Record<CommitDateMode, string> = {
    original: 'ORIGINAL',
    now: 'NOW',
    custom: 'CUSTOM',
  };

  const who = state.account ? `Signed in as ${state.account.login}` : 'Signed out of GitHub';

  return el('section', { class: 'card tight' }, [
    el('h2', { class: 'card-title' }, [
      'MISSION',
      button('EDIT', 'sm yellow', () => setTab('setup')),
    ]),
    el('div', { class: 'target-line', title: `${target || 'No target set'} · ${who}` }, [
      el('span', { class: `conn-dot ${state.connection}` }),
      el('span', { class: 'name', text: target ? prettyTarget(target) : 'No target repository' }),
    ]),
    el('div', { class: 'chips-row' }, [
      el('span', { class: 'mchip branch', title: 'Target branch', text: `@${branch}` }),
      el('span', {
        class: `mchip ${state.commitDateMode}`,
        title: 'Default commit timestamp',
        text: `${dateLabel[state.commitDateMode]} DATE`,
      }),
      el('span', { class: 'mchip num', title: 'Gap between pushes', text: `${state.staggerMinutes} MIN GAP` }),
      el('span', {
        class: `mchip author-${state.author.mode}`,
        title: `Author: ${describeAuthor(state.author)}`,
        text: state.author.mode === 'custom' ? 'CUSTOM AUTHOR' : state.author.mode === 'self' ? 'AUTHORED BY ME' : 'ORIGINAL AUTHOR',
      }),
    ]),
  ]);
}

function renderProgressCard(): HTMLElement {
  const items = state.run?.items ?? [];
  const c = counts();
  const total = items.length;
  const segs = Math.min(Math.max(total, 1), 20);

  const xp = el('div', { class: 'xp', style: `--segs:${segs}` });
  for (let i = 0; i < segs; i += 1) {
    const item = total <= 20 ? items[i] : items[Math.floor((i / segs) * total)];
    const cls = !item
      ? ''
      : item.status === 'sent'
        ? 'on'
        : item.status === 'live'
          ? 'live'
          : item.status === 'failed'
            ? 'bad'
            : '';
    xp.appendChild(el('span', { class: cls }));
  }

  const pct = total ? Math.round((c.sent / total) * 100) : 0;
  const tiles: [string, number, string, string][] = [
    ['QUEUED', c.queued, 'var(--queued)', 'var(--white)'],
    ['ARMED', c.armed, 'var(--armed)', 'var(--ink)'],
    ['SENT', c.sent, 'var(--sent)', 'var(--ink)'],
    ['FAILED', c.failed, 'var(--failed)', 'var(--white)'],
  ];

  return el('section', { class: 'card tight' }, [
    el('h2', { class: 'card-title' }, ['BROADCAST', el('span', { class: 'aside', text: runStateLabel() })]),
    xp,
    el('div', { class: 'xp-caption num' }, [
      el('span', { text: `${c.sent} / ${total} SENT` }),
      el('span', { text: `${pct}%` }),
    ]),
    el(
      'div',
      { class: 'tiles' },
      tiles.map(([label, value, bg, ink]) =>
        el('div', { class: 'tile', style: `--tile:${bg};--tile-ink:${ink}` }, [
          el('b', { class: 'num', text: String(value) }),
          el('span', { text: label }),
        ])
      )
    ),
  ]);
}

function runStateLabel(): string {
  const run = state.run;
  if (!run || run.items.length === 0) {
    return 'STANDBY';
  }
  switch (run.state) {
    case 'running':
      return counts().live ? 'ON AIR' : 'ARMED';
    case 'paused':
      return 'PAUSED';
    case 'done':
      return 'COMPLETE';
    default:
      return 'READY';
  }
}

function renderUpNextCard(): HTMLElement {
  const items = state.run?.items ?? [];
  const card = el('section', { class: 'card tight' });
  card.appendChild(
    el('h2', { class: 'card-title' }, [
      'UP NEXT',
      items.length ? button('OPEN QUEUE', 'sm blue', () => setTab('queue')) : null,
    ])
  );

  if (state.run?.pausedReason) {
    card.appendChild(el('div', { class: 'qerror', style: 'margin-bottom:12px', text: state.run.pausedReason }));
  }

  if (items.length === 0) {
    card.appendChild(empty('+', 'NOTHING CUED', 'Click commits on the reel to load them here.', true));
    return card;
  }

  const ordered = [
    ...items.filter((i) => i.status === 'live'),
    ...items.filter((i) => i.status === 'failed'),
    ...items.filter((i) => i.status === 'armed' || i.status === 'queued'),
    ...items.filter((i) => i.status === 'sent').reverse(),
  ].slice(0, 6);

  const list = el('div', { class: 'mini-queue' });
  for (const item of ordered) {
    const position = items.indexOf(item) + 1;
    list.appendChild(
      el('div', { class: 'mini-row', 'data-status': item.status }, [
        el('span', { class: 'idx num', text: String(position) }),
        el('span', { class: 'what' }, [
          el('span', { class: 's', title: item.subject, text: item.subject }),
          el('span', { class: 't', 'data-mini-for': item.id, text: shortTime(item) }),
        ]),
        el('span', { class: `pill ${item.status}`, text: item.status }),
      ])
    );
  }
  card.appendChild(list);

  if (items.length > ordered.length) {
    card.appendChild(
      el('div', { class: 'hint', style: 'margin-top:10px;text-align:center', text: `+ ${items.length - ordered.length} more in the queue` })
    );
  }
  return card;
}

function renderOnAir(): HTMLElement {
  const run = state.run;
  const pending = pendingItems();
  const deck = deckState();
  const running = run?.state === 'running';

  let label = 'ON AIR';
  if (deck === 'live') {
    label = 'BROADCASTING…';
  } else if (running && pending.length) {
    label = 'ARMED';
  } else if (run?.state === 'paused' && pending.length) {
    label = 'RESUME';
  }

  return el('div', { class: 'onair-panel' }, [
    el('div', { class: 'onair-row' }, [
      el('div', { class: `lamp ${deck === 'live' ? 'live' : deck === 'armed' ? 'armed' : ''}` }),
      button(label, `lg orange${running && (pending.length || deck === 'live') ? ' running' : ''}`, confirmRun, {
        disabled: pending.length === 0 || running,
      }),
    ]),
    el('div', {
      class: 'onair-note',
      text: pending.length
        ? `${pending.length} CUED · VS CODE MUST STAY OPEN`
        : 'CUE COMMITS ON THE REEL TO GO ON AIR',
    }),
  ]);
}

function shortTime(item: QueueItem): string {
  switch (item.status) {
    case 'sent':
      return `SENT ${item.completedAt ? relativePast(item.completedAt).toUpperCase() : ''}`;
    case 'live':
      return 'PUSHING NOW';
    case 'failed':
      return 'NEEDS ATTENTION';
    case 'armed': {
      const ms = Date.parse(item.pushAt) - Date.now();
      return ms <= 60_000 ? `FIRES ${clockTime(item.pushAt)}` : countdownTo(item.pushAt).toUpperCase();
    }
    case 'cancelled':
      return 'NOT SCHEDULED';
    default:
      return `AT ${clockTime(item.pushAt)}`;
  }
}

function confirmRun(): void {
  const run = state.run;
  const pending = pendingItems();
  if (!run || pending.length === 0) {
    return;
  }
  const problem = authorProblem(state.author);
  if (problem) {
    state.modal = {
      title: 'AUTHOR INCOMPLETE',
      text: problem,
      confirmLabel: 'OPEN SETUP',
      confirm: () => setTab('setup'),
    };
    render();
    return;
  }
  if (!run.targetRepoUrl) {
    state.modal = {
      title: 'NO TARGET SET',
      text: 'Pick the GitHub repository to broadcast to before going on air.',
      confirmLabel: 'OPEN SETUP',
      confirm: () => setTab('setup'),
    };
    render();
    return;
  }
  const first = clockTime(pending[0].pushAt);
  const last = clockTime(pending[pending.length - 1].pushAt);
  state.modal = {
    title: 'GO ON AIR?',
    text: `This will push ${pending.length} commit${pending.length === 1 ? '' : 's'} to the remote. Each push creates a new commit there. Your local repository is never modified.`,
    summary: [
      ['TARGET', `${prettyTarget(run.targetRepoUrl)}@${run.targetBranch || 'default branch'}`],
      ['COMMITS', String(pending.length)],
      ['WINDOW', pending.length === 1 ? first : `${first} → ${last}`],
      ['AUTHOR', describeAuthor(run.author)],
    ],
    confirmLabel: 'ON AIR',
    confirm: () => post({ type: 'START_RUN' }),
  };
  render();
}

function renderQueueStrip(): HTMLElement {
  const run = state.run;
  const hasItems = Boolean(run && run.items.length);
  const stagger = el('input', {
    class: 'input tiny',
    type: 'number',
    id: 'stagger-strip',
    min: 0,
    step: 1,
    title: 'Minutes between pushes',
  }) as HTMLInputElement;
  stagger.value = String(state.staggerMinutes);
  stagger.addEventListener('change', () => {
    state.staggerMinutes = Math.max(0, Number(stagger.value) || 0);
  });

  return el('div', { class: 'strip' }, [
    el('span', { class: 'label', text: 'GAP' }),
    stagger,
    el('span', { class: 'label', text: 'MIN' }),
    button('STAGGER FROM NOW', 'green', () => {
      const ids = pendingItems().map((i) => i.id);
      post({ type: 'STAGGER_QUEUE', ids, startAt: new Date().toISOString(), minutesBetween: state.staggerMinutes });
    }, { disabled: pendingItems().length === 0, title: 'Refill push times in the current order' }),
    el('div', { class: 'grow' }),
    button('PAUSE', 'yellow', () => post({ type: 'PAUSE_RUN' }), { disabled: run?.state !== 'running' }),
    button('CANCEL RUN', 'orange', () => post({ type: 'CANCEL_RUN' }), { disabled: !hasItems }),
    button('CLEAR QUEUE', 'red', () => {
      state.selected.clear();
      post({ type: 'CLEAR_QUEUE' });
      render();
    }, { disabled: !hasItems }),
    button(
      run?.state === 'paused' ? 'RESUME' : run?.state === 'running' ? 'ON AIR…' : 'ON AIR',
      `purple${run?.state === 'running' && pendingItems().length ? ' running' : ''}`,
      confirmRun,
      { disabled: pendingItems().length === 0 || run?.state === 'running' }
    ),
  ]);
}

let dragId: string | null = null;

function renderQueue(): HTMLElement {
  const scroll = el('div', { class: 'stage-scroll', id: 'queue-scroll' });
  const items = state.run?.items ?? [];

  if (items.length === 0) {
    scroll.appendChild(
      el('div', { class: 'card', style: 'max-width:560px;margin:40px auto' }, [
        empty('[ ]', 'QUEUE IS EMPTY', 'Select commits on the REEL tab — each one you click lands here, ready to schedule.'),
        el('div', { style: 'display:flex;justify-content:center' }, [button('GO TO REEL', 'blue', () => setTab('reel'))]),
      ])
    );
    return scroll;
  }

  const list = el('div', { class: 'qlist' });
  if (state.run?.pausedReason) {
    list.appendChild(el('div', { class: 'qerror', text: state.run.pausedReason }));
  }
  items.forEach((item, index) => list.appendChild(renderQueueCard(item, index)));
  scroll.appendChild(list);
  return scroll;
}

function renderQueueCard(item: QueueItem, index: number): HTMLElement {
  const editable = item.status === 'queued' || item.status === 'armed' || item.status === 'failed';
  const card = el('article', {
    class: 'qcard',
    'data-status': item.status,
    draggable: String(editable),
  });

  card.addEventListener('dragstart', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, select, button')) {
      event.preventDefault();
      return;
    }
    dragId = item.id;
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => {
    dragId = null;
    card.classList.remove('dragging');
    document.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
  });
  card.addEventListener('dragover', (event) => {
    if (dragId && dragId !== item.id) {
      event.preventDefault();
      card.classList.add('drop-target');
    }
  });
  card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
  card.addEventListener('drop', (event) => {
    event.preventDefault();
    card.classList.remove('drop-target');
    if (!dragId || dragId === item.id || !state.run) {
      return;
    }
    const ids = state.run.items.map((i) => i.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(item.id), 0, dragId);
    post({ type: 'REORDER_QUEUE', ids });
  });

  card.appendChild(
    el('div', { class: 'qnum' }, [
      el('b', { class: 'num', text: String(index + 1) }),
      editable ? el('span', { class: 'grip', title: 'Drag to reorder', text: '⋮⋮' }) : null,
    ])
  );

  const commit = state.commits.find((c) => c.sha === item.sha);
  const type = commit ? commitType(commit) : null;

  const body = el('div', { class: 'qbody' });
  body.appendChild(
    el('div', { class: 'qhead' }, [
      el('span', { class: 'sha', text: item.shortSha }),
      type ? el('span', { class: `type ${type}`, text: type.toUpperCase() }) : null,
      el('span', { class: 'subject', title: item.subject, text: item.subject }),
      el('span', { class: `pill ${item.status}`, text: item.status }),
    ])
  );

  const grid = el('div', { class: 'qgrid' });

  const dateField = el('div', { class: 'field' });
  dateField.appendChild(el('span', { class: 'flabel', text: 'COMMIT DATE' }));
  const dateSelect = el('select') as HTMLSelectElement;
  for (const [value, label] of [
    ['original', `Original · ${shortDate(item.originalDate)}`],
    ['now', 'Now, at push'],
    ['custom', 'Custom…'],
  ] as [CommitDateMode, string][]) {
    dateSelect.appendChild(el('option', { value, text: label }));
  }
  dateSelect.value = item.commitDateMode;
  dateSelect.disabled = !editable;
  dateSelect.addEventListener('change', () => {
    const mode = dateSelect.value as CommitDateMode;
    post({
      type: 'UPDATE_QUEUE_ITEM',
      id: item.id,
      patch: {
        commitDateMode: mode,
        customCommitDate: mode === 'custom' ? item.customCommitDate ?? item.originalDate : undefined,
      },
    });
  });
  if (item.commitDateMode === 'custom') {
    const custom = el('input', { type: 'datetime-local' }) as HTMLInputElement;
    custom.value = toLocalInput(item.customCommitDate ?? item.originalDate);
    custom.disabled = !editable;
    custom.addEventListener('change', () => {
      post({ type: 'UPDATE_QUEUE_ITEM', id: item.id, patch: { customCommitDate: fromLocalInput(custom.value) } });
    });
    dateField.appendChild(el('div', { class: 'field-pair' }, [dateSelect, custom]));
  } else {
    dateField.appendChild(dateSelect);
  }
  grid.appendChild(dateField);

  const pushField = el('div', { class: 'field' });
  pushField.appendChild(el('span', { class: 'flabel', text: 'PUSH TIME' }));
  const pushSelect = el('select') as HTMLSelectElement;
  for (const [value, label] of [
    ['now', 'Immediately'],
    ['relative', 'After previous'],
    ['absolute', 'At a set time'],
  ] as [PushMode, string][]) {
    pushSelect.appendChild(el('option', { value, text: label }));
  }
  pushSelect.value = item.pushMode;
  pushSelect.disabled = !editable;
  pushSelect.addEventListener('change', () => {
    post({ type: 'UPDATE_QUEUE_ITEM', id: item.id, patch: { pushMode: pushSelect.value as PushMode } });
  });

  if (item.pushMode === 'relative') {
    const offset = el('input', { type: 'number', min: 0, step: 1, title: 'Minutes after the previous push' }) as HTMLInputElement;
    offset.value = String(item.relativeOffsetMinutes ?? 0);
    offset.disabled = !editable;
    offset.addEventListener('change', () => {
      post({
        type: 'UPDATE_QUEUE_ITEM',
        id: item.id,
        patch: { relativeOffsetMinutes: Math.max(0, Number(offset.value) || 0) },
      });
    });
    pushField.appendChild(
      el('div', { class: 'field-pair' }, [pushSelect, el('div', { class: 'unit', 'data-unit': 'MIN' }, [offset])])
    );
  } else if (item.pushMode === 'absolute') {
    const when = el('input', { type: 'datetime-local' }) as HTMLInputElement;
    when.value = toLocalInput(item.pushAt);
    when.disabled = !editable;
    when.addEventListener('change', () => {
      post({ type: 'UPDATE_QUEUE_ITEM', id: item.id, patch: { pushAt: fromLocalInput(when.value) } });
    });
    pushField.appendChild(el('div', { class: 'field-pair' }, [pushSelect, when]));
  } else {
    pushField.appendChild(pushSelect);
  }
  grid.appendChild(pushField);

  const clock = el('div', { class: `clock ${item.status}`, 'data-clock-for': item.id });
  fillClock(clock, item);
  grid.appendChild(clock);

  body.appendChild(grid);

  if (item.error) {
    body.appendChild(el('div', { class: 'qerror', text: truncate(item.error, 220) }));
  }

  const actions: HTMLElement[] = [];
  if (item.status === 'failed') {
    actions.push(button('RETRY', 'sm green', () => post({ type: 'RETRY_ITEM', id: item.id })));
    actions.push(
      button('DETAILS', 'sm', () => {
        state.modal = { title: `${item.shortSha} FAILED`, code: item.error ?? 'No details recorded.' };
        render();
      })
    );
    if (item.tempDir) {
      actions.push(button('OPEN TEMP FOLDER', 'sm', () => post({ type: 'OPEN_TEMP_DIR', id: item.id })));
    }
  }
  if (editable) {
    actions.push(button('PUSH NOW', 'sm orange', () => post({ type: 'REPLAY_COMMIT', sha: item.sha })));
    actions.push(
      button('REMOVE', 'sm ghost', () => {
        state.selected.delete(item.sha);
        syncSelection();
        render();
      })
    );
  }
  if (actions.length) {
    body.appendChild(el('div', { class: 'qactions' }, actions));
  }

  card.appendChild(body);
  return card;
}

function fillClock(node: Element, item: QueueItem): void {
  node.className = `clock ${item.status}`;
  node.textContent = '';
  let time: string;
  switch (item.status) {
    case 'sent':
      time = item.replayedSha
        ? `${item.replayedSha.slice(0, 7)} · ${item.completedAt ? relativePast(item.completedAt) : ''}`
        : 'pushed';
      break;
    case 'live':
      time = 'pushing now…';
      break;
    case 'failed':
      time = `${item.attempts} attempt${item.attempts === 1 ? '' : 's'}`;
      break;
    case 'cancelled':
      time = 'not scheduled';
      break;
    case 'armed': {
      const ms = Date.parse(item.pushAt) - Date.now();
      time = ms <= 60_000 ? `fires ${clockTime(item.pushAt)}` : `${countdownTo(item.pushAt)} · ${clockTime(item.pushAt)}`;
      break;
    }
    default:
      time = `at ${clockTime(item.pushAt)} once on air`;
  }
  node.appendChild(el('span', { class: 'state', text: item.status }));
  node.appendChild(el('span', { class: 'time', text: time }));
}

function renderSetupStrip(): HTMLElement {
  return el('div', { class: 'strip' }, [
    state.account
      ? el('span', { class: 'label', text: `SIGNED IN AS ${state.account.login.toUpperCase()}` })
      : button('SIGN IN TO GITHUB', 'blue', () => post({ type: 'SIGN_IN_GITHUB' })),
    el('div', { class: 'grow' }),
    button(state.showRepoPicker ? 'HIDE REPOS' : 'PICK FROM GITHUB', 'purple', () => {
      state.showRepoPicker = !state.showRepoPicker;
      if (state.showRepoPicker && !state.repos) {
        post({ type: 'LIST_GITHUB_REPOS' });
      }
      render();
    }, { disabled: !state.account }),
    button('NEW REPO', 'green', () => {
      const name = window.prompt('New private GitHub repository name');
      if (name && name.trim()) {
        post({ type: 'CREATE_GITHUB_REPO', name: name.trim(), isPrivate: true });
      }
    }, { disabled: !state.account }),
  ]);
}

function renderSetup(): HTMLElement {
  const scroll = el('div', { class: 'stage-scroll', id: 'setup-scroll' });
  const grid = el('div', { class: 'setup-grid' }, [
    el('div', { class: 'setup-col' }, [renderTargetCard(), renderSettingsCard()]),
    el('div', { class: 'setup-col' }, [renderAuthorCard(), renderRulesCard()]),
  ]);
  scroll.appendChild(grid);
  return scroll;
}

function renderTargetCard(): HTMLElement {
  const connLabel =
    state.connection === 'signed-in' ? 'CONNECTED' : state.connection === 'unreachable' ? 'UNREACHABLE' : 'SIGNED OUT';

  const url = el('input', {
    type: 'text',
    id: 'target-url',
    placeholder: 'owner/repo or https://github.com/owner/repo',
  }) as HTMLInputElement;
  url.value = state.targetRepoUrl;
  url.addEventListener('change', () => {
    state.targetRepoUrl = url.value.trim();
    post({ type: 'SET_TARGET', targetRepoUrl: state.targetRepoUrl, targetBranch: state.targetBranch });
    if (state.targetRepoUrl) {
      post({ type: 'CHECK_TARGET', targetRepoUrl: state.targetRepoUrl });
    }
    syncSelection();
  });

  const branch = el('input', { type: 'text', id: 'target-branch', placeholder: 'main' }) as HTMLInputElement;
  branch.value = state.targetBranch;
  branch.addEventListener('change', () => {
    state.targetBranch = branch.value.trim();
    syncSelection();
  });

  const card = el('section', { class: 'card' }, [
    el('h2', { class: 'card-title' }, [
      'TARGET REPOSITORY',
      el('span', { class: 'aside', style: 'display:flex;align-items:center;gap:6px' }, [
        el('span', { class: `conn-dot ${state.connection}` }),
        connLabel,
      ]),
    ]),
    el('div', { class: 'field' }, [el('label', { for: 'target-url', text: 'REPOSITORY' }), url]),
    el('div', { class: 'field' }, [el('label', { for: 'target-branch', text: 'BRANCH · BLANK = DEFAULT' }), branch]),
  ]);

  if (!state.account) {
    card.appendChild(
      el('div', { class: 'btn-row' }, [button('SIGN IN TO GITHUB', 'blue', () => post({ type: 'SIGN_IN_GITHUB' }))])
    );
  }

  if (state.showRepoPicker) {
    if (state.loading.repos) {
      card.appendChild(el('div', { class: 'hint', style: 'margin-top:16px', text: 'Loading repositories…' }));
    } else if (state.repos) {
      const picker = el('div', { class: 'repo-picker' });
      for (const repo of state.repos.slice(0, 200)) {
        const option = el('button', { class: 'repo-option' }, [
          el('span', { text: repo.fullName }),
          el('span', {
            class: 'tag',
            text: `${repo.isPrivate ? 'PRIVATE' : 'PUBLIC'}${repo.isEmpty ? ' · EMPTY' : ''}`,
          }),
        ]);
        option.addEventListener('click', () => {
          state.targetRepoUrl = repo.cloneUrl;
          state.targetBranch = state.targetBranch || repo.defaultBranch;
          state.showRepoPicker = false;
          state.connection = 'signed-in';
          post({ type: 'SET_TARGET', targetRepoUrl: state.targetRepoUrl, targetBranch: state.targetBranch });
          syncSelection();
          render();
        });
        picker.appendChild(option);
      }
      if (state.repos.length === 0) {
        picker.appendChild(el('div', { class: 'hint', style: 'padding:12px', text: 'No repositories you can push to.' }));
      }
      card.appendChild(picker);
    }
  }
  return card;
}

function renderSettingsCard(): HTMLElement {
  const stagger = el('input', { type: 'number', id: 'stagger-setup', min: 0, step: 1 }) as HTMLInputElement;
  stagger.value = String(state.staggerMinutes);
  stagger.addEventListener('change', () => {
    state.staggerMinutes = Math.max(0, Number(stagger.value) || 0);
    render();
  });

  return el('section', { class: 'card' }, [
    el('h2', { class: 'card-title', text: 'REPLAY SETTINGS' }),
    el('div', { class: 'field' }, [
      el('span', { class: 'flabel', text: 'COMMIT TIMESTAMP' }),
      segmented<CommitDateMode>(
        [
          ['original', 'ORIGINAL'],
          ['now', 'NOW'],
          ['custom', 'CUSTOM'],
        ],
        state.commitDateMode,
        (value) => {
          state.commitDateMode = value;
          syncSelection();
          render();
        }
      ),
      el('div', {
        class: 'hint',
        text: 'Default for newly cued commits. Sets GIT_AUTHOR_DATE and GIT_COMMITTER_DATE — independent of push time. Each row can override it.',
      }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { for: 'stagger-setup', text: 'MINUTES BETWEEN PUSHES' }),
      stagger,
      el('div', { class: 'hint', text: '0 pushes back to back. Applies to newly cued commits; use STAGGER on the QUEUE tab to refill existing rows.' }),
    ]),
  ]);
}

function renderAuthorCard(): HTMLElement {
  const author = state.author;

  const commit = (patch: Partial<AuthorConfig>) => {
    state.author = { ...state.author, ...patch };
    post({ type: 'SET_AUTHOR', author: state.author });
    syncSelection();
    render();
  };

  const card = el('section', { class: 'card' }, [
    el('h2', { class: 'card-title', text: 'COMMIT AUTHOR' }),
    el('div', { class: 'field' }, [
      el('span', { class: 'flabel', text: 'WHO WROTE THESE COMMITS' }),
      segmented<AuthorMode>(
        [
          ['original', 'ORIGINAL'],
          ['self', 'ME'],
          ['custom', 'SOMEONE'],
        ],
        author.mode,
        (mode) => commit({ mode })
      ),
    ]),
  ]);

  if (author.mode === 'custom') {
    const name = el('input', {
      type: 'text',
      id: 'author-name',
      placeholder: 'Ada Lovelace',
      autocomplete: 'off',
    }) as HTMLInputElement;
    name.value = author.name;
    name.addEventListener('change', () => commit({ name: name.value.trim() }));

    const email = el('input', {
      type: 'text',
      id: 'author-email',
      placeholder: 'ada@example.com',
      autocomplete: 'off',
    }) as HTMLInputElement;
    email.value = author.email;
    email.addEventListener('change', () => commit({ email: email.value.trim() }));

    card.appendChild(el('div', { class: 'field' }, [el('label', { for: 'author-name', text: 'NAME' }), name]));
    card.appendChild(el('div', { class: 'field' }, [el('label', { for: 'author-email', text: 'EMAIL' }), email]));

    const problem = authorProblem(author);
    if (problem) {
      card.appendChild(el('div', { class: 'qerror', style: 'margin-top:12px', text: problem }));
    }
    card.appendChild(
      el('div', {
        class: 'hint',
        style: 'margin-top:12px',
        text: 'GitHub links a commit to an account by email. An address GitHub does not recognise still shows the name, just without an avatar or profile link.',
      })
    );
  } else {
    card.appendChild(
      el('div', {
        class: 'hint',
        style: 'margin-top:12px',
        text:
          author.mode === 'original'
            ? 'Each replayed commit keeps the name and email it already has in your local history.'
            : 'Every replayed commit is authored by your own git identity (git config user.name and user.email).',
      })
    );
  }

  card.appendChild(
    el('div', { class: 'author-preview' }, [
      el('span', { class: 'flabel', text: 'ON GITHUB' }),
      el('span', { class: 'who', text: describeAuthor(author) }),
    ])
  );
  return card;
}

function describeAuthor(author: AuthorConfig): string {
  switch (author.mode) {
    case 'custom':
      return author.name.trim() && author.email.trim()
        ? `${author.name.trim()} <${author.email.trim()}>`
        : 'custom author — name and email needed';
    case 'self':
      return 'your git identity';
    default:
      return 'each commit’s original author';
  }
}

function authorProblem(author: AuthorConfig): string | null {
  if (author.mode !== 'custom') {
    return null;
  }
  if (!author.name.trim()) {
    return 'Enter a name for the custom author.';
  }
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(author.email.trim())) {
    return 'Enter a valid email address, for example ada@example.com.';
  }
  return null;
}

function renderRulesCard(): HTMLElement {
  const rules: [string, string, string, string][] = [
    ['OK', 'var(--c-green)', 'LOCAL REPO UNTOUCHED', 'Snapshots are extracted into a temp folder. Your branches, history and working tree are never written to.'],
    ['ON', 'var(--c-yellow)', 'KEEP VS CODE OPEN', 'Scheduled pushes fire from the extension. If VS Code was closed when one came due, you are asked before anything pushes.'],
    ['!!', 'var(--c-red)', 'FAILURES HOLD THE QUEUE', 'A failed push pauses the rest of the run. Retry it, then resume — nothing skips ahead silently.'],
    ['Y', 'var(--c-pink)', 'MERGES GO LINEAR', 'Merge commits replay as single-parent commits carrying the merged snapshot.'],
  ];
  const legend: [QueueItemStatus, string][] = [
    ['queued', 'cued, not timed'],
    ['armed', 'timer running'],
    ['live', 'pushing now'],
    ['sent', 'landed on remote'],
    ['failed', 'push failed'],
    ['cancelled', 'pulled from run'],
  ];

  return el('section', { class: 'card' }, [
    el('h2', { class: 'card-title', text: 'HOW THE DECK WORKS' }),
    el(
      'ul',
      { class: 'rules' },
      rules.map(([ico, color, title, text]) =>
        el('li', {}, [
          el('span', { class: 'ico', style: `--ico:${color}`, text: ico }),
          el('span', {}, [el('b', { text: title }), text]),
        ])
      )
    ),
    el('h2', { class: 'card-title', style: 'margin-top:24px', text: 'STATES' }),
    el(
      'div',
      { class: 'legend' },
      legend.map(([status, text]) => el('div', {}, [el('span', { class: `pill ${status}`, text: status }), text]))
    ),
  ]);
}

function renderLogStrip(): HTMLElement {
  const c = counts();
  return el('div', { class: 'strip' }, [
    el('span', { class: 'label num', text: `${c.sent} SENT · ${c.failed} FAILED` }),
    el('div', { class: 'grow' }),
    button('BACK TO REEL', 'blue', () => setTab('reel')),
  ]);
}

function renderLog(): HTMLElement {
  const scroll = el('div', { class: 'stage-scroll', id: 'log-scroll' });
  const done = (state.run?.items ?? [])
    .filter((i) => i.status === 'sent' || i.status === 'failed')
    .sort((a, b) => Date.parse(b.completedAt ?? b.pushAt) - Date.parse(a.completedAt ?? a.pushAt));

  if (done.length === 0) {
    scroll.appendChild(
      el('div', { class: 'card', style: 'max-width:560px;margin:40px auto' }, [
        empty('>_', 'NO BROADCASTS YET', 'Every push that lands or fails is recorded here, with the SHA it became on the remote.'),
      ])
    );
    return scroll;
  }

  const table = el('table', { class: 'log-table' });
  table.appendChild(
    el('thead', {}, [
      el('tr', {}, ['STATE', 'LOCAL → REMOTE', 'COMMIT', 'STAMPED', 'PUSHED', ''].map((h) => el('th', { text: h }))),
    ])
  );
  const body = el('tbody');
  for (const item of done) {
    const stamp =
      item.commitDateMode === 'original'
        ? shortDate(item.originalDate)
        : item.commitDateMode === 'custom'
          ? shortDate(item.customCommitDate ?? item.originalDate)
          : 'at push';
    const action =
      item.status === 'failed'
        ? button('RETRY', 'sm green', () => post({ type: 'RETRY_ITEM', id: item.id }))
        : null;
    body.appendChild(
      el('tr', {}, [
        el('td', {}, [el('span', { class: `pill ${item.status}`, text: item.status })]),
        el('td', { class: 'sha' }, [
          item.shortSha,
          el('span', { class: 'arrow', text: '→' }),
          item.replayedSha ? item.replayedSha.slice(0, 7) : '———',
        ]),
        el('td', { class: 'subject', title: item.error ?? item.subject, text: item.subject }),
        el('td', { class: 'num', text: stamp }),
        el('td', { class: 'num', text: item.completedAt ? clockTime(item.completedAt) : '—' }),
        el('td', {}, [action]),
      ])
    );
  }
  table.appendChild(body);
  scroll.appendChild(el('div', { class: 'log-wrap' }, [table]));
  return scroll;
}

function segmented<T extends string>(options: [T, string][], active: T, onChange: (value: T) => void): HTMLElement {
  const wrap = el('div', { class: 'segmented', 'data-mode': active, role: 'group' });
  const index = Math.max(0, options.findIndex(([value]) => value === active));
  wrap.appendChild(
    el('div', {
      class: 'thumb',
      style: `width:calc(100% / ${options.length});transform:translateX(${index * 100}%)`,
    })
  );
  for (const [value, label] of options) {
    const b = el('button', { text: label, 'aria-pressed': String(value === active) });
    b.addEventListener('click', () => onChange(value));
    wrap.appendChild(b);
  }
  return wrap;
}

function renderModal(): HTMLElement | null {
  const modal = state.modal;
  if (!modal) {
    return null;
  }
  const close = () => {
    state.modal = null;
    render();
  };

  const body = el('div', { class: 'modal-body' });
  if (modal.text) {
    body.appendChild(el('p', { text: modal.text }));
  }
  if (modal.summary) {
    const dl = el('dl', { class: 'modal-summary' });
    for (const [k, v] of modal.summary) {
      dl.appendChild(el('dt', { text: k }));
      dl.appendChild(el('dd', { text: v }));
    }
    body.appendChild(dl);
  }
  if (modal.code) {
    body.appendChild(el('pre', { text: modal.code }));
  }

  const actions = el('div', { class: 'modal-actions' }, [button(modal.confirm ? 'CANCEL' : 'CLOSE', '', close)]);
  if (modal.confirm) {
    const confirm = modal.confirm;
    actions.appendChild(
      button(modal.confirmLabel ?? 'CONFIRM', 'orange', () => {
        state.modal = null;
        confirm();
        render();
      })
    );
  }

  const backdrop = el('div', { class: 'backdrop' }, [
    el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { class: 'modal-head', text: modal.title }),
      body,
      actions,
    ]),
  ]);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) {
      close();
    }
  });
  return backdrop;
}

let toastStack: HTMLElement | null = null;

const SCROLLERS = ['reel-list', 'rail-scroll', 'queue-scroll', 'setup-scroll', 'log-scroll'];

function render(): void {
  const root = document.getElementById('root');
  if (!root) {
    return;
  }

  const scrolls = new Map(SCROLLERS.map((id) => [id, document.getElementById(id)?.scrollTop ?? 0]));
  const active = document.activeElement as HTMLInputElement | null;
  const activeId = active?.id;
  let caret: number | null = null;
  try {
    caret = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
  } catch {
    caret = null;
  }

  const strips: Record<Tab, () => HTMLElement> = {
    reel: renderReelStrip,
    queue: renderQueueStrip,
    setup: renderSetupStrip,
    log: renderLogStrip,
  };
  const stages: Record<Tab, () => HTMLElement> = {
    reel: renderReel,
    queue: renderQueue,
    setup: renderSetup,
    log: renderLog,
  };

  const frame = el('div', { class: 'frame' }, [
    renderHeader(),
    el('div', { class: 'device' }, [
      renderTabs(),
      strips[state.tab](),
      el('main', { class: 'stage' }, [stages[state.tab]()]),
    ]),
  ]);

  root.textContent = '';
  root.appendChild(frame);

  if (!toastStack) {
    toastStack = el('div', { class: 'toasts', 'aria-live': 'polite' });
  }
  root.appendChild(toastStack);

  const modal = renderModal();
  if (modal) {
    root.appendChild(modal);
  }

  for (const [id, top] of scrolls) {
    const node = document.getElementById(id);
    if (node) {
      node.scrollTop = top;
    }
  }

  if (activeId) {
    const restored = document.getElementById(activeId) as HTMLInputElement | null;
    if (restored) {
      restored.focus();
      if (caret !== null) {
        try {
          restored.setSelectionRange(caret, caret);
        } catch {}
      }
    }
  }
}

function showToast(level: 'info' | 'warn' | 'error', message: string, itemId?: string): void {
  if (!toastStack) {
    return;
  }
  const label = level === 'error' ? 'FAIL' : level === 'warn' ? 'HEADS UP' : 'OK';
  const content = el('div', {}, [message]);
  if (level === 'error') {
    const link = el('button', { class: 'link', text: 'SHOW DETAILS' });
    link.addEventListener('click', () => {
      const item = itemId ? state.run?.items.find((i) => i.id === itemId) : undefined;
      state.modal = { title: item ? `${item.shortSha} FAILED` : 'ERROR', code: item?.error ?? message };
      render();
    });
    content.appendChild(link);
  }
  const toast = el('div', { class: `toast ${level}` }, [el('span', { class: 'badge', text: label }), content]);
  toastStack.appendChild(toast);
  setTimeout(() => toast.remove(), level === 'error' ? 14_000 : 6000);
}

function tick(): void {
  const run = state.run;
  if (!run) {
    return;
  }
  for (const item of run.items) {
    const clock = document.querySelector(`[data-clock-for="${item.id}"]`);
    if (clock) {
      fillClock(clock, item);
    }
    const mini = document.querySelector(`[data-mini-for="${item.id}"]`);
    if (mini) {
      mini.textContent = shortTime(item);
    }
    if (isImminent(item)) {
      document.querySelector(`.commit-row[data-sha="${item.sha}"] .pulse-ring`)?.classList.add('animate');
    }
  }
}

let previousRunState: string | undefined;

window.addEventListener('message', (event: MessageEvent<ToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'INIT':
      state.config = message.config;
      state.version = message.config.version;
      state.commitDateMode = message.config.defaultCommitDateMode;
      state.staggerMinutes = message.config.defaultStaggerMinutes;
      state.author = message.config.author;
      state.targetBranch = message.config.targetBranch;
      state.targetRepoUrl = message.config.lastTargetRepoUrl;
      break;
    case 'HISTORY':
      state.repo = message.repo;
      state.commits = message.commits;
      state.historyError = null;
      break;
    case 'HISTORY_ERROR':
      state.historyError = message.message;
      state.commits = [];
      break;
    case 'COMMIT_DETAIL':
      state.details.set(message.sha, message.files);
      break;
    case 'RUN_STATE': {
      state.run = message.run;

      state.selected = new Set(
        (message.run?.items ?? []).filter((i) => i.status !== 'cancelled').map((i) => i.sha)
      );
      if (message.run?.targetRepoUrl && !state.targetRepoUrl) {
        state.targetRepoUrl = message.run.targetRepoUrl;
      }
      const nowState = message.run?.state;
      if (nowState === 'done' && previousRunState && previousRunState !== 'done') {
        const c = message.run!.items.filter((i) => i.status === 'sent').length;
        showToast('info', `Broadcast complete — ${c} commit${c === 1 ? '' : 's'} sent.`);
      }
      previousRunState = nowState;
      break;
    }
    case 'REPLAY_PROGRESS':
      if (message.status === 'failed') {
        showToast('error', `${message.sha.slice(0, 7)} failed to push. The rest of the queue is held.`, message.id);
      }
      break;
    case 'GITHUB_SESSION':
      state.account = message.account;
      state.connection = message.account ? 'signed-in' : 'signed-out';
      break;
    case 'GITHUB_REPOS':
      state.repos = message.repos;
      break;
    case 'CONNECTION':
      state.connection = message.state;
      break;
    case 'LOADING':
      state.loading[message.scope] = message.value;
      break;
    case 'TOAST':
      showToast(message.level, message.message, message.itemId);
      return;
  }
  render();
});

render();
post({ type: 'READY' });
setInterval(tick, 1000);
