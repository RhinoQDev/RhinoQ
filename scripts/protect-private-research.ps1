<#!
.SYNOPSIS
  Encrypt or restore the local research files that are not public product truth.

.DESCRIPTION
  The key is intentionally kept outside Git under private/research-key.txt.
  The encrypted outputs are safe to commit, but the key must be backed up in a
  separate password manager or private store before moving to another machine.
#>
[CmdletBinding()]
param(
    [ValidateSet('protect', 'restore')]
    [string] $Mode = 'protect',
    [string] $KeyPath = (Join-Path $PSScriptRoot '..\private\research-key.txt'),
    [string] $InputRoot = (Join-Path $PSScriptRoot '..\private'),
    [string] $OutputRoot = (Join-Path $PSScriptRoot '..\private-encrypted')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$files = @(
    'product-direction-v3.md',
    'product-evidence.md',
    'RHINOQ.md',
    'RHINOQ_V2_CHIEN_LUOC.md'
)

function Read-OrCreateKey {
    param([string] $Path)

    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    if (-not (Test-Path -LiteralPath $Path)) {
        $bytes = [byte[]]::new(64)
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) }
        finally { $rng.Dispose() }
        [Convert]::ToBase64String($bytes) | Set-Content -LiteralPath $Path -Encoding ascii -NoNewline
        Write-Host "Created local encryption key: $Path"
        Write-Warning 'Back up this key outside the repository. It is not recoverable from the encrypted files.'
    }
    $key = [Convert]::FromBase64String((Get-Content -LiteralPath $Path -Raw).Trim())
    if ($key.Length -ne 64) {
        throw "Key file must contain a base64-encoded 64-byte encryption key: $Path"
    }
    return $key
}

function Protect-File {
    param([byte[]] $Key, [string] $Source, [string] $Destination)

    $plain = [IO.File]::ReadAllBytes($Source)
    $iv = [byte[]]::new(16)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($iv) }
    finally { $rng.Dispose() }
    $aes = [System.Security.Cryptography.Aes]::Create()
    try {
        $aes.Key = $Key[0..31]
        $aes.IV = $iv
        $aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
        $aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
        $cipher = $aes.CreateEncryptor().TransformFinalBlock($plain, 0, $plain.Length)
    }
    finally { $aes.Dispose() }
    $authenticated = [byte[]]::new(4 + $iv.Length + $cipher.Length)
    [Text.Encoding]::ASCII.GetBytes('RQR1').CopyTo($authenticated, 0)
    $iv.CopyTo($authenticated, 4)
    $cipher.CopyTo($authenticated, 4 + $iv.Length)
    $hmac = [System.Security.Cryptography.HMACSHA256]::new($Key[32..63])
    try { $tag = $hmac.ComputeHash($authenticated) }
    finally { $hmac.Dispose() }
    $envelope = [ordered]@{
        version = 1
        algorithm = 'AES-256-CBC-HMAC-SHA256'
        iv = [Convert]::ToBase64String($iv)
        tag = [Convert]::ToBase64String($tag)
        ciphertext = [Convert]::ToBase64String($cipher)
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($Destination, $envelope + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function Restore-File {
    param([byte[]] $Key, [string] $Source, [string] $Destination)

    $envelope = Get-Content -LiteralPath $Source -Raw | ConvertFrom-Json
    if ($envelope.version -ne 1 -or $envelope.algorithm -ne 'AES-256-CBC-HMAC-SHA256') {
        throw "Unsupported encrypted research envelope: $Source"
    }
    $iv = [Convert]::FromBase64String($envelope.iv)
    $tag = [Convert]::FromBase64String($envelope.tag)
    $cipher = [Convert]::FromBase64String($envelope.ciphertext)
    $authenticated = [byte[]]::new(4 + $iv.Length + $cipher.Length)
    [Text.Encoding]::ASCII.GetBytes('RQR1').CopyTo($authenticated, 0)
    $iv.CopyTo($authenticated, 4)
    $cipher.CopyTo($authenticated, 4 + $iv.Length)
    $hmac = [System.Security.Cryptography.HMACSHA256]::new($Key[32..63])
    try { $expectedTag = $hmac.ComputeHash($authenticated) }
    finally { $hmac.Dispose() }
    if ($expectedTag.Length -ne $tag.Length) { throw "Ciphertext authentication failed: $Source" }
    $difference = 0
    for ($index = 0; $index -lt $tag.Length; $index++) { $difference = $difference -bor ($expectedTag[$index] -bxor $tag[$index]) }
    if ($difference -ne 0) { throw "Ciphertext authentication failed: $Source" }
    $aes = [System.Security.Cryptography.Aes]::Create()
    try {
        $aes.Key = $Key[0..31]
        $aes.IV = $iv
        $aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
        $aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
        $plain = $aes.CreateDecryptor().TransformFinalBlock($cipher, 0, $cipher.Length)
    }
    finally { $aes.Dispose() }
    [IO.File]::WriteAllBytes($Destination, $plain)
}

$key = Read-OrCreateKey -Path $KeyPath
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null

foreach ($name in $files) {
    if ($Mode -eq 'protect') {
        $source = Join-Path $InputRoot $name
        if (-not (Test-Path -LiteralPath $source)) {
            Write-Warning "Skipping missing local research file: $source"
            continue
        }
        $destination = Join-Path $OutputRoot "$name.rqe"
        Protect-File -Key $key -Source $source -Destination $destination
        Write-Host "Protected $name -> $destination"
    } else {
        $source = Join-Path $OutputRoot "$name.rqe"
        if (-not (Test-Path -LiteralPath $source)) {
            Write-Warning "Skipping missing encrypted research file: $source"
            continue
        }
        $destination = Join-Path $InputRoot $name
        Restore-File -Key $key -Source $source -Destination $destination
        Write-Host "Restored $source -> $destination"
    }
}
