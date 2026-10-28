# Remove a inicialização automática do sistema (tarefa agendada e regra de firewall).
# NÃO apaga dados, .env, .venv, node_modules nem logs.
# Rode como Administrador:  clique duas vezes em servidor\desinstalar.bat

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "config.ps1")
$raiz = Split-Path $PSScriptRoot -Parent
$entrada = Join-Path $raiz $ENTRADA
$pythonVenv = Join-Path $raiz ".venv\Scripts\python.exe"
$iniciar = Join-Path $PSScriptRoot "iniciar.ps1"

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host "ERRO: rode como Administrador." -ForegroundColor Red; exit 1 }

# Só as tarefas que apontam para o iniciar.ps1 DESTA pasta
$tarefas = Get-ScheduledTask -TaskName "$NOME_SISTEMA (*)" -ErrorAction SilentlyContinue |
    Where-Object { $_.Actions.Arguments -like "*$iniciar*" }
foreach ($t in $tarefas) {
    Stop-ScheduledTask -TaskName $t.TaskName
    Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false
    Get-NetFirewallRule -DisplayName $t.TaskName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Write-Host "Removidos: tarefa e regra de firewall '$($t.TaskName)'" -ForegroundColor Green
}
if (-not $tarefas) { Write-Host "Nenhuma tarefa '$NOME_SISTEMA' instalada para esta pasta." }

# Encerra o sistema se ainda estiver rodando: laço do iniciar.ps1 e os processos que ele abriu
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -like "*$iniciar*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -in "python.exe", "node.exe" -and
                   ($_.CommandLine -like "*$entrada*" -or $_.ExecutablePath -eq $pythonVenv) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "Encerrado: PID $($_.ProcessId)" }
