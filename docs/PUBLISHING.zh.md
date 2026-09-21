# 发布

[English](PUBLISHING.md) | 简体中文

一次发布就是一个 tag。tag 之前的所有步骤，都是为了确保这个 tag 不会把没验证过的东西发出去。

## 发布之前

- 按顺序跑守卫：先套件，再重录配对，最后核对文档数字。先重录再查数字是刻意的，因为查数字那道才是会去读真实结果的那一道。
- 版本号只在一处升，也就是 `package.json`，然后顺着守卫的报错，去改那些复述这个版本号的文档。
- 确认打包白名单与实际发布内容一致，因为白名单里漏一个文件，就会产出「装得上但什么也不做」的包。

## 发布

```bash
node test/run.mjs
node tools/verify-translation-pairing.mjs --write
node tools/verify-doc-numbers.mjs
bash -n install.sh && bash -n uninstall.sh
node tools/verify-version-consistency.mjs --dsh 0.1.5-rc.2
node tools/boot-check.mjs --port 31901 --timeout 40
git tag -a v1.0.1 -m "v1.0.1" && git push origin v1.0.1
```

启动自检需要一个可启动的 harness：先跑 `npm install --no-save @deepseek-ai/dsh@0.1.5-rc.2`
与 `node tools/link-harness-peers.mjs`，或者用 `--dsh-bin <指向 @deepseek-ai/dsh/lib/bin.js 的路径>` 指定。
它还需要 PATH 上有 `pnpm`，因为 `dsh plugin` 会把它转发过去。

## 发布之后

- 发布任务报成功，并不等于版本到了 npm。要去轮询 registry 而不是想当然，因为传播要几分钟，而且它的失败是静默的。
- 把发出去的 tarball 解开，grep 只有本次发布才有的字符串。绿色的任务加上新的 registry 版本，两者合起来也只能证明「有个东西发出去了」。
- 把版本、commit、tag 与 tarball 核对写进发布记录，这样下一次发布是从证据出发，而不是从记忆出发。

## 市场

| 市场 | 怎么触达 | 门槛 |
| --- | --- | --- |
| awesome-dsh-plugin | 开一个 PR 改一条 YAML 条目 | 描述必须与代码相符 |
| dsh-market | 自动，取自仓库 description | 无 |
| dsh.market | 自动，取自仓库 description 与 topics | 无 |
