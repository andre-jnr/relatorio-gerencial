"""Acesso somente leitura ao SQL Server (SISMOURA) de cada loja, com mssql-python.

Cada consulta abre a própria conexão: assim as consultas de uma loja rodam em paralelo.
"""
import logging
from concurrent.futures import ThreadPoolExecutor

import mssql_python

from .config import credenciais

log = logging.getLogger("painel")

# READ UNCOMMITTED: não trava o PDV. NOCOUNT: o DECLARE não gera resultado vazio antes do SELECT.
_PREFIXO = "SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\n"

_pool = ThreadPoolExecutor(max_workers=12, thread_name_prefix="sql")


class ErroBanco(Exception):
    """Erro com mensagem segura para o navegador (sem servidor, banco, usuário ou senha)."""


def _string_conexao(fonte):
    usuario, senha = credenciais(fonte)
    esc = lambda v: "{" + str(v).replace("}", "}}") + "}"
    return (f"Server={fonte['servidor']};Database={fonte['banco']};UID={esc(usuario)};PWD={esc(senha)};"
            "Encrypt=yes;TrustServerCertificate=yes")


def _motivo(exc):
    """Resume o erro do driver em algo útil sem expor detalhes da infraestrutura."""
    t = str(exc).lower()
    if "login failed" in t or "18456" in t:
        return "usuário ou senha do banco recusados (confira o .env)"
    if "timeout" in t or "timed out" in t or "tempo" in t:
        return "o banco demorou demais para responder"
    if any(x in t for x in ("network", "server was not found", "could not open", "tcp provider", "named pipes", "08001")):
        return "o servidor do banco não respondeu (fora da rede ou desligado)"
    if "invalid object" in t or "invalid column" in t:
        return "a estrutura do banco é diferente da esperada"
    return "erro ao consultar o banco"


def consultar(fonte, sql, params=(), timeout=20):
    """Executa um SELECT e devolve a lista de linhas como dicionários."""
    if not sql.lstrip().upper().startswith(("SELECT", "DECLARE", "WITH")):
        raise ValueError("Somente consultas de leitura.")
    try:
        conn = mssql_python.connect(_string_conexao(fonte), timeout=timeout, autocommit=False)
    except Exception as e:  # noqa: BLE001
        log.error("Conexão falhou (%s / %s): %s", fonte["servidor"], fonte["banco"], e)
        raise ErroBanco(_motivo(e)) from None
    try:
        cur = conn.cursor()
        cur.execute(_PREFIXO + sql, *params)
        while cur.description is None and cur.nextset():
            pass
        colunas = [c[0] for c in cur.description]
        return [dict(zip(colunas, linha)) for linha in cur.fetchall()]
    except Exception as e:  # noqa: BLE001
        log.error("Consulta falhou (%s / %s): %s", fonte["servidor"], fonte["banco"], e)
        raise ErroBanco(_motivo(e)) from None
    finally:
        try:
            conn.rollback()
        finally:
            conn.close()


def consultar_varios(tarefas):
    """Roda várias consultas em paralelo. tarefas: {nome: (fonte, sql, params)} -> {nome: linhas}."""
    futuros = {nome: _pool.submit(consultar, *args) for nome, args in tarefas.items()}
    return {nome: f.result() for nome, f in futuros.items()}


def num(v):
    return 0.0 if v is None else float(v)
