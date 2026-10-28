// ============================================================
// Seção "Análise de pagamentos por conta contábil" do PDF da Visão geral:
// a mesma matriz da página Análise por conta contábil, com o plano de
// contas e tudo expandido (plano > grupo > conta), para impressão.
// ============================================================

const RelatorioPDF = (() => {
  const NAO_CLASSIFICADOS = 'PAGAMENTOS NÃO CLASSIFICADOS';

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function parseData(iso) {
    const [a, m, d] = iso.split('-').map(Number);
    return { ano: a, mes: m, dia: d };
  }

  const dd = (n) => String(n).padStart(2, '0');

  // "Set/26", "Out/26 · 01 a 05", "2025" ou "2026 · até 05/10"
  function rotulo(periodo, dados) {
    const ini = parseData(periodo.ini);
    const fim = parseData(periodo.fim);
    if (dados.ano_inteiro) return dados.mes_fechado ? `${ini.ano}` : `${ini.ano} · até ${dd(fim.dia)}/${dd(fim.mes)}`;
    const base = `${fmt.monthName(ini.mes)}/${String(ini.ano).slice(2)}`;
    return dados.mes_fechado ? base : `${base} · 01 a ${dd(fim.dia)}`;
  }

  function diferenca(anterior, atual) {
    const valor = atual - anterior;
    const pct = anterior ? (valor / Math.abs(anterior)) * 100 : null;
    const dir = Math.abs(valor) < 0.005 ? 'flat' : valor > 0 ? 'up' : 'down';
    return { valor, pct, dir };
  }

  function celulasNumeros(anterior, atual) {
    const d = diferenca(anterior, atual);
    const valor = d.dir === 'flat' ? fmt.currencyCents(0) : `${d.valor > 0 ? '+' : '−'}${fmt.currencyCents(Math.abs(d.valor))}`;
    const pct = d.pct === null ? (atual ? 'novo' : '—') : d.dir === 'flat' ? '0,0%' : `${d.pct > 0 ? '+' : '−'}${fmt.percent(Math.abs(d.pct))}`;
    return `<td class="col-num">${fmt.currencyCents(anterior)}</td>
      <td class="col-num">${fmt.currencyCents(atual)}</td>
      <td class="col-num dif-${d.dir}">${valor}</td>
      <td class="col-num dif-${d.dir}">${pct}</td>`;
  }

  function ordenar(a, b) {
    const na = a.nome === NAO_CLASSIFICADOS ? 1 : 0;
    const nb = b.nome === NAO_CLASSIFICADOS ? 1 : 0;
    return na - nb || b.atual - a.atual || b.anterior - a.anterior || a.nome.localeCompare(b.nome, 'pt-BR');
  }

  // plano > grupo > conta; não classificados vão direto do plano para as contas
  function arvore(linhas, campos) {
    const [campo, ...resto] = campos;
    const mapa = new Map();
    for (const l of linhas) {
      if (!mapa.has(l[campo])) mapa.set(l[campo], []);
      mapa.get(l[campo]).push(l);
    }
    return [...mapa.entries()].map(([nome, itens]) => {
      const proximos = nome === NAO_CLASSIFICADOS ? resto.filter((c) => c === 'conta') : resto;
      return {
        nome,
        campo,
        naoClassificado: itens.every((l) => !l.classificado),
        anterior: itens.reduce((s, l) => s + l.anterior, 0),
        atual: itens.reduce((s, l) => s + l.atual, 0),
        filhos: proximos.length ? arvore(itens, proximos) : [],
      };
    }).sort(ordenar);
  }

  function renderAnalise(container, dados, unidadeNome) {
    const ant = rotulo(dados.periodo_anterior, dados);
    const atu = rotulo(dados.periodo_atual, dados);
    const linhas = [];
    const percorrer = (nos, nivel) => {
      for (const no of nos) {
        const classes = [`nivel-${nivel}`, `campo-${no.campo}`];
        if (no.naoClassificado) classes.push('is-nao-class');
        const nome = no.nome === NAO_CLASSIFICADOS ? 'Pagamentos não classificados' : no.nome;
        linhas.push(`<tr class="${classes.join(' ')}">
          <th scope="row" class="col-nome" style="--nivel:${nivel}">${escapeHtml(nome)}</th>
          ${celulasNumeros(no.anterior, no.atual)}
        </tr>`);
        percorrer(no.filhos, nivel + 1);
      }
    };
    percorrer(arvore(dados.linhas, ['plano', 'grupo', 'conta']), 0);

    const totAnt = dados.linhas.reduce((s, l) => s + l.anterior, 0);
    const totAtu = dados.linhas.reduce((s, l) => s + l.atual, 0);
    const comparacao = dados.ano_inteiro
      ? (dados.mes_fechado ? 'ano inteiro comparado com o ano anterior' : 'ano em andamento comparado com o mesmo intervalo do ano anterior')
      : (dados.mes_fechado ? 'mês fechado comparado com o mês anterior inteiro' : 'mês em andamento comparado com o mesmo intervalo de dias do mês anterior');

    container.innerHTML = `
      <section class="card card--matriz">
        <div class="card-head">
          <div>
            <h2>Análise de pagamentos por conta contábil</h2>
            <p>${escapeHtml(unidadeNome)} · ${escapeHtml(atu)} x ${escapeHtml(ant)} — ${comparacao}. Plano de contas &gt; grupo &gt; conta contábil.</p>
          </div>
        </div>
        <table class="matriz">
          <thead><tr>
            <th scope="col" class="col-nome">Plano de contas / grupo / conta contábil</th>
            <th scope="col" class="col-num">${escapeHtml(ant)}</th>
            <th scope="col" class="col-num">${escapeHtml(atu)}</th>
            <th scope="col" class="col-num">Diferença (R$)</th>
            <th scope="col" class="col-num">Diferença (%)</th>
          </tr></thead>
          <tbody>${linhas.join('') || '<tr class="matriz-vazia"><td colspan="5">Nenhuma conta paga nos dois períodos.</td></tr>'}</tbody>
          <tfoot><tr><th scope="row" class="col-nome">Total pago</th>${celulasNumeros(totAnt, totAtu)}</tr></tfoot>
        </table>
        <p class="matriz-nota">Aumento de pagamento em vermelho, redução em verde. Mesmas exclusões do painel.</p>
      </section>`;
  }

  function renderErro(container, msg) {
    container.innerHTML = `<section class="card"><div class="card-head"><div>
      <h2>Análise de pagamentos por conta contábil</h2>
      <p>Não foi possível consultar a análise: ${escapeHtml(msg)}</p></div></div></section>`;
  }

  return { renderAnalise, renderErro };
})();
