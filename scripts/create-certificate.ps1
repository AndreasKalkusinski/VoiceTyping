# Create a self-signed certificate for code signing
# Run this script once in PowerShell as Administrator

$certName = "JeanTools Voice Typing"
$certPassword = "voicetyping123"  # Change this!
$certPath = "$PSScriptRoot\..\certs"
$pfxPath = "$certPath\certificate.pfx"

# Create certs directory if it doesn't exist
if (!(Test-Path $certPath)) {
    New-Item -ItemType Directory -Path $certPath -Force
}

# Create self-signed certificate
$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject "CN=$certName, O=JeanTools, L=Germany" `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter (Get-Date).AddYears(5)

Write-Host "Certificate created with thumbprint: $($cert.Thumbprint)"

# Export to PFX
$securePassword = ConvertTo-SecureString -String $certPassword -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePassword

Write-Host ""
Write-Host "Certificate exported to: $pfxPath"
Write-Host ""
Write-Host "IMPORTANT: Set these environment variables before building:"
Write-Host "  set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$certPassword"
Write-Host ""
Write-Host "Or add to your system environment variables."
Write-Host ""
Write-Host "Note: Users will see a warning when running the app because"
Write-Host "      the certificate is not from a trusted CA."
