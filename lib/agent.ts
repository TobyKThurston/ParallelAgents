/**
 * Adversarial QA agent driven by OpenAI's vision API.
 *
 * Each fork runs an agent loop: take a screenshot of the page, send it +
 * a compact DOM snippet to GPT-4o-mini, and ask for the NEXT browser action
 * to take in pursuit of an "intent" (e.g., "cause duplicate orders").
 *
 * The model returns one of: click | fill | press | eval | done.
 * The runner executes that action via Playwright and loops until the model
 * returns `done` (or a max-step cap is reached).
 */

import OpenAI from 'openai'

let client: OpenAI | null = null
function getClient(): OpenAI {
  if (!client) {
    const key = process.env.OPENAI_API_KEY
    if (!key) throw new Error('OPENAI_API_KEY not set in .env.local')
    client = new OpenAI({ apiKey: key })
  }
  return client
}

export function hasApiKey(): boolean {
  return !!process.env.OPENAI_API_KEY
}

export type AgentAction =
  | { type: 'click'; selector: string; reason: string }
  | { type: 'fill'; selector: string; value: string; reason: string }
  | { type: 'press'; selector: string; key: string; reason: string }
  | { type: 'eval'; code: string; reason: string }
  | {
      type: 'done'
      verdict: 'bug' | 'passed' | 'tolerable'
      reason: string
    }

const ACTION_TOOL = {
  type: 'function' as const,
  function: {
    name: 'pick_action',
    description: 'Choose the next browser action to take.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['click', 'fill', 'press', 'eval', 'done'],
          description: 'Which kind of action to take.',
        },
        selector: {
          type: 'string',
          description:
            'CSS selector targeting the element. Required for click, fill, press.',
        },
        value: {
          type: 'string',
          description:
            'For fill: the literal text/value to type. For eval: ignored.',
        },
        key: {
          type: 'string',
          description: 'For press: the keyboard key (e.g. "Enter", "Tab").',
        },
        code: {
          type: 'string',
          description:
            'For eval: a JavaScript expression to run inside the page (e.g. "document.querySelector(\'#total\').textContent").',
        },
        verdict: {
          type: 'string',
          enum: ['bug', 'passed', 'tolerable'],
          description:
            'For done: your overall judgement of whether the intent revealed a bug.',
        },
        reason: {
          type: 'string',
          description:
            'A brief sentence explaining why this action pursues the intent.',
        },
      },
      required: ['type', 'reason'],
    },
  },
}

const SYSTEM_PROMPT = `You are an adversarial QA agent driving a real browser via Playwright.
You are part of a swarm — multiple instances of you are testing the same app from
the same starting state, each with a different INTENT.

You will see a screenshot of the current page and a compact DOM snippet.
Choose ONE action at a time using the pick_action tool. Pursue your intent
relentlessly but efficiently — do not waste actions on idle exploration.

Action types:
  click   — click the element matching the CSS selector
  fill    — type a value into an input matching the selector
  press   — press a keyboard key after the selector is focused (e.g. "Enter")
  eval    — execute a JavaScript expression in the page (e.g. for state inspection,
            adversarial DOM manipulation, or triggering events directly)
  done    — stop and return your verdict ('bug' | 'passed' | 'tolerable')

Selectors must be valid CSS. When uncertain about a selector, prefer ids
(\`#id\`) and stable attributes (\`[data-foo]\`).

Return done as soon as you have learned enough to judge — usually within 3-5
actions. Always include a one-sentence \`reason\` so a human watching your
swarm can follow your thinking.`

function compactDom(html: string, max = 4000): string {
  // Strip script/style bodies and collapse whitespace; keep tag attributes.
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
  return stripped.length > max ? stripped.slice(0, max) + '…(truncated)' : stripped
}

export async function pickNextAction(opts: {
  intent: string
  pageUrl: string
  domSnippet: string
  screenshotB64: string
  history: AgentAction[]
  stepsRemaining: number
}): Promise<AgentAction> {
  const c = getClient()

  const historyText =
    opts.history.length === 0
      ? '(no actions yet)'
      : opts.history
          .map((a, i) => `  ${i + 1}. ${JSON.stringify(a)}`)
          .join('\n')

  const userText = `INTENT: ${opts.intent}

URL: ${opts.pageUrl}
Steps remaining (incl this one): ${opts.stepsRemaining}

History:
${historyText}

DOM snippet (truncated):
${compactDom(opts.domSnippet)}`

  const resp = await c.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.5,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${opts.screenshotB64}`,
              detail: 'low',
            },
          },
        ],
      },
    ],
    tools: [ACTION_TOOL],
    tool_choice: { type: 'function', function: { name: 'pick_action' } },
  })

  const tc = resp.choices?.[0]?.message?.tool_calls?.[0]
  if (!tc || tc.type !== 'function') {
    return {
      type: 'done',
      verdict: 'tolerable',
      reason: 'no tool call returned by model',
    }
  }
  let parsed: any
  try {
    parsed = JSON.parse(tc.function.arguments)
  } catch (e) {
    return {
      type: 'done',
      verdict: 'tolerable',
      reason: `failed to parse model output: ${(e as Error).message}`,
    }
  }
  return parsed as AgentAction
}
