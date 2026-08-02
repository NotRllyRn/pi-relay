# Pi Relay

Pi extension that uses multiple OpenAI Codex accounts, selects available quota, switches on account limits, and resumes interrupted tasks.

## Install

```sh
pi install git:github.com/NotRllyRn/pi-relay
```

Restart Pi.

## Manage Relay

```text
/relay
```

This shows account status and opens a menu for adding, renaming, deleting, enabling, selecting, or unpinning accounts; refreshing usage; changing policy; and controlling Quota Wait.

Adding an account prepares `/login openai-codex`. Enter a label, access token, and refresh token there. Secret fields are masked.

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
