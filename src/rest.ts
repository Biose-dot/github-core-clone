// The REST v3 surface: repositories, branches, commits, contents, the Git Data API, labels,
// issues + comments, and pull requests + files + merges. Every reply is JSON with a non-empty
// X-GitHub-Request-Id; errors are JSON {message}; the authenticated user is the scenario viewer.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  ZERO_OID,
  blobAtPath,
  buildCommitData,
  buildTreeFromFlat,
  commitAncestors,
  commitOnBranch,
  commitTree,
  createIssue,
  createPull,
  flattenTree,
  identTimestamp,
  isAncestor,
  isOid,
  mergePull,
  parseCommitData,
  parseTreeData,
  peelToCommit,
  pullFiles,
  treeEntriesAt,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './core.ts';
import { encodeGlobalId } from './ids.ts';

export interface RestContext {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  /** Path segments after /api/v3, each decodeURIComponent'd. */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body (undefined when there was no body). */
  body: unknown;
  /** True when a body was sent but did not parse as JSON. */
  bodyError: boolean;
  requestId: string;
  host: string;
  pathname: string;
}

type Ctx = RestContext;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function send(ctx: Ctx, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': ctx.requestId,
    'x-github-media-type': 'github.v3',
    ...(text ? { 'content-length': Buffer.byteLength(text) } : {}),
    ...extra,
  });
  ctx.res.end(text);
}

function fail(ctx: Ctx, status: number, message: string): void {
  send(ctx, status, { message });
}

function bodyObject(ctx: Ctx): Record<string, unknown> | null {
  if (ctx.bodyError) {
    fail(ctx, 400, 'Problems parsing JSON');
    return null;
  }
  return isRecord(ctx.body) ? ctx.body : {};
}

// -------------------------------------------------------------------------------------------------
// serializers
// -------------------------------------------------------------------------------------------------

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: encodeGlobalId('User', [VIEWER.id]),
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: encodeGlobalId('Repository', [repo.id]),
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    owner: userJson(),
    description: repo.description,
    fork: false,
    created_at: repo.createdSec ? new Date(repo.createdSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : undefined,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: label?.description ?? null, default: false };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: encodeGlobalId('Issue', [repo.id, issue.number]),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(),
    comments: issue.comments.length,
    created_at: forge.iso(issue.createdSec),
    updated_at: forge.iso(issue.createdSec),
    closed_at: null,
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.branchTip(pull.headRef) ?? ZERO_OID;
  const baseSha = repo.branchTip(pull.baseRef) ?? ZERO_OID;
  return {
    id: pull.id,
    node_id: encodeGlobalId('PullRequest', [repo.id, pull.number]),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    merged_at: pull.mergedAtSec !== null ? forge.iso(pull.mergedAtSec) : null,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(),
    created_at: forge.iso(pull.createdSec),
    updated_at: forge.iso(pull.createdSec),
    closed_at: pull.mergedAtSec !== null ? forge.iso(pull.mergedAtSec) : null,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha },
  };
}

function commentJson(forge: Forge, comment: { id: number; body: string; createdSec: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: encodeGlobalId('IssueComment', [comment.id]),
    body: comment.body,
    user: userJson(),
    created_at: forge.iso(comment.createdSec),
    updated_at: forge.iso(comment.createdSec),
  };
}

function identJson(ident: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(ident.trim());
  if (!match) return { name: ident, email: '', date: new Date(0).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  return {
    name: match[1],
    email: match[2],
    date: new Date(Number(match[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

export function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const object = repo.get(oid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommitData(object.data);
  return {
    sha: oid,
    node_id: oid,
    commit: {
      message: commit.message.replace(/\n$/, ''),
      author: identJson(commit.author),
      committer: identJson(commit.committer),
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((sha) => ({ sha })),
    author: userJson(),
    committer: userJson(),
  };
}

// -------------------------------------------------------------------------------------------------
// pagination
// -------------------------------------------------------------------------------------------------

function paginate<T>(ctx: Ctx, items: T[]): T[] {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const base = `http://${ctx.host}${ctx.pathname}`;
  const params = new URLSearchParams(ctx.query);
  const links: string[] = [];
  const linkFor = (targetPage: number, rel: string): string => {
    params.set('per_page', String(perPage));
    params.set('page', String(targetPage));
    return `<${base}?${params.toString()}>; rel="${rel}"`;
  };
  if (page < totalPages) {
    links.push(linkFor(page + 1, 'next'));
    links.push(linkFor(totalPages, 'last'));
  }
  if (page > 1) {
    links.push(linkFor(page - 1, 'prev'));
    links.push(linkFor(1, 'first'));
  }
  if (links.length) ctx.res.setHeader('link', links.join(', '));
  return items.slice((page - 1) * perPage, page * perPage);
}

// -------------------------------------------------------------------------------------------------
// repository helpers
// -------------------------------------------------------------------------------------------------

function requireRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  const repo = ctx.forge.getRepo(owner, name);
  if (!repo) {
    fail(ctx, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** Resolve a ref parameter (branch name, tag name, or commit sha) to a commit id. */
function resolveCommit(repo: Repo, ref: string | null): string | null {
  if (!ref) {
    const tip = repo.branchTip(repo.defaultBranch);
    return tip ?? null;
  }
  const branchTip = repo.branchTip(ref);
  if (branchTip) return branchTip;
  const tagTip = repo.refs.get(`refs/tags/${ref}`);
  if (tagTip) return peelToCommit(repo, tagTip);
  if (isOid(ref)) {
    const object = repo.get(ref);
    if (object?.type === 'commit') return ref;
    if (object?.type === 'tag') return peelToCommit(repo, ref);
  }
  return null;
}

const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// -------------------------------------------------------------------------------------------------
// route handlers
// -------------------------------------------------------------------------------------------------

function handleUserRepos(ctx: Ctx): void {
  const method = ctx.req.method ?? 'GET';
  if (method === 'GET') {
    const repos = ctx.forge.reposOf(VIEWER.login).map(repoJson);
    send(ctx, 200, paginate(ctx, repos));
    return;
  }
  if (method === 'POST') {
    const body = bodyObject(ctx);
    if (!body) return;
    const name = typeof body.name === 'string' ? body.name : '';
    if (!REPO_NAME_RE.test(name)) {
      fail(ctx, 422, 'name is invalid');
      return;
    }
    if (ctx.forge.getRepo(VIEWER.login, name)) {
      send(ctx, 422, {
        message: 'Repository creation failed.',
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      });
      return;
    }
    const repo = ctx.forge.createRepo(
      VIEWER.login,
      name,
      body.private === true,
      typeof body.description === 'string' ? body.description : '',
    );
    if (body.auto_init === true) {
      const flat = new Map<string, { oid: string; mode: string }>();
      const readme = repo.store('blob', Buffer.from(`# ${name}\n`, 'utf8'));
      flat.set('README.md', { oid: readme, mode: '100644' });
      commitOnBranch(ctx.forge, repo, repo.defaultBranch, flat, 'Initial commit');
    }
    send(ctx, 201, repoJson(repo));
    return;
  }
  fail(ctx, 404, 'Not Found');
}

function handleRepo(ctx: Ctx, owner: string, name: string): void {
  const method = ctx.req.method ?? 'GET';
  if (method === 'DELETE') {
    if (!ctx.forge.deleteRepo(owner, name)) {
      fail(ctx, 404, 'Not Found');
      return;
    }
    send(ctx, 204, undefined);
    return;
  }
  const repo = requireRepo(ctx, owner, name);
  if (!repo) return;
  if (method === 'GET') {
    send(ctx, 200, repoJson(repo));
    return;
  }
  if (method === 'PATCH') {
    const body = bodyObject(ctx);
    if (!body) return;
    if (typeof body.private === 'boolean') repo.isPrivate = body.private;
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.default_branch === 'string' && repo.branchTip(body.default_branch)) {
      repo.headRef = `refs/heads/${body.default_branch}`;
    }
    if (typeof body.name === 'string' && REPO_NAME_RE.test(body.name) && body.name !== repo.name) {
      ctx.forge.repos.delete(repo.fullName);
      repo.name = body.name;
      ctx.forge.repos.set(repo.fullName, repo);
    }
    send(ctx, 200, repoJson(repo));
    return;
  }
  fail(ctx, 404, 'Not Found');
}

function handleBranches(ctx: Ctx, repo: Repo, rest: string[]): void {
  const method = ctx.req.method ?? 'GET';
  if (rest.length === 0) {
    if (method !== 'GET') return fail(ctx, 404, 'Not Found');
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    send(ctx, 200, paginate(ctx, branches));
    return;
  }
  const branch = rest.join('/');
  const tip = repo.branchTip(branch);
  if (!tip) return fail(ctx, 404, 'Not Found');
  if (method === 'GET') {
    send(ctx, 200, { name: branch, commit: { sha: tip }, protected: false });
    return;
  }
  fail(ctx, 404, 'Not Found');
}

function handleCommits(ctx: Ctx, repo: Repo, rest: string[]): void {
  const method = ctx.req.method ?? 'GET';
  if (method !== 'GET') return fail(ctx, 404, 'Not Found');
  if (rest.length === 1) {
    const commit = commitJson(repo, rest[0]);
    if (!commit) return fail(ctx, 404, 'Not Found');
    send(ctx, 200, commit);
    return;
  }
  const ref = ctx.query.get('sha');
  const tip = resolveCommit(repo, ref);
  if (!tip) {
    send(ctx, 200, []);
    return;
  }
  const commits = commitAncestors(repo, tip)
    .map((oid) => commitJson(repo, oid))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  send(ctx, 200, paginate(ctx, commits));
}

function contentFileJson(repo: Repo, path: string, oid: string): Record<string, unknown> {
  const object = repo.get(oid);
  const data = object?.data ?? Buffer.alloc(0);
  const base64 = data.toString('base64');
  const wrapped = base64.replace(/(.{60})/g, '$1\n') + (base64 ? '\n' : '');
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: path.split('/').pop() ?? path,
    path,
    sha: oid,
    content: wrapped,
  };
}

function handleContents(ctx: Ctx, repo: Repo, path: string): void {
  const method = ctx.req.method ?? 'GET';
  if (method === 'GET') {
    const tip = resolveCommit(repo, ctx.query.get('ref'));
    if (!tip) return fail(ctx, 404, 'Not Found');
    const tree = commitTree(repo, tip);
    if (!tree) return fail(ctx, 404, 'Not Found');
    if (path === '') {
      const entries = treeEntriesAt(repo, tree, '') ?? [];
      send(ctx, 200, entries.map((entry) => ({
        type: entry.mode === '40000' || entry.mode === '040000' ? 'dir' : 'file',
        name: entry.name,
        path: entry.name,
        sha: entry.oid,
      })));
      return;
    }
    const blob = blobAtPath(repo, tree, path);
    if (blob) {
      send(ctx, 200, contentFileJson(repo, path, blob.oid));
      return;
    }
    const entries = treeEntriesAt(repo, tree, path);
    if (entries) {
      send(ctx, 200, entries.map((entry) => ({
        type: entry.mode === '40000' || entry.mode === '040000' ? 'dir' : 'file',
        name: entry.name,
        path: `${path}/${entry.name}`,
        sha: entry.oid,
      })));
      return;
    }
    return fail(ctx, 404, 'Not Found');
  }
  if (method === 'PUT') {
    const body = bodyObject(ctx);
    if (!body) return;
    if (path === '') return fail(ctx, 422, 'path is required');
    const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    // A write naming a new branch starts it from the default branch, as the suite's fallback expects.
    if (!repo.refs.has(`refs/heads/${branch}`)) {
      const defaultTip = repo.branchTip(repo.defaultBranch);
      if (defaultTip) repo.refs.set(`refs/heads/${branch}`, defaultTip);
    }
    const tip = repo.branchTip(branch);
    const flat = flattenTree(repo, tip ? commitTree(repo, tip) : null);
    const existing = flat.get(path);
    const shaGiven = typeof body.sha === 'string' ? body.sha : undefined;
    if (existing) {
      if (shaGiven === undefined) {
        send(ctx, 422, { message: "sha wasn't supplied." });
        return;
      }
      if (shaGiven !== existing.oid) {
        fail(ctx, 409, `${path} does not match ${shaGiven}`);
        return;
      }
    } else if (shaGiven !== undefined) {
      fail(ctx, 422, 'sha is supplied for a file that does not exist');
      return;
    }
    const raw = typeof body.content === 'string' ? body.content.replace(/\s+/g, '') : '';
    const data = Buffer.from(raw, 'base64');
    const blobOid = repo.store('blob', data);
    flat.set(path, { oid: blobOid, mode: '100644' });
    const commit = commitOnBranch(ctx.forge, repo, branch, flat, message);
    send(ctx, existing ? 200 : 201, {
      content: contentFileJson(repo, path, blobOid),
      commit: { sha: commit, message },
    });
    return;
  }
  if (method === 'DELETE') {
    const body = bodyObject(ctx);
    if (!body) return;
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const tip = repo.branchTip(branch);
    if (!tip) return fail(ctx, 404, 'Not Found');
    const flat = flattenTree(repo, commitTree(repo, tip));
    const existing = flat.get(path);
    if (!existing) return fail(ctx, 404, 'Not Found');
    if (typeof body.sha === 'string' && body.sha !== existing.oid) {
      fail(ctx, 409, `${path} does not match ${body.sha}`);
      return;
    }
    flat.delete(path);
    const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
    const commit = commitOnBranch(ctx.forge, repo, branch, flat, message);
    send(ctx, 200, { content: null, commit: { sha: commit, message } });
    return;
  }
  fail(ctx, 404, 'Not Found');
}

function handleGitData(ctx: Ctx, repo: Repo, rest: string[]): void {
  const method = ctx.req.method ?? 'GET';
  const [kind, ...tail] = rest;
  if (kind === 'refs') {
    if (tail.length === 0) {
      if (method === 'GET') {
        const refs = [...repo.refs.entries()]
          .map(([ref, sha]) => ({ ref, object: { sha, type: repo.get(sha)?.type ?? 'commit' } }))
          .sort((a, b) => (a.ref < b.ref ? -1 : 1));
        send(ctx, 200, paginate(ctx, refs));
        return;
      }
      if (method === 'POST') {
        const body = bodyObject(ctx);
        if (!body) return;
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.get(sha)) {
          fail(ctx, 422, 'ref or sha is invalid');
          return;
        }
        if (repo.refs.has(ref)) {
          fail(ctx, 422, 'Reference already exists');
          return;
        }
        repo.refs.set(ref, sha);
        send(ctx, 201, { ref, object: { sha, type: repo.get(sha)?.type ?? 'commit' } });
        return;
      }
      return fail(ctx, 404, 'Not Found');
    }
    const ref = `refs/${tail.join('/')}`;
    const current = repo.refs.get(ref);
    if (method === 'GET') {
      if (!current) return fail(ctx, 404, 'Not Found');
      send(ctx, 200, { ref, object: { sha: current, type: repo.get(current)?.type ?? 'commit' } });
      return;
    }
    if (method === 'PATCH') {
      const body = bodyObject(ctx);
      if (!body) return;
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!isOid(sha) || !repo.get(sha)) return fail(ctx, 422, 'sha is invalid');
      if (current && ref.startsWith('refs/heads/') && body.force !== true) {
        const currentCommit = peelToCommit(repo, current);
        const newCommit = peelToCommit(repo, sha);
        if (currentCommit && newCommit && !isAncestor(repo, currentCommit, newCommit)) {
          fail(ctx, 422, 'Update is not a fast-forward');
          return;
        }
      }
      repo.refs.set(ref, sha);
      send(ctx, 200, { ref, object: { sha, type: repo.get(sha)?.type ?? 'commit' } });
      return;
    }
    if (method === 'DELETE') {
      if (!current) return fail(ctx, 404, 'Not Found');
      repo.refs.delete(ref);
      send(ctx, 204, undefined);
      return;
    }
    return fail(ctx, 404, 'Not Found');
  }
  if (kind === 'blobs') {
    if (method === 'POST' && tail.length === 0) {
      const body = bodyObject(ctx);
      if (!body) return;
      const content = typeof body.content === 'string' ? body.content : '';
      const data = body.encoding === 'base64' ? Buffer.from(content.replace(/\s+/g, ''), 'base64') : Buffer.from(content, 'utf8');
      const sha = repo.store('blob', data);
      send(ctx, 201, { sha, url: '' });
      return;
    }
    if (method === 'GET' && tail.length === 1) {
      const object = repo.get(tail[0]);
      if (!object || object.type !== 'blob') return fail(ctx, 404, 'Not Found');
      send(ctx, 200, {
        sha: tail[0],
        size: object.data.length,
        encoding: 'base64',
        content: object.data.toString('base64'),
      });
      return;
    }
    return fail(ctx, 404, 'Not Found');
  }
  if (kind === 'trees') {
    if (method === 'POST' && tail.length === 0) {
      const body = bodyObject(ctx);
      if (!body) return;
      const flat = new Map<string, { oid: string; mode: string }>();
      if (typeof body.base_tree === 'string' && repo.get(body.base_tree)?.type === 'tree') {
        for (const [path, entry] of flattenTree(repo, body.base_tree)) flat.set(path, entry);
      }
      const entries = Array.isArray(body.tree) ? body.tree : [];
      for (const entry of entries) {
        if (!isRecord(entry) || typeof entry.path !== 'string') continue;
        if (entry.type === 'tree') continue;
        let oid: string | null = null;
        if (typeof entry.sha === 'string' && repo.get(entry.sha)) oid = entry.sha;
        else if (typeof entry.content === 'string') oid = repo.store('blob', Buffer.from(entry.content, 'utf8'));
        if (!oid) continue;
        flat.set(entry.path, { oid, mode: typeof entry.mode === 'string' ? entry.mode : '100644' });
      }
      const sha = buildTreeFromFlat(repo, flat);
      send(ctx, 201, { sha, url: '' });
      return;
    }
    if (method === 'GET' && tail.length === 1) {
      const object = repo.get(tail[0]);
      if (!object || object.type !== 'tree') return fail(ctx, 404, 'Not Found');
      const recursive = ctx.query.get('recursive') === '1' || ctx.query.get('recursive') === 'true';
      const tree: Array<Record<string, unknown>> = [];
      if (recursive) {
        const walk = (treeOid: string, prefix: string): void => {
          const current = repo.get(treeOid);
          if (!current || current.type !== 'tree') return;
          for (const entry of parseTreeData(current.data)) {
            const path = prefix ? `${prefix}/${entry.name}` : entry.name;
            tree.push({ path, mode: entry.mode, type: entry.mode === '40000' || entry.mode === '040000' ? 'tree' : 'blob', sha: entry.oid });
            if (entry.mode === '40000' || entry.mode === '040000') walk(entry.oid, path);
          }
        };
        walk(tail[0], '');
      } else {
        for (const entry of parseTreeData(object.data)) {
          tree.push({ path: entry.name, mode: entry.mode, type: entry.mode === '40000' || entry.mode === '040000' ? 'tree' : 'blob', sha: entry.oid });
        }
      }
      send(ctx, 200, { sha: tail[0], tree, truncated: false });
      return;
    }
    return fail(ctx, 404, 'Not Found');
  }
  if (kind === 'commits') {
    if (method === 'POST' && tail.length === 0) {
      const body = bodyObject(ctx);
      if (!body) return;
      const tree = typeof body.tree === 'string' ? body.tree : '';
      if (!repo.get(tree) || repo.get(tree)?.type !== 'tree') return fail(ctx, 422, 'tree is invalid');
      const parents = Array.isArray(body.parents) ? body.parents.filter((p): p is string => typeof p === 'string') : [];
      const message = typeof body.message === 'string' ? body.message : '';
      const sec = ctx.forge.tick();
      const ident = ctx.forge.ident(sec);
      const authorLine = isRecord(body.author) && typeof body.author.name === 'string'
        ? `${body.author.name} <${typeof body.author.email === 'string' ? body.author.email : ''}> ${sec} +0000`
        : ident;
      const sha = repo.store('commit', buildCommitData({ tree, parents, author: authorLine, committer: ident, message }));
      const commit = commitJson(repo, sha);
      send(ctx, 201, commit ?? { sha });
      return;
    }
    if (method === 'GET' && tail.length === 1) {
      const commit = commitJson(repo, tail[0]);
      if (!commit) return fail(ctx, 404, 'Not Found');
      send(ctx, 200, commit);
      return;
    }
    return fail(ctx, 404, 'Not Found');
  }
  fail(ctx, 404, 'Not Found');
}

function handleLabels(ctx: Ctx, repo: Repo, rest: string[]): void {
  const method = ctx.req.method ?? 'GET';
  if (rest.length === 0) {
    if (method === 'GET') {
      send(ctx, 200, [...repo.labels.keys()].sort().map((name) => labelJson(repo, name)));
      return;
    }
    if (method === 'POST') {
      const body = bodyObject(ctx);
      if (!body) return;
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) return fail(ctx, 422, 'name is required');
      if (repo.labels.has(name)) return fail(ctx, 422, 'Label already exists');
      repo.labels.set(name, {
        name,
        color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
        description: typeof body.description === 'string' ? body.description : '',
      });
      send(ctx, 201, labelJson(repo, name));
      return;
    }
    return fail(ctx, 404, 'Not Found');
  }
  const name = rest.join('/');
  if (!repo.labels.has(name)) return fail(ctx, 404, 'Not Found');
  if (method === 'GET') {
    send(ctx, 200, labelJson(repo, name));
    return;
  }
  if (method === 'DELETE') {
    repo.labels.delete(name);
    send(ctx, 204, undefined);
    return;
  }
  fail(ctx, 404, 'Not Found');
}

function labelNamesFrom(body: Record<string, unknown>): string[] {
  const raw = body.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
  }
  return names;
}

function handleIssues(ctx: Ctx, repo: Repo, rest: string[]): void {
  const method = ctx.req.method ?? 'GET';
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      issues = [...issues].sort((a, b) => a.number - b.number);
      if (sort === 'created' && direction === 'desc') issues.reverse();
      send(ctx, 200, paginate(ctx, issues).map((issue) => issueJson(ctx.forge, repo, issue)));
      return;
    }
    if (method === 'POST') {
      const body = bodyObject(ctx);
      if (!body) return;
      const title = typeof body.title === 'string' ? body.title : '';
      if (!title) return fail(ctx, 422, 'title is required');
      const labels = labelNamesFrom(body);
      for (const name of labels) {
        if (!repo.labels.has(name)) return fail(ctx, 422, `label "${name}" does not exist`);
      }
      const issue = createIssue(ctx.forge, repo, title, typeof body.body === 'string' ? body.body : '', labels);
      send(ctx, 201, issueJson(ctx.forge, repo, issue));
      return;
    }
    return fail(ctx, 404, 'Not Found');
  }
  const number = Number(rest[0]);
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (!issue) return fail(ctx, 404, 'Not Found');
  if (rest.length === 1) {
    if (method === 'GET') {
      send(ctx, 200, issueJson(ctx.forge, repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const body = bodyObject(ctx);
      if (!body) return;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      const labels = labelNamesFrom(body);
      if (Array.isArray(body.labels)) {
        for (const name of labels) {
          if (!repo.labels.has(name)) return fail(ctx, 422, `label "${name}" does not exist`);
        }
        issue.labels = labels;
      }
      send(ctx, 200, issueJson(ctx.forge, repo, issue));
      return;
    }
    return fail(ctx, 404, 'Not Found');
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      send(ctx, 200, paginate(ctx, issue.comments).map((comment) => commentJson(ctx.forge, comment)));
      return;
    }
    if (method === 'POST') {
      const body = bodyObject(ctx);
      if (!body) return;
      const comment = {
        id: ctx.forge.newCommentId(),
        body: typeof body.body === 'string' ? body.body : '',
        createdSec: ctx.forge.tick(),
      };
      issue.comments.push(comment);
      send(ctx, 201, commentJson(ctx.forge, comment));
      return;
    }
    return fail(ctx, 404, 'Not Found');
  }
  if (rest.length === 2 && rest[1] === 'labels') {
    if (method === 'POST') {
      const raw = Array.isArray(ctx.body) ? ctx.body : (isRecord(ctx.body) ? ctx.body.labels : []);
      const names = (Array.isArray(raw) ? raw : []).map((entry) => (typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.name === 'string' ? entry.name : '')).filter(Boolean);
      for (const name of names) {
        if (!repo.labels.has(name)) return fail(ctx, 422, `label "${name}" does not exist`);
        if (!issue.labels.includes(name)) issue.labels.push(name);
      }
      send(ctx, 200, issue.labels.map((name) => labelJson(repo, name)));
      return;
    }
    return fail(ctx, 404, 'Not Found');
  }
  fail(ctx, 404, 'Not Found');
}

function handlePulls(ctx: Ctx, repo: Repo, rest: string[]): void {
  const method = ctx.req.method ?? 'GET';
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      pulls = [...pulls].sort((a, b) => a.number - b.number);
      const direction = ctx.query.get('direction') ?? 'desc';
      if (direction === 'desc') pulls.reverse();
      send(ctx, 200, paginate(ctx, pulls).map((pull) => pullJson(ctx.forge, repo, pull)));
      return;
    }
    if (method === 'POST') {
      const body = bodyObject(ctx);
      if (!body) return;
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head.replace(/^[^:]+:/, '') : '';
      const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      if (!title) return fail(ctx, 422, 'title is required');
      if (!repo.branchTip(head)) return fail(ctx, 422, `head branch "${head}" does not exist`);
      if (!repo.branchTip(base)) return fail(ctx, 422, `base branch "${base}" does not exist`);
      if (head === base) return fail(ctx, 422, 'head and base are the same');
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate) return fail(ctx, 422, `A pull request already exists for ${head} into ${base}.`);
      const pull = createPull(ctx.forge, repo, title, typeof body.body === 'string' ? body.body : '', head, base);
      send(ctx, 201, pullJson(ctx.forge, repo, pull));
      return;
    }
    return fail(ctx, 404, 'Not Found');
  }
  const number = Number(rest[0]);
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (!pull) return fail(ctx, 404, 'Not Found');
  if (rest.length === 1) {
    if (method === 'GET') {
      send(ctx, 200, pullJson(ctx.forge, repo, pull));
      return;
    }
    if (method === 'PATCH') {
      const body = bodyObject(ctx);
      if (!body) return;
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if ((body.state === 'open' || body.state === 'closed') && !pull.merged) pull.state = body.state;
      if (typeof body.base === 'string' && repo.branchTip(body.base)) pull.baseRef = body.base;
      send(ctx, 200, pullJson(ctx.forge, repo, pull));
      return;
    }
    return fail(ctx, 404, 'Not Found');
  }
  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') return fail(ctx, 404, 'Not Found');
    const files = pullFiles(repo, pull).map((change) => ({
      sha: change.sha,
      filename: change.filename,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
    }));
    send(ctx, 200, paginate(ctx, files));
    return;
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (method === 'GET') {
      if (pull.merged) send(ctx, 204, undefined);
      else fail(ctx, 404, 'Not Found');
      return;
    }
    if (method === 'PUT') {
      const body = bodyObject(ctx);
      if (!body) return;
      if (pull.merged) return fail(ctx, 405, 'Pull Request has already been merged');
      if (pull.state !== 'open') return fail(ctx, 405, 'Pull Request is not mergeable');
      const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
      const outcome = mergePull(ctx.forge, repo, pull, mergeMethod);
      if (!outcome.ok) {
        if (outcome.reason === 'conflict') return fail(ctx, 405, 'Pull Request is not mergeable');
        if (outcome.reason === 'not-open') return fail(ctx, 405, 'Pull Request is not mergeable');
        return fail(ctx, 405, 'Pull Request is not mergeable');
      }
      send(ctx, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    return fail(ctx, 404, 'Not Found');
  }
  fail(ctx, 404, 'Not Found');
}

// -------------------------------------------------------------------------------------------------
// the dispatcher
// -------------------------------------------------------------------------------------------------

export function handleRest(ctx: Ctx): void {
  const { segments } = ctx;
  const method = ctx.req.method ?? 'GET';

  if (segments.length === 0) {
    if (method === 'GET') {
      send(ctx, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        rate_limit_url: '/api/v3/rate_limit',
      }, { 'x-oauth-scopes': 'repo, read:org, gist' });
      return;
    }
    return fail(ctx, 404, 'Not Found');
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') {
      send(ctx, 200, {
        verifiable_password_authentication: false,
        ssh_key_fingerprints: {},
        installed_version: '1.0.0-forge',
        github_developer_program: false,
      });
      return;
    }
    return fail(ctx, 404, 'Not Found');
  }
  if (segments[0] === 'rate_limit' && segments.length === 1) {
    send(ctx, 200, { rate: { limit: 5000, remaining: 4999, reset: 1893456000, used: 1 } });
    return;
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method === 'GET' || method === 'PATCH') {
      send(ctx, 200, userJson());
      return;
    }
    return fail(ctx, 404, 'Not Found');
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    handleUserRepos(ctx);
    return;
  }
  if (segments[0] === 'users' && segments.length === 2) {
    if (method === 'GET' && segments[1] === VIEWER.login) {
      send(ctx, 200, userJson());
      return;
    }
    return fail(ctx, 404, 'Not Found');
  }
  if (segments[0] === 'search' && segments.length === 2 && method === 'GET') {
    const q = ctx.query.get('q') ?? '';
    if (segments[1] === 'repositories') {
      const needle = q.toLowerCase();
      const items = ctx.forge.reposOf(VIEWER.login)
        .filter((repo) => repo.name.toLowerCase().includes(needle))
        .map(repoJson);
      send(ctx, 200, { total_count: items.length, incomplete_results: false, items });
      return;
    }
    if (segments[1] === 'issues') {
      const repoMatch = /repo:([^\s/]+)\/(\S+)/.exec(q);
      const items: Record<string, unknown>[] = [];
      const repos = repoMatch ? [ctx.forge.getRepo(repoMatch[1], repoMatch[2])].filter((r): r is Repo => !!r) : ctx.forge.reposOf(VIEWER.login);
      for (const repo of repos) {
        for (const issue of repo.issues) items.push(issueJson(ctx.forge, repo, issue));
      }
      send(ctx, 200, { total_count: items.length, incomplete_results: false, items });
      return;
    }
    return fail(ctx, 404, 'Not Found');
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1];
    const name = segments[2];
    const rest = segments.slice(3);
    if (rest.length === 0) {
      handleRepo(ctx, owner, name);
      return;
    }
    // Another owner's repository is invisible: 404, never 403.
    if (owner !== VIEWER.login) return fail(ctx, 404, 'Not Found');
    const repo = requireRepo(ctx, owner, name);
    if (!repo) return;
    switch (rest[0]) {
      case 'branches':
        handleBranches(ctx, repo, rest.slice(1));
        return;
      case 'commits':
        handleCommits(ctx, repo, rest.slice(1));
        return;
      case 'contents':
        handleContents(ctx, repo, rest.slice(1).join('/'));
        return;
      case 'git':
        handleGitData(ctx, repo, rest.slice(1));
        return;
      case 'labels':
        handleLabels(ctx, repo, rest.slice(1));
        return;
      case 'issues':
        handleIssues(ctx, repo, rest.slice(1));
        return;
      case 'pulls':
        handlePulls(ctx, repo, rest.slice(1));
        return;
      default:
        return fail(ctx, 404, 'Not Found');
    }
  }
  fail(ctx, 404, 'Not Found');
}

export { identTimestamp };
