/**
 * @fileoverview CH Geladas PDV — Sync Module v6.0.0
 *
 * Responsabilidades:
 *  1. Restore inicial: Firestore → localStorage (na abertura)
 *  2. Real-time listener: onSnapshot → aplica mudanças de outros devices ao vivo
 *  3. Backup: localStorage → Firestore com debounce (após cada save)
 *  4. Indicador visual de conectividade (bolinha 🟢/🟡/🔴 no app)
 *  5. Nunca bloquear o app — falha silenciosa em modo offline
 *
 * Fluxo garantido:
 *  firebase.js carrega → sync.js carrega → restoreFirestore() → CH_INIT()
 *  Se Firestore falhar → CH_INIT() é chamado mesmo assim (modo offline)
 *
 * Multi-device (NOVO v6):
 *  onSnapshot() detecta mudanças de outros tablets/dispositivos em tempo real.
 *  Conflito resolvido por _updatedAt timestamp — o mais recente vence,
 *  a menos que o device local tenha um save com lock ativo (CH_SYNC_LOCK).
 */

import {
  doc,
  setDoc,
  getDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ═══════════════════════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════════════════════ */
const STORAGE_KEY          = 'CH_GELADAS_DB_ENTERPRISE';
const FIRESTORE_COLLECTION = 'ch_geladas';
const FIRESTORE_DOC_ID     = 'sistema';

const FIREBASE_WAIT_MS     = 5_000;   // timeout aguardando Firebase inicializar
const BACKUP_DEBOUNCE_MS   = 1_500;   // debounce de escrita no Firestore
const BACKUP_TIMEOUT_MS    = 12_000;  // timeout máximo por operação
const SNAPSHOT_MIN_GAP_MS  = 2_000;   // ignora snapshots chegando muito rápido (anti-loop)

/* ═══════════════════════════════════════════════════════════════════
   ESTADO INTERNO
═══════════════════════════════════════════════════════════════════ */
let _backupTimer       = null;   // timer do debounce
let _initCalled        = false;  // CH_INIT chamado apenas uma vez
let _isOffline         = false;  // true quando Firestore inacessível
let _unsubSnapshot     = null;   // função de cleanup do onSnapshot
let _lastSnapshotApply = 0;      // timestamp da última aplicação de snapshot
let _lastLocalSave     = 0;      // timestamp do último save local

/* ═══════════════════════════════════════════════════════════════════
   INDICADOR VISUAL DE CONECTIVIDADE
   Injeta/atualiza um badge discreto no topo do app
═══════════════════════════════════════════════════════════════════ */
const ConnectivityUI = (() => {
  const BADGE_ID = 'ch-sync-badge';

  /**
   * @param {'online'|'syncing'|'offline'|'error'} status
   */
  function set(status) {
    // Aguarda DOM estar pronto
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => set(status), { once: true });
      return;
    }

    let badge = document.getElementById(BADGE_ID);
    if (!badge) {
      badge = document.createElement('div');
      badge.id    = BADGE_ID;
      badge.style.cssText = [
        'position:fixed',
        'top:env(safe-area-inset-top,0px)',
        'right:0',
        'z-index:99999',
        'display:flex',
        'align-items:center',
        'gap:4px',
        'padding:4px 10px 4px 8px',
        'border-radius:0 0 0 12px',
        'font-size:9px',
        'font-weight:800',
        'letter-spacing:.06em',
        'text-transform:uppercase',
        'pointer-events:none',
        'transition:background .3s,color .3s',
        'font-family:Plus Jakarta Sans,sans-serif',
      ].join(';');
      document.body.appendChild(badge);
    }

    const MAP = {
      online:  { bg: 'rgba(16,185,129,.15)', color: '#34d399', dot: '🟢', label: 'Sync'    },
      syncing: { bg: 'rgba(245,158,11,.15)', color: '#fbbf24', dot: '🟡', label: 'Salvando' },
      offline: { bg: 'rgba(71,85,105,.15)',  color: '#64748b', dot: '⚫', label: 'Offline'  },
      error:   { bg: 'rgba(239,68,68,.15)',  color: '#f87171', dot: '🔴', label: 'Erro Sync' },
    };

    const cfg = MAP[status] ?? MAP.offline;
    badge.style.background = cfg.bg;
    badge.style.color      = cfg.color;
    badge.innerHTML        = `<span style="font-size:7px">${cfg.dot}</span>${cfg.label}`;
  }

  return Object.freeze({ set });
})();

/* ═══════════════════════════════════════════════════════════════════
   UTILITÁRIOS
═══════════════════════════════════════════════════════════════════ */

/**
 * Aguarda window.firestoreDB ficar disponível ou null (falha).
 * Resolve null após FIREBASE_WAIT_MS.
 * @returns {Promise<object|null>}
 */
function _waitFirebase() {
  return new Promise(resolve => {
    if (window.firestoreDB)         { resolve(window.firestoreDB); return; }
    if (window.firestoreDB === null) { resolve(null); return; }

    const deadline = Date.now() + FIREBASE_WAIT_MS;
    const tick = () => {
      if (window.firestoreDB)          return resolve(window.firestoreDB);
      if (window.firestoreDB === null)  return resolve(null);
      if (Date.now() >= deadline)       return resolve(null);
      setTimeout(tick, 80);
    };
    tick();
  });
}

/**
 * Race entre uma Promise e um timeout que rejeita.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function _withTimeout(promise, ms) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`[Sync] Timeout ${ms}ms`)), ms)
  );
  return Promise.race([promise, timer]);
}

/**
 * Lê e parseia o estado atual do localStorage.
 * @returns {object|null}
 */
function _readLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Chama window.CH_INIT() UMA única vez — ponto de boot da UI.
 */
function _callCHInit() {
  if (_initCalled) return;
  _initCalled = true;

  if (typeof window.CH_INIT === 'function') {
    try { window.CH_INIT(); }
    catch (err) { console.error('[Sync] Erro em CH_INIT:', err); }
    return;
  }

  // app-core.js pode ainda não ter carregado — aguarda 500ms
  setTimeout(() => {
    if (typeof window.CH_INIT === 'function') {
      window.CH_INIT();
    } else {
      console.error('[Sync] ❌ CH_INIT não encontrado. Verifique a ordem dos <script>.');
    }
  }, 500);
}

/* ═══════════════════════════════════════════════════════════════════
   RESTORE — Firestore → localStorage (executa uma vez no boot)
═══════════════════════════════════════════════════════════════════ */
async function _restoreFirestore() {
  ConnectivityUI.set('syncing');

  const db = await _waitFirebase();

  if (!db) {
    _isOffline = true;
    ConnectivityUI.set('offline');
    console.warn('[Sync] Firebase indisponível — modo offline');
    _callCHInit();
    return;
  }

  try {
    const ref  = doc(db, FIRESTORE_COLLECTION, FIRESTORE_DOC_ID);
    const snap = await _withTimeout(getDoc(ref), BACKUP_TIMEOUT_MS);

    if (snap.exists()) {
      const remote = snap.data()?.data;

      if (remote && typeof remote === 'object') {
        const local = _readLocal();

        // Estratégia: timestamp de última modificação decide.
        // _updatedAt é gravado pelo _executeBackup a cada persist().
        const localTs  = local?._updatedAt  ?? 0;
        const remoteTs = remote._updatedAt   ?? 0;

        if (!local || remoteTs > localTs) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(remote));
          console.info(
            `[Sync] ✅ Restore → remoto (${new Date(remoteTs).toLocaleTimeString('pt-BR')})`
          );
        } else {
          console.info(
            `[Sync] ℹ️ Local mais recente (${new Date(localTs).toLocaleTimeString('pt-BR')}) — mantendo`
          );
        }
      }
    } else {
      console.info('[Sync] Sem dados no Firestore — primeiro uso ou base limpa');
    }

    ConnectivityUI.set('online');

  } catch (err) {
    _isOffline = true;
    ConnectivityUI.set('error');
    console.warn('[Sync] Restore falhou — usando localStorage:', err.message);
  } finally {
    // CH_INIT SEMPRE executado, independente do resultado
    _callCHInit();
    // Inicia listener real-time APÓS o restore (evita loop de init)
    _startRealtimeListener();
  }
}

/* ═══════════════════════════════════════════════════════════════════
   REAL-TIME LISTENER — onSnapshot (NOVO v6)
   Detecta mudanças de outros devices ao vivo e aplica no app
═══════════════════════════════════════════════════════════════════ */
async function _startRealtimeListener() {
  const db = window.firestoreDB;
  if (!db) return;

  // Cleanup de listener anterior (evita duplicatas em hot-reload)
  if (typeof _unsubSnapshot === 'function') {
    _unsubSnapshot();
    _unsubSnapshot = null;
  }

  try {
    const ref = doc(db, FIRESTORE_COLLECTION, FIRESTORE_DOC_ID);

    _unsubSnapshot = onSnapshot(
      ref,
      { includeMetadataChanges: false },  // ignora escritas locais pendentes

      (snapshot) => {
        // Ignorar se snapshot veio de cache local (não de outro device)
        if (snapshot.metadata.hasPendingWrites) return;
        if (!snapshot.exists())                return;

        const remote = snapshot.data()?.data;
        if (!remote || typeof remote !== 'object') return;

        const remoteTs = remote._updatedAt ?? 0;
        const localTs  = _readLocal()?._updatedAt ?? 0;

        // Anti-loop: se acabamos de salvar localmente, ignoramos nosso próprio snapshot
        const msSinceLastSave = Date.now() - _lastLocalSave;
        if (msSinceLastSave < SNAPSHOT_MIN_GAP_MS) return;

        // Anti-flood: snapshots chegando muito rápido (raro, mas protege)
        const msSinceLast = Date.now() - _lastSnapshotApply;
        if (msSinceLast < SNAPSHOT_MIN_GAP_MS) return;

        // Só aplica se o remoto for mais novo que o local
        if (remoteTs <= localTs) return;

        // Respeita lock de sync (app-core.js seta CH_SYNC_LOCK durante checkout)
        if (window.CH_SYNC_LOCK) {
          console.info('[Sync] 🔒 Lock ativo — snapshot adiado');
          setTimeout(() => _applyRemoteSnapshot(remote, remoteTs), 2_500);
          return;
        }

        _applyRemoteSnapshot(remote, remoteTs);
      },

      (err) => {
        // Listener morreu (ex: conexão caiu)
        _isOffline = true;
        ConnectivityUI.set('error');
        console.warn('[Sync] onSnapshot erro:', err.message);

        // Tenta reconectar em 30s
        setTimeout(_startRealtimeListener, 30_000);
      }
    );

    console.info('[Sync] 👂 Real-time listener ativo');
    _isOffline = false;
    ConnectivityUI.set('online');

  } catch (err) {
    console.error('[Sync] Falha ao iniciar listener:', err.message);
  }
}

/**
 * Aplica dados remotos no app local (via CH_SAFE_SYNC) e atualiza localStorage.
 * @param {object} remoteData
 * @param {number} remoteTs
 */
function _applyRemoteSnapshot(remoteData, remoteTs) {
  _lastSnapshotApply = Date.now();

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(remoteData));
  } catch (err) {
    console.error('[Sync] Falha ao escrever localStorage:', err);
    return;
  }

  if (typeof window.CH_SAFE_SYNC === 'function') {
    window.CH_SAFE_SYNC(remoteData);
    console.info(
      `[Sync] 📡 Sync remoto aplicado (${new Date(remoteTs).toLocaleTimeString('pt-BR')})`
    );
  }

  ConnectivityUI.set('online');
}

/* ═══════════════════════════════════════════════════════════════════
   BACKUP — localStorage → Firestore (com debounce + retry)
═══════════════════════════════════════════════════════════════════ */

/**
 * Executa o backup efetivo no Firestore.
 * Se falhar, agenda retry em 15s (backoff linear simples).
 */
async function _executeBackup() {
  const db = window.firestoreDB;
  if (!db) { _isOffline = true; ConnectivityUI.set('offline'); return; }

  const data = _readLocal();
  if (!data) return;

  ConnectivityUI.set('syncing');
  _lastLocalSave = Date.now();

  try {
    const ref = doc(db, FIRESTORE_COLLECTION, FIRESTORE_DOC_ID);
    await _withTimeout(
      setDoc(ref, {
        data,
        updated: new Date().toISOString(),
        version: '6.0.0-enterprise',
        device:  navigator.userAgent.slice(0, 80), // identifica qual device salvou (debug)
      }),
      BACKUP_TIMEOUT_MS
    );

    _isOffline = false;
    ConnectivityUI.set('online');
    console.info(`[Sync] 🔥 Backup OK (${new Date().toLocaleTimeString('pt-BR')})`);

  } catch (err) {
    _isOffline = true;
    ConnectivityUI.set('error');
    console.warn('[Sync] Backup falhou — retry em 15s:', err.message);

    // Backoff: tenta novamente em 15s sem acumular debounce
    setTimeout(_executeBackup, 15_000);
  }
}

/**
 * Agenda backup com debounce.
 * Múltiplos saves em sequência disparam UMA ÚNICA escrita no Firestore.
 */
function _scheduleBackup() {
  clearTimeout(_backupTimer);
  _backupTimer = setTimeout(_executeBackup, BACKUP_DEBOUNCE_MS);
}

/**
 * Flush imediato: descarta o debounce e salva agora.
 * Chamado no beforeunload — garante que vendas chegam ao Firestore
 * mesmo que o usuário feche a aba dentro da janela de debounce.
 */
function _flushImmediate() {
  if (_backupTimer !== null) {
    clearTimeout(_backupTimer);
    _backupTimer = null;
    _executeBackup(); // fire-and-forget (browser permite async mínimo no unload)
  }
}

/* ═══════════════════════════════════════════════════════════════════
   CONECTIVIDADE — Reage aos eventos do firebase.js
═══════════════════════════════════════════════════════════════════ */
window.addEventListener('ch:connectivity', ({ detail }) => {
  if (detail.online) {
    // Voltou online: re-inicia listener + faz backup imediato se houver dados
    _startRealtimeListener();
    const hasLocal = !!_readLocal();
    if (hasLocal) _executeBackup();
  } else {
    _isOffline = true;
    ConnectivityUI.set('offline');
  }
});

/* ═══════════════════════════════════════════════════════════════════
   LISTENERS DO BROWSER
═══════════════════════════════════════════════════════════════════ */

// Salva ao fechar aba (antes de sair)
window.addEventListener('beforeunload', _flushImmediate);

// Salva ao voltar para a aba (usuário volta ao app)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !_isOffline) {
    // Re-verifica se há updates remotos perdidos enquanto a aba estava oculta
    console.info('[Sync] Aba voltou ao foco — verificando updates remotos...');
    // onSnapshot já cuida disso automaticamente; basta garantir que está ativo
    if (!_unsubSnapshot) _startRealtimeListener();
  }
});

/* ═══════════════════════════════════════════════════════════════════
   API PÚBLICA — Exposta via window para app-core.js consumir
═══════════════════════════════════════════════════════════════════ */

/**
 * CH_BACKUP — chamado por SyncService.persist() após cada save.
 * Agenda backup com debounce para não estourar quotas do Firestore.
 */
window.CH_BACKUP = _scheduleBackup;

/**
 * CH_SYNC_APPLY — aplica dados remotos recebidos externamente.
 * Pode ser chamado manualmente se necessário (ex: força sync).
 */
window.CH_SYNC_APPLY = (data) => {
  if (!data) return;
  _applyRemoteSnapshot(data, data._updatedAt ?? Date.now());
};

/**
 * CH_FORCE_SYNC — força backup imediato (ex: botão "Salvar Agora" na UI).
 */
window.CH_FORCE_SYNC = _executeBackup;

/**
 * CH_SYNC_STATUS — retorna estado atual do sync para debug.
 */
window.CH_SYNC_STATUS = () => ({
  offline:          _isOffline,
  listenerAtivo:    typeof _unsubSnapshot === 'function',
  ultimoSaveLocal:  _lastLocalSave  ? new Date(_lastLocalSave).toLocaleTimeString('pt-BR')  : '—',
  ultimoSnapshot:   _lastSnapshotApply ? new Date(_lastSnapshotApply).toLocaleTimeString('pt-BR') : '—',
});

/* ═══════════════════════════════════════════════════════════════════
   BOOT — Inicia restore ao carregar o módulo
═══════════════════════════════════════════════════════════════════ */
_restoreFirestore();
