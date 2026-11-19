// The forge's core: an in-memory git object store (real SHA-1 git objects: blobs, trees, commits,
// tags), the repository model, and the domain operations (issues, labels, pull requests, merges)
// that the REST, GraphQL and MCP surfaces all share, so every surface reads the same objects.

import { createHash } from 'node:crypto';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

/** The one authenticated user of a trial: wire.ts's seeded scenario viewer. */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const ZERO_OID = '0'.repeat(40);
const OID_RE = /^[0-9a-f]{40}$/;
export const isOid = (value: string): boolean => OID_RE.test(value);

/** SHA-1 over the git object framing `<type> <size>\0<data>` — the object id git itself computes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

// -------------------------------------------------------------------------------------------------
// trees
// -------------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000'
  name: string;
  oid: string;
}

const isDirMode = (mode: string): boolean => mode === '40000' || mode === '040000';

/** Git's tree sort: bytewise by name, directories compared as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return isDirMode(entry.mode) ? `${entry.name}/` : entry.name;
}

export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Serialize tree entries to git's binary tree format. */
export function buildTreeData(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse git's binary tree format. */
export function parseTreeData(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// -------------------------------------------------------------------------------------------------
// commits and tags
// -------------------------------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommitData(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommitData(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTagData(data: Buffer): TagView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const out: TagView = { object: '', type: '', tag: '', tagger: '', message: blank < 0 ? '' : text.slice(blank + 2) };
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') out.object = value;
    else if (key === 'type') out.type = value;
    else if (key === 'tag') out.tag = value;
    else if (key === 'tagger') out.tagger = value;
  }
  return out;
}

/** The unix-seconds timestamp inside an author/committer line ("Name <mail> 1735689600 +0000"). */
export function identTimestamp(ident: string): number {
  const match = / (\d{9,}) [+-]\d{4}$/.exec(ident.trim());
  return match ? Number(match[1]) : 0;
}

// -------------------------------------------------------------------------------------------------
// the repository model
// -------------------------------------------------------------------------------------------------

export interface IssueComment {
  id: number;
  body: string;
  createdSec: number;
}

export interface Issue {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdSec: number;
}

export interface Pull {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAtSec: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdSec: number;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  createdSec: number;
  objects = new Map<string, GitObj>();
  /** Full ref name ("refs/heads/main") -> object id. */
  refs = new Map<string, string>();
  /** The ref HEAD names; the default branch is this ref's last segment. */
  headRef = 'refs/heads/main';
  issues: Issue[] = [];
  pulls: Pull[] = [];
  labels = new Map<string, Label>();
  /** One shared counter for issue and pull-request numbers, as on GitHub. */
  nextNumber = 1;

  constructor(id: number, owner: string, name: string, isPrivate: boolean, description: string, createdSec: number) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
    this.createdSec = createdSec;
  }

  get defaultBranch(): string {
    return this.headRef.replace(/^refs\/heads\//, '');
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  store(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): GitObj | undefined {
    return this.objects.get(oid);
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }
}

/** Every object reachable from `roots` (commit -> tree+parents, tag -> target, tree -> entries). */
export function collectReachable(repo: Repo, roots: Iterable<string>, allowMissing = false): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.get(oid);
    if (!object) {
      if (allowMissing) continue;
      throw new Error(`object ${oid} is missing`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommitData(object.data);
      queue.push(commit.tree);
      queue.push(...commit.parents);
    } else if (object.type === 'tag') {
      queue.push(parseTagData(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTreeData(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Peel a ref target to a commit id, following annotated tags. Null when it never reaches a commit. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = repo.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTagData(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** All commit ids reachable from a tip, newest first (BFS distance from the tip, oid tie-break). */
export function commitAncestors(repo: Repo, tip: string): string[] {
  const distance = new Map<string, number>();
  const queue: Array<{ oid: string; level: number }> = [{ oid: tip, level: 0 }];
  while (queue.length) {
    const { oid, level } = queue.shift()!;
    if (distance.has(oid)) continue;
    const object = repo.get(oid);
    if (!object || object.type !== 'commit') continue;
    distance.set(oid, level);
    for (const parent of parseCommitData(object.data).parents) {
      queue.push({ oid: parent, level: level + 1 });
    }
  }
  return [...distance.entries()]
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
    .map(([oid]) => oid);
}

const seqByRepo = new WeakMap<Repo, Map<string, number>>();
let seqCounter = 0;

/** A monotone sequence number per stored commit, so listings order children before parents. */
export function commitSeq(repo: Repo, oid: string): number {
  let map = seqByRepo.get(repo);
  if (!map) {
    map = new Map();
    seqByRepo.set(repo, map);
  }
  let seq = map.get(oid);
  if (seq === undefined) {
    seq = seqCounter += 1;
    map.set(oid, seq);
  }
  return seq;
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.get(oid);
    if (!object || object.type !== 'commit') continue;
    stack.push(...parseCommitData(object.data).parents);
  }
  return false;
}

/** The best common ancestor of two commits (first hit walking from `b` against `a`'s ancestors). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOfA = new Set(commitAncestors(repo, a));
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = repo.get(oid);
    if (!object || object.type !== 'commit') continue;
    queue.push(...parseCommitData(object.data).parents);
  }
  return null;
}

// -------------------------------------------------------------------------------------------------
// trees as flat path maps
// -------------------------------------------------------------------------------------------------

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree (recursively) into path -> blob entry. An empty/missing tree flattens to nothing. */
export function flattenTree(repo: Repo, treeOid: string | null): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTreeData(object.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isDirMode(entry.mode)) walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  if (treeOid) walk(treeOid, '');
  return out;
}

/** The entries of the tree at `path` ('' is the root), or null when the path is not a directory. */
export function treeEntriesAt(repo: Repo, rootTree: string, path: string): TreeEntry[] | null {
  if (path === '') {
    const object = repo.get(rootTree);
    return object && object.type === 'tree' ? parseTreeData(object.data) : null;
  }
  let current = rootTree;
  for (const segment of path.split('/')) {
    const object = repo.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTreeData(object.data).find((candidate) => candidate.name === segment);
    if (!entry || !isDirMode(entry.mode)) return null;
    current = entry.oid;
  }
  const object = repo.get(current);
  return object && object.type === 'tree' ? parseTreeData(object.data) : null;
}

/** The blob entry at `path` under a root tree, or null. */
export function blobAtPath(repo: Repo, rootTree: string, path: string): FlatEntry | null {
  const segments = path.split('/');
  let current = rootTree;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTreeData(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) return isDirMode(entry.mode) ? null : { oid: entry.oid, mode: entry.mode };
    if (!isDirMode(entry.mode)) return null;
    current = entry.oid;
  }
  return null;
}

/** Build (and store) nested trees from a flat path map; answers the root tree id. */
export function buildTreeFromFlat(repo: Repo, flat: Map<string, FlatEntry>): string {
  interface Dir {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let dir = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      let next = dir.dirs.get(segments[index]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(segments[index], next);
      }
      dir = next;
    }
    dir.files.set(segments[segments.length - 1], entry);
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(sub) });
    return repo.store('tree', buildTreeData(entries));
  };
  return emit(root);
}

/** The tree id of a commit, or null. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommitData(object.data).tree;
}

// -------------------------------------------------------------------------------------------------
// the forge: all repositories plus the deterministic clock
// -------------------------------------------------------------------------------------------------

export class Forge {
  repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private tickCount = 0;
  readonly baseSec: number;

  constructor() {
    const fromEnv = process.env.MAKEFUN_TRIAL_NOW ?? '';
    let base = 1735689600; // 2025-01-01T00:00:00Z
    if (/^\d+$/.test(fromEnv)) base = Number(fromEnv);
    else if (fromEnv) {
      const parsed = Date.parse(fromEnv);
      if (Number.isFinite(parsed)) base = Math.floor(parsed / 1000);
    }
    this.baseSec = base;
  }

  /** Deterministic time: a fixed base plus a tick per call, so no wall clock reaches the data. */
  tick(): number {
    this.tickCount += 1;
    return this.baseSec + this.tickCount;
  }

  iso(sec: number): string {
    return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  ident(sec: number): string {
    return `${VIEWER.name} <${VIEWER.email}> ${sec} +0000`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo = new Repo(this.nextRepoId, owner, name, isPrivate, description, this.tick());
    this.nextRepoId += 1;
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  reposOf(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
  }

  newIssueId(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  newCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }
}

// -------------------------------------------------------------------------------------------------
// domain operations shared by REST, GraphQL and MCP
// -------------------------------------------------------------------------------------------------

export function createIssue(forge: Forge, repo: Repo, title: string, body: string, labels: string[]): Issue {
  const issue: Issue = {
    kind: 'issue',
    id: forge.newIssueId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdSec: forge.tick(),
  };
  repo.nextNumber += 1;
  repo.issues.push(issue);
  return issue;
}

export function createPull(forge: Forge, repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
  const pull: Pull = {
    kind: 'pull',
    id: forge.newIssueId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAtSec: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    createdSec: forge.tick(),
  };
  repo.nextNumber += 1;
  repo.pulls.push(pull);
  return pull;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string | null;
}

/** Line counts of a blob's content (a trailing newline does not make a phantom line). */
function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** A small LCS line diff for the additions/deletions counts of a modified file. */
function lineDiffCounts(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const a = before.toString('utf8').split('\n');
  const b = after.toString('utf8').split('\n');
  if (a.length * b.length > 4_000_000) {
    return { additions: b.length, deletions: a.length };
  }
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j];
      if (a[i - 1] === b[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j], dp[j - 1]);
      diagonal = above;
    }
  }
  const common = dp[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

/** The changed files of a pull request: the three-dot diff (merge-base tree -> head tree). */
export function pullFiles(repo: Repo, pull: Pull): FileChange[] {
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (!headTip) return [];
  const fromCommit = baseTip ? (mergeBase(repo, headTip, baseTip) ?? baseTip) : null;
  const before = flattenTree(repo, fromCommit ? commitTree(repo, fromCommit) : null);
  const after = flattenTree(repo, commitTree(repo, headTip));
  const changes: FileChange[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry && newEntry && oldEntry.oid === newEntry.oid) continue;
    if (!oldEntry && newEntry) {
      const blob = repo.get(newEntry.oid);
      const additions = blob ? lineCount(blob.data) : 0;
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, sha: newEntry.oid });
    } else if (oldEntry && !newEntry) {
      const blob = repo.get(oldEntry.oid);
      const deletions = blob ? lineCount(blob.data) : 0;
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, sha: oldEntry.oid });
    } else if (oldEntry && newEntry) {
      const oldBlob = repo.get(oldEntry.oid);
      const newBlob = repo.get(newEntry.oid);
      const counts = oldBlob && newBlob ? lineDiffCounts(oldBlob.data, newBlob.data) : { additions: 1, deletions: 1 };
      changes.push({
        filename: path,
        status: 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
        sha: newEntry.oid,
      });
    }
  }
  return changes;
}

/** Three-way tree merge; answers the merged flat map, or null on a real conflict. */
export function mergeTrees(
  repo: Repo,
  baseFlat: Map<string, FlatEntry>,
  headFlat: Map<string, FlatEntry>,
  otherFlat: Map<string, FlatEntry>,
): Map<string, FlatEntry> | null {
  const out = new Map<string, FlatEntry>();
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...otherFlat.keys()]);
  const same = (x?: FlatEntry, y?: FlatEntry): boolean => x?.oid === y?.oid && x?.mode === y?.mode;
  for (const path of paths) {
    const base = baseFlat.get(path);
    const head = headFlat.get(path);
    const other = otherFlat.get(path);
    if (same(head, other)) {
      if (head) out.set(path, head);
    } else if (same(base, head)) {
      if (other) out.set(path, other);
    } else if (same(base, other)) {
      if (head) out.set(path, head);
    } else {
      return null;
    }
  }
  return out;
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict' | 'not-open' | 'missing' };

/** Whether merging `pull` today would conflict (the GraphQL `mergeable` read). */
export function pullConflicts(repo: Repo, pull: Pull): boolean {
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (!headTip || !baseTip) return false;
  const base = mergeBase(repo, headTip, baseTip);
  if (!base || base === headTip || base === baseTip) return false;
  const merged = mergeTrees(
    repo,
    flattenTree(repo, commitTree(repo, base)),
    flattenTree(repo, commitTree(repo, headTip)),
    flattenTree(repo, commitTree(repo, baseTip)),
  );
  return merged === null;
}

/** Merge a pull request into its base branch (squash, merge-commit or fast-forward). */
export function mergePull(forge: Forge, repo: Repo, pull: Pull, method: string): MergeOutcome {
  if (pull.state !== 'open') return { ok: false, reason: 'not-open' };
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (!headTip || !baseTip) return { ok: false, reason: 'missing' };
  const sec = forge.tick();
  const ident = forge.ident(sec);
  let newTip: string;
  if (headTip === baseTip || isAncestor(repo, headTip, baseTip)) {
    // Already up to date: the base already contains the head.
    newTip = baseTip;
  } else if (method !== 'merge' && isAncestor(repo, baseTip, headTip)) {
    if (method === 'squash') {
      const tree = commitTree(repo, headTip);
      if (!tree) return { ok: false, reason: 'missing' };
      newTip = repo.store('commit', buildCommitData({
        tree,
        parents: [baseTip],
        author: ident,
        committer: ident,
        message: `${pull.title} (#${pull.number})\n`,
      }));
      commitSeq(repo, newTip);
    } else {
      newTip = headTip; // fast-forward
    }
  } else {
    const base = mergeBase(repo, headTip, baseTip);
    if (!base) return { ok: false, reason: 'conflict' };
    const merged = mergeTrees(
      repo,
      flattenTree(repo, commitTree(repo, base)),
      flattenTree(repo, commitTree(repo, headTip)),
      flattenTree(repo, commitTree(repo, baseTip)),
    );
    if (!merged) return { ok: false, reason: 'conflict' };
    const tree = buildTreeFromFlat(repo, merged);
    if (method === 'merge') {
      newTip = repo.store('commit', buildCommitData({
        tree,
        parents: [baseTip, headTip],
        author: ident,
        committer: ident,
        message: `Merge pull request #${pull.number} from ${pull.headRef}\n`,
      }));
    } else {
      newTip = repo.store('commit', buildCommitData({
        tree,
        parents: [baseTip],
        author: ident,
        committer: ident,
        message: `${pull.title} (#${pull.number})\n`,
      }));
    }
    commitSeq(repo, newTip);
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, newTip);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAtSec = sec;
  pull.mergeCommitSha = newTip;
  return { ok: true, sha: newTip };
}

/** Commit a new tree onto a branch (the contents API's write path). Answers the commit id. */
export function commitOnBranch(
  forge: Forge,
  repo: Repo,
  branch: string,
  flat: Map<string, FlatEntry>,
  message: string,
): string {
  const tree = buildTreeFromFlat(repo, flat);
  const parent = repo.branchTip(branch);
  const sec = forge.tick();
  const ident = forge.ident(sec);
  const oid = repo.store('commit', buildCommitData({
    tree,
    parents: parent ? [parent] : [],
    author: ident,
    committer: ident,
    message: message.endsWith('\n') ? message : `${message}\n`,
  }));
  commitSeq(repo, oid);
  repo.refs.set(`refs/heads/${branch}`, oid);
  return oid;
}
