# 葫芦音乐 · 54 个源聚合在一个插件

葫芦音乐 2.0 起，把 [mygo-music-plugins](https://github.com/hhym/mygo-music-plugins) 里的 54 个单站插件合成这一个插件，取代 1.x 那套网易云 / B 站 / 酷我 / QQ / 播客音源。结构还是本仓库原来的样子：一份 `plugin.json`、一个 `index.js`、没有构建。

- 插件 id：`hulu-music`
- 版本：2.0.3（`minAppVersion` 0.1.20）
- 播放方式：`stream`

## 怎么用

首页之后就是四个分类（音乐 28 / DJ 音乐 2 / 听书 21 / 评书 3），点进去是该分类下的源；进某个源就是它原来的首页，曲目、歌单、专辑、搜索全按源自己的逻辑走。

track / 页面的 id 统一编成 `<源 id>:<源内 id>`，聚合层拆前缀分发；每个源的 `host.storage`、`host.setting` 都加了前缀，收藏与历史互不串味。

## 源清单（54 个）

### 音乐（28 个）

- **世纪音乐** `4c44-music` — 世纪音乐（www.4c44.com）的歌曲、榜单、歌单与动态歌词。
- **5nd音乐** `5nd-music` — 5nd音乐网的歌曲、榜单、歌手与专辑，带动态歌词。
- **凤梨音乐** `flmp3-music` — 凤梨音乐网（flmp3.pro）的歌曲、音乐合集与在线试听，带歌词。
- **优折美音乐** `uzz-music` — 优折美在线音乐播放器（m.uzz.me）的音源，网易云曲库的搜索、歌单与试听。
- **汽车音乐网** `carsmp3-music` — 汽车音乐网（www.carsmp3.com）的无损车载专辑目录，附网易云匹配试听。
- **闪闪音乐** `33ve` — 
- **5sing** `5sing` — 
- **动感酷音乐** `dgcol` — 
- **GD音乐台** `gdstudio` — 
- **好听轻音乐** `htqyy` — 
- **米乐迪音乐** `imelody` — 
- **米粒音乐** `milimusic` — 
- **无名音乐** `mvmp3` — 
- **小蜜蜂音乐** `xmfwav` — 
- **VY音乐** `yyvy` — 
- **听听网** `tingting` — 
- **九天音乐** `nine-sky` — 
- **布谷音乐** `buguyy-music` — 布谷音乐的热歌、新歌与搜索，320kbps mp3 直接播放，带 LRC 歌词。
- **一起听歌吧** `jusic-room` — 只读跟随 Jusic 听歌房（happy.alang.run）：房间正在播放和待播队列同步到这，能直接播；搜索可浏览房间里的曲目。
- **糖豆音乐** `tangdou` — 
- **广场舞地盘** `gcwdp` — 广场舞地盘的舞曲库、最新舞曲、交谊舞曲与轻音乐，站内试听地址现取现播。
- **IN音乐网** `inmp3` — IN音乐网（inmp3.com）的热门歌曲、分类榜单、搜索与在线试听。
- **放屁网** `fangpiw` — 放屁网（fangpiw.com）的热门珍藏、搜索与 MP3 试听片段。
- **7082音乐网** `music7082` — 7082音乐网（www.7082.cn）的原创音乐、分类、排行榜、搜索与 MP3 在线播放。
- **无忧音乐网** `ting05` — 无忧音乐网（ting05.com）的音乐首页、分类、搜索、歌曲详情与 m4a 在线播放。
- **番茄音乐** `fanqie-music` — 
- **大米饭** `damifan-music` — 大米饭的推荐、随机、标签、歌单与搜索，曲库上万首，320kbps mp3 直接播放。
- **24bit无损音乐** `24bit` — 

### DJ音乐（2 个）

- **DJ024电音** `dj024-music` — 沈阳DJ024电音传媒（www.dj024.com）的DJ舞曲、串烧与现场，带独家试听。
- **36DJ舞曲** `36dj-music` — 36DJ舞曲网（www.36dj.com）的DJ舞曲、串烧与车载大碟，含中文、英文、慢摇分类与人气榜。

### 听书（21 个）

- **猫耳FM** `missevan-music` — 猫耳FM（missevan.com）的广播剧、音乐音单与声音搜索，音单里的曲目可试听；可选按节目名到蜻蜓FM 找同名音频。
- **听书网** `tingshuwang-music` — 听书网（www.tingshuwang.cc）的有声小说：玄幻武侠、都市言情、恐怖悬疑等分类，按书籍收听全本章节。
- **恋听网** `ting55` — 
- **275听书** `i275` — 
- **听FM电台** `tingfm` — 
- **悦听吧** `yuetingba` — 
- **85听书网** `85ting` — 
- **环球听书** `hqkomics` — 
- **更快听书** `gkbasic` — 
- **爱上听书** `kmbas` — 
- **59听书** `ting59` — 
- **三九听书** `sanjiuwang` — 
- **瓜播听书** `guabo` — 
- **伊薇听书** `eweizhi` — 
- **一一听书** `eyihu` — 
- **我爱听书** `ipangxie` — 
- **幻听听书** `q062` — 
- **听友听书** `tingyou` — 
- **石头听书** `shitou` — 
- **易听书网** `yitingshu` — 易听书网（yitingshu.com）的有声小说、分类、搜索、专辑与章节播放。
- **99听书网** `ting99` — 99听书网（ting99.com）的有声小说、分类、搜索、专辑与章节播放。

### 评书（3 个）

- **单田芳评书网** `pingshu5` — 
- **我听评书网** `qmtsw` — 我听评书网（qmtsw.com）的评书分类、搜索、专辑章节与在线播放。
- **娓雅评书** `wpingshu` — 

## 已知取舍

- 首页只取 4 个代表源各一段，其余源都在分类页里，不再逐个拉首页，免得一进来就发几十个请求。
- 搜索按并发池同时打多个源（限并发，单源超时即放弃），结果是各源命中的合并，`album.name` 里标了来源。
- 只有部分源带专辑 / 歌手 / 歌单接口，对应页面按源能力显示，缺的源点了会提示没有。
- 需要 ffmpeg 转码的那几个源（HE-AAC、Layer II、HLS）依赖 `permissions.process`，聚合后统一在插件设置里配置。

## 图标

源列表、分类入口统一挂葫芦听音乐图标（`icon.png` 192×192，源列表那张由
[mygo-music-plugins](https://github.com/hhym/mygo-music-plugins) 的 `assets/hulu-music-v2.png` 经 jsdelivr 分发），
源自己没有 logo 时不再是一片空白；插件页的卡片图也用这张。

## 国内装不上怎么办

App 的在线更新直接拉 GitHub Release 资产，国内常常连不通（`dial tcp …:443: i/o timeout`）。
把 zip 存一份在 `dist/`，jsdelivr 可以直连：

```bash
curl -LO https://cdn.jsdelivr.net/gh/hhym/mygo-music-hulumusic-plugin@main/dist/hulu-music-2.0.3.zip
```

下完用 App 里「+ → 从本机 zip 安装」装上，功能一样；系统代理开着的话在线更新也会照常工作。

## 来源与重新生成

源都在 [mygo-music-plugins](https://github.com/hhym/mygo-music-plugins)，聚合层由那个仓库的
`tools/build-allinone.mjs` 生成，本仓库只存产物：

```bash
node tools/build-allinone.mjs --out /tmp/hulu --id hulu-music --name 葫芦音乐 --version 2.0.3 --icon assets/hulu-music-v2.png
```
