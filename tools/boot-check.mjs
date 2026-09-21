#!/usr/bin/env node
/**
 * Boot the plugin in a throwaway `DSH_HOME` and require that it actually starts.
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
 * What it asserts, in order:
 *   1. `dsh plugin --profile web add <repo>` exits 0.
 *   2. `--dump-config` exits 0, writes nothing to stderr, and its composed tree
 *      contains this plugin's row id.
 *   3. `--port <n> --no-open` prints a listening URL, writes nothing to stderr,
 *      and is still running when the timeout expires.
 *
 * Everything runs against a temporary `DSH_HOME`; the harness install is never
 * written to, and `profiles/node_modules` is left entirely to the harness.
 *
 * Run: node tools/boot-check.mjs
 *      node tools/boot-check.mjs --port 31901 --timeout 30
 *      node tools/boot-check.mjs --keep            # leave the sandbox behind
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(REPO, "package.json"), "utf8")));

/** The row this plugin inserts, and the row it disables. */
const ROW_ID = PKG.name === "dsh-zcode-breaker" ? "compaction-breaker" : PKG.name;
const HOST_ROW_ID = "compaction-basic";

function flag(name, fallback) {
	const at = process.argv.indexOf(`--${name}`);
	return at === -1 ? fallback : process.argv[at + 1];
}

const PORT = Number(flag("port", "31901"));
const TIMEOUT_S = Number(flag("timeout", "30"));
const KEEP = process.argv.includes("--keep");
const DSH_VERSION = flag("dsh-version", undefined);

/** Locate the CLI entry, in the order the two environments provide it. */
function resolveDshBin() {
	const explicit = flag("dsh-bin", process.env.DSH_BIN);
	if (explicit !== undefined) return resolve(explicit);
	const inRepo = join(REPO, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
	if (existsSync(inRepo)) return inRepo;
	for (const root of [
		process.env.DSH_INSTALL,
		process.platform === "win32" ? "C:/BL/AI/DSH Desktop/resources/app" : undefined,
	].filter((value) => typeof value === "string" && value.length > 0)) {
		const candidate = join(root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/**
 * The profile skeleton is the only thing written by hand.
 *
 * Everything else under `profiles/` is maintained by the harness itself:
 * `healProfilesModuleFallback` mirrors the dsh installation's dependency closure
 * into `$DSH_HOME/profiles/node_modules` on every launch. Pre-creating that
 * directory — even as a symlink to a perfectly good harness install — makes the
 * boot fail, because the harness expects to own the entries inside it and
 * refuses to adopt a real directory:
 *
 *   dsh: <dir> exists and is not a symlink or dsh-managed module proxy;
 *        remove it so dsh can manage the installation fallback
 *
 * So this script supplies the profile and lets the harness do the rest.
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

const fail = (message) => {
	console.error(`✗ ${message}`);
	process.exit(1);
};

const bin = resolveDshBin();
if (bin === undefined) {
	fail(
		"no dsh CLI found. In CI run `npm install --no-save @deepseek-ai/dsh`, " +
			"or pass --dsh-bin <path to @deepseek-ai/dsh/lib/bin.js> (or set DSH_BIN).",
	);
}

// `dsh plugin` is a thin pnpm forwarder: it runs `pnpm` with cwd set to the
// profile. Without pnpm it fails with a message that reads like a plugin
// problem, so it is checked for up front and reported as its own cause.
const pnpmProbe = spawnSync("pnpm", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
if (pnpmProbe.status !== 0) {
	fail(
		"pnpm is not on PATH. `dsh plugin` forwards to pnpm, so the install step cannot run. " +
			"Install it (for example `npm install -g pnpm`) before running this check.",
	);
}

const dshHome = mkdtempSync(join(tmpdir(), "dsh-boot-check-"));
writeProfileSkeleton(join(dshHome, "profiles", "web"));

const run = (args, options = {}) =>
	spawnSync(process.execPath, [bin, ...args], {
		cwd: REPO,
		env: { ...process.env, DSH_HOME: dshHome },
		encoding: "utf8",
		timeout: 240_000,
		...options,
	});

const report = [];
const record = (label, value) => {
	report.push(`${label}: ${value}`);
	console.log(`  ${label}: ${value}`);
};

console.log(`dsh bin        : ${bin}`);
console.log(`DSH_HOME       : ${dshHome}`);
console.log(`dsh version    : ${DSH_VERSION ?? "(whatever the installed CLI is)"}`);
console.log(`pnpm           : ${pnpmProbe.stdout.trim()}`);
console.log("");

let failed = false;

// ── 1. install ───────────────────────────────────────────────────────────────
process.stdout.write("1) dsh plugin --profile web add <repo>\n");
const installed = run(["plugin", "--profile", "web", "add", REPO]);
record("install exit", String(installed.status));
if (installed.status !== 0) {
	console.error(installed.stdout ?? "");
	console.error(installed.stderr ?? "");
	failed = true;
}

// ── 2. the row must be resolvable in the composed tree ───────────────────────
process.stdout.write("2) --dump-config\n");
const dumped = run(["--profile", "web", "--dump-config"]);
const dumpOut = dumped.stdout ?? "";
const dumpErr = dumped.stderr ?? "";
record("dump exit", String(dumped.status));
record("dump stderr bytes", String(Buffer.byteLength(dumpErr)));
record(`dump mentions '${ROW_ID}'`, String(dumpOut.includes(ROW_ID)));
if (dumped.status !== 0 || dumpErr.length > 0 || !dumpOut.includes(ROW_ID)) {
	if (dumpErr.length > 0) console.error(dumpErr);
	failed = true;
}

// ── 3. boot ──────────────────────────────────────────────────────────────────
process.stdout.write(`3) --port ${String(PORT)} --no-open\n`);
const child = spawn(process.execPath, [bin, "--profile", "web", "--port", String(PORT), "--no-open"], {
	cwd: REPO,
	env: { ...process.env, DSH_HOME: dshHome },
	stdio: ["ignore", "pipe", "pipe"],
});

let bootOut = "";
let bootErr = "";
let sawUrl = false;
let exited = undefined;

const urlSeen = new Promise((resolveUrl) => {
	child.stdout.on("data", (chunk) => {
		bootOut += chunk.toString();
		if (!sawUrl && bootOut.includes("http://")) {
			sawUrl = true;
			resolveUrl("url");
		}
	});
	child.stderr.on("data", (chunk) => {
		bootErr += chunk.toString();
	});
	child.on("exit", (code) => {
		exited = code;
		resolveUrl("exit");
	});
});

const outcome = await Promise.race([
	urlSeen,
	new Promise((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), TIMEOUT_S * 1000)),
]);

// Still running is the healthy outcome: `--no-open` serves until it is killed.
if (!sawUrl && outcome !== "url") {
	await new Promise((resolveWait) => setTimeout(resolveWait, 3000));
}

record("boot exit", exited === undefined ? "still running" : String(exited));
record("boot stderr bytes", String(Buffer.byteLength(bootErr)));
record("boot printed a URL", String(sawUrl));

if (!sawUrl || bootErr.length > 0 || exited !== undefined) {
	if (bootErr.length > 0) console.error(`--- stderr ---\n${bootErr}`);
	if (bootOut.length > 0) console.error(`--- stdout ---\n${bootOut}`);
	failed = true;
}

// ── teardown ─────────────────────────────────────────────────────────────────
if (exited === undefined) {
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
	} else {
		child.kill("SIGTERM");
	}
	// Give the killed process a moment to release its handles; on Windows the
	// sandbox directory cannot be removed while they are still open.
	await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
}

if (KEEP) {
	console.log(`\nsandbox kept at ${dshHome}`);
} else {
	// A cleanup failure must never turn a passing check into a failing one.
	// Windows keeps handles open on freshly exited processes, antivirus scans
	// the tree, and some CI sandboxes refuse bulk deletes outright — none of
	// that says anything about the plugin. Deleting thousands of files is also
	// exactly where a "delete a lot of files" policy can trip, which would
	// produce a red run whose cause has nothing to do with this repository: the
	// same class of trailing red that `release.yml` already had to remove once.
	try {
		rmSync(dshHome, { recursive: true, force: true });
	} catch (error) {
		console.warn(`\n· could not remove the sandbox at ${dshHome} — harmless, but delete it by hand.`);
		console.warn(`  ${error instanceof Error ? error.message : String(error)}`);
	}
}

console.log("");
if (failed) {
	console.error("✗ boot check failed — see the values above.");
	process.exit(1);
}
console.log(`✓ boot check passed: installed, composed, and serving on port ${String(PORT)}.`);
console.log(report.join("\n"));
