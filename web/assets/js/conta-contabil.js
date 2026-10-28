// ============================================================
// Página "Análise por conta contábil": matriz plano de contas > grupo > conta contábil
// com o pago no mês selecionado x mês anterior. Mês em andamento é
// comparado pelo mesmo intervalo de dias (o corte vem do servidor).
// ============================================================

const ContaContabil = (() => {
  const NAO_CLASSIFICADOS = 'PAGAMENTOS NÃO CLASSIFICADOS';
  const MSG_SEM_SERVIDOR = 'Não foi possível falar com o servidor do painel. Confira se ele está no ar e tente de novo.';
  const ANOS_DISPONIVEIS = 3; // ano atual e os dois anteriores (o servidor guarda 24 meses no painel)

  const hoje = new Date();
  const state = {
    slug: null,
    ano: hoje.getFullYear(),
    mes: hoje.getMonth() + 1, // abre no mês corrente (em andamento)
    comPlano: true,
    busca: '',
    ordem: { coluna: 'atual', direcao: 'desc' }, // clique no título da coluna
  };

  let unidadesIndex = [];
  let dados = null;            // resposta de /api/conta-contabil do período atual
  let expandidos = new Set();  // chaves dos nós abertos na matriz
  let requisicao = 0;          // descarta respostas de filtros já trocados
  const cache = {};            // "slug|ano|mes" -> resposta
  const els = {};

  function qs(id) { return document.getElementById(id); }

  function cacheEls() {
    [
      'filter-unidade', 'filter-ano', 'filter-mes', 'filter-conexao', 'filter-atualizado', 'refresh-btn',
      'status-panel', 'status-icon', 'status-title', 'status-msg', 'status-retry', 'pagamentos-body',
      'subheading', 'pag-resumo', 'matriz-sub', 'toggle-plano', 'matriz-busca', 'btn-expandir', 'btn-recolher',
      'th-nome', 'th-anterior', 'th-atual', 'matriz-body', 'matriz-foot', 'footer-updated',
    ].forEach((id) => { els[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = qs(id); });
  }

  // ---------------- utilidades ----------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function normaliza(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  }

  function unidade(slug) { return unidadesIndex.find((u) => u.slug === slug); }

  function mesAno(ano, mes) { return `${fmt.monthName(mes)}/${String(ano).slice(2)}`; }

  function parseData(iso) {
    const [a, m, d] = iso.split('-').map(Number);
    return { ano: a, mes: m, dia: d };
  }

  // "Set/26" (mês fechado) ou "Set/26 · 01 a 04" (recorte do mês em andamento)
  function rotuloPeriodo(periodo, fechado) {
    const ini = parseData(periodo.ini);
    const fim = parseData(periodo.fim);
    const base = mesAno(ini.ano, ini.mes);
    return fechado ? base : `${base} · 01 a ${String(fim.dia).padStart(2, '0')}`;
  }

  function diferenca(anterior, atual) {
    const valor = atual - anterior;
    const pct = anterior ? (valor / Math.abs(anterior)) * 100 : null;
    const dir = Math.abs(valor) < 0.005 ? 'flat' : valor > 0 ? 'up' : 'down';
    return { valor, pct, dir };
  }

  function textoValorDif(d) {
    if (d.dir === 'flat') return fmt.currencyCents(0);
    return `${d.valor > 0 ? '+' : '−'}${fmt.currencyCents(Math.abs(d.valor))}`;
  }

  function textoPctDif(d, atual) {
    if (d.pct === null) return atual ? 'novo' : '—';
    if (d.dir === 'flat') return '0,0%';
    return `${d.pct > 0 ? '+' : '−'}${fmt.percent(Math.abs(d.pct))}`;
  }

  // ---------------- status ----------------
  const ICON_ALERT = '<svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17h.01"/></svg>';

  function showStatus(kind, title, msg, onRetry) {
    els.statusPanel.hidden = false;
    els.statusPanel.classList.toggle('is-error', kind === 'error');
    els.statusIcon.innerHTML = kind === 'error' ? ICON_ALERT : '<span class="spinner"></span>';
    els.statusTitle.textContent = title;
    els.statusMsg.textContent = msg;
    els.statusRetry.hidden = !onRetry;
    els.statusRetry.onclick = onRetry || null;
    els.pagamentosBody.hidden = true;
  }

  function hideStatus() {
    els.statusPanel.hidden = true;
    els.pagamentosBody.hidden = false;
  }

  // ---------------- filtros ----------------
  function renderUnidadeSelect() {
    els.filterUnidade.innerHTML = unidadesIndex
      .map((u) => `<option value="${escapeHtml(u.slug)}">${escapeHtml(u.nome)}</option>`)
      .join('');
    els.filterUnidade.value = state.slug;
    els.filterUnidade.onchange = () => {
      state.slug = els.filterUnidade.value;
      persist();
      carregar();
    };
  }

  function renderAnoFilter() {
    const anoAtual = hoje.getFullYear();
    const anos = Array.from({ length: ANOS_DISPONIVEIS }, (_, i) => anoAtual - i);
    els.filterAno.innerHTML = anos
      .map((a) => `<button type="button" data-a="${a}" class="${a === state.ano ? 'is-active' : ''}">${a}</button>`)
      .join('');
    [...els.filterAno.children].forEach((btn) => {
      btn.onclick = () => {
        state.ano = Number(btn.dataset.a);
        // não deixa cair num mês futuro ao voltar para o ano corrente
        if (state.ano === anoAtual) state.mes = Math.min(state.mes, hoje.getMonth() + 1);
        carregar();
      };
    });
  }

  function renderMesFilter() {
    const limite = state.ano === hoje.getFullYear() ? hoje.getMonth() + 1 : 12;
    els.filterMes.innerHTML = Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
      const ok = m <= limite;
      return `<button type="button" data-m="${m}" class="${m === state.mes ? 'is-active' : ''}" ${ok ? '' : 'disabled style="opacity:.32;cursor:not-allowed"'}>${fmt.monthName(m)}</button>`;
    }).join('');
    [...els.filterMes.children].forEach((btn) => {
      if (btn.disabled) return;
      btn.onclick = () => {
        state.mes = Number(btn.dataset.m);
        carregar();
      };
    });
  }

  function renderFilters() {
    const u = unidade(state.slug);
    els.filterConexao.textContent = u.nome;
    renderAnoFilter();
    renderMesFilter();
    if (dados) {
      const dt = new Date(dados.atualizado_em);
      const hora = dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      els.filterAtualizado.textContent = `consultado em ${dt.toLocaleDateString('pt-BR')} às ${hora}`;
      els.footerUpdated.textContent = `Dados consultados no banco em ${dt.toLocaleString('pt-BR')}`;
    } else {
      els.filterAtualizado.textContent = '—';
      els.footerUpdated.textContent = '—';
    }
  }

  // unidade e exibição do plano de contas são lembradas entre visitas
  function persist() {
    try {
      const raw = localStorage.getItem('painel.state');
      const salvo = raw ? JSON.parse(raw) : {};
      localStorage.setItem('painel.state', JSON.stringify({ ...salvo, slug: state.slug }));
      localStorage.setItem('painel.contas.plano', state.comPlano ? '1' : '0');
      localStorage.setItem('painel.contas.ordem', JSON.stringify(state.ordem));
    } catch (e) { /* ignora ambientes sem storage */ }
  }

  function restore() {
    try {
      const raw = localStorage.getItem('painel.state');
      const salvo = raw ? JSON.parse(raw) : null;
      if (salvo && unidade(salvo.slug)) state.slug = salvo.slug;
      state.comPlano = localStorage.getItem('painel.contas.plano') !== '0';
      const ordem = JSON.parse(localStorage.getItem('painel.contas.ordem') || 'null');
      if (ordem && COLUNAS_ORDEM[ordem.coluna] && ['asc', 'desc'].includes(ordem.direcao)) state.ordem = ordem;
    } catch (e) { /* ignora */ }
  }

  // ---------------- carregamento ----------------
  async function carregar(atualizar = false) {
    const id = ++requisicao;
    const chave = `${state.slug}|${state.ano}|${state.mes}`;
    const u = unidade(state.slug);
    dados = null;
    renderFilters();

    if (atualizar || !cache[chave]) {
      els.subheading.textContent = `Consultando ${u.nome}…`;
      showStatus('loading', `Consultando os pagamentos de ${u.nome}…`,
        `${fmt.monthName(state.mes)}/${state.ano} e o mês anterior.`);
      try {
        const res = await fetch(CONFIG.contaContabilUrl(state.slug, state.ano, state.mes) + (atualizar ? '&atualizar=1' : ''), { cache: 'no-store' });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || body.erro) throw new Error((body && body.erro) || `HTTP ${res.status}`);
        body.linhas = Array.isArray(body.linhas) ? body.linhas : [];
        cache[chave] = body;
      } catch (e) {
        if (id !== requisicao) return;
        const msg = e instanceof TypeError ? MSG_SEM_SERVIDOR : e.message;
        els.subheading.textContent = `Não foi possível consultar ${u.nome}.`;
        showStatus('error', `Não foi possível carregar os pagamentos de ${u.nome}`, msg, () => carregar(true));
        return;
      }
      if (id !== requisicao) return; // filtro trocado enquanto consultava
    }

    dados = cache[chave];
    expandidos = PDF.modoArquivo() ? todasChaves(montarArvore(dados.linhas, niveis())) : expansaoPadrao();
    hideStatus();
    renderFilters();
    render();
  }

  async function atualizar() {
    els.refreshBtn.disabled = true;
    els.refreshBtn.classList.add('is-busy');
    try {
      await carregar(true);
    } finally {
      els.refreshBtn.disabled = false;
      els.refreshBtn.classList.remove('is-busy');
    }
  }

  // ---------------- árvore da matriz ----------------
  function niveis() {
    return state.comPlano ? ['plano', 'grupo', 'conta'] : ['grupo', 'conta'];
  }

  function filtrarLinhas(linhas) {
    const termo = normaliza(state.busca.trim());
    if (!termo) return linhas;
    return linhas.filter((l) => [l.conta, l.grupo, state.comPlano ? l.plano : ''].some((t) => normaliza(t).includes(termo)));
  }

  // valor de cada coluna para ordenar; "novo" (sem pagamento no mês anterior) conta como o maior aumento
  const COLUNAS_ORDEM = {
    nome: (n) => n.nome,
    anterior: (n) => n.anterior,
    atual: (n) => n.atual,
    dif: (n) => n.atual - n.anterior,
    pct: (n) => {
      const d = diferenca(n.anterior, n.atual);
      if (d.pct !== null) return d.pct;
      return n.atual > 0 ? Infinity : n.atual < 0 ? -Infinity : 0;
    },
  };

  // ordena cada nível pela coluna escolhida; não classificados ficam sempre por último
  function ordenar(a, b) {
    const na = a.nome === NAO_CLASSIFICADOS ? 1 : 0;
    const nb = b.nome === NAO_CLASSIFICADOS ? 1 : 0;
    if (na !== nb) return na - nb;
    const { coluna, direcao } = state.ordem;
    const va = COLUNAS_ORDEM[coluna](a);
    const vb = COLUNAS_ORDEM[coluna](b);
    const cmp = coluna === 'nome'
      ? va.localeCompare(vb, 'pt-BR', { sensitivity: 'base' })
      : (va === vb ? 0 : va < vb ? -1 : 1);
    return (direcao === 'asc' ? cmp : -cmp) || b.atual - a.atual || a.nome.localeCompare(b.nome, 'pt-BR');
  }

  function renderOrdem() {
    document.querySelectorAll('#matriz thead th[data-col]').forEach((th) => {
      const ativa = th.dataset.col === state.ordem.coluna;
      th.setAttribute('aria-sort', ativa ? (state.ordem.direcao === 'asc' ? 'ascending' : 'descending') : 'none');
    });
  }

  function montarArvore(linhas, campos, prefixo = '') {
    const [campo, ...resto] = campos;
    const mapa = new Map();
    for (const l of linhas) {
      const nome = l[campo];
      if (!mapa.has(nome)) mapa.set(nome, []);
      mapa.get(nome).push(l);
    }
    return [...mapa.entries()].map(([nome, itens]) => {
      const chave = `${prefixo}${campo}:${nome}`;
      // não classificados não têm grupo: o plano já lista as contas direto
      const proximos = nome === NAO_CLASSIFICADOS ? resto.filter((c) => c === 'conta') : resto;
      return {
        chave,
        nome,
        campo,
        naoClassificado: itens.every((l) => !l.classificado),
        anterior: itens.reduce((s, l) => s + l.anterior, 0),
        atual: itens.reduce((s, l) => s + l.atual, 0),
        filhos: proximos.length ? montarArvore(itens, proximos, `${chave}|`) : [],
      };
    }).sort(ordenar);
  }

  // abre o primeiro nível (com plano de contas, mostra os grupos de cada plano)
  function expansaoPadrao() {
    if (!dados || !state.comPlano) return new Set();
    return new Set(montarArvore(dados.linhas, niveis()).map((n) => n.chave));
  }

  // ---------------- exportar (Excel / PDF) ----------------
  function nomeExportacao() {
    const u = unidade(state.slug);
    return `Análise por conta contábil - ${u.nome} - ${fmt.monthName(state.mes)}-${state.ano}`;
  }

  // Excel: uma linha por conta contábil (com plano e grupo em colunas, para filtrar), na ordem da tela
  function exportarExcel() {
    if (!dados) return;
    const contas = [];
    const percorrer = (nos, caminho) => {
      for (const no of nos) {
        const c = { ...caminho, [no.campo]: no.nome === NAO_CLASSIFICADOS ? 'Pagamentos não classificados' : no.nome };
        if (no.filhos.length) percorrer(no.filhos, c);
        else contas.push({ ...c, anterior: no.anterior, atual: no.atual });
      }
    };
    percorrer(montarArvore(filtrarLinhas(dados.linhas), niveis()), {});
    const ant = rotuloPeriodo(dados.periodo_anterior, dados.mes_fechado);
    const atu = rotuloPeriodo(dados.periodo_atual, dados.mes_fechado);
    const pct = (a, b) => (a ? ((b - a) / Math.abs(a)) * 100 : null);
    const colunas = [
      ...(state.comPlano ? [{ titulo: 'Plano de contas', tipo: 'texto', largura: 26 }] : []),
      { titulo: 'Grupo', tipo: 'texto', largura: 30 },
      { titulo: 'Conta contábil', tipo: 'texto', largura: 40 },
      { titulo: ant, tipo: 'moeda', largura: 16 },
      { titulo: atu, tipo: 'moeda', largura: 16 },
      { titulo: 'Diferença (R$)', tipo: 'moeda', largura: 16 },
      { titulo: 'Diferença (%)', tipo: 'pct', largura: 13 },
    ];
    const linhas = contas.map((c) => [
      ...(state.comPlano ? [c.plano] : []), c.grupo || '', c.conta || c.grupo || '',
      c.anterior, c.atual, c.atual - c.anterior, pct(c.anterior, c.atual),
    ]);
    const totAnt = contas.reduce((s, c) => s + c.anterior, 0);
    const totAtu = contas.reduce((s, c) => s + c.atual, 0);
    const busca = state.busca.trim();
    Exportar.excel({
      nome: nomeExportacao(),
      titulo: nomeExportacao().replace(/ - /g, ' · '),
      subtitulo: `${atu} x ${ant}${dados.mes_fechado ? '' : ' (mês em andamento: mesmo intervalo de dias)'}${busca ? ` · busca: "${busca}"` : ''}`,
      colunas,
      linhas,
      total: [...(state.comPlano ? ['Total pago'] : []), state.comPlano ? '' : 'Total pago', '', totAnt, totAtu, totAtu - totAnt, pct(totAnt, totAtu)],
    });
  }

  function exportarPDF(botao) {
    if (!dados) return;
    const params = { slug: state.slug, ano: state.ano, mes: state.mes, plano: state.comPlano ? 1 : 0, ordem: `${state.ordem.coluna}:${state.ordem.direcao}` };
    if (state.busca.trim()) params.busca = state.busca.trim();
    Exportar.pdf({ pagina: 'conta-contabil.html', params, nome: nomeExportacao(), botao });
  }

  function todasChaves(nos, acc = new Set()) {
    for (const n of nos) {
      if (n.filhos.length) { acc.add(n.chave); todasChaves(n.filhos, acc); }
    }
    return acc;
  }

  // ---------------- render ----------------
  function render() {
    renderCabecalho();
    if (state.busca.trim()) els.matrizSub.textContent += ` · busca: "${state.busca.trim()}"`;
    renderResumo();
    renderMatriz();
  }

  function renderCabecalho() {
    const u = unidade(state.slug);
    const ant = rotuloPeriodo(dados.periodo_anterior, dados.mes_fechado);
    const atu = rotuloPeriodo(dados.periodo_atual, dados.mes_fechado);
    const mes = `${fmt.monthName(dados.mes)}/${dados.ano}`;
    els.subheading.textContent = dados.mes_fechado
      ? `Contas pagas da unidade ${u.nome} em ${mes}, comparadas com o mês anterior inteiro.`
      : `Contas pagas da unidade ${u.nome} em ${mes} (mês em andamento), comparadas com o mesmo intervalo de dias do mês anterior.`;
    els.matrizSub.textContent = dados.mes_fechado
      ? `${atu} x ${ant} — meses fechados, comparação do mês inteiro`
      : `Mês em andamento: ${atu} x ${ant} (mesmo intervalo de dias)`;
    els.thAnterior.textContent = ant;
    els.thAtual.textContent = atu;
    els.thNome.textContent = state.comPlano ? 'Plano de contas / grupo / conta contábil' : 'Grupo / conta contábil';
  }

  function kpi(label, valor, extra, tom, delay) {
    const div = document.createElement('div');
    div.className = 'kpi-mini';
    div.style.animationDelay = `${delay}ms`;
    div.innerHTML = `
      <span class="kpi-mini-label">${label}</span>
      <div class="kpi-mini-row">
        <span class="kpi-mini-value">${valor}</span>
        ${extra ? `<span class="kpi-mini-delta pag-tom-${tom}">${extra}</span>` : ''}
      </div>`;
    els.pagResumo.appendChild(div);
  }

  function renderResumo() {
    els.pagResumo.innerHTML = '';
    const anterior = dados.linhas.reduce((s, l) => s + l.anterior, 0);
    const atual = dados.linhas.reduce((s, l) => s + l.atual, 0);
    const d = diferenca(anterior, atual);
    const nc = dados.linhas.filter((l) => !l.classificado && l.atual !== 0);
    const ncValor = nc.reduce((s, l) => s + l.atual, 0);

    kpi(`Pago em ${rotuloPeriodo(dados.periodo_anterior, dados.mes_fechado)}`, fmt.currencyCompact(anterior), '', 'flat', 0);
    kpi(`Pago em ${rotuloPeriodo(dados.periodo_atual, dados.mes_fechado)}`, fmt.currencyCompact(atual), '', 'flat', 40);
    const sinal = d.dir === 'flat' ? '' : d.valor > 0 ? '+' : '−';
    kpi('Diferença (R$)', `${sinal}${fmt.currencyCompact(Math.abs(d.valor))}`, '', d.dir, 80);
    kpi('Diferença (%)', textoPctDif(d, atual), '', d.dir, 120);
    kpi('Não classificados no mês', fmt.currencyCompact(ncValor), nc.length ? `${nc.length} conta(s)` : 'nenhuma', nc.length ? 'warn' : 'flat', 160);

    // valor e % da diferença coloridos como na matriz (aumento de pagamento = vermelho)
    const cards = els.pagResumo.querySelectorAll('.kpi-mini-value');
    cards[2].classList.add(`dif-${d.dir}`);
    cards[3].classList.add(`dif-${d.dir}`);
  }

  function linhaHtml(no, nivel, abertoForcado) {
    const temFilhos = no.filhos.length > 0;
    const aberto = abertoForcado || expandidos.has(no.chave);
    const d = diferenca(no.anterior, no.atual);
    const classes = [`nivel-${nivel}`, `campo-${no.campo}`];
    if (no.naoClassificado) classes.push('is-nao-class');
    const nome = no.nome === NAO_CLASSIFICADOS ? 'Pagamentos não classificados' : no.nome;
    const rotulo = temFilhos
      ? `<button type="button" class="matriz-toggle" data-chave="${escapeHtml(no.chave)}" aria-expanded="${aberto}">
           <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg><span>${escapeHtml(nome)}</span>
           <small>${contarContas(no)}</small>
         </button>`
      : `<span class="matriz-folha">${escapeHtml(nome)}</span>`;
    return `<tr class="${classes.join(' ')}">
      <th scope="row" class="col-nome" style="--nivel:${nivel}">${rotulo}</th>
      <td class="col-num">${fmt.currencyCents(no.anterior)}</td>
      <td class="col-num">${fmt.currencyCents(no.atual)}</td>
      <td class="col-num dif-${d.dir}">${textoValorDif(d)}</td>
      <td class="col-num dif-${d.dir}">${textoPctDif(d, no.atual)}</td>
    </tr>`;
  }

  function contarContas(no) {
    const n = contarFolhas(no);
    return `${n} ${n === 1 ? 'conta' : 'contas'}`;
  }

  function contarFolhas(no) {
    return no.filhos.length ? no.filhos.reduce((s, f) => s + contarFolhas(f), 0) : 1;
  }

  function renderMatriz() {
    const linhas = filtrarLinhas(dados.linhas);
    const arvore = montarArvore(linhas, niveis());
    const buscando = state.busca.trim() !== '';
    const html = [];
    const percorrer = (nos, nivel) => {
      for (const no of nos) {
        html.push(linhaHtml(no, nivel, buscando));
        if (no.filhos.length && (buscando || expandidos.has(no.chave))) percorrer(no.filhos, nivel + 1);
      }
    };
    percorrer(arvore, 0);

    if (!html.length) {
      const msg = dados.linhas.length ? 'Nenhuma conta encontrada para essa busca.' : 'Nenhuma conta paga nos dois períodos.';
      els.matrizBody.innerHTML = `<tr class="matriz-vazia"><td colspan="5">${msg}</td></tr>`;
    } else {
      els.matrizBody.innerHTML = html.join('');
    }

    const anterior = linhas.reduce((s, l) => s + l.anterior, 0);
    const atual = linhas.reduce((s, l) => s + l.atual, 0);
    const d = diferenca(anterior, atual);
    els.matrizFoot.innerHTML = `<tr>
      <th scope="row" class="col-nome">${buscando ? 'Total da busca' : 'Total pago'}</th>
      <td class="col-num">${fmt.currencyCents(anterior)}</td>
      <td class="col-num">${fmt.currencyCents(atual)}</td>
      <td class="col-num dif-${d.dir}">${textoValorDif(d)}</td>
      <td class="col-num dif-${d.dir}">${textoPctDif(d, atual)}</td>
    </tr>`;

    els.matrizBody.querySelectorAll('.matriz-toggle').forEach((btn) => {
      btn.onclick = () => {
        if (buscando) return; // durante a busca tudo fica aberto
        const chave = btn.dataset.chave;
        if (expandidos.has(chave)) expandidos.delete(chave); else expandidos.add(chave);
        renderMatriz();
      };
    });
  }

  // ---------------- tema (menu lateral fica em layout.js) ----------------
  function initTheme() {
    const appEl = document.querySelector('.app');
    let saved = null;
    try { saved = localStorage.getItem('painel.theme'); } catch (e) { /* ignora */ }
    const preferDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = PDF.modoArquivo() ? 'light' : (saved || (preferDark ? 'dark' : 'light')); // PDF sempre claro
    appEl.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    qs('theme-toggle').addEventListener('click', () => {
      const next = appEl.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      appEl.setAttribute('data-theme', next);
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('painel.theme', next); } catch (e) { /* ignora */ }
    });
  }

  function initControles() {
    // 1º clique: texto em ordem alfabética, valores do maior para o menor; clicar de novo inverte
    document.querySelectorAll('.matriz-sort').forEach((btn) => {
      btn.onclick = () => {
        const coluna = btn.dataset.col;
        state.ordem = state.ordem.coluna === coluna
          ? { coluna, direcao: state.ordem.direcao === 'asc' ? 'desc' : 'asc' }
          : { coluna, direcao: coluna === 'nome' ? 'asc' : 'desc' };
        persist();
        renderOrdem();
        if (dados) renderMatriz();
      };
    });
    renderOrdem();
    els.refreshBtn.onclick = atualizar;
    els.togglePlano.checked = state.comPlano;
    els.togglePlano.onchange = () => {
      state.comPlano = els.togglePlano.checked;
      persist();
      if (!dados) return;
      expandidos = expansaoPadrao();
      renderCabecalho();
      renderMatriz();
    };
    els.matrizBusca.oninput = () => {
      state.busca = els.matrizBusca.value;
      if (dados) renderMatriz();
    };
    els.btnExpandir.onclick = () => {
      if (!dados) return;
      expandidos = todasChaves(montarArvore(dados.linhas, niveis()));
      renderMatriz();
    };
    qs('btn-excel').onclick = exportarExcel;
    qs('btn-pdf-tabela').onclick = (e) => exportarPDF(e.currentTarget);

    els.btnRecolher.onclick = () => {
      if (!dados) return;
      expandidos = new Set();
      renderMatriz();
    };
  }

  // ---------------- init ----------------
  async function init() {
    cacheEls();
    initTheme();

    if (location.protocol === 'file:') {
      showStatus('error', 'Abra o painel pelo endereço do servidor', MSG_SEM_SERVIDOR);
      return;
    }

    showStatus('loading', 'Conectando ao servidor do painel…', 'Carregando a lista de unidades.');
    try {
      const res = await fetch(CONFIG.unidadesUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      unidadesIndex = await res.json();
      if (!unidadesIndex.length) throw new Error('Nenhuma loja habilitada (LOJAS no .env do servidor).');
    } catch (e) {
      showStatus('error', 'Servidor do painel indisponível', MSG_SEM_SERVIDOR, () => location.reload());
      return;
    }

    state.slug = unidadesIndex[0].slug;
    restore();
    const params = new URLSearchParams(location.search);
    if (PDF.modoArquivo()) {
      // página aberta pelo servidor para virar PDF: mesma unidade, período, plano, busca e ordem da tela
      PDF.prepararModoArquivo();
      if (unidade(params.get('slug'))) state.slug = params.get('slug');
      if (Number(params.get('ano'))) state.ano = Number(params.get('ano'));
      if (Number(params.get('mes'))) state.mes = Number(params.get('mes'));
      if (params.get('plano')) state.comPlano = params.get('plano') === '1';
      const [coluna, direcao] = (params.get('ordem') || '').split(':');
      if (COLUNAS_ORDEM[coluna] && ['asc', 'desc'].includes(direcao)) state.ordem = { coluna, direcao };
      state.busca = params.get('busca') || '';
      els.matrizBusca.value = state.busca;
    }
    initControles();
    renderUnidadeSelect();
    await carregar();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', ContaContabil.init);
