# ThoughtDAG 知识工作台架构约束（Schema v2）

本文定义大型画布整理能力的实现契约。文中的“必须”“不得”和验收项是合入门槛，不表示对应能力已经完成。只有数据迁移、行为测试和端到端验收全部通过后，功能清单才能把相关能力描述为已提供。

## 1. 范围

本阶段只补齐以下六组能力：

1. 活动节点邻域模式：在全图与一至两层局部邻域之间切换。
2. 组织关系层：提供父级、子级和跳转关系，但不改变模型上下文。
3. 项目级标签与自定义节点类型：支持定义、复用和批量分配。
4. 组合过滤：组合文本、节点种类、标签、时间、关系范围和归档状态。
5. Tree 与 Card 视图：与 Canvas 共享活动节点、选择和过滤状态。
6. 持久化事务：记录可恢复的 `before/after`，刷新后仍可撤销和重做。

以下工作不属于本阶段：

- Outline、对称 Mind Map、演示模式、多标签页和多窗口；
- Pins、Home、最近访问、保存搜索、报告和自定义关系类型；
- 富文本编辑器、待办聚合、日历、提醒、收件箱和单节点发布；
- 账户同步、多人协作、移动端、权限系统和跨端设置同步；
- 运行对比、Artifact 节点、异步范式协作；
- 改变 LLM provider、检索、阅读器或桌面更新架构；
- 把分类元数据、组织关系或视图状态加入模型 prompt。

现有列树布局的箭头顺序和同一对话链竖向对齐是兼容性约束，不得因本阶段改造而退化。

## 2. 状态边界

系统必须区分三类状态：

### 2.1 项目领域状态

项目内容需要持久化、导入导出并进入事务系统，包括：

- 节点；
- 上下文边；
- 组织关系；
- 标签和自定义类型定义；
- 节点的标签、类型分配；
- 语义事件日志；
- 项目事务日志。

### 2.2 工作区领域状态

项目目录继续由现有 workspace store 独立持久化，包括项目创建、重命名、导入和删除。项目切换只是导航，不进入单项目撤销历史。本阶段不引入项目墓碑或跨项目撤销；这些属于后续恢复架构，不能与本阶段的单项目事务混为一谈。

### 2.3 瞬时视图状态

下列状态不进入项目事务，也不得改变图语义：

- 当前活动节点、框选集合和悬停状态；
- Canvas、Tree、Card 视图模式；
- 全图/局部开关和邻域深度；
- 当前过滤器、搜索输入和排序方式；
- viewport、面板开关、编辑中的草稿和流式 chunk；
- 由投影临时计算出的 `hidden`、位置、样式和高亮属性。

瞬时视图状态可以存为本机偏好，但不得混入 `.thoughtdag.json` 的领域数据，也不得产生撤销事务。

## 3. Schema v2

Schema v2 分为工作区清单和单项目文档。下面的类型是规范性结构；实现可调整文件拆分，但不得合并语义边界。

```ts
interface WorkspaceManifestV2 {
  projects: ProjectMetaV2[];
  activeId: string | null;
}

interface ProjectMetaV2 {
  id: string;
  name: string;
  kind: 'chat' | 'paradigm';
  createdAt: number;
  updatedAt: number;
  instantiatedFrom?: { name: string; at: string };
}

interface PersistedProjectEnvelopeV2 {
  version: 2;
  state: ProjectStateV2;
}

interface ProjectStateV2 {
  nodes: ThoughtNodeV2[];
  edges: ThoughtEdge[]; // 只允许上下文边；沿用既有兼容表示
  organizationRelations: OrganizationRelationV2[];
  taxonomy: ProjectTaxonomyV2;
  events: CanvasEvent[];
  transactions: DomainTransactionV2[];
  undoableTransactionIds: string[];
  redoableTransactionIds: string[];
  revision: number;
}

interface ProjectExportV2 extends ProjectStateV2 {
  schemaVersion: 2;
  version: 2;
  name: string;
  exportedAt: string;
  instantiatedFrom?: { name: string; at: string };
}
```

IndexedDB 内的工作区清单沿用现有 `thoughtdag:projects` 形状，项目内容使用 Zustand persist envelope。文件传输边界另行写入 `schemaVersion: 2`；完整导出使用 `ProjectExportV2`，只读展示导出保留节点、上下文边、组织关系与分类，但省略 `events`、事务、栈和 `revision`。

### 3.1 节点分类

`stepKind` 继续表示节点的系统行为，例如问答、便签、文件、链接、Frame、human 或 prompt。用户自定义类型不得覆盖或扩展 `stepKind`，否则渲染、生成和布局会被用户分类意外改变。

```ts
interface ThoughtDataV2 extends ThoughtData {
  tagIds: string[];
  customTypeId?: string;
}

interface ProjectTaxonomyV2 {
  tags: TagDefinitionV2[];
  nodeTypes: NodeTypeDefinitionV2[];
}

interface TagDefinitionV2 {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}

interface NodeTypeDefinitionV2 {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}
```

分类必须满足以下约束：

- 标签名和类型名在同一项目、同一分类空间内按规范化名称唯一；规范化至少包含首尾空白清理和大小写折叠。
- 一个节点可以有零到多个标签，但最多有一个自定义类型。
- `tagIds` 必须去重；不存在的 ID 不得由新命令写入。
- 重命名只更新定义，节点继续引用稳定 ID。
- 删除标签必须在同一事务中移除所有节点引用。
- 删除自定义类型必须在同一事务中清空所有节点的 `customTypeId`。
- 标签和自定义类型不得进入 `buildContext()`、上游指纹、Token 估算或陈旧判断。
- 类型颜色只影响显示；自定义图标和任意样式编辑不在本阶段范围内。

### 3.2 上下文边

本阶段对项目 schema 的升级是**加法式升级**：现有 `ThoughtEdge` 及其 `isCrossLink`、`isWatch` 兼容语义保持不变，避免一次知识整理功能交付同时改写 prompt、布局、陈旧判断和历史项目的核心边协议。`edges` 仍只保存会影响对话执行的上下文边：

- 普通边是 structural，参与 DAG 环检查、祖先/后代遍历、上下文主链、自动布局、陈旧判断和生成依赖；
- `data.isCrossLink === true` 是 reference，以引用块进入上下文；
- `data.isWatch === true` 沿用评审/随动语义；
- `data.isOrganization === true` 仅可出现在 React Flow 的渲染适配对象中，导入和持久化边界必须拒绝它。

把三类上下文边迁移到新的 canonical `kind` 是独立的后续重构，需要单独固定 v1 fixture 并证明所有 prompt 和布局输出等价，不作为本阶段六项能力的隐含前置条件。

### 3.3 组织关系

组织关系必须使用独立集合，不得存入 `edges`：

```ts
type OrganizationRelationKindV2 = 'parent' | 'jump';

interface OrganizationRelationV2 {
  id: string;
  kind: OrganizationRelationKindV2;
  sourceId: string; // parent 时为父级；jump 时为起点
  targetId: string; // parent 时为子级；jump 时为终点
  createdAt: string;
}
```

组织关系必须满足以下约束：

- `parent` 关系构成项目级 DAG；自环、重复边和成环写入必须被命令层拒绝。
- `jump` 是导航关系，可以跨层连接；自环和同向重复边仍必须拒绝。是否同时存在反向 jump 由用户显式创建决定。
- 新建关系前必须验证两个端点存在。
- 删除节点只删除与其相连的组织关系，不得级联删除组织子级。
- 归档节点不删除组织关系；是否显示由查询投影的归档过滤决定。
- 组织关系可以驱动邻域、Tree、反向链接和关系过滤，但不得驱动对话列树布局。
- 组织关系不得显示 Token 价格，也不得被转换为引用或结构上下文边；需要改变上下文时，用户必须另建上下文边。

## 4. 关系隔离不变量

以下不变量必须由类型边界、集中谓词和自动化测试共同保证：

1. `buildContext(nodeId, nodes, edges)` 只接收既有 `ThoughtEdge[]`，其签名中不得出现组织关系。
2. 添加、修改或删除任意组织关系前后，同一节点的 context messages、images、layer token、上游指纹和 staleness 结果必须相同。
3. 自动布局、结构环检查、批量重放、随动评审、范式级联、诊断和上下文路径不得遍历组织关系。
4. 组织关系的渲染适配器只能生成视图对象，不得把适配结果回写到项目 `edges`。
5. 新增的知识查询层集中解释上下文边语义；本阶段不强制重写所有既有上下文消费者，但任何新代码不得把组织关系适配边传给它们。
6. 所有组织遍历必须调用独立 selector，例如 `organizationParents()`、`organizationChildren()` 和 `organizationJumps()`。
7. 搜索或视图为了导航而合并两类关系时，合并结果只能存在于查询投影；不得把“可见关系”传给 prompt 构建器。

组织关系隔离回归必须比较关系新增前后的上下文结果与持久位置；任何差异都视为阻断问题。

## 5. 统一查询与视图投影

Canvas、Tree、Card 和搜索结果必须消费同一个纯查询层。组件不得各自实现关系遍历或过滤规则。

```ts
type RelationDomainV2 = 'context' | 'organization' | 'combined';
type RelationScopeV2 =
  | 'all'
  | 'ancestors'
  | 'descendants'
  | 'branch'
  | 'orphans'
  | 'backlinks';

interface KnowledgeQueryV2 {
  text?: string;
  systemKinds?: string[];
  customTypeIds?: string[];
  tagIds?: string[];
  tagMatch?: 'any' | 'all';
  createdAt?: { from?: string; to?: string };
  archived?: 'any' | 'active' | 'archived';
  relation?: {
    domain?: RelationDomainV2;
    scope: RelationScopeV2;
    anchorNodeId?: string;
  };
}

interface KnowledgeProjectionOptionsV2 {
  localDepth?: 0 | 1 | 2;
  activeNodeId?: string | null;
}

interface KnowledgeQueryProjectionV2 {
  candidateNodeIds: string[];
  matchedNodeIds: string[];
  visibleNodeIds: string[];
  hits: KnowledgeQueryHit[];
  activeOutsideFilter: boolean;
  neighborhood: ActiveNeighborhoodProjection | null;
}
```

`visibleNodeIds` 是 `matchedNodeIds` 加上局部模式中不匹配的活动锚点。Tree 与 Card 分别把同一 `visibleNodeIds` 交给纯投影函数；Canvas 保留 `candidateNodeIds` 的空间结构，用共享 `matchedNodeIds` 点亮命中并淡化未命中，同时只渲染两端都在局部候选集的边。非 `all` 关系范围的运行时锚点由共享 `resolveKnowledgeQuery()` 统一注入。

### 5.1 过滤语义

- 不同字段之间按 AND 组合；标签集合内部由 `tagMatch` 决定 any/all。
- `text` 为空时仍必须执行其他条件，不得返回空结果作为捷径。
- 文本搜索沿用问题、当前回答、便签、高亮、链接标题、材料名和显示摘要字段。
- 时间范围使用节点 `createdAt`；缺少时间的旧节点只在没有时间条件时命中。
- `ancestors` 是锚点沿 `structural` 上行的传递闭包。
- `descendants` 是锚点沿 `structural` 下行的传递闭包。
- `branch` 是锚点的结构祖先路径、锚点及从锚点出发的结构后代，不包含兄弟子树。
- `backlinks` 在 context 域表示指向锚点的 reference，在 organization 域表示指向锚点的 jump 或 parent；`combined` 取并集。
- `orphans` 在所选关系域中没有任何有效入边或出边。Frame 是否参与由 `systemKinds` 决定，不允许 selector 暗中排除。
- 关系范围依赖锚点但锚点不存在时，结果必须为空并返回可识别的查询错误，不得退化为全图。
- 结果排序必须稳定；同一排序键相同时以节点 ID 收尾，保证同一图和查询得到相同顺序。

### 5.2 活动节点邻域

必须新增独立的 `activeNodeId`。单选节点会更新它；框选多个节点不得清空上一次活动节点。三个视图都读取和更新同一个活动节点。

局部模式至少包含：

- 活动节点本身；
- 深度范围内的 structural 上下游；
- 活动节点的直接 structural 兄弟；
- 直接 reference 来源和去向；
- 深度范围内的 organization parent/child；
- 直接 organization jump 两端。

过滤器在邻域候选集上执行。即使活动节点不符合过滤条件，也要作为定位锚点保留，并通过 `activeOutsideFilter` 呈现状态；它不计入匹配数量。局部模式只能改变投影视图，切回全图后节点位置、边、选择和事务历史必须与切换前一致。

### 5.3 Tree 与 Card

- Canvas 继续使用上下文结构布局；组织关系不得重排持久化位置。
- Tree 本阶段以项目和组织父子构造虚拟层级；类型和标签通过共享过滤器参与结果裁剪，不额外伪造领域关系。虚拟行引用节点 ID，不复制节点数据。
- 一个节点有多个组织父级时可以出现多行，但每行必须有稳定 projection key；展开必须有 visited guard，不能递归死循环。
- 没有组织父级的节点进入项目根的“未归类”分组。上下文父子可以作为独立的“对话结构”分组显示，但不得伪装成组织父子。
- Card 使用同一过滤结果，按创建日期分组；类型和标签作为组合过滤条件。扩展为类型/标签分组不改变查询协议，可在后续版本增加。
- 在任一视图点击节点，都必须同步 `activeNodeId` 和单选状态；返回 Canvas 时应定位同一节点。
- 视图切换、展开折叠、分组和排序均不得产生领域事务。

## 6. UI/CLI 命令边界

CLI 代理只负责本机鉴权、权限检查、排队和结果传输，不拥有画布状态。新知识整理能力以 Zustand store action 作为领域写入边界：UI 和 CLI 都调用 `connectOrganization`、标签/类型 CRUD 及批量分类 action，不能各自复制校验或直接拼接领域数组。

命令边界必须满足：

- CLI 命令目录统一提供 ID、权限组和参数契约；设置页、代理白名单和页面执行器读取同一目录。
- 读取和导航命令不生成事务；mutation 在一个 store action 内校验并一次性写入。
- 批量标签、批量类型和批量关系操作是一个命令、一个事务，不得循环暴露中间状态。
- 新能力至少提供组织关系增删、标签 CRUD、类型 CRUD 和批量节点分类命令。
- `canvas.get`、完整导出和项目导入包含 v2 领域数据；只读分享包含展示所需的组织关系和分类，但不携带事务日志或语义事件日志。
- 删除标签、类型、组织关系和项目继续遵循危险操作授权；未经授权的 CLI mutation 必须在页面执行前拒绝。
- 校验或权限失败时，状态和事务日志都不得发生部分写入。

## 7. 持久化事务与撤销语义

语义事件日志继续记录“发生过什么”的轻量元数据；它是思考时间线，不是撤销日志。事务日志负责恢复内容，两者不得互相替代。

```ts
interface EntityChangeV2<T> {
  id: string;
  before?: T; // 缺省表示创建
  after?: T;  // 缺省表示删除
  beforeIndex?: number;
  afterIndex?: number;
}

interface DomainTransactionV2 {
  id: string;
  kind: 'change' | 'undo' | 'redo';
  label: string;
  at: string;
  beforeRevision: number;
  afterRevision: number;
  targetId?: string; // undo/redo 指向原 change 事务
  changes: {
    nodes: EntityChangeV2<ThoughtNode>[];
    edges: EntityChangeV2<ThoughtEdge>[];
    organizationRelations: EntityChangeV2<OrganizationRelationV2>[];
    taxonomy?: { before: ProjectTaxonomyV2; after: ProjectTaxonomyV2 };
  };
}

interface TransactionLogV2 {
  revision: number;
  entries: DomainTransactionV2[];
  undoableTransactionIds: string[]; // 原 change 事务 ID
  redoableTransactionIds: string[]; // 原 change 事务 ID
}
```

### 7.1 提交

- 一个 mutation 在内存中完成校验和 change set 计算后，必须把新状态、事务和 revision 作为同一项目持久化提交。
- `before` 和 `after` 是恢复所需的最小实体快照；不得把整个画布复制进每条事务。
- 创建或删除通过缺省 `before` 或 `after` 表达实体不存在，不能使用空对象代替。
- 普通命令成功后加入 `undoStack` 并清空 `redoStack`。
- 事务 ID 和实体 ID 必须稳定且可诊断；不得使用数组下标充当身份。
- 项目切换、完整导出、CLI 传输、自动备份和强制持久化前，必须同步收口兼容写路径的待提交差异，保证图与事务游标属于同一 revision。若正在生成或提取，导出/备份应等待或明确拒绝，不得导出部分流与旧账本的混合状态。
- 不得静默截断可撤销历史。如果未来需要压缩，必须引入显式 checkpoint 和可见的最早恢复边界，不能复用当前内存 `HISTORY_LIMIT`。

### 7.2 撤销与重做

- Undo 取 `undoableTransactionIds` 顶部原命令，反向应用其 change set，并追加一个 `kind: 'undo'` 的补偿事务；原命令 ID 移入 `redoableTransactionIds`。
- Redo 取 `redoableTransactionIds` 顶部原命令，正向应用其 change set，并追加一个 `kind: 'redo'` 的补偿事务；原命令 ID 回到 `undoableTransactionIds`。
- 补偿事务本身不作为新的用户命令压入 undo 栈，但必须保留在 append-only entries 中。
- 刷新或重新打开项目后，undo/redo 栈和 revision 必须从持久化日志恢复。
- Undo 后执行新的普通命令必须清空 redo 栈，但不得删除已经存在的日志条目。
- 项目事务不能撤销另一个项目的内容；项目目录事务不能混入单项目日志。

### 7.3 操作合并

- 节点拖动、Frame 携带拖动和尺寸调整在交互期间可以使用瞬时位置；只在结束时提交一次事务。
- 输入草稿和编辑开关不进入事务；确认后的问题、回答或便签编辑各提交一次。
- `question.ask` 先以一个事务创建节点和入边。流式 chunk 保持瞬时；成功完成、失败落定或用户停止时，再以一个生成结果事务提交最终/部分内容。
- 原地重新生成只在新版本完成或停止时提交一次，不为每个 token 产生事务。
- 批量归档、对齐、标签分配、类型分配、合并和删除均为单事务。

### 7.4 附件

PDF 原始二进制不得重复保存在事务中。PDF 快照只记录附件元数据和稳定 `vaultId`，内容存入独立 vault。图片仍沿用既有的内联表示，因为它们会同步进入视觉上下文；将图片也改为内容寻址存储是独立的后续优化。PDF vault 必须满足：

- 有内联 PDF 字节时，`vaultId` 必须由内容 SHA-256 重算，不得信任导入文件声明的外部 ID；真正相同的 payload 可共用一份内容。
- 当前图或任何保留事务仍引用 `vaultId` 时，不得回收对应内容；
- 删除附件或节点后，Undo 必须能通过原 `vaultId` 恢复内容；
- vault 写入先于领域事务提交，失败的领域提交允许留下待回收孤儿，但不得留下指向不存在内容的已提交事务；
- 完整导出在边界处重新内联内容，导入后再进入 vault；
- vault GC 必须统计所有项目当前状态和保留事务的引用。

## 8. 旧数据迁移

迁移必须同时支持 IndexedDB 中的 Zustand v1 envelope 和现有 `version: 1` 导出文件。

### 8.1 v1 → v2 映射

- 原 `nodes` 原样保留未知字段，并在查询/导入边界把缺省 `tagIds` 解释为空数组；`customTypeId` 缺省。
- 原上下文边原样保留 `isCrossLink`、`isWatch`、handle、branch 标记、创建时间和视觉字段；本阶段不迁移边协议。
- `organizationRelations`、标签和类型定义初始化为空。
- 原 `events` 全量保留。
- 由于 v1 未持久化 undo history，事务日志从当前图的 revision 0 空基线开始；迁移本身不得伪造成用户事务。
- 工作区项目元数据补齐 `kind` 和缺省字段，不改变项目 ID、名称和时间。

### 8.2 迁移规则

- Zustand envelope 的迁移必须幂等；文件导入先在内存完成版本与形状校验，成功后再写入新项目，失败时不得改变当前项目。
- 遗留悬空边不能被静默删除，应保留并交给拓扑诊断；新命令不得创建新的悬空关系。
- 导入高于当前支持版本的文件必须在写入前拒绝，并显示明确版本错误。
- 完整导出必须写明 `schemaVersion: 2`，包含组织关系、taxonomy、events 和 transactions。
- 迁移前后对同一 v1 fixture 的节点、上下文边端点、当前回答版本和 `buildContext()` 输出必须保持一致。

## 9. 验收矩阵

以下用例是最低验收门槛。单元测试验证纯模型和 selector，浏览器测试验证交互，CLI 集成测试验证权限及命令一致性。

| 编号 | 能力 | 前置数据 | 操作 | 必须结果 | 验证层 |
| --- | --- | --- | --- | --- | --- |
| A01 | v1 迁移 | 含 structural/reference/watch、版本回答、附件和 events 的 v1 fixture | 迁移并再次迁移 | 节点和边身份及兼容标记保留；新增集合有安全默认值；context 输出不变 | 单元 |
| A02 | 未来版本保护 | `schemaVersion > 2` 导入文件 | 导入 | 写入前拒绝；当前项目和项目列表不变 | 单元 + 浏览器 |
| A03 | 组织隔离 | 已生成回答的上下文 DAG | 新增 parent 和 jump | messages、images、layer token、fingerprint、staleIds 完全不变 | 单元 |
| A04 | 组织环约束 | `p1 → p2 → p3` parent 链 | 新增 `p3 → p1` | 命令失败；关系和事务数量不变 | 单元 + UI/CLI |
| A05 | 布局兼容 | 多分支、不同实测高度的对话链 | 新增/删除组织关系并整理布局 | 上下文链仍按箭头向下、同链竖直；组织关系不改变持久位置 | 浏览器 |
| A06 | 邻域深度 | `r→a→b`、`a→c`，`d` reference 到 `b`，`p` parent 到 `b`，`j` jump 到 `b`，另有远端 `x` | 以 `b` 开局部 1 层 | 显示 `b/a/c/d/p/j`，隐藏 `r/x`；活动节点保持 | 单元 + 浏览器 |
| A07 | 邻域恢复 | A06 图 | 局部 1 层→2 层→全图 | 2 层加入 `r`；全图恢复 `x`；nodes、edges、位置和事务数不变 | 浏览器 |
| A08 | 标签 CRUD | 两节点、一个标签 | 分配、重命名、删除 | 两节点共享稳定 ID；重命名同步显示；删除原子移除全部引用 | 单元 + 浏览器 |
| A09 | 自定义类型隔离 | 问答、文件各一节点 | 批量设置同一自定义类型 | `stepKind` 不变；渲染行为、上下文和布局语义不变 | 单元 + 浏览器 |
| A10 | 项目隔离 | 两个项目各有 taxonomy | 同名标签分别建立并切换项目 | 定义和分配互不泄漏；导出各自完整 | 浏览器 |
| A11 | 空文本过滤 | 标签、类型、时间和归档状态混合 fixture | 文本留空，仅设置结构化条件 | 按条件返回，不因空文本变成空结果 | 单元 + 浏览器 |
| A12 | 组合过滤 | A11 fixture | 文本+类型+多标签 all+日期+关系范围 | 所有字段按 AND；顺序稳定；Canvas/Tree/Card matched IDs 相同 | 单元 + 浏览器 |
| A13 | 关系范围 | 含祖先、后代、兄弟、reference、organization 的 fixture | 逐一执行 ancestors/descendants/branch/backlinks/orphans | 每种范围只按规范关系域命中，无组织关系进入 context selector | 单元 |
| A14 | Tree 多父 | 一个节点有两个 organization parent | 展开两条父链并点击任一行 | 两行稳定显示且无递归；均激活同一节点 ID | 浏览器 |
| A15 | Card 共享状态 | 已过滤且分组的 Card | 点击节点并切到 Canvas/Tree | 三视图共享活动节点和选择；Canvas 定位该节点 | 浏览器 |
| A16 | 事务原子性 | 多节点批量标签或删除 | 执行一次后 Undo | 产生一个 `change` 事务；一次 Undo 恢复全部实体，无中间态 | 单元 + 浏览器 |
| A17 | 刷新后撤销 | 已连续执行编辑、移动、关系和分类命令 | 硬刷新后连续 Undo/Redo | 栈、revision 和内容恢复；每次补偿事务指向正确原事务 | 浏览器 |
| A18 | Undo 后分叉 | 两条可撤销命令 | Undo 一次后执行新 mutation | redoStack 清空；旧日志保留；新 revision 单调递增 | 单元 + 浏览器 |
| A19 | 流式事务合并 | 一个提问和一次原地重生成 | 完成、停止、失败各执行一次 | chunk 不逐条入日志；每个落定结果最多一个事务；失败无部分 change set | 浏览器 |
| A20 | 附件恢复 | 含 PDF 的节点 | 删除、刷新、Undo、完整导出 | 元数据和 PDF 二进制均恢复；事务不重复内联 PDF payload；导出自包含 | 浏览器 |
| A21 | UI/CLI 等价 | 同一初始 fixture 和同一 mutation payload | 分别从 UI 与 CLI 执行 | 除来源、请求 ID 和时间外，状态及 change set 等价 | 集成 |
| A22 | CLI 权限 | CLI 默认关闭、删除组未授权 | 尝试普通 mutation 和危险删除 | 均在页面执行前拒绝；图和事务日志不变 | 集成 |
| A23 | CLI 导入导出 | 完整 v2 项目 | CLI 导出后导入为新项目 | nodes、context edges、organization、taxonomy、events、transactions 完整往返 | 集成 |
| A24 | 旧能力回归 | 现有示例画布 | 提问、引用/全量切换、陈旧重放、布局、导入导出 | 上下文层次、引用价格、箭头顺序和版本行为无回归 | 浏览器 smoke |

## 10. 合入门槛

相关实现只有同时满足以下条件才可视为完成：

1. Schema v2 的加法字段、兼容迁移和完整导入导出已实现，并通过 A01、A02、A23。
2. 组织关系隔离测试覆盖所有上下文消费者，并通过 A03—A05。
3. 查询 selector 是 Canvas、Tree、Card 的唯一过滤来源，并通过 A06—A15。
4. 新增的组织关系与分类写路径统一进入 store action；兼容写路径由事务安全网覆盖，CLI 不直接拥有领域状态。
5. 持久化 Undo/Redo、附件恢复和项目隔离通过 A16—A20。
6. CLI 的权限目录统一，知识命令复用 store action，并通过 A21—A23 中适用于本阶段的往返与权限用例。
7. `npm run build`、现有 smoke、新增专项测试和本次变更文件的 lint 全部通过；全仓 lint 原则上也必须通过。若干净基线已经存在且仅存在于本次未触碰文件中的 lint 债务，必须逐项记录、证明本次没有新增，并作为独立清理项保留，不能通过放宽规则或忽略目录来制造绿色结果。
8. 未通过上述门槛前，文档和 UI 不得把这些能力描述为已完成。

## 11. 2026-08-28 实施验证记录

本阶段按照第 9 节矩阵分层验证，而不是只以构建成功代替行为验收：

- `npm run test:capabilities` 通过：知识查询 8/8、持久化事务、项目/强制写入/传输边界、附件 vault、CLI 协议、HTTP 鉴权、附件权限、知识命令与 v2 往返、Web 严格导入校验全部通过。
- `npm run build` 通过；仅保留 Vite 对既有混合静态/动态导入和大 chunk 的非阻断提示。
- `npm run smoke` 通过：空项目启动、IndexedDB 写入、刷新恢复、节点渲染全部成功，浏览器控制台无错误。
- 对本次全部变更代码执行定向 ESLint，结果为 0 error / 0 warning；`git diff --check` 通过。
- 浏览器验收确认：局部候选集先于组合过滤执行，未命中的活动节点作为锚点保留；Canvas 保留局部空间结构并淡化未命中节点，Tree/Card 使用同一 `visibleNodeIds`；Card/Tree 激活节点会同步选择并移动底层 Canvas 视口。
- 浏览器验收确认：有向 jump 在按钮和确认框中明确显示 `source → target`，渲染为带箭头的独立组织边；创建、Undo、刷新后 Redo/Undo 均保持上下文边集合和持久位置不变。
- 全仓 `npm run lint` 的干净基线仍有 17 个 error 和 1 个 warning，位于本次未改动的 `src/components/ui/GlobalTooltip.tsx`、`src/components/ui/CondenseDialog.tsx` 与 `video/src/`。本阶段没有修改、隐藏或新增这些问题；它们仍是独立的仓库级清理项。
