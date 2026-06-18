<#
.SYNOPSIS
  Registers the "SolarForecast-WakeForExecute" scheduled task.

.DESCRIPTION
  Part of the sleep + wake-timer power policy (Option 3). When the host sleeps deeply,
  node-cron inside the service cannot be relied on to fire in the brief window after a
  timer-wake, so this task both WAKES the host (WakeToRun) AND drives the execute cycle
  directly: at each 15-min slot boundary (:00/:15/:30/:45, +30 s) it POSTs to
  http://127.0.0.1:3000/battery/execute, which runs snapshot + execute + conditional
  re-optimize in the already-running service (reusing its persistent Modbus socket).
  The cycle is debounced server-side, so when the host is awake and node-cron also
  fires, the duplicate is harmless.

  Pairs with the powercfg settings already applied:
    standby-timeout = 4 min, RTCWAKE enabled, hibernate off.

  NOTE: the URL hardcodes port 3000 (the service default). If you set a non-default
  PORT, update the -Uri below.

.NOTES
  MUST be run from an ELEVATED PowerShell (Run as administrator) — registering a
  SYSTEM task requires admin rights. Re-run any time; it replaces the existing task.
#>

$ErrorActionPreference = 'Stop'
$taskName = 'SolarForecast-WakeForExecute'

# Fail fast if not elevated.
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
  Write-Error "This script must be run from an elevated PowerShell (Run as administrator)."
  return
}

$xml = @'
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Wakes the host at each 15-min SolarForecast execute slot and triggers the execute cycle via POST http://127.0.0.1:3000/battery/execute. Replaces reliance on node-cron firing after a sleep-wake.</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT15M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2025-01-01T00:00:30</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>PT3M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -NonInteractive -WindowStyle Hidden -Command "try { Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/battery/execute' -TimeoutSec 120 | Out-Null } catch { exit 1 }"</Arguments>
    </Exec>
  </Actions>
</Task>
'@

Register-ScheduledTask -TaskName $taskName -Xml $xml -Force | Out-Null
Write-Host "Registered scheduled task '$taskName'." -ForegroundColor Green

Write-Host "`n--- Verify: task ---"
Get-ScheduledTask -TaskName $taskName |
  Select-Object TaskName, State, @{n='WakeToRun';e={$_.Settings.WakeToRun}} |
  Format-List
Get-ScheduledTaskInfo -TaskName $taskName |
  Select-Object LastRunTime, NextRunTime, LastTaskResult | Format-List

Write-Host "--- Verify: OS wake timers ---"
powercfg /waketimers
