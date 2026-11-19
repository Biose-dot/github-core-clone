// Git smart HTTP: ref advertisements (protocol v0 and v2), ls-refs, fetch (with shallow/deepen
// semantics) and receive-pack, spoken against the forge's real git object store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  collectReachable,
  commitAncestors,
  isAncestor,
  isOid,
  parseCommitData,
  parseTagData,
  peelToCommit,
  type Forge,
  type GitObj,
  type Repo,
} from './core.ts';
import { readPack, writePack } from './pack.ts';

// -------------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 65520) throw new Error('pkt-line too long');
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a whole pkt-line stream; throws on malformed framing. */
export function decodePktLines(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('pkt-line header is not hex');
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3) {
      offset += 4;
    } else {
      if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** Split a receive-pack body into its command packets and the pack bytes that follow the flush. */
function splitCommandList(buffer: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('pkt-line header is not hex');
    const length = parseInt(header, 16);
    offset += 4;
    if (length === 0) return { packets, rest: buffer.subarray(offset) };
    if (length === 1) {
      packets.push({ kind: 'delim' });
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      continue;
    }
    if (length === 3) continue;
    if (offset + length - 4 > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buffer.subarray(offset, offset + length - 4) });
    offset += length - 4;
  }
  return { packets, rest: Buffer.alloc(0) };
}

// -------------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------------

interface AdvertisedRef {
  oid: string;
  name: string;
  peeled?: string;
}

function advertisedRefs(repo: Repo): AdvertisedRef[] {
  const refs: AdvertisedRef[] = [];
  const headTarget = repo.refs.get(repo.headRef);
  refs.push({ oid: headTarget ?? ZERO_OID, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: AdvertisedRef = { oid, name };
    const object = repo.get(oid);
    if (object?.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled) entry.peeled = peeled;
    }
    refs.push(entry);
  }
  return refs;
}

const UPLOAD_CAPS_V0 = (repo: Repo): string =>
  `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=forge/1.0 symref=HEAD:${repo.headRef}`;
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';

function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0(repo) : RECEIVE_CAPS;
  const refs = advertisedRefs(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (refs.length === 1 && refs[0].oid === ZERO_OID) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const lines = [
    'version 2',
    'agent=forge/1.0',
    'ls-refs=unborn',
    'fetch=shallow thin-pack ofs-delta',
    'object-format=sha1',
  ];
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

export function handleInfoRefs(repo: Repo, service: string, wantsV2: boolean, res: ServerResponse): void {
  const body = service === 'git-upload-pack' && wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
  res.writeHead(200, {
    'content-type': `application/x-${service}-advertisement`,
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

// -------------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// -------------------------------------------------------------------------------------------------

function lsRefsLines(repo: Repo, args: string[]): string[] {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headTarget = repo.refs.get(repo.headRef);
  if (keep('HEAD')) {
    if (headTarget) {
      lines.push(`${headTarget} HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}`);
    } else {
      lines.push(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}`);
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = repo.get(oid);
      if (object?.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
    }
    lines.push(line);
  }
  return lines;
}

// -------------------------------------------------------------------------------------------------
// fetch
// -------------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth: number | null;
  deepenRelative: boolean;
  done: boolean;
}

function parseFetch(packets: Packet[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], clientShallow: [], depth: null, deepenRelative: false, done: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim().split(/\s+/)[0]);
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
    else if (line === 'deepen-relative') request.deepenRelative = true;
    else if (line === 'done') request.done = true;
  }
  return request;
}

interface FetchPlan {
  objects: GitObj[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Compute what a fetch sends. Two client shapes:
 *  - a full client (no shallow lines): its haves are a barrier — their whole history is held, so
 *    expansion stops at them and their reachable closure is pruned from the pack. A commit that is
 *    both a want and a have still expands (its ancestors may be exactly what a deepen asks for is
 *    impossible here, but the prune below removes everything the client holds anyway).
 *  - a shallow client (shallow lines present): its haves and boundary commits are held as single
 *    commits plus their trees, no deeper. Expansion stops at the boundary only when no depth was
 *    requested; with deepen it runs to the new depth straight through the old boundary.
 * The shallow list answers the included commits whose parents are neither included nor held.
 */
function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const wants = [...new Set(request.wants)].filter((oid) => isOid(oid) && repo.get(oid));
  const wantSet = new Set(wants);
  const haves = new Set(request.haves.filter((oid) => repo.get(oid)));
  const clientShallow = new Set(request.clientShallow.filter((oid) => repo.get(oid)));
  const shallowClient = clientShallow.size > 0;
  // deepen-relative (real git's deepen): the depth counts from the client's current boundary, so
  // the effective cap is the requested depth plus the boundary's distance from the wants.
  let depthCap = request.depth;
  if (request.deepenRelative && request.depth !== null && shallowClient) {
    let boundaryDistance = 0;
    const seen = new Set<string>();
    const probe: Array<{ oid: string; level: number }> = wants.map((oid) => ({ oid, level: 1 }));
    while (probe.length) {
      const { oid, level } = probe.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (clientShallow.has(oid)) {
        boundaryDistance = level;
        break;
      }
      const object = repo.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommitData(object.data).parents) probe.push({ oid: parent, level: level + 1 });
    }
    depthCap = request.depth + boundaryDistance;
  }
  const included = new Set<string>();
  const queue: Array<{ oid: string; level: number }> = wants.map((oid) => ({ oid, level: 1 }));
  while (queue.length) {
    const { oid, level } = queue.shift()!;
    if (included.has(oid)) continue;
    const object = repo.get(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      included.add(oid);
      queue.push({ oid: parseTagData(object.data).object, level });
      continue;
    }
    if (object.type !== 'commit') continue;
    if (!shallowClient && haves.has(oid) && !wantSet.has(oid)) continue; // the have barrier
    included.add(oid);
    if (depthCap !== null && level >= depthCap) continue;
    if (request.depth === null && shallowClient && clientShallow.has(oid)) continue; // boundary holds
    for (const parent of parseCommitData(object.data).parents) {
      queue.push({ oid: parent, level: level + 1 });
    }
  }
  // The boundary: included commits with a parent that is neither included nor already held.
  // The old boundary commits that are included now but no longer on the boundary are unshallowed:
  // the client must be told, or it keeps treating them as cut points.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (request.depth !== null || shallowClient) {
    for (const oid of included) {
      const object = repo.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommitData(object.data).parents;
      if (parents.length > 0 && parents.some((parent) => !included.has(parent) && !haves.has(parent) && !clientShallow.has(parent))) {
        shallow.push(oid);
      } else if (clientShallow.has(oid)) {
        unshallow.push(oid);
      }
    }
  }
  // Objects: the included commits and tags plus each included commit's tree closure — never an
  // excluded parent's objects (that is what makes a shallow fetch shallow). Then prune the held:
  // a full client's haves prune their whole reachable history; a shallow client's held commits
  // prune only themselves and their trees.
  const send = new Set<string>();
  for (const oid of included) {
    const object = repo.get(oid);
    if (!object) continue;
    send.add(oid);
    if (object.type === 'commit') {
      for (const treeOid of collectReachable(repo, [parseCommitData(object.data).tree], true)) send.add(treeOid);
    }
  }
  if (!shallowClient) {
    for (const oid of collectReachable(repo, haves, true)) send.delete(oid);
  } else {
    for (const held of [...haves, ...clientShallow]) {
      send.delete(held);
      const object = repo.get(held);
      if (!object || object.type !== 'commit') continue;
      const tree = parseCommitData(object.data).tree;
      for (const oid of collectReachable(repo, [tree], true)) send.delete(oid);
    }
  }
  const objects: GitObj[] = [];
  for (const oid of send) {
    const object = repo.get(oid);
    if (object) objects.push(object);
  }
  // Commits first, then trees, then blobs: a friendly order for index-pack.
  const rank = { commit: 0, tag: 1, tree: 2, blob: 3 } as const;
  objects.sort((a, b) => rank[a.type] - rank[b.type]);
  return { objects, shallow, unshallow };
}

/** Chunk a pack into sideband-1 pkt-lines of at most 65520 bytes. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  return parts;
}

function fetchV2(repo: Repo, request: FetchRequest): Buffer {
  const havesPresent = request.haves.filter((oid) => repo.get(oid));
  // Negotiation: when the client has not said `done` and none of its haves are known here,
  // negotiation cannot complete — the whole answer is a NAK acknowledgments section and the
  // client will offer more haves. When at least one have is known (or the client said `done`),
  // negotiation completes in this response, exactly as git's own upload-pack behaves: the
  // acknowledgments carry `ready` and the packfile sections follow in the same response.
  if (!request.done && request.haves.length > 0 && havesPresent.length === 0) {
    return Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH]);
  }
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  if (request.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (havesPresent.length === 0) parts.push(pktLine('NAK\n'));
    else for (const oid of havesPresent) parts.push(pktLine(`ACK ${oid}\n`));
    // The packfile sections follow, so the acknowledgments must close with `ready`: real git
    // refuses any further section after an acknowledgments section that lacked it.
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  if (request.depth !== null || request.clientShallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(writePack(plan.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPackets(writePack(plan.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = splitCommandList(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!match) throw new Error('malformed receive-pack command');
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const pack = readPack(rest, (oid) => repo.get(oid));
      for (const [oid, object] of pack.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'error';
    }
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
  for (const command of commands) {
    const fail = (reason: string): void => {
      reportLines.push(`ng ${command.ref} ${reason}`);
    };
    if (!unpackOk) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // delete
      if (current === ZERO_OID) {
        fail('reference does not exist');
        continue;
      }
      if (command.oldOid !== current) {
        fail('stale reference');
        continue;
      }
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}`);
      continue;
    }
    const target = repo.get(command.newOid);
    if (!target) {
      fail('new object is missing');
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== ZERO_OID) {
        fail('reference already exists');
        continue;
      }
    } else if (command.oldOid !== current) {
      fail('stale reference');
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && current !== ZERO_OID) {
      const currentCommit = peelToCommit(repo, current);
      const newCommit = peelToCommit(repo, command.newOid);
      if (currentCommit && newCommit && !isAncestor(repo, currentCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}`);
  }

  const report = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  return Buffer.concat([...sidebandPackets(report), PKT_FLUSH]);
}

// -------------------------------------------------------------------------------------------------
// the POST dispatcher for both services
// -------------------------------------------------------------------------------------------------

export function handleGitPost(
  forge: Forge,
  owner: string,
  repoName: string,
  service: string,
  body: Buffer,
  wantsV2: boolean,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  void forge;
  void req;
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('repository not found\n');
    return;
  }
  try {
    if (service === 'git-receive-pack') {
      const out = receivePack(repo, body);
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': out.length });
      res.end(out);
      return;
    }
    // git-upload-pack
    const packets = decodePktLines(body);
    let command = '';
    const commandArgs: string[] = [];
    let inArguments = false;
    const fetchPackets: Packet[] = [];
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        inArguments = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (!inArguments && line.startsWith('command=')) {
        command = line.slice('command='.length);
        continue;
      }
      if (command === 'ls-refs') commandArgs.push(line);
      else fetchPackets.push(packet);
    }
    if (wantsV2 && command === 'ls-refs') {
      const lines = lsRefsLines(repo, commandArgs);
      const out = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
      res.end(out);
      return;
    }
    if (wantsV2 && command === 'fetch') {
      const out = fetchV2(repo, parseFetch(fetchPackets));
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
      res.end(out);
      return;
    }
    // v0 upload-pack request (want/have lines directly).
    const out = fetchV0(repo, parseFetch(packets));
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
    res.end(out);
  } catch (err) {
    // A malformed body must never take the server down: answer 400 and keep serving.
    void err;
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request\n');
  }
}

/** The refs a REST caller sees, shared by the branches endpoints. */
export function branchList(repo: Repo): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [ref, oid] of repo.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha: oid });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export { commitAncestors };
