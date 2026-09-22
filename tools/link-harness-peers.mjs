#!/usr/bin/env node
/**
 * Make the harness peer packages resolvable from the repository root.
 *
 * The tests import `@deepseek-ai/dsh-compaction-basic` and
 * `@deepseek-ai/schemastery`, which are peer dependencies: the harness supplies
 * them, the plugin never ships them. That is the right contract for a plugin,
 * but it means neither `npm test` locally nor CI can resolve the import from a
 * fresh clone.
 *
 * Neither package is published on npm at a matching version — the registry's
 * `@deepseek-ai/dsh-compaction-basic` is an unrelated `0.0.1-rc.3` — so they
 * cannot be installed directly. They *are* present inside `@deepseek-ai/dsh`'s
 * own dependency tree, and also in whatever harness install is on this machine.
 * This script finds either and links it into `node_modules/@deepseek-ai/`, so a
 * repository checkout can run its own suite.
 *
 * Idempotent: an existing link is left alone, and an existing real directory is
 * never replaced.
 *
 * Run: node tools/link-harness-peers.mjs
 *      node tools/link-harness-peers.mjs --print   # report what it would do
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCOPE = join(REPO, "node_modules", "@deepseek-ai");
/**
 * The harness packages this repository's suite imports but never ships.
 *
 * `dsh-compaction-basic` is the engine this plugin subclasses; it is a
 * dependency of `@deepseek-ai/dsh` rather than a standalone install, and the
 * npm package of that name is an unrelated `0.0.1-rc.3`, so it can only be
 * linked out of a harness tree.
 */
const PEERS = ["dsh-compaction-basic", "dsh-session", "schemastery", "cordis"];
const printOnly = process.argv.includes("--print");

/**
 * Where to look for a harness install, most specific first.
 *
 * `DSH_INSTALL` is the only supported way to point this at a given machine, so
 * moving a harness is one environment variable rather than a hunt through every
 * link. There is deliberately **no hard-coded path** here: this repository is
 * public, and one machine's directory is not a fallback for anybody else — it is
 * a dead entry that makes the discovery look like it ran. CI never needs it,
 * because there the harness is an ordinary `@deepseek-ai/dsh` dependency and
 * `findScope` finds its nested tree first.
 *
 * When nothing is found the warning below names `DSH_INSTALL`; on a machine that
 * has not set it, that is faster than debugging an import error later.
 */
function harnessRoots() {
	const roots = [];
	if (process.env.DSH_INSTALL !== undefined) roots.push(process.env.DSH_INSTALL);
	if (process.platform !== "win32") roots.push(join(process.env.HOME ?? "", ".dsh", "profiles"));
	return roots.filter((root) => root.length > 0);
}

/**
 * Find a directory that actually contains the given scoped package.
 *
 * @param name - package name without the scope, e.g. `dsh-tools`.
 * @returns the containing `@deepseek-ai` directory, or `undefined`.
 */
function findScope(name) {
	// 1. Inside the harness package's own dependency tree (the CI layout, where
	//    `npm install @deepseek-ai/dsh` nests its dependencies).
	const nested = join(REPO, "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", name);
	if (existsSync(nested)) return dirname(nested);

	// 2. A harness install on this machine (the local-development layout).
	for (const root of harnessRoots()) {
		if (!existsSync(root)) continue;
		const candidates = [join(root, "node_modules", "@deepseek-ai", name)];
		try {
			for (const entry of readdirSync(root)) {
				candidates.push(join(root, entry, "node_modules", "@deepseek-ai", name));
				candidates.push(join(root, entry, "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", name));
			}
		} catch {
			// A missing or unreadable root is simply not a candidate.
		}
		const hit = candidates.find((candidate) => existsSync(candidate));
		if (hit !== undefined) return dirname(hit);
	}
	return undefined;
}

mkdirSync(SCOPE, { recursive: true });
let linked = 0;
let skipped = 0;

for (const name of PEERS) {
	const target = join(SCOPE, name);
	if (existsSync(target)) {
		skipped += 1;
		continue;
	}
	const scope = findScope(name);
	if (scope === undefined) {
		console.warn(`· ${name}: not found in any harness install — schema-dependent tests will fail to import.`);
		console.warn("  Set DSH_INSTALL to the harness app directory, or run `npm install --no-save @deepseek-ai/dsh`.");
		continue;
	}
	const source = join(scope, name);
	if (printOnly) {
		console.log(`would link ${source} -> ${target}`);
		continue;
	}
	symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
	console.log(`✓ linked @deepseek-ai/${name}`);
	linked += 1;
}

console.log(`harness peers: ${String(linked)} linked, ${String(skipped)} already present`);
