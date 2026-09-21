# Publishing

English | [中文](PUBLISHING.zh.md)

A release is a tag. Everything before the tag exists so that the tag cannot publish something unverified.

## Before a release

- Run the guards in order: the suite, then the pairing re-record, then the documented numbers. Re-recording before the number check is deliberate, because the number check is the one that reads real results.
- Raise the version in one place only, namely `package.json`, then follow the guard's complaints to the documents that restate it.
- Confirm the packed allowlist matches what ships, because a file missing from the allowlist produces a package that installs and then does nothing.

## Release

```bash
node test/run.mjs
node tools/verify-translation-pairing.mjs --write
node tools/verify-doc-numbers.mjs
bash -n install.sh && bash -n uninstall.sh
node tools/verify-version-consistency.mjs --dsh 0.1.5-rc.2
git tag -a v0.1.0 -m "v0.1.0" && git push origin v0.1.0
```

## After the release

- A successful publish job does not mean the version reached npm. Poll the registry rather than assuming, because propagation takes minutes and its failure is silent.
- Unpack the published tarball and grep it for strings that only this release contains. A green job and a new registry version together still only prove that something was published.
- Record the version, the commit, the tag and the tarball check in the release notes, so the next release starts from evidence rather than from memory.

## Marketplaces

| Marketplace | How it is reached | Threshold |
| --- | --- | --- |
| awesome-dsh-plugin | a pull request editing one YAML entry | the description must match the code |
| dsh-market | automatic, from the repository description | none |
| dsh.market | automatic, from the repository description and topics | none |
