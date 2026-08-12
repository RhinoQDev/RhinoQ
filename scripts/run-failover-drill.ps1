[CmdletBinding()]
param(
    [ValidateRange(1, 100000)]
    [int]$Writes = 150,
    [ValidateRange(1024, 65534)]
    [int]$PrimaryPort = 55436,
    [ValidateRange(1024, 65534)]
    [int]$ReplicaPort = 55437,
    [string]$ProjectName = "rhinoq-failover-drill"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repoRoot "tests/failover/docker-compose.yml"
$bash = "C:\Program Files\Git\bin\bash.exe"

if (-not (Test-Path -LiteralPath $bash)) {
    throw "Git Bash is required at $bash to run scripts/failover-drill.sh."
}
if ($PrimaryPort -eq $ReplicaPort) {
    throw "PrimaryPort and ReplicaPort must be different."
}

$env:RHINOQ_FAILOVER_PRIMARY_PORT = [string]$PrimaryPort
$env:RHINOQ_FAILOVER_REPLICA_PORT = [string]$ReplicaPort
$env:COMPOSE_PROJECT_NAME = $ProjectName
$env:COMPOSE_FILE = "tests/failover/docker-compose.yml"
$env:PRIMARY_PORT = [string]$PrimaryPort
$env:REPLICA_PORT = [string]$ReplicaPort
$env:WRITES = [string]$Writes

Push-Location $repoRoot
try {
    docker compose -f $composeFile up -d --wait
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose did not start the failover rig." }

    & $bash "./scripts/failover-drill.sh"
    if ($LASTEXITCODE -ne 0) { throw "The failover drill failed with exit code $LASTEXITCODE." }
}
finally {
    docker compose -f $composeFile down --volumes --remove-orphans
    Pop-Location
}
