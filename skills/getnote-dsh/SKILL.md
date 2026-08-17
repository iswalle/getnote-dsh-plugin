---
name: getnote-dsh
description: 在 DeepSeek Harness 中使用得到大脑。用户要搜索、保存、列出或打开得到大脑笔记，查看知识库或检查登录状态时使用。
---

# 得到大脑（DSH）

优先使用插件提供的 `getnote_*` 原生工具完成操作：

- `getnote_auth_status`：检查登录状态。
- `getnote_search`：语义搜索笔记，可限定知识库。
- `getnote_save`：保存文字、链接或本地图片，可设置标题和标签。
- `getnote_list_notes`：列出最近笔记。
- `getnote_get_note`：按字符串 ID 打开笔记。
- `getnote_list_knowledge_bases`：列出知识库。

笔记 ID 必须始终按字符串处理，不得转换为数字。

如果用户请求的能力不在这些工具中，优先使用 DSH 已发现的用户级 GetNote Skill；
不要为了绕过工具边界自行拼接未经说明的 Shell 命令。若没有相应 Skill，说明当前
插件尚未支持该操作，并建议用户安装或更新 GetNote Skills。

认证由本机 GetNote CLI 管理。未登录时，请用户在终端执行：

```bash
npx @getnote/cli@latest auth login
```
