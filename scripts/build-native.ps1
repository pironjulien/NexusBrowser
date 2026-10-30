# Builds the engine into a candidate folder outside the repository and OneDrive (~\.nexus\build\nexus-browser), never
# over a running installation. -Runtime win-x64|win-arm64: self-contained single file (the release build).
param([string]$OutputDirectory, [string]$Runtime)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime.ps1')
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $buildRoot 'candidate' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if ($OutputDirectory.StartsWith([IO.Path]::GetFullPath($repositoryRoot) + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Native build output must stay outside the repository and OneDrive.'
}
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw '.NET 10 SDK is required to build NexusBrowser.' }
if (Test-Path -LiteralPath $OutputDirectory) { Remove-Item -LiteralPath $OutputDirectory -Recurse -Force }
$arguments = @('publish', (Join-Path $repositoryRoot 'native\NexusBrowser.csproj'), '-c', 'Release', '-o', $OutputDirectory, '--nologo')
if ($Runtime) {
    $arguments += @('-r', $Runtime, '--self-contained', 'true', '-p:PublishSingleFile=true',
        '-p:IncludeNativeLibrariesForSelfExtract=true', '-p:EnableCompressionInSingleFile=true', '-p:DebugType=none')
}
& dotnet @arguments
if ($LASTEXITCODE) { throw 'Native NexusBrowser build failed.' }
$candidate = Join-Path $OutputDirectory 'NexusBrowser.exe'
$expected = (Get-Content (Join-Path $repositoryRoot 'VERSION') -Raw).Trim()
# An ARM64 build runs on ARM64 Windows only (an ARM64 PC also runs x64 builds): checked where it can run.
$hostArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($Runtime -ne 'win-arm64' -or $hostArch -eq 'ARM64') {
    $version = Invoke-Native $candidate @('--version') 30
    if ($version.Code -or $version.Output -ne $expected) { throw "Built engine answers '$($version.Output)', expected $expected." }
} elseif (-not (Test-Path -LiteralPath $candidate)) { throw 'ARM64 engine not built.' }
Write-Host "NexusBrowser $expected built in $OutputDirectory"
