import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

export interface AuthStatus {
  installed: boolean
  authenticated: boolean
  version?: string
  tokenPath?: string
}

/** Check if kiro-cli is installed and authenticated (filesystem check only). */
export function verifyAuth(): AuthStatus {
  let installed = false
  let version: string | undefined
  try {
    version = execFileSync("kiro-cli", ["--version"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    })
      .toString()
      .trim()
    installed = true
  } catch {
    return { installed: false, authenticated: false }
  }

  const tokenPath = join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json")
  const hasToken = existsSync(tokenPath)
  const hasApiKey = !!process.env.KIRO_API_KEY

  return {
    installed,
    authenticated: hasToken || hasApiKey,
    version,
    tokenPath: hasToken ? tokenPath : undefined,
  }
}
