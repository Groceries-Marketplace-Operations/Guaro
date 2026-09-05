#requires -Version 7.2

[CmdletBinding()]
param(
  [Parameter()]
  [ValidateNotNullOrEmpty()]
  [string]$Reason = 'Temporary local access to production from Eduardo trusted workstation',

  [Parameter()]
  [ValidateNotNullOrEmpty()]
  [string]$Email = 'eduardolarazarrabal@didi-labs.com',

  [Parameter()]
  [ValidateRange(1, 15)]
  [int]$TtlMinutes = 15,

  [Parameter()]
  [ValidateNotNullOrEmpty()]
  [string]$SshHost = 'root@209.38.73.188',

  [Parameter()]
  [ValidateNotNullOrEmpty()]
  [string]$SshKey = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ssh\guaro_digitalocean_ed25519'),

  [Parameter()]
  [ValidateNotNullOrEmpty()]
  [string]$RemoteDirectory = '/root/Guaro',

  [Parameter()]
  [ValidateRange(0, 65535)]
  [int]$Port = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-Base64Json {
  param([Parameter(Mandatory)][hashtable]$Value)

  $json = $Value | ConvertTo-Json -Compress -Depth 5
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
}

function New-LocalProductionNonce {
  $bytes = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Select-LoopbackPort {
  param([Parameter(Mandatory)][int]$RequestedPort)

  if ($RequestedPort -ne 0 -and $RequestedPort -lt 49152) {
    throw 'Port must be 0 (automatic) or a high dynamic port between 49152 and 65535.'
  }

  $attempts = if ($RequestedPort -eq 0) { 64 } else { 1 }
  for ($attempt = 0; $attempt -lt $attempts; $attempt += 1) {
    $candidate = if ($RequestedPort -eq 0) {
      [Security.Cryptography.RandomNumberGenerator]::GetInt32(49152, 65536)
    } else {
      $RequestedPort
    }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $candidate)
    try {
      $listener.Start()
      return $candidate
    } catch {
      if ($RequestedPort -ne 0) {
        throw "Port $RequestedPort is unavailable on 127.0.0.1."
      }
    } finally {
      $listener.Stop()
    }
  }

  throw 'Could not reserve an available high loopback port after 64 attempts.'
}

function New-NodeProcessStartInfo {
  param(
    [Parameter(Mandatory)][string]$NodeExecutable,
    [Parameter(Mandatory)][string]$WorkingDirectory,
    [Parameter(Mandatory)][string[]]$Arguments,
    [switch]$RedirectOutput
  )

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $NodeExecutable
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $false
  foreach ($argument in $Arguments) {
    [void]$startInfo.ArgumentList.Add($argument)
  }

  # Never let inherited Node hooks, debug logging or disabled TLS verification
  # affect the process that owns a production bearer.
  foreach ($name in @(
    'DEBUG',
    'NODE_OPTIONS',
    'NODE_DEBUG',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_EXTRA_CA_CERTS'
  )) {
    [void]$startInfo.Environment.Remove($name)
  }

  if ($RedirectOutput) {
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
  }
  return $startInfo
}

function Assert-NodeSystemCaSupport {
  param(
    [Parameter(Mandatory)][string]$NodeExecutable,
    [Parameter(Mandatory)][string]$WorkingDirectory
  )

  $startInfo = New-NodeProcessStartInfo `
    -NodeExecutable $NodeExecutable `
    -WorkingDirectory $WorkingDirectory `
    -Arguments @('--use-system-ca', '--version') `
    -RedirectOutput
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) {
      throw 'Node.js could not be started.'
    }
    $standardOutput = $process.StandardOutput.ReadToEnd()
    $standardError = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
      throw "Node.js must support --use-system-ca. $standardError"
    }
    if ($standardOutput -notmatch '^v\d+\.\d+\.\d+') {
      throw 'Node.js returned an unexpected version response.'
    }
  } finally {
    $process.Dispose()
  }
}

if ($RemoteDirectory -notmatch '^/[A-Za-z0-9._/-]+$') {
  throw 'RemoteDirectory must be an absolute Unix path without spaces or shell metacharacters.'
}
if ($SshHost -notmatch '^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$') {
  throw 'SshHost must use the user@host form without SSH options or shell metacharacters.'
}
if ([string]::IsNullOrWhiteSpace($Reason) -or $Reason.Trim().Length -lt 10 -or $Reason.Length -gt 500) {
  throw 'Reason must contain between 10 and 500 characters.'
}
if ($Email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
  throw 'Email is not valid.'
}

$resolvedKey = (Resolve-Path -LiteralPath $SshKey).Path
$sshExecutable = (Get-Command ssh.exe -ErrorAction Stop).Source
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$frontendDirectory = Join-Path $repositoryRoot 'frontend'
$viteEntrypoint = Join-Path $frontendDirectory 'node_modules\vite\bin\vite.js'
if (-not (Test-Path -LiteralPath $viteEntrypoint -PathType Leaf)) {
  throw "Frontend dependencies are missing. Run 'npm ci' inside $frontendDirectory before requesting a production session."
}

$selectedPort = Select-LoopbackPort -RequestedPort $Port
Assert-NodeSystemCaSupport -NodeExecutable $nodeExecutable -WorkingDirectory $frontendDirectory

$sshArguments = @(
  '-i', $resolvedKey,
  '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes',
  '-o', 'ConnectTimeout=15',
  $SshHost
)
$remotePrincipalSetup = 'source_ip="${SSH_CONNECTION%% *}" && test -n "$source_ip" && test -n "$USER" && ssh_principal="${USER}@${source_ip}" && '

function Invoke-RemoteJson {
  param([Parameter(Mandatory)][string]$Command)

  $output = & $sshExecutable @sshArguments $Command
  $sshExitCode = $LASTEXITCODE
  if ($sshExitCode -ne 0) {
    throw "The production SSH command failed with exit code $sshExitCode."
  }

  $json = ($output -join "`n").Trim()
  if ([string]::IsNullOrWhiteSpace($json)) {
    throw 'The production SSH command returned no JSON.'
  }
  try {
    return $json | ConvertFrom-Json -Depth 10
  } catch {
    throw 'The production SSH command returned invalid JSON.'
  }
}

$sessionId = $null
$issued = $null
$accessToken = $null
$viteStartInfo = $null
$viteProcess = $null
$viteStarted = $false
$viteExitCode = 0

try {
  $issueRequest = ConvertTo-Base64Json @{
    email = $Email
    reason = $Reason
    ttlMinutes = $TtlMinutes
  }
  $issueCommand = $remotePrincipalSetup `
    + "cd -- '$RemoteDirectory' && docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T -e GUARO_LOCAL_ACCESS_REQUEST_B64='$issueRequest' " `
    + '-e GUARO_LOCAL_ACCESS_SSH_PRINCIPAL="$ssh_principal" backend node dist/auth/local-production-access.cli.js issue --confirm-production'
  $issued = Invoke-RemoteJson -Command $issueCommand

  $candidateSessionId = [string]$issued.sessionId
  if ($candidateSessionId -notmatch '^[a-fA-F0-9]{64}$') {
    throw 'The production CLI returned an invalid session identifier.'
  }
  $sessionId = $candidateSessionId.ToLowerInvariant()

  $accessToken = [string]$issued.accessToken
  if ($accessToken -notmatch '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$') {
    throw 'The production CLI returned an invalid access token.'
  }

  $expiresAtText = [string]$issued.expiresAt
  $expiresAt = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse($expiresAtText, [ref]$expiresAt)) {
    throw 'The production CLI returned an invalid expiration timestamp.'
  }
  $remaining = $expiresAt.ToUniversalTime() - [DateTimeOffset]::UtcNow
  if ($remaining.TotalSeconds -le 0 -or $remaining.TotalMinutes -gt 16) {
    throw 'The production CLI returned a token outside the allowed temporary lifetime.'
  }

  $nonce = New-LocalProductionNonce
  $viteStartInfo = New-NodeProcessStartInfo `
    -NodeExecutable $nodeExecutable `
    -WorkingDirectory $frontendDirectory `
    -Arguments @('--use-system-ca', $viteEntrypoint, '--mode', 'local-production')
  $viteStartInfo.Environment['GUARO_LOCAL_PROD_ACCESS_TOKEN'] = $accessToken
  $viteStartInfo.Environment['GUARO_LOCAL_PROD_NONCE'] = $nonce
  $viteStartInfo.Environment['GUARO_LOCAL_PROD_EXPIRES_AT'] = $expiresAt.ToUniversalTime().ToString('o')
  $viteStartInfo.Environment['GUARO_LOCAL_PROD_PORT'] = [string]$selectedPort

  $viteProcess = [Diagnostics.Process]::new()
  $viteProcess.StartInfo = $viteStartInfo
  if (-not $viteProcess.Start()) {
    throw 'The local Vite process could not be started.'
  }
  $viteStarted = $true

  # ProcessStartInfo retains its mutable environment after Start(). Remove the
  # parent-side copy immediately; the already-created child keeps its copy.
  foreach ($name in @(
    'GUARO_LOCAL_PROD_ACCESS_TOKEN',
    'GUARO_LOCAL_PROD_NONCE',
    'GUARO_LOCAL_PROD_EXPIRES_AT',
    'GUARO_LOCAL_PROD_PORT'
  )) {
    [void]$viteStartInfo.Environment.Remove($name)
  }
  $accessToken = $null
  $issued.accessToken = $null

  Write-Host 'Sesión temporal emitida. El JWT existe únicamente en el proceso hijo de Vite y no se mostrará.' -ForegroundColor Yellow
  Write-Host "Entorno: PRODUCCIÓN | Cuenta: $Email | Expira: $($expiresAt.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss zzz'))" -ForegroundColor Red
  Write-Host "Abre manualmente http://127.0.0.1:$selectedPort/guaro/ . Usa Ctrl+C o 'Cerrar sesión' para revocar." -ForegroundColor Cyan

  $viteProcess.WaitForExit()
  $viteExitCode = $viteProcess.ExitCode
} finally {
  $accessToken = $null
  if ($issued -and $issued.PSObject.Properties.Name -contains 'accessToken') {
    $issued.accessToken = $null
  }
  if ($viteStartInfo) {
    foreach ($name in @(
      'GUARO_LOCAL_PROD_ACCESS_TOKEN',
      'GUARO_LOCAL_PROD_NONCE',
      'GUARO_LOCAL_PROD_EXPIRES_AT',
      'GUARO_LOCAL_PROD_PORT'
    )) {
      [void]$viteStartInfo.Environment.Remove($name)
    }
  }

  if ($viteStarted -and -not $viteProcess.HasExited) {
    try {
      $viteProcess.Kill($true)
      if (-not $viteProcess.WaitForExit(5000)) {
        Write-Warning 'The local Vite child did not confirm termination within five seconds.'
      }
    } catch {
      Write-Warning "Could not confirm local Vite termination: $($_.Exception.Message)"
    }
  }

  if ($sessionId) {
    try {
      $revokeReason = "Local launcher ended: $Reason"
      $revokeRequest = ConvertTo-Base64Json @{
        reason = $revokeReason.Substring(0, [Math]::Min(500, $revokeReason.Length))
      }
      $revokeCommand = $remotePrincipalSetup `
        + "cd -- '$RemoteDirectory' && docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T -e GUARO_LOCAL_ACCESS_REQUEST_B64='$revokeRequest' " `
        + '-e GUARO_LOCAL_ACCESS_SSH_PRINCIPAL="$ssh_principal" backend node dist/auth/local-production-access.cli.js revoke ' `
        + "'$sessionId' --confirm-production"
      $revoked = Invoke-RemoteJson -Command $revokeCommand
      if ($revoked.revoked -ne $true) {
        Write-Warning 'Production did not confirm revocation. The session will still expire automatically.'
      } else {
        Write-Host 'Sesión temporal revocada.' -ForegroundColor Green
      }
    } catch {
      Write-Warning "Could not confirm session revocation: $($_.Exception.Message) The session will still expire automatically."
    }
  }

  if ($viteProcess) {
    $viteProcess.Dispose()
  }
}

if ($viteExitCode -ne 0 -and $viteExitCode -ne 130) {
  throw "The local Vite server exited with code $viteExitCode."
}
