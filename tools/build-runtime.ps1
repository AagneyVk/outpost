param([string]$PublicCertificateBundle)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$dockerCommand=(Get-Command docker -ErrorAction SilentlyContinue).Source
if(!$dockerCommand){$dockerCommand=Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'}
if(!(Test-Path -LiteralPath $dockerCommand)){throw 'Docker Desktop is required on the developer build computer.'}
$cacheContainer='outpost-public-cache-'+[guid]::NewGuid().ToString('N')
$previousSystemCA=$env:NODE_USE_SYSTEM_CA
$previousExtraCA=$env:NODE_EXTRA_CA_CERTS
Push-Location $projectRoot
try {
    $env:NODE_USE_SYSTEM_CA='1'
    if(!$PublicCertificateBundle){
        $certificateDirectory=Join-Path $projectRoot '.runtime-build'
        New-Item -ItemType Directory -Path $certificateDirectory -Force | Out-Null
        $PublicCertificateBundle=Join-Path $certificateDirectory 'public-build-ca.pem'
        $seenCertificates=@{}
        $certificateText=New-Object System.Text.StringBuilder
        foreach($location in @('CurrentUser','LocalMachine')){
            $store=New-Object System.Security.Cryptography.X509Certificates.X509Store('Root',$location)
            try {
                $store.Open('ReadOnly')
                foreach($certificate in $store.Certificates){
                    if(!$seenCertificates.ContainsKey($certificate.Thumbprint)){
                        $seenCertificates[$certificate.Thumbprint]=$true
                        [void]$certificateText.AppendLine('-----BEGIN CERTIFICATE-----')
                        [void]$certificateText.AppendLine([Convert]::ToBase64String($certificate.RawData,[Base64FormattingOptions]::InsertLineBreaks))
                        [void]$certificateText.AppendLine('-----END CERTIFICATE-----')
                    }
                }
            } finally {$store.Close()}
        }
        [IO.File]::WriteAllText($PublicCertificateBundle,$certificateText.ToString(),[Text.Encoding]::ASCII)
    }
    $env:NODE_EXTRA_CA_CERTS=(Resolve-Path -LiteralPath $PublicCertificateBundle).Path
    $buildArgs=@('build','--progress=plain','--file','runtime/Dockerfile.debian32','--target','guest','--tag','outpost-debian32-cache-base')
    if($PublicCertificateBundle){
        $certificatePath=(Resolve-Path -LiteralPath $PublicCertificateBundle).Path
        $buildArgs+=@('--secret',"id=build_ca,src=$certificatePath")
    }
    $buildArgs+='runtime'
    & $dockerCommand @buildArgs
    if($LASTEXITCODE -ne 0){throw 'Browser base build failed.'}
    & $dockerCommand build --file runtime/Dockerfile.startup-cache --tag outpost-firefox-public-cache runtime
    if($LASTEXITCODE -ne 0){throw 'Public code-cache image build failed.'}
    & $dockerCommand run --name $cacheContainer --network none --cap-drop ALL --security-opt no-new-privileges --shm-size 256m outpost-firefox-public-cache
    if($LASTEXITCODE -ne 0){throw 'Offline public code-cache generation failed.'}
    New-Item -ItemType Directory -Force public/firefox-startup | Out-Null
    foreach ($fileName in @('compatibility.ini','startupCache.4.little','scriptCache.bin','scriptCache-child.bin')) {
        $oldCache = Join-Path public/firefox-startup $fileName
        if (Test-Path -LiteralPath $oldCache) { Remove-Item -LiteralPath $oldCache }
    }
    & $dockerCommand cp "${cacheContainer}:/tmp/public-startup-cache/." public/firefox-startup
    if($LASTEXITCODE -ne 0){throw 'Code-cache copy failed.'}
    & $dockerCommand build --file runtime/Dockerfile.vnc32 --output type=local,dest=public/vnc32 runtime
    if($LASTEXITCODE -ne 0){throw 'Browser-local guest filesystem build failed.'}
    foreach($script in @('tools/fetch-assets.mjs','tools/patch-v86-network.mjs','tools/vendor-display.mjs','tools/vendor-terminal.mjs','tools/prepare-runtime.mjs')){
        & node $script
        if($LASTEXITCODE -ne 0){throw "Preparation failed: $script"}
    }
} finally {
    & $dockerCommand rm --force $cacheContainer 2>$null | Out-Null
    $env:NODE_USE_SYSTEM_CA=$previousSystemCA
    $env:NODE_EXTRA_CA_CERTS=$previousExtraCA
    Pop-Location
}
