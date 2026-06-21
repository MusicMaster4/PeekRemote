param(
  [Parameter(Mandatory = $true)]
  [string] $ExePath,

  [string] $TaskPath = "\Peek Remote\",
  [string] $ShowTaskName = "Peek Remote Elevated",
  [string] $HiddenTaskName = "Peek Remote Elevated Hidden",
  [string] $StartupTaskName = "Peek Remote Startup"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ExePath)) {
  throw "Peek Remote executable not found: $ExePath"
}

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances Parallel

function Register-PeekTask {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Name,

    [Parameter(Mandatory = $true)]
    [string] $Arguments,

    [Microsoft.Management.Infrastructure.CimInstance[]] $Trigger = $null
  )

  $action = New-ScheduledTaskAction -Execute $ExePath -Argument $Arguments
  $description = "Starts Peek Remote elevated so it can control administrator windows."
  if ($Trigger) {
    Register-ScheduledTask -TaskPath $TaskPath -TaskName $Name -Action $action -Trigger $Trigger -Principal $principal -Settings $settings -Description $description -Force | Out-Null
  } else {
    Register-ScheduledTask -TaskPath $TaskPath -TaskName $Name -Action $action -Principal $principal -Settings $settings -Description $description -Force | Out-Null
  }
}

Register-PeekTask -Name $ShowTaskName -Arguments "--elevated-task"
Register-PeekTask -Name $HiddenTaskName -Arguments "--elevated-task --hidden"

$existingStartup = Get-ScheduledTask -TaskPath $TaskPath -TaskName $StartupTaskName -ErrorAction SilentlyContinue
if ($existingStartup) {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  Register-PeekTask -Name $StartupTaskName -Arguments "--elevated-task --hidden" -Trigger $trigger
}
