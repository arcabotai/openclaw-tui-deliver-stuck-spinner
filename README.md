# openclaw-tui-deliver-stuck-spinner

Root-cause write-up and a runnable local fix for an OpenClaw TUI UX bug.

**TL;DR** — `openclaw tui` looks broken on a fresh install: you type a message, the spinner spins forever, Esc says `no active run`, and no reply ever appears. The backend actually answers the message (it ends up in the session file on disk), but the TUI can't recover from its own `--deliver: false` default. This repo explains why and ships a drop-in patch script.

Discovered and patched against **OpenClaw 2026.4.14** (commit `323493f`).

Upstream tracker:
- ergonomic half, stale: [openclaw/openclaw#33102](https://github.com/openclaw/openclaw/issues/33102)
- new issue focused on the stuck-spinner failure mode: *link added after filing*

> Credit: [arcabot.ai](https://arcabot.ai)

---

## Symptom

```
$ openclaw tui --session smoke-2
> 2+2

[spinner: "bamboozling... | connected"   — forever]
[Esc] → "no active run"
```

But:

- The session file on disk contains the assistant reply (`4`). The backend ran the turn.
- `openclaw tui --deliver --session smoke-2` works instantly and renders `4`.

So the model is fine. The TUI just refuses to recover from its own default.

## Root cause

In the published bundle `dist/tui-*.js` (line numbers from 2026.4.14):

- `sendMessage` sets `activityStatus = "waiting"` after `client.sendChat(...)` resolves.
- `state.activeChatRunId` is **only ever set** inside `handleChatEvent` — i.e. when a `chat.event` frame arrives from the gateway.
- `activityStatus` is **only ever cleared** inside `finalizeRun` / lifecycle-end handlers, which also depend on `chat.event` frames.

When `deliver: false` is sent on the `chat.send` request, the gateway runs the message to completion but **does not stream `chat.event` frames back to this client**. Consequences:

1. `activeChatRunId` stays `null` forever.
2. `activityStatus` stays `"waiting"` forever → spinner never stops.
3. `abortActive()` sees `activeChatRunId == null` → prints `no active run` on Esc.
4. User concludes "the TUI is broken," not "the reply was stored but not streamed to me."

The CLI and the TUI runtime both default `deliver` to `false` in 2026.4.14. A UI whose entire purpose is to render replies should not default to not-receiving them.

## Fix (four changes)

1. **CLI:** flip `--deliver` default to `true`, add `--no-deliver` as the explicit opt-out.
2. **Runtime:** make `deliverDefault` mutable at runtime and read it from `state` so a toggle can change it.
3. **`sendMessage`:** if delivery is off, don't hang — clear optimistic state, log `sent (reply delivery off — enable via settings to see replies here)`, set activity back to `idle`.
4. **Settings panel:** add a persistent **Deliver replies** toggle next to *Tool output* / *Show thinking*.

## Apply the fix to your installed OpenClaw

```bash
git clone https://github.com/arcabotai/openclaw-tui-deliver-stuck-spinner.git
cd openclaw-tui-deliver-stuck-spinner
node apply-local-patch.mjs
```

Or, one-liner:

```bash
curl -sL https://raw.githubusercontent.com/arcabotai/openclaw-tui-deliver-stuck-spinner/main/apply-local-patch.mjs | node
```

The script:

- locates your installed `openclaw` package (via `require.resolve`, with a Homebrew fallback),
- finds the content-hashed `tui-cli-*.js` and `tui-*.js` bundles in `dist/` (hashes change per release),
- verifies each expected old string is present before touching anything,
- applies the replacements,
- is idempotent — safe to re-run, reports what was applied and what was already patched,
- fails cleanly with a clear error if your OpenClaw version doesn't match (expected bundle strings missing).

> **Heads-up:** this patches the installed bundle in place. Running `npm i -g openclaw` (or `brew upgrade openclaw`) will overwrite it. Re-run the script after upgrading until the fix lands upstream.

## Exact diffs

### File 1 — `dist/tui-cli-*.js`

```diff
- .option("--deliver", "Deliver assistant replies", false)
+ .option("--deliver", "Deliver assistant replies to the TUI (default: on)", true).option("--no-deliver", "Disable delivering assistant replies to the TUI")
```

Per commander.js 14 docs: if you define `--foo` first, adding `--no-foo` does not change the default value — so `deliver` defaults to `true`, `--deliver` is a no-op (preserved for muscle memory), and `--no-deliver` is the opt-out.

### File 2 — `dist/tui-*.js`

**Default flipped to on, made mutable:**

```diff
- const deliverDefault = opts.deliver ?? false;
+ let deliverDefault = opts.deliver ?? true;
```

**`state` object gains getter/setter:**

```diff
  get showThinking() { return showThinking; },
  set showThinking(value) { showThinking = value; },
+ get deliverDefault() { return deliverDefault; },
+ set deliverDefault(value) { deliverDefault = value; },
```

**`sendMessage` reads from state and handles `deliver=off` cleanly:**

```diff
+ const deliverNow = state.deliverDefault;
  await client.sendChat({
    sessionKey: state.currentSessionKey,
    message: text,
    thinking: opts.thinking,
-   deliver: deliverDefault,
+   deliver: deliverNow,
    timeoutMs: opts.timeoutMs,
    runId
  });
  if (!isBtw) {
-   setActivityStatus("waiting");
+   if (deliverNow) {
+     setActivityStatus("waiting");
+   } else {
+     state.pendingOptimisticUserMessage = false;
+     chatLog.addSystem("sent (reply delivery off — enable via settings to see replies here)");
+     setActivityStatus("idle");
+   }
    tui.requestRender();
  }
```

**Settings panel gains a third row:**

```diff
  }, {
    id: "thinking",
    label: "Show thinking",
    currentValue: state.showThinking ? "on" : "off",
    values: ["off", "on"]
+ }, {
+   id: "deliver",
+   label: "Deliver replies",
+   currentValue: state.deliverDefault ? "on" : "off",
+   values: ["off", "on"]
  }], (id, value) => {
    ...
+   if (id === "deliver") {
+     state.deliverDefault = value === "on";
+     chatLog.addSystem(`reply delivery ${state.deliverDefault ? "on" : "off"}`);
+   }
    tui.requestRender();
  }
```

## Behavior after patch

- `openclaw tui --session smoke-2` → replies stream in the TUI immediately. No more stuck spinner.
- `openclaw tui --deliver …` → still works (no-op, preserved for backwards compat).
- `openclaw tui --no-deliver …` → opts out; TUI prints a clear system line and returns to `idle` instead of hanging.
- Esc → settings → **Deliver replies** toggle lets you flip delivery at runtime.

## License

MIT, matching upstream OpenClaw.
