# 在 DeepSeek Harness 中使用得到大脑

把得到大脑接入 DeepSeek Harness（`dsh`）。安装后，你可以直接用自然语言搜索、
保存和阅读笔记，不需要复制 API 请求，也不需要单独配置 MCP。

## 开始使用

### 1. 安装插件

```bash
dsh plugin --profile web add @getnote/dsh-plugin
```

如果你通过 `npx` 使用 DSH：

```bash
npx @deepseek-ai/dsh plugin --profile web add @getnote/dsh-plugin
```

### 2. 登录得到大脑

```bash
npx @getnote/cli@latest auth login
```

命令会打开浏览器，请按页面提示完成授权。得到大脑 OpenAPI 需要得到大脑会员。

插件不要求你额外全局安装 CLI。运行笔记操作时，它会先使用本机 `PATH` 中已有的
`getnote`，再尝试插件环境中的 GetNote CLI；都没有时会自动通过 `npx` 调用兼容
版本。上面的登录授权也可以被其他支持 GetNote CLI 的 AI 工具复用。

### 3. 重启 DSH

重启 `dsh web` 后，就可以直接对 Agent 说：

```text
帮我搜索得到大脑里关于 Agent Harness 的笔记
把 https://example.com/article 保存到得到大脑，添加“待读”标签
列出最近 10 条笔记
打开笔记 1896830231705320746
读一下这条长笔记里讲绩效的那一段
把这 3 条笔记放进「产品研究」知识库
列出我的知识库
```

## 支持的能力

插件需要 GetNote CLI 1.10.0 或更高版本。本机 CLI 太旧时，工具会提示运行
`getnote update`。

**笔记**
- 按自然语言搜索全部笔记或某个知识库，可只返回简短摘要
- 按类型、来源、创建/编辑时间、知识库筛选笔记，按游标翻页
- 查看笔记详情；长笔记先看目录，再按位置或关键词分段读取
- 一次批量读取多条笔记正文（按字数预算，放不下的会列出来下次再读）
- 查看原文、录音转写、附件、时间线、章节、快捷笔记、会议待办、标记
- 按课程名或老师找到有笔记的得到课程
- 保存文字、网页链接和本地图片；可设标题、标签，直接存进知识库或作为子笔记；
  长文本自动走标准输入
- 修改标题、正文、标签；删除笔记（移入回收站）；公开分享笔记
- 查看、添加、去掉单个标签
- 查看保存任务进度、发芽报告、API 额度

**知识库**
- 查看自己的或订阅的知识库，按类型、名称、书籍筛选
- 查看知识库里的笔记，新建知识库，把笔记加入或移出知识库
- 浏览、新建、重命名/移动、删除知识库目录
- 查看和订阅博主、直播及其内容

**需要你确认才会执行**：删除笔记、公开分享、替换正文或全部标签、把笔记移出
知识库、删除目录。DSH 会先弹出确认；没有确认能力的环境里这些操作会被拒绝。

**暂不支持**：登录/退出（请在终端用 CLI）、CLI 自身的安装与升级，以及向知识库
上传文件（需要另行申请上传凭证的多步流程）。

插件会提供一个轻量的 DSH 引导 Skill，让 Agent 优先选择这些原生工具。若你已经
在本机安装了更完整的 GetNote Skills，DSH 仍可正常发现并使用它们，插件不会再
复制一套相同 Skill，也不会覆盖你的版本。

## 常见问题

### 提示未登录怎么办？

重新执行：

```bash
npx @getnote/cli@latest auth login
```

完成授权后重启 DSH。如果仍然失败，可以运行：

```bash
npx @getnote/cli@latest doctor -o json
```

### 是否需要配置 API Key？

普通用户不需要手工填写 API Key。推荐使用浏览器授权，插件会复用 GetNote CLI
保存的登录状态。

### 插件会把凭据发给模型吗？

不会。认证由 GetNote CLI 在本地管理；插件只把笔记操作结果返回给 DSH。登录
状态检查也不会把 API Key 或末尾字符写入模型上下文。

### 为什么依赖 GetNote CLI？

GetNote CLI 负责浏览器授权、调用得到大脑 OpenAPI、处理异步任务和返回结构化
结果。插件负责把这些能力变成 DSH 原生工具。这样同一份授权可以跨终端和多个
AI 工具复用，也能避免重复维护两套得到大脑接口。

## 更新与卸载

更新：

```bash
dsh plugin --profile web update @getnote/dsh-plugin
```

卸载：

```bash
dsh plugin --profile web remove @getnote/dsh-plugin
```

卸载插件不会退出得到大脑账号。如需同时退出：

```bash
npx @getnote/cli@latest auth logout
```

## 高级配置

大多数用户不需要修改配置。需要调整长任务超时或输出上限时，可以在 profile 的
`cordis.patch.yml` 中覆盖插件配置：

```yaml
- id: getnote-tools
  name: '@getnote/dsh-plugin'
  inject: [tools, skills]
  config:
    timeoutMs: 120000
    maxOutputBytes: 10485760
```

`binaryPath` 和 `apiUrl` 仅用于开发或联调环境。

## 安全边界

- 插件只开放明确的得到大脑操作，不提供任意 Shell 参数入口。
- CLI 参数通过参数数组传递，不拼接 Shell 命令。
- 删除、公开分享、覆盖正文/标签、移出知识库、删除目录前，插件会通过 DSH 请求用户确认。
- 长文本经标准输入传给 CLI，不出现在进程参数里。
- 插件与其他 DSH 插件一样，在当前用户权限下运行；请只从可信来源安装。

## 开发

```bash
npm install
npm run check
npm test
npm run build
npm pack --dry-run
```

项目通过 `@getnote/cli` 调用得到大脑能力，并随 npm 包提供一个只负责工具选择的
DSH 引导 Skill。推送与 `package.json` 版本一致的 `v*` tag 后，GitHub Actions
会执行检查、测试、构建并发布 npm 包。

## License

MIT
