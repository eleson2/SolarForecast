$ErrorActionPreference = 'Stop'

# --- Require Administrator ---
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Please run this script as Administrator (right-click -> Run as administrator)."
    exit 1
}
$ServiceName = 'SolarForecast'
$ProjectDir  = 'G:\projects\SolarForecast'
$LogDir      = "$ProjectDir\logs"

# --- Find node.exe ---
$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodePath) {
    Write-Error "node.exe not found in PATH. Install Node.js first."
    exit 1
}
Write-Host "Using node: $NodePath"

# --- Find nssm.exe ---
$NssmPath = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $NssmPath) {
    Write-Host "nssm not found - attempting install..."

    if (Get-Command scoop -ErrorAction SilentlyContinue) {
        Write-Host "Installing via scoop..."
        scoop install nssm
    } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Host "Installing via chocolatey..."
        choco install nssm -y
    } else {
        # Download nssm.exe directly into project directory
        Write-Host "No package manager found - downloading nssm.exe directly..."
        $NssmDir = "$ProjectDir\tools"
        New-Item -ItemType Directory -Path $NssmDir -Force | Out-Null
        $ZipPath = "$NssmDir\nssm.zip"
        Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $ZipPath
        Expand-Archive -Path $ZipPath -DestinationPath $NssmDir -Force
        $NssmPath = Get-ChildItem -Path $NssmDir -Recurse -Filter 'nssm.exe' |
                    Where-Object { $_.FullName -like '*win64*' } |
                    Select-Object -First 1 -ExpandProperty FullName
        if (-not $NssmPath) {
            Write-Error "Could not locate nssm.exe after download. Check $NssmDir"
            exit 1
        }
        Write-Host "Using downloaded nssm: $NssmPath"
    }

    # Refresh PATH after package manager install
    if (-not $NssmPath) {
        $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' +
                    [System.Environment]::GetEnvironmentVariable('PATH', 'User')
        $NssmPath = (Get-Command nssm -ErrorAction SilentlyContinue).Source
    }

    if (-not $NssmPath) {
        Write-Error "nssm still not found. Install it manually (scoop install nssm) and re-run."
        exit 1
    }
}
Write-Host "Using nssm: $NssmPath"

# --- Remove existing service if present ---
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing service..."
    & $NssmPath stop $ServiceName confirm 2>$null
    & $NssmPath remove $ServiceName confirm
}

# --- Ensure log directory exists ---
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# --- Install service ---
Write-Host "Installing service '$ServiceName'..."
& $NssmPath install $ServiceName $NodePath "$ProjectDir\scheduler.js"
& $NssmPath set $ServiceName AppDirectory $ProjectDir
& $NssmPath set $ServiceName AppStdout "$LogDir\nssm-out.log"
& $NssmPath set $ServiceName AppStderr "$LogDir\nssm-error.log"
& $NssmPath set $ServiceName AppRotateFiles 1
& $NssmPath set $ServiceName AppRotateBytes 10485760   # 10 MB
& $NssmPath set $ServiceName Start SERVICE_AUTO_START
& $NssmPath set $ServiceName DisplayName 'SolarForecast Battery Optimizer'
& $NssmPath set $ServiceName Description 'Solar forecast and battery charge/discharge optimizer'

# --- Set environment: inherit PATH so node can resolve modules ---
$machinePath = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine')
$userPath    = [System.Environment]::GetEnvironmentVariable('PATH', 'User')
$envExtras   = @("PATH=$machinePath;$userPath", 'NODE_ENV=production')
& $NssmPath set $ServiceName AppEnvironmentExtra @envExtras

# --- Start it ---
Write-Host "Starting service..."
& $NssmPath start $ServiceName
Start-Sleep -Seconds 3
& $NssmPath status $ServiceName
