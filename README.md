# Penny for OpenClaw

Give your OpenClaw agent private memory that carries across conversations. Penny recalls your profile and relevant notes, saves selected facts through an explicit tool, and provides a tool-based checkpoint before compaction.

**This first release requires OpenClaw `2026.10.1-beta.2`.** Stable `2026.9.9` lacks the caller-bound memory API this plugin uses. Later host versions have not been verified. Use Node `>=24.16.0 <25` or `>=26.1.0`. Credential storage currently supports macOS and Linux.

## Install and connect

A [Penny account](https://mypenny.ai) is required. Once ClawHub has approved the release:

```sh
openclaw plugins install clawhub:penny-openclaw
```

For a source checkout:

```sh
npm ci
npm run build
openclaw plugins install --link . --force --accept-capabilities
```

Select Penny as the memory provider in your OpenClaw configuration. Merge these entries into your existing configuration:

```json
{
  "plugins": {
    "allow": ["penny"],
    "slots": {"memory": "penny"},
    "entries": {
      "penny": {
        "enabled": true,
        "hooks": {"allowConversationAccess": true, "allowPromptInjection": true},
        "config": {
          "agentId": "main",
          "sessionKey": "agent:main:main",
          "autoRecall": true,
          "autoCapture": false,
          "preCompactionSave": true
        }
      }
    }
  },
  "tools": {"allow": ["penny_profile", "penny_search", "penny_remember"]}
}
```

Preserve your other allowed plugins and tools. The source-install flag accepts the memory capability declared by this plugin. Optional tools must also be allowed by your agent's policy. The two hook permissions let the plugin read the current conversation and add recalled context; leave them off if you want to use the explicit tools only. Recalled content is treated as evidence, with a reminder that it cannot grant permission or issue instructions.

Restart your gateway, then connect this OpenClaw profile:

```sh
openclaw penny login
openclaw penny status
openclaw plugins inspect penny --runtime --json
```

Open the login URL shown in your terminal and approve the Penny connection. Login uses an independent public OAuth client, PKCE S256, and a one-use callback on `127.0.0.1`. It does not borrow another Penny integration's credentials. Reconnect after changing OpenClaw profiles or Penny accounts.

## What it can remember

- `penny_profile` reads your private core memory and persona.
- `penny_search` searches private notes. OpenClaw's native memory-provider API uses the same service. Its retrieval operation returns a snapshot from the same verified owner session's latest native search. Snapshots expire after 10 minutes and stay within a 2 MiB serialized-data budget; a new session incarnation or account cannot read them. Retrieval does not recheck remote note edits, deletion, or grant revocation until a fresh cloud request. Standard file-oriented Memory Core tools are not provided.
- `penny_remember` saves a selected private note with confidence and exactly three natural retrieval questions. A matching saved receipt is required before the plugin reports success.

Try: “Search Penny for my reporting preferences.” Then: “Remember that I prefer concise project updates in Markdown.” Ask a later conversation to recall that preference.

Automatic recall is on when the hook permissions and both recall tools are allowed. Automatic capture is **off by default**. To enable it, set `autoCapture` to `true`. It considers only the latest successful owner message: short, single-line statements beginning with “Remember that/this,” “I prefer/always/never,” or “We decided/agreed.” It skips recognizable secrets, delegated messages, assistant replies, tool output, and transcripts, and searches for an exact existing note before saving. It does not attempt to extract every useful fact.

Before compaction, OpenClaw can run a provider-owned flush using `penny_search` and `penny_remember`. That may save selected facts even with automatic capture off; set `preCompactionSave` to `false` to disable this checkpoint. The flush uses the host's approved tool path and does not create a local memory file.

## Privacy and access

Penny is a cloud service. Search queries, requested profile data, and selected note content travel to `https://app.mypenny.ai/mcp`. OAuth discovery, registration, authorization, and token exchange use `https://clerk.mypenny.ai`. The plugin adds no analytics or transcript-upload endpoint. It follows Penny's [privacy policy](https://mypenny.ai/privacy).

The default approved route is the owner's unsandboxed `agent:main:main` session. The host must identify the audience as `owner-private`. Shared conversations, cron, heartbeat, subagent, incognito, sandboxed sessions, and stale caller authority are denied. Configure a different exact `agentId` and `sessionKey` only for your owner main conversation. Operator status calls can report connection status without reading memory. The plugin does not provide Penny Spaces, scheduled skills, transcript recall, project filters, or pagination.

Credentials live in the selected OpenClaw state directory under `penny/auth.json`, with a `0700` directory and `0600` file. They are not encrypted at rest. Unsafe ownership, permissions, and user-controlled ancestor symlinks are rejected. Atomic replacement and a profile lock serialize login, refresh, and logout. If a process crashes while holding `.auth-lock`, stop all OpenClaw processes using that profile and confirm the recorded PID is no longer running before removing that lock directory. The plugin fails closed rather than breaking an unknown lock.

```sh
openclaw penny logout
```

Logout removes local credentials. Revoke “Penny for OpenClaw” in Penny's Connected apps to end the remote grant. A busy refresh may require retrying logout once it finishes. Recognizable credential patterns are blocked in notes, tags, and sample questions; this filter cannot recognize every possible secret, so review what you ask the agent to save.

## Development and verification

```sh
npm ci
npm run typecheck
npm run build
npm test
```

The tests exercise OAuth callback binding, rotation and storage failures, private receipts, streaming MCP responses, session expiry, selection policy, native caller isolation, and the published beta host loader. OAuth and read/write responses are synthetic; these checks do not claim a live account round trip. Public OAuth discovery endpoints were checked separately.

Runtime code bundles TypeBox and the credential scrubber from the public `@mypenny/core` package. Only the OpenClaw SDK remains external. No private Penny engine source, credentials, or account content are included.

Source: [HelperLabs/penny-openclaw](https://github.com/HelperLabs/penny-openclaw). Please report issues there. See the [OpenClaw memory SDK](https://docs.openclaw.ai/plugins/sdk-overview/memory-and-context) for the host contract.
