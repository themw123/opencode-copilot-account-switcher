# WeChat Opencode 宿主验证闸门设计

## 背景

当前 WeChat 兼容链已经多次暴露同一类问题：仓库内 `npm test` 和大量 Node 单测可以通过，但真正进入 Opencode/Bun 宿主后，`wechat-bind` 仍会在 upstream 微信插件依赖树的运行时装配阶段崩溃。

已暴露的故障面包括：

- `require('jiti')` 在目标宿主中不可用。
- `jiti` 的 `default` / `createJiti` / `module.exports` 形状在不同运行时下不一致。
- 即便绕过 `jiti` 本身，也会继续撞到 `json5` 等更深层 CJS/ESM 互操作边界。

这些问题说明，当前测试体系缺失一条足够接近真实宿主的发布前闸门。WeChat 是目前最先暴露这一问题的链路，但这类“Node 单测绿，真实 Opencode/Bun 宿主炸”的情况不应被视为 WeChat 特例。

## 目标

本设计要达成的目标是：

1. 为 WeChat `wechat-bind` 兼容链建立一条高保真、本地可重复的宿主验证闸门。
2. 让待发布插件产物在接近用户机器的 Opencode/Bun 加载方式下被验证，而不是继续只靠仓库源码直跑单测。
3. 在发布前把“模块加载失败 / 依赖互操作失败 / compat helper 装配失败”这类问题前移暴露。
4. 为项目中其它“与真实 Opencode 宿主差距过大”的测试线提供第一条可复用样板。

## 非目标

本阶段明确不做：

1. 不接入真实微信账号。
2. 不要求真实扫码或真实登录完成。
3. 不模拟完整菜单键盘交互。
4. 不一次性重做整个项目的所有低保真测试。
5. 不把 harness 本身做成完整的 Opencode 进程编排器。

## 总体结论

这条闸门应被定义为：

> 一条面向 WeChat compat 链的发布前宿主验证门槛：它消费接近真实发布形态的插件产物，在临时 opencode-like cache 布局中以 Bun/Opencode 风格加载插件，并真实驱动 `provider adapter -> wechat-bind -> bind-flow -> compat helper` 链，以便在本地稳定暴露宿主层兼容故障，而不是继续依赖用户机器探雷。

## 分层设计

### 1. Artifact 层

职责：

- 生成或收集接近真实发布物的插件产物。
- 明确后续各层消费的不是仓库源码树，而是发布形态输入。

输入：

- 当前仓库工作树。
- `package.json`。
- `dist/` 产物。

输出：

- 一个可被安装进临时 cache layout 的插件产物。
- 第一阶段可以是整理后的目录，也可以是实际 pack 产物；二者都必须尽量逼近 npm 发布形态。

边界：

- 这一层只决定“测什么”，不决定“如何加载”。

### 2. Cache Layout 层

职责：

- 搭建临时的 opencode-like cache 布局。
- 把 Artifact 层产物放进接近 `~/.cache/opencode/package.json` + `node_modules/<plugin>` 的结构里。

输入：

- Artifact 层产物。

输出：

- 临时 cache 根目录。
- 临时 `package.json`。
- 临时 `node_modules/opencode-copilot-account-switcher` 安装形态。

边界：

- 不负责执行插件入口。
- 不负责业务场景驱动。

### 3. Plugin Load 层

职责：

- 用 Bun/Opencode 风格加载插件入口。
- 构造最小宿主上下文，让插件能完成 provider 装配和 action 路由。

输入：

- 临时 cache layout。

输出：

- 已加载的插件实例。
- 可驱动的 provider adapter / action 入口。

边界：

- 这一层先回答“产物能不能以真实宿主方式被加载”。
- 不负责证明业务流程正确结束。

### 4. Scenario Driver 层

职责：

- 驱动一个最小但真实的 WeChat 场景。
- 第一阶段只做：`provider adapter -> wechat-bind -> bind-flow -> compat helper 装配`。

输入：

- Plugin Load 层输出的插件实例与宿主上下文。

输出：

- 结构化结果：
  - `ok: business-path-reached`
  - `failed: module-load`
  - `failed: provider-route`
  - `failed: compat-assembly`
  - `failed: business-error`
- 每个失败结果都要带明确的错误原文与阶段标记。

边界：

- 不是完整 TUI 自动化。
- 不是扫码成功证明。
- 重点是让宿主兼容边界被真实触发并可归类。

## 可扩展性

方案 2 必须设计成可平滑扩到方案 3，而不是一次性 throwaway harness。

可复用层：

- Artifact 层
- Cache Layout 层
- Plugin Load 层
- Scenario Driver 层

未来若要扩到完整交互型，只需要在其上增加：

- Menu/TUI Driver 层
- 必要时的真实进程编排层

也就是说，本阶段不是做一个只服务单个测试的临时 hack，而是在做后续更完整宿主验证的底座。

## 文件落点

### 新增文件

- `test/wechat-opencode-host-gate.test.js`
  - 作为高保真宿主验证闸门的主测试入口。
  - 串起 Artifact / Cache Layout / Plugin Load / Scenario Driver 四层。

- `test/helpers/opencode-host-harness.js`
  - 仅在需要时新增。
  - 负责封装临时 cache 目录、插件产物落位、Bun 风格加载和通用宿主辅助。

### 修改范围

- 第一阶段优先不改生产代码。
- 只有当现有生产入口完全无法被测试侧 harness 驱动时，才允许补最小、通用的测试友好入口。
- 这类入口必须是通用能力，不能是只为单个测试文件写的临时分支。

## 第一阶段必须锁住的断言

1. 插件产物能够被放入临时 opencode-like cache layout。
2. Bun 风格宿主能成功加载插件入口。
3. provider adapter 能实际路由到 `wechat-bind`。
4. `bind-flow` 能真实进入 compat helper 装配阶段。
5. 如果失败，结果必须能明确区分：
   - 插件入口加载失败
   - provider 路由失败
   - compat helper 装配失败
   - bind-flow 业务失败
6. 当前反复踩中的 `jiti/json5/...` 一类宿主解析错误，必须能在 gate 中被本地直接复现和归类。

## 运行命令设计

建议新增一个独立命令：

- `npm run test:wechat-host-gate`

它背后的执行应至少包含：

- `npm run build`
- `node --test test/wechat-opencode-host-gate.test.js`

如果测试内部需要直接驱动 Bun 风格加载，则由测试文件自身调用 Bun/Opencode 风格入口，而不是把 Bun 逻辑散落到别的脚本里。

## 在发布流程中的位置

涉及 WeChat compat / bind 链路的发布前证据，后续应至少包含：

1. `npm test`
2. `npm run test:wechat-host-gate`
3. 两者都通过，才允许 release

这条规则的目的不是追求“零问题”的幻觉，而是禁止再次出现“连真实宿主加载边界都没有本地证明就发版”的发布方式。

## 验证原则

1. 现有 Node 单测继续保留，负责局部语义。
2. 新增 host gate 只负责真实宿主边界，不试图替代所有单测。
3. host gate 必须优先追求失败可定位，而不是把所有错误吞成同一类失败。
4. host gate 第一阶段必须是无真实账号依赖的 deterministic 路径。

## 成功判定

当本设计落地后，团队在发布前至少要能回答：

1. 当前待发布产物在仿真 Opencode/Bun 宿主下，能否稳定走到 `wechat-bind` 真实 compat 链而不在模块层面炸掉。
2. 如果失败，错误是否已经在本地 gate 中被归类并可直接回归验证。
3. WeChat 这条链路是否从“靠用户机器探雷”切换成“靠我们自己的发布前闸门探雷”。

## 为什么值得做

这条闸门的价值，不是让 WeChat 从此绝不出错，而是把当前最昂贵的失败模式关掉：

- 不是再靠用户机器暴露宿主兼容问题。
- 不是在 release 之后才第一次看到 `jiti/json5/...` 这类错误。
- 而是在本地发布前就把这类故障面拉到可重复、可断言、可归类的环境里。
