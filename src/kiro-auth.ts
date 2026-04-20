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
  const hasApiKey = !!process.env.KIRO_API_KEY
  let hasValidToken = false

  if (existsSync(tokenPath)) {
    try {
      const raw = JSON.parse(readFileSync(tokenPath, "utf8"))
      const expires = raw.expiresAt ? new Date(raw.expiresAt).getTime() : 0
      hasValidToken = !!raw.accessToken && expires > Date.now()
    } catch {
      // Corrupt or unreadable token file
    }
  }

  return {
    installed,
    authenticated: hasValidToken || hasApiKey,
    version,
    tokenPath: hasValidToken ? tokenPath : undefined,
  }
}
