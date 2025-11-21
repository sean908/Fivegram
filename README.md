# Fivegram

基于 [open-wegram-bot](https://github.com/wozulong/open-wegram-bot) 和 [TG-RUbot](https://github.com/RU-Sirius/TG-RUbot) 的 Telegram 私聊转发 Bot

为每个用户创建独立 Forum Topic 实现消息隔离  
使用 Cloudflare KV 存储突破 4096 字符限制


## ✨ 核心特性

- **🔒 消息隔离**: 每个用户自动创建独立 Topic，保持群内对话整洁
- **💾 KV 存储**: 使用 Cloudflare KV 存储元数据，支持 1000+ 映射记录
- **👥 管理员检测**: 动态识别 Supergroup 管理员，自动跳过转发
- **🔄 双向同步**: 支持消息编辑、删除
- **🛡️ 自动修复**: 检测 Topic 失效并自动清理映射，防止重复错误


## 🚀 快速开始 - GitHub & Cloudflare 快速部署

### 前置准备

- Cloudflare 账号（免费）
- GitHub 账号
- Telegram Bot Token（从 [@BotFather](https://t.me/BotFather) 获取）
- 你的 Telegram UID（从 [@userinfobot](https://t.me/userinfobot) 获取）

### 部署步骤

#### 1. Fork / Clone 仓库

#### 2. 创建 KV Namespace

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **KV** 页面
3. 点击 **Create a namespace**，名称设为 `MESSAGE_MAPPING`<sup> 名称可**自定义**</sup>
4. 记录 ***Namespace ID***

#### 3. 填写 *wrangler.toml* 配置

- 在 `[[kv_namespaces]]` 的 **id** 填入上一步创建的 ***Namespace ID***
- <sup>可选 </sup> `[vars]` 的 **PREFIX** 可以按自己喜好修改

#### 3. 连接 GitHub 自动部署

1. 在 Cloudflare Dashboard 进入 **Workers & Pages**
2. 点击 **Create application** > **Workers** > **Import a repository**
3. 选择 Fork / Clone 的仓库
4. 为该 Worker 取个名称（如 `fivegram`）
5. **Build command** (**空**)
6. **Deploy command** `npx wrangler deploy`(**默认**应该就是这个)
7. 点击 **Create and Deploy**

#### 4. 配置环境变量和 KV

在 Worker 的 **Settings** > **Variables and Secrets** 中修改：

| 变量名         | 类型      | 值                   | 说明                                                   |
| -------------- | --------- | -------------------- | ------------------------------------------------------ |
| `PREFIX`       | Plaintext | `fivegram`           | URL 路径前缀                                           |
| `SECRET_TOKEN` | Secret    | `Your16CharToken123` | Webhook 验证密钥（16+ 字符, 包含**大、小写以及数字**） |

点击 **Save and deploy**。

#### 5. 注册 Webhook

访问以下 URL 注册 Bot Webhook：

```
https://your-worker.workers.dev/{PREFIX}/install/{YOUR_UID}/{BOT_TOKEN}
```

成功后返回：

```json
{"ok":true,"result":{"url":"https://...","pending_update_count":0}}
```

#### 6. 初始化 Group

1. 启用你将用来转发的 Bot(在与它的聊天框中点击 **Start**)
2. 创建 Telegram group 并开启 **Topics** 功能
3. 将 Bot 添加为管理员，授予以下权限：
   - ✅ Manage Topics
   - ✅ Delete Messages
   - ✅ Pin Messages
4. 在 **General Topic** 中发送 `/init`

看到"初始化完成"提示即可开始使用！


## 主要命令

| 命令              | 使用位置                    | 说明                     |
| ----------------- | --------------------------- | ------------------------ |
| `/start`          | 机器人私聊                  | 查看使用说明             |
| `/init`           | Supergroup 的 General Topic | 初始化 Supergroup 绑定   |
| `/reset`          | Supergroup 的 General Topic | 清理 KV 映射并删除 Topic |
| `/status`         | 机器人私聊                  | 查看当前配置状态         |
| `/ban` / `/unban` | Supergroup 的 对话Topic     | 拉黑/解禁用户 Topic      |
| `#del`            | Supergroup 的 对话Topic     | 删除消息（通过回复触发） |


## 工具特性

- 每个用户独立 Topic，消息隔离
- 消息映射保存在 Cloudflare KV（支持 1000+ 条记录）
- 自动同步消息编辑、删除、Emoji Reactions
- 管理员消息自动跳过转发


## 🙏 参考项目

本项目基于以下开源项目开发：

- [open-wegram-bot](https://github.com/wozulong/open-wegram-bot)
- [TG-RUbot](https://github.com/RU-Sirius/TG-RUbot)

感谢原作者的贡献！


## 📄 许可证

本项目采用 **GPL v3** 许可证 - 详见 [LICENSE](LICENSE)


## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

**版本**: v0.2.1
**文档更新**: 2025/11/19
