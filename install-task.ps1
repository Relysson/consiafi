param(
    [int]$IntervalMinutes = 15,
    [string]$TaskName = "CONSIAFI Monitor"
)

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$scriptPath = Join-Path $projectDir "monitor.js"
$logDir = Join-Path $projectDir "logs"

if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

$logPath = Join-Path $logDir "monitor.log"
$escapedProjectDir = $projectDir.Replace('"', '""')
$escapedScriptPath = $scriptPath.Replace('"', '""')
$escapedLogPath = $logPath.Replace('"', '""')

$taskCommand = "cmd /c cd /d `"$escapedProjectDir`" && `"$nodeExe`" `"$escapedScriptPath`" >> `"$escapedLogPath`" 2>&1"
$startTime = (Get-Date).AddMinutes(1).ToString("HH:mm")

schtasks /Create `
    /F `
    /SC MINUTE `
    /MO $IntervalMinutes `
    /TN $TaskName `
    /TR $taskCommand `
    /ST $startTime

Write-Host "Tarefa agendada criada: $TaskName"
Write-Host "Intervalo: a cada $IntervalMinutes minuto(s)"
Write-Host "Log: $logPath"
