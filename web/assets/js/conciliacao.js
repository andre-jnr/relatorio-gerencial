// ============================================================
// Página "Conciliação dos pagamentos": parte do total pago lançado no
// sistema, tira e acrescenta cada regra da unidade e chega ao valor de
// Pagamentos da Visão geral, com centavos (sem arredondar para mil/mi).
// ============================================================

const Conciliacao = (() => {
  const MSG_SEM_SERVIDOR = 'Não foi possível falar com o servidor do painel. Confira se ele está no ar e tente de novo.';
  const ANOS_DISPONIVEIS = 3;
  const LINHAS_VISIVEIS = 40; // lançamentos por ajuste antes do "Mostrar todos"

  const hoje = new Date();
  const params = new URLSearchParams(location.search);
  const state = { slug: null, ano: hoje.getFullYear(), mes: hoje.getMonth() + 1 };
  let unidades = [];
  let dados = null;
  let requisicao = 0;
  const cache = {};
  const els = {};

  const qs = (id) => document.getElementById(id);
  const brl = (v) => fmt.currencyCents(v);
  const assinado = (v, tipo) => `${tipo === 'menos' ? '−' : '+'} ${brl(Math.abs(v))}`;
  const qtde = (n) => `${fmt.int(n)} ${n === 1 ? 'lançamento' : 'lançamentos'}`;
  const dataBR = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
  const unidade = (slug) => unidades.find((u) => u.slug === slug);

  const ICON = {
    menos: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
    mais: '<svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg>',
    ok: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    alerta: '<svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17h.01"/></svg>',
    seta: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    abrir: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  };

  // ---------------- status ----------------
  function status(tipo, titulo, msg, repetir) {
    els.statusPanel.hidden = false;
    els.statusPanel.classList.toggle('is-error', tipo === 'error');
    els.statusIcon.innerHTML = tipo === 'error' ? ICON.alerta : '<span class="spinner"></span>';
    els.statusTitle.textContent = titulo;
    els.statusMsg.textContent = msg;
    els.statusRetry.hidden = !repetir;
    els.statusRetry.onclick = repetir || null;
    els.concBody.hidden = true;
  }

  // ---------------- filtros ----------------
  function renderFiltros() {
    els.filterUnidade.innerHTML = unidades.map((u) => `<option value="${escapeHtml(u.slug)}">${escapeHtml(u.nome)}</option>`).join('');
    els.filterUnidade.value = state.slug;
    els.filterUnidade.onchange = () => { state.slug = els.filterUnidade.value; gravar(); carregar(); };

    const anoAtual = hoje.getFullYear();
    els.filterAno.innerHTML = Array.from({ length: ANOS_DISPONIVEIS }, (_, i) => anoAtual - i)
      .map((a) => `<button type="button" data-a="${a}" class="${a === state.ano ? 'is-active' : ''}">${a}</button>`).join('');
    [...els.filterAno.children].forEach((b) => {
      b.onclick = () => {
        state.ano = Number(b.dataset.a);
        if (state.ano === anoAtual && state.mes !== 'all') state.mes = Math.min(state.mes, hoje.getMonth() + 1);
        carregar();
      };
    });

    const limite = state.ano === anoAtual ? hoje.getMonth() + 1 : 12;
    els.filterMes.innerHTML = `<button type="button" data-m="all" class="${state.mes === 'all' ? 'is-active' : ''}">Ano inteiro</button>`
      + Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (m <= limite
        ? `<button type="button" data-m="${m}" class="${m === state.mes ? 'is-active' : ''}">${fmt.monthName(m)}</button>`
        : `<button type="button" disabled style="opacity:.32;cursor:not-allowed">${fmt.monthName(m)}</button>`)).join('');
    [...els.filterMes.children].forEach((b) => {
      if (b.disabled) return;
      b.onclick = () => { state.mes = b.dataset.m === 'all' ? 'all' : Number(b.dataset.m); carregar(); };
    });
  }

  function gravar() {
    try {
      const salvo = JSON.parse(localStorage.getItem('painel.state') || '{}');
      localStorage.setItem('painel.state', JSON.stringify({ ...salvo, slug: state.slug }));
    } catch (e) { /* sem storage */ }
  }

  function periodoTexto() {
    if (state.mes === 'all') return `ano de ${state.ano}`;
    const nome = fmt.monthLong(state.mes);
    return `${nome} de ${state.ano}`;
  }

  // ---------------- carregamento ----------------
  async function carregar(atualizar = false) {
    const id = ++requisicao;
    const mes = state.mes === 'all' ? 0 : state.mes;
    const chave = `${state.slug}|${state.ano}|${mes}`;
    renderFiltros();
    const u = unidade(state.slug);
    els.subheading.textContent = `${u.nome} · ${periodoTexto()}`;
    if (atualizar || !cache[chave]) {
      status('loading', `Conciliando ${u.nome}…`, 'Lendo os lançamentos do banco e as regras da unidade.');
      try {
        const res = await fetch(`/api/conciliacao/${encodeURIComponent(state.slug)}?ano=${state.ano}&mes=${mes}${atualizar ? '&atualizar=1' : ''}`, { cache: 'no-store' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.erro || `Erro ${res.status}`);
        cache[chave] = body;
      } catch (e) {
        if (id !== requisicao) return;
        status('error', `Não foi possível conciliar ${u.nome}`, e instanceof TypeError ? MSG_SEM_SERVIDOR : e.message, () => carregar(true));
        return;
      }
    }
    if (id !== requisicao) return;
    dados = cache[chave];
    els.statusPanel.hidden = true;
    els.concBody.hidden = false;
    render();
  }

  // ---------------- render ----------------
  function render() {
    const d = dados;
    const menos = d.grupos.filter((g) => g.tipo === 'menos');
    const mais = d.grupos.filter((g) => g.tipo === 'mais');
    const totalMenos = menos.reduce((s, g) => s + g.valor, 0);
    const totalMais = mais.reduce((s, g) => s + g.valor, 0);
    const dif = d.total - d.painel;
    const confere = Math.abs(dif) < 0.015; // frações de centavo (preço de custo, fator) não contam

    els.subheading.textContent = `${d.unidade} · ${periodoTexto()} · ${dataBR(d.periodo.ini)} a ${dataBR(d.periodo.fim)}`;
    const dt = new Date(d.atualizado_em);
    els.filterAtualizado.textContent = `consultado às ${dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    els.footerUpdated.textContent = `Dados consultados no banco em ${dt.toLocaleString('pt-BR')}`;

    // ---- ponte ----
    els.concPonte.innerHTML = `
      <div class="conc-passo">
        <span class="conc-rotulo">${escapeHtml(d.base.titulo)}</span>
        <span class="conc-valor">${brl(d.base.valor)}</span>
        <span class="conc-nota">${qtde(d.base.qtde)} com data de pagamento no período</span>
      </div>
      <span class="conc-seta" aria-hidden="true">${ICON.seta}</span>
      <div class="conc-passo conc-passo--ajustes">
        <div class="conc-ajuste is-menos">
          <span class="conc-rotulo">Desconsiderado</span>
          <span class="conc-valor conc-valor--medio">${totalMenos ? `− ${brl(totalMenos)}` : brl(0)}</span>
          <span class="conc-nota">${menos.length ? `${menos.length} ${menos.length === 1 ? 'regra' : 'regras'}` : 'nenhuma regra tira valores'}</span>
        </div>
        <div class="conc-ajuste is-mais">
          <span class="conc-rotulo">Acrescentado de outras fontes</span>
          <span class="conc-valor conc-valor--medio">${totalMais ? `+ ${brl(totalMais)}` : brl(0)}</span>
          <span class="conc-nota">${mais.length ? mais.map((g) => escapeHtml(g.titulo)).join(' · ') : 'nenhuma fonte de fora do banco'}</span>
        </div>
      </div>
      <span class="conc-seta" aria-hidden="true">${ICON.seta}</span>
      <div class="conc-passo conc-passo--final">
        <span class="conc-rotulo">Pagamentos no painel</span>
        <span class="conc-valor">${brl(d.total)}</span>
        <span class="conc-selo ${confere ? 'is-ok' : 'is-alerta'}">${confere ? ICON.ok : ICON.alerta}
          ${confere ? 'Confere com a Visão geral' : `Diferença de ${brl(dif)} com a Visão geral (${brl(d.painel)})`}</span>
      </div>`;

    // ---- cascata ----
    const passos = [{ tipo: 'base', titulo: d.base.titulo, valor: d.base.valor, qtde: d.base.qtde }]
      .concat(d.grupos.map((g) => ({ tipo: g.tipo, titulo: g.titulo, valor: g.valor, qtde: g.qtde, id: g.id })))
      .concat([{ tipo: 'total', titulo: 'Pagamentos no painel', valor: d.total }]);
    let corrente = 0;
    const faixas = passos.map((p) => {
      let de; let ate;
      if (p.tipo === 'base' || p.tipo === 'total') { de = 0; ate = p.valor; corrente = p.valor; }
      else if (p.tipo === 'menos') { de = corrente - p.valor; ate = corrente; corrente = de; }
      else { de = corrente; ate = corrente + p.valor; corrente = ate; }
      return { ...p, de, ate };
    });
    const escala = Math.max(...faixas.map((f) => f.ate), 1);
    els.concCascata.innerHTML = faixas.map((f) => {
      const esq = (Math.max(f.de, 0) / escala) * 100;
      const larg = Math.max(((f.ate - Math.max(f.de, 0)) / escala) * 100, 0.4);
      const valor = f.tipo === 'menos' || f.tipo === 'mais' ? assinado(f.valor, f.tipo) : brl(f.valor);
      const alvo = f.id ? ` href="#ajuste-${f.id}"` : '';
      const Tag = f.id ? 'a' : 'div';
      return `<${Tag} class="conc-linha is-${f.tipo}" role="listitem"${alvo}>
        <span class="conc-linha-titulo">${escapeHtml(f.titulo)}${f.qtde != null ? `<small>${qtde(f.qtde)}</small>` : ''}</span>
        <span class="conc-trilho"><span class="conc-barra" style="left:${esq}%;width:${larg}%"></span></span>
        <span class="conc-linha-valor">${valor}</span>
      </${Tag}>`;
    }).join('');

    // ---- extrato ----
    if (!d.grupos.length) {
      els.concExtrato.innerHTML = `<div class="card conc-vazio">${ICON.ok}<div><strong>Nenhum ajuste neste período.</strong><p>Tudo o que foi pago no sistema entra nos pagamentos do painel.</p></div></div>`;
      return;
    }
    const pdf = PDF.modoArquivo();
    els.concExtrato.innerHTML = d.grupos.map((g) => {
      const maior = Math.max(...g.subgrupos.map((s) => Math.abs(s.valor)), 1);
      const subs = g.subgrupos.map((s) => `
        <li>
          <span class="conc-sub-titulo">${escapeHtml(s.titulo)}<small>${qtde(s.qtde)}</small></span>
          <span class="conc-sub-barra"><span style="width:${(Math.abs(s.valor) / maior) * 100}%"></span></span>
          <span class="conc-sub-valor">${brl(s.valor)}</span>
        </li>`).join('');
      return `
      <details class="card conc-grupo is-${g.tipo}" id="ajuste-${g.id}" ${pdf ? 'open' : ''}>
        <summary>
          <span class="conc-sinal">${ICON[g.tipo]}</span>
          <span class="conc-grupo-titulo"><strong>${escapeHtml(g.titulo)}</strong><small>${escapeHtml(g.descricao)}</small></span>
          <span class="conc-grupo-qtde">${qtde(g.qtde)}</span>
          <span class="conc-grupo-valor">${assinado(g.valor, g.tipo)}</span>
          <span class="conc-abrir">${ICON.abrir}</span>
        </summary>
        <div class="conc-grupo-corpo">
          <ul class="conc-subs">${subs}</ul>
          ${tabela(g, pdf)}
        </div>
      </details>`;
    }).join('');
    els.concExtrato.querySelectorAll('[data-todos]').forEach((b) => {
      b.onclick = () => {
        const g = d.grupos.find((x) => x.id === b.dataset.todos);
        b.closest('.conc-tabela-wrap').outerHTML = tabela(g, true);
      };
    });
  }

  function tabela(g, todas) {
    const linhas = todas ? g.linhas : g.linhas.slice(0, LINHAS_VISIVEIS);
    const mostraDetalhe = g.subgrupos.length > 1;
    return `<div class="conc-tabela-wrap">
      <table class="matriz lista conc-tabela">
        <thead><tr>
          <th class="col-num">Código</th><th class="col-data">Data</th><th class="col-txt">Fornecedor</th>
          <th class="col-txt">Conta contábil</th><th class="col-txt col-obs">Observação</th>
          ${mostraDetalhe ? '<th class="col-txt">Motivo</th>' : ''}<th class="col-num">Valor</th>
        </tr></thead>
        <tbody>${linhas.map((l) => `<tr>
          <td class="col-num">${l.codigo ?? '—'}</td><td class="col-data">${dataBR(l.data)}</td>
          <td class="col-txt">${escapeHtml(l.fornecedor || '—')}</td><td class="col-txt">${escapeHtml(l.conta || '—')}</td>
          <td class="col-txt col-obs">${escapeHtml(l.observacao || '')}</td>
          ${mostraDetalhe ? `<td class="col-txt">${escapeHtml(l.detalhe)}</td>` : ''}
          <td class="col-num">${brl(l.valor)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="${mostraDetalhe ? 6 : 5}">Total do ajuste</td><td class="col-num">${brl(g.valor)}</td></tr></tfoot>
      </table>
      ${!todas && g.linhas.length > LINHAS_VISIVEIS ? `<div class="lista-mais"><button type="button" class="btn-ghost" data-todos="${g.id}">Mostrar todos os ${fmt.int(g.linhas.length)} lançamentos</button></div>` : ''}
    </div>`;
  }

  // ---------------- tema e PDF ----------------
  function initTema() {
    const app = document.querySelector('.app');
    let salvo = null;
    try { salvo = localStorage.getItem('painel.theme'); } catch (e) { /* sem storage */ }
    const escuro = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const tema = PDF.modoArquivo() ? 'light' : (salvo || (escuro ? 'dark' : 'light'));
    app.setAttribute('data-theme', tema);
    document.documentElement.setAttribute('data-theme', tema);
    qs('theme-toggle').addEventListener('click', () => {
      const prox = app.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      app.setAttribute('data-theme', prox);
      document.documentElement.setAttribute('data-theme', prox);
      try { localStorage.setItem('painel.theme', prox); } catch (e) { /* sem storage */ }
    });
  }

  function gerarPDF() {
    if (!dados) return;
    const periodo = state.mes === 'all' ? `${state.ano}` : `${fmt.monthName(state.mes)}-${state.ano}`;
    PDF.baixar({
      pagina: 'conciliacao.html',
      params: { slug: state.slug, ano: state.ano, mes: state.mes },
      nome: `Conciliação dos pagamentos - ${dados.unidade} - ${periodo}`,
    });
  }

  // ---------------- início ----------------
  async function init() {
    ['filter-unidade', 'filter-ano', 'filter-mes', 'filter-atualizado', 'refresh-btn', 'status-panel', 'status-icon',
      'status-title', 'status-msg', 'status-retry', 'conc-body', 'conc-ponte', 'conc-cascata', 'conc-extrato',
      'subheading', 'footer-updated'].forEach((id) => { els[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = qs(id); });
    initTema();
    if (PDF.modoArquivo()) PDF.prepararModoArquivo();

    status('loading', 'Conectando ao servidor do painel…', 'Carregando a lista de lojas.');
    try {
      const res = await fetch(CONFIG.unidadesUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      unidades = await res.json();
      if (!unidades.length) throw new Error('sem lojas');
    } catch (e) {
      status('error', 'Servidor do painel indisponível', MSG_SEM_SERVIDOR, () => location.reload());
      return;
    }
    state.slug = unidades[0].slug;
    try {
      const salvo = JSON.parse(localStorage.getItem('painel.state') || 'null');
      if (salvo && unidade(salvo.slug)) state.slug = salvo.slug;
    } catch (e) { /* sem storage */ }
    if (unidade(params.get('slug'))) state.slug = params.get('slug');
    if (Number(params.get('ano'))) state.ano = Number(params.get('ano'));
    if (params.get('mes')) state.mes = params.get('mes') === 'all' ? 'all' : (Number(params.get('mes')) || state.mes);

    els.refreshBtn.onclick = async () => {
      els.refreshBtn.disabled = true;
      els.refreshBtn.classList.add('is-busy');
      try { await carregar(true); } finally { els.refreshBtn.disabled = false; els.refreshBtn.classList.remove('is-busy'); }
    };
    qs('pdf-btn').onclick = gerarPDF;
    await carregar();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Conciliacao.init);
