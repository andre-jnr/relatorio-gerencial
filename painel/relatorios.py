"""Relatórios do painel. Fórmulas (medidas DAX do relatório original):

  Total vendas   = SUM(Venda.Valor_Final)                 Cancelada = 'N'
  Total transf.  = SUM(Fiscal_NF.Total_NF)                NFe AUTORIZADA, CFOPs de transferência
  Pagamentos     = SUM(Contas_Pagar.Valor_Pago)           por Data_Pagamento, exceto contas excluídas
  Faturamento    = Total vendas + Total transf.
  Resultado e lucratividade são calculados no navegador.

Regras por unidade (config/unidades.json):
  contas_excluidas_pagamentos  fora dos pagamentos; "incluir_contas" traz alguma de volta para a unidade
  contas_ignoradas             fora de todos os relatórios
  fator_contas                 fração do valor lançado que entra (ex.: CD, 60% da energia)
  lancamentos_ignorados        códigos de Contas_Pagar desconsiderados
  vendas_adicionais            vendas de outros servidores somadas às da unidade (Parque Dez + Flores)
  pagamentos_de                servidor/banco de onde vêm as contas pagas, no lugar do da unidade (Flores)
  somente_contas               só estas contas entram nos pagamentos (mesmo se estiverem nas excluídas)
  transferencias_marcadas      "excluir" ou "incluir" as transferências recebidas cuja nota (rodapé do XML)
                               ou observação cita outra loja (palavras na regra de mesmo nome, no topo)
  transferencias_cd            transferências do CD (planilha) lançadas como pagamento da loja
  planilha_vendas              faturamento vindo da planilha (CD), com estoque
  conta_boi                    CD: boi emitido em ano anterior ao do pagamento pode ficar fora do ano
A comparação de contas ignora maiúsculas, acentos e espaços (a grafia varia entre os bancos).
"""
import threading
from datetime import date, datetime, timezone

from . import planilhas
from .banco import consultar, consultar_varios, num
from .config import CFG, MESES_HISTORICO, TODAS, chave_conta, normaliza

MESES_LABEL = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"]
NAO_CLASSIFICADOS = "PAGAMENTOS NÃO CLASSIFICADOS"
CONTA_SEM_ESPACO = "REPLACE(ISNULL(cc.Descricao, ''), ' ', '') COLLATE Latin1_General_CI_AI"
PERIODO = "DECLARE @ini DATETIME = ?; DECLARE @fim DATETIME = ?;\n"


def agora_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def soma_meses(d, n):
    m = d.year * 12 + d.month - 1 + n
    return date(m // 12, m % 12 + 1, 1)


def _dt(d):
    return datetime(d.year, d.month, d.day)


def _sql_texto(s):
    return "N'" + str(s).replace("'", "''") + "'"


# ------------------------------------------------------------------
# Filtros por unidade
# ------------------------------------------------------------------
def _incluidas(u):
    return {chave_conta(c) for c in u.get("incluir_contas", []) + u.get("somente_contas", []) if c}


def _fonte_pagamentos(u):
    """Banco das contas pagas: o da unidade ou o de "pagamentos_de" (Flores: pagas pelo banco da Parque Dez)."""
    p = u.get("pagamentos_de")
    return {"nome": u["nome"], **p} if p else u


# ------------------------------------------------------------------
# Transferências recebidas que são de outra loja ("transferencias_marcadas"): a nota vem no CNPJ da
# unidade, mas o rodapé do XML (infCpl, em Entrada_Produto) ou a observação da conta a pagar citam
# a outra loja. Em duas consultas leves: as contas a pagar da conta de transferência e, só para as
# notas delas, o rodapé (o XML é pesado: lido uma vez e guardado, porque não muda depois de salvo).
# ------------------------------------------------------------------
SQL_TRANSF_RECEBIDAS = """DECLARE @ini DATETIME = ?;
SELECT cp.Codigo, cp.Codigo_Entrada, CAST(cp.Observacao AS NVARCHAR(MAX)) AS Observacao, e.Chave_NFE
FROM Contas_Pagar cp
INNER JOIN Conta_Contabil cc ON cc.Codigo = cp.Conta_Contabil
LEFT JOIN Entrada_Produto e ON e.Chave = cp.Codigo_Entrada
WHERE """ + CONTA_SEM_ESPACO + """ = __CONTA__
  AND (cp.Data_Pagamento >= @ini OR cp.Data_Emissao >= @ini);"""

# Notas de transferência emitidas pelas outras unidades ("emissores") com as palavras no rodapé
# (Fiscal_NF.Dados_Adicionais_Manuais): pegam também as notas que a unidade ainda não lançou
SQL_TRANSF_EMITIDAS = """DECLARE @ini DATETIME = ?;
SELECT fe.Chave_Acesso AS Chave, f.Data_Emissao, f.Total_NF, f.CFOP,
       CAST(f.Dados_Adicionais_Manuais AS NVARCHAR(MAX)) AS Rodape
FROM Fiscal_NF f
INNER JOIN Fiscal_NFe fe ON fe.Codigo_Fiscal_NF = f.Codigo
WHERE f.CFOP IN ('5.152', '5.409', '5.557', '5.552') AND fe.Situacao = 'AUTORIZADA'
  AND f.Data_Emissao >= @ini
  AND (__CITA__);"""

SQL_RODAPES = """SELECT e.Chave, CASE WHEN p.I > 0 AND p.F > p.I THEN SUBSTRING(x.X, p.I + 8, p.F - p.I - 8) END AS Rodape
FROM Entrada_Produto e
CROSS APPLY (SELECT CAST(e.Conteudo_Arquivo_Xml AS NVARCHAR(MAX)) AS X) x
CROSS APPLY (SELECT CHARINDEX('<infCpl>', x.X) AS I, CHARINDEX('</infCpl>', x.X) AS F) p
WHERE e.Chave IN (__CHAVES__);"""

_rodapes = {}  # (servidor, banco, chave da entrada) -> rodapé da nota
_trava_rodapes = threading.Lock()


def _regra_transf():
    regra = CFG.get("transferencias_marcadas") or {}
    palavras = [chave_conta(p) for p in regra.get("palavras", []) if p]
    return (regra, palavras) if regra.get("conta") and palavras else (None, [])


def _transf_lancadas(u):
    regra, _ = _regra_transf()
    desde = datetime.fromisoformat(regra.get("desde") or "2000-01-01")
    sql = SQL_TRANSF_RECEBIDAS.replace("__CONTA__", _sql_texto(chave_conta(regra["conta"])))
    return consultar(_fonte_pagamentos(u), sql, (desde,))


def _marcadas(u, contas=None):
    """{código da conta a pagar: rodapé da nota} das transferências que citam a outra loja."""
    regra, palavras = _regra_transf()
    if not (u.get("transferencias_marcadas") in ("incluir", "excluir") and regra):
        return {}
    fonte = _fonte_pagamentos(u)
    if contas is None:
        contas = _transf_lancadas(u)
    with _trava_rodapes:
        faltam = sorted({int(c["Codigo_Entrada"]) for c in contas if c["Codigo_Entrada"] is not None}
                        - {k[2] for k in _rodapes if k[:2] == (fonte["servidor"], fonte["banco"])})
        for i in range(0, len(faltam), 200):
            lote = faltam[i:i + 200]
            achados = {int(r["Chave"]): r["Rodape"] or "" for r in
                       consultar(fonte, SQL_RODAPES.replace("__CHAVES__", ", ".join(map(str, lote))), timeout=60)}
            for chave in lote:
                _rodapes[(fonte["servidor"], fonte["banco"], chave)] = " ".join(achados.get(chave, "").split())
        rodapes = {c["Codigo"]: _rodapes.get((fonte["servidor"], fonte["banco"], c["Codigo_Entrada"]), "") for c in contas}
    cita = lambda texto: any(p in chave_conta(texto) for p in palavras)
    return {int(c["Codigo"]): rodapes[c["Codigo"]] for c in contas
            if cita(c["Observacao"] or "") or cita(rodapes[c["Codigo"]])}


def _so_digitos(s):
    return "".join(ch for ch in str(s or "") if ch.isdigit())


def transf_nao_lancadas(u):
    """Notas emitidas pelas outras unidades para a outra loja (rodapé) que ainda não viraram conta a
    pagar na conta de transferência da unidade pagadora. Entram como pagamento pela data de emissão:
    na Flores ("incluir") e na Parque Dez + Flores ("completar"). Quando a nota for lançada e paga,
    ela sai daqui e passa a contar pela conta a pagar (sem contar duas vezes)."""
    regra, palavras = _regra_transf()
    if not regra or u.get("transferencias_marcadas") not in ("incluir", "completar"):
        return []
    desde = datetime.fromisoformat(regra.get("desde") or "2000-01-01")
    texto = "REPLACE(CAST(f.Dados_Adicionais_Manuais AS NVARCHAR(MAX)), ' ', '') COLLATE Latin1_General_CI_AI"
    cita = " OR ".join(f"{texto} LIKE {_sql_texto('%' + p + '%')}" for p in palavras)
    emissores = [TODAS[s] for s in regra.get("emissores", []) if s in TODAS]
    tarefas = {e["slug"]: (e, SQL_TRANSF_EMITIDAS.replace("__CITA__", cita), (desde,), 60) for e in emissores}  # Morada demora a conectar
    tarefas["_lancadas"] = (_fonte_pagamentos(u), SQL_TRANSF_RECEBIDAS.replace("__CONTA__", _sql_texto(chave_conta(regra["conta"]))), (desde,))
    r = consultar_varios(tarefas)
    lancadas = {_so_digitos(c["Chave_NFE"])[-44:] for c in r["_lancadas"] if c["Chave_NFE"]}
    notas = []
    for e in emissores:
        for n in r[e["slug"]]:
            chave = _so_digitos(n["Chave"])[-44:]
            if chave in lancadas:
                continue
            emissao = n["Data_Emissao"].date() if isinstance(n["Data_Emissao"], datetime) else n["Data_Emissao"]
            notas.append({"chave": chave, "nf": chave[25:34].lstrip("0") if len(chave) == 44 else "", "emissor": e["nome"],
                          "emissao": emissao, "valor": num(n["Total_NF"]), "cfop": n["CFOP"],
                          "rodape": " ".join((n["Rodape"] or "").split())})
    return notas


def _sql_codigos(codigos):
    return f"cp.Codigo IN ({', '.join(map(str, sorted(codigos)))})" if codigos else "1 = 0"


def _sql_somente(u, marcadas):
    """Filtros da unidade: "somente_contas" e "transferencias_marcadas" ("excluir" ou "incluir")."""
    contas = [c for c in u.get("somente_contas", []) if c]
    filtro = ""
    if contas:
        filtro = f"{CONTA_SEM_ESPACO} IN (" + ", ".join(_sql_texto(chave_conta(c)) for c in contas) + ")"
        if u.get("transferencias_marcadas") == "incluir":
            filtro = f"({filtro} OR {_sql_codigos(marcadas)})"
        filtro = f"AND {filtro}"
    if u.get("transferencias_marcadas") == "excluir":
        filtro += f" AND NOT {_sql_codigos(marcadas)}"
    return filtro


def _fatores(u):
    return {chave_conta(k): float(v) for k, v in (u.get("fator_contas") or {}).items()}


def _sql_excluidas(u):
    inc = _incluidas(u)
    contas = [c for c in CFG.get("contas_excluidas_pagamentos", []) + CFG.get("contas_ignoradas", [])
              if c and chave_conta(c) not in inc]
    return ", ".join(_sql_texto(str(c).replace(" ", "")) for c in contas) or "N'<nenhuma conta excluida>'"


def _sql_fator(u):
    f = _fatores(u)
    if not f:
        return "1"
    casos = " ".join(f"WHEN {CONTA_SEM_ESPACO} = {_sql_texto(k)} THEN {v!r}" for k, v in f.items())
    return f"(CASE {casos} ELSE 1 END)"


def _sql_lancamentos(u):
    codigos = [int(c) for c in u.get("lancamentos_ignorados", []) if c is not None]  # só números
    return ", ".join(map(str, codigos)) or "-1"


def _formatar(sql, u, marcadas=None):
    if marcadas is None:
        marcadas = _marcadas(u)
    return (sql.replace("__EXCLUIDAS__", _sql_excluidas(u))
               .replace("__FATOR__", _sql_fator(u))
               .replace("__LANCAMENTOS__", _sql_lancamentos(u))
               .replace("__SOMENTE__", _sql_somente(u, marcadas)))


# ------------------------------------------------------------------
# Consultas
# ------------------------------------------------------------------
SQL_VENDAS = PERIODO + """
SELECT YEAR(v.Data) AS Ano, MONTH(v.Data) AS Mes,
       SUM(v.Valor_Final) AS Total_Vendas, COUNT(DISTINCT v.Codigo) AS Qtde_Vendas
FROM Venda v
WHERE v.Cancelada = 'N' AND v.Data >= @ini AND v.Data < @fim
GROUP BY YEAR(v.Data), MONTH(v.Data);"""

SQL_TRANSF = PERIODO + """
SELECT YEAR(f.Data_Emissao) AS Ano, MONTH(f.Data_Emissao) AS Mes, SUM(f.Total_NF) AS Total_Transferencias
FROM Fiscal_NF f
INNER JOIN Fiscal_NFe fe ON fe.Codigo_Fiscal_NF = f.Codigo
WHERE f.CFOP IN ('5.152', '5.409', '5.557', '5.552')
  AND fe.Situacao = 'AUTORIZADA'
  AND f.Data_Emissao >= @ini AND f.Data_Emissao < @fim
GROUP BY YEAR(f.Data_Emissao), MONTH(f.Data_Emissao);"""

# LEFT JOIN: pagamento sem conta contábil não está na lista de exclusão, portanto é somado (como no DAX)
SQL_PAGAMENTOS = PERIODO + f"""
SELECT Ano, Mes, Origem, Conta, EmissaoAnterior, SUM(Valor_Pago) AS Valor_Pago
FROM (
  SELECT YEAR(cp.Data_Pagamento) AS Ano, MONTH(cp.Data_Pagamento) AS Mes,
         CASE
           WHEN cp.Conta_Corrente = 2 THEN 'transferencia'
           WHEN YEAR(cp.Data_Emissao) = YEAR(cp.Data_Pagamento)
            AND MONTH(cp.Data_Emissao) = MONTH(cp.Data_Pagamento) THEN 'mesmo_mes'
           WHEN DATEFROMPARTS(YEAR(cp.Data_Emissao), MONTH(cp.Data_Emissao), 1)
              < DATEFROMPARTS(YEAR(cp.Data_Pagamento), MONTH(cp.Data_Pagamento), 1) THEN 'meses_anteriores'
           ELSE 'outros'
         END AS Origem,
         ISNULL(cc.Descricao, '') AS Conta,
         CASE WHEN YEAR(cp.Data_Emissao) < YEAR(cp.Data_Pagamento) THEN YEAR(cp.Data_Emissao) * 100 + MONTH(cp.Data_Emissao) ELSE 0 END AS EmissaoAnterior,
         (ISNULL(cp.Valor_Pago, 0) * __FATOR__) AS Valor_Pago
  FROM Contas_Pagar cp
  LEFT JOIN Conta_Contabil cc ON cc.Codigo = cp.Conta_Contabil
  WHERE cp.Data_Pagamento >= @ini AND cp.Data_Pagamento < @fim
    AND {CONTA_SEM_ESPACO} NOT IN (__EXCLUIDAS__)
    AND cp.Codigo NOT IN (__LANCAMENTOS__) __SOMENTE__
) x
GROUP BY Ano, Mes, Origem, Conta, EmissaoAnterior;"""

SQL_PROXIMO_MES = PERIODO + f"""
SELECT YEAR(cp.Data_Emissao) AS Ano, MONTH(cp.Data_Emissao) AS Mes, SUM(cp.Valor * __FATOR__) AS Pagamentos_Proximo_Mes
FROM Contas_Pagar cp
LEFT JOIN Conta_Contabil cc ON cc.Codigo = cp.Conta_Contabil
WHERE cp.Data_Emissao >= @ini AND cp.Data_Emissao < @fim
  AND {CONTA_SEM_ESPACO} NOT IN (__EXCLUIDAS__)
  AND cp.Codigo NOT IN (__LANCAMENTOS__) __SOMENTE__
  AND DATEFROMPARTS(YEAR(cp.Data_Vencimento), MONTH(cp.Data_Vencimento), 1)
    = DATEADD(MONTH, 1, DATEFROMPARTS(YEAR(cp.Data_Emissao), MONTH(cp.Data_Emissao), 1))
GROUP BY YEAR(cp.Data_Emissao), MONTH(cp.Data_Emissao);"""

SQL_GRUPOS = PERIODO + """
SELECT YEAR(v.Data) AS Ano, MONTH(v.Data) AS Mes, ISNULL(gp.Descricao, 'SEM GRUPO') AS Grupo, SUM(vi.Valor_Total) AS Valor
FROM Venda_Item vi
INNER JOIN Venda v ON v.Codigo = vi.Venda
LEFT JOIN Produto p ON p.Codigo = vi.Produto
LEFT JOIN Grupo_Produto gp ON gp.Codigo = p.Grupo
WHERE vi.Cancelado = 'N' AND v.Cancelada = 'N' AND v.Data >= @ini AND v.Data < @fim
GROUP BY YEAR(v.Data), MONTH(v.Data), ISNULL(gp.Descricao, 'SEM GRUPO');"""


# ------------------------------------------------------------------
# Visão geral: mês a mês dos últimos MESES_HISTORICO meses
# ------------------------------------------------------------------
def dados_unidade(u):
    hoje = date.today()
    fim = soma_meses(date(hoje.year, hoje.month, 1), 1)
    ini = soma_meses(fim, -MESES_HISTORICO - 1)
    periodo = (_dt(ini), _dt(fim))
    marcadas = _marcadas(u)

    meses = {}
    d = ini
    while d < fim:
        meses[(d.year, d.month)] = {
            "ano": d.year, "mes": d.month, "vendas": 0.0, "qtde": 0, "transf": 0.0, "proximo": 0.0, "revenda": 0.0,
            "vendas_fontes": {}, "sem_classificacao": {},
            "origem": {"transferencia": 0.0, "mesmo_mes": 0.0, "meses_anteriores": 0.0, "outros": 0.0, "fornecedor_cd": 0.0},
            "boi": {"total": 0.0, "transferencia": 0.0, "mesmo_mes": 0.0, "meses_anteriores": 0.0, "outros": 0.0, "revenda": 0.0, "por_emissao": {}},
            "grupos": {}, "movimento": False, "sem_planilha": False,
        }
        d = soma_meses(d, 1)

    # todas as consultas da unidade (e das lojas somadas a ela) em paralelo; CD com planilha não consulta vendas
    tarefas = {
        "transf": (u, SQL_TRANSF, periodo),
        "pagamentos": (_fonte_pagamentos(u), _formatar(SQL_PAGAMENTOS, u, marcadas), periodo),
        "proximo": (_fonte_pagamentos(u), _formatar(SQL_PROXIMO_MES, u, marcadas), periodo),
    }
    if not u.get("planilha_vendas"):
        tarefas["vendas"] = (u, SQL_VENDAS, periodo)
        tarefas["grupos"] = (u, SQL_GRUPOS, periodo)
    fontes = [f for f in u.get("vendas_adicionais", []) if f]
    for i, f in enumerate(fontes):
        tarefas[f"vendas_{i}"] = (f, SQL_VENDAS, periodo)
        tarefas[f"grupos_{i}"] = (f, SQL_GRUPOS, periodo)
    r = consultar_varios(tarefas)

    def mes_de(linha):
        return meses.get((int(linha["Ano"]), int(linha["Mes"])))

    for l in r.get("vendas", []):
        m = mes_de(l)
        if m:
            m["vendas"], m["qtde"], m["movimento"] = num(l["Total_Vendas"]), int(num(l["Qtde_Vendas"])), True
    for l in r["transf"]:
        m = mes_de(l)
        if m:
            m["transf"], m["movimento"] = num(l["Total_Transferencias"]), True

    chave_boi = chave_conta(u["conta_boi"]) if u.get("conta_boi") else None
    # notas de transferência para a loja ainda sem conta a pagar: entram pela data de emissão
    conta_transf = (_regra_transf()[0] or {}).get("conta", "")
    extras = [{"Ano": n["emissao"].year, "Mes": n["emissao"].month, "Origem": "transferencia", "Conta": conta_transf,
               "EmissaoAnterior": 0, "Valor_Pago": n["valor"]} for n in transf_nao_lancadas(u)]
    for l in r["pagamentos"] + extras:
        m = mes_de(l)
        if not m:
            continue
        v, conta, origem = num(l["Valor_Pago"]), l["Conta"] or "", l["Origem"]
        m["origem"][origem] += v
        classe = planilhas.classe_conta(conta)
        if chave_boi and int(l["EmissaoAnterior"] or 0) > 0 and chave_conta(conta) == chave_boi:
            b = m["boi"]
            b["total"] += v
            b[origem] += v
            b["por_emissao"][int(l["EmissaoAnterior"])] = b["por_emissao"].get(int(l["EmissaoAnterior"]), 0.0) + v
            if classe == "PRODUTOS PARA REVENDA":
                b["revenda"] += v
        if classe == "PRODUTOS PARA REVENDA":
            m["revenda"] += v
        elif not classe and v:
            nome = conta or "(sem conta contábil)"
            m["sem_classificacao"][nome] = m["sem_classificacao"].get(nome, 0.0) + v
        m["movimento"] = True
    for l in r["proximo"]:
        m = mes_de(l)
        if m:
            m["proximo"] = num(l["Pagamentos_Proximo_Mes"])
    for l in r.get("grupos", []):
        m = mes_de(l)
        if m:
            m["grupos"][l["Grupo"]] = num(l["Valor"])

    # vendas de outros servidores somadas às da unidade; vendas_fontes guarda quanto veio de cada loja
    if fontes:
        principal = u.get("nome_vendas") or u["nome"]
        for m in meses.values():
            m["vendas_fontes"] = {principal: m["vendas"], **{f["nome"]: 0.0 for f in fontes}}
    for i, f in enumerate(fontes):
        for l in r[f"vendas_{i}"]:
            m = mes_de(l)
            if m:
                v = num(l["Total_Vendas"])
                m["vendas"] += v
                m["qtde"] += int(num(l["Qtde_Vendas"]))
                m["vendas_fontes"][f["nome"]] += v
                m["movimento"] = True
        for l in r[f"grupos_{i}"]:
            m = mes_de(l)
            if m:
                m["grupos"][l["Grupo"]] = m["grupos"].get(l["Grupo"], 0.0) + num(l["Valor"])

    # transferências do CD para a loja (planilha do CD) entram nos pagamentos, como produtos para revenda
    if u.get("transferencias_cd"):
        for m in meses.values():
            v = planilhas.transferencias_cd(u, m["ano"], m["mes"])
            if v:
                m["origem"]["fornecedor_cd"] += v
                m["revenda"] += v
                m["movimento"] = True

    # faturamento da planilha (CD): substitui vendas, transferências e grupos (os grupos viram os clientes)
    if u.get("planilha_vendas"):
        for m in meses.values():
            p = planilhas.mes_planilha(u, m["ano"], m["mes"])
            if p:
                m.update(vendas=p["venda"], qtde=p["qtde"], transf=p["transf"], grupos=dict(p["clientes"]), movimento=True)
            else:
                m.update(vendas=0.0, qtde=0, transf=0.0, grupos={}, sem_planilha=True)

    # descarta os meses iniciais sem movimento (unidade ainda não operava)
    lista = list(meses.values())
    while lista and not lista[0]["movimento"]:
        lista.pop(0)

    registros = [_registro(u, m, chave_boi) for m in lista]
    return {
        "slug": u["slug"],
        "unidade": u["nome"],
        "planilha_vendas": bool(u.get("planilha_vendas")),
        "tem_estoque": planilhas.tem_estoque(u),
        "layout_cd": bool(u.get("layout_cd")),
        "conta_boi": u.get("conta_boi"),
        # link "Lançamentos desconsiderados": loja com lançamentos ignorados ou transferências de outra loja
        # desconsideradas, ou o CD (onde há FALCAO INDUSTRIA NF)
        "tem_desconsiderados": bool(u.get("lancamentos_ignorados") or u.get("transferencias_marcadas") == "excluir"
                                    or (u.get("layout_cd") and CFG.get("contas_ignoradas"))),
        "atualizado_em": agora_iso(),
        "meses": registros,
    }


def _r2(v):
    return round(v, 2)


def _registro(u, m, chave_boi):
    o = m["origem"]
    faturamento = m["vendas"] + m["transf"]
    pagamentos = o["transferencia"] + o["mesmo_mes"] + o["meses_anteriores"] + o["outros"] + o["fornecedor_cd"]
    b = m["boi"]
    estoque = planilhas.estoque_planilha(u, m["ano"], m["mes"]) if u.get("planilha_vendas") else None
    return {
        "ano": m["ano"],
        "mes": m["mes"],
        "label": f"{MESES_LABEL[m['mes'] - 1]}/{str(m['ano'])[2:]}",
        "total_vendas": _r2(m["vendas"]),
        "qtde_vendas": m["qtde"],
        "total_transferencias": _r2(m["transf"]),
        "faturamento_total": _r2(faturamento),
        "pagamentos": _r2(pagamentos),
        "pagamentos_proximo_mes": _r2(m["proximo"]),
        # "outros" (emissão posterior ao pagamento) entra no total e fica junto de "mesmo mês"
        "pagamentos_origem": {
            "transferencia": _r2(o["transferencia"]),
            "mesmo_mes": _r2(o["mesmo_mes"] + o["outros"]),
            "meses_anteriores": _r2(o["meses_anteriores"]),
            "fornecedor_cd": _r2(o["fornecedor_cd"]),
        },
        "boi_ano_anterior": {
            "total": _r2(b["total"]),
            "transferencia": _r2(b["transferencia"]),
            "mesmo_mes": _r2(b["mesmo_mes"] + b["outros"]),
            "meses_anteriores": _r2(b["meses_anteriores"]),
            "revenda": _r2(b["revenda"]),
            "por_emissao": [{"emissao": f"{k // 100}-{k % 100:02d}", "valor": _r2(v)} for k, v in sorted(b["por_emissao"].items())],
        } if chave_boi else None,
        "vendas_por_fonte": [{"nome": k, "valor": _r2(v)} for k, v in m["vendas_fontes"].items()],
        "distribuicao": {
            "produtos_revenda": _r2(m["revenda"]),
            "despesas_operacionais": _r2(pagamentos - m["revenda"]),
            "lucro": _r2(faturamento - pagamentos),
        },
        "sem_planilha": m["sem_planilha"],
        "estoque": _r2(estoque) if estoque is not None else None,
        "contas_sem_classificacao": [{"conta": k, "valor": _r2(v)} for k, v in sorted(m["sem_classificacao"].items(), key=lambda x: -x[1])],
        "grupos": [{"grupo": k, "valor": _r2(v)} for k, v in sorted(m["grupos"].items(), key=lambda x: -x[1])],
    }


# ------------------------------------------------------------------
# Análise por conta contábil: período selecionado x período anterior
# ------------------------------------------------------------------
SQL_PAGAMENTOS_CONTA = """DECLARE @iniAnt DATETIME = ?; DECLARE @fimAnt DATETIME = ?; DECLARE @iniAtu DATETIME = ?; DECLARE @fimAtu DATETIME = ?;
SELECT ISNULL(cc.Descricao, '') AS Conta,
       SUM(CASE WHEN cp.Data_Pagamento >= @iniAnt AND cp.Data_Pagamento < @fimAnt THEN (ISNULL(cp.Valor_Pago, 0) * __FATOR__) ELSE 0 END) AS Anterior,
       SUM(CASE WHEN cp.Data_Pagamento >= @iniAtu AND cp.Data_Pagamento < @fimAtu THEN (ISNULL(cp.Valor_Pago, 0) * __FATOR__) ELSE 0 END) AS Atual
FROM Contas_Pagar cp
LEFT JOIN Conta_Contabil cc ON cc.Codigo = cp.Conta_Contabil
WHERE ((cp.Data_Pagamento >= @iniAnt AND cp.Data_Pagamento < @fimAnt)
    OR (cp.Data_Pagamento >= @iniAtu AND cp.Data_Pagamento < @fimAtu))
  AND """ + CONTA_SEM_ESPACO + """ NOT IN (__EXCLUIDAS__)
  AND cp.Codigo NOT IN (__LANCAMENTOS__) __SOMENTE__
  __FILTRO_BOI__
GROUP BY ISNULL(cc.Descricao, '');"""


def transferencias_cd_periodo(u, ini, fim):
    """Soma os meses inteiros contidos em [ini, fim): a planilha do CD é mensal."""
    total, d = 0.0, date(ini.year, ini.month, 1)
    while d < fim:
        if d >= ini and soma_meses(d, 1) <= fim:
            total += planilhas.transferencias_cd(u, d.year, d.month)
        d = soma_meses(d, 1)
    return total


def pagamentos_por_conta(u, ano, mes, sem_boi_anterior=False):
    """Mês fechado: mês inteiro x mês anterior inteiro. Mês em andamento: dia 1 até hoje x o mesmo
    intervalo do mês anterior. mes = 0: ano inteiro x ano anterior (em andamento: até hoje x mesmo intervalo)."""
    hoje = date.today()
    corte = None
    if mes == 0:
        ini_atu = date(ano, 1, 1)
        ini_ant = date(ano - 1, 1, 1)
        fechado = date(ano + 1, 1, 1) <= hoje
        if fechado:
            fim_atu, fim_ant = date(ano + 1, 1, 1), ini_atu
        else:
            fim_atu = date.fromordinal(hoje.toordinal() + 1)
            try:
                fim_ant = date.fromordinal(hoje.replace(year=hoje.year - 1).toordinal() + 1)
            except ValueError:  # 29/02
                fim_ant = date(hoje.year - 1, 3, 1)
    else:
        ini_atu = date(ano, mes, 1)
        ini_ant = soma_meses(ini_atu, -1)
        fechado = soma_meses(ini_atu, 1) <= hoje
        if fechado:
            fim_atu, fim_ant = soma_meses(ini_atu, 1), ini_atu
        else:
            corte = hoje.day
            fim_atu = date.fromordinal(hoje.toordinal() + 1)
            dias_ant = (ini_atu - ini_ant).days
            fim_ant = date.fromordinal(ini_ant.toordinal() + min(corte, dias_ant))  # mês anterior mais curto: inteiro

    filtro_boi = ""
    if sem_boi_anterior and u.get("conta_boi"):
        filtro_boi = (f"AND NOT ({CONTA_SEM_ESPACO} = {_sql_texto(chave_conta(u['conta_boi']))} "
                      "AND ISNULL(YEAR(cp.Data_Emissao), 9999) < YEAR(cp.Data_Pagamento))")
    sql = _formatar(SQL_PAGAMENTOS_CONTA, u).replace("__FILTRO_BOI__", filtro_boi)
    linhas_sql = consultar(_fonte_pagamentos(u), sql, tuple(_dt(x) for x in (ini_ant, fim_ant, ini_atu, fim_atu)))
    # notas de transferência para a loja ainda sem conta a pagar, pela data de emissão
    conta_transf = (_regra_transf()[0] or {}).get("conta", "")
    dentro = lambda d, a, b: a <= d < b
    linhas_sql = list(linhas_sql) + [
        {"Conta": conta_transf, "Anterior": n["valor"] if dentro(n["emissao"], ini_ant, fim_ant) else 0,
         "Atual": n["valor"] if dentro(n["emissao"], ini_atu, fim_atu) else 0}
        for n in transf_nao_lancadas(u)]

    # agrupa pela conta normalizada e encaixa cada conta no plano/grupo da planilha
    por_conta = {}
    for l in linhas_sql:
        chave = normaliza(l["Conta"])
        if chave not in por_conta:
            info = planilhas.info_conta(l["Conta"])
            if info:
                por_conta[chave] = {"plano": info["plano"], "grupo": info["grupo"], "conta": info["nome"], "classificado": True}
            else:
                nome = (l["Conta"] or "").strip() or "(sem conta contábil)"
                por_conta[chave] = {"plano": NAO_CLASSIFICADOS, "grupo": NAO_CLASSIFICADOS, "conta": nome, "classificado": False}
            por_conta[chave].update(anterior=0.0, atual=0.0)
        por_conta[chave]["anterior"] += num(l["Anterior"])
        por_conta[chave]["atual"] += num(l["Atual"])
    linhas = [{**x, "anterior": _r2(x["anterior"]), "atual": _r2(x["atual"])}
              for x in por_conta.values() if x["anterior"] or x["atual"]]

    t = u.get("transferencias_cd")
    if t:
        ant, atu = transferencias_cd_periodo(u, ini_ant, fim_ant), transferencias_cd_periodo(u, ini_atu, fim_atu)
        if ant or atu:
            linhas.append({"plano": t["plano"], "grupo": t["grupo"], "conta": t["conta"], "classificado": True,
                           "anterior": _r2(ant), "atual": _r2(atu)})

    um_dia = lambda d: date.fromordinal(d.toordinal() - 1).isoformat()
    return {
        "slug": u["slug"], "unidade": u["nome"], "ano": ano, "mes": mes,
        "ano_inteiro": mes == 0, "mes_fechado": fechado, "corte_dia": corte,
        "periodo_atual": {"ini": ini_atu.isoformat(), "fim": um_dia(fim_atu)},
        "periodo_anterior": {"ini": ini_ant.isoformat(), "fim": um_dia(fim_ant)},
        "atualizado_em": agora_iso(),
        "linhas": linhas,
    }


# ------------------------------------------------------------------
# Página Pagamentos: uma linha por pagamento
# ------------------------------------------------------------------
SQL_LISTA = PERIODO + """
SELECT cp.Codigo, cp.Codigo_Fornecedor, pe.Nome AS Fornecedor,
       ISNULL(cc.Descricao, '') AS Conta,
       cp.Data_Emissao, cp.Data_Pagamento, cp.Data_Vencimento,
       (ISNULL(cp.Valor_Pago, 0) * __FATOR__) AS Valor_Pago, CAST(cp.Observacao AS NVARCHAR(MAX)) AS Observacao,
       CASE
         WHEN cp.Conta_Corrente = 2 THEN 'Transferência'
         WHEN YEAR(cp.Data_Emissao) = YEAR(cp.Data_Pagamento) AND MONTH(cp.Data_Emissao) = MONTH(cp.Data_Pagamento) THEN 'Mesmo mês'
         WHEN DATEFROMPARTS(YEAR(cp.Data_Emissao), MONTH(cp.Data_Emissao), 1)
            < DATEFROMPARTS(YEAR(cp.Data_Pagamento), MONTH(cp.Data_Pagamento), 1) THEN 'Meses anteriores'
         ELSE 'Outros'
       END AS Origem
FROM Contas_Pagar cp
LEFT JOIN Conta_Contabil cc ON cc.Codigo = cp.Conta_Contabil
LEFT JOIN Pessoa pe ON pe.Codigo = cp.Codigo_Fornecedor
WHERE cp.Data_Pagamento >= @ini AND cp.Data_Pagamento < @fim
  __FILTRO__
ORDER BY cp.Data_Pagamento DESC, cp.Codigo DESC;"""


def _data_iso(v):
    return v.date().isoformat() if isinstance(v, datetime) else (v.isoformat() if isinstance(v, date) else None)


def lista_pagamentos(u, ano, mes, restos_boi=False, desconsiderados=False):
    """restos_boi: o ano (até hoje) só com a conta_boi emitida em ano anterior ao do pagamento.
    desconsiderados: só as contas_ignoradas e os lancamentos_ignorados (conferência). mes = 0: o ano todo."""
    hoje = date.today()
    amanha = date.fromordinal(hoje.toordinal() + 1)
    if restos_boi or mes == 0:
        ini = date(ano, 1, 1)
        fechado = date(ano + 1, 1, 1) <= hoje
        fim = date(ano + 1, 1, 1) if fechado else amanha
    else:
        ini = date(ano, mes, 1)
        fechado = soma_meses(ini, 1) <= hoje
        fim = soma_meses(ini, 1) if fechado else amanha

    filtro = f"AND {CONTA_SEM_ESPACO} NOT IN (__EXCLUIDAS__)\n  AND cp.Codigo NOT IN (__LANCAMENTOS__) __SOMENTE__"
    if restos_boi:
        filtro += (f"\n  AND {CONTA_SEM_ESPACO} = {_sql_texto(chave_conta(u['conta_boi']))}"
                   " AND ISNULL(YEAR(cp.Data_Emissao), 9999) < YEAR(cp.Data_Pagamento)")
    lanc_ignorados = {int(c) for c in u.get("lancamentos_ignorados", []) if c is not None}
    marcadas = u.get("transferencias_marcadas")
    marcadas_rodape = _marcadas(u)  # código -> rodapé da nota
    if desconsiderados:
        ign = ", ".join(_sql_texto(chave_conta(c)) for c in CFG.get("contas_ignoradas", []) if c) or "N'<nenhuma conta ignorada>'"
        if marcadas == "excluir":  # as transferências de outra loja também são desconsideradas aqui
            filtro = f"AND ({CONTA_SEM_ESPACO} IN ({ign}) OR cp.Codigo IN (__LANCAMENTOS__) OR {_sql_codigos(marcadas_rodape)})"
        else:
            filtro = f"AND ({CONTA_SEM_ESPACO} IN ({ign}) OR cp.Codigo IN (__LANCAMENTOS__)) __SOMENTE__"
    rows = consultar(_fonte_pagamentos(u), _formatar(SQL_LISTA.replace("__FILTRO__", filtro), u, marcadas_rodape),
                     (_dt(ini), _dt(fim)))
    fatores = _fatores(u)
    linhas = []
    for r in rows:
        codigo = int(r["Codigo"]) if r["Codigo"] is not None else None
        d = {
            "codigo": codigo,
            "codigo_fornecedor": int(r["Codigo_Fornecedor"]) if r["Codigo_Fornecedor"] is not None else None,
            "fornecedor": (r["Fornecedor"] or "").strip(),
            "conta": (r["Conta"] or "").strip(),
            "observacao": (r["Observacao"] or "").strip(),
            "origem": r["Origem"],
            "emissao": _data_iso(r["Data_Emissao"]),
            "pagamento": _data_iso(r["Data_Pagamento"]),
            "vencimento": _data_iso(r["Data_Vencimento"]),
            "valor_pago": _r2(num(r["Valor_Pago"])),
        }
        rodape = marcadas_rodape.get(codigo)
        if rodape is not None:
            if rodape:
                d["observacao"] = f"{d['observacao']} [rodapé da nota: {rodape}]".strip()
        if desconsiderados:
            if rodape is not None:
                d["origem"] = "Transferência para outra loja (rodapé ou observação)"
            else:
                d["origem"] = f"Lançamento desconsiderado (código {codigo})" if codigo in lanc_ignorados else "Conta desconsiderada"
        fator = fatores.get(chave_conta(d["conta"]))
        if fator and fator != 1:
            original = f"{d['valor_pago'] / fator:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
            d["observacao"] = f"{d['observacao']} [considerado {round(fator * 100)}% do valor pago de R$ {original}]".strip()
        linhas.append(d)

    # notas de transferência para a loja ainda sem conta a pagar (pela data de emissão)
    if not restos_boi and not desconsiderados:
        conta_transf = (_regra_transf()[0] or {}).get("conta", "")
        for n in transf_nao_lancadas(u):
            if ini <= n["emissao"] < fim:
                linhas.append({
                    "codigo": None, "codigo_fornecedor": None, "fornecedor": n["emissor"], "conta": conta_transf,
                    "observacao": f"NF {n['nf']} (CFOP {n['cfop']}) ainda sem conta a pagar na Parque Dez [rodapé da nota: {n['rodape']}]",
                    "origem": "Transferência (nota emitida)", "emissao": n["emissao"].isoformat(), "pagamento": None,
                    "vencimento": None, "valor_pago": _r2(n["valor"]),
                })

    t = u.get("transferencias_cd")
    cd = planilhas.unidade_cd(u)
    if t and cd and not restos_boi and not desconsiderados:
        d = date(ini.year, ini.month, 1)
        while d < fim:
            if d >= ini and soma_meses(d, 1) <= fim:
                v = planilhas.transferencias_cd(u, d.year, d.month)
                if v:
                    linhas.append({
                        "codigo": None, "codigo_fornecedor": None,
                        "fornecedor": "CD (planilha de transferências)", "conta": t["conta"],
                        "observacao": f"Transferências do CD para {t['cliente']} em {MESES_LABEL[d.month - 1]}/{d.year} (total do mês, planilha do CD)",
                        "origem": "Transferência do CD", "emissao": None, "pagamento": None, "vencimento": None,
                        "valor_pago": _r2(v),
                    })
            d = soma_meses(d, 1)

    return {
        "slug": u["slug"], "unidade": u["nome"], "ano": ano, "mes": mes,
        "mes_fechado": fechado, "restos_boi": restos_boi, "desconsiderados": desconsiderados,
        "conta_boi": u.get("conta_boi") or "",
        "periodo": {"ini": ini.isoformat(), "fim": date.fromordinal(fim.toordinal() - 1).isoformat()},
        "atualizado_em": agora_iso(),
        "linhas": linhas,
    }
