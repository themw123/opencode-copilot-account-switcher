# WeChat 真实 Opencode 宿主验证闸门设计

## 背景

当前 `test:wechat-host-gate` 已经证明一件事：仅靠 `package/dist -> cache layout -> plugin.js / adapter` 级别的宿主仿真，还不足以稳定复现 Robin 机器上真实出现过的 WeChat bind 宿主错误。

现有证据链表明：

- `adapter` 直调路径会失真，曾把问题误导成 `qr-wait`。
- 将入口抬到 `dist/plugin.js -> CopilotAccountSwitcher()` 后，结果又变成 `plugin-authorize-timeout`。
- 这说明当前仿真仍然缺少一层关键宿主语义：真实 `opencode` 进程自己的插件安装、插件加载、菜单链与运行时边界。

因此，现有 `test:wechat-host-gate` 不能继续默认占据 WeChat 发布前 gate 的位置。新的设计目标不是“再加一层测试”，而是用一条更真实的 gate 去替换掉不够真的发布前门槛。

## 目标

本设计要达成的目标是：

1. 建立一条以真实 `opencode` 进程为核心的 WeChat 宿主验证闸门。
2. 在完全隔离的临时宿主中，通过真实宿主可 load 的本地插件形态和真实菜单链复现 `微信通知 -> 绑定 / 重绑微信`。
3. 优先在本地复现 Robin 机器上已经出现过的原始错误文本，例如：
   - `wechat bind failed: Missing 'default' export in module '...json5/lib/index.js'`
4. 保证 gate 不污染开发者正在使用的真实 `opencode` 环境。
5. 为没装 `opencode`、版本不同或环境不一致的开发者提供可诊断路径；当前第一阶段只保证明确给出 `host-bootstrap-failed`，不宣称已实现真正自举运行体。

## 非目标

本阶段不做：

1. 不要求真实扫码成功。
2. 不要求把整条登录流程跑到成功完成。
3. 不要求第一阶段覆盖所有 provider。
4. 不要求保留旧的模拟型 host gate；它可以在真实 gate 稳定后被移除。
5. 不把当前设计扩展成完整的通用 TUI 自动化框架。

## 总体结论

新的 WeChat 发布前 gate 应定义为：

> 一条隔离型、基于真实 `opencode` 进程的宿主验证闸门。第一阶段依赖本机已有可运行 `opencode`；缺失时以 `host-bootstrap-failed` 提供可诊断失败。它通过临时宿主目录隔离数据目录与配置、以真实宿主可 load 的本地插件形态 `dist/index.js` 引入待测包，并真实驱动 `微信通知 -> 绑定 / 重绑微信` 完整菜单链，最终以原始错误文本或二维码等待边界作为验证证据。

旧的 `test:wechat-host-gate` 已从当前工作树移除；真实 `opencode` 宿主 gate 现在是唯一保留的 WeChat 宿主验证入口。

## 分层设计

### 1. Runtime Bootstrap 层

职责：

- 准备一个完全隔离的临时 `opencode` 宿主。
- 为真实 gate 提供独立的 cache / config / data / logs 根目录。
- 当前第一阶段只解析本机已可运行的 `opencode`；缺失时明确返回 `host-bootstrap-failed`，不宣称已实现真正自举下载/安装运行体。

输入：

- 当前仓库。
- 目标 `opencode` 版本约束。

输出：

- 一个临时宿主根目录。
- 一个可调用的 `opencode` 运行体路径。
- 与当前用户真实环境隔离的 cache / config / session / log 目录。

边界：

- 只负责“宿主从哪里来、数据放哪里”。
- 不负责安装插件，也不负责业务菜单驱动。

关键原则：

- 默认不能写入开发者真实的 `~/.cache/opencode`、真实配置目录或真实会话目录。
- 如果拿不到可运行的 `opencode`，必须明确给出 `host-bootstrap-failed`，而不是默默跳过。

### 2. Plugin Install 层

职责：

- 把待测插件以真实宿主会消费的方式装进临时 `opencode` 宿主。
- 当前第一阶段锁定真实宿主可 load 的本地插件形态为 `dist/index.js` 文件路径，不再把本地目录插件配置或 `package@file:<tgz>` 当作默认前提。
- 当前 `plugin-install-failed` 的主要保障来自 helper / unit-level 断言，不宣称第一阶段已经由完整真实集成链单独锁住整条安装失败链。

输入：

- 当前工作树打出的待测产物。
- 临时宿主根目录与 `opencode` 运行体。

输出：

- 临时宿主内可被真实 `opencode` 加载的本地插件 spec 与安装结果。

边界：

- 只负责“插件如何被装进去”。
- 不负责启动进程或驱动菜单链。

### 3. Real Process Driver 层

职责：

- 启动真实 `opencode` 进程。
- 把它固定在临时宿主根目录里运行。
- 暴露可被观察和驱动的 stdout / stderr / 日志 / 退出状态。

输入：

- 临时宿主。
- 已安装插件。

输出：

- 一个可被脚本控制与观察的真实 `opencode` 进程。

边界：

- 这里只负责“真实进程起来并可驱动”。
- 不直接定义菜单动作或业务成功条件。

### 4. Menu Chain Driver 层

职责：

- 通过真实入口 `providers login --provider github-copilot --method "Manage GitHub Copilot accounts"` 进入插件菜单。
- 等待 `Add credential` 后发送 `Enter`，进入插件菜单后再用 12 次 `DOWN` + `Enter` 打开 `微信通知` 子菜单。
- 真实走到完整菜单链：
  - `微信通知`
  - `绑定 / 重绑微信`
- 捕获菜单路径事件与最终控制台/日志错误原文。

输入：

- 正在运行的 `opencode` 进程。

输出：

- 菜单路径轨迹。
- 最终错误文本或二维码等待状态。
- 结构化阶段结果。

边界：

- 第一阶段不要求扫码成功。
- 但必须把“到达绑定菜单 -> 触发绑定 -> 报错或进入二维码等待”完整跑出来。

### 5. Failure Classifier 层

职责：

- 把真实进程结果收成可回归、可断言的阶段结论。

第一阶段至少要区分：

- `host-bootstrap-failed`
- `plugin-install-failed`
- `menu-chain-failed`
- `wechat-bind-import-failed`
- `wechat-bind-runtime-failed`
- `qr-wait-reached`

关键点：

- 若能复现 Robin 真机上的原始错误，例如 `wechat bind failed: Missing 'default' export in module '...json5/lib/index.js'`，必须原样保留并断言。
- 如果没有导入错误而是正常推进到二维码等待，则必须落成 `qr-wait-reached`，而不是笼统 success。

## 文件落点

### 旧 harness 的处理

已删除：

- `test/helpers/opencode-host-harness.js`
- `test/wechat-opencode-host-gate.test.js`

定位：

- 旧的模拟型 host gate 不再保留运行入口。
- WeChat 宿主验证统一收敛到真实 `opencode` 宿主 gate。

### 新增文件

- `test/helpers/opencode-real-host-harness.js`
  - 负责隔离宿主目录、解析本机可运行 `opencode`、基于 `dist/index.js` 的本地插件形态准备、真实进程启动、菜单驱动与日志采集。

- `test/wechat-opencode-real-host-gate.test.js`
  - 负责串起 Runtime Bootstrap / Plugin Install / Real Process Driver / Menu Chain Driver / Failure Classifier。
  - 负责锁定完整菜单链与最终错误文本。

### 需要修改的文件

- `package.json`
  - 新增 `test:wechat-real-host-gate`。

- `docs/superpowers/specs/2026-04-03-wechat-real-opencode-host-gate-design.md`
  - 最小同步真实宿主可 load 形态、命令口径与旧 gate 删除说明。

## 命令设计

真实宿主 gate 命令：

- `npm run test:wechat-real-host-gate`

涉及 WeChat bind / compat 链路的发布前证据，后续应改为：

1. `npm test`
2. `npm run test:wechat-real-host-gate`

当前发布前 WeChat 宿主验证命令统一为 `npm run test:wechat-real-host-gate`。

只有真实宿主 gate 通过，才允许发布。

## 第一阶段必须锁住的断言

1. 隔离宿主不会污染开发者真实 `opencode` 数据目录。
2. 待测插件以真实宿主可 load 的本地插件形态进入临时宿主；当前第一阶段锁定为 `dist/index.js` 文件路径，而不是手工塞文件、本地目录插件配置或 `package@file:<tgz>`；对应的 `plugin-install-failed` 目前主要由 helper / unit-level 断言保障。
3. 真实 `opencode` 进程能启动并被脚本观察。
4. 菜单链能真实走到：`微信通知 -> 绑定 / 重绑微信`。
5. 如果失败，能拿到原始错误文本并归类。
6. 已知 Robin 真机错误（如 `json5` 那类）如果能在本机复现，必须被原样保留并断言。
7. 若没有导入错误而是到达二维码等待，则明确落成 `qr-wait-reached`。

## 迁移策略

1. 真实 `test:wechat-real-host-gate` 已成为 WeChat 宿主验证的唯一保留入口。
2. 旧的模拟型 host gate 已删除，不再参与发布前证据链。

## 失败策略

1. 若自举失败，必须报 `host-bootstrap-failed`。
2. 若插件安装失败，必须报 `plugin-install-failed`。
3. 若菜单链走不到“绑定 / 重绑微信”，必须报 `menu-chain-failed`。
4. 只有当错误文本确实来自 `wechat bind failed: ...` 这条链时，才进一步进入 import/runtime 分类。

## 成功判定

新的真实宿主 gate 第一阶段的成功不是“绑定成功”，而是：

1. 能在隔离宿主里稳定启动真实 `opencode` 进程。
2. 能以真实宿主可 load 的本地插件形态装入待测插件，且当前第一阶段锁定为 `dist/index.js` 文件路径。
3. 能真实走到完整菜单链。
4. 若本机可复现 Robin 真机错误，则能把原始错误文本在本地锁住。
5. 若本机未复现导入错误而是到达二维码等待，则能明确落成 `qr-wait-reached`。

## 为什么这比当前 gate 更值得信任

因为它最终判定的是：

- 真实 `opencode` 进程
- 真实宿主可 load 的本地插件形态（当前第一阶段是 `dist/index.js` 文件路径）
- 真实菜单链

而不是我们手工拼出的 `plugin.js` / `adapter` 层仿真。

这条 gate 的价值不在于承诺“从此零问题”，而在于把“是否真的还原了真实宿主边界”作为发布前门槛，而不是再让不够真的 harness 继续占住 release gate 的位置。
