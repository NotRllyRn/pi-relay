# Pi Relay

Pi extension that uses multiple OpenAI Codex accounts, selects available quota, switches on account limits, and resumes interrupted tasks.

## Install

```sh
pi install git:github.com/NotRllyRn/pi-relay
```

Restart Pi.

## Add accounts

```text
/relay add
```

Run the prepared `/login openai-codex` command, then enter a label, access token, and refresh token. Secret fields are masked.

## Commands

| Command | Action |
| --- | --- |
| `/relay` | Accounts and usage |
| `/relay use <account>` | Use at next safe request |
| `/relay rename <account> <name>` | Rename an account, including the imported Default profile |
| `/relay prioritize <account>` | Prefer next |
| `/relay skip <account>` | Skip until reset |
| `/relay disable\|enable <account>` | Exclude or restore |
| `/relay refresh [all]` | Refresh usage |
| `/relay policy <name>` | Select policy |
| `/relay wait <action>` | Control Quota Wait |

## Behavior

Before output, quota failures retry the same request on another account. After partial output, Pi Relay continues in the same session with a hidden follow-up. If every account is exhausted, Quota Wait resumes after the earliest reset unless cancelled or paused. Codex is the only supported provider in this release.

## Data

Tokens are stored in `~/.pi/agent/pi-relay/state.json` with owner-only permissions. They are not encrypted. Anyone who can read files as your OS user can read them.

Users are responsible for complying with provider account and usage terms.

## Development

```sh
npm test
npm run typecheck
```
