// ============================================================
// Geração de PDF pela impressão do navegador ("Salvar como PDF").
// Antes de imprimir: tema claro, sem animações (classe "imprimindo") e
// gráficos redesenhados; depois volta tudo como estava.
// O layout de impressão fica no @media print de style.css.
// ============================================================

const PDF = (() => {
  // dá tempo de o navegador montar o que foi redesenhado (só timer: requestAnimationFrame
  // não roda com a aba em segundo plano e travaria o PDF)
  function esperar(ms = 300) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function aplicarTema(tema) {
    document.querySelector('.app').setAttribute('data-theme', tema);
    document.documentElement.setAttribute('data-theme', tema);
  }

  // opts.preparar: redesenha a página já no tema claro (pode ser async)
  // opts.restaurar: redesenha de volta no tema original
  // opts.titulo: vira o nome sugerido do arquivo PDF
  async function gerar({ preparar, restaurar, titulo }) {
    const temaOriginal = document.querySelector('.app').getAttribute('data-theme') || 'light';
    const tituloOriginal = document.title;
    const gerado = document.querySelectorAll('.pdf-gerado');
    const agora = new Date();
    gerado.forEach((el) => {
      el.textContent = `Gerado em ${agora.toLocaleDateString('pt-BR')} às ${agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    });

    document.body.classList.add('imprimindo');
    aplicarTema('light');
    try {
      if (preparar) await preparar();
      await esperar();
      if (titulo) document.title = titulo.replace(/[\\/:*?"<>|]/g, '-');
      window.print(); // o navegador abre o diálogo; escolha "Salvar como PDF"
    } finally {
      document.title = tituloOriginal;
      document.body.classList.remove('imprimindo');
      aplicarTema(temaOriginal);
      if (restaurar) await restaurar();
    }
  }

  function imprimindo() {
    return document.body.classList.contains('imprimindo');
  }

  // ---------------- PDF direto (sem o diálogo de impressão) ----------------
  // O servidor abre a página em modo PDF (?pdf=1&...) num Chrome/Edge invisível, que
  // salva em A4 paisagem; aqui só pedimos, esperamos ficar pronto e baixamos o arquivo.

  // a página foi aberta pelo servidor para virar PDF?
  function modoArquivo() {
    return new URLSearchParams(location.search).get('pdf') === '1';
  }

  function parametro(nome) {
    return new URLSearchParams(location.search).get(nome);
  }

  // no modo PDF: tema claro, sem animação e data de geração no cabeçalho
  function prepararModoArquivo() {
    document.body.classList.add('imprimindo');
    aplicarTema('light');
    const agora = new Date();
    document.querySelectorAll('.pdf-gerado').forEach((el) => {
      el.textContent = `Gerado em ${agora.toLocaleDateString('pt-BR')} às ${agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    });
  }

  let avisoEl = null;
  function aviso(texto, tipo = 'info') {
    if (!avisoEl) {
      avisoEl = document.createElement('div');
      avisoEl.className = 'pdf-aviso';
      avisoEl.setAttribute('role', 'status');
      document.body.appendChild(avisoEl);
    }
    avisoEl.textContent = texto;
    avisoEl.className = `pdf-aviso is-${tipo} is-visivel`;
    clearTimeout(avisoEl._timer);
    if (tipo !== 'info') avisoEl._timer = setTimeout(() => avisoEl.classList.remove('is-visivel'), 7000);
  }

  // opts.pagina: 'index.html' | 'consolidado.html'; opts.params: { slug, ano, mes }
  // opts.nome: nome do arquivo; opts.imprimir: plano B (diálogo de impressão) sem Chrome/Edge
  async function baixar({ pagina, params, nome, imprimir }) {
    aviso('Gerando o PDF… pode levar alguns segundos.');
    const query = new URLSearchParams({ pagina, ...params, ...(CONFIG.escopo ? { escopo: CONFIG.escopo } : {}) });
    const inicio = await fetch(`/api/pdf/iniciar?${query}`, { cache: 'no-store' });
    const job = await inicio.json().catch(() => null);
    if (!inicio.ok || !job || !job.id) {
      if (job && job.sem_navegador && imprimir) {
        aviso('Chrome/Edge não encontrado: abrindo a impressão do navegador (escolha "Paisagem").', 'erro');
        return imprimir();
      }
      throw new Error((job && job.erro) || `HTTP ${inicio.status}`);
    }
    for (;;) {
      await esperar(1000);
      const res = await fetch(`/api/pdf/${job.id}`, { cache: 'no-store' });
      if (res.status === 202) continue;
      if (!res.ok) {
        const erro = await res.json().catch(() => null);
        throw new Error((erro && erro.erro) || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${nome.replace(/[\\/:*?"<>|]/g, '-')}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 30000);
      aviso('PDF salvo na pasta de downloads.', 'ok');
      return;
    }
  }

  return { gerar, imprimindo, modoArquivo, parametro, prepararModoArquivo, baixar, aviso };
})();
