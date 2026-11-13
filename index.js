// 葫芦音乐 · MyGo 原生插件 v3
// 聚合三大平台：网易云 · YouTube · 酷我（Kuwo）。
// 搜索各平台并发打，取流走各来源直链 + 跨平台兜底。
// 全部用 MyGo 沙箱原生 fetch（含 HTTP 302 跟随）。

/* ============================================================
 * 反识别：UA 轮换 + 请求节奏抖动
 * ------------------------------------------------------------
 * 固定 UA + 固定节奏的并发请求很像爬虫，平台侧容易据此聚类。
 * 这里做两件事：
 *   ① 每次请求从一组真实浏览器 UA 里随机取一个
 *   ② 请求之间加随机延迟（不改变并发结构，只打散时间点）
 *
 * ⚠️ 注意：YouTube 的 innertube 接口对 UA 和 client 是绑定的，
 *    乱换会导致 playabilityStatus 异常，所以那里保持固定 UA，
 *    只对网易云 / 酷我这两个「普通网页接口」轮换。
 * ============================================================ */
const UA_POOL_DESKTOP = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
];

const UA_POOL_MOBILE = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.7 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
];

/** 从池子里随机取一个（每次调用都换） */
function pickUA(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}
/** 桌面 UA（网易云网页接口用） */
function uaDesktop() {
  return pickUA(UA_POOL_DESKTOP);
}
/** 移动 UA（酷我搜索接口用） */
function uaMobile() {
  return pickUA(UA_POOL_MOBILE);
}

/** 请求前的随机等待，打散时间点（毫秒） */
function jitter(maxMs) {
  const ms = Math.floor(Math.random() * (maxMs || 260));
  return new Promise((r) => setTimeout(r, ms));
}

// 兼容旧代码里的 UA / UA_MOBILE 常量（内部仍会走随机）
const UA = UA_POOL_DESKTOP[0];
const UA_MOBILE = UA_POOL_MOBILE[0];

// ---------- 网易云 ----------
// cloudsearch/pc：比老 search/get 返回字段更全（originCoverType 原唱标记、pop 热度）
const NETEASE_SEARCH = "https://music.163.com/api/cloudsearch/pc";
const NETEASE_OUTER = "https://music.163.com/song/media/outer/url?id={id}.mp3";

// ---------- 酷我 ----------
const KUWO_SEARCH = "http://search.kuwo.cn/r.s";
const KUWO_CONVERT =
  "http://antiserver.kuwo.cn/anti.s?type=convert_url&format={fmt}&response=url&rid=MUSIC_{rid}";

// ---------- YouTube Music（music.youtube.com 的 WEB_REMIX 目录 + VISIONOS 取流） ----------
const YTM_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const YTM_CLIENT_VERSION = "1.20261018.16.00";
const YTM_CLIENT_NAME = "67"; // WEB_REMIX

// VISIONOS client —— 签发的直链没有 1MB 配额限制，能播完整首
const YT_VISIONOS = {
  name: "VISIONOS",
  ver: "1.02",
  nameId: 101,
  ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  deviceMake: "Apple",
  deviceModel: "RealityDevice17,1",
  osName: "visionOS",
  osVersion: "26.5.23O471",
};

// innertube key + visitorData（60 分钟缓存）
let ytKey = "";
let ytKeyAt = 0;
let ytVisitor = "";
let ytVisitorAt = 0;

// ------------------------- 通用工具 -------------------------
async function fetchText(url, opts = {}) {
  // 调用方没指定 UA 就随机取一个（YouTube innertube 那边都显式传，不受影响）
  const ua = (opts.headers && opts.headers["User-Agent"]) || uaDesktop();
  /* ⚠️⚠️ 全局默认超时，别删。
     实测（2026-11-08）：某个电台/平台的接口会接受 TCP 连接但**永不返回数据**，
     没有超时的 fetch 会一直挂着 —— 表现是「点歌一直转圈」「播客页卡死」
     「测试脚本跑 4 分钟无输出」。一个挂住的请求能把整条链路拖死。
     20 秒兜底；调用方自己传了 signal 就用调用方的。 */
  const res = await fetch(url, {
    headers: { "User-Agent": ua, ...(opts.headers || {}) },
    ...opts,
    signal: opts.signal || AbortSignal.timeout(20000),
  });
  const text = await res.text();
  return { res, text };
}



function durToMs(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  return n < 3000 ? Math.round(n * 1000) : Math.round(n);
}

function parseDur(s) {
  if (!s) return 0;
  s = String(s).trim();
  if (/^\d+$/.test(s)) return durToMs(s);
  const p = s.split(":").map(Number);
  if (p.length === 3 && p.every((n) => !isNaN(n))) return (p[0] * 3600 + p[1] * 60 + p[2]) * 1000;
  if (p.length === 2 && p.every((n) => !isNaN(n))) return (p[0] * 60 + p[1]) * 1000;
  return 0;
}

// ------------------------- YouTube Music bootstrap（取 innertube key + visitorData） -------------------------
async function ytBoot() {
  // key 从 www.youtube.com/sw.js 抓（仅 12KB，比整张 watch 页 500KB 快得多）
  async function getKey() {
    const { text } = await fetchText("https://www.youtube.com/sw.js", {
      headers: { "User-Agent": YTM_UA },
    });
    const m = String(text).match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    if (!m) throw new Error("yt: 无法获取 innertube key");
    return m[1];
  }
  // visitorData 从 visitor_id 接口换（1KB）
  async function getVisitor(key) {
    const { text } = await fetchText(
      "https://www.youtube.com/youtubei/v1/visitor_id?key=" + key,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": YTM_UA },
        body: JSON.stringify({
          context: {
            client: { clientName: "WEB", clientVersion: "2.20250101.00.00", hl: "en", gl: "US" },
          },
        }),
      }
    );
    const d = JSON.parse(text);
    const rc = (d && d.responseContext) || {};
    if (!rc.visitorData) throw new Error("visitor_id 无 visitorData");
    return rc.visitorData;
  }

  if (ytKey && ytVisitor && Date.now() - ytKeyAt < 60 * 60 * 1000)
    return { key: ytKey, visitor: ytVisitor };

  const key = await getKey();
  const visitor = await getVisitor(key);
  ytKey = key;
  ytVisitor = visitor;
  ytKeyAt = Date.now();
  return { key, visitor };
}

// YouTube 搜索（主站 ANDROID client，稳定出歌曲；带音乐过滤参数）
const YT_ANDROID_VER = "20.10.38";
const YT_ANDROID_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip";
const YT_SEARCH_PARAMS = "EgIQAQ%3D%3D"; // 音乐搜索过滤位

function ytCtx(opts) {
  const client = {
    clientName: "ANDROID",
    clientVersion: YT_ANDROID_VER,
    hl: "zh-CN",
    gl: "CN",
    userAgent: YT_ANDROID_UA,
    androidSdkVersion: 34,
  };
  /* ⚠️⚠️ clientFormFactor 是把双刃剑，只在 browse 时加（2026-11-09 实测）：
       · browse 不带它 → 400 INVALID_ARGUMENT（285 字节），拿不到频道页
       · browse 带上它 → 200，4.3MB 完整频道数据 ✅
       · search 带上它 → 返回的是**另一套页面结构**（章节/提示类渲染器），
         里面一个 videoRenderer 都没有 → 搜索解析全线 0 条 ❌
     所以：browse 传 { noFormFactor: false }（默认带），search 必须显式传
     { noFormFactor: true } 把它摘掉。 */
  if (opts && opts.noFormFactor) {
    // search 用：保持精简（不带 formFactor）
  } else {
    client.clientFormFactor = "SMALL_FORM_FACTOR";
  }
  return {
    client: client,
    user: { lockedSafetyMode: false },
    request: { useSsl: true },
  };
}
function ytHeaders() {
  return {
    "Content-Type": "application/json",
    "User-Agent": YT_ANDROID_UA,
    "X-YouTube-Client-Name": "3",
    "X-YouTube-Client-Version": YT_ANDROID_VER,
  };
}

/* ============ YouTube 频道/艺人页（browse） ============
   ⚠️ browse 必须带 clientFormFactor（见 ytCtx 注释），否则 400。
   能做什么：
     · ytBrowseChannel(channelId)        → 拿频道页里的 VL 播放列表 id（艺人 Top songs）
     · ytArtistSongs(channelId)          → 拉该艺人的歌曲列表（Top songs 播放列表的全部内容）
   用途：下架歌手「纯搜歌手」时，不用再靠代表作去猜 —— 直接拉他官方频道里的歌。 */
async function ytBrowse(browseId, params) {
  const boot = await ytBoot();
  const body = { context: ytCtx(), browseId: browseId };
  if (params) body.params = params;
  const { text } = await fetchText(
    "https://www.youtube.com/youtubei/v1/browse?key=" + boot.key + "&prettyPrint=false",
    { method: "POST", headers: ytHeaders(), body: JSON.stringify(body) }
  );
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* 从任意 browse 返回里收集轨道（兼容多种渲染器命名）。
   ⚠️ YouTube 的字段名一直在变（videoRenderer / lockupViewModel /
      musicResponsiveListItemRenderer…），所以按「有 videoId 就认」来抓，
      再做一次去重。 */
function harvestTracks(node, out, seen) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) harvestTracks(x, out, seen);
    return;
  }
  // 直接形态：videoRenderer
  if (node.videoId && typeof node.videoId === "string" && node.videoId.length === 11) {
    const vid = node.videoId;
    if (!seen.has(vid)) {
      seen.add(vid);
      const title =
        (node.title && (node.title.simpleText || ((node.title.runs || []).map((r) => r.text).join("")))) ||
        "";
      const owner =
        (node.ownerText && (node.ownerText.runs || []).map((r) => r.text).join("")) ||
        (node.longBylineText && (node.longBylineText.runs || []).map((r) => r.text).join("")) ||
        "";
      const dur =
        (node.lengthText &&
          (node.lengthText.simpleText || ((node.lengthText.runs || []).map((r) => r.text).join("")))) ||
        "";
      out.push({
        id: vid,
        title: String(title),
        artist: String(owner),
        durationText: String(dur),
        artwork: ((node.thumbnail && node.thumbnail.thumbnails) || []).slice(-1)[0]?.url || "",
        chanId: "",
      });
    }
  }
  for (const k of Object.keys(node)) harvestTracks(node[k], out, seen);
}

/** 拉频道页，返回里面的 VL 播放列表 id 列表（艺人 Top songs 等） */
async function ytChannelPlaylists(channelId) {
  const data = await ytBrowse(channelId);
  if (!data) return [];
  const s = JSON.stringify(data);
  const ids = [...new Set([...s.matchAll(/"browseId":"(VL[\w-]+)"/g)].map((m) => m[1]))];
  return ids;
}

/** 从 browse 响应里取 continuation token（分页用） */
function pickContinuation(data) {
  if (!data) return "";
  const s = JSON.stringify(data);
  // continuationItemRenderer / nextContinuationData / continuationCommand 三种形态
  const m =
    s.match(/"continuationCommand":\{"token":"([^"]+)"/) ||
    s.match(/"nextContinuationData":\{[^}]*?"continuation":"([^"]+)"/) ||
    s.match(/"continuation":"([A-Za-z0-9_%-]{40,})"/);
  return m ? m[1] : "";
}

/** 拉一个播放列表（VL 前缀）里的全部曲目 —— 带分页。
    ⚠️ 一个播放列表可能有很多页（长播放列表），
       不翻页只能拿到第一页（通常 100 首以内）。
       分页走 browse + continuation token，最多翻 maxPages 页防止死循环。 */
async function ytPlaylistTracks(playlistId, maxPages) {
  const cap = Number(maxPages) > 0 ? Number(maxPages) : 8;
  const out = [];
  const seen = new Set();
  let data = await ytBrowse(playlistId);
  let page = 0;
  while (data && page < cap) {
    harvestTracks(data, out, seen);
    const token = pickContinuation(data);
    if (!token) break;
    page++;
    data = await ytBrowse(playlistId, null, token).catch(() => null);
  }
  return out;
}

/** 拉某艺人频道里的全部歌曲。
    两条路并用，取并集：
      ① 频道页里的 VL 播放列表（Top songs / auto-mix）—— 带分页
      ② 频道页里出现的所有 videoId（新版频道页直接铺视频网格）
    ⚠️ Top songs 播放列表只有约 10 首，所以不能只靠它。
       ANDROID 客户端拿不到 YouTube Music 的艺人专辑结构（无 MPREb），
       所以这里靠"频道页直铺 + 播放列表分页"尽量多捞。 */
/* 艺人曲目缓存的索引表 key 与容量上限（常量必须在 ytArtistSongs 之前声明） */
const ART_CACHE_INDEX = "ytArtIndex";
const ART_CACHE_MAX = 40;

/** 取某位下架歌手的头像。
    优先级：
      ① 已缓存的频道曲目缩略图（0 请求，最快）
      ② 没有缓存 → 现拉一次频道（限时 3 秒，超时就放弃，不拖慢搜索）
      ③ 都失败 → 空（交给 UI 兜底）
    ⚠️ ② 之所以要限时：browse 频道页正常 1-2 秒，但网络差时可能 10 秒+，
       搜索结果页面不能被它卡住。3 秒内拿不到就先用空头像。
       拿到之后会写进缓存，下次搜索直接命中（0 请求）。 */
async function artistThumbOf(name) {
  /* ⭐ 首选：Apple Music 的专辑封面（当头像用）。
     ⚠️ 为什么放弃网易（2026-11-09 实测教训）：
        网易 search/get?type=100 会返回**一堆 AI 蹭名歌手**
        （搜「赵薇」只回「赵薇薇」，搜「脆弱少女组」回「赵雷/卓文萱/薛凯琪」），
        严格名字匹配后 25 位里只能拿到 10 位，而且拿到的那张图也是蹭名号的。
        Apple 干净得多：赵薇/李志/卢广仲/达明一派都能精确命中真歌手，封面是官方专辑图。

     ⚠️ Apple 的 entity=musicArtist **没有 artwork 字段**（只有 artistName/artistId），
        所以要用 entity=song 搜，从歌曲记录里取 artworkUrl100
        （那是专辑封面，尺寸 100x100，把 100x100 换成 600x600 就是高清）。
     ⚠️ country 用 tw：这批下架歌手在台湾店上架更全（cn 店被清）。 */
  const ck = "artThumb:" + name;
  try {
    const v = host.storage.get(ck);
    if (typeof v === "string" && v) return v;
  } catch {}
  // ① Apple Music 专辑封面（严格歌手名匹配）
  try {
    const { text } = await fetchText(
      "https://itunes.apple.com/search?term=" + encodeURIComponent(name) +
        "&entity=song&limit=20&country=tw",
      {
        headers: { "User-Agent": uaDesktop() },
        signal: AbortSignal.timeout(10000),
      }
    );
    const j = JSON.parse(text);
    const songs = ((j && j.results) || []).filter((x) => x && x.wrapperType === "track");
    const simpName = toSimplified(name).replace(/\s/g, "");
    /* 严格匹配：歌手名去掉空格后完全相等。
       ⚠️ 不放松成「包含」——「陈升」会命中「劉若英 & 陳昇」，
          那张封面是合唱专辑的，不是他的个人作品。 */
    const exact = songs.filter(
      (x) => toSimplified(String(x.artistName || "")).replace(/\s/g, "") === simpName
    );
    const pick = exact.find((x) => x.artworkUrl100) || null;
    if (pick) {
      const pic = String(pick.artworkUrl100).replace(/\/\d+x\d+bb\./, "/600x600bb.");
      try {
        host.storage.set(ck, pic);
      } catch {}
      return pic;
    }
  } catch {}
  // ② 退回 YouTube 频道缓存里的缩略图
  try {
    const d = dictOf(name);
    if (d && d.yt) {
      const c = host.storage.get("ytArt:" + d.yt);
      if (c && Array.isArray(c.list)) {
        const t = c.list.find((x) => x && x.artwork);
        if (t) return String(t.artwork);
      }
    }
  } catch {}
  return "";
}

/* 按字典的 only 白名单筛曲目。
   ⚠️ 为什么需要：福禄寿 2023 年重组为 DOUDOU，两个名字共用同一个
      YouTube 频道，而 YouTube 单曲元数据里 **artist 字段是空的**，
      没法靠署名分开。只能在字典里人工列白名单按曲名区分。
   ⚠️⚠️ 必须用**精确匹配**（不是 contains）：
      之前用互相包含，结果「超度我」把「超度我 (Live)」也算成福禄寿，
      「馬」和「马」繁简归一后也串台，两个歌手页出现大段重叠。
      现在只归一空格和首尾括号外的标点，括号里的 (Live)/(Remix)/(日文版)
      保留下来当作区分依据 —— 同名不同版本正好靠它分开。
   没配 only 的歌手原样返回。 */
function normSongKey(x) {
  /* ⚠️ 这里**故意不做繁简转换**：频道里同时有《马》(简体，福禄寿) 和
     《馬》(繁体，DOUDOU 日文版)，繁简归一后两条会变成同一个 key，
     没法区分。保留原字形反而正好把它们分开。
     英文字母统一小写即可。 */
  return String(x || "")
    .replace(/\s/g, "")
    .replace(/[·・]/g, "")
    .replace(/[「」『』【】"'’“”]/g, "")
    .toLowerCase();
}
function filterByOnly(name, songs) {
  if (!Array.isArray(songs) || !songs.length) return songs;
  const d = dictOf(name);
  if (!d || !Array.isArray(d.only) || !d.only.length) return songs;
  const keys = new Set(d.only.map(normSongKey).filter(Boolean));
  return songs.filter((t) => {
    const k = normSongKey(t.title);
    if (!k) return false;
    if (keys.has(k)) return true;
    /* 频道里有些标题带宣传前缀，比如
       「DOUDOU｜动画《记忆管理局》OP《忘记了也没关系》发布」
       —— 去掉「XX｜」前缀和「发布/Official Music Video」尾巴再试一次 */
    const trimmed = k
      .replace(/^[^｜|]{1,12}[｜|]/, "")
      .replace(/(officialmusicvideo|officialvideo|发布|mv|完整版)$/g, "");
    /* ⚠️ 只做精确匹配，不做任何「包含/前缀」放宽。
       踩过两次：① 互相包含 →「超度我」把「超度我 (Live)」算给福禄寿；
                 ② 前缀匹配 →「我用什么把你留住」被
                    「我用什么把你留住 (Remix)」这条 DOUDOU 白名单捞走。
       白名单条目就是完整标题，照抄即可，不需要模糊。 */
    return keys.has(trimmed);
  });
}

async function ytArtistSongs(channelId, opts) {
  /* ⚠️ 结果做本地缓存（host.storage），TTL 7 天。
     为什么：一个频道的曲目列表基本不变，但每次搜索都要发 2-4 个请求
     （频道首页 + 播放列表分页），慢且容易被风控。
     缓存后：第一次 1-2 秒，之后 0 延迟。
     体积：实测单条 194 字节，一个歌手 50 首 ≈ 10KB，25 位歌手 ≈ 250KB。
     ⚠️ 用 maxAge 控制是否强制刷新（opts.refresh=true 时跳过缓存）。 */
  const cacheKey = "ytArt:" + channelId;
  const TTL = 7 * 24 * 60 * 60 * 1000;
  if (!(opts && opts.refresh)) {
    try {
      const c = host.storage.get(cacheKey);
      if (c && Array.isArray(c.list) && c.list.length && Date.now() - (c.at || 0) < TTL) {
        trace("频道曲目命中缓存", channelId.slice(0, 12) + " " + c.list.length + "首");
        return c.list;
      }
    } catch {}
  }

  const all = [];
  const seen = new Set();
  /* ⚠️⚠️ 必须过滤「没有标题」的条目（2026-11-09 踩的坑）：
     频道首页（browse UC...）里那 52 个 videoId **全是 watchEndpoint**
     （播放按钮里的跳转指令），不是视频条目 —— 采集后 id 有、标题/歌手/时长全空。
     结果歌手页显示 52 首「名字是空白」的歌，用户根本没法点。
     只有 VL 播放列表里的条目才有完整 title/artist/duration。
     所以：只收有标题的，没标题的直接丢掉。 */
  const push = (list) => {
    for (const t of list || []) {
      if (!t || !t.id || seen.has(t.id)) continue;
      if (!t.title || !String(t.title).trim()) continue; // 没标题 = 不是真条目
      seen.add(t.id);
      all.push(t);
    }
  };

  /* ① VL 播放列表优先（唯一有完整元数据的来源），多拉几个提高覆盖
     ⚠️ 顺序很重要：之前是先频道首页后播放列表，导致 52 个空标题条目
        先把 all 撑满，真歌反而被 seen 挡在后面。
     ⚠️⚠️ 不能只拉前 3 个：Topic 频道（如红花会 Hong Hua Hui - Topic）
        是「一首歌一个播放列表」，12 个列表各 1 首，只拉 3 个就只剩 3 首。
        所以按列表总数动态取上限，最多 16 个。 */
  const pls = await ytChannelPlaylists(channelId).catch(() => []);
  const plCap = Math.min(pls.length, 16);
  /* 并发拉（每批 4 个）—— 串行 16 个太慢，全并发又容易被限流 */
  for (let i = 0; i < plCap; i += 4) {
    const batch = pls.slice(i, Math.min(i + 4, plCap));
    const got = await Promise.all(batch.map((pl) => ytPlaylistTracks(pl, 2).catch(() => [])));
    for (const list of got) push(list);
  }

  // ② 频道首页兜底（新版页面里如果真有 videoRenderer 网格，能补一些）
  if (all.length === 0) {
    const home = await ytBrowse(channelId).catch(() => null);
    if (home) {
      const tmp = [];
      harvestTracks(home, tmp, new Set());
      push(tmp);
    }
  }

  // 写缓存（只存必要字段，省体积）
  if (all.length) {
    try {
      host.storage.set(cacheKey, {
        at: Date.now(),
        list: all.map((t) => ({
          id: t.id,
          title: t.title,
          artist: t.artist,
          durationText: t.durationText,
          artwork: t.artwork,
          chanId: t.chanId,
        })),
      });
      // 更新索引（channelId + 时间），供 pruneArtistCache 清理用
      try {
        const idx = readList(ART_CACHE_INDEX).filter((x) => x && x.id !== channelId);
        idx.push({ id: channelId, at: Date.now(), n: all.length });
        writeList(ART_CACHE_INDEX, idx);
      } catch {}
      pruneArtistCache();
    } catch {}
  }
  return all;
}

/* 艺人缓存清理：最多保留 MAX 个频道，超了就删最旧的。
   ⚠️ host.storage 没有"列出所有 key"的能力，所以自己维护一个索引表。
      索引只存 channelId + 时间戳，几十字节，可以放心存。 */
function pruneArtistCache() {
  try {
    const idx = readList(ART_CACHE_INDEX);
    if (idx.length <= ART_CACHE_MAX) return;
    // 按时间升序，删掉最老的
    idx.sort((a, b) => (a.at || 0) - (b.at || 0));
    const drop = idx.splice(0, idx.length - ART_CACHE_MAX);
    for (const d of drop) {
      try {
        host.storage.remove ? host.storage.remove("ytArt:" + d.id) : host.storage.set("ytArt:" + d.id, null);
      } catch {}
    }
    writeList(ART_CACHE_INDEX, idx);
  } catch {}
}

/** 多关键词并发搜索并合并去重（下架歌手用：一次搜歌手名、一次搜「歌手名 Topic」） */
/* 把可能被 YouTube 年龄验证拦掉的查询词换成能出结果的。
   ⚠️ 背景：搜「阴三儿」这种被标记成人内容的歌手，YouTube 直接返回
      「确认您的年龄」页（约 8KB，零 videoRenderer）→ 解析出 0 条。
      实测加歌名或换繁体都能绕过，所以字典里给这类歌手配 safeQuery。
   只在「查询词里只含歌手名、没有具体歌名」时替换，
   用户主动搜「阴三儿 北京晚报」时不干预。 */
function ytSafeQueries(q) {
  const src = String(q || "").trim();
  if (!src) return [src];
  const d = dictOf(src);
  if (!d || !Array.isArray(d.safeQuery) || !d.safeQuery.length) return [src];
  /* 纯歌手名（或只带空格/别名）才替换 */
  const norm = normSongKey(src);
  const isPure =
    norm === normSongKey(artistKeyOf(src)) ||
    (Array.isArray(d.alias) && d.alias.some((a) => norm === normSongKey(a)));
  if (!isPure) return [src];
  return d.safeQuery.slice();
}

/** 从字典里反查「这个查询词对应哪个歌手名」 */
function artistKeyOf(q) {
  const s = String(q || "").trim();
  if (ARTIST_DICT[s]) return s;
  const simp = toSimplified(s);
  for (const k of Object.keys(ARTIST_DICT)) {
    if (toSimplified(k) === simp) return k;
    /* 也认别名：「陰三兒」「LadyNana」这类写法要能归到同一个歌手 */
    const d = ARTIST_DICT[k];
    if (d && Array.isArray(d.alias) && d.alias.some((a) => toSimplified(String(a)) === simp)) return k;
  }
  return s;
}

async function ytSearchMulti(queries) {
  /* ⚠️ 先做「年龄墙」规避替换：把可能被拦的查询词展开成能出结果的 */
  const expanded = [];
  const seenQ = new Set();
  for (const q of queries) {
    for (const qq of ytSafeQueries(q)) {
      const k = String(qq).trim();
      if (!k || seenQ.has(k)) continue;
      seenQ.add(k);
      expanded.push(k);
    }
  }
  const lists = await Promise.all(expanded.map((q) => ytSearch(q).catch(() => [])));
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const t of list) {
      if (!t || !t.id || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }

  /* ⚠️ 字典里登记过的歌手，搜索结果必须再过一遍相关性过滤。
     原因：这类「下架歌手 / 冷门乐团」在 YouTube 上没有官方频道，
     只能靠搜索召回，而搜索结果会大量跑偏 ——
     实测「大买麦乐团」那 20 条里混着《乐队的夏天》鼓手简评、郭富城金曲串烧、
     甚至柯林·佩里濒死体验的阴谋论视频；「盘古乐队」混进万能青年旅店。
     规则：标题或歌手名里必须出现歌手名/别名/代表作（繁简都算），否则丢掉。
     ⚠️ 既然后面还有代表作多路搜，这里不能过滤太狠 ——
        过滤后少于 3 条就整体退回原结果。 */
  const knownArtist = queries.map((q) => artistKeyOf(q)).find((n) => {
    const d = dictOf(n);
    return !!(d && (Array.isArray(d.hits) || Array.isArray(d.safeQuery)));
  });
  if (knownArtist) {
    const d = dictOf(knownArtist);
    const names = [knownArtist]
      .concat(d.alias || [], d.hits || [])
      .map((x) => toSimplified(String(x)).toLowerCase().replace(/\s/g, ""))
      .filter(Boolean);
    const keep = out.filter((t) => {
      const hay = (toSimplified(String(t.title || "")) + " " + toSimplified(String(t.artist || "")))
        .toLowerCase()
        .replace(/\s/g, "");
      return names.some((n) => n && hay.indexOf(n) >= 0);
    });
    /* 过滤后留太少就退回原结果，避免一刀切把页面清空 */
    if (keep.length >= 3) {
      out.length = 0;
      keep.forEach((t) => out.push(t));
    }
  }
  /* 多路搜合并后，再按「频道集中度」重算一次音乐人标记
     —— 单路搜可能因为结果少（<5 条）没触发，合并后就能判断了。 */
  if (out.length >= 5) {
    const freq = new Map();
    for (const t of out) {
      const c = String(t.chanId || "");
      if (!c) continue;
      freq.set(c, (freq.get(c) || 0) + 1);
    }
    if (freq.size) {
      let topChan = "";
      let topN = 0;
      for (const [c, n] of freq) if (n > topN) { topN = n; topChan = c; }
      if (topN >= 3 && topN / out.length >= 0.15) {
        for (const t of out) if (t.chanId === topChan) t._ytArtistChan = true;
        console.log("[葫芦] YT 音乐人识别(合并后)：频道 " + topChan + " 占 " + topN + "/" + out.length);
      }
    }
  }
  return out;
}

async function ytSearch(query) {
  const key = await ytBoot().then((b) => b.key);
  const url = "https://www.youtube.com/youtubei/v1/search?key=" + key + "&prettyPrint=false";
  // ⚠️ search 必须显式 noFormFactor:true —— 带上 formFactor 会返回另一套页面结构，解析不出视频条目
  const body = JSON.stringify({ context: ytCtx({ noFormFactor: true }), query: query, params: YT_SEARCH_PARAMS });
  const { text } = await fetchText(url, { method: "POST", headers: ytHeaders(), body: body });
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const out = [];
  (function walk(o, d) {
    if (!o || typeof o !== "object" || d > 22) return;
    if (Array.isArray(o)) {
      for (let i = 0; i < o.length; i++) walk(o[i], d + 1);
      return;
    }
    for (const k of Object.keys(o)) {
      if (k === "videoRenderer" || k === "compactVideoRenderer") {
        const v = o[k];
        if (v && v.videoId) {
          /* 顺手抓出这条视频所属频道的 UC id —— 后面用它判断
             「这个频道是不是 YouTube 官方音乐人频道（Topic/官方艺人）」。 */
          let chanId = "";
          try {
            const be =
              (v.ownerText && v.ownerText.runs && v.ownerText.runs[0] &&
                v.ownerText.runs[0].navigationEndpoint &&
                v.ownerText.runs[0].navigationEndpoint.browseEndpoint) ||
              (v.longBylineText && v.longBylineText.runs && v.longBylineText.runs[0] &&
                v.longBylineText.runs[0].navigationEndpoint &&
                v.longBylineText.runs[0].navigationEndpoint.browseEndpoint);
            if (be && be.browseId) chanId = String(be.browseId);
          } catch {}
          out.push({
            id: v.videoId,
            title:
              ((v.title && v.title.runs) || []).map((x) => x.text).join("") ||
              (v.title && v.title.simpleText) ||
              "",
            artist:
              ((v.ownerText && v.ownerText.runs) || []).map((x) => x.text).join("") ||
              ((v.longBylineText && v.longBylineText.runs) || []).map((x) => x.text).join("") ||
              "",
            durationText:
              (v.lengthText &&
                (v.lengthText.simpleText ||
                  ((v.lengthText.runs || []).map((x) => x.text || "").join("")))) ||
              "",
            artwork: ((v.thumbnail && v.thumbnail.thumbnails) || []).slice(-1)[0].url || "",
            chanId: chanId,
          });
        }
      }
      walk(o[k], d + 1);
    }
  })(data, 0);

  /* 【YouTube Music「音乐人」加权】
     实测（2026-11-08）：ANDROID 客户端的搜索响应里**没有** musicArtistRenderer /
     musicResponsiveListItemRenderer 节点（那些是 YTM 网页版才有的），
     但每条 videoRenderer 都带 `ownerText.runs[0].navigationEndpoint.browseEndpoint.browseId`
     = 频道 UC id。这已经够用了：
       · 官方音乐人频道（Topic / Artist）的 id 是稳定的 UC 号，且**同一歌手所有官方稿件
         都挂在同一个 UC 下**；
       · 搬运号/粉丝号各有各的 UC，且通常一条视频一个号。
     所以统计「本批结果里各 UC 出现次数」，**出现次数最多的那个 UC 就是这位歌手的官方频道**
     （同一歌手的官方曲目会大量集中），把该 UC 下的条目加分，其它 UC 的降权。
     这比按频道名猜「- Topic」可靠：官方频道名可能叫「周杰倫 Jay Chou」而不是「周杰伦 - Topic」。 */
  if (out.length >= 5) {
    const freq = new Map();
    for (const t of out) {
      const c = String(t.chanId || "");
      if (!c) continue;
      freq.set(c, (freq.get(c) || 0) + 1);
    }
    if (freq.size) {
      let topChan = "";
      let topN = 0;
      for (const [c, n] of freq) {
        if (n > topN) { topN = n; topChan = c; }
      }
      // 至少占 15% 才认（否则是噪声，不是「官方集中」）
      if (topN >= 3 && topN / out.length >= 0.15) {
        for (const t of out) {
          if (t.chanId === topChan) t._ytArtistChan = true;
        }
        console.log(
          "[葫芦] YT 音乐人识别：频道 " + topChan + " 占 " + topN + "/" + out.length + " 条 → 官方音乐人加权"
        );
      }
    }
  }
  return out;
}

// YouTube Music 取流（VISIONOS client，无 1MB 配额限制）
async function ytStream(videoId) {
  const { key, visitor } = await ytBoot();
  const url = "https://www.youtube.com/youtubei/v1/player?key=" + key + "&prettyPrint=false";
  const body = {
    context: {
      client: {
        clientName: YT_VISIONOS.name,
        clientVersion: YT_VISIONOS.ver,
        deviceMake: YT_VISIONOS.deviceMake,
        deviceModel: YT_VISIONOS.deviceModel,
        userAgent: YT_VISIONOS.ua,
        osName: YT_VISIONOS.osName,
        osVersion: YT_VISIONOS.osVersion,
        hl: "zh-CN",
        gl: "CN",
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
    },
    visitorData: visitor,
    videoId: videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  const { text } = await fetchText(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": YT_VISIONOS.ua,
      "X-YouTube-Client-Name": String(YT_VISIONOS.nameId),
      "X-YouTube-Client-Version": YT_VISIONOS.ver,
      "X-Goog-Visitor-Id": visitor,
    },
    body: JSON.stringify(body),
  });
  const data = JSON.parse(text);
  const ps = data.playabilityStatus || {};
  if (ps.status !== "OK")
    throw "yt: " + (ps.status || "?") + " " + String(ps.reason || "").slice(0, 40);
  const sd = data.streamingData || {};
  const all = (sd.formats || []).concat(sd.adaptiveFormats || []);
  const audios = all
    .filter((f) => f.url && /audio/.test(f.mimeType || ""))
    .map((f) => ({
      itag: f.itag,
      mime: (f.mimeType || "").split(";")[0].trim(),
      bitrate: Number(f.bitrate || 0),
      url: f.url,
      size: Number(f.contentLength || 0),
    }))
    .sort((a, b) => b.bitrate - a.bitrate);
  if (!audios.length) throw "yt: 无音频流";

  /* ⚠️ YouTube 的 audio/mp4（itag 139/140）全是 DASH 分片流：
       文件头是 "ftypdash"，样本数据在 moof 里，stbl 表是空的。
     MyGo 的 mp4 解析器读到空 stbl 就抛 "mp4: bad sample table"，
     播放器直接报错。

     audio/webm（itag 251/250/249，Opus）不受影响 —— MyGo 走 EBML/Ogg 解析，
     不碰 stbl 表，实测文件头 1A 45 DF A3 正常。

     所以**优先选 webm**，mp4 只在没有 webm 时才兜底（并标记为实验性）。
     代价：Opus 160kbps vs AAC 128kbps，音质反而更好。 */
  const WEBM_PREF = [251, 250, 249];
  const MP4_PREF = [141, 140, 139];
  let pick = null;
  for (const itag of WEBM_PREF) {
    const hit = audios.find((a) => a.itag === itag);
    if (hit) {
      pick = hit;
      break;
    }
  }
  if (!pick) {
    // 没命中标准 webm itag，就按 mime 找任意 webm
    pick = audios.filter((a) => a.mime.indexOf("webm") >= 0).sort((a, b) => b.bitrate - a.bitrate)[0];
  }
  if (!pick) {
    for (const itag of MP4_PREF) {
      const hit = audios.find((a) => a.itag === itag);
      if (hit) {
        pick = hit;
        break;
      }
    }
  }
  if (!pick) pick = audios[0];
  // webm → ogg（MyGo 的 EBML/Ogg 通道）；mp4 容器 → 也标 ogg 是错的，标 m4a 让 app 按内容探测
  const type = pick.mime.indexOf("webm") >= 0 ? "ogg" : "m4a";
  return { url: pick.url, type, bitrate: pick.bitrate };
}

// ------------------------- 音频格式探测 -------------------------
/* ⚠️ MyGo 的 mp3 解码器是 github.com/hajimehoshi/go-mp3，限制很死：
     - 只支持 MPEG Layer III（Layer I/II 直接报 "only layer3 ... is supported"）
     - 不支持 free-format（bitrate index = 0，报 "free bitrate format is not supported"）

   各平台偶尔会返回这种非标准文件（尤其酷我/网易云的老资源、MP2 编码的
   翻唱/现场）。用户看到的就是播放直接报错。

   所以返回直链前先取头部验一次格式，不合法就换下一条源。 */
const MP3_BITRATE_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATE_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** 探测音频容器/编码是否被 MyGo 接受 */
function detectAudio(bytes) {
  const b = bytes;
  if (!b || b.length < 12) return { fmt: "unknown", ok: false, why: "太短" };
  // 常见容器魔数 —— 这些 MyGo 都能解码
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    return { fmt: "webm", ok: true, why: "EBML/WebM" };
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53)
    return { fmt: "ogg", ok: true, why: "OggS" };
  if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43)
    return { fmt: "flac", ok: true, why: "fLaC" };
  if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70)
    return { fmt: "mp4", ok: true, why: "ftyp(m4a/mp4)" };
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46)
    return { fmt: "wav", ok: true, why: "RIFF/WAV" };
  // ID3 标签头：跳过标签再找帧（这里只判标签存在，交给下面找帧）
  let start = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    start = 10 + size;
    if (start >= b.length) return { fmt: "mp3", ok: true, why: "ID3(帧在标签后)" };
  }
  // 找裸 MP3 帧
  const limit = Math.min(b.length - 4, start + 4096);
  for (let i = start; i < limit; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (b[i + 1] >> 3) & 3;
    const layer = (b[i + 1] >> 1) & 3;
    const brIdx = (b[i + 2] >> 4) & 0xf;
    const srIdx = (b[i + 2] >> 2) & 3;
    if (layer === 0 || brIdx === 15 || srIdx === 3) continue;
    if (layer !== 1) return { fmt: "mp3", ok: false, why: "非 Layer3（层 " + layer + "）" };
    if (brIdx === 0) return { fmt: "mp3", ok: false, why: "free bitrate" };
    const br = ver === 3 ? MP3_BITRATE_V1L3[brIdx] : MP3_BITRATE_V2L3[brIdx];
    if (!br) continue;
    return { fmt: "mp3", ok: true, why: "MPEG L3 " + br + "kbps" };
  }
  return { fmt: "unknown", ok: false, why: "无有效音频帧" };
}

/** 取头部实际字节验格式；网络失败时放行（不因探测失败误杀）。
    ⚠️ 用流式读头而不是 res.arrayBuffer()：arrayBuffer 会等 body 读完，
       而直播流（icecast / 网络电台）是无限的，Range 常被忽略返回整条流，
       那样会一直挂到超时。改成读满 36KB 就 cancel，立刻能判断格式。 */
async function checkAudioUrl(url, timeoutMs = 6000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: { Range: "bytes=0-8191" },
      signal: ctrl.signal,
    });
    if (!res.ok && res.status !== 206) {
      clearTimeout(timer);
      return { ok: true, fmt: "unknown", why: "HTTP " + res.status };
    }
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) {
      clearTimeout(timer);
      const buf = new Uint8Array(await res.arrayBuffer().catch(() => new Uint8Array(0)));
      return detectAudio(buf);
    }
    const chunks = [];
    let total = 0;
    const deadline = Date.now() + 4000;
    while (total < 36864 && Date.now() < deadline) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      if (value && value.length) { chunks.push(value); total += value.length; }
    }
    try { reader.cancel && reader.cancel(); } catch {}
    clearTimeout(timer);
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    return detectAudio(all);
  } catch {
    try { clearTimeout(timer); } catch {}
    return { ok: true, fmt: "unknown", why: "探测失败(放行)" };
  }
}

/* ============================================================
 * B 站（Bilibili）
 * ------------------------------------------------------------
 * 为什么接：内地下架歌手（脆弱少女组/赵薇/李志…）在 YouTube 上
 * 经常只有翻唱或残缺版本，B 站反而有完整原曲搬运。多一条路。
 *
 * 三个坑（都是实测踩出来的）：
 *   ① 搜索接口要 WBI 签名（w_rid），不签会返回 -403 / 空结果
 *      → 从 nav 接口的 wbi_img 算 mixinKey，再 md5(参数串 + mixinKey)
 *   ② 音频是 m4s（fMP4 分片），moov 里的采样表是**空的**（n=0），
 *      MyGo 的 mp4 解析器会「解析成功但 0 个采样」→ 播不出声。
 *      必须走 ffmpeg 转码（跟 YouTube 同一条路）
 *   ③ CDN 请求必须带 Referer: https://www.bilibili.com/，否则 403
 *      且 ffmpeg 不读系统代理，要显式 -http_proxy（否则 -138）
 * ============================================================ */

const BILI_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let biliCookie = "";
let biliCookieAt = 0;
let biliMixinKey = "";
let biliMixinAt = 0;

/** B 站 API 请求头。
 *  ⚠️ 光有 User-Agent 不够：B 站风控会看 sec-ch-ua / sec-fetch-* 这一套。
 *  缺了它们，同一个 UA 也可能被判成脚本。 */
function biliHeaders() {
  const h = {
    "User-Agent": BILI_UA,
    Referer: "https://www.bilibili.com/",
    Origin: "https://www.bilibili.com",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
  };
  if (biliCookie) h.Cookie = biliCookie;
  return h;
}

/** 拿 buvid3/buvid4（没有 cookie 时 B 站风控更严，拿一下更稳） */
async function biliEnsureCookie() {
  if (biliCookie && Date.now() - biliCookieAt < 3600e3) return;
  try {
    const { text } = await fetchText("https://api.bilibili.com/x/frontend/finger/spi", {
      headers: biliHeaders(),
    });
    const d = JSON.parse(text);
    const b3 = d && d.data && d.data.b_3;
    if (b3) {
      biliCookie = "buvid3=" + b3 + (d.data.b_4 ? "; buvid4=" + d.data.b_4 : "");
      biliCookieAt = Date.now();
    }
  } catch {}
}

/** WBI 签名用的 mixinKey（从 nav 的 wbi_img 算，1 小时缓存） */
async function biliEnsureMixinKey() {
  if (biliMixinKey && Date.now() - biliMixinAt < 3600e3) return;
  try {
    const { text } = await fetchText("https://api.bilibili.com/x/web-interface/nav", {
      headers: biliHeaders(),
    });
    const d = JSON.parse(text);
    const w = d && d.data && d.data.wbi_img;
    if (!w || !w.img_url || !w.sub_url) return;
    const name = (u) => String(u).slice(String(u).lastIndexOf("/") + 1).split(".")[0];
    const raw = name(w.img_url) + name(w.sub_url);
    // B 站写死的置换表
    const TAB = [
      46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19,
      29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
      22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
    ];
    biliMixinKey = TAB.map((i) => raw[i] || "").join("").slice(0, 32);
    biliMixinAt = Date.now();
  } catch {}
}

/** 给参数加 WBI 签名 */
function biliSign(params) {
  const qs = Object.keys(params)
    .sort()
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(params[k]))
    .join("&");
  if (!biliMixinKey) return qs; // 没 key 就裸发，反正有兜底
  return qs + "&w_rid=" + md5Hex(qs + biliMixinKey);
}

/** 简单 md5（纯 JS，不依赖 host.crypto，避免沙箱差异） */
function md5Hex(str) {
  function rotl(x, n) {
    return (x << n) | (x >>> (32 - n));
  }
  function add(a, b) {
    return (a + b) | 0;
  }
  const bytes = [];
  for (const ch of unescape(encodeURIComponent(str))) bytes.push(ch.charCodeAt(0));
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push((i < 4 ? bitLen : 0) >>> (8 * (i % 4)) & 0xff);
  // 用 64 位长度（低 32 位足够，字符串不会超过 512MB）
  const lenPos = bytes.length - 8;
  const lo = bitLen >>> 0;
  bytes[lenPos] = lo & 0xff;
  bytes[lenPos + 1] = (lo >>> 8) & 0xff;
  bytes[lenPos + 2] = (lo >>> 16) & 0xff;
  bytes[lenPos + 3] = (lo >>> 24) & 0xff;
  for (let i = 4; i < 8; i++) bytes[lenPos + i] = 0;

  let a0 = 0x67452301,
    b0 = 0xefcdab89,
    c0 = 0x98badcfe,
    d0 = 0x10325476;
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = [];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

  for (let off = 0; off < bytes.length; off += 64) {
    const M = [];
    for (let i = 0; i < 16; i++) {
      M[i] =
        bytes[off + i * 4] |
        (bytes[off + i * 4 + 1] << 8) |
        (bytes[off + i * 4 + 2] << 16) |
        (bytes[off + i * 4 + 3] << 24);
    }
    let A = a0,
      B = b0,
      C = c0,
      D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const tmp = D;
      D = C;
      C = B;
      B = add(B, rotl(add(add(A, F), add(K[i], M[g])), S[i]));
      A = tmp;
    }
    a0 = add(a0, A);
    b0 = add(b0, B);
    c0 = add(c0, C);
    d0 = add(d0, D);
  }
  const toHex = (n) => {
    let s = "";
    for (let i = 0; i < 4; i++) s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    return s;
  };
  return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
}

/** 搜索 B 站视频（只要音频类结果） */
async function biliSearch(keyword, limit = 20) {
  await biliEnsureCookie();
  await biliEnsureMixinKey();
  const params = {
    search_type: "video",
    keyword: String(keyword || ""),
    page: 1,
    page_size: Math.min(limit, 50),
  };
  const url = "https://api.bilibili.com/x/web-interface/wbi/search/type?" + biliSign(params);
  const { text } = await fetchText(url, { headers: biliHeaders() });
  const d = JSON.parse(text);
  if (!d || d.code !== 0) return [];
  const list = (d.data && d.data.result) || [];
  return list.map((x) => ({
    bvid: x.bvid,
    title: String(x.title || "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
    author: String(x.author || ""),
    duration: x.duration || "", // "3:24"
    pic: String(x.pic || "").replace(/^\/\//, "https://"),
  }));
}

/** 拿 bvid → { cid, title, duration } */
async function biliView(bvid) {
  await biliEnsureCookie();
  const url = "https://api.bilibili.com/x/web-interface/view?bvid=" + encodeURIComponent(bvid);
  const { text } = await fetchText(url, { headers: biliHeaders() });
  const d = JSON.parse(text);
  if (!d || d.code !== 0 || !d.data) return null;
  const p = (d.data.pages && d.data.pages[0]) || {};
  return {
    cid: p.cid || d.data.cid,
    title: d.data.title || "",
    duration: d.data.duration || 0, // 秒
    owner: (d.data.owner && d.data.owner.name) || "",
    pic: d.data.pic || "",
  };
}

/** 取 B 站音频流地址（dash 里最高码率的音轨） */
async function biliAudioUrl(bvid, cid) {
  await biliEnsureCookie();
  const url =
    "https://api.bilibili.com/x/player/playurl?bvid=" +
    encodeURIComponent(bvid) +
    "&cid=" +
    encodeURIComponent(cid) +
    "&fnval=4048&fourk=1";
  const { text } = await fetchText(url, { headers: biliHeaders() });
  const d = JSON.parse(text);
  if (!d || d.code !== 0 || !d.data) return null;
  const dash = d.data.dash;
  let best = null;
  if (dash && Array.isArray(dash.audio) && dash.audio.length) {
    best = dash.audio.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  }
  // 兜底：老接口给的 durl（整段 mp4，一般音质差但能用）
  if (!best && Array.isArray(d.data.durl) && d.data.durl[0]) {
    return { url: d.data.durl[0].url, mime: "video/mp4", bandwidth: 0 };
  }
  if (!best) return null;
  return {
    url: best.baseUrl || best.base_url,
    mime: best.mimeType || "audio/mp4",
    bandwidth: best.bandwidth || 0,
  };
}

// ------------------------- 酷我（Kuwo）搜索 -------------------------
/* 酷我 SONGNAME 里带 HTML 实体（「七里香&nbsp;(伴奏)」），不还原就认不出伴奏版。 */
function htmlDecode(str) {
  return String(str || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (m, n) => {
      const code = Number(n);
      return code > 0 && code < 65536 ? String.fromCharCode(code) : m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/* ============================ QQ 音乐 ============================
 * 为什么加它：网易云的歌手/专辑字段经常是错的（搜「林宥嘉」30 张专辑里大半不是他的），
 * 拿它当「置信度基准」会把排序带偏。QQ 这边字段是干净的：
 *   搜「七里香 周杰倫」→ 第 1 条就是 { 七里香 | 周杰倫 | 专辑「七里香」| 299s }，
 *   后面才是 Live / 钢琴版，版本标记也写在歌名里（「七里香 (Live)」）。
 * 而且**免登录可用**：
 *   · 搜索走老接口 c.y.qq.com/soso/fcgi-bin/client_search_cp（GET，不需要 cookie）
 *   · 取流走 vkey.GetVkeyServer，filename 用 RS02<media_mid>.mp3 就能拿到 purl
 *     （M500/C400 前缀返回空，RS02 才是免费可用的那档）
 * 实测：purl 拼上 sip → HTTP 200 / audio/mpeg / 960KB，能直接播。
 * ============================================================== */
const QQ_SEARCH = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp";
/* qq:<songmid> → media_mid。取流时 filename 要用 media_mid（RS02<media_mid>.mp3），
   而 id 里只有 songmid，两者不一定相同，所以搜到时就记下来。 */
const qqMedia = new Map();
const QQ_FCG = "https://u.y.qq.com/cgi-bin/musicu.fcg";

function qqCover(albumMid) {
  return albumMid ? "https://y.gtimg.cn/music/photo_new/T002R500x500M000" + albumMid + ".jpg" : "";
}

/* QQ 搜索：返回统一结构的 track 列表 */
async function qqSearch(query, n = 20) {
  await jitter(100);
  const url =
    QQ_SEARCH +
    "?ct=24&qqmusic_ver=1298&remoteplace=txt.yqq.top&t=0&aggr=1&cr=1&catZhida=0" +
    "&lossless=0&flag_qc=0&p=1&n=" + n +
    "&w=" + encodeURIComponent(query) +
    "&format=json&g_tk=5381";
  const { text } = await fetchText(url, {
    headers: { "User-Agent": uaMobile(), Referer: "https://y.qq.com/" },
  });
  let j;
  try { j = JSON.parse(text); } catch { return []; }
  const list = (j && j.data && j.data.song && j.data.song.list) || [];
  // ⚠️ DJ 混剪版在 QQ 侧取流必 404（实测「0.8x DJ阿Bo版」「DJ阿若版」稳定 404），
  //    纯废稿，直接影响按长度排序排在前面时点了播不了。直接剔除，保留 Live/翻唱。
  const DJ_RE = /[0-9.]{1,3}x?DJ|DJ[ 　]*(咚鼓|阿|加速|慢摇|串烧)/i;
  const filtered = list.filter((s) => {
    const songname = String(s.songname || "");
    return !DJ_RE.test(songname);
  });
  return filtered.map((s) => {
    const mid = String(s.songmid || "");
    const media = String(s.strMediaMid || s.media_mid || s.songmid || "");
    if (!mid) return null;
    const albumMid = (s.albummid || "").trim();
    qqMedia.set(mid, media || mid);
    return {
      id: "qq:" + mid,
      _qqMid: mid,
      _qqMedia: media,
      name: String(s.songname || s.name || "").trim(),
      artists: (s.singer || []).map((x) => ({ name: x.name || "" })),
      album: s.albumname ? { name: s.albumname, imageUrl: qqCover(albumMid) } : undefined,
      artwork: qqCover(albumMid),
      duration: (Number(s.interval) || 0) * 1000 || undefined,
      provider: "qq",
      // 版本标记：QQ 把 Live/伴奏/翻唱 写在歌名括号里，这里额外标一个，供排序用
      _ver: /[(（\[【][^)）\]】]*(live|现场|現場|伴奏|翻唱|cover|钢琴|純音樂|纯音乐|remix|dj|版)[^)）\]】]*[)）\]】]/i.test(s.songname || "")
        ? true
        : undefined,
    };
  }).filter(Boolean);
}

/* QQ 取流：vkey.GetVkeyServer，RS02 前缀免登录可用 */
async function qqStreamUrl(mid, media) {
  const data = {
    req_0: {
      module: "vkey.GetVkeyServer",
      method: "CgiGetVkey",
      param: {
        guid: "10000",
        songmid: [mid],
        filename: ["RS02" + (media || mid) + ".mp3"],
        songtype: [0],
        uin: "0",
        loginflag: 1,
        platform: "20",
      },
    },
    comm: { uin: "0", format: "json", ct: 24, cv: 0 },
  };
  const url = QQ_FCG + "?format=json&data=" + encodeURIComponent(JSON.stringify(data));
  const { text } = await fetchText(url, {
    headers: { "User-Agent": uaMobile(), Referer: "https://y.qq.com/" },
  });
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  const d = j && j.req_0 && j.req_0.data;
  const info = d && d.midurlinfo && d.midurlinfo[0];
  const sip = d && d.sip && d.sip.filter((x) => x)[0];
  if (!info || !info.purl || !sip) return null;
  return sip + info.purl;
}

/* ============================================================
 * QQ 音乐 —— 专辑 / 歌手 / 歌单 / 榜单 / 歌词（第二部分）
 * ------------------------------------------------------------
 * 上面那一段只管「搜单曲 + 取流」；这里把 QQ 补齐成一个完整来源，
 * 让它在聚合里能跟其它平台平起平坐：
 *
 *   qqa:<albummid>    专辑页
 *   qqr:<singermid>   歌手页（热歌 50 首 + 专辑墙）
 *   qqp:<dissid>      歌单页
 *   qqc:<topid>       榜单（可分页）
 *   qq:<songmid>      歌词
 *
 * 接口全部免登录（uin 固定 "0"），与上游 mygo-music-qqmusic-plugin 同源：
 *   · 详情/榜单用 c.y.qq.com 老 cgi（结构跟老接口一致，一次就能拿到 songmid）
 *   · 歌手页用 u.y.qq.com musicu（music.web_singer_info_svr）
 *   · 三类搜索用 music.search.SearchCgiService —— 这个接口匿名时经常回
 *     2001（QQ 侧限流，不是拒绝），所以调用方必须做「失败即静默」，
 *     绝不能让它拖慢整个搜索。
 * ============================================================ */
const QQ_CGI = "https://c.y.qq.com";

/** QQ 的 lyric 字段是 base64（实测 "[ti:晴天]" 编出来就是 W3RpOuaZtOWkqV0...），这里手动解 */
function qqB64(str) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = String(str || "").replace(/[^A-Za-z0-9+/]/g, "");
  if (!clean) return "";
  const bytes = new Uint8Array(Math.ceil((clean.length * 3) / 4));
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c1 = chars.indexOf(clean[i] || "");
    const c2 = chars.indexOf(clean[i + 1] || "");
    const c3 = chars.indexOf(clean[i + 2] || "");
    const c4 = chars.indexOf(clean[i + 3] || "");
    const n = ((c1 & 63) << 18) | ((c2 & 63) << 12) | (((c3 < 0 ? 64 : c3) & 63) << 6) | ((c4 < 0 ? 64 : c4) & 63);
    bytes[p++] = (n >> 16) & 255;
    if (i + 2 < clean.length) bytes[p++] = (n >> 8) & 255;
    if (i + 3 < clean.length) bytes[p++] = n & 255;
  }
  const head = bytes.slice(0, p);
  try {
    return new TextDecoder("utf-8").decode(head);
  } catch {
    let out = "";
    for (let i = 0; i < head.length; i++) out += String.fromCharCode(head[i]);
    return out;
  }
}

async function qqCgi(path, params) {
  await jitter(80);
  const q = Object.entries({ ...params, format: "json", outCharset: "utf-8" })
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
  const { text } = await fetchText(QQ_CGI + path + "?" + q, {
    headers: { "User-Agent": uaMobile(), Referer: "https://y.qq.com/" },
    signal: AbortSignal.timeout(20000),
  });
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw fail("unavailable", "QQ 接口返回异常");
  }
  if (j && typeof j.code === "number" && j.code !== 0) throw fail("unavailable", "QQ 接口错误 " + j.code);
  return j;
}

/** musicu.fcg 的 POST 封装（匿名：uin "0"） */
async function qqRpc(module, method, param, comm) {
  await jitter(80);
  const body = {
    comm: comm || { ct: 24, cv: 0, uin: "0", format: "json" },
    req_0: { module, method, param },
  };
  const { text } = await fetchText(QQ_FCG, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": uaMobile(), Referer: "https://y.qq.com/" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw fail("unavailable", "QQ 接口返回异常");
  }
  const code = (j && j.req_0 && j.req_0.code) || (j && j.code);
  if (code !== 0 || !j.req_0 || !j.req_0.data) throw fail("unavailable", "QQ 接口错误 " + code);
  return j.req_0.data;
}

/** 各类 QQ 歌曲对象（专辑 cgi / 歌单 cgi / 榜单 cgi / musicu 歌手页）→ 统一 Track */
function qqTrackFrom(s, fallbackAlbum) {
  if (!s) return null;
  const mid = String(s.songmid || s.mid || s.songMid || "");
  if (!mid) return null;
  const media = String(s.strMediaMid || s.media_mid || (s.file && s.file.media_mid) || mid);
  // 取流时要 media_mid，不在搜索路径里出现的曲目（专辑/歌单/歌手/榜单）也要记下来
  qqMedia.set(mid, media || mid);
  const singers = Array.isArray(s.singer) ? s.singer : s.singer ? [s.singer] : [];
  const albumMid = String(s.albummid || (s.album && (s.album.mid || s.album.albummid)) || (fallbackAlbum && fallbackAlbum.mid) || "");
  const albumName = String(s.albumname || (s.album && s.album.name) || (fallbackAlbum && fallbackAlbum.name) || "");
  return {
    id: "qq:" + mid,
    name: String(s.songname || s.name || s.title || "").trim() || "未命名",
    artists: singers.length ? singers.map((x) => ({ id: String(x.mid || ""), name: String(x.name || "") })) : [{ name: "QQ 音乐" }],
    album: albumMid || albumName ? { id: albumMid ? "qqa:" + albumMid : "", name: albumName, imageUrl: qqCover(albumMid) } : undefined,
    artwork: qqCover(albumMid),
    duration: (Number(s.interval) || 0) * 1000 || undefined,
    provider: "qq",
  };
}

/** 专辑页 */
async function qqAlbumPage(albumMid) {
  const j = await qqCgi("/v8/fcg-bin/fcg_v8_album_info_cp.fcg", { albummid: albumMid });
  const d = j && j.data;
  if (!d) throw fail("unavailable", "QQ 没有这张专辑");
  const name = String(d.name || d.albumname || "专辑");
  const tracks = (d.list || []).map((x) => qqTrackFrom(x, { mid: albumMid, name })).filter(Boolean);
  const artists = tracks[0] && tracks[0].artists.length ? tracks[0].artists : d.singername ? [{ name: String(d.singername) }] : [];
  remember(tracks);
  return {
    album: {
      id: "qqa:" + albumMid,
      name,
      artists,
      imageUrl: qqCover(albumMid),
      artwork: qqCover(albumMid),
      released: dateOnly(d.aDate || d.publicTime),
      trackCount: tracks.length,
    },
    tracks,
  };
}

/** 歌手页：热歌 + 专辑墙 */
async function qqArtistPage(singerMid) {
  const hot = await qqRpc("music.web_singer_info_svr", "get_singer_detail_info", { sort: 5, singermid: singerMid, sin: 0, num: 50 });
  const info = hot.singer_info || {};
  const name = String(info.name || "QQ 歌手");
  const tracks = (hot.songlist || []).map((x) => qqTrackFrom(x)).filter(Boolean);
  let albums = [];
  try {
    const list = await qqRpc("music.musichallAlbum.AlbumListServer", "GetAlbumList", { sort: 5, singermid: singerMid, begin: 0, num: 30 });
    albums = (list.albumList || [])
      .map((a) => {
        const mid = String(a.albumMid || a.mid || "");
        if (!mid) return null;
        return {
          id: "qqa:" + mid,
          name: String(a.albumName || a.name || ""),
          imageUrl: qqCover(mid),
          released: dateOnly(a.publishDate || a.publicTime),
          artists: [{ id: "qqr:" + singerMid, name }],
        };
      })
      .filter(Boolean);
  } catch {}
  remember(tracks);
  return {
    artist: { id: "qqr:" + singerMid, name, imageUrl: info.pic ? String(info.pic) : "", artwork: "" },
    tracks,
    albums,
  };
}

/** 歌单页 */
async function qqPlaylistPage(dissid) {
  const j = await qqCgi("/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg", {
    disstid: dissid,
    type: "1",
    json: "1",
    utf8: "1",
    onlysong: "0",
    new_format: "1",
  });
  const info = j && j.cdlist && j.cdlist[0];
  if (!info) throw fail("unavailable", "QQ 没有这个歌单");
  const tracks = (info.songlist || []).map((x) => qqTrackFrom(x)).filter(Boolean);
  remember(tracks);
  return {
    id: "qqp:" + dissid,
    name: String(info.dissname || info.title || "QQ 歌单"),
    imageUrl: String(info.logo || info.picurl || ""),
    description: String(info.desc || "").replace(/<[^>]+>/g, "").slice(0, 200),
    owner: String(info.nickname || info.nick || ""),
    trackCount: Number(info.total_song_num || info.songnum) || tracks.length,
    tracks,
  };
}

/** 榜单：老接口一次给 30 首完整结构（含 songmid / strMediaMid），比 musicu 的只给 songId 好用 */
async function qqChartPage(topid, offset, num) {
  const begin = Number(offset) || 0;
  const size = Math.min(Number(num) || 30, 100);
  const j = await qqCgi("/v8/fcg-bin/fcg_v8_toplist_cp.fcg", { topid, page: "detail", type: "top", song_begin: begin, song_num: size });
  const info = j.toptitle || j.topinfo || {};
  const tracks = (j.songlist || []).map((x) => qqTrackFrom(x.data || x)).filter(Boolean);
  return {
    id: "qqc:" + topid,
    name: String(info.ListName || info.name || "QQ 榜单"),
    imageUrl: String(info.pic || info.pic_v12 || info.pic_v9 || info.mac_pic || ""),
    description: String(info.intro || "").replace(/<[^>]+>/g, "").slice(0, 200),
    owner: "QQ 音乐",
    trackCount: tracks.length + begin,
    tracks,
  };
}

/** 榜单分组（QQ 侧「巅峰榜 / 地区榜 / 特色榜 / 全球榜」） */
async function qqChartGroups() {
  const d = await qqRpc("musicToplist.ToplistInfoServer", "GetAll", { offset: 0, num: 20 });
  const groups = (d && (d.group || (d.data && d.data.group))) || [];
  return groups
    .map((g) => ({
      name: String(g.groupName || "榜单"),
      items: (g.toplist || [])
        .map((t) => ({
          topId: Number(t.topId) || 0,
          title: String(t.title || t.ListName || ""),
          imageUrl: String(t.headPicUrl || t.frontPicUrl || ""),
        }))
        .filter((x) => x.topId && x.title),
    }))
    .filter((g) => g.items.length);
}

/** 歌词：老接口返回 base64 的 lrc 文本 */
async function qqLyricPage(songmid) {
  let j = null;
  try {
    j = await qqCgi("/lyric/fcgi-bin/fcg_query_lyric_new.fcg", { songmid });
  } catch {}
  const lrc = qqB64(j && (j.lyric || j.data)).replace(/<[^>]+>/g, "").trim();
  if (!lrc || !/\[\d{1,3}:\d{2}/.test(lrc)) return {};
  const trans = qqB64(j && (j.trans || "")).trim();
  const lines = lrcToLines(lrc);
  if (lines.length) return trans ? { lines, translation: trans } : { lines };
  return trans ? { lrc, translation: trans } : { lrc };
}

/** 三类搜索（musicu）。限流 2001 时返回 []，由调用方决定是否补 */
async function qqSearchKind(kind, query, limit) {
  const type = { albums: 2, artists: 1, playlists: 3 }[kind];
  if (!type) return [];
  const d = await qqRpc(
    "music.search.SearchCgiService",
    "DoSearchForQQMusicDesktop",
    { query, search_type: type, num_per_page: 20, page_num: 1 },
    { ct: 11, cv: 0, uin: "0", format: "json", tmeAppID: "qqmusic" }
  );
  const list = (d.body && (d.body.song || d.body.singer || d.body.album || d.body.songlist) || {}).list || [];
  if (kind === "albums") {
    return list
      .slice(0, limit)
      .map((a) => {
        const mid = String(a.mid || a.albummid || "");
        if (!mid) return null;
        return {
          id: "qqa:" + mid,
          name: String(a.name || a.albumName || ""),
          imageUrl: qqCover(mid),
          released: dateOnly(a.publish_date || a.publicTime),
          artists: (a.singer_lists || a.singer || []).map((s) => ({ id: s.mid ? "qqr:" + String(s.mid) : "", name: String(s.name || "") })).slice(0, 3),
        };
      })
      .filter(Boolean);
  }
  if (kind === "artists") {
    return list
      .slice(0, limit)
      .map((s) => {
        const mid = String(s.mid || s.singer_mid || "");
        if (!mid) return null;
        return { id: "qqr:" + mid, name: String(s.name || s.singer_name || ""), imageUrl: s.pic ? String(s.pic) : "" };
      })
      .filter(Boolean);
  }
  return list
    .slice(0, limit)
    .map((p) => {
      const id = String(p.dissid || p.tid || "");
      if (!/^[1-9]\d*$/.test(id)) return null;
      return {
        id: "qqp:" + id,
        name: String(p.dissname || p.title || ""),
        imageUrl: String(p.imgurl || p.cover || ""),
        description: String(p.introduction || "").slice(0, 120),
        trackCount: Number(p.song_count || p.songnum) || 0,
        owner: String((p.creator && p.creator.name) || p.creator_name || ""),
      };
    })
    .filter(Boolean);
}

/* ============================================================
 * 网络电台（RoamDial）
 * ------------------------------------------------------------
 * 上游 GYRYEZ/mygo-music-roamdial：把 roamdial.com 的世界电台接进播放器。
 * RoamDial 把整张电台地图拆成两个 JSON：
 *   /api/globe?part=core   分类 / 国家 / 语种 / 热度，按下标对齐的索引（0.9MB）
 *   /api/globe?part=rest   台名 / 流地址 / 标签 / 州省（3 万台，3.7MB）
 * 两个文件按下标一一对应，join 一次就整场会话缓存。之后翻页、筛国家、筛分类
 * 全在内存里做，不再请求目录 —— 比一页一个请求快得多，代价是首次加载要下 4.6MB。
 *
 * 页面：
 *   radio                     目录首页（中国电台 / 分类 / 国家 / 随便听听）
 *   rblist:country:<CC>:<n>   某国家的电台（CN / US …）
 *   rblist:genre:<i>:<n>      某分类的电台（0 流行 … 10 综合）
 *   rblist:mood:<id>:<n>      心情台（分类 + 标签拼出来的）
 *   rblist:random:all:<n>     随便听听（按日期打散，同一天顺序稳定）
 *   rd:<station id>           单台取流
 *
 * ⚠️ 封面：台标在 /api/stations/<id> 里，得逐台取；ICO / SVG / GIF 走 weserv
 *    转 PNG（播放器只认 png / jpg / webp）。列表页只预取当前这一页，
 *    并发 12、单台 2.5 秒超时 —— 三万台全预取等于打人家服务器。
 * ============================================================ */
const RD_SITE = "https://roamdial.com";
const RD_PAGE = 60; // 一次给多少台，翻页也按这个步进
const RD_TYPES = ["mp3", "aac", "ogg", "flac", "m4a", "wav"];
const RD_UA = "MyGoMusicHulu/1.0";

/* 分类索引固定（core.genres 的顺序）：0 流行 1 摇滚 2 电子 3 爵士蓝调 4 古典
   5 新闻谈话 6 嘻哈 7 乡村民谣 8 地方与世界 9 宗教 10 综合 */
const RD_MOODS = [
  { id: "focus", name: "专注", desc: "古典与电子，长时段不吵", genres: [4, 2], tags: ["ambient", "chill", "study", "piano"] },
  { id: "late", name: "深夜", desc: "爵士蓝调，一点静电噪音", genres: [3], tags: ["lounge", "late", "night", "slow"] },
  { id: "drive", name: "路上", desc: "流行和摇滚，跟着节奏走", genres: [0, 1, 10], tags: ["hit", "drive", "classic"] },
  { id: "wander", name: "漫游", desc: "每次都是世界的另一个角落", genres: [], tags: [] },
  { id: "cafe", name: "咖啡馆", desc: "低声说话，屋子是暖的", genres: [10, 3], tags: ["lounge", "cafe", "coffee", "acoustic"] },
  { id: "dance", name: "舞曲", desc: "四四拍，一直不停", genres: [2], tags: ["dance", "house", "techno", "club", "edm"] },
  { id: "sleep", name: "睡前", desc: "慢、轻、远", genres: [4], tags: ["sleep", "ambient", "relax", "ambience"] },
  { id: "news", name: "新闻", desc: "别处正在发生什么", genres: [5], tags: ["news", "talk"] },
];

let rdCache = null;
let rdPending = null;
const rdDetails = new Map(); // id → { cover, about }

function rdChinese() {
  try {
    return String(host.language() || "").toLowerCase().indexOf("zh") === 0;
  } catch {
    return true;
  }
}

async function rdFetch(url, timeoutMs) {
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": RD_UA }, signal: AbortSignal.timeout(timeoutMs || 30000) });
  } catch (e) {
    throw fail("unavailable", "连不上 RoamDial，稍后再试");
  }
  if (!res.ok) throw fail("unavailable", "RoamDial 接口返回 " + res.status);
  try {
    return await res.json();
  } catch {
    throw fail("unavailable", "RoamDial 返回的内容不是 JSON");
  }
}

/** 只收能直接播的地址：播放列表文件点开没有声，HLS 交给播放器也是哑的 */
function rdDirect(url) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return false;
  const file = u.toLowerCase().split("?")[0].split("#")[0];
  if (/\.(m3u8|m3u|pls|xspf|asx)$/.test(file)) return false;
  if (/\.(wma|webm)$/.test(file)) return false;
  return true;
}

function rdStreamType(url) {
  const file = String(url || "").toLowerCase().split("?")[0].split("#")[0];
  if (/\.aac$/.test(file)) return "aac";
  if (/\.m4a$/.test(file)) return "m4a";
  if (/\.(ogg|oga|opus)$/.test(file)) return "ogg";
  if (/\.flac$/.test(file)) return "flac";
  if (/\.wav$/.test(file)) return "wav";
  return "mp3";
}

function rdClean(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .trim();
}

function rdCountryName(core, i) {
  const row = core.countries && core.countries[i];
  if (!row) return "";
  return rdChinese() ? row[1] || row[2] || row[0] || "" : row[2] || row[1] || row[0] || "";
}

function rdGenreName(core, i) {
  const zh = (core.genres || [])[i] || "";
  const en = (core.genresEn || [])[i] || "";
  return rdChinese() ? zh || en : en || zh;
}

/** 一次 join 完两个接口，整场会话只做一次 */
async function rdLoad() {
  if (rdCache) return rdCache;
  if (rdPending) return rdPending;
  rdPending = (async () => {
    const [core, rest] = await Promise.all([
      rdFetch(RD_SITE + "/api/globe?part=core", 25000),
      rdFetch(RD_SITE + "/api/globe?part=rest", 45000),
    ]);
    if (!rest || !rest.id || !core || !core.countries) throw fail("unavailable", "RoamDial 的数据格式变了");
    const stations = [];
    const byId = new Map();
    for (let i = 0; i < rest.id.length; i++) {
      const url = String(rest.url[i] || "");
      if (!rdDirect(url)) continue;
      const st = {
        id: String(rest.id[i]),
        name: rdClean(rest.name[i]) || "未命名电台",
        url,
        tags: String(rest.tags[i] || ""),
        state: String(rest.state[i] || ""),
        ci: Number(core.c[i]) || 0,
        gi: Number(core.g[i]) || 0,
        pop: Number(core.pop[i]) || 0,
      };
      st.text = [st.name, st.tags, st.state, rdCountryName(core, st.ci), rdGenreName(core, st.gi)]
        .join(" ")
        .toLowerCase();
      stations.push(st);
      byId.set(st.id, st);
    }
    /* 国家与分类的台数一次算完，别在渲染目录时对 3 万台逐个 filter */
    const countryCount = new Map();
    const genreCount = new Map();
    for (const st of stations) {
      countryCount.set(st.ci, (countryCount.get(st.ci) || 0) + 1);
      genreCount.set(st.gi, (genreCount.get(st.gi) || 0) + 1);
    }
    rdCache = { core, stations, byId, countryCount, genreCount };
    rdPending = null;
    return rdCache;
  })().catch((e) => {
    rdPending = null;
    throw e;
  });
  return rdPending;
}

/** 台标：详情接口里的 favicon；非位图走 weserv 转 PNG；拿不到就用兜底封面 */
function rdProxied(url) {
  return "https://images.weserv.nl/?url=" + encodeURIComponent(url) + "&w=600&h=600&fit=cover&output=png&n=-1";
}

async function rdDetail(station) {
  const known = rdDetails.get(station.id);
  if (known) return known;
  const found = { cover: "", about: "" };
  try {
    const data = await rdFetch(RD_SITE + "/api/stations/" + encodeURIComponent(station.id), 2500);
    const favicon = String((data && data.favicon) || "");
    if (/^https?:\/\//i.test(favicon)) {
      found.cover = /\.(png|jpe?g|webp)(\?|#|$)/i.test(favicon) ? favicon : rdProxied(favicon);
    }
    found.about = String((data && data.about) || "").trim();
  } catch {}
  rdDetails.set(station.id, found);
  return found;
}

/** 只预取这一页的封面，并发 12，省得连播放器都等 */
async function rdPrefetch(stations) {
  const todo = [];
  for (const st of stations) if (!rdDetails.has(st.id)) todo.push(st);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) await rdDetail(todo[next++]);
  };
  const workers = [];
  for (let i = 0; i < Math.min(12, todo.length); i++) workers.push(worker());
  await Promise.all(workers);
}

/* 严格探测：真去读几千字节，认得出播放器能解的格式才直连。
   广播台常在 HEAD 上撒谎（HEAD 200、GET 404），只看状态码不够。 */
/* 探测要 5~6 秒，同一台反复点会白等；3 分钟内复用结果 */
const rdProbeCache = new Map();
async function rdProbe(url, timeoutMs) {
  const key = String(url || "");
  const hit = rdProbeCache.get(key);
  if (hit && Date.now() - hit.at < 3 * 60 * 1000) return hit.r;
  const r = await rdProbeStream(url, timeoutMs);
  rdProbeCache.set(key, { at: Date.now(), r });
  return r;
}

async function rdProbeStream(url, timeoutMs) {
  let status = 0;
  try {
    const res = await fetch(url, {
      headers: { Range: "bytes=0-8191", "User-Agent": RD_UA },
      signal: AbortSignal.timeout(timeoutMs || 8000),
    });
    status = res.status;
    if (status !== 200 && status !== 206) {
      /* 非 2xx 时把前几十字节读出来：zeno.fm / qtfm 会回
         "upstream connect error or disconnect/reset before headers"，
         这句能直接告诉用户是「这个台自己没在播」而不是「插件坏了」 */
      let body = "";
      try { body = String(await res.text()).slice(0, 100); } catch {}
      try { res.body && res.body.cancel && res.body.cancel(); } catch {}
      return { ok: false, status, bytes: 0, body, why: "HTTP " + status };
    }
    /* ⚠️⚠️ 这里绝对不能用 res.arrayBuffer()。
       直播台是**永远不会结束**的流：不认 Range 的（蜻蜓老台一律回 200 + chunked）
       压根不会停在 8192 字节上，arrayBuffer 会一直挂着直到超时 abort，
       于是探测永远失败 → 插件抛 unavailable → MyGo 只显示「这首歌无法播放」。
       实测 lhttp.qingting.fm/live/4804/64k.mp3 就是这种：Range 被忽略、
       回 200 全量、HEAD 直接 400，但里头是干净的 MPEG1 Layer III。
       改成读到 ~8KB 就主动 cancel，跟服务端认不认 Range 无关。 */
    const chunks = [];
    let total = 0;
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (reader) {
      const deadline = Date.now() + 4000;
      while (total < 8192 && Date.now() < deadline) {
        const r = await reader.read().catch(() => ({ done: true }));
        if (r.done) break;
        if (!r.value || !r.value.length) continue;
        chunks.push(r.value);
        total += r.value.length;
      }
      try { reader.cancel && reader.cancel(); } catch {}
    } else {
      const buf = new Uint8Array(await res.arrayBuffer().catch(() => new Uint8Array(0)));
      if (buf.length) { chunks.push(buf); total = buf.length; }
    }
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    if (all.length < 64) return { ok: false, status, bytes: all.length, short: true, why: "服务端没给数据（" + all.length + "B）" };
    const d = detectAudio(all);
    if (!d || !d.ok) return { ok: false, status, bytes: all.length, why: (d && d.why) || "读不出音频头" };
    /* 干净 = 第一个字节就是合法容器/帧。前头有几十字节垃圾的流（蜻蜓部分台
       首字节 d1 fd…，要到第 26 字节才是 ff fb 帧）直连给解码器会崩，
       这类即便探测出 mp3 也得走转码。 */
    const b = all;
    const clean =
      (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || // ID3
      (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) || // 裸 MPEG 帧
      (b[0] === 0x1a && b[1] === 0x45) || // EBML
      (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67) || // OggS
      (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61) || // fLaC
      (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46) || // RIFF
      (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70); // ftyp
    const map = { mp4: "m4a", webm: "" };
    const fmt = map[d.fmt] !== undefined ? map[d.fmt] : d.fmt;
    if (!fmt || RD_TYPES.indexOf(fmt) < 0) return { ok: false, status, bytes: all.length, clean, why: "格式 " + d.fmt + " 播放器不认" };
    return { ok: true, fmt, status, bytes: all.length, clean };
  } catch (e) {
    /* 超时/断连也要把已经拿到的状态带出去：
       服务端 2xx 说明这台北上广能播，只是我们这边线路慢，调用方据此退回直连。 */
    return { ok: false, status, bytes: 0, why: String((e && e.message) || "连不上").slice(0, 40) };
  }
}

function rdCover(st) {
  const found = rdDetails.get(st.id);
  return (found && found.cover) || FALLBACK_COVER;
}

/** RoamDial 的电台 → MyGo Track（直播：没有时长） */
function rdTrack(core, st) {
  const country = rdCountryName(core, st.ci);
  const genre = rdGenreName(core, st.gi);
  const found = rdDetails.get(st.id) || {};
  const bits = [];
  if (found.about) bits.push(found.about);
  if (st.state) bits.push(st.state);
  if (st.tags) bits.push(st.tags.split(",").slice(0, 4).join(" · "));
  return {
    id: "rd:" + st.id,
    name: st.name,
    artists: country ? [{ name: country }] : [{ name: "网络电台" }],
    album: { name: genre || "网络电台", imageUrl: rdCover(st) },
    artwork: rdCover(st),
    duration: undefined, // 直播没有时长
    description: bits.join(" · ") || undefined,
    provider: "roamdial",
  };
}

/** 热度降序 + 台名升序，跟上游的排法一致 */
function rdSorted(list) {
  return list.slice().sort((a, b) => {
    if (b.pop !== a.pop) return b.pop - a.pop;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

async function rdListPage(kind, value, offset) {
  const data = await rdLoad();
  const from = Math.max(0, Number(offset) || 0);
  let picked = [];
  let title = "网络电台";
  let sub = "";

  if (kind === "country") {
    const code = String(value || "").toUpperCase();
    const rows = data.core.countries || [];
    const idx = rows.findIndex((row) => String(row[0]).toUpperCase() === code);
    if (idx < 0) throw fail("unavailable", "没有这个国家");
    picked = rdSorted(data.stations.filter((s) => s.ci === idx));
    title = rdCountryName(data.core, idx) || code;
    sub = picked.length + " 个电台 · 按热度排";
  } else if (kind === "genre") {
    const gi = Number(value);
    if (!isFinite(gi) || gi < 0) throw fail("unavailable", "没有这个分类");
    picked = rdSorted(data.stations.filter((s) => s.gi === gi));
    title = rdGenreName(data.core, gi) || "分类";
    sub = picked.length + " 个电台 · 按热度排";
  } else if (kind === "mood") {
    const mood = RD_MOODS.find((m) => m.id === value) || RD_MOODS[0];
    title = mood.name;
    sub = mood.desc;
    if (mood.genres.length) {
      const hit = (s) => {
        const text = s.tags.toLowerCase();
        let score = 0;
        for (const tag of mood.tags) if (text.indexOf(tag) >= 0) score++;
        return score;
      };
      const cands = data.stations.filter((s) => mood.genres.indexOf(s.gi) >= 0);
      picked = cands
        .map((s) => ({ s, score: hit(s) }))
        .sort((a, b) => (b.score - a.score) || (b.s.pop - a.s.pop))
        .map((x) => x.s);
    } else {
      picked = rdShuffled(data.stations, rdSeed());
    }
  } else if (kind === "random") {
    title = "随便听听";
    sub = "按日期打散，同一天顺序固定";
    picked = rdShuffled(data.stations, rdSeed());
  } else {
    throw fail("unavailable", "没有这种电台列表");
  }

  const page = picked.slice(from, from + RD_PAGE);
  await rdPrefetch(page);
  const tracks = page.map((s) => rdTrack(data.core, s));
  return {
    title,
    subtitle: sub,
    sections: [
      {
        title: "电台",
        tracks,
        empty: "这一批暂时没有可播的电台",
        morePage: from + RD_PAGE < picked.length ? `rblist:${kind}:${value}:${from + RD_PAGE}` : "",
      },
    ],
  };
}

/** 当天种子：同一天翻页顺序稳定，过一天换一批 */
function rdSeed() {
  const d = new Date();
  let seed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  return seed >>> 0;
}

/** 线性同余打散：三万台里挑一段，跨页不重复不跳号 */
function rdShuffled(list, seed) {
  let s = seed >>> 0;
  const out = [];
  const used = new Set();
  const total = list.length;
  if (!total) return out;
  while (out.length < total && used.size < total) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const i = s % total;
    if (used.has(i)) continue;
    used.add(i);
    out.push(list[i]);
  }
  return out;
}

async function rdById(id) {
  const data = await rdLoad();
  return data.byId.get(String(id)) || null;
}


async function kuwoSearch(query) {
  await jitter(120); // 打散请求时间点
  const url =
    KUWO_SEARCH +
    "?all=" + encodeURIComponent(query) +
    "&ft=music" +
    "&itemset=web_2013" +
    "&client=kt" +
    "&pn=0&rn=10" +
    "&rformat=json&encoding=utf8&mobi=1";
  const { text } = await fetchText(url, {
    headers: { "User-Agent": uaMobile(), Cookie: "kw_token=ABC", Referer: "http://www.kuwo.cn/" },
  });
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (j && j.abslist) || [];
  return list
    .map((x) => {
      const rid = String(x.MUSICRID || x.rid || "");
      if (!rid) return null;
      const durationMs = parseDur(x.DURATION || x.duration || 0);
      /* ⚠️ 标题优先用 SONGNAME，不是 NAME！
         实测酷我搜「七里香 周杰伦」返回：
           NAME     = 「七里香」           ← 干净的，但不带版本信息
           SONGNAME = 「七里香&nbsp;(伴奏)」 ← 带后缀，还带 HTML 实体
         旧代码取 NAME，把「(伴奏)」标记丢了，于是伴奏条目看起来跟原版一模一样，
         排序时当成干净单曲顶到前面（用户就发现「第六个怎么还是个伴奏」）。
         取 SONGNAME 并经 htmlDecode 还原实体，才能认出伴奏/翻唱版本。 */
      const durationMs2 = durationMs;
      return {
        id: rid.replace(/^MUSIC_/, ""),
        rid, // 保留原始 MUSIC_ 前缀，供取流
        title: htmlDecode(x.SONGNAME || x.songname || x.NAME || x.name || ""),
        artist: x.ARTIST || x.artist || x.DJ || "",
        album: x.ALBUM || x.album || "",
        duration: durationMs,
        artwork: x.web_albumpic_short || x.WEB_ALBUM_PIC_240_300 || x.albumpic || x.MVPIC || "",
      };
    })
    .filter(Boolean)
    .filter((x) => !isAudiobook(x.title, x.artist, x.album));
}

// 酷我取流（convert_url → 返回 mp3/aac 直链）
async function kuwoStream(rid, fmt = "mp3") {
  await jitter(100);
  const url = KUWO_CONVERT
    .replace("{fmt}", fmt)
    .replace("{rid}", encodeURIComponent(String(rid).replace(/^MUSIC_/, "")));
  const { text } = await fetchText(url, {
    headers: { "User-Agent": uaMobile(), Cookie: "kw_token=ABC" },
  });
  const s = String(text).trim();
  if (s.indexOf("http") !== 0) throw "kuwo: " + s.slice(0, 40);
  return s;
}

// ------------------------- 听书/翻唱过滤 -------------------------
const AUDIOBOOK_RE =
  /听书|有声|广播剧|评书|小说|朗读|节目|爆款|优秀作品|演播|专辑(合集)?(连载|完本)?|有声书|FM|一下|诵读|朗读版|全文背诵|名著导读/i;

function isAudiobook(...fields) {
  const joined = fields
    .map((f) => String(f || ""))
    .join(" ")
    .trim();
  return AUDIOBOOK_RE.test(joined);
}

// 标题里是否带明显「非原唱/伴奏/翻唱/remix/钢琴」之类的变体
const COVER_RE =
  /伴奏|钢琴|翻唱|cover|Cover|COVER|翻自|翻唱自|原唱[:：]|原唱是|remix|Remix|DJ版|电音|抖音|女声版|男声版|童声|KTV|合声|纯音乐|纯享|instrumental|Inst\.|笛子|吉他版|吉他曲|口琴|八音盒|music box|慢摇|咚鼓|加速版|降速版|女版|男版|翻录版/i;
// Live/现场：不删，只降权（你的偏好：保留但排后）
const LIVE_RE = /live|Live|LIVE|现场|演唱会|巡回|Tour|unplugged|不插电/i;
// 歌词版/无损/音质标注：纯噪声标记
const NOISE_RE = /歌词版|lyrics|Lyrics|LYRICS|動態歌詞|动态歌词|無損|无损|FLAC|高清|HD|Official\s*Music\s*Video|官方MV/i;

function isCoverLikeTitle(title) {
  return COVER_RE.test(String(title || ""));
}

// 归一化标题：去掉括号内容、变体标记，用于精确匹配判断
function normTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[(（\[【][^)）\]】]*[)）\]】]/g, " ") // 去括号内容
    .replace(/[-–—_/|·•~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ------------------------- 内地下架歌手 -------------------------
/* ⚠️ 这批歌手在内地平台（网易云/QQ/酷狗/咪咕/酷我）整体被下架或限流：
     搜「脆弱少女组」→ 网易云返回 Michael Jackson
     搜「赵薇」→ 只有「赵薇薇」0 首
     搜「李志」→ 只有同名小号 1~2 首，真身不在
     搜「那我懂你意思了」→ 只有 1-2 首的野鸡条目标题

   发过去的请求不但拿不到东西，还会用同名噪声把 YouTube 的真原唱挤下去。
   所以命中名单时：YouTube 结果排最前，内地结果沉底保留（YouTube 空时兜底）。

   名单写死在代码里，不给用户配 —— 这是数据事实，不是偏好设置。 */
const DELISTED_ARTISTS = [
  // —— 早先实测确认 ——
  "脆弱少女组",
  "赵薇",
  "李志",
  "那我懂你意思了",
  "陈升",
  "黄耀明",
  "何韵诗",
  "达明一派",
  // —— 台湾/海外独立与摇滚乐团（全网清除）——
  "灭火器乐团",
  "闪灵乐团",
  "拷秋勤乐团",
  "盘古乐队",
  "伤心欲绝",
  "假假條",
  "浊乐队",
  "大买麦乐团",
  // —— 内地说唱（文化部黑名单/违规全网下架）——
  "阴三儿",
  "红花会",
  "新街口组合",
  // —— 成员涉案被连带下架 ——
  "福禄寿乐队",
  "羽·泉",
  "羽泉",
  // —— 个人作品全网清理 ——
  "那艺娜",
  "俄罗斯娜娜",
  "高晓松",
  "卢广仲",
  "柯震东",
];

/* 【下架歌手的代表作】
   ⚠️ 为什么需要这张表（2026-11-09 实测踩的坑）：
      直接搜「赵薇」，YouTube 返回的 20 条**全是**新闻/八卦/政治分析视频
      （「赵薇作品被多平台下架」「赵薇的难言之隐」「赵薇66亿身家归零」…），
      一条真歌都没有 —— 新闻热度远高于她当年的歌，搜索排序被新闻彻底挤占。
      但换成「赵薇 情深深雨濛濛」「赵薇 有一个姑娘」去搜，
      返回的就全是真歌了。
      所以：下架歌手搜索时，除了搜歌手名，还要**用歌手名+代表作**再搜几路，
      把这些真歌捞回来。代表作只需几个最出名的，不用全。
      只给 DELISTED_ARTISTS 里有需要的歌手配；没配的走原有逻辑。 */
const DELISTED_HITS = {
  赵薇: ["情深深雨濛濛", "有一个姑娘", "自从有了你", "京华烟云", "不能和你分手"],
  李志: ["梵高先生", "关于郑州的记忆", "天空之城", "热河", "和你在一起"],
  陈升: ["把悲伤留给自己", "北京一夜", "然而", "不再让你孤单", "恨情歌"],
  黄耀明: ["石头记", "春光乍泄", "这么远那么近", "暗涌", "四季歌"],
  何韵诗: ["化蝶", "劳斯莱斯", "木纹", "钢铁是怎样炼成的", "再见露丝玛丽"],
  达明一派: ["石头记", "今天应该很高兴", "马路天使", "天花乱坠", "禁色"],
  脆弱少女组: ["Lonely Lonely", "梦幻的婚礼", "秘密", "花", "长大"],
  那我懂你意思了: ["所以我停下来", "怎么都没有了", "原谅我不明白你的悲伤", "没有你的地方", "及时行乐"],
  灭火器乐团: ["海上的人", "天马茶房", "十字路口", "大富翁", "人生"],
  闪灵乐团: ["暮沉武德殿", "皇军", "玉碎", "破月", "失落的灵魂"],
  高晓松: ["同桌的你", "白衣飘飘的年代", "青春无悔", "模范情书"],
  卢广仲: ["慢慢等", "鱼仔", "刻在我心底的名字", "我爱你", "早安晨之美"],
  柯震东: ["小时代", "我的滑板鞋"],
  阴三儿: ["老子明天不上班", "老师你好", "北京晚报", "凭什么"],
  红花会: ["中国魂", "万里长城", "黑怕不怕黑", "反拍"],
  新街口组合: ["北京土著", "这里是北京", "胡同"],
  福禄寿乐队: ["我用什么把你留住", "超度我", "玉珍", "春天音乐"],
  羽泉: ["最美", "冷酷到底", "深呼吸", "奔跑", "彩虹"],
  羽·泉: ["最美", "冷酷到底", "深呼吸", "奔跑", "彩虹"],
  伤心欲绝: ["This Is My Life", "我爱你", "谢谢你"],
  假假條: ["二十年", "大悲咒", "我是谁"],
  浊乐队: ["秽", "苦海", "无名"],
  大买麦乐团: ["大买麦", "小苹果"],
  拷秋勤乐团: ["无名英雄", "海上的人"],
  盘古乐队: ["我们", "什么玩意儿"],
  那艺娜: ["红旗飘飘"],
  俄罗斯娜娜: ["喀秋莎"],
};

/* 【下架歌手的官方 YouTube 频道 ID】
   ⚠️ 为什么需要硬写：搜「赵薇 Topic」时 YouTube **根本不返回**她的官方 Topic 频道
      （返回的是搬运号和新闻视频），靠搜索猜频道 ID 猜不准。
      所以把确认过的官方频道 ID 直接记下来，纯搜歌手时优先用这个拉全曲库。
      格式：歌手名 → 频道 UC id。只填确认过的，不确定的别填（宁可走搜索）。 */
const DELISTED_CHANNELS = {
  赵薇: "UCxEsKVLUbvVSMU-4HwVa9og", // 趙薇 - Topic（用户提供的频道链接实测确认）
  // —— 下面这批是 2026-11-09 批量探测出来的（搜索→按频道名匹配→拉歌验证非空才写入）——
  脆弱少女组: "UCNP5IxBhbYLO0-o9voFrkbw",
  羽泉: "UCJnPXRqqNAwJtc8fPuX-8kg",
  浊乐队: "UC_oJuRT37cHhnQ0_sw6diTA",
  新街口组合: "UCGU1P-Jp5-VK22I1ItRRfbw",
  卢广仲: "UC3RKnfmu-Q-AJ3VmVj_tz2g", // 盧廣仲 Crowd Lu（官方主频道，29 首）
  假假條: "UCduvQuhInUHDBSA8jb5pbtw", // 假假條JaJaTao Official（21 首）
  /* ⚠️ 何韵诗原先登记的是 UCVbZ4AUOBdDZ44UoPddbnyg，实测只有 21 首且名字对不上；
     2026-11-09 扫描换成 Denise Ho - Topic（49 首，见下方第二批）。 */
  /* ⚠️ 高晓松：用户 2026-11-09 提供并实测确认（UCpdEYhmnNY-vBFNT1L-R2fg）。
     之前没登记频道，走搜索时抓到一堆「晓说」段子视频（脱口秀/访谈），
     真正的歌（《殺了她喂豬》《舊的童年》《聲聲慢》《一個北京人在北京》）反而没有。 */
  高晓松: "UCpdEYhmnNY-vBFNT1L-R2fg",
  /* —— 第二批（2026-11-09 扫描）：搜歌手名→频道名含别名→拉歌≥8首才写入 ——
     ⚠️ 必须「拉歌验证非空」才能登记：很多同名频道是粉丝搬运号，
        名字像但里面没几首真歌，登记了反而比搜索更差。 */
  李志: "UC0fESTkfQAd_zZQrw2ZupuQ", // Li Zhi - Topic（59 首）
  陈升: "UCBoVbYG19RpbiqYH17MdslA", // 陳昇 Bobby Chen（43 首）
  何韵诗: "UCq6bV8xawEbYLj7cDTP7iNw", // Denise Ho - Topic（49 首）
  达明一派: "UC5QL_gYA1VzTkcIjwD4cxfA", // Tat Ming Pair - Topic（41 首）
  那我懂你意思了: "UCLh5Hc1l4nYspFqKAMIIEhg", // {{PERSON_rygd7hsu}} - Topic（30 首）
  灭火器乐团: "UCJgJWs9un9HYYzpXU7t1Sgg", // 滅火器 Fire EX.（26 首）
  闪灵乐团: "UCFn5CIjfAj-KZgJtsXw349g", // CHTHONIC 閃靈（16 首）
  柯震东: "UCZNznnDYIBA0hodYCYd7GBQ", // KaiKoVEVO（20 首）
  伤心欲绝: "UC3QIRokryxnTOHvrIdvjLXw", // 傷心欲絕Wayneʻs So Sad（28 首）
  拷秋勤乐团: "UCamGrIHlmPq59IGDUZTU4kQ", // KouChouChing（21 首）
  那艺娜: "UCQ6-2S4_ovdC3V68VjC5-Hw", // LADY NANA -K-CLASS（24 首）
};

/* ============================================================
 * 艺人字典（Artist Dictionary）
 * ------------------------------------------------------------
 * 一个歌手的信息散在四处太乱了：别名、代表作、YouTube 频道、iTunes id、
 * 是否下架、作品全集。统一收进一张表，查一次全拿到。
 *
 * 字段：
 *   alias    —— 别名（英文名/繁体名），用于搜索和打分识别
 *   hits     —— 代表作，纯搜歌手时用来捞回被新闻挤掉的歌
 *   yt       —— 官方 YouTube 频道 UC id（有就直接拉，不用搜）
 *   itunes   —— iTunes artistId（查完整作品目录）
 *   albums   —— 缓存下来的专辑数（iTunes 探测结果）
 *   songs    —— 缓存下来的歌曲数
 *
 * ⚠️ 只写「确认过」的数据。itunes 字段必须校验 artistName 精确匹配才填，
 *    因为 iTunes 搜「李志」第一条会返回「宋冬野」—— 差一个字就是别人。
 * ============================================================ */
const ARTIST_DICT = {
  赵薇: {
    alias: ["Zhao Wei", "Vicki Zhao", "趙薇"],
    hits: ["情深深雨濛濛", "有一个姑娘", "自从有了你", "京华烟云", "不能和你分手"],
    yt: "UCxEsKVLUbvVSMU-4HwVa9og",
  },
  李志: {
    alias: ["Li Zhi", "Lizhi", "李志"],
    hits: ["梵高先生", "关于郑州的记忆", "天空之城", "热河", "和你在一起"],
    yt: "UC0fESTkfQAd_zZQrw2ZupuQ",
  },
  陈升: {
    alias: ["Bobby Chen", "陳昇"],
    hits: ["把悲伤留给自己", "北京一夜", "然而", "不再让你孤单", "恨情歌"],
    yt: "UCBoVbYG19RpbiqYH17MdslA",
  },
  何韵诗: {
    alias: ["Denise Ho", "何韻詩"],
    hits: ["化蝶", "劳斯莱斯", "木纹", "钢铁是怎样炼成的", "再见露丝玛丽"],
    yt: "UCq6bV8xawEbYLj7cDTP7iNw",
  },
  达明一派: {
    alias: ["Tat Ming Pair", "達明一派"],
    hits: ["石头记", "今天应该很高兴", "马路天使", "天花乱坠", "禁色"],
    yt: "UC5QL_gYA1VzTkcIjwD4cxfA",
  },
  脆弱少女组: {
    alias: ["FragileGirls", "Fragile Girls", "脆弱少女組"],
    hits: ["Lonely Lonely", "梦幻的婚礼", "秘密", "花", "长大"],
    yt: "UCNP5IxBhbYLO0-o9voFrkbw",
  },
  那我懂你意思了: {
    alias: ["IGU Band", "IGU", "那我懂你的意思了"],
    hits: ["所以我停下来", "怎么都没有了", "原谅我不明白你的悲伤", "没有你的地方", "及时行乐"],
    yt: "UCLh5Hc1l4nYspFqKAMIIEhg",
  },
  灭火器乐团: {
    alias: ["{{PERSON_1oyguhdb}}", "滅火器", "Fire EX."],
    hits: ["海上的人", "天马茶房", "十字路口", "大富翁", "人生"],
    yt: "UCJgJWs9un9HYYzpXU7t1Sgg",
  },
  闪灵乐团: {
    alias: ["ChthoniC", "閃靈", "Chthonic"],
    hits: ["暮沉武德殿", "皇军", "玉碎", "破月", "失落的灵魂"],
    yt: "UCFn5CIjfAj-KZgJtsXw349g",
  },
  福禄寿乐队: {
    alias: ["福祿壽", "Floruit Show"],
    hits: ["我用什么把你留住", "超度我", "玉珍", "春天音乐"],
    /* ⚠️ 福禄寿 2023 年重组为「DOUDOU」（豆豆 + 咪咪），
       两个人现在共用同一个 YouTube 频道 @doudou-officiall
       = UC5zfZninWiwYy3EUKZ3iW0g（用户 2026-11-10 提供）。
       频道里 28 首歌是老乐队作品 + 新组合作品混在一起的，
       而且 **YouTube 单曲不带署名**（artist 字段全空），接口层面分不开。
       所以这里只能按曲目名白名单区分：
         · only  = 福禄寿时期（2020《我用什么把你留住》专辑等）的代表曲目
         · onlyNot 里放的归 DOUDOU
       注意：这里只做「本歌手页该显示哪些」，不影响搜索。 */
    yt: "UC5zfZninWiwYy3EUKZ3iW0g",
    only: [
      "我用什么把你留住",
      "超度我",
      "玉珍",
      "兰若度母",
      "春暖花开去见你",
      "马",
      "Intro",
      "如何",
      "没咯",
      "轨道之上",
      "火车的终点",
      "像乌鸦一样飞起来",
      "南三环东路",
      "迷宫的入口",
    ],
  },
  DOUDOU: {
    // 2023 年重组后的名字（豆豆 + 咪咪），和老乐队共用同一个频道
    alias: ["豆豆乐队", "doudou-officiall"],
    hits: ["忘记了也没关系", "荒唐谣", "A Rusty Dream", "嗵嗵", "老槐树"],
    yt: "UC5zfZninWiwYy3EUKZ3iW0g",
    /* ⚠️ 只列 DOUDOU 时期的作品。注意《馬》(繁体) 是日文版、
       《超度我 (Live)》《我用什么把你留住 (Remix)》算新编曲版本，
       它们是靠「繁简字形不同 / 带版本后缀」和福禄寿那批区分开的，
       所以这里必须写完整标题，不能简写。 */
    only: [
      "A Rusty Dream (from Cyberpunk: Edgerunners 2)",
      "DOUDOU｜动画《记忆管理局》OP《忘记了也没关系》发布",
      "嗵嗵",
      "DOUDOU｜上美影《燃比娃》宣传曲《荒唐谣》（The Fool）Official Music Video",
      "老槐树",
      "小红舞鞋 (电影《匿杀》片尾曲)",
      "可你听见了 (电影《默杀》主题曲)",
      "DOUDOU《最終觀測》Official Music Video",
      "最终观测 (Live)",
      "超度我 (Live)",
      "我用什么把你留住 (Remix)",
      "馬",
      "隧道",
      "我却没能救她",
      "Even in the Dark (电影《匿杀》插曲)",
      "到天亮 (电影《匿杀》插曲)",
      "DOUDOU / 馬(japanese.ver)【OFFICIAL MUSIC VIDEO】",
    ],
  },
  高晓松: {
    alias: ["Gao Xiaosong", "高曉松"],
    // ⚠️ 代表作改成他本人唱的、且频道里确实有的（原来写的是他给别人写的歌，
    //    搜出来全是别人的版本 + 「晓说」段子）。用户 2026-11-09 提供频道后已对齐。
    hits: ["殺了她喂豬", "舊的童年", "聲聲慢", "一個北京人在北京", "一葉知鞦"],
    yt: "UCpdEYhmnNY-vBFNT1L-R2fg",
  },
  卢广仲: {
    alias: ["Crowd Lu", "盧廣仲"],
    hits: ["慢慢等", "鱼仔", "刻在我心底的名字", "我爱你", "早安晨之美"],
    yt: "UC3RKnfmu-Q-AJ3VmVj_tz2g",
  },
  柯震东: {
    alias: ["Kai Ko", "柯震東"],
    hits: ["小时代", "我的滑板鞋"],
    yt: "UCZNznnDYIBA0hodYCYd7GBQ",
  },
  阴三儿: {
    alias: ["Yin San Er", "陰三兒"],
    /* ⚠️ 代表作原来写的第一条《老子明天不上班》是谢帝的歌，误挂到阴三儿名下了，已删。
       下面这批是实测能在 YouTube 搜到、且确实是 IN3 作品的。 */
    hits: ["北京晚报", "没钱没朋友", "老师你好", "穷孩子", "立交桥"],
    /* ⚠️⚠️ 单独的搜索词「阴三儿」会被 YouTube 判成成人内容，
       直接返回「确认您的年龄」页面（8KB，没有任何 videoRenderer）→ 搜索 0 条。
       实测加歌名（「阴三儿 穷孩子」）或换成繁体（「陰三兒」）都能正常返回 20 条。
       所以这里给「纯歌手名」的查询做替换，避免直接撞年龄墙。 */
    /* 实测有效性（2026-11-10）：
         「陰三兒」       → 20 条，19 条是 IN3 真货 ✅
         「阴三儿 北京晚报」→ 20 条，17 条是 IN3 真货 ✅
         「阴三儿 没钱没朋友」→ 0 条 ❌（这个词会撞年龄墙）
         「IN3 阴三儿」    → 0 条 ❌
       所以只留前两个有效的，别再加无效词。 */
    safeQuery: ["陰三兒", "阴三儿 北京晚报"],
  },
  红花会: {
    alias: ["Red Flower", "紅花會"],
    /* ⚠️ 2026-11-10 实测修正：原代表作「中国魂」「反拍」在 YouTube 搜不到，
       「万里长城」搜出来是《万里长城永不倒》那些无关的歌。
       换成实测能命中的：《黑怕不怕黑》15 条精确、《圣诞夜》《HNBMC 2018 CYPHER》
       《Rocket》《红招牌》都是真货。 */
    hits: ["黑怕不怕黑", "圣诞夜", "红招牌", "Rocket", "中二病"],
    /* 用户 2026-11-10 提供的官方 Topic 频道「Hong Hua Hui - Topic」。
       ⚠️ 这个频道是「一首歌一个播放列表」的结构，12 个列表各 1 首，
          所以 ytArtistSongs 必须把列表全拉完（已改成最多 16 个），
          否则只会拿到前 3 首。 */
    yt: "UC5mxxA_9bIqixeku3BGHUvg",
  },
  新街口组合: {
    alias: ["Xinjiekou"],
    hits: ["北京土著", "这里是北京", "胡同"],
    yt: "UCGU1P-Jp5-VK22I1ItRRfbw",
  },
  羽泉: {
    // ⚠️ 「羽·泉」是同一个组合的另一种写法（中间带间隔号），
    //    DELISTED_ARTISTS 里两条都有，字典里合并成一条 + 别名即可。
    alias: ["Yu Quan", "羽·泉"],
    hits: ["最美", "冷酷到底", "深呼吸", "奔跑", "彩虹"],
    yt: "UCJnPXRqqNAwJtc8fPuX-8kg",
  },
  伤心欲绝: {
    alias: ["Wayne's So Sad", "傷心欲絕"],
    hits: ["This Is My Life", "我爱你", "谢谢你"],
    yt: "UC3QIRokryxnTOHvrIdvjLXw",
  },
  假假條: {
    alias: ["JaJaTao", "假假条"],
    hits: ["二十年", "大悲咒", "我是谁"],
    yt: "UCduvQuhInUHDBSA8jb5pbtw",
  },
  浊乐队: {
    alias: ["Zhuo", "濁樂隊"],
    hits: ["秽", "苦海", "无名"],
    yt: "UC_oJuRT37cHhnQ0_sw6diTA",
  },
  大买麦乐团: {
    alias: ["Big Buy Mai", "大買麥樂團"],
    /* ⚠️ 2026-11-10 实测修正：原代表作「小苹果」完全错了，那是筷子兄弟的歌，
       搜出来全是别人的翻唱。这乐团真正的歌是：
       《Play Go》《藥別停》《我們的小幸福》（iBand 用 iPad 演奏那个团）。 */
    hits: ["Play Go", "藥別停", "我們的小幸福"],
  },
  拷秋勤乐团: {
    alias: ["Kou Chou Ching", "拷秋勤"],
    hits: ["无名英雄", "海上的人"],
    yt: "UCamGrIHlmPq59IGDUZTU4kQ",
  },
  盘古乐队: {
    alias: ["Pangu Band", "盤古樂隊"],
    /* ⚠️ 2026-11-10 实测修正：原代表作「我们」「什么玩意儿」搜不到。
       这乐队在 YouTube 上传的都是政治题材：
       《出来一个杀一个》《你不让我摇滚》《张献忠民主》《奴才》《猪三部曲之圈》。 */
    hits: ["出来一个杀一个", "你不让我摇滚", "张献忠民主", "奴才"],
  },
  那艺娜: {
    alias: ["LadyNana", "那藝娜"],
    /* ⚠️ 2026-11-10 修正：原代表作《红旗飘飘》是孙楠的歌，挂错人了。
       她真正的成名曲是《爱如火》，还有《橘子酸》《如塔》。
       ⚠️ 频道 UCQ6-2S4_ovdC3V68VjC5-Hw 已摘掉 —— 实测拉出来 24 首
          全是「Lady #Nana's eating show #mukbang」韩语吃播视频，
          是同名的韩国博主，不是她。走搜索反而准。 */
    hits: ["爱如火", "橘子酸", "如塔"],
  },
  俄罗斯娜娜: {
    /* ⚠️⚠️ 「俄罗斯娜娜」就是「那艺娜」本人 —— 她早期用「俄罗斯娜娜」这个人设
       在抖音涨粉（后来自认是湖北人，人设翻车），现在用本名「那艺娜」发歌。
       两个名字是同一个人，代表作也共用。
       原代表作写的是《喀秋莎》—— 那是苏联老歌，搜出来全是波琳娜/爱琳的翻唱，
       跟这个人毫无关系，已换成她真正唱过的《爱如火》《橘子酸》。 */
    alias: ["Russia Nana", "娜娜"],
    hits: ["爱如火", "橘子酸", "如塔"],
    /* ⚠️ 那个 UCQ6 频道是韩国吃播博主，已摘掉，两边都走搜索 */
  },
};

/** 查字典（支持繁简归一匹配） */
function dictOf(artist) {
  if (!artist) return null;
  const key = String(artist);
  if (ARTIST_DICT[key]) return ARTIST_DICT[key];
  const simp = toSimplified(key);
  for (const k of Object.keys(ARTIST_DICT)) {
    if (toSimplified(k) === simp) return ARTIST_DICT[k];
    // 也匹配别名
    const d = ARTIST_DICT[k];
    if (d && Array.isArray(d.alias) && d.alias.some((a) => toSimplified(String(a)) === simp)) return d;
  }
  return null;
}

/** 取某位下架歌手的代表作（优先查新字典，退回旧表） */
function hitsOf(artist) {
  if (!artist) return [];
  const d = dictOf(artist);
  if (d && Array.isArray(d.hits) && d.hits.length) return d.hits;
  const key = String(artist);
  if (DELISTED_HITS[key]) return DELISTED_HITS[key];
  // 繁简归一后再试一次
  const simp = toSimplified(key);
  for (const k of Object.keys(DELISTED_HITS)) {
    if (toSimplified(k) === simp) return DELISTED_HITS[k];
  }
  return [];
}

/* 只下架了「部分曲目」的歌手里，主力作品仍在内地平台正常在售。
   ⚠️ 不能和 DELISTED_ARTISTS 混在一起：整团清零会走「YouTube 优先、内地沉底」，
      对这些人反而是伤害 —— 内地主力曲目是能播的正版，YouTube 只是搬运。
   所以只做标注，排序完全不干预。 */
const PARTIAL_DELISTED = [
  "反光镜乐队",
  "痛苦的信仰",
  "田馥甄",
  "蔡依林",
  "徐若瑄",
  "周子瑜",
  "陈翔",
  "司徒骏文",
  "廖俊涛",
  "曾轶可",
  "大兵",
  // 第二批补充
  "那艺娜",
  "俄罗斯娜娜",
  "高晓松",
  "卢广仲",
  "柯震东",
  "李易峰",
  "郑爽",
  "范冰冰",
  "房祖名",
  "张默",
  "吴秀波",
  "李小璐",
  "尧十三",
  "赵雷",
  "罗百吉",
  "黄立成",
  "Maji",
  "MC 天佑",
  "乔任梁",
  "满文军",
  "孙兴",
];

/* 这些歌手正常在售，但**个别曲目**被定点下架。
   key = 歌手名（或能识别的写法），value = 被下架的曲目名（归一化后比对）。
   命中时：YouTube/B站 版本加分、内地平台版本压分 —— 因为内地那条
   要么播不了，要么是同名翻唱。 */
const BANNED_TRACKS = {
  张震岳: ["我爱台妹", "放屁", "狗男女", "0204", "free night"],
  蔡依林: ["我的梦中情人", "我是你的谁", "打分数"],
  许嵩: ["晃晃悠悠"],
  热狗: ["哈狗帮", "毒", "补补补", "女人", "我行我素", "我爱台妹"],
  "MC Hotdog": ["哈狗帮", "毒", "补补补", "女人", "我行我素"],
  罗大佑: ["皇后大道东"],
  张学友: ["人间道"],
  费玉清: ["嘿嘿嘿"],
  田馥甄: ["离岛", "離島"],
  李宇春: ["dance to the music"],
  马頔: ["海咪咪小姐"],
  谢帝: ["瓜老外"],
  大兵: ["谁让你是广州人", "向领导汇报"],
  小贱: ["当我孤独的时候还可以抱抱你"],
  星弟: ["快餐式的爱情"],
  高振宇: ["不想上学"],
  铁热沁夫: ["大王叫我来巡山"],
  沈庆: ["青春"],
  李想: ["把爱出卖"],
  天天: ["我想更懂你"],
  五月天: ["少年他的奇幻漂流", "入阵曲"],
  黄耀明: ["六月飞霜", "主旋律"],
  苏打绿: ["墙外的风景"],
  陈奕迅: ["六月飞霜", "主旋律"],
};

/** 查「这首歌 + 这个歌手」是否命中定点下架清单 */
function bannedTrackHit(songName, artistName) {
  const s = normTitle(songName || "");
  if (!s) return false;
  const a = String(artistName || "").toLowerCase();
  for (const [who, tracks] of Object.entries(BANNED_TRACKS)) {
    const whoL = who.toLowerCase();
    if (!a || (a.indexOf(whoL) < 0 && whoL.indexOf(a) < 0)) continue;
    for (const t of tracks) {
      const tn = normTitle(t);
      if (tn && (s === tn || s.indexOf(tn) >= 0)) return true;
    }
  }
  return false;
}

/* 这些歌手在海外平台用英文/繁体艺名发行，按中文名搜会漏。
   key 是查询命中的中文名，value 是可能的官方别名（打分时用来认人）。 */
const ARTIST_ALIASES = {
  脆弱少女组: ["FragileGirls", "Fragile Girls", "脆弱少女組"],
  赵薇: ["Zhao Wei", "Vicki Zhao"],
  李志: ["Li Zhi", "Lizhi"],
  // ⚠️ 别再写 "I Mean Us"——那是另一个乐团。这个团的英文官方名是 IGU Band
  //    （YouTube 官方 Topic 频道就是 "IGU Band - Topic"）。
  那我懂你意思了: ["IGU Band", "IGU", "那我懂你的意思了"],
  陈升: ["Bobby Chen", "陳昇"],
  黄耀明: ["Anthony Wong", "黃耀明"],
  何韵诗: ["Denise Ho", "何韻詩"],
  达明一派: ["Tat Ming Pair", "達明一派"],
  // —— 乐团/组合（YouTube 常用英文或繁体艺名）——
  灭火器乐团: ["{{PERSON_1oyguhdb}}", "滅火器", "Fire EX."],
  闪灵乐团: ["ChthoniC", "閃靈", "Chthonic"],
  拷秋勤乐团: ["Kou Chou Ching", "拷秋勤"],
  伤心欲绝: ["Wayne's So Sad", "傷心欲絕"],
  假假條: ["Jiajiadao", "假假條"],
  浊乐队: ["Zhuo", "濁樂隊"],
  大买麦乐团: ["Da Mai Mai", "大買麥"],
  阴三儿: ["Yin San Er", "陰三兒"],
  红花会: ["Hong Hua Hui", "紅花會"],
  新街口组合: ["Xinjiekou", "新街口組合"],
  福禄寿乐队: ["Fu Lu Shou", "福祿壽"],
  羽泉: ["Yu Quan", "羽·泉", "羽泉"],
  盘古乐队: ["Pangu", "盤古樂隊"],
  // —— 个人（YouTube 英文/繁体艺名）——
  卢广仲: ["Lu Guang Zhong", "盧廣仲", "Crowd Lu"],
  柯震东: ["Ko Chen Tung", "柯震東", "Kai Ko"],
  高晓松: ["Gao Xiaosong", "高曉松"],
  那艺娜: ["娜娜", "俄罗斯娜娜", "俄羅斯娜娜"],
  俄罗斯娜娜: ["那艺娜", "娜娜"],
  // —— 个别曲目下架（主力在售，别名仅供识别）——
  田馥甄: ["田馥禋", "Hebe", "Hebe Tien"],
  蔡依林: ["Jolin Tsai", "蔡依林"],
  徐若瑄: ["Vivian Hsu", "徐若瑄"],
  周子瑜: ["Tzuyu", "周子瑜"],
  反光镜乐队: ["Reflector", "反光鏡樂隊"],
  痛苦的信仰: ["Tongue of Truth", "痛苦的信仰樂隊"],
};

/** 某歌手名对应的所有可能写法（含自身） */
function aliasesOf(name) {
  const out = [String(name || "").toLowerCase()];
  const extra = ARTIST_ALIASES[name];
  if (Array.isArray(extra)) for (const a of extra) out.push(String(a).toLowerCase());
  return out.filter(Boolean);
}

function delistedHit(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return "";
  for (const name of DELISTED_ARTISTS) {
    const n = name.toLowerCase();
    if (q === n) return name;

    /* ⚠️ 不能简单 indexOf —— 会把「歌名里含歌手名」的查询误判成搜歌手。
       实测踩过：搜「寻找李志」应该找这首歌，结果被判成「搜李志这位歌手」，
       返回一整页李志的歌，用户要的那首反而没有。

       判定规则：
         ① 歌手名出现在**开头**（"李志 天空之城" / "李志-天空之城"）→ 是搜歌手
         ② 歌手名出现在**末尾**（"天空之城 李志"）→ 也是搜歌手
         ③ 歌手名夹在中间（"寻找李志"/"我爱李志"）→ 是**歌名**，不是搜歌手 */
    if (q.indexOf(n) === 0) return name;
    const tailAt = q.length - n.length;
    if (tailAt > 0 && q.lastIndexOf(n) === tailAt) {
      // 结尾命中，但前面得是分隔符或空格，否则像「寻找李志」这种是在中间
      const prevCh = q.charAt(tailAt - 1);
      if (!/[\u4e00-\u9fff]/.test(prevCh)) return name;
      // 前面紧邻汉字 → 属于歌名的一部分，不算搜歌手
    }
  }
  return "";
}

/* ============ 严格的歌手名匹配 ============
   规则：**100% 相等**才算同一个人。只放行这几种白名单变体：
     ① 繁简差异（陳昇 = 陈升、盧廣仲 = 卢广仲）
     ② 乐队/乐团/樂隊 后缀（反光镜 = 反光镜乐队）
     ③ YouTube 官方 Topic 频道（"XX - Topic" 剥掉后缀后必须 100% 相等）
     ④ 别名表 ARTIST_ALIASES 里登记的官方英文名/艺名
        （那我懂你意思了 = IGU Band、闪灵乐团 = ChthoniC）
     ⑤ YouTube 官方「歌手名 + Topic / - Topic / 官方頻道」组合（实测周杰伦的
        官方频道就叫「周杰倫 Jay Chou」，不是单纯的「周杰伦」）
   ⚠️ 不放行：「XX呀」「小XX」「XX官方」「XX二號」这类只佐一字/前后缀的小号，
      正是它们把「李志」搜成一堆李志洲、李志宇的原因。 */
const ARTIST_STRIP_SUFFIX = /\s*[-–—]\s*topic$/i;          // "IGU Band - Topic"
// "周杰倫 Jay Chou" / "周杰伦 Topic" / "周杰伦 - 官方頻道"
const ARTIST_TOPIC_RE = /^(.+?)\s*(?:[-–—]\s*)?topic(?:\s|$)/i;
const ARTIST_OFFICIAL_RE = /^(.+?)\s*[-–—]?\s*(?:官方頻道|官方频道|官方帳號|官方账号|official)$/i;
const ARTIST_BAND_SUFFIX = /^(乐队|樂隊|乐团|樂團|组合|組合|组合体|band|group)$/i;

/** 去掉 YouTube Topic 后缀，只留艺术家名 */
function stripTopicSuffix(raw) {
  return String(raw || "").replace(ARTIST_STRIP_SUFFIX, "").trim();
}

/**
 * 判断 candidate 是否就是 query 这位歌手（严格）。
 * @param {string} candidate 待判定的歌手名（如 "IGU Band - Topic"）
 * @param {string} query     用户搜索的歌手名（如 "那我懂你意思了"）
 * @param {string[]} [extra] 额外允许的写法（如专辑/歌单作者名）
 */
export function isSameArtistStrict(candidate, query, extra) {
  const raw = stripTopicSuffix(candidate);
  const c = normTitle(toSimplified(raw));
  const q = normTitle(toSimplified(query));
  if (!c || !q) return false;

  // ① 完全相等（含繁简归一）
  if (c === q) return true;

  // ② 乐队/乐团 后缀：只允许 candidate 比 query 多一个「乐队」类后缀
  if (c.startsWith(q)) {
    const tail = c.slice(q.length).replace(/\s+/g, "");
    if (ARTIST_BAND_SUFFIX.test(tail)) return true;
  }
  // 反向（query 带「乐队」、candidate 不带）
  if (q.startsWith(c)) {
    const tail = q.slice(c.length).replace(/\s+/g, "");
    if (ARTIST_BAND_SUFFIX.test(tail)) return true;
  }

  // ③④ 别名表（含官方英文名 / 繁简写法）
  const allow = new Set();
  for (const a of aliasesOf(String(query || "").trim())) allow.add(normTitle(toSimplified(a)));
  // 别名表以简体名登记，用户可能用繁体搜索，两个方向都查
  for (const key of Object.keys(ARTIST_ALIASES)) {
    if (normTitle(toSimplified(key)) === q) {
      for (const a of ARTIST_ALIASES[key]) allow.add(normTitle(toSimplified(a)));
      allow.add(q);
    }
  }
  if (Array.isArray(extra)) for (const e of extra) allow.add(normTitle(toSimplified(stripTopicSuffix(e))));
  if (allow.has(c)) return true;

  return false;
}

/**
 * 从 YouTube 视频标题解析专辑名。
 * 常见正版音乐标题格式（取中间那段「既不是歌手名、也不是歌曲名」的部分）：
 *   ① 歌手 - 专辑名 - 歌曲名
 *   ② 歌手《专辑名》歌曲名 / 歌手《专辑名》 - 歌曲名
 *   ③ 歌手 - 歌曲名 (专辑: 专辑名)
 *   ④ 歌手 - 歌曲名 [专辑名]
 *   ⑤ 歌手 - 歌曲名 - 专辑名   （最后一段是专辑）
 * 解析不到 → 返回空字符串（调用方退化为「歌手」总专辑）。
 */
/* YouTube 视频标题里的画质/格式标注，不是专辑名。
   用 `pickSegment` 选段时，命中这段的直接跳过，不把它当专辑名。 */
const QUALITY_RE =
  /^(4k|8k|hd|hq|fhd|sd|av1|hdr|1080p|720p|480p|360p|240p|144p|160p|90p|60fps|30fps|fps|dolby|hevc|h265|avc|h264|x264|x265|webm|mkv|mp4|avi|flv|m4a|aac|flac|opus|320kbps|256kbps|192kbps|128kbps|320k|256k|192k|128k|lossless|hi-res|hi-fi|hifi|hifi audio|hi fi|hi\\s*fi|official music video|official video|official mv|official audio|official sound|official cover|official visual|official remaster|official edit|official clip|official version|official release|official performance|official acoustic|official studio|official live|official session|official remastered|official mono|official stereo|official radio|official stream|official playlist|official full|official lyrics|official lyric|official behind|official behind the scenes|official tour|official official|official mv|official music video|official hd|official audio|official studio|official version)$/i;

function pickSegment(segs, skipIdx) {
  for (let i = 0; i < segs.length; i++) {
    if (i === skipIdx) continue;
    const s = segs[i].trim();
    if (!s || s.length > 60) continue;
    if (QUALITY_RE.test(s)) continue;
    return s;
  }
  return null;
}

function pickAlbumNameFromTitle(title, artistName) {
  const t = String(title || "").trim();
  const a = String(artistName || "").trim();
  if (!t || !a) return "";
  const low = t.toLowerCase();
  const aLow = a.toLowerCase();

  // ③ "(专辑: xxx)" / "（专辑：xxx）"
  let m = t.match(/[（(]\s*专辑\s*[:：]\s*([^）)]{1,40})[）)]/i);
  if (m && m[1] && m[1] !== a) return m[1].trim();

  // ④ "[专辑名]"（通常在歌名之后）
  m = t.match(/\[([^\[\]]{1,40})\]/);
  if (m && m[1] && m[1] !== a && !isCoverLikeTitle(m[1]) && m[1].indexOf(a) < 0) return m[1].trim();

  // ② 书名号《专辑名》
  m = t.match(/《([^》]{1,40})》/);
  if (m && m[1] && m[1] !== a && !isCoverLikeTitle(m[1])) return m[1].trim();

  // ①③⑤ 用分隔符 "-" / "—" 拆段
  const segs = t.split(/[-–—－·|]+/).map((s) => s.trim()).filter(Boolean);
  if (segs.length >= 2) {
    // 去掉开头是歌手名的段
    let i = 0;
    if (segs[0] && segs[0].toLowerCase().indexOf(aLow) >= 0) i = 1;
    // 剩下 >= 2 段：中间是专辑、结尾是歌曲
    if (i + 2 < segs.length) {
      const album = segs[i + 1];
      if (album && album !== a && !isCoverLikeTitle(album) && album.toLowerCase().indexOf(aLow) < 0) {
        return album;
      }
    }
    // 剩下刚好 2 段：判断哪段是专辑
    if (i + 2 === segs.length) {
      const first = segs[i];
      const second = segs[i + 1];
      if (first && !isCoverLikeTitle(first) && first.toLowerCase().indexOf(aLow) < 0 &&
          second && (isCoverLikeTitle(second) || second.length < 4)) {
        return first;
      }
      if (second && !isCoverLikeTitle(second) && second.toLowerCase().indexOf(aLow) < 0 &&
          first && (isCoverLikeTitle(first) || first.length < 4)) {
        return second;
      }
    }
  }
  return "";
}

/* 完全不是歌的内容：访谈、新闻、八卦、红毯、纪录片、综艺片段…
   ⚠️ 实测搜「赵薇」会返回「MET Gala 2015」「危险的富贵：赵薇的难言之隐」
      「天涯神贴：揭秘赵薇早期秘闻」这类东西，能播但完全不是音乐。
      这些在 add 阶段就直接扔掉，不进入结果列表。 */
/* ⚠️ 实测（2026-11-08）搜「赵薇」时，下面这些**全都漏过了**旧正则：
     赵薇作品被多平台下架、除名！        ← 缺「下架」
     赵薇多部影视作品被删除名字           ← 缺「删除」
     【巫师】赵薇的资本博弈               ← 缺「资本」「博弈」
     赵薇 趙薇 ×易立竞 主持人与演员        ← 缺「主持人」「演员」
     【台灣壹週刊】趙薇：愛情一定會變調     ← 缺「週刊」「壹週刊」
   这些都是**新闻/八卦/访谈**，不是歌曲，必须拦掉。
   注意：不能加「演员」「歌手」这种会误伤歌名的词，所以只加「主持人与」「访谈」这类
   明确指向节目的组合词。 */
/* ⚠️⚠️ 这里踩过大坑（2026-11-09 修）：
   老版本把「演员」「素颜」「事件」「故事」「公司」「品牌」「深度」「观察」
   「调查」「回应」「声明」「资本」「财富」「分析」「到底」…… 这些**当红歌名高频词**
   也塞进了非音乐正则，结果直接把它们从结果里删了 ——
   搜「薛之谦 演员」，10 条《演员》全被当新闻删掉，一条都搜不到；
   搜「许嵩 素颜」同理。这类"单词即歌名"的词**绝不能单条命中就删**。
   拆成两层：
     · NOT_MUSIC_RE   —— 强新闻词（几乎不可能出现在歌名里），单条命中直接删；
     · NOT_MUSIC_WEAK —— 弱词（既可能是歌名、也可能是新闻标题的一部分），
                          只有在「长标题(≥12 字)」里命中、且不含明显单曲特征时才删。
   原则：宁可漏掉几条新闻，也不能让合法歌名凭空消失。 */
const NOT_MUSIC_RE =
  /专访|访谈|採訪|采访|新聞|新闻|纪录|紀錄|講座|讲座|演講|演讲|vlog|Vlog|reaction|Reaction|播放列表|Playlist|Gala|红毯|紅毯|八卦|秘闻|秘聞|神贴|神貼|揭秘|内幕|內幕|难言之隐|難言之隱|综艺|綜藝|花边|花邊|吐槽|解说|解說|评论|評論|影评|影評|抓捕|被判刑|坐牢|绯闻|緋聞|故事会|故事會|你拍|面对面|面對面|超话|超話|资金外逃|資金外逃|女明星|运动员|運動員|访谈录|訪談錄|恋情|戀情|出轨|出軌|终于说出|不怕尴尬|曾爆料|自曝|坦言|首谈|泪崩|封杀|封殺|查无此人|壹週刊|壹周刊|人物訪談|主持人与|纪录片|紀錄片|解說版|配音版|点评版|时评|時評|幕后|幕後|起底|扒一扒|你不知道的|辟谣|闢謠|捐款|慈善|公益|股票|股市|楼市|樓市|财经|財經|融资|融資|收购|收購|退市|市值|身价|身價|富豪|首富|杠杆|槓桿|帝国|帝國|代言|作品被|多平台|全网下架|全網下架|封禁|现身海外|現身海外|不了了之|情人吗|起家|誰毀掉|谁毁掉|内娱|內娛|资本链条|資本鏈條|权贵|權貴|大公开|大公開|多位大佬|揭開|揭开|解密|深扒|深挖|删除名字|刪除名字/i;
/* 弱词：可能是歌名，也可能只是新闻标题的一部分。只在长标题里才删。 */
const NOT_MUSIC_WEAK =
  /演员|素颜|素顏|事件|故事|公司|集团|集團|品牌|深度|观察|觀察|调查|調查|分析|解读|解讀|点评|點評|回顾|回顧|回忆|回憶|盘点|盤點|真相|内幕|回应|回應|声明|聲明|澄清|道歉|表白|暗恋|暗戀|告白|拒绝|拒絕|分手|复合|懷孕|怀孕|生子|结婚|結婚|离婚|離婚|资本|資本|财富|財富|经济|經濟|投资|投資|商业|商業|生意|上市|广告|廣告|到底|究竟|怎么|怎麼|为何|為何|背后|背後|如今|现状|現狀|近况|近況|复出|復出|现身|現身|亮相|爆料|真相/i;

/* 一条标题是否「明显不是歌」：强新闻词直接判死；弱词只在标题够长(像新闻)时才判死。 */
function isNotMusicTitle(rawTitle) {
  const s = String(rawTitle || "");
  if (!s) return false;
  if (NOT_MUSIC_RE.test(s)) return true;
  // 弱词：只有长标题 + 含新闻式标点/结构时才判死，避免误杀「演员」「素颜」
  if (NOT_MUSIC_WEAK.test(s)) {
    const long = s.length >= 12;
    const newsish = /[|｜]|【.*】|《.*》.*[？?！!]|^\d{4}|曝光|惊呆|震惊|网友|直播回放/.test(s);
    return long && newsish;
  }
  return false;
}

/* 关注过的歌手名（小写）。每次 search() 开头刷新一次，
   不能每首歌都去读 storage——那是 30 次反序列化。 */
let followedSet = new Set();

// 按匹配度+质量给一条结果打分，越好越靠前
/* ============================================================
 * 「这次搜的是不是歌手名」的整轮判定
 * ------------------------------------------------------------
 * 移植自用户自己的 MusicFree 源（那里踩过这个坑，注释都是血泪）。
 *
 * 问题现象：搜「那我懂你意思了」（乐队名），结果混进「那我懂你意思了呀」
 * （池鱼/划水唱的）这种同名但完全无关的歌。
 *
 * 判断逻辑：看整批结果里
 *   hits = artist 字段包含查询词的条数（说明这串字是人名）
 *   n    = 标题正好等于查询词、但 artist 不是的条数（同名歌）
 * 只有 n >= 3 且 n >= hits 时才判定为「歌名搜索」，否则当歌手名处理。
 *
 * ⚠️ 为什么不能简单用「有同名标题就算歌名」：
 *    搜「那我懂你意思了」时，乐队自己有首歌就叫这名，另外还有 3 个人
 *    写了同名歌 → 同名 3 条，会被误判成歌名搜索，
 *    结果乐队真正的 18 首 YouTube 官方曲全被压下去。
 *    实测那轮：同名 3 / 歌手命中 21 → 是歌手名，不该否决。
 *    而「晴天」：同名 10+ / 歌手命中 0 → 是歌名，该否决。
 * ============================================================ */
function normForMatch(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s\-–—_/|·•~,，.。!！?？'"'"'"、:：()（）\[\]【】]/g, "")
    .trim();
}

/** 一条结果的 artist 字段是否等于/包含查询词 */
function artistHitsQuery(artist, query) {
  const a = normForMatch(artist);
  const q = normForMatch(query);
  if (!a || !q) return false;
  if (a === q) return true;
  // 多歌手的 "A/B/C" 拆开比
  for (const part of String(artist || "").split(/[\/&、,，;；]/)) {
    if (normForMatch(part) === q) return true;
  }
  return a.indexOf(q) >= 0;
}

/** 判断整批结果里这次查询是不是歌手名 */
function isArtistSearch(query, items) {
  /* ⚠️ 「歌名 + 歌手」这种组合查询（如「七里香 周杰伦」）**不是**歌手名搜索。
     实测搜「七里香 周杰伦」时，判成了歌手名，于是「周杰伦♚」
     这个冒名小号的杂歌（《我爱你》《学狗叫》《撤回一句话》）因为 artist 命中率高
     全挤到前排，真正的《七里香》被挤到第 6 位之后。
     判据：查询按空格/分隔符切成≥2 段，其中有一段是歌名（其它结果标题里出现过），
     就按歌名搜索处理。 */
  /* 分段查询（歌名 歌手）**一律不按歌手名搜索**：
     艺术家名几乎都是单段（「周杰倫」「Beyond」「告五人」），
     一旦用户打了空格，就是「歌名 + 歌手」的组合查询，当然按歌名排 ——
     谁家的标题/歌手同时命中，谁排前面。 */
  const segs = String(query || "").trim().split(/\s+/).filter((x) => x.length >= 2);
  if (segs.length >= 2) return false;

  const q = normForMatch(query);
  if (!q || q.length < 2) return false;
  const list = items || [];
  if (!list.length) return false;

  let hits = 0; // artist 命中
  let same = 0; // 标题等于查询词但 artist 不是
  /* ⚠️ 还数「不同歌手数」：搜「起风了」时，有一堆**歌手名叫「起风了」**的不同人
     （独立音乐人），他们的歌各不相同（困城/去看海/嫩芽…），artist 命中 15 条；
     而真歌《起风了》同名 9 条。按「条数」比会判成歌手名，把真歌全压下去。
     按「歌手种类数」比才对：这 15 条来自 15 个不同歌手？不——它们 artist 全都叫「起风了」，
     所以 artistKinds=1；而歌名「起风了」有 9 个不同演唱者（吴青峰/买辣椒也用券…）。
     一种 artist 对应一个「歌手名」假设，胜过 9 个不同人唱同一首歌 = 是歌名。 */
  const artistKinds = new Set();
  for (const it of list) {
    const artist = (it.artists && it.artists[0] && it.artists[0].name) || "";
    if (artistHitsQuery(artist, query)) {
      hits++;
      artistKinds.add(normForMatch(artist));
      continue;
    }
    const t = normForMatch(it.name);
    if (t && t === q) same++;
  }
  // 同名歌不够多 → 是歌手名
  if (same < 3) return true;
  /* 同名歌 >= 3 时：若这些同名歌来自多个不同歌手（>=3 种），说明是**歌名**
     （一首歌被很多人翻唱/各平台都有）；若 artist 命中也只来自 1-2 种歌手，
     就更确认是歌名搜索。反之 artist 来自很多种不同歌手、且同名的很少，才是歌手名。 */
  if (same >= 3 && same >= artistKinds.size) return false; // → 歌名搜索
  return hits > same * 2; // 歌手名只在 artist 命中压倒性更多时才成立
}

function scoreTrack(t, query) {
  /* ⚠️ 打分要用**原始标题**（t._rawTitle），不能用清洗后的 t.name。
     原因：tier 判定靠「Official Video / 歌詞版 / 標清 / HQ」这些关键词，
     而 cleanSongTitle 正好把它们剥掉了 —— 用 t.name 打分会丢掉这些信号。
     UI 显示用 t.name（干净的），排序判断用 t._rawTitle（原始的）。 */
  const rawTitle = String(t._rawTitle || t.name || "");
  const title = normTitle(String(t.name || rawTitle));
  const q = normTitle(query);
  const artist = String((t.artists && t.artists[0] && t.artists[0].name) || "");
  const artistNorm = artist.toLowerCase();
  let score = 0;

  /* ① 标题匹配度（最重要）
     ⚠️ 分段查询（「七里香 周杰伦」）不能拿整串去比标题 —— 一个都匹配不上，
        结果那些纯属噪声的条目反而因为「都不沾边」站在同一起跑线。
        拆成段逐个比，标题命中任一段就算命中，命中多段更高分。
        歌手段另外在 ② 里给 artist 加分。 */
  if (t._qSong) {
    /* 分段查询：「标题命中歌名段」是**前提**，不命中直接沉底 ——
       否则冒名小号的杂歌（标题《把坏天气当风景》、artist 挂着「周杰倫」）
       会因为 artist 命中而捞回来。
       命中之后再叠歌手段的加分：歌手也对得上的最前。 */
    const songHit = title === t._qSong || title.startsWith(t._qSong) || title.indexOf(t._qSong) >= 0;
    if (!songHit) {
      score -= 500; // 标题里根本没这个歌名 → 跟这次查询无关
    } else {
      if (title === t._qSong) score += 300;
      else if (title.startsWith(t._qSong)) score += 140;
      else score += 60;
      // 歌手段：artist 命中再加分（只降不删，避免误伤）
      const aSegs = t._qArtist || [];
      const aExact = aSegs.some((seg) => {
        const an = normForMatch(artist);
        if (an === seg) return true;
        // 「A/B」拆开逐个认
        for (const part of String(artist || "").split(/[\/&、,，;；]/)) {
          if (normForMatch(part) === seg) return true;
        }
        return false;
      });
      if (aExact) score += 120;
      else if (aSegs.length) score -= 40;
    }
  } else if (title === q) score += 300;
  else if (title.startsWith(q)) score += 140;
  else if (title.indexOf(q) >= 0) score += 60;
  else if (q.indexOf(title) >= 0 && title.length >= 2) score += 40; // 查询更长时
  else score -= 40; // 基本不沾边

  // ② 查询里带了歌手名（"晴天 周杰伦"），则歌手必须匹配，否则重罚
  const qTokens = q.split(" ").filter((x) => x.length >= 2);
  // 判断查询词里除歌名外是否还有"像歌手名"的部分（近似：查询含空格，或查询与标题不等）
  const queryHasArtist = qTokens.length >= 2 || q !== title;
  if (artistNorm && qTokens.some((tok) => artistNorm.indexOf(tok) >= 0)) {
    score += 90; // 歌手命中查询词
  } else if (queryHasArtist && artistNorm) {
    score -= 70; // 查询里像是点了歌手，但这条不是 → 大概率是同名李鬼
  }

  // ③ 变体降权（不删除，只沉底）
  if (isCoverLikeTitle(rawTitle)) score -= 120;
  if (LIVE_RE.test(rawTitle)) score -= 60;
  if (NOISE_RE.test(rawTitle)) score -= 80;
  /* 拼接串烧「歌A + 歌B」/「歌A&歌B」重罚 —— 用户搜的是单个裸歌名，
     串烧混唱是另一种东西。尤其别让它靠「是本人原唱」顶到裸单曲前面。 */
  if (/[＋+&]\s*[^（(]\S/.test(rawTitle)) score -= 160;

  /* ③c QQ 交叉验证的结果。
     · 双平台歌手一致 → 这确实是他唱的，加分（最可信）
     · 歌名相同但 QQ 说歌手是别人 → 大概率是翻唱/同名老歌，重压
       （网易云把洪荣宏的《七里香》标成原唱，QQ 里那首歌的歌手根本不是周杰倫） */
  if (t._qqOk) score += 120;
  else if (t._qqConflict) score -= 260;
  /* QQ 认定的「正主」再顶一层 —— 搜「七里香」时把周杰倫的版本顶到最前，
     而不是白允y/梨土豆er 那些翻唱。 */
  /* ⚠️ 「正主加分」只在**标题恰好等于查询歌名**时才给（不含只"包含"）。
     否则搜「江南」时，「江南+一千年以后 (跨年Live)」这类串烧、拼接现场
     也会因为是林俊杰本人（_qqMainArtist）被 +300 顶到原唱前面 ——
     它确实是本人唱的，但它不是用户要找的那一个裸单曲。
     裸标题完全等于 _qSong/q 才给正主分，变体（Live/串烧/Remix/括号）自然沉底。
   「非正主降权」仍用"包含"判定 —— 翻唱者标题常带「(副歌)」「Cover」等后缀，
     不是裸歌名，但同样要压下去，不能因为标题不完全相等就放它上来。 */
  if (t._qqMainArtist && (title === q || title === (t._qSong || ""))) score += 300;
  else if (t._qqNotMain && (title === q || title === (t._qSong || "") || (t._qSong && title.indexOf(t._qSong) >= 0) || title.indexOf(q) >= 0)) score -= 280;

  /* ③b 标题带括号的默认往后放。
     用户规矩：搜歌名时，裸标题（「七里香」）才是干净的原版，
     「七里香 (DJ咚鼓版)」「晴天（深情版）」「xxx【翻自…】」都是改编/翻唱/现场，
     一律降权。括号里即使是 (Official Video) 这种无害的，也先按用户说的往后，
     反正官方 MV 在 YouTube 侧还有 officialChannel 加分兜着。 */
  if (/[(（\[【<《]/.test(rawTitle)) score -= 180;

  // ④ 时长合理性
  const sec = (Number(t.duration) || 0) / 1000;
  if (sec >= 100 && sec <= 480) score += 30;
  else if (sec > 0 && sec < 60) score -= 150; // 明显是试听片段
  else if (sec > 600) score -= 40;

  /* ⑤ 短标题优先（越接近查询原样越好）。
     歌名搜索时加倍：短的就是干净的单曲，长的多半是串烧/合集/带一堆装饰
     （LX Music 就是短的在前）。 */
  const lenPen = Math.max(0, title.length - q.length) * (t._artistSearch ? 3 : 8);
  score -= lenPen;

  // ⑥ 网易云官方原唱/翻唱标记（最硬的判据，比标题猜可靠得多）
  if (t._cover === 1) score += 120; // 原唱
  else if (t._cover === 2) score -= 130; // 翻唱
  else if (t._cover === 3) score -= 100; // 伴奏/remix/其他版本
  // 热度：同分时热门优先（只做微调，不盖过匹配度）
  if (t._pop >= 90) score += 25;
  else if (t._pop >= 70) score += 12;
  // 需付费/VIP 的排后面一点（可能播不了）
  if (t._fee === 1) score -= 15;

  /* ⑦-0 定点下架曲目：内地平台那条要么播不了、要么是同名翻唱。
        YouTube/B站 版本必须顶到最前面，用户点开就能听。
        加分数值要能盖过「QQ 原唱 +120 / 网易原唱 +120」——
        那些标记对这类歌是**错的**（内地那条确实是原唱，但它被下架了）。 */
  if (t._bannedTrack) {
    if (t.provider === "youtube" || t.provider === "bilibili") score += 420;
    else score -= 420;
  }

  /* 【YouTube Music「音乐人」加权】
     YouTube 搜索会把一堆搬运号/粉丝号/剪辑号混进来。但官方音乐人频道
     （Topic 频道 / 官方艺人号）有一个特征：**同一位歌手的官方曲目高度集中在
     同一个 UC id 下**（例如 周杰伦 的官方号是「周杰倫 Jay Chou」，
     该 UC 下有 400+ 条视频）。而搬运号一条视频一个号，分散得很。
     所以 ytSearch 里统计「本批结果中哪个 UC 出现最多」，命中的打上
     _ytArtistChan 标记，这里给加分 —— 这是**比频道名猜「- Topic」更硬的判据**，
     因为官方频道名可能根本不含歌手名。

     分值 90：足够把官方曲目从搬运号堆里提到前面，
     但又低于「标题与查询词完全相等」的 300，不会打乱相关度排序。 */
  if (t._ytArtistChan) score += 90;

  // ⑦ 平台元数据可信度
  /* QQ 的歌手/专辑字段是最准的（网易云那边经常写错人），
     而且它把 Live/伴奏 写在歌名里，可信度给最高一档。
     但仍低于 Topic 官方音轨（那是唱片公司直供）。 */
  /* QQ 的元数据准，但它的**搜索结果排序**是按热度，翻唱常常更热
     （搜「七里香」QQ 前 4 条全是白允y/梨土豆er 这类翻唱）。
     所以平台分只给一点点（比网易云略高），
     真正决定顺序的是「是不是官方音源」和「QQ 交叉验证」那两项。 */
  if (t.provider === "qq") score += 15;
  else if (t.provider === "netease") score += 20;
  else if (t.provider === "kuwo") score += 10;
  else if (t.provider === "youtube") {
    if (/-\s*Topic$/i.test(artist)) t._topic = true;
    /* - Topic 是 YouTube 官方自动生成的唱片公司音轨（YouTube Music 的「专辑」就来自这里），
       音质干净、没有 UP 主加的片头片尾和水印，是所有来源里最可信的。
       用户要求顶到最高，所以给一个压倒性的加分。 */
    if (/-\s*Topic$/i.test(artist)) score += 400; // 官方发行音轨（最高优先级）
    else {
      /* ⚠️ 没有 Topic 频道的歌很多（欧美大牌常见），它们用的是**艺人本人频道**
         （频道名就叫「Elton John」「Adele」）。之前只认 artist 字段里的 VEVO/Official，
         但艺人本人频道名里根本没这些词，反而被当成「普通频道」扣分，
         导致官方 MV 排到翻唱后面。现在同时看**频道名**和**标题**：
           · 频道名含 VEVO/Official/官方 → 官方频道
           · 标题含 Official Video / 官方 MV / 官方高清 → 官方 MV
           · 频道名出现在标题里（本人上传）→ 艺人本人频道
         三种都算高可信，给 180（比 Topic 低一档，但远高于普通频道）。 */
      const officialChannel = /VEVO|Official|官方|Taihe|太合|StreetVoice|相信音樂/i.test(artist);
      const officialTitle =
        /official\s*(music\s*)?video|official\s*audio|官方\s*MV|官方高清|官方版|官方完整版/i.test(rawTitle);
      // 频道名出现在标题里：说明是艺人本人上传的
      const artistChannel = artist.length >= 2 && normTitle(rawTitle).indexOf(normTitle(artist)) >= 0;
      /* ⚠️ 「艺人本人频道」还有一类识别不出来：周杰倫的官方频道叫
         「周杰倫 Jay Chou」（英文名），既没 VEVO 也没 Official，标题也不含频道名，
         于是走 else 被扣 10 分 —— 结果搜「七里香」时，他的官方原版
         排在洪荣宏/周思洁的同名翻唱后面（第 6）。
         补一条：**标题干净得像单曲（等于查询词、不带括号装饰）+ 频道名不像营销号**，
         就按「疑似艺人本人上传」给高分。营销号（歌单/合集/无损/热歌/MV/歌词…）
         标题一定带装饰或频道名带这些词，会被排除。 */
      const cleanHit = !!q && title === q;           // 标题就是歌名本身，没有任何后缀
      const fanChannel = /音乐|歌单|歌單|合集|频道|頻道|电台|電台|music|Music|channel|Channel|MV|mv|歌词|歌詞|lyrics|Lyrics|推荐|推薦|精选|精選|热歌|熱歌|无损|無損|Hi-?Res|HQ|4K|8K|DJ|翻唱|cover|Cover|official|Official|VEVO/i.test(artist);
      const personLike = artist.length >= 2 && artist.length <= 14 && !fanChannel;
      if (officialChannel || officialTitle || artistChannel || (cleanHit && personLike)) score += 180;
      else if (cleanHit) score += 60; // 标题干净但频道名存疑：也给一点
      else score -= 10; // 普通 UP 主频道，不可信
    }
  }

  // ⑧ 访谈/新闻/纪录片类完全不是歌，重罚
  if (isNotMusicTitle(rawTitle)) score -= 400;

  // ⑨ 命中下架歌手时，歌手字段必须真的是这个歌手（防同名噪声）
  //    海外平台常改用英文/繁体艺名（脆弱少女组 → FragileGirls），
  //    所以标题和歌手都要拿别名表比一遍。
  if (t._delisted) {
    const names = aliasesOf(t._delisted).concat([String(t._delisted).toLowerCase()]);
    const hay = (rawTitle + " " + artist + " " + String((t.album && t.album.name) || "")).toLowerCase();
    /* ⚠️ 必须「边界精确匹配」，不能简单 indexOf 包含判断。
       踩过的坑：搜「赵薇」时第一条冒出来「别让爱凋落 / 赵薇薇 - Topic」——
       "赵薇薇" 里含 "赵薇"，indexOf 判定为真 → 加分顶到第一。
       同理还有「赵薇儿」「小赵薇」之类。这些都是**别的歌手**。
       规则：命中位置的左右两侧不能紧挨着另一个汉字（除非是分隔符/空格/结尾）。 */
    /* ⚠️ 判断"这条到底是不是这位歌手"，要挡三种撞名：
       ① 赵薇薇 —— 名字里含「赵薇」，紧邻汉字
       ② 「赵薇薇 - Topic」—— 后面隔着空格但还是别人的频道名
       ③ 越南翻唱号把标题写成「赵薇」+ 越南语频道名
       做法：先做严格边界判断（前后不紧邻汉字），
       再把常见撞名后缀一并排除。 */
    /* 撞名黑名单：这些词一出现，说明是别人（名字里含目标歌手名）。 */
    const NAME_COLLIDE = /薇薇|赵薇儿|小赵薇|李志辉|赵薇儿/;
    const isRight = names.some((n) => {
      if (!n || n.length < 2) return false;
      let from = 0;
      while (true) {
        const at = hay.indexOf(n, from);
        if (at < 0) return false;
        const before = at > 0 ? hay.charAt(at - 1) : "";
        const after = hay.charAt(at + n.length);
        const isCJK = (ch) => !!ch && /[\u4e00-\u9fff]/.test(ch);
        // ① 前后不紧邻汉字（允许空格/分隔符/结尾）
        // ② 整体不命中撞名黑名单
        if (!isCJK(before) && !isCJK(after) && !NAME_COLLIDE.test(hay)) return true;
        from = at + 1;
      }
    });
    if (isRight) {
      score += 150;
      /* 下架歌手里还有一类噪声：标题**只有歌手名**、没有歌名
         （如「赵薇」「Vicki Zhao 赵薇」），多半是越南/东南亚翻唱号的
         标题就写个歌手名。真正有歌名的条目标题里一定还有别的字。
         所以：去掉歌手名后如果剩余字数很少，降权。 */
      let rest = rawTitle.toLowerCase();
      for (const n of names) if (n) rest = rest.split(n).join("");
      rest = rest.replace(/[\s\-_|｜/·,，.。()（）【】\[\]「」""''#]/g, "");
      if (rest.length <= 2) score -= 180;
      // 越南/泰文等外文翻唱：标题含非中英文字符时降权（这些不是原唱）
      if (/[\u0e00-\u0e7f\u1e00-\u1eff\u0102\u0103\u0110\u0111\u01a0\u01a1\u01af\u01b0]/.test(rawTitle)) score -= 220;
    } else score -= 250; // 不是这个歌手的，直接沉底

    /* 播放层面：这些条目最后都得靠「拿歌名去网易云/酷我找同曲」才能出声，
       而现场/串烧/访谈/整张专辑那种长视频在内地平台根本搜不到对应曲目。
       所以排序时把「像正规录音室单曲」的顶到前面：
       标题短、时长 2~6 分钟、不带 Live/现场/串烧/精选集。 */
    const sec = (Number(t.duration) || 0) / 1000;
    if (sec >= 120 && sec <= 380) score += 90;
    else if (sec > 600) score -= 180; // 超过 10 分钟基本是合集
    else if (sec > 0 && sec < 90) score -= 60;
    if (/live|Live|LIVE|现场|現場|演唱会|演唱會|串烧|串燒|精选|精選|合辑|合輯|完整版|全曲|一小时|一小時|小时|小時|playlist|Playlist|片尾曲|片頭曲|片尾|主题曲|主題曲|插曲|宣传曲|宣傳曲|OST|原声带|原聲帶|配乐|配樂/i.test(rawTitle))
      score -= 160;
    // 标题越短越像单曲
    score -= Math.max(0, String(rawTitle).length - 20) * 2;

    /* 下架歌手场景下，内地平台的条目整体沉底：
       它们的歌手库对这些人是空的，返回的基本都是同名噪声。
       但**不删除**——万一 YouTube 一条都没搜到，这些就是唯一的兜底，
       沉底而非丢弃，用户往下翻还能看到。 */
    if (t.provider === "netease" || t.provider === "kuwo") score -= 300;
  }

  /* ⑩ 这次搜的是歌手名时，artist 字段必须真的写着这个歌手。
     否则「那我懂你意思了呀」（池鱼/划水唱的）这类同名歌会混进来。
     只降权不删除 —— 同名歌里也可能有用户真正想找的。 */
  if (t._artistSearch) {
    // 歌手搜索：艺名出现频率最高者加分（真身），短艺名再补一点
    if (typeof t._freqScore === "number") score += t._freqScore;
    const artAll = (t.artists || []).map((a) => a.name || "");
    const main = String(artAll[0] || "");
    // Live / 现场 / 演唱会 / 伴奏，歌手搜索时一律重降（要录音室版）
    if (LIVE_RE.test(rawTitle) || /伴奏|instrumental|KTV|翻唱|cover|纯享|純享/i.test(rawTitle)) score -= 150;
    // 主歌手是不是查询词：歌手搜索时，合唱/参与合唱的歌要区分，
    //   以他为主（独唱、feat别人）→ 正常保留
    //   以别人为主、他只是参与（宋祖英的合唱里有他）→ 重降权
    //   源自用户自己的源：歌手 50 首热门里 39 首的主歌手是别人，
    //   那是《布拉格广场》《刀马旦》这类别人主场、他只是参与合唱的歌。
    const mainHit = artistHitsQuery(main, query);
    if (artistHitsQuery(artist, query)) {
      if (mainHit) score += 200;
      else score -= 160; // 主歌手不是他，只是挂名合唱
    } else {
      score -= 260;
    }
    /* 合唱/多艺人再狠降：歌手搜索时用户要的是这个人的独唱作品。
       实测搜「周杰伦」，屋顶/刀马旦/因为是爱情(Live) 这类
       合唱占了前二，独唱《花海》《蜗牛》反而被挤到后面。
       多艺人（除他还有别人）直接大幅沉底，独唱单曲才顶得上。 */
    if (artAll.length > 1) score -= 180;
    else {
      // LX Music 风格：独唱单曲里，标题越短（越像单曲）越靠前。
      // 这里 title 已经缩到只剩歌名，短 = 干净的单曲；长 = 串烧/合集/带装饰。
      const len = String(rawTitle || "").replace(/\([^)]*\)|\[[^\]]*\]|【[^】]*】/g, "").trim().length;
      if (len > 0 && len <= 6) score += 30;   // 2~3 字纯歌名：夜曲/花海/蜗牛
      else if (len <= 12) score += 10;
      else if (len > 20) score -= 20;         // 超长 = 合集/串烧
    }
  }

  /* 歌名搜索：比查询词还短的标题，根本对不上这首歌，重罚沉底 */
  if (t._tooShort) score -= 300;

  /* ② 关注过的歌手稍微往前提一点。
     不能给太多—— 关注只是个偏好，不能盖过匹配度。 */
  if (followedSet && followedSet.size) {
    const a = String(artist || "").toLowerCase();
    if (a && followedSet.has(a)) score += 60;
  }

  return score;
}

// ------------------------- 网易云条目转 track -------------------------
// cloudsearch 字段：ar(歌手[]) al(专辑) dt(时长ms) originCoverType(1原唱/2翻唱/3伴奏) fee pop
function neSongToTrack(song) {
  const artists = (song.ar || song.artists || []).map((a) => ({ name: a.name || "" }));
  const album = song.al || song.album || {};
  const ms = Number(song.dt || song.duration || 0) || 0;
  const cover = Number(song.originCoverType);
  return {
    id: `ne:${song.id}`,
    name: song.name || "未知歌曲",
    artists: artists.length ? artists : [{ name: "未知歌手" }],
    album: album.name ? { name: album.name, imageUrl: album.picUrl || "" } : undefined,
    artwork: album.picUrl || "",
    duration: ms > 0 ? ms : undefined,
    // 内部字段，供打分用（不发送给播放器也无害）
    _cover: Number.isFinite(cover) ? cover : undefined,
    _pop: Number(song.pop) || 0,
    _fee: Number(song.fee),
    _st: Number(song.st), // <0 表示下架，首页拼单要剔掉
  };
}

// ------------------------- 专辑 / 歌手 / 歌单 转换 -------------------------
/** 把各种来源的发布日安全地变成 YYYY-MM-DD，坏值一律返回 undefined */
function dateOnly(value) {
  if (value == null || value === "") return undefined;
  const d = new Date(typeof value === "number" ? value : String(value));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

function neAlbumToAlbum(a) {
  return {
    id: `nea:${a.id}`,
    name: a.name || "未知专辑",
    // ⚠️ MyGo 的 Go 结构体要求 artists[].id 是 string，传数字会直接反序列化失败
    artists: a.artist && a.artist.name ? [{ id: String(a.artist.id || ""), name: a.artist.name }] : [],
    imageUrl: a.picUrl || "",
    artwork: a.picUrl || "",
    released: dateOnly(a.publishTime),
    trackCount: Number(a.size) || undefined,
  };
}

function neArtistToArtist(a) {
  return {
    id: `nar:${a.id}`,
    name: a.name || "未知歌手",
    imageUrl: a.picUrl || a.img1v1Url || "",
    artwork: a.picUrl || a.img1v1Url || "",
    albumCount: Number(a.albumSize) || undefined,
    trackCount: Number(a.musicSize) || undefined,
    description: (a.alias || []).join(" / ") || undefined,
  };
}

function nePlaylistToPlaylist(p) {
  return {
    id: `nep:${p.id}`,
    name: p.name || "未知歌单",
    imageUrl: p.coverImgUrl || "",
    artwork: p.coverImgUrl || "",
    trackCount: Number(p.trackCount) || 0,
    description:
      (p.creator && p.creator.nickname ? "by " + p.creator.nickname + " · " : "") +
      (Number(p.playCount) ? "播放 " + formatCount(p.playCount) : ""),
    creator: p.creator && p.creator.nickname,
  };
}

function formatCount(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1) + "亿";
  if (v >= 10000) return (v / 10000).toFixed(1) + "万";
  return String(v);
}

/* 判定「查询词是不是某个网易云歌手」，返回歌手对象或 null。
   ⚠️ 只认**完全同名**（或带「乐队/乐团」后缀），别的都不算 ——
      搜歌名「晴天」时网易云也会返回一个叫「晴天」的小号。
   另外要求 albumSize >= 3：真歌手有唱片，山寨号/电台号是 0~1。 */
async function detectNeteaseArtist(query) {
  const q = String(query || "").trim();
  if (!q || q.length < 2) return null;
  try {
    const { text } = await fetchText(
      "https://music.163.com/api/cloudsearch/pc?s=" + encodeURIComponent(q) + "&type=100&limit=10",
      { headers: { Referer: "https://music.163.com/" } }
    );
    const r = JSON.parse(text);
    const list = (r && r.result && r.result.artists) || [];
    /* ⚠️ 繁体必须能匹配上简体：用户打「周杰倫」，网易云库里是「周杰伦」。
       内置 T2S_MAP 只有 433 个常用字，**没收「倫→伦」**，所以光靠它不够。
       这里用两级判据：
         ① 繁简转换后完全相等（最准）
         ② 字面不相等、但**字数相同、且逐字都能对上**（允许繁简差异）
       ② 的实现：把两边都拆成字数组，同位置比较 —— 相等就算命中。
       这样「周杰倫」vs「周杰伦」：2 字对 3 字，对不上，不算；
       但「周杰倫」3 字 vs「周杰伦」3 字，前两字相同、第三字繁简差异 → 算命中。
       ⚠️ 绝不能用「包含」判定：会命中「周杰伦♚」「周杰伦」这种山寨号。 */
    const qn = normTitle(toSimplified(q));
    const qRaw = normTitle(q);
    const qChars = Array.from(qRaw);
    // 简体字表里找不到对应关系的，用一个宽松的「繁简同源」判断：去掉繁简后字形仍一致的部分
    const looseEq = (a, b) => {
      const A = Array.from(a), B = Array.from(b);
      if (A.length !== B.length || !A.length) return false;
      let same = 0;
      for (let i = 0; i < A.length; i++) if (A[i] === B[i]) same++;
      // 允许 1 个字因繁简差异对不上（3 字名字里第 3 字「倫/伦」）
      return same >= A.length - 1 && same >= 2;
    };
    /* ⚠️ 同名歌手有多条（搜「李志」会同时返回真李志和「李志辉」这类同名小号，
       而网易云的排序是按热度，小号常常排在前面）。
       所以**不能取第一个**，必须遍历所有精确同名候选，选专辑数最多的那个——
       真歌手唱片多，营销号/小号只有零星几张。 */
    let best = null;
    for (const a of list) {
      const rawName = String(a.name || "").trim();
      const an = normTitle(toSimplified(rawName));
      const anRaw = normTitle(rawName);
      if (!an) continue;
      let ok = an === qn || anRaw === qRaw || looseEq(anRaw, qRaw);
      if (!ok && an.startsWith(qn)) {
        const tail = an.slice(qn.length).replace(/\s+/g, "");
        if (/^(乐队|樂隊|乐团|樂團)$/.test(tail)) ok = true;
      }
      if (!ok) continue;
      const albumSize = Number(a.albumSize) || 0;
      if (albumSize < 3) continue;   // 真歌手才有唱片
      if (!best || albumSize > best.albumSize) {
        best = { id: a.id, name: a.name, albumSize };
      }
    }
    if (best) return best;
  } catch {}
  return null;
}

/* 拉取某位歌手的**热歌目录**（网易云 /api/v1/artist/songs，order=hot）。
   ⚠️ 这是搜歌手名时的正解：关键词搜索只做召回，混着 Live/伴奏/合集/营销号视频；
      歌手目录返回的是这个人在唱片公司登记过的歌，带专辑名，干净得多。
      实测周杰伦：安静/以父之名/半岛铁盒/枫/花海/明明就 —— 全是正版。 */
async function neArtistHotSongs(artistId, maxTotal = 300) {
  /* ⚠️ 单次最多返回 200 首，而且 limit>200 会被服务端截断成 200，
     所以**必须分页拉**：offset 0/100/200/... 每次 100 首，
     直到 more=false 或到达 maxTotal。
     实测周杰伦（id=6452）musicSize=591，分页能拉全 589 首；
     只拉 limit=50 的话，他的《以父之名》《半岛铁盒》这些都被漏掉。 */
  const out = [];
  const seen = new Set();
  const PAGE = 100;
  try {
    for (let off = 0; off < maxTotal; off += PAGE) {
      const { text } = await fetchText(
        "https://music.163.com/api/v1/artist/songs?id=" + encodeURIComponent(artistId) +
        "&offset=" + off + "&limit=" + PAGE + "&order=hot",
        { headers: { Referer: "https://music.163.com/" } }
      );
      const r = JSON.parse(text);
      const songs = (r && r.songs) || [];
      if (!songs.length) break;
      for (const s of songs) {
        const sid = String(s.id || "");
        if (!sid || seen.has(sid)) continue;
        seen.add(sid);
        out.push(s);
      }
      if (!r.more) break;
      if (songs.length < PAGE) break;
    }
  } catch {}
  return out;
}

/* 拉取某位歌手的正版专辑目录（网易云 /api/artist/albums） */
async function neArtistAlbums(artistId) {
  try {
    const { text } = await fetchText(
      "https://music.163.com/api/artist/albums/" + encodeURIComponent(artistId) + "?limit=100",
      { headers: { Referer: "https://music.163.com/" } }
    );
    const r = JSON.parse(text);
    return (r && (r.hotAlbums || r.moreAlbums)) || [];
  } catch {
    return [];
  }
}

// 网易云分类搜索（4 类共用一个入口）
// type: 1=单曲 10=专辑 100=歌手 1000=歌单
async function neSearchTyped(query, type, limit = 20) {
  await jitter(120); // 打散请求时间点
  const params = new URLSearchParams({ s: query, type: String(type), limit: String(limit), offset: "0" });
  const { text } = await fetchText(NETEASE_SEARCH + "?" + params.toString(), {
    headers: { "User-Agent": uaDesktop(), Referer: "https://music.163.com/" },
  });
  const d = JSON.parse(text);
  return (d && d.result) || {};
}

/* 搜索词前缀 → 指定单一来源。
   MyGo 搜索页没有下拉框（SearchKind 是固定枚举，插件加不了自定义 tab），
   所以用前缀当作「源选择器」：

     yt:晴天 / youtube:晴天   → 只查 YouTube
     ne:晴天 / wy:晴天        → 只查网易云
     kw:晴天 / kuwo:晴天      → 只查酷我
     其它                      → 三平台聚合

   前缀只在「冒号 + 后面还有内容」时才算，避免误伤「re:从零开始」这种歌名。 */
/* 来源前缀。英文缩写和中文名都认 —— 用户手打「YouTube:晴天」和
   「yt:晴天」是同一个意思。suggest 里下发的是中文名（普通用户看不懂 yt/ne）。 */
const SOURCE_PREFIX = [
  { re: /^(?:yt|youtube|油管)\s*[:：]\s*(.+)$/i, only: "yt" },
  { re: /^(?:ne|wy|netease|wangyi|网易云|网易)\s*[:：]\s*(.+)$/i, only: "ne" },
  { re: /^(?:kw|kuwo|酷我)\s*[:：]\s*(.+)$/i, only: "kw" },
  { re: /^(?:bi|bili|bilibili|bzhan|b站|B站)\s*[:：]\s*(.+)$/i, only: "bi" },
  { re: /^(?:qq|QQ|qq音乐|QQ音乐|腾讯)\s*[:：]\s*(.+)$/i, only: "qq" },
];

function parseSourcePrefix(raw) {
  const s = String(raw || "").trim();
  for (const p of SOURCE_PREFIX) {
    const m = p.re.exec(s);
    if (m && m[1] && m[1].trim()) return { only: p.only, query: m[1].trim() };
  }
  return { only: "", query: s };
}

// ------------------------- 搜索（聚合） -------------------------
/* ============================================================
 * 搜索建议 —— 用来「选平台」
 * ------------------------------------------------------------
 * MyGo 的搜索框点建议项时会：
 *     a.query = item;  a.search(item)     // ui_suggest.go:182
 * 也就是把这段文字原样填进搜索框再立刻搜。
 * 所以我们只要下发「YouTube:晴天」这样的串，用户点一下就等于
 * 切到 YouTube 搜索了 —— 这是插件唯一能改写搜索词的地方
 * （回车是 MyGo 直接调 search()，中间没有插件钩子）。
 *
 * ⚠️ 只下发中文平台名，不要下发 yt:/ne:/bi: 这种缩写 ——
 *    普通用户看不懂，而且建议列表只有纯文本没有图标。
 * ============================================================ */
export async function suggest({ query }) {
  const q = String(query || "").trim();
  if (!q || q.length < 1) return [];

  /* 用户已经在打前缀了（「yt:xxx」「网易云:xxx」）就不要再套一层，
     否则会变成「YouTube:yt:xxx」这种鬼东西。 */
  const already = parseSourcePrefix(q);
  if (already.only) return [];

  const out = [q]; // 第一条永远是原词 = 聚合搜索
  for (const name of ["YouTube", "网易云", "B站", "酷我"]) {
    out.push(name + ":" + q);
  }
  return out;
}

const SEARCH_KINDS = ["tracks", "albums", "artists", "playlists", "shows"];

/* QQ 三类搜索（专辑/歌手/歌单）作为补充追加。
   musicu 的 SearchCgiService 匿名时常回 2001（QQ 侧限流，不是拒绝），
   所以「失败就当没有」——绝不让 QQ 的限流拖慢整个搜索。 */
async function qqSearchExtra(kind, query, limit) {
  try {
    return (await qqSearchKind(kind, query, limit)) || [];
  } catch (e) {
    trace("QQ 搜索跳过", kind + " " + String((e && e.message) || e).slice(0, 60));
    return [];
  }
}

export async function search(args) {
  const { query, kind } = args || {};
  const local = await searchLocal(args);
  const k = String(kind || "");
  /* 单曲已经有 QQ 参与混排（见 tracks 分支），shows 也不归 QQ，这里只补三类 */
  if (k !== "albums" && k !== "artists" && k !== "playlists") return local;
  if (!query || !String(query).trim()) return local;
  const extra = await qqSearchExtra(k, String(query), k === "artists" ? 3 : 5);
  if (!extra.length) return local;
  const have = new Set((local[k] || []).map((x) => String(x.id)));
  const merged = (local[k] || []).concat(extra.filter((x) => !have.has(String(x.id))));
  return { [k]: merged, more: !!local.more };
}

async function searchLocal({ query, kind, offset }) {
  /* ⚠️ kind 必须校验：以前直接把 kind 当键名塞进返回对象，
     传进来一个未知 kind 会返回 {movies: []} 这种播放器读不懂的东西
     （应用只看 tracks/albums/artists/playlists/shows），
     kind 缺失时甚至会返回 {undefined: []}。未知类型按 unsupported 报。 */
  const k = String(kind || "");
  if (!SEARCH_KINDS.includes(k)) throw fail("unsupported", "不支持的搜索类型: " + (k || "空"));
  // 每次搜索开头刷新一次关注列表（用户可能刚关注/取消）
  followedSet = followedNames();
  if (!query || !String(query).trim()) {
    return { [k]: [], more: false };
  }
  if (offset > 0) return { [k]: [], more: false };

  // 专辑
  if (kind === "albums") {
    /* 【下架歌手：一律以 YouTube 为准，不信网易】
       实测（2026-11-08）网易艺人库对下架歌手完全不可用：
         赵薇 / 脆弱少女组 / 何韵诗 / 达明一派 → 0 个同名艺人
         李志 / 那我懂你意思了 / 陈升 / 水仙斗活佛 → 只剩 albumSize=1 的空壳
       所以命中名单时跳过网易，从 YouTube 拉这个人的曲目，按 album 名聚合出专辑。 */
    /* ⚠️ YouTube 的曲目**没有专辑名字段**（只有 album.imageUrl 封面），
       所以「按专辑名聚合」走不通。改成从视频标题里解析专辑名：
       YouTube 上正版音乐常见三种写法
         「歌手 - 专辑名 - 歌曲名」
         「歌手《专辑名》歌曲名」
         「歌手 - 歌曲名 (专辑: 专辑名)」
       都解析不到就退化成「这位歌手」一张总专辑，至少比把同名小号端上来强。 */
    const dlAlb = delistedHit(query);
    if (dlAlb) {
      try {
        const ytTracks = await ytSearchMulti([
          dlAlb + " Topic",
          dlAlb,
          ...aliasesOf(dlAlb).map((a) => a + " Topic"),
        ]);
        const byAlbum = new Map();
        let fallbackCover = "";
        for (const t of ytTracks || []) {
          const title = String(t.title || "");
          // 只认「标题里确实有这个歌手」的条目
          const looksMine =
            isSameArtistStrict(t.artist || "", dlAlb) ||
            title.toLowerCase().indexOf(String(dlAlb).toLowerCase()) >= 0 ||
            aliasesOf(dlAlb).some((a) => a && title.toLowerCase().indexOf(a.toLowerCase()) >= 0);
          if (!looksMine) continue;
          if (!fallbackCover) fallbackCover = t.thumbnail || t.artwork || "";
          const an = pickAlbumNameFromTitle(title, dlAlb);
          if (!an || isCoverLikeTitle(an)) continue;
          const key = normTitle(an);
          if (!byAlbum.has(key)) {
            byAlbum.set(key, {
              id: "yta:" + encodeURIComponent(an),
              name: an,
              artists: [{ id: "yda:" + dlAlb, name: dlAlb }],
              imageUrl: t.thumbnail || t.artwork || "",
              artwork: t.thumbnail || t.artwork || "",
              trackCount: 0,
            });
          }
          byAlbum.get(key).trackCount += 1;
        }
        const albums = [...byAlbum.values()].sort((a, b) => b.trackCount - a.trackCount);
        if (albums.length) {
          console.log("[葫芦] 专辑（下架歌手→YouTube）：「" + dlAlb + "」解析出 " + albums.length + " 张");
          return { albums, more: false };
        }
        /* 一张都解析不出来（下架歌手的视频多是搬运号，命名不规范）——
           退化成「这位歌手」一张总专辑，点进去 artist() 拉全部曲目。 */
        if (ytTracks && ytTracks.length) {
          console.log("[葫芦] 专辑（下架歌手→YouTube）：标题无专辑信息，退化为总专辑");
          return {
            albums: [
              {
                id: "yda:" + dlAlb,
                name: dlAlb,
                artists: [{ id: "yda:" + dlAlb, name: dlAlb }],
                imageUrl: fallbackCover,
                artwork: fallbackCover,
                trackCount: ytTracks.length,
              },
            ],
            more: false,
          };
        }
        console.log("[葫芦] 专辑（下架歌手→YouTube）：「" + dlAlb + "」YouTube 也没结果");
      } catch (e) {
        console.log("[葫芦] YouTube 专辑失败：" + String(e.message || e).slice(0, 60));
      }
      // 完全没结果 → 只留总专辑条目（保证 UI 里歌手页能点进去）
      return {
        albums: [
          {
            id: "yda:" + dlAlb,
            name: dlAlb,
            artists: [{ id: "yda:" + dlAlb, name: dlAlb }],
            imageUrl: "",
            artwork: "",
            trackCount: 0,
          },
        ],
        more: false,
      };
    }
    /* 【歌手目录优先】判定查询词是歌手名时，直接用歌手 id 拉他的正版专辑目录。
       这是之前那版源踩出来的正解：专辑搜索按名字搜，网易云会把同名翻唱合集、
       别人的同名专辑、山寨小号全倒进来（搜「林宥嘉」30 条里大半不是他的唱片）；
       而 /api/artist/albums/<id> 返回的 34 张全是他的正版专辑，一张杂音都没有。 */
    try {
      const singer = await detectNeteaseArtist(query);
      if (singer && singer.albumSize >= 3) {
        const al = await neArtistAlbums(singer.id);
        if (al.length >= 3) {
          const albums = al.map((a) => ({
            id: `nea:${a.id}`,
            name: a.name || "",
            artists: [{ id: String(singer.id), name: singer.name }],
            imageUrl: a.picUrl || a.blurPicUrl || "",
            artwork: a.picUrl || a.blurPicUrl || "",
            released: a.publishTime ? new Date(a.publishTime).toISOString().slice(0, 10) : undefined,
            trackCount: Number(a.size) || undefined,
          }));
          for (const a of albums) {
            albumCache.set(String(a.id).slice(4), {
              name: a.name,
              artist: singer.name,
              artwork: a.imageUrl,
            });
          }
          console.log("[葫芦] 专辑：走歌手目录「" + singer.name + "」，" + albums.length + " 张");
          return { albums, more: false };
        }
      }
    } catch {}
    try {
      const rawAl = (await neSearchTyped(query, 10, 30)).albums || [];
      /* 命中下架歌手时：内地只剩「同名人」（李志 → 李志洲/李志宇/李志辉），
         真身专辑全被清掉。所以只保留「专辑名或专辑 artist 里确实写着该歌手名」的条目，
         把同名小号挡掉。非下架歌手不做这个限制（正常歌手按关键词召回即可）。 */
      const dlArtist = delistedHit(query);
      const albums = rawAl
        .map(neAlbumToAlbum)
        // 剔除翻唱命名装作专辑的条目（「Cover 歌手」「翻唱」样式）
        .filter((a) => {
          const t = String(a.name || "");
          if (isCoverLikeTitle(t)) return false;
          return true;
        })
        /* ⚠️ 下架歌手的专辑：网易把「李志」拆成了一堆同名号（李志洲 4063、
           李志辉 4047 —— 后者是佛教音乐），真身专辑几乎清空。
           而专辑的 artist 字段**恰好是可靠的**（id 明确区分），
           所以按 artist 严格判断：是这个人就留，是别人就剔。
           ⚠️ 特例：artist 字段为空（网易数据缺失）时保留，宁可留着也不错杀。 */
        .filter((a) => {
          if (!dlArtist) return true;
          const t = String(a.name || "");
          const ar = String((a.artists && a.artists[0] && a.artists[0].name) || "");
          if (!ar) return t.indexOf(dlArtist) >= 0; // 无 artist 字段：靠专辑名
          if (isSameArtistStrict(ar, dlArtist)) return true; // 就是这个人
          // 专辑名里明确「歌手名 - 专辑名」这种命名也算（"李志 - 天空之城"）
          if (t.indexOf(dlArtist + " - ") === 0 || t.indexOf(dlArtist + "－") === 0) return true;
          console.log("[葫芦] 专辑：剔除同名小号「" + t + "」(" + ar + ")");
          return false;
        })
        /* ⚠️ 不能按 artist 过滤！实测网易云专辑搜索返回的 artists 字段是**错的**：
           搜「林孥嘉」，「全世界谁倾听你」的 artist 被写成了别的人，
           「想自由」「神秘嘉宾」「残酷月光」全压成另一个名字。
           按 artist 过滤会把真专辑全部删掉（只剩 2 张）。
           专辑这一类只靠「翻唱命名」过滤就够了——搜索词本身已经是艺人名，
           网易云返回的就是跟这个人相关的专辑，再按它自己错的 artist 筛只会适得其反。 */
        ;
      for (const a of albums) {
        albumCache.set(String(a.id).slice(4), {
          name: a.name,
          artist: (a.artists && a.artists[0] && a.artists[0].name) || "",
          artwork: a.imageUrl,
        });
      }
      return { albums, more: false };
    } catch {
      return { albums: [], more: false };
    }
  }

  // 歌手
  if (kind === "artists") {
    /* ⚠️ 下架歌手不信网易艺人库：网易把它们整体清掉，偶尔残留的也是一个
       同名空壳（实测搜「李志」返回 nar:33603544，点进去没有他的歌）。
       只要命中名单，直接造 yda: 兜底条目，artist() 会从 YouTube 拉歌，
       比放一个点进去空空的网易条目强。 */
    const dlA = delistedHit(query);
    if (dlA) {
      console.log("[葫芦] 下架歌手「" + dlA + "」→ 直接造 yda: 兜底条目");
      /* 头像：用字典里官方频道已知的第一条视频缩略图。
         ⚠️ 之前写死 imageUrl: "" —— 搜索结果里 25 位下架歌手全是空白头像。
         这里用同步可取的信息（缓存过就用缓存），取不到就留空，
         由 artist() 页面加载时再补（那边会拉频道数据）。 */
      const cover = await artistThumbOf(dlA);
      return {
        artists: [{ id: "yda:" + dlA, name: dlA, imageUrl: cover, artwork: cover }],
        more: false,
      };
    }
    try {
      const rawArt = (await neSearchTyped(query, 100, 30)).artists || [];
      const artists = rawArt.map(neArtistToArtist);
      // 同名区分：像「那我懂你意思了」vs「那我懂你意思了呀」vs「Bad Sweetheart」。
      // 但编制和小名应允许（只尾夫·乐团·团队»，只能容忍右端后缀，不能是差字）。 */
      /* 【严格歌手匹配】只认 100% 同名 + 白名单变体（繁简/乐队后缀/Topic/别名表）。
         之前的宽松版允许「XX那些」「XX文工室」等后缀，结果搜「李志」放进了一堆
         李志洲、李志宇、李志清……全是同名的别人。 */
      const clean = artists.filter((x) => isSameArtistStrict(x.name, query));
      // 去重（同名同人多个 id，保留第一个）
      const seen = new Set();
      const deduped = clean.filter((x) => {
        const k = normTitle(x.name || "");
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      /* 下架歌手兜底：网易艺人库把这些人整体清掉，搜「赵薇」artists 一条不出。
         但用户要求在歌手页也能找到他们 → 构造一个 yda: 虚拟歌手条目，
         点进去 artist() 会从 YouTube 拉歌。 */
      if (!deduped.length) {
        const dl = delistedHit(query);
        if (dl) {
          console.log("[葫芦] 下架歌手「" + dl + "」网易无艺人 → 造 yda: 兜底条目");
          return { artists: [{ id: "yda:" + dl, name: dl, imageUrl: "", artwork: "" }], more: false };
        }
      }
      for (const a of deduped) {
        artistCache.set(String(a.id).slice(4), { name: a.name, artwork: a.imageUrl });
      }
      return { artists: deduped, more: false };
    } catch {
      return { artists: [], more: false };
    }
  }

  // 歌单
  if (kind === "playlists") {
    try {
      const dlArtistP = delistedHit(query);
      /* 下架歌手：歌单是「词条型」搜索，用**全部别名**多路搜才对。
         ⚠️ 实测（2026-11-08）网易搜「闪灵乐团」返回的全是无关内容
            （闪亮的乐队 / Groove Coverage / 《闪灵》电影原声 / 闪光的乐队），
            而搜「CHTHONIC」才返回真正的闪灵歌单。所以别名必须进搜索词。
         这和曲目搜索不同 —— 曲目搜英文别名会招来一堆无关英文视频，
         歌单/专辑这种词条搜索反而正是靠英文别名才找得到。 */
      let rawLists = [];
      if (dlArtistP) {
        const aliasQ = [dlArtistP, ...aliasesOf(dlArtistP)];
        const lists = await Promise.all(
          aliasQ.map((a) => neSearchTyped(a, 1000, 20).catch(() => ({ playlists: [] })))
        );
        for (const l of lists) rawLists.push(...((l && l.playlists) || []));
      } else {
        const r = await neSearchTyped(query, 1000, 20);
        rawLists = (r && r.playlists) || [];
      }
      // 去重
      const seenP = new Set();
      const uniq = [];
      for (const p of rawLists) {
        const k = String(p.id || p.name || "");
        if (seenP.has(k)) continue;
        seenP.add(k);
        uniq.push(p);
      }
      /* 下架歌手的匹配词表：原名 + 所有别名（含英文 CHTHONIC、繁体 閃靈） */
      const dlTerms = dlArtistP
        ? [dlArtistP, ...aliasesOf(dlArtistP)].map((x) => String(x).toLowerCase()).filter(Boolean)
        : [];
      const playlists = uniq
        .map(nePlaylistToPlaylist)
        /* 歌单标题里明确写「翻自/翻唱/伴奏/remix」的是改编歌单，跟要搜的原唱无关。
           但**不能一刀切**：像「赵薇经典歌曲65首」这种纯歌手名歌单必须留着，
           所以只按变体标记过滤，不按歌手名过滤。 */
        .filter((p) => !isCoverLikeTitle(p.name))
        /* 下架歌手：歌单标题必须真写着歌手名或它的别名，
           挡掉「李志洲」「闪亮的乐队」这类同名/近似噪声。 */
        .filter((p) => {
          if (!dlArtistP) return true;
          const t = String(p.name || "").toLowerCase();
          const hit = dlTerms.some((term) => t.indexOf(term) >= 0);
          if (!hit) console.log("[葫芦] 歌单：剔除无关「" + p.name + "」");
          return hit;
        });
      return { playlists, more: false };
    } catch {
      return { playlists: [], more: false };
    }
  }

  /* 播客/节目搜索：走 Apple Podcast 目录。这填补了「播客页面只能进首页那 5
     个固定节目、搜不了特定节目」的空缺。返回结构兼容 show()（MyGo 点节目卡
     会调 show(id)）。也兼容歌手搜索 —— 搜「赵薇」「李志」也能返回相关节目。 */
  if (kind === "shows") {
    try {
      let shows = await podcastSearch(query, 20);
      /* 原名搜不到 → 用别名再试（英文名/繁体名）。
         实测搜「闪灵乐团」「盘古乐队」在 Apple 播客中国区是 0 条，
         但「ChthoniC」「閃靈」可能有（海外节目常只写英文名）。
         合并去重后返回，别让用户看到空列表。 */
      if (!shows.length) {
        const dlS = delistedHit(query);
        const altTerms = dlS
          ? [dlS, ...aliasesOf(dlS)].filter((x) => x && x.toLowerCase() !== String(query).toLowerCase())
          : [];
        for (const alt of altTerms) {
          const more = await podcastSearch(alt, 10).catch(() => []);
          if (more.length) {
            console.log("[葫芦] 播客：原名无结果，改用别名「" + alt + "」拿到 " + more.length + " 条");
            shows = more;
            break;
          }
        }
      }
      return { shows, more: false };
    } catch {
      return { shows: [], more: false };
    }
  }

  if (kind !== "tracks") return { [kind]: [], more: false };

  /* 搜索词前缀可以指定只查某个平台，例如：
       yt:晴天    只查 YouTube
       ne:晴天    只查网易云
       kw:晴天    只查酷我
     不带前缀 = 三平台聚合（默认）。
     MyGo 的搜索页没法加下拉框（SearchKind 是固定枚举），这是唯一的筛选入口。 */
  const parsed = parseSourcePrefix(query);
  const q = parsed.query;
  const only = parsed.only; // "" | "yt" | "ne" | "kw"
  if (!q) return { tracks: [], more: false };
  if (only) console.log("[葫芦] 指定来源「" + only + "」搜索：" + q);

  /* 「内地下架歌手」的处理：
     这些歌手在内地平台整体被清掉，搜过去只有同名噪声（搜「李志」返回一堆
     「李志辉」）。但**不能因此把内地平台整个砍掉** —— YouTube 偶尔也会
     一条都搜不到，那时内地结果至少还能兜住。

     做法：两边都查，但命中下架歌手时
       · YouTube 结果大幅加权排前面（- Topic 官方频道优先）
       · 内地结果只在 YouTube 一条都没有时才补位
     */
  const delisted = delistedHit(q);
  if (delisted) console.log("[葫芦] 「" + q + "」命中下架歌手「" + delisted + "」→ YouTube 优先");

  const wantNe = !only || only === "ne";
  const wantKw = !only || only === "kw";
  const wantYt = !only || only === "yt";
  const wantBi = !only || only === "bi";
  const wantQq = !only || only === "qq";

  const [neTracks, kuwoRes, ytRes, biliRes, qqRes] = await Promise.all([
    (async () => {
      if (!wantNe) return [];
      /* 【歌手目录优先】搜的是歌手名时，直接拉他的热歌目录，不走关键词召回。
         关键词召回（cloudsearch）只保证「名字沾边」，会混进 Live、伴奏、
         营销号合集、综艺片段；而 /api/v1/artist/songs?order=hot 返回的是
         这个人登记在唱片公司名下的歌，带专辑名，干净得多。
         实测搜「周杰伦」：关键词召回 65 条里后 45 条全是噪声，
         歌手目录 50 条全是《安静》《以父之名》《半岛铁盒》《枫》这种正版。 */
      try {
        const singer = await detectNeteaseArtist(q);
        if (singer) {
          const hot = await neArtistHotSongs(singer.id, 600);
          if (hot.length >= 5) {
            /* 歌手目录拿到的是「这个人的全部曲目」，同一首歌会有很多版本：
               录音室版 + Live + 伴奏 + 串烧 + 综艺现场，还有跨专辑重复收录。
               这里做三件事：
                 ① 按「归一化歌名」去重，每组只留最干净的那版
                    （优先级：非 Live/伴奏/串烧 > 有专辑名 > 时长合理 > 热度高）
                 ② 丢掉纯变体（整组都是 Live/伴奏/串烧的，说明这人只有现场版，留着也没用）
                 ③ 保持原顺序（歌手目录本身按热度排，已经很合理） */
            const VARIANT_RE = /live|现场|現場|演唱会|演唱會|巡迴|巡回|tour|伴奏|纯音乐|純音樂|instrumental|karaoke|ktv|remix|dj|串烧|串燒|medley|钢琴|鋼琴|吉他|鼓|教程|翻唱|cover/i;
            const groups = new Map();   // 归一化歌名 → { best, bestScore }
            const order = [];           // 保持首次出现的顺序
            for (const s0 of hot) {
              if (isAudiobook(s0.name, (s0.artists || [])[0] && (s0.artists || [])[0].name, s0.album && s0.album.name)) continue;
              const nm = String(s0.name || "");
              if (!nm) continue;
              // 归一化：去括号后缀、去标点，用于判定「是不是同一首歌」
              const key = normTitle(nm).toLowerCase();
              if (!key) continue;
              const isVariant = VARIANT_RE.test(nm);
              const hasAlbum = !!(s0.album && s0.album.name);
              const pop = Number(s0.popularity) || 0;
              const dur = Number(s0.duration) || 0;
              let sc = 0;
              if (!isVariant) sc += 1000;
              if (hasAlbum) sc += 200;
              if (dur >= 120000 && dur <= 420000) sc += 100;
              sc += Math.min(pop, 100);
              if (!groups.has(key)) {
                groups.set(key, { best: s0, bestScore: sc });
                order.push(key);
              } else if (sc > groups.get(key).bestScore) {
                groups.set(key, { best: s0, bestScore: sc });
              }
            }
            const picked = order.map((k) => groups.get(k).best);
            console.log("[葫芦] 「" + q + "」走歌手热歌目录：" + hot.length + " 首 → 去重后 " + picked.length + " 首");
            return picked.map(neSongToTrack);
          }
        }
        // 不是歌手名（或目录拿不到）→ 退回关键词召回
        const r = await neSearchTyped(q, 1, 30);
        const songs = r.songs || [];
        return songs
          .map(neSongToTrack)
          .filter(
            (t) => !isAudiobook(t.name, t.artists && t.artists[0] && t.artists[0].name, t.album && t.album.name)
          );
      } catch {
        return [];
      }
    })(),
    wantKw ? kuwoSearch(q).catch(() => []) : Promise.resolve([]),
    (async () => {
      if (!wantYt) return [];
      /* 下架歌手：用「中文原名 + 原名 Topic + 中文别名(繁体) + 别名 Topic」多路搜。
         ⚠️⚠️ 繁体必须进搜索词！
            实测搜「赵薇」返回的全是简体标题的搬运号和新闻
            （赵薇作品被多平台下架 / 赵薇瞒了20年……），一条正经音乐都没有；
            而搜「趙薇」能出「趙薇·情深深雨濛濛」「【一直下雨的星期天】/趙薇」。
            YouTube 上这批港台老歌的标题基本都是繁体，只搜简体等于没搜。
         ⚠️ 但**纯英文别名不能进搜索词** —— 实测搜 "FragileGirls" 会返回一堆
            "Fragile Girl Defeats a Top Fighter" 这种无关英文视频，把真音源全挤掉。
            所以只挑「含中文的别名」进搜索，英文别名继续只在打分阶段认人。 */
      if (!delisted) return ytSearch(q).catch(() => []);
      const cnAliases = aliasesOf(delisted).filter(
        (a) => a && /[\u4e00-\u9fff]/.test(a) && a.toLowerCase() !== String(q).toLowerCase()
      );
      /* ⚠️⚠️ 配了 safeQuery 的歌手（如阴三儿）**不能**加 " Topic" 查询。
         实测「阴三儿 Topic」会命中「龍胆紫 - Topic」—— 那是阴三儿成员后来
         组的另一个组合，YouTube 把发行方署名挂成龍胆紫，于是拉进来 34 首
         全是《穷孩子》《Be Water》这类龍胆紫的歌，一首 IN3 的都没有。
         这类歌手一律只走 safeQuery 里那几条实测有效的词。 */
      const dq = dictOf(delisted);
      const hasSafe = !!(dq && Array.isArray(dq.safeQuery) && dq.safeQuery.length);
      const queries = hasSafe ? dq.safeQuery.slice() : [q, q + " Topic"];
      if (!hasSafe) {
        for (const a of cnAliases) {
          queries.push(a);
          queries.push(a + " Topic");
        }
      }
      /* ⚠️⚠️ A 方案：整句里如果还有「歌名部分剩下」，说明用户是在找这首歌，
         这时**不要**再补代表作 —— 否则「寻找 李志」会变成"李志全集"，
         用户要的《寻找》被埋掉。
         只有整句里除歌手名外什么都不剩（纯搜歌手）才补代表作。 */
      const songPart = String(q)
        .split(delisted).join("")
        .replace(/[\s\-_|·,，.。()（）【】\[\]「」"'"'#]/g, "");
      const pureArtist = songPart.length < 2;
      if (pureArtist) {
        const hits = hitsOf(delisted).slice(0, 3);
        for (const h of hits) {
          queries.push(delisted + " " + h);
          queries.push(h + " " + delisted);
        }
        console.log("[葫芦] 下架歌手纯搜歌手：" + delisted + " → " + queries.length + " 路（补 " + hits.length + " 首代表作）");
      } else {
        console.log("[葫芦] 下架歌手歌名优先：" + q + "（歌名部分「" + songPart + "」，不补代表作）");
      }
      /* ⭐ 纯搜歌手时的「正路」：先搜索找出他的官方频道（- Topic 频道），
         再 browse 那个频道页，直接拉他官方频道的曲目列表。
         这条路拿到的都是真歌，不会被新闻视频挤掉，也不靠代表作去猜。
         实测（2026-11-09）：赵薇 Topic 频道能拉到《舊玩具》《天使旅行箱》
         《多愛自己一些》等真歌，全是搜索结果里根本看不到的。 */
      const [searchRes, chanRes] = await Promise.all([
        ytSearchMulti(queries).catch(() => []),
        pureArtist
          ? (async () => {
              try {
                // ① 字典里有官方频道 ID → 直接用，不用猜
                const dInfo = dictOf(delisted);
                const known =
                  (dInfo && dInfo.yt) ||
                  DELISTED_CHANNELS[delisted] ||
                  DELISTED_CHANNELS[toSimplified(delisted)];
                if (known) {
                  const songs = await ytArtistSongs(known).catch(() => []);
                  if (songs.length) {
                    console.log("[葫芦] 官方频道(已登记)拉到 " + songs.length + " 首：" + known);
                    return songs;
                  }
                  console.log("[葫芦] 已登记频道拉取失败，退回搜索猜频道");
                }
                /* ⚠️⚠️ 配了 safeQuery 的歌手直接放弃「猜频道」。
                   实测阴三儿：搜「阴三儿 Topic」命中「龍胆紫 - Topic」，
                   第 ③ 步「退回出现次数最多」会选中它，然后 34 首龍胆紫的作品
                   全被当成 IN3 塞进搜索页（《穷孩子》《Be Water》《都知道》…）。
                   这类歌手只靠 safeQuery 的搜索结果，不猜频道。 */
                if (dInfo && Array.isArray(dInfo.safeQuery) && dInfo.safeQuery.length) {
                  console.log("[葫芦] " + delisted + " 配了 safeQuery，跳过猜频道");
                  return [];
                }
                // ② 没登记 → 用「歌手名 Topic」搜，靠频道名判官方
                const probe = await ytSearch(delisted + " Topic").catch(() => []);
                /* 找官方频道：优先「频道名含歌手名 + Topic」的。
                   ⚠️ 不能只按出现次数最多来选 —— 实测搜「赵薇」时，
                      出现最多的是某个搬运号（3/20），而不是官方 Topic 频道
                      （1/20）。官方 Topic 频道才是唱片公司直传的音频库。 */
                const nameByChan = new Map();
                const freq = new Map();
                for (const t of probe || []) {
                  const c = String(t.chanId || "");
                  if (!c) continue;
                  freq.set(c, (freq.get(c) || 0) + 1);
                  if (!nameByChan.has(c)) nameByChan.set(c, String(t.artist || ""));
                }
                const dl = String(delisted).toLowerCase();
                const simpDl = toSimplified(dl);
                let topChan = "";
                // ① 优先：频道名含歌手名且是 Topic 频道
                for (const [c, nm] of nameByChan) {
                  const n = String(nm).toLowerCase();
                  const isTopic = /-\s*topic\s*$/i.test(n);
                  const hasName = n.indexOf(dl) >= 0 || toSimplified(n).indexOf(simpDl) >= 0;
                  if (isTopic && hasName) { topChan = c; break; }
                }
                // ② 退一步：频道名含歌手名（非 Topic 也算，官方主频道）
                if (!topChan) {
                  for (const [c, nm] of nameByChan) {
                    const n = String(nm).toLowerCase();
                    if (n.indexOf(dl) >= 0 || toSimplified(n).indexOf(simpDl) >= 0) { topChan = c; break; }
                  }
                }
                // ③ 最后才退回"出现次数最多"
                if (!topChan) {
                  let topN = 0;
                  for (const [c, n] of freq) if (n > topN) { topN = n; topChan = c; }
                }
                if (!topChan) return [];
                const songs = await ytArtistSongs(topChan).catch(() => []);
                if (songs.length) console.log("[葫芦] 频道页拉到 " + songs.length + " 首：" + topChan);
                return songs;
              } catch (e) {
                console.log("[葫芦] 频道页拉取失败: " + ((e && e.message) || e).slice(0, 60));
                return [];
              }
            })()
          : Promise.resolve([]),
      ]);
      /* 频道页拉到的歌：标官方标记 + 补歌手名。
         ⚠️ 频道页返回的 ownerText 经常是空的（Topic 频道没填 owner），
            导致 UI 上歌手显示成「YouTube Music」。这里统一填成歌手本人。 */
      for (const t of chanRes || []) {
        t._ytArtistChan = true;
        if (!t.artist || /^youtube\s*music$/i.test(String(t.artist).trim())) t.artist = String(delisted);
      }
      return (searchRes || []).concat(chanRes || []);
    })(),
    wantBi ? biliSearch(q, 20).catch(() => []) : Promise.resolve([]),
    wantQq ? qqSearch(q, 20).catch((e) => { console.log("[葫芦] QQ 搜索失败: " + (e && e.message)); return []; }) : Promise.resolve([]),
  ]);

  // YouTube 一条都没有 → 内地结果顶上（兜底）
  const ytEmpty = !ytRes || !ytRes.length;
  const biEmpty = !biliRes || !biliRes.length;
  /* 下架歌手：只要 YouTube / B站 有一条结果，就**完全不显示**内地平台的条目。
     ⚠️ 为什么从「沉底保留」改成「直接丢掉」：
        这些人的内地平台条目里，真正的原曲几乎没有，全是
          · 别人上传的搬运（网易云把赵雷《鼓楼》标成「那我懂你意思了」）
          · 大量翻唱（zicheng 一整张 COVER 专辑）
          · 同名不同人的歌（「那我懂你意思了呀」是池鱼/划水唱的）
        沉底保留的结果是：用户往下翻能看到，点了一个歌名陌生的条目，
        播出来完全不是他要的歌 —— 体验比「什么都没有」更糟。
        所以只在 YouTube 和 B站 **都** 没结果时才让内地结果顶上。 */
  const dropMainland = !!delisted && !(ytEmpty && biEmpty);
  if (delisted && ytEmpty && biEmpty) console.log("[葫芦] YouTube/B站 都无结果，改用内地平台兜底");
  if (dropMainland) console.log("[葫芦] 下架歌手：丢弃内地平台条目（数据太脏）");

  // 三平台结果统一成 MyGo track，再去重 + 打分排序
  const pool = [];
  const seen = new Map();
  const add = (t) => {
    if (!t || !t.id || !t.name) return;
    /* 非音乐内容（访谈/新闻/八卦/红毯…）直接扔掉，不占列表位置。
       ⚠️ 用**原始标题**判断（_rawTitle）：name 已被 cleanSongTitle 洗过，
         那些「访谈」「揭秘」关键词正好被洗掉了，用 name 判会漏。 */
    if (isNotMusicTitle(String(t._rawTitle || t.name))) return;
    /* 【时长上限：超过 20 分钟的不是歌】
       实测搜「赵薇」会返回 43 分钟的《中美对标》、64 分钟的《肖建华》、
       51 分钟的《京華煙雲》纪录片 —— 标题里根本没「赵薇」两个字，
       是从内容/字幕里匹配出来的长视频，能播但完全不是歌。
       歌曲极少超过 20 分钟（古典乐/后摇长曲除外，但这个取舍值得），
       所以按 1200 秒硬卡。没有时长的条目放行（别误杀）。 */
    const durMs = Number(t.duration) || 0;
    if (durMs > 20 * 60 * 1000) return;


    // 下架歌手 + YouTube/B站 有结果 → 内地平台条目直接不要（见上面 dropMainland 的说明）
    // ⚠️ 必须包含 qq：实测搜「福禄寿乐队」「阴三儿」，QQ 仍返回 20 条内地条目，
    //    和 YouTube 结果混在一起，用户点到就是「同名但不是本人」的歌。
    if (dropMainland && (t.provider === "netease" || t.provider === "kuwo" || t.provider === "qq")) return;

    /* 定点下架曲目（歌手本人正常在售，只有几首歌被封）：
       歌名命中清单 + 歌手命中 → 打标记，打分时 YouTube/B站 加分、内地压分。
       ⚠️ 歌手字段经常残缺（B站是 UP 主名、YouTube 是频道名），
          所以「歌名命中 + 整串查询里含歌手名」也算命中。 */
    if (!t._bannedTrack) {
      const artistName = (t.artists && t.artists[0] && t.artists[0].name) || "";
      if (bannedTrackHit(t.name, artistName) || bannedTrackHit(t.name, q)) t._bannedTrack = true;
    }

    /* ⚠️ 下架歌手的网易云/酷我结果里混着大量「脏数据」——
       用户自己上传的搬运，把别人的歌标成这个歌手。
       实测搜「那我懂你意思了」，网易云返回一首《鼓楼》（赵雷的），
       artist 字段却被标成「那我懂你意思了」，专辑名也叫「鼓楼」。
       用户看到歌手名对就点了，结果播出来是《鼓楼》—— 这就是
       「音频和歌曲对不上」的真实原因。
       判据：下架歌手 + 内地平台 + 歌名跟查询词完全不沾边 → 丢掉。
       （查询词是歌手名时，正常结果应该是这个歌手的歌，歌名通常
         不会等于歌手名，所以用「专辑名==歌名」+「歌名不含查询词」
         两个条件同时成立来判定是搬运。） */
    if (delisted && (t.provider === "netease" || t.provider === "kuwo" || t.provider === "qq")) {
      const songName = String(t.name || "");
      const albumName = String((t.album && t.album.name) || "");
      const qn = normTitle(q);
      const nameInQuery = qn && (normTitle(songName).indexOf(qn) >= 0 || qn.indexOf(normTitle(songName)) >= 0);
      // 专辑名和歌名一模一样 = 典型的用户上传搬运（正规专辑很少这样）
      const selfTitled = albumName && normTitle(albumName) === normTitle(songName);
      if (selfTitled && !nameInQuery) {
        console.log("[葫芦] 丢弃疑似搬运: " + songName + " (专辑同名, 非查询词)");
        return;
      }
    }

    /* 去重键：**保留括号内容的**标题 + 歌手。
       ⚠️ 绝不能用 normTitle —— 它会把「(Live)」「(伴奏)」整段去掉，
          于是《七里香》和《七里香 (Live)》撞成同一个 key：
            · 轻则 Live 版被当成重复丢掉（用户想留着，靠长度自然排后）
            · 重则酷我的「(伴奏)」把 QQ 那条干净的原版挤掉（先到先得）
          Live/伴奏 本来就该作为**独立条目**存在，它们的标题更长，
          打分里的「带括号 -180」和「长度惩罚」会自动把它们沉到原版后面。
          这里只做「完全同名同歌手」的真去重（同一首歌在不同合辑重复收录）。
       括号统一成半角、压缩空格、忽略大小写，但不删内容。 */
    const dedupTitle = String(t.name || "")
      .replace(/[（(]/g, "(").replace(/[）)]/g, ")")
      .replace(/[【\[]/g, "[").replace(/[】\]]/g, "]")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const dedupArtist = String((t.artists && t.artists[0] && t.artists[0].name) || "").trim().toLowerCase();
    const key = dedupTitle + "|" + dedupArtist;
    /* 同一条（真的同名同歌手）出现在多个平台时，留信息最全的那个：
       有专辑名 > 有封面 > 时长有效。QQ 的元数据最准，同分时优先 QQ。 */
    const quality = (x) => {
      let sc = 0;
      if (x.album && x.album.name) sc += 20;
      if (x.album && x.album.imageUrl) sc += 10;
      else if (x.artwork) sc += 5;
      if (Number(x.duration) > 0) sc += 5;
      if (x.provider === "qq") sc += 3;
      else if (x.provider === "netease") sc += 2;
      return sc;
    };
    const prev = seen.get(key);
    if (prev) {
      if (quality(t) > quality(prev)) {
        const at = pool.indexOf(prev);
        if (at >= 0) pool.splice(at, 1);
        seen.set(key, t);
      } else {
        return; // 已有信息更全的那条，丢弃新的
      }
    } else {
      seen.set(key, t);
    }
    // 下架歌手场景：标记一下，让打分知道要严格校验歌手字段
    if (delisted) t._delisted = delisted;
    pool.push(t);
  };

  for (const t of neTracks) add({ ...t, provider: "netease" });
  for (const t of kuwoRes)
    add({
      id: `kw:${t.id}`,
      name: t.title || "未知歌曲",
      artists: t.artist ? [{ name: t.artist }] : [{ name: "未知歌手" }],
      album: t.album ? { name: t.album } : undefined,
      artwork: t.artwork || "",
      duration: t.duration || undefined,
      provider: "kuwo",
    });
  for (const t of qqRes) add({ ...t, provider: "qq" });
  for (const t of ytRes)
    add({
      id: `yt:${t.id}`,
      /* ⚠️ UI 上显示的 name 必须是**清洗后**的标题。
         以前直接把原始 YouTube 标题塞进 name，结果列表里全是
         「【HQ】赵薇 - 天使之名（附带歌词）」「发现 赵薇《京华烟云》片尾曲 标清」
         「【發現】/ 趙薇(高清修復版)」「趙薇 Vicki Zhao 千言萬語 (高音量 HQ)」
         这种画质噪声，用户在列表里根本看不出歌名是什么。
         打分仍然用 t.title（原始），因为 tier 判定要靠那些关键词。 */
      name: cleanSongTitle(t.title, t.artist || "") || t.title,
      artists: t.artist ? [{ name: t.artist }] : [{ name: "YouTube Music" }],
      artwork: t.artwork,
      duration: parseDur(t.durationText) || undefined,
      provider: "youtube",
      // 官方音乐人频道（同一 UC 大量集中）标记，打分时加权
      _ytArtistChan: t._ytArtistChan || undefined,
      _rawTitle: t.title,
    });

  /* B 站条目。
     ⚠️ 歌手字段用 UP 主名（B 站没有独立的歌手概念），
        但 UP 主经常是搬运号，所以打分时按「不可信」处理。
        标题里通常带「歌名+歌手」，靠标题识别更靠谱。 */
  for (const t of biliRes) {
    if (!t.bvid) continue; // bvid 为空的条目没有可播地址，直接不产出，避免 id 变成 "bi:"
    add({
      id: `bi:${t.bvid}`,
      name: t.title,
      artists: t.author ? [{ name: t.author }] : [{ name: "bilibili" }],
      artwork: t.pic,
      duration: parseDur(t.duration) || undefined,
      provider: "bilibili",
    });
  }

  /* 先判断这轮搜的是不是歌手名，再逐条打分。
     是歌手名 → artist 不匹配的条目大幅降权（治「同名但不同人」）。 */
  const artistSearch = isArtistSearch(q, pool);
  if (artistSearch) console.log("[葫芦] 「" + q + "」判定为歌手名搜索");

  /* ===== QQ 交叉验证：网易云标错歌手时以 QQ 为准 =====
     网易云的 artist 字段经常是错的（实测搜「林宥嘉」，专辑页 30 条里大半
     挂的是别人的名字；搜「七里香」，洪荣宏/周思洁的同名老歌占了前 5 位）。
     QQ 的字段准确得多（搜「七里香 周杰倫」第 1 条就是原版 299s，歌手字段全是周杰倫），
     所以拿 QQ 当**证人**：同一个歌名，如果 QQ 说这歌是这个歌手唱的，
     而某条网易云说不是 —— 那条大概率是翻唱/同名老歌，压下去。

     做法：按「归一化歌名」建 QQ 的歌手索引，只对**同一首歌**做比对，
     不做全局猜测（避免误伤同名不同曲）。
     只有 QQ 真的返回了这个歌名才生效，QQ 没结果就完全不影响原有排序。 */
  const qqArtistByName = new Map();  // 归一化歌名 → Set(小写歌手名)
  /* 同时统计「这次查询下每个歌手出现多少条」——
     这就是**原唱识别**的关键信号。
     实测 QQ 搜「七里香」30 条：周杰倫 占 11 条，白允y 2 条，其余各 1 条。
     出现次数碾压其他人的那位，就是这首歌的正主；
     那些只出现 1 次的，基本都是翻唱/同名老歌。
     这比「谁热度高」可靠 —— 翻唱的播放量可能更高，但正主会有一堆不同版本（Live/伴奏/不同专辑）。 */
  const qqArtistFreq = new Map();    // 小写歌手名 → 出现条数
  for (const t of qqRes) {
    const rawKey = String(t.name || "")
      .replace(/[（(]/g, "(").replace(/[）)]/g, ")")
      .replace(/[【\[]/g, "[").replace(/[】\]]/g, "]")
      .replace(/\s+/g, " ").trim().toLowerCase();
    if (!rawKey) continue;
    if (!qqArtistByName.has(rawKey)) qqArtistByName.set(rawKey, new Set());
    for (const a of t.artists || []) {
      const an = String(a.name || "").trim().toLowerCase();
      if (!an) continue;
      qqArtistByName.get(rawKey).add(an);
      qqArtistFreq.set(an, (qqArtistFreq.get(an) || 0) + 1);
    }
  }
  // 找出出现次数远超他人的「正主」（至少 3 条，且是第二名的 2 倍以上）
  let qqTopArtist = "", qqTopCount = 0;
  if (qqArtistFreq.size) {
    const sorted = [...qqArtistFreq.entries()].sort((a, b) => b[1] - a[1]);
    const [topName, topCount] = sorted[0];
    const secondCount = sorted.length > 1 ? sorted[1][1] : 0;
    if (topCount >= 3 && topCount >= secondCount * 2) {
      qqTopArtist = topName;
      qqTopCount = topCount;
      console.log("[葫芦] QQ 原唱识别：本次查询下「" + topName + "」占 " + topCount + " 条（第二名 " + secondCount + " 条）");
    }
  }
  if (qqArtistByName.size) {
    let fixed = 0;
    for (const t of pool) {
      /* ⚠️ 用**原始歌名**精确比对，不能用 normTitle ——
         「七里香」和「七里香 (伴奏)」「七里香 (Live)」归一化后全变成同一个 key，
         于是那个 key 下混着周杰倫 和白允y/梨土豆er 一堆人的名字，
         导致真正的《七里香 - 周杰倫 》判不出「正主」。
         精确比名之后，只有「同名同曲」的条目才会互相影响。 */
      const rawKey = String(t.name || "")
        .replace(/[（(]/g, "(").replace(/[）)]/g, ")")
        .replace(/[【\[]/g, "[").replace(/[】\]]/g, "]")
        .replace(/\s+/g, " ").trim().toLowerCase();
      /* ⚠️ 不做 normTitle 兜底 —— 那会把《七里香 (Live)》当成《七里香》去比对，
         用原唱的结论去判定 Live 版，两边歌手其实一致但歌名不同，会误导。 */
      const qqSet = qqArtistByName.get(rawKey);
      if (!qqSet || !qqSet.size) continue;
      const myArtist = String((t.artists && t.artists[0] && t.artists[0].name) || "").trim().toLowerCase();
      if (!myArtist) continue;
      // QQ 那边这首歌的歌手里有他 → 一致，不动
      let agree = false;
      for (const qa of qqSet) {
        if (qa === myArtist || qa.indexOf(myArtist) >= 0 || myArtist.indexOf(qa) >= 0) { agree = true; break; }
      }
      if (agree) {
        t._qqOk = true;      // 双平台一致 → 可信度最高
      } else {
        t._qqConflict = true; // 歌名相同但歌手对不上 → 疑似翻唱/同名老歌
        fixed++;
      }
      /* 是不是 QQ 认定的正主（同一查询下出现次数碾压其他歌手的那个）。
         ⚠️ 关键：**认出正主之后，其他人都要降权**，不然白允y 那种翻唱
            靠标题完全匹配（+300）照样压住正主。 */
      if (qqTopArtist) {
        if (myArtist === qqTopArtist || myArtist.indexOf(qqTopArtist) >= 0) {
          t._qqMainArtist = true;
        } else {
          t._qqNotMain = true;   // 这首歌的正主是别人 → 这条是翻唱/同名
        }
      }
    }
    if (fixed) console.log("[葫芦] QQ 交叉验证：发现 " + fixed + " 条歌手对不上的条目");
  }

  /* 搜的是歌手名 → YouTube/B站 里跟这个歌手毫无关系的条目直接丢掉。
     实测搜「周杰伦」，YouTube 会返回「GAI太狂：周杰伦不会说唱」
     「周杰倫轉發認自己是中國歌手」这种综艺/新闻剪辑，B站 返回钢琴教程、鼓谱、
     营销号合集 —— 全都不是歌，占了半屏。
     判据：标题或频道名里出现歌手名（或别名）才算数。
     ⚠️ 下架歌手例外：他们的正版 MV 标题常不带完整歌手名，一过滤就全没了。
     ⚠️ 只过滤 YouTube/B站/QQ —— 网易云那边已经走歌手目录了，
        酷我字段本来就干净。 */
  if (artistSearch && !delisted) {
    const qn = normTitle(q).toLowerCase();
    const aliases = aliasesOf(q).map((x) => String(x).toLowerCase()).filter((x) => x.length >= 2);
    const before = pool.length;
    for (let i = pool.length - 1; i >= 0; i--) {
      const t = pool[i];
      if (t.provider !== "youtube" && t.provider !== "bilibili" && t.provider !== "qq") continue;
      const hay = (String(t.name || "") + " " + (t.artists || []).map((a) => a.name || "").join(" ")).toLowerCase();
      const hit = (qn && hay.indexOf(qn) >= 0) || aliases.some((a) => hay.indexOf(a) >= 0);
      if (!hit) pool.splice(i, 1);
    }
    const cut = before - pool.length;
    if (cut > 0) console.log("[葫芦] 歌手搜索：剔掉 " + cut + " 条跟歌手无关的条目");
  }

  /* ① 歌名搜索：标题最短也要跟查询词一样长。
     比查询词还短的标题，根本对不上这歌，直接沉底。
     ⚠️ 长度要拿**归一化后**的比（去掉括号装饰）：
        「晴天（深情版）」归一化后是「晴天」，跟查询「晴天」一样长，达标；
        而搜「七里香」碰到「香」这种 1 字的，才是真对不上，沉底。 */
  if (!artistSearch) {
    const qn = normTitle(q);
    for (const t of pool) {
      const tn = normTitle(t.name || "");
      // 短于查询词 → 不是这首；等于或略长 → 达标；远超 → 靠长度惩罚自然靠后
      if (tn.length < qn.length) t._tooShort = true;
    }
  }

  /* ② 歌手搜索：统计每个艺人名出现的次数。
     同一个名字出现越频繁，越说明它就是真正要找的这个歌手
     （同名噪声、长得像的艺名出现频率低）。
     LX Music 风格：艺名出现多的在前，同频次下短的在前。 */
  if (artistSearch) {
    const freq = new Map();
    for (const t of pool) {
      const a = String(t.artists && t.artists[0] && t.artists[0].name || "");
      if (a) freq.set(a, (freq.get(a) || 0) + 1);
    }
    const maxFreq = Math.max(0, ...freq.values());
    for (const t of pool) {
      const a = String(t.artists && t.artists[0] && t.artists[0].name || "");
      const f = freq.get(a) || 1;
      t._artistFreq = f;
      // 出现次数最多 +200（真身），每档减 40，最短的艺名补一点
      t._freqScore = Math.round((f / Math.max(1, maxFreq)) * 200) - (a ? a.length : 0);
    }
  }

  for (const t of pool) t._artistSearch = artistSearch;

  /* 分段查询（歌名 + 歌手）：先认出哪段是歌名、哪段是歌手。
     认法：标题**完全等于**某段的条数最多的那段 = 歌名；另一段 = 歌手。
     实测「七里香 周杰伦」：标题正好叫「七里香」的一大把，
     标题正好叫「周杰伦」的没有 → 歌名=七里香、歌手=周杰伦。
     不先分清楚，拿整串去比标题一个都匹配不上，
     反而让「周杰伦♚」这种冒名小号的杂歌顶到最前。 */
  const qSegsRaw = String(query || "").trim().split(/\s+/).map((x) => x.trim()).filter((x) => x.length >= 2);
  if (qSegsRaw.length >= 2) {
    let bestSong = null, bestC = 0;
    /* ⚠️ 先认出「哪段是歌手名」——这是最可靠的判据，比"标题包含谁多"准得多。
       实测反例：搜「薛之谦 演员」，池子里 QQ 返回的标题大量带「薛之谦」字样，
       「标题包含哪段最多」的启发式就误判成「歌名=薛之谦、歌手=演员」，
       于是按歌名"薛之谦"去匹配（没有一条歌名叫这个）→ 歌曲匹配全失效，
       结果全变成薛之谦的其他热歌，《演员》一条都没有。
       判法：哪段能在网易艺人库里查到（且专辑数≥3），那段就是歌手，另一段是歌名。
       两段都能查到、或都查不到时，再退回原来的"标题同名计数"启发式。 */
    try {
      const segSinger = await Promise.all(
        qSegsRaw.map((seg) => detectNeteaseArtist(seg).catch(() => null))
      );
      const singerIdx = segSinger.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
      if (singerIdx.length === 1) {
        const songIdx = (singerIdx[0] + 1) % qSegsRaw.length;
        bestSong = qSegsRaw[songIdx];
        console.log("[葫芦] 分段查询：认出「" + qSegsRaw[singerIdx[0]] + "」是歌手 → 歌名取「" + bestSong + "」");
      }
    } catch {}
    if (!bestSong) {
      for (const seg of qSegsRaw) {
        const sn = normTitle(seg);
        let exactC = 0;
        for (const t of pool) if (normTitle(t.name || "") === sn) exactC++;
        if (exactC > bestC) { bestC = exactC; bestSong = seg; }
      }
    }
    if (!bestSong) {
      // 没有完全同名的，退而求其次：标题里包含哪段最多
      for (const seg of qSegsRaw) {
        const sn = normTitle(seg);
        let c = 0;
        for (const t of pool) if (normTitle(t.name || "").indexOf(sn) >= 0) c++;
        if (c > bestC) { bestC = c; bestSong = seg; }
      }
    }
    if (bestSong) {
      const songNorm = normTitle(bestSong);
      const artistSegs = qSegsRaw.filter((x) => x !== bestSong).map((x) => normForMatch(x));
      for (const t of pool) {
        t._qSong = songNorm;
        t._qArtist = artistSegs;
      }
      console.log("[葫芦] 分段查询：「" + bestSong + "」当歌名，「" + (qSegsRaw.filter((x) => x !== bestSong).join("/") || "-") + "」当歌手");
    }
  }

  /* 【排序】MyGo 的搜索页没有排序控件（实测：只有 tab + 歌曲行 + 播放栏），
     所以「按长度排序」只能在这里做完再交给 UI —— UI 显示的顺序 = 这个数组的顺序。
     
     策略：先按「相关度档位」粗排，**同一档位内按时长升序**。
     为什么不纯按时长排：纯时长会把「晴天 3 分钟的翻唱」排到「晴天 4:29 的原唱」前面，
     用户搜「晴天」第一条变成翻唱，比不排序还糟。
     档位 = score 每 100 分一档（scoreTrack 的量级是 ±420，所以档位足够细）。
     同档位内短歌在前 → 满足「按长度排序」，同时保住相关度。 */
  const scored = pool.map((t) => ({ t, score: scoreTrack(t, q) }));
  scored.sort((a, b) => {
    const ba = Math.round(a.score / 100);
    const bb = Math.round(b.score / 100);
    if (ba !== bb) return bb - ba;              // ① 相关度档位高的在前
    const da = a.t.duration || 0;
    const db = b.t.duration || 0;
    if (da > 0 && db > 0 && da !== db) return da - db; // ② 同档位内：短的在前
    if (da > 0 && db === 0) return -1;          // ③ 有时长的排在没有时长的前面
    if (da === 0 && db > 0) return 1;
    return 0;                                    // ④ 完全同级：保持原平台顺序
  });
  const tracks = scored.map((x) => x.t);

  /* ⚠️ MyGo 从 track.album.imageUrl 读封面，不是顶层的 artwork。
     把所有 track 的封面同步到 album.imageUrl（MyGo 认这个字段） */
  for (const t of tracks) sinkThumb(t);

  // 缓存元数据，供歌词（LRCLIB）反查
  // ⚠️ name 一定要用 cleanSongTitle 清洗！否则 YouTube 标题「A - B (Official MV)」
  //    带着一堆装饰词去查 LRCLIB / 网易云根本对不上，歌词永远匹配不到。
  for (const t of tracks) {
    trackMeta.set(t.id, {
      name: cleanSongTitle(t.name, (t.artists && t.artists[0] && t.artists[0].name) || ""),
      artist: cleanArtistName((t.artists && t.artists[0] && t.artists[0].name) || ""),
      duration: t.duration || 0,
      album: (t.album && t.album.name) || "",
      // 封面也存一份：like/played 要靠它给收藏和最近播放补图
      artwork: (t.album && t.album.imageUrl) || t.artwork || "",
      // YouTube 的 artist 是上传频道名，不可信（详见 scoreLrcCandidate 注释）
      artistTrusted: t.provider !== "youtube" && t.provider !== "bilibili",
    });
  }
  return { tracks, more: false };
}

// ------------------------- 歌词 -------------------------
// 曲目元数据缓存：歌词接口只给 id，LRCLIB 需要歌名+歌手+时长，搜索时先存下来
const trackMeta = new Map(); // id -> { name, artist, duration }
// 专辑/歌手元数据缓存：详情页要靠名字反查曲目（官方详情接口要登录）
const albumCache = new Map(); // id -> { name, artist, artwork }
const artistCache = new Map(); // id -> { name, artwork }

/* ============================================================
 * 歌词候选打分（照 xhongc/music-tag-web 的 match_score/match_artist 移植）
 * ------------------------------------------------------------
 * 它那套的精髓：
 *   ① 繁简不是「搜两次」，而是**双方都归一化成简体再比**
 *   ② 标题 / 歌手 / 专辑三项分别打分，再相加
 *   ③ 歌手对不上直接 -2 —— 一票否决
 *      （正好治「我是誰」配到 MP魔幻力量的同名歌）
 *   ④ 歌手字段有逗号就拆开分别比
 *
 * 返回值：
 *   matchOne   单值比较：完全相等 2 / 包含 1 / 不沾边 0
 *   scoreSong  一条候选的总分（含歌手否决），以及是否够格采用
 * ============================================================ */

/** 归一化：小写、去空白、繁→简（跟 zhconv 的 convert(x,'zh-cn') 同理） */
function normLrc(s) {
  return toSimplified(String(s || "").toLowerCase().replace(/\s+/g, ""));
}

/** 单值比较：2=完全相等 1=包含 0=无关 */
function matchOne(myValue, uValue) {
  const a = normLrc(myValue);
  const b = normLrc(uValue);
  if (!a || !b) return 0;
  if (a === b) return 2;
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return 1;
  return 0;
}

/** 歌手比较：多个歌手（逗号 / 斜杠 / &）拆开分别比，取最高分 */
function matchArtistScore(myValue, uValue) {
  const raw = String(uValue || "");
  if (!raw) return 0;
  const parts = raw.split(/[,，、\/&;；]/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return 0;
  let best = 0;
  for (const p of parts) best = Math.max(best, matchOne(myValue, p));
  return best;
}

/* 从歌名里剥掉歌手的名字，只留纯歌名。
   ⚠️ LRCLIB 的 search 不支持「歌名 歌手」的组合式查询 —— 它会拿整串字去匹配，
      返回 0 条（实测「稻香」20 条、「稻香 周杰伦」0 条）。
      而 YouTube 标题常是「歌名 歌手」格式，所以查之前必须把歌手名去掉。 */
function stripArtistFromTitle(title, artist) {
  let t = String(title || "").trim();
  const a = String(artist || "").trim();
  if (!a) return t;
  // 完整歌手名出现 → 去掉（含前后分隔符）
  if (t.toLowerCase().indexOf(a.toLowerCase()) >= 0) {
    t = t.replace(new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  } else {
    // 歌手名可能是 "A/B" 多个，逐个去
    for (const p of a.split(/[\/&、,，;；]/)) {
      const pp = p.trim();
      if (pp.length >= 2) t = t.replace(new RegExp(pp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
    }
  }
  return t.replace(/\s+/g, " ").trim();
}

/* 产出一串候选查询词，从最精确到最宽松。
   ⚠️ 为什么需要：YouTube 标题「稻香 周杰伦 (歌词版)」清洗后是
      「稻香 周杰伦」，而它的 artist 字段是频道名 GM Lyric，
      跟标题里的周杰伦对不上，剥不掉 → LRCLIB 拿整串查 → 0 条。
      所以按空格切段，从「前 1 段」到「前 N 段」逐级试，
      哪个能查出来用哪个。 */
function lrcLookupVariants(name, artist) {
  const out = [];
  const push = (x) => {
    const v = String(x || "").trim();
    if (v && v.length >= 2 && !out.includes(v)) out.push(v);
  };
  const stripped = stripArtistFromTitle(name, artist);
  push(stripped);
  // 按空格 / 分隔符切段，依次取「前 1 段」「前 2 段」…
  const segs = String(stripped || "")
    .split(/\s+/)
    .filter(Boolean);
  if (segs.length > 1) {
    // 从长到短：先试前 2 段，再试前 1 段
    for (let k = segs.length - 1; k >= 1; k--) push(segs.slice(0, k).join(" "));
  }
  push(name);
  return out;
}

/* 一条 LRCLIB 候选打分。
   ⚠️ 歌手字段要分「可信 / 不可信」两种来源：
      · 网易云 / 酷我 → artist 是平台正规歌手字段，可信，对不上就一票否决
      · YouTube      → artist 是上传频道名（GM Lyric / laba / xxx - Topic），
                       经常是随便起的名字，跟真歌手毫无关系。
                       拿它做「一票否决」会误杀正确的匹配
                       （实测：稻香 (歌词版) 频道名 GM Lyric → 歌手否决 → 歌词丢了）
                       所以 YouTube 曲目只按歌名 + 时长打分，歌手命中算加分，
                       对不上不扣分。 */
function scoreLrcCandidate(cand, meta) {
  const wantTitle = meta.name || "";
  const wantArtist = meta.artist || "";
  const wantAlbum = (meta.album && meta.album.name) || "";
  const durSec = Math.round((Number(meta.duration) || 0) / 1000);
  const trusted = meta.artistTrusted !== false; // 默认可信

  const titleScore = matchOne(wantTitle, cand.trackName || cand.name);
  let artistScore = wantArtist ? matchArtistScore(wantArtist, cand.artistName) : 0;
  const albumScore = wantAlbum ? matchOne(wantAlbum, cand.albumName) : 0;

  const candDur = Number(cand.duration) || 0;
  // 翻唱/重制版和原版时长常有十几秒差（稻香原版 223s，网易云那条 214s）
  const durClose = durSec > 0 && candDur > 0 && Math.abs(candDur - durSec) <= 15;

  /* ⚠️ 两种「歌手不可信」的情况，都不能拿歌手做否决：
     ① YouTube 曲目：artist 是上传频道名（GM Lyric / laba），跟真歌手无关
     ② 我们自己的 artist 就是脏的：搜索命中的可能是一条翻唱，
        artist 字段写着翻唱者（实测搜「稻香」第一条是网易云翻唱
        歌手 itmusicstudio，拿它去否定所有周杰伦原唱版本，
        结果一句歌词都拿不到）
     所以「标题完全相等 + 时长几乎一致」时直接放行 —— 同名同时长
     基本就是同一首歌，歌手字段是谁都不影响这是同一首的歌词。 */
  const exactEnough = titleScore === 2 && durClose;

  // 歌手一票否决：只在歌手可信、且不是「标题+时长已锁定」时生效
  if (!exactEnough && trusted && wantArtist && artistScore === 0) artistScore = -2;

  // 时长接近再加 1 分
  const durScore = durClose ? 1 : 0;

  const score = titleScore + artistScore + albumScore + durScore;
  // 歌名完全不沾边 → 直接不要；歌手被否决 + 总分不够 → 也不要
  const ok = titleScore >= 1 && (exactEnough || score >= 2);
  return { score, ok, titleScore, artistScore, exactEnough };
}

async function lrclib(id, meta) {
  if (!meta || !meta.name) return null;
  const artist = meta.artist || "";
  const durSec = Math.round((Number(meta.duration) || 0) / 1000);
  /* 查 LRCLIB 用的纯歌名：把标题里的歌手名剥掉。
     YouTube 标题「稻香 周杰伦 (歌词版)」清洗后是「稻香 周杰伦」，
     其中的歌手名要去掉，否则 LRCLIB 搜不到（组合查询返回 0 条）。 */
  const lookupName = stripArtistFromTitle(meta.name, artist) || meta.name; // 精确 get 用

  // ① 精确 get（LRCLIB 的 get 是「全字段都要对上」的严格查询，最干净）
  try {
    let url = "https://lrclib.net/api/get?track_name=" + encodeURIComponent(lookupName);
    if (artist) url += "&artist_name=" + encodeURIComponent(artist);
    if (durSec > 0) url += "&duration=" + durSec;
    const { text } = await fetchText(url, { headers: { "User-Agent": "MyGo-Zongzi/1.0" } });
    const j = JSON.parse(text);
    const lrc = j && (j.syncedLyrics || j.plainLyrics);
    if (lrc && lrc.trim()) return { lrc: j.syncedLyrics || toLrc(j.plainLyrics) };
  } catch {}

  /* ② 搜索 + 打分选优。
     ⚠️ 不能直接取 list[0]！LRCLIB 的 search 是按歌名模糊匹配，
        排第一的经常是同名但别的歌手的歌（实测「我是誰」首条是
        MP魔幻力量的，不是那我懂你意思了的）。
        要按「标题+歌手+专辑+时长」打分，歌手对不上的一票否决。 */
  try {
    /* 逐个查询词变体去搜，取打分最高的那条。
       从精确到宽松：先「周杰伦」式完整名，再逐段缩短到纯歌名。 */
    const variants = lrcLookupVariants(meta.name, artist);
    let best = null;
    for (const v of variants) {
      const url = "https://lrclib.net/api/search?track_name=" + encodeURIComponent(v);
      let list = [];
      try {
        const { text } = await fetchText(url, { headers: { "User-Agent": "MyGo-Zongzi/1.0" } });
        const arr = JSON.parse(text);
        list = (Array.isArray(arr) ? arr : []).filter((x) => x && (x.syncedLyrics || x.plainLyrics));
      } catch {
        continue;
      }
      if (!list.length) continue;
      for (const cand of list) {
        const r = scoreLrcCandidate(cand, meta);
        if (!r.ok) continue;
        if (!best || r.score > best.score) best = { cand, score: r.score };
      }
      // 已经拿到高分（标题满分 + 时长对上）就不用再放宽了
      if (best && best.score >= 3) break;
    }
    if (!best) return null;
    return { lrc: best.cand.syncedLyrics || toLrc(best.cand.plainLyrics) };
  } catch (e) {
    console.log("[葫芦] LRCLIB 搜索出错: " + (e && e.message));
  }
  return null;
}

// 纯文本歌词 → 无时间轴 LRC（MyGo 也能显示）
function toLrc(plain) {
  return String(plain || "")
    .split("\n")
    .map((line) => "[00:00.00]" + line)
    .join("\n");
}

/* 校验「网易云 id 对应的歌名」和「我们缓存的歌名」是不是同一首。
   ⚠️ 为什么需要：MyGo 有时会拿 A 歌的 id 去请求 B 歌的歌词
      （实测界面显示《爱你》，传过来的 id 却是《很爱很爱你》的），
      不校验就会把别的歌的歌词显示出来。
   返回 true 才信这个 id；拿不到歌名时保守返回 true（宁可给词也不要空）。 */
async function neIdMatchesMeta(songId, meta) {
  if (!meta || !meta.name) return true;
  try {
    const url =
      "https://music.163.com/api/v3/song/detail?c=" +
      encodeURIComponent(JSON.stringify([{ id: Number(songId) }]));
    const { text } = await fetchText(url, { headers: { Referer: "https://music.163.com/" } });
    const j = JSON.parse(text);
    const s = (j && j.songs && j.songs[0]) || null;
    if (!s || !s.name) return true;
    return sameSongName(s.name, meta.name);
  } catch {
    return true;
  }
}

/** 取网易云某首歌的歌词 */
async function neLyric(songId) {
  try {
    const url = "https://music.163.com/api/song/lyric?id=" + encodeURIComponent(songId) + "&lv=-1&tv=-1";
    const { text } = await fetchText(url, { headers: { Referer: "https://music.163.com/" } });
    const res = JSON.parse(text);
    const lrc = res && res.lrc && res.lrc.lyric;
    if (lrc && lrc.trim() && !/暂无歌词/.test(lrc) && !/純音樂|纯音乐/.test(lrc)) return lrc;
  } catch {}
  return "";
}

/** 把 YouTube 那种脏标题洗成能搜的歌名 */
function cleanSongTitle(raw, artistHint) {
  let s = String(raw || "");
  // ① 去掉括号内的装饰（全角半角都处理），但保留不含装饰词的括号（可能真是歌名一部分）
  s = s.replace(/[（(][^）)]*[）)]/g, (m) => (/MV|官方|歌词|歌詞|lyrics|Lyric|高音質|音質|HD|高清|標清|标清|版|现场|現場|Live|live/i.test(m) ? " " : m));
  // ② 去掉 【】 [] 整段
  s = s.replace(/[【\[][^】\]]*[】\]]/g, " ");
  // ③ 去掉独立的英文标记（中英混排时 \b 不生效，这里直接按词匹配）
  s = s.replace(/(Official\s*Music\s*Video|Official\s*Video|Lyric\s*Video|Music\s*Video)/gi, " ");
  s = s.replace(/(^|\s)(MV|HD|HQ|Audio|Lyrics?|Lyric)(\s|$)/gi, " ");
  s = s.replace(/(歌詞版|歌词版|動態歌詞|动态歌词|無損|无损|FLAC|高音質|音質|完整版|官方版)/gi, " ");
  s = s.replace(/\s+/g, " ").trim();
  /* ③ 「歌手【歌名】-尾巴」这种格式（官方 MV 常见）。
     实例：「周杰倫 Jay Chou【晴天 Sunny Day】-Official Music Video」→ 要拿到「晴天」。
     【】里如果含着歌名，直接取【】内容。 */
  if (artistHint) {
    const bracket = s.match(/[【\[][^】\]]{2,40}[】\]]/);
    if (bracket) {
      const inner = bracket[0].slice(1, -1).trim();
      // 【】里不能只是装饰词，也不能是歌手名本身
      const hint = String(artistHint).trim().toLowerCase();
      const low = inner.toLowerCase();
      const isDecor = /歌词|官方|mv|hd|hq|高清|完整版|无损|live|现场|現場|audio/i.test(inner);
      const isArtist = low === hint || (low.indexOf(hint) >= 0 && low.length - hint.length <= 6);
      if (!isDecor && !isArtist && inner.length >= 2) {
        // 去掉里面的英文注释（「晴天 Sunny Day」→「晴天」）
        const cn = inner.replace(/\s*[A-Za-z][A-Za-z\s'&.,!?-]*$/g, "").trim();
        if (cn.length >= 2) return cn;
        return inner;
      }
    }
  }

  /* ④ 「A - B」形式。演唱者在左、歌名在右是常见写法，但**不是绝对的**。
     实测踩过：B 站有条视频标题是「927 - 那我懂你意思了」（歌名在左），
     旧逻辑一律取右侧，拿到的是**歌手名**，于是拿「那我懂你意思了」
     去跨平台搜同曲，搜到了这个乐队的同名歌——音频就错了。
     现在：传入歌手名时，哪一侧等于歌手名就剔掉，取另一侧。 */
  /* ⚠️ 拆分隔符**之前**必须先剥掉括号内容。
     实测踩过：「赵薇-自从有了你 (Zhao Wei-Zi Cong You Le Ni)」
     括号里那个英文译名也带 `-`，直接 split 会把整串拆成
     ['赵薇','自从有了你 (Zhao Wei','Zi Cong You Le Ni)']，
     最后一段取到 `Zi Cong You Le Ni)` —— 歌名彻底丢了。
     先剥括号 → 「赵薇-自从有了你」，再拆 → ['赵薇','自从有了你']，正确。 */
  const sNoParen = s.replace(/[（(][^）)]*[）)]/g, " ").replace(/[【\[][^】\]]*[】\]]/g, " ").trim();
  const parts = sNoParen
    .split(/\s+[-–—|｜]\s+|[-–—|｜]/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    // 先看能不能用歌手名判定哪侧是歌手
    const hint = String(artistHint || "").trim().toLowerCase();
    if (hint.length >= 2) {
      const isArtist = (x) => {
        const v = String(x || "").trim().toLowerCase();
        if (!v) return false;
        if (v === hint) return true;
        // 容忍「歌手 - Topic」「歌手 Official」这种尾巴
        return v.indexOf(hint) >= 0 && v.length - hint.length <= 12;
      };
      const left = parts[0];
      const right = parts[parts.length - 1];
      if (isArtist(right) && !isArtist(left)) {
        // 右侧是歌手 → 歌名在左
        let cand = left.replace(/[（(][^）)]*[）)]/g, " ").trim();
        if (cand.length >= 2 && cand.length <= 30) s = cand;
        return s;
      }
      if (isArtist(left) && !isArtist(right)) {
        // 左侧是歌手 → 歌名在右（常规情况，下面继续走）
      }
    }
    /* 右侧优先，但右侧常还挂着尾巴注释（英文说明、括号补充之类），
       所以右侧再跑一遍去括号 + 去英文注释。 */
    let right = parts[parts.length - 1];
    right = right.replace(/[（(][^）)]*[）)]/g, " ").trim();
    // 若右侧被清空了，退回上一段
    if (right.length < 2 || right.length > 30) {
      for (let i = parts.length - 2; i >= 0; i--) {
        let c = parts[i].replace(/[（(][^）)]*[）)]/g, " ").trim();
        if (c.length >= 2 && c.length <= 30) {
          right = c;
          break;
        }
      }
    }
    if (right && right.length >= 2 && right.length <= 30) s = right;
  }
  // ⑤ 兜底：把残留的纯英文说明去掉（Mandarin/Pinyin/Eng Sub 之类）
  s = s.replace(/\b(Mandarin|Pinyin|Eng\s*Sub|Sub|Chinese|English|Translation|Translated)\b/gi, " ");
  return s.replace(/[（(][^）)]*[）)]/g, " ").replace(/\s+/g, " ").replace(/^[-–—\s]+|[-–—\s]+$/g, "").trim();
}

/** 用歌名去网易云反查歌词（YouTube/酷我的曲目靠这条路补词） */
async function neLyricBySearch(name, artist) {
  const title = cleanSongTitle(name);
  if (!title || title.length < 2) return "";

  const lc = (x) => String(x || "").toLowerCase().trim();
  const titleLc = lc(title);
  const artistLc = lc(artist);
  const titleSimp = toSimplified(title); // 繁体原名 → 简体（台湾乐队歌常是繁体，网易云要用简体搜）

  // 先试「歌名 歌手」（更准），再退回纯歌名；繁体简体各来一遍
  const queries = [];
  if (artistLc && titleLc.indexOf(artistLc) < 0) queries.push(title + " " + artist);
  queries.push(title);
  if (titleSimp !== title) {
    if (artistLc && titleSimp.indexOf(artistLc) < 0) queries.push(titleSimp + " " + artist);
    queries.push(titleSimp);
  }

  for (const q of queries) {
    try {
      const r = await neSearchTyped(q, 1, 10);
      const songs = r.songs || [];
      // 候选打分：歌名越接近越优先，歌手命中再加分
      const scored = songs
        .map((s) => {
          const sName = lc(s.name);
          if (!sName) return null;
          // 候选歌名也洗一遍（"自从有了你(Kala)" → "自从有了你"），再去比
          const sClean = lc(cleanSongTitle(s.name));
          const exact = sName === titleLc || sClean === titleLc;
          const contains =
            sName.indexOf(titleLc) >= 0 ||
            titleLc.indexOf(sName) >= 0 ||
            (sClean.length >= 2 && (sClean.indexOf(titleLc) >= 0 || titleLc.indexOf(sClean) >= 0));
          if (!exact && !contains) return null;
          let sc = exact ? 100 : 60;
          sc -= Math.abs(sName.length - titleLc.length) * 2;

          const sArtists = (s.ar || []).map((a) => lc(a.name));
          const artistHit = artistLc && sArtists.some((n) => n && (n.indexOf(artistLc) >= 0 || artistLc.indexOf(n) >= 0));
          const isCover = /cover|翻唱|翻自|翻唱版/i.test(sName);

          /* 歌手处理（照 music-tag-web 的 match_artist 一票否决思路）：
             ① 歌手对本上 → 大加分
             ② 明确标了翻唱 → 温和放过（同一首歌歌词一样，聊胜于无）
             ③ 歌手对不上、也不是翻唱 → 这是「同名但不同人的另一首歌」，
                必须重罚淘汰，否则会把别人的歌词安到这首上
                （实测「我是誰」会配到 MP魔幻力量的同名歌） */
          if (artistHit) sc += 60;
          else if (isCover) sc -= 10;
          else if (artistLc) sc -= 80;

          if (isCover) sc -= 20;
          return { s, sc };
        })
        .filter(Boolean)
        .sort((a, b) => b.sc - a.sc);

      for (const { s, sc } of scored.slice(0, 3)) {
        // 分数太低说明只是字面沾边，不是同一首
        if (sc < 40) continue;
        const lrc = await neLyric(s.id);
        // 歌词太短（<3 行）基本是空的或纯音乐标注，不要
        if (lrc && lrc.split("\n").filter((x) => x.trim() && /\[\d/.test(x)).length >= 3) return lrc;
      }
    } catch {}
  }
  return "";
}

/* ============================================================
 * 本机收藏 / 最近播放（不依赖任何平台账号）
 * ------------------------------------------------------------
 * 全部存 host.storage，跨平台统一 —— 网易云、YouTube、B站、酷我
 * 收藏的歌都进同一个「我喜欢」。
 *
 * 为什么存快照而不是只存 id：
 *   recent()/liked() 要给 MyGo 返回完整 Track（名字、封面、时长），
 *   只存 id 的话每次进页面都得拿 id 回平台查一遍，慢且可能查不到
 *   （YouTube 视频被删、B站稿件下架）。所以点喜欢/播放的当下就把
 *   整条 track 存下来，之后纯读本地。
 * ============================================================ */

const LIKED_KEY = "liked";
const RECENT_KEY = "recent";
const RECENT_MAX = 60;
const LIKED_PAGE = 50;

/** 从 storage 读一个数组，坏了就返回空 */
function readList(key) {
  try {
    const v = host.storage.get(key);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeList(key, list) {
  try {
    host.storage.set(key, list);
  } catch {}
}

/** 把 Track 压成能存的快照（去掉内部字段） */
function snapshot(t) {
  if (!t || !t.id) return null;
  return {
    id: String(t.id),
    name: t.name || "",
    artists: t.artists || [],
    album: t.album || {},
    duration: t.duration || 0,
    url: t.url || "",
    // 保留可播性字段：缓存回读后还要用它过滤 VIP
    fee: typeof t._fee === "number" ? t._fee : undefined,
    st: typeof t._st === "number" ? t._st : undefined,
    at: Date.now(),
  };
}

/** 快照还原成 MyGo 能吃的 Track */
function unsnapshot(s) {
  if (!s || !s.id) return null;
  const t = {
    id: s.id,
    name: s.name || "未知歌曲",
    artists: s.artists && s.artists.length ? s.artists : [{ name: "未知歌手" }],
    album: s.album || {},
    duration: s.duration || 0,
  };
  if (s.url) t.url = s.url;
  if (typeof s.fee === "number") t._fee = s.fee;
  if (typeof s.st === "number") t._st = s.st;
  sinkThumb(t);
  return t;
}

/* ---------------- 我喜欢 ---------------- */

export async function isLiked({ ids }) {
  const set = new Set(readList(LIKED_KEY).map((x) => x.id));
  const out = {};
  for (const id of ids || []) out[String(id)] = set.has(String(id));
  return out;
}

export async function like({ id, on }) {
  const key = String(id);
  const list = readList(LIKED_KEY);
  const at = list.findIndex((x) => x.id === key);
  if (on) {
    if (at >= 0) return; // 已经在里面
    // 从各处的元数据缓存里找这条 track
    let snap = null;
    const meta = trackMeta.get(key);
    if (meta) {
      snap = {
        id: key,
        name: meta.name || "",
        artists: meta.artist ? [{ name: meta.artist }] : [],
        album: { name: meta.album || "", imageUrl: meta.artwork || "" },
        duration: meta.duration || 0,
        at: Date.now(),
      };
    }
    // recent 里有的话直接用（信息更全）
    if (!snap) snap = readList(RECENT_KEY).find((x) => x.id === key) || null;
    if (!snap) snap = { id: key, name: "", artists: [], album: {}, duration: 0, at: Date.now() };
    list.unshift({ ...snap, at: Date.now() });
    writeList(LIKED_KEY, list);
  } else if (at >= 0) {
    list.splice(at, 1);
    writeList(LIKED_KEY, list);
  }
}

export async function liked({ offset }) {
  const list = readList(LIKED_KEY);
  const from = Math.max(0, Number(offset) || 0);
  const slice = list.slice(from, from + LIKED_PAGE);
  return {
    tracks: slice.map(unsnapshot).filter(Boolean),
    more: from + LIKED_PAGE < list.length,
  };
}

/* ---------------- 最近播放 ---------------- */

export async function played({ id }) {
  const key = String(id);
  const list = readList(RECENT_KEY);
  const at = list.findIndex((x) => x.id === key);
  let snap = at >= 0 ? list[at] : null;
  if (!snap) {
    // 先查内存缓存；没有就去平台反查一次（这才能保证录下的名字是真的）
    let meta = trackMeta.get(key);
    if (!meta || !meta.name) meta = await lookupTrackMeta(key);
    snap = {
      id: key,
      name: (meta && meta.name) || "",
      artists: meta && meta.artist ? [{ name: meta.artist }] : [],
      album: { name: (meta && meta.album) || "", imageUrl: (meta && meta.artwork) || "" },
      duration: (meta && meta.duration) || 0,
      at: 0,
    };
  }
  // 挪到最前面
  const rest = list.filter((x) => x.id !== key);
  rest.unshift({ ...snap, at: Date.now() });
  writeList(RECENT_KEY, rest.slice(0, RECENT_MAX));
}

/* ⚠️ MyGo 的 played({id}) 只传 id，不传歌名/歌手。
   如果这首歌在本次会话里没被搜索过，trackMeta 里就没有它，
   录下来的快照就是空名字 → 「继续听」全是未知歌手。
   这里在读取时补一次：只要名字是空的，就拿 id 去对应平台反查，
   查到就写回缓存（下次就不用再查）。 */
async function fillMissingMeta(snaps) {
  const need = snaps.filter((x) => x && x.id && (!x.name || !x.artists || !x.artists.length));
  if (!need.length) return;
  // 并发查，但最多 6 个—— 不能让首页卡住
  await Promise.all(
    need.slice(0, 6).map(async (x) => {
      const meta = await lookupTrackMeta(x.id);
      if (!meta) return;
      x.name = meta.name || x.name;
      x.artists = meta.artist ? [{ name: meta.artist }] : x.artists;
      if (!x.album || !x.album.imageUrl) x.album = { name: meta.album || "", imageUrl: meta.artwork || "" };
      if (!x.duration) x.duration = meta.duration || 0;
    })
  );
}

/** 拿 id 去对应平台反查一条曲目的元数据 */
async function lookupTrackMeta(id) {
  const key = String(id || "");
  const hit = trackMeta.get(key);
  if (hit && hit.name) return hit;
  try {
    const ne = /^ne:(\d+)$/.exec(key);
    if (ne) {
      const url =
        "https://music.163.com/api/v3/song/detail?c=" +
        encodeURIComponent(JSON.stringify([{ id: Number(ne[1]) }]));
      const { text } = await fetchText(url, { headers: { Referer: "https://music.163.com/" } });
      const j = JSON.parse(text);
      const s0 = (j && j.songs && j.songs[0]) || null;
      if (!s0) return null;
      const meta = {
        name: cleanSongTitle(s0.name || "", ((s0.ar || [])[0] || {}).name || ""),
        artist: cleanArtistName(((s0.ar || [])[0] || {}).name || ""),
        album: (s0.al && s0.al.name) || "",
        artwork: (s0.al && s0.al.picUrl) || "",
        duration: Number(s0.dt) || 0,
      };
      trackMeta.set(key, { ...meta, artistTrusted: true });
      return meta;
    }
    const yt = /^yt:(.+)$/.exec(key);
    if (yt) {
      // YouTube oEmbed：只需要 videoId，不需要 innertube key，很轻
      const url =
        "https://www.youtube.com/oembed?url=" +
        encodeURIComponent("https://www.youtube.com/watch?v=" + yt[1]) +
        "&format=json";
      const { text } = await fetchText(url, { headers: { "User-Agent": UA } });
      const j = JSON.parse(text);
      if (!j || !j.title) return null;
      const meta = {
        name: cleanSongTitle(j.title, j.author_name || ""),
        artist: cleanArtistName(j.author_name || ""),
        album: "",
        artwork: "https://i.ytimg.com/vi/" + yt[1] + "/sddefault.jpg",
        duration: 0, // oEmbed 不给时长
      };
      trackMeta.set(key, { ...meta, artistTrusted: false });
      return meta;
    }
    const bi = /^bi:(.+)$/.exec(key);
    if (bi) {
      const v = await biliView(bi[1]);
      if (!v) return null;
      const meta = {
        name: cleanSongTitle(v.title || "", v.owner || ""),
        artist: cleanArtistName(v.owner || ""),
        album: "",
        artwork: v.pic || "",
        duration: (Number(v.duration) || 0) * 1000,
      };
      trackMeta.set(key, { ...meta, artistTrusted: false });
      return meta;
    }
    const kw = /^kw:(\d+)$/.exec(key);
    if (kw) {
      // 酷我没有单曲详情接口，用搜索反查不可靠，只能跳过
      return null;
    }
  } catch {}
  return null;
}

export async function recent() {
  const list = readList(RECENT_KEY);
  const snaps = list.slice(0, 20);
  await fillMissingMeta(snaps);
  return snaps.map(unsnapshot).filter(Boolean);
}

/* ============================================================
 * LRC 文本 → MyGo 的 { lines } 结构
 * ------------------------------------------------------------
 * MyGo 的 lyrics 支持两种返回：
 *   { lrc: "..." }                     纯文本时间轴
 *   { lines: [{ start, end, text }] }  结构化（毫秒）
 * 后者更好：MyGo 能拿它做逐行高亮和滚动定位，不用自己解析字符串。
 *
 * ⚠️ 逐字（words）拿不到：LRCLIB 和网易云给的都是行级时间轴，
 *    没有字级时间。所以这里只给行级 lines，不给 words —— 硬编
 *    words 会让高亮错位，不如不给。
 * ============================================================ */
function lrcToLines(lrc) {
  const text = String(lrc || "");
  if (!text.trim()) return null;
  const out = [];
  // 一行里可能有多个时间戳：[00:12.34][01:20.00]歌词
  const tag = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const stamps = [];
    let m;
    tag.lastIndex = 0;
    while ((m = tag.exec(line))) {
      const min = Number(m[1]) || 0;
      const sec = Number(m[2]) || 0;
      let frac = m[3] || "0";
      if (frac.length === 1) frac = frac + "00";
      else if (frac.length === 2) frac = frac + "0";
      else frac = frac.slice(0, 3);
      stamps.push(min * 60000 + sec * 1000 + (Number(frac) || 0));
    }
    if (!stamps.length) continue;
    const body = line.replace(tag, "").trim();
    if (!body) continue;
    for (const start of stamps) out.push({ start, text: body });
  }
  if (out.length < 3) return null;
  out.sort((a, b) => a.start - b.start);
  // 补 end：下一条的 start，最后一条给个 6 秒兜底
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    out[i].end = next ? next.start : out[i].start + 6000;
  }
  return out;
}

/** 统一的歌词返回：lrc 和 lines 都给，MyGo 优先用 lines */
function lyricsOut(lrc) {
  const text = String(lrc || "");
  if (!text.trim()) return null;
  const lines = lrcToLines(text);
  return lines ? { lrc: text, lines } : { lrc: text };
}

/* ============================================================
 * 歌单收藏 / 关注歌手
 * ------------------------------------------------------------
 * 与「我喜欢」不同，这两个是**分层**的：
 *   歌曲  → liked（已有）
 *   歌单  → savePlaylist（本次）
 *   歌手  → followArtist（本次）
 *
 * 为什么不全塞进「我喜欢」：MyGo 的侧边栏就分了
 * 「我喜欢的音乐」「收藏的歌单」两个入口，混在一起会乱。
 * ============================================================ */

const SAVED_PLAYLIST_KEY = "savedPlaylists";
const FOLLOWED_ARTIST_KEY = "followedArtists";

/** 当前跟随中的歌手名集合（搜索打分时用） */
function followedNames() {
  const set = new Set();
  for (const a of readList(FOLLOWED_ARTIST_KEY)) {
    if (a && a.name) set.add(String(a.name).toLowerCase());
  }
  return set;
}

/* ---------------- 收藏的歌单 ---------------- */

/* ---------------- 自建歌单 ----------------
 * 这是这个插件最不一样的地方：一个歌单里可以同时有
 * 网易云、YouTube、B 站、酷我的歌（id 带前缀），播放时各自走各的源。
 * 别的插件只能建单一平台的歌单。
 * ------------------------------------------------------------ */
const MY_PLAYLIST_KEY = "myPlaylists";

/** 生成一个不会重的本地歌单 id */
function newPlaylistId() {
  return "mypl:" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 我的歌单列表 = 自建的 + 收藏的 */
export async function playlists() {
  /* ⚠️ 自建歌单没有 imageUrl 字段（创建时也没给），
     所以封面一直空白。改成：取歌单里第一首歌的封面。
     歌单加了歌就有图，删空了就回落兜底图。 */
  const mine = readList(MY_PLAYLIST_KEY).map((p) => {
    const tracks = p.tracks || [];
    /* 找第一首有封面的。优先用歌单快照里的图；
       快照里没图（加歌时 trackMeta 没缓存到）就去 trackMeta 现查一次。 */
    let cover = p.imageUrl || "";
    if (!cover) {
      for (const t of tracks) {
        if (!t) continue;
        const snapArt = (t.album && t.album.imageUrl) || t.artwork || "";
        if (snapArt) {
          cover = snapArt;
          break;
        }
        const m = trackMeta.get(String(t.id || ""));
        if (m && m.artwork) {
          cover = m.artwork;
          break;
        }
      }
    }
    return {
      id: p.id,
      name: p.name || "未命名歌单",
      imageUrl: cover || FALLBACK_COVER,
      description: p.description || (tracks.length ? tracks.length + " 首" : "空歌单"),
      owner: "我",
      trackCount: tracks.length,
      mine: true,
    };
  });
  const saved = readList(SAVED_PLAYLIST_KEY).map((p) => ({
    id: p.id,
    name: p.name || "未命名歌单",
    imageUrl: p.imageUrl || "",
    description: p.description || "",
    owner: p.owner || "",
    trackCount: Number(p.trackCount) || 0,
    saved: true,
  }));
  /* 【「我喜欢」置顶】
     「我的歌单」页最上面永远先放一遍自己的收藏歌 —— 收藏是最常用的入口，
     每次都要往下翻到「我喜欢的音乐」那一栏很反人类。
     id 用虚拟前缀 `fav:`，playlist() 里单独处理；不写进 storage，
     所以喜欢/取消喜欢会实时反映在这张卡片上。 */
  const favs = readList(LIKED_KEY).filter(Boolean);
  const favList = [
    {
      id: "fav:liked",
      name: "我喜欢",
      imageUrl: (favs[0] && ((favs[0].album && favs[0].album.imageUrl) || favs[0].artwork)) || FALLBACK_COVER,
      description: favs.length ? "我收藏的全部歌曲" : "还没有收藏，点心形按钮试试",
      owner: "我",
      trackCount: favs.length,
      mine: true,
    },
  ];
  return favList.concat(mine).concat(saved);
}

export async function createPlaylist({ name }) {
  /* 以前空名会静默建成「我的歌单」，同一个空名连点几次就是几个同名歌单。
     现在空名直接报错，让界面提示用户填名字。 */
  const trimmed = String(name || "").trim();
  if (!trimmed) throw fail("unavailable", "歌单名不能为空");
  const list = readList(MY_PLAYLIST_KEY);
  const pl = {
    id: newPlaylistId(),
    name: trimmed.slice(0, 60),
    tracks: [],
    at: Date.now(),
  };
  list.unshift(pl);
  writeList(MY_PLAYLIST_KEY, list);
  return { id: pl.id, name: pl.name, trackCount: 0, mine: true, tracks: [] };
}

export async function renamePlaylist({ id, name }) {
  const list = readList(MY_PLAYLIST_KEY);
  const p = list.find((x) => x.id === String(id));
  if (!p) throw fail("unavailable", "没有这个歌单");
  p.name = String(name || p.name).slice(0, 60);
  writeList(MY_PLAYLIST_KEY, list);
}

export async function deletePlaylist({ id }) {
  const list = readList(MY_PLAYLIST_KEY);
  const at = list.findIndex((x) => x.id === String(id));
  if (at < 0) throw fail("unavailable", "没有这个歌单");
  list.splice(at, 1);
  writeList(MY_PLAYLIST_KEY, list);
}

/** 往自建歌单里加歌。跨平台：id 带哪个前缀就存哪个。 */
export async function addToPlaylist({ id, trackIds }) {
  const list = readList(MY_PLAYLIST_KEY);
  const p = list.find((x) => x.id === String(id));
  if (!p) throw fail("unavailable", "只能往自建歌单里加歌");
  p.tracks = p.tracks || [];
  const have = new Set(p.tracks.map((x) => x.id));
  for (const tid of trackIds || []) {
    const key = String(tid);
    if (have.has(key)) continue;
    // 从元数据缓存里拿快照；没有就只存 id
    const meta = trackMeta.get(key);
    /* 封面兜底：trackMeta 没图时，去「我喜欢」「最近播放」里找同 id 的记录。
       这两个列表里存的是完整快照，通常带封面 —— 这样加进歌单后
       歌单卡片能拿到封面，不至于一片空白。 */
    let art = (meta && meta.artwork) || "";
    if (!art) {
      const pool = readList(LIKED_KEY).concat(readList(RECENT_KEY));
      const hit = pool.find((x) => x && String(x.id) === key);
      if (hit) art = (hit.album && hit.album.imageUrl) || hit.artwork || "";
    }
    const snap = meta
      ? {
          id: key,
          name: meta.name || "",
          artists: meta.artist ? [{ name: meta.artist }] : [],
          album: { name: meta.album || "", imageUrl: art },
          duration: meta.duration || 0,
        }
      : { id: key, name: "", artists: [], album: { imageUrl: art }, duration: 0 };
    p.tracks.push(snap);
    have.add(key);
  }
  writeList(MY_PLAYLIST_KEY, list);
}

export async function removeFromPlaylist({ id, trackIds }) {
  const list = readList(MY_PLAYLIST_KEY);
  const p = list.find((x) => x.id === String(id));
  if (!p) throw fail("unavailable", "没有这个歌单");
  const del = new Set((trackIds || []).map(String));
  p.tracks = (p.tracks || []).filter((x) => !del.has(x.id));
  writeList(MY_PLAYLIST_KEY, list);
}

export async function movePlaylistTrack({ id, from, to }) {
  const list = readList(MY_PLAYLIST_KEY);
  const p = list.find((x) => x.id === String(id));
  if (!p) throw fail("unavailable", "没有这个歌单");
  const arr = p.tracks || [];
  const a = Number(from),
    b = Number(to);
  if (a < 0 || a >= arr.length || b < 0 || b >= arr.length) return;
  const [x] = arr.splice(a, 1);
  arr.splice(b, 0, x);
  writeList(MY_PLAYLIST_KEY, list);
}

export async function savePlaylist({ id, on }) {
  const key = String(id);
  const list = readList(SAVED_PLAYLIST_KEY);
  const at = list.findIndex((x) => x.id === key);
  if (on) {
    if (at >= 0) return; // 已经收藏了
    // 拿一份完整信息存下来（之后不用再查）
    let snap = { id: key, name: "", imageUrl: "", description: "", owner: "", trackCount: 0 };
    try {
      const m = /^nep:(\d+)$/.exec(key);
      if (m) {
        const url = "https://music.163.com/api/v6/playlist/detail?id=" + encodeURIComponent(m[1]) + "&n=0";
        const { text } = await fetchText(url, { headers: { Referer: "https://music.163.com/" } });
        const d = JSON.parse(text);
        const p = (d && d.playlist) || {};
        snap = {
          id: key,
          name: String(p.name || ""),
          imageUrl: String(p.coverImgUrl || ""),
          description: String(p.description || "").slice(0, 200),
          owner: String((p.creator && p.creator.nickname) || ""),
          trackCount: Number(p.trackCount) || 0,
        };
      }
    } catch {}
    list.unshift({ ...snap, at: Date.now() });
    writeList(SAVED_PLAYLIST_KEY, list);
  } else if (at >= 0) {
    list.splice(at, 1);
    writeList(SAVED_PLAYLIST_KEY, list);
  }
}

/* ---------------- 关注的歌手 ---------------- */

export async function followArtist({ id, on }) {
  const key = String(id);
  const list = readList(FOLLOWED_ARTIST_KEY);
  const at = list.findIndex((x) => x.id === key);
  if (on) {
    if (at >= 0) return;
    let snap = { id: key, name: "", imageUrl: "" };
    try {
      const m = /^nar:(\d+)$/.exec(key);
      if (m) {
        const url = "https://music.163.com/api/artist/" + encodeURIComponent(m[1]);
        const { text } = await fetchText(url, { headers: { Referer: "https://music.163.com/" } });
        const d = JSON.parse(text);
        const a = (d && d.artist) || {};
        snap = {
          id: key,
          name: String(a.name || ""),
          imageUrl: String(a.picUrl || a.img1v1Url || ""),
        };
      }
    } catch {}
    list.unshift({ ...snap, at: Date.now() });
    writeList(FOLLOWED_ARTIST_KEY, list);
  } else if (at >= 0) {
    list.splice(at, 1);
    writeList(FOLLOWED_ARTIST_KEY, list);
  }
}

export async function lyrics({ id }) {
  const key = String(id);
  const meta = trackMeta.get(key);

  /* QQ 曲目（qq:<songmid>）—— 老接口直接给 base64 的 lrc，解出来就能用 */
  if (key.startsWith("qq:")) return qqLyricPage(key.slice(3));

  // ① 网易云曲目：直接查自己的歌词库（最快最准）
  const nem = /^ne:(\d+)$/.exec(key);
  if (nem) {
    /* ⚠️⚠️ 先校验「这个 id 对应的歌」和「播放器正在显示的歌」是不是同一首。
       实测踩过：界面显示《爱你》，传过来的 id 却是《很爱很爱你》的，
       结果歌词显示的是《后来》的词 —— 用户一眼就看出来不对。
       校验方式是拿 id 去查歌名，跟缓存里的 meta.name 比；
       对不上说明 id 串了，这时不能信这个 id，改走后面的按歌名匹配。 */
    const ok = await neIdMatchesMeta(nem[1], meta);
    if (ok) {
      const lrc = await neLyric(nem[1]);
      /* ⚠️ 不能「有词就返回」！
         实测搜「稻香」第一条是网易云翻唱（歌手 itmusicstudio），
         它自带一份只有 2 行的残词，直接返回的话，
         后面明明能匹配到周杰伦原版的完整歌词也拿不到了。
         所以歌词行数太少（<3 行）要继续往下走。 */
      if (lrc && lrc.split("\n").filter((x) => x.trim() && /\[\d/.test(x)).length >= 3)
        return lyricsOut(lrc);
    } else {
      trace("歌词 id 与歌名不符，改按歌名匹配", key + " vs " + ((meta && meta.name) || "?"));
    }
  }

  // ② LRCLIB（按歌名+歌手+时长精确匹配）
  const l = await lrclib(key, meta);
  if (l) return l.lrc ? lyricsOut(l.lrc) : l;

  // ③ 网易云搜索反查（酷我 / YouTube 的曲目靠这条路）
  //    实测：LRCLIB 对小众乐队基本没有词，网易云反而收得更全。
  if (meta && meta.name) {
    const lrc = await neLyricBySearch(meta.name, meta.artist);
    if (lrc) return lyricsOut(lrc);
  }

  /* 没有词就返回空对象：应用期望 { lrc } 或 { lines }，
     以前返回 null，反序列化后是零值，界面上仍是「暂无歌词」，
     但毕竟不是它约定的形状，给 {} 更稳。 */
  return {};
}

// ------------------------- 专辑 / 歌手 / 歌单 详情 -------------------------
/* ⚠️ 网易云的 album / artist 详情接口对未登录用户返回 code 200 但 songs/hotSongs
   是空数组（-462 要绑手机）。所以改用「搜索反查」：
     - 专辑：搜专辑名，结果里 al.id === 专辑 id 的歌就是这张专辑的曲目
     - 歌手：搜歌手名，结果里 ar 里含该歌手 id 的歌就是他的歌
   这条路不需要登录，实测能拿到完整曲目。 */

async function songsOfAlbum(albumId, albumName, artistName) {
  const kw = [albumName, artistName].filter(Boolean).join(" ");
  const r = await neSearchTyped(kw, 1, 50);
  const songs = r.songs || [];
  const hit = songs.filter((s) => String((s.al && s.al.id) || "") === String(albumId));
  return (hit.length ? hit : songs).map(neSongToTrack);
}

async function songsOfArtist(artistId, artistName) {
  const r = await neSearchTyped(artistName, 1, 50);
  const songs = r.songs || [];
  const hit = songs.filter(
    (s) => Array.isArray(s.ar) && s.ar.some((a) => String(a.id) === String(artistId))
  );
  return (hit.length ? hit : songs).map(neSongToTrack);
}

export async function album({ id }) {
  /* QQ 专辑（qqa:<albummid>） */
  const qqAlb = /^qqa:(.+)$/.exec(String(id));
  if (qqAlb) return qqAlbumPage(qqAlb[1]);
  /* 下架歌手的虚拟专辑（ydalb:<歌手名>）—— 就是该歌手「全部歌曲」。
     直接复用 artist() 的拉取逻辑，保证歌手页和专辑页看到同一份数据。 */
  if (String(id).startsWith("ydalb:")) {
    const name = String(id).slice(6);
    const a = await artist({ id: "yda:" + name });
    return {
      album: {
        id,
        name: name + " · 全部歌曲",
        artists: [{ id: "yda:" + name, name }],
        imageUrl: a.artist.imageUrl || "",
        artwork: a.artist.artwork || "",
        trackCount: a.tracks.length,
      },
      tracks: a.tracks,
    };
  }
  const m = /^nea:(\d+)$/.exec(String(id));
  if (!m) throw fail("unavailable", "无法识别的专辑");
  const albumId = m[1];
  const cached = albumCache.get(albumId);
  const name = (cached && cached.name) || "";
  const artist = (cached && cached.artist) || "";
  let tracks = [];
  try {
    tracks = await songsOfAlbum(albumId, name, artist);
  } catch {}
  remember(tracks);
  return {
    album: {
      id,
      name: name || "专辑",
      artists: artist ? [{ name: artist }] : [],
      imageUrl: (cached && cached.artwork) || "",
      artwork: (cached && cached.artwork) || "",
    },
    tracks,
  };

}
export async function artist({ id }) {
  /* QQ 歌手（qqr:<singermid>） */
  const qqSinger = /^qqr:(.+)$/.exec(String(id));
  if (qqSinger) return qqArtistPage(qqSinger[1]);
  /* 下架歌手兜底：网易艺人库里查不到（被清掉），歌手页改从 YouTube 拉歌。
     id 形如 yda:<歌手名>。 */
  if (String(id).startsWith("yda:")) {
    const name = String(id).slice(4);
    /* ⚠️ 优先走字典里登记的官方频道 —— 比搜索结果准得多。
       搜「赵薇」返回的全是新闻，靠它拉不到歌；直接 browse 官方 Topic 频道
       才有《舊玩具》《天使旅行箱》这些真作品。 */
    const dInfo = dictOf(name);
    let tracks = [];
    let coverImg = "";
    if (dInfo && dInfo.yt) {
      const rawSongs = await ytArtistSongs(dInfo.yt).catch(() => []);
      /* ⚠️ 共用频道（福禄寿 / DOUDOU）：按 only 白名单只留属于本名字的歌 */
      const songs = filterByOnly(name, rawSongs);
      tracks = songs.map((t) => ({
        id: "yt:" + t.id,
        name: t.title,
        artists: [{ name: dInfo.ytName || name }],
        artwork: t.artwork || "",
        duration: parseDur(t.durationText) || undefined,
        provider: "youtube",
      }));
      // 封面：优先用该频道视频的缩略图（有真实视觉），没有就留空由上层兜底
      if (songs.length) coverImg = songs[0].artwork || "";
    }
    // 字典里没登记频道 / 频道拉不到 → 退回搜索（含代表作多路搜）
    if (!tracks.length) {
      const raw = await ytSearchMulti([name + " Topic", name]).catch(() => []);
      const hits = hitsOf(name).slice(0, 3);
      const multi = hits.length
        ? await ytSearchMulti(hits.map((h) => name + " " + h)).catch(() => [])
        : [];
      const merged = raw.concat(multi);
      tracks = merged
        .slice(0, 60)
        .map((t) => ({
          id: "yt:" + t.id,
          name: t.title,
          artists: [{ name: t.artist || name }],
          artwork: t.artwork,
          duration: parseDur(t.durationText) || undefined,
          provider: "youtube",
        }))
        .filter((t) => t.name);
      if (!coverImg && merged.length) coverImg = merged[0].artwork || "";
    }
    remember(tracks);
    return {
      artist: { id, name, imageUrl: coverImg, artwork: coverImg },
      tracks,
      /* ⚠️ 专辑先留空数组（YouTube 频道页拿不到官方专辑结构），
         但把「全部歌曲」做成一个虚拟专辑，避免专辑页彻底空着。 */
      albums: tracks.length
        ? [
            {
              id: "ydalb:" + name,
              name: name + " · 全部歌曲",
              imageUrl: coverImg,
              artwork: coverImg,
              artists: [{ id, name }],
              trackCount: tracks.length,
            },
          ]
        : [],
    };
  }
  const m = /^nar:(\d+)$/.exec(String(id));
  if (!m) throw fail("unavailable", "无法识别的歌手");
  const artistId = m[1];
  const cached = artistCache.get(artistId);
  const name = (cached && cached.name) || "";
  let tracks = [];
  try {
    tracks = await songsOfArtist(artistId, name);
  } catch {}
  remember(tracks);
  return {
    artist: {
      id,
      name: name || "歌手",
      imageUrl: (cached && cached.artwork) || "",
      artwork: (cached && cached.artwork) || "",
    },
    tracks,
    albums: [],
  };
}

export async function playlist({ id }) {
  /* QQ 榜单（qqc:<topid>）与 QQ 歌单（qqp:<dissid>） */
  const qqChartM = /^qqc:(\d+)$/.exec(String(id));
  if (qqChartM) return qqChartPage(qqChartM[1], 0, 30);
  const qqPlM = /^qqp:(\d+)$/.exec(String(id));
  if (qqPlM) return qqPlaylistPage(qqPlM[1]);
  /* 首页分类卡片（mix:<分类>:<第几单>）。
     首页把每个分类拆成 2 张歌单卡片，点进去调这里拿那一单的歌。
     ⚠️ 不缓存成静态列表 —— 每天的内容不一样，走和首页同一条 catMix 逻辑，
        缓存 key 也是同一套，所以点进去和首页看到的完全一致。 */
  const mixM = /^mix:([a-z]+):(\d+)$/.exec(String(id));
  if (mixM) {
    const key = mixM[1];
    const idx = Number(mixM[2]) || 0;
    const c = HOME_CATS.find((x) => x.key === key);
    if (!c) throw fail("unavailable", "没有这个分类");
    /* ⚠️ 不要再跑 playableOnly —— catMix 返回的已经是过滤好的同一份数据，
       再过滤一次会把 VIP 剔掉（16 首变 10 首），卡片数量和点进去对不上。
       首页和详情页必须看到同一份东西。 */
    const tracks = await catMix(c, idx);
    remember(tracks);
    const titles = ["", "· 第二单", "· 第三单"];
    return {
      id,
      name: c.title + (titles[idx] || ""),
      imageUrl: (tracks[0] && tracks[0].album && tracks[0].album.imageUrl) || "",
      trackCount: tracks.length,
      owner: "多平台混排",
      description: "网易云 · YouTube · B站 · 酷我 · QQ 混着来",
      tracks,
    };
  }

  /* 【「我喜欢」虚拟歌单】
     由 playlists() 置顶插入，id 固定是 fav:liked。
     不存 storage 副本，每次点开都实时读收藏列表 —— 这样在别处点心形
     收藏/取消的歌曲，回到这里立刻就是最新状态。 */
  if (String(id) === "fav:liked") {
    const favs = readList(LIKED_KEY).filter(Boolean);
    const tracks = favs.map(unsnapshot).filter(Boolean);
    remember(tracks);
    return {
      id: "fav:liked",
      name: "我喜欢",
      imageUrl: (tracks[0] && ((tracks[0].album && tracks[0].album.imageUrl) || tracks[0].artwork)) || "",
      trackCount: tracks.length,
      owner: "我",
      description: tracks.length ? "我收藏的全部歌曲" : "还没有收藏，点心形按钮试试",
      tracks,
    };
  }

  /* 自建歌单先走这条（id 带 mypl: 前缀）。
     里面的歌可能从四个平台来，直接还原快照就行。 */
  const mineId = /^mypl:/.exec(String(id));
  if (mineId) {
    const p = readList(MY_PLAYLIST_KEY).find((x) => x.id === String(id));
    if (!p) throw fail("unavailable", "没有这个歌单");
    const tracks = (p.tracks || []).map(unsnapshot).filter(Boolean);
    remember(tracks);
    return {
      id: p.id,
      name: p.name || "未命名歌单",
      imageUrl: "",
      trackCount: tracks.length,
      owner: "我",
      mine: true,
      tracks,
    };
  }

  const m = /^nep:(\d+)$/.exec(String(id));
  if (!m) throw fail("unavailable", "无法识别的歌单");
  const pid = m[1];
  // 歌单详情接口不需要登录，直接可取
  const url = "https://music.163.com/api/v6/playlist/detail?id=" + encodeURIComponent(pid) + "&n=1000";
  const { text } = await fetchText(url, { headers: { Referer: "https://music.163.com/" } });
  const d = JSON.parse(text);
  const p = (d && d.playlist) || {};
  /* ⚠️ tracks 只给前 10 首，但 trackIds 是全的（144 个）。
     用 v3/song/detail 按 id 批量补全，每批 100 个。 */
  const ids = (p.trackIds || []).map((x) => String(x.id)).filter(Boolean);
  let raw = p.tracks || [];
  if (ids.length > raw.length) {
    const batch = ids.slice(0, 200);
    try {
      const c = encodeURIComponent(JSON.stringify(batch.map((id) => ({ id }))));
      const r2 = await fetchText("https://music.163.com/api/v3/song/detail?c=" + c, {
        headers: { Referer: "https://music.163.com/" },
      });
      const d2 = JSON.parse(r2.text);
      if (d2 && Array.isArray(d2.songs) && d2.songs.length) raw = d2.songs;
    } catch {}
  }
  const tracks = raw.map(neSongToTrack).filter((t) => !isAudiobook(t.name));
  remember(tracks);
  return {
    id,
    name: p.name || "歌单",
    imageUrl: p.coverImgUrl || "",
    artwork: p.coverImgUrl || "",
    trackCount: Number(p.trackCount) || tracks.length,
    description: p.description ? String(p.description).slice(0, 200) : "",
    tracks,
  };
}

/** YouTube Topic 频道名「那我懂你意思了 - Topic」→ 艺人名「那我懂你意思了」 */
function cleanArtistName(a) {
  let s = String(a || "").trim();
  if (!s) return "";
  s = s.replace(/[\s\-–—_]*[-|｜–—][\s\-–—_]*Topic\s*$/i, "");
  s = s.replace(/\s+-\s*Topic\s*$/i, "");
  s = s.replace(/- Topic$/i, "");
  return s.trim();
}

/** 把一批曲目写进歌词元数据缓存 */
function remember(tracks) {
  for (const t of tracks || []) {
    const prev = trackMeta.get(t.id);
    trackMeta.set(t.id, {
      name: cleanSongTitle(t.name, (t.artists && t.artists[0] && t.artists[0].name) || ""),
      artist: cleanArtistName((t.artists && t.artists[0] && t.artists[0].name) || ""),
      duration: t.duration || 0,
      album: (t.album && t.album.name) || "",
      // 封面也存一份：like/played 要靠它给收藏和最近播放补图
      artwork: (t.album && t.album.imageUrl) || t.artwork || "",
      // YouTube 的 artist 是上传频道名，不可信（详见 scoreLrcCandidate 注释）
      artistTrusted: t.provider !== "youtube" && t.provider !== "bilibili",
      // ⚠️ 保留已有的 audio / servedFrom：播客单集(show)先存了音频直链，
      //    这里若覆盖成普通版本会把 audio 丢掉 → stream 报「音频地址丢了」。
      audio: prev && prev.audio,
      servedFrom: prev && prev.servedFrom,
    });
  }
}

/* ⚠️ MyGo 从 track.album.imageUrl 读封面（顶层 artwork 不认）。
   把 track 的封面统一同步进 album.imageUrl。 */
/* 图床：统一放 ZONGZI-000/ZONGZI-000 仓库的「图床」目录。
   ⚠️ 中文目录要 URL 编码（图床 = %E5%9B%BE%E5%BA%8A），
      直接用中文 jsDelivr 会 404。
   ⚠️ 只能给 http(s) 绝对地址，MyGo 的图片加载器不认相对路径。 */
const IMG_BASE = "https://testingcf.jsdelivr.net/gh/ZONGZI-000/ZONGZI-000@main/%E5%9B%BE%E5%BA%8A/";

/* 兜底封面：有些歌（B 站搬运、小众翻唱）任何平台都没图，
   留空的话 MyGo 显示一个灰音符占位，很丑。 */
const FALLBACK_COVER = IMG_BASE + "zongzi-cover-fallback.jpg";

/* 播客专用兜底封面：看板娘戴耳机听播客。
   播客节目有时 RSS 不给 itunes:image、或订阅卡片缺图，
   用这张替代普通歌曲兜底图，视觉上一眼能区分「这是播客」。 */
const PODCAST_FALLBACK_COVER = IMG_BASE + "zongzi-podcast-fallback.jpg";

function sinkThumb(t) {
  if (!t) return t;
  const art = t.artwork || (t.album && t.album.imageUrl) || "";
  t.album = { ...(t.album || {}), imageUrl: art || FALLBACK_COVER };
  if (!t.artwork) t.artwork = t.album.imageUrl;
  return t;
}

// ============================================================
// ffmpeg 转码服务
// ------------------------------------------------------------
// 【为什么必须有这一层】
// MyGo 只认 mp3 / flac / ogg(OggS) / wav / m4a / aac，而且：
//   · 没有 WebM 解析器（exe 里搜不到 EBML / Matroska / OpusHead）
//   · mp4 走 parseTables，YouTube 的 ftypdash 空 stbl → "bad sample table"
// 而 YouTube 现在只给 audio/webm 和 audio/mp4(DASH)，所以**原生播不了**。
//
// 官方 mygo-music-youtube-music 插件的解法就是起 ffmpeg，用
// `-listen 1 http://127.0.0.1:port/` 把转码后的 mp3 用 HTTP 流出去，
// stream() 返回这个本地地址。这里照做。
//
// 注意：ffmpeg 必须能访问 googlevideo.com。如果系统走了代理，
// 要给它传 -http_proxy，否则会 403 / 连接失败。
// ============================================================
const SERVING = []; // 正在跑的 ffmpeg 进程

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 找一个空闲本地端口（试探式，失败也不会太久） */
function pickPort() {
  const base = 18000 + Math.floor(Math.random() * 2000) * 2;
  return base;
}

/* ⚠️⚠️ 平台名映射 —— 这是踩了很久的坑。
   MyGo 的 host.platform 来自 Go 的 runtime.GOOS，值是 **"windows"**，
   而 Node 的 process.platform 是 "win32"。我一开始按 Node 的习惯
   拼成 bin/win32-amd64/ffmpeg.exe，实际拼出来是
   bin/windows-amd64/ffmpeg —— 文件根本不在那儿，所以永远「没有可用 ffmpeg」。
   这里统一映射成 bin 目录实际用的名字。 */
function platDirName() {
  let plat = "windows",
    arch = "amd64";
  try {
    if (host && host.platform) plat = String(host.platform);
    if (host && host.arch) arch = String(host.arch);
  } catch {}
  // 目录名统一用 win32 前缀（跟之前落盘的文件对齐）
  const dirPlat = plat === "windows" || plat === "win32" ? "win32" : plat;
  // Go 的 arch: amd64 / arm64；Node 的 arch: x64 / arm64
  const dirArch = arch === "x64" || arch === "amd64" ? "amd64" : arch;
  return dirPlat + "-" + dirArch;
}

/** 是否 Windows（决定要不要 .exe 后缀、路径分隔符） */
function isWindows() {
  let plat = "windows";
  try {
    if (host && host.platform) plat = String(host.platform);
  } catch {}
  return plat === "windows" || plat === "win32";
}

/** 相对路径：bin/<plat>-<arch>/ffmpeg[.exe]（权限匹配和下载落盘用） */
function ffmpegRelPath() {
  return "bin/" + platDirName() + (isWindows() ? "/ffmpeg.exe" : "/ffmpeg");
}

/** 绝对路径：host.dir + 相对路径（spawn 用，Windows 上更稳） */
function ffmpegPath() {
  let dir = "";
  try {
    if (host && host.dir) dir = String(host.dir);
  } catch {}
  const rel = ffmpegRelPath();
  if (!dir) return rel;
  const sep = isWindows() ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + rel.replace(/\//g, sep);
}

/* ============================================================
 * ffmpeg 从哪来（设置项）
 * ------------------------------------------------------------
 * 跟蜻蜓 FM 插件同款的两个设置：
 *   · transcode   填 0 关闭转码，直接播原地址（HE-AAC / MPEG Layer II 会报错）
 *   · ffmpegPath  自定义可执行文件；留空则自动找
 * 查找顺序：
 *   1. 用户填的路径
 *   2. 插件自带 bin/<plat>-<arch>/ffmpeg（都没有才下载）
 *   3. PATH 上的 ffmpeg / ffmpeg.exe
 *   4. 常见安装位置（Homebrew / /usr/local / /usr/bin / snap / C:\ffmpeg…）
 * 每台机器只探一次，结果缓存在 FFMPEG_READY；改了设置会清掉重探。
 * ============================================================ */
function settingText(key) {
  try {
    if (host && host.setting) return String(host.setting(key) || "").trim();
  } catch {}
  return "";
}

/** 填 0 / off / 关 就关掉转码（跟 proxyMode 那套写法保持一致） */
function transcodeEnabled() {
  const v = settingText("transcode");
  if (!v) return true;
  const low = v.toLowerCase();
  return !(low === "0" || low === "off" || low === "no" || low === "false" || low === "关");
}

/** 依次尝试的可执行文件。自定义路径排第一，用户说在哪就在哪。 */
function ffmpegCandidates() {
  const out = [];
  const custom = settingText("ffmpegPath").replace(/^["']|["']$/g, "");
  if (custom) out.push(custom);
  const builtin = ffmpegPath();
  if (out.indexOf(builtin) < 0) out.push(builtin);
  const onPath = isWindows() ? "ffmpeg.exe" : "ffmpeg";
  if (out.indexOf(onPath) < 0) out.push(onPath);
  const common = isWindows()
    ? ["C:\\ffmpeg\\bin\\ffmpeg.exe", "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe"]
    : ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg", "/snap/bin/ffmpeg"];
  for (const exe of common) if (out.indexOf(exe) < 0) out.push(exe);
  return out;
}

let FFMPEG_READY = "";
/** 探一个能跑的 ffmpeg；返回路径，一个都没有就返回空串（交给 ensureFfmpeg 去下载） */
async function resolveFfmpegPath() {
  if (FFMPEG_READY) return FFMPEG_READY;
  for (const exe of ffmpegCandidates()) {
    let r;
    try {
      r = await runOnce(exe, ["-version"], 5000);
    } catch {
      r = { ok: false, out: "" };
    }
    /* ⚠️ 判据用 ok，不用「输出里有 ffmpeg version」：
       MyGo 的 host.spawn 只暴露 stderr，而这版构建把版本打到 stdout，
       按输出匹配会把好好的文件判成坏的（曾经因此每次启动重下 78MB）。 */
    if (r && r.ok) {
      trace("✓ ffmpeg 可用", exe);
      FFMPEG_READY = exe;
      return exe;
    }
  }
  trace("✗ 候选里没有能跑的 ffmpeg", ffmpegCandidates().join(" | "));
  return "";
}

/* ============================================================
 * ffmpeg 缺失时自动下载
 * ------------------------------------------------------------
 * 162MB 的 ffmpeg 不能塞进插件仓库分发给别人，所以做成：
 *   · 插件目录里已有 bin/<plat>-<arch>/ffmpeg.exe → 直接用
 *   · 没有 → 用 host.spawn 起 PowerShell / curl 下载到 bin/ 里
 *   · 下载完再起 ffmpeg 转码
 *
 * 为什么能写文件：沙箱本身没有写文件的 API，但 host.spawn 起的
 * 系统程序不受这个限制，所以用 PowerShell 的 Invoke-WebRequest 落盘。
 *
 * 下载源用 eugeneware/ffmpeg-static 的 release（78MB，比官方包小一半），
 * 按平台/架构取对应文件。
 * ============================================================ */
/* ⚠️⚠️ key 必须和 platDirName() / plugin.json 的 process 权限用同一套名字：Go 的
   host.platform + host.arch（linux + amd64、darwin + arm64）。以前这里写成
   linux-x64 / darwin-x64，而 platDirName 产出 linux-amd64 / darwin-amd64，
   查表永远 undefined —— Linux 和 macOS 上根本下不到 ffmpeg，
   而且落盘路径 bin/linux-amd64/ffmpeg 也不在权限声明的 bin/linux-x64/ffmpeg 里，
   连 spawn 都会被拒。Windows 能跑纯属 arch 恰好都叫 amd64。 */
const FFMPEG_DOWNLOAD = {
  "win32-amd64": "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-win32-x64",
  // eugeneware 的 b6.0 没有 win32-arm64 资产，只能用 x64 版：Windows 11 on ARM 会模拟执行。
  "win32-arm64": "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-win32-x64",
  "darwin-amd64": "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-darwin-x64",
  "darwin-arm64": "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-darwin-arm64",
  "linux-amd64": "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-x64",
  "linux-arm64": "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-arm64",
};

let DOWNLOAD_STATE = "idle"; // idle | downloading | ready | failed
let DOWNLOAD_FAILED_AT = 0; // 上次失败的时间，用于 30 秒后允许重试
let DOWNLOAD_PROMISE = null;

/** 下载源用的 key（跟 bin 目录命名一致：win32-amd64 / darwin-arm64 / linux-x64） */
function platArch() {
  return platDirName();
}

/** 用 spawn 跑一个短命令，等它结束，返回 {ok, out} */
function runOnce(cmd, args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = host.spawn(cmd, args);
    } catch (e) {
      // 文件不存在时 Go 侧会直接报错，这里当作「没有」处理
      resolve({ ok: false, out: String((e && e.message) || e) });
      return;
    }
    if (!proc) {
      resolve({ ok: false, out: "spawn returned nothing" });
      return;
    }
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        proc.kill && proc.kill();
      } catch {}
      resolve({ ok: false, out: "timeout" });
    }, timeoutMs);
    Promise.resolve(proc.wait())
      .then(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        let out = "";
        try {
          out = proc.errorOutput ? String(proc.errorOutput() || "") : "";
        } catch {}
        /* ⚠️⚠️ 只读 stderr 会漏掉 stdout！
           实测这个 ffmpeg 构建（eugeneware/ffmpeg-static b6.0，gyan.dev essentials）
           把 `-version` 打到 **stdout**（1427 字节），stderr 是 0 字节。
           之前这里只看 errorOutput()，于是校验永远拿到空串、
           /ffmpeg version/ 永不匹配 → ensureFfmpeg() 返回 null，
           结果明明是下载成功的 78MB 文件被判定失败，每次启动都要重下。
           现在把 stdout 一并读进来（proc.stdout 拿不到也不影响 stderr 路径）。 */
        try {
          const so = proc.stdout;
          if (so) {
            if (typeof so.read === "function") {
              const rest = so.read();
              if (rest) out += String(rest);
            }
            if (typeof so.errorOutput === "function") {
              out += String(so.errorOutput() || "");
            }
          }
        } catch {}
        /* ⚠️⚠️ very important：spawn 失败（比如可执行文件不存在）时，
           MyGo 的 proc.wait() 并不会 reject —— 它照样 resolve，
           真正的错误只留在 errorOutput() 里（形如
           「spawn D:\\...\\ffmpeg.exe ENOENT」）。
           如果这时直接 ok:true，调用方就会把「不存在的文件」当成可用的，
           于是 ensureFfmpeg() 跳过下载、直接返回一个根本不存在的路径，
           后面转码时才炸。这里显式识别「进程压根没起来」的情况。 */
        const spawnFailed =
          /ENOENT|no such file|not found|cannot find the file|不是内部或外部命令/i.test(out);
        resolve({ ok: !spawnFailed, out });
      })
      .catch(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, out: "spawn failed" });
      });
  });
}

/** 确保 ffmpeg 存在；没有就下载。返回可执行路径或 null */
async function ensureFfmpeg() {
  trace("ensureFfmpeg 入口", "state=" + DOWNLOAD_STATE + " 距上次失败=" + (DOWNLOAD_FAILED_AT ? Date.now() - DOWNLOAD_FAILED_AT + "ms" : "无"));
  if (DOWNLOAD_STATE === "ready") return ffmpegPath();
  /* ⚠️ 失败状态不要永久缓存！
     之前这里是 `if (DOWNLOAD_STATE === "failed") return null;`，
     结果一次失败之后整个进程生命周期内再也不重试 —— 即使后来
     ffmpeg 被放进去了、权限被授予了，也永远返回 null。
     现在只缓存 30 秒，之后允许重新探测。 */
  if (DOWNLOAD_STATE === "failed") {
    if (Date.now() - DOWNLOAD_FAILED_AT < 30000) return null;
    DOWNLOAD_STATE = "idle";
  }
  if (DOWNLOAD_PROMISE) return DOWNLOAD_PROMISE;

  DOWNLOAD_PROMISE = (async () => {
    const abs = ffmpegPath(); // 绝对路径，执行用
    const rel = ffmpegRelPath(); // 相对路径，下载落盘用（相对插件目录）
    const pa = platArch();
    const url = FFMPEG_DOWNLOAD[pa];
    if (!url) {
      trace("✗ 平台无下载源", pa);
      console.log("[葫芦] 当前平台没有预置的 ffmpeg 下载源: " + pa);
      DOWNLOAD_STATE = "failed";
      DOWNLOAD_FAILED_AT = Date.now();
      return null;
    }

    // 先试试现有文件能不能跑（存在且可执行就直接用）
    /* ⚠️ 这里同样不能只靠 /ffmpeg version/ 匹配：
       该构建把版本打到 stdout，而 host.spawn 只暴露 stderr，
       于是「文件明明好好的」也会被判成坏的 → 白白重下 78MB。
       判据放宽成「进程能正常跑完(ok) 就算可用」——
       spawn 失败（文件不存在/不可执行）时 runOnce 会返回 ok=false。 */
    trace("ffmpeg 探测", abs);
    const probe = await runOnce(abs, ["-version"], 8000);
    trace("ffmpeg 探测结果", "ok=" + probe.ok + " out=" + String(probe.out || "").slice(0, 100));
    /* 能跑完(ok) → 直接用。
       ⚠️ 判据不能要求「输出里有 ffmpeg version」：
          这个构建把版本信息打到 stdout，而 MyGo 的 host.spawn 封装
          只暴露 errorOutput()（stderr），真实环境拿到的就是空串，
          于是「文件明明好的」也会被判失败、每次启动重下 78MB。
       ⚠️ 也不能无条件信任 ok：spawn 找不到文件时 MyGo 的 proc.wait()
          照样 resolve。好在 runOnce 已把 ENOENT 这类错误识别成 ok=false。 */
    if (probe.ok) {
      trace("✓ 已有 ffmpeg 可用，跳过下载");
      DOWNLOAD_STATE = "ready";
      return abs;
    }

    DOWNLOAD_STATE = "downloading";
    trace("开始下载 ffmpeg", url);
    console.log("[葫芦] 首次使用，正在下载 ffmpeg（约 78MB）…");

    // 用 PowerShell 下载到插件目录（用绝对路径，避免工作目录不确定）
    const win = pa.indexOf("win32") === 0;
    const dest = win ? abs.replace(/\//g, "\\") : abs;
    let r;
    if (win) {
      const ps =
        "$ProgressPreference='SilentlyContinue';" +
        "New-Item -ItemType Directory -Force -Path (Split-Path '" + dest + "') | Out-Null;" +
        "Invoke-WebRequest -Uri '" + url + "' -OutFile '" + dest + "' -UseBasicParsing -TimeoutSec 600;" +
        "if(Test-Path '" + dest + "'){ (Get-Item '" + dest + "').Length }";
      r = await runOnce("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], 600000);
    } else {
      // macOS / Linux 用 curl
      const sh =
        "mkdir -p \"$(dirname '" + dest + "')\" && " +
        "curl -sL --max-time 600 -o '" + dest + "' '" + url + "' && chmod +x '" + dest + "' && stat -c%s '" + dest + "'";
      r = await runOnce("/bin/sh", ["-c", sh], 600000);
    }

    trace("下载结果", "ok=" + r.ok + " out=" + String(r.out || "").slice(0, 140));
    if (!r.ok) {
      console.log("[葫芦] ffmpeg 下载失败: " + String(r.out).slice(0, 160));
      DOWNLOAD_STATE = "failed";
      DOWNLOAD_FAILED_AT = Date.now();
      return null;
    }

    // 校验能跑
    /* ⚠️⚠️ 校验只能靠「能不能跑起来」，不能靠输出内容！
       实测（2026-11-10）：
         · 这个构建（eugeneware/ffmpeg-static b6.0 / gyan.dev essentials）
           把 `-version` 打到 **stdout**（1427 字节），stderr 是 0 字节
         · MyGo 的 host.spawn 封装只暴露 errorOutput()（stderr）
         · 于是校验拿到空串 → /ffmpeg version/ 永不匹配
         · 结果：下载成功的 78MB 文件被判定失败，每次启动都重下
       同理，用 PowerShell 问文件大小也拿不到值（封装不给 stdout）。

       所以判据收敛成一条：**进程能正常起来（runOnce 的 ok）**。
       文件不存在 / 不可执行时，runOnce 会从 errorOutput 里识别出
       ENOENT 并返回 ok=false，这条路径是可靠的（已实测）。 */
    const check = await runOnce(abs, ["-version"], 15000);
    trace("下载后校验", "ok=" + check.ok + " out=" + String(check.out || "").slice(0, 100));
    if (check.ok) {
      console.log("[葫芦] ffmpeg 下载完成并可用");
      DOWNLOAD_STATE = "ready";
      return abs;
    }
    console.log("[葫芦] ffmpeg 下载后无法执行: " + String(check.out).slice(0, 120));
    DOWNLOAD_STATE = "failed";
      DOWNLOAD_FAILED_AT = Date.now();
    return null;
  })();

  try {
    return await DOWNLOAD_PROMISE;
  } finally {
    DOWNLOAD_PROMISE = null;
  }
}


/* ffmpeg 不读系统代理，要显式传 -http_proxy。
   MyGo 的设置项只有文本框（没有开关控件），所以一个字段表达三态：

     留空    → 默认代理 127.0.0.1:7890
     off     → 不用代理
     其它    → 当作地址（没写协议会自动补 http://）
   兼容旧的 0 / 1 写法。 */
const DEFAULT_PROXY = "http://127.0.0.1:7890";

let PROXY_CACHE = null;
function resolveProxy() {
  let v = "";
  try {
    if (host && host.setting) v = String(host.setting("proxyMode") || "").trim();
  } catch {}

  if (!v) return DEFAULT_PROXY; // 留空 → 默认
  const low = v.toLowerCase();
  if (low === "off" || low === "0" || low === "no" || low === "false" || low === "关") return "";
  if (low === "1" || low === "on" || low === "yes" || low === "true" || low === "开") return DEFAULT_PROXY;

  // 其它值当作地址
  if (v.indexOf("://") < 0) v = "http://" + v;
  return v;
}

function proxyArg() {
  if (PROXY_CACHE === null) PROXY_CACHE = resolveProxy();
  return PROXY_CACHE ? ["-http_proxy", PROXY_CACHE] : [];
}

/* ============================================================
 * 本机默认代理（127.0.0.1:7890）到底开没开
 * ------------------------------------------------------------
 * 设置留空时按老规则默认走 127.0.0.1:7890。可一旦用户没跑 Clash，
 * ffmpeg 就拿着这个死代理去连，日志只有一句
 *   Connection refused → 进程秒退 → 转码永远「起不来」
 * 表现就是「电台播不了」，而且跟 ffmpeg 装没装完全无关。
 * 插件自己的 fetch 一直是直连的，只有 ffmpeg 被强制套代理，两边还不一致。
 * 这里给默认地址做一次性端口探测（结果缓存到进程结束）：
 * 开着就照旧用代理，没开就直连。
 * ============================================================ */
let PROXY_LIVE = null;
async function proxyPortLive() {
  if (PROXY_LIVE !== null) return PROXY_LIVE;
  try {
    await fetch("http://127.0.0.1:7890/", { signal: AbortSignal.timeout(1500) });
    PROXY_LIVE = true;   // 有 HTTP 响应（哪怕是 4xx/坏网关），说明端口有人听
  } catch (e) {
    const s = String((e && e.cause && e.cause.code) || (e && e.message) || e);
    /* 只有明确的「拒绝」或「超时」才判死：端口没人听时内核直接 RST。
       其它错误（DNS、奇怪的超时实现）保守当作有代理，免得白白丢掉用户配好的代理。 */
    PROXY_LIVE = !/ECONNREFUSED|refused|TIMEDOUT|timeout/i.test(s);
  }
  trace("默认代理探测", "7890 live=" + PROXY_LIVE);
  return PROXY_LIVE;
}

/** ffmpeg 用的代理参数：配了地址就用；留空时先确认默认端口真开着 */
async function proxyArgChecked() {
  if (PROXY_CACHE === null) PROXY_CACHE = resolveProxy();
  if (!PROXY_CACHE) return [];
  if (/127\.0\.0\.1:7890|localhost:7890/i.test(PROXY_CACHE) && !(await proxyPortLive())) {
    trace("默认代理没开，ffmpeg 直连", PROXY_CACHE);
    return [];
  }
  return ["-http_proxy", PROXY_CACHE];
}

/** 设置变了要清缓存 */
export function resetProxyCache() {
  PROXY_CACHE = null;
  try { PROXY_LIVE = null; } catch {}
}

/** MyGo 在设置项改动后会调这个（如果它调用的话），这里做兼容 */
export function setSetting({ key } = {}) {
  resetProxyCache();
  /* 改了转码开关或 ffmpeg 路径，之前探出来的结果和下载状态就作废 */
  if (!key || key === "transcode" || key === "ffmpegPath") {
    FFMPEG_READY = "";
    try {
      DOWNLOAD_STATE = "idle";
      DOWNLOAD_FAILED_AT = 0;
    } catch {}
    trace("设置变更，ffmpeg 缓存已清", String(key || "全部"));
  }
}

/**
 * 起一个 ffmpeg 转码服务，把 sourceUrl 的音频实时转成 mp3 从本地端口出去。
 * 返回可播放的本地地址；失败返回 null。
 */
async function serveWithFfmpeg(sourceUrl, userAgent, bitRate = 128, extraHeaders = null) {
  let spawn;
  try {
    spawn = host && host.spawn;
  } catch {}
  trace("serveWithFfmpeg 进入", "spawn=" + typeof spawn);
  if (typeof spawn !== "function") {
    trace("✗ 没有 host.spawn");
    console.log("[葫芦] 当前环境没有 host.spawn，跳过转码");
    return null;
  }
  /* 设置里填了 0：不转码，交给调用方回退到原地址。
     后果是 HE-AAC / MPEG Layer II / HLS 这些内容播不出来（会报 SBR 或 layer3），
     这是用户自己的选择。 */
  if (!transcodeEnabled()) {
    trace("转码已在设置里关闭", "");
    return null;
  }

  /* 拿 ffmpeg 路径。
     ⚠️ 不再依赖「先探测 -version 再决定」——那一步在真实 MyGo 里
        因为 spawn 的行为差异一直失败，导致永远判定「没有可用 ffmpeg」。
        改成：直接用路径去 spawn 转码进程，spawn 抛错（文件不存在）
        才触发下载，下载完再试一次。 */
  let exe = await resolveFfmpegPath();
  if (!exe) {
    /* 候选全跑不起来 → 走内置下载，下完再试 */
    exe = await ensureFfmpeg().catch(() => null) || "";
  }
  if (!exe) {
    trace("✗ 没有可用的 ffmpeg", "");
    console.log("[葫芦] 找不到可用的 ffmpeg：设置里填「ffmpeg 路径」，或允许插件下载");
    return null;
  }
  trace("准备用 ffmpeg", exe);

  const port = pickPort();
  const url = "http://127.0.0.1:" + port + "/";
  const args = [
    "-nostdin",
    "-hide_banner",
    "-nostats",
    /* ⚠️ 必须是 info，不能用 warning。
       "Input #0" 是 info 级别的日志，warning 级别根本不打印，
       而我们就靠它判断「ffmpeg 已经读到音频、端口已开」。
       实测 info 级别整段 stderr 只有 1347 字节，远小于 MyGo tailWriter
       的 8KB 窗口，不会被截断。 */
    "-loglevel", "info",
    // 网络抖动重连
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-rw_timeout", "15000000",
    /* ⚠️ 不要把 -request_size 写死在这儿。
      它是 ffmpeg 6.x 才有的 http 选项，实测 ffmpeg 4.4（Ubuntu 22.04 自带、
      不少发行版和用户手装的版本）会直接
        Unrecognized option 'request_size'
        Error splitting the argument list: Option not found
      然后进程秒退 → 插件报「电台流暂时连不上」，看起来像网络问题，其实是参数不兼容。
      去掉它只是让分块回到默认的 256KB，YouTube webm 照样能读，不值得为此牺牲兼容性。 */
    ...(userAgent ? ["-user_agent", userAgent] : []),
    /* 额外的请求头（B 站必须带 Referer，否则 CDN 403）。
       ffmpeg 的 -headers 要求每行以 \r\n 结尾，多个头拼成一整串。 */
    ...(extraHeaders
      ? ["-headers", Object.entries(extraHeaders).map(([k, v]) => k + ": " + v + "\r\n").join("")]
      : []),
    ...(await proxyArgChecked()),
    "-i", sourceUrl,
    "-vn",
    "-c:a", "libmp3lame",
    "-b:a", bitRate + "k",
    "-id3v2_version", "0",
    "-write_xing", "0",
    "-f", "mp3",
    "-listen", "1",
    url,
  ];

  let proc;
  try {
    proc = spawn(exe, args);
    trace("ffmpeg 已启动", "pid=" + (proc && proc.pid));
  } catch (e) {
    const msg = String((e && e.message) || e);
    trace("✗ ffmpeg spawn 抛错", msg.slice(0, 120));
    console.log("[葫芦] ffmpeg 启动失败: " + msg);
    /* 这个路径跑不起来：清掉缓存，重新探一遍（用户可能刚改了设置），
       实在没有就触发下载，下完再试一次 */
    FFMPEG_READY = "";
    try {
      const again = await resolveFfmpegPath();
      if (again && again !== exe) {
        exe = again;
        proc = spawn(exe, args);
        trace("ffmpeg 换路径后启动", exe + " pid=" + (proc && proc.pid));
      }
    } catch {}
    if (proc) {
      try { if (proc.closeStdin) proc.closeStdin(); } catch {}
    } else try {
      const dl = await ensureFfmpeg();
      if (dl && dl !== exe) {
        exe = dl;
        proc = spawn(exe, args);
        trace("ffmpeg 下载后启动", "pid=" + (proc && proc.pid));
      }
    } catch (e2) {
      trace("✗ 下载后仍失败", String((e2 && e2.message) || e2).slice(0, 120));
    }
    if (!proc) return null;
  }
  try {
    if (proc.closeStdin) proc.closeStdin();
  } catch {}

  SERVING.push(proc);
  let stopped = false;
  // 90 秒还没开始服务就放弃（慢网下 ffmpeg 拉流确实要等）
  const timer = setTimeout(() => {
    try {
      if (proc.kill) proc.kill();
    } catch {}
  }, 90000);

  try {
    proc.wait().then(() => {
      stopped = true;
      clearTimeout(timer);
      const at = SERVING.indexOf(proc);
      if (at >= 0) SERVING.splice(at, 1);
    });
  } catch {}

  /* 就绪判断：等 stderr 里出现 "Input #0"。
     ⚠️⚠️ 千万不能用 fetch 去探端口！ffmpeg 的 -listen 1 只接受**一次**连接，
        探一下就把这次连接用掉了，MyGo 再去拉就是
        "Error closing file: Error number -10054"（实测踩过）。

     ⚠️ 另一个坑：MyGo 的 errorOutput() 只保留 stderr 最后 8KB（tailWriter）。
        所以 loglevel 必须是 warning —— info 级别会打一堆元数据行，
        把 "Input #0" 挤出窗口，导致永远等不到。
        warning 级别下 stderr 基本为空，8KB 足够装下那一行。 */
  const errText = () => {
    try {
      return proc.errorOutput ? String(proc.errorOutput() || "") : "";
    } catch {
      return "";
    }
  };

  // ffmpeg 打印 "Input #0" 时端口就已经开好了，再等一小会儿让 listen 起来
  const until = Date.now() + 30000;
  let sawInput = false;
  while (Date.now() < until) {
    if (errText().indexOf("Input #0") >= 0) {
      sawInput = true;
      break;
    }
    if (stopped) {
      const tail = errText().trim().split("\n").filter(Boolean).pop() || "";
      console.log("[葫芦] ffmpeg 提前退出: " + tail.slice(0, 160));
      return null;
    }
    await sleep(50);
  }

  if (!sawInput) {
    try {
      if (proc.kill) proc.kill();
    } catch {}
    const tail = errText().trim().split("\n").filter(Boolean).pop() || "";
    trace("✗ ffmpeg 30s 无 Input#0", tail || "(stderr 空)");
    console.log("[葫芦] ffmpeg 30 秒内没读到输入" + (tail ? "：" + tail.slice(0, 140) : ""));
    return null;
  }

  await sleep(250); // 让 -listen 把端口监听起来
  trace("✓ ffmpeg 就绪", url);
  console.log("[葫芦] ffmpeg 转码就绪：" + url);
  return { url, port };
}

/** 插件卸载/切换时，把还活着的 ffmpeg 都收掉 */
export function stopServing() {
  for (const p of SERVING.slice()) {
    try {
      if (p.kill) p.kill();
    } catch {}
  }
  SERVING.length = 0;
}

// ------------------------- 播放（跨平台兜底） -------------------------
/** 逐个候选验格式，返回第一个能播的；全不兼容返回 null（交给上层兜底） */
async function pickPlayable(candidates) {
  for (const c of candidates) {
    if (!c || !c.url) continue;
    const d = await checkAudioUrl(c.url);
    if (d.ok) return c;
    console.log("[葫芦] 跳过不兼容音频(" + d.why + ")：" + String(c.url).slice(0, 60));
  }
  return null;
}

/** 某条 YouTube 视频播不了时，用同曲元数据再搜，换别的上传版本 */
async function retryOtherYoutubeUpload(currentId, err) {
  const meta = trackMeta.get(String(currentId));
  if (!meta || !meta.name) return null;
  try {
    // 去掉标题里的装饰词再搜，命中率更高
    const clean = String(meta.name)
      .replace(/[【\[][^】\]]*[】\]]/g, " ")
      .replace(/(歌词版|lyrics?|官方MV|Official\s*Music\s*Video|無損|无损|FLAC|HD|高清)/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const kw = meta.artist && clean.indexOf(meta.artist) < 0 ? clean + " " + meta.artist : clean;
    const list = await ytSearch(kw);
    if (!list || !list.length) return null;

    /* ⚠️ 换源必须严格校验，否则会换到毫不相干的视频。
       实测踩过：给「李志—下雨」换源，搜出来第一条是「#张新成 #张子枫 疯批CP」，
       能播但完全是别的东西。用户听到的是噪声，比报错还糟。

       校验规则：
         ① 候选标题必须包含原歌名的核心片段（取最长的那段中文/英文词）
         ② 或者歌手名必须出现在标题/频道里
       两条都不满足就跳过。 */
    const coreSegs = String(meta.name)
      .split(/[—–\-\|丨\/、，,：:（）()【】\[\]【】\s]+/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 2)
      .sort((a, b) => b.length - a.length);
    const core = coreSegs[0] || clean;
    const artistLc = String(meta.artist || "").toLowerCase();
    const titleHasCore = (title) => {
      const t = String(title || "").toLowerCase();
      // 核心片段命中，或任意一段 2 字以上的片段命中
      return t.indexOf(core.toLowerCase()) >= 0 || coreSegs.some((s) => s.length >= 2 && t.indexOf(s.toLowerCase()) >= 0);
    };

    for (const cand of list.slice(0, 6)) {
      if (cand.id === String(currentId).slice(3)) continue; // 跳过自己
      const candTitle = String(cand.title || "");
      const candArtist = String(cand.artist || "");
      const artistHit = artistLc && (candTitle.toLowerCase().indexOf(artistLc) >= 0 || candArtist.toLowerCase().indexOf(artistLc) >= 0);
      if (!titleHasCore(candTitle) && !artistHit) continue; // 不相关，跳过
      try {
        const st = await ytStream(cand.id);
        if (!st || !st.url) continue;
        // YouTube 给的是 webm，MyGo 播不了，必须转码
        const served = await serveWithFfmpeg(st.url, YT_ANDROID_UA, 128);
        if (!served) continue;
        console.log("[葫芦] YouTube 换源成功：" + candTitle.slice(0, 40));
        return { url: served.url, type: "mp3" };
      } catch {
        /* 换下一条 */
      }
    }
  } catch {}
  return null;
}

/** 带超时的 fetch。⚠️ 网易云 outer 一卡就会永远等下去，
    直到 MyGo 的 30 秒超时把整个插件进程干掉，表现就是「无法播放」。 */
async function fetchTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 网易云 outer → 真实 CDN 地址；无版权/VIP 返回空串 */
async function resolveNeteaseOuter(outerUrl) {
  try {
    const res = await fetchTimeout(outerUrl, {
      method: "GET",
      headers: { "User-Agent": UA, Range: "bytes=0-8191" },
      redirect: "follow",
    });
    const finalUrl = res.url || "";
    if (finalUrl && finalUrl.indexOf("/404") < 0 && finalUrl.indexOf("music.126.net") >= 0) return finalUrl;
  } catch {}
  try {
    const head = await fetchTimeout(outerUrl, { method: "HEAD", headers: { "User-Agent": UA }, redirect: "manual" }, 5000);
    const loc = (head.headers && head.headers.get("location")) || "";
    if (loc.indexOf("http") === 0 && loc.indexOf("/404") < 0 && loc.indexOf("126.net") >= 0) return loc;
  } catch {}
  return "";
}

/* 繁→简：内地平台对繁体关键词经常搜不到（"滔滔" vs "滔滔"、"爛泥" vs "烂泥"）。
   YouTube 上台湾/香港的标题大多是繁体，不转一遍基本全是空结果。
   只收最常用的几百个高频字，覆盖歌名够用。 */
const T2S_MAP = {
  這: "这", 個: "个", 們: "们", 時: "时", 會: "会", 來: "来", 到: "到", 說: "说",
  對: "对", 過: "过", 還: "还", 開: "开", 關: "关", 麼: "么", 樣: "样", 點: "点",
  為: "为", 現: "现", 實: "实",  樂: "乐", 聲: "声", 電: "电", 腦: "脑",
  愛: "爱", 戀: "恋", 夢: "梦", 願: "愿", 讓: "让", 見: "见", 覺: "觉", 得: "得",
  寶: "宝", 貝: "贝", 車: "车", 馬: "马", 鳥: "鸟", 魚: "鱼", 龍: "龙", 鳳: "凤",
  東: "东", 西: "西", 南: "南", 北: "北", 邊: "边", 裡: "里", 裏: "里", 頭: "头",
  長: "长", 短: "短", 高: "高", 低: "低", 遠: "远", 近: "近", 進: "进", 出: "出",
  記: "记", 憶: "忆", 遺: "遗", 忘: "忘", 專: "专", 業: "业", 餘: "余", 與: "与",
  從: "从",  經: "经", 歷: "历",  難: "难", 誰: "谁", 
  嗎: "吗", 呢: "呢", 吧: "吧", 啊: "啊", 喔: "喔", 噢: "噢", 妳: "你", 祢: "你",
  無: "无", 盡: "尽", 處: "处", 場: "场", 廠: "厂", 廣: "广", 應: "应", 該: "该",
  舊: "旧", 輕: "轻", 重: "重", 飛: "飞", 飄: "飘", 風: "风", 雲: "云", 雨: "雨",
  陽: "阳", 陰: "阴", 燈: "灯", 燦: "灿", 爛: "烂", 壞: "坏", 傷: "伤", 痛: "痛",
  淚: "泪", 哭: "哭", 笑: "笑", 唱: "唱", 聽: "听", 彈: "弹", 節: "节", 譜: "谱",
  線: "线", 絲: "丝", 織: "织", 網: "网", 結: "结", 綠: "绿", 紅: "红", 藍: "蓝",
  黃: "黄", 銀: "银", 鐵: "铁", 鋼: "钢", 錢: "钱", 買: "买", 賣: "卖", 貴: "贵",
  體: "体", 變: "变", 雙: "双", 單: "单", 歡: "欢", 溫: "温", 暖: "暖", 熱: "热",
  冷: "冷", 靜: "静", 動: "动",  給: "给", 將: "将", 沒: "没", 帶: "带",
  尋: "寻", 找: "找", 擇: "择", 選: "选",  總: "总", 親: "亲", 
  // 补充：歌名里高频、之前漏掉的
  廳: "厅",  廚: "厨", 廁: "厕", 樓: "楼", 層: "层", 島: "岛", 嶼: "屿",
  灣: "湾", 港: "港", 灘: "滩", 峽: "峡", 嶺: "岭", 巔: "巅", 巖: "岩", 礦: "矿",
  園: "园", 圓: "圆", 團: "团", 圍: "围", 國: "国", 圖: "图", 壇: "坛", 壓: "压",
  壩: "坝", 墳: "坟", 墊: "垫", 墻: "墙", 壁: "壁",  職: "职",
   肅: "肃", 脅: "胁", 脈: "脉",  臉: "脸", 膽: "胆", 臟: "脏",
  臨: "临", 臺: "台",  舉: "举",  艙: "舱", 艦: "舰", 藝: "艺",
  藥: "药", 蘇: "苏", 蘭: "兰",  號: "号", 蟲: "虫", 蠟: "蜡", 術: "术",
  衛: "卫", 衝: "冲", 補: "补", 裝: "装",  褲: "裤", 襯: "衬", 
  觀: "观", 計: "计", 訂: "订", 認: "认", 討: "讨",  訓: "训", 議: "议",
  訊: "讯",  講: "讲", 許: "许", 論: "论", 設: "设", 訪: "访", 証: "证",
  評: "评", 識: "识",  警: "警", 譯: "译", 護: "护", 讀: "读", 
  讚: "赞", 谷: "谷", 豐: "丰", 豬: "猪", 貓: "猫",  負: "负", 財: "财",
  貢: "贡", 貧: "贫", 貨: "货", 販: "贩", 貪: "贪", 責: "责",  
  貸: "贷", 費: "费", 賀: "贺", 資: "资", 賊: "贼", 賞: "赏", 賢: "贤", 賦: "赋",
  質: "质", 賬: "账", 賴: "赖", 購: "购", 賽: "赛", 贏: "赢", 贊: "赞", 贈: "赠",
  趕: "赶", 趨: "趋", 跡: "迹", 踐: "践",  軌: "轨", 軍: "军", 軒: "轩",
  軟: "软", 軸: "轴", 較: "较", 載: "载", 輔: "辅",  輛: "辆", 輪: "轮",
  輸: "输", 轉: "转", 辦: "办", 辭: "辞", 農: "农", 迴: "回", 遊: "游", 運: "运",
   達: "达", 違: "违", 遙: "遥", 遜: "逊",  適: "适", 遲: "迟",
  遷: "迁",  遼: "辽", 邁: "迈",   邏: "逻", 郵: "邮",
  鄉: "乡", 鄧: "邓", 鄭: "郑", 鄰: "邻", 醜: "丑", 釋: "释", 針: "针", 釘: "钉",
  釣: "钓", 鈴: "铃", 鉛: "铅",  銅: "铜", 鋪: "铺", 銷: "销", 鋒: "锋",
   錄: "录", 錶: "表",  錦: "锦", 鍵: "键", 鎖: "锁", 鏡: "镜",
  鐘: "钟",  鑰: "钥",  門: "门", 閉: "闭", 問: "问", 間: "间",
  悶: "闷", 閘: "闸", 閩: "闽", 閱: "阅", 闆: "板", 闊: "阔",  
   陳: "陈", 陸: "陆", 隊: "队", 階: "阶", 隨: "随", 險: "险", 隱: "隐",
  雜: "杂", 雞: "鸡", 離: "离",    霧: "雾", 靈: "灵",
   韻: "韵", 響: "响", 頁: "页", 頂: "顶", 項: "项", 順: "顺", 須: "须",
  預: "预", 領: "领",  頻: "频", 顆: "颗", 題: "题", 額: "额", 顏: "颜",
   類: "类", 顧: "顾", 顯: "显",    養: "养",
  餐: "餐", 飯: "饭", 飲: "饮", 飽: "饱", 餓: "饿", 館: "馆",  駕: "驾",
  騎: "骑", 驚: "惊", 驗: "验",  髮: "发", 鬧: "闹", 鬥: "斗", 魂: "魂",
   鮮: "鲜", 鯨: "鲸",   鴻: "鸿", 鷹: "鹰", 鹽: "盐",
  麗: "丽", 麥: "麦", 麵: "面",   黨: "党", 齊: "齐", 齒: "齿",
   龜: "龟",
  // 姓氏与常见人名用字
  組: "组", 慶: "庆",   
  歐: "欧", 趙: "赵", 劉: "刘", 張: "张", 楊: "杨", 吳: "吴",  馮: "冯",
  蕭: "萧",  曾: "曾", 彭: "彭", 呂: "吕", 盧: "卢",  蔣: "蒋",
  蔡: "蔡", 賈: "贾", 丁: "丁", 魏: "魏", 薛: "薛", 閻: "阎", 鄒: "邹", 龔: "龚",
   龐: "庞", 嚴: "严", 韓: "韩", 塗: "涂",  湯: "汤", 喬: "乔",
      萬: "万", 侯: "侯", 嶽: "岳", 帥: "帅",
  傑: "杰", 偉: "伟", 強: "强", 剛: "刚", 劍: "剑",  鵬: "鹏", 
   霞: "霞",   菊: "菊", 蓮: "莲", 梅: "梅", 櫻: "樱",
  兒: "儿", 爺: "爷", 媽: "妈",  爸: "爸", 姊: "姐", 妹: "妹", 
   淒: "凄", 涼: "凉", 凍: "冻", 濕: "湿", 濃: "浓", 淺: "浅", 滾: "滚",
  滿: "满", 漲: "涨", 漸: "渐", 潔: "洁", 濁: "浊", 灑: "洒",  
};

/** 繁体 → 简体（逐字查表，查不到的原样保留） */
function toSimplified(s) {
  let out = "";
  for (const ch of String(s || "")) out += T2S_MAP[ch] || ch;
  return out;
}

/* 判断候选歌名是不是「同一首歌」。
   ⚠️ 不能用简单的双向包含（indexOf）。
      实测踩过：搜「我知道我失去你了」，网易云返回「我知道」也能通过
      双向包含判断，结果播出来是另一首歌 —— 用户直接听出来了。
   规则收紧为：
     ① 归一化后完全相等 → 是
     ② 一方包含另一方，且长度差 ≤ 3 个字 → 是（容忍「(Live)」这类后缀）
     ③ 其余 → 不是 */
function sameSongName(cand, want) {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[(（\[【][^)）\]】]*[)）\]】]/g, "") // 去括号
      .replace(/[\s\-–—_/|·•~,，.。!！?？'"'"'"、:：]/g, "") // 去标点空白
      .trim();
  const a = norm(cand);
  const b = norm(want);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) {
    const short = a.length < b.length ? a : b;
    const long = a.length < b.length ? b : a;
    // 长度差 ≤ 2，且短的至少占长的 60% —— 挡住「失去」vs「失去尼歐」这种沾边
    return long.length - short.length <= 2 && short.length >= long.length * 0.6;
  }
  return false;
}

/** 用歌名+歌手去内地平台找同一首歌（YouTube 播放不了的补偿路径） */
/* 跨平台同名曲兜底。
   ⚠️ 这里踩过一次大坑，记下来别再犯：
      「927 - 那我懂你意思了」这首歌，原来只按歌名比（sameSongName），
      于是网易云搜「927」拿到一首《927》就放行 —— 播出来是别人的歌。
      搜「我懂你」拿到潘瑋柏《我想更懂你》，搜「飘」拿到别的歌手的《飘》，全错。
      所以**必须校验歌手**，而且歌手校验要比歌名更严：
        · 原名带了歌手 → 候选歌手必须包含它（或它包含候选），否则丢弃
        · 原名没带歌手 → 只靠歌名 exact 匹配，且必须是「一模一样」不放宽
   为什么歌手校验放在歌名前面：下架歌手在网易云/酷我里常常整条被清掉，
   能搜到的同名曲大概率是别人的 —— 只要歌手对不上，歌名对得多准都不能用。 */
async function tryMainlandByName(name, artist) {
  const rawTitle = cleanSongTitle(name);
  const title = toSimplified(rawTitle);
  if (!title || title.length < 2) return null;
  const artistS = toSimplified(String(artist || "").trim());
  // 去掉「- Topic」这类频道后缀，用它做歌手比对没意义
  const artistClean = artistS.replace(/[-–—]\s*(topic|official|vevo)\s*$/i, "").trim();

  // 歌名比对的严格版：只认「完全一致」或「一方是另一方 + 极短后缀」，
  // 不放宽长度比例 —— 老版 long-short<=2 让「927」和「我那懂你」都能过。
  const exactish = (cand) => {
    const a = toSimplified(cleanSongTitle(cand)).replace(/\s+/g, "");
    const b = title.replace(/\s+/g, "");
    if (!a || !b) return false;
    if (a === b) return true;
    // 允许候选带极短尾巴（「七里香」vs「七里香mp3」这种），但尾巴 ≤2 且不含中文数字以外内容
    if (a.startsWith(b) && a.length - b.length <= 2) return true;
    if (b.startsWith(a) && b.length - a.length <= 2) return true;
    return false;
  };

  // 歌手比对：任一方包含另一方，且短的一方至少 2 个字（防「我」这种单字误命中）
  const artistOk = (cand) => {
    if (!artistClean) return true;              // 不知道原歌手 → 不拦
    const c = toSimplified(String(cand || "")).replace(/[-–—]\s*(topic|official|vevo)\s*$/i, "").trim();
    if (!c) return true;                        // 候选没歌手信息 → 不拦（有些平台字段为空）
    const cl = c.toLowerCase(), wl = artistClean.toLowerCase();
    if (cl === wl) return true;
    if (cl.indexOf(wl) >= 0 || wl.indexOf(cl) >= 0) {
      return Math.min(cl.length, wl.length) >= 2;
    }
    return false;
  };

  const kwList = [];
  if (artistClean && title.indexOf(artistClean) < 0) kwList.push(title + " " + artistClean);
  kwList.push(title);

  for (const kw of kwList) {
    // 网易云
    try {
      const r = await neSearchTyped(kw, 1, 10);
      for (const song of (r.songs || []).slice(0, 5)) {
        const sName = String(song.name || "");
        const candArtist = (song.ar || []).map((a) => a.name || "").join(" / ");
        if (!exactish(sName)) { trace("① 歌名不符", sName + " ≠ " + title); continue; }
        if (!artistOk(candArtist)) { trace("① 歌手不符", candArtist + " ≠ " + artistClean); continue; }
        const url = NETEASE_OUTER.replace("{id}", encodeURIComponent(song.id));
        const real = await resolveNeteaseOuter(url);
        if (real) {
          const d = await checkAudioUrl(real);
          if (d.ok) {
            trace("① 网易云命中", sName + " / " + candArtist);
            return { url: real, type: guessType(real) };
          }
        }
      }
    } catch {}
    // 酷我
    try {
      const list = await kuwoSearch(kw);
      for (const it of (list || []).slice(0, 5)) {
        const t = String(it.title || "");
        const itArtist = String(it.artist || "");
        if (!exactish(t)) { trace("① 酷我歌名不符", t + " ≠ " + title); continue; }
        if (!artistOk(itArtist)) { trace("① 酷我歌手不符", itArtist + " ≠ " + artistClean); continue; }
        for (const fmt of ["mp3", "aac"]) {
          try {
            const u = await kuwoStream(it.rid, fmt);
            const d = await checkAudioUrl(u);
            if (d.ok) {
              trace("① 酷我命中", t + " / " + itArtist);
              return { url: u, type: fmt === "mp3" ? "mp3" : guessType(u) };
            }
          } catch {}
        }
      }
    } catch {}
  }
  return null;
}

/* 诊断：把 stream() 的执行轨迹写进 host.storage，
   方便在真实 MyGo 里定位「无法播放」到底卡在哪一步。
   用户可以在设置里把 proxyMode 留空（默认）时也照常工作，不影响正常播放。 */
function trace(step, extra) {
  try {
    if (!host || !host.storage) return;
    const key = "__trace";
    let list = [];
    try {
      const v = host.storage.get(key);
      if (Array.isArray(v)) list = v;
    } catch {}
    list.push({ t: new Date().toISOString().slice(11, 19), step: String(step).slice(0, 160), extra: extra ? String(extra).slice(0, 200) : "" });
    // 只留最近 40 条
    if (list.length > 40) list = list.slice(-40);
    host.storage.set(key, list);
  } catch {}
}

export async function stream({ id, quality }) {
  /* 【整体硬超时兜底】
     ⚠️⚠️ 实测（2026-11-08）：某些直播源（蜻蜓 qtfm.cn 等）在 DNS/TCP 阶段直接挂住，
        底层 fetch 和 ffmpeg 都可能在「已发起但永不返回」的状态里耗着。
        没有总超时的话，MyGo 点一首歌就永远转圈，测试脚本也会跑 4 分钟无输出。
        这里用 Promise.race 给整个取流过程套一个 45 秒上限 ——
        不管里面卡在哪一层，到点就抛「暂时找不到能播的音源」，让 UI 能报错而不是卡死。
     45 秒的理由：慢网下 ffmpeg 拉流 + 转码确实要等，30 秒会误杀正常慢请求。 */
  const STREAM_TIMEOUT_MS = 45000;
  let timer = null;
  try {
    return await Promise.race([
      _streamInner({ id, quality }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(fail("unavailable", "这首歌暂时找不到能播的音源")), STREAM_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** stream 的实际实现（被上面的超时包装器调用） */
async function _streamInner({ id, quality }) {
  const s = String(id);
  trace("stream 开始", s);

  /* YouTube —— 三步走：
       ① 先拿歌名去网易云/酷我找同曲（最快、最稳，直接是 mp3）
       ② 找不到就让 ffmpeg 把 YouTube 的 webm 实时转成 mp3 流出来
       ③ 还不行就换一条同曲的 YouTube 上传版本再试
     MyGo 原生播不了 YouTube 的任何音频格式（详见上面 ffmpeg 段注释）。 */
  if (s.startsWith("yt:")) {
    const meta = trackMeta.get(s);

    // ① 跨平台同名曲
    if (meta && meta.name) {
      trace("① 试跨平台同名曲", meta.name);
      const cross = await tryMainlandByName(meta.name, meta.artist);
      if (cross) {
        trace("① 跨平台成功", cross.url);
        return cross;
      }
      trace("① 跨平台无结果");
    } else {
      trace("① 无元数据，跳过跨平台", s);
    }

    // ② ffmpeg 转码
    const viaFfmpeg = async (videoId) => {
      try {
        trace("② 取 YouTube 流", videoId);
        const st = await ytStream(videoId);
        if (!st || !st.url) {
          trace("② ytStream 无 url");
          return null;
        }
        trace("② 起 ffmpeg", st.url.slice(0, 60));
        const served = await serveWithFfmpeg(st.url, YT_ANDROID_UA, 128);
        if (served) {
          trace("② ffmpeg 成功", served.url);
          return { url: served.url, type: "mp3" };
        }
        trace("② ffmpeg 失败");
      } catch (e) {
        const m2 = String((e && e.message) || e).slice(0, 120);
        trace("② 异常", m2);
        console.log("[葫芦] ffmpeg 转码失败: " + m2.slice(0, 80));
      }
      return null;
    };

    const videoId = s.slice(3);
    const first = await viaFfmpeg(videoId);
    if (first) return first;

    // ③ 换一条同曲上传版本（retryOtherYoutubeUpload 内部已做 ffmpeg 转码）
    try {
      trace("③ 试换源");
      const alt = await retryOtherYoutubeUpload(s, new Error("需要换源"));
      if (alt) {
        trace("③ 换源成功", alt.url);
        return alt;
      }
      trace("③ 换源失败");
    } catch {}

    trace("✗ 全部失败");
    throw fail("unavailable", "这首歌暂时找不到能播的音源");
  }

  /* B 站。
     ⚠️ 必须走 ffmpeg 转码，原因：
        B 站的 m4s 是 fMP4 分片，moov 里的采样表是空的（stsz n=0），
        MyGo 的 mp4 解析器会「解析成功但 0 个采样」→ 播不出声。
        跟 YouTube 的 ftypdash 是同一类问题。
     ⚠️ 且 CDN 请求必须带 Referer，否则 403。 */
  if (s.startsWith("bi:")) {
    const bvid = s.slice(3);
    const meta = trackMeta.get(s);

    // ① 跨平台同名曲（B 站搬运号音质参差，内地平台有正版就优先用）
    if (meta && meta.name) {
      trace("① B站试跨平台", meta.name);
      const cross = await tryMainlandByName(meta.name, meta.artist);
      if (cross) {
        trace("① B站跨平台成功", cross.url);
        return cross;
      }
      trace("① B站跨平台无结果");
    }

    // ② B 站自己的流，ffmpeg 转码
    try {
      trace("② B站取详情", bvid);
      const v = await biliView(bvid);
      if (v && v.cid) {
        const audio = await biliAudioUrl(bvid, v.cid);
        if (audio && audio.url) {
          trace("② B站起 ffmpeg", Math.round(audio.bandwidth / 1000) + "kbps");
          const served = await serveWithFfmpeg(audio.url, BILI_UA, 192, {
            Referer: "https://www.bilibili.com/",
          });
          if (served) {
            trace("② B站 ffmpeg 成功", served.url);
            return { url: served.url, type: "mp3" };
          }
          trace("② B站 ffmpeg 失败");
        } else {
          trace("② B站无音轨");
        }
      } else {
        trace("② B站详情失败");
      }
    } catch (e) {
      trace("② B站异常", String((e && e.message) || e).slice(0, 120));
    }

    trace("✗ B站全部失败");
    throw fail("unavailable", "这首歌暂时找不到能播的音源");
  }

  // 网易云
  if (s.startsWith("ne:")) {
    const neteaseId = s.slice(3);
    const outerUrl = NETEASE_OUTER.replace("{id}", encodeURIComponent(neteaseId));

    /* ⚠️ outer 的两种结局都要处理：
         免费/已购 → 302 到 mXXX.music.126.net 的 CDN 直链
         无版权/VIP → 302 到 http://music.163.com/404（一个 HTML 页面，且跟随后状态是 200！）
       所以**不能只看状态码**，必须拿到最终 URL 判断，再用内容复核。 */
    /* ⚠️⚠️ 这里必须带超时！
       实测踩过：MyGo 会同时发几个 stream 请求（预加载下一首），
       网易云那边一卡，无超时的 fetch 就永远等下去，
       直到 MyGo 的 30 秒超时把整个插件进程干掉——
       表现就是「这首歌无法播放」，而且后面的歌也跟着全挂。 */
    let realUrl = "";
    try {
      const res = await fetchTimeout(outerUrl, {
        method: "GET",
        headers: { "User-Agent": UA, Range: "bytes=0-8191" },
        redirect: "follow",
      });
      const finalUrl = res.url || "";
      if (finalUrl && finalUrl.indexOf("/404") < 0 && finalUrl.indexOf("music.126.net") >= 0) {
        realUrl = finalUrl;
      }
      // 若外层没给出 CDN，退回手动取 location
      if (!realUrl) {
        const head = await fetchTimeout(
          outerUrl,
          { method: "HEAD", headers: { "User-Agent": UA }, redirect: "manual" },
          5000
        );
        const loc = (head.headers && head.headers.get("location")) || "";
        if (loc.indexOf("http") === 0 && loc.indexOf("/404") < 0 && loc.indexOf("126.net") >= 0)
          realUrl = loc;
      }
    } catch (e) {
      trace("ne outer 超时/失败", String((e && e.message) || e).slice(0, 60));
    }

    if (realUrl) {
      const d = await checkAudioUrl(realUrl);
      if (d.ok) return { url: realUrl, type: guessType(realUrl) };
      console.log("[葫芦] 网易云直链格式不兼容(" + d.why + ")，转兜底");
    } else {
      console.log("[葫芦] 网易云无版权/VIP（outer→404），转兜底");
    }
    // 无版权 / VIP / 格式怪 → 跨平台兜底到 YouTube
    const alt = await fallbackToYoutube(id);
    if (alt) return alt;
    throw fail("unavailable", "网易云无版权/VIP，且未找到替代音源");
  }

  /* 真·网络收音机 —— 直连直播流，用 ffmpeg 实时转 MP3 推给 MyGo。
     ⚠️ 直播流是无限的，ffmpeg -listen 1 会一直读、一直推，播放器就一直播。
        跟点播不同：不设 -t（不限时长），也不做 seek。
     ⚠️ 先试直连（很多直播流本身就是 mp3，MyGo 能直接播），
        直连不通/格式怪再上 ffmpeg 转码。 */
  /* RoamDial 目录里的电台（rd:<内部 id>）—— 直播流，带三层兜底 */
  if (s.startsWith("rd:")) {
    const id = s.slice(3);
    if (!id) throw fail("unavailable", "电台 id 为空");
    const st = await rdById(id);
    if (!st) throw fail("unavailable", "这个电台已经下架了");
    const url = st.url;
    /* ⚠️ 蜻蜓系（qtfm.cn / qingting.fm）每次连接都会在第一个 MPEG 帧前塞一段
       随机长度的前缀：实测同一台十次请求分别是 2 / 14 / 16 / 25 / 36 / 63 / 66 / 79 / 89 字节，
       内容也每次不同（不是 ID3、不是固定 ICY 头）。
       MyGo 的 mp3 解码器从第 0 字节开始读，碰上这些前缀直接报
       「mp3: only layer3 (want 1; got 2)」或「这首歌无法播放」。
       前缀长度不固定 → 跳过固定字节没用，只能让 ffmpeg 自己同步到帧。
       所以这里不再"先转码再说"，而是先探测：干净的台直连（快、不依赖 ffmpeg），
       带前缀的台才转码。 */
    const probe0 = await rdProbe(url, 6000);
    if (probe0.ok && probe0.clean) {
      return { url, type: probe0.fmt };
    }
    /* aac 一律先转码：里面混着 HE-AAC（SBR+PS），MyGo 的解码器直接报错 */
    const probe = probe0;
    if (probe.ok) {
      /* 头部带垃圾的平台（蜻蜓部分台）直连解码器必崩，探测出 mp3 也得转 */
      if (probe.fmt === "mp3" && probe.clean === false) {
        const served = await serveWithFfmpeg(url, uaDesktop(), 128).catch(() => null);
        if (served) return { url: served.url, type: "mp3" };
        trace("rd 头部不干净且转码没起来", String(probe.bytes || 0) + "B");
        /* ⚠️ 这种流不能就这么丢给解码器（开头是 ICY 元数据块，例如
           lhttp.qingting.fm/live/4915/64k.mp3 第一个字节就是 0x11 元数据长度），
           丢过去的结果就是一句「这首歌无法播放」，用户完全不知道是 ffmpeg 没就绪。
           这里抛普通 Error（不带 unavailable 之类的码）：MyGo 对未知错误
           会把 message 原样显示在播放栏，正好把原因告诉用户。 */
        throw new Error(
          "这个台的音频开头带 ICY 元数据（不是纯音频），必须用 ffmpeg 转码播放。" +
          "本机没找到可用的 ffmpeg：请在插件设置里填「ffmpeg 路径」，或允许插件下载 ffmpeg 后重试。"
        );
      }
      if (probe.fmt === "aac") {
        const served = await serveWithFfmpeg(url, uaDesktop(), 128).catch(() => null);
        if (served) return { url: served.url, type: "mp3" };
        trace("rd aac 转码失败，直连", String(probe.bytes || 0) + "B");
      }
      return { url, type: probe.fmt };
    }
    trace("rd 直连不可播", probe.why || "");
    /* 读不到数据或格式不认：交给 ffmpeg 在用户本机拉流转 mp3 */
    const served = await serveWithFfmpeg(url, uaDesktop(), 128).catch(() => null);
    if (served) return { url: served.url, type: "mp3" };
    /* 到这里说明：直接播不了，ffmpeg 也没启动。
       ⚠️ 不能再"退回原始地址让播放器自己试" —— 带随机前缀或 HE-AAC 的流
          丢过去只会以一句「这首歌无法播放」收场，用户完全不知道发生了什么。
       用普通 Error（不带 code）：MyGo 会把 message 原样显示在播放栏。 */
    /* 用户在设置里明确关掉了转码（填 0）：这是他自己的选择，退回直连，
       播不播得出来由播放器决定，不再拦。 */
    if (!transcodeEnabled()) {
      trace("转码被设置关掉，退回直连", url.slice(0, 60));
      return { url, type: rdStreamType(url) };
    }
    if (probe.ok) {
      throw new Error(
        "这个台的音频开头带随机前缀（蜻蜓等直播台的常见做法），播放器自己解不了，要用 ffmpeg 转一道。" +
        "现在 ffmpeg 没能启动：请到插件设置里把「ffmpeg 路径」填全，并在弹出的授权里点「允许」。"
      );
    }
    if (probe.status === 503 || /upstream connect|upstream|disconnect/i.test(String(probe.body || ""))) {
      throw fail("unavailable", "这个台的服务器现在没在播（" + (probe.body || probe.why || "503") + "），换一台吧");
    }
    throw new Error(
      "拉不到这个台的音频数据（" + (probe.why || "无响应") + "），需要 ffmpeg 在本机拉流。" +
      "现在 ffmpeg 没能启动：请把「ffmpeg 路径」填全，并在授权提示里点「允许」。"
    );
  }

  if (s.startsWith("radio:")) {
    const streamUrl = s.slice(6);
    if (!streamUrl) throw fail("unavailable", "电台地址为空");
    /* 需转码的台跳过直连探测 —— 蜻蜓这类流带 junk 头/封装，
       直连探测的 Range 请求会在那块白等 6 秒超时，纯浪费时间。 */
    let forceTrans = false;
    try {
      const meta = trackMeta.get(String(id));
      forceTrans = !!(meta && meta.forceTranscode);
    } catch {}
    // ① 先看直链能不能直接播（纯 mp3 直播流）
    if (!forceTrans) {
      try {
        const d = await checkAudioUrl(streamUrl, 6000);
        if (d.ok) return { url: streamUrl, type: "mp3" };
        trace("radio 直连不可播，转 ffmpeg", d.why || "");
      } catch (e) {
        trace("radio 直连异常", String((e && e.message) || e).slice(0, 60));
      }
    } else {
      trace("radio 强制转码（蜻蜓 junk 头）", streamUrl.slice(0, 50));
    }
    // ② ffmpeg 转码（HLS / AAC / 格式怪的流）
    try {
      const served = await serveWithFfmpeg(streamUrl, uaDesktop(), 128);
      if (served) return { url: served.url, type: "mp3" };
    } catch (e) {
      trace("radio ffmpeg 异常", String((e && e.message) || e).slice(0, 60));
    }
    throw fail("unavailable", "电台流暂时连不上");
  }

  /* 播客单集 —— 直接用 RSS 里的 enclosure 直链（实测是小宇宙 CDN 的 m4a，
     HTTP 200 / audio/mp4，MyGo 认 m4a，能直接播，不用转码）。 */
  /* 网易电台节目（ndjp:）—— 本质是一首歌（mainSong.id），
     直接复用网易的 outer 302 取流，再走 ffmpeg 兜底。
     ⚠️ 先试 outer 直链（免费/已购会 302 到 CDN）；
        302 到 /404 说明无版权，转 ffmpeg 兜底也没用，直接报错。 */
  if (s.startsWith("ndjp:")) {
    const meta = trackMeta.get(String(id));
    const sid = (meta && meta.neSongId) || "";
    if (!sid) throw fail("unavailable", "电台节目缺少音频 id");
    const outerUrl = NETEASE_OUTER.replace("{id}", encodeURIComponent(sid));
    try {
      const res = await fetchTimeout(outerUrl, {
        method: "GET",
        headers: { "User-Agent": UA, Range: "bytes=0-8191" },
        redirect: "follow",
      });
      const finalUrl = res.url || "";
      if (finalUrl && finalUrl.indexOf("/404") < 0 && finalUrl.indexOf("music.126.net") >= 0) {
        const d = await checkAudioUrl(finalUrl);
        if (d.ok) return { url: finalUrl, type: guessType(finalUrl) };
      }
    } catch (e) {
      trace("ndjp outer 失败", String((e && e.message) || e).slice(0, 60));
    }
    // 兜底：交给 ffmpeg 转码（如果是格式问题）
    try {
      const served = await serveWithFfmpeg(outerUrl, uaDesktop(), 128);
      if (served) return { url: served.url, type: "mp3" };
    } catch {}
    throw fail("unavailable", "这个电台节目暂时无法播放（可能无版权）");
  }

  if (s.startsWith("pode:")) {
    const meta = trackMeta.get(String(id));
    const audio = meta && meta.audio;
    if (!audio) throw fail("unavailable", "播客音频地址丢了，回节目页重进一次");
    /* ⚠️⚠️ 播客只交 mp3 —— 别的格式一律 ffmpeg 转码。
       踩过的坑：喜马拉雅/小宇宙大量单集是 .m4a，里面实为 AAC，
       而 MyGo 的 aac 解码器是 go-aac，**不支持 HE-AAC(SBR+PS)**，
       报 "go-aac/pcm: unsupported stream: SBR (HE-AAC) + PS"，
       进度卡 0:00 播不出声。
       所以：mp3 直连；m4a/aac/未知 → ffmpeg 实时转 mp3。 */
    const pathNoQuery = audio.toLowerCase().split("?")[0];
    const isMp3 = pathNoQuery.endsWith(".mp3") || pathNoQuery.endsWith(".mp3.m4a");
    if (isMp3) return { url: audio, type: "mp3" };
    // 非 mp3（m4a/aac/ogg/flac/无扩展名）→ ffmpeg 转 mp3
    try {
      const served = await serveWithFfmpeg(audio, uaDesktop(), 128);
      if (served) return { url: served.url, type: "mp3" };
    } catch (e) {
      trace("播客转码失败", String((e && e.message) || e).slice(0, 80));
    }
    // 转码不可用（无 host.spawn 等）→ 退化成按扩展名交给播放器，至少有机会播
    if (pathNoQuery.endsWith(".ogg")) return { url: audio, type: "ogg" };
    if (pathNoQuery.endsWith(".flac")) return { url: audio, type: "flac" };
    return { url: audio, type: "m4a" };
  }

  /* QQ —— RS02 前缀免登录可用，拿到的是标准 mp3，MyGo 直接能播。
     ⚠️ media_mid 与 songmid 不一定相同，取流要用 media_mid；
        进程重启后缓存会丢，这时退回用 songmid（大部分歌两者一致）。 */
  if (s.startsWith("qq:")) {
    const mid = s.slice(3);
    const media = qqMedia.get(mid) || mid;
    try {
      const url = await qqStreamUrl(mid, media);
      if (url) return { url, type: "mp3" };
    } catch {}
    // QQ 拿不到（VIP/下架）→ 跨平台兜底
    const alt = await fallbackToYoutube(id);
    if (alt) return alt;
    throw fail("unavailable", "QQ 音乐地址获取失败");
  }

  // 酷我 —— mp3 与 aac 各试一遍，逐个验格式
  if (s.startsWith("kw:")) {
    const rid = s.slice(3);
    const candidates = [];
    for (const fmt of ["mp3", "aac"]) {
      try {
        const url = await kuwoStream(rid, fmt);
        candidates.push({ url, type: fmt === "mp3" ? "mp3" : guessType(url) });
      } catch {}
    }
    if (!candidates.length) throw fail("unavailable", "酷我地址获取失败");
    const hit = await pickPlayable(candidates);
    if (hit) return { url: hit.url, type: hit.type, headers: hit.headers };
    // 酷我的 mp3 是 MP2/free-format 之类的非法编码 → 跨平台兜底
    const alt = await fallbackToYoutube(id);
    if (alt) return alt;
    throw fail("unavailable", "酷我音频格式不兼容");
  }

  throw fail("unavailable", "无法识别曲目");
}

/** 用缓存的曲目元数据去 YouTube 找同曲，兜底播放（YouTube 只有 webm，最稳） */
async function fallbackToYoutube(id) {
  const meta = trackMeta.get(String(id));
  if (!meta || !meta.name) return null;
  try {
    const kw = meta.artist ? meta.name + " " + meta.artist : meta.name;
    const list = await ytSearch(kw);
    if (!list || !list.length) return null;

    /* ⚠️ 选版本的原则：**官方 - Topic 频道优先，且时长必须对得上**。
       踩过的坑：陶喆《Melody》在网易云是 VIP（播放不了），兜底到 YouTube
       时选到了《Melody (Live)》—— Live 版比录音室版长 26 秒，前奏也不一样，
       结果歌词和音频完全错位，用户一眼看出来「歌词比歌快」。
       Topic 频道是唱片公司直传的发行版，版本一定和专辑一致，所以给最高分；
       时长差超过 20 秒的直接淘汰（Live/现场/加长版都会差这么多）。 */
    const wantSec = Math.round((Number(meta.duration) || 0) / 1000);
    const ranked = list
      .map((t) => {
        const isTopic = /-\s*Topic$/i.test(t.artist || "");
        const sec = parseDur(t.durationText) / 1000;
        const durDiff = wantSec > 0 && sec > 0 ? Math.abs(sec - wantSec) : -1;
        let sc = 0;
        if (isTopic) sc += 1000; // 官方发行音轨，压倒性优先
        if (normTitle(t.title).indexOf(normTitle(meta.name)) >= 0) sc += 100;
        // 时长越接近越好；差 > 20 秒的扣到负分（等价于淘汰）
        if (durDiff >= 0) {
          if (durDiff <= 3) sc += 200;
          else if (durDiff <= 10) sc += 80;
          else if (durDiff > 20) sc -= 500;
        }
        // 标题带 Live/现场/翻唱/伴奏的压下去（Topic 频道豁免）
        if (!isTopic && /live|现场|現場|演唱会|演唱會|cover|翻唱|伴奏|instrumental|remix/i.test(t.title || ""))
          sc -= 300;
        return { t, sc };
      })
      .sort((a, b) => b.sc - a.sc);
    // 全被扣成负分说明没找到像样的版本，宁可失败也别播错
    if (!ranked.length || ranked[0].sc < 0) {
      console.log("[葫芦] YouTube 无合适的同曲版本，放弃兜底");
      return null;
    }
    console.log(
      "[葫芦] 兜底选版: " +
        ranked[0].t.title.slice(0, 30) +
        " (" +
        ranked[0].t.artist +
        ") sc=" +
        ranked[0].sc
    );
    const st = await ytStream(ranked[0].t.id);
    if (!st || !st.url) return null;
    console.log("[葫芦] 跨平台兜底到 YouTube：" + meta.name);
    /* ⚠️ 不能直接返回 YouTube 的原始链接 —— 那是 webm/Opus，
       MyGo 没有 EBML 解析器，播不了（报 mp3: is_pos was too big）。
       必须让 ffmpeg 转成 mp3 再从本地端口流出去。 */
    const served = await serveWithFfmpeg(st.url, YT_ANDROID_UA, 128);
    if (served) {
      /* ⚠️ 兜底成功后把**实际选中的那个版本**写回元数据缓存。
         为什么：音频和歌词必须来自同一个版本。
         原来 meta 里存的是网易云那条的时长（录音室版 269s），
         但实际播的是 YouTube 选中的版本；如果选中的是 Live 版，
         歌词按 269s 的时间轴走就会整体错位。
         把真实版本的歌名/时长/歌手覆盖进去，之后 lrclib() 和
         网易云反查都会按这个版本去找，两边就对齐了。 */
      try {
        const picked = ranked[0].t;
        // parseDur 返回的是**毫秒**，这里要秒
        const pickedSec = Math.round(parseDur(picked.durationText) / 1000);
        trackMeta.set(String(id), {
          ...(meta || {}),
          name: cleanSongTitle(picked.title || meta.name, picked.artist || meta.artist || ""),
          artist: cleanArtistName(picked.artist || meta.artist || ""),
          duration: pickedSec > 0 ? pickedSec * 1000 : meta.duration, // 存回毫秒
          // YouTube 频道名不可信，但 Topic 频道是官方发行版，可以信
          artistTrusted: /-\s*Topic$/i.test(picked.artist || ""),
          servedFrom: "youtube",
        });
        console.log("[葫芦] 已同步歌词版本: " + cleanSongTitle(picked.title || "") + " / " + pickedSec + "s");
      } catch {}
      return { url: served.url, type: "mp3" };
    }
    return null;
  } catch {
    return null;
  }
}

function guessType(url) {
  const lower = String(url).toLowerCase();
  if (lower.includes(".flac") || lower.includes("flac")) return "flac";
  if (lower.includes(".m4a")) return "m4a";
  if (lower.includes(".webm")) return "ogg";
  if (lower.includes(".ogg") || lower.includes("opus")) return "ogg";
  return "mp3";
}

function fail(code, message) {
  const e = new Error(message || "unavailable");
  e.code = code;
  return e;
}

/* ============================================================
 * 首页
 * ------------------------------------------------------------
 * 第一块 tracks 会被 MyGo 渲染成大横幅（featureCard）：
 *   背景色 = 第一首封面的主色调，鼠标悬停唱片滑出并转动。
 *   所以「今日拼单」放第一个，视觉最抓眼。
 *
 * 「今日拼单」的规则（沿用拼好歌那套，但**不用收听历史**）：
 *   · 从网易云几个热门歌单各取一批曲目，混在一起
 *   · 同歌手最多 2 首（超过就腻）
 *   · 全列表打散，不按歌手/风格聚堆
 *   · 三分之二处插一首风格反差的（从另一个类目挑）
 *   · 用日期做随机种子 —— 同一天打开几次都一样，第二天自动换
 *
 * 为什么不用收听历史：插件拿不到 MyGo 的播放记录（played 只给 id，
 * 不给时长也不给跳过），拿不到就没法按口味推。所以改成「每天换一批
 * 好歌」，至少不会重复。
 * ============================================================ */

/** 可复现的伪随机（同一天结果一致） */
function seeded(seed) {
  let s = 0;
  for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) | 0;
  return () => {
    s = (s * 1103515245 + 12345) | 0;
    return ((s >>> 16) & 0x7fff) / 0x7fff;
  };
}

function shuffleWith(list, rnd) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 今天的日期键，用来做种子和缓存失效 */
function todayKey() {
  const d = new Date();
  return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
}

/* 首页用的几个类目。cat 直接传给网易云歌单接口。 */
const HOME_CATS = [
  { key: "huayu", cat: "华语", title: "华语精选" },
  { key: "rock", cat: "摇滚", title: "摇滚" },
  { key: "oumei", cat: "欧美", title: "欧美精选" },
  { key: "rihan", cat: "日语", title: "日系" },
  { key: "minyao", cat: "民谣", title: "民谣" },
  { key: "dianzi", cat: "电子", title: "电子" },
  { key: "gufeng", cat: "古风", title: "古风" },
  { key: "shuochang", cat: "说唱", title: "说唱" },
];

/** 拉某个类目的热门歌单（带封面）。
    ⚠️ 每个分类按当天缓存 —— home() 里 16 个 catMix 并发跑，同分类
       两个 slot 会重复请求这里。不缓存的话冷启动 16 次并爆网易接口，
       大量返回空 → 分类缺卡、主页下半截空白。缓存后最多 8 次（已热
       缓存则是 0 次），同分类 slot0/slot1 结果完全一致（本就同源）。 */
async function neTopPlaylists(cat, limit = 8) {
  const key = "nepTop:" + CACHE_VER + ":" + cat + ":" + todayKey();
  try {
    const cached = host.storage.get(key);
    if (Array.isArray(cached) && cached.length) return cached;
  } catch {}
  const url =
    "https://music.163.com/api/playlist/list?cat=" +
    encodeURIComponent(cat) +
    "&order=hot&limit=" +
    limit +
    "&offset=0";
  const { text } = await fetchText(url, { headers: { Referer: "https://music.163.com/" } });
  const j = JSON.parse(text);
  const list = (j && j.playlists) || [];
  const out = list.map((p) => ({
    id: "nep:" + p.id,
    name: String(p.name || ""),
    imageUrl: String(p.coverImgUrl || ""),
    trackCount: Number(p.trackCount) || 0,
    owner: (p.creator && p.creator.nickname) || "",
    description: String(p.description || "").slice(0, 120),
  }));
  try {
    if (out.length) host.storage.set(key, out);
  } catch {}
  return out;
}

/** 拉一个歌单的曲目（最多 n 首） */
async function nePlaylistTracks(pid, n = 30) {
  const url = "https://music.163.com/api/v6/playlist/detail?id=" + encodeURIComponent(pid) + "&n=" + n;
  const { text } = await fetchText(url, { headers: { Referer: "https://music.163.com/" } });
  const j = JSON.parse(text);
  const p = (j && j.playlist) || {};
  const tracks = (p.tracks || []).slice(0, n).map(neSongToTrack);
  return { name: String(p.name || ""), tracks };
}

/** 今日拼单：跨歌单混排 + 同歌手限流 + 反差曲 */
/* 可播性过滤：fee=1 是 VIP，st<0 是下架。
   ⚠️ 必须在**每次**返回前过一遍，不能只在生成时过——
      缓存回读路径不经过生成逻辑，不过滤就会把 VIP 歌发给播放器。 */
function playableOnly(list) {
  const out = (list || []).filter((t) => {
    if (!t) return false;
    if (t._fee === 1) return false;
    if (typeof t._st === "number" && t._st < 0) return false;
    return true;
  });
  // 过滤完太少就不过滤了（宁可有几首需要兜底也别空）
  return out.length >= 6 ? out : list || [];
}

/* ⚠️ 缓存结构版本号。
   只要改了 snapshot()/unsnapshot() 的字段，就把这个数字 +1——
   旧版缓存的 key 不一样，自动失效，不会再把缺字段的旧数据读回来。
   （踩过：加了 fee 字段但旧缓存没有，导致 VIP 歌过滤失效、点播放全报错。） */
const CACHE_VER = 2;

async function todayMix() {
  const cacheKey = "mix:v" + CACHE_VER + ":" + todayKey();
  try {
    const cached = host.storage.get(cacheKey);
    if (Array.isArray(cached) && cached.length >= 10)
      return playableOnly(cached.map(unsnapshot).filter(Boolean));
  } catch {}

  const rnd = seeded("mix-" + todayKey());
  // 两个类目各拿一个歌单，凑出 40 首候选
  const picked = [];
  for (const c of HOME_CATS) {
    try {
      const pls = await neTopPlaylists(c.cat, 10);
      if (!pls.length) continue;
      // 用种子挑两个歌单，保证同一天固定
      for (let k = 0; k < 2; k++) {
        const pl = pls[Math.floor(rnd() * pls.length)];
        if (!pl) continue;
        const d = await nePlaylistTracks(pl.id.slice(4), 50);
        for (const t of d.tracks) picked.push(t);
      }
    } catch {}
  }
  if (picked.length < 10) return [];

  /* ⚠️ 光从网易云歌单拿歌，音频就全是网易云一家的——
     VIP 歌多、源单一、且没体现「聚合」这个卖点。
     这里再拿一批同名歌去 YouTube / B站 / 酷我 搜，把音频来源打散。
     做法：从已拿到的网易云歌里抽几首当关键词，
     去其他平台搜，只要歌名对得上就当作「同一首歌的另一个源」。 */
  /* ⚠️ 只拿 4 个种子（不是 6）—— 每个种子要打 3 个平台，
     6 个就是 18 个请求，实测超过 6 秒，主页等不起。 */
  const seeds = shuffleWith(picked, seeded("seed-" + todayKey())).slice(0, 4);
  const extra = [];
  // ⚠️ 串行搜 6 首 × 3 平台 = 18 个请求，很慢（实测 5.7s）。
  //    改成先把 6 首的三平台搜索全并发出去，再逐个挑结果。
  const seedInfo = seeds
    .map((seed) => {
      const name = cleanSongTitle(seed.name || "");
      const artist = cleanArtistName((seed.artists && seed.artists[0] && seed.artists[0].name) || "");
      return name.length >= 2 ? { seed, name, artist, kw: artist ? name + " " + artist : name } : null;
    })
    .filter(Boolean);
  const searched = await Promise.all(
    seedInfo.map((x) =>
      Promise.all([
        ytSearch(x.kw).catch(() => []),
        biliSearch(x.kw, 6).catch(() => []),
        kuwoSearch(x.kw).catch(() => []),
      ])
    )
  );
  for (let si = 0; si < seedInfo.length; si++) {
    const { seed, name, artist } = seedInfo[si];
    const [yt, bi, kw2] = searched[si];
    /* YouTube：优先 Topic 频道（官方发行版），没有就找标题含歌名的。
       ⚠️ 之前只认 Topic，但很多华语歌在 YouTube 根本没有 Topic 频道，
          结果搜十首一首都拿不到。现在放宽到「标题含歌名」即可。 */
    const wantSec = Math.round((Number(seed.duration) || 0) / 1000);
    const ytHit =
      (yt || []).find((t) => /-\s*Topic$/i.test(t.artist || "")) ||
      (yt || []).find((t) => {
        if (normTitle(t.title).indexOf(normTitle(name)) < 0) return false;
        if (/live|现场|現場|cover|翻唱|伴奏|remix|合集|串烧|vietsub|tiktok/i.test(t.title || ""))
          return false;
        const sec = parseDur(t.durationText) / 1000;
        if (wantSec > 0 && sec > 0 && Math.abs(sec - wantSec) > 20) return false;
        return true;
      });
    if (ytHit)
      extra.push({
        id: "yt:" + ytHit.id,
        name: ytHit.title || name,
        artists: [{ name: cleanArtistName(ytHit.artist || artist) }],
        album: {},
        artwork: ytHit.artwork || "",
        duration: parseDur(ytHit.durationText) || seed.duration,
        provider: "youtube",
      });
    // B站：取标题含歌名的那条
    const biHit = (bi || []).find((t) => normTitle(t.title).indexOf(normTitle(name)) >= 0);
    if (biHit)
      extra.push({
        id: "bi:" + biHit.bvid,
        name: biHit.title || name,
        artists: [{ name: biHit.author || "bilibili" }],
        album: {},
        artwork: biHit.pic || "",
        duration: parseDur(biHit.duration) || seed.duration,
        provider: "bilibili",
      });
    // 酷我：歌名对得上就要
    const kwHit = (kw2 || []).find((t) => normTitle(t.title).indexOf(normTitle(name)) >= 0);
    if (kwHit)
      extra.push({
        id: "kw:" + kwHit.id,
        name: kwHit.title || name,
        artists: [{ name: kwHit.artist || artist }],
        album: kwHit.album ? { name: kwHit.album } : {},
        artwork: kwHit.artwork || "",
        duration: kwHit.duration || seed.duration,
        provider: "kuwo",
      });
  }
  // 把外部源的歌插进候选池（占四成左右，不让它们全占）
  for (const t of extra.slice(0, 12)) picked.push(t);

  // 同歌手最多 2 首
  const byArtist = new Map();
  const kept = [];
  for (const t of shuffleWith(picked, rnd)) {
    // 剔掉明显是翻唱/伴奏的（标题里写着 cover/翻唱）
    if (/cover|翻唱|翻自|伴奏|卡拉\s*ok|karaoke/i.test(String(t.name || ""))) continue;
    const a = ((t.artists && t.artists[0] && t.artists[0].name) || "").toLowerCase();
    const n = byArtist.get(a) || 0;
    if (n >= 2) continue;
    byArtist.set(a, n + 1);
    kept.push(t);
    if (kept.length >= 34) break;
  }
  if (kept.length < 6) return kept;

  // 剔掉网易云明确播不了的（VIP / 无版权）—— 用统一的 playableOnly
  const base = playableOnly(kept);

  // 全列表打散，再在三分之二处插一首「反差」（取最后那首换到那个位置）
  const out = shuffleWith(base, rnd);
  if (out.length >= 9) {
    const contrast = out.pop();
    out.splice(Math.floor(out.length * 0.66), 0, contrast);
  }
  const final = out.slice(0, 30);
  /* ⚠️ 首页「拼好歌」大横幅取每首 track 的封面显示。
     MyGo 从 track.album.imageUrl 读封面（不是顶层 artwork）。
     todayMix 混进来的跨平台曲目（yt/bi/kw）album 是空对象，
     不补 imageUrl 的话第一首若是这类曲就显示空/fallback 封面。
     这里统一把 artwork 同步到 album.imageUrl，保证所有曲都有封面。 */
  for (const t of final) if (t) sinkThumb(t);

  try {
    host.storage.set(cacheKey, final.map(snapshot).filter(Boolean));
  } catch {}
  return final;
}

/* 分类拼单：拿该分类热门歌单的曲目，再抽几首去其他平台找同歌，
   让音频来源分散。每个分类缓存一天。 */
/* catMix(c, slot)
   slot=0 是首页第一张卡片（也是首页展示的那批），slot=1 是第二张卡片。
   ⚠️ 两单的随机种子必须不同，否则两张卡片内容一模一样。
      但同一天、同一个 slot 必须稳定 —— 用户点进卡片看到的就是首页那张的内容。 */
async function catMix(c, slot = 0) {
  const cacheKey = "cat:v" + CACHE_VER + ":" + c.key + ":" + slot + ":" + todayKey();
  try {
    const cached = host.storage.get(cacheKey);
    if (Array.isArray(cached) && cached.length >= 6)
      return playableOnly(cached.map(unsnapshot).filter(Boolean));
  } catch {}

  const rnd = seeded("cat-" + c.key + "-" + slot + "-" + todayKey());
  const pls = await neTopPlaylists(c.cat, 12);
  if (!pls.length) return [];
  const picked = [];
  for (let k = 0; k < 2; k++) {
    const pl = pls[Math.floor(rnd() * pls.length)];
    if (!pl) continue;
    try {
      const d = await nePlaylistTracks(pl.id.slice(4), 40);
      for (const t of d.tracks) picked.push(t);
    } catch {}
  }
  if (picked.length < 6) return playableOnly(picked);

  // 抽 3 首当种子，去其他平台找同歌
  const seeds = shuffleWith(picked, rnd).slice(0, 3);
  const seedInfo = seeds
    .map((seed) => {
      const name = cleanSongTitle(seed.name || "");
      const artist = cleanArtistName((seed.artists && seed.artists[0] && seed.artists[0].name) || "");
      return name.length >= 2 ? { seed, name, artist, kw: artist ? name + " " + artist : name } : null;
    })
    .filter(Boolean);
  const searched = await Promise.all(
    seedInfo.map((x) =>
      Promise.all([
        ytSearch(x.kw).catch(() => []),
        biliSearch(x.kw, 5).catch(() => []),
        kuwoSearch(x.kw).catch(() => []),
      ])
    )
  );
  const extra = [];
  for (let si = 0; si < seedInfo.length; si++) {
    const { seed, name, artist } = seedInfo[si];
    const [yt, bi, kw2] = searched[si];
    const wantSec = Math.round((Number(seed.duration) || 0) / 1000);
    const ytHit =
      (yt || []).find((t) => /-\s*Topic$/i.test(t.artist || "")) ||
      (yt || []).find((t) => {
        if (normTitle(t.title).indexOf(normTitle(name)) < 0) return false;
        if (/live|现场|現場|cover|翻唱|伴奏|remix|vietsub|tiktok/i.test(t.title || "")) return false;
        const sec = parseDur(t.durationText) / 1000;
        if (wantSec > 0 && sec > 0 && Math.abs(sec - wantSec) > 20) return false;
        return true;
      });
    if (ytHit)
      extra.push({
        id: "yt:" + ytHit.id,
        name: ytHit.title || name,
        artists: [{ name: cleanArtistName(ytHit.artist || artist) }],
        album: {},
        artwork: ytHit.artwork || "",
        duration: parseDur(ytHit.durationText) || seed.duration,
        provider: "youtube",
      });
    const biHit = (bi || []).find((t) => normTitle(t.title).indexOf(normTitle(name)) >= 0);
    if (biHit)
      extra.push({
        id: "bi:" + biHit.bvid,
        name: biHit.title || name,
        artists: [{ name: biHit.author || "bilibili" }],
        album: {},
        artwork: biHit.pic || "",
        duration: parseDur(biHit.duration) || seed.duration,
        provider: "bilibili",
      });
    const kwHit = (kw2 || []).find((t) => normTitle(t.title).indexOf(normTitle(name)) >= 0);
    if (kwHit)
      extra.push({
        id: "kw:" + kwHit.id,
        name: kwHit.title || name,
        artists: [{ name: kwHit.artist || artist }],
        album: kwHit.album ? { name: kwHit.album } : {},
        artwork: kwHit.artwork || "",
        duration: kwHit.duration || seed.duration,
        provider: "kuwo",
      });
  }

  // 网易云原本的 + 其他平台的，混在一起
  const pool = playableOnly(picked).concat(extra);
  const byArtist = new Map();
  const kept = [];
  for (const t of shuffleWith(pool, rnd)) {
    if (/cover|翻唱|翻自|伴奏|karaoke/i.test(String(t.name || ""))) continue;
    const a = ((t.artists && t.artists[0] && t.artists[0].name) || "").toLowerCase();
    const n = byArtist.get(a) || 0;
    if (n >= 2) continue;
    byArtist.set(a, n + 1);
    kept.push(t);
    if (kept.length >= 16) break;
  }
  /* ⚠️ 返回前就把 VIP/下架剔干净，并且**缓存过滤后的结果**。
     之前缓存的是未过滤的 16 首，首页卡片显示「16 首」，
     点进去 playlist() 再过滤一次只剩 8 首 —— 数量和实际对不上，
     用户以为丢歌了。现在两边看到的是同一份数据。 */
  const base = kept.length >= 6 ? kept : playableOnly(picked).slice(0, 12);
  /* ⚠️ VIP 不删，只排在后面 —— 删了华语分类只剩 6 首（热歌一半是 VIP）。
     MyGo 播 VIP 歌会走 YouTube 兜底，能出声，没必要剔掉。
     只剔真正播不了的：下架（st<0）、有声书、歌词版/翻唱版本。 */
  const out = base
    .filter((t) => {
      if (!t) return false;
      if (typeof t._st === "number" && t._st < 0) return false;
      if (isAudiobook(t.name, (t.artists && t.artists[0] && t.artists[0].name) || "", (t.album && t.album.name) || "")) return false;
      if (/歌词版|歌詞版|lyrics|Lyrics|翻唱|cover|Cover/i.test(String(t.name || ""))) return false;
      return true;
    })
    // 能直接播的排前面，VIP 的沉底（数量保持不变，只是顺序）
    .sort((a, b) => (a._fee === 1 ? 1 : 0) - (b._fee === 1 ? 1 : 0));
  /* ⚠️ 分类卡片的封面走 cover() 读 album.imageUrl —— 跨平台曲目 album 是空对象，
     不补的话卡片封面就空。统一同步 artwork → album.imageUrl。 */
  for (const t of out) if (t) sinkThumb(t);
  try {
    host.storage.set(cacheKey, out.map(snapshot).filter(Boolean));
  } catch {}
  return out;
}

/* ---------------- 电台 ----------------
   两种台并存：
   ① 「分类台」（radio:<key>）：无尽头混播 —— stationNext 每次给一批
      真实可播的跨平台轨道，内容复用 HOME_CATS 的分类拼单。
   ② 「真电台」（radio:<流地址>）：真·网络收音机 —— 直连公开直播流
      （蜻蜓FM / Icecast 之类），用 ffmpeg 把直播流实时转成 MP3 推给
      MyGo。直播流本身是无限的，所以 stationNext 每次都返回同一个
      "直播轨"，播完再要就是同一条流，实现无缝续播。 */
const RADIO_STATIONS = HOME_CATS.map((c) => ({
  id: "radio:" + c.key,
  name: c.title + " 电台",
  description: c.cat + " · 无尽头混播",
  imageUrl: "",
}));

/* 电台的真实分类维度 —— 语种 / 年代 / 风格。
   ⚠️ 每个维度下的 cat 直接喂给网易云歌单接口的分类名,
      所以必须是网易真实存在的分类词（乱写会返回空歌单）。 */
const RADIO_DIMS = [
  {
    key: "lang",
    title: "按语种",
    cats: [
      { key: "lang_huayu", cat: "华语", title: "华语" },
      { key: "lang_oumei", cat: "欧美", title: "欧美" },
      { key: "lang_rihan", cat: "日语", title: "日韩" },
      { key: "lang_yue", cat: "粤语", title: "粤语" },
      { key: "lang_xiaoyuzhong", cat: "小语种", title: "小语种" },
    ],
  },
  {
    key: "era",
    title: "按年代",
    cats: [
      { key: "era_80", cat: "80年代", title: "80年代" },
      { key: "era_90", cat: "90年代", title: "90年代" },
      { key: "era_00", cat: "00年代", title: "00年代" },
      { key: "era_10", cat: "10年代", title: "10年代" },
      { key: "era_20", cat: "20年代", title: "20年代" },
    ],
  },
  {
    key: "style",
    title: "按风格",
    cats: [
      { key: "st_rock", cat: "摇滚", title: "摇滚" },
      { key: "st_minyao", cat: "民谣", title: "民谣" },
      { key: "st_dianzi", cat: "电子", title: "电子" },
      { key: "st_gufeng", cat: "古风", title: "古风" },
      { key: "st_shuochang", cat: "说唱", title: "说唱" },
      { key: "st_gudian", cat: "古典", title: "古典" },
      { key: "st_jazz", cat: "爵士", title: "爵士" },
    ],
  },
];

/* 扁平化的一张表：key → {cat,title}，供 stationNext 查归类目 */
const RADIO_CAT_MAP = (() => {
  const m = new Map();
  for (const d of RADIO_DIMS) for (const c of d.cats) m.set(c.key, c);
  return m;
})();

/* 每个维度下的台卡（id 形如 radio:<catKey>）。
   封面用该分类热门歌单的第一张封面 —— 真实、且和该分类的内容相关。
   取不到才回落兜底图。缓存一天，避免每次进电台页都打网络。 */
async function radioStationsOfDim(dim) {
  return Promise.all(
    dim.cats.map(async (c) => {
      let cover = "";
      const ck = "radioCover:" + c.key + ":" + todayKey();
      try {
        const cached = host.storage.get(ck);
        if (cached) cover = String(cached);
      } catch {}
      if (!cover) {
        try {
          /* ⚠️ 有些分类（80年代/90年代）热门歌单前几位会重合，
             导致不同台拿到同一张封面。按 key 哈希错开取第几张。 */
          const pls = await neTopPlaylists(c.cat, 8);
          let h = 0;
          for (const ch of c.key) h = (h * 31 + ch.charCodeAt(0)) | 0;
          const idx = Math.abs(h) % Math.max(1, pls.length);
          cover = (pls[idx] && pls[idx].imageUrl) || (pls[0] && pls[0].imageUrl) || "";
          if (cover) {
            try {
              host.storage.set(ck, cover);
            } catch {}
          }
        } catch {}
      }
      return {
        id: "radio:" + c.key,
        name: c.title + " 电台",
        description: c.cat + " · 无尽头混播",
        imageUrl: cover || FALLBACK_COVER,
      };
    })
  );
}

/* 真·网络收音机：公开直播流（候选源列表）。
   ⚠️ 选源原则：必须是公开直链的 MP3/AAC 直播流（不是点播），
      ffmpeg 能一直读下去；HLS(m3u8) 也行，ffmpeg 会自己处理分片。
   这些是内置候选源 —— stations() 返回的台就是用户可选列表，
   点哪个台播哪个台，网络环境变了也不会全丢，可新增候选源。
   stream() 的 radio: 分支会先试直连（mp3 直播流直接播，不转码），
   直连不通/格式怪才用 ffmpeg 转码兜底。
   ⚠️ 不同平台混着挂，别清一色一个服务商：
     · 蜻蜓FM（华语，中文用户核心 —— 流带 86 字节 junk 头，
       直连探测会超时，靠 forceTranscode 直接跳过直连）
     · SomaFM / Radio Paradise（美国公开台，直连就是干净 mp3）
     · Radio France FIP / France Inter（法国，直连 mp3/aac）
     · NTS Radio（英国地下音乐，直连 mp3）
     · Classic FM（英国古典）、Antenne / bayern3（德国流行）
   forceTranscode=true 的台跳过直连探测，直接上 ffmpeg 转码
   —— 因为直连那一步对这类带 junk 头/封装的流只会白等超时。 */
const LIVE_RADIOS = [
  { key: "qt_pop",  name: "华语流行台",    desc: "蜻蜓FM · 华语流行直播",   url: "https://lhttp.qtfm.cn/live/4915/64k.mp3", forceTranscode: true, logo: "https://somafm.com/img3/poptron-400.jpg" },
  { key: "qt_city", name: "城市音乐台",    desc: "蜻蜓FM · 城市音乐直播",   url: "https://lhttp.qtfm.cn/live/4930/64k.mp3", forceTranscode: true, logo: "https://somafm.com/img3/indiepop-400.jpg" },
  { key: "fip",     name: "FIP 法国音乐台", desc: "Radio France · 现代流行", url: "https://icecast.radiofrance.fr/fip-midfi.mp3", logo: "https://somafm.com/img3/suburbsofgoa-400.jpg" },
  { key: "france",  name: "France Inter",  desc: "Radio France · 综合",     url: "https://icecast.radiofrance.fr/franceinter-hifi.aac", logo: "https://somafm.com/img3/secretagent-400.jpg" },
  { key: "soma",    name: "SomaFM 音乐台", desc: "SomaFM · 英文驰放",       url: "https://ice1.somafm.com/groovesalad-128-mp3", logo: "https://somafm.com/img3/groovesalad-400.jpg" },
  { key: "soma2",   name: "SomaFM 环境台", desc: "SomaFM · 氛围电子",       url: "https://ice1.somafm.com/dronezone-128-mp3", logo: "https://somafm.com/img3/dronezone-400.jpg" },
  { key: "nts",     name: "NTS Radio",     desc: "NTS · 英伦地下/世界音乐", url: "https://stream-relay-geo.ntslive.net/stream", logo: "https://somafm.com/img3/beatblender-400.jpg" },
  { key: "rp",      name: "Radio Paradise",desc: "Mix · 精选综合",          url: "https://stream.radioparadise.com/mp3-192", logo: "https://somafm.com/img3/fluid-400.jpg" },
  { key: "classic", name: "Classic FM 古典", desc: "UK · 古典音乐",          url: "https://media-ice.musicradio.com/ClassicFMMP3", logo: "https://somafm.com/img3/lush-400.jpg" },
  { key: "antenne", name: "Antenne 巴伐利亚", desc: "DE · 流行",            url: "https://s5-webradio.antenne.de/antenne/stream/mp3", logo: "https://somafm.com/img3/covers-400.jpg" },
];

/* 真电台台卡（id 里带上流地址，stationNext 直接读出来转码）。
   imageUrl 用统一的封面占位，避免电台页空图。 */
const LIVE_STATIONS = LIVE_RADIOS.map((r) => ({
  id: "radios:" + r.url,
  name: r.name,
  description: r.desc,
  // 每个台用各自的台标封面，不再全用同一张兜底图
  imageUrl: r.logo || FALLBACK_COVER,
}));

/* 电台/播客专用过滤：直接踢掉网易 VIP/下架轨，不设"太少就放行"的兜底
   —— 因为电台是连续播放，放进去一首播不了的就把整个台卡死。
   跨平台轨(yt/bi/kw/qq)不标 fee，天然保留。 */
function radioSafe(list) {
  return (list || []).filter((t) => {
    if (!t) return false;
    const id = String(t.id || "");
    if (id.startsWith("ne:") && (t._fee === 1 || (typeof t._st === "number" && t._st < 0))) return false;
    return true;
  });
}

export async function stations() {
  // 分类混播台（真网络收音机由 browse 的 stations 分支单独用卡片挂出来，
  // 避免和这里的重复）
  return RADIO_STATIONS;
}

export async function stationNext({ id }) {
  const p = String(id || "");

  /* 真·网络收音机：返回一条"直播轨"。
     直播流是无限的，播完（其实不会自然播完）再要就是同一条流。
     stream() 的 radio: 分支会把这条流用 ffmpeg 实时转成 MP3。 */
  if (p.startsWith("radios:")) {
    const url = p.slice(7);
    const st = LIVE_RADIOS.find((r) => r.url === url);
    const name = (st && st.name) || "网络电台";
    const track = {
      id: "radio:" + url,
      name: name + " · 直播",
      artists: [{ name: "网络收音机" }],
      album: { name: name, imageUrl: FALLBACK_COVER },
      artwork: FALLBACK_COVER,
      duration: undefined, // 直播没有时长
    };
    // 记下元数据，stream() 要靠它知道这条 id 对应哪条流
    try {
      trackMeta.set(track.id, {
        name: track.name,
        artist: "网络收音机",
        audio: url,
        servedFrom: "radio",
        // 蜻蜓这类带 junk 头的流，直连探测只会在那块白等超时 —— 标记直接转码
        forceTranscode: !!(st && st.forceTranscode),
      });
    } catch {}
    return [track];
  }

  /* 分类混播台：先查真实分类维度（语种/年代/风格），
     再退回首页那 8 个分类（兼容老 id）。 */
  const rawKey = p.startsWith("radio:") ? p.slice(6) : "";
  let c = RADIO_CAT_MAP.get(rawKey);
  if (!c) c = HOME_CATS.find((x) => x.key === rawKey);
  if (!c) {
    // id 不认识 → 默认第一个分类台，别让播放器空转
    const fallback = RADIO_STATIONS[0];
    c = HOME_CATS.find((x) => x.key === fallback.id.slice(6));
  }
  if (!c) return [];
  try {
    const mix = await catMix(c);
    const safe = radioSafe(mix);
    return safe.length ? safe : mix && mix.length ? mix : [];
  } catch {
    return [];
  }
}

/* ---------------- 播客（专辑当节目） ----------------
   把几个分类做成「节目」，show() 返回该分类的曲目当单集。
   播客的集数本就该是能播的轨道，复用分类拼单最稳。 */
/* 播客字幕提取：从 RSS item 的 description 里提取歌词文本。
   很多中文播客的 description 直接放了带时间戳的歌词，这里去标签、
   保留歌词文本作为 transcript（带时间轴的优先，无则纯文本歌词，仍算有效字幕）。 */
function extractTranscript(desc) {
  if (!desc) return "";
  let text = desc.replace(/<[^>]+>/g, "");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length < 10) return "";
  return text.slice(0, 1000);
}

/* ============================ 播客 ============================
 * 用 **Apple Podcasts（iTunes Search）** 当目录，RSS 当内容源。
 * 为什么选它：它是全球最大的播客目录，绝大多数中文播客的 RSS 都登记在这里 ——
 *   实测搜「忽左忽右」直接返回 JustPod 的节目（654 集），
 *   feedUrl 指向 feed.xyzfm.space（小宇宙的托管域名）；
 *   搜到的另一个版本 feedUrl 是 ximalaya.com/album/*.xml（喜马拉雅）。
 *   换句话说：**接了 Apple 目录 = 同时覆盖小宇宙 + 喜马拉雅 + 独立播客**，
 *   不用挨个平台去逆向接口。
 * 音频直链也在 RSS 里（enclosure），实测是小宇宙 CDN 的 m4a，
 * HTTP 200 / audio/mp4，MyGo 能直接播。
 * ============================================================== */
const APPLE_PODCAST = "https://itunes.apple.com/search";
const podcastFeedCache = new Map();   // feedUrl → { at, items }
/* 节目卡缓存：id → Show 卡片。
   订阅时 MyGo 只传 id，不传节目信息，得靠这个补全卡片。
   ⚠️ 只是内存缓存，重启会丢；丢了就靠 show() 再查一次补回来。 */
const showMeta = new Map();

/* 搜节目 */
/* ============ 网易云电台搜索（补 Apple 中国区的空缺） ============
   ⚠️ 为什么需要这个源（2026-11-09 实测）：
      Apple Podcasts 中国区的播客内容很少，41 个分类里有 15 个搜不到任何节目
      （旅行/游戏/法律/军事/设计/摄影/汽车/动漫/职场/地理/女性 全部 0 条）。
      而网易云电台（type=1009）每个词都能返回 30 个真实中文节目。
   ⚠️ 但网易云电台**不给 RSS 地址**，只有 id/picUrl/desc/name ——
      所以它只能用来「发现节目」，播放要靠 playdj() 单独取流。
   接口：POST https://music.163.com/api/search/get
        body: s=<关键词>&type=1009&limit=20&offset=0
        ⚠️ type=1009 是「电台」，1002 是「用户」，别写错。
   ============================================================ */
async function nePodcastSearch(term, limit = 20) {
  try {
    const body = "s=" + encodeURIComponent(term) + "&type=1009&limit=" + limit + "&offset=0";
    const { text } = await fetchText("https://music.163.com/api/search/get", {
      method: "POST",
      headers: {
        "User-Agent": uaDesktop(),
        Referer: "https://music.163.com/",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body,
      signal: AbortSignal.timeout(12000),
    });
    const j = JSON.parse(text);
    const list = (j && j.result && j.result.djRadios) || [];
    return list.map((x) => ({
      // 用 ndj: 前缀标明这是网易云电台（没有 feedUrl，走 play 分支）
      id: "ndj:" + String(x.id || x.radioId || ""),
      name: String(x.name || "未命名电台"),
      imageUrl: String(x.picUrl || x.picURL || ""),
      description: String(x.desc || x.description || "").replace(/<[^>]+>/g, "").slice(0, 120),
      publisher: String((x.dj && x.dj.nickname) || x.nickname || ""),
      episodeCount: Number(x.programCount || x.programCnt) || 0,
      _ne: true,
    })).filter((x) => x.id !== "ndj:");
  } catch (e) {
    trace("nePodcastSearch 失败", String((e && e.message) || e).slice(0, 60));
    return [];
  }
}

/* ============ 播客小镇（podtown.xyz）—— 中文播客精选目录 ============
   ⚠️ 为什么接它（2026-11-09）：
      Apple 中国区内容稀薄（15/41 分类搜不到），网易云电台又没有 RSS、
      播放信息不全。播客小镇是**人工策展的中文播客地图**，280 个节目，
      每条都带 rss / cover / author / description / 多平台链接，质量很高。

   数据源：https://podtown-1251175174.file.myqcloud.com/2022/public.json（324KB 静态 JSON）
     ⚠️ 这个 COS 域名**必须直连、不能走代理** —— 走代理会 403，
        但它是国内腾讯云 CDN，本来就不需要代理。
     ⚠️ api.podtown.xyz 有 Cloudflare 反爬（一律 418 I'm a teapot），不要用那个。

   本地按天缓存，280 条 × ~1KB ≈ 300KB，只取检索需要的字段压到 ~80KB。 */
const PODTOWN_JSON = "https://podtown-1251175174.file.myqcloud.com/2022/public.json";
let podtownCache = null; // { at, list }

async function podtownList() {
  if (podtownCache && Date.now() - podtownCache.at < 12 * 60 * 60 * 1000) {
    return podtownCache.list;
  }
  // 先试本地按天缓存
  const ck = "podtown:" + todayKey();
  try {
    const v = host.storage.get(ck);
    if (Array.isArray(v) && v.length) {
      podtownCache = { at: Date.now(), list: v };
      return v;
    }
  } catch {}
  try {
    const { text } = await fetchText(PODTOWN_JSON, {
      headers: { "User-Agent": uaDesktop(), Referer: "https://podtown.xyz/" },
      signal: AbortSignal.timeout(20000),
    });
    const j = JSON.parse(text);
    const items = (j && j.data && j.data.items) || [];
    const list = items
      .filter((x) => x && x.rss && x.title)
      .map((x) => ({
        id: "pod:" + String(x.id || x.rss).slice(-24) + "|" + encodeURIComponent(x.rss),
        name: String(x.title || ""),
        imageUrl: String(x.cover || ""),
        description: String(x.description || "").slice(0, 160),
        publisher: String(x.author || ""),
        episodeCount: 0,
        _podtown: true,
      }));
    if (list.length) {
      podtownCache = { at: Date.now(), list: list };
      try {
        host.storage.set(ck, list);
      } catch {}
      console.log("[葫芦] 播客小镇载入 " + list.length + " 个节目");
    }
    return list;
  } catch (e) {
    trace("podtown 载入失败", String((e && e.message) || e).slice(0, 60));
    return [];
  }
}

/** 在播客小镇目录里按关键词本地过滤（标题/作者/简介三处匹配） */
async function podtownSearch(term, limit = 20) {
  const all = await podtownList();
  if (!all.length) return [];
  const q = String(term || "").trim().toLowerCase();
  if (!q) return [];
  const simp = toSimplified(q);
  const hit = [];
  for (const x of all) {
    const hay = (x.name + " " + x.publisher + " " + x.description).toLowerCase();
    const hayS = toSimplified(hay);
    if (hay.indexOf(q) >= 0 || hayS.indexOf(simp) >= 0) {
      hit.push(x);
      if (hit.length >= limit) break;
    }
  }
  return hit;
}

async function podcastSearch(term, limit = 20) {
  try {
    const url = APPLE_PODCAST + "?term=" + encodeURIComponent(term) +
      "&entity=podcast&limit=" + limit + "&country=cn";
    // 同样必须带超时：Apple 目录偶尔会挂住，把整个播客页拖死
    const { text } = await fetchText(url, {
      headers: { "User-Agent": uaDesktop() },
      signal: AbortSignal.timeout(15000),
    });
    const j = JSON.parse(text);
    const list = (j.results || []).map((x) => ({
      /* id 里带上 feedUrl（编码后）—— MyGo 只回传 id，
         不给 feedUrl 就再也找不到这个节目的 RSS 了。 */
      id: "pod:" + String(x.collectionId || "") + "|" + encodeURIComponent(x.feedUrl || ""),
      name: x.collectionName || "未知节目",
      imageUrl: x.artworkUrl600 || x.artworkUrl100 || PODCAST_FALLBACK_COVER,
      description: (x.artistName ? "by " + x.artistName : "") +
        (x.trackCount ? " · " + x.trackCount + " 集" : ""),
      publisher: x.artistName || "",
      episodeCount: Number(x.trackCount) || 0,
      _feed: x.feedUrl || "",
    })).filter((x) => x._feed);
    /* 顺手把节目卡缓存下来 —— 用户可能直接在列表上点订阅，
       那一刻 MyGo 只回传 id，没缓存就只能存个没名字的空卡。 */
    for (const s of list) {
      showMeta.set(s.id, {
        id: s.id,
        name: s.name,
        imageUrl: s.imageUrl,
        description: s.description,
        publisher: s.publisher,
        episodeCount: s.episodeCount,
      });
    }
    return list;
  } catch {
    return [];
  }
}

/* 简单 XML 字段提取（不引第三方库）。
   ⚠️ 正则写在字符串里，所有反斜杠必须写两遍（\\s、\\[、\\S），
      JS 字符串字面量会把 \s、\[ 这种非转义序列的反斜杠静默剥掉，
      导致字符类错乱、`Unmatched ')'` 报错，RSS 直接解析不出单集。 */
function xmlPick(str, tag) {
  const c = new RegExp("<" + tag + "(?:\\s[^>]*)?>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>", "i").exec(str);
  if (c) return c[1].trim();
  const p = new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i").exec(str);
  if (p) return p[1].replace(/<[^>]+>/g, "").trim();
  return "";
}
function xmlAttr(str, tag, attr) {
  // 纯字符串切分，不用正则 —— 避免转义层层吃掉反斜杠
  const open = '<' + tag;
  const key = attr + '=' + '"';
  let i = 0;
  while (true) {
    const at = str.indexOf(open, i);
    if (at < 0) return '';
    const close = str.indexOf('>', at);
    if (close < 0) return '';
    const raw = str.slice(at, close);
    const k = raw.indexOf(key);
    if (k >= 0) {
      const vs = k + key.length;
      const ve = raw.indexOf('"', vs);
      if (ve > vs) return raw.slice(vs, ve);
    }
    i = close + 1;
  }
}

/* 拉 RSS 单集（带 10 分钟缓存，RSS 有 3MB，不能每次请求都重下） */
async function podcastEpisodes(feedUrl) {
  const hit = podcastFeedCache.get(feedUrl);
  // 空结果不缓存 —— 解析失败时缓存了空数组，修好逻辑后也永远拿不到新数据
  if (hit && hit.items.length && Date.now() - hit.at < 10 * 60 * 1000) return hit.items;
  try {
    /* ⚠️ 必须带超时。实测有 RSS 源（喜马拉雅/部分独立托管）会一直挂着不返回，
       导致 shows() / show() 无限阻塞 —— 表现是「播客页转圈」或测试卡死。
       20 秒拿不到就当失败，走空数组。 */
    const { text: xml } = await fetchText(feedUrl, {
      headers: { "User-Agent": uaDesktop() },
      signal: AbortSignal.timeout(20000),
    });
    console.log("[DBG] RSS " + feedUrl.slice(0, 50) + " → " + (xml ? xml.length : 0) + " bytes, item@ " + (xml || "").indexOf("item"));
    /* RSS 的频道封面。⚠️ 这里**不要**填兜底图 —— 留空让上层（show/shows）
       自己按优先级挑：列表页 Apple 封面 > RSS 频道图 > 兜底。
       填了兜底图，上层就分不清"真没图"和"拿到的就是兜底"。 */
    const channelImg = xmlAttr(xml.split("<item")[0], "itunes:image", "href") || "";
    /* 手写切分，不用正则 —— 之前 string 里的 \s 被层层转义吃掉，
       变成了「item[s>]」，一个都切不出来（raw=654 但 items=0 就是这么来的）。
       规则：找 "<item" 后面紧跟空白或 ">" 的位置。 */
    const raw = [];
    {
      const LT = "<item";
      let i = 0;
      while (true) {
        const at = xml.indexOf(LT, i);
        if (at < 0) break;
        const nx = xml.charAt(at + LT.length);
        const code = nx.charCodeAt(0);
        // 62='>'  32=' '  10=LF  13=CR  9=TAB
        if (code === 62 || code === 32 || code === 10 || code === 13 || code === 9) {
          const nxt = xml.indexOf(LT, at + LT.length);
          raw.push(xml.slice(at + LT.length, nxt < 0 ? xml.length : nxt));
          if (nxt < 0) break;
          i = nxt;
        } else {
          i = at + LT.length;
        }
      }
    }
    const items = [];
    let dbgNoAudio = 0;
    for (const it of raw) {
      const audio = xmlAttr(it, "enclosure", "url");
      if (!audio) { dbgNoAudio++; continue; }
      const title = xmlPick(it, "title") || "未命名单集";
      const pub = xmlPick(it, "pubDate");
      let dur = xmlPick(it, "itunes:duration");
      // duration 可能是 "01:32:46" 或纯秒数
      let ms = 0;
      if (/^\d+$/.test(dur)) ms = Number(dur) * 1000;
      else if (dur.indexOf(":") >= 0) {
        const parts = dur.split(":").map((x) => Number(x) || 0);
        ms = ((parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0)) * 1000;
      }
      items.push({
        id: "pode:" + (xmlPick(it, "guid") || audio),
        name: title.replace(/\s+/g, " ").trim(),
        artists: [{ name: xmlPick(it, "itunes:author") || "" }],
        // 单集封面：RSS 频道图 → 单集自己的 itunes:image → 播客兜底图
        artwork: channelImg || xmlAttr(it, "itunes:image", "href") || PODCAST_FALLBACK_COVER,
        album: { name: xmlPick(xml.split("<item")[0], "title") || "", imageUrl: channelImg },
        duration: ms || undefined,
        published: pub || undefined,
        description: (xmlPick(it, "description") || "").replace(/<[^>]+>/g, "").slice(0, 200),
        _audio: audio,
        provider: "podcast",
        // 播客字幕：从 description 里提取歌词文本（很多中文播客直接放了歌词）
        transcript: extractTranscript(xmlPick(it, "description")),
      });
    }
    console.log("[DBG] raw=" + raw.length + " items=" + items.length + " noAudio=" + dbgNoAudio);
    podcastFeedCache.set(feedUrl, { at: Date.now(), items });
    return items;
  } catch (e) {
    console.log("[葫芦] 播客 RSS 解析失败 " + feedUrl.slice(0, 60) + ": " + (e && e.message));
    return [];
  }
}

/* 播客类别 —— 播客页按这些类别分组做列表。
   每个类别配一组中文搜索词，去 Apple 目录找真实节目；
   找不到也宁可空，不编假节目。 */
const PODCAST_CATS = [
  { key: "music",    title: "音乐",   kws: ["音乐", "摇滚", "古典乐", "华语"],       icon: "music" },
  { key: "tech",     title: "科技",   kws: ["科技", "人工智能", "互联网", "程序"],    icon: "chip" },
  { key: "culture",  title: "文化",   kws: ["文化", "文学", "艺术", "历史"],         icon: "book" },
  { key: "business", title: "商业",   kws: ["商业", "财经", "创业", "投资"],         icon: "chart" },
  { key: "news",     title: "新闻",   kws: ["新闻", "时事", "时政"],                 icon: "news" },
  { key: "story",    title: "故事",   kws: ["故事", "悬疑", "推理", "小说"],         icon: "note" },
  { key: "life",     title: "生活",   kws: ["生活", "情感", "健康", "心理"],         icon: "heart" },
  { key: "edu",      title: "知识",   kws: ["知识", "英语", "外语", "学习"],         icon: "star" },
  { key: "comedy",   title: "喜剧",   kws: ["喜剧", "脱口秀", "搞笑", "相声"],       icon: "star" },
  { key: "movie",    title: "影视",   kws: ["电影", "影视", "剧集"],                 icon: "note" },
  { key: "sport",    title: "运动",   kws: ["运动", "篮球", "足球", "健身"],         icon: "star" },
  { key: "food",     title: "美食",   kws: ["美食", "美食故事", "烹饪"],             icon: "heart" },
  { key: "science",  title: "科学",   kws: ["科学", "物理", "天文", "宇宙"],         icon: "chip" },
  { key: "travel",   title: "旅行",   kws: ["旅行", "旅游", "户外"],                 icon: "star" },
  { key: "game",     title: "游戏",   kws: ["游戏", "电竞", "主机"],                 icon: "star" },
  { key: "society",  title: "社会",   kws: ["社会", "人文", "访谈", "圆桌"],         icon: "news" },
  // —— 2026-11-09 扩充：从 16 类补到 34 类，覆盖更多兴趣面 ——
  { key: "history",  title: "历史",   kws: ["历史", "中国史", "世界史", "古代"],       icon: "book" },
  { key: "philo",    title: "哲学",   kws: ["哲学", "思想", "存在主义"],               icon: "book" },
  { key: "psych",    title: "心理",   kws: ["心理学", "心理", "情绪", "自我成长"],     icon: "heart" },
  { key: "health",   title: "健康",   kws: ["健康", "医学", "养生", "营养"],           icon: "heart" },
  { key: "tech2",    title: "编程",   kws: ["编程", "程序员", "代码", "开发"],         icon: "chip" },
  { key: "ai",       title: "AI",     kws: ["人工智能", "AI", "大模型", "ChatGPT"],    icon: "chip" },
  { key: "startup",  title: "创业",   kws: ["创业", "商业模式", "公司"],               icon: "chart" },
  { key: "invest",   title: "投资",   kws: ["投资", "股票", "经济", "理财"],           icon: "chart" },
  { key: "law",      title: "法律",   kws: ["法律", "案件", "法理"],                   icon: "news" },
  { key: "crime",    title: "案件",   kws: ["案件", "悬案", "真实案件", "罪案"],       icon: "note" },
  { key: "military", title: "军事",   kws: ["军事", "战争", "武器"],                   icon: "star" },
  { key: "design",   title: "设计",   kws: ["设计", "平面设计", "建筑"],               icon: "star" },
  { key: "photo",    title: "摄影",   kws: ["摄影", "相机", "拍照"],                   icon: "star" },
  { key: "car",      title: "汽车",   kws: ["汽车", "新能源车", "驾驶"],               icon: "star" },
  { key: "anime",    title: "动漫",   kws: ["动漫", "二次元", "漫画"],                 icon: "star" },
  { key: "novel",    title: "文学",   kws: ["文学", "小说", "诗歌", "读书"],           icon: "book" },
  { key: "talk",     title: "闲谈",   kws: ["闲聊", "夜谈", "电台", "播客"],           icon: "note" },
  { key: "parent",   title: "亲子",   kws: ["亲子", "育儿", "教育孩子"],               icon: "heart" },
  { key: "career",   title: "职场",   kws: ["职场", "职业", "跳槽", "工作"],           icon: "chart" },
  { key: "english",  title: "英语",   kws: ["英语学习", "英语播客", "口语"],           icon: "star" },
  { key: "finance",  title: "财经",   kws: ["财经", "宏观经济", "美联储"],             icon: "chart" },
  { key: "religion", title: "人文",   kws: ["人文", "宗教", "信仰"],                   icon: "book" },
  { key: "geo",      title: "地理",   kws: ["地理", "国家", "地图"],                   icon: "star" },
  { key: "women",    title: "女性",   kws: ["女性", "性别", "女性成长"],               icon: "heart" },
  { key: "mystery",  title: "未解",   kws: ["未解之谜", "神秘", "灵异"],               icon: "note" },
];

/* 按类别取真实节目（每类 4 个，逐关键词搜，够数即止） */
async function podcastByCategory(cat, want = 4) {
  /* ⚠️ 原来每个关键词只搜 5 条、且是串行 await ——
     要拿 8-10 个节目时，5 条里去掉重复往往不够，得把 4 个关键词全串一遍，
     最慢的情况是 4×1.5s = 6 秒/类。41 类铺首屏根本等不起。
     改成：4 个关键词**并发**搜（各取 18 条），再合并去重取前 want 个。
     并发后单类耗时 ≈ 最慢那一路（约 1.5s），且 podcasSearch 自身有缓存。 */
  const out = [];
  const seen = new Set();
  const addAll = (list) => {
    for (const x of list || []) {
      const k = (x.name || "").toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push({ ...x });
      if (out.length >= want) return true;
    }
    return false;
  };

  /* ① 播客小镇（质量最高：人工策展的真中文播客，且带 RSS 能直接播）
     ⚠️ 它全在内存里，零网络请求（首次载入 324KB JSON 后按天缓存），所以放第一步。
        这是唯一能覆盖「旅行/游戏/法律/设计」等 Apple 空缺分类的 RSS 源。 */
  try {
    const ptLists = await Promise.all(
      cat.kws.slice(0, 3).map((kw) => podtownSearch(kw, 12).catch(() => []))
    );
    if (addAll([].concat(...ptLists))) return out;
  } catch {}

  /* ② Apple（有 RSS，信息最全，但中国区内容少）
     ⚠️ 必须在 ① 之后：Apple 为了凑满 want 会塞进各种泛泛的英文播客，
        先跑它会把播客小镇的好节目挤掉。 */
  const lists = await Promise.all(
    cat.kws.slice(0, 4).map((kw) => podcastSearch(kw, 18).catch(() => []))
  );
  if (addAll([].concat(...lists))) return out;

  /* ③ 还不够 → 网易云电台兜底（中文覆盖最广，但没 RSS，走 play 分支取流） */
  if (out.length < want) {
    const neList = await Promise.all(
      cat.kws.slice(0, 2).map((kw) => nePodcastSearch(kw, 20).catch(() => []))
    );
    addAll([].concat(...neList));
  }
  return out;
}

export async function shows() {
  /* ⚠️⚠️ 订阅的播客必须由插件自己持久化并在这里返回 ——
     MyGo 只在内存里记「已订阅」，重启或刷新播客页时会用
     shows() 的返回值整表覆盖，插件不返回就等于订阅被清空。
     （这是「订阅完又消失」的根因）

     顺序：已订阅的排最前（用户最关心），后面补推荐节目。 */
  const saved = readList(SUBSCRIBED_SHOW_KEY);
  const subscribed = saved.map((s) => ({ ...s, subscribed: true }));

  /* 推荐节目：按类别每组取几个真实节目当门面。
     ⚠️ 这些节目名是「关键词」，拿它去 Apple 搜真实结果；
        Apple 挂了就退化成空列表（宁可空，也不给假节目）。 */
  const groups = await Promise.all(
    PODCAST_CATS.slice(0, 6).map((c) => podcastByCategory(c, 2).catch(() => []))
  );
  const seen = new Set(subscribed.map((s) => String(s.id)));
  const out = subscribed.slice();
  for (const g of groups) {
    for (const x of g) {
      const k = (x.name || "").toLowerCase();
      if (!x.id || seen.has(String(x.id))) continue;
      seen.add(String(x.id));
      out.push(x);
    }
  }
  return out.slice(0, 20);
}

/* 节目详情 + 单集列表。id 里的 feedUrl 用 encodeURIComponent 包着。 */
export async function show({ id, offset }) {
  const raw = String(id || "");

  /* 网易云电台（ndj:<radioId>）—— 没有 RSS，得单独取节目单。
     接口：GET https://music.163.com/api/dj/program/by/radio/<id>?limit=100
     返回 programs[].mainSong（音频 id 走 ne: 那套 outer 302 取流）
     ⚠️ 实测这个接口免登录能用，但**经常返回空列表**（版权/下架），
        拿不到就报明确错误，别让播放器白等。 */
  if (raw.startsWith("ndj:")) {
    const rid = raw.slice(4);
    if (!rid) throw fail("unavailable", "电台 id 为空");
    let list = [];
    try {
      /* ⚠️ 接口名是 `dj/program/byradio?radioId=`，不是 `dj/program/by/radio/<id>`
         （后者返回 {"code":404,"message":"接口未找到！"} —— 实测踩过）。 */
      const { text } = await fetchText(
        "https://music.163.com/api/dj/program/byradio?radioId=" + encodeURIComponent(rid) + "&limit=100&offset=0",
        { headers: { "User-Agent": uaDesktop(), Referer: "https://music.163.com/" }, signal: AbortSignal.timeout(15000) }
      );
      const j = JSON.parse(text);
      list = (j && j.programs) || [];
    } catch (e) {
      trace("电台节目单失败", String((e && e.message) || e).slice(0, 60));
    }
    if (!list.length) throw fail("unavailable", "这个电台暂时取不到节目（可能已下架）");
    const card = showMeta.get(raw) || {};
    const eps = list.map((p) => {
      const song = (p.mainSong && p.mainSong.id) || "";
      const t = {
        id: "ndjp:" + String(p.id || song || ""),
        name: String(p.name || "未命名节目"),
        artists: [{ name: String((p.dj && p.dj.nickname) || card.publisher || "网易电台") }],
        artwork: String((p.coverUrl || (p.mainSong && p.mainSong.album && p.mainSong.album.picUrl)) || card.imageUrl || PODCAST_FALLBACK_COVER),
        album: { name: String(card.name || "网易电台"), imageUrl: card.imageUrl || "" },
        duration: Number(p.duration) || undefined,
        description: String(p.description || "").replace(/<[^>]+>/g, "").slice(0, 200),
        _neSong: song ? String(song) : "",
        provider: "netease-dj",
      };
      // 把音频 id 记到 trackMeta，stream 的 ndjp: 分支要用
      if (song) {
        try {
          trackMeta.set(t.id, {
            name: t.name,
            artist: t.artists[0].name,
            duration: t.duration || 0,
            album: t.album.name,
            artwork: t.artwork,
            neSongId: String(song),
            servedFrom: "netease-dj",
          });
        } catch {}
      }
      return t;
    });
    const page = eps.slice(offset || 0, (offset || 0) + 50);
    return {
      show: { ...card, id: raw, episodeCount: eps.length, episodes: undefined },
      episodes: page,
      more: eps.length > (offset || 0) + 50,
    };
  }

  if (!raw.startsWith("pod:")) throw fail("unavailable", "无法识别的节目");
  const body = raw.slice(4);
  // id 形如 pod:<collectionId>|<encodeURIComponent(feedUrl)>
  const sep = body.indexOf("|");
  if (sep < 0) throw fail("unavailable", "节目缺少 RSS 地址");
  const collectionId = body.slice(0, sep);
  const feedUrl = decodeURIComponent(body.slice(sep + 1));
  const eps = await podcastEpisodes(feedUrl);
  const page = eps.slice(offset || 0, (offset || 0) + 50);
  /* 音频直链存进 trackMeta —— stream() 只拿到 id，得靠这个找地址。 */
  for (const e of page) {
    if (e._audio) {
      trackMeta.set(e.id, {
        name: e.name,
        artist: (e.artists && e.artists[0] && e.artists[0].name) || "",
        duration: e.duration || 0,
        album: (e.album && e.album.name) || "",
        artwork: e.artwork || "",
        audio: e._audio,
        servedFrom: "podcast",
      });
    }
  }
  remember(page);
  /* ⚠️ 封面优先级（踩过的坑）：
     列表页用的是 Apple 目录的 artworkUrl600，一定有图；
     但节目页原来只取 eps[0].artwork（RSS 里第一集的 itunes:image），
     RSS 经常不给这个字段 → 一进节目页封面就变空白/兜底图，
     和列表页对不上，看起来像"图丢了"。
     正确顺序：① 列表页缓存的封面（showMeta）② RSS 频道图 ③ 第一集封面 ④ 兜底 */
  const prev = showMeta.get(raw) || {};
  // eps[0].album.imageUrl 是 RSS 的频道图（podcastEpisodes 里统一塞的 channelImg）
  const rssChannelImg = (eps[0] && eps[0].album && eps[0].album.imageUrl) || "";
  const notFallback = (u) => u && u !== PODCAST_FALLBACK_COVER;
  const cover =
    (notFallback(prev.imageUrl) && prev.imageUrl) ||
    (notFallback(rssChannelImg) && rssChannelImg) ||
    (notFallback(eps[0] && eps[0].artwork) && eps[0].artwork) ||
    PODCAST_FALLBACK_COVER;
  const card = {
    id: raw,
    name: prev.name || (eps[0] && eps[0].album && eps[0].album.name) || "播客节目",
    imageUrl: cover,
    description: "来自 RSS · 共 " + eps.length + " 集",
    episodeCount: eps.length,
  };
  // 缓存卡片，供订阅时补全；同时判断当前是否已订阅
  showMeta.set(raw, card);
  const subscribed = readList(SUBSCRIBED_SHOW_KEY).some((s) => s && String(s.id) === raw);
  return {
    show: { ...card, subscribed },
    episodes: page,
    more: eps.length > (offset || 0) + 50,
  };
}

/* 订阅的播客 —— 插件必须自己存，MyGo 不负责持久化。
   存的是完整 Show 卡片（id/name/imageUrl/description/episodeCount），
   这样 shows() 能原样还原，不用回头再查 Apple。 */
const SUBSCRIBED_SHOW_KEY = "subscribedShows";

export async function subscribeShow({ id, on }) {
  const sid = String(id || "");
  if (!sid) return null;
  const list = readList(SUBSCRIBED_SHOW_KEY).filter((s) => s && String(s.id) !== sid);
  if (on) {
    /* 订阅：MyGo 只传 id，其它字段得从节目页的缓存里补。
       show({id}) 之前会把节目信息塞进 showMeta，这里优先用它。 */
    const known = showMeta.get(sid) || {};
    list.unshift({
      id: sid,
      name: known.name || "播客节目",
      imageUrl: known.imageUrl || PODCAST_FALLBACK_COVER,
      description: known.description || "",
      publisher: known.publisher || "",
      episodeCount: Number(known.episodeCount) || 0,
    });
  }
  writeList(SUBSCRIBED_SHOW_KEY, list);
  return null;
}

export async function home() {
  const sections = [];

  // ① 今日拼单（大横幅）
  try {
    const mix = await todayMix();
    if (mix.length) {
      sections.push({
        title: "拼好歌",
        pageTitle: "拼好歌",
        subtitle: "网易云 · YouTube · B站 · 酷我 混着来，每天换一批",
        tracks: mix,
      });
    }
  } catch (e) {
    console.log("[葫芦] 拼好歌失败: " + ((e && e.message) || e));
  }

  /* ② 各分类。
     ⚠️ 不用 playlists 了—— 歌单只有网易云有接口，
        整个主页就全是网易云的歌单，聚合的意义没了。
        改成每个分类直接给一批 tracks，每首都走过多平台搜索，
        音频来源就分散到了网易云/酷我/YouTube/B站。 */
  /* 每个分类铺满一整行歌单卡片。
     ⚠️ 实测（2026-11-08）每张卡片固定 197px 宽，内容区 1560px，
        所以**一行能放 7 张**。以前每个分类只给 2 张 → 右边空 1140px（73% 空白），
        整个首页看起来像没加载完。现在改成 7 张铺满。
     ⚠️ 不能用 tracks —— MyGo 里 tracks 是写死的单列列表（每行 54px），
        插件改不了；而 Playlists 走 ui.Grid().Columns()，是真网格。
     每张卡片点进去调 playlist({id:"mix:<key>:<slot>"})，拿到的就是这一单的歌。
     ⚠️ 7 单并发跑，不然串行要 20 秒。 */
  const SLOTS_PER_CAT = 7;
  const catJobs = [];
  HOME_CATS.forEach((c) => {
    for (let s = 0; s < SLOTS_PER_CAT; s++) catJobs.push(catMix(c, s).catch(() => []));
  });
  const catMixes = await Promise.all(catJobs);
  const SLOT_LABEL = ["", " · 第二单", " · 第三单", " · 第四单", " · 第五单", " · 第六单", " · 第七单"];
  HOME_CATS.forEach((c, i) => {
    const pls = [];
    const cover = (arr) => (arr[0] && arr[0].album && arr[0].album.imageUrl) || (arr[0] && arr[0].artwork) || "";
    for (let s = 0; s < SLOTS_PER_CAT; s++) {
      const m = catMixes[i * SLOTS_PER_CAT + s] || [];
      if (m.length < 6) continue;
      pls.push({
        id: "mix:" + c.key + ":" + s,
        name: s === 0 ? c.title : c.title + (SLOT_LABEL[s] || " · 第" + (s + 1) + "单"),
        imageUrl: cover(m),
        description: m.length + " 首 · 多平台混排",
        owner: "网易云 · YouTube · B站 · 酷我 · QQ",
        trackCount: m.length,
      });
    }
    if (pls.length) sections.push({ title: c.title, playlists: pls });
  });

  /* ③ 首页不再放「继续听」（2026-11-09 按用户要求去掉）。
     最近播放有侧边栏独立入口（page: recent），不需要在首页重复一遍。 */

  /* ④ 网络电台（Radio Browser）—— 入口提到首页。
     这里只给静态链接，一个请求都不发：心情台和「中国电台」点进去才拉目录，
     首页本来就慢，不能再多个三秒。 */
  sections.push({
    title: "网络电台",
    subtitle: "RoamDial 三万多个真实电台，直播直连，转码兜底",
    links: [
      { title: "中国电台", subtitle: "1500+ 台 · 中国之声 / 省市音乐台", page: "rblist:country:CN:0" },
    ]
      .concat(RD_MOODS.map((m) => ({ title: m.name, subtitle: m.desc, page: "rblist:mood:" + m.id + ":0" })))
      .concat([{ title: "全部目录", subtitle: "按流派 / 国家 / 语言浏览", page: "radio" }]),
    empty: "目录暂时连不上",
  });

  if (!sections.length) {
    sections.push({ title: "葫芦音乐", empty: "先去搜索页找首歌吧" });
  }
  return { title: "葫芦音乐", sections };
}

export async function browse({ page }) {
  const p = String(page || "");

  // 分类的「查看全部」—— 跟主页同一套跨平台拼单
  if (p.startsWith("cat:")) {
    const key = p.slice(4);
    const c = HOME_CATS.find((x) => x.key === key);
    if (!c) throw fail("unavailable", "没有这个分类");
    const mix = await catMix(c);
    return { title: c.title, sections: [{ tracks: mix, empty: "暂无内容" }] };
  }

  // 今日拼单的完整列表
  if (p === "mix") {
    const mix = await todayMix();
    return { title: "今天的拼单", sections: [{ tracks: mix, empty: "今天还没拼出来" }] };
  }

  // 我的歌单（自建 + 收藏）
  /* QQ 音乐入口（page: qq）——把 QQ 的榜单搬进来，
     每个分组一个 section，卡片点进去是 qqchart:<topid>。 */
  /* 网络电台（RoamDial）：page radio 是目录首页，
     具体列表走 rblist:<kind>:<value>:<offset>。 */
  if (p === "radio" || p.startsWith("rblist:")) {
    if (p.startsWith("rblist:")) {
      const parts = p.slice(7).split(":");
      return await rdListPage(parts[0] || "random", parts[1] || "all", parts[2] || 0);
    }
    const data = await rdLoad();
    const countries = (data.core.countries || [])
      .map((row, i) => ({ code: String(row[0] || ""), name: rdCountryName(data.core, i), count: data.countryCount.get(i) || 0 }))
      .filter((c) => c.count > 0 && c.code)
      .sort((a, b) => b.count - a.count);
    const genres = (data.core.genres || [])
      .map((name, i) => ({ i, name: rdGenreName(data.core, i), count: data.genreCount.get(i) || 0 }))
      .filter((g) => g.count > 0);
    const cn = countries.find((c) => c.code.toUpperCase() === "CN");
    const others = countries.filter((c) => c.code.toUpperCase() !== "CN");
    const sections = [];
    if (cn) {
      sections.push({
        title: "中国电台",
        links: [{ title: cn.name, subtitle: cn.count + " 个台 · 按热度排", page: "rblist:country:CN:0" }],
      });
    }
    sections.push({ title: "按分类", links: genres.map((g) => ({ title: g.name, subtitle: g.count + " 个台", page: "rblist:genre:" + g.i + ":0" })) });
    sections.push({
      title: "按心情",
      links: RD_MOODS.filter((m) => m.id !== "wander").map((m) => ({ title: m.name, subtitle: m.desc, page: "rblist:mood:" + m.id + ":0" })),
    });
    sections.push({
      title: "随便听听",
      links: [{ title: "今天抽一批", subtitle: "按日期打散，同一天顺序固定", page: "rblist:random:all:0" }],
    });
    sections.push({ title: "按国家", links: others.slice(0, 40).map((c) => ({ title: c.name, subtitle: c.count + " 个台", page: "rblist:country:" + c.code + ":0" })) });
    return {
      title: "网络电台",
      description: "RoamDial · " + data.stations.length + " 个可直接播放的电台",
      sections,
    };
  }

  if (p === "qq" || p.startsWith("qqchart:")) {
    if (p.startsWith("qqchart:")) {
      const topid = p.slice(8);
      if (!/^\d+$/.test(topid)) throw fail("unavailable", "没有这个榜单");
      const chart = await qqChartPage(topid, 0, 30);
      remember(chart.tracks);
      return {
        title: chart.name,
        subtitle: chart.owner,
        sections: [{ title: chart.name, tracks: chart.tracks, empty: "这个榜单暂时没有歌" }],
      };
    }
    let groups = [];
    try {
      groups = await qqChartGroups();
    } catch (e) {
      trace("QQ 榜单分组失败", String((e && e.message) || e).slice(0, 60));
    }
    const sections = groups.map((g) => ({
      title: g.name,
      links: g.items.map((x) => ({ title: x.title, imageUrl: x.imageUrl, page: "qqchart:" + x.topId })),
      empty: "暂无榜单",
    }));
    return {
      title: "QQ 音乐",
      description: "免登录可听的 QQ 榜单与歌单，取流失败会自动换 YouTube",
      sections: sections.length ? sections : [{ title: "QQ 音乐", empty: "暂时拿不到榜单" }],
    };
  }

  if (p === "mylists") {
    const pls = await playlists();
    return {
      title: "我的歌单",
      sections: [{ playlists: pls, empty: "还没有歌单，去收藏或新建一个吧" }],
    };
  }

  // 最近播放
  if (p === "recent") {
    const rc = await recent();
    return { title: "最近播放", sections: [{ tracks: rc, empty: "还没有播放记录" }] };
  }

  // 艺人收藏
  if (p === "artists") {
    const artists = readList(FOLLOWED_ARTIST_KEY).map((a) => ({
      id: a.id,
      name: a.name || "未命名歌手",
      imageUrl: a.imageUrl || "",
      artwork: a.imageUrl || "",
    }));
    return { title: "艺人收藏", sections: [{ artists, empty: "还没收藏歌手，去歌手页关注一个吧" }] };
  }

  // 电台（无尽头播放）
  if (p === "stations") {
    /* 电台页结构：
       ① 网络收音机（真直播流，放最上面 —— 这才是「电台」的本意）
       ② 按语种 / ③ 按年代 / ④ 按风格（分类混播，无尽头续歌） */
    const sections = [
      {
        title: "中国电台",
        links: [
          {
            title: "全国电台，按收听人数排",
            subtitle: "中国之声 / 各省市音乐台等",
            page: "rblist:country:CN:0",
          },
        ],
        empty: "目录暂时连不上",
      },
      {
        title: "网络电台目录",
        links: [
          {
            title: "三万多台，按心情 / 流派 / 国家",
            subtitle: "Radio Browser",
            page: "radio",
          },
        ],
        empty: "目录暂时连不上",
      },
      {
        title: "网络收音机",
        stations: LIVE_STATIONS,
        /* ⚠️ Section 结构里没有 description 字段（Go 侧只有 title/tracks/albums/
           artists/playlists/shows/stations/links/morePage/empty/pageTitle/subtitle），
           写 description 会被静默丢弃 —— 用 subtitle。 */
        subtitle: "点台直接收听公开直播流（直连，不转码）",
        empty: "暂无可用网络电台源",
      },
    ];
    // 三个维度的封面并发取，别串行等
    const dimStations = await Promise.all(RADIO_DIMS.map((d) => radioStationsOfDim(d).catch(() => [])));
    RADIO_DIMS.forEach((dim, i) => {
      sections.push({
        title: dim.title,
        stations: dimStations[i],
        subtitle: dim.title.replace("按", "") + "分类 · 无尽头混播",
        empty: "暂无内容",
      });
    });
    return { title: "电台", sections };
  }

  // 播客（按类别分组做列表）
  /* 播客页：
     ① 我的收藏（有才显示，放最上面 —— 最常用的入口）
     ② 各分类推荐（音乐/科技/文化/商业/新闻/故事/生活/知识）
     想搜索就点搜索页选「播客」类型，或直接用 suggest。 */
  if (p === "shows") {
    const sections = [];

    // ① 收藏
    const saved = readList(SUBSCRIBED_SHOW_KEY).map((s) => ({ ...s, subscribed: true }));
    if (saved.length) {
      sections.push({
        title: "我的播客收藏",
        shows: saved,
        morePage: "myshows",
        subtitle: "共 " + saved.length + " 个节目",
      });
    }

    /* ② 分类推荐：**全部 41 类都铺到首屏**，每类 8 个节目。
       ⚠️ 请求量：41 类 × 4 关键词 = 164 个 Apple 请求。
          听起来吓人，但：
            · 关键词并发（podcastByCategory 内部已改并发）
            · podcastSearch 有内存缓存，同一关键词只打一次
            · **每类结果按天缓存**，第二次进页面 0 请求
          实测首屏首次约 3-4 秒，之后 0ms。 */
    const FIRST_BATCH = PODCAST_CATS.length;
    const PER_CAT = 8;
    const cachedSections = [];
    const needFetch = [];
    for (const c of PODCAST_CATS.slice(0, FIRST_BATCH)) {
      const ck = "podCat:" + CACHE_VER + ":" + c.key + ":" + todayKey();
      let hit = null;
      try {
        const v = host.storage.get(ck);
        // ⚠️ 空数组也算命中（表示"这个分类今天确实没结果"，不要再重打）
        if (Array.isArray(v)) hit = v;
      } catch {}
      if (hit) cachedSections.push({ c, shs: hit });
      else needFetch.push(c);
    }
    /* ⚠️ 限流：不能把 41 类一次性全并发扔给 Apple（会触发限流/超时）。
       分批发，每批 12 类并发。12×4 = 48 个请求同时进行，是实测比较稳的水位。 */
    const CONCURRENCY = 12;
    const fetched = [];
    for (let i = 0; i < needFetch.length; i += CONCURRENCY) {
      const batch = needFetch.slice(i, i + CONCURRENCY);
      const res = await Promise.all(
        batch.map((c) =>
          podcastByCategory(c, PER_CAT)
            .then((shs) => {
              /* ⚠️ 空结果也要缓存！否则每次进页面都要为一个「搜不到」的
                 分类白打 4 个请求 —— 41 类里有十几个在 Apple 中国区就是空的
                 （AI/创业/编程这类英文词搜不到中文节目），
                 这些空分类每次都重打，正是「第二次还要 1.9 秒」的原因。 */
              try {
                host.storage.set("podCat:" + CACHE_VER + ":" + c.key + ":" + todayKey(), shs);
              } catch {}
              return { c, shs };
            })
            .catch(() => ({ c, shs: [] }))
        )
      );
      fetched.push(...res);
    }
    const byKey = new Map();
    for (const g of cachedSections.concat(fetched)) byKey.set(g.c.key, g.shs);
    for (const c of PODCAST_CATS.slice(0, FIRST_BATCH)) {
      const shs = byKey.get(c.key) || [];
      if (shs.length) sections.push({ title: c.title, shows: shs });
    }
    if (!sections.length) {
      sections.push({ title: "播客", empty: "暂时拉不到节目，去电台栏翻一翻吧" });
    }
    /* 底部「更多」已去掉（2026-11-09）：41 个分类已经全部铺在首屏，
       收藏也有侧边栏独立入口 + 首屏第一行，那个链接块纯属重复。 */
    return { title: "播客", sections };
  }

  /* 播客收藏独立页（侧边栏「播客收藏」） */
  if (p === "myshows") {
    const saved = readList(SUBSCRIBED_SHOW_KEY).map((s) => ({ ...s, subscribed: true }));
    return {
      title: "播客收藏",
      sections: [
        {
          title: "已订阅 " + saved.length + " 个节目",
          shows: saved,
          empty: "还没收藏播客，去播客页点订阅吧",
        },
      ],
    };
  }

  /* 全部播客分类总览页（播客页首屏只放前 12 类，其余从这里进） */
  if (p === "podcats") {
    return {
      title: "播客分类",
      sections: [
        {
          title: "全部 " + PODCAST_CATS.length + " 个分类",
          links: PODCAST_CATS.map((c) => ({
            title: c.title,
            subtitle: c.kws.slice(0, 2).join(" · "),
            page: "podcat:" + c.key,
          })),
        },
      ],
    };
  }

  /* 单个播客分类的完整列表（每类最多 12 个节目） */
  if (p.startsWith("podcat:")) {
    const key = p.slice(7);
    const c = PODCAST_CATS.find((x) => x.key === key);
    if (!c) throw fail("unavailable", "没有这个分类");
    const ck = "podCat12:" + CACHE_VER + ":" + c.key + ":" + todayKey();
    let shs = null;
    try {
      const v = host.storage.get(ck);
      if (Array.isArray(v) && v.length) shs = v;
    } catch {}
    if (!shs) {
      shs = await podcastByCategory(c, 12).catch(() => []);
      try {
        if (shs.length) host.storage.set(ck, shs);
      } catch {}
    }
    return {
      title: c.title + " 播客",
      sections: [{ title: c.title, shows: shs, empty: "这一类暂时没有节目" }],
    };
  }

  throw fail("unavailable", "没有这个页面");
}