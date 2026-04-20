import { existsSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

export interface AuthStatus {
  installed: boolean
  authenticated: boolean
  version?: string
  tokenPath?: string
}

/** Check if kiro-cli is installed and authenticated. */
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

  // Check actual auth status via kiro-cli (handles refresh token automatically)
  let authenticated = false
  try {
    const output = execFileSync("kiro-cli", ["whoami"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    }).toString()
    authenticated = output.includes("Logged in")
  } catch {
    // whoami fails if not authenticated
  }

  const tokenPath = join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json")
  const hasToken = existsSync(tokenPath)

  return {
    installed,
    authenticated,
    version,
    tokenPath: hasToken ? tokenPath : undefined,
  }
}
