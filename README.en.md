# BlitzGrep

[日本語 README](README.md)

**Full-text search for the question "where did this code come from?"**

Searches the places `Ctrl+Shift+F` can't reach — other branches, commit history, and
**your Claude Code conversation logs** — from one search box.

> You look at code an AI agent wrote and think: *"where was that spec written down?"*
> Sometimes the answer isn't in your working tree. It might be on a branch, in a deleted
> commit, or — most often — **only in the conversation**. BlitzGrep searches all of it at once.

## Start here: `Ctrl+Alt+O`

Put your cursor on a line you're curious about and press **`Ctrl+Alt+O`**
(*BlitzGrep: Where did this come from?*). It runs four sources in one shot and merges the
results into a single list:

```
📍 a1b2c3d4  last touched this line — add passphrase TTL      2026-08-01 you
   traced.ts:1  export const PASSPHRASE_TTL_HOURS = 24;
◆ a1b2c3d4  add passphrase TTL                                2026-08-01 you
 + traced.ts:1  export const PASSPHRASE_TTL_HOURS = 24;
💬 2026-08-01  my-project                                      main
   🤖Write   "content": "export const PASSPHRASE_TTL_HOURS = 24;"
   👤text    how many hours until the passphrase expires?
   🤖think   24 hours seems right for a passphrase.
```

Top to bottom: *who touched it last* → *when it landed* → **why it is the way it is**.
Click the 💬 result and the conversation opens as readable Markdown, scrolled to that
exact message.

A line of code rarely appears verbatim in conversation, so when an exact match finds
nothing, BlitzGrep extracts one distinctive term from the line and retries automatically.
The sidebar tells you what it retried with.

## How it differs from GitLens and others

BlitzGrep does not compete with GitLens. **It answers a different question.**

| Question | VS Code search | GitLens | BlitzGrep |
|---|---|---|---|
| Where is it **now**? | ✅ | — | ✅ |
| Is it on another **branch**? | ❌ open tree only | ❌ browsing, not search | ✅ `git grep` across every ref |
| **When** did it land (incl. deleted lines)? | ❌ | △ commit search, not line-level tracking | ✅ parses `git log -S` down to the diff |
| **Who** touched it last? | ❌ | ✅ blame is its home turf | ✅ as stage one of origin tracing |
| **Why** is it this way? | ❌ | ❌ | ✅ **Claude Code conversation logs** |
| All of the above **in one shot**? | ❌ | ❌ | ✅ `Ctrl+Alt+O` |

Two things matter here.

1. **The "why" lives somewhere else.** GitLens reads what git knows: who, when, what.
   When you build with an AI agent, the *why* ends up in the conversation, not the commit
   message. BlitzGrep treats that conversation as a searchable source. Reaching outside git
   is the thing no other extension does.
2. **You don't have to ask the questions separately.** Instead of "check blame, then search
   the log, then dig through chat," one term goes to four sources at once and comes back as
   a single timeline. The sidebar shows a live pipeline of which stage returned what.

Keep GitLens installed. Use GitLens for always-on blame annotations; reach for
`Ctrl+Alt+O` **only when you're stuck on "where did this spec come from?"**

### Non-goals

- Inline blame annotations, hovers, file history views, commit graphs — that's GitLens.
- Git operations (commit / push / stage) — BlitzGrep only reads.
- Other AI tools' history — currently Claude Code's transcript format only.

## The four sources

| Source | Question it answers | Engine |
|---|---|---|
| **Now** (working tree) | Where is it used? | ripgrep (auto-detected from your VS Code) |
| **Branches** | Is it only on someone else's branch? | parallel `git grep <ref>` |
| **History** | **When** did it land / what landed with it? | `git log -S` / `-G` (pickaxe) |
| **Conversation** | **Why** did it land / who proposed it? | `~/.claude/projects/**/*.jsonl` |

### Why all four

- **History (pickaxe)** only sees what's reachable from HEAD. Unmerged branches are invisible.
- **Branch search** only sees refs that still exist. A branch deleted after a squash merge is gone.
- **Conversation logs** hold things nothing else does. The spec you added as an aside mid-chat,
  or the one Claude proposed and you approved with "sounds good" — **exists in no commit and no file.**

## Usage

1. Magnifier icon in the activity bar, or `Ctrl+Alt+F`.
2. Pick a source and type.
3. Working tree and conversation search run as you type. **Branch and history search run on `Enter`**
   (they're expensive).

Picking a source shows a one-line explanation of what it does. When a search comes up empty,
the sidebar lists what to try next for that particular source.

### Pipeline view

Searches that run multiple stages (origin tracing, branch search) show their progress per stage:

```
● 📍 last touched this line          1 hit
│
◐ ◆ when it landed (git log -S)      4 hits
│    retrying with "traceOrigin"
○ 💬 why it landed (conversation)
```

Every stage is listed before anything runs, so you know what's left. Stages that don't run stay
visible with a reason (`not committed yet`, `no anchor line in the editor`). Branch search shows
`7/20 branches` with a progress bar.

### History search

Results group by commit. `+` marks added lines, `-` removed lines.
**Other hits under the same commit are what landed alongside it.** Click an added line to open
that commit's version; click a removed line to open **its parent** — the state just before deletion.

### Conversation search

You choose which blocks to search:

| Block | Contents | Default |
|---|---|---|
| Messages | your prompts and Claude's replies | on |
| Thinking | Claude's reasoning; often holds the *why* | on |
| Tool input | `Edit` / `Write` arguments — **what was actually written** | on |
| Tool results | tool output; large and noisy | off |

By default only the project matching your workspace. "All projects" searches across them.
Sub-agent (Task) conversations are included.

**Conversation logs live outside your repository** (`~/.claude/projects/`). Of the four sources,
this is the only one that reads outside git. Nothing is sent anywhere — everything stays local.

Matching your workspace to a project directory is done by name first, falling back to the `cwd`
recorded inside the transcript. The directory naming scheme is Claude Code's internal detail, so
relying on the name alone would break silently if it ever changes.

**While "all projects" is on**, conversations from unrelated folders are in scope. So you can tell,
the toolbar shows `⚠ all projects` and matching sessions are tagged `別プロジェクト` (other project)
in the result list.

Clicking a result **reassembles the conversation as readable Markdown** and jumps to the message.

### Keyboard

| Key | Action |
|---|---|
| `Ctrl+Alt+O` (`Cmd+Alt+O`) | **Where did this come from?** (blame + history + conversation) |
| `Ctrl+Alt+F` (`Cmd+Alt+F`) | Open BlitzGrep and focus the search box |
| `Ctrl+Alt+Shift+F` | Search the editor selection (or word) |
| `F4` / `Shift+F4` | Next / previous match |
| `Enter` | Run the search |
| `↑` / `↓` | Move through results with preview |
| `←` / `→` | Collapse / expand a group (when the list has focus) |
| `Alt+C` / `Alt+W` / `Alt+R` | Case sensitive / whole word / regex |
| `Esc` | Cancel a running search |

### Finding the line you opened

The **match** and the **line** are marked differently on purpose — using the same colour for both
makes the match disappear into the line.

| What | How it's shown |
|---|---|
| **The match itself** | Filled with an opaque colour, text colour changed (highlighter pen) |
| The line | Neutral faint tint + a bar at the line start + a ▶ in the gutter |
| Just after jumping | The line flashes for 0.7s (`blitzgrep.flashOnJump`) |

Even when the exact position can't be resolved (conversation Markdown), the line marker always shows.
All colours are theme-overridable:

| Colour | Used for |
|---|---|
| `blitzgrep.currentMatchBackground` | the match fill |
| `blitzgrep.currentMatchForeground` | the match text |
| `blitzgrep.currentMatchBorder` | match border, line bar, gutter marker |
| `blitzgrep.currentLineBackground` | the line tint |
| `blitzgrep.flashBackground` | the post-jump flash |

## Limitations (stated plainly)

**Conversation logs expire.** Claude Code deletes old transcripts automatically
(`cleanupPeriodDays`, default 30 days). You can raise it in `~/.claude/settings.json`, but
**what's already gone is gone.** If you want the "why" to survive, raise it before you need it.

Also:

- Branch search only covers **refs you've already fetched**. An un-fetched `origin/xxx` won't appear.
- History search goes back 300 commits by default (`blitzgrep.historyMaxCommits`). Merge commit diffs are skipped.
- Regex dialects differ per source: working tree = Rust regex, branches = PCRE (`git grep -P`),
  history = POSIX (`git log -G`), conversation = JavaScript.
- History search is unavailable in virtual repositories (`vscode-vfs`). Branch search there goes through
  the API and downloads the branch archive on first use (aborts above 120 MB).
- Branch and history contents are read as UTF-8. Shift-JIS will be garbled.
- No external processes (ripgrep / git) are launched in untrusted workspaces.

**The transcript format is not a published contract.** It's Claude Code's internal format and can
change. If it does, run **`BlitzGrep: Diagnose conversation logs`** — it reports what it read, what it
could extract, and any block types it doesn't recognise. Search also reports the problem itself rather
than quietly returning "no matches".

## Settings

| Setting | Default | Description |
|---|---|---|
| `blitzgrep.maxResults` | `10000` | Max hits collected per search |
| `blitzgrep.debounceMs` | `120` | Incremental search debounce |
| `blitzgrep.historyMaxCommits` | `300` | How far history search goes back |
| `blitzgrep.useGitignore` | `true` | Respect `.gitignore` |
| `blitzgrep.includeHidden` | `false` | Search hidden files too |
| `blitzgrep.excludeGlobs` | `node_modules` etc. | Globs always excluded |
| `blitzgrep.maxFileSizeKb` | `2048` | Skip files larger than this |
| `blitzgrep.branchConcurrency` | `6` | Concurrent `git grep` processes |
| `blitzgrep.highlightInEditor` | `true` | Faintly highlight all matches of the term |
| `blitzgrep.highlightCurrentLine` | `true` | Mark the opened line (tint + bar + gutter) |
| `blitzgrep.flashOnJump` | `true` | Flash the line right after opening |
| `blitzgrep.contextLines` | `0` | Context lines (working tree only) |
| `blitzgrep.ripgrepPath` | `""` | Explicit ripgrep path |
| `blitzgrep.githubMaxFilesPerBranch` | `1500` | File cap per branch in virtual repositories |
| `blitzgrep.openPreview` | `true` | Single click opens in a preview tab |

## Development

```bash
npm install
npm run watch             # esbuild watch build
npm run typecheck         # tsc --noEmit
npm test                  # unit tests + webview smoke tests
npm run test:integration  # integration tests in an isolated VS Code
npm run package           # produce blitzgrep.vsix
```

Open the folder in VS Code and press `F5` for an extension development host.

Unit tests stub the `vscode` module and run against real `git` and real `ripgrep` (auto-detected
from an installed VS Code). The webview (`media/main.js`) only runs inside VS Code, so
`test/webview.js` loads it against a minimal DOM stub and asserts what it renders. Integration
tests use a VS Code downloaded into `.vscode-test/` and never touch your settings, extensions,
or conversation logs (`CLAUDE_CONFIG_DIR` points at a fixture).

CI runs every suite on Ubuntu, macOS, and Windows.

## License

MIT
