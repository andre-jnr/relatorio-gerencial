// ============================================================
// Endpoints da API (app.py) e formatação pt-BR compartilhada.
// Não usar `this` no fmt: as funções são passadas soltas como callback.
// ============================================================
const CONFIG = {
  unidadesUrl: '/api/unidades',
  dadosUrl: (slug) => `/api/dados/${encodeURIComponent(slug)}`,
  contaContabilUrl: (slug, ano, mes) => `/api/conta-contabil/${encodeURIComponent(slug)}?ano=${ano}&mes=${mes}`,
  pagamentosUrl: (slug, ano, mes) => `/api/pagamentos/${encodeURIComponent(slug)}?ano=${ano}&mes=${mes}`,
};

const fmt = {
  currencyFull(v) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v || 0);
  },
  currencyCents(v) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v || 0);
  },
  // "R$ 1,41 mi", "R$ 801 mil", "−R$ 335 mil" (como no Power BI)
  currencyCompact(v) {
    const n = v || 0;
    const sinal = n < 0 ? '−' : '';
    return `${sinal}R$ ${fmt.compact(Math.abs(n))}`;
  },
  // sem o "R$": rótulos de gráfico
  compact(v) {
    const n = v || 0;
    const abs = Math.abs(n);
    const sinal = n < 0 ? '−' : '';
    if (abs >= 1e6) return `${sinal}${(abs / 1e6).toFixed(2).replace('.', ',')} mi`;
    if (abs >= 1e3) return `${sinal}${Math.round(abs / 1e3).toLocaleString('pt-BR')} mil`;
    return `${sinal}${Math.round(abs).toLocaleString('pt-BR')}`;
  },
  int(v) {
    return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(v || 0);
  },
  percent(v, decimals = 1) {
    const n = v || 0;
    return `${n < 0 ? '−' : ''}${Math.abs(n).toFixed(decimals).replace('.', ',')}%`;
  },
  signedPercent(v, decimals = 1) {
    return `${(v || 0) >= 0 ? '+' : ''}${fmt.percent(v, decimals)}`;
  },
  delta(current, previous) {
    if (previous === 0 || previous === undefined || previous === null) return { pct: null, direction: 'flat' };
    const pct = ((current - previous) / Math.abs(previous)) * 100;
    return { pct, direction: Math.abs(pct) < 0.05 ? 'flat' : pct > 0 ? 'up' : 'down' };
  },
  monthName(m) {
    return ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'][m - 1];
  },
  monthLong(m) {
    return ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'][m - 1];
  },
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
