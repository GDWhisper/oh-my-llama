---
name: codegraph
description: Use CodeGraph (a code knowledge graph indexed in .codegraph/ at the repo root) to understand and locate code BEFORE grep/find or reading files. Reach for it whenever you need to explore, navigate, or understand the codebase.
allowed-tools: Bash(codegraph:*)
license: MIT
compatibility: Requires the codegraph CLI/index — i.e. a `.codegraph/` directory present at the repo root.
metadata:
  author: vacio
  version: "1.0"
  generatedBy: "claude-to-codebuddy-conversion"
---

## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
