# Security

## Reporting a vulnerability

Report privately through the repository's Security tab: **Security > Advisories > Report a vulnerability**. Do not open a public issue.

Include:

- What the vulnerability does and its impact.
- Steps to reproduce it.
- The affected file, setting or endpoint.
- A proof of concept if you have one.

## Scope

The code in this repository. Issues in discord.js or Node.js go to their upstream trackers.

Worth reporting here:

- Anything that leaks the Discord token, the API key or `data/` contents.
- Anything that lets a non-owner run owner commands or write to the bot's files.
- Anything that makes the bot send or act outside the output contract (`<msg>`, `<react>`, `<skip/>`).

Prompt injection that makes the persona say something silly is a prompt-quality matter — open a regular issue unless it crosses one of the lines above.

## Supported versions

Only the current `main` branch.

## Response

Single maintainer, best-effort response. Expect acknowledgement within a week.
