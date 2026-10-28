# Adds or removes one folder in the user PATH, for the Windows installer
# (packaging/windows/installer.nsh, docs/plans/windows.md §13.5). It needs only
# Windows PowerShell 5.1 and no administrator rights.
#
#   powershell -File path-entry.ps1 -Add <folder>
#   powershell -File path-entry.ps1 -Remove <folder>
#
# [Environment]::SetEnvironmentVariable would rewrite the PATH as a plain string,
# and every %VAR% entry in it would stop expanding; NSIS string functions cut a
# long PATH at 1024 characters. This reads the value as written, changes only
# the one entry, writes it back with the same kind, and tells Explorer, so a
# terminal opened afterwards sees it. A failed read stops before any write.
param(
  [string]$Add,
  [string]$Remove
)
$ErrorActionPreference = 'Stop'

$folder = if ($Add) { $Add } else { $Remove }
if (-not $folder) { throw 'Name a folder with -Add or -Remove.' }

function Same-Folder([string]$Left, [string]$Right) {
  $Left.Trim().Trim('"').TrimEnd('\', '/') -ieq $Right.Trim().Trim('"').TrimEnd('\', '/')
}

$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
$current = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$entries = @($current -split ';' | Where-Object { $_.Trim() })
$present = @($entries | Where-Object { Same-Folder $_ $folder }).Count -gt 0

if ($Add) {
  if ($present) { exit 0 }
  $next = @($entries) + $folder
} else {
  if (-not $present) { exit 0 }
  $next = @($entries | Where-Object { -not (Same-Folder $_ $folder) })
}

$kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
if ($key.GetValueNames() -contains 'Path' -and $key.GetValueKind('Path') -eq 'String') {
  $kind = [Microsoft.Win32.RegistryValueKind]::String
}
$key.SetValue('Path', ($next -join ';'), $kind)

Add-Type -Namespace SolusPath -Name Env -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);'
$result = [System.UIntPtr]::Zero
[void][SolusPath.Env]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
