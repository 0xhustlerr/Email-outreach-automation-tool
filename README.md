# Cold Outreach Command Center

A single control center for developer outreach. Discover every public contact for
a GitHub / Stack Overflow profile - emails, phones, and links pulled from repos,
pinned READMEs, personal sites, linked URLs, and commit `.patch` headers - then
run two-step email sequences from approved accounts and track replies as they land,
all from a Next.js web UI backed by a Windows tray widget.

## Contact discovery

Scan a GitHub user's recent commits until one of the `.patch` files reveals an
email-style `From: Display Name <user@host>` header. Displays the repo, commit
SHA, patch URL, extracted author/email, and the first N lines of the patch.

## Stack

- Next.js 15 (App Router)
- TypeScript + Tailwind CSS
- GitHub REST API (`/users/:u/repos`, `/repos/:o/:r/commits`)
- Server-side `fetch` for the raw `.patch` files (`github.com/.../commit/{sha}.patch`)

## File tree

```
email-auto-sending-automation/
├── .env.example
├── next.config.mjs
├── package.json
├── postcss.config.mjs
├── tailwind.config.ts
├── tsconfig.json
├── app/
│   ├── api/
│   │   ├── repos/route.ts     # GET  — list non-fork repos for a user
│   │   └── scan/route.ts      # POST — NDJSON stream of scan events
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx               # UI: URL input, repo picker, live progress
└── lib/
    ├── github.ts              # GitHub API client + URL parsing
    ├── patch.ts               # Patch header parsing + regex
    └── types.ts               # Shared TS types
```

## Setup

```bash
cp .env.example .env.local     # optionally set GITHUB_TOKEN
npm install
npm run dev
```

Open http://localhost:3000.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | unset | Raises GitHub rate limit from 60 → 5,000 req/h. A classic PAT with no scopes works for public repos. |
| `NEXT_PUBLIC_DEFAULT_SCAN_LIMIT` | `30` | Initial value of the scan-limit input. |
| `PATCH_PREVIEW_LINES` | `50` | Number of patch lines returned to the UI. |

## How it works

### Commit scanning

1. The browser submits a GitHub profile URL. `parseGitHubUsername` extracts the
   login from several common shapes (`https://github.com/foo`, `github.com/foo`,
   or just `foo`).
2. `GET /api/repos?user=<login>` calls `/users/:user/repos?sort=pushed&type=owner`
   and returns non-fork repos. The default selection is the most recently pushed
   non-fork repo.
3. `POST /api/scan` with `{ owner, repo, limit }` lists that many recent commits
   via `/repos/:owner/:repo/commits?per_page=<limit>`.
4. The route iterates commits sequentially. For each commit it:
   - Builds `https://github.com/{owner}/{repo}/commit/{sha}.patch`.
   - Fetches the raw patch text server-side (honoring `GITHUB_TOKEN` if set).
   - Slices the header (everything before the first blank line) and tests it
     against the email-style regex.
   - Streams a `progress` event to the client (`Checking commit N of M…`).
5. On the **first** match the server emits `match` + `done` and closes the
   stream, so no further commits are fetched. If the loop finishes without a
   match, it emits `{ type: "done", matched: false }`.

A single patch 404 or non-rate-limit 403 does not abort the scan — it's logged
as "skip" and scanning continues. A 403 with `x-ratelimit-remaining: 0` aborts
immediately and surfaces a clear message in the UI.

### Email-style match detection

The header regex in [lib/patch.ts](lib/patch.ts):

```ts
export const FROM_LINE_RE = /^From:\s+(.+?)\s+<([^>]+)>\s*$/m;
```

- `^From:` with multiline flag matches the `From:` line at the start of any
  line in the header block.
- `(.+?)` captures the display name, non-greedy so it stops before the angle
  brackets.
- `<([^>]+)>` captures the email address.
- After extraction the email is validated with a minimal
  `local@domain.tld` check. The `From …` line that starts a patch (the commit
  SHA + timestamp) is explicitly *not* matched, since it has no `:` after
  `From`.

Only the header slice is tested, so multi-megabyte patches don't get
regex-scanned in full.

### Event stream

The scan endpoint streams NDJSON — one JSON object per line — with these event
types (see [lib/types.ts](lib/types.ts)):

- `start` — total commits to scan
- `progress` — current `index` / `total`
- `match` — full match payload (repo, sha, patchUrl, preview, author)
- `done` — `matched: boolean`, `scanned: number`
- `error` — fatal error message

The client parses the stream line-by-line and updates UI state per event, so
progress, match, no-match, and error states are all driven by the same pipe.

## Tuning

### Change the scan limit

- **Per request (UI):** use the "Scan limit" number input on the page.
- **Default value:** set `NEXT_PUBLIC_DEFAULT_SCAN_LIMIT` in `.env.local`.
- **Hard cap:** `MAX_LIMIT` in [app/api/scan/route.ts](app/api/scan/route.ts)
  (currently 100 — the per-page cap of `/repos/:o/:r/commits`). If you need more,
  add pagination to `listCommits` in [lib/github.ts](lib/github.ts).

### Change the returned line count

Set `PATCH_PREVIEW_LINES` in `.env.local` (e.g. `PATCH_PREVIEW_LINES=120`). The
value is read per request in [app/api/scan/route.ts](app/api/scan/route.ts) via
`previewLines()`, so no restart is needed beyond the usual dev-server reload.

## Helper functions

All live in [lib/](lib/):

| Function | File | Purpose |
| --- | --- | --- |
| `parseGitHubUsername` | `github.ts` | Normalize a profile URL or bare login to a username. |
| `listUserRepos` | `github.ts` | `/users/:u/repos` (owner, pushed-desc, per_page=100). |
| `pickDefaultRepo` | `github.ts` | Most recently pushed non-fork repo. |
| `listCommits` | `github.ts` | `/repos/:o/:r/commits?per_page=<limit>`. |
| `buildPatchUrl` | `github.ts` | `https://github.com/{o}/{r}/commit/{sha}.patch`. |
| `fetchPatch` | `github.ts` | Server-side `fetch` with auth + User-Agent. |
| `extractPatchHeader` | `patch.ts` | Slice to the first blank line. |
| `extractAuthorFromPatch` | `patch.ts` | Regex + basic email validation. |
| `firstNLines` | `patch.ts` | Plain-text truncation for the UI preview. |

The scan loop itself — "iterate commits, fetch patch, check header, stop on
first match" — lives inline in [app/api/scan/route.ts](app/api/scan/route.ts)
so it can stream progress events as it runs.

## Error handling

- Invalid profile URL → 400 with a clear message.
- GitHub 404 (user not found) / 403 (rate limit) → surfaced as the error
  banner in the UI.
- Individual patch fetch failures → skipped silently, scan continues.
- Rate-limit 403 mid-scan → emits an `error` event and stops.
- Network failures → caught and surfaced; the user can retry.
