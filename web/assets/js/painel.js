// ============================================================
// Visão geral: carrega só a loja escolhida, aplica os filtros
// (loja / ano / mês) e desenha cartões e gráficos numa página.
// ============================================================
const Painel = (() => {
  const MSG_SEM_SERVIDOR = 'Não foi possível falar com o servidor do painel. Confira se ele está no ar e tente de novo.';
  const state = { slug: null, ano: null, mes: null }; // mes: 1-12 ou 'all'
  let lojas = [];
  const datasets = {};
  const erros = {};
  const pendentes = {};
  const qs = (id) => document.getElementById(id);

  // ---------------- armazenamento local (só conveniências) ----------------
  function ler(chave, padrao = null) {
    try { const v = localStorage.getItem(chave); return v === null ? padrao : v; } catch (e) { return padrao; }
  }
  function gravar(chave, valor) {
    try { localStorage.setItem(chave, valor); } catch (e) { /* sem storage */ }
  }

  // ---------------- carregamento ----------------
  function loja(slug) { return lojas.find((u) => u.slug === slug); }

  function carregar(slug, atualizar = false) {
    if (pendentes[slug]) return pendentes[slug];
    if (!atualizar && datasets[slug]) return Promise.resolve(datasets[slug]);
    pendentes[slug] = (async () => {
      try {
        const res = await fetch(CONFIG.dadosUrl(slug) + (atualizar ? '?atualizar=1' : ''), { cache: 'no-store' });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || body.erro) throw new Error((body && body.erro) || `HTTP ${res.status}`);
        if (!Array.isArray(body.meses) || !body.meses.length) throw new Error('O banco não retornou nenhum movimento no período consultado.');
        datasets[slug] = body;
        delete erros[slug];
      } catch (e) {
        delete datasets[slug];
        erros[slug] = e instanceof TypeError ? MSG_SEM_SERVIDOR : e.message;
      } finally {
        delete pendentes[slug];
      }
      return datasets[slug] || null;
    })();
    return pendentes[slug];
  }

  const ICON_ALERT = '<svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17h.01"/></svg>';

  function status(tipo, titulo, msg, tentar) {
    qs('status-panel').hidden = false;
    qs('status-panel').classList.toggle('is-error', tipo === 'error');
    qs('status-icon').innerHTML = tipo === 'error' ? ICON_ALERT : '<span class="spinner"></span>';
    qs('status-title').textContent = titulo;
    qs('status-msg').textContent = msg;
    qs('status-retry').hidden = !tentar;
    qs('status-retry').onclick = tentar || null;
    qs('dashboard').hidden = true;
  }
  function esconderStatus() {
    qs('status-panel').hidden = true;
    qs('dashboard').hidden = false;
  }

  // ---------------- períodos ----------------
  const ordenados = (data) => [...data.meses].sort((a, b) => a.ano - b.ano || a.mes - b.mes);
  const anos = (data) => [...new Set(data.meses.map((m) => m.ano))].sort((a, b) => b - a);
  const mesesDoAno = (data, ano) => ordenados(data).filter((m) => m.ano === ano);
  const hoje = new Date();
  const ehMesAtual = (ano, mes) => ano === hoje.getFullYear() && mes === hoje.getMonth() + 1;

  function agregar(lista, label) {
    if (!lista.length) return null;
    const agg = {
      ano: lista[0].ano, mes: null, label,
      total_vendas: 0, qtde_vendas: 0, total_transferencias: 0, faturamento_total: 0, pagamentos: 0, pagamentos_proximo_mes: 0,
      pagamentos_origem: { transferencia: 0, mesmo_mes: 0, meses_anteriores: 0, fornecedor_cd: 0 },
      vendas_por_fonte: [], distribuicao: { produtos_revenda: 0, despesas_operacionais: 0, lucro: 0 },
      grupos: [], contas_sem_classificacao: [], estoque: null, estoque_label: null,
    };
    const grupos = new Map();
    const semClasse = new Map();
    for (const m of lista) {
      for (const k of ['total_vendas', 'qtde_vendas', 'total_transferencias', 'faturamento_total', 'pagamentos', 'pagamentos_proximo_mes']) agg[k] += m[k];
      for (const k of Object.keys(agg.pagamentos_origem)) agg.pagamentos_origem[k] += m.pagamentos_origem[k] || 0;
      for (const k of Object.keys(agg.distribuicao)) agg.distribuicao[k] += m.distribuicao[k];
      for (const f of m.vendas_por_fonte || []) {
        const atual = agg.vendas_por_fonte.find((x) => x.nome === f.nome);
        if (atual) atual.valor += f.valor; else agg.vendas_por_fonte.push({ ...f });
      }
      for (const g of m.grupos) grupos.set(g.grupo, (grupos.get(g.grupo) || 0) + g.valor);
      for (const c of m.contas_sem_classificacao || []) semClasse.set(c.conta, (semClasse.get(c.conta) || 0) + c.valor);
      if (m.estoque != null) { agg.estoque = m.estoque; agg.estoque_label = m.label; } // posição, não soma
    }
    agg.grupos = [...grupos].map(([grupo, valor]) => ({ grupo, valor }));
    agg.contas_sem_classificacao = [...semClasse].map(([conta, valor]) => ({ conta, valor })).sort((a, b) => b.valor - a.valor);
    return agg;
  }

  function registro(data, ano, mes) {
    if (mes === 'all') return agregar(mesesDoAno(data, ano), `Ano ${ano}`);
    return ordenados(data).find((m) => m.ano === ano && m.mes === mes) || null;
  }

  // ano inteiro: compara com os mesmos meses do ano anterior
  function registroAnterior(data, ano, mes) {
    if (mes === 'all') {
      const atuais = mesesDoAno(data, ano).map((m) => m.mes);
      const ant = mesesDoAno(data, ano - 1).filter((m) => atuais.includes(m.mes));
      return ant.length ? agregar(ant, `Ano ${ano - 1}`) : null;
    }
    const todos = ordenados(data);
    const i = todos.findIndex((m) => m.ano === ano && m.mes === mes);
    return i > 0 ? todos[i - 1] : null;
  }

  function janelaDesempenho(data) {
    const todos = ordenados(data);
    if (state.mes === 'all' || anoAtualApenas()) {
      return { meses: mesesDoAno(data, state.ano), titulo: `Desempenho da loja · ${state.ano}`, rotulo: `Lucratividade ${state.ano}` };
    }
    const i = todos.findIndex((m) => m.ano === state.ano && m.mes === state.mes);
    const fim = i === -1 ? todos.length : i + 1;
    return { meses: todos.slice(Math.max(0, fim - 12), fim), titulo: 'Desempenho da loja · últimos 12 meses', rotulo: 'Lucratividade 12 meses' };
  }

  function derivar(r) {
    const resultado = r.faturamento_total - r.pagamentos;
    const est = r.estoque ?? null;
    return {
      ...r,
      resultado,
      margem: r.faturamento_total ? (resultado / r.faturamento_total) * 100 : 0,
      margem_estoque: est !== null && r.faturamento_total ? ((resultado + est) / r.faturamento_total) * 100 : null,
      ticket: r.qtde_vendas ? r.total_vendas / r.qtde_vendas : 0,
    };
  }

  function padrao(data) {
    // abre no último mês FECHADO (o corrente ainda está em andamento)
    const atual = hoje.getFullYear() * 12 + hoje.getMonth();
    const todos = ordenados(data);
    const fechados = todos.filter((m) => m.ano * 12 + (m.mes - 1) < atual);
    const alvo = (fechados.length ? fechados : todos).at(-1);
    state.ano = alvo.ano;
    state.mes = alvo.mes;
  }

  function garantirPeriodo(data) {
    if (!anos(data).includes(state.ano)) return padrao(data);
    if (state.mes !== 'all' && !mesesDoAno(data, state.ano).some((m) => m.mes === state.mes)) padrao(data);
  }

  // ---------------- CD: regra do FORNECEDOR DE BOI ----------------
  let boiPDF = null;
  const boiIncluido = () => (boiPDF !== null ? boiPDF : ler('painel.cd.boi') === '1');
  const ehCD = () => Boolean(datasets[state.slug] && datasets[state.slug].layout_cd);
  const opcaoBoi = () => {
    const d = datasets[state.slug];
    return Boolean(d && d.layout_cd && d.conta_boi && state.mes === 'all' && state.ano === hoje.getFullYear());
  };
  const regraBoi = () => opcaoBoi() && !boiIncluido();

  function semBoi(m) {
    const b = m.boi_ano_anterior;
    if (!b || !b.total) return m;
    return {
      ...m,
      pagamentos: m.pagamentos - b.total,
      pagamentos_origem: {
        ...m.pagamentos_origem,
        transferencia: m.pagamentos_origem.transferencia - b.transferencia,
        mesmo_mes: m.pagamentos_origem.mesmo_mes - b.mesmo_mes,
        meses_anteriores: m.pagamentos_origem.meses_anteriores - b.meses_anteriores,
      },
      distribuicao: {
        produtos_revenda: m.distribuicao.produtos_revenda - b.revenda,
        despesas_operacionais: m.distribuicao.despesas_operacionais - (b.total - b.revenda),
        lucro: m.distribuicao.lucro + b.total,
      },
    };
  }

  function dadosRelatorio() {
    const d = datasets[state.slug];
    return regraBoi() ? { ...d, meses: d.meses.map(semBoi) } : d;
  }

  // ---------------- filtros ----------------
  function renderLojas() {
    const sel = qs('filter-unidade');
    sel.innerHTML = lojas.map((u) => `<option value="${escapeHtml(u.slug)}">${escapeHtml(u.nome)}${erros[u.slug] ? ' (indisponível)' : ''}</option>`).join('');
    sel.value = state.slug;
    sel.onchange = () => mostrar(sel.value);
    qs('filtro-loja').hidden = lojas.length < 2;
  }

  function renderFiltros() {
    const data = datasets[state.slug];
    if (!data) {
      qs('filter-ano').innerHTML = '';
      qs('filter-mes').innerHTML = '';
      return;
    }
    qs('filter-ano').innerHTML = anos(data).map((a) => `<button type="button" data-a="${a}" class="${a === state.ano ? 'is-active' : ''}">${a}</button>`).join('');
    qs('filter-ano').querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        state.ano = Number(b.dataset.a);
        const ms = mesesDoAno(data, state.ano);
        state.mes = ms.length ? ms.at(-1).mes : 'all';
        atualizarTela();
      };
    });
    const disp = new Set(mesesDoAno(data, state.ano).map((m) => m.mes));
    qs('filter-mes').innerHTML = `<button type="button" data-m="all" class="${state.mes === 'all' ? 'is-active' : ''}" title="Ano inteiro">Ano</button>` +
      Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
        const cls = [state.mes === m ? 'is-active' : '', ehMesAtual(state.ano, m) ? 'is-andamento' : ''].join(' ').trim();
        return `<button type="button" data-m="${m}" class="${cls}" ${disp.has(m) ? '' : 'disabled'} ${ehMesAtual(state.ano, m) ? 'title="Mês em andamento"' : ''}>${fmt.monthName(m)}</button>`;
      }).join('');
    qs('filter-mes').querySelectorAll('button:not(:disabled)').forEach((b) => {
      b.onclick = () => { state.mes = b.dataset.m === 'all' ? 'all' : Number(b.dataset.m); atualizarTela(); };
    });
    const dt = new Date(data.atualizado_em);
    qs('refresh-btn').title = `Consultado às ${dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}. Clique para consultar o banco de novo.`;

    // CD: considerar o boi de anos anteriores (só no ano inteiro em andamento)
    qs('opcao-boi').hidden = !opcaoBoi();
    qs('toggle-boi').checked = boiIncluido();
  }

  function atualizarTela() {
    renderFiltros();
    renderTudo();
  }

  async function mostrar(slug, atualizar = false) {
    state.slug = slug;
    gravar('painel.loja', slug);
    qs('filter-unidade').value = slug;
    const u = loja(slug);
    if (atualizar || !datasets[slug]) {
      qs('titulo-loja').textContent = u.nome;
      qs('head-sub').textContent = 'Consultando o banco de dados…';
      status('loading', `Consultando ${u.nome}…`, 'Buscando vendas, transferências e contas pagas direto no banco.');
      renderFiltros();
      await carregar(slug, atualizar);
      renderLojas();
      if (state.slug !== slug) return; // trocou de loja enquanto carregava
    }
    const data = datasets[slug];
    if (!data) {
      qs('head-sub').textContent = 'Sem dados.';
      status('error', `Não foi possível carregar ${u.nome}`, erros[slug] || 'Erro desconhecido.', () => mostrar(slug, true));
      renderFiltros();
      return;
    }
    garantirPeriodo(data);
    esconderStatus();
    atualizarTela();
  }

  // ---------------- cabeçalho ----------------
  function renderCabecalho(data) {
    qs('titulo-loja').textContent = data.unidade;
    const periodo = state.mes === 'all'
      ? `Ano de ${state.ano}${state.ano === hoje.getFullYear() ? ' (até hoje)' : ''}`
      : `${fmt.monthLong(state.mes)[0].toUpperCase()}${fmt.monthLong(state.mes).slice(1)} de ${state.ano}${ehMesAtual(state.ano, state.mes) ? ' · mês em andamento' : ''}`;
    qs('head-sub').textContent = periodo;
    document.title = `${data.unidade} · Relatório gerencial`;
  }

  // ---------------- cartões ----------------
  const ICON_UP = '<svg viewBox="0 0 24 24"><path d="M7 14l5-5 5 5"/></svg>';
  const ICON_DOWN = '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg>';

  // bomQuandoSobe: false para pagamentos (subir é ruim)
  function deltaHtml(atual, anterior, { bomQuandoSobe = true, pp = false } = {}) {
    if (anterior === null || anterior === undefined) return '<span class="kpi-delta">sem período anterior</span>';
    const comp = state.mes === 'all' ? 'vs. ano ant.' : 'vs. mês ant.';
    let valor;
    let dir;
    if (pp) {
      const diff = atual - anterior;
      dir = Math.abs(diff) < 0.05 ? 'flat' : diff > 0 ? 'up' : 'down';
      valor = `${diff >= 0 ? '+' : '−'}${Math.abs(diff).toFixed(1).replace('.', ',')} p.p.`;
    } else {
      const d = fmt.delta(atual, anterior);
      if (d.pct === null) return '<span class="kpi-delta">—</span>';
      dir = d.direction;
      valor = fmt.signedPercent(d.pct).replace('-', '−');
    }
    const tom = dir === 'flat' ? 'is-neutro' : (dir === 'up') === bomQuandoSobe ? 'is-bom' : 'is-ruim';
    const icone = dir === 'up' ? ICON_UP : dir === 'down' ? ICON_DOWN : '';
    return `<span class="kpi-delta"><strong class="${tom}">${icone}${valor}</strong> ${comp}</span>`;
  }

  function animarNumero(elem, para, formatar) {
    if (PDF.imprimindo() || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { elem.textContent = formatar(para); return; }
    const inicio = performance.now();
    const dur = 700;
    const passo = (t) => {
      const p = Math.min(1, (t - inicio) / dur);
      elem.textContent = formatar(para * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(passo);
      else elem.textContent = formatar(para);
    };
    requestAnimationFrame(passo);
  }

  function cartao({ label, valor, formatar = fmt.currencyCompact, delta = '', extra = '', spark = null, tom = '', titulo = '' }, i) {
    const div = document.createElement('article');
    div.className = 'kpi';
    div.style.animationDelay = `${i * 40}ms`;
    if (titulo) div.title = titulo;
    div.innerHTML = `<span class="kpi-label">${label}</span>
      <span class="kpi-value ${tom}">${valor === null ? '—' : formatar(0)}</span>
      ${delta}${extra}${spark ? '<svg class="kpi-spark" aria-hidden="true"></svg>' : ''}`;
    qs('kpis').appendChild(div);
    if (valor !== null) animarNumero(div.querySelector('.kpi-value'), valor, formatar);
    if (spark) Graficos.sparkline(div.querySelector('.kpi-spark'), spark);
  }

  function renderKPIs(r, ant, janela) {
    const cur = derivar(r);
    const prev = ant ? derivar(ant) : null;
    const cd = ehCD();
    const box = qs('kpis');
    box.innerHTML = '';
    const sp = (fn) => janela.map(fn);
    const comEstoque = cd && datasets[state.slug].tem_estoque;
    box.classList.toggle('kpis--8', comEstoque);

    // vendas: ticket médio e, com mais de uma loja, quanto veio de cada uma
    const fontes = cur.vendas_por_fonte || [];
    let extraVendas = cd ? '' : `<span class="kpi-sub"><b>${fmt.int(cur.qtde_vendas)}</b> vendas · ticket <b>${fmt.currencyFull(cur.ticket)}</b></span>`;
    if (fontes.length > 1 && cur.total_vendas) {
      extraVendas = `<div class="kpi-fontes" title="${fontes.map((f) => `${f.nome}: ${fmt.currencyCents(f.valor)}`).join(' · ')}">
        <div class="kpi-fontes-bar">${fontes.map((f) => `<span style="width:${(f.valor / cur.total_vendas) * 100}%"></span>`).join('')}</div>
        <div class="kpi-fontes-leg">${fontes.map((f) => `<span>${escapeHtml(f.nome)} <b>${fmt.percent((f.valor / cur.total_vendas) * 100, 0)}</b></span>`).join('')}</div>
      </div>`;
    }

    const cartoes = [
      { label: cd ? 'Vendas' : 'Total vendas', valor: cur.total_vendas, delta: deltaHtml(cur.total_vendas, prev?.total_vendas), extra: extraVendas, titulo: fmt.currencyCents(cur.total_vendas) },
      { label: 'Total transf.', valor: cur.total_transferencias, delta: deltaHtml(cur.total_transferencias, prev?.total_transferencias), spark: sp((m) => m.total_transferencias), titulo: fmt.currencyCents(cur.total_transferencias) },
      { label: 'Fat. total', valor: cur.faturamento_total, delta: deltaHtml(cur.faturamento_total, prev?.faturamento_total), spark: sp((m) => m.faturamento_total), titulo: fmt.currencyCents(cur.faturamento_total) },
      { label: 'Pagamentos', valor: cur.pagamentos, delta: deltaHtml(cur.pagamentos, prev?.pagamentos, { bomQuandoSobe: false }), spark: sp((m) => m.pagamentos), titulo: regraBoi() ? `Sem ${datasets[state.slug].conta_boi} de anos anteriores` : fmt.currencyCents(cur.pagamentos) },
      { label: 'Resultado (R$)', valor: cur.resultado, tom: cur.resultado < 0 ? 'is-neg' : 'is-pos', delta: deltaHtml(cur.resultado, prev?.resultado), spark: sp((m) => m.faturamento_total - m.pagamentos), titulo: fmt.currencyCents(cur.resultado) },
      { label: 'Resultado (%)', valor: cur.margem, formatar: (v) => fmt.percent(v, 2), tom: cur.margem < 0 ? 'is-neg' : 'is-pos', delta: deltaHtml(cur.margem, prev?.margem, { pp: true }), spark: sp((m) => (m.faturamento_total ? ((m.faturamento_total - m.pagamentos) / m.faturamento_total) * 100 : 0)) },
    ];
    if (comEstoque) {
      cartoes.push(
        { label: 'Estoque', valor: cur.estoque, delta: cur.estoque === null ? `<span class="kpi-delta">sem estoque na planilha</span>` : deltaHtml(cur.estoque, prev?.estoque), extra: cur.estoque_label ? `<span class="kpi-sub">posição de ${escapeHtml(cur.estoque_label)}</span>` : '' },
        { label: 'Margem c/ estoque', valor: cur.margem_estoque, formatar: (v) => fmt.percent(v, 2), tom: (cur.margem_estoque ?? 0) < 0 ? 'is-neg' : 'is-pos', delta: cur.margem_estoque === null ? '' : deltaHtml(cur.margem_estoque, prev?.margem_estoque ?? null, { pp: true }), extra: '<span class="kpi-sub">(resultado + estoque) ÷ fat.</span>' },
      );
    } else {
      cartoes.push({ label: 'Pags. próximo mês', valor: cur.pagamentos_proximo_mes, delta: deltaHtml(cur.pagamentos_proximo_mes, prev?.pagamentos_proximo_mes, { bomQuandoSobe: false }), spark: sp((m) => m.pagamentos_proximo_mes), titulo: 'Emitidos no período com vencimento no mês seguinte' });
    }
    cartoes.forEach((c, i) => cartao(c, i));
  }

  // ---------------- painéis e gráfico ----------------
  function renderPaineis(r) {
    const data = datasets[state.slug];
    qs('titulo-grupos').textContent = data.planilha_vendas ? 'Maiores clientes' : 'Maiores grupos de vendas';
    Graficos.ranking(qs('grupos'), r.grupos || []);

    const o = r.pagamentos_origem;
    Graficos.rosca(qs('origem'), [
      { label: 'Mesmo mês', value: o.mesmo_mes, cor: '--s2' },
      { label: 'Transferência', value: o.transferencia, cor: '--s3' },
      { label: 'Transferências do CD', value: o.fornecedor_cd || 0, cor: '--s4' },
      { label: 'Meses anteriores', value: o.meses_anteriores, cor: '--s1' },
    ], 'Pagamentos');

    Graficos.distribuicao(qs('distribuicao'), r.distribuicao, r.faturamento_total);
    const contas = r.contas_sem_classificacao || [];
    const aviso = qs('aviso-classificacao');
    aviso.hidden = !contas.length;
    if (contas.length) {
      const total = contas.reduce((s, c) => s + c.valor, 0);
      const lista = contas.slice(0, 3).map((c) => `${escapeHtml(c.conta)} (${fmt.currencyCompact(c.valor)})`).join('; ');
      aviso.querySelector('span').innerHTML = `<strong>${fmt.currencyCompact(total)}</strong> em ${contas.length} conta(s) fora da planilha de classificação, contadas como despesas: ${lista}${contas.length > 3 ? `; e mais ${contas.length - 3}` : ''}.`;
    }

    // CD: mês sem linhas na planilha fica zerado
    const faltando = data.meses.filter((m) => m.sem_planilha && m.ano === state.ano && (state.mes === 'all' || m.mes === state.mes)).map((m) => fmt.monthName(m.mes));
    const avisoTopo = qs('aviso-topo');
    avisoTopo.hidden = !faltando.length;
    if (faltando.length) avisoTopo.querySelector('span').innerHTML = `A planilha de vendas não tem lançamentos em <strong>${faltando.join(', ')}/${state.ano}</strong>: o faturamento desse período aparece zerado.`;
  }

  let ultimoDesempenho = null;
  function renderDesempenho(data) {
    const janela = janelaDesempenho(data);
    // CD: só os meses com faturamento e pagamentos
    const meses = ehCD() ? janela.meses.filter((m) => m.faturamento_total > 0 && m.pagamentos > 0) : janela.meses;
    qs('titulo-desempenho').textContent = janela.titulo;
    qs('rotulo-anual').textContent = janela.rotulo;
    const fat = meses.reduce((s, m) => s + m.faturamento_total, 0);
    const res = meses.reduce((s, m) => s + m.faturamento_total - m.pagamentos, 0);
    const lucro = fat ? (res / fat) * 100 : null;
    const elLucro = qs('lucro-anual');
    elLucro.textContent = lucro === null ? '—' : fmt.percent(lucro, 2);
    elLucro.className = lucro === null ? '' : lucro < 0 ? 'is-neg' : 'is-pos';
    qs('opcao-ano').hidden = state.mes === 'all';
    qs('rotulo-ano-atual').textContent = `Só ${state.ano}`;

    ultimoDesempenho = meses.map((m) => ({
      ano: m.ano, mes: m.mes, label: m.label,
      faturamento_total: m.faturamento_total, pagamentos: m.pagamentos,
      lucratividade: m.faturamento_total ? ((m.faturamento_total - m.pagamentos) / m.faturamento_total) * 100 : 0,
      selecionado: state.mes !== 'all' && m.ano === state.ano && m.mes === state.mes,
      andamento: ehMesAtual(m.ano, m.mes),
    }));
    desenharDesempenho();
  }

  function desenharDesempenho() {
    if (!ultimoDesempenho) return;
    Graficos.desempenho(qs('grafico-desempenho'), ultimoDesempenho, {
      onSelect: PDF.modoArquivo() ? null : (ano, mes) => { state.ano = ano; state.mes = mes; atualizarTela(); },
    });
  }

  const anoAtualApenas = () => ler('painel.so-ano', '0') === '1';

  function renderRodape(data) {
    const dt = new Date(data.atualizado_em);
    qs('rodape-atualizado').textContent = `Dados consultados no banco em ${dt.toLocaleString('pt-BR')}`;
    const link = qs('link-desconsiderados');
    link.hidden = !(data.layout_cd && data.tem_desconsiderados);
    link.href = `pagamentos.html?visao=desconsiderados&slug=${encodeURIComponent(state.slug)}&ano=${state.ano}&mes=${state.mes}`;
    const restos = qs('link-restos');
    restos.hidden = !opcaoBoi();
    restos.href = `pagamentos.html?restos=boi&slug=${encodeURIComponent(state.slug)}&ano=${state.ano}`;
  }

  function seguro(nome, fn) {
    try { fn(); } catch (e) { console.error(`[painel] falha ao desenhar ${nome}:`, e); }
  }

  function renderTudo() {
    const data = dadosRelatorio();
    const r = registro(data, state.ano, state.mes);
    if (!r) return;
    const ant = registroAnterior(data, state.ano, state.mes);
    const janela = janelaDesempenho(data).meses;
    seguro('cabeçalho', () => renderCabecalho(data));
    seguro('cartões', () => renderKPIs(r, ant, janela));
    seguro('painéis', () => renderPaineis(r));
    seguro('desempenho', () => renderDesempenho(data));
    seguro('rodapé', () => renderRodape(data));
  }

  // ---------------- PDF ----------------
  async function prepararAnalise() {
    const secao = qs('pdf-analise');
    try {
      const mes = state.mes === 'all' ? 0 : state.mes;
      const res = await fetch(CONFIG.contaContabilUrl(state.slug, state.ano, mes) + (regraBoi() ? '&sem_boi_anterior=1' : ''), { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || body.erro) throw new Error((body && body.erro) || `HTTP ${res.status}`);
      RelatorioPDF.renderAnalise(secao, body, datasets[state.slug].unidade);
    } catch (e) {
      RelatorioPDF.renderErro(secao, e instanceof TypeError ? MSG_SEM_SERVIDOR : e.message);
    }
  }

  async function gerarPDF() {
    const data = datasets[state.slug];
    if (!data || qs('dashboard').hidden) return;
    const btn = qs('pdf-btn');
    const rot = btn.querySelector('span');
    btn.disabled = true;
    rot.textContent = 'Gerando…';
    const periodo = state.mes === 'all' ? `${state.ano}` : `${fmt.monthName(state.mes)}-${state.ano}`;
    const nome = `Relatório gerencial - ${data.unidade} - ${periodo}`;
    try {
      await PDF.baixar({
        pagina: 'index.html',
        params: { slug: state.slug, ano: state.ano, mes: state.mes, ...(boiIncluido() ? { boi: 1 } : {}) },
        nome,
        imprimir: async () => {
          await prepararAnalise();
          try { await PDF.gerar({ titulo: nome, preparar: () => renderTudo(), restaurar: () => renderTudo() }); } finally { qs('pdf-analise').innerHTML = ''; }
        },
      });
    } catch (e) {
      PDF.aviso(`Não foi possível gerar o PDF: ${e instanceof TypeError ? MSG_SEM_SERVIDOR : e.message}`, 'erro');
    } finally {
      btn.disabled = false;
      rot.textContent = 'Gerar PDF';
    }
  }

  // ---------------- tema ----------------
  function iniciarTema() {
    const salvo = ler('painel.theme');
    const escuro = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const tema = PDF.modoArquivo() ? 'light' : (salvo || (escuro ? 'dark' : 'light'));
    document.documentElement.setAttribute('data-theme', tema);
    qs('theme-toggle').addEventListener('click', () => {
      const prox = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', prox);
      document.querySelector('.app').setAttribute('data-theme', prox);
      gravar('painel.theme', prox);
    });
  }

  // ---------------- início ----------------
  async function init() {
    const modoPDF = PDF.modoArquivo();
    if (modoPDF) PDF.prepararModoArquivo();
    iniciarTema();

    qs('pdf-btn').onclick = gerarPDF;
    qs('refresh-btn').onclick = async () => {
      const b = qs('refresh-btn');
      b.disabled = true; b.classList.add('is-busy');
      try { await mostrar(state.slug, true); } finally { b.disabled = false; b.classList.remove('is-busy'); }
    };
    const chkAno = qs('toggle-ano');
    chkAno.checked = anoAtualApenas();
    chkAno.onchange = () => { gravar('painel.so-ano', chkAno.checked ? '1' : '0'); if (datasets[state.slug]) renderTudo(); };
    qs('toggle-boi').onchange = (e) => { gravar('painel.cd.boi', e.target.checked ? '1' : '0'); atualizarTela(); };

    let espera = null;
    new ResizeObserver(() => { clearTimeout(espera); espera = setTimeout(desenharDesempenho, 120); }).observe(qs('grafico-desempenho'));

    status('loading', 'Conectando ao servidor do painel…', 'Carregando as lojas habilitadas.');
    try {
      const res = await fetch(CONFIG.unidadesUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      lojas = await res.json();
    } catch (e) {
      status('error', 'Servidor do painel indisponível', MSG_SEM_SERVIDOR, () => location.reload());
      return;
    }
    if (!lojas.length) {
      status('error', 'Nenhuma loja habilitada', 'Inclua as lojas em LOJAS no arquivo .env do servidor e reinicie o painel.');
      return;
    }

    state.slug = loja(ler('painel.loja')) ? ler('painel.loja') : lojas[0].slug;
    if (modoPDF) {
      if (loja(PDF.parametro('slug'))) state.slug = PDF.parametro('slug');
      state.ano = Number(PDF.parametro('ano')) || null;
      state.mes = PDF.parametro('mes') === 'all' ? 'all' : Number(PDF.parametro('mes')) || null;
      boiPDF = PDF.parametro('boi') === '1';
    }
    renderLojas();
    await mostrar(state.slug);
    if (modoPDF && datasets[state.slug]) await prepararAnalise();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Painel.init);
