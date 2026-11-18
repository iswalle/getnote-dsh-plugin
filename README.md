# 在 DeepSeek Harness 中使用得到大脑

把得到大脑接入 DeepSeek Harness（`dsh`）。安装后，直接用自然语言搜索、保存、
阅读和整理笔记。插件直接调用得到大脑 OpenAPI，不需要安装 GetNote CLI，也不需要
配置 MCP 或手填 API Key。

## 开始使用

### 1. 安装插件

```bash
dsh plugin --profile web add @getnote/dsh-plugin
```

如果你通过 `npx` 使用 DSH：

```bash
npx @deepseek-ai/dsh plugin --profile web add @getnote/dsh-plugin
```

### 2. 重启 DSH，在对话里登录

重启 `dsh web` 后，对 Agent 说「登录得到大脑」。Agent 会给你一个授权链接和
确认码，在浏览器打开链接、登录并确认即可。授权页上的应用名是
「DeepSeek Harness 插件」。

**免费账号也可以使用，无需先开通会员。** 免费与会员享有不同额度，可以对 Agent
说「查看得到大脑额度」查看当前实际额度。额度用尽后按返回的重置时间等待；需要
更高默认额度时，可[升级会员](https://www.biji.com/checkout?product_alias=9Ab36BB3ZD&spm=openapi_dsh)。

### 3. 开始使用

```text
帮我搜索得到大脑里关于 Agent Harness 的笔记
把 https://example.com/article 保存到得到大脑，添加“待读”标签
列出最近 10 条录音台笔记
打开笔记 1896830231705320746，只看讲到“定价”的部分
把这 3 条笔记加到「产品调研」知识库
```

## 支持的能力

| 类别 | 能力 |
| --- | --- |
| 账号 | 浏览器授权、查看状态、查看额度、退出 |
| 查找 | 语义搜索（全部或指定知识库）、按类型/来源/时间/知识库筛选列表、翻页 |
| 阅读 | 笔记详情、长笔记目录和分段阅读、批量阅读 |
| 写入 | 保存文字/链接/图片链接、查询链接处理进度、修改标题和正文、加删标签 |
| 高风险 | 删除（移入回收站）、公开分享 —— 执行前会请你确认 |
| 知识库 | 列出自己的和订阅的知识库、查看知识库笔记、加入或移出笔记 |

暂不支持：上传本地图片、新建或删除知识库、订阅博主等。需要这些能力时可使用
GetNote CLI 或 Skills，两者可以同时安装，互不影响。

## 常见问题

### 提示未登录或授权失效怎么办？

对 Agent 说「重新登录得到大脑」，按链接重新授权即可。

### 凭据存在哪里？会发给模型吗？

授权后的 API Key 保存在 `$DSH_HOME/getnote/credentials.json`（默认
`~/.dsh/getnote/credentials.json`），文件权限 0600。Key 只用于请求得到大脑，
不会出现在工具返回给模型的内容里。

### 和 GetNote CLI 的登录是一份吗？

不是。插件使用自己的授权（应用名「DeepSeek Harness 插件」），可以在得到大脑
账号的授权管理里单独查看和撤销，不影响 CLI。

## 更新与卸载

```bash
dsh plugin --profile web update @getnote/dsh-plugin
dsh plugin --profile web remove @getnote/dsh-plugin
```

卸载前可先对 Agent 说「退出得到大脑」清除本机授权；要彻底取消授权，请在得到
大脑账号设置中撤销「DeepSeek Harness 插件」。

## 高级配置

大多数用户不需要修改配置。可以在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: getnote-tools
  name: '@getnote/dsh-plugin'
  inject: [tools, skills]
  config:
    timeoutMs: 60000
    credentialPath: /path/to/credentials.json
```

`apiUrl`、`clientId` 仅用于联调环境。设置环境变量 `GETNOTE_API_KEY`（及可选
`GETNOTE_CLIENT_ID`）时会优先使用它，适合 CI。

## 安全边界

- 只开放明确的得到大脑操作，不执行任何本机命令。
- 删除、公开分享、替换正文或全部标签、移出知识库前会请求用户确认；没有确认
  通道的运行环境中这些操作会被拒绝。
- 插件与其他 DSH 插件一样，在当前用户权限下运行；请只从可信来源安装。

## 开发

```bash
npm install
npm run check
npm test
npm run build
npm pack --dry-run
```

推送与 `package.json` 版本一致的 `v*` tag 后，GitHub Actions 会执行检查、
测试、构建并发布 npm 包。

## License

MIT
