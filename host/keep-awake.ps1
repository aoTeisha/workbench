# Keeps the PC from sleeping while this process runs: asks Windows for ES_SYSTEM_REQUIRED, the request media players
# make. It fakes no input, so the screen still locks on the company's schedule. Ends with the process.
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class Awake {
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
}
'@
$ES_CONTINUOUS = [uint32]'0x80000000'; $ES_SYSTEM_REQUIRED = [uint32]'0x00000001'
while ($true) {
  [void][Awake]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
  Start-Sleep -Seconds 300
}
