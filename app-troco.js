/**
 * app-troco.js — Módulo de Troco para PDV
 * Integração: adicione <script src="app-troco.js"></script> no index.html
 * Uso: window.TrocoApp.abrir(totalVenda)
 */

window.TrocoApp = (() => {
  // ─── Notas e moedas brasileiras (maior → menor) ───────────────────────────
  const CEDULAS  = [200, 100, 50, 20, 10, 5, 2];
  const MOEDAS   = [1, 0.50, 0.25, 0.10, 0.05, 0.01];
  const DINHEIRO = [...CEDULAS, ...MOEDAS];

  // ─── Calcula decomposição ótima do troco ──────────────────────────────────
  function decompor(valor) {
    let restante = Math.round(valor * 100); // centavos para evitar float
    const resultado = [];
    for (const item of DINHEIRO) {
      const centavos = Math.round(item * 100);
      const qtd = Math.floor(restante / centavos);
      if (qtd > 0) {
        resultado.push({ valor: item, quantidade: qtd });
        restante -= qtd * centavos;
      }
    }
    return resultado;
  }

  // ─── Formata valor em BRL ─────────────────────────────────────────────────
  function brl(v) {
    return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  // ─── Injeta estilos únicos (só uma vez) ───────────────────────────────────
  function injetarEstilos() {
    if (document.getElementById('troco-styles')) return;
    const style = document.createElement('style');
    style.id = 'troco-styles';
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap');

      #troco-overlay {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0,0,0,0.75);
        backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity .25s ease;
        padding: 1rem;
      }
      #troco-overlay.show { opacity: 1; }

      #troco-modal {
        background: #0f1117;
        border: 1px solid #2a2d3a;
        border-radius: 20px;
        width: 100%; max-width: 420px;
        box-shadow: 0 30px 80px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.04);
        transform: translateY(24px) scale(.97);
        transition: transform .3s cubic-bezier(.34,1.56,.64,1);
        overflow: hidden;
        font-family: 'Syne', sans-serif;
      }
      #troco-overlay.show #troco-modal {
        transform: translateY(0) scale(1);
      }

      /* ── Header ── */
      .troco-header {
        background: linear-gradient(135deg, #1a1d2e 0%, #131620 100%);
        padding: 1.4rem 1.6rem 1.2rem;
        border-bottom: 1px solid #1e2030;
        display: flex; align-items: center; gap: .8rem;
      }
      .troco-header-icon {
        width: 40px; height: 40px; border-radius: 10px;
        background: linear-gradient(135deg, #4ade80, #22c55e);
        display: flex; align-items: center; justify-content: center;
        font-size: 1.2rem; flex-shrink: 0;
        box-shadow: 0 4px 14px rgba(74,222,128,.35);
      }
      .troco-title { color: #f1f5f9; font-size: 1.1rem; font-weight: 700; }
      .troco-subtitle { color: #64748b; font-size: .75rem; font-weight: 400; margin-top: 1px; }

      /* ── Corpo ── */
      .troco-body { padding: 1.4rem 1.6rem; display: flex; flex-direction: column; gap: 1rem; }

      /* ── Linha de valores ── */
      .troco-row {
        display: flex; align-items: center; justify-content: space-between;
        background: #161820; border-radius: 10px;
        padding: .7rem 1rem;
        border: 1px solid #1e2030;
      }
      .troco-row-label { color: #94a3b8; font-size: .78rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
      .troco-row-value {
        font-family: 'JetBrains Mono', monospace;
        font-size: 1rem; font-weight: 600; color: #f1f5f9;
      }

      /* ── Input pagamento ── */
      .troco-input-wrap { position: relative; }
      .troco-input-label {
        color: #94a3b8; font-size: .78rem; font-weight: 600;
        text-transform: uppercase; letter-spacing: .06em;
        margin-bottom: .4rem; display: block;
      }
      .troco-input {
        width: 100%; background: #161820;
        border: 2px solid #2a2d3a; border-radius: 10px;
        padding: .75rem 1rem .75rem 2.8rem;
        color: #f1f5f9; font-size: 1.25rem; font-weight: 700;
        font-family: 'JetBrains Mono', monospace;
        outline: none; transition: border-color .2s, box-shadow .2s;
        box-sizing: border-box;
      }
      .troco-input:focus {
        border-color: #4ade80;
        box-shadow: 0 0 0 3px rgba(74,222,128,.15);
      }
      .troco-input-prefix {
        position: absolute; left: 1rem; top: 50%; transform: translateY(-50%);
        color: #4ade80; font-size: .9rem; font-weight: 700;
        font-family: 'JetBrains Mono', monospace; pointer-events: none;
      }

      /* ── Sugestões rápidas ── */
      .troco-sugestoes {
        display: flex; gap: .5rem; flex-wrap: wrap;
      }
      .troco-sug-btn {
        background: #1e2030; border: 1px solid #2a2d3a;
        color: #94a3b8; border-radius: 8px;
        padding: .35rem .75rem; font-size: .8rem; font-weight: 600;
        font-family: 'Syne', sans-serif;
        cursor: pointer; transition: all .15s;
        flex: 1 1 auto; min-width: 56px; text-align: center;
      }
      .troco-sug-btn:hover { background: #252838; border-color: #4ade80; color: #4ade80; }
      .troco-sug-btn.active { background: #14532d; border-color: #4ade80; color: #4ade80; }

      /* ── Resultado troco ── */
      .troco-resultado {
        border-radius: 12px; overflow: hidden;
        border: 1px solid #1e2030;
        transition: all .3s ease;
      }
      .troco-resultado-header {
        background: linear-gradient(135deg, #14532d, #166534);
        padding: .85rem 1rem;
        display: flex; align-items: center; justify-content: space-between;
      }
      .troco-resultado-label { color: #bbf7d0; font-size: .8rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
      .troco-resultado-valor {
        font-family: 'JetBrains Mono', monospace;
        font-size: 1.5rem; font-weight: 700; color: #4ade80;
        text-shadow: 0 0 20px rgba(74,222,128,.4);
      }
      .troco-resultado-negativo .troco-resultado-header {
        background: linear-gradient(135deg, #7f1d1d, #991b1b);
      }
      .troco-resultado-negativo .troco-resultado-label { color: #fecaca; }
      .troco-resultado-negativo .troco-resultado-valor { color: #f87171; text-shadow: 0 0 20px rgba(248,113,113,.4); }

      /* ── Decomposição ── */
      .troco-decomp {
        background: #0d0f18; padding: .75rem 1rem;
        display: flex; flex-wrap: wrap; gap: .4rem;
      }
      .troco-item {
        display: flex; align-items: center; gap: .3rem;
        background: #161820; border: 1px solid #2a2d3a;
        border-radius: 6px; padding: .25rem .55rem;
        font-size: .78rem;
      }
      .troco-item-qtd {
        font-family: 'JetBrains Mono', monospace;
        font-weight: 700; color: #4ade80; font-size: .75rem;
      }
      .troco-item-val { color: #94a3b8; font-weight: 600; }
      .troco-item-cedula { border-color: #4ade8044; }
      .troco-item-moeda  { border-color: #fbbf2444; }
      .troco-item-moeda .troco-item-qtd { color: #fbbf24; }

      /* ── Botões ── */
      .troco-footer {
        padding: .8rem 1.6rem 1.4rem;
        display: flex; gap: .75rem;
      }
      .troco-btn {
        flex: 1; padding: .75rem; border-radius: 10px;
        font-family: 'Syne', sans-serif; font-weight: 700;
        font-size: .9rem; cursor: pointer;
        transition: all .15s; border: none; outline: none;
      }
      .troco-btn-cancelar {
        background: #161820; color: #64748b;
        border: 1px solid #2a2d3a;
      }
      .troco-btn-cancelar:hover { background: #1e2030; color: #94a3b8; }
      .troco-btn-confirmar {
        background: linear-gradient(135deg, #22c55e, #16a34a);
        color: #fff;
        box-shadow: 0 4px 14px rgba(34,197,94,.3);
      }
      .troco-btn-confirmar:hover {
        transform: translateY(-1px);
        box-shadow: 0 6px 20px rgba(34,197,94,.45);
      }
      .troco-btn-confirmar:active { transform: translateY(0); }
      .troco-btn-confirmar:disabled {
        opacity: .4; cursor: not-allowed; transform: none;
        box-shadow: none;
      }

      /* ── Teclado numérico ── */
      .troco-teclado {
        display: grid; grid-template-columns: repeat(3, 1fr);
        gap: .5rem; margin-top: .25rem;
      }
      .troco-key {
        background: #161820; border: 1px solid #2a2d3a;
        border-radius: 8px; padding: .7rem;
        color: #e2e8f0; font-size: 1rem; font-weight: 700;
        font-family: 'JetBrains Mono', monospace;
        cursor: pointer; text-align: center;
        transition: all .1s; user-select: none;
      }
      .troco-key:hover  { background: #1e2030; border-color: #4ade80; color: #4ade80; }
      .troco-key:active { background: #14532d; transform: scale(.96); }
      .troco-key.del    { color: #f87171; font-size: .85rem; }
      .troco-key.zero   { grid-column: span 2; }

      @media (max-width: 400px) {
        .troco-body { padding: 1rem; }
        .troco-footer { padding: .6rem 1rem 1rem; }
      }
    `;
    document.head.appendChild(style);
  }

  // ─── Cria o HTML do modal ─────────────────────────────────────────────────
  function criarModal() {
    const el = document.createElement('div');
    el.id = 'troco-overlay';
    el.innerHTML = `
      <div id="troco-modal" role="dialog" aria-modal="true" aria-labelledby="troco-title">

        <div class="troco-header">
          <div class="troco-header-icon">💵</div>
          <div>
            <div class="troco-title" id="troco-title">Calcular Troco</div>
            <div class="troco-subtitle">Informe o valor recebido</div>
          </div>
        </div>

        <div class="troco-body">

          <!-- Total da venda -->
          <div class="troco-row">
            <span class="troco-row-label">Total da Venda</span>
            <span class="troco-row-value" id="troco-total-display">R$ 0,00</span>
          </div>

          <!-- Input valor recebido -->
          <div class="troco-input-wrap">
            <span class="troco-input-label">Valor Recebido</span>
            <span class="troco-input-prefix">R$</span>
            <input id="troco-input" class="troco-input" type="text"
              placeholder="0,00" inputmode="decimal" autocomplete="off" />
          </div>

          <!-- Sugestões rápidas -->
          <div id="troco-sugestoes" class="troco-sugestoes"></div>

          <!-- Teclado numérico -->
          <div class="troco-teclado">
            ${[7,8,9,4,5,6,1,2,3].map(n=>`<button class="troco-key" data-key="${n}">${n}</button>`).join('')}
            <button class="troco-key del" data-key="del">⌫</button>
            <button class="troco-key zero" data-key="0">0</button>
            <button class="troco-key" data-key=",">,</button>
          </div>

          <!-- Resultado -->
          <div id="troco-resultado" class="troco-resultado" style="display:none">
            <div class="troco-resultado-header">
              <span class="troco-resultado-label" id="troco-res-label">Troco</span>
              <span class="troco-resultado-valor" id="troco-res-valor">R$ 0,00</span>
            </div>
            <div id="troco-decomp" class="troco-decomp"></div>
          </div>

        </div>

        <div class="troco-footer">
          <button class="troco-btn troco-btn-cancelar" id="troco-cancelar">Cancelar</button>
          <button class="troco-btn troco-btn-confirmar" id="troco-confirmar" disabled>Confirmar</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    return el;
  }

  // ─── Estado interno ───────────────────────────────────────────────────────
  let overlay     = null;
  let totalVenda  = 0;
  let rawInput    = '';  // string de dígitos, ex: "1500" = R$15,00
  let onConfirmar = null;

  // ─── Parseia rawInput para float ──────────────────────────────────────────
  function rawToFloat() {
    if (!rawInput) return 0;
    return parseInt(rawInput, 10) / 100;
  }

  // ─── Formata rawInput para exibição ──────────────────────────────────────
  function rawToDisplay() {
    const v = rawToFloat();
    return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ─── Atualiza tudo na tela ────────────────────────────────────────────────
  function atualizar() {
    const input     = document.getElementById('troco-input');
    const resultado = document.getElementById('troco-resultado');
    const resLabel  = document.getElementById('troco-res-label');
    const resValor  = document.getElementById('troco-res-valor');
    const decomp    = document.getElementById('troco-decomp');
    const btnConf   = document.getElementById('troco-confirmar');

    input.value = rawInput ? rawToDisplay() : '';

    const pago  = rawToFloat();
    const troco = pago - totalVenda;

    if (pago === 0) {
      resultado.style.display = 'none';
      btnConf.disabled = true;
      return;
    }

    resultado.style.display = '';
    resultado.classList.toggle('troco-resultado-negativo', troco < 0);

    if (troco < 0) {
      resLabel.textContent = 'Faltam';
      resValor.textContent = brl(Math.abs(troco));
      decomp.innerHTML     = '';
      btnConf.disabled     = true;
    } else {
      resLabel.textContent = troco === 0 ? 'Troco Exato' : 'Troco';
      resValor.textContent = brl(troco);
      decomp.innerHTML     = troco === 0
        ? '<span style="color:#64748b;font-size:.8rem;padding:.25rem">Pagamento exato 🎯</span>'
        : decompor(troco).map(({ valor, quantidade }) => {
            const isMoeda = valor < 2;
            const label = valor >= 1
              ? `R$${valor.toFixed(0)}`
              : `${(valor * 100).toFixed(0)}¢`;
            return `<span class="troco-item ${isMoeda ? 'troco-item-moeda' : 'troco-item-cedula'}">
              <span class="troco-item-qtd">${quantidade}×</span>
              <span class="troco-item-val">${label}</span>
            </span>`;
          }).join('');
      btnConf.disabled = false;
    }
  }

  // ─── Gera sugestões de notas acima do total ───────────────────────────────
  function gerarSugestoes(total) {
    const wrap = document.getElementById('troco-sugestoes');
    if (!wrap) return;
    // Pega as 4 primeiras cédulas maiores ou iguais ao total
    const sugs = CEDULAS
      .filter(c => c >= total)
      .slice(0, 4);
    // Adiciona valor exato se não estiver
    if (!sugs.includes(total) && total === Math.round(total)) sugs.unshift(total);

    wrap.innerHTML = sugs.slice(0, 4).map(v => `
      <button class="troco-sug-btn" data-sug="${v}">
        ${v === total ? 'Exato' : brl(v)}
      </button>
    `).join('');

    wrap.querySelectorAll('.troco-sug-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = parseFloat(btn.dataset.sug);
        rawInput  = String(Math.round(val * 100));
        wrap.querySelectorAll('.troco-sug-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        atualizar();
      });
    });
  }

  // ─── Teclado numérico ────────────────────────────────────────────────────
  function bindTeclado() {
    document.getElementById('troco-modal').addEventListener('click', e => {
      const key = e.target.closest('[data-key]')?.dataset.key;
      if (!key) return;

      if (key === 'del') {
        rawInput = rawInput.slice(0, -1);
      } else if (key === ',') {
        // nada (já formatamos com centavos)
      } else {
        if (rawInput.length >= 9) return; // máximo R$ 9.999.999,99
        rawInput += key;
        // Remove zeros à esquerda
        rawInput = String(parseInt(rawInput, 10));
      }

      // Desmarca sugestão ativa
      document.querySelectorAll('.troco-sug-btn').forEach(b => b.classList.remove('active'));
      atualizar();
    });

    // Input manual por teclado físico
    document.getElementById('troco-input').addEventListener('keydown', e => {
      e.preventDefault();
      if (e.key >= '0' && e.key <= '9') {
        if (rawInput.length < 9) rawInput = String(parseInt((rawInput || '0') + e.key, 10));
      } else if (e.key === 'Backspace') {
        rawInput = rawInput.slice(0, -1);
      } else if (e.key === 'Enter') {
        const btn = document.getElementById('troco-confirmar');
        if (!btn.disabled) btn.click();
      } else if (e.key === 'Escape') {
        fechar();
      }
      document.querySelectorAll('.troco-sug-btn').forEach(b => b.classList.remove('active'));
      atualizar();
    });
  }

  // ─── Abre o modal ─────────────────────────────────────────────────────────
  function abrir(total, callback) {
    injetarEstilos();
    if (!overlay) {
      overlay = criarModal();

      // Fechar ao clicar fora
      overlay.addEventListener('click', e => {
        if (e.target === overlay) fechar();
      });

      document.getElementById('troco-cancelar').addEventListener('click', fechar);
      document.getElementById('troco-confirmar').addEventListener('click', () => {
        const pago  = rawToFloat();
        const troco = pago - totalVenda;
        fechar();
        if (typeof onConfirmar === 'function') {
          onConfirmar({ totalVenda, pago, troco });
        }
      });

      bindTeclado();
    }

    totalVenda  = total;
    rawInput    = '';
    onConfirmar = callback || null;

    document.getElementById('troco-total-display').textContent = brl(total);
    document.getElementById('troco-resultado').style.display   = 'none';
    document.getElementById('troco-confirmar').disabled        = true;
    document.getElementById('troco-input').value               = '';

    gerarSugestoes(total);
    atualizar();

    requestAnimationFrame(() => {
      overlay.style.display = 'flex';
      requestAnimationFrame(() => {
        overlay.classList.add('show');
        setTimeout(() => document.getElementById('troco-input').focus(), 200);
      });
    });
  }

  // ─── Fecha o modal ────────────────────────────────────────────────────────
  function fechar() {
    if (!overlay) return;
    overlay.classList.remove('show');
    setTimeout(() => { overlay.style.display = 'none'; }, 260);
  }

  // ─── API pública ──────────────────────────────────────────────────────────
  return { abrir, fechar, calcularTroco: (pago, total) => pago - total };
})();
