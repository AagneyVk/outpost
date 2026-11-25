param(
    [Parameter(Mandatory=$true)][string]$Destination,
    [Parameter(Mandatory=$true)][string]$NodeLicense
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node.exe).Source
if ((& $node -p 'process.arch') -ne 'x64') { throw 'Use Windows x64 Node.js.' }
$license = (Resolve-Path -LiteralPath $NodeLicense).Path
if (Test-Path -LiteralPath $Destination) { throw 'Choose a new executable path.' }
$compilerRoot = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('outpost-pack-' + [Guid]::NewGuid().ToString('N'))
$payload = Join-Path $temp 'runtime'
New-Item -ItemType Directory -Path $payload | Out-Null
try {
    $paths = @(
        'server.mjs', 'relay.mjs', 'LICENSE', 'THIRD_PARTY.md',
        'experiments/memory-profile/memory-profile.mjs',
        'public/workstation.css', 'public/tools.css', 'public/portable.js', 'public/theme',
        'public/gecko-lab/engine/gecko-input-v7.js',
        'public/gecko-lab/engine/gecko-input-v7.wasm.zst', 'public/gecko-lab/engine/LICENSE',
        'node_modules/ws', 'node_modules/ipaddr.js'
    )
    $paths += Get-ChildItem -LiteralPath (Join-Path $root 'public/gecko-lab') -File |
        ForEach-Object { 'public/gecko-lab/' + $_.Name }
    foreach ($relative in $paths) {
        $target = Join-Path $payload $relative
        New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $root $relative) -Destination $target -Recurse
    }
    Copy-Item -LiteralPath $node -Destination (Join-Path $payload 'node.exe')
    Copy-Item -LiteralPath $license -Destination (Join-Path $payload 'NODE-LICENSE.txt')
    $zip = Join-Path $temp 'payload.zip'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($payload, $zip)
    $output = [IO.Path]::GetFullPath($Destination)
    $flags = @('/nologo', '/target:exe', '/platform:x64', "/out:$output",
        "/resource:$zip,OutpostRuntime", "/reference:$compilerRoot\System.IO.Compression.dll",
        "/reference:$compilerRoot\System.IO.Compression.FileSystem.dll",
        (Join-Path $PSScriptRoot 'OutpostLauncher.cs'))
    & (Join-Path $compilerRoot 'csc.exe') @flags
    if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
    Get-Item -LiteralPath $output
} finally {
    $actual = [IO.Path]::GetFullPath($temp)
    if ((Split-Path $actual -Parent) -eq [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') -and
        (Split-Path $actual -Leaf) -match '^outpost-pack-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $actual -Recurse -Force
    }
}
