---
name: getnote-dsh
description: 在 DeepSeek Harness 中使用得到大脑。用户要登录得到大脑，搜索、保存、列出、阅读、修改、删除或分享笔记，管理标签和知识库时使用。
---

# 得到大脑（DSH）

使用插件提供的 `getnote_*` 原生工具完成操作，不需要本机安装 GetNote CLI。

## 登录

- 任何工具提示未登录时，调用 `getnote_login`，把返回的链接和确认码原样告诉用户，请用户在浏览器打开、登录并确认。
- 用户说已确认后，调用 `getnote_auth_status` 确认结果，再继续原来的操作。
- `getnote_logout` 只清除本机授权；要彻底取消，请用户在得到大脑账号设置里撤销。

## 调用额度

- 所有用户授权后都可以调用，会员享有更高额度。不要预先因为用户不是会员就拒绝、要求升级或重新登录。
- 用 `getnote_quota` 查看当前实际额度，不要自己写死额度数字。
- 工具报额度或频率超限时，按返回的等待时间告诉用户，不要连续重试。
- 只有服务端明确返回非会员错误（10201 / not_member）时，才把错误里的会员链接告诉用户。

## 找笔记

- `getnote_search`：语义搜索，可用 `knowledge_base_id` 限定知识库；结果多时加 `snippet_chars` 只取片段。
- `getnote_list_notes`：按时间倒序列笔记，可按类型、来源、创建/编辑时间、知识库筛选；翻页用上一页的 `next_cursor`。
  - 录音台笔记：`source=vendor_moan`；录音卡：`source=getseed`。

## 读笔记

- `getnote_get_note`：读一条笔记全文和标签（含标签 ID）。
- 长笔记先 `getnote_note_outline` 拿目录和 offset，再用 `getnote_note_section` 按 offset 或关键词读片段；offset 只用接口返回的，不要自己算。
- `getnote_read_notes`：一次读多条（最多 20），没读完的在 `pending_ids` 里，再调一次。
- 笔记带 `generation_status` 且不是 `completed`（生成中、附件处理中、失败等）时，正文可能为空或不完整，不要当最终内容，告诉用户还在生成，过会儿再用 `getnote_get_note` 读；没有这个字段时照常处理。

## 写笔记

- `getnote_save`：保存文字、网页链接或 HTTPS 图片链接，可带标题、标签、知识库、父笔记。链接是异步处理，用 `getnote_task_status` 查结果；重试同一次保存时带同一个 `idempotency_key`，避免重复。
- `getnote_update_note`：改标题；正文只能改纯文本笔记；`tags` 会替换全部标签。只加标签用 `getnote_add_note_tags`，删一个用 `getnote_remove_note_tag`。
- `getnote_delete_note`：移入回收站（可在 App 恢复）。
- `getnote_share_note`：公开分享，拿到链接的人都能看。

## 知识库

- `getnote_list_knowledge_bases`：自己的知识库；`subscribed=true` 看订阅的。
- `getnote_list_kb_notes`、`getnote_kb_add_notes`、`getnote_kb_remove_notes`（只移出，不删笔记）。

## 规则

- 笔记 ID、知识库 ID、标签 ID 一律按字符串处理，不要转成数字。
- 删除、公开分享、替换正文或全部标签、移出知识库会先请用户确认；用户拒绝就停下，不要换别的工具绕过去。
- 不支持的操作（如上传本地图片、新建知识库）直接告诉用户插件暂不支持。
