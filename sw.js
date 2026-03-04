/**
 * @fileoverview CH Geladas PDV — Service Worker v6.0.0
 *
 * Estratégias de cache (padrão Workbox / Google):
 *
 *  App Shell     → Cache First  : HTML + JS + CSS locais ficam no cache.
 *                                 App abre instantaneamente, mesmo sem rede.
 *
 *  CDN externos  → Stale While  : FontAwesome, Google Fonts, Tailwind CDN.
 *    (FA/Fonts)    Revalidate     Serve do cache imediatamente,
 *                                 atualiza em background quando online.
 *
 *  Firebase /    → Network First : Firestore e Firebase SDK precisam de rede
 *    Firestore                    para sync. Se falhar → app funciona offline
 *                                 com localStorage (já tratado em sync.js).
 *
 *  Outros        → Network Only  : Qualquer outra URL não cacheada.
 *
 * Instalação:
 *   Registre em index.html (já incluído):
 *   if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════
   CONFIGURAÇÃO
═══════════════════════════════════════════════════════════════════ */

/** Incrementar a cada deploy para invalidar cache antigo */
const CACHE_VERSION = 'ch-geladas-v6.0.0';

/** App Shell: arquivos locais que sempre devem estar no cache */
const APP_SHELL = [
  '/',
  '/index.html',
  '/app-dialogs.js',
  '/app-core.js',
  '/app-financeiro.js',
  '/app-delivery.js',
  '/app-ponto.js',
  '/app-comanda.js',
  '/firebase.js',
  '/sync.js',
  '/manifest.json',
];

/** Ícones: cacheados separadamente (não bloqueiam o install se falharem) */
const ICONS_SHELL = [
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-144.png',
  '/icons/icon-96.png',
  '/icons/icon-72.png',
];

/** CDN externos: servidos Stale-While-Revalidate */
const CDN_DOMAINS = [
  'cdn.tailwindcss.com',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

/** Firebase/Firestore: sempre network-first */
const FIREBASE_DOMAINS = [
  'firestore.googleapis.com',
  'www.gstatic.com',
  'firebase.googleapis.com',
  'identitytoolkit.googleapis.com',
];

/* ═══════════════════════════════════════════════════════════════════
   INSTALL — Pré-caches o App Shell
═══════════════════════════════════════════════════════════════════ */
self.addEventListener('install', event => {
  console.info(`[SW] Instalando ${CACHE_VERSION}`);

  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      // addAll() falha atomicamente — se um recurso falhar, nenhum é cacheado.
      // Usamos Promise.allSettled para não bloquear se um ícone faltar.
      // App Shell obrigatório
      await Promise.allSettled(
        APP_SHELL.map(url =>
          cache.add(url).catch(err =>
            console.warn(`[SW] Falha ao cachear ${url}:`, err.message)
          )
        )
      );
      // Ícones opcionais — não travam o install se falharem
      await Promise.allSettled(
        ICONS_SHELL.map(url =>
          cache.add(url).catch(() => null)
        )
      );
      return Promise.resolve();
    }).then(() => {
      console.info('[SW] App Shell cacheado');
      // Ativa imediatamente sem esperar abas antigas fecharem
      return self.skipWaiting();
    })
  );
});

/* ═══════════════════════════════════════════════════════════════════
   ACTIVATE — Limpa caches antigos
═══════════════════════════════════════════════════════════════════ */
self.addEventListener('activate', event => {
  console.info(`[SW] Ativando ${CACHE_VERSION}`);

  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => {
            console.info(`[SW] Removendo cache antigo: ${key}`);
            return caches.delete(key);
          })
      )
    ).then(() => {
      // Assume controle de todas as abas abertas imediatamente
      return self.clients.claim();
    })
  );
});

/* ═══════════════════════════════════════════════════════════════════
   FETCH — Intercepta requisições e aplica estratégia correta
═══════════════════════════════════════════════════════════════════ */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignora: não-GET, chrome-extension, DevTools
  if (request.method !== 'GET')             return;
  if (url.protocol === 'chrome-extension:') return;

  // ── Firebase/Firestore → Network First ─────────────────────────
  if (FIREBASE_DOMAINS.some(d => url.hostname.includes(d))) {
    event.respondWith(_networkFirst(request));
    return;
  }

  // ── CDN externos → Stale While Revalidate ──────────────────────
  if (CDN_DOMAINS.some(d => url.hostname.includes(d))) {
    event.respondWith(_staleWhileRevalidate(request));
    return;
  }

  // ── App Shell (same-origin) → Cache First ──────────────────────
  if (url.origin === self.location.origin) {
    event.respondWith(_cacheFirst(request));
    return;
  }

  // ── Todo o resto → Network Only ────────────────────────────────
  // (não interferimos)
});

/* ═══════════════════════════════════════════════════════════════════
   ESTRATÉGIAS DE CACHE
═══════════════════════════════════════════════════════════════════ */

/**
 * Cache First: serve do cache, busca na rede só se não encontrar.
 * Ideal para App Shell — zero latência no boot.
 */
async function _cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone()); // armazena para próxima vez
    }
    return response;
  } catch {
    // Recurso não disponível e não está no cache
    // Para navegação (HTML), retorna o index.html cacheado (SPA fallback)
    if (request.destination === 'document') {
      return caches.match('/index.html');
    }
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

/**
 * Stale While Revalidate: retorna cache imediatamente, atualiza em background.
 * Ideal para CDN — sempre rápido, sempre atualizado no próximo load.
 */
async function _staleWhileRevalidate(request) {
  const cache  = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  // Busca na rede em background (não bloqueia)
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached ?? await fetchPromise ?? new Response('', { status: 503 });
}

/**
 * Network First: tenta rede, cai para cache se falhar.
 * Ideal para Firebase — sempre dados frescos quando online,
 * graceful degradation offline.
 */
async function _networkFirst(request) {
  try {
    const response = await fetch(request);
    // Não cacheamos respostas Firebase — sync.js já trata localStorage
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached ?? new Response('', { status: 503 });
  }
}

/* ═══════════════════════════════════════════════════════════════════
   SYNC EM BACKGROUND (Background Sync API)
   Garante que backups pendentes chegam ao Firestore quando a rede volta,
   mesmo que o app esteja fechado.
═══════════════════════════════════════════════════════════════════ */
self.addEventListener('sync', event => {
  if (event.tag === 'ch-backup-sync') {
    console.info('[SW] Background sync disparado → notificando app');
    // Notifica todas as abas abertas para executar backup
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(client =>
          client.postMessage({ type: 'CH_BACKGROUND_SYNC' })
        );
      })
    );
  }
});

/* ═══════════════════════════════════════════════════════════════════
   PUSH NOTIFICATIONS (opcional — base para implementação futura)
   Exemplo de uso: notificar garçom sobre novo pedido delivery
═══════════════════════════════════════════════════════════════════ */
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try { payload = event.data.json(); }
  catch { payload = { title: 'CH Geladas', body: event.data.text() }; }

  const options = {
    body:    payload.body    || '',
    icon:    payload.icon    || '/icons/icon-192.png',
    badge:   payload.badge   || '/icons/icon-72.png',
    tag:     payload.tag     || 'ch-notif',
    data:    payload.data    || {},
    actions: payload.actions || [],
    vibrate: [200, 100, 200],
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'CH Geladas', options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      const existing = clients.find(c => c.url.includes(self.location.origin));
      return existing ? existing.focus() : self.clients.openWindow('/');
    })
  );
});

console.info(`[SW] ${CACHE_VERSION} carregado`);
