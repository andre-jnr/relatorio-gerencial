// ============================================================
// Página "Usuários" (só superusuário): cadastrar, redefinir senha,
// ativar/desativar, dar/tirar superusuário e excluir.
// ============================================================
const Usuarios = (() => {
  let lista = [];
  let eu = null;
  const qs = (id) => document.getElementById(id);

  function tema() {
    let salvo = null;
    try { salvo = localStorage.getItem('painel.theme'); } catch (e) { /* sem storage */ }
    const escuro = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', salvo || (escuro ? 'dark' : 'light'));
    qs('theme-toggle').addEventListener('click', () => {
      const prox = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', prox);
      try { localStorage.setItem('painel.theme', prox); } catch (e) { /* sem storage */ }
    });
  }

  const dataBR = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)} ${s.slice(11, 16)}` : '—');

  // "André Luiz" -> "andre.luiz"
  function sugerirLogin(nome) {
    const p = nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    return p.length > 1 ? `${p[0]}.${p[p.length - 1]}` : (p[0] || '');
  }

  // ---------------- janelas ----------------
  function janela(html, aoEnviar) {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialogo';
    dlg.innerHTML = `<form class="dialogo-corpo" novalidate>${html}
      <p class="login-erro" role="alert" hidden></p>
      <div class="dialogo-acoes">
        <button type="button" class="btn" data-cancelar>Cancelar</button>
        <button type="submit" class="btn btn--primary" data-ok>Salvar</button>
      </div></form>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector('form');
    const erro = dlg.querySelector('.login-erro');
    dlg.querySelector('[data-cancelar]').onclick = () => dlg.close();
    dlg.addEventListener('close', () => dlg.remove());
    form.onsubmit = async (e) => {
      e.preventDefault();
      erro.hidden = true;
      const ok = dlg.querySelector('[data-ok]');
      ok.disabled = true;
      try {
        await aoEnviar(new FormData(form));
        dlg.close();
        await carregar();
      } catch (err) {
        erro.textContent = err.message;
        erro.hidden = false;
      } finally {
        ok.disabled = false;
      }
    };
    dlg.showModal();
    return dlg;
  }

  function novo() {
    const dlg = janela(`
      <h2>Novo usuário</h2>
      <p class="dialogo-sub">Passe o login e a senha para a pessoa. Ela pode trocar a senha depois, no menu do avatar.</p>
      <label class="campo"><span>Nome</span><input name="nome" maxlength="80" required autocomplete="off" /></label>
      <label class="campo"><span>Login</span><input name="login" maxlength="40" required autocomplete="off" autocapitalize="none" spellcheck="false" /></label>
      <label class="campo"><span>Senha inicial</span><input name="senha" type="password" minlength="6" required autocomplete="new-password" /></label>
      <label class="campo"><span>Repita a senha</span><input name="senha2" type="password" required autocomplete="new-password" /></label>
      <label class="switch switch--pequeno"><input type="checkbox" name="super" /><span class="switch-track" aria-hidden="true"></span><span>Superusuário (pode cadastrar outros usuários)</span></label>`,
    async (f) => {
      if (f.get('senha') !== f.get('senha2')) throw new Error('As senhas não conferem.');
      await Sessao.enviar('/api/usuarios', 'POST', { nome: f.get('nome'), login: f.get('login'), senha: f.get('senha'), super: f.get('super') === 'on' });
      PDF.aviso(`Usuário ${f.get('login')} criado.`, 'ok');
    });
    const nome = dlg.querySelector('[name="nome"]');
    const login = dlg.querySelector('[name="login"]');
    let editado = false;
    login.oninput = () => { editado = true; };
    nome.oninput = () => { if (!editado) login.value = sugerirLogin(nome.value); };
  }

  function redefinir(u) {
    janela(`
      <h2>Redefinir senha</h2>
      <p class="dialogo-sub">${escapeHtml(u.nome)} (${escapeHtml(u.login)}) sai do painel e entra de novo com a nova senha.</p>
      <label class="campo"><span>Nova senha</span><input name="senha" type="password" minlength="6" required autocomplete="new-password" /></label>
      <label class="campo"><span>Repita a senha</span><input name="senha2" type="password" required autocomplete="new-password" /></label>`,
    async (f) => {
      if (f.get('senha') !== f.get('senha2')) throw new Error('As senhas não conferem.');
      await Sessao.enviar(`/api/usuarios/${u.id}/senha`, 'PUT', { senha: f.get('senha') });
      PDF.aviso('Senha redefinida.', 'ok');
    });
  }

  function confirmarExclusao(u) {
    const dlg = janela(`
      <h2>Excluir usuário</h2>
      <p class="dialogo-sub">Excluir <strong>${escapeHtml(u.nome)}</strong> (${escapeHtml(u.login)})? Isso não pode ser desfeito. Para só bloquear o acesso, use Desativar.</p>`,
    async () => {
      await Sessao.enviar(`/api/usuarios/${u.id}`, 'DELETE');
      PDF.aviso('Usuário excluído.', 'ok');
    });
    const ok = dlg.querySelector('[data-ok]');
    ok.textContent = 'Excluir';
    ok.classList.add('btn--perigo');
  }

  async function alterar(u, dados, msg) {
    try {
      await Sessao.enviar(`/api/usuarios/${u.id}`, 'PATCH', dados);
      PDF.aviso(msg, 'ok');
    } catch (e) {
      PDF.aviso(e.message, 'erro');
    }
    await carregar();
  }

  // ---------------- lista ----------------
  function render() {
    const ativos = lista.filter((u) => u.ativo).length;
    const supers = lista.filter((u) => u.super && u.ativo).length;
    qs('resumo').innerHTML = [
      ['Usuários', lista.length], ['Ativos', ativos], ['Desativados', lista.length - ativos], ['Superusuários', supers],
    ].map(([l, v], i) => `<div class="kpi-mini" style="animation-delay:${i * 40}ms"><span class="kpi-mini-label">${l}</span><div class="kpi-mini-row"><span class="kpi-mini-value">${v}</span></div></div>`).join('');

    qs('lista').innerHTML = lista.length ? lista.map((u) => {
      const proprio = eu && u.login === eu.login;
      return `<tr class="${u.ativo ? '' : 'is-inativo'}">
        <td class="col-txt"><span class="usuario-nome"><i class="avatar avatar--p">${escapeHtml(u.nome.split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase())}</i>${escapeHtml(u.nome)}${proprio ? ' <small>(você)</small>' : ''}</span></td>
        <td class="col-txt">${escapeHtml(u.login)}</td>
        <td class="col-txt">${u.super ? '<span class="selo selo--super">Superusuário</span>' : '<span class="selo">Usuário</span>'}</td>
        <td class="col-txt">${u.ativo ? '<span class="selo selo--ativo">Ativo</span>' : '<span class="selo selo--inativo">Desativado</span>'}</td>
        <td class="col-txt">${dataBR(u.ultimo_acesso)}</td>
        <td class="col-txt">${escapeHtml(u.criado_por || '—')}</td>
        <td class="col-num"><div class="acoes">
          <button type="button" class="btn-ghost" data-acao="senha" data-id="${u.id}">Redefinir senha</button>
          ${proprio ? '' : `
          <button type="button" class="btn-ghost" data-acao="super" data-id="${u.id}">${u.super ? 'Tirar super' : 'Tornar super'}</button>
          <button type="button" class="btn-ghost" data-acao="ativo" data-id="${u.id}">${u.ativo ? 'Desativar' : 'Ativar'}</button>
          <button type="button" class="btn-ghost btn-ghost--perigo" data-acao="excluir" data-id="${u.id}">Excluir</button>`}
        </div></td>
      </tr>`;
    }).join('') : '<tr class="matriz-vazia"><td colspan="7">Nenhum usuário.</td></tr>';
  }

  async function carregar() {
    try {
      const res = await fetch('/api/usuarios', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.erro || `Erro ${res.status}`);
      lista = body;
      render();
    } catch (e) {
      qs('lista').innerHTML = `<tr class="matriz-vazia"><td colspan="7">${escapeHtml(e.message)}</td></tr>`;
    }
  }

  async function init() {
    tema();
    try { eu = await (await fetch('/api/eu', { cache: 'no-store' })).json(); } catch (e) { /* segue sem marcar "você" */ }
    qs('btn-novo').onclick = novo;
    qs('lista').addEventListener('click', (e) => {
      const b = e.target.closest('[data-acao]');
      if (!b) return;
      const u = lista.find((x) => x.id === Number(b.dataset.id));
      if (!u) return;
      if (b.dataset.acao === 'senha') redefinir(u);
      if (b.dataset.acao === 'excluir') confirmarExclusao(u);
      if (b.dataset.acao === 'ativo') alterar(u, { ativo: !u.ativo }, u.ativo ? 'Usuário desativado.' : 'Usuário ativado.');
      if (b.dataset.acao === 'super') alterar(u, { super: !u.super }, u.super ? 'Agora é usuário comum.' : 'Agora é superusuário.');
    });
    await carregar();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
