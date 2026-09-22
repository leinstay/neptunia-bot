# Commands

Channels, roles and users are picked from Discord's own pickers; `set`/`unset` and `access grant`/`access revoke` autocomplete their `path`/`command` options. The bot does not read direct messages.

`/nep` is visible to every member from the start; access is gated per command at the moment it runs, never through Discord's own command visibility. Owners (`bot.owners`) can always run every command. Everyone else needs a grant: `/nep access grant <command> [role] [user]` opens one command key (e.g. `memory.show`), a whole group (e.g. `memory`), or every command (`*`) to everyone (no role/user given), a role, or a user; `/nep access revoke` undoes one of those; `/nep access list` shows the current grants. Without a grant, a non-owner who runs `/nep` gets an ephemeral "Not allowed" reply.

| Command | What it does |
|---|---|
| `/nep status` | Model, calibration, quotas and per-guild memory status |
| `/nep reload` | Reload config and prompts now |
| `/nep ping [role]` | Send a minimal request to one or all model roles (`talk`, `analyzer`, `media`, `followup`) and report model, latency, provider, tokens or the error; does not count against `llm.maxRequestsPerDay` and works while paused or warming up |
| `/nep pause` | Stop all activity, flush memory to disk and unload it; `data/` is safe to edit while paused |
| `/nep resume` | Reload memory from `data/` and continue; refuses if any JSON file does not parse, naming the broken ones |
| `/nep interject [channel]` | Jump into the current conversation in this channel now |
| `/nep initiate [channel]` | Start a topic in this channel now |
| `/nep set <path> <value>` | Override a config value (writes to `config.local.json`) |
| `/nep unset <path>` | Remove a config override |
| `/nep rule add <text>` | Append a rule to `prompts.local/rules.md` |
| `/nep rule list` | List the rules, numbered |
| `/nep rule remove <number>` | Remove a rule by number |
| `/nep model show` | Show active models for each role (`talk`, `analyzer`, `media`, `followup`) |
| `/nep model set <role> <id>` | Set the model for a role (`talk`, `analyzer`, `media`, `followup`) |
| `/nep memory show <user> [section] [limit] [order]` | Without a section: compact summary. Sections: `character`, `style`, `relationship`, `affinity`, `aliases`, `interests`, `details`, `episodes`, `raw` (stored JSON). List sections take `limit` 1..100 (default 25) and `order`: `rank` (default, divider at the visibility cutoff) or `recent`. Stored member references resolve to the current name, except in `raw` |
| `/nep memory channel [channel]` | With a channel: stored note in full (purpose, topics, tone, message count, activity, top writers). Without: a table of every channel the persona knows, sorted by last message |
| `/nep memory server` | Server-wide notes: how people talk, how conversations start, in-jokes, self-facts, plus counts of profiles, channels and lore entries |
| `/nep memory refresh <user>` | Force a portrait refresh for a member |
| `/nep memory forget <user>` | Delete a stored profile |
| `/nep memory affinity <user> [score] [reason]` | Show or set attitude (-100..100) |
| `/nep memory alias-add <user> <name>` | Add a chat alias; confirmed at once |
| `/nep memory alias-remove <user> <name>` | Remove a chat alias |
| `/nep memory wipe <confirm>` | Wipe all analyzer memory for this server; type the exact server name to confirm |
| `/nep lore add <title> <keys> <text> [always]` | Add or overwrite a lorebook entry; an entry with the same title is replaced and becomes owner-owned, so the analyzer never edits it again |
| `/nep lore list [query]` | List lorebook entries |
| `/nep lore show <id>` | Show a lorebook entry |
| `/nep lore remove <id>` | Remove a lorebook entry |
| `/nep warmup run` | Start or resume a full run: channels, then people, then server |
| `/nep warmup users [member]` | With a member: profile or re-profile that one now; without: re-profile every qualifying member |
| `/nep warmup channels [channel]` | With a channel: describe or re-describe that one now; without: every readable channel |
| `/nep warmup server` | Rebuild the server notes and lore now |
| `/nep warmup people` | List members who qualify |
| `/nep warmup status` | Show warmup progress and token usage |
| `/nep warmup stop` | End any warmup work at once; the request in flight is cancelled, progress is kept so `run` can resume |
| `/nep warmup reset` | Clear warmup progress, not stored memory |
| `/nep access grant <command> [role] [user]` | Open a command, group or `*` to everyone (default), a role, or a user |
| `/nep access revoke <command> [role] [user]` | Revoke a previous grant from everyone (default), a role, or a user |
| `/nep access list` | List every current access grant |
