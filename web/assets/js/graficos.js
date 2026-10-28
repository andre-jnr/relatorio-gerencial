// ============================================================
// Gráficos do painel em SVG/HTML puro (sem biblioteca).
// Cores sempre pelas variáveis CSS (--s1..--s4), que mudam com o tema.
// ============================================================
const Graficos = (() => {
  const NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs = {}, pai) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
    if (pai) pai.appendChild(e);
    return e;
  }

  function texto(pai, x, y, conteudo, attrs = {}) {
    const t = el('text', { x, y, ...attrs }, pai);
    t.textContent = conteudo;
    return t;
  }

  // ---------------- tooltip único da página ----------------
  let tip = null;
  function tooltip() {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'tooltip';
      tip.setAttribute('role', 'tooltip');
      document.body.appendChild(tip);
    }
    return tip;
  }
  function mostrarTip(html, evento) {
    const t = tooltip();
    t.innerHTML = html;
    t.classList.add('is-on');
    moverTip(evento);
  }
  function moverTip(evento) {
    const t = tooltip();
    const larg = t.offsetWidth;
    const alt = t.offsetHeight;
    let x = evento.clientX + 16;
    let y = evento.clientY - alt - 12;
    if (x + larg > window.innerWidth - 8) x = evento.clientX - larg - 16;
    if (y < 8) y = evento.clientY + 16;
    t.style.left = `${x}px`;
    t.style.top = `${y}px`;
  }
  function esconderTip() { if (tip) tip.classList.remove('is-on'); }

  // ---------------- sparkline dos cartões ----------------
  function sparkline(svg, valores) {
    svg.innerHTML = '';
    const v = valores.filter((x) => Number.isFinite(x));
    if (v.length < 2) return;
    const w = svg.clientWidth || 160;
    const h = svg.clientHeight || 26;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const min = Math.min(...v);
    const max = Math.max(...v);
    const amp = max - min || 1;
    const pts = v.map((x, i) => [(i / (v.length - 1)) * (w - 4) + 2, h - 3 - ((x - min) / amp) * (h - 6)]);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    el('path', { class: 'area', d: `${d}L${pts[pts.length - 1][0]},${h}L${pts[0][0]},${h}Z` }, svg);
    el('path', { class: 'linha', d }, svg);
    const ult = pts[pts.length - 1];
    el('circle', { cx: ult[0], cy: ult[1], r: 2.5 }, svg);
  }

  // ---------------- maiores grupos (barras horizontais) ----------------
  function ranking(container, grupos, limite = 5) {
    const ordenados = [...grupos].sort((a, b) => b.valor - a.valor);
    if (!ordenados.length) { container.innerHTML = '<p class="vazio">Sem vendas no período.</p>'; return; }
    const total = ordenados.reduce((s, g) => s + g.valor, 0) || 1;
    const max = ordenados[0].valor || 1;
    container.innerHTML = `<ol class="rank">${ordenados.slice(0, limite).map((g, i) => `
      <li title="${escapeHtml(g.grupo)}: ${fmt.currencyCents(g.valor)}">
        <span class="rank-nome">${escapeHtml(g.grupo)}</span>
        <span class="rank-valor">${fmt.currencyCompact(g.valor)}<small>${fmt.percent((g.valor / total) * 100)}</small></span>
        <span class="rank-barra"><span style="width:${Math.max(1, (g.valor / max) * 100)}%;animation-delay:${i * 50}ms"></span></span>
      </li>`).join('')}</ol>`;
  }

  // ---------------- rosca ----------------
  function arco(cx, cy, r0, r1, a0, a1) {
    const p = (r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
    const grande = a1 - a0 > Math.PI ? 1 : 0;
    const [x0, y0] = p(r1, a0);
    const [x1, y1] = p(r1, a1);
    const [x2, y2] = p(r0, a1);
    const [x3, y3] = p(r0, a0);
    return `M${x0},${y0}A${r1},${r1} 0 ${grande} 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${grande} 0 ${x3},${y3}Z`;
  }

  // fatias: [{ label, value, cor: '--s1' }]
  function rosca(container, fatias, rotuloCentro) {
    const itens = fatias.filter((f) => f.value > 0);
    const total = itens.reduce((s, f) => s + f.value, 0);
    container.innerHTML = `
      <div class="donut-wrap">
        <div class="donut"><svg viewBox="0 0 150 150" role="img" aria-label="${escapeHtml(rotuloCentro)}"></svg>
          <div class="donut-centro"><span>${escapeHtml(rotuloCentro)}</span><strong>${fmt.currencyCompact(total)}</strong></div></div>
        <ul class="legenda">${itens.map((f, i) => `
          <li data-i="${i}"><i style="background:var(${f.cor})"></i><span class="leg-nome">${escapeHtml(f.label)}</span>
            <span class="leg-pct">${fmt.percent(total ? (f.value / total) * 100 : 0, 0)}</span>
            <span class="leg-valor">${fmt.currencyCompact(f.value)}</span></li>`).join('')}</ul>
      </div>`;
    if (!total) { container.querySelector('.legenda').innerHTML = '<li class="vazio">Nenhum pagamento no período.</li>'; return; }
    const svg = container.querySelector('svg');
    const donut = container.querySelector('.donut');
    const legenda = container.querySelector('.legenda');
    let a = 0;
    const gap = itens.length > 1 ? 0.025 : 0; // ~2px de respiro entre fatias
    itens.forEach((f, i) => {
      const ang = (f.value / total) * Math.PI * 2;
      const a0 = a + gap / 2;
      const a1 = Math.max(a0 + 0.001, a + ang - gap / 2);
      const path = el('path', { d: arco(75, 75, 50, 72, a0, Math.min(a1, a0 + Math.PI * 2 - 0.0001)), fill: `var(${f.cor})`, 'data-i': i }, svg);
      a += ang;
      const ligar = (on) => {
        donut.classList.toggle('is-hover', on);
        legenda.classList.toggle('is-hover', on);
        path.classList.toggle('is-on', on);
        legenda.querySelector(`[data-i="${i}"]`).classList.toggle('is-on', on);
      };
      path.addEventListener('mouseenter', (e) => { ligar(true); mostrarTip(`<h4>${escapeHtml(f.label)}</h4><div><i style="background:var(${f.cor})"></i><span>${fmt.percent((f.value / total) * 100)}</span><b>${fmt.currencyCents(f.value)}</b></div>`, e); });
      path.addEventListener('mousemove', moverTip);
      path.addEventListener('mouseleave', () => { ligar(false); esconderTip(); });
    });
  }

  // ---------------- distribuição do faturamento ----------------
  // barra = pagamentos (revenda + despesas) e lucro sobre a base max(faturamento, pagamentos);
  // com prejuízo, uma marca mostra onde o faturamento termina e o excedente fica hachurado
  function distribuicao(container, d, faturamento) {
    const revenda = Math.max(0, d.produtos_revenda);
    const despesas = Math.max(0, d.despesas_operacionais);
    const lucro = d.lucro;
    const pagamentos = revenda + despesas;
    const base = Math.max(faturamento, pagamentos) || 1;
    const pctFat = (v) => (faturamento ? fmt.percent((v / faturamento) * 100) : '—');
    const w = (v) => `${(v / base) * 100}%`;
    const prejuizo = lucro < 0;
    const marca = prejuizo ? (faturamento / base) * 100 : null;
    container.innerHTML = `
      <div class="dist-barra" role="img" aria-label="Distribuição do faturamento">
        <span style="width:${w(revenda)};background:var(--s3)"></span>
        <span style="width:${w(despesas)};background:var(--s2);animation-delay:80ms"></span>
        ${!prejuizo && lucro > 0 ? `<span style="width:${w(lucro)};background:var(--s1);animation-delay:160ms"></span>` : ''}
        ${prejuizo ? `<span class="prejuizo" style="position:absolute;left:${marca}%;right:0;top:0;bottom:0;border-radius:0 5px 5px 0;background:none"></span><i class="dist-marca" style="left:calc(${marca}% - 1px)"></i>` : ''}
      </div>
      <div class="dist-marca-rotulo"><span>0</span><span>${prejuizo ? `Faturamento ${fmt.currencyCompact(faturamento)} · pagamentos ${fmt.currencyCompact(pagamentos)}` : `Faturamento ${fmt.currencyCompact(faturamento)}`}</span></div>
      <ul class="dist-linhas">
        <li><i style="background:var(--s3)"></i><span class="nome">Produtos para revenda</span><span class="valor">${fmt.currencyCompact(revenda)}</span><span class="pct">${pctFat(revenda)}</span></li>
        <li><i style="background:var(--s2)"></i><span class="nome">Despesas operacionais</span><span class="valor">${fmt.currencyCompact(despesas)}</span><span class="pct">${pctFat(despesas)}</span></li>
        <li class="${prejuizo ? 'is-neg' : ''}"><i class="${prejuizo ? 'hach' : ''}" style="${prejuizo ? '' : 'background:var(--s1)'}"></i><span class="nome">${prejuizo ? 'Prejuízo' : 'Lucro'}</span><span class="valor">${fmt.currencyCompact(lucro)}</span><span class="pct">${pctFat(lucro)}</span></li>
      </ul>`;
  }

  // ---------------- desempenho: linha de lucratividade sobre barras ----------------
  // meses: [{ ano, mes, label, faturamento_total, pagamentos, lucratividade, andamento }]
  // A linha fica numa faixa própria acima das barras (escala própria, sem eixo duplo).
  function desempenho(box, meses, opts = {}) {
    const svg = box.querySelector('svg') || el('svg', {}, box);
    svg.innerHTML = '';
    const W = box.clientWidth || 900;
    const H = box.clientHeight || 280;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!meses.length) { texto(svg, W / 2, H / 2, 'Sem meses para mostrar.', { class: 'tl-eixo', 'text-anchor': 'middle' }); return; }

    const n = meses.length;
    const padX = 6;
    const cw = (W - padX * 2) / n;
    const topoLinha = 24;
    const altLinha = Math.max(40, Math.min(76, H * 0.18));
    const topoBarras = topoLinha + altLinha + 26;
    const baseY = H - 24;
    const altBarras = Math.max(40, baseY - topoBarras);
    const bw = Math.max(6, Math.min(30, cw * 0.28));
    const rotulos = cw >= 62;

    const maxV = Math.max(1, ...meses.map((m) => Math.max(m.faturamento_total, m.pagamentos)));
    const yBar = (v) => baseY - (Math.max(0, v) / maxV) * altBarras;
    const pcts = meses.map((m) => m.lucratividade);
    let pMin = Math.min(0, ...pcts);
    let pMax = Math.max(0, ...pcts);
    if (pMax - pMin < 10) { const meio = (pMax + pMin) / 2; pMin = meio - 5; pMax = meio + 5; }
    const yPct = (p) => topoLinha + (1 - (p - pMin) / (pMax - pMin)) * altLinha;
    const cx = (i) => padX + cw * i + cw / 2;

    // seleção e linhas de grade
    meses.forEach((m, i) => {
      if (m.selecionado) el('rect', { class: 'tl-sel', x: padX + cw * i + 2, y: 4, width: cw - 4, height: H - 6, rx: 10 }, svg);
    });
    const grade = el('g', { class: 'tl-grid' }, svg);
    [0.5, 1].forEach((f) => el('line', { x1: padX, x2: W - padX, y1: baseY - altBarras * f, y2: baseY - altBarras * f }, grade));
    el('line', { class: 'tl-base', x1: padX, x2: W - padX, y1: baseY + 0.5, y2: baseY + 0.5 }, svg);
    if (pMin < 0 && pMax > 0) el('line', { class: 'tl-zero', x1: padX, x2: W - padX, y1: yPct(0), y2: yPct(0) }, svg);
    texto(svg, padX + 2, 12, 'Lucratividade', { class: 'tl-faixa' });

    // barras
    meses.forEach((m, i) => {
      const g = el('g', {}, svg);
      const x0 = cx(i) - bw - 1;
      const x1 = cx(i) + 1;
      // rótulos abrem para fora a partir do meio do par de barras, para não se sobreporem
      const barra = (x, v, cor, atraso, ancora) => {
        const y = yBar(v);
        const h = Math.max(1, baseY - y);
        // topo arredondado (4px), base reta no eixo
        const r = Math.min(4, bw / 2, h);
        el('path', {
          class: 'tl-anim', fill: `var(${cor})`, style: `animation-delay:${atraso}ms`,
          d: `M${x},${baseY}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${baseY}Z`,
        }, g);
        if (rotulos || m.selecionado) {
          const lx = ancora === 'end' ? x + bw - 1 : ancora === 'start' ? x + 1 : x + bw / 2;
          texto(g, lx, y - 5, fmt.compact(v), { class: 'tl-rotulo', 'text-anchor': ancora || 'middle' });
        }
      };
      const separar = cw < bw * 2 + 90;
      barra(x0, m.faturamento_total, '--s1', i * 25, separar ? 'end' : null);
      barra(x1, m.pagamentos, '--s2', i * 25 + 40, separar ? 'start' : null);
      texto(svg, cx(i), H - 6, m.label, { class: `tl-eixo${m.selecionado ? ' is-sel' : ''}`, 'text-anchor': 'middle' });
    });

    // linha de lucratividade (faixa de cima)
    const pts = meses.map((m, i) => [cx(i), yPct(m.lucratividade)]);
    const d = pts.map((p, i) => {
      if (!i) return `M${p[0]},${p[1]}`;
      const [x0, y0] = pts[i - 1];
      const mx = (x0 + p[0]) / 2;
      return `C${mx},${y0} ${mx},${p[1]} ${p[0]},${p[1]}`;
    }).join('');
    const linha = el('path', { class: 'tl-linha tl-linha-anim', d }, svg);
    try { linha.style.setProperty('--len', Math.ceil(linha.getTotalLength())); } catch (e) { /* sem layout */ }
    meses.forEach((m, i) => {
      const neg = m.lucratividade < 0;
      el('circle', { class: `tl-ponto${neg ? ' is-neg' : ''}${m.andamento ? ' is-andamento' : ''}`, cx: pts[i][0], cy: pts[i][1], r: m.selecionado ? 5 : 4 }, svg);
      const acima = pts[i][1] - topoLinha > 14;
      texto(svg, pts[i][0], acima ? pts[i][1] - 10 : pts[i][1] + 18, fmt.percent(m.lucratividade, cw < 48 ? 0 : 2),
        { class: `tl-pct${neg ? ' is-neg' : ''}`, 'text-anchor': 'middle' });
    });

    // camada de interação por mês: destaque, tooltip e clique para selecionar
    meses.forEach((m, i) => {
      const g = el('g', { class: 'tl-col' }, svg);
      el('rect', { class: 'tl-hover', x: padX + cw * i + 2, y: 4, width: cw - 4, height: H - 6, rx: 10 }, g);
      g.parentNode.insertBefore(g, svg.firstChild.nextSibling); // fica atrás das marcas
      const alvo = el('rect', { x: padX + cw * i, y: 0, width: cw, height: H, fill: 'transparent' }, svg);
      const html = () => {
        const res = m.faturamento_total - m.pagamentos;
        return `<h4>${m.label}${m.andamento ? ' · em andamento' : ''}</h4>
          <div><i style="background:var(--s1)"></i><span>Faturamento</span><b>${fmt.currencyCents(m.faturamento_total)}</b></div>
          <div><i style="background:var(--s2)"></i><span>Pagamentos</span><b>${fmt.currencyCents(m.pagamentos)}</b></div>
          <hr><div><i></i><span>Resultado</span><b style="color:${res < 0 ? 'var(--critical)' : 'var(--good)'}">${fmt.currencyCents(res)}</b></div>
          <div><i></i><span>${escapeHtml(opts.nomeLucro || 'Lucratividade')}</span><b>${fmt.percent(m.lucratividade, 2)}</b></div>
          ${opts.onSelect && !m.selecionado ? '<p>Clique para ver este mês</p>' : ''}`;
      };
      alvo.addEventListener('mouseenter', (e) => { g.querySelector('.tl-hover').style.opacity = 1; mostrarTip(html(), e); });
      alvo.addEventListener('mousemove', moverTip);
      alvo.addEventListener('mouseleave', () => { g.querySelector('.tl-hover').style.opacity = ''; esconderTip(); });
      if (opts.onSelect) {
        alvo.style.cursor = 'pointer';
        alvo.addEventListener('click', () => { esconderTip(); opts.onSelect(m.ano, m.mes); });
      }
    });
  }

  return { sparkline, ranking, rosca, distribuicao, desempenho, esconderTip };
})();
