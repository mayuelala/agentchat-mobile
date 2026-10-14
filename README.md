# AgentChat Mobile

一个不依赖后端的单文件移动网页客户端，使用自定义 Responses API，并提供应用内多 Agent 协作。

- 默认接口：`https://modelservice.jdcloud.com/v1`
- 默认模型：`gpt-5.6-sol`
- 支持 `@研究员`、`@工程师`、`@审阅者`、`@写作者`
- 左侧历史对话栏：新建、切换、删除并自动保存
- 可通过输入 `@` 或历史栏中的 `@`，让其他对话携带自身上下文参与协作
- 支持 iPhone 相机、相册和多附件预览
- 支持图片、PDF、Word、TXT、Markdown、CSV、JSON、XML、HTML、RTF
- 可从 iPhone Safari 添加到主屏幕

仓库不包含 API Key。密钥由用户首次打开时填写，仅保存在当前浏览器的本地存储中，并直接发送给用户设置的接口。

附件正文保存在浏览器 IndexedDB 中，不会上传到 GitHub；调用模型时才直接发送给用户配置的接口。单个附件最大 10 MB，每条消息最多 5 个附件。
