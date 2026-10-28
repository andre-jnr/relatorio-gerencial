# Configuração da publicação deste sistema no servidor Windows.
# Lida por instalar.ps1, iniciar.ps1 e desinstalar.ps1 (que são iguais em todos os sistemas).

$NOME_SISTEMA = "Relatorio gerencial lojas"   # SEM acentos: vira o nome da tarefa agendada e da regra de firewall
$PORTA_PADRAO = 3007         # da tabela de orientacoes-projetos-ia.md (PORT no .env tem prioridade)
$TIPO         = "python"           # "python" ou "node"
$ENTRADA      = "app.py"        # arquivo principal, relativo à raiz do projeto (ex.: app.py, server/index.js)
$ARGUMENTOS   = "--producao"     # argumentos do modo produção (ex.: --producao) ou ""
$ROTA_TESTE   = "/api/ping"     # rota que responde 200 com o sistema no ar (ex.: /, /api/saude)
$PASTAS_DADOS = @("dados")           # pastas onde o sistema grava; a conta SYSTEM recebe escrita (logs já incluso)
