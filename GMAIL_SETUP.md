# Gmail Connection Setup

The app connects to Gmail on two layers:

| Layer | What it does | Credential |
| --- | --- | --- |
| **Sending** | Sends your outreach emails | App password (SMTP) |
| **Reply sync** | Reads replies landing in the sender's inbox | OAuth token (read-only) |

The two are independent: sending is always SMTP, and the OAuth token is only
ever used to *read* replies. Outbound SMTP (port 465/587) must therefore be
reachable from the machine running the app — most VPS hosts block it by
default, so open it there or run the app somewhere that allows it. Parts 2–5
below are needed only if you want reply sync.

---

## Part 1 — Add a sending account (app password)

1. Make sure the Gmail account has **2-Step Verification** on:
   [myaccount.google.com/security](https://myaccount.google.com/security).
2. Create an app password at
   [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   (any name, e.g. "Outreach"). Copy the 16-character password.
3. In the app: **Accounts** (top bar) → add the account with its display name,
   Gmail address, and the app password.

> On a machine where outbound SMTP is blocked the password cannot be verified at
> save time — the app saves it with a warning, but sending will keep failing
> until the port is open.

## Part 2 — Create the OAuth client (per account, or one shared by all)

Each account saves its own Client ID/Secret in the app, so you can create a
separate Google Cloud project per Gmail account **or** reuse one project for
all of them — both work. The only rule: each account's refresh token (Part 3)
must be generated with the client saved for that account.

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and
   create a project (any name).
2. Enable the **Gmail API** — the client cannot call Gmail until this is on:
   - Make sure the correct project is picked in the project selector at the top
     of the page (everything below is per-project).
   - Left menu → **APIs & Services** → **Library**, or go straight to
     [console.cloud.google.com/apis/library](https://console.cloud.google.com/apis/library).
   - Search `Gmail API`, open the result whose provider is **Google Enterprise
     API / Google**, and click **Enable**.
   - Wait for the page to turn into the Gmail API dashboard ("API Enabled").
     If it still shows a blue **Enable** button, it did not take — reload and
     click again.
   - Nothing else on that page needs changing (no quotas, no credentials yet).
3. Configure the **OAuth consent screen** — in the current console this lives
   under **APIs & Services → OAuth consent screen**, which redirects to
   **Google Auth Platform**
   ([console.cloud.google.com/auth/overview](https://console.cloud.google.com/auth/overview)).
   If the project has never been configured, click **Get started** and fill the
   short wizard first (App name → user support email → **Audience: External** →
   contact email → agree → Create). Then set each page:
   - **Branding** — *App name* (shown on the consent screen, e.g. "Outreach"),
     *User support email*, and *Developer contact information*. Logo, home page,
     and privacy/terms URLs can stay empty for personal use.
   - **Audience** — User type must be **External**. While it says **Testing**,
     scroll to **Test users** → **Add users** and add **every Gmail address you
     send from**, one per line, then **Save**. An account that is not listed
     here gets `403 access_denied` in Part 3.
   - **Data access** — click **Add or remove scopes**. The Gmail read scope is
     sensitive/restricted, so it is usually not in the visible list: paste it
     into the **Manually add scopes** box at the bottom, then **Add to table**:
     - `https://www.googleapis.com/auth/gmail.readonly` (read replies)

     Click **Update**, confirm it now appears under *Restricted scopes* /
     *Sensitive scopes*, then **Save**.
   - Google may show a "verification required" notice for these scopes. Ignore
     it: an unverified app still works for your own test users (and, after
     Part 5, for up to 100 users) with an extra Advanced → continue click.
4. Create credentials: **APIs & Services → Credentials** → **Create
   credentials** → **OAuth client ID** → Application type **Web application** →
   under *Authorized redirect URIs* click **Add URI** and enter
   `https://developers.google.com/oauthplayground` (no trailing slash) →
   **Create**.
5. Copy the **Client ID** and **Client Secret**, and paste them in the app
   under **Accounts → Reply sync setup** (step 1 in the modal).

## Part 3 — Get a refresh token (repeat for EACH sending account)

1. Open [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground/).
2. Click the **gear icon** (top right) → tick **Use your own OAuth
   credentials** → paste the same Client ID and Client Secret.
3. In the Step 1 panel, type the scope into **"Input your own scopes"**:

   ```
   https://www.googleapis.com/auth/gmail.readonly
   ```

4. Click **Authorize APIs** and sign in **as the sending account you are
   setting up right now** — the token belongs to whichever account you pick.
5. Click **Allow**.
6. Click **Exchange authorization code for tokens** and copy the
   **Refresh token** (starts with `1//`).

## Part 4 — Connect the token in the app

1. **Accounts → Reply sync setup** → find the account → paste the refresh
   token → save. The app test-exchanges the token immediately, so a bad paste
   fails here instead of at send time.
2. Repeat Parts 3–4 for every sending account.

## Part 5 — Publish the consent screen

While the consent screen is in **Testing**, Google expires refresh tokens
after ~7 days. On the OAuth consent screen page click **Publish app**, then
re-do Parts 3–4 once so the tokens are permanent.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `connect ETIMEDOUT ...:465` in the log | Outbound SMTP is blocked (typical on VPS). Open port 465/587 outbound on the host, or run the app from a network that allows it — sending has no other path. |
| `invalid_grant` on token exchange | Token expired (consent screen still in Testing → Part 5) or revoked. Mint a new one (Part 3). |
| "Could not sign in to Gmail with that app password" | Use a 16-character **App Password** (Part 1), not the normal account password; 2-Step Verification must be on. |
| Consent screen shows "unverified app" warning | Normal for your own client in Testing/Published state — click Advanced → continue. |
| `403: access_denied` when authorizing | That Gmail address is not a **Test user** (Part 2, step 3 → Audience), or you signed in with a different account than intended. |
| `400: redirect_uri_mismatch` | The OAuth client is missing `https://developers.google.com/oauthplayground` as an authorized redirect URI (Part 2, step 4) — add it exactly, no trailing slash. |
| `Gmail API has not been used in project ... before or it is disabled` | Part 2, step 2 was skipped or applied to a different project. |

**Env notes (advanced):** tokens entered in the UI are stored in the local
database and take precedence over any `GMAIL_*` values in `.env.local`.
