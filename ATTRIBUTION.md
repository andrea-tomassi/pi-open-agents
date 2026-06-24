# Attribution

This project builds on ideas and code from the following open-source projects.
Significant portions of the initial implementation are derived from these sources.

## pi-agent-mode

- **Source**: https://github.com/ZGltYQ/agent-mode
- **Author**: ZGltYQ
- **License**: MIT
- **Version at time of fork**: v1.3.0 (commit `751abef`)
- **What we use**: Primary agent loading, inline system prompt injection,
  model switching, tool whitelist, TUI selector/search UI, status banner,
  `set_agent`/`search_agents` tools, session persistence, `--agent` CLI flag.

## pi-subagents

- **Source**: https://github.com/jwu/pi-subagents
- **Author**: jwu (John Wu)
- **License**: MIT
- **Version at time of fork**: v2.1.0 (commit `6c568dd`)
- **What we use**: Subagent execution engine, child session spawning,
  tool scoping, parent-child IPC, TUI rendering for subagent streams,
  `maxDepth`/`allowedAgents` controls, `thinking` frontmatter support.

## opencode

- **Source**: https://github.com/anomalyco/opencode
- **Author**: anomalyco (fork of sst/opencode)
- **Version at time of clone**: commit `cfddb24`
- **What we reference**: Agent definition format, frontmatter schema,
  discovery paths (`.opencode/agent/`), compatibility target for
  cross-runtime agent definitions.

## License compliance

Each source file derived from these projects retains appropriate attribution
in its header comments. The upstream licenses apply to their respective code.
