# Checks the mod in this worktree, then fast-forwards the live worktree
# (the folder CLAUDE_CODE_PLUGIN_DIRS loads) to the checked commit.
param(
  [string]$Live = (Join-Path $PSScriptRoot '..\..\cc-mods-sub-discuss-live')
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Step([string]$Name, [scriptblock]$Run) {
  Write-Host "==> $Name"
  & $Run
  if ($LASTEXITCODE -ne 0) { throw "$Name failed; live is unchanged." }
}

if (git status --porcelain) { throw 'Uncommitted changes: commit them first, so live gets exactly what was tested.' }

Step 'validate'  { claude plugin validate . }
Step 'typecheck' { npx -y -p typescript@5 tsc -p . }
Step 'test'      { claude plugin test . }

$branch = git branch --show-current
Step "fast-forward live to $branch" { git -C $Live merge --ff-only $branch }
Write-Host "Released $(git rev-parse --short HEAD) to $Live"
