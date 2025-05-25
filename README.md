# Wikipedia MCP Server

This package provides a ready-to-use [Model-Context Protocol (MCP)](https://github.com/modelcontextprotocol) server that allows LLM agents to **create or update pages on test2.wikipedia.org** via the MediaWiki Action API.

## Installation

```bash
# npm
npm install --save @MyTH-AI-JP/sample-mcp

# or pnpm
yarn add @MyTH-AI-JP/sample-mcp
```

> ℹ️  Node.js ≥ 18 is required (for native `fetch`).

## Usage (CLI)

```bash
npx wikipedia-mcp-server | mcp-proxy
```

The server communicates over **stdio**.  See the [MCP specification](https://github.com/modelcontextprotocol/spec) for the message format.

## Usage (Programmatic)

```ts
import { runWikipediaServer } from "@MyTH-AI-JP/sample-mcp";

await runWikipediaServer();
```

## Development

```bash
git clone https://github.com/your-org/sample-mcp.git
cd sample-mcp
npm install --legacy-peer-deps
npm run build
```

## Publishing

1. Bump the version in `package.json`.
2. `npm publish --access public`  (requires `npm login`).

## License

MIT © 2025