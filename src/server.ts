// The HTTP server: routing, the trial-token check, and body plumbing for the forge's four
// surfaces — git smart HTTP (/<owner>/<repo>.git/...), REST v3 (/api/v3), GraphQL (/api/graphql)
// and MCP (/mcp) — plus the env's /healthz probe.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './core.ts';
import { handleGitPost, handleInfoRefs } from './git.ts';
import { handleRest, type RestContext } from './rest.ts';
import { executeGraphQL, type GraphQLRequestItem } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${TOKEN}`;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > 128 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

let requestCounter = 0;

export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://entry');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      requestCounter += 1;
      const requestId = `req-${requestCounter}`;

      try {
        // The env's boot probe.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/<endpoint>
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          const [, owner, repoName, endpoint] = gitMatch;
          if (!authorized(req)) {
            res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('unauthorized\n');
            return;
          }
          const repo = forge.getRepo(decodeSegment(owner), decodeSegment(repoName));
          if (endpoint === 'info/refs') {
            if (method !== 'GET') {
              res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('method not allowed\n');
              return;
            }
            if (!repo) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('repository not found\n');
              return;
            }
            const service = url.searchParams.get('service') ?? '';
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('unknown service\n');
              return;
            }
            const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
            handleInfoRefs(repo, service, wantsV2, res);
            return;
          }
          if (method !== 'POST') {
            res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('method not allowed\n');
            return;
          }
          const body = await readBody(req);
          const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
          handleGitPost(forge, decodeSegment(owner), decodeSegment(repoName), endpoint, body, wantsV2, req, res);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': requestId });
            return;
          }
          let body: unknown;
          let bodyError = false;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                body = JSON.parse(raw.toString('utf8'));
              } catch {
                bodyError = true;
              }
            }
          }
          const segments = path
            .slice('/api/v3'.length)
            .split('/')
            .filter((segment) => segment !== '')
            .map(decodeSegment);
          const ctx: RestContext = {
            forge,
            req,
            res,
            segments,
            query: url.searchParams,
            body,
            bodyError,
            requestId,
            host: req.headers.host ?? '127.0.0.1',
            pathname: path,
          };
          handleRest(ctx);
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql' && method === 'POST') {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': requestId });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
            return;
          }
          if (Array.isArray(parsed)) {
            sendJson(res, 200, parsed.map((item) => executeGraphQL(forge, item as GraphQLRequestItem)));
            return;
          }
          sendJson(res, 200, executeGraphQL(forge, parsed as GraphQLRequestItem));
          return;
        }

        // MCP (it applies its own parse-then-auth order).
        if (path === '/mcp' && method === 'POST') {
          const raw = await readBody(req);
          handleMcp(forge, TOKEN, req, res, raw);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
      } catch (err) {
        // One bad request never takes the forge down.
        void err;
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, { 'x-github-request-id': requestId });
        else res.end();
      }
    })();
  });
  return server;
}
