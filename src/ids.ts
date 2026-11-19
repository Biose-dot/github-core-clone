// Opaque global (Relay-style) ids for the GraphQL surface: base64 of a kind-tagged payload.
// They are stable across reads and never equal to the plain numeric id.

export type GlobalKind = 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment' | 'User';

export function encodeGlobalId(kind: GlobalKind, parts: readonly (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const segments = text.split(':');
    if (segments.length < 2) return null;
    return { kind: segments[0], parts: segments.slice(1) };
  } catch {
    return null;
  }
}
