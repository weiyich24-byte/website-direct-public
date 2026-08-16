# 网站直达 Pages 发布仓库规则

本目录只保存 GitHub Pages 静态发布产物，不是源码目录。源码在 `D:\个人项目\网站直达独立版`。

- 当前目标 CNAME 是 `weiyicheng.cn`；`go.weiyicheng.cn` 已停用。
- 只有用户明确说“发布”或“上线”时，才允许把源码仓库已通过 `npm run verify` 的 `outputs/pages` 同步到这里。
- 同步前必须检查 CNAME、静态资源、首页和 404 页面；同步后先看 `git diff`，再由用户确认是否提交/推送。
- 未经明确授权不得 `git push`、改 DNS、改服务器或把本地候选变成线上状态。
- 不在这里直接开发功能；功能修改回到源码目录并遵守其 `AGENTS.md`。
