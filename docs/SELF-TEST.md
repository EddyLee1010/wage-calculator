# 自验流程：改代码 → 推送 → 本地更新 → 刷新验证

这套流程让你**用朋友的身份**验证自己的插件：本地装的是 GitHub 上的副本，不是你的源码目录。改源码不会偷偷生效，必须走完推送+更新才生效——和别人的体验一致。

---

## 当前状态（已完成切换）

| 项 | 值 |
|---|---|
| 依赖声明 | `github:EddyLee1010/wage-calculator` |
| node_modules 形态 | 真实目录（从 GitHub 下载的副本） |
| 锁定的 commit | `6d23448` |
| 装的版本 | 0.1.0 |
| 本地源码目录 | `/Users/xone/五行三界外/wage-calculator` |

`node_modules/wage-calculator` 现在是**普通目录**，改源码目录里的文件**不会**影响已装的插件。这正是自验需要的隔离。

---

## 每次验证走这四步

### 1. 在源码目录改代码

```bash
cd /Users/xone/五行三界外/wage-calculator
# 改 client.js 等文件
```

改完**先在本地自检**，别把有问题的代码推上去：

```bash
node --check client.js
node tools/selfcheck.mjs
```

看到 `自检 N/N 全绿` 才算过。

### 2. 提交并推送

```bash
git add -A
git commit -m "描述你改了什么"
git push origin main
```

### 3. 让本地装上新版本

因为 pnpm 把依赖锁定在具体 commit 上，**推送后不会自动更新**。要重新安装一次：

在对话里让 Agent 执行（推荐，走正规路径）：

```
帮我重新安装 wage-calculator，target 用
https://github.com/EddyLee1010/wage-calculator.git
```

> ⚠️ **必须用完整 HTTPS URL**，不要用 `github:EddyLee1010/wage-calculator` 这种简写。
> 实测：简写形式会 5 秒超时失败，完整 URL 会先超时一次然后重试成功。这是网络环境导致的，不是你配置错了。

如果 Agent 装的时候报「already up to date」之类，可以先移除再装：

```
先 remove_bundle wage-calculator，再用
https://github.com/EddyLee1010/wage-calculator.git 安装
```

### 4. 重启应用验证

**完全退出 DeepSeek Harness 再打开**（不是最小化，是退出）。

然后像第一次用一样：填月薪等参数 → 点开始 → 观察效果。

---

## 怎么确认装的是新版本

装完可以让 Agent 检查锁定的 commit 是否变成你刚推的那个：

```bash
grep -A1 "wage-calculator:" ~/.dsh/profiles/desktop/pnpm-lock.yaml | head -3
```

看到 `tar.gz/<你刚推的commit前7位>` 就说明更新成功了。

---

## 切换到「朋友怎么装」的验证

这套流程本身就是朋友会经历的过程，唯一区别：

- **朋友**：第一次装，直接 `install_bundle`
- **你**：装了改、改了装，多几次循环

所以你验证过没问题，朋友装就不会有问题——**除了**版本兼容性（朋友的 Harness 版本可能比你老）。

---

## 底层的两件事（了解即可）

**1. 为什么是真实目录而不是符号链接**

- 符号链接（`link:`）：`node_modules` 里只是个指针指向你的源码，改源码立刻生效 —— 这适合开发，但**测不出真实用户体验**
- GitHub 依赖：pnpm 下载一份副本放进去，与源码目录完全隔离 —— **这才是朋友装到的东西**

**2. 为什么更新要重新安装**

pnpm 会把 GitHub 依赖锁定到具体 commit（写在 `pnpm-lock.yaml` 里）。这是为了「可复现」——同一个锁定文件在任何机器上装出完全一样的东西。代价就是你推了新代码，本地不会自动感知，必须重新解析依赖。

---

## 万一出问题想退回开发模式

把插件换回符号链接（改源码即生效）：

```
先 remove_bundle wage-calculator
然后 install_bundle，target 填 /Users/xone/五行三界外/wage-calculator
```

用**本地目录路径**装，就会变回 `link:` 形式。
