// The MCP endpoint (Streamable HTTP, JSON answers): server/discover for the 2026-07-28 revision
// plus the legacy initialize handshake, and the six GitHub tools the suite drives, all mapped onto
// the same store the REST surface serves — an object created here is the same object over REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, createIssue, createPull, mergePull, type Forge, type Repo } from './core.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  required: string[];
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const STRING = { type: 'string' } as const;

/** The tool list is a constant: two tools/list calls must answer byte for byte the same array. */
export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: objectSchema({ name: STRING, description: STRING, private: { type: 'boolean' } }, ['name']),
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING }, ['owner', 'repo']),
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, title: STRING, body: STRING }, ['owner', 'repo', 'title']),
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed, all).',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, state: STRING }, ['owner', 'repo']),
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, title: STRING, body: STRING, head: STRING, base: STRING }, ['owner', 'repo', 'title', 'head', 'base']),
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request by number.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, pull_number: { type: 'integer' } }, ['owner', 'repo', 'pull_number']),
    required: ['owner', 'repo', 'pull_number'],
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, issue_number: { type: 'integer' } }, ['owner', 'repo', 'issue_number']),
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'list_repos',
    description: 'List the repositories of the authenticated user.',
    inputSchema: objectSchema({}, []),
    required: [],
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

interface ToolOutcome {
  payload: unknown;
  isError?: boolean;
}

function toolError(message: string): ToolOutcome {
  return { payload: { error: message }, isError: true };
}

function requireRepo(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
  return forge.getRepo(owner, name) ?? null;
}

function runTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (!repoName) return toolError('name is required');
      if (forge.getRepo(VIEWER.login, repoName)) return toolError(`repository ${repoName} already exists`);
      const repo = forge.createRepo(
        VIEWER.login,
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return { payload: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = requireRepo(forge, args);
      if (!repo) return toolError('repository not found');
      return { payload: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = requireRepo(forge, args);
      if (!repo) return toolError('repository not found');
      const issue = createIssue(forge, repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
      return { payload: issueJson(forge, repo, issue) };
    }
    case 'list_issues': {
      const repo = requireRepo(forge, args);
      if (!repo) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => issueJson(forge, repo, issue));
      return { payload: { issues } };
    }
    case 'create_pull_request': {
      const repo = requireRepo(forge, args);
      if (!repo) return toolError('repository not found');
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      if (!repo.branchTip(head)) return toolError(`head branch ${head} does not exist`);
      if (!repo.branchTip(base)) return toolError(`base branch ${base} does not exist`);
      const pull = createPull(forge, repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, base);
      return { payload: pullJson(forge, repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = requireRepo(forge, args);
      if (!repo) return toolError('repository not found');
      const pull = repo.pulls.find((candidate) => candidate.number === Number(args.pull_number));
      if (!pull) return toolError('pull request not found');
      const outcome = mergePull(forge, repo, pull, 'squash');
      if (!outcome.ok) return toolError(`pull request is not mergeable (${outcome.reason})`);
      return { payload: pullJson(forge, repo, pull) };
    }
    case 'get_issue': {
      const repo = requireRepo(forge, args);
      if (!repo) return toolError('repository not found');
      const issue = repo.issues.find((candidate) => candidate.number === Number(args.issue_number));
      if (!issue) return toolError('issue not found');
      return { payload: issueJson(forge, repo, issue) };
    }
    case 'list_repos': {
      return { payload: { repositories: forge.reposOf(VIEWER.login).map(repoJson) } };
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

// -------------------------------------------------------------------------------------------------
// JSON-RPC plumbing
// -------------------------------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function handleRequest(forge: Forge, request: Record<string, unknown>): Record<string, unknown> | null {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const params = isRecord(request.params) ? request.params : {};
  if (id === undefined || id === null) {
    // A notification: accepted, never answered.
    return null;
  }
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        protocolVersion: '2026-07-28',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === toolName);
      if (!tool) return rpcError(id, -32602, `unknown tool ${toolName}`);
      const args = isRecord(params.arguments) ? params.arguments : {};
      const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length) return rpcError(id, -32602, `missing required argument(s): ${missing.join(', ')}`);
      const outcome = runTool(forge, toolName, args);
      const text = JSON.stringify(outcome.payload) ?? '';
      return rpcResult(id, {
        content: [{ type: 'text', text }],
        structuredContent: outcome.payload,
        isError: outcome.isError === true,
      });
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/**
 * Handle one POST /mcp. A body that is not JSON is a 400 with -32700 before anything else; a
 * well-formed call without the trial's Authorization is a 401.
 */
export function handleMcp(forge: Forge, token: string, req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const authorization = req.headers.authorization ?? '';
  if (token !== '' && authorization !== `Bearer ${token}`) {
    sendJson(res, 401, rpcError(isRecord(parsed) ? parsed.id : null, -32001, 'unauthorized'));
    return;
  }
  if (Array.isArray(parsed)) {
    const answers = parsed
      .filter(isRecord)
      .map((entry) => handleRequest(forge, entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    if (answers.length === 0) {
      res.writeHead(204);
      res.end();
      return;
    }
    sendJson(res, 200, answers);
    return;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const answer = handleRequest(forge, parsed);
  if (answer === null) {
    res.writeHead(204);
    res.end();
    return;
  }
  sendJson(res, 200, answer);
}
