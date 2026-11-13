# 来源协议

来源页复制按钮会用 ClipboardItem 同时写HTML和纯文本，产品与版本在 data-product、data-version 中。门户 editor 是 contenteditable，paste监听器读取真实clipboardData，100ms后清除不支持标签并标记 settled。/control 可推进资料版本。浏览器需授权clipboard-read、clipboard-write。页面地址/portal.html是目标窗口。

## 通用控制

`GET /inventory` 返回本来源当前目录，`GET /health` 检查存活，`GET /state` 查看来源状态。`POST /control` 接收JSON对象，仅在来源支持的字段范围内操作。每次创建服务重新读取 fixtures/source.json；控制用于复现来源演进，不是采集业务的实现接口。

服务使用随机本地端口，测试启动与关闭均由代码负责。没有真实个人资料、凭据或付费调用。
