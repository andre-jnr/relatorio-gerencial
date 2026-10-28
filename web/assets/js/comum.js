// ============================================================
// Comum a todas as páginas logadas: sessão expirada volta ao login,
// menu do usuário (trocar a própria senha, sair) e o item "Usuários"
// do menu lateral, que só aparece para o superusuário.
// ============================================================
const Sessao = (() => {
  // qualquer chamada da API com 401 (sessão expirada ou usuário desativado) leva ao login
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await fetchOriginal(...args);
    const url = String(args[0] instanceof Request ? args[0].url : args[0]);
    if (res.status === 401 && url.includes('/api/') && !url.includes('/api/login')) {
      location.href = `/login?volta=${encodeURIComponent(location.pathname + location.search)}`;
      return new Promise(() => {}); // a página está saindo: não deixa o erro aparecer
    }
    return res;
  };

  async function enviar(url, metodo, dados) {
    const res = await fetch(url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados || {}) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.erro || `Erro ${res.status}`);
    return body;
  }

  const iniciais = (nome) => nome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

  // ---------------- janela "Minha senha" ----------------
  function abrirMinhaSenha() {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialogo';
    dlg.innerHTML = `
      <form method="dialog" class="dialogo-corpo" novalidate>
        <h2>Trocar minha senha</h2>
        <p class="dialogo-sub">As outras sessões abertas com a senha antiga serão encerradas.</p>
        <label class="campo"><span>Senha atual</span><input type="password" name="atual" autocomplete="current-password" required /></label>
        <label class="campo"><span>Nova senha</span><input type="password" name="nova" autocomplete="new-password" minlength="6" required /></label>
        <label class="campo"><span>Repita a nova senha</span><input type="password" name="nova2" autocomplete="new-password" required /></label>
        <p class="login-erro" role="alert" hidden></p>
        <div class="dialogo-acoes">
          <button type="button" class="btn" value="cancelar">Cancelar</button>
          <button type="submit" class="btn btn--primary">Salvar</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector('form');
    const erro = dlg.querySelector('.login-erro');
    dlg.querySelector('[value="cancelar"]').onclick = () => dlg.close();
    dlg.addEventListener('close', () => dlg.remove());
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      erro.hidden = true;
      if (f.get('nova') !== f.get('nova2')) { erro.textContent = 'As novas senhas não conferem.'; erro.hidden = false; return; }
      try {
        await enviar('/api/minha-senha', 'PUT', { atual: f.get('atual'), nova: f.get('nova') });
        dlg.close();
        if (window.PDF) PDF.aviso('Senha alterada.', 'ok');
      } catch (err) { erro.textContent = err.message; erro.hidden = false; }
    };
    dlg.showModal();
  }

  // ---------------- menu do usuário no trilho ----------------
  function montarMenu(eu) {
    const foot = document.querySelector('.rail-foot');
    if (!foot) return;
    const wrap = document.createElement('div');
    wrap.className = 'usuario-menu';
    wrap.innerHTML = `
      <button type="button" class="avatar" aria-haspopup="menu" aria-expanded="false" title="${escapeHtml(eu.nome)}">${escapeHtml(iniciais(eu.nome))}</button>
      <div class="usuario-pop" role="menu" hidden>
        <div class="usuario-quem"><strong>${escapeHtml(eu.nome)}</strong><span>${escapeHtml(eu.login)}${eu.super ? ' · superusuário' : ''}</span></div>
        <button type="button" role="menuitem" data-acao="senha">Trocar minha senha</button>
        <button type="button" role="menuitem" data-acao="sair">Sair</button>
      </div>`;
    foot.appendChild(wrap);
    const btn = wrap.querySelector('.avatar');
    const pop = wrap.querySelector('.usuario-pop');
    const fechar = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.onclick = (e) => {
      e.stopPropagation();
      pop.hidden = !pop.hidden;
      btn.setAttribute('aria-expanded', String(!pop.hidden));
    };
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) fechar(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fechar(); });
    pop.querySelector('[data-acao="senha"]').onclick = () => { fechar(); abrirMinhaSenha(); };
    pop.querySelector('[data-acao="sair"]').onclick = async () => {
      // quem sai do painel do CD volta para ele ao entrar de novo
      try { await enviar('/api/sair', 'POST'); } finally { location.href = CONFIG.escopo ? '/login?volta=%2Fcd%2F' : '/login'; }
    };
  }

  async function iniciar() {
    if (new URLSearchParams(location.search).get('pdf') === '1') return; // PDF: sem menus
    try {
      const res = await fetch('/api/eu', { cache: 'no-store' });
      if (!res.ok) return;
      const eu = await res.json();
      document.querySelectorAll('[data-super]').forEach((el) => { el.hidden = !eu.super; });
      montarMenu(eu);
    } catch (e) { /* servidor fora do ar: a própria página mostra o erro */ }
  }

  document.addEventListener('DOMContentLoaded', iniciar);
  return { enviar };
})();
