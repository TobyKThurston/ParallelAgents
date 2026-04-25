/**
 * "Helix" — a deliberately-buggy multi-page SaaS app served as plain HTML.
 *
 * Modeled loosely on Linear/Notion. Acts as the target the adversarial fork
 * swarm tests. Multiple flows, multiple bug categories, varied attack surface.
 *
 * Pages:
 *   /                       Dashboard (stats, recent activity)
 *   /issues                 Issue list + "new issue" CTA
 *   /issues/new             Create form (title, description, priority, assignee)
 *   /billing                Plan upgrade form (seats, coupon, card, email, name)
 *   /billing/success?...    Order confirmation (XSS via innerHTML on name)
 *   /settings               Profile (display name, avatar URL — javascript: URLs unfiltered)
 *
 * Planted bugs (intentional):
 *   [I1] POST /api/issues — no idempotency → concurrent submits create dupes
 *   [I2] Issue list renders titles via innerHTML → XSS
 *   [I3] POST /api/issues — server crashes on empty title (.toUpperCase() on undefined)
 *   [B1] /billing seats input has no min → negative seats → negative total
 *   [B2] Coupon code "FREE100" applies 100% off → total may go to 0 or negative
 *   [B3] POST /api/billing — concurrent submits create duplicate orders
 *   [B4] POST /api/billing — missing email crashes (.split('@')[1].toLowerCase())
 *   [B5] /billing/success renders ?name= via innerHTML → XSS
 *   [S1] /settings avatar URL accepts `javascript:` schemes (rendered as <img src>)
 *
 * Cart-style state remains for backward compat with old fork-runner code paths.
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'

type Order = { orderId: string; sid: string; email: string; name: string; total: number; at: number }
type Issue = { id: string; title: string; description: string; priority: string; assignee: string; at: number }
type Session = { sid: string; orders: Order[]; issues: Issue[]; profileName: string; avatarUrl: string }

const SHELL_HEAD = (title: string) => `<!doctype html>
<html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — Helix</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' x2='1' y1='0' y2='1'%3E%3Cstop stop-color='%23635bff'/%3E%3Cstop offset='1' stop-color='%2300d4ff'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect rx='22' width='100' height='100' fill='url(%23g)'/%3E%3Cpath d='M30 70 L50 20 L70 70 L58 70 L50 48 L42 70 Z' fill='white'/%3E%3C/svg%3E" />
<link rel="preconnect" href="https://rsms.me/" />
<link rel="stylesheet" href="https://rsms.me/inter/inter.css" />
<style>
  :root {
    --bg: #ffffff;
    --bg-muted: #f6f9fc;
    --bg-sunken: #f0f4f9;
    --ink: #0a2540;
    --ink-soft: #425466;
    --ink-faint: #697386;
    --ink-ghost: #8792a2;
    --line: #e3e8ee;
    --line-soft: #ebeef3;
    --brand: #635bff;
    --brand-ink: #4b44d6;
    --brand-soft: #eef0ff;
    --gradient: linear-gradient(135deg, #635bff 0%, #00d4ff 100%);
    --gradient-soft: linear-gradient(135deg, #eef0ff 0%, #e0f7ff 100%);
    --ok: #0b875b;
    --ok-soft: #e6f8ef;
    --warn: #bb5a00;
    --warn-soft: #fff5e0;
    --danger: #cd3d64;
    --danger-soft: #ffecf0;
    --shadow-sm: 0 1px 2px rgba(10, 37, 64, 0.04), 0 1px 3px rgba(10, 37, 64, 0.06);
    --shadow-md: 0 2px 6px rgba(10, 37, 64, 0.04), 0 8px 24px rgba(10, 37, 64, 0.06);
    --shadow-lg: 0 8px 30px rgba(10, 37, 64, 0.08), 0 30px 60px rgba(10, 37, 64, 0.08);
    --radius: 8px;
    --radius-lg: 12px;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; background: var(--bg-muted); color: var(--ink); font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; font-size: 14px; line-height: 1.5; letter-spacing: -0.003em; }
  @supports (font-variation-settings: normal) {
    html, body { font-family: "Inter var", "Inter", ui-sans-serif, system-ui, sans-serif; }
  }
  a { color: inherit; text-decoration: none; }
  a.link { color: var(--brand); }
  a.link:hover { color: var(--brand-ink); text-decoration: underline; text-underline-offset: 2px; }
  button { font-family: inherit; cursor: pointer; }
  code, kbd, .mono { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace; font-size: 0.92em; }
  ::selection { background: rgba(99, 91, 255, 0.22); }

  .app { display: grid; grid-template-columns: 240px 1fr; grid-template-rows: 100vh; min-height: 100vh; background: var(--bg-muted); }

  /* SIDEBAR */
  .side { background: var(--bg); border-right: 1px solid var(--line); padding: 16px 12px; display: flex; flex-direction: column; gap: 20px; position: sticky; top: 0; height: 100vh; overflow: auto; }
  .brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 14px; border-bottom: 1px solid var(--line-soft); }
  .brand-logo { width: 32px; height: 32px; border-radius: 9px; background: var(--gradient); display: grid; place-items: center; color: #fff; box-shadow: 0 4px 14px rgba(99, 91, 255, 0.35); flex-shrink: 0; }
  .brand-logo svg { width: 16px; height: 16px; }
  .brand-name { font-weight: 600; font-size: 14px; letter-spacing: -0.015em; color: var(--ink); }
  .brand-sub { font-size: 11.5px; color: var(--ink-faint); margin-top: 1px; display: flex; align-items: center; gap: 5px; }
  .brand-sub::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--ok); display: inline-block; box-shadow: 0 0 0 3px var(--ok-soft); }
  .nav-group { display: flex; flex-direction: column; gap: 1px; }
  .nav-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-ghost); padding: 10px 10px 6px; font-weight: 600; }
  .nav a { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 6px; color: var(--ink-soft); font-size: 13px; font-weight: 500; transition: background 0.1s ease, color 0.1s ease; }
  .nav a:hover { background: var(--bg-muted); color: var(--ink); }
  .nav a.active { background: var(--brand-soft); color: var(--brand-ink); }
  .nav a.active .ic svg path, .nav a.active .ic svg circle { stroke: var(--brand-ink); }
  .nav a .ic { width: 16px; height: 16px; flex-shrink: 0; display: grid; place-items: center; color: var(--ink-faint); }
  .nav a .ic svg { width: 16px; height: 16px; }
  .nav a:hover .ic { color: var(--ink); }
  .nav a.active .ic { color: var(--brand-ink); }
  .nav-count { margin-left: auto; font-size: 11px; color: var(--ink-ghost); background: var(--bg-muted); padding: 1px 6px; border-radius: 4px; min-width: 18px; text-align: center; font-weight: 600; }
  .nav a.active .nav-count { background: rgba(99, 91, 255, 0.1); color: var(--brand-ink); }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .dot.eng { background: #6366f1; }
  .dot.mkt { background: #ec4899; }
  .dot.des { background: #f59e0b; }
  .side-bottom { margin-top: auto; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg-muted); display: flex; gap: 10px; align-items: center; }
  .side-bottom:hover { background: var(--bg-sunken); }
  .avatar { width: 32px; height: 32px; border-radius: 50%; background: var(--gradient); display: grid; place-items: center; font-size: 12px; color: #fff; font-weight: 600; flex-shrink: 0; overflow: hidden; letter-spacing: 0; }
  .avatar img { width: 100%; height: 100%; object-fit: cover; }
  .who { font-size: 12.5px; line-height: 1.25; flex: 1; min-width: 0; }
  .who .nm { font-weight: 600; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .who .em { color: var(--ink-faint); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .who-chev { color: var(--ink-ghost); font-size: 14px; }

  /* MAIN */
  main { overflow: auto; min-width: 0; background: var(--bg-muted); }
  .top { display: flex; align-items: center; justify-content: space-between; padding: 14px 32px; border-bottom: 1px solid var(--line); background: rgba(255, 255, 255, 0.85); backdrop-filter: saturate(180%) blur(12px); -webkit-backdrop-filter: saturate(180%) blur(12px); position: sticky; top: 0; z-index: 5; }
  .crumbs { font-size: 13px; color: var(--ink-faint); display: flex; align-items: center; gap: 8px; font-weight: 500; }
  .crumbs a { color: var(--ink-faint); transition: color 0.1s ease; }
  .crumbs a:hover { color: var(--ink); }
  .crumbs strong { color: var(--ink); font-weight: 600; }
  .crumbs .sep { color: var(--ink-ghost); opacity: 0.5; }
  .top-actions { display: flex; gap: 8px; align-items: center; }
  .search { background: var(--bg-muted); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px 6px 30px; font-size: 13px; width: 240px; color: var(--ink); position: relative; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%238792a2' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.3-4.3'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: 10px center; outline: none; transition: border-color 0.12s ease, box-shadow 0.12s ease; }
  .search:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(99, 91, 255, 0.15); }
  .kbd { display: inline-flex; align-items: center; padding: 1px 5px; border: 1px solid var(--line); border-radius: 3px; background: var(--bg); font-size: 10.5px; color: var(--ink-faint); font-family: ui-monospace, monospace; }
  .iconbtn { width: 32px; height: 32px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--ink-faint); display: grid; place-items: center; transition: background 0.1s ease, color 0.1s ease; }
  .iconbtn:hover { background: var(--bg-muted); color: var(--ink); }
  .iconbtn svg { width: 15px; height: 15px; }
  .page { padding: 32px 40px 96px; max-width: 1180px; }
  .page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
  .page-head > div:first-child { min-width: 0; }
  h1.title { font-size: 26px; letter-spacing: -0.025em; margin: 0 0 6px; font-weight: 600; color: var(--ink); }
  .lede { color: var(--ink-faint); font-size: 14px; margin: 0; max-width: 60ch; }
  .eyebrow { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; background: var(--brand-soft); color: var(--brand-ink); border-radius: 999px; font-size: 11.5px; font-weight: 600; letter-spacing: 0.01em; margin-bottom: 10px; }
  .eyebrow::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--brand); }

  /* CARDS */
  .card { background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow-sm); }
  .card .hdr { padding: 14px 20px; border-bottom: 1px solid var(--line-soft); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .card .hdr h3 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; color: var(--ink); }
  .card .hdr .sub { font-size: 12.5px; color: var(--ink-faint); margin-top: 2px; }
  .card .body { padding: 20px; }
  .card .body.tight { padding: 0; }
  .card .ftr { padding: 12px 20px; border-top: 1px solid var(--line-soft); background: var(--bg-muted); display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; color: var(--ink-faint); border-radius: 0 0 var(--radius) var(--radius); }

  /* STATS */
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
  .stat { background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px 20px; box-shadow: var(--shadow-sm); position: relative; overflow: hidden; }
  .stat::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: var(--gradient); opacity: 0; transition: opacity 0.15s ease; }
  .stat:hover::before { opacity: 1; }
  .stat .lbl { font-size: 12px; color: var(--ink-faint); font-weight: 500; display: flex; align-items: center; gap: 6px; }
  .stat .lbl .info { color: var(--ink-ghost); cursor: help; }
  .stat .val { font-size: 28px; font-weight: 600; margin-top: 6px; letter-spacing: -0.03em; color: var(--ink); line-height: 1.1; }
  .stat .delta { font-size: 12px; margin-top: 6px; display: flex; align-items: center; gap: 4px; font-weight: 500; color: var(--ok); }
  .stat .delta.down { color: var(--danger); }
  .stat .delta .tri { display: inline-block; line-height: 1; }

  /* Two-column layout */
  .two-col { display: grid; grid-template-columns: 1fr 360px; gap: 20px; }
  @media (max-width: 1024px) { .two-col { grid-template-columns: 1fr; } .stats { grid-template-columns: repeat(2, 1fr); } }

  /* FORMS */
  label.fld { display: block; margin-bottom: 16px; }
  label.fld .lbl { display: block; font-size: 13px; color: var(--ink); margin-bottom: 6px; font-weight: 500; }
  label.fld .lbl .opt { color: var(--ink-faint); font-weight: 400; font-size: 12px; margin-left: 6px; }
  label.fld .help { display: block; font-size: 12px; color: var(--ink-faint); margin-top: 6px; line-height: 1.45; }
  input[type=text], input[type=email], input[type=number], input[type=url], input[type=password], textarea, select {
    width: 100%; background: var(--bg); border: 1px solid var(--line); color: var(--ink); padding: 9px 12px; border-radius: 6px; font-family: inherit; font-size: 14px; outline: none; transition: border-color 0.12s ease, box-shadow 0.12s ease; box-shadow: var(--shadow-sm);
  }
  input::placeholder, textarea::placeholder { color: var(--ink-ghost); }
  input:focus, textarea:focus, select:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(99, 91, 255, 0.15); }
  input:disabled { background: var(--bg-muted); color: var(--ink-faint); }
  textarea { min-height: 96px; resize: vertical; line-height: 1.5; }
  select { appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23697386' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; padding-right: 32px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; }
  .input-group { position: relative; }
  .input-group .prefix, .input-group .suffix { position: absolute; top: 50%; transform: translateY(-50%); color: var(--ink-faint); font-size: 13px; pointer-events: none; }
  .input-group .prefix { left: 12px; }
  .input-group .suffix { right: 12px; }
  .input-group input.with-prefix { padding-left: 28px; }

  /* BUTTONS */
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 14px; border-radius: 6px; font-weight: 500; font-size: 13.5px; border: 1px solid transparent; transition: all 0.12s ease; line-height: 1.2; letter-spacing: -0.005em; box-shadow: var(--shadow-sm); }
  .btn.primary { background: var(--brand); color: #fff; box-shadow: 0 1px 1px rgba(10, 37, 64, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.08); }
  .btn.primary:hover { background: var(--brand-ink); transform: translateY(-0.5px); }
  .btn.primary:active { transform: translateY(0); }
  .btn.gradient { background: var(--gradient); color: #fff; box-shadow: 0 1px 2px rgba(10, 37, 64, 0.12), 0 4px 12px rgba(99, 91, 255, 0.28); }
  .btn.gradient:hover { filter: brightness(1.05); transform: translateY(-0.5px); }
  .btn.ghost { background: var(--bg); border-color: var(--line); color: var(--ink); }
  .btn.ghost:hover { background: var(--bg-muted); border-color: var(--ink-ghost); }
  .btn.subtle { background: var(--brand-soft); color: var(--brand-ink); border-color: transparent; box-shadow: none; }
  .btn.subtle:hover { background: rgba(99, 91, 255, 0.16); }
  .btn.danger { background: var(--danger-soft); border-color: var(--danger-soft); color: var(--danger); }
  .btn.sm { padding: 6px 10px; font-size: 12.5px; }
  .btn.lg { padding: 11px 18px; font-size: 14px; }
  .btn .ic svg { width: 14px; height: 14px; }

  /* TABLE */
  table.list { width: 100%; border-collapse: collapse; }
  table.list th, table.list td { padding: 12px 20px; text-align: left; border-bottom: 1px solid var(--line-soft); font-size: 13.5px; vertical-align: middle; }
  table.list tr:last-child td { border-bottom: none; }
  table.list th { font-size: 11.5px; font-weight: 600; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.04em; background: var(--bg-muted); border-bottom: 1px solid var(--line); }
  table.list tr:hover td { background: var(--bg-muted); }
  table.list td a.link { font-weight: 500; }
  table.list td .issue-title { color: var(--ink); font-weight: 500; }
  table.list td .desc { color: var(--ink-faint); font-size: 12.5px; margin-top: 2px; }

  /* PILL / BADGE */
  .pill { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600; line-height: 1.5; letter-spacing: 0.005em; }
  .pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; }
  .pill.high { background: var(--danger-soft); color: var(--danger); }
  .pill.high::before { background: var(--danger); }
  .pill.med { background: var(--warn-soft); color: var(--warn); }
  .pill.med::before { background: var(--warn); }
  .pill.low { background: #e6f3ff; color: #0570de; }
  .pill.low::before { background: #0570de; }
  .pill.todo { background: var(--bg-sunken); color: var(--ink-soft); }
  .pill.todo::before { background: var(--ink-ghost); }
  .pill.done { background: var(--ok-soft); color: var(--ok); }
  .pill.done::before { background: var(--ok); }
  .pill.review { background: #f3e8ff; color: #7e22ce; }
  .pill.review::before { background: #7e22ce; }
  .pill.progress { background: #e0f2fe; color: #0369a1; }
  .pill.progress::before { background: #0369a1; }
  .badge { display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 4px; background: var(--bg-sunken); color: var(--ink-soft); font-size: 11.5px; font-family: ui-monospace, monospace; font-weight: 500; letter-spacing: 0.01em; }

  /* MISC */
  .empty { text-align: center; padding: 72px 16px; color: var(--ink-faint); }
  .empty .icon-wrap { width: 48px; height: 48px; border-radius: 10px; background: var(--gradient-soft); display: grid; place-items: center; margin: 0 auto 16px; color: var(--brand); }
  .empty h4 { color: var(--ink); font-size: 15px; margin: 0 0 6px; font-weight: 600; }
  .empty p { margin: 0 0 16px; font-size: 13.5px; }
  hr.div { border: 0; border-top: 1px solid var(--line); margin: 20px 0; }

  /* RECEIPT */
  .receipt { background: var(--bg-muted); border: 1px solid var(--line); border-radius: 8px; padding: 16px 18px; margin-top: 18px; }
  .receipt-line { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13.5px; color: var(--ink-soft); }
  .receipt-line.total { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 6px; font-weight: 600; color: var(--ink); font-size: 15px; }
  .receipt-line .muted { color: var(--ink-faint); }

  /* ALERTS */
  .alert { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: 6px; font-size: 13.5px; margin-bottom: 16px; border: 1px solid transparent; line-height: 1.5; }
  .alert .ai-ic { flex-shrink: 0; margin-top: 1px; }
  .alert.success { background: var(--ok-soft); border-color: rgba(11, 135, 91, 0.2); color: var(--ok); }
  .alert.error { background: var(--danger-soft); border-color: rgba(205, 61, 100, 0.2); color: var(--danger); }
  .alert.info { background: #e6f3ff; border-color: rgba(5, 112, 222, 0.2); color: #0570de; }

  /* DEMO HINT — visible bug-finder cheatsheet for the deliberately-buggy demo */
  .demo-hint { display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; border-radius: 6px; font-size: 13px; margin: 0 0 18px; border: 1px dashed rgba(202, 138, 4, 0.45); background: #fffbeb; color: #854d0e; line-height: 1.55; }
  .demo-hint strong { color: #713f12; font-weight: 600; }
  .demo-hint code { background: rgba(202, 138, 4, 0.12); padding: 1px 5px; border-radius: 3px; font-family: ui-monospace, monospace; font-size: 12px; color: #713f12; }
  .demo-hint ul { margin: 4px 0 0; padding-left: 18px; }
  .demo-hint li { margin: 2px 0; }
  .demo-hint .demo-ic { font-size: 16px; line-height: 1; flex-shrink: 0; padding-top: 1px; }

  /* PLAN COMPARISON (billing) */
  .plans { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 20px; }
  .plan { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 18px; cursor: pointer; transition: border-color 0.12s ease, box-shadow 0.12s ease; position: relative; }
  .plan:hover { border-color: var(--ink-ghost); }
  .plan.selected { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(99, 91, 255, 0.15); }
  .plan .plan-name { font-weight: 600; font-size: 14px; color: var(--ink); letter-spacing: -0.01em; }
  .plan .plan-tag { position: absolute; top: -9px; right: 14px; background: var(--gradient); color: #fff; padding: 2px 8px; border-radius: 999px; font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .plan .plan-price { margin-top: 8px; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; color: var(--ink); }
  .plan .plan-price .per { font-size: 12px; color: var(--ink-faint); font-weight: 500; }
  .plan .plan-feats { margin: 12px 0 0; padding: 0; list-style: none; font-size: 12.5px; color: var(--ink-soft); display: flex; flex-direction: column; gap: 4px; }
  .plan .plan-feats li { display: flex; gap: 6px; align-items: flex-start; }
  .plan .plan-feats li::before { content: '✓'; color: var(--ok); font-weight: 600; }

  /* ACTIVITY */
  .activity { display: flex; flex-direction: column; }
  .activity-item { display: flex; gap: 12px; padding: 12px 20px; align-items: flex-start; border-bottom: 1px solid var(--line-soft); transition: background 0.1s ease; }
  .activity-item:last-child { border-bottom: none; }
  .activity-item:hover { background: var(--bg-muted); }
  .activity-item .dot-av { width: 26px; height: 26px; border-radius: 50%; background: var(--gradient-soft); display: grid; place-items: center; font-size: 11px; font-weight: 600; color: var(--brand-ink); flex-shrink: 0; }
  .activity-item .meta { flex: 1; min-width: 0; font-size: 13px; color: var(--ink-soft); }
  .activity-item .meta strong { color: var(--ink); font-weight: 600; }
  .activity-item .time { font-size: 11.5px; color: var(--ink-ghost); margin-top: 2px; }

  /* CHART */
  .chart-wrap { padding: 8px 20px 20px; }
  .chart-head { display: flex; align-items: baseline; justify-content: space-between; padding: 4px 0 14px; }
  .chart-val { font-size: 24px; font-weight: 600; letter-spacing: -0.025em; color: var(--ink); }
  .chart-tag { font-size: 12px; color: var(--ok); font-weight: 500; }
  .chart-legend { display: flex; gap: 14px; font-size: 12px; color: var(--ink-faint); }
  .chart-legend span { display: inline-flex; align-items: center; gap: 5px; }
  .chart-legend .swatch { width: 8px; height: 8px; border-radius: 2px; }

  /* SUCCESS PAGE */
  .success-card { max-width: 520px; margin: 64px auto; background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 44px 44px 36px; text-align: center; box-shadow: var(--shadow-lg); }
  .success-card .check { width: 60px; height: 60px; border-radius: 50%; background: var(--gradient); display: grid; place-items: center; margin: 0 auto 20px; color: #fff; box-shadow: 0 8px 24px rgba(99, 91, 255, 0.3); }
  .success-card .check svg { width: 28px; height: 28px; }
  .success-card h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.025em; margin: 0 0 6px; color: var(--ink); }
  .success-card .sub { color: var(--ink-faint); font-size: 14px; margin: 0 0 22px; }
  .success-card .order-id { background: var(--bg-muted); border: 1px solid var(--line); border-radius: 6px; padding: 12px 14px; font-family: ui-monospace, monospace; font-size: 13px; color: var(--ink); }
  .success-card .thanks { margin-top: 22px; color: var(--ink-soft); font-size: 14px; }

  /* FILTERS ROW */
  .filters { display: flex; gap: 6px; padding: 12px 20px; border-bottom: 1px solid var(--line-soft); align-items: center; flex-wrap: wrap; }
  .filters .fchip { padding: 4px 10px; border-radius: 6px; font-size: 12.5px; font-weight: 500; color: var(--ink-soft); background: transparent; border: 1px solid transparent; cursor: pointer; }
  .filters .fchip.active { background: var(--bg-muted); color: var(--ink); border-color: var(--line); }
  .filters .fchip:hover { background: var(--bg-muted); }
  .filters .fsep { width: 1px; height: 18px; background: var(--line); margin: 0 4px; }

  /* TOAST */
  .toast-root { position: fixed; bottom: 24px; right: 24px; z-index: 100; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
  .toast { background: var(--ink); color: #fff; padding: 10px 14px; border-radius: 8px; font-size: 13px; box-shadow: var(--shadow-lg); display: flex; gap: 8px; align-items: center; animation: toast-in 0.18s ease; pointer-events: auto; max-width: 320px; }
  .toast .tc { color: #7ddc9c; display: grid; place-items: center; }
  .toast .tc svg { width: 14px; height: 14px; }
  @keyframes toast-in { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
</style>
<script>
  (function() {
    function toast(msg) {
      let root = document.querySelector('.toast-root');
      if (!root) { root = document.createElement('div'); root.className = 'toast-root'; document.body.appendChild(root); }
      const el = document.createElement('div');
      el.className = 'toast';
      el.innerHTML = '<span class="tc"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span><span></span>';
      el.lastElementChild.textContent = msg;
      root.appendChild(el);
      setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; el.style.transition = 'all 0.18s ease'; }, 1800);
      setTimeout(() => el.remove(), 2100);
    }
    document.addEventListener('DOMContentLoaded', () => {
      // Filter chips: exclusive within group
      document.querySelectorAll('.filters').forEach(group => {
        group.addEventListener('click', e => {
          const chip = e.target.closest('.fchip');
          if (!chip) return;
          group.querySelectorAll('.fchip.active').forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          toast('Filter: ' + chip.textContent.trim().replace(/\\s+/g, ' '));
        });
      });
      // Plan cards: exclusive selection
      const plans = document.querySelectorAll('.plans .plan');
      plans.forEach(p => p.addEventListener('click', () => {
        plans.forEach(o => o.classList.remove('selected'));
        p.classList.add('selected');
        const nm = p.querySelector('.plan-name');
        if (nm) toast('Plan: ' + nm.textContent);
      }));
      // Notification / help top-bar icon buttons
      document.querySelectorAll('.iconbtn').forEach(b => {
        b.addEventListener('click', () => toast((b.getAttribute('title') || 'OK') + ' · nothing new'));
      });
      // Search: Enter shows a toast
      document.querySelectorAll('.search').forEach(s => {
        s.addEventListener('keydown', e => {
          if (e.key === 'Enter' && s.value.trim()) toast('Searched "' + s.value.trim() + '"');
        });
      });
      // Dead-end buttons that are purely decorative but should feel alive
      document.querySelectorAll('[data-noop]').forEach(b => {
        b.addEventListener('click', e => {
          e.preventDefault();
          toast(b.getAttribute('data-noop') || 'Done');
        });
      });
    });
  })();
</script>
</head><body>`

const ICONS = {
  dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>`,
  issues: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/></svg>`,
  active: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>`,
  backlog: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>`,
  profile: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  billing: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`,
  help: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12" y2="17.01"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  chev: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`,
  logoMark: `<svg viewBox="0 0 24 24" fill="none"><path d="M6 18 12 3 18 18 14.5 18 12 11 9.5 18 Z" fill="white"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  spark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 14 10 21 12 14 14 12 21 10 14 3 12 10 10Z"/></svg>`,
}

const sidebar = (active: string, issueCount: number) => `
<aside class="side">
  <div class="brand">
    <div class="brand-logo">${ICONS.logoMark}</div>
    <div>
      <div class="brand-name">Helix</div>
      <div class="brand-sub">Acme Corp · Pro</div>
    </div>
  </div>
  <div class="nav-group nav">
    <div class="nav-label">Workspace</div>
    <a class="${active === 'dashboard' ? 'active' : ''}" href="/"><span class="ic">${ICONS.dashboard}</span> Dashboard</a>
    <a class="${active === 'issues' ? 'active' : ''}" href="/issues"><span class="ic">${ICONS.issues}</span> Issues<span class="nav-count">${issueCount}</span></a>
    <a href="/issues"><span class="ic">${ICONS.active}</span> Active</a>
    <a href="/issues"><span class="ic">${ICONS.backlog}</span> Backlog</a>
  </div>
  <div class="nav-group nav">
    <div class="nav-label">Teams</div>
    <a href="/issues"><span class="ic"><span class="dot eng"></span></span> Engineering</a>
    <a href="/issues"><span class="ic"><span class="dot mkt"></span></span> Marketing</a>
    <a href="/issues"><span class="ic"><span class="dot des"></span></span> Design</a>
  </div>
  <div class="nav-group nav">
    <div class="nav-label">Account</div>
    <a class="${active === 'settings' ? 'active' : ''}" href="/settings"><span class="ic">${ICONS.profile}</span> Profile</a>
    <a class="${active === 'billing' ? 'active' : ''}" href="/billing"><span class="ic">${ICONS.billing}</span> Billing</a>
  </div>
  <button class="side-bottom" data-noop="Account menu" style="all:unset;box-sizing:border-box;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg-muted);display:flex;gap:10px;align-items:center;cursor:pointer;width:100%">
    <div class="avatar" id="user-avatar">TH</div>
    <div class="who">
      <div class="nm" id="user-name">Toby H.</div>
      <div class="em">toby@acme.com</div>
    </div>
    <div class="who-chev">${ICONS.chev}</div>
  </button>
</aside>`

const topbar = (crumbs: string, actions = '') => `
<header class="top">
  <div class="crumbs">${crumbs}</div>
  <div class="top-actions">
    <input class="search" placeholder="Search issues, people, settings…" />
    ${actions}
    <button class="iconbtn" title="Notifications">${ICONS.bell}</button>
    <button class="iconbtn" title="Help">${ICONS.help}</button>
  </div>
</header>`

const demoHint = (items: string[]) => `
<div class="demo-hint" data-demo-hint>
  <span class="demo-ic">🐛</span>
  <div>
    <strong>Helix is a deliberately-buggy QA target.</strong> Things to try on this page:
    <ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>
  </div>
</div>`

const dashboardPage = (issueCount: number, profileName: string) => SHELL_HEAD('Dashboard') + `
<div class="app">
  ${sidebar('dashboard', issueCount)}
  <main>
    ${topbar('<strong>Dashboard</strong>', '<a class="btn primary" href="/issues/new"><span class="ic">' + ICONS.plus + '</span> New issue</a>')}
    <div class="page">
      ${demoHint([
        'Go to <a href="/issues/new"><code>/issues/new</code></a> and submit with an empty title (server crashes), or paste <code>&lt;img src=x onerror=alert(1)&gt;</code> as the title and then visit <a href="/issues">/issues</a> (stored XSS).',
        'Go to <a href="/billing"><code>/billing</code></a>: try seats <code>-5</code>, coupon <code>FREE100</code>, or leave email blank.',
        'Tamper the URL: <a href="/billing/success?name=%3Cimg+src%3Dx+onerror%3Dalert(1)%3E"><code>/billing/success?name=&lt;img src=x onerror=alert(1)&gt;</code></a> — reflected XSS.',
      ])}
      <div class="page-head">
        <div>
          <div class="eyebrow">Overview</div>
          <h1 class="title">Welcome back, <span id="greet"></span></h1>
          <p class="lede">Here&rsquo;s what&rsquo;s happening across your workspace this week.</p>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn ghost sm" data-noop="Date range: last 7 days">Last 7 days <span class="ic">${ICONS.chev}</span></button>
          <button class="btn ghost sm" data-noop="Export started — check your email">Export</button>
        </div>
      </div>

      <div class="stats">
        <div class="stat">
          <div class="lbl">Active issues</div>
          <div class="val">${issueCount}</div>
          <div class="delta"><span class="tri">▲</span> 3 this week</div>
        </div>
        <div class="stat">
          <div class="lbl">Resolved</div>
          <div class="val">128</div>
          <div class="delta"><span class="tri">▲</span> 12% MoM</div>
        </div>
        <div class="stat">
          <div class="lbl">Avg cycle time</div>
          <div class="val">2.4<span style="font-size:16px;color:var(--ink-faint);font-weight:500">d</span></div>
          <div class="delta down"><span class="tri">▼</span> 0.3d slower</div>
        </div>
        <div class="stat">
          <div class="lbl">Throughput</div>
          <div class="val">87<span style="font-size:16px;color:var(--ink-faint);font-weight:500">%</span></div>
          <div class="delta"><span class="tri">▲</span> 4% vs last wk</div>
        </div>
      </div>

      <div class="two-col">
        <div class="card">
          <div class="hdr">
            <div>
              <h3>Throughput</h3>
              <div class="sub">Issues closed per day · last 14 days</div>
            </div>
            <div class="chart-legend">
              <span><span class="swatch" style="background:var(--brand)"></span> Closed</span>
              <span><span class="swatch" style="background:#c7d7ff"></span> Opened</span>
            </div>
          </div>
          <div class="chart-wrap">
            <div class="chart-head">
              <div>
                <div class="chart-val">214</div>
                <div style="font-size:12.5px;color:var(--ink-faint)">Closed this period</div>
              </div>
              <div class="chart-tag">▲ 12.4%</div>
            </div>
            <svg viewBox="0 0 700 200" preserveAspectRatio="none" style="width:100%;height:200px;display:block">
              <defs>
                <linearGradient id="area" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stop-color="#635bff" stop-opacity="0.18"/>
                  <stop offset="100%" stop-color="#635bff" stop-opacity="0"/>
                </linearGradient>
              </defs>
              <g stroke="#ebeef3" stroke-width="1">
                <line x1="0" y1="40" x2="700" y2="40"/>
                <line x1="0" y1="90" x2="700" y2="90"/>
                <line x1="0" y1="140" x2="700" y2="140"/>
                <line x1="0" y1="190" x2="700" y2="190"/>
              </g>
              <path d="M0 150 L50 130 L100 140 L150 110 L200 100 L250 115 L300 80 L350 95 L400 60 L450 70 L500 50 L550 45 L600 55 L650 30 L700 40 L700 200 L0 200 Z" fill="url(#area)"/>
              <path d="M0 150 L50 130 L100 140 L150 110 L200 100 L250 115 L300 80 L350 95 L400 60 L450 70 L500 50 L550 45 L600 55 L650 30 L700 40" stroke="#635bff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M0 170 L50 160 L100 150 L150 155 L200 140 L250 145 L300 120 L350 130 L400 110 L450 125 L500 105 L550 115 L600 90 L650 95 L700 80" stroke="#c7d7ff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="3 3"/>
            </svg>
          </div>
        </div>

        <div class="card">
          <div class="hdr"><h3>Recent activity</h3><a class="btn subtle sm" href="/issues">View all</a></div>
          <div class="activity">
            <div class="activity-item">
              <div class="dot-av">JM</div>
              <div class="meta"><strong>Jenna M.</strong> moved <strong>HEL-128 · API gateway throttling</strong> to <span class="pill progress">In progress</span><div class="time">12 minutes ago</div></div>
            </div>
            <div class="activity-item">
              <div class="dot-av">AK</div>
              <div class="meta"><strong>Alex K.</strong> opened PR for <strong>HEL-127 · Stripe retries on 5xx</strong> <span class="pill review">Review</span><div class="time">1 hour ago</div></div>
            </div>
            <div class="activity-item">
              <div class="dot-av">TH</div>
              <div class="meta"><strong>You</strong> resolved <strong>HEL-126 · Migrate to TanStack Query</strong> <span class="pill done">Done</span><div class="time">3 hours ago</div></div>
            </div>
            <div class="activity-item">
              <div class="dot-av">SN</div>
              <div class="meta"><strong>Sam N.</strong> shipped <strong>HEL-125 · Mobile nav drawer</strong> <span class="pill done">Done</span><div class="time">Yesterday</div></div>
            </div>
            <div class="activity-item">
              <div class="dot-av">TH</div>
              <div class="meta"><strong>You</strong> commented on <strong>HEL-124 · Billing webhook idempotency</strong><div class="time">Yesterday</div></div>
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:20px">
        <div class="hdr">
          <div>
            <h3>Upgrade to Helix Business</h3>
            <div class="sub">Unlimited issues, SSO, audit logs, and priority support.</div>
          </div>
          <a class="btn gradient" href="/billing"><span class="ic">${ICONS.spark}</span> Upgrade plan</a>
        </div>
      </div>
    </div>
  </main>
</div>
<script>
  // BUG S2: greet name via innerHTML — XSS reflection from profile state
  const profileName = ${JSON.stringify(profileName)};
  document.getElementById('greet').innerHTML = profileName;
</script>
</body></html>`

const issuesListPage = (issueCount: number) => SHELL_HEAD('Issues') + `
<div class="app">
  ${sidebar('issues', issueCount)}
  <main>
    ${topbar(
      '<a href="/">Dashboard</a><span class="sep">/</span><strong>Issues</strong>',
      '<a class="btn primary" href="/issues/new"><span class="ic">' + ICONS.plus + '</span> New issue</a>'
    )}
    <div class="page">
      <div class="page-head">
        <div>
          <h1 class="title">Issues</h1>
          <p class="lede">Track and triage work across the workspace. Filter by status, priority, or assignee.</p>
        </div>
      </div>

      <div class="card">
        <div class="filters">
          <button class="fchip active">All <span class="badge" style="margin-left:4px" id="count-badge">0</span></button>
          <button class="fchip">Active</button>
          <button class="fchip">In review</button>
          <button class="fchip">Done</button>
          <div class="fsep"></div>
          <button class="fchip">Priority <span style="opacity:0.6;margin-left:2px">${ICONS.chev}</span></button>
          <button class="fchip">Assignee <span style="opacity:0.6;margin-left:2px">${ICONS.chev}</span></button>
          <button class="fchip">Team <span style="opacity:0.6;margin-left:2px">${ICONS.chev}</span></button>
          <div style="margin-left:auto;display:flex;gap:6px;align-items:center">
            <button class="fchip">Sort: Newest <span style="opacity:0.6;margin-left:2px">${ICONS.chev}</span></button>
          </div>
        </div>
        <div class="body tight">
          <table class="list">
            <thead>
              <tr>
                <th style="width: 96px">ID</th>
                <th>Title</th>
                <th style="width: 120px">Priority</th>
                <th style="width: 160px">Assignee</th>
                <th style="width: 110px">Status</th>
              </tr>
            </thead>
            <tbody id="issues-tbody">
              <tr><td colspan="5">
                <div class="empty">
                  <div class="icon-wrap">${ICONS.issues}</div>
                  <h4>No issues yet</h4>
                  <p>Create your first issue to get started with tracking work.</p>
                  <a class="btn primary sm" href="/issues/new"><span class="ic">${ICONS.plus}</span> Create issue</a>
                </div>
              </td></tr>
            </tbody>
          </table>
        </div>
        <div class="ftr">
          <span>Showing <strong id="showing-count">0</strong> of <strong id="total-count">0</strong> issues</span>
          <span>Updated just now</span>
        </div>
      </div>
    </div>
  </main>
</div>
<script>
  function initials(s) {
    return (s || '').trim().split(/\\s+|@/).filter(Boolean).slice(0, 2).map(p => p[0] || '').join('').toUpperCase() || '?';
  }
  async function load() {
    const r = await fetch('/api/issues');
    const data = await r.json();
    const tbody = document.getElementById('issues-tbody');
    const n = (data.issues || []).length;
    document.getElementById('count-badge').textContent = n;
    document.getElementById('showing-count').textContent = n;
    document.getElementById('total-count').textContent = n;
    if (!n) return;
    const prioLabel = p => p === 'high' ? 'High' : p === 'med' ? 'Medium' : 'Low';
    // BUG I2: titles rendered via innerHTML — XSS via stored payload
    tbody.innerHTML = data.issues.map(i =>
      '<tr>' +
        '<td><span class="badge">' + i.id + '</span></td>' +
        '<td><div class="issue-title">' + i.title + '</div>' +  // <-- vulnerable
          (i.description ? '<div class="desc">' + i.description.replace(/</g, '&lt;').slice(0, 80) + (i.description.length > 80 ? '…' : '') + '</div>' : '') +
        '</td>' +
        '<td><span class="pill ' + (i.priority || 'low') + '">' + prioLabel(i.priority || 'low') + '</span></td>' +
        '<td>' + (i.assignee ? '<span style="display:inline-flex;gap:7px;align-items:center"><span class="dot-av" style="width:22px;height:22px;font-size:10px">' + initials(i.assignee) + '</span>' + i.assignee + '</span>' : '<span style="color:var(--ink-ghost)">Unassigned</span>') + '</td>' +
        '<td><span class="pill todo">Open</span></td>' +
      '</tr>'
    ).join('');
  }
  load();
</script>
</body></html>`

const issuesNewPage = (issueCount: number) => SHELL_HEAD('New issue') + `
<div class="app">
  ${sidebar('issues', issueCount)}
  <main>
    ${topbar(
      '<a href="/">Dashboard</a><span class="sep">/</span><a href="/issues">Issues</a><span class="sep">/</span><strong>New</strong>'
    )}
    <div class="page" style="max-width: 760px">
      ${demoHint([
        'Click <strong>Create issue</strong> with the title field empty → server returns HTTP 500.',
        'Set title to <code>&lt;img src=x onerror=alert(1)&gt;</code>, create, then visit <a href="/issues">/issues</a> → JS dialog fires (stored XSS).',
        'Click <strong>Create issue</strong> twice in quick succession → duplicate issues land on /issues (no idempotency).',
      ])}
      <div class="page-head">
        <div>
          <h1 class="title">New issue</h1>
          <p class="lede">Describe the work clearly. Required fields are marked with an asterisk.</p>
        </div>
      </div>
      <div id="alert-slot"></div>
      <div class="card">
        <div class="hdr"><h3>Details</h3><span class="badge">Draft</span></div>
        <div class="body">
          <label class="fld"><span class="lbl">Title *</span>
            <input id="title" type="text" placeholder="e.g. Implement idempotent retries on 5xx responses" autofocus />
            <span class="help">Keep it short and action-oriented. Teammates will scan this in a list.</span>
          </label>
          <label class="fld"><span class="lbl">Description <span class="opt">(optional)</span></span>
            <textarea id="description" placeholder="What needs to happen, and why does it matter?"></textarea>
            <span class="help">Supports plain text. Paste stack traces and links freely.</span>
          </label>
          <div class="row">
            <label class="fld"><span class="lbl">Priority</span>
              <select id="priority">
                <option value="low">Low — no rush</option>
                <option value="med">Medium — this sprint</option>
                <option value="high">High — blocking work</option>
              </select>
            </label>
            <label class="fld"><span class="lbl">Assignee <span class="opt">(optional)</span></span>
              <input id="assignee" type="text" placeholder="@username or Full Name" />
            </label>
          </div>
        </div>
        <div class="ftr" style="justify-content:flex-end;gap:8px">
          <a class="btn ghost" href="/issues">Cancel</a>
          <button id="create" class="btn primary">Create issue</button>
        </div>
      </div>

      <div class="alert info" style="margin-top:18px">
        <span class="ai-ic">${ICONS.spark}</span>
        <span><strong>Tip:</strong> issues with clear reproduction steps get picked up 3× faster. Include what you expected vs. what actually happened.</span>
      </div>
    </div>
  </main>
</div>
<script>
  document.getElementById('create').addEventListener('click', async () => {
    const body = {
      title: document.getElementById('title').value,
      description: document.getElementById('description').value,
      priority: document.getElementById('priority').value,
      assignee: document.getElementById('assignee').value,
    };
    const r = await fetch('/api/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    const slot = document.getElementById('alert-slot');
    if (r.ok) {
      slot.innerHTML = '<div class="alert success"><span class="ai-ic">' + ${JSON.stringify(ICONS.check)} + '</span><span>Created <strong>' + data.id + '</strong>. Redirecting to issue list…</span></div>';
      setTimeout(() => location.href = '/issues', 700);
    } else {
      slot.innerHTML = '<div class="alert error"><span>HTTP ' + r.status + ': ' + (data.error || 'unknown') + '</span></div>';
    }
  });
</script>
</body></html>`

const billingPage = (issueCount: number) => SHELL_HEAD('Billing') + `
<div class="app">
  ${sidebar('billing', issueCount)}
  <main>
    ${topbar('<a href="/">Dashboard</a><span class="sep">/</span><strong>Billing</strong>')}
    <div class="page" style="max-width: 820px">
      ${demoHint([
        'Set <strong>Seats</strong> to <code>-5</code> and pay → total goes negative; order accepted.',
        'Apply coupon <code>FREE100</code> → 100% off; total drops to $0 (no max-discount cap).',
        'Leave <strong>Email</strong> blank and pay → server returns HTTP 500.',
        'Click <strong>Pay</strong> twice in quick succession → duplicate orders.',
        'After paying, edit the URL to <code>/billing/success?name=&lt;img src=x onerror=alert(1)&gt;</code> → reflected XSS.',
      ])}
      <div class="page-head">
        <div>
          <div class="eyebrow">Upgrade</div>
          <h1 class="title">Choose a plan</h1>
          <p class="lede">You&rsquo;re on <strong>Helix Pro</strong>. Move your workspace to <strong>Business</strong> for unlimited issues, SSO, and audit logs.</p>
        </div>
      </div>

      <div id="alert-slot"></div>

      <div class="plans">
        <div class="plan">
          <div class="plan-name">Starter</div>
          <div class="plan-price">$0<span class="per"> /mo</span></div>
          <ul class="plan-feats">
            <li>Up to 10 issues</li>
            <li>2 teammates</li>
            <li>Community support</li>
          </ul>
        </div>
        <div class="plan selected">
          <div class="plan-tag">Most popular</div>
          <div class="plan-name">Business</div>
          <div class="plan-price">$10<span class="per"> /seat / mo</span></div>
          <ul class="plan-feats">
            <li>Unlimited issues</li>
            <li>SSO &amp; SCIM</li>
            <li>Audit logs</li>
            <li>Priority support</li>
          </ul>
        </div>
        <div class="plan">
          <div class="plan-name">Enterprise</div>
          <div class="plan-price">Custom</div>
          <ul class="plan-feats">
            <li>Everything in Business</li>
            <li>Dedicated CSM</li>
            <li>Custom SLA</li>
          </ul>
        </div>
      </div>

      <div class="card">
        <div class="hdr">
          <div>
            <h3>Checkout</h3>
            <div class="sub">Billed monthly. Cancel anytime. You won&rsquo;t be charged until you confirm.</div>
          </div>
          <span class="badge">🔒 Secured by Helix Pay</span>
        </div>
        <div class="body">
          <div class="row">
            <label class="fld"><span class="lbl">Seats</span>
              <input id="seats" type="number" value="5" />
              <span class="help">$10 per seat / month. Add or remove seats anytime.</span>
            </label>
            <label class="fld"><span class="lbl">Coupon code <span class="opt">(optional)</span></span>
              <input id="coupon" type="text" placeholder="e.g. SAVE10" style="text-transform:uppercase" />
              <span class="help">Have a promotional code? Apply it for a discount.</span>
            </label>
          </div>

          <hr class="div" />

          <h4 style="margin:0 0 14px;font-size:13px;font-weight:600;color:var(--ink);letter-spacing:-0.005em">Billing contact</h4>
          <div class="row">
            <label class="fld"><span class="lbl">Email *</span>
              <input id="email" type="email" placeholder="billing@acme.com" />
            </label>
            <label class="fld"><span class="lbl">Cardholder name *</span>
              <input id="name" type="text" placeholder="Full name on card" />
            </label>
          </div>

          <h4 style="margin:10px 0 14px;font-size:13px;font-weight:600;color:var(--ink);letter-spacing:-0.005em">Payment</h4>
          <label class="fld"><span class="lbl">Card number *</span>
            <input id="card" type="text" placeholder="1234 1234 1234 1234" />
          </label>
          <div class="row">
            <label class="fld"><span class="lbl">Expiration *</span>
              <input type="text" placeholder="MM / YY" />
            </label>
            <label class="fld"><span class="lbl">CVC *</span>
              <input type="text" placeholder="CVC" />
            </label>
          </div>

          <div class="receipt">
            <div class="receipt-line"><span>Helix Business · <span id="seat-count">5</span> seats</span><span>$<span id="subtotal">50</span>.00</span></div>
            <div class="receipt-line"><span class="muted">Discount (<span id="coupon-applied">none</span>)</span><span class="muted">−$<span id="discount">0</span>.00</span></div>
            <div class="receipt-line"><span class="muted">Tax (estimated)</span><span class="muted">$0.00</span></div>
            <div class="receipt-line total"><span>Total due today</span><span>$<span id="total">50</span>.00 USD</span></div>
          </div>
        </div>
        <div class="ftr" style="justify-content:space-between">
          <span>By paying, you agree to the Helix terms.</span>
          <div style="display:flex;gap:8px">
            <a class="btn ghost" href="/">Cancel</a>
            <button id="place" class="btn gradient">Pay $<span id="btn-total">50</span>.00</button>
          </div>
        </div>
      </div>

      <div style="margin-top:18px;display:flex;gap:8px;align-items:center;color:var(--ink-faint);font-size:12.5px;justify-content:center">
        <span>🔒 Encrypted end-to-end</span>
        <span>·</span>
        <span>PCI-DSS Level 1</span>
        <span>·</span>
        <span>SOC 2 Type II</span>
      </div>
    </div>
  </main>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  function recalc() {
    const seats = parseFloat($('seats').value);  // BUG B1: no min check, accepts negatives
    const subtotal = seats * 10;
    const couponRaw = $('coupon').value.trim().toUpperCase();
    let discount = 0;
    let applied = 'none';
    // BUG B2: FREE100 is a real coupon code with no max-discount cap
    if (couponRaw === 'FREE100') { discount = subtotal; applied = 'FREE100 (−100%)'; }
    else if (couponRaw === 'SAVE10') { discount = subtotal * 0.10; applied = 'SAVE10 (−10%)'; }
    const total = subtotal - discount;
    $('seat-count').textContent = seats;
    $('subtotal').textContent = subtotal;
    $('discount').textContent = discount;
    $('coupon-applied').textContent = applied;
    $('total').textContent = total;
    $('btn-total').textContent = total;
  }
  $('seats').addEventListener('input', recalc);
  $('coupon').addEventListener('input', recalc);
  recalc();
  $('place').addEventListener('click', async () => {
    const body = {
      seats: parseFloat($('seats').value),
      coupon: $('coupon').value,
      email: $('email').value,
      name: $('name').value,
      card: $('card').value,
    };
    const r = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    const slot = $('alert-slot');
    if (r.ok && data.orderId) {
      slot.innerHTML = '<div class="alert success"><span>Payment received. Order <strong>' + data.orderId + '</strong>. Redirecting…</span></div>';
      setTimeout(() => location.href = '/billing/success?order=' + data.orderId + '&name=' + encodeURIComponent(body.name), 600);
    } else {
      slot.innerHTML = '<div class="alert error"><span>HTTP ' + r.status + ': ' + (data.error || 'unknown') + '</span></div>';
    }
  });
</script>
</body></html>`

const billingSuccessPage = (orderId: string, name: string, issueCount: number) => SHELL_HEAD('Order confirmed') + `
<div class="app">
  ${sidebar('billing', issueCount)}
  <main>
    ${topbar('<a href="/">Dashboard</a><span class="sep">/</span><a href="/billing">Billing</a><span class="sep">/</span><strong>Confirmed</strong>')}
    <div style="max-width: 820px; margin: 24px auto 0; padding: 0 24px">
      ${demoHint([
        'Edit the URL: replace <code>?name=...</code> with <code>?name=&lt;img src=x onerror=alert(1)&gt;</code> → JS dialog fires (reflected XSS).',
      ])}
    </div>
    <div class="success-card">
      <div class="check">${ICONS.check}</div>
      <h1>Payment successful</h1>
      <p class="sub">Your workspace is now on <strong>Helix Business</strong>.</p>
      <div class="order-id">${orderId}</div>
      <p class="thanks">Thanks, <span id="thanks-name"></span>! A receipt has been sent to your email.</p>
      <div style="display:flex;gap:8px;margin-top:22px;justify-content:center">
        <a class="btn primary" href="/">Go to dashboard</a>
        <a class="btn ghost" href="/issues">View issues</a>
      </div>
    </div>
  </main>
</div>
<script>
  // BUG B5: name from query string rendered via innerHTML — XSS reflection
  const qs = new URLSearchParams(location.search);
  const nm = qs.get('name') || 'friend';
  document.getElementById('thanks-name').innerHTML = nm;
</script>
</body></html>`

const settingsPage = (issueCount: number, profileName: string, avatarUrl: string) => SHELL_HEAD('Settings') + `
<div class="app">
  ${sidebar('settings', issueCount)}
  <main>
    ${topbar('<a href="/">Dashboard</a><span class="sep">/</span><strong>Profile</strong>')}
    <div class="page" style="max-width: 820px">
      ${demoHint([
        'Set <strong>Display name</strong> to <code>&lt;img src=x onerror=alert(1)&gt;</code>, save, then visit the <a href="/">Dashboard</a> → JS dialog fires (the dashboard reflects the profile name via innerHTML).',
        'Paste <code>javascript:alert(1)</code> into <strong>Avatar URL</strong> and save → an unfiltered <code>javascript:</code> scheme is stored on your profile.',
      ])}
      <div class="page-head">
        <div>
          <h1 class="title">Profile</h1>
          <p class="lede">Personalize your account. Changes are visible to teammates in your workspace.</p>
        </div>
      </div>

      <div id="alert-slot"></div>

      <div class="card">
        <div class="hdr">
          <div>
            <h3>Identity</h3>
            <div class="sub">Your name and photo as they appear to teammates.</div>
          </div>
        </div>
        <div class="body">
          <div style="display:flex;gap:18px;align-items:center;margin-bottom:22px;padding:14px;background:var(--bg-muted);border-radius:8px;border:1px solid var(--line-soft)">
            <div class="avatar" style="width:64px;height:64px;border-radius:14px;font-size:20px;box-shadow:0 4px 14px rgba(99,91,255,0.2)">
              <img id="avatar-preview" src="${avatarUrl || ''}" alt="" onerror="this.replaceWith(document.createTextNode('?'))" />
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:15px;letter-spacing:-0.01em">${profileName}</div>
              <div style="font-size:12.5px;color:var(--ink-faint);margin-top:2px">toby@acme.com · Pro plan · Member since Jan 2024</div>
            </div>
            <button class="btn ghost sm" data-noop="Photo picker coming soon">Change photo</button>
          </div>

          <label class="fld"><span class="lbl">Display name</span>
            <input id="name" type="text" value="${profileName.replace(/"/g, '&quot;')}" />
            <span class="help">Shown on comments, mentions, and activity feeds.</span>
          </label>
          <label class="fld"><span class="lbl">Avatar URL <span class="opt">(optional)</span></span>
            <input id="avatar" type="url" value="${avatarUrl.replace(/"/g, '&quot;')}" placeholder="https://example.com/me.jpg" />
            <span class="help">Paste a public image URL. Square images work best.<!-- BUG S1: javascript: schemes accepted --></span>
          </label>
        </div>
        <div class="ftr" style="justify-content:flex-end;gap:8px">
          <a class="btn ghost" href="/">Cancel</a>
          <button id="save" class="btn primary">Save changes</button>
        </div>
      </div>

      <div class="card" style="margin-top:20px">
        <div class="hdr">
          <div>
            <h3>Email &amp; account</h3>
            <div class="sub">Used for login and notifications.</div>
          </div>
        </div>
        <div class="body">
          <div class="row">
            <label class="fld"><span class="lbl">Email</span>
              <input type="email" value="toby@acme.com" disabled />
              <span class="help">Contact support to change your login email.</span>
            </label>
            <label class="fld"><span class="lbl">Timezone</span>
              <select>
                <option>Europe/London (GMT+0)</option>
                <option>America/New_York (GMT−5)</option>
                <option>America/Los_Angeles (GMT−8)</option>
              </select>
            </label>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:20px;border-color:rgba(205,61,100,0.25)">
        <div class="hdr">
          <div>
            <h3 style="color:var(--danger)">Danger zone</h3>
            <div class="sub">Deactivating removes your data after 30 days.</div>
          </div>
          <button class="btn danger sm" data-noop="Deactivation requires owner confirmation">Deactivate account</button>
        </div>
      </div>
    </div>
  </main>
</div>
<script>
  document.getElementById('save').addEventListener('click', async () => {
    const body = {
      name: document.getElementById('name').value,
      avatar: document.getElementById('avatar').value,
    };
    const r = await fetch('/api/profile', { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body) });
    const data = await r.json();
    const slot = document.getElementById('alert-slot');
    if (r.ok) {
      slot.innerHTML = '<div class="alert success"><span>Profile saved. Reloading…</span></div>';
      setTimeout(() => location.reload(), 500);
    } else {
      slot.innerHTML = '<div class="alert error"><span>' + (data.error || 'failed') + '</span></div>';
    }
  });
</script>
</body></html>`

// ---------- Server ----------

function cookieFromReq(req: http.IncomingMessage): string | undefined {
  return req.headers.cookie?.match(/sid=([^;]+)/)?.[1]
}
async function parseBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c)
  const str = Buffer.concat(chunks).toString('utf8')
  try { return str ? JSON.parse(str) : {} } catch { return {} }
}

export async function startBuggyServer(port = 0): Promise<{
  url: string
  port: number
  stop: () => Promise<void>
  sessions: Map<string, Session>
}> {
  const sessions = new Map<string, Session>()
  let counter = 0

  const server = http.createServer(async (req, res) => {
    let sid = cookieFromReq(req)
    if (!sid) {
      sid = `s${++counter}`
      res.setHeader('Set-Cookie', `sid=${sid}; Path=/; SameSite=Lax`)
    }
    if (!sessions.has(sid)) {
      sessions.set(sid, {
        sid,
        orders: [],
        issues: [],
        profileName: 'Toby Thurston',
        avatarUrl: '',
      })
    }
    const session = sessions.get(sid)!
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'

    // ---------- Pages ----------

    if (method === 'GET' && url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(dashboardPage(session.issues.length, session.profileName))
      return
    }
    if (method === 'GET' && url === '/issues') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(issuesListPage(session.issues.length))
      return
    }
    if (method === 'GET' && url === '/issues/new') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(issuesNewPage(session.issues.length))
      return
    }
    if (method === 'GET' && url === '/billing') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(billingPage(session.issues.length))
      return
    }
    if (method === 'GET' && url.startsWith('/billing/success')) {
      const u = new URL(url, 'http://local')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(
        billingSuccessPage(
          u.searchParams.get('order') ?? '???',
          u.searchParams.get('name') ?? 'friend',
          session.issues.length
        )
      )
      return
    }
    if (method === 'GET' && url === '/settings') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(settingsPage(session.issues.length, session.profileName, session.avatarUrl))
      return
    }

    // ---------- API: issues ----------

    if (method === 'GET' && url === '/api/issues') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ issues: session.issues }))
      return
    }

    if (method === 'POST' && url === '/api/issues') {
      const body = await parseBody(req)
      // BUG I3: server crashes on empty/missing title — derives an avatar
      // initial from title.trim()[0], which throws on '' or undefined.
      try {
        if (!body.title || typeof body.title !== 'string' || body.title.trim() === '') {
          // Boom: dereferencing [0] on undefined when split is empty
          // (simulating a careless avatar-letter computation)
          throw new (body.title as any)[0].constructor('title required')
        }
        const _initial = body.title.trim().toUpperCase().slice(0, 1)
        void _initial
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'server error', detail: e?.message ?? 'unknown' }))
        return
      }
      // BUG I1: no idempotency key — concurrent posts create duplicates
      await new Promise((r) => setTimeout(r, 60))
      const id = `HEL-${100 + session.issues.length + 1}`
      const issue: Issue = {
        id,
        title: String(body.title ?? ''),
        description: String(body.description ?? ''),
        priority: ['low', 'med', 'high'].includes(body.priority) ? body.priority : 'low',
        assignee: String(body.assignee ?? ''),
        at: Date.now(),
      }
      session.issues.push(issue)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, id }))
      return
    }

    // ---------- API: billing ----------

    if (method === 'POST' && url === '/api/billing/checkout') {
      const body = await parseBody(req)
      // BUG B4: missing email crashes the email-domain parser
      try {
        const _domain = body.email.split('@')[1].toLowerCase()
        void _domain
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'server error', detail: e?.message ?? 'unknown' }))
        return
      }
      const seats = Number(body.seats) || 0
      let discount = 0
      const coupon = String(body.coupon ?? '').trim().toUpperCase()
      if (coupon === 'FREE100') discount = seats * 10 // BUG B2 server-side enforcement is the same broken logic
      else if (coupon === 'SAVE10') discount = seats * 10 * 0.1
      const total = seats * 10 - discount
      // BUG B3: no idempotency
      await new Promise((r) => setTimeout(r, 60))
      const order: Order = {
        orderId: randomUUID(),
        sid,
        email: body.email,
        name: body.name ?? '',
        total,
        at: Date.now(),
      }
      session.orders.push(order)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, orderId: order.orderId, total }))
      return
    }

    if (method === 'GET' && url.startsWith('/api/orders')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ sid, orders: session.orders }))
      return
    }

    // ---------- API: profile ----------

    if (method === 'POST' && url === '/api/profile') {
      const body = await parseBody(req)
      session.profileName = String(body.name ?? session.profileName)
      // BUG S1: avatar URL accepted as-is, no scheme check (javascript:, data: pass)
      session.avatarUrl = String(body.avatar ?? '')
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
      return
    }

    res.statusCode = 404
    res.setHeader('Content-Type', 'text/plain')
    res.end('not found')
  })

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : port
      resolve({
        url: `http://127.0.0.1:${actualPort}`,
        port: actualPort,
        stop: () => new Promise<void>((r) => server.close(() => r())),
        sessions,
      })
    })
    server.on('error', reject)
  })
}
