# 葫芦音源 · MyGo 插件

聚合多个音乐源的 [MyGo](https://github.com/egoist/mygo-music) 音源插件。跨平台源聚合、相互兜底，主流 App 找不到的曲目也能在这里补齐。

本项目基于 [@ZONGZI-000](https://github.com/ZONGZI-000) 的 [zongzi-mygo-plugin-beta](https://github.com/ZONGZI-000/zongzi-mygo-plugin-beta) 二次开发，在此致谢。

## 功能

| 模块 | 说明 |
|---|---|
| 搜索 | 单曲 / 歌手 / 专辑 / 歌单 / 播客，多源并发合并去重 |
| 首页 | 华语精选、欧美精选、新歌速递、下架歌手入口 |
| 歌单 | 自建歌单、我喜欢、收藏 |
| 歌手页 | 下架歌手走 YouTube 官方 Topic 频道拉完整曲库 |
| 专辑页 | 云音乐歌手目录 + YouTube 虚拟专辑兜底 |
| 电台 | 30+ 直播电台（SomaFM 等）+ Radio Browser 目录三万多台：按心情 / 流派 / 国家浏览，中国电台 1900+ 单独入口 |
| 播客 | 41 个分类，播客小镇 + Apple Podcasts + 云音乐电台三源合并 |
| QQ 音乐 | 独立入口：榜单分组（巅峰/地区/特色/全球）、歌单、专辑、歌手页与歌词，免登录 |

## 数据源

- **云音乐** — 搜索、歌单、歌手目录、电台节目
- **YouTube / YouTube Music** — 下架歌手主源（InnerTube 直连，无需 API Key）
- **酷我** — 搜索与取流
- **Apple Podcasts** — 播客搜索与歌手头像
- **播客小镇 (podtown.xyz)** — 266 个中文播客，自带 RSS
- **SomaFM / Radio France** — 直播电台
- **Radio Browser**（[jockcc/mygo-music-radio](https://github.com/jockcc/mygo-music-radio) 同源目录）— 三万多台真实电台，只列能解码的流；HLS 台自动用 ffmpeg 转 mp3
- **QQ 音乐** — 搜索（单曲混排 + 专辑/歌手/歌单补充）、专辑 `qqa:` / 歌手 `qqr:` / 歌单 `qqp:` / 榜单 `qqc:` / 歌词，匿名接口，付费曲目自动兜底 YouTube

## 播放相关

MyGo 的解码器限制很死，踩过不少：

- 只认 `mp3 / flac / ogg / wav / m4a / aac`，传别的会被当 mp3 解码后报错
- mp3 解码器（`hajimehoshi/go-mp3`）**只支持 MPEG Layer III**，Layer I/II 会报 `only layer3 is supported`
- **不支持 HE-AAC (SBR+PS)** → 播客 m4a 必须用 ffmpeg 转 mp3

## 安装

### 直接下载 zip（推荐）

最新版地址**固定不变**，出什么新版本都是这个链接：

```
https://github.com/hhym/mygo-music-hulumusic-plugin/releases/latest/download/hulu-music-latest.zip
```

解压到 `%APPDATA%\MyGo Music\plugins\hulu-music\` 即可。历史版本在 [Releases](https://github.com/hhym/mygo-music-hulumusic-plugin/releases) 里按版本号归档。

### 从源码装

```bash
git clone https://github.com/hhym/mygo-music-hulumusic-plugin.git \
  "$APPDATA/MyGo Music/plugins/hulu-music"
```

装完重启 MyGo。

### ffmpeg

`bin/`（ffmpeg 等平台二进制）不入库，首次用到转码时自动下载。有两点建议：

- **最好自备 ffmpeg**：把可用的 `ffmpeg.exe` 放到 `bin/win32-amd64/` 下即可，插件会直接用，省掉 78MB 下载和出错的概率
- 自动下载的源在 **GitHub release**，大陆网络可能连不上或很慢——如果一直卡在下载，挂代理，或干脆手动把 ffmpeg 放进上面的目录

## 版本

| 通道 | 版本号形态 | 分支 | 节奏 |
|---|---|---|---|
| 稳定版 | `1.0.1` | `master` | **少**，攒够验证过的改动才发 |
| 测试版 | `1.1.0-beta.7` | `beta` | **多**，随改随发 |

日常更新在 `beta`，稳定版是 `beta` 磨稳后的固化快照。发版流程见 [RELEASING.md](RELEASING.md)。

## 开发

```bash
node --check index.js      # 语法检查
node test_all.cjs          # 跑测试（沙箱 mock 了 host 环境）
./deploy.sh                # 部署到 MyGo（自动探测目录，也可传参）
```

`deploy.sh` 支持三种方式指定目标：

```bash
./deploy.sh                             # 自动探测
./deploy.sh "/d/MyGo/plugins/xxx"       # 指定路径
MYGO_PLUGIN_DIR=/some/dir ./deploy.sh   # 环境变量
```

⚠️ MyGo **只在启动时读插件**，部署完要重启才生效。

## 结构

```
index.js                插件主逻辑（~7600 行）
plugin.json             插件元信息 + 网络白名单
locales/zh-CN.json      界面文案
deploy.sh               部署脚本
NOTES.md                MyGo 播放器硬限制备忘
BANNED_ARTISTS.md       下架歌手整理
```

## 致谢

这个插件不是从零写起的东西，它站在几个开源项目的肩上：

- **[@ZONGZI-000](https://github.com/ZONGZI-000)** — [zongzi-mygo-plugin-beta](https://github.com/ZONGZI-000/zongzi-mygo-plugin-beta) 是本项目的起点：插件骨架、云音乐 / YouTube / 酷我 / B 站 / 播客的接入方式、ffmpeg 转码与播放器兼容性的那些坑，都出自这里。感谢作者把整套实现开源出来。
- **[@jockcc](https://github.com/jockcc)** — [mygo-music-radio](https://github.com/jockcc/mygo-music-radio) 提供了 Radio Browser 目录的接入思路与可播性判断，电台目录部分参考了它的做法。
- **[Radio Browser](https://www.radio-browser.info)** — 三万多台电台目录，由社区志愿者维护，免费开放。

## 说明

仅供个人学习与自用。曲库信息来自各平台公开接口，不对内容做二次分发。