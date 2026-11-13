# 粽子音源 · MyGo 插件 关键坑位备忘

## 一、MyGo 播放器的硬限制（决定了插件怎么写）

### 1. 只认这 6 种 type
`mp3 / flac / ogg / wav / m4a / aac`
传别的（例如 `mp4`）会被 `songType()` 回退成 `mp3`，然后按 mp3 解码 → 报错。

### 2. mp3 解码器限制很死（github.com/hajimehoshi/go-mp3）
- **只支持 MPEG Layer III** → Layer I/II 报 `only layer3 is supported`
- **不支持 free-format**（bitrate index = 0）→ 报 `free bitrate format is not supported`

所以 `stream()` 返回前必须验头部字节，不合法就换源。
`detectAudio()` 就是干这个的，别删。

### 3. mp4 解析器不认 DASH 分片
`internal/mp4/mp4.go` 的判定：
```go
if mvex != nil && !hasSamples(stbl) { Fragmented = true }
else if tables { a.parseTables(stbl) }   // 空 stbl → "mp4: bad sample table"
```
YouTube 的 `audio/mp4`（itag 139/140）**全是 DASH 分片**，文件头 `ftypdash`，
样本在 moof 里、stbl 空表 → 必然报错。

**所以 YouTube 必须优先选 webm/Opus（itag 251/250/249）**，走 EBML 解析，不碰 stbl。
实测 itag 251 头字节 `1A 45 DF A3`（EBML），播放正常，且 Opus 160kbps 比 AAC 128k 音质更好。

### 4. `rqh=1` 参数不能去掉
URL 里的 `rqh` 是签名的一部分，删掉直接 403。不要尝试"清理"URL。

## 二、各平台的真实状况

### 网易云 outer 直链
- 免费/已购 → 302 到 `mXXX.music.126.net` CDN 直链
- **无版权/VIP → 302 到 `http://music.163.com/404`，跟随后状态码是 200！**
  所以**不能只看状态码**，必须看最终 URL 是否含 `/404`，并用内容探测复核。

### 内地下架歌手（重要）
这批在内地平台整体被清除或限流，搜过去只会返回同名噪声：

| 歌手 | 内地平台表现 | YouTube |
|---|---|---|
| 脆弱少女组 | 网易云返回 Michael Jackson | `FragileGirls - Topic` 官方音轨 ✅ |
| 赵薇 | 只有「赵薇薇」0 曲 | 真原唱《不由自主》《拨浪鼓》 ✅ |
| 李志 | 只有同名小号 1~2 首 | 太合音樂官方跨年现场 ✅ |
| 那我懂你意思了 | 只有 1-2 首野鸡条目 | 本尊频道 ✅ |

**做法**：命中名单 → 跳过网易云/酷我，只问 YouTube。
名单：`DELISTED_ARTISTS` + 设置项 `extraDelisted`（`!name` 表示移除）。

### 英文别名只能用于识别，不能用于搜索
搜 "FragileGirls" 会返回一堆 "Fragile Girl Defeats a Top Fighter" 这类无关英文视频。
英文别名只在 `scoreTrack()` 里认人用。搜索词永远用中文原名。

## 三、搜索结果里必须扔掉的东西

`NOT_MUSIC_RE` 过滤这些（不降权，直接删）：
- 访谈/新闻/纪录片/红毯/八卦/揭秘/内幕
- 专访/花絮/综艺/解说/评论/影评
- 恋情/婚姻/离婚/生子/道歉/回应/声明/辟谣
- 事件/回顾/回忆/盘点/真相/那些事/面对面/超话

**注意误伤**：「结婚」会把水仙斗活佛的《结婚记》删掉，所以只用更具体的组合词。

## 四、搜索排序（scoreTrack）

| 维度 | 权重 |
|---|---|
| 标题完全等于查询 | +300 |
| 标题以查询开头 | +140 |
| 标题含查询 | +60 |
| 歌手命中查询词 | +90 |
| `originCoverType=1`（原唱） | +120 |
| `originCoverType=2`（翻唱） | −130 |
| `originCoverType=3`（伴奏/remix） | −100 |
| pop ≥ 90 | +25 |
| 非音乐内容 | −400 |
| 下架歌手场景歌手不匹配 | −250 |
| YouTube `- Topic` 频道 | +80 |
| 时长 < 60s（试听片段） | −150 |

## 五、歌词（三级兜底）

1. 网易云曲目 → `song/lyric` 直接查
2. LRCLIB `api/get`（精确）→ `api/search`（只按歌名，不带歌手）
3. **网易云搜索反查**：洗标题 → 搜歌名 → 歌名相似度打分 → 取歌词

第 3 步对酷我/YouTube 最重要。小众乐队的原唱被下架后，
网易云上常常只剩翻唱，**翻唱的歌名带 `- COVER`，但歌词是同一份**，
所以 `scoreTrack` 里对翻唱只压 20 分而非直接排除。

## 六、绝对不要做的

- 不要给 YouTube 传 `type: "mp4"`
- 不要删 `rqh` 参数
- 不要用英文别名搜索
- 不要只看 HTTP 状态码判断网易云 outer 是否可用
- 不要用「结婚」「明星」「运动」这类宽泛词做过滤（会误伤歌名）

---

## 七、重大发现：YouTube 在 MyGo 上**根本播不了**

这是这一轮最重要的结论，推翻了之前的假设。

### 证据
在 `MyGo Music.exe` 里搜符号，**完全没有** `EBML` / `Matroska` / `OpusHead`。
说明 MyGo 没有 WebM 解析器。它的 ogg 通道用的是 `jfreymuth/oggvorbis`，
**只认 `OggS` 魔数的 Ogg Vorbis**。

而 YouTube 现在只给两种音频流：

| itag | 格式 | 文件头 | MyGo 表现 |
|---|---|---|---|
| 251/250/249 | audio/webm (Opus) | `1a 45 df a3` (EBML) | 无法解析 → 回退按 mp3 解 → `mp3: is_pos was too big: 576` |
| 140/139 | audio/mp4 | `ftypdash` + `moov` | `mp4: bad sample table`（空 stbl） |

换 client 也没用：ANDROID / IOS / ANDROID_VR / WEB 全都返回 `rqh=true` 的 DASH 流。

### 所以的补偿策略
`stream()` 收到 `yt:` 时，**先拿歌名去网易云/酷我找同曲**（`tryMainlandByName`），
找到就返回标准 MP3；找不到才退回 YouTube 原链。

效果：普通歌曲（草东、邓紫棋、陈奕迅、周杰伦）的 YouTube 条目
**大多能被换到内地平台的 MP3**，从 0% 可播提升到约 56%。

### 但内地下架歌手仍然无解
实测这些歌在内地平台**真的不存在**（或只有无关的同名歌）：

| 歌名 | 网易云实际返回 |
|---|---|
| 夢想少女 | 電影夢想少女 - パスピエ（日本乐队，无关） |
| 失去尼歐 | 蚊 - 陈奕迅（无关） |
| 遺忘不是我們的專長 | 只有 COVER 版 |
| 所以我停下來 | 翻唱版（翻自 那我懂你意思了） |

这不是代码问题，是版权现状。要真正播这些歌，
只能让 MyGo 支持 WebM（改它的 Go 源码），或在插件里用 `host.spawn`
起一个转码进程（需要 process 权限 + 打包 ffmpeg，很重）。

## 八、繁简转换是必需的一步

YouTube 上台湾/香港的标题大量是繁体（`爛泥`、`遺忘`、`夢想`），
直接拿去内地平台搜基本全空。`toSimplified()` 逐字查表转换后才搜得到。

实测：草东的三条 YouTube 条目在加繁简转换前全部换源失败，
加完之后全部成功换成网易云 MP3。

---

## 九、【解法】用 ffmpeg 转码绕过 MyGo 的格式限制（v2.0.0）

### 灵感来源
官方插件 `egoist/mygo-music-youtube-music` 返回的是 `type: "mp3"`，
它是起 ffmpeg 把 YouTube 音频**实时转码成 mp3 并通过本地 HTTP 流出去**的。

### 实现
```
ffmpeg -nostdin -hide_banner -nostats \
  -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
  -rw_timeout 15000000 -request_size 10485760 \
  -user_agent "<YouTube UA>" -http_proxy "http://127.0.0.1:7890" \
  -i "<googlevideo URL>" \
  -vn -c:a libmp3lame -b:a 128k -id3v2_version 0 -write_xing 0 \
  -f mp3 -listen 1 http://127.0.0.1:<port>/
```
`stream()` 返回 `http://127.0.0.1:<port>/`，MyGo 拿到的是标准 MP3 流。

### 三个必须注意的点

**1. 必须给 ffmpeg 传代理**
ffmpeg 不读 Windows 系统代理。本机代理是 `127.0.0.1:7890`（Clash/FlClash）。
不传的话会 `Error number -138`（连接失败）或 `403 Forbidden`。
插件设置里有 `proxy` 项，留空时代码会自动兜底用 `http://127.0.0.1:7890`。

**2. 不能整首一次性下载**
`fetch(url)` 不带 Range 会被 Clash 的 fake-IP（`198.18.x.x`）劫持导致失败。
必须分块 `Range: bytes=x-y`，每块 ≤512KB。
而且 YouTube 对版权内容有约 1MB 配额，第二块常 403 ——
所以**不能让 JS 下载完整音频**，必须让 ffmpeg 自己边拉边转。

**3. 判断 ffmpeg 就绪靠 stderr 里的 "Input #0"**
不能去探测端口 —— 探测会消耗掉 ffmpeg 唯一的那次请求。

### 效果
| 歌手 | 之前 | 现在 |
|---|---|---|
| 脆弱少女组 | 0% 可播 | ✅ 全部可播 |
| 那我懂你意思了 | 0% | ✅ |
| 赵薇 | 0% | ✅ |
| 李志 | 0% | ✅ |
| 水仙斗活佛 | 100%（网易云有） | ✅ |

实测 **15/15 真实可播**（用 ffmpeg 转出来的流验证头字节为 `ff fb` MP3 帧头）。

### 分发注意
`bin/win32-amd64/ffmpeg.exe` 有 **162MB**。如果要发到 GitHub，
建议放到 Release 资产里（按平台命名 zip），不要塞进仓库。

### 权限
`plugin.json` 需要：
```json
"permissions": { "process": ["bin/win32-amd64/ffmpeg.exe"] }
```
第一次播放时 MyGo 会弹窗要你允许启动程序 —— 必须点允许。

---

## 十、搜索源前缀（v2.2.0）

### 为什么用前缀而不是下拉框
查过 MyGo 源码，**搜索页加不了自定义控件**：

```go
// internal/music/music.go
type SearchKind string
const (
    SearchTracks    SearchKind = "tracks"
    SearchAlbums    SearchKind = "albums"
    SearchArtists   SearchKind = "artists"
    SearchPlaylists SearchKind = "playlists"
    SearchShows     SearchKind = "shows"
)
```
插件只能在这 5 个里返回内容，加不了「YouTube / 云音乐 / 酷我」这种 tab。

`Suggest()` 虽然是插件可控的，但 UI 那边只渲染纯文本：
```go
ui.Text(c, label).FontSize(13)   // 没有 Icon
```
所以联想列表也放不了图标。

侧边栏 `navigation` 的 `icon` 字段**只认 11 个内置名**：
`home / note / album / artist / playlist / radio / podcast / chart / calendar / heart / search / star`
—— 那是唯一能显示图标的地方，但要求拆成多个插件源。

### 最终做法：搜索词前缀
| 写法 | 效果 |
|---|---|
| `晴天` | 三平台聚合（默认） |
| `yt:晴天` `youtube:晴天` | 只查 YouTube |
| `ne:晴天` `wy:晴天` `netease:晴天` | 只查网易云 |
| `kw:晴天` `kuwo:晴天` | 只查酷我 |

前缀必须「冒号 + 后面有内容」才算，避免误伤 `re:从零开始` 这类歌名（已测：42 条正常聚合）。

---

## 十一、反识别措施（v2.3.0）

固定 UA + 固定节奏的并发请求很像爬虫，平台侧容易聚类。加了两层：

### 1. UA 轮换
```js
UA_POOL_DESKTOP  // 6 个：Chrome 129/130/131 (Win+Mac)、Firefox 133、Safari 18.1
UA_POOL_MOBILE   // 4 个：iOS 17/18 Safari、Pixel 8、Samsung S918B
```
每次请求随机取一个。

**⚠️ YouTube 例外**：innertube 接口对 UA 和 client 是绑定的，
乱换会导致 `playabilityStatus` 异常。所以 YouTube 那边保持固定 UA，
只对网易云 / 酷我这两个普通网页接口轮换。

### 2. 请求节奏抖动
```js
await jitter(120)  // 0~120ms 随机延迟
```
加在 `neSearchTyped`、`kuwoSearch`、`kuwoStream` 入口。
不改变并发结构，只打散时间点。

### 代价
- 聚合搜索 1136ms（原来约 1000ms），多出的时间就是抖动
- 单源搜索 132~458ms，抖动影响很小

### 没做的
- **代理池**：需要额外基础设施，插件层做不了
- **Cookie 轮换**：网易云/酷我匿名接口不需要登录态，轮换没意义
- **请求签名伪装**：需要逆向平台的签名算法，成本远大于收益

---

## 十二、侧边栏菜单与电台/播客（v3.11.0）

### 五个新菜单（plugin.json `navigation`）
```json
{ "title": "我的歌单", "page": "mylists", "icon": "playlist" }
{ "title": "最近播放", "page": "recent",  "icon": "history" }
{ "title": "艺人收藏", "page": "artists", "icon": "account-heart" }
{ "builtin": "stations", "title": "电台" }
{ "builtin": "shows",    "title": "播客" }
```
- 前三个走 `browse({page})`，页面逻辑在 browse() 里（mylists / recent / artists）。
- 后两个用 MyGo 内置页 `builtin: "stations" / "shows"`：菜单由 app 渲染，
  数据由插件的 `stations()` / `shows()` 提供，**不需要在 browse() 里处理**。
- ⚠️ `navigation[].icon` 只认内置名：home/note/album/artist/playlist/radio/podcast/
  chart/calendar/heart/search/star。用了别的名字图标不显示。

### 电台：无限连续播放
- `stations()` 返回 3 个台（华语/摇滚/欧美），每个台是 `{id,name,description,imageUrl}`。
- 点开自动播，`stationNext({id})` 每次给一批轨道，播完继续要 —— 无尽头。
- 内容复用 `catMix()` 的分类拼单（跨平台混排），保证可播。

### 播客：专辑当节目
- `shows()` 返回节目卡（华语/摇滚/欧美/今日拼单），`show({id})` 返回
  `{show, episodes, more}`，episodes 就是该分类的曲目。
- `subscribeShow()` 空实现（插件无平台账号，订阅存在播放器侧）。

### ⚠️ 电台/播客必须用严格过滤 radioSafe()
`catMix()` 内部的 `playableOnly()` 有个「过滤后不足 6 首就不过滤」的兜底 ——
在首页没问题，但**电台是连续播放，混进一首 VIP 歌就把整个台卡死**。
所以 stationNext/show 返回前额外过一遍 `radioSafe()`：直接踢掉网易 VIP/下架轨，
不设兜底；跨平台轨(yt/bi/kw/qq)不标 fee，天然保留。

### 测试脚本 test_all.cjs
`node test_all.cjs` —— 自包含：自动把 index.js 转成 CJS 加载，mock 掉 host
（storage 内存版 + 真 ffmpeg spawn），真实联网跑：
- 五个新菜单全链路（stations/stationNext/shows/show/browse 三页）
- 全平台取流（网易/酷我/QQ/YouTube/B站）并实测拉流头字节
装了 acorn 会做权威语法校验，没装则跳过。
⚠️ ffmpeg `-listen 1` 只接受**一次**连接，探测时不能先探一次再拉 ——
要么直接一次拉够 4KB，要么第一块太小就多读几块。

---

## 十三、下架歌手三级分类与定点曲目（v3.12.0）

### 三级结构（不能混用）

| 常量 | 含义 | 排序行为 |
|---|---|---|
| `DELISTED_ARTISTS` | 整人全网清零 | YouTube/B站 优先，内地（ne/kw/qq）结果**直接丢弃** |
| `PARTIAL_DELISTED` | 只下架个别曲目，主力在售 | 完全不干预，仅作数据标注 |
| `BANNED_TRACKS` | 具体某几首歌被定点下架 | 命中则 YT/B站 **+420**，内地 **−420** |

### ⚠️ 踩过的坑

**1. `dropMainland` 漏了 QQ**
原来只过滤 `netease` / `kuwo`，实测搜「福禄寿乐队」「阴三儿」，
QQ 仍返回 20 条内地条目混在结果里（用户点到就是同名但不是本人的歌）。
三处判断（dropMainland / 搬运判定 / 打分）都必须带 `qq`。

**2. 定点曲目的加分要压过原唱分**
最初给 YT +90，但 QQ 的 `_cover=1` 原唱 +120、网易 +120 —— 抵不过，
首条仍是内地那条（虽然是正版原唱，但它已被下架，播不了）。
改成 ±420 后，YT/B站 稳定排第一。

**3. `bannedTrackHit` 要同时比对两个来源**
歌手字段经常残缺（B站是 UP 主名、YouTube 是频道名），
所以 `bannedTrackHit(t.name, artistName)` 和 `bannedTrackHit(t.name, q)`
两个都要试 —— 第二个用整串查询词兜底。

### 实测结果（v3.12.0）

| 查询 | 首条平台 | 播放 |
|---|---|---|
| 张震岳 我爱台妹 | yt | ✅ |
| 张学友 人间道 | bi | ✅ 6.5MB |
| 罗大佑 皇后大道东 | yt | ✅ 5.2MB |
| 许嵩 晃晃悠悠 | yt | ✅ 3.0MB |
| 热狗 哈狗帮 | bi | ✅ 4.9MB |
| 费玉清 嘿嘿嘿 | bi | ✅ 4.8MB |
| 田馥甄 离岛 | yt | ✅ 0.8MB |
| 马頔 海咪咪小姐 | bi | ✅ 6.6MB |
| 谢帝 瓜老外 | yt | ⚠️ 首条 UNPLAYABLE |

### 整人清零型实测（命中后只走 YT/B站）

| 歌手 | 平台分布 | 长度字段 |
|---|---|---|
| 脆弱少女组 | yt:31 bi:19 | 50/50 |
| 赵薇 | yt:14 bi:3 | 17/17 |
| 灭火器乐团 | yt:22 bi:16 | 38/38 |
| 闪灵乐团 | yt:38 bi:20 | 58/58 |
| 李志 | yt:38 bi:19 | 57/57 |
| 福禄寿乐队 | yt:35 bi:16 | 51/51 |
| 阴三儿 | bi:17 yt:19 | 36/36 |

✅ `ne` / `kw` / `qq` 均已清零，长度字段 100% 完整（按长度排序可用）。

### 播客搜索（新增）

`search({kind:"shows"})` 走 Apple Podcast 目录，填补「播客页只能进首页 5 个固定节目」的空缺。
实测：「音乐」20 条、「李志」5 条、「忽左忽右」2 条、「播客」19 条。

### 下架歌手 artists 页兜底（v3.11.3）

网易把这些人整体清出艺人库，`artists` 搜索返回 0 条 →
命中 `delistedHit` 时构造 `yda:<歌手名>` 虚拟条目，
`artist({id:"yda:xxx"})` 改从 YouTube 拉歌。
实测：赵薇 39 首、脆弱少女组 33 首。

### 其他修复

- **播客 RSS 解析**：`xmlPick` 正则字符串里 `\s` / `\[` 被 JS 字面量吃掉反斜杠，
  导致 `Unmatched ')'`、654 集解析成 0 集。改为 `\s` / `\[`。
- **`remember()` 覆盖 audio**：`show()` 存了播客音频直链后，`remember(page)`
  会用普通版本覆盖 trackMeta，把 `audio` 丢掉 → stream 报「音频地址丢了」。
  改成保留 `prev.audio` / `prev.servedFrom`。
- **B站空 bvid**：`biliSearch` 偶尔返回无 `bvid` 的条目，id 会变成 `"bi:"`。
  组装时跳过。
- **QQ DJ 混剪版**：QQ 侧取流稳定 404（实测「0.8x DJ阿Bo版」「DJ阿若版」），
  在 `qqSearch` 里直接剔除，保留 Live/翻唱。

---

## 十四、v3.13.0：封面 / 电台扩充 / 播客分类 / 搜索大修

### 1. 首页拼好歌第一首没封面（已修）
`todayMix()` / `catMix()` 混进来的跨平台曲目（yt/bi/kw）`album` 是**空对象**，
而 MyGo 从 `track.album.imageUrl` 读封面（不是顶层 `artwork`）→ 这些曲显示空封面。
首页大横幅第一首若是这类曲就露馅。
**修复**：两处返回前统一 `for (const t of out) sinkThumb(t)`，把 artwork 同步进 album.imageUrl。

### 2. 电台：真实网络收音机扩充到多平台（v3.13.0）
原来只有蜻蜓FM 3 个 + Zeno 1 个。Zeno 实测 401，蜻蜓流带 **86 字节 junk 头**
（`d0 9c …`，真 MP3 帧在 86 字节后），直连探测会白等 6 秒。
现在挂 10 个台，覆盖多平台：
| 台 | 平台 | 直连头 |
|---|---|---|
| 华语流行台 / 城市音乐台 | 蜻蜓FM | junk 头 → forceTranscode |
| FIP / France Inter | Radio France | `ff fb` mp3 / ADTS aac，可直连 |
| SomaFM 音乐台 / 环境台 | SomaFM | 可直连（要 UA+Referer） |
| NTS Radio | NTS（英国） | 可直连 |
| Radio Paradise | 混合 | 可直连 |
| Classic FM | 英国古典 | 可直连 |
| Antenne 巴伐利亚 | 德国 | 可直连 |
- `LIVE_RADIOS[].forceTranscode=true` 的台（蜻蜓）**跳过直连探测**直接上 ffmpeg，
  省下那 6 秒。标记经 `trackMeta` 传到 `stream()` 的 radio 分支。
- `checkAudioUrl()` 改成**流式读头 36KB 就 cancel**，不再用 `res.arrayBuffer()`
  —— 后者对无限直播流会一直挂到超时（icecast 常忽略 Range 返回整条流）。
- 真电台台卡补了 `imageUrl`（fallback 封面），电台页不再空图。
- plugin.json network 白名单补：radiofrance.fr / somafm.com / ntslive.net /
  radioparadise.com / musicradio.com / antenne.de。

### 3. 播客页按类别做列表（v3.13.0）
- 新增 `PODCAST_CATS`（音乐/科技/文化/商业/新闻/故事/生活/知识 8 类）+ `podcastByCategory()`。
- `browse({page:"shows"})` 返回**多个 section**，每个 section 一个类别、含该类真实节目。
- 导航「播客」菜单从 `builtin:shows` 改成自定义 `page:shows`；「电台」同样改 `page:stations`。
- `shows()` 保留（摊平返回），兼容旧入口。

### 4. 【重大】搜索：NOT_MUSIC_RE 误删合法歌名（v3.13.0 修，影响面极大）
老版本的非音乐正则把一堆**当红歌名高频词**也塞进去了：
`演员`、`素颜`、`事件`、`故事`、`公司`、`品牌`、`深度`、`观察`、`调查`、
`分析`、`回应`、`声明`、`资本`、`财富`、`到底`、`拒绝`、`表白` …
`add()` 里 `NOT_MUSIC_RE.test(rawTitle)` 命中就**直接删除**。
**后果**：搜「薛之谦 演员」，网易返回 10 条《演员》全被当新闻删掉，一条都搜不到；
搜「许嵩 素颜」同理。这让一大批热门歌凭空消失。
**修复**：拆成两层
- `NOT_MUSIC_RE`（强新闻词，几乎不可能是歌名）→ 单条命中直接删；
- `NOT_MUSIC_WEAK`（既可能是歌名、也可能是新闻标题的一部分）→
  只在 **长标题(≥12 字) + 新闻式标点/结构** 时才删。
统一入口 `isNotMusicTitle(rawTitle)`，删除处和降权处都改用它。
原则：**宁可漏几条新闻，也不能让合法歌名消失**。

### 5. 搜索排序：分段查询认错歌手（v3.13.0 修）
搜「薛之谦 演员」时，分段判定用「标题完全等于某段最多者当歌名」的启发式，
因池子里 QQ 结果大量带「薛之谦」字样 → 误判成
「歌名=薛之谦、歌手=演员」→ 按不存在的歌名匹配，歌曲全失效。
**修复**：分段前先 `detectNeteaseArtist(seg)` 认哪段是歌手名（网易艺人库能查到且专辑≥3），
认出唯一歌手段 → 另一段当歌名。查不到再退回原启发式。

### 6. 搜索排序：串烧/拼接整段压过原唱（v3.13.0 修）
- 「正主加分 +300」原来在 `title.indexOf(_qSong)>=0` 就给，
  于是「江南+一千年以后(跨年Live)」这种串烧因为是本人也拿满正主分，顶到《江南》前面。
  **改成只在 `title === q || title === _qSong`（裸标题完全相等）时才给**。
  「非正主降权 −280」保持「包含」判定（翻唱带"(副歌)"后缀也要压）。
- 新增拼接串烧降权：标题含 `+ / ＋ / &` 连接符的 `score -= 160`。

### 7. 搜索排序：下架歌手噪声（v3.13.0 修）
- 赵薇/李志等下架歌手搜出来混入「…片尾曲…」「发现…」等资料类。
  下架歌手降权正则补 `片尾曲|片頭曲|片尾|主题曲|主題曲|插曲|宣传曲|OST|原声带|配乐`。
- **artists 页**：下架歌手命中名单时**直接造 `yda:` 兜底**，不信网易。
  以前只看"网易返回空"才兜底，但网易偶尔残留同名空壳（搜「李志」返回 nar:33603544，
  点进去没歌）→ 现在只要命中名单就统一走 yda:，点进去从 YouTube 拉歌（实测李志 40 首）。

### 版本
plugin.json 3.12.0 → **3.13.0**
