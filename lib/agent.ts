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
      type: 'spawn'
      intents: { name: string; description: string; bannerColor?: string }[]
      reason: string
    }
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
          enum: ['click', 'fill', 'press', 'eval', 'spawn', 'done'],
          description: 'Which kind of action to take.',
        },
        selector: {
          type: 'string',
          description:
            'CSS selector targeting the element. Required for click, fill, press.',
        },
        value: {
          type: 'string',
          description: 'For fill: the literal text/value to type.',
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
        intents: {
          type: 'array',
          minItems: 2,
          maxItems: 3,
          description:
            'For spawn: list of 2-3 sub-intents. Each will become a new fork branching off this one in the tree, starting from the page state you reached.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'kebab-case identifier' },
              description: { type: 'string', description: 'what this sub-fork should do' },
              bannerColor: {
                type: 'string',
                enum: ['#16a34a', '#dc2626', '#ea580c', '#9333ea', '#ca8a04', '#3b82f6'],
              },
            },
            required: ['name', 'description'],
          },
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
            adversarial DOM manipulation, or triggering 2 concurrent fetches with
            Promise.all to test idempotency)
  spawn   — fork into 2-3 NEW sub-agents (use sparingly). Pick this when you've
            navigated to a state where multiple INDEPENDENT attack paths open up
            and pursuing them serially would mutate state. Each sub-intent should
            be a meaningfully different angle. The current state is snapshotted
            and each sub-fork starts from there. Use this when you DISCOVER
            multiple options mid-loop — don't pre-plan it.
  done    — stop and return your verdict ('bug' | 'passed' | 'tolerable')

Selectors must be valid CSS. When uncertain about a selector, prefer ids
(\`#id\`) and stable attributes (\`[data-foo]\`).

Most forks should NOT spawn — they should pursue a single intent to completion
and return done. Only spawn if you've discovered multiple distinct opportunities
that didn't exist at the original fork point.

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

export type GeneratedIntent = {
  name: string
  banner: string
  bannerColor: string
  description: string
}

const INTENT_LIST_TOOL = {
  type: 'function' as const,
  function: {
    name: 'list_intents',
    description:
      'Return a list of distinct adversarial intents to test on the current page. Choose between 2 and 5 — fewer if the page is simple, more if it has rich attack surface.',
    parameters: {
      type: 'object',
      properties: {
        intents: {
          type: 'array',
          minItems: 2,
          maxItems: 5,
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description:
                  'Short kebab-case identifier, e.g. "race-double-submit" or "xss-in-title".',
              },
              description: {
                type: 'string',
                description:
                  'Adversarial intent in plain English — what to test, what should happen, what would prove a bug.',
              },
              banner: {
                type: 'string',
                description:
                  'Short banner shown on the headed browser, e.g. "🔴 RACE — double-click submit".',
              },
              bannerColor: {
                type: 'string',
                enum: ['#16a34a', '#dc2626', '#ea580c', '#9333ea', '#ca8a04', '#3b82f6'],
                description:
                  'Color for the banner: green for control, red for race, orange for overflow, purple for injection/confusion, yellow for validation, blue for other.',
              },
            },
            required: ['name', 'description', 'banner', 'bannerColor'],
          },
        },
      },
      required: ['intents'],
    },
  },
}

const INTENT_SYSTEM_PROMPT = `You are a senior adversarial QA architect. Look at a screenshot + DOM of one page in a SaaS web app, and propose 2-5 distinct adversarial intents to test on this exact page.

Choose the count based on the page's actual attack surface:
  * 2 — simple pages: one input + one button, or trivial forms with no validation surface beyond "click submit"
  * 3 — typical forms: a few inputs feeding one submit (most CRUD forms land here)
  * 4 — pages with several independently-exploitable inputs (e.g. multiple text fields plus a numeric input plus a submit)
  * 5 — rich pages with truly 5+ distinct attack classes: quantity AND coupon AND email AND name AND card, all exploitable in different ways

Pick the number that genuinely fits. Don't anchor on any default — count the real attack surfaces you see and let the answer fall out.

DO NOT pad. Two intents that test the same vulnerability class are ONE intent (e.g., "XSS in title" + "XSS in description" → just "XSS in any reflected field"). Each intent must be meaningfully distinct.

Always include exactly ONE control intent (banner color #16a34a) that exercises the happy path normally — this gives a baseline against which other forks are diffed.

The remaining 1-4 intents (however many fit the page) should match the page's actual attack surface. Examples of good intent types:
  - race condition (concurrent submit on a non-idempotent endpoint)
  - numeric overflow / negative values on a quantity-like input
  - missing required field → server crash / 5xx
  - XSS / HTML injection in any reflected field
  - coupon / promo / discount abuse
  - javascript: scheme in a URL field
  - boundary value / type-confusion in a numeric or select input

Pages with ONE attack surface beyond control deserve 2 intents. Pages with FIVE deserve 5. Match the page.`

export async function generateIntents(opts: {
  pageUrl: string
  domSnippet: string
  screenshotB64: string
  context: string
}): Promise<GeneratedIntent[]> {
  const c = getClient()
  const userText = `URL: ${opts.pageUrl}

Page context: ${opts.context}

DOM snippet:
${compactDom(opts.domSnippet)}

Propose 2-5 adversarial intents for this page. Always include one control.`

  const resp = await c.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.7,
    messages: [
      { role: 'system', content: INTENT_SYSTEM_PROMPT },
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
    tools: [INTENT_LIST_TOOL],
    tool_choice: { type: 'function', function: { name: 'list_intents' } },
  })

  const tc = resp.choices?.[0]?.message?.tool_calls?.[0]
  if (!tc || tc.type !== 'function') throw new Error('intent generator returned no tool call')

  let parsed: any
  try {
    parsed = JSON.parse(tc.function.arguments)
  } catch (e) {
    throw new Error(`failed to parse intent generator output: ${(e as Error).message}`)
  }
  const intents: GeneratedIntent[] = (parsed.intents ?? []).slice(0, 5)
  if (intents.length < 2) throw new Error(`intent generator returned only ${intents.length} intents`)
  return intents
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
