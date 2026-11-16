# 上架准备清单

上架到 DSH 插件市场**不需要任何权限或官方批准**——它是开源目录的 PR 收录制。
你只需要一个公开 GitHub 仓库，然后去 `awesome-dsh-plugin` 提一个 PR。

---

## 一、已替你准备好的（代码侧，已完成）

| 项 | 状态 | 说明 |
|---|---|---|
| `dsh.bundle` 清单 | ✅ 已有 | `{"patch": "./cordis.patch.yml"}`。这是**最常被拒**的一条，只写 `dsh.client` 会被打回 |
| `cordis.patch.yml` 在根目录 | ✅ 已有 | 内容正确 |
| 真实可用代码 | ✅ | 非占位、非 README-only |
| 零依赖、无构建 | ✅ | 装的时候不用 pnpm build，评委看着舒服 |
| `engines.dsh` 预发布兼容 | ✅ **本轮已修** | 原先写 `>=0.2.0-rc.1 <0.3.0-0`，按 node-semver 规则**匹配不到你自己在跑的 0.2.2-rc.3**，上架后会被标成不兼容。现改为覆盖 0.2.x 全系预发布 |
| 文案与行为一致 | ✅ **本轮已修** | 全项目已无「每秒」字样，统一为「实时」；实际是 2 秒刷新，不会与代码矛盾 |
| 自检 | ✅ 55/55 全绿 | `node tools/selfcheck.mjs` |

---

## 二、GitHub 仓库（已完成 ✅）

- 仓库：https://github.com/EddyLee1010/wage-calculator
- 公开可访问（匿名读取 HTTP 200）
- `main` 分支已推送，本地与远端同步
- `package.json` 已含 `repository` / `homepage` / `bugs` / `author`
- 远端 `package.json` 已验证含 `dsh.bundle`，`cordis.patch.yml`、`client.js`、`index.js`、`locale/*.json` 均可访问

### 还剩两步

**① 给仓库打 topic**（硬性要求，CI 会查）

仓库页面右侧 About 区域的齿轮 → 添加 topic：**`dsh-plugin`**

**② 等满 1 天**

仓库**创建满 1 天**才能提 PR，CI 自动检查。这是为了过滤「PR 前几分钟才建仓」的情况，不是对你插件的评价。

---

## 三、提 PR（一个文件就够）

仓库：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin

Fork → 新建文件 `data/plugins/EddyLee1010__wage-calculator.yml` → 内容直接复制 `docs/market-entry.yml`（用户名和 URL 都已填好）→ 提 PR。

**注意：只加这一个文件，不要手改 README**（README 由脚本生成，手改必然冲突）。

---

## 四、评审会看什么（提前知道，少被退回）

1. **代码是否真做了描述里说的事** —— 会把描述对着源码核，包括数字和 API 名
2. **分类是否合理** —— 选不准不会被打回，维护者会直接改。工资计时器放 `fun` 或 `usage` 都行
3. **是否真实代码**，非占位
4. **是否与已有插件重复** —— 重复时不看谁先来，看谁做得更好
5. **源码有无可疑之处** —— 混淆、外传凭据等

> 收录**不等于安全审查**。你可以在描述里点明「零依赖、不联网、配置只存本地」——这是加分项。

---

## 五、上架前建议先解决的一件事 ⚠️

**「切到别的标签再切回来，设置会不会被重置」这个还没验证。**

如果会重置，用户装完第一条反馈就是这个，而且会落在评论区（dsh-market 的评论是 GitHub Discussions，公开可见）。

**测法**：填月薪 `88888`、每月 `17` 天 → 保存 → 切到别的对话再切回 → 看是否还是 88888。

- 还在 → 放心上架
- 变回 12000 → 先修（需要改走 Host 端持久化），修好再上

---

## 六、可选加分项（不影响收录）

- **发布到 npm**：能让市场显示下载量、排序。发布后 `package.json` 的 `repository` 字段必须指回你的仓库
- **截图**：在你仓库根放 `screenshots.json`，列出 1–8 张图片路径，市场详情页会展示
- **图标**：GitHub 托管的 png/jpg/webp（**不要 SVG**），约 96px 方形最佳

---

## 七、你准备好仓库后，告诉我地址

以上都已填好并推送：

- `package.json` 的 `repository`、`homepage`、`bugs`、`author` ✅
- `docs/market-entry.yml` 里的用户名与 URL ✅
- README 补充了「零依赖、不联网、配置只存本地」的说明 ✅

现在只剩：**打 topic → 等满 1 天 → 提 PR**。
