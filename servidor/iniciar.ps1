# Sobe o sistema em modo produção e o mantém no ar.
# É chamado pela tarefa agendada criada por instalar.ps1 (conta SYSTEM, ao ligar o computador).
# Se o processo cair, reinicia sozinho. Se a porta estiver ocupada (código 3), registra no log e para.

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "config.ps1")
$raiz = Split-Path $PSScriptRoot -Parent
$pastaLogs = Join-Path $raiz "logs"
$log = Join-Path $pastaLogs "servidor.log"
$PORTA_OCUPADA = 3   # o sistema deve sair com este código quando a porta já estiver em uso

if ($TIPO -eq "python") {
    $exe = Join-Path $raiz ".venv\Scripts\python.exe"
    $env:PYTHONIOENCODING = "utf-8"
    $env:PYTHONUNBUFFERED = "1"
} else {
    # Caminho do Node gravado pelo instalador (a conta SYSTEM pode ter outro PATH)
    $exe = (Get-Content (Join-Path $PSScriptRoot ".node") -ErrorAction SilentlyContinue | Select-Object -First 1)
    if (-not $exe) { $exe = Join-Path $env:ProgramFiles "nodejs\node.exe" }
    $env:NODE_ENV = "production"
}
$entrada = Join-Path $raiz $ENTRADA   # caminho completo: é por ele que instalar/desinstalar acham o processo

New-Item -ItemType Directory -Force $pastaLogs | Out-Null
Set-Location $raiz

function Registrar($msg) {
    # Falha ao escrever no log (arquivo preso por outro processo) nunca pode derrubar o sistema
    try { Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  [iniciar] $msg" -Encoding UTF8 } catch {}
}

while ($true) {
    # Log com no máximo ~5 MB: o anterior vira servidor.log.old
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) {
        Move-Item $log "$log.old" -Force
    }
    Registrar "Iniciando $NOME_SISTEMA"
    $inicio = Get-Date
    cmd /c "`"$exe`" `"$entrada`" $ARGUMENTOS >> `"$log`" 2>&1"
    $codigo = $LASTEXITCODE

    if ($codigo -eq $PORTA_OCUPADA) {
        Registrar "Porta em uso por outro programa. O sistema NÃO foi iniciado. Libere a porta e rode o servidor\instalar.bat de novo."
        exit $codigo
    }
    # Se caiu logo depois de subir (ex.: erro no .env), espera mais para não encher o log
    $espera = if (((Get-Date) - $inicio).TotalSeconds -lt 60) { 60 } else { 10 }
    Registrar "O sistema parou (código $codigo). Reiniciando em $espera s."
    Start-Sleep -Seconds $espera
}
