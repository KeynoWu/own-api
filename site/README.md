# own-api 官网落地页

单文件、零构建、零第三方脚本（仅字体走 Google Fonts，失败自动回落系统字体），可直接静态托管。

## 本地预览

```bash
open site/index.html          # 直接双击打开也行
# 或起个静态服务
npx serve site
```

## 发布到 GitHub Pages（推荐）

仓库已在 `github.com/KeynoWu/own-api`，两条路任选：

1. **Settings → Pages → Source 选 `main` 分支 `/site` 目录**（零配置，push 即更新）。
   页面地址：`https://keynowu.github.io/own-api/`（落地页内 OG url 已按此预填）。
2. 或仓库根放 `.nojekyll` 后用 `/` 根目录——会和 README 混排，不推荐。

## 维护提示

- 下载区**不写死版本号与安装包文件名**（按钮永链 Releases 页，页面自带最新版），发版无需改落地页。
- 全部品牌色/间距/字号在 `<style>` 顶部的 `:root` 令牌里，别在组件里写死 hex。
- 内容口径与 README 对齐：不支持 `/v1/responses` 这类"注意"别在页面上吹掉了。
