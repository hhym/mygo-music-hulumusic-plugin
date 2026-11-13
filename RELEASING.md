# 发布流程

单条 `main` 分支，发版就是「打 tag + 传 zip」。

## 版本号

`主版本.次版本.修订号`，SemVer：

| 段位 | 什么时候加 |
|---|---|
| 主版本 | 架构级重写、不兼容变更（比如改插件 id） |
| 次版本 | 新功能、新数据源、行为改进 |
| 修订号 | 只修 bug |

## 打包

只有这些进包，其他一律不进（`bin/`、测试脚本、`.git` 都不进）：

```
index.js  plugin.json  README.md  RELEASING.md
NOTES.md  BANNED_ARTISTS.md  deploy.sh  locales/
```

```bash
node --check index.js
zip -rq hulu-music-<版本>.zip \
  plugin.json index.js locales README.md NOTES.md \
  BANNED_ARTISTS.md RELEASING.md deploy.sh
```

## 发版

```bash
git add -A && git commit -m "1.2.0: ..." && git push
git tag v1.2.0 && git push origin v1.2.0
gh release create v1.2.0 hulu-music-1.2.0.zip --title "1.2.0" --notes "变更说明"
```

## 用户怎么装

```bash
git clone https://github.com/hhym/mygo-music-hulumusic-plugin.git \
  "$APPDATA/MyGo Music/plugins/hulu-music"
```

或解压 zip 到 `%APPDATA%\MyGo Music\plugins\hulu-music\`。

⚠️ MyGo 只在启动时读插件，装完要重启。

## 发版前检查

- `node --check index.js` 过
- `plugin.json` 里的 `version` 跟 tag 一致
- 新设置项、新权限（`permissions.network`）确实写进清单
- 电台 / 搜索 / 取流各抽一个真机跑通
- `bin/`（ffmpeg）不入库，首次使用时自动下载
