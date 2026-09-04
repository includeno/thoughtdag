# ThoughtDAG CLI

CLI 通过本机代理把命令交给当前打开的 ThoughtDAG 页面执行，画布仍由页面中的 Zustand/IndexedDB 管理。默认禁止执行；在工具栏 `…` → `CLI 控制` 中开启，并按组或逐项授权。

删除组默认全部关闭，并在设置页显示红色警告。没有授权的命令会在进入画布前被本机代理拒绝。

## 连接桌面安装版

首选方式是打开工具栏 `…` → `CLI 控制`，开启所需权限并保存，然后复制设置页显示的连接命令。该命令同时包含当前安装位置中的 CLI 脚本和会话文件路径，不需要猜测应用被安装到哪里。

在本仓库中运行 `npm run cli` 时，也可以通过 `--session` 连接桌面版。桌面版使用 Electron 的用户数据目录，默认会话文件为：

| 系统 | 会话文件 |
|---|---|
| macOS | `${HOME}/Library/Application Support/thoughtdag-desktop/cli-session.json` |
| Linux | `${XDG_CONFIG_HOME:-${HOME}/.config}/thoughtdag-desktop/cli-session.json` |
| Windows | `%APPDATA%\thoughtdag-desktop\cli-session.json` |

macOS 示例：

```bash
npm run cli -- --session "$HOME/Library/Application Support/thoughtdag-desktop/cli-session.json" status
```

Linux 示例：

```bash
thoughtdag_config_root="${XDG_CONFIG_HOME:-$HOME/.config}"
npm run cli -- --session "$thoughtdag_config_root/thoughtdag-desktop/cli-session.json" status
```

Windows PowerShell 示例：

```powershell
npm run cli -- --session "$env:APPDATA\thoughtdag-desktop\cli-session.json" status
```

路径中的用户目录必须通过 `$HOME`、`$env:APPDATA` 或系统相应环境变量解析，不要复制别人电脑上的绝对路径。会话文件含有本机访问令牌：只传递文件路径，不要读取、输出或提交文件内容。

## 开始

本地开发时先运行页面和代理：

```bash
npm run server
npm run dev
```

在页面中开启 CLI 后：

```bash
npm run cli -- status
npm run cli -- groups
npm run cli -- node.list
npm run cli -- node.get --json '{"nodeId":"node-id"}'
```

桌面版的设置页会显示一条带 `--session` 的可复制连接命令。参数既可以写在命令行，也可以从文件或标准输入读取：

```bash
npm run cli -- node.create --json @operation.json
printf '%s' '{"kind":"note","text":"一条材料"}' | npm run cli -- node.create --json -
```

## 命令组

| 组 | 命令 | 主要参数 |
|---|---|---|
| 读取画布 | `project.list`、`canvas.get`、`node.list`、`node.get`、`edge.list` | `node.get`: `nodeId`；`canvas.get`: 可选 `sharedReadonly` |
| 项目 | `project.create`、`project.switch`、`project.rename` | `name`、`projectId`、可选 `kind` |
| 节点 | `node.create`、`node.update`、`node.move`、`node.duplicate`、`node.archive`、`node.classify` | 见下方示例 |
| 连线 | `edge.connect`、`edge.update`、`organization.connect` | `sourceId`、`targetId`、`relation` / `kind` |
| 材料与高亮 | `attachment.add`、`attachment.update`、`highlight.add`、`highlight.mode` | `nodeId` 及对象 ID |
| 提问与生成 | `question.ask`、`node.regenerate`、`generation.stop` | `question`、`parentId` 或 `nodeId` |
| 整理、分类与历史 | `canvas.relayout`、`node.align`、`tag.create`、`tag.rename`、`type.create`、`type.rename`、`history.undo`、`history.redo` | 标签/类型使用稳定 ID |
| 导入与导出 | `canvas.export`、`project.import` | v2 完整载荷；可使用 `--file` / `--output` |
| 删除（危险） | `project.delete`、`node.delete`、`edge.delete`、`organization.delete`、`attachment.delete`、`highlight.delete`、`version.delete`、`tag.delete`、`type.delete` | 相应对象 ID |

## 常用操作

创建便签、问题节点或 Frame：

```bash
npm run cli -- node.create --json '{"kind":"note","text":"核心结论","position":{"x":120,"y":80}}'
npm run cli -- node.create --json '{"kind":"ask","question":"下一步验证什么？","parentId":"parent-id"}'
npm run cli -- node.create --json '{"kind":"frame","question":"第一章","width":720,"height":480}'
```

`kind` 支持 `ask`、`note`、`file`、`link`、`frame`、`human`、`prompt`。创建 `link` 时传入 `url`，页面会抓取并保存网页快照。

更新、移动、归档节点：

```bash
npm run cli -- node.update --json '{"nodeId":"node-id","patch":{"question":"新问题","response":"人工整理的回答"}}'
npm run cli -- node.move --json '{"nodeId":"node-id","position":{"x":660,"y":420}}'
npm run cli -- node.archive --json '{"nodeIds":["a","b"],"archived":true}'
```

连接节点：

```bash
npm run cli -- edge.connect --json '{"sourceId":"a","targetId":"b","relation":"structural"}'
npm run cli -- edge.connect --json '{"sourceId":"source","targetId":"target","relation":"reference"}'
```

`relation` 支持 `structural`、`reference`、`watch`。结构连线会检查环，并调用现有自动布局保持箭头顺序。

建立独立于对话上下文的组织关系：

```bash
npm run cli -- organization.connect --json '{"sourceId":"parent","targetId":"child","kind":"parent"}'
npm run cli -- organization.connect --json '{"sourceId":"a","targetId":"b","kind":"jump"}'
```

`kind` 必须是 `parent` 或 `jump`。两个端点必须存在且不能是 Frame；`parent` 会拒绝自环、重复边和成环写入，`jump` 会拒绝自环和同向重复边。组织关系只用于知识整理，不会进入提示词、上下文布局或陈旧判断。

创建、重命名标签和自定义类型，并批量分类节点：

```bash
npm run cli -- tag.create --json '{"name":"关键证据","color":"#0F766E"}'
npm run cli -- tag.rename --json '{"tagId":"tag-id","name":"已核验证据"}'
npm run cli -- type.create --json '{"name":"决策"}'
npm run cli -- type.rename --json '{"typeId":"type-id","name":"最终决策"}'
npm run cli -- node.classify --json '{"nodeIds":["a","b"],"customTypeId":"type-id","tagIds":["tag-a","tag-b"]}'
```

`node.classify` 要求非空 `nodeIds`。提供 `tagIds` 时采用 **replace** 语义：数组会去重并完整替换每个目标节点当前的标签；传 `[]` 清空标签；省略 `tagIds` 则保持原值。`customTypeId` 传稳定类型 ID 表示设置，传 `null` 表示清空，省略则保持原值。所有节点和分类 ID 会在写入前一次性校验，整批修改只产生一个可撤销事务。

添加文件、网页与高亮：

```bash
npm run cli -- attachment.add --node node-id --file ./materials/report.pdf
npm run cli -- node.create --json '{"kind":"link","url":"https://example.com/doc"}'
npm run cli -- highlight.add --json '{"nodeId":"node-id","text":"关键证据"}'
```

提问、重新生成和停止：

```bash
npm run cli -- question.ask --json '{"question":"根据材料整理三条结论","parentId":"node-id"}'
npm run cli -- node.regenerate --json '{"nodeId":"node-id"}'
npm run cli -- generation.stop --json '{"nodeId":"node-id"}'
```

导出和导入均使用完整 `.thoughtdag.json` 格式：

```bash
npm run cli -- canvas.export --output ./backup.thoughtdag.json
npm run cli -- project.import --file ./backup.thoughtdag.json
```

默认的 `canvas.get` 与 `canvas.export` 返回 `schemaVersion: 2`，并完整携带 `nodes`、上下文 `edges`、`organizationRelations`、`taxonomy`、`events`、`transactions`、`undoableTransactionIds`、`redoableTransactionIds` 和 `revision`；`project.import` 会以同一 v2 持久化边界导入，并校验节点/边端点、结构边和 parent 关系环、组织关系与分类 ID、事务 ID 及撤销/重做栈引用。旧版只含 `nodes` / `edges` 的载荷仍按 v1 兼容导入。

需要构造只读/展示载荷时，显式传 `sharedReadonly: true`：

```bash
npm run cli -- canvas.export --json '{"sharedReadonly":true}' --output ./shared.thoughtdag.json
npm run cli -- canvas.get --json '{"sharedReadonly":true}'
```

只读载荷仍包含展示所需的 `organizationRelations` 与 `taxonomy`，但不会包含 `events`、`transactions`、撤销/重做事务 ID 或 `revision`。导入带 `sharedReadonly: true` 的载荷时也会在持久化前强制剥离这些字段，即使输入中额外注入了历史数据。

删除命令只有在红色删除组中单独授权后才能运行：

```bash
npm run cli -- node.delete --json '{"nodeIds":["a","b"]}'
npm run cli -- edge.delete --json '{"edgeId":"edge-a-b"}'
npm run cli -- organization.delete --json '{"relationIds":["org-a-b","org-b-c"]}'
npm run cli -- tag.delete --json '{"tagId":"tag-id"}'
npm run cli -- type.delete --json '{"typeId":"type-id"}'
```

删除标签或类型会在同一事务中清理所有节点引用；`organization.delete` 也会对整批关系做先校验后删除，任何未知 ID 都会使整条命令失败且不产生部分写入。
