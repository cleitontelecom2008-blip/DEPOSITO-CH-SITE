/**
 * @fileoverview CH Geladas PDV — Core Module
 * @version 5.0.0-enterprise
 *
 * Arquitetura:
 *  - Store          → State management reativo (padrão Redux-like)
 *  - AuthService    → Autenticação com SHA-256 hash
 *  - CartService    → Carrinho de compras
 *  - UIService      → Toast, Modals, Clock, Alerts
 *  - SyncService    → localStorage + Firestore bridge
 *  - RenderService  → Renderização do catálogo PDV
 *  - Validators     → Validações puras e reutilizáveis
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════════════════════ */
const CONSTANTS = Object.freeze({
  STORAGE_KEY: 'CH_GELADAS_DB_ENTERPRISE',
  SYNC_LOCK_DURATION_MS: 6_000,
  TOAST_DURATION_MS: 2_800,
  SYNC_FALLBACK_MS: 5_000,
  CART_ANIMATION_MS: 400,
  DEBOUNCE_SAVE_MS: 300,
  LOCALE: 'pt-BR',
  CURRENCY: { minimumFractionDigits: 2, maximumFractionDigits: 2 },
  PIN_HASH: Object.freeze({
    ADMIN: '7a3e6b16cb75f48fb897eff3ae732f3154f6d203b53f33660f01b4c3b6bc2df9', // 001
    PDV:   'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3'  // 123
  }),
  LOW_STOCK_THRESHOLD: 3,
});

/* ═══════════════════════════════════════════════════════════════════
   VALIDATORS — Funções puras, sem efeitos colaterais
═══════════════════════════════════════════════════════════════════ */
const Validators = Object.freeze({
  /** @param {string} v @returns {boolean} */
  isNonEmptyString: v => typeof v === 'string' && v.trim().length > 0,

  /** @param {number} v @returns {boolean} */
  isPositiveNumber: v => typeof v === 'number' && Number.isFinite(v) && v >= 0,

  /** @param {any} v @returns {boolean} */
  isNonEmptyArray: v => Array.isArray(v) && v.length > 0,

  /** @param {string} tel @returns {boolean} */
  isPhoneNumber: tel => /^\+?[\d\s\-().]{7,20}$/.test(String(tel).trim()),

  /** @param {number} price @returns {boolean} */
  isValidPrice: price => typeof price === 'number' && Number.isFinite(price) && price >= 0,

  /** @param {object} product @returns {{valid:boolean, errors:string[]}} */
  validateProduct(product) {
    const errors = [];
    if (!this.isNonEmptyString(product?.nome)) errors.push('Nome é obrigatório');
    if (!this.isValidPrice(product?.precoUn))  errors.push('Preço unitário inválido');
    if (!this.isValidPrice(product?.custoUn))  errors.push('Custo unitário inválido');
    if (!this.isPositiveNumber(product?.qtdUn))errors.push('Quantidade inválida');
    return { valid: errors.length === 0, errors };
  },
});

/* ═══════════════════════════════════════════════════════════════════
   UTILITIES — Helpers puros
═══════════════════════════════════════════════════════════════════ */
const Utils = Object.freeze({
  /**
   * Gera ID único globalmente (UUID v4 via Web Crypto API).
   * Colisão-free, seguro para multi-device e multi-tab.
   * Compatível com todos os browsers modernos (mesmo Firefox/Safari offline).
   * Retorna string — todos os comparadores do app já usam String() casting.
   * @returns {string} ex: "550e8400-e29b-41d4-a716-446655440000"
   */
  generateId: () => crypto.randomUUID(),

  /**
   * Formata valor como moeda BRL
   * @param {number} v
   * @returns {string}
   */
  formatCurrency: v =>
    `R$ ${Number(v || 0).toLocaleString(CONSTANTS.LOCALE, CONSTANTS.CURRENCY)}`,

  /**
   * Formata número de telefone para wa.me (somente dígitos, sem zero inicial)
   * @param {string|null|undefined} tel
   * @returns {string}
   */
  formatPhone(tel) {
    if (!tel) return '';
    const digits = String(tel).replace(/\D/g, '');
    return digits.startsWith('0') ? digits.slice(1) : digits;
  },

  /**
   * Debounce: adia execução da função até silêncio de `ms`
   * @param {Function} fn
   * @param {number} ms
   * @returns {Function}
   */
  debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  },

  /**
   * Safe JSON parse com fallback
   * @param {string} str
   * @param {any} fallback
   * @returns {any}
   */
  safeJsonParse(str, fallback = null) {
    try { return JSON.parse(str); }
    catch { return fallback; }
  },

  /**
   * Abre link WhatsApp sem ser bloqueado pelo browser
   * @param {string} tel
   * @param {string} msg
   */
  openWhatsApp(tel, msg) {
    const num = this.formatPhone(tel);
    if (!num) return;
    const a = document.createElement('a');
    a.href = `https://wa.me/55${num}?text=${encodeURIComponent(msg)}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },

  /**
   * Download de blob como arquivo
   * @param {string|object} content
   * @param {string} mime
   * @param {string} filename
   */
  downloadBlob(content, mime, filename) {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /**
   * Obtém elemento do DOM de forma segura
   * @param {string} id
   * @returns {HTMLElement|null}
   */
  el: id => document.getElementById(id),

  /**
   * Data local atual em formato exibição: DD/MM/AAAA (pt-BR)
   * Usado para display ao usuário e comparações de dataCurta legada.
   */
  today: () => new Date().toLocaleDateString(CONSTANTS.LOCALE),

  /**
   * Data local atual em formato ISO: YYYY-MM-DD
   * Padrão global de armazenamento — evita ambiguidade e conversões.
   * Todas as novas gravações de dataCurta usam este formato.
   */
  todayISO: (() => {
    const pad = n => String(n).padStart(2, '0');
    return () => {
      const d = new Date();
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
  })(),

  /** Hora atual em locale string (HH:MM:SS) */
  now: () => new Date().toLocaleTimeString(CONSTANTS.LOCALE),

  /** Timestamp completo para logs e auditoria */
  timestamp: () => new Date().toLocaleString(CONSTANTS.LOCALE),
});

/* ═══════════════════════════════════════════════════════════════════
   CRYPTO — SHA-256 via Web Crypto API
═══════════════════════════════════════════════════════════════════ */
const CryptoService = (() => {
  /**
   * Gera hash SHA-256 de uma string
   * @param {string} str
   * @returns {Promise<string>}
   */
  async function sha256(str) {
    const buffer = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Valida PIN comparando hash
   * @param {string} pin
   * @returns {Promise<'admin'|'pdv'|null>}
   */
  async function validatePin(pin) {
    const hash = await sha256(pin);
    if (hash === CONSTANTS.PIN_HASH.ADMIN) return 'admin';
    if (hash === CONSTANTS.PIN_HASH.PDV)   return 'pdv';
    return null;
  }

  return Object.freeze({ sha256, validatePin });
})();

/* ═══════════════════════════════════════════════════════════════════
   EVENT BUS — Comunicação desacoplada entre módulos
═══════════════════════════════════════════════════════════════════ */
const EventBus = (() => {
  /** @type {Map<string, Set<Function>>} */
  const _listeners = new Map();

  /**
   * Registra listener para um evento
   * @param {string} event
   * @param {Function} handler
   * @returns {Function} unsubscribe
   */
  function on(event, handler) {
    if (!_listeners.has(event)) _listeners.set(event, new Set());
    _listeners.get(event).add(handler);
    return () => _listeners.get(event)?.delete(handler);
  }

  /**
   * Emite um evento com dados opcionais
   * @param {string} event
   * @param {any} [data]
   */
  function emit(event, data) {
    _listeners.get(event)?.forEach(fn => {
      try { fn(data); }
      catch (err) { console.error(`[EventBus] Handler error for "${event}":`, err); }
    });
  }

  /**
   * Remove todos os listeners de um evento
   * @param {string} event
   */
  function off(event) { _listeners.delete(event); }

  return Object.freeze({ on, emit, off });
})();

/* ═══════════════════════════════════════════════════════════════════
   STORE — Single Source of Truth (padrão Redux-like)
═══════════════════════════════════════════════════════════════════ */
const Store = (() => {
  /** @type {import('./types').AppState} */
  const _defaultState = () => ({
    estoque:    [],
    vendas:     [],
    ponto:      [],
    inventario: [],
    caixa:      [],
    comandas:   [],
    investimento: 0,
    config:     { whatsapp: '' },
    delivery:   {
      pedidos:      [],
      clientes:     [],
      entregadores: [],
      zonas:        [],
    },
  });

  let _state = _defaultState();
  let _version = 0;

  /**
   * Retorna referência ao estado atual.
   * ATENÇÃO: não mutar diretamente — use Store.mutate() para mutations controladas.
   * @returns {object}
   */
  function getState() { return _state; }

  /**
   * Executa uma mutação controlada no estado.
   * Garante que _ensureDefaults() é chamado, _version incrementa e o evento state:changed dispara.
   * Use este método em vez de Store.getState().campo = valor.
   * @param {function(object): void} fn — função que recebe o estado mutável
   * @param {boolean} [silent=false]
   */
  function mutate(fn, silent = false) {
    if (typeof fn !== 'function') return;
    const prev = _state;
    try { fn(_state); } catch (err) { console.error('[Store.mutate] Erro na mutação:', err); return; }
    _ensureDefaults();
    _version++;
    if (!silent) EventBus.emit('state:changed', { prev, next: _state, version: _version });
  }

  /**
   * Atualiza estado de forma controlada e emite evento 'state:changed'
   * @param {Partial<object>} patch
   * @param {boolean} [silent=false] — se true, não emite evento
   */
  function setState(patch, silent = false) {
    const prev = _state;
    _state = _mergeDeep(_state, patch);
    _ensureDefaults();
    _version++;
    if (!silent) EventBus.emit('state:changed', { prev, next: _state, version: _version });
  }

  /**
   * Reseta estado para o padrão inicial
   */
  function resetState() {
    _state = _defaultState();
    _version = 0;
    EventBus.emit('state:reset');
  }

  /**
   * Garante que arrays e sub-objetos obrigatórios existem
   * @private
   */
  function _ensureDefaults() {
    const d = _state;
    if (!d.config)              d.config = { whatsapp: '' };
    if (!Array.isArray(d.estoque))    d.estoque    = [];
    if (!Array.isArray(d.vendas))     d.vendas     = [];
    if (!Array.isArray(d.ponto))      d.ponto      = [];
    if (!Array.isArray(d.inventario)) d.inventario = [];
    if (!Array.isArray(d.caixa))      d.caixa      = [];
    if (!Array.isArray(d.comandas))   d.comandas   = [];
    if (typeof d.investimento !== 'number') d.investimento = 0;
    if (!d.delivery) d.delivery = { pedidos: [], clientes: [], entregadores: [], zonas: [] };
    const dlv = d.delivery;
    if (!Array.isArray(dlv.pedidos))      dlv.pedidos      = [];
    if (!Array.isArray(dlv.clientes))     dlv.clientes     = [];
    if (!Array.isArray(dlv.entregadores)) dlv.entregadores = [];
    if (!Array.isArray(dlv.zonas))        dlv.zonas        = [];
  }

  /**
   * Deep merge de objetos (não sobrescreve arrays, apenas objetos simples)
   * @private
   */
  function _mergeDeep(target, source) {
    if (source === null || typeof source !== 'object') return source;
    const output = { ...target };
    for (const key of Object.keys(source)) {
      if (
        source[key] !== null &&
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        typeof target[key] === 'object' &&
        !Array.isArray(target[key])
      ) {
        output[key] = _mergeDeep(target[key] || {}, source[key]);
      } else {
        output[key] = source[key];
      }
    }
    return output;
  }

  /** Selectors — acesso tipado e seguro ao estado */
  const Selectors = Object.freeze({
    getEstoque:        () => _state.estoque,
    getVendas:         () => _state.vendas,
    getPonto:          () => _state.ponto,
    getInventario:     () => _state.inventario,
    getCaixa:          () => _state.caixa,
    getConfig:         () => _state.config,
    getDelivery:       () => _state.delivery,
    getPedidos:        () => _state.delivery.pedidos,
    getZonas:          () => _state.delivery.zonas,
    getEntregadores:   () => _state.delivery.entregadores,
    getInvestimento:   () => _state.investimento,
    getUltimoCaixa:    () => (_state.caixa || [])[0] || null,
    getProdutoById:    id => _state.estoque.find(p => String(p.id) === String(id)) || null,
    getPedidoById:     id => _state.delivery.pedidos.find(p => String(p.id) === String(id)) || null,
    getEntregadorById: id => _state.delivery.entregadores.find(e => String(e.id) === String(id)) || null,
    getZonaById:       id => _state.delivery.zonas.find(z => String(z.id) === String(id)) || null,
    getLowStockItems:  () => _state.estoque.filter(p => p.qtdUn > 0 && p.qtdUn <= CONSTANTS.LOW_STOCK_THRESHOLD),
    getOutOfStockItems:() => _state.estoque.filter(p => p.qtdUn <= 0),
    isCaixaOpen:       () => (_state.caixa || [])[0]?.tipo === 'ABERTURA',
    vendasHoje: () => {
      // dataCurta é YYYY-MM-DD (v6+). Backward-compat: aceita DD/MM/YYYY legado.
      const isoHoje  = Utils.todayISO(); // "2026-03-04"
      const dispHoje = Utils.today();    // "04/03/2026" — compatível com registros antigos
      return _state.vendas.filter(v => {
        const dc = v.dataCurta || '';
        if (dc) return dc === isoHoje || dc === dispHoje || dc.startsWith(dispHoje);
        return (v.data || '').startsWith(dispHoje);
      });
    },
    pedidosAtivosHoje: () => {
      const isoHoje  = Utils.todayISO();
      const dispHoje = Utils.today();
      return _state.delivery.pedidos.filter(p =>
        (p.dataCurta === isoHoje || p.data === dispHoje) &&
        p.status !== 'CANCELADO'
      );
    },
  });

  return Object.freeze({ getState, setState, resetState, mutate, Selectors });
})();

/* ═══════════════════════════════════════════════════════════════════
   SYNC SERVICE — localStorage + Firestore bridge
═══════════════════════════════════════════════════════════════════ */
const SyncService = (() => {
  let _syncLockTimer = null;
  let _isSyncLocked  = false;

  /** Bloqueia sync externo por SYNC_LOCK_DURATION_MS após save local */
  function _acquireSyncLock() {
    _isSyncLocked = true;
    clearTimeout(_syncLockTimer);
    _syncLockTimer = setTimeout(() => {
      _isSyncLocked = false;
      EventBus.emit('sync:unlocked');
    }, CONSTANTS.SYNC_LOCK_DURATION_MS);
  }

  /**
   * Persiste estado no localStorage e dispara backup no Firestore
   * Debounced para evitar escritas excessivas em série
   */
  const persist = Utils.debounce(() => {
    try {
      _acquireSyncLock();
      // Injeta timestamp de modificação para resolução de conflitos no sync remoto
      const stateWithTs = { ...Store.getState(), _updatedAt: Date.now() };
      localStorage.setItem(CONSTANTS.STORAGE_KEY, JSON.stringify(stateWithTs));
      EventBus.emit('sync:saved');

      // Bridge para sync.js (Firestore)
      if (typeof window.CH_BACKUP === 'function') window.CH_BACKUP();

      // Feedback visual de sincronização
      const dot = Utils.el('syncDot');
      if (dot) {
        dot.style.display  = 'block';
        dot.style.background = '#f59e0b';
        setTimeout(() => { dot.style.background = '#10b981'; }, 3_500);
      }
    } catch (err) {
      console.error('[SyncService] Persist failed:', err);
      EventBus.emit('sync:error', err);
    }
  }, CONSTANTS.DEBOUNCE_SAVE_MS);

  /**
   * FIX: persistNow — escrita IMEDIATA no localStorage sem debounce.
   * Usar em operações críticas (checkout, finalizar comanda/delivery) onde
   * um F5 ou fechamento de aba nos próximos 300ms não pode perder a venda.
   * O backup no Firestore ainda usa debounce (CH_BACKUP) para não sobrecarregar.
   */
  function persistNow() {
    try {
      _acquireSyncLock();
      const stateWithTs = { ...Store.getState(), _updatedAt: Date.now() };
      localStorage.setItem(CONSTANTS.STORAGE_KEY, JSON.stringify(stateWithTs));
      EventBus.emit('sync:saved');
      if (typeof window.CH_BACKUP === 'function') window.CH_BACKUP();
      const dot = Utils.el('syncDot');
      if (dot) {
        dot.style.display    = 'block';
        dot.style.background = '#f59e0b';
        setTimeout(() => { dot.style.background = '#10b981'; }, 3_500);
      }
    } catch (err) {
      console.error('[SyncService] PersistNow failed:', err);
      EventBus.emit('sync:error', err);
    }
  }

  /**
   * Carrega estado do localStorage
   * @returns {object|null}
   */
  function load() {
    const raw = localStorage.getItem(CONSTANTS.STORAGE_KEY);
    if (!raw) return null;
    return Utils.safeJsonParse(raw, null);
  }

  /**
   * Aplica dados remotos (Firestore) sem sobrescrever saves locais
   * Chamado por window.CH_SAFE_SYNC do sync.js
   * @param {object} remoteData
   */
  function applyRemoteSync(remoteData) {
    if (_isSyncLocked) {
      console.info('[SyncService] Sync bloqueado — save local em progresso');
      return;
    }
    if (!remoteData || typeof remoteData !== 'object') return;
    try {
      Store.setState(remoteData, true);
      localStorage.setItem(CONSTANTS.STORAGE_KEY, JSON.stringify(Store.getState()));
      EventBus.emit('sync:remote-applied', remoteData);
    } catch (err) {
      console.error('[SyncService] applyRemoteSync failed:', err);
    }
  }

  return Object.freeze({ persist, persistNow, load, applyRemoteSync, get _isSyncLocked() { return _isSyncLocked; } });
})();

/* ═══════════════════════════════════════════════════════════════════
   AUTH SERVICE — Autenticação com PIN + SHA-256
═══════════════════════════════════════════════════════════════════ */
const AuthService = (() => {
  /** @type {'admin'|'pdv'|null} */
  let _role = null;
  let _loginAttempts = 0;
  const MAX_ATTEMPTS = 5;

  /** @returns {'admin'|'pdv'|null} */
  const getRole  = () => _role;
  const isAdmin  = () => _role === 'admin';
  const isLogged = () => _role !== null;

  /**
   * Realiza login assíncrono com validação de PIN via SHA-256
   * @param {string} pin
   * @returns {Promise<boolean>}
   */
  async function login(pin) {
    if (_loginAttempts >= MAX_ATTEMPTS) {
      UIService.showToast('Bloqueado', 'Muitas tentativas. Recarregue a página.', 'error');
      return false;
    }

    const role = await CryptoService.validatePin(String(pin).trim());

    if (!role) {
      _loginAttempts++;
      const remaining = MAX_ATTEMPTS - _loginAttempts;
      UIService.showToast('PIN Inválido', remaining > 0 ? `${remaining} tentativa(s) restante(s)` : 'Conta bloqueada', 'error');
      const pinEl = Utils.el('pinInput');
      if (pinEl) pinEl.value = '';
      return false;
    }

    _loginAttempts = 0;
    _role = role;
    _applyRoleToUI(role);
    EventBus.emit('auth:login', { role });
    return true;
  }

  function logout() {
    _role = null;
    EventBus.emit('auth:logout');
  }

  /** Aplica permissões visuais baseadas no role */
  function _applyRoleToUI(role) {
    const isAdm = role === 'admin';

    document.body.classList.toggle('is-admin', isAdm);
    document.body.classList.toggle('is-pdv',   !isAdm);

    const roleTitle = Utils.el('roleTitle');
    const roleTag   = Utils.el('roleTag');
    if (roleTitle) roleTitle.textContent = isAdm ? 'Administrador' : 'Colaborador';
    if (roleTag) {
      roleTag.textContent = isAdm ? 'ADM' : 'PDV';
      roleTag.className   = `badge ${isAdm ? 'b-blue' : 'b-purple'}`;
      roleTag.classList.remove('hidden');
    }
  }

  return Object.freeze({ login, logout, getRole, isAdmin, isLogged });
})();

/* ═══════════════════════════════════════════════════════════════════
   UI SERVICE — Toast, Modais, Clock, Alertas
═══════════════════════════════════════════════════════════════════ */
const UIService = (() => {
  let _toastTimer  = null;
  let _clockTimer  = null;

  /* ── Toast ─────────────────────────────────────────────── */
  /**
   * Exibe notificação toast
   * @param {string} title
   * @param {string} [subtitle='']
   * @param {'success'|'warning'|'error'} [type='success']
   */
  function showToast(title, subtitle = '', type = 'success') {
    const toast = Utils.el('toast');
    if (!toast) return;

    const config = {
      success: { cls: 'bg-blue-500/20 text-blue-400',  icon: 'check' },
      warning: { cls: 'bg-amber-500/20 text-amber-400', icon: 'exclamation' },
      error:   { cls: 'bg-red-500/20 text-red-400',     icon: 'times' },
    };

    const { cls, icon } = config[type] || config.success;
    const iconEl = Utils.el('toastIcon');
    const msgEl  = Utils.el('toastMsg');
    const subEl  = Utils.el('toastSub');

    if (iconEl) { iconEl.className = `w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${cls}`; iconEl.innerHTML = `<i class="fas fa-${icon} text-[10px]"></i>`; }
    if (msgEl) msgEl.textContent = title;
    if (subEl) subEl.textContent = subtitle;

    toast.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => toast.classList.remove('show'), CONSTANTS.TOAST_DURATION_MS);
  }

  /* ── Modais ─────────────────────────────────────────────── */
  /** @param {string} id */
  function openModal(id) {
    const modal = Utils.el(id);
    if (!modal) return;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    // Trap focus inside modal
    const first = modal.querySelector('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (first) setTimeout(() => first.focus(), 50);
  }

  /** @param {string} id */
  function closeModal(id) {
    const modal = Utils.el(id);
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  /** Fecha modais ao clicar no backdrop */
  function _initModalBackdropClose() {
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', e => {
        if (e.target === modal) closeModal(modal.id);
      });
    });
    // ESC fecha o modal aberto mais recente
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        const open = document.querySelector('.modal.open');
        if (open) closeModal(open.id);
      }
    });
  }

  /* ── Relógio ────────────────────────────────────────────── */
  function startClock() {
    const el = Utils.el('clock');
    if (!el) return;
    clearInterval(_clockTimer);
    const tick = () => { el.textContent = Utils.now(); };
    tick();
    _clockTimer = setInterval(tick, 1_000);
  }

  /* ── Alertas de Estoque ──────────────────────────────────── */
  function refreshAlerts() {
    if (!AuthService.isAdmin()) return;
    const lowCount = Store.Selectors.getLowStockItems().length;
    const btn      = Utils.el('alertaBtn');
    const count    = Utils.el('alertaCount');
    if (!btn) return;
    if (lowCount > 0) {
      if (count) count.textContent = lowCount;
      btn.style.display = 'flex';
      btn.setAttribute('aria-label', `${lowCount} produto(s) com estoque baixo`);
    } else {
      btn.style.display = 'none';
    }
  }

  /* ── Tela de Bloqueio ─────────────────────────────────────── */
  function showLock() {
    const lock = Utils.el('lock');
    if (lock) lock.style.display = 'flex';
    const app = Utils.el('app');
    if (app)  app.style.display  = 'none';
    // Foca no campo PIN e permite Enter para login
    const pin = Utils.el('pinInput');
    if (pin) {
      // Garante que aceita até 5 dígitos (PIN PDV = 12345)
      pin.maxLength = 6;
      setTimeout(() => pin.focus(), 300);
      // Garante abertura do teclado ao tocar na tela (PWA offline)
      const lockEl = Utils.el('lock');
      if (lockEl && !lockEl._tapBound) {
        lockEl._tapBound = true;
        lockEl.addEventListener('click', () => { Utils.el('pinInput')?.focus(); });
      }
      if (!pin._enterBound) {
        pin._enterBound = true;
        pin.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
      }
    }
  }

  function showApp() {
    const lock = Utils.el('lock');
    if (lock) lock.style.display  = 'none';
    const app = Utils.el('app');
    if (app)  app.style.display   = 'flex';
    const dot = Utils.el('syncDot');
    if (dot)  dot.style.display   = 'block';
  }

  /* ── Loader ───────────────────────────────────────────────── */
  function hideLoader() {
    const loader = Utils.el('app-loader');
    if (!loader) return;
    loader.classList.add('hide');
    setTimeout(() => { loader.style.display = 'none'; }, 400);
  }

  return Object.freeze({
    showToast, openModal, closeModal, startClock,
    refreshAlerts, showLock, showApp, hideLoader,
    _initModalBackdropClose,
  });
})();

/* ═══════════════════════════════════════════════════════════════════
   CART SERVICE — Carrinho de compras
═══════════════════════════════════════════════════════════════════ */
/**
 * Verifica se PDV pode registar vendas (ponto + caixa).
 * @returns {string|null} mensagem de bloqueio ou null se liberado
 */
function _getPdvBloqueio() {
  // ADM tem acesso total — sem restrição de ponto/caixa
  if (AuthService.isAdmin()) return null;

  // dataCurta é ISO (v6+); Utils.today() como fallback para registros legados
  const isoHoje  = Utils.todayISO();
  const dispHoje = Utils.today();
  const pontoHoje = Store.getState().ponto?.some(
    p => (p.dataCurta === isoHoje || p.dataCurta === dispHoje || p.data?.startsWith(dispHoje)) &&
         p.tipo === 'ENTRADA'
  );
  const caixaAberto = Store.Selectors.isCaixaOpen();

  if (!pontoHoje && !caixaAberto) return 'Registe o ponto e abra o caixa';
  if (!pontoHoje)                 return 'Registe a entrada do ponto primeiro';
  if (!caixaAberto)               return 'Abra o caixa antes de vender';
  return null;
}

const CartService = (() => {
  /** @type {Array<CartItem>} */
  let _items = [];
  let _formaPgto = '';

  /* ── Getters ─────────────────────────────────────────────── */
  const getItems    = () => [..._items];
  const getTotal    = () => _items.reduce((acc, i) => acc + i.preco, 0);
  const getLucro    = () => _items.reduce((acc, i) => acc + (i.preco - i.custo), 0);
  const getCount    = () => _items.length;
  const isEmpty     = () => _items.length === 0;
  const getFormaPgto = () => _formaPgto;

  /* ── Mutações ────────────────────────────────────────────── */
  /**
   * Adiciona item ao carrinho, verificando estoque
   * @param {string} prodId
   * @param {number} packIdx — 0 = unidade, 1+ = pack
   * @param {HTMLElement|null} btnEl — botão que gerou a ação (para animação)
   */
  function addItem(prodId, packIdx, btnEl = null) {
    const product = Store.Selectors.getProdutoById(prodId);
    if (!product) return;

    // Guard: ponto + caixa obrigatórios
    const bloqueio = _getPdvBloqueio();
    if (bloqueio) {
      UIService.showToast('Acesso Bloqueado', bloqueio, 'error');
      TabManager.switchTab('ponto');
      return;
    }

    /** @type {CartItem} */
    let item;

    if (packIdx === 0) {
      if (product.qtdUn < 1) return UIService.showToast('Sem Estoque', product.nome, 'error');
      item = {
        prodId: product.id,
        nome:    product.nome,
        label:   'UNID',
        preco:   product.precoUn,
        custo:   product.custoUn,
        desconto: 1,
      };
    } else {
      const pack = product.packs?.[packIdx - 1];
      if (!pack) return;
      if (product.qtdUn < pack.un) return UIService.showToast('Estoque Insuficiente', 'Pack cancelado', 'error');
      item = {
        prodId:  product.id,
        nome:    product.nome,
        label:   `PACK ${pack.un}`,
        preco:   pack.preco,
        custo:   product.custoUn * pack.un,
        desconto: pack.un,
      };
    }

    _items.push(item);
    EventBus.emit('cart:item-added', item);

    // Animação no botão
    if (btnEl) {
      const cls = packIdx === 0 ? 'flash-blue' : 'flash-amber';
      btnEl.classList.remove(cls);
      void btnEl.offsetWidth; // reflow
      btnEl.classList.add(cls);
      setTimeout(() => btnEl.classList.remove(cls), CONSTANTS.CART_ANIMATION_MS);
    }
  }

  /**
   * Remove item pelo índice
   * @param {number} index
   */
  function removeItem(index) {
    if (index < 0 || index >= _items.length) return;
    const removed = _items.splice(index, 1)[0];
    EventBus.emit('cart:item-removed', removed);
  }

  /** Limpa todos os itens */
  function clear() {
    _items = [];
    EventBus.emit('cart:cleared');
  }

  /**
   * Define a forma de pagamento
   * @param {string} forma
   */
  function setFormaPgto(forma) {
    _formaPgto = forma;
    EventBus.emit('cart:pgto-set', forma);
  }

  /* ── Checkout ────────────────────────────────────────────── */
  /**
   * Finaliza venda: debita estoque, registra venda e inventário
   * @returns {object|null} venda registrada ou null em caso de erro
   */
  function checkout() {
    if (isEmpty()) return null;

    const now    = new Date();
    const today  = Utils.todayISO();
    const nowStr = Utils.now();
    const ts     = Utils.timestamp();

    const vendaId = Utils.generateId();

    // Debita estoque e registra no inventário via Store.mutate()
    Store.mutate(state => {
      _items.forEach(item => {
        const product = state.estoque.find(p => String(p.id) === String(item.prodId));
        if (!product) return;
        const qtdAntes = product.qtdUn;
        state.inventario.unshift({
          id: Utils.generateId(),
          vendaId,
          produto:       product.nome,
          label:         item.label,
          preco:         item.preco,
          qtdMovimento:  item.desconto,
          qtdAntes,
          qtdDepois:     qtdAntes - item.desconto,
          data:          today,
          hora:          nowStr,
          tipo:          'VENDA',
        });
        product.qtdUn -= item.desconto;
      });
    }, true); // silent=true pois persist() já dispara seu próprio evento

    const venda = {
      id:          vendaId,
      total:       getTotal(),
      lucro:       getLucro(),
      data:        ts,
      dataCurta:   today,
      hora:        nowStr,
      itens:       [..._items],
      formaPgto:   _formaPgto,
      origem:      'PDV',
    };

    Store.mutate(state => { state.vendas.unshift(venda); }, true);
    // FIX: persistNow (sem debounce) garante que a venda está no localStorage
    // imediatamente — evita perda se o utilizador der F5 nos próximos 300ms.
    SyncService.persistNow();

    const vendaSnapshot = { ...venda };
    clear();
    EventBus.emit('cart:checkout', vendaSnapshot);
    return vendaSnapshot;
  }

  return Object.freeze({
    getItems, getTotal, getLucro, getCount, isEmpty, getFormaPgto,
    addItem, removeItem, clear, setFormaPgto, checkout,
  });
})();

/* ═══════════════════════════════════════════════════════════════════
   RENDER SERVICE — Catálogo PDV e Carrinho
═══════════════════════════════════════════════════════════════════ */
const RenderService = (() => {
  /* ── PDV Stats ────────────────────────────────────────────── */
  function updateStats() {
    const estoque  = Store.Selectors.getEstoque();
    const statsEl  = Utils.el('pdvStats');
    if (!statsEl) return;

    if (estoque.length > 0) {
      statsEl.classList.remove('hidden');
      _setText('pdvTotal', estoque.length);
      _setText('pdvLow',   Store.Selectors.getLowStockItems().length);
      _setText('pdvOut',   Store.Selectors.getOutOfStockItems().length);
    } else {
      statsEl.classList.add('hidden');
    }
    UIService.refreshAlerts();
  }

  /* ── Catálogo ─────────────────────────────────────────────── */
  function renderCatalogo() {
    const cont = Utils.el('catalogo');
    if (!cont) return;

    // Verifica bloqueio ponto + caixa
    const bloqueio   = _getPdvBloqueio();
    const warning    = Utils.el('pdvWarning');
    const warningMsg = Utils.el('pdvWarningMsg');
    if (warning) {
      if (bloqueio) {
        warning.classList.remove('hidden');
        if (warningMsg) warningMsg.textContent = bloqueio;
      } else {
        warning.classList.add('hidden');
      }
    }

    const busca   = (Utils.el('searchProd')?.value || '').toLowerCase();
    const estoque = Store.Selectors.getEstoque();
    const filtered = busca
      ? estoque.filter(p => p.nome.toLowerCase().includes(busca))
      : estoque;

    if (filtered.length === 0) {
      cont.innerHTML = `
        <div class="col-span-full flex flex-col items-center justify-center py-20 opacity-20">
          <i class="fas fa-beer text-5xl mb-4 text-slate-600"></i>
          <p class="text-[10px] font-black uppercase tracking-widest text-slate-600">
            ${busca ? 'Nenhum produto encontrado' : 'Catálogo vazio'}
          </p>
        </div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    filtered.forEach(prod => {
      const div = document.createElement('div');
      div.innerHTML = _buildProdCard(prod, !!bloqueio);
      frag.appendChild(div.firstElementChild);
    });
    cont.innerHTML = '';
    cont.appendChild(frag);
    updateStats();
  }

  /**
   * Constrói HTML do card de produto (sem innerHTML concatenado em loop)
   * @param {object} p — produto
   * @returns {string}
   */
  function _buildProdCard(p, bloqueado = false) {
    const esgotado   = p.qtdUn <= 0;
    const baixoStock = !esgotado && p.qtdUn <= CONSTANTS.LOW_STOCK_THRESHOLD;
    const stockCls   = esgotado   ? 'text-red-400'
                     : baixoStock ? 'text-amber-400'
                     :              'text-emerald-400';
    const stockLabel = esgotado   ? 'Esgotado'
                     : baixoStock ? `⚠ ${p.qtdUn}`
                     :              `${p.qtdUn} und`;
    const margem = p.custoUn > 0
      ? `<span class="badge b-green text-[7px]">${((1 - p.custoUn / p.precoUn) * 100).toFixed(0)}%</span>` : '';

    // Packs: só o primeiro pack em mobile (para não encher demais)
    const packsHtml = (p.packs || []).slice(0, 2).map((pk, i) => {
      const desc = ((1 - pk.preco / (p.precoUn * pk.un)) * 100).toFixed(0);
      return `<button class="btn-pk" onclick="addCart('${p.id}', ${i + 1}, this)"
          ${esgotado || p.qtdUn < pk.un || bloqueado ? 'disabled' : ''}>
        <div class="text-[8px] font-black text-amber-400 uppercase leading-none">Pack ${pk.un}</div>
        <div class="text-[10px] font-black text-white leading-tight">R$ ${pk.preco.toFixed(2)}</div>
        ${Number(desc) > 0 ? `<div class="text-[7px] text-amber-300/60">-${desc}%</div>` : ''}
      </button>`;
    }).join('');

    return `
      <article class="prod-card p-3 flex flex-col gap-2 ${esgotado ? 'esgotado' : ''}" data-prod-id="${p.id}">
        <!-- header: nome + margem -->
        <div class="flex items-start justify-between gap-1 min-w-0">
          <div class="min-w-0 flex-1">
            <h3 class="text-[10px] font-black text-slate-200 leading-tight" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${_escapeHtml(p.nome)}</h3>
          </div>
          ${margem}
        </div>
        <!-- preço + stock -->
        <div>
          <p class="text-base font-black text-white leading-none">R$ ${p.precoUn.toFixed(2)}</p>
          <p class="text-[8px] font-bold ${stockCls} mt-0.5">${stockLabel}</p>
        </div>
        <!-- botões -->
        <div class="flex gap-1.5 mt-auto">
          <button class="btn-un flex-1" onclick="addCart('${p.id}', 0, this)"
              ${esgotado || bloqueado ? 'disabled' : ''}>
            <div class="text-[8px] font-black text-blue-400 uppercase leading-none">Unid</div>
            <div class="text-[10px] font-black text-white leading-tight">R$ ${p.precoUn.toFixed(2)}</div>
          </button>
          ${packsHtml}
        </div>
      </article>`;
  }

  /* ── Carrinho ─────────────────────────────────────────────── */
  function renderCarrinho() {
    const items = CartService.getItems();
    const total = CartService.getTotal();
    const count = CartService.getCount();
    const fmtTotal = Utils.formatCurrency(total);

    const emptyHtml = `<div class="flex flex-col items-center justify-center h-full text-center py-10 opacity-20">
      <i class="fas fa-shopping-cart text-4xl mb-3 text-slate-500"></i>
      <p class="text-[10px] text-slate-500 font-black uppercase tracking-wider">Carrinho vazio</p>
    </div>`;

    function fillContainer(cont, btnLimparId) {
      if (!cont) return;
      if (items.length === 0) {
        cont.innerHTML = emptyHtml;
        Utils.el(btnLimparId)?.classList.add('hidden');
      } else {
        const frag = document.createDocumentFragment();
        items.forEach((item, i) => {
          const div = document.createElement('div');
          div.innerHTML = _buildCartItem(item, i);
          frag.appendChild(div.firstElementChild);
        });
        cont.innerHTML = '';
        cont.appendChild(frag);
        Utils.el(btnLimparId)?.classList.remove('hidden');
      }
    }

    // Desktop sidebar
    fillContainer(Utils.el('carrinhoLista'), 'btnLimpar');
    _setText('cartTotal', fmtTotal);
    _setText('cartCount', count > 0 ? `${count} ${count === 1 ? 'item' : 'itens'}` : '');
    const badge = Utils.el('cartBadge');
    if (badge) { badge.textContent = count; badge.classList.toggle('hidden', count === 0); }
    const btn = Utils.el('btnFinalizar');
    if (btn) {
      btn.disabled = count === 0;
      btn.className = count > 0
        ? 'w-full py-4 rounded-xl font-black uppercase text-[10px] tracking-widest transition-all bg-blue-600 text-white shadow-lg shadow-blue-500/25 hover:bg-blue-500'
        : 'w-full py-4 rounded-xl font-black uppercase text-[10px] tracking-widest transition-all bg-slate-800 text-slate-500 cursor-not-allowed';
    }

    // Mobile drawer
    fillContainer(Utils.el('carrinhoListaMob'), 'btnLimparMob');
    _setText('cartTotalMob', fmtTotal);
    _setText('cartCountMob', count > 0 ? `${count} ${count === 1 ? 'item' : 'itens'}` : '');
    const badgeMob = Utils.el('cartBadgeMob');
    if (badgeMob) { badgeMob.textContent = count; badgeMob.classList.toggle('hidden', count === 0); }
    const btnMob = Utils.el('btnFinalizarMob');
    if (btnMob) {
      btnMob.disabled = count === 0;
      btnMob.className = count > 0
        ? 'w-full py-4 rounded-xl font-black uppercase text-[10px] tracking-widest transition-all bg-blue-600 text-white shadow-lg shadow-blue-500/25 hover:bg-blue-500'
        : 'w-full py-4 rounded-xl font-black uppercase text-[10px] tracking-widest transition-all bg-slate-800 text-slate-500 cursor-not-allowed';
    }

    // Float button
    const fl = Utils.el('float-cart');
    if (fl) {
      fl.classList.toggle('show', count > 0);
      if (count > 0) {
        _setText('floatCount', `${count} ${count === 1 ? 'item' : 'itens'}`);
        _setText('floatTotal', fmtTotal);
        _setText('floatBadge', count);
      }
    }
  }

  /**
   * @param {object} item
   * @param {number} index
   * @returns {string}
   */
  function _buildCartItem(item, index) {
    const isUnid = item.label === 'UNID';
    return `
      <div class="flex justify-between items-center bg-slate-950/60 px-4 py-3 rounded-xl border border-white/5 hover:border-white/10 transition-all"
           role="listitem">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${isUnid ? 'bg-blue-500/15' : 'bg-amber-500/15'}" aria-hidden="true">
            <i class="fas ${isUnid ? 'fa-cube text-blue-400' : 'fa-box text-amber-400'} text-[9px]"></i>
          </div>
          <div class="min-w-0">
            <p class="text-[10px] font-black text-slate-300 truncate">${_escapeHtml(item.nome)}</p>
            <p class="text-[9px] text-slate-600 font-bold">
              ${_escapeHtml(item.label)} ·
              <span class="text-blue-400 font-black">${Utils.formatCurrency(item.preco)}</span>
            </p>
          </div>
        </div>
        <button
          onclick="removerCart(${index})"
          class="w-6 h-6 rounded-lg bg-red-500/8 text-red-500/40 hover:bg-red-500/20 hover:text-red-400 flex items-center justify-center transition-all flex-shrink-0 ml-2"
          aria-label="Remover ${_escapeHtml(item.nome)} do carrinho">
          <i class="fas fa-times text-[9px]" aria-hidden="true"></i>
        </button>
      </div>`;
  }

  /* ── Auxiliares ──────────────────────────────────────────── */
  function _setText(id, text) {
    const el = Utils.el(id);
    if (el) el.textContent = text;
  }

  /** Previne XSS em interpolação de strings */
  function _escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  return Object.freeze({ renderCatalogo, renderCarrinho, updateStats, _escapeHtml });
})();

/* ═══════════════════════════════════════════════════════════════════
   TAB MANAGER — Controle de abas com permissão
═══════════════════════════════════════════════════════════════════ */
const TabManager = (() => {
  /** Map de aba → função de render associada */
  const _renderMap = {
    vendas:     () => { RenderService.renderCatalogo(); },
    estoque:    () => { if (typeof renderEstoque    === 'function') renderEstoque();    },
    financeiro: () => { if (typeof renderFinanceiro === 'function') renderFinanceiro(); },
    ponto:      () => { if (typeof renderPonto      === 'function') renderPonto();      },
    dados:      () => { if (typeof renderDados      === 'function') renderDados();      },
    inventario: () => { if (typeof renderInventario === 'function') renderInventario(); },
    comanda:    () => { if (typeof renderComandas   === 'function') renderComandas();   },
    delivery:   () => {
      if (typeof renderDelivery          === 'function') renderDelivery();
      if (typeof populateMpProdutos      === 'function') populateMpProdutos();
      if (typeof populateMpZonas         === 'function') populateMpZonas();
      if (typeof populateMpEntregadores  === 'function') populateMpEntregadores();
    },
  };

  /**
   * Troca de aba com verificação de permissão
   * @param {string} id
   */
  function switchTab(id) {
    const btn = document.querySelector(`[data-tab="${id}"]`);
    if (!btn) return;

    // Verifica permissão para aba restrita
    if (btn.classList.contains('adm') && !AuthService.isAdmin()) {
      UIService.showToast('Acesso Negado', 'Apenas Administradores', 'error');
      return;
    }

    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    const pane = Utils.el(`tab-${id}`);
    if (pane) {
      pane.classList.add('active');
      pane.setAttribute('aria-selected', 'true');
    }
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

    if (id === 'estoque' && typeof resetFormEstoque === 'function') resetFormEstoque();
    _renderMap[id]?.();
    EventBus.emit('tab:switched', id);
  }

  return Object.freeze({ switchTab });
})();

/* ═══════════════════════════════════════════════════════════════════
   VENDA — Fluxo de pagamento e comprovante
═══════════════════════════════════════════════════════════════════ */
const VendaService = (() => {
  /** @type {object|null} */
  let _lastSale = null;

  /** @returns {object|null} */
  const getLastSale = () => _lastSale;

  /** Abre modal de seleção de pagamento */
  function abrirPagamento() {
    if (CartService.isEmpty()) return;

    // Guard: ponto + caixa obrigatórios
    const bloqueio = _getPdvBloqueio();
    if (bloqueio) {
      UIService.showToast('Acesso Bloqueado', bloqueio, 'error');
      TabManager.switchTab('ponto');
      return;
    }

    const resumoEl = Utils.el('vendaResumo');
    if (resumoEl) resumoEl.textContent = `Total: ${Utils.formatCurrency(CartService.getTotal())}`;
    UIService.openModal('modalPagamento');
  }

  /**
   * Confirma forma de pagamento e finaliza venda
   * @param {string} forma
   */
  function confirmarPagamento(forma) {
    CartService.setFormaPgto(forma);
    UIService.closeModal('modalPagamento');
    finalizarVenda();
  }

  /** Executa checkout com guard duplo-clique */
  function finalizarVenda() {
    const btn    = Utils.el('btnFinalizar');
    const btnMob = Utils.el('btnFinalizarMob');
    // FIX: verificar ambos os botões (desktop + mobile) para evitar duplo-toque
    if ((btn?.disabled && btnMob?.disabled) || CartService.isEmpty()) return;
    if (btn)    btn.disabled    = true;
    if (btnMob) btnMob.disabled = true;

    // Áudio de venda
    try { Utils.el('audioVenda')?.play(); } catch (_) {}

    const venda = CartService.checkout();
    if (!venda) { if (btn) btn.disabled = false; return; }

    _lastSale = venda;
    EventBus.emit('venda:concluida', venda);
    UIService.openModal('modalVenda');
  }

  function fecharModalVenda() {
    UIService.closeModal('modalVenda');
    // FIX: re-habilitar ambos os botões (desktop + mobile)
    const btn    = Utils.el('btnFinalizar');
    const btnMob = Utils.el('btnFinalizarMob');
    if (btn)    btn.disabled    = false;
    if (btnMob) btnMob.disabled = false;
  }

  /** Gera e baixa comprovante TXT */
  function baixarComprovante() {
    if (!_lastSale) return;
    let txt = `CH GELADAS — CUPOM NÃO FISCAL\n`;
    txt    += `ID: ${_lastSale.id} | Data: ${_lastSale.data}\n`;
    txt    += `${'─'.repeat(36)}\n`;
    _lastSale.itens.forEach(i => {
      txt += `${i.label === 'UNID' ? '1x' : i.label} ${i.nome} ... ${Utils.formatCurrency(i.preco)}\n`;
    });
    txt += `${'─'.repeat(36)}\n`;
    txt += `Forma de Pgto: ${_lastSale.formaPgto || '—'}\n`;
    txt += `TOTAL: ${Utils.formatCurrency(_lastSale.total)}\n`;
    Utils.downloadBlob(txt, 'text/plain', `Venda_${_lastSale.id}.txt`);
  }

  /** Envia comprovante via WhatsApp */
  function enviarWhatsapp() {
    if (!_lastSale) return;
    const config = Store.Selectors.getConfig();
    if (!config.whatsapp) { UIService.showToast('Configuração', 'Configure o WhatsApp nas configurações', 'error'); return; }
    let msg = `*CH GELADAS | COMPROVANTE*\n📅 ${_lastSale.data}\n${'—'.repeat(26)}\n`;
    _lastSale.itens.forEach(i => { msg += `${i.label === 'UNID' ? '1x' : i.label} ${i.nome} ... ${Utils.formatCurrency(i.preco)}\n`; });
    msg += `${'—'.repeat(26)}\n`;
    if (_lastSale.formaPgto) msg += `Pagamento: ${_lastSale.formaPgto}\n`;
    msg += `*TOTAL: ${Utils.formatCurrency(_lastSale.total)}*\nObrigado pela preferência! 🍺`;
    Utils.openWhatsApp(config.whatsapp, msg);
    fecharModalVenda();
  }

  return Object.freeze({ abrirPagamento, confirmarPagamento, finalizarVenda, fecharModalVenda, baixarComprovante, enviarWhatsapp, getLastSale });
})();

/* ═══════════════════════════════════════════════════════════════════
   BOOTSTRAP — Inicialização da aplicação
═══════════════════════════════════════════════════════════════════ */
const Bootstrap = (() => {
  /**
   * Ponto de entrada. Chamado pelo sync.js após restaurar dados remotos.
   */
  function init() {
    UIService.hideLoader();
    if (!AuthService.isLogged()) {
      UIService.showLock();
    }

    // Carrega estado do localStorage
    const savedData = SyncService.load();
    if (savedData) {
      Store.setState(savedData, true);
    }

    // Inicializa UI
    const invInput = Utils.el('invInput');
    if (invInput) invInput.value = Store.Selectors.getInvestimento() || 0;

    const zapNum = Utils.el('zapNum');
    if (zapNum) zapNum.value = Store.Selectors.getConfig().whatsapp || '';

    // Modo cardápio público (URL hash #pedido)
    if (window.location.hash === '#pedido') {
      UIService.hideLoader();
      if (typeof iniciarPublicOrder === 'function') iniciarPublicOrder();
    }
  }

  /**
   * Finaliza login e inicializa interface completa
   * @param {'admin'|'pdv'} role
   */
  function onLoginSuccess(role) {
    UIService.showApp();
    UIService.showToast('Sessão Iniciada', role === 'admin' ? 'Acesso Total' : 'Modo Colaborador');

    // Avisa se admin está a usar o PIN padrão fraco
    if (role === 'admin') {
      setTimeout(() => {
        UIService.showToast('Segurança', 'PIN padrão detectado — considere alterar nas configurações', 'warning');
      }, 2500);
    }
    UIService.startClock();
    UIService.refreshAlerts();

    // NOTA: o estado já foi carregado em Bootstrap.init() antes do login.
    // Não recarregamos aqui para evitar sobrescrever um sync remoto que possa
    // ter ocorrido entre init() e o momento do login.

    // Renderiza módulos iniciais
    RenderService.renderCatalogo();
    RenderService.renderCarrinho();
    if (typeof renderEstoque    === 'function') renderEstoque();
    if (typeof renderPonto      === 'function') renderPonto();
    if (typeof renderFinanceiro === 'function') renderFinanceiro(); // FIX: era o único módulo não pré-renderizado
    if (typeof renderDelivery   === 'function') renderDelivery();
    if (typeof renderComandas   === 'function') renderComandas();
    if (typeof populateMpZonas       === 'function') populateMpZonas();
    if (typeof populateMpEntregadores === 'function') populateMpEntregadores();

    RenderService.updateStats();
  }

  /**
   * Registra listeners globais de eventos
   */
  function _registerEventListeners() {
    // Reativa renders quando o estado muda via sync remoto
    EventBus.on('sync:remote-applied', () => {
      RenderService.renderCatalogo();
      RenderService.updateStats();
    });

    // Atualiza aviso do PDV quando caixa ou ponto muda
    EventBus.on('caixa:aberto',     () => RenderService.renderCatalogo());
    EventBus.on('caixa:fechado',    () => RenderService.renderCatalogo());
    EventBus.on('ponto:registered', () => RenderService.renderCatalogo());

    // Renderiza carrinho sempre que muda
    EventBus.on('cart:item-added',   () => RenderService.renderCarrinho());
    EventBus.on('cart:item-removed', () => RenderService.renderCarrinho());
    EventBus.on('cart:cleared',      () => RenderService.renderCarrinho());
    EventBus.on('cart:checkout',     () => RenderService.updateStats());

    // Float-cart bounce ao adicionar item
    EventBus.on('cart:item-added', () => {
      const fl = Utils.el('float-cart');
      if (fl) {
        fl.style.transform = 'scale(1.08)';
        setTimeout(() => { fl.style.transform = 'scale(1)'; }, 200);
      }
    });

    // Hash change para cardápio público
    window.addEventListener('hashchange', () => {
      if (window.location.hash === '#pedido') {
        if (Utils.el('app')?.style.display !== 'none') {
          if (typeof iniciarPublicOrder === 'function') iniciarPublicOrder();
        }
      }
    });

    // Modais: fecha no backdrop e ESC
    UIService._initModalBackdropClose();
  }

  function start() {
    _registerEventListeners();

    // Captura CH_INIT ANTES de definir o wrapper, para evitar referência circular.
    const _originalCHInit = window.CH_INIT;

    // Fallback de segurança: se sync.js não chamar CH_INIT em SYNC_FALLBACK_MS,
    // o app inicializa em modo offline para não travar o utilizador.
    let _initDispatched = false; // garante que Bootstrap.init() roda no máximo UMA VEZ

    window.CH_INIT = function () {
      if (_initDispatched) {
        console.warn('[Bootstrap] CH_INIT chamado mais de uma vez — ignorado');
        return;
      }
      _initDispatched = true;
      _originalCHInit?.();
    };

    setTimeout(() => {
      if (_initDispatched) return; // já inicializado pelo sync.js — não faz nada
      const loader = Utils.el('app-loader');
      const loaderAindaAtivo = loader && !loader.classList.contains('hide');
      if (loaderAindaAtivo) {
        console.warn('[Bootstrap] Fallback offline ativado — sync.js não chamou CH_INIT a tempo');
        Bootstrap.init(); // chama diretamente (não via window.CH_INIT para não marcar _initDispatched antes)
        _initDispatched = true;
      }
    }, CONSTANTS.SYNC_FALLBACK_MS);
  }

  return Object.freeze({ init, onLoginSuccess, start });
})();

/* ═══════════════════════════════════════════════════════════════════
   WINDOW BRIDGES — API pública para sync.js e HTML inline
═══════════════════════════════════════════════════════════════════ */

/** Chamado pelo sync.js após restaurar dados */
window.CH_INIT = Bootstrap.init;

/** Chamado pelo sync.js ao receber snapshot do Firestore */
window.CH_SAFE_SYNC = SyncService.applyRemoteSync;

/** Flag de lock de sync para sync.js */
Object.defineProperty(window, 'CH_SYNC_LOCK', {
  get: () => SyncService._isSyncLocked ?? false,
  configurable: true,
});

/* ── Funções globais mantidas para compatibilidade com HTML inline ── */

/** @deprecated Use TabManager.switchTab */
function switchTab(id)           { TabManager.switchTab(id); }

/** @deprecated Use UIService.openModal */
function openModal(id)           { UIService.openModal(id); }

/** @deprecated Use UIService.closeModal */
function closeModal(id)          { UIService.closeModal(id); }

/** @deprecated Use UIService.showToast */
function showToast(msg, sub, type) { UIService.showToast(msg, sub, type); }

/** @deprecated Use Utils.downloadBlob */
function dlBlob(c, m, f)        { Utils.downloadBlob(c, m, f); }

/** @deprecated Use RenderService.renderCatalogo */
function renderCatalogo()        { RenderService.renderCatalogo(); }

/** @deprecated Use RenderService.updateStats */
function updateStats()           { RenderService.updateStats(); }

/** Adiciona item ao carrinho — chamado por onclick nos cards */
function addCart(prodId, packIdx, btnEl) { CartService.addItem(prodId, packIdx, btnEl); }

function removerCart(i)          { CartService.removeItem(i); }

function limparCarrinho() {
  if (CartService.isEmpty()) return;
  if (confirm(`Limpar ${CartService.getCount()} ${CartService.getCount() === 1 ? 'item' : 'itens'}?`)) {
    CartService.clear();
    UIService.showToast('Carrinho', 'Limpo', 'warning');
  }
}

function abrirDrawer() {
  const drawer = Utils.el('carrinhoDrawer');
  const bg     = Utils.el('drawerBg');
  const panel  = Utils.el('drawerPanel');
  if (!drawer) return;
  drawer.style.visibility    = 'visible';
  drawer.style.pointerEvents = 'auto';
  requestAnimationFrame(() => {
    if (bg)    bg.style.opacity        = '1';
    if (panel) panel.style.transform   = 'translateY(0)';
  });
}

function fecharDrawer() {
  const drawer = Utils.el('carrinhoDrawer');
  const bg     = Utils.el('drawerBg');
  const panel  = Utils.el('drawerPanel');
  if (!drawer) return;
  if (bg)    bg.style.opacity      = '0';
  if (panel) panel.style.transform = 'translateY(100%)';
  setTimeout(() => {
    drawer.style.visibility    = 'hidden';
    drawer.style.pointerEvents = 'none';
  }, 320);
}

function abrirPagamento()        { VendaService.abrirPagamento(); }
function confirmarPagamento(f)   { VendaService.confirmarPagamento(f); }
function finalizarVenda()        { VendaService.finalizarVenda(); }
function fecharModalVenda()      { VendaService.fecharModalVenda(); }
function baixarTxt()             { VendaService.baixarComprovante(); }
function enviarWhatsapp()        { VendaService.enviarWhatsapp(); }

function salvarZap() {
  const raw = Utils.el('zapNum')?.value || '';
  Store.mutate(state => { state.config.whatsapp = raw.replace(/\D/g, ''); }, true);
  SyncService.persist();
  UIService.closeModal('modalZap');
  UIService.showToast('WhatsApp', 'Número salvo');
}

/** Login assíncrono com PIN */
async function doLogin() {
  const pin = Utils.el('pinInput')?.value || '';
  const success = await AuthService.login(pin);
  if (success) Bootstrap.onLoginSuccess(AuthService.getRole());
}

/**
 * Auto-login chamado a cada keystroke.
 * Só dispara quando o comprimento do PIN é inequívoco:
 *  - 3 dígitos → pode ser admin (001) → só tenta se NENHUM PIN maior for possível.
 *    Para evitar consumir tentativas enquanto o PDV ainda digita, usamos um delay
 *    cancelável: se o utilizador continuar digitando, o auto-login é abortado.
 */
let _checkPinTimer = null;
function checkPin(val) {
  clearTimeout(_checkPinTimer);
  const len = String(val).trim().length;

  // PIN de 5 dígitos: tenta imediatamente (comprimento final do PIN PDV)
  if (len === 5 || len === 6) {
    doLogin();
    return;
  }

  // PIN de 3 dígitos: aguarda 600ms para ver se o utilizador continua a digitar.
  // Isso evita consumir tentativas de quem está a digitar o PIN de 5 dígitos.
  if (len === 3) {
    _checkPinTimer = setTimeout(() => {
      // Verifica novamente o comprimento actual (pode ter mudado)
      const currentLen = String(Utils.el('pinInput')?.value || '').trim().length;
      if (currentLen === 3) doLogin();
    }, 600);
  }
}




function verificarAlertas()      { UIService.refreshAlerts(); }

/** Salva estado — bridge para módulos externos */
function save() { SyncService.persist(); }

/** Referência legada ao db — somente leitura para prevenir sobrescrita do estado via console */
Object.defineProperty(window, 'db', {
  get: () => Store.getState(),
  // setter removido intencionalmente (LOW-07): expor setter permite que qualquer
  // script ou extensão do browser sobrescreva todo o estado com db = {}.
  // Use Store.setState() ou Store.mutate() nos módulos internos.
  configurable: true,
});

/** Referência legada a isAdmin */
Object.defineProperty(window, 'isAdmin', {
  get: () => AuthService.isAdmin(),
  configurable: true,
});

/** Referência legada a lastSale */
Object.defineProperty(window, 'lastSale', {
  get: () => VendaService.getLastSale(),
  configurable: true,
});

/* ── Inicia a aplicação ─────────────────────────────────────────── */
Bootstrap.start();
