# Release gate for the Windows build (#280): fails unless the installer and the unpacked app each
# carry a valid, timestamped Authenticode signature from $Signer. SignTool only warns when the
# timestamp server fails, and an untimestamped signature stops validating once the short-lived
# Artifact Signing certificate expires (about three days).
param(
  [Parameter(Mandatory)][string]$Installer,
  [Parameter(Mandatory)][string]$Signer,
  # The packager keeps its stage here with T3CODE_DESKTOP_KEEP_STAGE; win-unpacked is not in release/.
  [string]$StageParent = [IO.Path]::GetTempPath()
)
$ErrorActionPreference = 'Stop'
$failed = $false
$files = @($Installer)
$unpacked = $null
$stages = @(Get-ChildItem -LiteralPath $StageParent -Directory -Filter 't3code-desktop-win-stage-*')
if ($stages.Count -eq 1) {
  $unpacked = Join-Path $stages[0].FullName 'app/dist/win-unpacked'
  $files += Join-Path $unpacked 'LibraOS Next.exe'
} else {
  Write-Output "::error::expected one kept build stage in $StageParent, found $($stages.Count)"
  $failed = $true
}
foreach ($file in $files) {
  if (-not (Test-Path -LiteralPath $file)) {
    Write-Output "::error::missing $file"
    $failed = $true
    continue
  }
  $sig = Get-AuthenticodeSignature -LiteralPath $file
  $subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '(none)' }
  $stamp = if ($sig.TimeStamperCertificate) { "timestamped by $($sig.TimeStamperCertificate.Subject)" } else { 'no timestamp' }
  Write-Output "${file}: $($sig.Status), signer $subject, $stamp"
  if ($sig.Status -ne 'Valid' -or -not $subject.Contains($Signer)) {
    Write-Output "::error::$file is not validly signed by $Signer"
    $failed = $true
  } elseif (-not $sig.TimeStamperCertificate) {
    Write-Output "::error::$file has no timestamp, so its signature expires with the signing certificate"
    $failed = $true
  }
}
# Information only: the other binaries electron-builder signs (signExts).
if ($unpacked -and (Test-Path -LiteralPath $unpacked)) {
  $unsigned = @(Get-ChildItem -LiteralPath $unpacked -Recurse -File |
    Where-Object { $_.Extension -in '.exe', '.dll', '.node' } |
    Where-Object { (Get-AuthenticodeSignature -LiteralPath $_.FullName).Status -ne 'Valid' })
  foreach ($file in $unsigned) { Write-Output "not signed: $($file.FullName)" }
  if ($unsigned.Count -gt 0) { Write-Output "::warning::$($unsigned.Count) binaries in win-unpacked are not signed" }
}
if ($failed) { exit 1 }
