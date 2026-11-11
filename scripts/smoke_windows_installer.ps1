$ErrorActionPreference = 'Stop'
# Never expose a release upload token to a test app.
Remove-Item Env:GH_TOKEN, Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$setup = Join-Path $PWD "dist/HumanStudy-Hub-Setup-$version.exe"
$installed = Join-Path $env:RUNNER_TEMP 'humanstudy-installed'
$profile = Join-Path $env:RUNNER_TEMP 'humanstudy-smoke-profile'
$installer = Start-Process -FilePath $setup -ArgumentList '/S', "/D=$installed" -Wait -PassThru
if ($installer.ExitCode -ne 0) { throw "NSIS exited $($installer.ExitCode)" }
$exe = Join-Path $installed 'HumanStudy Hub.exe'
if ((Get-Item $exe).VersionInfo.ProductVersion -notlike "$version*") {
  throw 'The installed app version does not match the candidate.'
}
$sample = Join-Path $installed 'resources/sample'
# The program records the file digest; study.json records the engine's canonical JSON digest.
$protocol = (Get-Content (Join-Path $sample 'program.json') -Raw | ConvertFrom-Json).extensions.scholarly.protocol
$digest = (Get-FileHash (Join-Path $sample $protocol.path) -Algorithm SHA256).Hash
if ($digest -ine $protocol.sha256) { throw 'The installed protocol sample does not match its declared digest.' }
$env:APPDATA = $profile
New-Item -Path $profile -ItemType Directory -Force | Out-Null
$app = Start-Process -FilePath $exe -ArgumentList '--disable-gpu' -PassThru
try {
  for ($attempt = 0; $attempt -lt 45; $attempt++) {
    $app.Refresh()
    if ($app.HasExited) { throw "The packaged app exited $($app.ExitCode) before showing a window." }
    if ($app.MainWindowHandle -ne 0) {
      Get-FileHash $setup -Algorithm SHA256 | Format-List
      Write-Output "Windows $([System.Environment]::OSVersion.Version): opened $($app.MainWindowTitle) ($version)."
      return
    }
    Start-Sleep -Seconds 1
  }
  throw 'The packaged app did not show a window within 45 seconds.'
} finally {
  if (!$app.HasExited) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue }
}
