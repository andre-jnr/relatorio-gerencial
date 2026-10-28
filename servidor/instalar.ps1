# Instala o sistema no servidor (Windows) para subir sozinho ao ligar o computador.
# Rode como Administrador:  clique duas vezes em servidor\instalar.bat
#
# O que faz:
#   1. confere o .env
#   2. confere se a porta está livre (se estiver ocupada por outro programa, para e avisa)
#   3. prepara o Python (.venv) ou o Node e instala as dependências
#   4. libera a porta no firewall do Windows (todos os perfis de rede)
#   5. cria a tarefa agendada "<NOME_SISTEMA> (<porta>)" que roda servidor\iniciar.ps1 ao ligar
#   6. inicia o sistema e testa o acesso (localhost e IP da rede)
# Pode ser rodado de novo (ex.: depois de atualizar o código): refaz tudo sem perder dados.
# Configuração do sistema: servidor\config.ps1

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "config.ps1")
$raiz = Split-Path $PSScriptRoot -Parent
$envArq = Join-Path $raiz ".env"
$entrada = Join-Path $raiz $ENTRADA
$venv = Join-Path $raiz ".venv"
$pythonVenv = Join-Path $venv "Scripts\python.exe"
$iniciar = Join-Path $PSScriptRoot "iniciar.ps1"
$log = Join-Path $raiz "logs\servidor.log"

function Passo($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg)    { Write-Host "    OK  $msg" -ForegroundColor Green }
function Aviso($msg) { Write-Host "    !   $msg" -ForegroundColor Yellow }
function Falha($msg) { Write-Host "`nERRO: $msg" -ForegroundColor Red; exit 1 }

function Ler-Env($nome, $padrao) {
    if (-not (Test-Path $envArq)) { return $padrao }
    $linha = Get-Content $envArq -Encoding UTF8 | Where-Object { $_ -match "^\s*$nome\s*=" } | Select-Object -Last 1
    if (-not $linha) { return $padrao }
    $valor = ($linha -split "=", 2)[1].Trim().Trim("'").Trim('"')
    if ($valor) { return $valor } else { return $padrao }
}

function Gravar-Env($nome, $valor) {
    # troca a linha da variável (ou acrescenta no fim), mantendo o resto do .env como está
    $linhas = @(Get-Content $envArq -Encoding UTF8)
    $achou = $false
    $linhas = @($linhas | ForEach-Object { if ($_ -match "^\s*$nome\s*=") { $achou = $true; "$nome=$valor" } else { $_ } })
    if (-not $achou) { $linhas += "$nome=$valor" }
    [IO.File]::WriteAllLines($envArq, [string[]]$linhas, (New-Object Text.UTF8Encoding $false))
}

function Sim($valor) { "$valor".Trim().ToLower() -in "1", "s", "sim", "true" }

function Processo-Na-Porta($porta) {
    $con = Get-NetTCPConnection -LocalPort $porta -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($con) { Get-CimInstance Win32_Process -Filter "ProcessId = $($con.OwningProcess)" }
}

function Parar-Sistema {
    # Para o laço do iniciar.ps1 DESTA pasta e os processos que ele abriu. O python.exe do .venv é um
    # lançador que abre o Python real como filho; os dois têm o caminho completo da entrada na linha de comando.
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
        Where-Object { $_.CommandLine -like "*$iniciar*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Get-CimInstance Win32_Process |
        Where-Object { $_.Name -in "python.exe", "node.exe" -and
                       ($_.CommandLine -like "*$entrada*" -or $_.ExecutablePath -eq $pythonVenv) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
}

# ---------- 0. administrador ----------
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Falha "rode como Administrador (clique com o botão direito em instalar.bat > Executar como administrador)." }

# ---------- 1. configuração ----------
Passo "Conferindo o .env"
$exemplo = Join-Path $raiz ".env.example"
if (-not (Test-Path $envArq) -and (Test-Path $exemplo)) {
    Copy-Item $exemplo $envArq
    Falha "não havia .env. Criei um a partir do .env.example em:`n  $envArq`nPreencha os valores e rode a instalação de novo."
}
$porta = [int](Ler-Env "PORT" "$PORTA_PADRAO")
Ok "porta $porta"
$nomeTarefa = "$NOME_SISTEMA ($porta)"

# Perguntas de sim/não do config.ps1: Enter mantém a resposta da instalação anterior
$caminhosExtras = @()
if ($PERGUNTAS) {
    Passo "Opções da instalação"
    foreach ($p in $PERGUNTAS) {
        $padrao = if (Sim (Ler-Env $p.Variavel "0")) { "S" } else { "N" }
        do {
            $r = (Read-Host "    $($p.Pergunta) (S/N) [$padrao]").Trim().ToUpper()
            if (-not $r) { $r = $padrao }
        } until ($r -in "S", "N", "SIM", "NAO", "NÃO")
        $valor = if ($r.StartsWith("S")) { "1" } else { "0" }
        Gravar-Env $p.Variavel $valor
        Ok "$($p.Variavel)=$valor $(if ($valor -eq '1') { '(sim)' } else { '(não)' })"
        if ($valor -eq "1" -and $p.Caminho) { $caminhosExtras += $p.Caminho }
    }
}

# ---------- 2. porta (antes das dependências: numa reinstalação os arquivos podem estar em uso) ----------
Passo "Conferindo a porta $porta"
if (Get-ScheduledTask -TaskName $nomeTarefa -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $nomeTarefa   # reinstalação: para a versão em execução
}
Parar-Sistema
$proc = Processo-Na-Porta $porta
if ($proc) {
    Falha "a porta $porta já está em uso por '$($proc.Name)' (PID $($proc.ProcessId)).`nNão troquei de porta: confira orientacoes-projetos-ia.md e libere a porta antes de instalar."
}
Ok "porta livre"

# ---------- 3. dependências ----------
if ($TIPO -eq "python") {
    $VERSAO_MINIMA = [version]"3.10"

    function Versao-Python($exe, $extra) {
        try { [version](& $exe @extra -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null) } catch { $null }
    }

    function Achar-Python {
        # 1º o lançador "py" (usa a versão mais nova instalada), depois os python.exe do PATH
        if ((Get-Command py -ErrorAction SilentlyContinue) -and (Versao-Python "py" @("-3")) -ge $VERSAO_MINIMA) {
            return @{ Exe = "py"; Extra = @("-3") }
        }
        foreach ($c in Get-Command python -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike "*WindowsApps*" }) {
            if ((Versao-Python $c.Source @()) -ge $VERSAO_MINIMA) { return @{ Exe = $c.Source; Extra = @() } }
        }
    }

    Passo "Preparando o Python (.venv)"
    if ((Test-Path $pythonVenv) -and -not ((Versao-Python $pythonVenv @()) -ge $VERSAO_MINIMA)) {
        Aviso "o .venv existente está quebrado ou é antigo demais. Recriando."
        Remove-Item -Recurse -Force $venv
    }
    if (-not (Test-Path $pythonVenv)) {
        $py = Achar-Python
        if (-not $py) {
            Falha "Python $VERSAO_MINIMA ou mais novo não encontrado. Instale em python.org (Windows installer 64-bit, marque 'Add python.exe to PATH')."
        }
        & $py.Exe @($py.Extra) -m venv $venv
        if ($LASTEXITCODE -ne 0) { Falha "não consegui criar o .venv." }
    }
    # --only-binary: só instala pacotes prontos, nunca tenta compilar (o que exigiria o Visual C++)
    # Rede instável (IncompleteRead, conexão interrompida): o pip repete e, se ainda falhar, tenta de novo do zero.
    for ($tentativa = 1; $tentativa -le 3; $tentativa++) {
        & $pythonVenv -m pip install --disable-pip-version-check -q --only-binary :all: --retries 10 --timeout 60 -r (Join-Path $raiz "requirements.txt")
        if ($LASTEXITCODE -eq 0) { break }
        if ($tentativa -lt 3) { Aviso "a instalação das dependências falhou (tentativa $tentativa de 3). Tentando de novo..."; Start-Sleep -Seconds 5 }
    }
    if ($LASTEXITCODE -ne 0) {
        Falha "falha ao instalar as dependências (requirements.txt). Se o erro fala em conexão (IncompleteRead, Connection broken, timeout), é a internet do servidor: rode de novo. Se diz que não há versão compatível, algum pacote não tem versão pronta para este Python: use outra versão do Python."
    }
    Ok (& $pythonVenv --version)
} else {
    Passo "Preparando o Node.js"
    $node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $node -and (Test-Path (Join-Path $env:ProgramFiles "nodejs\node.exe"))) { $node = Join-Path $env:ProgramFiles "nodejs\node.exe" }
    if (-not $node) { Falha "Node.js não encontrado. Instale a versão LTS em nodejs.org e rode a instalação de novo." }
    Set-Content -Path (Join-Path $PSScriptRoot ".node") -Value $node -Encoding ASCII   # usado pelo iniciar.ps1 (SYSTEM)
    $npm = Join-Path (Split-Path $node -Parent) "npm.cmd"
    Push-Location $raiz
    if (Test-Path (Join-Path $raiz "package-lock.json")) { & $npm ci --omit=dev --no-audit --no-fund }
    else { & $npm install --omit=dev --no-audit --no-fund }
    $codigoNpm = $LASTEXITCODE
    Pop-Location
    if ($codigoNpm -ne 0) { Falha "falha ao instalar as dependências (npm)." }
    Ok "Node $(& $node -v)"
}

# ---------- permissões ----------
# A tarefa roda como SYSTEM: precisa ler o .env e gravar nas pastas de dados e de logs
if (Test-Path $envArq) { icacls $envArq /grant:r "*S-1-5-18:R" | Out-Null }
foreach ($pasta in @($PASTAS_DADOS) + "logs" | Select-Object -Unique) {
    $p = Join-Path $raiz $pasta
    New-Item -ItemType Directory -Force $p | Out-Null
    icacls $p /grant "*S-1-5-18:(OI)(CI)M" | Out-Null
}

# ---------- 4. firewall ----------
# Todos os perfis de rede (Domínio, Privado e Público): se a rede do servidor estiver classificada
# como "Pública", uma regra só para Domínio/Privado não valeria e ninguém acessaria pela rede.
Passo "Liberando a porta $porta no firewall do Windows"
Get-NetFirewallRule -DisplayName $nomeTarefa -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $nomeTarefa -Direction Inbound -Protocol TCP -LocalPort $porta `
    -Action Allow -Profile Any | Out-Null
Ok "regra '$nomeTarefa' criada"

# ---------- 5. tarefa agendada ----------
Passo "Criando a tarefa agendada '$nomeTarefa'"
$acao = New-ScheduledTaskAction -Execute "powershell.exe" -WorkingDirectory $raiz `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$iniciar`""
$gatilho = New-ScheduledTaskTrigger -AtStartup
$gatilho.Delay = "PT30S"   # espera a rede subir
$conta = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$config = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $nomeTarefa -Action $acao -Trigger $gatilho -Principal $conta -Settings $config `
    -Description "$NOME_SISTEMA - porta $porta. Instalado por servidor\instalar.ps1 em $raiz" -Force | Out-Null
Ok "sobe sozinho ao ligar o computador (sem precisar de login)"

# ---------- 6. iniciar e testar ----------
Passo "Iniciando"
Start-ScheduledTask -TaskName $nomeTarefa
$url = "http://localhost:$porta$ROTA_TESTE"
$respondeu = $false
for ($i = 0; $i -lt 30 -and -not $respondeu; $i++) {
    Start-Sleep -Seconds 2
    try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 5 | Out-Null; $respondeu = $true } catch {}
}
if (-not $respondeu) { Falha "o sistema não respondeu em $url. Veja o log: $log" }
Ok "respondendo em http://localhost:$porta"

$ips = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" }).IPAddress
# Testa pelo IP da rede: se só responder no localhost, o sistema não está escutando em 0.0.0.0
$naRede = $ips | Where-Object {
    try { Invoke-WebRequest "http://${_}:$porta$ROTA_TESTE" -UseBasicParsing -TimeoutSec 5 | Out-Null; $true } catch { $false }
}
if ($naRede) { Ok "respondendo também pelo IP da rede ($($naRede -join ', '))" }
else { Aviso "responde no localhost, mas não pelo IP da rede. Confira se o sistema escuta em 0.0.0.0 e se há antivírus/firewall de terceiros bloqueando a porta $porta." }

Write-Host "`nPronto! Acesse de outra máquina da rede:" -ForegroundColor Green
Write-Host "  http://$($env:COMPUTERNAME):$porta"
$ips | ForEach-Object { Write-Host "  http://${_}:$porta" }
foreach ($c in $caminhosExtras) {
    $urlExtra = "http://localhost:$porta$c"
    try { Invoke-WebRequest $urlExtra -UseBasicParsing -TimeoutSec 5 | Out-Null; Write-Host "  http://$($env:COMPUTERNAME):$porta$c" }
    catch { Aviso "$urlExtra não respondeu. Veja o log: $log" }
}
Write-Host "Log: $log"
