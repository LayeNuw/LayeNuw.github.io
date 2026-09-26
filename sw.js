/* 我的空间 · 离线缓存 Service Worker
 *
 * 策略（同源请求才管，Supabase 等外部请求一律直连不碰）：
 * 1. 带指纹的静态文件（/_next/static/…）：内容永不变 → 缓存优先（秒开）
 * 2. 页面：网络优先但最多等 1.5 秒 —— 网络快就拿到最新页面（发版后一次刷新即生效），
 *    网络慢就立刻用缓存顶上，不让你干等；两者都会顺手更新缓存
 * 3. /version.json ：完全不拦，永远走网络（页面靠它判断"线上是不是出新版了"）
 *
 * 页面里的 lib/appUpdate.ts 还会定期比对 /version.json，发现新版就清缓存 + 自动刷新，
 * 所以长时间开着的窗口（桌面应用开机自启那种）也不会一直停在旧版。
 *
 * VERSION 每抬一位 = 清空所有旧缓存。改了缓存策略或想强制所有人重来时才需要动。
 */
const VERSION = "v2";
const SHELL_CACHE = `space-shell-${VERSION}`;
const ASSET_CACHE = `space-assets-${VERSION}`;

/** 页面"网络优先"的最长等待时间（毫秒）；超时就用缓存先显示 */
const NET_TIMEOUT_MS = 1500;

/* 安装时预存的"页面壳"：全部是与构建指纹无关的固定地址，不会过期 */
const SHELL_URLS = [
  "/",
  "/schedule/",
  "/notes/",
  "/diary/",
  "/links/",
  "/api/",
  "/chat/",
  "/view/",
  "/write/",
  "/settings/",
  "/manifest.webmanifest",
  "/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const old = keys.filter(
        (k) => k.startsWith("space-") && k !== SHELL_CACHE && k !== ASSET_CACHE,
      );
      await Promise.all(old.map((k) => caches.delete(k)));
      // 只接管，不强制导航已开着的窗口：
      // 从 activate 里 clients.navigate() 会让浏览器陷入导航循环（实测把页面卡死），
      // 旧窗口交给 lib/appUpdate.ts 的版本比对自动刷新。
      await self.clients.claim();
    })(),
  );
});

/* 页面发来的指令（lib/appUpdate.ts）：
   - clear-shell：只清页面壳缓存 —— 检测到线上有新版本、准备自动刷新时用
   - clear-all  ：连静态资源缓存一起清 —— 设置页「获取最新版本」硬重置时用
   清完立刻回执（页面可以刷新了），再在后台用最新内容把页面壳补回来，
   这样即使清过缓存，之后断网也照样能打开各个页面 */
self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;
  if (type !== "clear-shell" && type !== "clear-all") return;
  const replyPort = event.ports && event.ports[0];

  const cleared = (async () => {
    await caches.delete(SHELL_CACHE);
    if (type === "clear-all") await caches.delete(ASSET_CACHE);
  })();

  event.waitUntil(
    cleared.then(async () => {
      if (replyPort) replyPort.postMessage({ ok: true });
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(SHELL_URLS).catch(() => {});
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 版本标记文件永不拦截：页面靠它判断"线上是不是已经出新版了"
  if (url.pathname === "/version.json") return;

  // 兜底铁律：SW 只是加速层，绝不能因为它自己的问题让页面打不开。
  // 下面这个 .catch 会在任何意外（包括我们自己的代码 bug）时直接放行到网络。
  event.respondWith(
    handle(req, url.pathname.startsWith("/_next/static/"), (p) =>
      event.waitUntil(p),
    ).catch(() => fetch(event.request)),
  );
});

async function handle(req, isAsset, keepAlive = () => {}) {
  // 带内容指纹的静态资源：文件名变了内容才是真的变了，放心一直用缓存
  if (isAsset) {
    const cache = await caches.open(ASSET_CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  }

  // 页面 / RSC 预取 .txt / manifest / 图标：
  // 网络优先，但最多等 NET_TIMEOUT 毫秒 —— 网络快就用最新的（发版后一次刷新即生效），
  // 网络慢（比如手机走国外线路）就立刻用缓存顶上，不让用户干等。
  const cache = await caches.open(SHELL_CACHE);
  const network = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => undefined);

  const cached =
    (await cache.match(req)) ||
    (await cache.match(req, { ignoreSearch: true }));

  if (cached) {
    const winner = await Promise.race([
      network,
      new Promise((r) => setTimeout(() => r(undefined), NET_TIMEOUT_MS)),
    ]);
    // 网速快且结果正常 → 用最新的；超时/断网/服务端报错 → 缓存顶上
    if (winner && winner.ok) return winner;
    keepAlive(network); // 让后台这次网络请求有时间把缓存更新掉
    return cached;
  }

  const net = await network;
  return net || offlineFallback(req);
}

/* 从没打开过的页面在离线时才会走到这里 */
function offlineFallback(req) {
  if (req.mode === "navigate") {
    return new Response(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
        `<title>离线 · 我的空间</title>` +
        `<div style="font-family:system-ui,sans-serif;display:flex;height:100vh;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:#6e6e73">` +
        `<div style="font-size:44px">📡</div>` +
        `<div style="font-size:15px">现在没有网络<br>连网打开过的页面，之后都能离线看</div></div>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
  return new Response("", { status: 504 });
}
