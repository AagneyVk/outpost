param(
    [Parameter(Mandatory=$true)][string]$Candidate,
    [Parameter(Mandatory=$true)][string]$Destination,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$Thumbprint,
    [Parameter(Mandatory=$true)][string]$SignTool,
    [Parameter(Mandatory=$true)][uri]$TimestampUrl
)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $Candidate).Path
$tool = (Resolve-Path -LiteralPath $SignTool).Path
$output = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $output) { throw 'Choose a new path for the signed executable.' }
if ($TimestampUrl.Scheme -notin @('https', 'http')) { throw 'Choose an RFC 3161 timestamp URL.' }
$signer = Get-Item -LiteralPath "Cert:\CurrentUser\My\$Thumbprint"
$now = Get-Date
if (!$signer.HasPrivateKey -or $signer.NotBefore -gt $now -or $signer.NotAfter -lt $now -or
    $signer.EnhancedKeyUsageList.ObjectId -notcontains '1.3.6.1.5.5.7.3.3') {
    throw 'The selected certificate must be current, allow code signing, and have an accessible private key.'
}
$staging = Join-Path (Split-Path $output -Parent) ('outpost-sign-' + [guid]::NewGuid().ToString('N') + '.exe')
try {
    Copy-Item -LiteralPath $source -Destination $staging
    & $tool sign /sha1 $Thumbprint /fd SHA256 /tr $TimestampUrl.AbsoluteUri /td SHA256 $staging
    if ($LASTEXITCODE -ne 0) { throw 'Authenticode signing failed.' }
    & $tool verify /pa /v /tw $staging
    if ($LASTEXITCODE -ne 0) { throw 'Authenticode verification failed.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $staging
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $Thumbprint -or
        !$signature.TimeStamperCertificate) {
        throw 'The expected trusted and timestamped signature was not found.'
    }
    Move-Item -LiteralPath $staging -Destination $output
    Get-FileHash -LiteralPath $output -Algorithm SHA256
} finally {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging }
}
