# Commands

Channels, roles and users are picked from Discord's own pickers; `set`/`unset` and `access grant`/`access revoke` autocomplete their `path`/`command` options.

`/nep` is visible to every member from the start; access is gated per command at the moment it runs, never through Discord's own command visibility. Owners (`bot.owners`) can always run every command. Everyone else needs a grant: `/nep access grant <command> [role] [user]` opens one command key (e.g. `memory.show`), a whole group (e.g. `memory`), or every command (`*`) to everyone (no role/user given), a role, or a user; `/nep access revoke` undoes one of those; `/nep access list` shows the current grants. Without a grant, a non-owner who runs `/nep` gets an ephemeral "Not allowed" reply. `private.show` and `private.forget` are owner-only and excluded from all grants; `access grant` refuses them, and `access list` does not offer them.

| Command | What it does |
|---|---|
| `/nep status` | Model, calibration, quotas (including image count and image model), per-guild memory status, private chat on/off and private file count |
| `/nep reload` | Reload config and prompts now |
| `/nep ping [role]` | Send a minimal request to one or all model roles (`talk`, `analyzer`, `classifier.text`, `classifier.media`, `classifier.video`) and report model, latency, provider, tokens or the error; `/nep ping classifier` pings all three classifier roles. After `classifier.video`, reports `youtube: API key — {status}` (e.g. `ok`, `not needed (yt-dlp ok)`, `missing (blocked)`); after `classifier.text`, reports `web: API key — {status}` (`ok`, `missing` or `off`). Does not count against `llm.maxRequestsPerDay` and works while paused or warming up |
| `/nep pause` | Stop all activity, flush memory to disk and unload it; `data/` is safe to edit while paused |
| `/nep resume` | Reload memory from `data/` and continue; refuses if any JSON file does not parse, naming the broken ones |
| `/nep interject [channel]` | Jump into the current conversation in this channel now |
| `/nep initiate [channel]` | Start a topic in this channel now |
| `/nep draw <text> [self]` | Draw one picture through the drawing prompt. Answered only to you (ephemeral with the picture attached). Spends balance against `image.maxPerDay` but not against a member's quota. Refused while paused. NOT gated by `features.imageGeneration` |
| `/nep set <path> <value>` | Override a config value (writes to `config.local.json`) |
| `/nep unset <path>` | Remove a config override |
| `/nep rule add <text>` | Append a rule to `prompts.local/rules.md` |
| `/nep rule list` | List the rules, numbered |
| `/nep rule remove <number>` | Remove a rule by number |
| `/nep model show` | Show active models for each role (`talk`, `analyzer`, `classifier.text`, `classifier.media`, `classifier.video`) |
| `/nep model set <role> <id>` | Set the model for a role (`talk`, `analyzer`, `classifier.text`, `classifier.media`, `classifier.video`) |
| `/nep memory show <user> [section] [limit] [order]` | Without a section: compact summary. Sections: `character`, `style`, `relationship`, `affinity`, `aliases`, `interests`, `details`, `episodes`, `raw` (stored JSON). List sections take `limit` 1..100 (default 25) and `order`: `rank` (default, divider at the visibility cutoff) or `recent`. Stored member references resolve to the current name, except in `raw` |
| `/nep memory channel [channel]` | With a channel: stored note in full (purpose, topics, tone, message count, activity, top writers). Without: a table of every channel the persona knows, sorted by last message |
| `/nep memory server` | Server-wide notes: how people talk, how conversations start, in-jokes, self-facts, plus counts of profiles, channels and lore entries |
| `/nep memory refresh <user>` | Force a portrait refresh for a member |
| `/nep memory forget <user>` | Delete a stored profile and its private memory |
| `/nep memory affinity <user> [score] [reason]` | Show or set attitude (-100..100) |
| `/nep memory wipe <confirm>` | Wipe all analyzer memory for this server, including private files; type the exact server name to confirm |
| `/nep private show <user>` | Show a member's private memory: relationship, interests, details, episodes, private and effective attitude, today's reply count. No private layer is a plain answer, not an error. Owner-only; cannot be granted |
| `/nep private forget <user>` | Delete only a member's private memory; the public profile is kept. Owner-only; cannot be granted |
| `/nep alias add <user> <name>` | Add a chat alias; confirmed at once |
| `/nep alias remove <user> <name>` | Remove a chat alias |
| `/nep learned list` | List lessons with ids, who taught each one, sightings |
| `/nep learned add <text>` | Add a lesson by hand (no teacher, confirmed) |
| `/nep learned remove <id>` | Delete a lesson |
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
| `/nep access grant <command> [role] [user]` | Open a command, group or `*` to everyone (default), a role, or a user. `private.*` is excluded; see above |
| `/nep access revoke <command> [role] [user]` | Revoke a previous grant from everyone (default), a role, or a user |
| `/nep access list` | List every current access grant |
