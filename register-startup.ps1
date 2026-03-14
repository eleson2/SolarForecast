# Run this script as Administrator to register PM2 as a Windows startup task.
# Right-click PowerShell → "Run as Administrator", then:
#   cd G:\projects\SolarForecast
#   .\register-startup.ps1

$pm2 = "C:\Users\erlan\AppData\Roaming\npm\pm2.cmd"
$taskName = "PM2SolarForecast"

$action  = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$pm2`" resurrect"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

# Run as the current user, whether or not they are logged on
$principal = New-ScheduledTaskPrincipal -UserId "erlan" -LogonType S4U -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force

Write-Host "Task '$taskName' registered. PM2 will now resurrect at every system startup." -ForegroundColor Green
