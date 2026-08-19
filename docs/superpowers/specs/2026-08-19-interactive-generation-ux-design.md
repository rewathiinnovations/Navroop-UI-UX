# Interactive generation UX — design

Date: 2026-08-19
Status: approved, phase 1 in implementation

## Problem

During a build the workspace shows a spinner and a status line. Files appear only
when finished, so a 400-line `page.tsx` is invisible for ~30 seconds and then pops
in complete. The reference the user gave — llamacoder — makes the generation itself
the interface: code streams into a viewer, the preview compiles as soon as it can.

What we already have, and are NOT rebuilding:

- `BrowserPreview` **is** llamacoder's renderer: `esbuild-wasm` bundles in the tab,
  `esm.sh` serves dependencies, the result runs in a sandboxed iframe. No VM.
  Wired at `ProjectWorkspace.tsx`.
- SSE frames already exist (`stream`, `conversation`, `complete`, `warning`).
- A Code tab, checkpoint version history, and `react-syntax-highlighter`.

The gap is two specific things:

1. `applyStreamedCode` (`lib/generation/generation-runtime.ts`) matches only
   **closed** fences — ` ```lang{path=…}\n…\n``` ` — so a file in progress is
   not represented at all.
2. `BrowserPreview` keys its rebuild on a stable `filesKey` precisely to avoid
   recompiling ("esbuild-wasm on every keystroke is too slow"), so nothing
   recompiles mid-stream.

## Phase 1 — streaming (approach A)

Rejected alternatives: **B** code-only during the stream (preview still arrives
all at once — half the effect); **C** recompile per completed file (esbuild-wasm
runs on the main thread; 12 compiles compete with the streaming UI, which is what
the existing comment warns about).

### Data

`applyStreamedCode` also emits the currently open fence:

```ts
{ path, content: partialBody, type, completed: false, edited }
```

Contract, so the panel and the preview can rely on it:

- At most one file has `completed: false`, and it is the last element.
- A file's `completed` only ever goes `false → true`; content only grows.
- Once closed, the entry is byte-identical to what the closed-fence path produced
  before this change. Existing consumers (`hasExistingSite`, "Keep what was
  built", the `complete` frame) therefore see no behavioural change.
- A partial path is validated with the same `sanitizeGenerationPath` the persist
  path uses, so a traversal or absolute path never reaches a file rail or a key.

### Components

- `components/workspace/StreamingCodePanel.tsx` (new): file rail (done ✓ /
  writing ●), syntax-highlighted body, follows the active file. Following
  disengages when the user scrolls or picks a file, and a "Follow" control
  re-engages it — being yanked away mid-read is the failure mode here.
- `BrowserPreview` gains an explicit settle trigger (`settleMs`, default ~400)
  so recompile timing is a prop rather than an emergent property of identity.
  It compiles when a file completes and the window elapses, and once at stream
  end. Never per token.
- Status line reports what is happening — "Writing app/page.tsx · 4 of 9 files" —
  replacing "Generating code…".

### Isolation

`GenerationWorkspace.tsx` is ~119KB. The streaming view is a new file that takes
`{ files, activePath, status }` and owns no fetching, so it is testable without
rendering the workspace. Nothing else is refactored.

## Phase 2 — layout

Two-pane chat ↔ artifact with a Code/Preview toggle and version pills mapped onto
existing checkpoints; Quality/Assets/Brain/Domains move to an overflow. Designed
after phase 1 is verified in a browser.

## Error handling

- A malformed or unsafe partial path is dropped, and the drop is visible in the
  panel rather than silent (the audit found several silent drops in this area).
- A compile failure during the stream leaves the last good preview on screen and
  shows the error; it must not blank a working preview.
- The panel never invents state: if the stream dies, files stay as they were and
  the recovery panel remains the thing that explains it.

## Verification

- Unit tests for partial-fence extraction: chunk split mid-path, mid-body, two
  fences in one chunk, an unclosed fence followed by a new opener, CRLF, and a
  traversal path.
- Unit test that a closed file's final shape is unchanged from before.
- Then a real generation driven in the browser, with screenshots of code
  streaming and the preview appearing mid-build.
