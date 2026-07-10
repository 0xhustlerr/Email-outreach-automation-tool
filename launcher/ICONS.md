# Icon requirements (do not change without user approval)

All branding uses the user's original file only:

- **Source:** `D:\email-auto-sending-automation\icon.ico` (full multi-size ICO, ~172 KB)
- **Do not** run Build-ClassicAppIco, Build-MultiClassicAppIco, Reorder-LauncherIcon, or rcedit on the exe
- **Do not** overwrite `icon.ico` with a rebuilt/smaller ICO

| Surface | How it is loaded |
|---------|------------------|
| **Email Finder.exe** | MSBuild `ApplicationIcon` → `..\icon.ico` (user file) |
| **Tray** | `new Icon(icon.ico, 32×32)` native frame |
| **Taskbar / title bar** | `Form.Icon` from `icon.ico` 128×128 (or 64/48) native frame |
| **Favicon** | Copy `icon.ico` → `public/favicon.ico`, `app/favicon.ico` |
| **Web PNG** | Copy existing `app-icon.png` or `tray-icon.png` if present — no ICO→PNG conversion |

Also ship beside the exe: `icon.ico`, `WebView2Loader.dll` (required for in-app browser).

## Widget (tray → Widget)

- Auto-search on URL paste (400ms debounce), GitHub + Stack Overflow (same APIs as web).
- Full pipeline: `resolve-so` → `repos` → `discover` + `scan` (all repos) → merged contacts.
- Activity log (text only) appears below the URL while searching.
- Send form: email pick, name, link, sender; after send shows GitHub profile URL only.
