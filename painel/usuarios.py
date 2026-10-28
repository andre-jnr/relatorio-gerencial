"""Usuários do painel (SQLite em dados/usuarios.db). Senhas só em hash (scrypt, do Werkzeug).

Superusuário: vê tudo e cadastra, ativa/desativa, exclui e redefine a senha dos outros usuários.
O primeiro superusuário é criado pelo terminal:  python -m painel.usuarios criar-super
"""
import getpass
import secrets
import sqlite3
import sys
import threading
import time
import unicodedata
from datetime import datetime

from werkzeug.security import check_password_hash, generate_password_hash

from .config import RAIZ

ARQUIVO = RAIZ / "dados" / "usuarios.db"
SENHA_MINIMA = 6
_trava = threading.Lock()


class ErroUsuario(Exception):
    """Mensagem que pode ir para a tela."""


def _conn():
    ARQUIVO.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(ARQUIVO, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("""CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        login TEXT NOT NULL UNIQUE,
        nome TEXT NOT NULL,
        senha_hash TEXT NOT NULL,
        super INTEGER NOT NULL DEFAULT 0,
        ativo INTEGER NOT NULL DEFAULT 1,
        versao TEXT NOT NULL,
        criado_em TEXT NOT NULL,
        criado_por TEXT,
        ultimo_acesso TEXT)""")
    return c


def normaliza_login(s):
    """'André' e 'andre' são o mesmo login: minúsculo, sem acento e sem espaços nas pontas."""
    s = unicodedata.normalize("NFD", str(s or "").strip().lower())
    return "".join(ch for ch in s if unicodedata.category(ch) != "Mn")


def _agora():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _publico(r):
    return {"id": r["id"], "login": r["login"], "nome": r["nome"], "super": bool(r["super"]),
            "ativo": bool(r["ativo"]), "criado_em": r["criado_em"], "criado_por": r["criado_por"],
            "ultimo_acesso": r["ultimo_acesso"]}


def _validar_senha(senha):
    if len(senha or "") < SENHA_MINIMA:
        raise ErroUsuario(f"A senha precisa ter pelo menos {SENHA_MINIMA} caracteres.")


# ------------------------------------------------------------------
# Tentativas de login: 5 erros seguidos bloqueiam o login (e o IP) por 5 minutos
# ------------------------------------------------------------------
_falhas = {}
LIMITE_FALHAS, BLOQUEIO_S = 5, 300


def _bloqueado(chave):
    n, ate = _falhas.get(chave, (0, 0))
    return n >= LIMITE_FALHAS and time.time() < ate


def _registrar_falha(chave):
    n, ate = _falhas.get(chave, (0, 0))
    if ate and time.time() >= ate:
        n = 0
    _falhas[chave] = (n + 1, time.time() + BLOQUEIO_S)


def autenticar(login, senha, ip):
    """Devolve o usuário (dict) ou levanta ErroUsuario com mensagem genérica."""
    login = normaliza_login(login)
    chaves = (f"login:{login}", f"ip:{ip}")
    with _trava:
        if any(_bloqueado(c) for c in chaves):
            raise ErroUsuario("Muitas tentativas erradas. Aguarde 5 minutos e tente de novo.")
        with _conn() as c:
            r = c.execute("SELECT * FROM usuarios WHERE login = ?", (login,)).fetchone()
            # compara mesmo sem usuário, para não revelar pelo tempo de resposta quem existe
            ok = check_password_hash(r["senha_hash"] if r else _HASH_FALSO, senha or "")
            if not (r and ok and r["ativo"]):
                for ch in chaves:
                    _registrar_falha(ch)
                raise ErroUsuario("Usuário ou senha incorretos.")
            for ch in chaves:
                _falhas.pop(ch, None)
            c.execute("UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?", (_agora(), r["id"]))
            return {**_publico(r), "versao": r["versao"]}


_HASH_FALSO = generate_password_hash(secrets.token_hex(16))


def por_sessao(uid, versao):
    """Usuário da sessão, se ainda ativo e com a mesma senha (trocar a senha derruba as outras sessões)."""
    with _conn() as c:
        r = c.execute("SELECT * FROM usuarios WHERE id = ?", (uid,)).fetchone()
    if not r or not r["ativo"] or r["versao"] != versao:
        return None
    return _publico(r)


def listar():
    with _conn() as c:
        return [_publico(r) for r in c.execute("SELECT * FROM usuarios ORDER BY super DESC, nome COLLATE NOCASE")]


def criar(nome, login, senha, super_=False, criado_por=None):
    nome = " ".join(str(nome or "").split())
    login = normaliza_login(login)
    if not nome or len(nome) > 80:
        raise ErroUsuario("Informe o nome (até 80 caracteres).")
    if not login or len(login) > 40 or not all(ch.isalnum() or ch in "._-" for ch in login):
        raise ErroUsuario("O login aceita só letras, números, ponto, hífen e sublinhado (até 40).")
    _validar_senha(senha)
    try:
        with _trava, _conn() as c:
            cur = c.execute(
                "INSERT INTO usuarios (login, nome, senha_hash, super, versao, criado_em, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (login, nome, generate_password_hash(senha), int(bool(super_)), secrets.token_hex(8), _agora(), criado_por))
            return cur.lastrowid
    except sqlite3.IntegrityError:
        raise ErroUsuario(f"Já existe um usuário com o login '{login}'.") from None


def _supers_ativos(c, exceto=None):
    return c.execute("SELECT COUNT(*) FROM usuarios WHERE super = 1 AND ativo = 1 AND id <> ?", (exceto or -1,)).fetchone()[0]


def alterar(uid, por_id, *, ativo=None, super_=None, nome=None):
    with _trava, _conn() as c:
        r = c.execute("SELECT * FROM usuarios WHERE id = ?", (uid,)).fetchone()
        if not r:
            raise ErroUsuario("Usuário não encontrado.")
        if uid == por_id and (ativo is False or super_ is False):
            raise ErroUsuario("Você não pode desativar nem tirar o acesso de superusuário de si mesmo.")
        if r["super"] and (ativo is False or super_ is False) and not _supers_ativos(c, exceto=uid):
            raise ErroUsuario("O painel precisa de pelo menos um superusuário ativo.")
        if nome is not None:
            nome = " ".join(str(nome).split())
            if not nome or len(nome) > 80:
                raise ErroUsuario("Informe o nome (até 80 caracteres).")
            c.execute("UPDATE usuarios SET nome = ? WHERE id = ?", (nome, uid))
        if ativo is not None:
            c.execute("UPDATE usuarios SET ativo = ? WHERE id = ?", (int(bool(ativo)), uid))
        if super_ is not None:
            c.execute("UPDATE usuarios SET super = ? WHERE id = ?", (int(bool(super_)), uid))


def definir_senha(uid, nova, senha_atual=None):
    """Com senha_atual: o próprio usuário trocando a senha. Sem: superusuário redefinindo."""
    _validar_senha(nova)
    with _trava, _conn() as c:
        r = c.execute("SELECT * FROM usuarios WHERE id = ?", (uid,)).fetchone()
        if not r:
            raise ErroUsuario("Usuário não encontrado.")
        if senha_atual is not None and not check_password_hash(r["senha_hash"], senha_atual):
            raise ErroUsuario("A senha atual está incorreta.")
        versao = secrets.token_hex(8)  # derruba as sessões abertas com a senha antiga
        c.execute("UPDATE usuarios SET senha_hash = ?, versao = ? WHERE id = ?", (generate_password_hash(nova), versao, uid))
        return versao


def excluir(uid, por_id):
    with _trava, _conn() as c:
        r = c.execute("SELECT * FROM usuarios WHERE id = ?", (uid,)).fetchone()
        if not r:
            raise ErroUsuario("Usuário não encontrado.")
        if uid == por_id:
            raise ErroUsuario("Você não pode excluir o próprio usuário.")
        if r["super"] and not _supers_ativos(c, exceto=uid):
            raise ErroUsuario("O painel precisa de pelo menos um superusuário ativo.")
        c.execute("DELETE FROM usuarios WHERE id = ?", (uid,))
        return r["login"]


def existe_algum():
    with _conn() as c:
        return c.execute("SELECT COUNT(*) FROM usuarios").fetchone()[0] > 0


# ------------------------------------------------------------------
# Terminal: python -m painel.usuarios criar-super
# ------------------------------------------------------------------
if __name__ == "__main__":
    if sys.argv[1:2] != ["criar-super"]:
        print("Uso: python -m painel.usuarios criar-super")
        sys.exit(1)
    nome = input("Nome: ")
    login = input("Login: ")
    senha = getpass.getpass("Senha: ")
    if senha != getpass.getpass("Repita a senha: "):
        print("As senhas não conferem.")
        sys.exit(1)
    try:
        criar(nome, login, senha, super_=True, criado_por="terminal")
        print(f"Superusuário '{normaliza_login(login)}' criado em {ARQUIVO}.")
    except ErroUsuario as e:
        print(f"ERRO: {e}")
        sys.exit(1)
