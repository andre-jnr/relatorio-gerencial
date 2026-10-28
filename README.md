# Relatório gerencial das lojas

Dashboard de uma página no formato do relatório do Power BI, com **dados ao vivo** do SQL Server (SISMOURA) de cada loja.
Usa as mesmas regras e funções do *Relatório gerencial testes*, exceto o Consolidado. Só consulta as lojas listadas no `.env`.

- **Porta:** 3007. Ela vem de `PORT` no `.env`.
- **Tecnologia:** Python 3.10 ou mais novo, Flask (Waitress no servidor), `mssql-python` (já traz o driver; não precisa instalar o ODBC) e `openpyxl`.
- **Páginas:** Visão geral (`/`), Pagamentos (`/pagamentos.html`) e Análise por conta contábil (`/conta-contabil.html`).

## Escolher as lojas (`.env`)

```
LOJAS=parque_dez,parque_dez_flores
```

As lojas disponíveis estão cadastradas em `config/unidades.json`: `parque_dez`, `parque_dez_flores`, `ponta_negra`, `morada_do_sol`, `monte_das_oliveiras` e `cd`.
Uma loja fora da lista não aparece no seletor e o banco dela **nunca é consultado** (a API responde 404).
Além disso, o painel só consulta a loja aberta na tela. Ele não carrega as outras em segundo plano.
Depois de mudar o `.env`, reinicie o painel. No servidor, rode `servidor\instalar.bat` de novo.

### Painel do CD em `/cd/`

O banco do CD fica no mesmo servidor da Parque Dez. Com `CD_SUBCAMINHO=1` no `.env`, o mesmo sistema (porta 3007) também serve o painel do CD em `http://SERVIDOR:3007/cd/`.
O endereço principal continua só com as lojas de `LOJAS`, e o `/cd/` mostra só o CD. Com `CD_SUBCAMINHO=0`, o `/cd/` responde 404.
O login é o mesmo nos dois endereços. O instalador pergunta se o CD deve ser instalado e grava a resposta no `.env`.
O CD precisa da planilha `dados/base_dados_cd.xlsx`, que não vai para o git: copie a planilha para o servidor junto com o projeto.

**Trocar a planilha pelo painel:** no CD, o superusuário vê um botão de envio (seta para cima) ao lado do Atualizar. A planilha enviada só é aceita se tiver a aba VENDAS com as colunas MÊS, ANO, TIPO e VLR FINAL e pelo menos uma linha válida; senão a atual continua em uso.
A anterior é guardada em `dados/backups/base_dados_cd_AAAA-MM-DD_HHMMSS.xlsx`, e os números do CD e da Parque Dez + Flores passam a usar a nova na hora. Para voltar atrás, copie um backup de volta para `dados/base_dados_cd.xlsx`. O limite é 20 MB, e o log registra quem enviou.

A **Parque Dez + Flores** lê as transferências do CD para a Flores na planilha `dados/base_dados_cd.xlsx`. Por isso ela funciona sem o CD na lista: a planilha é um arquivo local e não exige consulta ao banco.

## Onde fica cada coisa

```
app.py                  servidor web (rotas, cache, PDF); python app.py --producao no servidor
painel/config.py        lê .env e config/unidades.json
painel/banco.py         consultas somente leitura (READ UNCOMMITTED, rollback no fim)
painel/relatorios.py    consultas SQL e fórmulas (Visão geral, conta contábil, lista de pagamentos)
painel/planilhas.py     classificação dos pagamentos e planilha do CD (relidas quando salvas)
painel/pdf.py           PDF em A4 paisagem gerado por um Chrome/Edge invisível
config/unidades.json    lojas e regras (contas excluídas, ignoradas, fatores...). Sem senhas
dados/                  classificação_pagamentos.xlsx e base_dados_cd.xlsx
web/                    páginas, CSS e JS. É a única pasta entregue ao navegador
servidor/               scripts de instalação no servidor Windows
```

## Regras (iguais às do relatório de referência)

| Indicador | Cálculo |
|---|---|
| Total vendas | `SUM(Venda.Valor_Final)` com `Cancelada = 'N'`, por `Data` (+ vendas da Flores na Parque Dez + Flores) |
| Total transf. | `SUM(Fiscal_NF.Total_NF)`, CFOP 5.152 / 5.409 / 5.557 / 5.552, NFe `AUTORIZADA` |
| Fat. total | vendas + transferências |
| Pagamentos | `SUM(Contas_Pagar.Valor_Pago)` por `Data_Pagamento`, sem as `contas_excluidas_pagamentos` e as `contas_ignoradas` |
| Resultado | faturamento − pagamentos; Resultado (%) = resultado ÷ faturamento |
| Pags. próximo mês | `SUM(Contas_Pagar.Valor)` emitido no mês com vencimento no mês seguinte |
| Origem das contas pagas | Conta_Corrente = 2 → Transferência; emissão no mesmo mês → Mesmo mês; emissão anterior → Meses anteriores; transferências do CD (planilha) |
| Distribuição do faturamento | classificação da planilha `classificação_pagamentos.xlsx`: produtos para revenda, despesas operacionais e lucro/prejuízo |
| Maiores grupos | `SUM(Venda_Item.Valor_Total)` por `Grupo_Produto` (no CD, clientes da planilha) |

As regras por loja (`incluir_contas`, `fator_contas`, `lancamentos_ignorados`, `vendas_adicionais`, `transferencias_cd`, `planilha_vendas` e `conta_boi`) funcionam como no relatório de referência e estão descritas no começo de `painel/relatorios.py`.
Uma conta paga que não esteja na planilha de classificação entra como despesa operacional e aparece num aviso amarelo no painel.

## Segurança

- As senhas ficam só no `.env`, que não vai para o git nem para o navegador. A Flores usa `FLORES_DB_USUARIO` e `FLORES_DB_SENHA`.
- O navegador recebe só o slug e o nome das lojas. Servidor, banco e usuário nunca saem do servidor. Mensagens de erro mostram só o motivo resumido; o detalhe fica em `logs\servidor.log`.
- Só são servidas as três páginas e a pasta `web/assets`. O `.env`, `config/`, `dados/` e o código respondem 404.
- Mantenha o acesso restrito à rede interna (regra 5 das orientações). O painel usa `http` (sem `https`), então não deve ser exposto na internet.

## Login e usuários

- Todas as páginas e a API exigem login. Sem sessão, a página vai para `/login` e a API responde 401. Ficam livres só a tela de login, os arquivos de `web/assets` e o `/api/ping` (usado pelo instalador).
- Os usuários ficam em `dados/usuarios.db` (SQLite). As senhas são guardadas só em hash (scrypt) e ninguém consegue ver a senha de outro usuário.
- O **superusuário** vê o item **Usuários** no menu lateral. Ali ele cadastra usuários, redefine senhas, ativa e desativa, dá ou tira o acesso de superusuário e exclui.
- O painel sempre mantém pelo menos um superusuário ativo, e ninguém consegue desativar ou excluir o próprio usuário.
- Qualquer usuário troca a própria senha pelo menu do avatar, no canto de baixo do menu lateral.
- Desativar um usuário ou redefinir a senha dele encerra as sessões abertas na hora.
- O login não diferencia maiúsculas nem acentos: `André`, `andre` e `ANDRE` são o mesmo usuário. A sessão dura 12 horas.
- Depois de 5 tentativas erradas seguidas, o login e o IP ficam bloqueados por 5 minutos.
- O log registra entradas, recusas e alterações de usuários, mas nunca as senhas.
- O superusuário inicial é **André**, com login `andre`.
- Se o `dados/usuarios.db` se perder, crie outro superusuário pelo terminal, na pasta do projeto: `python -m painel.usuarios criar-super`.
- O cookie de login é assinado com `SECRET_KEY` do `.env`. Sem ela, o painel cria uma chave em `dados/.chave_sessao`.
- O gerador de PDF entra no painel com um token de uso único, válido por 5 minutos e aceito só a partir do próprio servidor.

## Usar no próprio computador (teste)

1. Crie o `.env` a partir do `.env.example`.
2. Rode `pip install -r requirements.txt`.
3. Clique duas vezes em `Abrir Painel.bat`, ou rode `python app.py` e abra http://localhost:3007.

## Publicar no servidor (Windows)

1. Copie a pasta do projeto para o servidor, **incluindo `dados/usuarios.db`**, que tem os usuários. Se o arquivo não for junto, crie o superusuário lá com `python -m painel.usuarios criar-super`.
2. Tenha o Python 3.10 ou mais novo instalado (marque *Add python.exe to PATH*). Para o botão **Gerar PDF** funcionar, o servidor também precisa do Chrome ou do Edge.
3. Crie o `.env` a partir do `.env.example`.
4. Clique duas vezes em `servidor\instalar.bat` e confirme o pedido de administrador.
   O instalador pergunta se deve instalar também o painel do CD em `/cd/`. Responda **S** só no servidor da Parque Dez. Ao reinstalar, Enter mantém a resposta anterior.

O painel sobe sozinho ao ligar o computador (tarefa agendada "Relatorio gerencial lojas (3007)") e reinicia se cair.
Ele fica acessível em http://NOME-DO-SERVIDOR:3007. Log: `logs\servidor.log`.
Para atualizar, copie os arquivos novos e rode o `instalar.bat` de novo.
Para remover, use `servidor\desinstalar.bat` (não apaga dados).
