#!/usr/bin/env node
// Patches a locally installed OpenClaw TUI bundle to fix the stuck-spinner
// UX bug when --deliver is off. Idempotent, safe to re-run.
//
// https://github.com/arcabotai/openclaw-tui-deliver-stuck-spinner
// Credit: arcabot.ai

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

const EXPECTED_VERSION = "2026.4.14";

function resolveOpenclawDist() {
	try {
		const pkg = execSync(
			`node -e "console.log(require.resolve('openclaw/package.json'))"`,
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
		).trim();
		if (pkg) return join(dirname(pkg), "dist");
	} catch {}
	const candidates = [
		"/opt/homebrew/lib/node_modules/openclaw/dist",
		"/usr/local/lib/node_modules/openclaw/dist",
		"/usr/lib/node_modules/openclaw/dist"
	];
	for (const c of candidates) {
		try {
			if (statSync(c).isDirectory()) return c;
		} catch {}
	}
	throw new Error(
		"Could not locate the openclaw install. Install openclaw first, e.g.:\n  npm i -g openclaw"
	);
}

const dist = resolveOpenclawDist();
const pkgPath = join(dirname(dist), "package.json");
let installedVersion = "unknown";
try {
	installedVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "unknown";
} catch {}

console.log(`openclaw dist:      ${dist}`);
console.log(`installed version:  ${installedVersion}`);
console.log(`patch targets:      ${EXPECTED_VERSION}`);
if (installedVersion !== EXPECTED_VERSION) {
	console.warn(
		`\n⚠ version mismatch. This patch was written against ${EXPECTED_VERSION}. ` +
		`The script will still try to apply it and will abort cleanly if the expected ` +
		`strings are not found.\n`
	);
}

const files = readdirSync(dist);
const tuiCli = files.find((f) => /^tui-cli-[^/]+\.js$/.test(f));
const tuiRuntime = files.find(
	(f) => /^tui-[A-Za-z0-9_-]+\.js$/.test(f) && !f.startsWith("tui-cli-")
);
if (!tuiCli) throw new Error("no tui-cli-*.js bundle found in openclaw/dist");
if (!tuiRuntime) throw new Error("no tui-*.js runtime bundle found in openclaw/dist");

const cliPath = join(dist, tuiCli);
const rtPath = join(dist, tuiRuntime);
console.log(`tui cli bundle:     ${tuiCli}`);
console.log(`tui runtime:        ${tuiRuntime}\n`);

const replacements = [
	{
		file: cliPath,
		label: "CLI --deliver default → true (+ --no-deliver)",
		alreadyMarker: `.option("--no-deliver"`,
		old: `.option("--deliver", "Deliver assistant replies", false)`,
		new: `.option("--deliver", "Deliver assistant replies to the TUI (default: on)", true).option("--no-deliver", "Disable delivering assistant replies to the TUI")`
	},
	{
		file: rtPath,
		label: "runtime deliverDefault: const → let, default true",
		alreadyMarker: "let deliverDefault = opts.deliver ?? true;",
		old: "const deliverDefault = opts.deliver ?? false;",
		new: "let deliverDefault = opts.deliver ?? true;"
	},
	{
		file: rtPath,
		label: "state getter/setter for deliverDefault",
		alreadyMarker: "get deliverDefault() {",
		old:
`		get showThinking() {
			return showThinking;
		},
		set showThinking(value) {
			showThinking = value;
		},`,
		new:
`		get showThinking() {
			return showThinking;
		},
		set showThinking(value) {
			showThinking = value;
		},
		get deliverDefault() {
			return deliverDefault;
		},
		set deliverDefault(value) {
			deliverDefault = value;
		},`
	},
	{
		file: rtPath,
		label: "sendMessage reads state + handles deliver=off cleanly",
		alreadyMarker: "const deliverNow = state.deliverDefault;",
		old:
`			await client.sendChat({
				sessionKey: state.currentSessionKey,
				message: text,
				thinking: opts.thinking,
				deliver: deliverDefault,
				timeoutMs: opts.timeoutMs,
				runId
			});
			if (!isBtw) {
				setActivityStatus("waiting");
				tui.requestRender();
			}`,
		new:
`			const deliverNow = state.deliverDefault;
			await client.sendChat({
				sessionKey: state.currentSessionKey,
				message: text,
				thinking: opts.thinking,
				deliver: deliverNow,
				timeoutMs: opts.timeoutMs,
				runId
			});
			if (!isBtw) {
				if (deliverNow) {
					setActivityStatus("waiting");
				} else {
					state.pendingOptimisticUserMessage = false;
					chatLog.addSystem("sent (reply delivery off — enable via settings to see replies here)");
					setActivityStatus("idle");
				}
				tui.requestRender();
			}`
	},
	{
		file: rtPath,
		label: "settings panel: Deliver replies toggle",
		alreadyMarker: `id: "deliver",`,
		old:
`	const openSettings = () => {
		openOverlay(createSettingsList([{
			id: "tools",
			label: "Tool output",
			currentValue: state.toolsExpanded ? "expanded" : "collapsed",
			values: ["collapsed", "expanded"]
		}, {
			id: "thinking",
			label: "Show thinking",
			currentValue: state.showThinking ? "on" : "off",
			values: ["off", "on"]
		}], (id, value) => {
			if (id === "tools") {
				state.toolsExpanded = value === "expanded";
				chatLog.setToolsExpanded(state.toolsExpanded);
			}
			if (id === "thinking") {
				state.showThinking = value === "on";
				loadHistory();
			}
			tui.requestRender();
		}, () => {
			closeOverlay();
			tui.requestRender();
		}));
		tui.requestRender();
	};`,
		new:
`	const openSettings = () => {
		openOverlay(createSettingsList([{
			id: "tools",
			label: "Tool output",
			currentValue: state.toolsExpanded ? "expanded" : "collapsed",
			values: ["collapsed", "expanded"]
		}, {
			id: "thinking",
			label: "Show thinking",
			currentValue: state.showThinking ? "on" : "off",
			values: ["off", "on"]
		}, {
			id: "deliver",
			label: "Deliver replies",
			currentValue: state.deliverDefault ? "on" : "off",
			values: ["off", "on"]
		}], (id, value) => {
			if (id === "tools") {
				state.toolsExpanded = value === "expanded";
				chatLog.setToolsExpanded(state.toolsExpanded);
			}
			if (id === "thinking") {
				state.showThinking = value === "on";
				loadHistory();
			}
			if (id === "deliver") {
				state.deliverDefault = value === "on";
				chatLog.addSystem(\`reply delivery \${state.deliverDefault ? "on" : "off"}\`);
			}
			tui.requestRender();
		}, () => {
			closeOverlay();
			tui.requestRender();
		}));
		tui.requestRender();
	};`
	}
];

const buffers = new Map();
const read = (f) => {
	if (!buffers.has(f)) buffers.set(f, readFileSync(f, "utf8"));
	return buffers.get(f);
};

let applied = 0;
let already = 0;
for (const r of replacements) {
	const src = read(r.file);
	if (src.includes(r.alreadyMarker)) {
		console.log(`  ✓ already patched — ${r.label}`);
		already++;
		continue;
	}
	if (!src.includes(r.old)) {
		console.error(`  ✗ expected text not found — ${r.label}`);
		console.error(
			`    Your installed OpenClaw (${installedVersion}) does not match the ` +
			`${EXPECTED_VERSION} bundle this patch was written for. No files were modified.`
		);
		process.exit(1);
	}
	buffers.set(r.file, src.replace(r.old, r.new));
	applied++;
	console.log(`  → applied      — ${r.label}`);
}

if (applied > 0) {
	for (const [f, src] of buffers) writeFileSync(f, src);
	console.log(`\nPatched ${applied} change(s) (${already} already present).`);
	console.log(`Start a fresh \`openclaw tui --session <key>\` to verify.`);
} else {
	console.log(`\nAll ${already} changes already present. Nothing to do.`);
}
