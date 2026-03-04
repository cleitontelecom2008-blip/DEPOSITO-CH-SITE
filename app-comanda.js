/**
 * @fileoverview CH Geladas PDV — Módulo de Comandas
 * @version 2.0.0
 *
 * Sistema isolado de comandas para colaboradores (role = pdv).
 * NÃO usa CartService — tem seu próprio fluxo de itens e checkout.
 *
 * Fluxo:
 *  1. Colaborador abre aba "Comanda"
 *  2. Cria uma comanda (nome = mesa, grupo, cliente...)
 *  3. Dentro da comanda: catálogo igual ao PDV para adicionar itens
 *  4. Itens ficam RESERVADOS (estoque visual deduzido, real intacto)
 *  5. "Fechar Conta" → modal com resumo completo + forma de pagamento
 *  6. Confirmar pagamento → debita estoque real, registra venda, fecha comanda
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════
   COMANDA SERVICE
═══════════════════════════════════════════════════════════════════ */
const ComandaService = (() => {

  function _store() {
    // Acessa via Store.getState() — _ensureDefaults() já garante que comandas existe
    return Store.getState().comandas;
  }

  const getAll     = () => _store();
  const getAbertas = () => _store().filter(c => c.status === 'ABERTA');
  const getById    = id => _store().find(c => String(c.id) === String(id)) ?? null;

  /**
   * Quantidade total reservada em comandas abertas para um produto.
   * Usada para calcular estoque visual sem debitar o real.
   */
  function qtdReservada(prodId) {
    return getAbertas().reduce((total, c) =>
      total + c.itens.reduce((s, i) =>
        i.prodId === String(prodId) ? s + (i.desconto || 1) : s, 0
      ), 0
    );
  }

  function nova(nome) {
    const n = (nome || '').trim() || `Comanda ${getAbertas().length + 1}`;
    const c = {
      id:         String(Utils.generateId()),
      nome:       n,
      itens:      [],
      status:     'ABERTA',
      total:      0,
      horaAberta: Utils.now(),
      dataAberta: Utils.today(),
      tsAberta:   Date.now(),
    };
    Store.mutate(state => { state.comandas.unshift(c); }, true);
    SyncService.persist();
    EventBus.emit('comanda:changed');
    return c;
  }

  function renomear(id, novoNome) {
    const c = getById(id);
    if (!c || !novoNome?.trim()) return false;
    // FIX: usar Store.mutate() para manter _version, _ensureDefaults e EventBus íntegros
    Store.mutate(state => {
      const cmd = state.comandas.find(x => String(x.id) === String(id));
      if (cmd) cmd.nome = novoNome.trim();
    }, true);
    SyncService.persist();
    EventBus.emit('comanda:changed');
    return true;
  }

  function adicionarItem(cmdId, prodId, packIdx = 0) {
    const comanda = getById(cmdId);
    if (!comanda || comanda.status !== 'ABERTA') return false;

    const prod = Store.Selectors.getProdutoById(prodId);
    if (!prod) return false;

    const disponivel = prod.qtdUn - qtdReservada(prodId);
    let item;

    if (packIdx === 0) {
      if (disponivel < 1) {
        UIService.showToast('Sem Estoque', prod.nome, 'error');
        return false;
      }
      item = {
        id:       String(Utils.generateId()),
        prodId:   String(prod.id),
        nome:     prod.nome,
        label:    'UNID',
        preco:    prod.precoUn,
        custo:    prod.custoUn,
        desconto: 1,
      };
    } else {
      const pack = prod.packs?.[packIdx - 1];
      if (!pack) return false;
      if (disponivel < pack.un) {
        UIService.showToast('Estoque Insuficiente',
          `Disponível: ${disponivel} un — Pack precisa de ${pack.un}`, 'error');
        return false;
      }
      item = {
        id:       String(Utils.generateId()),
        prodId:   String(prod.id),
        nome:     prod.nome,
        label:    `PACK ${pack.un}`,
        preco:    pack.preco,
        custo:    prod.custoUn * pack.un,
        desconto: pack.un,
      };
    }

    // FIX: usar Store.mutate() — nunca mutar objetos do estado por referência direta.
    // Antes: comanda.itens.push(item) + comanda.total = ... mutava _state diretamente,
    // sem incrementar _version nem disparar state:changed.
    Store.mutate(state => {
      const cmd = state.comandas.find(c => String(c.id) === String(cmdId));
      if (!cmd) return;
      cmd.itens.push(item);
      cmd.total = _calcTotal(cmd.itens);
    }, true);
    SyncService.persist();
    EventBus.emit('comanda:item-changed', cmdId);
    return true;
  }

  function removerItem(cmdId, itemId) {
    // FIX: usar Store.mutate() em vez de mutar por referência direta
    Store.mutate(state => {
      const cmd = state.comandas.find(c => String(c.id) === String(cmdId));
      if (!cmd) return;
      const idx = cmd.itens.findIndex(i => i.id === String(itemId));
      if (idx === -1) return;
      cmd.itens.splice(idx, 1);
      cmd.total = _calcTotal(cmd.itens);
    }, true);
    SyncService.persist();
    EventBus.emit('comanda:item-changed', cmdId);
  }

  function excluir(id) {
    Store.mutate(state => {
      const idx = state.comandas.findIndex(c => String(c.id) === String(id));
      if (idx !== -1) state.comandas.splice(idx, 1);
    }, true);
    SyncService.persist();
    EventBus.emit('comanda:changed');
  }

  function finalizar(cmdId, formaPgto) {
    const comanda = getById(cmdId);
    if (!comanda || comanda.status !== 'ABERTA') return null;
    if (comanda.itens.length === 0) {
      UIService.showToast('Atenção', 'Comanda sem itens', 'error');
      return null;
    }

    // Guard: ponto + caixa obrigatórios
    if (typeof _getPdvBloqueio === 'function') {
      const bloqueio = _getPdvBloqueio();
      if (bloqueio) {
        UIService.showToast('Acesso Bloqueado', bloqueio, 'error');
        TabManager.switchTab('ponto');
        return null;
      }
    }

    // Valida estoque real
    for (const item of comanda.itens) {
      const prod = Store.Selectors.getProdutoById(item.prodId);
      if (!prod || prod.qtdUn < item.desconto) {
        UIService.showToast('Erro de Estoque',
          `"${item.nome}" — disponível: ${prod?.qtdUn ?? 0}, necessário: ${item.desconto}`, 'error');
        return null;
      }
    }

    const today   = Utils.todayISO();
    const nowStr  = Utils.now();
    const ts      = Utils.timestamp();
    const vendaId = String(Utils.generateId());

    // Debita estoque e registra inventário via Store.mutate()
    Store.mutate(state => {
      comanda.itens.forEach(item => {
        const prod = state.estoque.find(p => String(p.id) === String(item.prodId));
        if (!prod) return;
        const qtdAntes = prod.qtdUn;
        prod.qtdUn -= item.desconto;
        state.inventario.unshift({
          id:           String(Utils.generateId()),
          vendaId,
          produto:      prod.nome,
          label:        item.label,
          preco:        item.preco,
          qtdMovimento: item.desconto,
          qtdAntes,
          qtdDepois:    prod.qtdUn,
          data:         today,
          hora:         nowStr,
          tipo:         'VENDA',
        });
      });
    }, true);

    const total = comanda.total;
    const lucro = comanda.itens.reduce((a, i) => a + (i.preco - (i.custo || 0)), 0);

    const venda = {
      id:          vendaId,
      total,
      lucro,
      data:        ts,
      dataCurta:   today,
      hora:        nowStr,
      itens:       [...comanda.itens],
      formaPgto,
      origem:      'COMANDA',
      nomeComanda: comanda.nome,
    };

    Store.mutate(state => { state.vendas.unshift(venda); }, true);

    // FIX: mover mutações de status da comanda para dentro de Store.mutate()
    // Antes: comanda.status = 'PAGA' etc. mutavam por referência direta ao _state
    Store.mutate(state => {
      const cmd = state.comandas.find(c => String(c.id) === String(cmdId));
      if (!cmd) return;
      cmd.status    = 'PAGA';
      cmd.horaFecho = nowStr;
      cmd.tsFecho   = Date.now();
      cmd.formaPgto = formaPgto;
    }, true);

    // FIX: persistNow (sem debounce) para escrita imediata no localStorage
    SyncService.persistNow();

    try { Utils.el('audioVenda')?.play(); } catch (_) {}

    EventBus.emit('comanda:finalizada', venda);
    EventBus.emit('cart:checkout', venda);
    return venda;
  }

  function _calcTotal(itens) {
    return itens.reduce((a, i) => a + (i.preco || 0), 0);
  }

  return Object.freeze({
    getAll, getAbertas, getById, qtdReservada,
    nova, renomear, adicionarItem, removerItem, excluir, finalizar,
  });
})();

/* ═══════════════════════════════════════════════════════════════════
   COMANDA RENDERER
═══════════════════════════════════════════════════════════════════ */
const ComandaRenderer = (() => {
  let _cmdAtivaId = null;
  let _busca      = '';

  const getAtivaId = () => _cmdAtivaId;

  function renderComandas() {
    _renderKPIs();
    _renderGrade();
    if (_cmdAtivaId) {
      const c = ComandaService.getById(_cmdAtivaId);
      if (!c || c.status !== 'ABERTA') {
        _voltarLista(false);
      } else {
        _renderDetalhe(c);
      }
    }
  }

  function _renderKPIs() {
    const abertas   = ComandaService.getAbertas();
    const pagas     = ComandaService.getAll().filter(
      c => c.status === 'PAGA' && (c.dataAberta === Utils.today() || c.dataAberta === Utils.todayISO())
    );
    const valAberto = abertas.reduce((a, c) => a + (c.total || 0), 0);
    _txt('cmdKpiAbertas', abertas.length);
    _txt('cmdKpiValor',   Utils.formatCurrency(valAberto));
    _txt('cmdKpiPagas',   pagas.length);
  }

  function _renderGrade() {
    const cont    = Utils.el('cmdGrade');
    if (!cont) return;
    const abertas = ComandaService.getAbertas();

    if (abertas.length === 0) {
      cont.innerHTML = `
        <div class="col-span-full text-center py-20 text-slate-700">
          <i class="fas fa-receipt text-5xl block mb-4 opacity-30"></i>
          <p class="text-[11px] font-black uppercase tracking-wide">Nenhuma comanda aberta</p>
          <p class="text-[9px] mt-1 font-bold opacity-60">Toque em "Nova" para começar</p>
        </div>`;
      return;
    }

    cont.innerHTML = abertas.map(c => {
      const mins    = Math.max(1, Math.floor((Date.now() - (c.tsAberta || Date.now())) / 60000));
      const tempo   = mins < 60 ? `${mins}min` : `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`;
      const preview = c.itens.length > 0
        ? c.itens.slice(0, 3).map(i => i.nome).join(', ') + (c.itens.length > 3 ? ` +${c.itens.length - 3}` : '')
        : 'Sem itens ainda';
      return `
        <article onclick="cmdAbrirDetalhe('${c.id}')"
          class="glass-card rounded-2xl p-4 cursor-pointer hover:border-purple-500/40 transition-all active:scale-[.97] border-l-4 border-l-purple-600 relative">
          <button onclick="event.stopPropagation();cmdCancelarById('${c.id}')"
            class="absolute top-3 right-3 w-6 h-6 rounded-md bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white flex items-center justify-center transition-all">
            <i class="fas fa-times text-[8px]"></i>
          </button>
          <p class="text-sm font-black text-white truncate pr-8">${_esc(c.nome)}</p>
          <p class="text-[8px] text-slate-500 font-bold mt-0.5">
            <i class="fas fa-clock mr-1"></i>${c.horaAberta} · ${tempo}
          </p>
          <div class="flex items-end justify-between mt-3">
            <div>
              <p class="text-[7px] text-slate-600 uppercase font-bold">Itens</p>
              <p class="text-lg font-black ${c.itens.length > 0 ? 'text-slate-200' : 'text-slate-600'}">${c.itens.length}</p>
            </div>
            <div class="text-right">
              <p class="text-[7px] text-slate-600 uppercase font-bold">Total</p>
              <p class="text-xl font-black ${c.total > 0 ? 'text-purple-300' : 'text-slate-600'}">${Utils.formatCurrency(c.total || 0)}</p>
            </div>
          </div>
          <p class="text-[7px] text-slate-600 font-bold mt-2 truncate border-t border-white/5 pt-2">${_esc(preview)}</p>
        </article>`;
    }).join('');
  }

  function abrirDetalhe(id) {
    const c = ComandaService.getById(id);
    if (!c || c.status !== 'ABERTA') return;
    _cmdAtivaId = id;
    _busca      = '';
    const busca = Utils.el('cmdBusca'); if (busca) busca.value = '';
    Utils.el('cmdVLista')?.classList.add('hidden');
    Utils.el('cmdVDetalhe')?.classList.remove('hidden');
    _renderDetalhe(c);
  }

  function _renderDetalhe(c) {
    const mins  = Math.max(1, Math.floor((Date.now() - (c.tsAberta || Date.now())) / 60000));
    const tempo = mins < 60 ? `${mins} min` : `${Math.floor(mins/60)}h${String(mins%60).padStart(2,'0')}`;
    _txt('cmdDetNome',  c.nome);
    _txt('cmdDetTempo', `Aberta ${c.horaAberta} · ${tempo}`);
    _txt('cmdDetQtd',   `${c.itens.length} ${c.itens.length === 1 ? 'item' : 'itens'}`);
    _txt('cmdDetTotal', Utils.formatCurrency(c.total || 0));

    const btn = Utils.el('btnCmdFechar');
    if (btn) btn.disabled = c.itens.length === 0;

    _renderCatalogo();
    _renderItens(c);
  }

  function _renderCatalogo() {
    const cont = Utils.el('cmdCatalogo');
    if (!cont) return;

    const q     = _busca.toLowerCase();
    const prods = Store.Selectors.getEstoque().filter(p =>
      p.nome.toLowerCase().includes(q)
    );

    if (prods.length === 0) {
      cont.innerHTML = `
        <div class="col-span-2 text-center py-10 text-slate-700">
          <i class="fas fa-beer text-3xl block mb-2 opacity-30"></i>
          <p class="text-[10px] font-black uppercase">${q ? 'Nenhum resultado' : 'Catálogo vazio'}</p>
        </div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    prods.forEach(prod => {
      const reservado  = ComandaService.qtdReservada(prod.id);
      const disponivel = prod.qtdUn - reservado;
      const esgotado   = disponivel <= 0;
      const baixo      = !esgotado && disponivel <= CONSTANTS.LOW_STOCK_THRESHOLD;
      const stockCls   = esgotado ? 'text-red-400' : baixo ? 'text-amber-400' : 'text-emerald-400';
      const stockLabel = esgotado ? 'Esgotado' : `${disponivel} disp.`;
      const margem     = prod.custoUn > 0
        ? `<span class="badge b-green text-[7px]">${((1 - prod.custoUn / prod.precoUn) * 100).toFixed(0)}%</span>` : '';

      const packsHtml = (prod.packs || []).slice(0, 2).map((pk, i) => {
        const desc = ((1 - pk.preco / (prod.precoUn * pk.un)) * 100).toFixed(0);
        return `
          <button class="btn-pk" onclick="cmdAddItem('${prod.id}',${i+1})"
            ${esgotado || disponivel < pk.un ? 'disabled' : ''}>
            <div class="text-[8px] font-black text-amber-400 uppercase leading-none">Pack ${pk.un}</div>
            <div class="text-[10px] font-black text-white leading-tight">R$ ${pk.preco.toFixed(2)}</div>
            ${Number(desc) > 0 ? `<div class="text-[7px] text-amber-300/60">-${desc}%</div>` : ''}
          </button>`;
      }).join('');

      const div = document.createElement('div');
      div.innerHTML = `
        <article class="prod-card p-3 flex flex-col gap-2 ${esgotado ? 'esgotado' : ''}">
          <div class="flex items-start justify-between gap-1 min-w-0">
            <h3 class="text-[10px] font-black text-slate-200 leading-tight flex-1"
              style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">
              ${_esc(prod.nome)}
            </h3>
            ${margem}
          </div>
          <div>
            <p class="text-base font-black text-white leading-none">R$ ${prod.precoUn.toFixed(2)}</p>
            <p class="text-[8px] font-bold ${stockCls} mt-0.5">${stockLabel}</p>
          </div>
          <div class="flex gap-1.5 mt-auto">
            <button class="btn-un flex-1" onclick="cmdAddItem('${prod.id}',0)" ${esgotado ? 'disabled' : ''}>
              <div class="text-[8px] font-black text-blue-400 uppercase leading-none">Unid</div>
              <div class="text-[10px] font-black text-white leading-tight">R$ ${prod.precoUn.toFixed(2)}</div>
            </button>
            ${packsHtml}
          </div>
        </article>`;
      frag.appendChild(div.firstElementChild);
    });

    cont.innerHTML = '';
    cont.appendChild(frag);
  }

  function _renderItens(c) {
    const cont = Utils.el('cmdDetItens');
    if (!cont) return;

    if (c.itens.length === 0) {
      cont.innerHTML = `
        <div class="flex flex-col items-center justify-center py-10 text-slate-700 text-center">
          <i class="fas fa-receipt text-3xl mb-2 opacity-30"></i>
          <p class="text-[9px] font-black uppercase">Sem itens</p>
          <p class="text-[8px] opacity-60 mt-0.5">Adicione produtos ao lado</p>
        </div>`;
      return;
    }

    cont.innerHTML = c.itens.map(it => `
      <div class="flex items-center justify-between bg-slate-950/60 px-3 py-2 rounded-xl border border-white/5 hover:border-white/10 transition-all">
        <div class="flex-1 min-w-0">
          <p class="text-[10px] font-black text-slate-200 truncate">${_esc(it.nome)}</p>
          <p class="text-[8px] text-slate-600 font-bold">${_esc(it.label)} · <span class="text-blue-400 font-black">${Utils.formatCurrency(it.preco)}</span></p>
        </div>
        <button onclick="cmdRemoverItem('${it.id}')"
          class="ml-2 w-6 h-6 rounded-md bg-red-500/8 text-red-500/40 hover:bg-red-500/20 hover:text-red-400 flex items-center justify-center transition-all flex-shrink-0">
          <i class="fas fa-times text-[9px]"></i>
        </button>
      </div>`).join('');
  }

  function voltarLista() { _voltarLista(true); }

  function _voltarLista(render = true) {
    _cmdAtivaId = null;
    _busca      = '';
    Utils.el('cmdVDetalhe')?.classList.add('hidden');
    Utils.el('cmdVLista')?.classList.remove('hidden');
    if (render) renderComandas();
  }

  function buscar(q) {
    _busca = (q || '').trim();
    if (_cmdAtivaId) _renderCatalogo();
  }

  function _txt(id, v) { const el = Utils.el(id); if (el) el.textContent = String(v ?? ''); }
  function _esc(s)     { return RenderService._escapeHtml(String(s ?? '')); }

  return Object.freeze({ renderComandas, abrirDetalhe, voltarLista, buscar, getAtivaId });
})();

/* ═══════════════════════════════════════════════════════════════════
   MODAL FECHAR CONTA — Confirmação + pagamento
═══════════════════════════════════════════════════════════════════ */
const ComandaFechamento = (() => {
  let _pendingId = null;

  function abrir(cmdId) {
    const c = ComandaService.getById(cmdId);
    if (!c || c.status !== 'ABERTA' || c.itens.length === 0) {
      UIService.showToast('Atenção', 'Comanda sem itens para fechar', 'error');
      return;
    }

    // Guard: ponto + caixa
    if (typeof _getPdvBloqueio === 'function') {
      const bloqueio = _getPdvBloqueio();
      if (bloqueio) {
        UIService.showToast('Acesso Bloqueado', bloqueio, 'error');
        TabManager.switchTab('ponto');
        return;
      }
    }

    _pendingId = cmdId;

    const nome = Utils.el('cmdFechNome');
    if (nome) nome.textContent = c.nome;

    const cont = Utils.el('cmdFechItens');
    if (cont) {
      cont.innerHTML = c.itens.map(it => `
        <div class="flex justify-between text-[10px]">
          <span class="text-slate-300 font-bold truncate flex-1 mr-2">
            ${RenderService._escapeHtml(it.nome)}
            <span class="text-slate-600"> · ${RenderService._escapeHtml(it.label)}</span>
          </span>
          <span class="font-black text-white flex-shrink-0">${Utils.formatCurrency(it.preco)}</span>
        </div>`).join('');
    }

    const totalEl = Utils.el('cmdFechTotal');
    if (totalEl) totalEl.textContent = Utils.formatCurrency(c.total || 0);

    UIService.openModal('modalCmdFechar');
  }

  function confirmar(formaPgto) {
    if (!_pendingId) return;
    const id   = _pendingId;
    _pendingId = null;

    UIService.closeModal('modalCmdFechar');

    const venda = ComandaService.finalizar(id, formaPgto);
    if (!venda) return;

    UIService.showToast(
      '✅ Conta Fechada!',
      `${venda.nomeComanda} · ${Utils.formatCurrency(venda.total)} · ${formaPgto}`
    );

    setTimeout(() => ComandaRenderer.voltarLista(), 300);
  }

  return Object.freeze({ abrir, confirmar });
})();

/* ═══════════════════════════════════════════════════════════════════
   EVENT LISTENERS
═══════════════════════════════════════════════════════════════════ */
EventBus.on('comanda:changed',      () => ComandaRenderer.renderComandas());
EventBus.on('comanda:item-changed', () => ComandaRenderer.renderComandas());
EventBus.on('comanda:finalizada',   () => {
  RenderService.renderCatalogo();
  RenderService.updateStats();
  ComandaRenderer.renderComandas();
});

/* ═══════════════════════════════════════════════════════════════════
   WINDOW BRIDGES
═══════════════════════════════════════════════════════════════════ */

function renderComandas() { ComandaRenderer.renderComandas(); }

function cmdNova() {
  const nome = prompt('Nome da comanda (Mesa, grupo, cliente...):', '');
  if (nome === null) return;
  const c = ComandaService.nova(nome);
  UIService.showToast('Comanda Aberta', `"${c.nome}" criada`);
  ComandaRenderer.abrirDetalhe(c.id);
}

function cmdAbrirDetalhe(id)  { ComandaRenderer.abrirDetalhe(id); }
function cmdVoltarLista()     { ComandaRenderer.voltarLista(); }

function cmdRenomear() {
  const id = ComandaRenderer.getAtivaId();
  if (!id) return;
  const c = ComandaService.getById(id);
  if (!c) return;
  const novo = prompt('Novo nome:', c.nome);
  // FIX 11: verificar null antes de .trim() — caso contrário null?.trim() retorna
  // undefined (truthy no !), tornando o check "novo === null" inalcançável.
  if (novo === null || !novo.trim()) return;
  ComandaService.renomear(id, novo);
  UIService.showToast('Renomeada', novo.trim());
}

function cmdAddItem(prodId, packIdx) {
  const id = ComandaRenderer.getAtivaId();
  if (!id) return;
  const ok = ComandaService.adicionarItem(id, prodId, packIdx);
  if (ok) UIService.showToast('Adicionado', Store.Selectors.getProdutoById(prodId)?.nome || '');
}

function cmdRemoverItem(itemId) {
  const id = ComandaRenderer.getAtivaId();
  if (!id) return;
  ComandaService.removerItem(id, itemId);
}

function cmdAbrirFechamento() {
  const id = ComandaRenderer.getAtivaId();
  if (!id) return;
  ComandaFechamento.abrir(id);
}

function cmdConfirmarPgto(forma) { ComandaFechamento.confirmar(forma); }

function cmdCancelarById(id) {
  const c = ComandaService.getById(id);
  if (!c) return;
  const msg = c.itens.length > 0
    ? `Cancelar "${c.nome}"?\n${c.itens.length} item(ns) · ${Utils.formatCurrency(c.total || 0)}\n\nEsta ação não pode ser desfeita.`
    : `Cancelar a comanda "${c.nome}"?`;
  if (!confirm(msg)) return;
  ComandaService.excluir(id);
  UIService.showToast('Comanda cancelada', c.nome, 'warning');
}

function cmdBuscar(q) { ComandaRenderer.buscar(q); }
