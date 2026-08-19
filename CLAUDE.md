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
- **Wallpaper 边距固定 60px（四边相等）**：`buildWallpaperFrame` 里 `WALLPAPER_PAD = 60`，不再按卡片宽高百分比算，避免竖长卡片上下边距明显大于左右
- **操作条按钮主次**：「复制图片」是主按钮（蓝底白字）排第一位，「下载 PNG」次按钮排第二位，「关闭」最后——大多数用户复制完直接粘贴发出去，比下载文件更高频
- **modal 超高内容处理**：面板本身 `maxHeight:90vh + overflow:auto` 兜底可滚动，操作条就是文档流里的普通子元素，滚动到底才看得到，不做 sticky 底栏（用户明确要求）；溢出时右下角浮一个「复制按钮在下面 ↓」提示胶囊，滚到接近底部（剩余 < 40px）自动淡出
- **主题记忆链路**：点样式按钮 → `saveStyle()` 立即写 `chrome.storage.sync` key `theme` → 下次 `handleGenerateClick` 里 `getSavedStyle()` 读回来初始化 `state.style` 和按钮选中态，读不到给默认 "white"，全链路已用 smoke.py 关模态框再重开验证过确实生效
- **隐藏互动数据**：`chrome.storage.sync` key `hideStats`，默认 `false`，跟 `theme`/`wallpaperBg` 同一套记忆模式；`buildCard(data, {hideStats})` 为 true 时整个 footer（含上边框分隔线）都不创建，不是简单 `display:none`，卡片直接以正文/配图收尾
- **Wallpaper 背景选择**：一开始按用户要求做过 4 张纯 CSS/canvas 渐变生成的内置背景（`WALLPAPER_PAD` 那次之后的版本），当天晚些时候用户又改主意换成 7 张真实壁纸图（`assets/bg-sequoia.webp` + 6 张新图，全部方形 700-1002px webp），**canvas 渐变生成那套代码已整个删除**，改成跟 Sequoia 一样走 `chrome.runtime.getURL(file)` 的统一 `BUILTIN_BACKGROUNDS` 数组（`{id, label, file}`），选中标识存 `storage.sync` key `wallpaperBg`（"sequoia"/"sparrow"/"silver"/"rose-gold"/"albany-gold"/"space-gray"/"gradient-dark"/`custom:N`），自定义图升级成 `storage.local.customBgs` 数组（见下）。缩略图行只在 Wallpaper 模式显示，选中项 2px 蓝色描边，未选中 1px 灰色描边（`box-shadow` 模拟，避免描边把布局撑大）；「恢复默认」按钮已按用户要求去掉，点 Sequoia 缩略图等效。
- **生成等待态（先弹 modal 再异步渲染）**：`handleGenerateClick` 拆成两段——`createModalShell()` 同步立即建 host/shadow/overlay/panel/previewWrap+灰色 spinner+「卡片生成中，需要等待几秒钟…」，`await nextPaint()`（连续两次 `requestAnimationFrame`）让浏览器先画一帧再往下走，然后才做 `extractTweetData`（真实 X 大推文 DOM clone 可能有感知延迟）+ `Promise.all` 读 5 个 storage 设置，读完调 `finishModal()` 把 spinner 换成真卡片、补齐样式选择器/操作条/滚动提示。两处都检查 `shell.host.isConnected` 防止用户中途关闭 modal 后还在往一个已从文档摘除的节点上做无意义 DOM 操作。**给 smoke.py 踩的坑**：headless Chromium 里 `requestAnimationFrame` 几乎瞬间 resolve（没有真实 vsync 可等），mock 的 storage 回调如果是同步的，整条「建 modal→抓数据→读设置→建卡片」链路会在 Playwright 下一次 CDP 往返都还没到达浏览器之前就跑完，导致 spinner 状态测不到（时序竞态）。修法：mock.html 的 `storage.sync/local.get` 回调统一套一层 `setTimeout(...,30)`，给 spinner 一个确定能被观测到的窗口——这不是在掩盖真实时序，チrome 真实的 storage API 本来就是异步的，只是延迟通常比 30ms 短，mock 里放大一点纯粹是为了测试可观测性。
- **自定义背景多张化**：`customBg`（单值）→`customBgs`（数组，上限 6 张，`MAX_CUSTOM_BACKGROUNDS`），首次读取时自动迁移（`storage.local` 读到旧 `customBg` 单值就转成 `[customBg]` 写回 `customBgs` 再删旧 key，只会跑一次）。选中标识用 `custom:N`（N 是当前在 `customBgs` 数组里的下标，不是每张图固定分配的 id）——好处是删除中间一张后，后面每张图的「新下标」天然对齐，不用额外维护映射表；唯一要手动处理的是**当前被选中的**那个 `custom:N` 字符串在删除发生时不会自动更新，所以删除逻辑里专门判断：删的是选中项本身→回落 Sequoia；删的下标在选中项之前→选中项下标减一并重新存；删的下标在选中项之后→不受影响。另外在 `handleGenerateClick` 里对刚读出来的 `wallpaperBg` 用 `sanitizeBgId()` 校验一遍下标是否越界（防跨会话的陈旧引用，比如上次开着 modal 时被别的地方改了 storage）。
- **壁纸缩略图折叠/展开**：默认折叠、每次开 modal 都不记忆展开状态。折叠态只在 DOM 里放 1 个圆形缩略图（当前选中项）+「更多壁纸 ▸」文字按钮，其余 7 内置+自定义+上传按钮**折叠时压根不创建 DOM 节点**（不是 CSS 隐藏）——这是为了让「折叠态总数很少」这件事变成一个能直接数 DOM 节点数的硬断言，不用去猜克隆的节点是不是被裁剪了。展开时才把节点建出来塞进一个 `overflow:hidden; max-width` 的容器再把 `max-width` 从 0 撑到 600px（配 `transition: max-width 250ms ease`）触发滑出动画；收起时反过来先把 `max-width` 收回 0 播放动画，`setTimeout(300ms)` 后才真正清空子节点（给动画留够播放时间，不是收起了动画其实是瞬间清空看不出效果）。**踩过的坑**：一开始选中的自定义图缩略图挪到「常驻可见」那个槽位时被写死 `allowDelete=false`（原意是折叠态那张图不该有删除角标），结果用户选中一张自定义图后它就再也删不掉了——因为它已经不在 `restItems`（会生成删除角标的那个列表）里了。修复：常驻槽位的 `allowDelete` 改成 `bgExpanded && item.id 是 custom:`，折叠时强制不显示（跟需求一致），展开时如果它是自定义图就照常给删除角标。这个 bug 是 smoke.py 第 13 项断言（真删一次）测出来的，光测「有没有角标」测不出来，得真点删除才会暴露。

## X 改版高危点（改版先查这里）

- 按钮注入锚点：`article` 内 `[role="group"]` 互动栏
- 互动数据解析：`[role="group"][aria-label]` + views 兜底 `a[href$="/analytics"]`
- 正文抽取：`[data-testid="tweetText"]`，emoji 是 `<img>` 要拼 alt
- 折叠检测：`[data-testid="tweet-text-show-more-link"]`
- React 拦截：注入按钮的 click 必须 window capture 阶段监听，只 stopPropagation 不 preventDefault（x-post-launcher 踩过）

## 发版规范

版本号用杰哥自定的「年序.月.日」格式（2026 为第 0 年）：2026-08-19 发布＝`0.8.19`，2027-02-01＝`1.2.1`。日期不补前导零（manifest 禁止），同天多版加第四段（`0.8.19.2`）。

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
- **2026-08-19（真实用户反馈）Wallpaper 四边 padding 不等，改固定 60px 后仍然不等**：一开始以为是「百分比 vs 固定值」的问题，改成 `WALLPAPER_PAD=60` 固定值后用新加的 smoke 断言一测，左右还是只有 20px（上下正常 60px）。真根因是 `buildWallpaperFrame` 返回的 frame 节点被塞进 `previewWrap`（`display:flex`）之后，没有显式设 `flexShrink:'0'`，默认 `flex-shrink:1` 会在横向（flex 主轴）把 720px 宽的 frame 压缩到跟 modal 面板差不多宽，纵向（非主轴）不受影响，压缩只发生在左右——这才是「上下边距明显大于左右」的真正机制，跟 padding 是百分比还是固定值无关，只是百分比值更大（原来 90px）让压缩量看起来更夸张。**教训：任何一个子元素被塞进 flex 容器、又要求它按精确像素渲染（不能被主轴挤压）时，必须显式 `flexShrink:0`，不能假设「反正我设了 width 就一定按这个宽度画」。** 修复：`wrapper` 加 `flexShrink:'0'`；smoke.py 新增 7b 断言直接量 frame/card 两个矩形的四边差值，四边必须相等且等于 60，这类「肉眼看着对，测出来才发现只有部分方向生效」的偏差以后能被自动挡住。
