// The forge's HTTP surface, grown from the starter: git smart HTTP, the REST v3 resources,
// GraphQL v4 and the MCP endpoint all live under src/, one module per surface over a shared
// in-memory git object store. main.ts (the entry <-> env lifecycle) is unchanged.

export { createApp } from './src/server.ts';
