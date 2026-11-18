---
name: getnote-dsh
description: 在 DeepSeek Harness 中使用得到大脑。用户要搜索、保存、阅读、修改、整理得到大脑笔记，管理知识库、标签、订阅，或查看登录状态和额度时使用。
---

# 得到大脑（DSH）

优先使用插件提供的 `getnote_*` 原生工具，不要自行拼接 Shell 命令。

## 找笔记
- `getnote_search`：语义搜索，可限定知识库；结果太长时传 `snippet_chars` 只取摘要。
- `getnote_list_notes`：按时间列笔记，可按类型、来源、时间、知识库筛选；用返回的 `next_cursor` 作为 `cursor` 翻页。
- `getnote_find_course`：按课程名或老师找有笔记的得到课程。

## 读笔记
- `getnote_get_note`：读一条笔记全文。
- 长笔记：先 `getnote_note_outline` 看目录，再用 `getnote_note_section` 按返回的 `offset` + `version` 或关键词读；不要自己按字数算 offset，version 变了就重新读目录。
- 多条笔记：`getnote_read_notes` 批量读，`pending_ids` 里是这次没放下的，下一次再读。
- `getnote_note_view`：原文、录音转写、附件、时间线、章节、快捷笔记、会议待办；不是每种笔记都有每种视图，提示不可用时换别的视图。
- `getnote_note_marks`、`getnote_list_sprouts`（需要月份 YYYY-MM）、`getnote_get_sprout`。

## 写笔记
- `getnote_save`：保存文字、链接或本地图片；链接是异步处理，用 `getnote_task_status` 查结果。重试同一次保存时复用 `idempotency_key`。
- `getnote_update_note`：改标题可直接执行；替换正文（仅纯文本笔记）或全部标签需要用户确认。
- 只加/去一个标签时用 `getnote_add_note_tag` / `getnote_remove_note_tag`，不要用 `getnote_update_note` 覆盖全部标签。
- `getnote_delete_note`（移入回收站）、`getnote_share_note`（公开链接）需要用户确认。

## 知识库
- `getnote_list_knowledge_bases`（`subscribed: true` 看订阅的）、`getnote_list_kb_notes`、`getnote_create_knowledge_base`。
- `getnote_kb_add_notes` / `getnote_kb_remove_notes`（移出需确认）：每次最多 20 条。
- 目录：`getnote_kb_list_directories`、`getnote_kb_create_directory`、`getnote_kb_update_directory`、`getnote_kb_delete_directory`（需确认）。
- 订阅：博主 `getnote_kb_list_bloggers` / `getnote_kb_list_blogger_contents` / `getnote_kb_get_blogger_content` / `getnote_kb_follow_blogger`；直播 `getnote_kb_list_lives` / `getnote_kb_get_live` / `getnote_kb_follow_live`。

## 规则
- 笔记 ID、知识库 ID、目录 ID 一律按字符串传，不要转成数字。
- 需要确认的操作被拒绝时，告诉用户需要他确认，不要换别的工具绕过去。
- 用户要的能力不在这些工具里时，优先用 DSH 已发现的用户级 GetNote Skill；都没有就如实说明暂不支持。
- 工具报 CLI 版本过旧时，请用户在终端运行 `getnote update`。

## 登录
认证由本机 GetNote CLI 管理。未登录时，请用户在终端执行：

```bash
npx @getnote/cli@latest auth login
```
