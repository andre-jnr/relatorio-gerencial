// ============================================================
// Exportação das tabelas de pagamentos.
//   Excel: .xlsx de verdade (SheetJS, carregado só no primeiro uso);
//          sem internet, cai para .csv (abre no Excel).
//   PDF:   o servidor gera em A4 paisagem (ver pdf.js / painel/pdf.py).
// ============================================================

const Exportar = (() => {
  const SHEETJS = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  let carregando = null;

  function carregarSheetJS() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!carregando) {
      carregando = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = SHEETJS;
        s.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('SheetJS indisponível')));
        s.onerror = () => { carregando = null; reject(new Error('sem acesso à internet para gerar o .xlsx')); };
        document.head.appendChild(s);
      });
    }
    return carregando;
  }

  function nomeArquivo(nome) {
    return nome.replace(/[\\/:*?"<>|]/g, '-');
  }

  // "2026-09-30" -> Date (meio-dia, para o fuso não trocar o dia)
  function data(iso) {
    if (!iso) return null;
    const [a, m, d] = iso.split('-').map(Number);
    return new Date(a, m - 1, d, 12);
  }

  // colunas: [{ titulo, tipo: 'texto' | 'moeda' | 'data' | 'pct' | 'numero', largura }]
  // linhas: arrays de valores (moeda/pct/numero = número; data = 'aaaa-mm-dd'; pct já em %)
  async function excel({ nome, titulo, subtitulo, colunas, linhas, total }) {
    try {
      const XLSX = await carregarSheetJS();
      const aoa = [[titulo], subtitulo ? [subtitulo] : [], [], colunas.map((c) => c.titulo)];
      const conv = (c, v) => (v === null || v === undefined || v === '' ? null
        : c.tipo === 'data' ? data(v)
          : c.tipo === 'moeda' ? Math.round(v * 100) / 100
          : c.tipo === 'pct' ? v / 100
            : v);
      linhas.forEach((l) => aoa.push(l.map((v, i) => conv(colunas[i], v))));
      if (total) aoa.push(total.map((v, i) => conv(colunas[i], v)));
      const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
      const inicio = 4; // primeira linha de dados (0 = título)
      const fim = aoa.length - 1;
      colunas.forEach((c, ci) => {
        const formato = c.tipo === 'moeda' ? '#,##0.00' : c.tipo === 'data' ? 'dd/mm/yyyy' : c.tipo === 'pct' ? '0.0%' : c.tipo === 'numero' ? '0' : null;
        if (!formato) return;
        for (let r = inicio; r <= fim; r++) {
          const cel = ws[XLSX.utils.encode_cell({ r, c: ci })];
          if (cel && (cel.t === 'n' || cel.t === 'd')) cel.z = formato;
        }
      });
      ws['!cols'] = colunas.map((c) => ({ wch: c.largura || (c.tipo === 'texto' ? 30 : 15) }));
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: Math.max(3, fim - (total ? 1 : 0)), c: colunas.length - 1 } }) };
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Pagamentos');
      XLSX.writeFile(wb, `${nomeArquivo(nome)}.xlsx`, { cellDates: true });
      PDF.aviso('Planilha salva na pasta de downloads.', 'ok');
    } catch (e) {
      csv({ nome, titulo, colunas, linhas, total });
      PDF.aviso(`Não foi possível gerar o .xlsx (${e.message}); salvei em .csv, que também abre no Excel.`, 'erro');
    }
  }

  // plano B: CSV com ";" e BOM, como o Excel em português espera
  function csv({ nome, titulo, colunas, linhas, total }) {
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
      return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const fmtCel = (c, v) => (c.tipo === 'data' && v ? v.split('-').reverse().join('/') : v);
    const todas = [[titulo], colunas.map((c) => c.titulo), ...linhas, ...(total ? [total] : [])];
    const texto = todas.map((l, li) => l.map((v, i) => esc(li > 1 ? fmtCel(colunas[i], v) : v)).join(';')).join('\r\n');
    const blob = new Blob(['﻿' + texto], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${nomeArquivo(nome)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  // PDF pelo servidor (A4 paisagem); a página abre em modo PDF com os mesmos filtros
  async function pdf({ pagina, params, nome, botao }) {
    const rotulo = botao && botao.textContent;
    if (botao) { botao.disabled = true; botao.textContent = 'Gerando…'; }
    try {
      await PDF.baixar({ pagina, params, nome, imprimir: () => PDF.gerar({ titulo: nome }) });
    } catch (e) {
      PDF.aviso(`Não foi possível gerar o PDF: ${e.message}`, 'erro');
    } finally {
      if (botao) { botao.disabled = false; botao.textContent = rotulo; }
    }
  }

  return { excel, pdf };
})();
