# D1 清理凭据：coffeechat

操作人账号：neachao1@gmail.com（Account ID 3ec5438f9e30e232506d2e2e3e0f1745）
删除时间：2026-11-17（Asia/Shanghai）

## 删除前快照（不可逆操作凭据）

`wrangler d1 list` 原始行：

| uuid | name | created_at | version | num_tables | file_size |
|---|---|---|---|---|---|
| c9a14daf-27df-4dc3-9518-201c4d86a28b | coffeechat | 2025-03-10T19:18:08.284Z | production | 1 | 16384 |

- 库 id：`c9a14daf-27df-4dc3-9518-201c4d86a28b`
- 创建时间：2025-03-10T19:18:08.284Z
- 大小：16384 字节（16 KB，空库大小）

## 独立复核：库内全部对象

```
SELECT type, count(*) FROM sqlite_master GROUP BY type  WHERE name NOT LIKE '_cf_%'
→ table: 1        （其余 type 均无记录：无 view / trigger / index）
```

唯一对象是表 `user`，表结构：

```sql
CREATE TABLE [user] (
  "id" integer PRIMARY KEY,
  "input" text,
  "career" text,
  "output_ai" text,
  "output_json" text
)
```

行数：`SELECT COUNT(*) FROM user` → **0**

结论：除这张 0 行的 `user` 表外，库内没有任何其它数据对象，也没有任何行。

## 删除前后 D1 库数量

- 删除前：10 个
- 删除后：9 个（`wrangler d1 list` 实测 9 行；`mailboxes-db` 与 `umami-db-local` 均仍在）
- 随后新建 `mailboxes-db-demo`（`be18b99a-6fb7-4a72-9c00-edd6b982d6a8`，2026-11-16T17:41:52Z）作为演示库，总数回到 10。

## 未触碰的库（复核仍在）

| uuid | name |
|---|---|
| bce48f1a-88a3-4a57-8cee-a0f0c7a7ac38 | mailboxes-db（生产） |
| dd56738d-5d3e-4bfd-a5f6-e90a9edbd6c8 | umami-db-local（约 2.5 万行活库） |
