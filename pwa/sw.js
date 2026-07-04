// Cache-first service worker: precaches the entire app so it runs fully
// offline once installed. Bump VERSION on every deploy to refresh clients.
const VERSION = "v3";
const CACHE = `greenrattle-${VERSION}`;

const ASSETS = [
	".",
	"index.html",
	"manifest.webmanifest",
	"css/style.css",
	"js/app.js",
	"js/crypto.js",
	"js/modem.js",
	"js/capture-worklet.js",
	"vendor/qrcode.js",
	"vendor/jsQR.js",
	"wasm/rattlegram.js",
	"icons/icon-192.png",
	"icons/icon-512.png",
];

self.addEventListener("install", (e) => {
	e.waitUntil(
		caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
	);
});

self.addEventListener("activate", (e) => {
	e.waitUntil(
		caches.keys().then(names =>
			Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)))
		).then(() => self.clients.claim())
	);
});

self.addEventListener("fetch", (e) => {
	if (e.request.method !== "GET")
		return;
	e.respondWith(
		caches.match(e.request, { ignoreSearch: true }).then(hit =>
			hit || fetch(e.request).then(resp => {
				// runtime-cache same-origin requests so updates land in cache too
				if (resp.ok && new URL(e.request.url).origin === location.origin) {
					const copy = resp.clone();
					caches.open(CACHE).then(c => c.put(e.request, copy));
				}
				return resp;
			}).catch(() => {
				// Offline with nothing cached for this request. For a page
				// navigation, fall back to the app shell so the PWA still
				// opens; for anything else, fail cleanly instead of throwing.
				if (e.request.mode === "navigate")
					return caches.match("index.html");
				return new Response("", { status: 503, statusText: "Offline" });
			})
		)
	);
});
