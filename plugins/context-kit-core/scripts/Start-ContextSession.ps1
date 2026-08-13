<#
.SYNOPSIS
    Pick a context repo under ~/.context and start a Claude session in it.

.DESCRIPTION
    Walks the clone root one level at a time (owner -> repo), prompting at each level,
    and stops descending as soon as the chosen directory *is* a repo. What counts as
    a repo is decided by content, never by depth: a context repo has context.json at
    its root, the plugin marketplace has .claude-plugin/marketplace.json, and anything
    else with a .git directory is a checkout too. Then cd's there and runs `claude`.

    Why this exists: everything else in this plugin answers "which context does THIS
    project load" from inside a session that has already started somewhere. This is the
    other direction — start from the context and let it choose the directory — which is
    what you want from a desktop shortcut, where there is no working directory to speak
    of. It is deliberately the one interactive script here: a menu is the point, not a
    fallback, so unlike link-context.mjs it prompts rather than taking the repo as an
    argument.

    It reads nothing and writes nothing in the repos it lists (bar -Shortcut, which
    writes only its own copy and the .lnk): the session's own SessionStart hook does the
    loading, exactly as it would had you cd'd there by hand.

.PARAMETER Root
    Clone root to browse. Defaults to ~/.context — the layout context-repo.sh and
    plugin-repo.sh clone into (~/.context/<owner>/<repo>). Point it elsewhere if you
    keep checkouts somewhere else; nothing here assumes the managed layout.

.PARAMETER DryRun
    Print the directory that would be entered instead of launching Claude.

.PARAMETER Shortcut
    Install a stable copy of this script at the clone root and put a Desktop shortcut on
    it, then exit. Windows only — see the .sh sibling for macOS and Linux.

    The copy is the point. An installed plugin lives at a versioned path
    (~/.claude/plugins/cache/.../context-kit-core/[version]/scripts/), so a shortcut aimed
    straight at it breaks silently on the next plugin update. Re-run -Shortcut after an
    update to refresh the copy; the shortcut itself never needs touching.

.PARAMETER ShortcutName
    Name for the Desktop shortcut. Defaults to "Claude context session".

.PARAMETER ClaudeArgs
    Everything left over is passed through to `claude` verbatim.

.EXAMPLE
    .\Start-ContextSession.ps1
    .\Start-ContextSession.ps1 --continue
    .\Start-ContextSession.ps1 -DryRun
    .\Start-ContextSession.ps1 -Shortcut
#>
[CmdletBinding()]
param(
    [string] $Root = (Join-Path $HOME '.context'),
    [switch] $DryRun,
    [switch] $Shortcut,
    [string] $ShortcutName = 'Claude context session',
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $ClaudeArgs
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# $IsWindows only exists from PowerShell 6; Windows PowerShell 5.1 only ever runs on
# Windows, so its absence is the answer. Test-Path rather than a bare reference because
# StrictMode makes reading an undefined variable an error.
$onWindows = if (Test-Path Variable:\IsWindows) { $IsWindows } else { $true }

# A double-clicked shortcut owns its console window, so an error that just exits takes the
# message with it — the user sees a black flash and nothing else. Pause on the way out
# unless input is redirected (piped/CI), where Read-Host would block forever on EOF.
function Exit-Fatal {
    param([string] $Message, [int] $Code = 1)
    Write-Host $Message -ForegroundColor Red
    try {
        if (-not [Console]::IsInputRedirected) { Read-Host 'Press Enter to close' | Out-Null }
    } catch { }
    exit $Code
}

function Test-IsRepo {
    param([string] $Dir)
    (Test-Path -LiteralPath (Join-Path $Dir 'context.json')) -or
    (Test-Path -LiteralPath (Join-Path $Dir (Join-Path '.claude-plugin' 'marketplace.json'))) -or
    (Test-Path -LiteralPath (Join-Path $Dir '.git'))
}

function Get-Label {
    param([string] $Dir)
    if (Test-Path -LiteralPath (Join-Path $Dir (Join-Path '.claude-plugin' 'marketplace.json'))) { return 'marketplace' }
    if (Test-Path -LiteralPath (Join-Path $Dir 'context.json'))                                  { return 'context repo' }
    if (Test-Path -LiteralPath (Join-Path $Dir '.git'))                                          { return 'checkout' }
    return ''
}

# Path under the clone root, for display. Both separators are trimmed: PowerShell on macOS
# and Linux builds paths with '/', Windows with '\', and this runs on all three.
function Get-RelativeLabel {
    param([string] $Dir)
    $Dir.Substring($Root.Length).TrimStart([char]'\', [char]'/')
}

# Returns the chosen directory's full path, $null to quit, or the string 'BACK'
# to hand control back to the caller's menu.
function Select-Directory {
    param([string] $Dir, [int] $Depth = 0)

    while ($true) {
        $children = @(
            Get-ChildItem -LiteralPath $Dir -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -notlike '.*' } |
                Sort-Object Name
        )
        if ($children.Count -eq 0) { return $Dir }

        $rel = Get-RelativeLabel $Dir
        Write-Host ''
        if ($rel) { Write-Host "  $rel" -ForegroundColor Cyan }
        else      { Write-Host "  Context repos  ($Root)" -ForegroundColor Cyan }
        Write-Host ''

        for ($i = 0; $i -lt $children.Count; $i++) {
            $label = Get-Label $children[$i].FullName
            $line  = '   {0,2}) {1}' -f ($i + 1), $children[$i].Name
            Write-Host $line -NoNewline
            if ($label) { Write-Host "  [$label]" -ForegroundColor DarkGray } else { Write-Host '' }
        }

        Write-Host ''
        if ($Depth -gt 0) { Write-Host '    b) back' -ForegroundColor DarkGray }
        Write-Host '    q) quit' -ForegroundColor DarkGray

        # No console to read from — piped, redirected, or a -NonInteractive host. Read-Host
        # throws there, and an unhandled throw from a menu reads as a crash; treat it as
        # "quit", which is what a caller with no way to answer meant.
        try { $answer = (Read-Host "`nSelect").Trim() } catch { Write-Host ''; return $null }

        if ($answer -eq 'q' -or $answer -eq '') { return $null }
        if ($answer -eq 'b') {
            if ($Depth -gt 0) { return 'BACK' }
            continue
        }

        $n = 0
        if (-not [int]::TryParse($answer, [ref] $n) -or $n -lt 1 -or $n -gt $children.Count) {
            Write-Host "  '$answer' is not one of the options." -ForegroundColor Yellow
            continue
        }

        $chosen = $children[$n - 1].FullName
        if (Test-IsRepo $chosen) { return $chosen }

        $result = Select-Directory -Dir $chosen -Depth ($Depth + 1)
        if ($result -eq 'BACK') { continue }
        return $result
    }
}

# ---------------------------------------------------------------- desktop shortcut

function Install-Shortcut {
    if (-not $onWindows) {
        Exit-Fatal ("-Shortcut is Windows-only: a .lnk is a Windows object, and the desktop entry`n" +
                    "formats elsewhere are not the same file. Use start-context-session.sh --shortcut`n" +
                    "from this same scripts/ directory, which writes a .desktop (Linux) or .command (macOS).")
    }

    # A stable home outside the versioned plugin directory, and not touched by plugin
    # updates. Created if absent: -Shortcut is the one mode that may run before there is
    # anything to browse, and refusing to make the shortcut until the user has cloned
    # something is backwards — the shortcut is how they get there.
    if (-not (Test-Path -LiteralPath $Root)) { New-Item -ItemType Directory -Path $Root -Force | Out-Null }
    $Root = (Resolve-Path -LiteralPath $Root).ProviderPath
    $installed = Join-Path $Root 'Start-ContextSession.ps1'
    $source    = $PSCommandPath
    if ($source -and ($source -ne $installed)) {
        Copy-Item -LiteralPath $source -Destination $installed -Force
        Write-Host "  ok    copied this script to $installed" -ForegroundColor Green
    } else {
        Write-Host "  ok    already running from $installed" -ForegroundColor DarkGray
    }

    # GetFolderPath, not "$HOME\Desktop": on a machine with OneDrive Known Folder Move the
    # real Desktop is under the OneDrive folder, and a shortcut written to the other path
    # is invisible to the person who asked for it.
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $desktop) { Exit-Fatal 'Could not locate your Desktop folder.' }

    # Whichever PowerShell is running this is the one the shortcut should keep using —
    # pwsh.exe and powershell.exe are different hosts with different module paths.
    $psExe = try { (Get-Process -Id $PID).Path } catch { $null }
    if (-not $psExe) { $psExe = Join-Path $PSHOME 'powershell.exe' }

    $lnkPath = Join-Path $desktop "$ShortcutName.lnk"
    $shell   = New-Object -ComObject WScript.Shell
    $lnk     = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = $psExe
    # -ExecutionPolicy Bypass is not optional: the default policy on a stock Windows install
    # refuses to run an unsigned .ps1, and a shortcut that trips it looks like it did nothing.
    $lnk.Arguments        = '-NoLogo -ExecutionPolicy Bypass -File "{0}"' -f $installed
    $lnk.WorkingDirectory = $Root
    $lnk.Description      = 'Pick a context repo and start a Claude session in it'
    $lnk.Save()

    Write-Host "  ok    shortcut written to $lnkPath" -ForegroundColor Green
    Write-Host ''
    Write-Host '        Re-run with -Shortcut after a plugin update to refresh the copy;' -ForegroundColor DarkGray
    Write-Host '        the shortcut points at the copy, so it never needs changing.'    -ForegroundColor DarkGray
    exit 0
}

# ---------------------------------------------------------------- main

# Before the clone-root check, deliberately: Install-Shortcut creates the root if it has to.
if ($Shortcut) { Install-Shortcut }

if (-not (Test-Path -LiteralPath $Root)) {
    Exit-Fatal "Clone root not found: $Root"
}
$Root = (Resolve-Path -LiteralPath $Root).ProviderPath

$target = Select-Directory -Dir $Root
if ($null -eq $target -or $target -eq 'BACK') {
    Write-Host 'Nothing selected.' -ForegroundColor DarkGray
    exit 0
}

if ($DryRun) {
    Write-Host ''
    Write-Host $target
    exit 0
}

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
    Exit-Fatal 'claude was not found on PATH.'
}

Set-Location -LiteralPath $target
# Cosmetic, and not every host has a settable title (VS Code's integrated terminal, some
# terminals on macOS) — never let it take the session down with it.
try { $host.UI.RawUI.WindowTitle = "claude - $(Get-RelativeLabel $target)" } catch { }
Write-Host ''
Write-Host "-> $target" -ForegroundColor DarkGray
Write-Host ''

# .Source is empty when `claude` resolves to a function or alias rather than an executable;
# fall back to the name so a shim install still launches.
$exe = if ($claude.Source) { $claude.Source } else { 'claude' }
$global:LASTEXITCODE = 0
if ($ClaudeArgs) { & $exe @ClaudeArgs } else { & $exe }
exit $LASTEXITCODE
