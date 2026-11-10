# Taakplanner op de mini-pc: elke 10 minuten (en maandag 08:00 met -Weekbericht).
param([switch]$Weekbericht)
$ErrorActionPreference = 'Continue'
$map = Split-Path $PSScriptRoot -Parent
Set-Location $map
$env:NTFY_TOPIC = (Get-Content 'C:\Users\Ronald\geheim\ntfy-topic.txt' -Raw).Trim()
$log = Join-Path $map 'state\log.txt'
New-Item -ItemType Directory -Force (Join-Path $map 'state') | Out-Null
$args2 = @('check.mjs', '--rol', 'hoofd')
if ($Weekbericht) { $args2 += '--weekbericht' }
$uit = & node @args2 2>&1 | Out-String
Add-Content $log ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $uit.Trim()) -Encoding utf8
# log klein houden
$regels = Get-Content $log -Encoding utf8
if ($regels.Count -gt 3000) { $regels | Select-Object -Last 2000 | Set-Content $log -Encoding utf8 }
