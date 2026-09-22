# AGENTS.md

Repository conventions for coding agents working here. Read this before changing anything.

## Never break these

1. There is no client half. Every surface this plugin adds is host-side, so adding a browser module changes the package shape rather than extending it.
2. The engine wraps exactly one method. Trigger policy, retention and summary selection belong to the base engine; re-implementing them here would mean two places to keep correct.
3. State must not live in private class fields. A realm served this plugin's service object without this class's private brands, and a private-field read throws inside the compaction path, where the host swallows it and auto-compaction simply stops.
4. Every configuration key declared in `static Config` must be documented in both READMEs. The documented-numbers guard fails until it is, and that is deliberate.
5. Both sides of a translated pair change together, and then the pairing hashes are re-recorded. Re-recording declares the pair aligned; it does not check it.

## Guards

- Run them in order: the suite, the pairing re-record, the documented numbers. The order matters because the number check reads real results.
- A guard that cannot fail is not a guard. When you add one, prove it fails on a mutated copy before trusting it.
- The boot check is the only one that *applies* the plugin. Everything else reads files and will happily pass on a plugin that installs and does nothing. It needs `pnpm` on PATH, because `dsh plugin` forwards to it.
- The boot check has four assertions: A the install exits 0, B `cordis.patch.yml`'s row name equals `package.json`'s name, C the port answers *and keeps answering* through `--settle`, D stderr stays empty. Exit 1 names the failing letter; exit 2 means the environment is missing something (no pnpm, no harness, or a port already in use) and says nothing about this plugin.
- Assertion C deliberately refuses to run when the port is already taken. A listener that is not our child satisfies "the port answers" perfectly, and that produced two false greens in one batch of mutants. Do not relax it.

## Facts worth not rediscovering

- `--dump-config` synthesises configuration without applying plugins, so it cannot see a duplicate tool or service name — and it does not resolve a row's package either. With a row name deliberately pointing at a package that does not exist, it still exits 0, writes nothing to stderr, and still lists the row. Only a real boot reports `Cannot find package '<name>'`.
- A preset row resolves against the profile that is booting and never appears in the composition tree, so its absence from a dump means nothing.
- Nothing here needs a GUI: a probe can compose the preset realm through the same two public calls the session controller makes.
- Current shape: 13 configuration keys, 19 tests in 2 suites, declared for dsh `>=0.1.5-rc.2 <0.2.0-0`.
