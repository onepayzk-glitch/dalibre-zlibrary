# Dalibre · Z-Library 书源

中文 | [English](README.en.md)

在 [Dalibre](https://dalibre.randynamic.org) 的「获取图书」里搜索、查看、下载 Z-Library 的书，Z-Library 被拦或没登录时自动回退到 Library Genesis 镜像。

移植自 calibre 商店插件 [tekofx/zlibrary-calibre-store-plugin](https://github.com/tekofx/zlibrary-calibre-store-plugin)，
按 Dalibre 插件 API 1 重写（书源能力、`resolve` 下载、设置项、权限声明）。

> 本插件只是把公开的网页检索接到 Dalibre 里。能不能下载、能下多少，取决于你自己的账号和站点规则；请自行确认所在地区的合规性。

## 安装

**方式一：从 GitHub 装（推荐，能收更新）**

Dalibre → 插件（Plugins）→ **从 GitHub 安装** → 填 `onepayzk-glitch/dalibre-zlibrary`，选 latest release 或 main 分支。

**方式二：从文件装**

下载 release 里的 `io.github.onepayzk.zlibrary-0.2.0.dalibre-plugin`，Dalibre → 插件 → **从文件安装**。

装完在「获取图书」的来源里选 **Z-Library 书源**。

## 设置

插件 → Z-Library 书源 → 设置：

| 项 | 默认 | 说明 |
|---|---|---|
| 搜索来源 | 自动 | 自动 = 先 Z-Library，失败或零结果时转 LibGen |
| Z-Library 站点 | `https://z-lib.gl` | 只填域名。换镜像要同时在 `plugin.json` 的 `permissions.hosts` 里加域名，否则请求会被 Dalibre 拒绝 |
| Z-Library 登录 Cookie | 空 | `secret` 类型，存系统钥匙串。从浏览器开发者工具复制 `remix_userid=...; remix_userkey=...` 整段 |
| LibGen 镜像 | `https://libgen.li` | 只填域名。解析按 libgen.li 的表格列结构写，换别的镜像可能对不上 |

没有 Cookie 时搜索页通常还能返回结果，但下载会失败——下载需要登录态。

## 它是怎么工作的

2026 年起 Z-Library 的 `/eapi/book/search` 对普通账号一律返回 `400 {"success":0,"error":"Access denied"}`
（登录态、付费态、浏览器同源请求都一样），所以这个插件走站点自己的搜索页：

1. `GET /s/<关键词>`。没有通过的会话时，站点回 503 的「Checking your browser」页面，
   里面嵌一段 JS 工作量证明。
2. 插件取出页面里的 40 位十六进制 challenge，用纯 JS 暴力找 `i`，
   使 `sha1(challenge + i)` 在 challenge 首位十六进制数字决定的位置上正好是 `0xB0 0x0B`。
   平均几万次尝试，几十毫秒到一秒。
3. 带上 `c_token=<challenge+i>` 和 `c_time=3` 重新请求，拿到 200 的结果页。
4. 解析站点自己的 `<z-bookcard>` 元素：书名、作者、出版社、年份、语言、大小、封面、
   下载 token 都在属性或子元素里。
5. 下载：对 `/dl/<token>` 再解一次墙，读 302 的 `Location`（`*.ncdn.ec` 上的 CDN 直链），
   把这个地址交给 Dalibre 去取文件。文件不经过插件。

一次搜索约 3–5 秒（解墙 + 抓页面），下载另有 1–2 秒的解墙开销。

```
permissions.hosts: z-lib.gl, z-library.sk, *.cdn-zlib.sk(封面), *.ncdn.ec(下载), libgen.li
```

## 已知限制

- **验证墙的算法是唯一脆弱点。** 站点改脚本，`solveChallenge()` 就要跟着改；届时搜索会抛
  「验证墙没看懂，页面结构可能变了」。
- **下载配额由账号决定**，免费档通常每天 10 本；配额用完时下载会报错。
- **只认这些格式**：EPUB、PDF、MOBI、AZW3、AZW、FB2、DJVU、TXT、RTF 等电子书格式，
  其它扩展名的结果会被丢掉。
- **LibGen 备用**按 `libgen.li` 的表格列顺序解析；镜像站换版式就解析不出来，会报
  「只返回占位页面」或「没有结果」。
- 站点若整体不可达（例如被网络层面阻断），搜索会报错而不是返回空列表——这是故意的，
  免得看起来像「没这本书」。

## 开发

```sh
npx dalibre-plugin@0.8.0 check .                   # 校验 plugin.json 和导出
npx dalibre-plugin@0.8.0 search . "deep work"      # 用 Dalibre 的运行时跑一次搜索
npx dalibre-plugin@0.8.0 download . "deep work" -o /tmp/zlib   # 走一遍 resolve
npx dalibre-plugin@0.8.0 pack .                    # 打包成 .dalibre-plugin
```

`main.js` 顶部有 `// @ts-check`，配合 `dalibre.d.ts` 在编辑器里能补全和查类型。

目录：

```
plugin.json          清单：id/版本/能力/权限/设置
main.js              search / resolve，HTML 解析与解墙都在这里
dalibre.d.ts         类型定义
jsconfig.json        编辑器配置
plugin.schema.json   plugin.json 的 JSON Schema
.github/workflows    push 时跑 check
```

## 许可证

GPL-3.0，与上游 calibre 插件一致。
