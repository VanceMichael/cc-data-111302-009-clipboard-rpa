# 跨窗口富内容粘贴的浏览器录入自动化

Node.js 服务，把“从产品资料页复制、到授权发布门户粘贴”的人工录入扩展成可核对的流程。
机器人操作的是真实页面：来源页用 `ClipboardItem` 写入 `text/html` 与 `text/plain`，门户在
`paste` 事件里读取真实 `clipboardData` 并异步清理，机器人在目标编辑区发送真实
`Control+V`，等待清理完成后回读结果。不存在绕过页面的后台写库路径。

## 环境与命令

Node.js 22.20.0 或更新的 22.x。依赖由 package-lock.json 锁定。

```sh
npm ci --ignore-scripts
npm run build
npm test
npm start          # 启动来源 + 机器人操作台
npm run demo       # 单次完整演示：复制 → 核对 → 粘贴 → 清理 → 回读
```

`npm start` 在同一进程启动来源模拟服务与机器人服务，并在标准输出报告两者的地址：

```json
{"service":"http://127.0.0.1:PORT","source":"http://127.0.0.1:SOURCE","portal":"http://127.0.0.1:SOURCE/portal.html","status":"机器人服务就绪"}
```

`HOST`/`PORT` 指定机器人服务监听地址；`SOURCE_URL`/`PORTAL_URL` 可把机器人指向已有来源；
`SANITIZE_DELAY` 调整门户异步清理延迟；`RECORD_DIR` 指定记录持久化目录；`SETTLE_TIMEOUT_MS`
设置等待清理超时。默认绑定本机回环地址并使用动态端口。

```sh
docker build -t clipboard-rpa:local .
docker run --rm --network none clipboard-rpa:local
docker run --rm --network none clipboard-rpa:local npm run demo
```

依赖在镜像构建阶段安装，运行阶段不需要公网。容器已带匹配版本的 Chromium。

## 操作台与接口

浏览器打开 `http://127.0.0.1:PORT/` 即“剪贴板录入操作台”：选择产品与资料员后创建记录，
再逐项执行粘贴/重新复制/暂停/换人继续/确认降级/标记完成。来源页与门户页也可在该服务下
直接打开对照（`/index.html`、`/portal.html`）。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/records` | 列出记录摘要 |
| `POST /api/records` | `{product, accountant}`：新建记录并执行一次真实复制与剪贴板核对 |
| `GET /api/records/:id` | 完整记录（复制来源、剪贴板核对、粘贴事件、清理、回读、待确认项） |
| `POST /api/records/:id/paste` | 粘贴并等待异步清理、回读；可选 `settleTimeoutMs` |
| `POST /api/records/:id/recopy` | 重新从来源页复制并核对 |
| `POST /api/records/:id/pause` | 暂停并清空本上下文的剪贴板 |
| `POST /api/records/:id/resume` | `{accountant}`：换人继续；清空剪贴板后重新复制 |
| `POST /api/records/:id/acknowledge` | `{accountant, ids?, note?}`：资料员逐项确认降级 |
| `POST /api/records/:id/publish` | 仅在清理完成、无未解决问题、无未确认降级项时标记完成 |
| `GET /api/events` | Server-Sent Events，推送记录状态变化 |
| `GET /api/clipboard` | 读取当前上下文的剪贴板表示 |
| `POST /api/clipboard/clear` | 主动清空剪贴板 |

`/inventory`、`/state`、`/control` 原样转发到来源服务；`/control` 仅用于测试和演示推进资料版本，
不是业务写入接口。

## 核对协议

1. **复制动作可追溯**：来源页每次点击“复制资料”生成随机 token，写入 HTML 开头的
   `<!--clipboard-copy token=… product=… version=…-->` 标记以及 `article[data-product]`/
   `[data-version]`。页面同时把本次动作记录为 `window.__lastCopy`。
2. **复制前清空**：每条记录（以及暂停、换人、重新复制）先清空机器人自己浏览器上下文的剪贴板，
   避免把上一位资料员或上一条产品的内容带进本次动作。
3. **粘贴前核对**：用 Clipboard API 读取两种表示，校验 token、产品、版本、标题；任何一项不符
   都以 `clipboard-*` 码阻止粘贴，不发送键盘事件。
4. **真实粘贴**：门户编辑区必须实际获得焦点；机器人发送 `Control+V`，并在门户真实的 `paste`
   监听器旁挂探针，记录 `clipboardData.types`、HTML/纯文本，以及被采用的表示。
5. **等待清理**：门户清理是异步的，且编辑区失焦时会暂停。机器人轮询 `data-settled`、
   `data-cleaning` 与门户状态，暂停时可自动恢复焦点；超时则记为 `interrupted`，不会把一次
   键盘操作当作业务完成。
6. **回读比对**：清理完成后结构化回读标题、段落、表格、链接、图片与残留的不支持标签，与
   复制时的产品模型比对，输出 `issues`（未解决）和 `confirmations`（降级/人工待确认项）。

## 记录内容

每条记录持久化（`RECORD_DIR` 或内存）包含：

- `copy`：来源页、来源 URL、产品、版本、复制时间、本次 token、复制时的产品模型；
- `previousClipboard`：本次复制前剪贴板里是否还有内容（跨记录/跨人的残留检测）；
- `clipboard`：两种表示、核对结果、标记、被采用的表示；
- `paste`：键盘操作、焦点、paste 事件中实际看到的类型/标记、被采用的表示；
- `cleanup`：是否完成、等待时长、暂停次数、焦点恢复次数；
- `readback`：清理后的标题、段落、链接、表格、图片、残留标签；
- `confirmations`：明确的降级/待确认项，例如“门户不支持图片，图片已被清理”“http 链接地址被移除，
  只保留文字”“清理因失焦暂停后恢复”；
- `issues`、`handovers`、`history`。

## 明确降级，不声称原样保留

门户清理会删除图片、`http:` 链接地址与脚本类标签。机器人保留产品标题、段落、允许的 `https:`
链接与简单表格关系，同时把无法保留的结构写入 `confirmations`，在操作台上要求资料员逐项确认；
未确认前 `publish` 会被拒绝（`confirmations-open`）。若门户只收到纯文本，代码为
`structure-flattened`，表格与链接关系按降级处理。

## 目录

- `src/source.mjs`：来源页/门户页/控制接口的生命周期与 HTTP 入口。
- `src/agent.mjs`：复制、核对、真实粘贴、等待清理、回读与记录编排。
- `src/clipboard.mjs`：浏览器侧探针、剪贴板校对、粘贴表示判定与回读比对。
- `src/records.mjs`：记录持久化与摘要。
- `src/serve.mjs`：机器人服务与操作台入口。
- `src/demo.mjs`：单次完整演示。
- `public/index.html`、`public/portal.html`：来源页与门户页（合成业务资料）。
- `public/agent.html`：操作台。
- `fixtures/source.json`：来源初始目录。
- `docs/source-contract.md`：来源协议与页面契约。
- `test/agent.test.mjs`：真实浏览器剪贴板、粘贴事件、抢占与异步清理测试。
- `test/source.test.mjs`、`test/startup.test.mjs`：来源与启动测试。

来源模拟运行时状态仅在内存，重启回到 fixtures。页面与记录均为合成数据，不含真实个人资料或凭据。
在宿主机跑浏览器测试前执行 `npx playwright install --with-deps chromium`；容器已带匹配版本。
