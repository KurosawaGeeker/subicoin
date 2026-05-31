function Install-SubiSeller {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Gateway,

    [Parameter(Mandatory = $true)]
    [string]$SetupToken,

    [string]$AgentPath = "",
    [string]$InstallDir = "$env:USERPROFILE\.subi\seller",
    [string]$ServiceName = "subi-seller-agent"
  )

  $ErrorActionPreference = "Stop"
  $Gateway = $Gateway.TrimEnd("/")
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

  $encodedToken = [System.Uri]::EscapeDataString($SetupToken)
  $setupURL = "$Gateway/api/v1/subi/seller/setup?token=$encodedToken"
  $setupResponse = Invoke-WebRequest -UseBasicParsing -Uri $setupURL
  $payload = $setupResponse.Content | ConvertFrom-Json

  if (-not $payload.seller_config_env) {
    throw "setup response did not include seller_config_env"
  }

  $configPath = Join-Path $InstallDir "config.env"
  Set-Content -Path $configPath -Value ($payload.seller_config_env + "`n") -NoNewline -Encoding UTF8

  $agentFile = Join-Path $InstallDir "seller-agent.exe"
  if ($AgentPath) {
    Copy-Item -Force -Path $AgentPath -Destination $agentFile
  } else {
    $existingAgent = Get-Command "seller-agent.exe" -ErrorAction SilentlyContinue
    if ($existingAgent) {
      Copy-Item -Force -Path $existingAgent.Source -Destination $agentFile
    } else {
      $downloadTmp = Join-Path $InstallDir "seller-agent.exe.download"
      $downloadURL = "$Gateway/api/v1/subi/seller/downloads/seller-agent-windows-x64.exe"
      Invoke-WebRequest -UseBasicParsing -Uri $downloadURL -OutFile $downloadTmp
      Move-Item -Force -Path $downloadTmp -Destination $agentFile
    }
  }

  $launcherPath = Join-Path $InstallDir "run-seller-agent.ps1"
  $launcher = @'
$ErrorActionPreference = "Stop"
$InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $InstallDir "config.env"

Get-Content $ConfigPath | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) {
    return
  }

  $parts = $line.Split("=", 2)
  $name = $parts[0].Trim()
  $value = $parts[1].Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  $value = $value.Replace('$HOME', $env:USERPROFILE)
  [Environment]::SetEnvironmentVariable($name, $value, "Process")
}

& (Join-Path $InstallDir "seller-agent.exe") >> (Join-Path $InstallDir "seller-agent.log") 2>&1
'@
  Set-Content -Path $launcherPath -Value $launcher -Encoding UTF8

  try {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$launcherPath`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName $ServiceName -Action $action -Trigger $trigger -Force | Out-Null
    Start-ScheduledTask -TaskName $ServiceName
    Write-Host "Subi seller-agent installed and started with Windows Task Scheduler."
  } catch {
    Start-Process -WindowStyle Hidden -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $launcherPath)
    Write-Host "Subi seller-agent started with PowerShell."
  }

  Write-Host "Config: $configPath"
  Write-Host "Logs:   $(Join-Path $InstallDir 'seller-agent.log')"
}
