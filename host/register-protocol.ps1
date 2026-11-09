# Registers workbench:// for this Windows user (no admin). Links fired by the board run Workbench.exe, which starts
# server.mjs --url without a window. Builds Workbench.exe from launcher.cs first. Re-run after moving the repo.
param([switch]$Remove)
# The Claude desktop app is a packaged app: a registry write from inside one of its sessions stays in the
# app's private view, and a browser never sees it (measured 2026-11-05). So from a Claude session, hop out via WMI.
if ($env:CLAUDECODE) {
  $flag = if ($Remove) { ' -Remove' } else { '' }
  Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"$flag" } | Out-Null
  're-running outside the Claude app'; exit
}
$key = 'HKCU:\Software\Classes\workbench'
if ($Remove) { Remove-Item $key -Recurse -Force -ErrorAction SilentlyContinue; 'workbench:// removed'; exit }
$exe = Join-Path $PSScriptRoot 'Workbench.exe'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:winexe /out:$exe (Join-Path $PSScriptRoot 'launcher.cs')
if (-not (Test-Path $exe)) { 'build failed: Workbench.exe was not produced'; exit 1 }
New-Item -Path "$key\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value 'URL:Workbench'
Set-ItemProperty -Path $key -Name 'URL Protocol' -Value ''
Set-ItemProperty -Path "$key\shell\open\command" -Name '(default)' -Value "`"$exe`" `"%1`""
"workbench:// -> $exe"
