"""PDF: o Chrome (ou o Edge) em modo invisível abre a página do painel em modo PDF e salva em
A4 paisagem (o @page do CSS), sem o diálogo de impressão.

  /api/pdf/iniciar?pagina=index.html&slug=&ano=&mes=  -> { id }
  /api/pdf/<id>  -> 202 enquanto gera; 200 com o PDF quando pronto
"""
import os
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

PASTA = Path(tempfile.gettempdir()) / "painel-gerencial-pdf"
LIMITE_S = 240
_jobs = {}
_trava = threading.Lock()


def achar_navegador():
    pf, pf86, local = os.getenv("ProgramFiles", ""), os.getenv("ProgramFiles(x86)", ""), os.getenv("LOCALAPPDATA", "")
    candidatos = [
        Path(pf) / "Google/Chrome/Application/chrome.exe",
        Path(pf86) / "Google/Chrome/Application/chrome.exe",
        Path(local) / "Google/Chrome/Application/chrome.exe",
        Path(pf86) / "Microsoft/Edge/Application/msedge.exe",
        Path(pf) / "Microsoft/Edge/Application/msedge.exe",
    ]
    return next((str(c) for c in candidatos if c.is_file()), None)


def iniciar(url):
    navegador = achar_navegador()
    if not navegador:
        return None
    PASTA.mkdir(parents=True, exist_ok=True)
    job_id = uuid.uuid4().hex
    arquivo = PASTA / f"{job_id}.pdf"
    perfil = PASTA / f"perfil-{job_id}"  # perfil próprio: não mexe no navegador aberto do usuário
    # o tempo virtual só avança com a página parada; consultas ao banco em andamento seguram a impressão
    args = [navegador, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
            "--disable-extensions", f"--user-data-dir={perfil}", "--no-pdf-header-footer",
            "--window-size=1060,740",  # largura útil da folha A4 paisagem: os gráficos já saem do tamanho certo
            "--virtual-time-budget=120000", f"--print-to-pdf={arquivo}", url]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    with _trava:
        _jobs[job_id] = {"proc": proc, "arquivo": arquivo, "perfil": perfil, "inicio": time.time()}
    return job_id


def _remover(job_id):
    with _trava:
        job = _jobs.pop(job_id, None)
    if job:
        try:
            job["arquivo"].unlink(missing_ok=True)
        except OSError:
            pass
        shutil.rmtree(job["perfil"], ignore_errors=True)


def situacao(job_id):
    """('inexistente'|'gerando'|'demorou'|'falhou', None) ou ('pronto', bytes)."""
    job = _jobs.get(job_id)
    if not job:
        return "inexistente", None
    if job["proc"].poll() is None:
        if time.time() - job["inicio"] > LIMITE_S:
            job["proc"].kill()
            _remover(job_id)
            return "demorou", None
        return "gerando", None
    if not job["arquivo"].exists() or job["arquivo"].stat().st_size == 0:
        _remover(job_id)
        return "falhou", None
    conteudo = job["arquivo"].read_bytes()
    _remover(job_id)
    return "pronto", conteudo
