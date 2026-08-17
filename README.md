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
列出我的知识库
```

## 支持的能力

- 检查得到大脑登录状态
- 按自然语言语义搜索全部笔记
- 在指定知识库内搜索
- 保存文字、网页链接和本地图片
- 保存时设置标题和标签
- 查看最近笔记
- 按 ID 查看笔记详情
- 查看知识库列表

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
- 删除和批量修改等高风险能力尚未在首版开放。
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
