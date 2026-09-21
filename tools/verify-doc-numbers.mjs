#!/usr/bin/env node
/**
 * The numbers and names in the documentation must match what the code produces.
 *
 * Why this exists: no other guard can see a stale count. A README that says
 * "19 cases" while the suite runs 21 is a claim like any other, and this
 * repository's rule is that claims are checked rather than remembered. The
 * second half matters more than the first: a configuration key that ships but
 * never reaches the documentation is invisible to every test, because the code
 * works either way.
 *
 * It reads the real values by *doing the thing* — running the suite through its
 * single entry point, and reading the declared configuration keys out of the
 * engine — never by scanning documentation against itself.
 *
 * Run: node tools/verify-doc-numbers.mjs   (CI runs it after the suite)
 * Exit: 0 when every claim matches; 1 with file:line and both values otherwise.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const problems = [];

/**
 * Run the suite and read the real totals.
 *
 * The counts come from the runner rather than from counting `test(` calls,
 * because a loop-generated or nested case would be invisible to a source scan.
 *
 * @returns the suite and case counts the runner reported.
 */
function measureSuite() {
	// Through the single entry point, not `node --test` directly: a suite added
	// to test/ but not picked up there would otherwise be counted by neither the
	// runner nor this guard.
	const output = execFileSync(process.execPath, [join(REPO, "test", "run.mjs")], {
		cwd: REPO,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 900_000,
	});
	const suites = /^suites: (\d+)$/m.exec(output);
	const tests = /^# tests (\d+)$/m.exec(output);
	if (suites === null || tests === null) {
		console.error("✗ could not read `suites: N` / `# tests N` from the test runner output");
		process.exit(2);
	}
	return { suites: Number(suites[1]), tests: Number(tests[1]) };
}

/**
 * Read the configuration keys the engine actually declares.
 *
 * Scanned out of the `static Config` literal because `schemastery` exposes no
 * documented key enumeration, and because the claim being checked is precisely
 * "the keys written here are the keys documented". A rename that skips the
 * documentation fails on the name below, not silently.
 *
 * @returns the declared key names, in source order.
 */
function measureConfigKeys() {
	const source = readFileSync(join(REPO, "index.js"), "utf8");
	const block = /static Config = z\.object\(\{([\s\S]*?)\n {2}\}\);/m.exec(source);
	if (block === null) {
		console.error("✗ the `static Config = z.object({…})` literal was not found in index.js — did it get reformatted?");
		process.exit(2);
	}
	const keys = [...block[1].matchAll(/^ {4}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]);
	if (keys.length === 0) {
		console.error("✗ parsed the Config literal but found no keys — the indentation or shape changed");
		process.exit(2);
	}
	return keys;
}

/**
 * Compare every count claim on every line of one file.
 *
 * @param rel - repository-relative path.
 * @param rules - `[pattern, key, label]` triples; the pattern captures the number.
 * @param actual - the measured values.
 */
function checkCounts(rel, rules, actual) {
	const lines = readFileSync(join(REPO, rel), "utf8").split("\n");
	lines.forEach((line, index) => {
		for (const [pattern, key, label] of rules) {
			const match = pattern.exec(line);
			if (match === null) continue;
			const documented = Number(match[1]);
			if (documented !== actual[key]) {
				problems.push(
					`${rel}:${String(index + 1)} says ${label} is ${match[1]}, but it is ${String(actual[key])}\n    ${line.trim()}`,
				);
			}
		}
	});
}

const suite = measureSuite();
const configKeys = measureConfigKeys();
const actual = { tests: suite.tests, suites: suite.suites, configKeys: configKeys.length };
console.log(
	`actual: ${String(actual.tests)} tests in ${String(actual.suites)} suites, ${String(actual.configKeys)} config keys`,
);

// Each rule is `[pattern, measured key, label].` Both languages are covered so a
// translated document cannot drift on its own.
const TEST_RULES = [
	[/(\d+) tests?\b/, "tests", "the test count"],
	[/(\d+) cases?\b/, "tests", "the test count"],
	[/(\d+) 个测试/, "tests", "测试数"],
	[/(\d+) 个用例/, "tests", "测试数"],
];
const SUITE_RULES = [
	[/(\d+) suites?\b/, "suites", "the suite count"],
	[/(\d+) 个测试套件/, "suites", "套件数"],
];
const CONFIG_KEY_RULES = [
	[/(\d+) config(?:uration)? keys\b/, "configKeys", "the configuration-key count"],
	[/(\d+) 个配置项/, "configKeys", "配置项数"],
];

for (const rel of ["README.md", "README.zh.md", "AGENTS.md", "CHANGELOG.md", "CHANGELOG.zh.md"]) {
	checkCounts(rel, [...TEST_RULES, ...SUITE_RULES, ...CONFIG_KEY_RULES], actual);
}

// Every declared configuration key must be named in both READMEs. A count alone
// cannot see "one key was swapped for another".
for (const rel of ["README.md", "README.zh.md"]) {
	const text = readFileSync(join(REPO, rel), "utf8");
	for (const key of configKeys) {
		if (!text.includes(`\`${key}\``)) problems.push(`${rel} never mentions the config key \`${key}\``);
	}
}

// The declared compatibility range is a claim too, and the one users act on.
const manifest = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const range = manifest.engines.dsh;
for (const rel of ["README.md", "README.zh.md"]) {
	if (!readFileSync(join(REPO, rel), "utf8").includes(range)) {
		problems.push(`${rel} does not state the declared dsh range ${range}`);
	}
}

// SECURITY.md's support table must name the version the package is actually at.
// A stale row tells users the wrong thing about what is maintained, and no test
// can see documentation.
const security = readFileSync(join(REPO, "SECURITY.md"), "utf8");
const supportedRow = /^\|\s*`(\d+\.\d+\.\d+)`\s*\|/m.exec(security);
if (supportedRow === null) {
	problems.push("SECURITY.md has no `x.y.z` row in its supported-versions table");
} else if (supportedRow[1] !== manifest.version) {
	problems.push(`SECURITY.md's support table names ${supportedRow[1]}, but the package version is ${manifest.version}`);
}

if (problems.length > 0) {
	console.error("");
	for (const problem of problems) console.error(`✗ ${problem}`);
	console.error("");
	console.error(`documented numbers disagree with reality in ${String(problems.length)} place(s).`);
	console.error("Fix the documentation, not this check — the check reads real results.");
	process.exit(1);
}
console.log(
	`✓ documentation matches reality (${String(actual.tests)} tests / ${String(actual.suites)} suites / ` +
		`${String(actual.configKeys)} config keys / dsh ${range})`,
);
