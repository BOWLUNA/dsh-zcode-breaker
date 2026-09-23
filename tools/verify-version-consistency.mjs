#!/usr/bin/env node
/**
 * The declared compatibility range must contain every harness version we test.
 *
 * The range in `engines.dsh` is a claim users act on: `dsh plugin add` will
 * happily install onto a version outside it, and the failure mode is a schema
 * DSL mismatch that surfaces as a rejected tool definition rather than as a
 * version error. So the range is checked three ways:
 *
 *   1. every version this project has actually been exercised against,
 *   2. every version the CI matrix installs,
 *   3. the version the current run installed, when `--dsh <version>` is passed.
 *
 * The syntax supported is the subset package.json uses: `||`-separated groups of
 * space-separated comparators, e.g.
 * `>=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0`. That is deliberate — a
 * full semver implementation is a dependency this plugin does not need. What is
 * *not* optional is node-semver's prerelease rule, because without it this guard
 * reports the opposite of what an install will do; see `SELFTEST`.
 *
 * Run: node tools/verify-version-consistency.mjs [--dsh <version>]
 *      node tools/verify-version-consistency.mjs --selftest
 * Exit: 0 when consistent; 1 listing each version outside the range.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Harness versions this project has been exercised against by hand — a real
 * boot plus a real turn, not just the suite. Update it when you test a new one.
 *
 * 0.1.5-rc.2 — a real `--profile web` boot in an isolated DSH_HOME, a real agent
 * preset realm composed through `agentPresets.mount()`, and the engine serving
 * `ctx.compaction`.
 *
 * 0.1.6-alpha.2 — added 2026-09-22 after a real boot in this repository's own lab
 * (`C:/Users/BOWLUNA/Desktop/DSHTEST/breaker`): `dsh plugin --profile web add`
 * exit 0, `--dump-config` exit 0 / 571 lines / stderr 0 bytes, and
 * `--port 32100 --no-open` answering at t=1500ms with stderr 0 bytes. This is the
 * line the WSL harness runs, so the declared range has to include it — which is
 * why the range carries one comparator group per line.
 *
 * The declared range is wider than this list on purpose — it is what the
 * package is expected to work on, while this list is what has been proven.
 */
const TESTED = ["0.1.5-rc.2", "0.1.6-alpha.2"];

/**
 * Parse `x.y.z` or `x.y.z-pre`.
 *
 * @param text - the version string.
 * @returns the parts, or `null` when it is not a version.
 */
function parseVersion(text) {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim());
	if (match === null) return null;
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? null };
}

/**
 * Order two parsed versions. A prerelease sorts below its own release, which is
 * the only ordering rule this project's ranges depend on.
 *
 * @param a - first version.
 * @param b - second version.
 * @returns -1, 0 or 1.
 */
function compare(a, b) {
	for (const key of ["major", "minor", "patch"]) {
		if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
	}
	if (a.pre === b.pre) return 0;
	if (a.pre === null) return 1;
	if (b.pre === null) return -1;
	return a.pre < b.pre ? -1 : 1;
}

/**
 * Evaluate one comparator group (no `||`), with node-semver's prerelease rule.
 *
 * @param version - the candidate version.
 * @param group - one space-separated comparator list.
 * @returns whether the version satisfies every comparator **and** the prerelease rule.
 */
function satisfiesGroup(version, group) {
	const parsed = parseVersion(version);
	if (parsed === null) return false;
	let sameTuplePrerelease = false;
	for (const clause of String(group).trim().split(/\s+/)) {
		if (clause.length === 0) continue;
		const match = /^(>=|<=|>|<|=)?(.+)$/.exec(clause);
		if (match === null) continue;
		const bound = parseVersion(match[2]);
		if (bound === null) return false;
		const order = compare(parsed, bound);
		const operator = match[1] ?? "=";
		if (operator === ">=" && order < 0) return false;
		if (operator === "<=" && order > 0) return false;
		if (operator === ">" && order <= 0) return false;
		if (operator === "<" && order >= 0) return false;
		if (operator === "=" && order !== 0) return false;
		if (bound.pre !== null && bound.major === parsed.major && bound.minor === parsed.minor && bound.patch === parsed.patch) {
			sameTuplePrerelease = true;
		}
	}
	// node-semver: a prerelease is only allowed when some comparator carries a
	// prerelease *and* shares the candidate's major.minor.patch tuple. Skipping
	// this makes the guard report the opposite of what an install will do.
	if (parsed.pre !== null && !sameTuplePrerelease) return false;
	return true;
}

/**
 * Evaluate a range: `||`-separated groups, satisfied when any group matches.
 *
 * @param version - the candidate version.
 * @param range - the declared range, e.g. `>=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0`.
 * @returns whether the version satisfies the range.
 */
function satisfies(version, range) {
	return String(range)
		.split("||")
		.some((group) => satisfiesGroup(version, group));
}

/**
 * The semantics above, pinned against real `semver` output.
 *
 * Measured with semver 7.8.5 against the declared range — this table is why the
 * guard is allowed to claim anything about a prerelease at all. Both the old
 * naive comparator and this one accept `0.1.5-rc.2`; they disagree on
 * `0.1.6-alpha.2`, and the naive one was the wrong answer:
 *
 *   >=0.1.5-rc.2 <0.2.0-0                        0.1.6-alpha.2 → false
 *   >=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 …   0.1.6-alpha.2 → true
 *
 * Run with `--selftest`; CI runs it as part of this guard so a refactor of the
 * comparator cannot quietly reintroduce the false green.
 */
const SELFTEST = [
	["0.1.5-rc.2", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0", true],
	["0.1.5", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0", true],
	["0.1.6-alpha.1", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0", true],
	["0.1.6-alpha.2", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0", true],
	["0.1.6", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0", true],
	["0.1.7", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0", true],
	["0.2.0-alpha.1", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0", false],
	["0.2.0", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0", false],
	["0.3.0", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0", false],
	// The prerelease rule on its own, with a single group: the naive comparator
	// accepted this one, which is the false green that motivated the fix.
	["0.1.6-alpha.2", ">=0.1.5-rc.2 <0.2.0-0", false],
	["0.1.5-rc.2", ">=0.1.5-rc.2 <0.2.0-0", true],
	// The range this package now declares. 0.1.7 is excluded on purpose, and the
	// two lines below are what make that exclusion visible if someone widens it
	// back without re-measuring.
	["0.1.5-rc.3", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.1.7-0", true],
	["0.1.6-alpha.2", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.1.7-0", true],
	["0.1.7-alpha.1", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.1.7-0", false],
	["0.1.7-alpha.2", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.1.7-0", false],
	["0.1.7", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.1.7-0", false],
];

if (process.argv.includes("--selftest")) {
	const wrong = SELFTEST.filter(([version, range, expected]) => satisfies(version, range) !== expected);
	for (const [version, , expected] of wrong) {
		console.error(`✗ selftest: ${version} should be ${String(expected)}`);
	}
	if (wrong.length > 0) {
		console.error(`version consistency selftest: ${String(wrong.length)} of ${String(SELFTEST.length)} cases wrong`);
		process.exit(1);
	}
	console.log(`✓ version consistency selftest: ${String(SELFTEST.length)} cases match semver 7.8.5`);
	process.exit(0);
}

/**
 * Harness versions that exist on npm, have been measured, and are **not**
 * supported — with the measurement that says so. The declared range must exclude
 * every one of them.
 *
 * This is the guard that catches a range that is too *wide*, which the comparator
 * self-test cannot: the self-test proves the comparator agrees with semver, and
 * says nothing about whether the declared range is honest. Measured 2026-09-23 on
 * a real 0.1.7-alpha.2 instance (`C:/Users/BOWLUNA/Desktop/DSHTEST/breaker/dsh017`):
 *
 *   · the host plane works — `dsh plugin add` exit 0, `--dump-config` exit 0 /
 *     1237 lines / stderr 0 bytes, `--port 32101` answering at t=2000ms with 0
 *     bytes on stderr, and a probe read `ctx.get("compaction")` as
 *     `BreakerCompactionEngine` with `compactIfNeeded` a function;
 *   · the **preset plane does not** — 0.1.7 replaced directory scanning with a
 *     declarative registry, so a preset placed in `<DSH_HOME>/.agent-presets/` is
 *     no longer discovered (`list()` returned `[]` with `breaker-trip` seeded).
 *
 * The README documents both planes, so "supports 0.1.7" would be a half-truth, and
 * a half-truth in a compatibility range is the thing this guard exists to stop.
 */
const UNSUPPORTED = [
	{
		version: "0.1.7-alpha.1",
		reason: "preset plane: the registry replaces directory scanning, so the documented .agent-presets setup is not discovered",
	},
	{
		version: "0.1.7-alpha.2",
		reason: "measured 2026-09-23: host plane serves this engine, preset plane does not (list() = [] with a preset seeded)",
	},
	{
		// The prerelease gate already excludes 0.1.7-alpha.x, so a range written as
		// `... <0.2.0-0` looks safe while still accepting the *release* 0.1.7 — and
		// the preset plane is broken there for the same structural reason. That gap
		// is what this entry exists to close; it is the one that made the declared
		// range in this repository too wide on 2026-09-23.
		version: "0.1.7",
		reason: "same preset-plane break as 0.1.7-alpha.2, which is structural (registry replaces directory scanning), not an alpha-only defect",
	},
];

const manifest = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const range = manifest.engines?.dsh;
if (range === undefined) {
	console.error("✗ package.json declares no engines.dsh — nothing to check the matrix against");
	process.exit(1);
}

const failures = [];

// Is the declared range too wide? Every known-unsupported version must be outside it.
for (const { version, reason } of UNSUPPORTED) {
	if (satisfies(version, range)) {
		failures.push(`declared range ${range} claims to support ${version}, but it is known unsupported: ${reason}`);
	}
}

// The comparator's own semantics next: a wrong comparator would make every
// conclusion below meaningless, and would do it silently.
for (const [version, sampleRange, expected] of SELFTEST) {
	if (satisfies(version, sampleRange) !== expected) {
		failures.push(`selftest: ${version} against ${sampleRange} should be ${String(expected)}`);
	}
}

for (const version of TESTED) {
	if (!satisfies(version, range)) {
		failures.push(`${version} is in the hand-tested list but the declared range is ${range}`);
	}
}

const ciPath = join(REPO, ".github", "workflows", "test.yml");
if (!existsSync(ciPath)) {
	failures.push(".github/workflows/test.yml is missing — the matrix that justifies the range cannot be read");
} else {
	const ci = readFileSync(ciPath, "utf8");
	const matrixVersions = new Set([...ci.matchAll(/dsh:\s*'([^']+)'/g)].map((match) => match[1]));
	if (matrixVersions.size === 0) failures.push("the CI matrix declares no dsh versions");
	for (const version of matrixVersions) {
		if (!satisfies(version, range)) failures.push(`${version} is exercised by CI but the declared range is ${range}`);
	}
}

const flagIndex = process.argv.indexOf("--dsh");
const explicit = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
if (explicit !== undefined && explicit !== "" && !satisfies(explicit, range)) {
	failures.push(`this run installed dsh ${explicit}, which ${range} does not cover`);
}

if (failures.length > 0) {
	console.error("");
	for (const failure of failures) console.error(`✗ ${failure}`);
	console.error("");
	console.error(`version consistency: ${String(failures.length)} problem(s).`);
	console.error("Widen engines.dsh, or drop the version from the matrix and the tested list.");
	process.exit(1);
}

console.log(`✓ version consistency: declared ${range} covers every tested and matrix version${explicit === undefined ? "" : ` (this run: ${explicit})`}`);
