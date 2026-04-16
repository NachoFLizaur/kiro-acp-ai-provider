import { existsSync } from "node:fs"
import { execSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

export interface AuthStatus {
  installed: boolean
  authenticated: boolean
  version?: string
  tokenPath?: string
}

/**
 * Check if kiro-cli is installed and authenticated.
 * Does not start kiro-cli — just checks the filesystem.
 */
export function verifyAuth(): AuthStatus {
  // Check if kiro-cli is installed
  let installed = false
  let version: string | undefined
  try {
    version = execSync("kiro-cli --version", {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    })
      .toString()
      .trim()
    installed = true
  } catch {
    return { installed: false, authenticated: false }
  }

  // Check for auth token
  const tokenPath = join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json")
  const hasToken = existsSync(tokenPath)

  // Also check KIRO_API_KEY env var
  const hasApiKey = !!process.env.KIRO_API_KEY

  return {
    installed,
    authenticated: hasToken || hasApiKey,
    version,
    tokenPath: hasToken ? tokenPath : undefined,
  }
}
