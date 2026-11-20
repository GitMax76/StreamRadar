[CmdletBinding()]
param(
    [ValidatePattern('^[0-9]{1,3}(\.[0-9]{1,3}){3}$')]
    [string]$Nas = '192.168.1.27',
    [ValidatePattern('^[A-Za-z_][A-Za-z0-9_.-]*$')]
    [string]$Utente = 'ZyMAX',
    [ValidateNotNullOrEmpty()]
    [string]$Ref = 'HEAD',
    [switch]$SoloPacchetto
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$project = '/DATA/AppData/StreamSuite-Prova'
$destination = "${Utente}@${Nas}"
$packageName = "streamsuite-prova-$([guid]::NewGuid().ToString('N')).tar.gz"
$package = Join-Path ([IO.Path]::GetTempPath()) $packageName
$remotePackage = "/tmp/$packageName"

Get-Command git -ErrorAction Stop | Out-Null
if (-not $SoloPacchetto) {
    Get-Command scp, ssh -ErrorAction Stop | Out-Null
}
$commit = & git -C $repo rev-parse --verify --end-of-options "$Ref^{commit}"
if ($LASTEXITCODE -ne 0) { throw "Revisione Git non disponibile: $Ref" }

$keepPackage = $false
try {
    if (-not $SoloPacchetto) {
        Write-Host "Preparazione StreamSuite di prova dal commit $($commit.Substring(0, 8))."
    }
    & git -C $repo archive --format=tar.gz -o $package $commit -- compose.yaml gateway manager radar scripts/zima-prova.sh
    if ($LASTEXITCODE -ne 0) { throw 'Creazione del pacchetto fallita.' }

    if ($SoloPacchetto) {
        $keepPackage = $true
        Write-Output $package
        return
    }

    Write-Host "Copia del pacchetto su $Nas."
    & scp $package "${destination}:$remotePackage"
    if ($LASTEXITCODE -ne 0) { throw 'Copia sul NAS fallita. Aggiornamento interrotto.' }

    Write-Host 'Aggiornamento e verifica dei servizi sul NAS.'
    $remoteCommand = @(
        "sudo test -f $project/.env.prova",
        "sudo tar -xzf $remotePackage -C $project",
        "sudo bash $project/scripts/zima-prova.sh $Nas",
        "rm -f -- $remotePackage"
    ) -join ' && '
    & ssh -t $destination $remoteCommand
    if ($LASTEXITCODE -ne 0) { throw "Aggiornamento o verifica falliti sul NAS. Controlla il messaggio sopra." }
} finally {
    if (-not $keepPackage -and (Test-Path -LiteralPath $package -PathType Leaf)) {
        Remove-Item -LiteralPath $package -ErrorAction SilentlyContinue
    }
}

Write-Host "Manager di prova: http://${Nas}:8790/manager/"
