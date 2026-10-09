# Release verification: 0.1.0

Verified on October 9, 2026 with Node 24.19.0 and published OpenClaw 2026.10.1-beta.2 (c58cf3a).

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm test`: 36 tests passed, including the actual published beta loader and hook dispatcher. Synthetic OAuth credentials and Penny responses were isolated in temporary profiles.
- `npm pack --pack-destination .build --json`: seven shipping files; no source checkout, test credentials, logs, or dependencies in the archive.
- `clawhub package validate <extracted-package> --openclaw-version 2026.10.1-beta.2`: no issues.
- `openclaw plugins install <archive> --force --accept-capabilities`: installed into an isolated profile.
- `openclaw plugins inspect penny --runtime --json`: loaded, selected memory provider, all three Penny tools and CLI registered.
- Public protected-resource and authorization-server discovery: HTTP 200, expected resource and issuer, public-client method `none`, PKCE `S256`, and issuer-response support.

Archive SHA-256: `8b6f98a198cc295a810701e954459d4418cd480dbc6938c6c2e2c6e8def2b10b`.

The OAuth callback and read/write flows in tests are synthetic. This release has not yet been tested with a live Penny account, actual conversational lineage minting, or later OpenClaw versions. Native retrieval returns a bounded session snapshot rather than a fresh server read. ClawHub approval and a mypenny.ai install page are separate publication steps.
