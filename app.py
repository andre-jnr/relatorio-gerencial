"""Painel gerencial das lojas (dados ao vivo do SQL Server SISMOURA).

  python app.py             -> modo local: só este computador (http://localhost:PORTA)
  python app.py --producao  -> servidor da empresa: Waitress, aceita acesso da rede

Quais lojas aparecem é decidido por LOJAS no .env; as outras nunca são consultadas.
"""
import json
import logging
import re
import socket
import sys
import threading
import time
from datetime import date

from flask import Flask, Response, abort, request, send_from_directory

from painel import pdf, planilhas, relatorios
from painel.banco import ErroBanco
from painel.config import CACHE_MINUTOS, LOJAS, LOJAS_DESCONHECIDAS, PORTA, RAIZ, loja
from painel.planilhas import ErroPlanilha

PORTA_OCUPADA = 3  # código de saída usado por servidor/iniciar.ps1 para não ficar tentando de novo
WEB = RAIZ / "web"
PAGINAS = {"index.html", "pagamentos.html", "conta-contabil.html"}

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
log = logging.getLogger("painel")

app = Flask(__name__, static_folder=None)
app.json.ensure_ascii = False


# ------------------------------------------------------------------
# Cache: uma consulta por chave de cada vez (dois usuários abrindo a mesma loja = uma consulta)
# ------------------------------------------------------------------
_cache = {}
_travas = {}
_trava_global = threading.Lock()


def _trava(chave):
    with _trava_global:
        return _travas.setdefault(chave, threading.Lock())


def _em_cache(chave, gerar, atualizar):
    """O mês em andamento muda a cada dia: o cache não atravessa a meia-noite."""
    with _trava(chave):
        item = _cache.get(chave)
        if (not atualizar and item and time.time() - item["quando"] < CACHE_MINUTOS * 60
                and item["dia"] == date.today()):
            return item["json"]
        texto = json.dumps(gerar(), ensure_ascii=False, separators=(",", ":"))
        _cache[chave] = {"json": texto, "quando": time.time(), "dia": date.today()}
        return texto


def _json(obj, status=200):
    texto = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    return Response(texto, status=status, mimetype="application/json")


def _erro(msg, status):
    return _json({"erro": msg}, status)


def _planilhas_ok():
    if planilhas.atualizar(LOJAS):
        _cache.clear()  # planilha alterada: o cache de todas as lojas fica velho


def _loja_ou_404(slug):
    u = loja(slug)
    if not u:
        abort(_erro("Loja não habilitada neste painel.", 404))
    return u


def _ano_mes(permite_ano_inteiro=False):
    hoje = date.today()
    try:
        ano, mes = int(request.args.get("ano", "")), int(request.args.get("mes", ""))
    except ValueError:
        ano = mes = -1
    minimo = 0 if permite_ano_inteiro else 1
    if not (2000 <= ano <= hoje.year and minimo <= mes <= 12) or (mes and ano * 12 + mes > hoje.year * 12 + hoje.month):
        abort(_erro("Informe um ano e mês válidos (até o mês atual).", 400))
    return ano, mes


def _consultar(u, chave, gerar, descricao):
    inicio = time.time()
    try:
        _planilhas_ok()
        texto = _em_cache(chave, gerar, request.args.get("atualizar") == "1")
        log.info("%s de %s: %.1fs", descricao, u["nome"], time.time() - inicio)
        return _json(texto)
    except ErroBanco as e:
        return _erro(f"Não foi possível consultar {u['nome']}: {e}.", 502)
    except ErroPlanilha as e:
        log.error("Planilha: %s", e)
        return _erro(f"Falha ao ler a planilha: {e}.", 502)
    except Exception:  # noqa: BLE001
        log.exception("Erro inesperado (%s)", descricao)
        return _erro("Erro inesperado no servidor do painel. Veja o log.", 500)


# ------------------------------------------------------------------
# API
# ------------------------------------------------------------------
@app.get("/api/ping")
def ping():
    return _json({"painel": True})


@app.get("/api/unidades")
def unidades():
    # só slug e nome: servidor, banco e usuários nunca vão para o navegador
    return _json([{"slug": u["slug"], "nome": u["nome"]} for u in LOJAS])


@app.get("/api/dados/<slug>")
def dados(slug):
    u = _loja_ou_404(slug)
    return _consultar(u, f"dados|{slug}", lambda: relatorios.dados_unidade(u), "Visão geral")


@app.get("/api/conta-contabil/<slug>")
def conta_contabil(slug):
    u = _loja_ou_404(slug)
    ano, mes = _ano_mes(permite_ano_inteiro=True)
    sem_boi = request.args.get("sem_boi_anterior") == "1"
    return _consultar(u, f"conta|{slug}|{ano}|{mes}|{sem_boi}",
                      lambda: relatorios.pagamentos_por_conta(u, ano, mes, sem_boi), "Análise por conta contábil")


@app.get("/api/pagamentos/<slug>")
def pagamentos(slug):
    u = _loja_ou_404(slug)
    restos = request.args.get("restos_boi") == "1"
    if restos and not u.get("conta_boi"):
        return _erro(f"A loja {u['nome']} não tem conta de boi configurada.", 400)
    desconsiderados = request.args.get("desconsiderados") == "1"
    ano, mes = _ano_mes(permite_ano_inteiro=restos or desconsiderados)
    return _consultar(u, f"lista|{slug}|{ano}|{mes}|{restos}|{desconsiderados}",
                      lambda: relatorios.lista_pagamentos(u, ano, mes, restos, desconsiderados), "Lista de pagamentos")


@app.get("/api/pdf/iniciar")
def pdf_iniciar():
    q = request.args
    pagina = q.get("pagina", "")
    if pagina not in PAGINAS:
        return _erro("Página inválida para PDF.", 400)
    # só repassa parâmetros conhecidos e validados para a URL da página
    partes = []
    if q.get("slug"):
        if not loja(q["slug"]):
            return _erro("Loja inválida.", 400)
        partes.append(f"slug={q['slug']}")
    if not re.fullmatch(r"\d{4}", q.get("ano", "")):
        return _erro("Ano inválido.", 400)
    partes.append(f"ano={q['ano']}")
    if q.get("mes") != "all" and not re.fullmatch(r"1[0-2]|[1-9]", q.get("mes", "")):
        return _erro("Mês inválido.", 400)
    partes.append(f"mes={q['mes']}")
    for nome, valor in (("boi", "1"), ("restos", "boi"), ("visao", "desconsiderados")):
        if q.get(nome) == valor:
            partes.append(f"{nome}={valor}")
    if re.fullmatch(r"[01]", q.get("plano", "")):
        partes.append(f"plano={q['plano']}")
    if q.get("ordem"):
        if not re.fullmatch(r"[a-z_]{1,20}:(asc|desc)", q["ordem"]):
            return _erro("Ordem inválida.", 400)
        partes.append(f"ordem={q['ordem']}")
    if q.get("busca"):
        from urllib.parse import quote
        partes.append("busca=" + quote(q["busca"][:120]))
    job = pdf.iniciar(f"http://127.0.0.1:{PORTA}/{pagina}?pdf=1&" + "&".join(partes))
    if not job:
        return _json({"erro": "Chrome ou Edge não encontrado neste computador.", "sem_navegador": True}, 501)
    log.info("Gerando PDF de %s...", pagina)
    return _json({"id": job})


@app.get("/api/pdf/<job_id>")
def pdf_baixar(job_id):
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        abort(404)
    estado, conteudo = pdf.situacao(job_id)
    if estado == "gerando":
        return _json({"pronto": False}, 202)
    if estado == "pronto":
        return Response(conteudo, mimetype="application/pdf")
    mensagens = {
        "inexistente": ("PDF não encontrado (o servidor foi reiniciado?).", 404),
        "demorou": ("O PDF demorou demais para ser gerado (as consultas ao banco podem estar lentas). Tente de novo.", 504),
        "falhou": ("O navegador terminou sem gerar o PDF.", 500),
    }
    return _erro(*mensagens[estado])


# ------------------------------------------------------------------
# Páginas: só as do painel e a pasta assets/ (o .env, config/ e dados/ nunca são servidos)
# ------------------------------------------------------------------
@app.get("/")
def inicio():
    return send_from_directory(WEB, "index.html")


@app.get("/<pagina>")
def pagina(pagina):
    if pagina not in PAGINAS:
        abort(404)
    return send_from_directory(WEB, pagina)


@app.get("/assets/<path:arquivo>")
def assets(arquivo):
    return send_from_directory(WEB / "assets", arquivo)


@app.after_request
def cabecalhos(resp):
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    return resp


# ------------------------------------------------------------------
def porta_em_uso(porta):
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", porta)) == 0


if __name__ == "__main__":
    producao = "--producao" in sys.argv
    if porta_em_uso(PORTA):
        print(f"ERRO: a porta {PORTA} já está em uso.", file=sys.stderr)
        sys.exit(PORTA_OCUPADA)
    if LOJAS_DESCONHECIDAS:
        log.warning("LOJAS no .env tem slug(s) sem cadastro em config/unidades.json: %s", ", ".join(LOJAS_DESCONHECIDAS))
    if not LOJAS:
        log.warning("Nenhuma loja habilitada: preencha LOJAS no .env.")
    log.info("Lojas habilitadas: %s", ", ".join(u["nome"] for u in LOJAS) or "nenhuma")
    if producao:
        from waitress import serve
        log.info("Escutando na rede: http://%s:%d", socket.gethostname(), PORTA)
        serve(app, host="0.0.0.0", port=PORTA, threads=8, ident="painel")
    else:
        log.info("Painel local: http://localhost:%d", PORTA)
        app.run(host="127.0.0.1", port=PORTA, debug=False, threaded=True)
