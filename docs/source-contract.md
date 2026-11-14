# 来源协议

## 页面

- `/index.html`：目录由 `GET /inventory` 渲染。每个产品一个 `article`，带
  `data-product`、`data-version`，含标题、段落、图片、表格与链接。每个产品有
  `.copy[data-product]` 复制按钮，P-1 另有 `#change` 更新版本按钮。
- 复制按钮用 `navigator.clipboard.write([new ClipboardItem({'text/html', 'text/plain'})])`
  同时写入两种表示。HTML 开头是本次动作标记：
  `<!--clipboard-copy token="<uuid>" product="P-1" version="1"-->`，随后是 `article.outerHTML`。
  纯文本为 `article.innerText`。成功时 `#copied` 变成“已复制”，并把本次动作放在
  `window.__lastCopy = {token, product, version, html, plain, at}`。失败时 `#copied` 显示“复制失败”，
  `window.__lastCopyError` 记录错误。
- `/portal.html`：`#editor` 是 `contenteditable`，`#status` 显示“清理中”/“等待焦点”/“已清理”。
  `paste` 监听器 `preventDefault()` 后读取真实 `clipboardData`：有 `text/html` 用 HTML，否则用
  `text/plain`，随后异步清理（默认 100ms，可用 `?sanitizeDelay=` 调整），清理后设
  `editor.dataset.settled="true"`、`editor.dataset.cleaning="done"`。
  清理会删除 `script/style/img/iframe/video/audio/object/embed/link/meta/form/input/button/textarea/select`
  与 `on*` 属性，并把非 `https:` 链接的 `href` 移除、只留文字。
  编辑区或窗口失焦会暂停待执行的清理（`dataset.cleaning="paused"`、`#status` 显示“等待焦点”），
  重新聚焦后重新计时。
- `/blank.html`：机器人自用的空白页，不承载业务内容。
- 来源与门户必须在同一浏览器上下文中加载，共享同一个系统剪贴板；跨上下文的剪贴板不共享。

## 控制

- `GET /inventory` 返回目录（`products` 下按产品编号存放产品模型）。
- `GET /health` 检查存活。
- `GET /state` 查看来源状态。
- `POST /control` 接收 JSON，仅支持 `product`、`version`、`paragraph`：
  `{"product":"P-1","version":2}` 把 P-1 版本推进到 2 并更新第一段。未知字段或未知产品返回 400。
- 每次创建服务重新读取 `fixtures/source.json`；控制用于复现来源演进，不是采集业务的实现接口。
- `/state` 与 `/control` 是本地操作设施，不能作为绕过浏览器页面的业务写入捷径。

服务使用随机本地端口，测试启动与关闭均由代码负责。没有真实个人资料、凭据或付费调用。
浏览器需授权 `clipboard-read`、`clipboard-write`。
