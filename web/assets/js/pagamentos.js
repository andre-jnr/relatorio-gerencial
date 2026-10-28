// ============================================================
// Página "Pagamentos": lista das contas pagas no mês (uma linha por
// pagamento de Contas_Pagar), com busca por fornecedor, conta contábil
// ou observação e ordenação por qualquer coluna.
// ============================================================

const Pagamentos = (() => {
  const MSG_SEM_SERVIDOR = 'Não foi possível falar com o servidor do painel. Confira se ele está no ar e tente de novo.';
  const ANOS_DISPONIVEIS = 3;
  const POR_PAGINA = 300; // linhas desenhadas por vez ("Mostrar mais" desenha as próximas)

  const hoje = new Date();
  const state = {
    slug: null,
    ano: hoje.getFullYear(),
    mes: hoje.getMonth() + 1,
    busca: '',
    ordem: { coluna: 'pagamento', direcao: 'desc' },
    limite: POR_PAGINA,
  };

  // ?restos=boi&slug=cd&ano=2026: só o FORNECEDOR DE BOI emitido em ano anterior e pago no ano
  const paramsUrl = new URLSearchParams(location.search);
  const modoRestos = paramsUrl.get('restos') === 'boi';
  // ?visao=desconsiderados&slug=cd&ano=&mes=: só o que os relatórios ignoram (ex.: FALCAO INDUSTRIA NF)
  const modoDesconsiderados = paramsUrl.get('visao') === 'desconsiderados';
  const modoEspecial = modoRestos || modoDesconsiderados;
  if (modoEspecial && Number(paramsUrl.get('ano'))) state.ano = Number(paramsUrl.get('ano'));
  if (modoDesconsiderados && paramsUrl.get('mes')) state.mes = paramsUrl.get('mes') === 'all' ? 'all' : (Number(paramsUrl.get('mes')) || state.mes);

  let unidadesIndex = [];
  let dados = null;
  let requisicao = 0;
  const cache = {};
  const els = {};

  // como cada coluna é comparada; texto em ordem alfabética, datas e valores pelo valor
  const COLUNAS = {
    codigo: { tipo: 'num' },
    fornecedor: { tipo: 'txt', valor: (l) => nomeFornecedor(l) },
    conta: { tipo: 'txt' },
    emissao: { tipo: 'data' },
    pagamento: { tipo: 'data' },
    vencimento: { tipo: 'data' },
    valor_pago: { tipo: 'num' },
    observacao: { tipo: 'txt' },
    origem: { tipo: 'txt' },
  };

  function qs(id) { return document.getElementById(id); }

  function cacheEls() {
    [
      'filter-unidade', 'filter-ano', 'filter-mes', 'filter-conexao', 'filter-atualizado', 'refresh-btn',
      'status-panel', 'status-icon', 'status-title', 'status-msg', 'status-retry', 'pagamentos-body',
      'subheading', 'pag-resumo', 'lista-sub', 'lista-busca', 'lista-contagem', 'lista-body', 'lista-foot',
      'lista-mais', 'btn-mais', 'footer-updated',
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

  function dataBR(iso) {
    if (!iso) return '—';
    const [a, m, d] = iso.split('-');
    return `${d}/${m}/${a}`;
  }

  // texto pesquisável: fornecedor, conta, observação, código e o valor pago em vários formatos
  // (R$ 720.036,00 · 720036,00 · 720036.00), para achar do jeito que for digitado
  function textoBusca(l) {
    const v = Number(l.valor_pago) || 0;
    const br = v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const valores = [`R$ ${br}`, br.replace(/\./g, ''), v.toFixed(2)];
    return normaliza([nomeFornecedor(l), l.conta, l.observacao, l.codigo ?? '', ...valores].join(' '));
  }

  function nomeFornecedor(l) {
    if (l.fornecedor) return l.fornecedor;
    return l.codigo_fornecedor != null ? `Fornecedor ${l.codigo_fornecedor}` : '';
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
        if (state.ano === anoAtual && state.mes !== 'all') state.mes = Math.min(state.mes, hoje.getMonth() + 1);
        carregar();
      };
    });
  }

  function renderMesFilter() {
    const limite = state.ano === hoje.getFullYear() ? hoje.getMonth() + 1 : 12;
    // lançamentos desconsiderados: dá para ver o ano todo de uma vez
    const btnAno = modoDesconsiderados ? `<button type="button" data-m="all" class="${state.mes === 'all' ? 'is-active' : ''}">Ano inteiro</button>` : '';
    els.filterMes.innerHTML = btnAno + Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
      const ok = m <= limite;
      return `<button type="button" data-m="${m}" class="${m === state.mes ? 'is-active' : ''}" ${ok ? '' : 'disabled style="opacity:.32;cursor:not-allowed"'}>${fmt.monthName(m)}</button>`;
    }).join('');
    [...els.filterMes.children].forEach((btn) => {
      if (btn.disabled) return;
      btn.onclick = () => {
        state.mes = btn.dataset.m === 'all' ? 'all' : Number(btn.dataset.m);
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

  // unidade compartilhada com as outras páginas; ordenação lembrada entre visitas
  function persist() {
    try {
      const raw = localStorage.getItem('painel.state');
      const salvo = raw ? JSON.parse(raw) : {};
      localStorage.setItem('painel.state', JSON.stringify({ ...salvo, slug: state.slug }));
      localStorage.setItem('painel.pagamentos.ordem', JSON.stringify(state.ordem));
    } catch (e) { /* ignora ambientes sem storage */ }
  }

  function restore() {
    try {
      const raw = localStorage.getItem('painel.state');
      const salvo = raw ? JSON.parse(raw) : null;
      if (salvo && unidade(salvo.slug)) state.slug = salvo.slug;
      const ordem = JSON.parse(localStorage.getItem('painel.pagamentos.ordem') || 'null');
      if (ordem && COLUNAS[ordem.coluna] && ['asc', 'desc'].includes(ordem.direcao)) state.ordem = ordem;
    } catch (e) { /* ignora */ }
  }

  // ---------------- carregamento ----------------
  async function carregar(atualizar = false) {
    const id = ++requisicao;
    const chave = `${state.slug}|${state.ano}|${modoRestos ? 'restos' : state.mes}|${modoDesconsiderados ? 'desc' : ''}`;
    const u = unidade(state.slug);
    dados = null;
    renderFilters();

    if (atualizar || !cache[chave]) {
      els.subheading.textContent = `Consultando ${u.nome}…`;
      showStatus('loading', `Consultando os pagamentos de ${u.nome}…`,
        `contas pagas em ${state.mes === 'all' || modoRestos ? '' : `${fmt.monthName(state.mes)}/`}${state.ano}.`);
      try {
        const url = modoRestos
          ? CONFIG.pagamentosUrl(state.slug, state.ano, 0) + '&restos_boi=1'
          : modoDesconsiderados
            ? CONFIG.pagamentosUrl(state.slug, state.ano, state.mes === 'all' ? 0 : state.mes) + '&desconsiderados=1'
            : CONFIG.pagamentosUrl(state.slug, state.ano, state.mes);
        const res = await fetch(url + (atualizar ? '&atualizar=1' : ''), { cache: 'no-store' });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || body.erro) throw new Error((body && body.erro) || `HTTP ${res.status}`);
        body.linhas = Array.isArray(body.linhas) ? body.linhas : [];
        // texto pronto para a busca (sem acento, maiúsculo)
        body.linhas.forEach((l) => { l._busca = textoBusca(l); });
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
    state.limite = PDF.modoArquivo() ? Infinity : POR_PAGINA;
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

  // ---------------- busca e ordenação ----------------
  function linhasVisiveis() {
    const termos = normaliza(state.busca).split(/\s+/).filter(Boolean);
    const filtradas = termos.length
      ? dados.linhas.filter((l) => termos.every((t) => l._busca.includes(t)))
      : dados.linhas.slice();
    const { coluna, direcao } = state.ordem;
    const def = COLUNAS[coluna];
    const valor = def.valor || ((l) => l[coluna]);
    const sinal = direcao === 'asc' ? 1 : -1;
    return filtradas.sort((a, b) => {
      const va = valor(a);
      const vb = valor(b);
      // vazios sempre no fim, qualquer que seja a direção
      const vaVazio = va == null || va === '';
      const vbVazio = vb == null || vb === '';
      if (vaVazio || vbVazio) return vaVazio === vbVazio ? 0 : vaVazio ? 1 : -1;
      const cmp = def.tipo === 'txt'
        ? String(va).localeCompare(String(vb), 'pt-BR', { sensitivity: 'base' })
        : (va < vb ? -1 : va > vb ? 1 : 0);
      return sinal * cmp || (b.codigo || 0) - (a.codigo || 0);
    });
  }

  function renderOrdem() {
    document.querySelectorAll('#lista thead th[data-col]').forEach((th) => {
      const ativa = th.dataset.col === state.ordem.coluna;
      th.setAttribute('aria-sort', ativa ? (state.ordem.direcao === 'asc' ? 'ascending' : 'descending') : 'none');
    });
  }

  // ---------------- render ----------------
  function render() {
    renderCabecalho();
    // no PDF (e na tela) o subtítulo deixa claro quando a lista está filtrada por busca
    if (state.busca.trim()) els.listaSub.textContent += ` · busca: "${state.busca.trim()}"`;
    renderLista();
  }

  function renderCabecalho() {
    const u = unidade(state.slug);
    const mes = `${fmt.monthName(dados.mes)}/${dados.ano}`;
    const periodo = `${dataBR(dados.periodo.ini)} a ${dataBR(dados.periodo.fim)}`;
    if (modoRestos) {
      const total = dados.linhas.reduce((s, l) => s + l.valor_pago, 0);
      els.subheading.textContent = `${dados.conta_boi} da unidade ${u.nome} emitido antes de ${dados.ano} e pago em ${dados.ano}.`;
      els.listaSub.textContent = `Pagos de ${periodo}, com emissão anterior a ${dados.ano}, um por linha`;
      qs('restos-texto').innerHTML = `<strong>${fmt.currencyCents(total)}</strong> em ${fmt.int(dados.linhas.length)} pagamento(s) de ${dados.conta_boi} lançados antes de ${dados.ano} e pagos em ${dados.ano} (${periodo}).`;
      return;
    }
    if (modoDesconsiderados) {
      const total = dados.linhas.reduce((s, l) => s + l.valor_pago, 0);
      const quando = dados.mes ? mes : `${dados.ano}`;
      els.subheading.textContent = `Lançamentos da unidade ${u.nome} que ficam fora de todos os relatórios — ${quando}.`;
      els.listaSub.textContent = `Pagos de ${periodo}, um por linha · a coluna Motivo diz por que não entram nos relatórios`;
      qs('restos-texto').innerHTML = `<strong>${fmt.currencyCents(total)}</strong> em ${fmt.int(dados.linhas.length)} lançamento(s) desconsiderado(s) em ${quando} (${periodo}). Só para conferência: não entram nos relatórios.`;
      return;
    }
    els.subheading.textContent = dados.mes_fechado
      ? `Contas pagas da unidade ${u.nome} em ${mes}.`
      : `Contas pagas da unidade ${u.nome} em ${mes} (mês em andamento, até hoje).`;
    els.listaSub.textContent = `Pagamentos de ${periodo}, um por linha`;
  }

  function kpi(label, valor, delay) {
    const div = document.createElement('div');
    div.className = 'kpi-mini';
    div.style.animationDelay = `${delay}ms`;
    div.innerHTML = `<span class="kpi-mini-label">${label}</span><div class="kpi-mini-row"><span class="kpi-mini-value">${valor}</span></div>`;
    els.pagResumo.appendChild(div);
  }

  // resumo acompanha a busca
  function renderResumo(linhas, buscando) {
    els.pagResumo.innerHTML = '';
    const total = linhas.reduce((s, l) => s + l.valor_pago, 0);
    const fornecedores = new Set(linhas.map((l) => nomeFornecedor(l)).filter(Boolean)).size;
    const contas = new Set(linhas.map((l) => l.conta).filter(Boolean)).size;
    const sufixo = buscando ? ' (busca)' : '';
    kpi(`Total pago${sufixo}`, fmt.currencyCompact(total), 0);
    kpi(`Pagamentos${sufixo}`, fmt.int(linhas.length), 40);
    kpi(`Fornecedores${sufixo}`, fmt.int(fornecedores), 80);
    kpi(`Contas contábeis${sufixo}`, fmt.int(contas), 120);
  }

  function linhaHtml(l) {
    const forn = nomeFornecedor(l);
    const obs = l.observacao || '';
    return `<tr>
      <td class="col-num col-codigo">${l.codigo ?? '—'}</td>
      <td class="col-txt">${forn ? escapeHtml(forn) : '<span class="lista-vazio">—</span>'}</td>
      <td class="col-txt">${l.conta ? escapeHtml(l.conta) : '<span class="lista-vazio">sem conta contábil</span>'}</td>
      <td class="col-data">${dataBR(l.emissao)}</td>
      <td class="col-data">${dataBR(l.pagamento)}</td>
      <td class="col-data">${dataBR(l.vencimento)}</td>
      <td class="col-num">${fmt.currencyCents(l.valor_pago)}</td>
      <td class="col-txt col-obs">${obs
        ? `<button type="button" class="obs-btn" aria-expanded="false" title="Clique para ver a observação inteira">${escapeHtml(obs)}</button>`
        : '<span class="lista-vazio">—</span>'}</td>
      <td class="col-txt col-origem">${escapeHtml(l.origem || '')}</td>
    </tr>`;
  }

  function renderLista() {
    const buscando = state.busca.trim() !== '';
    const linhas = linhasVisiveis();
    renderResumo(linhas, buscando);

    const mostrar = linhas.slice(0, state.limite);
    els.listaBody.innerHTML = mostrar.length
      ? mostrar.map(linhaHtml).join('')
      : `<tr class="matriz-vazia"><td colspan="9">${dados.linhas.length ? 'Nenhum pagamento encontrado para essa busca.' : 'Nenhuma conta paga no período.'}</td></tr>`;

    const total = linhas.reduce((s, l) => s + l.valor_pago, 0);
    els.listaFoot.innerHTML = `<tr>
      <th scope="row" colspan="6" class="col-nome">${buscando ? 'Total da busca' : 'Total pago'} · ${fmt.int(linhas.length)} pagamento(s)</th>
      <td class="col-num">${fmt.currencyCents(total)}</td>
      <td colspan="2"></td>
    </tr>`;

    const restantes = linhas.length - mostrar.length;
    els.listaMais.hidden = restantes <= 0;
    els.btnMais.textContent = `Mostrar mais ${fmt.int(Math.min(POR_PAGINA, restantes))} (faltam ${fmt.int(restantes)})`;
    els.listaContagem.textContent = linhas.length > mostrar.length
      ? `Exibindo ${fmt.int(mostrar.length)} de ${fmt.int(linhas.length)} pagamentos`
      : `${fmt.int(linhas.length)} pagamento(s)`;

  }

  // ---------------- exportar (Excel / PDF) ----------------
  // nome e título conforme o modo e o período da tela
  function tituloExportacao() {
    const u = unidade(state.slug);
    const periodo = modoRestos || state.mes === 'all' ? `${state.ano}` : `${fmt.monthName(state.mes)}-${state.ano}`;
    if (modoRestos) return `Exercícios anteriores - ${dados.conta_boi || 'boi'} - ${u.nome} - ${state.ano}`;
    if (modoDesconsiderados) return `Lançamentos desconsiderados - ${u.nome} - ${periodo}`;
    return `Pagamentos - ${u.nome} - ${periodo}`;
  }

  function exportarExcel() {
    if (!dados) return;
    const linhas = linhasVisiveis();
    const busca = state.busca.trim();
    Exportar.excel({
      nome: tituloExportacao(),
      titulo: tituloExportacao().replace(/ - /g, ' · '),
      subtitulo: `Período: ${dataBR(dados.periodo.ini)} a ${dataBR(dados.periodo.fim)}${busca ? ` · busca: "${busca}"` : ''} · ${linhas.length} pagamento(s)`,
      colunas: [
        { titulo: 'Código', tipo: 'numero', largura: 10 },
        { titulo: 'Fornecedor', tipo: 'texto', largura: 36 },
        { titulo: 'Conta contábil', tipo: 'texto', largura: 30 },
        { titulo: 'Data emissão', tipo: 'data', largura: 13 },
        { titulo: 'Data pagamento', tipo: 'data', largura: 13 },
        { titulo: 'Data vencimento', tipo: 'data', largura: 13 },
        { titulo: 'Valor pago', tipo: 'moeda', largura: 15 },
        { titulo: 'Observação', tipo: 'texto', largura: 60 },
        { titulo: modoDesconsiderados ? 'Motivo' : 'Origem', tipo: 'texto', largura: 28 },
      ],
      linhas: linhas.map((l) => [l.codigo, nomeFornecedor(l), l.conta, l.emissao, l.pagamento, l.vencimento, l.valor_pago, l.observacao, l.origem]),
      total: ['Total', '', '', '', '', '', linhas.reduce((s, l) => s + l.valor_pago, 0), '', ''],
    });
  }

  function exportarPDF(botao) {
    if (!dados) return;
    const params = { slug: state.slug, ano: state.ano, mes: state.mes, ordem: `${state.ordem.coluna}:${state.ordem.direcao}` };
    if (state.busca.trim()) params.busca = state.busca.trim();
    if (modoRestos) params.restos = 'boi';
    if (modoDesconsiderados) params.visao = 'desconsiderados';
    Exportar.pdf({ pagina: 'pagamentos.html', params, nome: tituloExportacao(), botao });
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
    els.refreshBtn.onclick = atualizar;

    let espera = null;
    els.listaBusca.oninput = () => {
      clearTimeout(espera);
      espera = setTimeout(() => {
        state.busca = els.listaBusca.value;
        state.limite = POR_PAGINA;
        if (dados) renderLista();
      }, 150);
    };

    // observação longa fica cortada; clicar abre o texto inteiro (clicar de novo fecha)
    els.listaBody.addEventListener('click', (e) => {
      const btn = e.target.closest('.obs-btn');
      if (!btn) return;
      const aberta = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(aberta));
      btn.title = aberta ? 'Clique para recolher' : 'Clique para ver a observação inteira';
    });

    qs('btn-excel').onclick = exportarExcel;
    qs('btn-pdf-tabela').onclick = (e) => exportarPDF(e.currentTarget);

    els.btnMais.onclick = () => {
      state.limite += POR_PAGINA;
      renderLista();
    };

    // 1º clique: texto A→Z, datas e valores do maior para o menor; clicar de novo inverte
    document.querySelectorAll('#lista .matriz-sort').forEach((btn) => {
      btn.onclick = () => {
        const coluna = btn.dataset.col;
        state.ordem = state.ordem.coluna === coluna
          ? { coluna, direcao: state.ordem.direcao === 'asc' ? 'desc' : 'asc' }
          : { coluna, direcao: COLUNAS[coluna].tipo === 'txt' ? 'asc' : 'desc' };
        persist();
        renderOrdem();
        if (dados) renderLista();
      };
    });
    renderOrdem();
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
    if (PDF.modoArquivo()) {
      // página aberta pelo servidor para virar PDF: mesmos filtros da tela e todas as linhas
      PDF.prepararModoArquivo();
      if (unidade(paramsUrl.get('slug'))) state.slug = paramsUrl.get('slug');
      if (Number(paramsUrl.get('ano'))) state.ano = Number(paramsUrl.get('ano'));
      const mes = paramsUrl.get('mes');
      if (mes) state.mes = mes === 'all' ? 'all' : (Number(mes) || state.mes);
      const [coluna, direcao] = (paramsUrl.get('ordem') || '').split(':');
      if (COLUNAS[coluna] && ['asc', 'desc'].includes(direcao)) state.ordem = { coluna, direcao };
      state.busca = paramsUrl.get('busca') || '';
      els.listaBusca.value = state.busca;
      state.limite = Infinity;
    }
    if (modoRestos) {
      // fica na unidade do relatório (o CD) e sem o filtro de mês: o período é o ano
      if (unidade(paramsUrl.get('slug'))) state.slug = paramsUrl.get('slug');
      els.filterUnidade.disabled = true;
      els.filterMes.closest('.filter-field').hidden = true;
      qs('restos-faixa').hidden = false;
      document.querySelector('.topbar-heading h1').innerHTML = 'Exercícios <em>anteriores</em>';
    }
    if (modoDesconsiderados) {
      if (unidade(paramsUrl.get('slug'))) state.slug = paramsUrl.get('slug');
      els.filterUnidade.disabled = true;
      qs('restos-faixa').hidden = false;
      qs('restos-faixa').querySelector('.kpi-label').textContent = 'Lançamentos desconsiderados dos relatórios';
      document.querySelector('.topbar-heading h1').innerHTML = 'Lançamentos <em>desconsiderados</em>';
      const thOrigem = document.querySelector('#lista thead th[data-col="origem"] .matriz-sort span');
      if (thOrigem) thOrigem.textContent = 'Motivo';
    }
    initControles();
    renderUnidadeSelect();
    await carregar();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Pagamentos.init);
