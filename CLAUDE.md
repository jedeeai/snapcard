# SnapCard · X 推文卡片生成器

开源独立插件（不与杰哥其他插件共享代码仓库），X榜单（xbangdan.com）出品。在 x.com 时间线/详情页每条推文互动栏末尾插「生成卡片」按钮，点击弹预览窗，把推文（头像＋昵称＋@handle＋日期＋正文＋配图＋互动数据）排成分享卡，支持白色/黑色/壁纸三种样式、下载 PNG / 复制到剪贴板；非中文推文可开谷歌翻译出双语卡（原文在上译文在下）。UI（预览 modal + popup）全部简体中文。

## 架构（纯 MV3 插件，零后台服务）

- `manifest.json` MV3；host: x.com / twitter.com / pbs.twimg.com / translate.googleapis.com；`web_accessible_resources` 开放 `assets/*` 给 x.com/twitter.com（Wallpaper 默认背景图用）；`homepage_url` 指向 xbangdan.com
- `content.js` 注入按钮 + 抓 DOM 数据 + Shadow DOM 预览 modal（含 Style 选择器、自定义背景上传/重置），UI 文案中文
- `card.js` 卡片 DOM 模板：`buildCard(data, {theme})` 按 `theme` ("white"/"dark") 取一份 palette 对象出全部颜色，不写两份模板；另导出 `buildWallpaperFrame(cardEl, backgroundUrl)` 把白卡包一层背景图+阴影。日期中文格式（`formatTime` 输出「2026年8月19日 10:37」），显示在昵称行蓝V后面，不在底部
- `render.js` 卡片 DOM → SVG foreignObject → canvas 2x → PNG（零第三方依赖）；Wallpaper 模式直接把 `buildWallpaperFrame` 返回的整个 frame 节点丢进同一条渲染管线，背景图和卡片里所有 `<img>` 一视同仁走通用的 `inlineImages()` 转 dataURL，没有为背景图特殊处理
- `background.js` 图片代理下载转 dataURL（CORS 兜底）+ 谷歌翻译 translate_a/single
- `popup.html/js` 署名开关（chrome.storage.sync，默认关）+ GitHub 链接 + 底部 xbangdan 品牌栏（logo+文字，点击新标签打开 xbangdan.com）
- `assets/bg-sequoia.webp` Wallpaper 模式内置默认背景图（macOS Sequoia 官方壁纸，个人使用）
- `assets/xbangdan-logo.svg` popup 品牌栏用的 X榜单官方 logo（蓝紫渐变），**只用在插件自身界面，不进生成的卡片**

## 关键决策（2026-08-19 评估定稿，同日追加 Style 切换 + 中文化 + 品牌栏）

- 数据只读 DOM，不碰 GraphQL 接口，零风控
- 图片跨域：已验证 pbs.twimg.com 返回 `access-control-allow-origin`（回显 Origin），可直取；onerror 时走 background 代理兜底
- 长推文折叠：不自动展开，modal 里提示「先点开全文再生成」
- **署名默认关**，popup 可开（chrome.storage.sync key `watermark` 默认 `false`，content.js/popup.js 两处默认值必须保持一致）
- 翻译：谷歌免费接口，国内无代理会失败，失败时提示不报错崩溃
- 色盲安全：UI 不用红绿对，状态用文字＋明度；Style 选择器选中态用蓝底白字，未选中灰底
- **Style 三态**：White/Dark 是 `card.js` 里两份真实 palette；Wallpaper **不是**第三份 palette，固定用白卡，只是外面包一层背景图框（`buildWallpaperFrame`）——所以 `buildCard` 的 `theme` 参数实际只接受 "white"/"dark"，wallpaper 由调用方（content.js）自己决定「先建白卡→再套框」
- **Wallpaper 尺寸算法**：`buildWallpaperFrame` 要求传入的 `cardEl` 已经挂载在真实文档里（不能是离屏 detached 节点），用 `getBoundingClientRect()` 量出卡片实际宽高，各自加 15% 当 padding 得到外框尺寸；背景图用 `<img>`（不是 CSS background-image），这样 render.js 现成的「找所有 `<img>` 转 dataURL」逻辑不用改就能顺带处理背景图
- **主题记忆**：`chrome.storage.sync` key `theme`，默认 "white"，切换即写入，下次打开 modal 直接取上次选择
- **自定义背景**：`chrome.storage.local`（不是 sync，sync 单 key 8KB 放不下一张图）key `customBg`，上传时用 canvas 等比压到最长边 ≤2400px、JPEG q0.85 再存；有 customBg 时 Wallpaper 优先用它，没有则用内置 `assets/bg-sequoia.webp`（`chrome.runtime.getURL` 取）
- **UI 中文化**：预览 modal + popup 所有按钮/提示文案改简体中文（样式选择器 白色/黑色/壁纸，操作按钮 翻译/下载 PNG/复制图片/关闭/上传背景/恢复默认），中文标点全角；卡片本身的时间/互动数据格式不受影响（不在本次改动范围）
- **日期挪位**：卡片底部原来的日期行删掉，日期改中文格式挪到昵称行、蓝V徽章右边，13px 次要灰（跟随 palette.subtle，白卡 #536471／黑卡 #71767b，两个主题天然一致不用额外定义颜色）；昵称行改 `flex-wrap:wrap`，昵称过长时日期换到下一行而不是把卡片撑宽——之前昵称是 `nowrap+ellipsis` 截断，现在容器换行接管这个职责，索性把截断样式也去掉让昵称能完整显示
- **品牌植入原则（不可动摇）**：卡片本身（不管哪种样式、哪种导出方式）永远不出现 xbangdan 品牌，水印开关只控制「SnapCard」四个字；xbangdan 的 logo/文字/链接只出现在插件自己的 UI（popup 品牌栏 + manifest homepage_url + README），card.js/content.js/render.js/background.js 这四个「卡片生成链路」文件里不允许出现 "xbangdan" 字符串，改完都要 grep 一遍确认

## X 改版高危点（改版先查这里）

- 按钮注入锚点：`article` 内 `[role="group"]` 互动栏
- 互动数据解析：`[role="group"][aria-label]` + views 兜底 `a[href$="/analytics"]`
- 正文抽取：`[data-testid="tweetText"]`，emoji 是 `<img>` 要拼 alt
- 折叠检测：`[data-testid="tweet-text-show-more-link"]`
- React 拦截：注入按钮的 click 必须 window capture 阶段监听，只 stopPropagation 不 preventDefault（x-post-launcher 踩过）

## 复用来源（只抄不引用）

- x-profile-md-saver：互动数据解析 parseCount（万/亿/K/M/B）
- x-post-launcher：按钮注入防拦截写法
- x-article-md：background 图片代理
- immersive-translate-jedee：谷歌翻译调用＋缓存

## 故障记录

- **2026-08-19 render.js 导出的 PNG 全白（无报错、无异常，纯白图）**：`renderCardToPng` 为离屏测量给克隆节点自身加了 `position:fixed;left:-9999px`，但后续 `XMLSerializer` 序列化的正是这同一个节点——`foreignObject` 里的内容因此继承了 `position:fixed`，相对 SVG 渲染上下文的视口定位到画布外，`ctx.drawImage` 什么也画不出来，但不报任何错。**教训：离屏测量绝不能直接改被序列化节点自身的 style，必须包一层 wrapper div 做离屏定位，克隆节点自己的 style 全程保持干净。** 修复后 `tests/smoke.py` 加了第 4 项断言：渲染完成后 `getImageData` 采样全画布像素，要求非白色像素数 > 0，防止这类"跑通但产出空白"的回归再次悄悄溜过。
- **同日 `toLargeImage()` 把 `data:` URI 也当 http(s) URL 处理**：`new URL(dataUri).searchParams.set('name','large')` 会在 base64 payload 后面拼一个 `?name=large`，把 data URI 直接拼坏（浏览器报 `ERR_INVALID_URL`）。修复：函数开头判断 `url.startsWith('data:')` 直接原样返回，不做任何改写。真实 x.com 环境下配图都是 `https://pbs.twimg.com/...` 不会触发，但 mock 测试用 `data:` URI 模拟图片时会立刻暴露。
- **2026-08-19（追加验收）正文被拆成多行、emoji 独占一行还带缩进**：根因是 `textWithEmoji()` 把兄弟节点之间的「纯空白文本节点」（HTML 源码里标签之间的换行+缩进，比如 `</span>\n  <img ...>`）当成正文内容原样拼接进去了——真实 tweetText 一行文字中 span/img/span 之间如果 DOM 里存在这种格式化空白，字面的 `\n  ` 就会被当成真实换行和缩进拼进结果。之前只在 pretty-print 过的 mock.html 里暴露（X 真实 React 输出是压缩过的，理论上没有这类空白，但不能假设改版后依然如此）。修复：`textWithEmoji()` 遇到纯空白文本节点时不再原样拼接，折叠成一个空格（非空白内容的文本节点不受影响，保留其中真实的 `\n`）；`extractText`/`extractNameAndHandle` 之后再过一遍 `normalizeExtractedText()`，把空格/制表符折叠、把换行两侧多余空格清掉，但不动换行符本身——这样真实的多段落推文（换行是文本节点内字面 `\n`）依然保留，只有格式化空白被清理。验收用 `getClientRects().length` 在真实渲染后的卡片正文 div 上采样，断言等于推文应有的行数（这条 mock 是 1 行），比单纯比对提取出的字符串更硬——直接验证浏览器实际怎么排版，不是我自己猜的。
- **同日 Wallpaper 模式预览里背景图不显示**：根因不在 content.js/render.js，而是 `tests/mock.html` 里 `chrome.runtime.getURL` 之前被我 mock 成返回一张 1x1 透明 data URI（是我为了让离线冒烟测试不发真实网络请求特意造的），杰哥的协调方截图验收时看到的「壁纸没铺上」其实是这张假图本身透明，不是产品代码的 bug。修复：mock 的 `getURL` 改成 `(path) => '../' + path`，指回 `tests/` 上一级的真实 `assets/bg-sequoia.webp`，实测背景 `<img>` `naturalWidth` 变成 2406（真实壁纸尺寸），预览截图也确认壁纸铺满、卡片带阴影居中。**顺带发现一个纯测试环境限制**：如果在这之后再跑一次完整 PNG 导出（`renderCardToPng`），`inlineImages()` 内部对背景图调用 `fetch(fileURL, {mode:'cors'})` 会被 Chrome 拒绝并打一条真实 console error（`URL scheme "file" is not supported`），这是 Chrome 对 `fetch()` 访问 `file://` 协议的硬限制，不是代码 bug——真实插件里背景图要么是 `data:`（用户自传壁纸，已经是内联的）要么是 `chrome-extension://`（内置默认壁纸，走 `web_accessible_resources` 声明过，`fetch()` 完全可用），都不会撞上这条限制。所以 smoke.py 里 Wallpaper 场景只验证「背景图在预览里真实解码成功」（`naturalWidth > 0`），没有让 Wallpaper 场景也跑一遍完整导出，避免把测试环境自身的协议限制误判成产品问题。
