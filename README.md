# GetNote Plugin for DeepSeek Harness

在 DeepSeek Harness（`dsh`）中使用得到大脑（Get笔记）。插件复用
[`@getnote/cli`](https://github.com/iswalle/getnote-cli) 的认证和 OpenAPI
实现，不保存第二份凭据，也不重复实现业务接口。

## 安装

```bash
dsh plugin --profile web add @getnote/dsh-plugin
```

首次使用前完成浏览器授权：

```bash
npx @getnote/cli@latest auth login
```

然后重启 DSH，即可用自然语言搜索、保存和读取笔记：

```text
帮我搜索得到大脑里关于 Agent Harness 的笔记
把这个链接保存到得到大脑，并添加“待读”标签
列出最近 10 条笔记
```

## 当前能力

插件注册以下原生 DSH Tools：

- `getnote_auth_status`
- `getnote_search`
- `getnote_save`
- `getnote_list_notes`
- `getnote_get_note`
- `getnote_list_knowledge_bases`

同时挂载随包发布的五个 GetNote Skills，帮助 Agent 正确选择工具并遵守笔记、
知识库、标签和认证操作规则。

## 调用关系

```text
DSH Skill / Tool
  -> @getnote/dsh-plugin
  -> bundled @getnote/cli executable
  -> GetNote OpenAPI
```

插件以参数数组启动 CLI，并强制使用 JSON 输出；不会拼接 Shell 命令。认证由
CLI 统一维护，因此终端、其他 Agent 和 DSH 可以复用同一份授权。

## 配置

可以在 profile 的 `cordis.patch.yml` 中覆盖插件行：

```yaml
- id: getnote-tools
  name: '@getnote/dsh-plugin'
  inject: [tools, skills]
  config:
    timeoutMs: 120000
    maxOutputBytes: 10485760
```

`binaryPath` 可用于开发或诊断；正常安装不需要设置，插件会解析自己依赖的
`@getnote/cli` 可执行文件。只有明确联调测试环境时才应配置 `apiUrl`。

## 本地开发

```bash
npm install
npm run check
npm test
npm run build

dsh plugin --profile web add .
dsh --profile web --dump-config
```

从 GitHub 源码安装时，pnpm 需要允许本包运行 `prepare` 构建脚本。正式 npm
包包含预构建产物，不需要安装时构建授权。

## 发布

版本号与 Git tag 保持一致：

```bash
npm version patch
git push origin HEAD --follow-tags
```

推送 `v*` tag 后，GitHub Actions 会检查、测试、构建、创建 GitHub Release，
并通过仓库 Secret `NPM` 发布公开 npm 包。

## 安全

- 插件与当前 DSH 进程拥有相同的本机权限。
- 凭据由 `@getnote/cli` 管理，不进入模型上下文。
- 插件只注册明确的 GetNote 操作，不提供任意 Shell 参数入口。
- 删除、批量修改等高风险能力尚未在首版开放。

## License

MIT
