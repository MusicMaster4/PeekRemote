param(
  [string] $TaskPath = "\Peek Remote\",
  [string[]] $TaskNames = @(
    "Peek Remote Elevated",
    "Peek Remote Elevated Hidden",
    "Peek Remote Startup"
  )
)

$ErrorActionPreference = "SilentlyContinue"

foreach ($taskName in $TaskNames) {
  Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $taskName -Confirm:$false
}
