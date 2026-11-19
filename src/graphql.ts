// A small GraphQL executor for the documents gh and github-mcp-server actually send: viewer,
// repository reads, issue/pull-request connections with cursor pagination, the create/close/merge
// mutations, Relay node(id:), batching, and the __type introspection probes. Unknown fields are a
// 200 with an errors array naming the field, as GitHub answers.

import {
  VIEWER,
  createIssue,
  createPull,
  mergePull,
  pullConflicts,
  pullFiles,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './core.ts';
import { decodeGlobalId, encodeGlobalId } from './ids.ts';

// -------------------------------------------------------------------------------------------------
// schema description for introspection
// -------------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'user', 'organization', 'search', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'updateIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'isFork', 'createdAt', 'updatedAt', 'url', 'primaryLanguage', 'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'url', 'createdAt', 'updatedAt',
    'closed', 'closedAt', 'author', 'labels', 'comments', 'repository', 'assignees',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable',
    'headRefName', 'baseRefName', 'files', 'commits', 'comments', 'createdAt', 'updatedAt', 'url',
    'author', 'additions', 'deletions', 'changedFiles', 'mergeCommit', 'closed', 'isDraft',
  ],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'bio', 'company', 'location', 'createdAt', 'updatedAt'],
  Organization: ['id', 'databaseId', 'login', 'name', 'url', 'avatarUrl'],
  Ref: ['id', 'name', 'prefix', 'target', 'repository'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'totalCount'],
  Label: ['id', 'name', 'color', 'description'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'databaseId', 'body', 'createdAt', 'updatedAt', 'author', 'url'],
  Commit: ['id', 'oid', 'message', 'committedDate', 'author'],
  SearchResultItemConnection: ['nodes', 'issueCount', 'repositoryCount', 'userCount', 'pageInfo'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  ReopenIssuePayload: ['issue', 'clientMutationId'],
  UpdateIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

/** Field name -> GraphQL type, for selection completion. Unlisted fields complete as scalars. */
const FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', user: 'User', organization: 'Organization', search: 'SearchResultItemConnection', __type: '__Type', __schema: '__Schema' },
  Mutation: {
    createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', reopenIssue: 'ReopenIssuePayload',
    updateIssue: 'UpdateIssuePayload', createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload',
  },
  Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection' },
  Issue: { author: 'User', repository: 'Repository', labels: 'LabelConnection', comments: 'IssueCommentConnection' },
  PullRequest: { author: 'User', repository: 'Repository', files: 'PullRequestFileConnection', mergeCommit: 'Commit' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  IssueCommentConnection: { nodes: 'IssueComment', pageInfo: 'PageInfo' },
  LabelConnection: { nodes: 'Label' },
  PullRequestFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
  SearchResultItemConnection: { nodes: 'Repository', pageInfo: 'PageInfo' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  ReopenIssuePayload: { issue: 'Issue' },
  UpdateIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'CommentEdge' },
  CommentEdge: { node: 'IssueComment' },
  IssueComment: { author: 'User' },
  Ref: { repository: 'Repository' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
};

// -------------------------------------------------------------------------------------------------
// lexer + parser
// -------------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selectionSet?: SelectionNode[];
}
interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}
interface InlineFragmentNode {
  kind: 'inline';
  typeCondition?: string;
  selectionSet: SelectionNode[];
}
type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name?: string;
  selectionSet: SelectionNode[];
}
interface FragmentNode {
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}
interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (char === '#') {
      while (index < input.length && input[index] !== '\n') index += 1;
      continue;
    }
    if (/\s|,/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '.' && input.slice(index, index + 3) === '...') {
      tokens.push('...');
      index += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }
    if (char === '"') {
      if (input.slice(index, index + 3) === '"""') {
        const end = input.indexOf('"""', index + 3);
        const text = end < 0 ? input.slice(index + 3) : input.slice(index + 3, end);
        tokens.push(`"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
        index = end < 0 ? input.length : end + 3;
        continue;
      }
      let cursor = index + 1;
      let text = '';
      while (cursor < input.length && input[cursor] !== '"') {
        if (input[cursor] === '\\' && cursor + 1 < input.length) {
          const escaped = input[cursor + 1];
          text += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          cursor += 2;
        } else {
          text += input[cursor];
          cursor += 1;
        }
      }
      tokens.push(`"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      index = cursor + 1;
      continue;
    }
    const nameMatch = /^[_A-Za-z][_0-9A-Za-z]*/.exec(input.slice(index));
    if (nameMatch) {
      tokens.push(nameMatch[0]);
      index += nameMatch[0].length;
      continue;
    }
    const numberMatch = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(input.slice(index));
    if (numberMatch) {
      tokens.push(numberMatch[0]);
      index += numberMatch[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)} in the GraphQL document`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = tokenize(input);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of the GraphQL document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  private skipDirectivesAndVariables(): void {
    // Variable definitions and directives are parsed loosely: balanced parens are skipped whole.
    while (this.peek() === '(' || this.peek() === '@') {
      if (this.peek() === '@') {
        this.next();
        this.next(); // directive name
        continue;
      }
      let depth = 0;
      do {
        const token = this.next();
        if (token === '(' || token === '[' || token === '{') depth += 1;
        else if (token === ')' || token === ']' || token === '}') depth -= 1;
      } while (depth > 0);
    }
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.tokens.length) {
      const head = this.peek();
      if (head === '{') {
        operations.push({ operation: 'query', selectionSet: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation' || head === 'subscription') {
        const operation = this.next() as 'query' | 'mutation';
        let name: string | undefined;
        const maybeName = this.peek();
        if (maybeName && /^[_A-Za-z]/.test(maybeName) && maybeName !== '(' && maybeName !== '@') name = this.next();
        this.skipDirectivesAndVariables();
        operations.push({ operation: operation === 'subscription' ? 'query' : operation, name, selectionSet: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        const typeCondition = this.next();
        this.skipDirectivesAndVariables();
        fragments.set(name, { name, typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${head} in the GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeCondition = this.next();
        this.skipDirectivesAndVariables();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.next();
      this.skipDirectivesAndVariables();
      return { kind: 'spread', name };
    }
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    this.skipDirectivesAndVariables();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek() === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d+\.\d+/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

// -------------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------------

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

type Source = unknown;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function resolveValue(node: ValueNode, ctx: ExecContext): unknown {
  switch (node.kind) {
    case 'variable':
      return ctx.variables[node.name];
    case 'string':
    case 'enum':
      return node.value;
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => resolveValue(value, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveValue(value, ctx);
  return out;
}

interface IssueSource { repo: Repo; issue: Issue }
interface PullSource { repo: Repo; pull: Pull }
interface CommentSource { repo: Repo; issue: Issue; comment: { id: number; body: string; createdSec: number } }

const cursorFor = (number: number): string => Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function repoByDbId(forge: Forge, dbId: number): Repo | undefined {
  return [...forge.repos.values()].find((repo) => repo.id === dbId);
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.issues];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((s) => String(s).toLowerCase()) : null;
  if (states) list = list.filter((issue) => states.includes(issue.state));
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const direction = typeof orderBy?.direction === 'string' ? orderBy.direction : 'DESC';
  list.sort((a, b) => a.number - b.number);
  if (direction === 'DESC') list.reverse();
  let start = 0;
  if (typeof args.after === 'string') {
    const afterNumber = numberFromCursor(args.after);
    const index = afterNumber === null ? -1 : list.findIndex((issue) => issue.number === afterNumber);
    if (index >= 0) start = index + 1;
  }
  const first = typeof args.first === 'number' ? args.first : 100;
  const page = list.slice(start, start + first);
  const last = page[page.length - 1];
  return {
    nodes: page.map((issue): IssueSource => ({ repo, issue })),
    pageInfo: {
      hasNextPage: start + page.length < list.length,
      hasPreviousPage: start > 0,
      startCursor: page.length ? cursorFor(page[0].number) : null,
      endCursor: last ? cursorFor(last.number) : null,
    },
    totalCount: list.length,
  };
}

function resolveField(typeName: string, source: Source, field: FieldNode, ctx: ExecContext): unknown {
  const forge = ctx.forge;
  const args = argsOf(field, ctx);
  const name = field.name;

  if (typeName === 'Query') {
    switch (name) {
      case 'viewer':
        return { login: VIEWER.login };
      case 'repository': {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ?? null;
      }
      case 'node': {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (!decoded) return null;
        const dbId = Number(decoded.parts[0]);
        if (decoded.kind === 'Repository') {
          const repo = repoByDbId(forge, dbId);
          return repo ? { __nodeKind: 'Repository', repo } : null;
        }
        if (decoded.kind === 'Issue') {
          const repo = repoByDbId(forge, dbId);
          const issue = repo?.issues.find((candidate) => candidate.number === Number(decoded.parts[1]));
          return repo && issue ? { __nodeKind: 'Issue', repo, issue } : null;
        }
        if (decoded.kind === 'PullRequest') {
          const repo = repoByDbId(forge, dbId);
          const pull = repo?.pulls.find((candidate) => candidate.number === Number(decoded.parts[1]));
          return repo && pull ? { __nodeKind: 'PullRequest', repo, pull } : null;
        }
        if (decoded.kind === 'User') return { __nodeKind: 'User', login: VIEWER.login };
        return null;
      }
      case 'user':
        return args.login === VIEWER.login ? { login: VIEWER.login } : null;
      case 'search':
        return { nodes: [], issueCount: 0, repositoryCount: 0, userCount: 0, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
      case '__type': {
        const typeNameArg = String(args.name ?? '');
        if (TYPE_FIELDS[typeNameArg]) return { __typeName: typeNameArg };
        if (TYPE_ENUMS[typeNameArg]) return { __typeName: typeNameArg };
        return null;
      }
      case '__schema':
        return { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
      default:
        break;
    }
  }

  if (typeName === 'Mutation') {
    const input = isRecord(args.input) ? args.input : {};
    switch (name) {
      case 'createIssue': {
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = decoded ? repoByDbId(forge, Number(decoded.parts[0])) : undefined;
        if (!repo) {
          ctx.errors.push({ message: 'repositoryId does not name a repository' });
          return { issue: null };
        }
        const issue = createIssue(forge, repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return { issue: { repo, issue } satisfies IssueSource };
      }
      case 'closeIssue':
      case 'reopenIssue':
      case 'updateIssue': {
        const idValue = String(input.issueId ?? input.id ?? '');
        const decoded = decodeGlobalId(idValue);
        const repo = decoded ? repoByDbId(forge, Number(decoded.parts[0])) : undefined;
        const issue = repo?.issues.find((candidate) => candidate.number === Number(decoded?.parts[1]));
        if (!repo || !issue) {
          ctx.errors.push({ message: 'issueId does not name an issue' });
          return { issue: null };
        }
        if (name === 'closeIssue') issue.state = 'closed';
        if (name === 'reopenIssue') issue.state = 'open';
        if (name === 'updateIssue') {
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          if (input.state === 'OPEN') issue.state = 'open';
          if (input.state === 'CLOSED') issue.state = 'closed';
        }
        return { issue: { repo, issue } satisfies IssueSource };
      }
      case 'createPullRequest': {
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = decoded ? repoByDbId(forge, Number(decoded.parts[0])) : undefined;
        if (!repo) {
          ctx.errors.push({ message: 'repositoryId does not name a repository' });
          return { pullRequest: null };
        }
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? repo.defaultBranch);
        if (!repo.branchTip(head) || !repo.branchTip(base)) {
          ctx.errors.push({ message: 'head or base branch does not exist' });
          return { pullRequest: null };
        }
        const pull = createPull(forge, repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
        return { pullRequest: { repo, pull } satisfies PullSource };
      }
      case 'mergePullRequest': {
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        const repo = decoded ? repoByDbId(forge, Number(decoded.parts[0])) : undefined;
        const pull = repo?.pulls.find((candidate) => candidate.number === Number(decoded?.parts[1]));
        if (!repo || !pull) {
          ctx.errors.push({ message: 'pullRequestId does not name a pull request' });
          return { pullRequest: null };
        }
        const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
        const outcome = mergePull(forge, repo, pull, method === 'merge' ? 'merge' : 'squash');
        if (!outcome.ok && outcome.reason === 'conflict') {
          ctx.errors.push({ message: 'Pull Request is not mergeable' });
        }
        return { pullRequest: { repo, pull } satisfies PullSource };
      }
      case 'addComment': {
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        const repo = decoded ? repoByDbId(forge, Number(decoded.parts[0])) : undefined;
        const issue = repo?.issues.find((candidate) => candidate.number === Number(decoded?.parts[1]));
        if (!repo || !issue) {
          ctx.errors.push({ message: 'subjectId does not name an issue' });
          return { commentEdge: null };
        }
        const comment = { id: forge.newCommentId(), body: String(input.body ?? ''), createdSec: forge.tick() };
        issue.comments.push(comment);
        const source: CommentSource = { repo, issue, comment };
        return { commentEdge: { node: source, cursor: cursorFor(comment.id) } };
      }
      default:
        break;
    }
  }

  if (typeName === 'Repository') {
    const repo = source as Repo;
    switch (name) {
      case 'id': return encodeGlobalId('Repository', [repo.id]);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return repo.fullName;
      case 'owner': return { login: repo.owner };
      case 'defaultBranchRef': return repo.branchTip(repo.defaultBranch) ? { name: repo.defaultBranch, repo } : null;
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'isPrivate': return repo.isPrivate;
      case 'isFork': return false;
      case 'createdAt':
      case 'updatedAt': return forge.iso(repo.createdSec);
      case 'url': return '';
      case 'issue': {
        const issue = repo.issues.find((candidate) => candidate.number === Number(args.number));
        return issue ? ({ repo, issue } satisfies IssueSource) : null;
      }
      case 'issues': return issuesConnection(repo, args);
      case 'pullRequest': {
        const pull = repo.pulls.find((candidate) => candidate.number === Number(args.number));
        return pull ? ({ repo, pull } satisfies PullSource) : null;
      }
      case 'pullRequests': {
        let list = [...repo.pulls];
        const states = Array.isArray(args.states) ? (args.states as unknown[]).map((s) => String(s)) : null;
        if (states) {
          list = list.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
        }
        list.sort((a, b) => b.number - a.number);
        const first = typeof args.first === 'number' ? args.first : 100;
        return {
          nodes: list.slice(0, first).map((pull): PullSource => ({ repo, pull })),
          pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: list.length,
        };
      }
      default:
        break;
    }
  }

  if (typeName === 'Issue') {
    const { repo, issue } = source as IssueSource;
    switch (name) {
      case 'id': return encodeGlobalId('Issue', [repo.id, issue.number]);
      case 'databaseId': return issue.id;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issue.state.toUpperCase();
      case 'body':
      case 'bodyText': return issue.body;
      case 'url': return '';
      case 'createdAt':
      case 'updatedAt': return forge.iso(issue.createdSec);
      case 'closed': return issue.state === 'closed';
      case 'closedAt': return null;
      case 'author': return { login: VIEWER.login };
      case 'repository': return repo;
      case 'labels':
        return {
          nodes: issue.labels.map((labelName) => ({ name: labelName, color: repo.labels.get(labelName)?.color ?? 'ededed', description: repo.labels.get(labelName)?.description ?? null })),
          totalCount: issue.labels.length,
        };
      case 'comments':
        return {
          nodes: issue.comments.map((comment): CommentSource => ({ repo, issue, comment })),
          pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: issue.comments.length,
        };
      default:
        break;
    }
  }

  if (typeName === 'PullRequest') {
    const { repo, pull } = source as PullSource;
    switch (name) {
      case 'id': return encodeGlobalId('PullRequest', [repo.id, pull.number]);
      case 'databaseId': return pull.id;
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged': return pull.merged;
      case 'mergedAt': return pull.mergedAtSec !== null ? forge.iso(pull.mergedAtSec) : null;
      case 'mergeable':
        if (pull.state !== 'open') return 'UNKNOWN';
        return pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'url': return '';
      case 'createdAt':
      case 'updatedAt': return forge.iso(pull.createdSec);
      case 'closed': return pull.state === 'closed';
      case 'isDraft': return false;
      case 'author': return { login: VIEWER.login };
      case 'repository': return repo;
      case 'mergeCommit': return pull.mergeCommitSha ? { oid: pull.mergeCommitSha } : null;
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const files = pullFiles(repo, pull);
        return {
          nodes: files.slice(0, first).map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() })),
          pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: files.length,
        };
      }
      case 'additions': return pullFiles(repo, pull).reduce((sum, file) => sum + file.additions, 0);
      case 'deletions': return pullFiles(repo, pull).reduce((sum, file) => sum + file.deletions, 0);
      case 'changedFiles': return pullFiles(repo, pull).length;
      default:
        break;
    }
  }

  if (typeName === 'User' || typeName === 'Organization') {
    const login = isRecord(source) && typeof source.login === 'string' ? source.login : VIEWER.login;
    switch (name) {
      case 'login': return login;
      case 'id': return encodeGlobalId('User', [VIEWER.id]);
      case 'databaseId': return VIEWER.id;
      case 'name': return login === VIEWER.login ? VIEWER.name : login;
      case 'email': return login === VIEWER.login ? VIEWER.email : '';
      case 'url':
      case 'avatarUrl': return '';
      case 'bio':
      case 'company':
      case 'location': return null;
      case 'createdAt':
      case 'updatedAt': return forge.iso(forge.baseSec);
      default:
        break;
    }
  }

  if (typeName === 'Ref') {
    const refSource = source as { name: string; repo?: Repo };
    switch (name) {
      case 'name': return refSource.name;
      case 'prefix': return 'refs/heads/';
      case 'id': return encodeGlobalId('Repository', [refSource.repo?.id ?? 0]);
      case 'target': return refSource.repo ? { oid: refSource.repo.branchTip(refSource.name) ?? '' } : null;
      case 'repository': return refSource.repo ?? null;
      default:
        break;
    }
  }

  if (typeName === 'IssueComment') {
    const { repo, comment } = source as CommentSource;
    switch (name) {
      case 'id': return encodeGlobalId('IssueComment', [repo.id, (source as CommentSource).issue.number, comment.id]);
      case 'databaseId': return comment.id;
      case 'body': return comment.body;
      case 'createdAt':
      case 'updatedAt': return forge.iso(comment.createdSec);
      case 'author': return { login: VIEWER.login };
      case 'url': return '';
      default:
        break;
    }
  }

  if (typeName === '__Type') {
    const typeNameArg = (source as { __typeName: string }).__typeName;
    switch (name) {
      case 'name': return typeNameArg;
      case 'kind': return TYPE_ENUMS[typeNameArg] ? 'ENUM' : 'OBJECT';
      case 'description': return null;
      case 'fields': return (TYPE_FIELDS[typeNameArg] ?? []).map((fieldName) => ({ name: fieldName }));
      case 'enumValues': return TYPE_ENUMS[typeNameArg] ? TYPE_ENUMS[typeNameArg].map((value) => ({ name: value })) : null;
      case 'possibleTypes':
      case 'inputFields':
      case 'interfaces': return [];
      case 'ofType': return null;
      default:
        break;
    }
  }

  if (typeName === '__Schema') {
    if (name === 'queryType') return { name: 'Query' };
    if (name === 'mutationType') return { name: 'Mutation' };
    if (name === 'types') return [];
    if (name === 'directives') return [];
    return null;
  }

  // Plain-object sources (connections, page info, payloads, files, labels, commits) read directly.
  if (isRecord(source) && name in source) return source[name];
  return undefined;
}

function completeValue(typeName: string, field: FieldNode, value: unknown, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (!field.selectionSet) return value;
  const fieldType = FIELD_TYPES[typeName]?.[field.name] ?? typeName;
  if (Array.isArray(value)) return value.map((entry) => completeValue(fieldType, { ...field, name: '' }, entry, ctx));
  if (isRecord(value) && typeof value.__nodeKind === 'string') {
    const concrete = value.__nodeKind;
    const concreteSource = concrete === 'Repository' ? value.repo : value;
    return executeSelectionSet(concrete, concreteSource, field.selectionSet, ctx);
  }
  return executeSelectionSet(fieldType, value, field.selectionSet, ctx);
}

function executeSelectionSet(typeName: string, source: Source, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelectionSet(typeName, source, fragment.selectionSet, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition && selection.typeCondition !== typeName && typeName !== 'Node') continue;
      Object.assign(out, executeSelectionSet(selection.typeCondition ?? typeName, source, selection.selectionSet, ctx));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const knownFields = TYPE_FIELDS[typeName];
    if (knownFields && !knownFields.includes(selection.name) && !isRecord(source)) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[responseKey] = null;
      continue;
    }
    if (knownFields && !knownFields.includes(selection.name) && isRecord(source) && !(selection.name in source)) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[responseKey] = null;
      continue;
    }
    const value = resolveField(typeName, source, selection, ctx);
    if (value === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(typeName, selection, value, ctx);
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// the endpoint
// -------------------------------------------------------------------------------------------------

export interface GraphQLRequestItem {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export function executeGraphQL(forge: Forge, item: GraphQLRequestItem): Record<string, unknown> {
  const errors: Array<{ message: string }> = [];
  try {
    const document = new Parser(String(item.query ?? '')).parseDocument();
    if (document.operations.length === 0) return { errors: [{ message: 'no operation in the document' }] };
    let operation = document.operations[0];
    if (item.operationName) {
      operation = document.operations.find((candidate) => candidate.name === item.operationName) ?? operation;
    } else if (document.operations.length > 1) {
      operation = document.operations[0];
    }
    const ctx: ExecContext = {
      forge,
      variables: item.variables ?? {},
      fragments: document.fragments,
      errors,
    };
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelectionSet(rootType, null, operation.selectionSet, ctx);
    const response: Record<string, unknown> = { data };
    if (errors.length) response.errors = errors;
    return response;
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL error' }] };
  }
}
