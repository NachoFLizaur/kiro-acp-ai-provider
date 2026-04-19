#!/usr/bin/env bun

/**
 * Integration test: Multi-turn session with revert-to-message simulation.
 *
 * Connects to a real kiro-cli process (must be installed and authenticated)
 * and exercises:
 *   Phase 1  — 3-turn math conversation with session affinity
 *   Phase 2A — Revert via injectContext() + separate doGenerate()
 *              (expected to FAIL — session mismatch, see notes below)
 *   Phase 2B — Revert via single doGenerate() with context in user message
 *              (expected to PASS)
 *   Phase 3  — Compare results from both approaches
 *
 * Why Phase 2A fails:
 *   injectContext() calls acquireSession() with NO affinity → creates session A.
 *   cleanupAfterStream() runs → session A is cleaned up (tools file removed,
 *   no persistence). The subsequent doGenerate() with x-session-affinity header
 *   calls acquireSession() which creates session B (new, no persisted mapping).
 *   Result: the context lives in session A, but the query goes to session B.
 *
 * Run:  bun test/integration/revert-simulation.ts
 */

import { createKiroAcp, type KiroACPProvider } from "../../src/index"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_ID = "claude-sonnet-4.6"
const AFFINITY_KEY = "test-revert-simulation"
const SYSTEM_PROMPT = "You are a math assistant. Always reply with just the number, nothing else."

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the plain-text answer from a doGenerate result. */
function extractText(result: LanguageModelV3GenerateResult): string {
  const parts: string[] = []
  for (const block of result.content) {
    if (block.type === "text") {
      parts.push(block.text)
    }
  }
  return parts.join("").trim()
}

/** Build a LanguageModelV3Prompt with system + user message. */
function buildPrompt(userText: string): LanguageModelV3Prompt {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: [{ type: "text", text: userText }] },
  ]
}

/** Build doGenerate call options with session affinity. */
function callOptions(prompt: LanguageModelV3Prompt): LanguageModelV3CallOptions {
  return {
    prompt,
    headers: { "x-session-affinity": AFFINITY_KEY },
  }
}

function separator(char = "─", width = 55): string {
  return char.repeat(width)
}

function banner(title: string): string {
  const line = "═".repeat(55)
  return `\n${line}\n  ${title}\n${line}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Turn runner
// ---------------------------------------------------------------------------

interface TurnResult {
  answer: string
  credits: number
  sessionId: string | null
}

async function runTurn(
  model: LanguageModelV3,
  provider: KiroACPProvider,
  turnNumber: number | string,
  userMessage: string,
): Promise<TurnResult> {
  const prompt = buildPrompt(userMessage)
  const options = callOptions(prompt)

  const result = await model.doGenerate(options)
  const answer = extractText(result)
  const credits = provider.getTotalCredits()
  const sessionId = provider.getSessionId()

  console.log(`[Turn ${turnNumber}] User: ${userMessage}`)
  console.log(`[Turn ${turnNumber}] Assistant: ${answer}`)
  console.log(`[Turn ${turnNumber}] Session: ${sessionId ?? "unknown"}`)
  console.log(`[Turn ${turnNumber}] Total credits so far: ${credits}`)

  return { answer, credits, sessionId }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let provider1: KiroACPProvider | null = null
  let provider2: KiroACPProvider | null = null
  let provider3: KiroACPProvider | null = null

  try {
    // =====================================================================
    // Phase 1: Multi-turn session (3 turns)
    // =====================================================================
    console.log(banner("Phase 1: Multi-turn Session"))

    provider1 = createKiroAcp({ cwd: process.cwd() })
    const model1 = provider1(MODEL_ID)

    const turns: TurnResult[] = []

    // Turn 1
    const turn1 = await runTurn(model1, provider1, 1, "What is 2 + 2? Reply with just the number.")
    turns.push(turn1)
    console.log(separator())

    // Turn 2
    const turn2 = await runTurn(model1, provider1, 2, "Now multiply that by 3. Reply with just the number.")
    turns.push(turn2)
    console.log(separator())

    // Turn 3 (original)
    const turn3 = await runTurn(model1, provider1, 3, "Now add 100 to that. Reply with just the number.")
    turns.push(turn3)
    console.log(separator())

    console.log(`\nPhase 1 complete. Answers: [${turns.map((t) => t.answer).join(", ")}]`)

    // Build conversation summary from turns 1-2 (shared by both Phase 2 approaches)
    const summary = [
      `Turn 1: User asked "What is 2 + 2?" — You answered "${turns[0].answer}"`,
      `Turn 2: User asked "Now multiply that by 3" — You answered "${turns[1].answer}"`,
    ].join("\n")

    // =====================================================================
    // Phase 2A: injectContext() + separate doGenerate()
    //
    // EXPECTED TO FAIL due to session mismatch:
    //   - injectContext() creates session A (no affinity)
    //   - cleanupAfterStream() cleans up session A
    //   - doGenerate() creates session B (new session, no context)
    //   - The model has no memory of turns 1-2 in session B
    // =====================================================================
    console.log(banner("Phase 2A: injectContext() Approach (expected to fail)"))

    console.log("NOTE: This approach is expected to fail due to session mismatch.")
    console.log("      injectContext() and doGenerate() end up in different sessions.")
    console.log(separator())

    // Shut down the old provider (closes the kiro-cli process)
    console.log("Shutting down original provider...")
    await provider1.shutdown()
    provider1 = null
    console.log("Original provider shut down.")
    console.log(separator())

    // Small delay to let the process fully exit
    await sleep(500)

    // Create a fresh provider + model for 2A
    console.log("Creating new provider for 2A (injectContext approach)...")
    provider2 = createKiroAcp({ cwd: process.cwd() })
    const model2 = provider2(MODEL_ID)
    console.log("New provider created.")
    console.log(separator())

    // Inject the conversation context from turns 1-2
    console.log("Injecting context from turns 1-2...")
    console.log("Conversation summary for rehydration:")
    console.log(summary)
    await provider2.injectContext(summary)
    console.log("Context injected successfully.")
    console.log(separator())

    // Send the alternative Turn 3' via separate doGenerate
    const turn3AltA = await runTurn(
      model2,
      provider2,
      "3'A",
      "Now subtract 5 from that instead. Reply with just the number.",
    )
    console.log(separator())

    // =====================================================================
    // Phase 2B: Single doGenerate() with context embedded in user message
    //
    // EXPECTED TO PASS: No session mismatch because everything is in one
    // doGenerate() call on a fresh provider. The conversation history is
    // provided inline in the user message.
    // =====================================================================
    console.log(banner("Phase 2B: Inline Context Approach (expected to pass)"))

    // Create a completely fresh provider + model for 2B
    console.log("Creating new provider for 2B (inline context approach)...")
    provider3 = createKiroAcp({ cwd: process.cwd() })
    const model3 = provider3(MODEL_ID)
    console.log("New provider created.")
    console.log(separator())

    const inlinePrompt = buildPrompt(
      `<conversation_history>
Turn 1: User asked "What is 2 + 2?" — You answered "${turns[0].answer}"
Turn 2: User asked "Now multiply that by 3" — You answered "${turns[1].answer}"
</conversation_history>

Continuing from where Turn 2 left off (the current result is ${turns[1].answer}):
Now subtract 5 from that. Reply with just the number.`,
    )

    console.log("[Turn 3'B] Sending inline context + question in single doGenerate()...")
    const resultB = await model3.doGenerate({
      prompt: inlinePrompt,
      headers: {},
    })
    const answerB = extractText(resultB)
    const creditsB = provider3.getTotalCredits()
    const sessionIdB = provider3.getSessionId()

    console.log(`[Turn 3'B] Assistant: ${answerB}`)
    console.log(`[Turn 3'B] Session: ${sessionIdB ?? "unknown"}`)
    console.log(`[Turn 3'B] Total credits: ${creditsB}`)
    console.log(separator())

    // =====================================================================
    // Phase 3: Verify & Report
    // =====================================================================
    console.log(banner("Phase 3: Verification & Report"))

    const originalT3 = turns[2].answer
    const revertedT3A = turn3AltA.answer
    const revertedT3B = answerB

    console.log("Results:")
    console.log(`  Turn 1 answer:                ${turns[0].answer}  (expected: 4)`)
    console.log(`  Turn 2 answer:                ${turns[1].answer}  (expected: 12)`)
    console.log(`  Original Turn 3 answer:       ${originalT3}  (expected: 112)`)
    console.log(`  Reverted Turn 3'A (inject):   ${revertedT3A}  (expected: 7, likely wrong)`)
    console.log(`  Reverted Turn 3'B (inline):   ${revertedT3B}  (expected: 7)`)
    console.log(separator())

    // Parse numeric answers
    const t1Num = parseInt(turns[0].answer, 10)
    const t2Num = parseInt(turns[1].answer, 10)
    const t3Num = parseInt(originalT3, 10)
    const t3AltANum = parseInt(revertedT3A, 10)
    const t3AltBNum = parseInt(revertedT3B, 10)

    const checks = [
      // Phase 1 checks
      { name: "Turn 1 correct (2+2=4)", pass: t1Num === 4 },
      { name: "Turn 2 correct (4×3=12)", pass: t2Num === 12 },
      { name: "Turn 3 correct (12+100=112)", pass: t3Num === 112 },

      // Phase 2A checks (injectContext — expected to fail)
      { name: "2A: Turn 3' correct (12-5=7)", pass: t3AltANum === 7 },
      { name: "2A: Model understood context", pass: t3AltANum === t2Num - 5 },

      // Phase 2B checks (inline context — expected to pass)
      { name: "2B: Turn 3' correct (12-5=7)", pass: t3AltBNum === 7 },
      { name: "2B: Model understood context", pass: t3AltBNum === t2Num - 5 },
    ]

    // Separate expected-to-fail checks from must-pass checks
    const mustPassChecks = checks.filter((c) => !c.name.startsWith("2A:"))
    const expectedFailChecks = checks.filter((c) => c.name.startsWith("2A:"))

    console.log("Must-pass checks:")
    let mustPassAllPassed = true
    for (const check of mustPassChecks) {
      const icon = check.pass ? "✅" : "❌"
      console.log(`  ${icon} ${check.name}`)
      if (!check.pass) mustPassAllPassed = false
    }

    console.log()
    console.log("Expected-to-fail checks (2A — session mismatch):")
    for (const check of expectedFailChecks) {
      const icon = check.pass ? "✅ (unexpected pass!)" : "⚠️  (expected failure)"
      console.log(`  ${icon} ${check.name}`)
    }

    console.log(separator())
    console.log(`Total credits (Phase 1):  ${turns[2].credits}`)
    console.log(`Total credits (Phase 2A): ${turn3AltA.credits}`)
    console.log(`Total credits (Phase 2B): ${creditsB}`)
    console.log(separator("═"))

    if (mustPassAllPassed) {
      const anyExpectedFailed = expectedFailChecks.some((c) => !c.pass)
      if (anyExpectedFailed) {
        console.log("\n🎉 Must-pass checks all passed! 2A failed as expected (session mismatch).\n")
      } else {
        console.log("\n🎉 All checks passed! (2A unexpectedly passed too — session mismatch may be fixed)\n")
      }
    } else {
      console.log("\n⚠️  Some must-pass checks failed. See details above.\n")
      process.exit(1)
    }
  } catch (error) {
    console.error("\n💥 Integration test failed with error:")
    console.error(error)
    process.exit(1)
  } finally {
    // Always clean up providers
    if (provider1) {
      try {
        await provider1.shutdown()
      } catch {
        // Ignore shutdown errors during cleanup
      }
    }
    if (provider2) {
      try {
        await provider2.shutdown()
      } catch {
        // Ignore shutdown errors during cleanup
      }
    }
    if (provider3) {
      try {
        await provider3.shutdown()
      } catch {
        // Ignore shutdown errors during cleanup
      }
    }
  }
}

main()
