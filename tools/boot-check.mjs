#!/usr/bin/env node
/**
 * Boot the plugin in a throwaway `DSH_HOME` and require that it really installs
 * and really starts.
 *
 * Why this exists: every other check in this repository reads files. The suite
 * imports the engine, `--dump-config` synthesises configuration, the pairing and
 * doc guards compare text — and none of them *applies* a profile bundle patch.
 * A row that names a package which cannot be resolved therefore passes all of
 * them and fails only when somebody installs the plugin and restarts the
 * harness. That is the exact shape of the defect this repository nearly shipped:
 * a rename updated `package.json` and the repository name but left the old name
 * in `cordis.patch.yml`, and `--dump-config` still exited 0 with empty stderr —
 * it synthesises rows without applying them, so it never resolves the row's
 * package and never notices.
 *
 * Only a real boot resolves the row. So this script performs one.
 *
 * ── The four assertions ──────────────────────────────────────────────────────
 *
 *   A  `dsh plugin --profile web add <repo>` exits 0.
 *   B  the `name` written in `cordis.patch.yml` equals `package.json`'s `name`,
 *      read straight out of the files. NOT via `--dump-config`: that command has
 *      *zero* signal about whether a row resolves — with the row name broken it
 *      still exits 0, still writes nothing to stderr, and still lists the row.
 *   C  the port answers, and keeps answering. `--profile web --port <n> --no-open`
 *      is started; `net.connect(n)` must succeed before the timeout, and the port
 *      must still answer after `--settle` milliseconds with the process alive.
 *      Two halves, both measured:
 *        · not "stdout printed a listening URL" — `0.1.5-rc.2` starts fine and
 *          prints zero bytes to stdout, so that assertion is version-dependent
 *          and reddens on a perfectly good plugin;
 *        · not a single successful connect either — one measured run answered at
 *          900 ms, stopped at 1100 ms, and the process was gone by 1200 ms with
 *          7 KB on stderr. "Process still alive at the instant it answers" does
 *          not save you: at 900 ms it really was alive.
 *      A listener that is not our child is also refused: the port must be free
 *      before the child starts, otherwise C passes on somebody else's socket.
 *   D  stderr stays empty from the moment the port answers through the settle
 *      window.
 *
 * ── Exit codes ───────────────────────────────────────────────────────────────
 *
 *   0  all four passed
 *   1  an assertion failed; the failing letter is named
 *   2  the environment is missing something (pnpm, a harness to boot, or a busy
 *      port) — nothing to do with this plugin. Kept separate so that a red run
 *      says which of the two it is; conflating them is how a guard starts being
 *      ignored.
 *
 * ── Where the harness comes from (fixed order, no dead paths) ────────────────
 *
 *   1. `--dsh-bin <path to @deepseek-ai/dsh/lib/bin.js>`
 *   2. `$DSH_INSTALL`            the harness install root
 *   3. `<repo>/node_modules/@deepseek-ai/dsh`   what CI installs
 *   4. `dsh` on PATH             a machine-level install (Linux/WSL only)
 *   5. otherwise exit 2 with the exports to copy
 *
 * `dsh` is deliberately never assumed to be on PATH: on Windows it is not, and
 * assuming it makes every CI leg fail with `plugin add exited 127`, which reads
 * like a plugin fault.
 *
 * Run: node tools/boot-check.mjs --port 31901
 *      node tools/boot-check.mjs --port 31901 --keep     # leave the sandbox
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));

function flag(name, fallback) {
	const at = process.argv.indexOf(`--${name}`);
	return at === -1 ? fallback : process.argv[at + 1];
}

const PORT = Number(flag("port", "31901"));
const TIMEOUT_S = Number(flag("timeout", "40"));
const SETTLE_MS = Number(flag("settle", "2000"));
const KEEP = process.argv.includes("--keep");

const exitEnvironment = (message) => {
	console.error(`✗ environment: ${message}`);
	console.error("");
	console.error("  The four exports that point at a harness on this machine:");
	console.error('    export DSH_HOME="C:/BL/AI/dsh-harness/harness"');
	console.error('    export DSH_INSTALL="C:/BL/AI/dsh-harness"');
	console.error('    N="C:/BL/AI/dsh-harness/node_modules/node/bin/node.exe"');
	console.error('    D="C:/BL/AI/dsh-harness/node_modules/@deepseek-ai/dsh/lib/bin.js"');
	console.error("    \"$N\" \"$D\" --version        # expect the version this repo declares");
	console.error("    node tools/boot-check.mjs --port 31901 --dsh-bin \"$D\"");
	console.error("");
	console.error("  On Linux/WSL, `export PATH=\"$HOME/.local/bin:$PATH\"` first — dsh lives there.");
	process.exit(2);
};

/**
 * Resolve how to invoke the CLI, in the fixed order above.
 *
 * @returns `{ argv, source }` where `argv` is ready for `spawn`.
 */
function resolveHarness() {
	const explicit = flag("dsh-bin");
	if (explicit !== undefined) {
		const bin = resolve(explicit);
		if (!existsSync(bin)) exitEnvironment(`--dsh-bin ${explicit} does not exist`);
		return { argv: [process.execPath, bin], source: `--dsh-bin (${bin})` };
	}

	const install = process.env.DSH_INSTALL;
	if (install !== undefined && install.length > 0) {
		const bin = join(install, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
		if (existsSync(bin)) return { argv: [process.execPath, bin], source: `$DSH_INSTALL (${bin})` };
	}

	const inRepo = join(REPO, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
	if (existsSync(inRepo)) return { argv: [process.execPath, inRepo], source: `repo install (${inRepo})` };

	// Last resort: a machine-level install. Not shelled, so a `.cmd` shim on
	// Windows simply will not resolve here — that is fine, Windows never has dsh
	// on PATH, and the hint above says what to use instead.
	const probe = spawnSync("dsh", ["--version"], { encoding: "utf8" });
	if (probe.status === 0) return { argv: ["dsh"], source: `PATH (dsh ${probe.stdout.trim()})` };

	return undefined;
}

const harness = resolveHarness();
if (harness === undefined) {
	exitEnvironment("no dsh CLI found — looked at --dsh-bin, $DSH_INSTALL, <repo>/node_modules, and PATH");
}

// `dsh plugin` is a thin pnpm forwarder: it runs `pnpm` with cwd set to the
// profile. Without pnpm it fails with a message that reads like a plugin
// problem, so it is checked for up front and reported as its own cause.
//
// The command is passed as one string rather than as an argv array on purpose:
// `shell: true` together with an array is what Node deprecates (DEP0190), and a
// deprecation banner printed by a guard is noise in the step's output — the kind
// of noise that teaches people to skim guard output.
const pnpmProbe = spawnSync("pnpm --version", { encoding: "utf8", shell: true });
if (pnpmProbe.status !== 0) {
	exitEnvironment("pnpm is not on PATH, and `dsh plugin` forwards to it (install: `npm install -g pnpm@12`)");
}

/**
 * A throwaway home, asserted to be one.
 *
 * This has gone wrong for real: a window forgot the `DSH_HOME` prefix and wrote
 * into the developer's **real `~/.dsh/profiles/web`**. So the value is checked
 * once here, and the same value is passed explicitly to every child below —
 * nothing inherits an ambient `DSH_HOME`.
 */
function makeThrowawayHome() {
	const home = mkdtempSync(join(tmpdir(), "dsh-boot-check-"));
	const real = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
	const looksLikeReal = (candidate) => candidate.length > 0 && same(resolve(candidate), resolve(join(real, ".dsh")));

	const insideTemp = resolve(home).startsWith(resolve(tmpdir()) + sep);
	if (!insideTemp || looksLikeReal(home) || looksLikeReal(process.env.DSH_HOME ?? "")) {
		console.error(`✗ refusing to run: DSH_HOME "${home}" is not a throwaway directory`);
		console.error(`  tmpdir=${tmpdir()}  HOME=${real}  ambient DSH_HOME=${process.env.DSH_HOME ?? "(unset)"}`);
		process.exit(2);
	}
	return home;
}

/**
 * The profile skeleton is the only thing written by hand.
 *
 * Everything else under `profiles/` is maintained by the harness itself:
 * `healProfilesModuleFallback` mirrors the dsh installation's dependency closure
 * into `$DSH_HOME/profiles/node_modules` on every launch. Pre-creating that
 * directory — even as a symlink to a perfectly good harness install — makes the
 * boot fail, because the harness expects to own the entries inside it and
 * refuses to adopt a real directory.
 */
function writeProfileSkeleton(dir) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		`${JSON.stringify(
			{
				name: "dsh-profile-web",
				private: true,
				dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], patchReload: "live" } },
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(join(dir, "cordis.patch.yml"), "[]\n");
}

/**
 * Every `name:` scalar in the bundle patch, unquoted.
 *
 * Both quoting styles are accepted on purpose — a reader that understands only
 * `name: 'x'` is the same defect as a counter that understands only one reporter
 * spelling. Nested `name:` keys inside `config:` blocks would also be collected;
 * that is deliberate, because a package name appearing in a config value is
 * just as unresolvable as one in a row header, and the assertion below only asks
 * whether the package's own name is present.
 */
function readRowNames(text) {
	const names = [];
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*-?\s*name:\s*(.+?)\s*(?:#.*)?$/.exec(line);
		if (match === null) continue;
		names.push(match[1].replace(/^(['"])(.*)\1$/, "$2"));
	}
	return names;
}

const dshHome = makeThrowawayHome();
writeProfileSkeleton(join(dshHome, "profiles", "web"));

const run = (args) =>
	spawnSync(harness.argv[0], [...harness.argv.slice(1), ...args], {
		cwd: REPO,
		env: { ...process.env, DSH_HOME: dshHome },
		encoding: "utf8",
		timeout: 240_000,
	});

const failures = [];
const record = (label, value) => console.log(`  ${label}: ${value}`);
const assert = (letter, ok, detail) => {
	console.log(`  ${ok ? "✓" : "✗"} assertion ${letter} — ${detail}`);
	if (!ok) failures.push(`${letter}: ${detail}`);
};

console.log(`harness   : ${harness.source}`);
console.log(`pnpm      : ${pnpmProbe.stdout.trim()}`);
console.log(`DSH_HOME  : ${dshHome}  (throwaway, asserted)`);
console.log(`port      : ${String(PORT)}`);
console.log("");

// ── A ────────────────────────────────────────────────────────────────────────
const installed = run(["plugin", "--profile", "web", "add", REPO]);
record("A install exit", String(installed.status));
assert("A", installed.status === 0, `dsh plugin --profile web add <repo> exited ${String(installed.status)}`);
if (installed.status !== 0) {
	console.error((installed.stdout ?? "") + (installed.stderr ?? ""));
}

// ── B ────────────────────────────────────────────────────────────────────────
const patchNames = readRowNames(readFileSync(join(REPO, "cordis.patch.yml"), "utf8"));
record("B row names in cordis.patch.yml", JSON.stringify(patchNames));
record("B package.json name", PKG.name);
assert(
	"B",
	patchNames.includes(PKG.name),
	patchNames.includes(PKG.name)
		? `a row names "${PKG.name}", same as package.json`
		: `no row in cordis.patch.yml names "${PKG.name}" — installs cleanly, then cannot be imported`,
);

// ── C ────────────────────────────────────────────────────────────────────────
// The port must be free *before* the child starts.
//
// Without this the assertion can be satisfied by a listener that is not our
// child — and that is not hypothetical: a batch run of five mutants reported
// "C port answered: true, D stderr bytes: 0" for two mutations whose own boot
// fails hard, because the previous case's instance was still serving during the
// teardown window and the first poll connected to it instantly. A guard that
// passes against somebody else's port is worse than no guard.
const portAnswers = (port) =>
	new Promise((done) => {
		const socket = connect({ port, host: "127.0.0.1" });
		socket.once("connect", () => {
			socket.destroy();
			done(true);
		});
		socket.once("error", () => {
			socket.destroy();
			done(false);
		});
	});

if (await portAnswers(PORT)) {
	exitEnvironment(
		`port ${String(PORT)} already has a listener. Refusing to run: assertion C would pass on that socket instead of on this plugin. ` +
			`Find the owner (\`ss -ltnp | grep :${String(PORT)}\` on Linux, \`netstat -ano | findstr :${String(PORT)}\` on Windows) and stop it, or pass another --port.`,
	);
}

const child = spawn(harness.argv[0], [...harness.argv.slice(1), "--profile", "web", "--port", String(PORT), "--no-open"], {
	cwd: REPO,
	env: { ...process.env, DSH_HOME: dshHome },
	stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
let exited;
child.stdout.on("data", (chunk) => {
	stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
	stderr += chunk.toString();
});
child.on("exit", (code) => {
	exited = code;
});

const answers = async (deadline) => {
	while (Date.now() < deadline) {
		if (exited !== undefined) return false;
		if (await portAnswers(PORT)) return true;
		await new Promise((wait) => setTimeout(wait, 500));
	}
	return false;
};

const deadline = Date.now() + TIMEOUT_S * 1000;
const listening = await answers(deadline);
const stderrAtAnswer = Buffer.byteLength(stderr);

// "Answers" is not enough — it has to keep answering, with the process alive.
// A single successful connect can sample a transient window: one measured run
// answered at 900 ms, stopped at 1100 ms, and was gone by 1200 ms with 7 KB on
// stderr. Checking "the process is still alive at the instant it answers" does
// not help either, because at 900 ms it really was alive.
let settled = listening;
if (listening) {
	const until = Date.now() + SETTLE_MS;
	while (Date.now() < until) {
		await new Promise((wait) => setTimeout(wait, 250));
		if (exited !== undefined || !(await portAnswers(PORT))) {
			settled = false;
			break;
		}
	}
}
const stderrAfterSettle = Buffer.byteLength(stderr);

record("C first answer", String(listening));
record("C still answering after settle", `${String(settled)} (--settle ${String(SETTLE_MS)}ms)`);
record("C process exit", exited === undefined ? "still running" : String(exited));
record("D stderr bytes at the answer", String(stderrAtAnswer));
record("D stderr bytes after settle", String(stderrAfterSettle));
if (settled === false && stdout.length + stderr.length > 0) {
	console.error("--- stdout ---\n" + stdout);
	console.error("--- stderr ---\n" + stderr);
}
assert(
	"C",
	listening && settled,
	listening && settled
		? `${String(PORT)} accepted a connection and still answered ${String(SETTLE_MS)}ms later`
		: listening
			? `${String(PORT)} answered once and then stopped${exited === undefined ? "" : ` (process exited ${String(exited)})`} — a broken plugin can sample that window`
			: `nothing answered on ${String(PORT)} within ${String(TIMEOUT_S)}s${exited === undefined ? "" : ` (process exited ${String(exited)})`} — the plugin did not start`,
);
assert("D", stderrAfterSettle === 0, `${String(stderrAfterSettle)} bytes on stderr (${String(stderrAtAnswer)} at the first answer)`);

// ── teardown: SIGTERM, not SIGKILL ───────────────────────────────────────────
// SIGKILL breaks the stdout of MCP children the harness spawned, and they answer
// by writing tracebacks to stderr — which is the same stream assertion D reads.
if (exited === undefined) {
	child.kill("SIGTERM");
	await new Promise((wait) => setTimeout(wait, 1500));
}

// Leaving a listener behind is how the *next* run gets a false green, so the
// port is checked and reported. It is deliberately a warning, not a failure: the
// plugin booted, and a leftover process is this script's problem, not the
// plugin's — but it must not be silent.
const released = (async () => {
	const until = Date.now() + 8000;
	while (Date.now() < until) {
		if (!(await portAnswers(PORT))) return true;
		await new Promise((wait) => setTimeout(wait, 500));
	}
	return false;
})();
if (!(await released)) {
	console.warn(`\n⚠ port ${String(PORT)} still has a listener after teardown.`);
	console.warn("  The next run refuses to start until it is free — that check is what keeps");
	console.warn("  assertion C from passing on somebody else's socket.");
}

if (KEEP) {
	console.log(`\nsandbox kept at ${dshHome}`);
} else {
	// A cleanup failure must never turn a passing check into a failing one.
	// Windows keeps handles open on freshly exited processes, antivirus scans the
	// tree, and some sandboxes refuse bulk deletes — none of that says anything
	// about the plugin, and a red run with an unrelated cause is the kind of
	// trailing red that teaches people to ignore red.
	try {
		rmSync(dshHome, { recursive: true, force: true });
	} catch (error) {
		console.warn(`\n· could not remove the sandbox at ${dshHome} — harmless, delete it by hand.`);
		console.warn(`  ${error instanceof Error ? error.message : String(error)}`);
	}
}

console.log("");
if (failures.length > 0) {
	console.error(`✗ boot check failed — ${String(failures.length)} assertion(s):`);
	for (const failure of failures) console.error(`    ${failure}`);
	process.exit(1);
}
console.log("✓ boot check passed — A install · B row name · C port answers · D clean stderr");
