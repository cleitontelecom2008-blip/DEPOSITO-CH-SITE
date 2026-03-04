/**
 * @fileoverview CH Geladas PDV — Ponto, Caixa, Inventário e Dados Module
 * @version 5.0.0-enterprise
 *
 * Módulos:
 *  - PontoService       → Registro de ponto de colaboradores
 *  - CaixaService       → Abertura e fechamento de caixa
 *  - InventoryRenderer  → Renderização do inventário e caixa
 *  - PontoRenderer      → Renderização do módulo de ponto
 *  - DataService        → Backup, importação e reset
 *  - EstoqueService     → Gerência de produtos no estoque
 *  - EstoqueRenderer    → Renderização do catálogo de estoque (admin)
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════
   PONTO SERVICE — Registro de entrada/saída
═══════════════════════════════════════════════════════════════════ */
const PontoService = (() => {
  const TIPOS = Object.freeze({ ENTRADA: 'ENTRADA', SAIDA: 'SAÍDA' });

  /**
   * Registra ponto de entrada ou saída
   * @param {'ENTRADA'|'SAÍDA'} tipo
   */
  function registrar(tipo) {
    const nome = Utils.el('pontNomeLive')?.value.trim() || '';
    if (!Validators.isNonEmptyString(nome)) {
      UIService.showToast('Erro', 'Insira o nome do colaborador', 'error');
      return;
    }
    Store.mutate(state => {
      state.ponto.unshift({
        id:        Utils.generateId(),
        nome,
        tipo,
        data:      Utils.timestamp(),
        dataCurta: Utils.todayISO(),
      });
    }, true);
    SyncService.persist();
    UIService.showToast('Ponto', `${nome} → ${tipo}`);
    EventBus.emit('ponto:registered', { nome, tipo });
  }

  /**
   * Abre modal de edição de um registro
   * @param {number|string} id
   */
  function abrirEditar(id) {
    const reg = Store.getState().ponto.find(p => String(p.id) === String(id));
    if (!reg) return;
    const set = (elId, val) => { const el = Utils.el(elId); if (el) el.value = val ?? ''; };
    set('pontIdx',  reg.id);
    set('pontNome', reg.nome);
    set('pontData', reg.data);
    _setPontoTipoBtn(reg.tipo);
    UIService.openModal('modalEditPonto');
  }

  /**
   * Salva edição de registro de ponto
   */
  function salvarEdicao() {
    const id   = String(Utils.el('pontIdx')?.value || '');
    const nome = Utils.el('pontNome')?.value.trim() || '';
    const tipo = Utils.el('pontTipo')?.value || '';
    const data = Utils.el('pontData')?.value.trim() || '';

    if (!Validators.isNonEmptyString(nome)) {
      UIService.showToast('Erro', 'Nome é obrigatório', 'error');
      return;
    }

    let found = false;
    Store.mutate(state => {
      const idx = state.ponto.findIndex(p => String(p.id) === id);
      if (idx !== -1) {
        state.ponto[idx] = { ...state.ponto[idx], nome, tipo, data };
        found = true;
      }
    }, true);
    if (!found) return;
    SyncService.persist();
    UIService.closeModal('modalEditPonto');
    UIService.showToast('Ponto', 'Registo atualizado');
    EventBus.emit('ponto:updated');
  }

  /**
   * Remove registro de ponto
   * @param {number|string} id
   */
  function apagar(id) {
    const reg = Store.getState().ponto.find(p => String(p.id) === String(id));
    if (!reg) return;
    if (!confirm(`Apagar registo de ${reg.nome}?`)) return;
    Store.mutate(state => {
      const idx = state.ponto.findIndex(p => String(p.id) === String(id));
      if (idx !== -1) state.ponto.splice(idx, 1);
    }, true);
    SyncService.persist();
    UIService.showToast('Ponto', 'Registo apagado', 'warning');
    EventBus.emit('ponto:deleted');
  }

  /**
   * Limpa todos os registros (apenas admin)
   */
  function limparTodos() {
    if (!AuthService.isAdmin()) return;
    if (!confirm('Apagar TODOS os registos de ponto? Esta ação não pode ser desfeita.')) return;
    Store.mutate(state => { state.ponto.splice(0); }, true);
    SyncService.persist();
    UIService.showToast('Ponto', 'Todos os registos apagados', 'warning');
    EventBus.emit('ponto:cleared');
  }

  /**
   * Atualiza botões visuais de tipo no modal de edição
   * @param {'ENTRADA'|'SAÍDA'} tipo
   */
  function _setPontoTipoBtn(tipo) {
    const tipoEl = Utils.el('pontTipo');
    if (tipoEl) tipoEl.value = tipo;

    const btnE = Utils.el('pontBtnE');
    const btnS = Utils.el('pontBtnS');

    const activeE = tipo === TIPOS.ENTRADA;
    if (btnE) btnE.className = `py-3 rounded-xl font-black uppercase text-xs border transition-all ${activeE ? 'bg-emerald-600/30 text-emerald-300 border-emerald-500/50' : 'bg-slate-800 text-slate-500 border-white/5'}`;
    if (btnS) btnS.className = `py-3 rounded-xl font-black uppercase text-xs border transition-all ${!activeE ? 'bg-red-600/30 text-red-300 border-red-500/50' : 'bg-slate-800 text-slate-500 border-white/5'}`;
  }

  return Object.freeze({ TIPOS, registrar, abrirEditar, salvarEdicao, apagar, limparTodos, _setPontoTipoBtn });
})();

/* ═══════════════════════════════════════════════════════════════════
   CAIXA SERVICE — Abertura e fechamento
═══════════════════════════════════════════════════════════════════ */
const CaixaService = (() => {
  /**
   * Abre modal de abertura de caixa
   */
  function abrirModalAbertura() {
    // Guard: impede dupla abertura
    if (Store.Selectors.isCaixaOpen()) {
      UIService.showToast('Atenção', 'Caixa já está aberto', 'warning');
      return;
    }
    const input = Utils.el('valorInicialCaixa');
    if (input) input.value = '';
    UIService.openModal('modalAbrirCaixa');
    setTimeout(() => input?.focus(), 220);
  }

  /**
   * Confirma abertura de caixa
   */
  function confirmarAbertura() {
    // Guard duplo (caso modal tenha ficado aberto)
    if (Store.Selectors.isCaixaOpen()) {
      UIService.closeModal('modalAbrirCaixa');
      UIService.showToast('Atenção', 'Caixa já está aberto', 'warning');
      return;
    }
    const raw = Utils.el('valorInicialCaixa')?.value || '0';
    const val = parseFloat(raw.replace(',', '.')) || 0;
    if (val < 0) { UIService.showToast('Erro', 'Valor não pode ser negativo', 'error'); return; }

    _registrarMovimento('ABERTURA', val, 'Abertura de caixa');
    UIService.closeModal('modalAbrirCaixa');
    UIService.showToast('Caixa Aberto', `Troco inicial: ${Utils.formatCurrency(val)}`);
    EventBus.emit('caixa:aberto', val);
  }

  /**
   * Abre modal de fechamento de caixa
   */
  function abrirModalFechamento() {
    if (!Store.Selectors.isCaixaOpen()) {
      UIService.showToast('Atenção', 'Caixa já está fechado', 'warning');
      return;
    }
    const input = Utils.el('valorFinalCaixa');
    if (input) input.value = '';

    // Oculta diferença até o usuário digitar
    const difEl = Utils.el('fcDiferenca');
    if (difEl) difEl.classList.add('hidden');

    _preencherResumoDia();
    UIService.openModal('modalFecharCaixa');
    setTimeout(() => input?.focus(), 220);

    // Calcula diferença em tempo real conforme o usuário digita
    if (input) {
      input.oninput = () => _atualizarDiferenca();
    }
  }

  /**
   * Calcula e preenche o resumo do dia no modal de fechamento.
   * Considera todas as vendas do dia (PDV + Comanda + Delivery).
   */
  function _preencherResumoDia() {
    // FIX: Utils.formatCurrency está sempre disponível (app-core.js carrega antes deste módulo)
    const fmt = v => Utils.formatCurrency(v);
    const _s  = (id, val) => { const el = Utils.el(id); if (el) el.textContent = val; };

    // Troco inicial da última abertura de caixa
    const ultimoEvento = Store.Selectors.getCaixa();
    let trocoInicial = 0;
    // Encontra a ABERTURA mais recente (pode haver fechamentos anteriores)
    const ultimaAbertura = (ultimoEvento || []).find(c => c.tipo === 'ABERTURA');
    if (ultimaAbertura) trocoInicial = parseFloat(ultimaAbertura.valor) || 0;

    // Vendas do dia usando a mesma lógica de _dataVenda do FinanceCalc
    const hoje = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();

    function _dataVenda(v) {
      const raw = v.dataCurta || (v.data || '').slice(0, 10) || '';
      if (raw.includes('/')) {
        const [d, m, y] = raw.split('/');
        return y ? `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}` : raw;
      }
      return raw.slice(0, 10);
    }

    const vendasHoje = Store.Selectors.getVendas().filter(v => _dataVenda(v) === hoje);

    const FORMAS_DINHEIRO = ['dinheiro', 'espécie', 'especie', 'cash'];
    const vendasDinheiro = vendasHoje
      .filter(v => FORMAS_DINHEIRO.includes((v.formaPgto || '').toLowerCase()))
      .reduce((a, v) => a + (v.total || 0), 0);

    const vendasOutros = vendasHoje
      .filter(v => !FORMAS_DINHEIRO.includes((v.formaPgto || '').toLowerCase()))
      .reduce((a, v) => a + (v.total || 0), 0);

    const totalVendido = vendasHoje.reduce((a, v) => a + (v.total || 0), 0);
    const esperado     = trocoInicial + vendasDinheiro;

    const qtdPdv      = vendasHoje.filter(v => v.origem === 'PDV').length;
    const qtdComanda  = vendasHoje.filter(v => v.origem === 'COMANDA').length;
    const qtdDelivery = vendasHoje.filter(v => v.origem === 'DELIVERY').length;

    _s('fcTrocoInicial',   fmt(trocoInicial));
    _s('fcVendasDinheiro', fmt(vendasDinheiro));
    _s('fcVendasOutros',   fmt(vendasOutros));
    _s('fcTotalVendido',   fmt(totalVendido));
    _s('fcEsperado',       fmt(esperado));
    _s('fcQtdVendas',      `${qtdPdv} PDV · ${qtdComanda} comanda(s) · ${qtdDelivery} delivery`);

    // Guarda o valor esperado para calcular diferença
    const modalEl = Utils.el('modalFecharCaixa');
    if (modalEl) modalEl.dataset.esperado = esperado.toFixed(2);
  }

  /**
   * Atualiza indicador de diferença (sobra/falta) em tempo real.
   */
  function _atualizarDiferenca() {
    const input    = Utils.el('valorFinalCaixa');
    const difEl    = Utils.el('fcDiferenca');
    const modalEl  = Utils.el('modalFecharCaixa');
    if (!input || !difEl || !modalEl) return;

    const apurado  = parseFloat(input.value) || 0;
    const esperado = parseFloat(modalEl.dataset.esperado) || 0;
    const diff     = apurado - esperado;

    if (input.value === '') { difEl.classList.add('hidden'); return; }

    difEl.classList.remove('hidden');
    const fmt = v => Utils.formatCurrency(Math.abs(v));

    if (Math.abs(diff) < 0.01) {
      difEl.textContent = '✅ Caixa fechando no valor exato';
      difEl.className   = 'text-[9px] font-black text-center mt-2 text-emerald-400';
    } else if (diff > 0) {
      difEl.textContent = `⬆ Sobra ${fmt(diff)} em relação ao esperado`;
      difEl.className   = 'text-[9px] font-black text-center mt-2 text-amber-400';
    } else {
      difEl.textContent = `⬇ Falta ${fmt(diff)} em relação ao esperado`;
      difEl.className   = 'text-[9px] font-black text-center mt-2 text-red-400';
    }
  }

  /**
   * Confirma fechamento de caixa
   */
  function confirmarFechamento() {
    const raw = Utils.el('valorFinalCaixa')?.value || '0';
    const val = parseFloat(raw.replace(',', '.')) || 0;
    if (val < 0) { UIService.showToast('Erro', 'Valor não pode ser negativo', 'error'); return; }

    _registrarMovimento('FECHAMENTO', val, 'Fechamento de caixa');
    UIService.closeModal('modalFecharCaixa');
    UIService.showToast('Caixa Fechado', `Valor apurado: ${Utils.formatCurrency(val)}`, 'warning');
    EventBus.emit('caixa:fechado', val);
  }

  /**
   * Registra evento de caixa e persiste
   * @param {'ABERTURA'|'FECHAMENTO'} tipo
   * @param {number} valor
   * @param {string} descricao
   */
  function _registrarMovimento(tipo, valor, descricao) {
    Store.mutate(state => {
      if (!Array.isArray(state.caixa)) state.caixa = [];
      state.caixa.unshift({
        id:        Utils.generateId(),
        tipo,
        valor,
        descricao,
        data:      Utils.today(),
        hora:      Utils.now(),
        timestamp: Date.now(),
      });
    }, true);
    SyncService.persist();
  }

  return Object.freeze({ abrirModalAbertura, confirmarAbertura, abrirModalFechamento, confirmarFechamento });
})();

/* ═══════════════════════════════════════════════════════════════════
   PONTO RENDERER — Renderização do módulo de ponto
═══════════════════════════════════════════════════════════════════ */
const PontoRenderer = (() => {
  function renderPonto() {
    _renderStatusCaixa();
    _renderPontoLogs();
    _renderPontoResumo();
  }

  /* ── Status do caixa ─────────────────────────────────────── */
  function _renderStatusCaixa() {
    const statusEl = Utils.el('caixaStatus');
    if (!statusEl) return;

    const ultimo = Store.Selectors.getUltimoCaixa();
    if (!ultimo) {
      statusEl.className = 'mb-4 p-4 rounded-xl border text-center border-slate-700 bg-slate-900/30';
      statusEl.innerHTML = '<p class="text-xs font-black uppercase text-slate-500"><i class="fas fa-question-circle mr-2" aria-hidden="true"></i>Sem registo de caixa</p>';
      statusEl.setAttribute('aria-label', 'Sem registo de caixa');
      return;
    }

    const isAberto = ultimo.tipo === 'ABERTURA';
    const cor      = isAberto ? 'emerald' : 'red';
    const icon     = isAberto ? 'fa-cash-register' : 'fa-lock';
    const label    = isAberto ? 'Caixa Aberto' : 'Caixa Fechado';
    const detalhe  = ultimo.valor != null
      ? ` · ${isAberto ? 'Troco' : 'Apurado'}: ${Utils.formatCurrency(parseFloat(ultimo.valor))}`
      : '';

    statusEl.className = `mb-4 p-4 rounded-xl border text-center border-${cor}-500/30 bg-${cor}-500/10`;
    statusEl.innerHTML = `<p class="text-xs font-black uppercase text-${cor}-400"><i class="fas ${icon} mr-2" aria-hidden="true"></i>${label} · ${ultimo.hora}${detalhe}</p>`;
    statusEl.setAttribute('aria-label', `${label}${detalhe}`);

    // Atualiza estado visual dos botões Abrir/Fechar
    const btnAbrir  = Utils.el('btnAbrirCaixa');
    const btnFechar = Utils.el('btnFecharCaixa');
    if (btnAbrir) {
      btnAbrir.disabled = isAberto;
      btnAbrir.className = isAberto
        ? 'py-4 rounded-xl bg-slate-800 text-slate-600 border border-slate-700 font-black text-xs uppercase cursor-not-allowed'
        : 'py-4 rounded-xl bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 font-black text-xs uppercase hover:bg-emerald-600/30 transition-all';
    }
    if (btnFechar) {
      btnFechar.disabled = !isAberto;
      btnFechar.className = !isAberto
        ? 'py-4 rounded-xl bg-slate-800 text-slate-600 border border-slate-700 font-black text-xs uppercase cursor-not-allowed'
        : 'py-4 rounded-xl bg-red-600/20 text-red-300 border border-red-500/30 font-black text-xs uppercase hover:bg-red-600/30 transition-all';
    }
  }

  /* ── Logs de ponto ───────────────────────────────────────── */
  function _renderPontoLogs() {
    const cont = Utils.el('pontoLogs');
    if (!cont) return;

    const filtro  = (Utils.el('filtroPonto')?.value || '').toLowerCase();
    const pontos  = Store.getState().ponto || [];
    const filtrados = filtro
      ? pontos.filter(p => p.nome.toLowerCase().includes(filtro))
      : pontos;

    if (filtrados.length === 0) {
      cont.innerHTML = `
        <div class="text-center py-8 text-slate-700 text-[10px] font-bold uppercase" role="status">
          <i class="fas fa-clock text-2xl block mb-2" aria-hidden="true"></i>
          Sem registos${filtro ? ' para este filtro' : ''}
        </div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    filtrados.forEach(p => {
      const isEntrada = p.tipo === 'ENTRADA';
      const div = document.createElement('div');
      div.innerHTML = `
        <div class="flex items-center justify-between bg-slate-900/50 p-4 rounded-2xl border border-white/5 hover:bg-slate-900 transition-all" role="row">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-xl flex items-center justify-center ${isEntrada ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}" aria-hidden="true">
              <i class="fas ${isEntrada ? 'fa-sign-in-alt' : 'fa-sign-out-alt'} text-xs"></i>
            </div>
            <div>
              <span class="block text-[11px] font-black text-slate-200">${RenderService._escapeHtml(p.nome)}</span>
              <span class="text-[9px] text-slate-500">${p.data}</span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <span class="badge ${isEntrada ? 'b-green' : 'b-red'}" role="status">${p.tipo}</span>
            ${AuthService.isAdmin() ? `
              <button onclick="abrirEditarPonto('${p.id}')" class="w-7 h-7 rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500 hover:text-white flex items-center justify-center transition-all" aria-label="Editar registo de ${RenderService._escapeHtml(p.nome)}"><i class="fas fa-edit text-[9px]" aria-hidden="true"></i></button>
              <button onclick="apagarPonto('${p.id}')" class="w-7 h-7 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white flex items-center justify-center transition-all" aria-label="Apagar registo de ${RenderService._escapeHtml(p.nome)}"><i class="fas fa-trash text-[9px]" aria-hidden="true"></i></button>` : ''}
          </div>
        </div>`;
      frag.appendChild(div.firstElementChild);
    });
    cont.innerHTML = '';
    cont.appendChild(frag);
  }

  /* ── Resumo por colaborador ──────────────────────────────── */
  function _renderPontoResumo() {
    const resumoEl = Utils.el('pontoResumo');
    if (!resumoEl) return;

    const pontos = Store.getState().ponto || [];
    /** @type {Object.<string, {e: number, s: number}>} */
    const map = {};
    pontos.forEach(p => {
      if (!map[p.nome]) map[p.nome] = { e: 0, s: 0 };
      if (p.tipo === 'ENTRADA') map[p.nome].e++;
      else map[p.nome].s++;
    });

    const nomes = Object.keys(map);
    if (nomes.length === 0) {
      resumoEl.innerHTML = '<p class="col-span-2 text-[9px] text-slate-600 text-center font-bold uppercase py-2">Sem registos ainda</p>';
      return;
    }

    resumoEl.innerHTML = nomes.map(n => `
      <div class="bg-black/20 p-4 rounded-xl border border-white/5">
        <p class="text-[10px] font-black text-slate-300 mb-2 truncate">${RenderService._escapeHtml(n)}</p>
        <div class="flex gap-2">
          <span class="badge b-green"><i class="fas fa-sign-in-alt mr-1" aria-hidden="true"></i>${map[n].e}</span>
          <span class="badge b-red"><i class="fas fa-sign-out-alt mr-1" aria-hidden="true"></i>${map[n].s}</span>
        </div>
      </div>`).join('');
  }

  return Object.freeze({ renderPonto });
})();

/* ═══════════════════════════════════════════════════════════════════
   INVENTORY RENDERER — Inventário e logs de caixa
═══════════════════════════════════════════════════════════════════ */
const InventoryRenderer = (() => {
  const TYPE_CONFIG = Object.freeze({
    DEVOLUCAO: { cls: 'bg-amber-500/10 text-amber-400',  icon: 'fa-undo',       border: 'border-l-amber-500/40' },
    DELIVERY:  { cls: 'bg-purple-500/10 text-purple-400', icon: 'fa-motorcycle', border: 'border-l-purple-500/40' },
    VENDA:     { cls: 'bg-blue-500/10 text-blue-400',     icon: 'fa-box',        border: 'border-l-blue-500/40' },
  });

  function renderInventario() {
    _renderInventarioLogs();
    _renderCaixaLogs();
  }

  function _renderInventarioLogs() {
    const cont = Utils.el('invLogs');
    if (!cont) return;

    const filtroData = Utils.el('filtroInvData')?.value || '';
    const todos      = Store.Selectors.getInventario() || [];
    const filtrados  = filtroData
      ? todos.filter(r => {
          const [d, m, y] = (r.data || '').split('/');
          return `${y}-${m}-${d}` === filtroData;
        })
      : todos;

    if (filtrados.length === 0) {
      cont.innerHTML = `
        <div class="text-center py-10 text-slate-700 text-[10px] font-bold uppercase" role="status">
          <i class="fas fa-clipboard text-2xl block mb-3" aria-hidden="true"></i>
          Sem registos${filtroData ? ' para esta data' : ''}
        </div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    filtrados.forEach(r => {
      const config = TYPE_CONFIG[r.tipo] || TYPE_CONFIG.VENDA;
      const div    = document.createElement('div');
      div.innerHTML = `
        <article
          class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900/50 p-4 rounded-2xl border border-white/5 hover:bg-slate-900 transition-all ${r.tipo !== 'VENDA' ? `border-l-2 ${config.border}` : ''}"
          role="row">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center ${config.cls}" aria-hidden="true">
              <i class="fas ${config.icon} text-sm"></i>
            </div>
            <div class="min-w-0">
              <p class="text-[11px] font-black text-slate-200 truncate">${RenderService._escapeHtml(r.produto)}</p>
              <p class="text-[9px] text-slate-500 font-bold">
                ${RenderService._escapeHtml(r.label)}
                ${r.preco > 0 ? `· ${Utils.formatCurrency(r.preco)}` : ''}
              </p>
            </div>
          </div>
          <div class="flex items-center gap-4 flex-shrink-0" role="group" aria-label="Movimentação de estoque">
            <div class="text-center">
              <p class="text-[7px] text-slate-600 uppercase font-bold mb-0.5">Antes</p>
              <p class="text-sm font-black text-amber-400" aria-label="Antes: ${r.qtdAntes}">${r.qtdAntes}</p>
            </div>
            <div class="w-5 text-center text-slate-600" aria-hidden="true">→</div>
            <div class="text-center">
              <p class="text-[7px] text-slate-600 uppercase font-bold mb-0.5">Depois</p>
              <p class="text-sm font-black ${r.qtdDepois <= 0 ? 'text-red-400' : r.qtdDepois <= CONSTANTS.LOW_STOCK_THRESHOLD ? 'text-amber-400' : 'text-emerald-400'}" aria-label="Depois: ${r.qtdDepois}">${r.qtdDepois}</p>
            </div>
            <div class="text-right">
              <p class="text-[9px] font-black text-slate-300">${r.data}</p>
              <p class="text-[8px] text-slate-600 font-bold">${r.hora}</p>
            </div>
          </div>
        </article>`;
      frag.appendChild(div.firstElementChild);
    });
    cont.innerHTML = '';
    cont.appendChild(frag);
  }

  function _renderCaixaLogs() {
    const cont = Utils.el('caixaLogs');
    if (!cont) return;

    const logs = Store.Selectors.getCaixa() || [];
    if (logs.length === 0) {
      cont.innerHTML = '<div class="text-center py-6 text-slate-700 text-[10px] font-bold uppercase" role="status">Sem registos de caixa</div>';
      return;
    }

    cont.innerHTML = logs.map(c => {
      const isAbertura = c.tipo === 'ABERTURA';
      const cor  = isAbertura ? 'emerald' : 'red';
      const icon = isAbertura ? 'fa-cash-register' : 'fa-lock';
      const info = c.valor != null
        ? `${isAbertura ? 'Troco inicial' : 'Valor apurado'}: ${Utils.formatCurrency(parseFloat(c.valor))}`
        : (c.responsavel || c.descricao || '—');

      return `
        <div class="flex items-center justify-between bg-slate-900/50 p-4 rounded-xl border border-white/5" role="row">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-xl flex items-center justify-center bg-${cor}-500/15 text-${cor}-400" aria-hidden="true">
              <i class="fas ${icon} text-xs"></i>
            </div>
            <div>
              <p class="text-[10px] font-black text-slate-200">${c.tipo} DE CAIXA</p>
              <p class="text-[9px] text-slate-500 font-bold">${info}</p>
            </div>
          </div>
          <div class="text-right">
            <p class="text-[9px] font-black text-slate-300">${c.data}</p>
            <p class="text-[8px] text-slate-600 font-bold">${c.hora}</p>
          </div>
        </div>`;
    }).join('');
  }

  return Object.freeze({ renderInventario });
})();

/* ═══════════════════════════════════════════════════════════════════
   DATA SERVICE — Backup, Importação e Reset
═══════════════════════════════════════════════════════════════════ */
const DataService = (() => {
  /**
   * Atualiza painel de dados
   */
  function renderDados() {
    const set = (id, v) => { const el = Utils.el(id); if (el) el.textContent = v; };
    set('statProd', Store.Selectors.getEstoque().length);
    set('statVend', Store.Selectors.getVendas().length);
    set('statPont', Store.getState().ponto?.length || 0);
    set('statInv',  Store.Selectors.getInventario().length);
    set('statDlv',  Store.Selectors.getPedidos().length);
  }

  /**
   * Exporta backup completo como JSON
   */
  function exportarBackup() {
    const payload = {
      version:   '5.0.0-enterprise',
      exportedAt: new Date().toISOString(),
      data:       Store.getState(),
    };
    Utils.downloadBlob(
      JSON.stringify(payload, null, 2),
      'application/json',
      `CH_Geladas_BKP_${new Date().toISOString().split('T')[0]}.json`
    );
    const lastEl = Utils.el('lastBackup');
    if (lastEl) lastEl.textContent = Utils.timestamp();
    UIService.showToast('Backup', 'Arquivo baixado com sucesso');
  }

  /**
   * Importa dados de um arquivo JSON de backup
   * @param {HTMLInputElement} input
   */
  function importarDados(input) {
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = e => {
      try {
        const parsed = Utils.safeJsonParse(e.target.result, null);
        if (!parsed) throw new Error('Arquivo inválido');

        // Suporta formato legado (objeto com estoque diretamente)
        // e novo formato ({ version, data: { estoque, ... } })
        const data = parsed.data ?? parsed;

        if (!Array.isArray(data.estoque)) {
          UIService.showToast('Erro', 'Arquivo inválido — estrutura incorreta', 'error');
          return;
        }

        if (!confirm('Substituir TODOS os dados atuais?\n\nEsta ação não pode ser desfeita.')) {
          input.value = '';
          return;
        }

        Store.setState(data);
        SyncService.persist();
        UIService.showToast('Sucesso', 'Dados restaurados com sucesso!');
        setTimeout(() => location.reload(), 1_500);
      } catch (err) {
        console.error('[DataService] Import failed:', err);
        UIService.showToast('Erro', 'Falha ao ler o arquivo', 'error');
      } finally {
        input.value = '';
      }
    };
    reader.readAsText(file);
  }

  /**
   * Reset completo do sistema com dupla confirmação
   */
  function resetSistema() {
    if (!AuthService.isAdmin()) {
      UIService.showToast('Negado', 'Apenas administradores podem resetar o sistema', 'error');
      return;
    }
    if (!confirm('⚠️ ATENÇÃO: Apagar TODOS os dados?\n\nEssa ação NÃO pode ser desfeita.')) return;
    const confirmStr = prompt('Digite "DELETAR" para confirmar definitivamente:');
    if (confirmStr !== 'DELETAR') {
      UIService.showToast('Cancelado', 'Código incorreto', 'error');
      return;
    }

    Store.resetState();
    SyncService.persist();
    UIService.showToast('Reset', 'Todos os dados foram apagados', 'error');
    setTimeout(() => location.reload(), 1_500);
  }

  return Object.freeze({ renderDados, exportarBackup, importarDados, resetSistema });
})();

/* ═══════════════════════════════════════════════════════════════════
   ESTOQUE SERVICE — CRUD de produtos (painel admin)
═══════════════════════════════════════════════════════════════════ */
const EstoqueService = (() => {
  // Estado do formulário de produto (novo ou edição)
  let _editingId = null;
  let _tempPacks = []; // packs em edição no formulário principal
  let _epPacks   = []; // packs no modal de edição rápida

  /* ── Getters ─────────────────────────────────────────────── */
  const getTempPacks = () => [..._tempPacks];
  const getEpPacks   = () => [..._epPacks];
  const isEditing    = () => _editingId !== null;

  /* ── Form Principal ──────────────────────────────────────── */
  function resetForm() {
    _editingId = null;
    _tempPacks = [];
    ['pNome', 'pCusto', 'pQtd', 'pPreco', 'editId'].forEach(id => {
      const el = Utils.el(id); if (el) el.value = '';
    });
    const formTitle = Utils.el('formTitle');
    if (formTitle) formTitle.textContent = 'Novo Produto';
    const btnSalvar = Utils.el('btnSalvar');
    if (btnSalvar) btnSalvar.textContent = 'Registar Produto';
    const btnCancelar = Utils.el('btnCancelar');
    if (btnCancelar) btnCancelar.classList.add('hidden');
    renderPackList('tPackList', _tempPacks);
  }

  function adicionarPack() {
    const un    = parseInt(Utils.el('tPackUn')?.value)   || 0;
    const preco = parseFloat(Utils.el('tPackPr')?.value) || 0;
    if (!un || !preco) { UIService.showToast('Pack', 'Preencha un. e preço', 'error'); return; }
    _tempPacks.push({ un, preco });
    const pUn = Utils.el('tPackUn'); if (pUn) pUn.value = '';
    const pP  = Utils.el('tPackPr'); if (pP) pP.value = '';
    renderPackList('tPackList', _tempPacks);
  }

  function removerTempPack(i) {
    _tempPacks.splice(i, 1);
    renderPackList('tPackList', _tempPacks);
  }

  function salvarProduto() {
    const nome  = Utils.el('pNome')?.value.trim()    || '';
    const preco = parseFloat(Utils.el('pPreco')?.value) || 0;
    const custo = parseFloat(Utils.el('pCusto')?.value) || 0;
    const qtd   = parseInt(Utils.el('pQtd')?.value)     || 0;

    const validation = Validators.validateProduct({ nome, precoUn: preco, custoUn: custo, qtdUn: qtd });
    if (!validation.valid) { UIService.showToast('Erro', validation.errors[0], 'error'); return; }

    if (_editingId !== null) {
      Store.mutate(state => {
        const idx = state.estoque.findIndex(p => String(p.id) === String(_editingId));
        if (idx !== -1)
          state.estoque[idx] = { ...state.estoque[idx], nome, precoUn: preco, custoUn: custo, qtdUn: qtd, packs: [..._tempPacks] };
      }, true);
      UIService.showToast('Estoque', `${nome} atualizado`);
    } else {
      Store.mutate(state => {
        state.estoque.push({ id: Utils.generateId(), nome, precoUn: preco, custoUn: custo, qtdUn: qtd, packs: [..._tempPacks] });
      }, true);
      UIService.showToast('Estoque', `${nome} adicionado`);
    }

    SyncService.persist();
    resetForm();
    EventBus.emit('estoque:updated');
  }

  function editarProduto(prodId) {
    const prod = Store.Selectors.getProdutoById(prodId);
    if (!prod) return;
    _editingId = prod.id;
    _tempPacks = [...(prod.packs || [])];

    const set = (id, val) => { const el = Utils.el(id); if (el) el.value = val ?? ''; };
    set('editId',  prod.id);
    set('pNome',   prod.nome);
    set('pPreco',  prod.precoUn);
    set('pCusto',  prod.custoUn);
    set('pQtd',    prod.qtdUn);

    const formTitle = Utils.el('formTitle');
    if (formTitle) formTitle.textContent = 'Editar Produto';
    const btnSalvar = Utils.el('btnSalvar');
    if (btnSalvar) btnSalvar.textContent = 'Salvar Alterações';
    const btnCancelar = Utils.el('btnCancelar');
    if (btnCancelar) btnCancelar.classList.remove('hidden');
    renderPackList('tPackList', _tempPacks);

    Utils.el('formTitle')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function removerProduto(prodId) {
    const prod = Store.Selectors.getProdutoById(prodId);
    if (!prod) return;
    if (!confirm(`Remover "${prod.nome}"?`)) return;
    Store.mutate(state => {
      const idx = state.estoque.findIndex(p => String(p.id) === String(prodId));
      if (idx !== -1) state.estoque.splice(idx, 1);
    }, true);
    SyncService.persist();
    UIService.showToast('Produto removido', '', 'warning');
    EventBus.emit('estoque:updated');
  }

  /* ── Edição Rápida (modal) ───────────────────────────────── */
  function abrirEdicaoRapida(prodId) {
    const prod = Store.Selectors.getProdutoById(prodId);
    if (!prod) return;
    _epPacks = [...(prod.packs || [])];

    const set = (id, val) => { const el = Utils.el(id); if (el) el.value = val ?? ''; };
    set('epId',    prod.id);
    set('epNome',  prod.nome);
    set('epPreco', prod.precoUn);
    set('epCusto', prod.custoUn);
    set('epQtd',   prod.qtdUn);
    renderPackList('epPackList', _epPacks);
    UIService.openModal('modalEditProd');
  }

  function epAdicionarPack() {
    const un    = parseInt(Utils.el('epPackUn')?.value)    || 0;
    const preco = parseFloat(Utils.el('epPackPr')?.value) || 0;
    if (!un || !preco) { UIService.showToast('Pack', 'Preencha un. e preço', 'error'); return; }
    _epPacks.push({ un, preco });
    const pUn = Utils.el('epPackUn'); if (pUn) pUn.value = '';
    const pP  = Utils.el('epPackPr'); if (pP) pP.value = '';
    renderPackList('epPackList', _epPacks);
  }

  function epRemoverPack(i) {
    _epPacks.splice(i, 1);
    renderPackList('epPackList', _epPacks);
  }

  function salvarEdicaoRapida() {
    const id    = String(Utils.el('epId')?.value || '');
    const nome  = Utils.el('epNome')?.value.trim() || '';
    const preco = parseFloat(Utils.el('epPreco')?.value) || 0;
    const custo = parseFloat(Utils.el('epCusto')?.value) || 0;
    const qtd   = parseInt(Utils.el('epQtd')?.value)     || 0;

    const validation = Validators.validateProduct({ nome, precoUn: preco, custoUn: custo, qtdUn: qtd });
    if (!validation.valid) { UIService.showToast('Erro', validation.errors[0], 'error'); return; }

    Store.mutate(state => {
      const idx = state.estoque.findIndex(p => String(p.id) === id);
      if (idx !== -1)
        state.estoque[idx] = { ...state.estoque[idx], nome, precoUn: preco, custoUn: custo, qtdUn: qtd, packs: [..._epPacks] };
    }, true);
    SyncService.persist();
    UIService.closeModal('modalEditProd');
    UIService.showToast('Produto', `${nome} atualizado`);
    EventBus.emit('estoque:updated');
  }

  /* ── Renderização de packs ───────────────────────────────── */
  function renderPackList(containerId, packs) {
    const cont = Utils.el(containerId);
    if (!cont) return;
    if (!packs.length) {
      cont.innerHTML = '<p class="text-[9px] text-slate-600 text-center py-2 font-bold">Sem packs</p>';
      return;
    }
    const isEp  = containerId === 'epPackList';
    const remFn = isEp ? 'epRemoverPack' : 'removerTempPack';
    cont.innerHTML = packs.map((pk, i) => `
      <div class="flex items-center justify-between bg-slate-900/50 px-3 py-2 rounded-xl border border-white/5">
        <span class="text-[10px] font-black text-slate-300">Pack ${pk.un} un · ${Utils.formatCurrency(pk.preco)}</span>
        <button onclick="${remFn}(${i})" class="text-red-400 hover:text-red-300 text-[10px]" aria-label="Remover pack ${pk.un} unidades"><i class="fas fa-times" aria-hidden="true"></i></button>
      </div>`).join('');
  }

  /* ── Estoque Renderer ────────────────────────────────────── */
  function renderEstoque() {
    const cont = Utils.el('gridEstoque');
    if (!cont) return;

    const busca   = (Utils.el('buscaEstoque')?.value || '').toLowerCase();
    const estoque = Store.Selectors.getEstoque();
    const filtrado = busca ? estoque.filter(p => p.nome.toLowerCase().includes(busca)) : estoque;

    if (filtrado.length === 0) {
      cont.innerHTML = `
        <div class="col-span-full text-center py-12 text-slate-700 text-[10px] font-bold uppercase" role="status">
          <i class="fas fa-box-open text-3xl block mb-3" aria-hidden="true"></i>
          ${busca ? 'Nenhum produto encontrado' : 'Nenhum produto cadastrado'}
        </div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    filtrado.forEach(p => {
      const esgotado   = p.qtdUn <= 0;
      const baixo      = !esgotado && p.qtdUn <= CONSTANTS.LOW_STOCK_THRESHOLD;
      const stockCls   = esgotado ? 'text-red-400' : baixo ? 'text-amber-400' : 'text-emerald-400';
      const margem     = p.precoUn > 0 ? ((1 - p.custoUn / p.precoUn) * 100).toFixed(0) : 0;

      const div = document.createElement('div');
      div.innerHTML = `
        <article class="glass-card rounded-2xl p-4 ${esgotado ? 'opacity-60' : ''}" aria-label="${RenderService._escapeHtml(p.nome)}">
          <div class="flex justify-between items-start mb-3">
            <div class="min-w-0 flex-1">
              <h3 class="text-[11px] font-black text-slate-200 truncate">${RenderService._escapeHtml(p.nome)}</h3>
              <p class="text-sm font-black text-white mt-0.5">${Utils.formatCurrency(p.precoUn)}</p>
              <p class="text-[8px] font-bold ${stockCls} mt-0.5">${esgotado ? 'Esgotado' : baixo ? `⚠ ${p.qtdUn} restante(s)` : `${p.qtdUn} em estoque`}</p>
            </div>
            <div class="text-right flex-shrink-0 ml-3">
              <span class="badge b-green text-[7px]">Margem ${margem}%</span>
              <p class="text-[7px] text-slate-600 font-bold mt-1">Custo: ${Utils.formatCurrency(p.custoUn)}</p>
            </div>
          </div>
          ${(p.packs || []).length > 0 ? `
            <div class="flex gap-1 flex-wrap mb-3">
              ${p.packs.map(pk => `<span class="badge b-amber text-[7px]">Pack ${pk.un}: ${Utils.formatCurrency(pk.preco)}</span>`).join('')}
            </div>` : ''}
          <div class="flex gap-2" role="group" aria-label="Ações de ${RenderService._escapeHtml(p.nome)}">
            <button onclick="editarProduto('${p.id}')" class="flex-1 py-2 rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500 hover:text-white text-[8px] font-black uppercase transition-all" aria-label="Editar ${RenderService._escapeHtml(p.nome)}">Editar</button>
            <button onclick="abrirEdicaoRapida('${p.id}')" class="py-2 px-3 rounded-lg bg-amber-500/10 text-amber-400 hover:bg-amber-500 hover:text-white text-[8px] font-black uppercase transition-all" aria-label="Edição rápida de ${RenderService._escapeHtml(p.nome)}"><i class="fas fa-bolt" aria-hidden="true"></i></button>
            <button onclick="removerProduto('${p.id}')" class="py-2 px-3 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white text-[8px] font-black uppercase transition-all" aria-label="Remover ${RenderService._escapeHtml(p.nome)}"><i class="fas fa-trash" aria-hidden="true"></i></button>
          </div>
        </article>`;
      frag.appendChild(div.firstElementChild);
    });
    cont.innerHTML = '';
    cont.appendChild(frag);
  }

  return Object.freeze({
    getTempPacks, getEpPacks, isEditing,
    resetForm, adicionarPack, removerTempPack, salvarProduto,
    editarProduto, removerProduto,
    abrirEdicaoRapida, epAdicionarPack, epRemoverPack, salvarEdicaoRapida,
    renderPackList, renderEstoque,
  });
})();

/* ═══════════════════════════════════════════════════════════════════
   REGISTRA LISTENERS
═══════════════════════════════════════════════════════════════════ */
EventBus.on('ponto:registered', () => PontoRenderer.renderPonto());
EventBus.on('ponto:updated',    () => PontoRenderer.renderPonto());
EventBus.on('ponto:deleted',    () => PontoRenderer.renderPonto());
EventBus.on('ponto:cleared',    () => PontoRenderer.renderPonto());
EventBus.on('caixa:aberto',     () => PontoRenderer.renderPonto());
EventBus.on('caixa:fechado',    () => PontoRenderer.renderPonto());
EventBus.on('estoque:updated',  () => {
  EstoqueService.renderEstoque();
  RenderService.renderCatalogo();
  RenderService.updateStats();
});

/* ═══════════════════════════════════════════════════════════════════
   WINDOW BRIDGES — Compatibilidade com HTML inline
═══════════════════════════════════════════════════════════════════ */

// ── Ponto
function registarPonto(tipo)     { PontoService.registrar(tipo); }
function abrirEditarPonto(id)    { PontoService.abrirEditar(id); }
function setPontoTipo(tipo)      { PontoService._setPontoTipoBtn(tipo); }
function salvarEdicaoPonto()     { PontoService.salvarEdicao(); }
function apagarPonto(id)         { PontoService.apagar(id); }
function limparPonto()           { PontoService.limparTodos(); }
function renderPonto()           { PontoRenderer.renderPonto(); }

// ── Caixa
function abrirCaixa()            { CaixaService.abrirModalAbertura(); }
function fecharModalCaixa()      { UIService.closeModal('modalAbrirCaixa'); }
function confirmarAberturaCaixa(){ CaixaService.confirmarAbertura(); }
function fecharCaixa()           { CaixaService.abrirModalFechamento(); }
function fecharModalFechamento() { UIService.closeModal('modalFecharCaixa'); }
function confirmarFechamentoCaixa() { CaixaService.confirmarFechamento(); }

// ── Inventário
function renderInventario()      { InventoryRenderer.renderInventario(); }

// ── Dados
function renderDados()           { DataService.renderDados(); }
function exportarBackup()        { DataService.exportarBackup(); }
function importarDados(input)    { DataService.importarDados(input); }
function resetSistema()          { DataService.resetSistema(); }

// ── Estoque
function renderEstoque()         { EstoqueService.renderEstoque(); }
function resetFormEstoque()      { EstoqueService.resetForm(); }
function addPackForm()           { EstoqueService.adicionarPack(); }   // bridge para HTML (tPackList)
function adicionarPack()         { EstoqueService.adicionarPack(); }
function removerTempPack(i)      { EstoqueService.removerTempPack(i); }
function salvarProduto()         { EstoqueService.salvarProduto(); }
function editarProduto(id)       { EstoqueService.editarProduto(id); }
function removerProduto(id)      { EstoqueService.removerProduto(id); }
function abrirEdicaoRapida(id)   { EstoqueService.abrirEdicaoRapida(id); }
function epAdicionarPack()       { EstoqueService.epAdicionarPack(); }
function addPackModal()          { EstoqueService.epAdicionarPack(); }  // alias usado no HTML
function epRemoverPack(i)        { EstoqueService.epRemoverPack(i); }
function salvarEdicaoRapida()    { EstoqueService.salvarEdicaoRapida(); }
function salvarProdModal()       { EstoqueService.salvarEdicaoRapida(); } // alias usado no HTML

// ajuste de stock no modal de edição rápida
function ajusteStock(delta) {
  const el = Utils.el('epQtd');
  if (!el) return;
  const atual = parseInt(el.value) || 0;
  el.value = Math.max(0, atual + delta);
}

// entrada rápida de stock no modal de edição rápida
function entradaRapida() {
  const qtdEl = Utils.el('epEntrada');
  const estoqueEl = Utils.el('epQtd');
  if (!qtdEl || !estoqueEl) return;
  const entrada = parseInt(qtdEl.value) || 0;
  if (entrada <= 0) { UIService.showToast('Atenção', 'Informe uma quantidade válida', 'warning'); return; }
  estoqueEl.value = (parseInt(estoqueEl.value) || 0) + entrada;
  qtdEl.value = '';
  UIService.showToast('Estoque', `+${entrada} unidades adicionadas`);
}
