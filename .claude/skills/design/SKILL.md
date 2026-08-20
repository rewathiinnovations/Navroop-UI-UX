---
name: design
description: 'Comprehensive design skill: brand identity, design tokens, UI styling, logo generation (55 styles, Gemini AI), corporate identity program (50 deliverables, CIP mockups), HTML presentations (Chart.js), banner design (22 styles, social/ads/web/print), icon design (15 styles, SVG, Gemini 3.1 Pro), social photos (HTML→screenshot, multi-platform). Actions: design logo, create CIP, generate mockups, build slides, design banner, generate icon, create social photos, social media images, brand identity, design system. Platforms: Facebook, Twitter, LinkedIn, YouTube, Instagram, Pinterest, TikTok, Threads, Google Ads.'
argument-hint: '[design-type] [context]'
license: MIT
metadata:
  author: claudekit
  version: '2.1.0'
---

# Design

Unified design skill: brand, tokens, UI, logo, CIP, slides, banners, social photos, icons.

## Cost: three of these commands spend money

Three commands in this skill call Google's **paid** Gemini API with your `GEMINI_API_KEY`
(see "Setup" at the bottom). Everything else here is local and free — the `search.py` briefs,
`render-html.py`, Slides, Banner and Social Photos never leave the machine.

| Billed command             | Requests per run                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/logo/generate.py` | 1 paid **image** (`gemini-2.5-flash-image`; `--pro` switches to the dearer `gemini-3-pro-image-preview`). `--batch N` bills one image per variant, capped at the 9 built-in styles.                       |
| `scripts/cip/generate.py`  | 1 paid **image** per deliverable. `--set` bills 5 (business card, letterhead, office signage, vehicle, polo shirt). `--model pro` switches to the dearer Pro model.                                       |
| `scripts/icon/generate.py` | 1 paid **text** request (`gemini-3.1-pro-preview`; SVG is XML text, so no image API). `--batch N` is still one request — it asks for N SVGs at once. `--sizes "16,24,32,48"` is one request **per size**. |

Each of the three scripts reads the key from the process environment first, then from a `.env`
file sitting beside this `SKILL.md`, then from `~/.claude/skills/.env` — first hit wins. So a run
can be billed without `GEMINI_API_KEY` ever appearing in your shell.

**In this repository the key is shared with the product.** `GEMINI_API_KEY` is the environment
fallback for the `ai.google.apiKey` setting, which the application uses for Imagen-3 image
generation (`lib/assets/generate-image.ts`) and asset alt text (`lib/assets/alt-text.ts`).
Design artefacts generated here draw on the same Google billing account as user-facing
generation, and none of it goes through `checkCredits` or appears on `/admin/usage`. Ask
whoever owns the key before running the three commands above.

## When to Use

- Brand identity, voice, assets
- Design system tokens and specs
- UI styling with shadcn/ui + Tailwind
- Logo design and AI generation
- Corporate identity program (CIP) deliverables
- Presentations and pitch decks
- Banner design for social media, ads, web, print
- Social photos for Instagram, Facebook, LinkedIn, Twitter, Pinterest, TikTok

## Sub-skill Routing

| Task                          | Sub-skill                | Details                                 |
| ----------------------------- | ------------------------ | --------------------------------------- |
| Brand identity, voice, assets | `brand`                  | External skill                          |
| Tokens, specs, CSS vars       | `design-system`          | External skill                          |
| shadcn/ui, Tailwind, code     | `ui-styling`             | External skill                          |
| Logo creation, AI generation  | Logo (built-in)          | `references/logo-design.md`             |
| CIP mockups, deliverables     | CIP (built-in)           | `references/cip-design.md`              |
| Presentations, pitch decks    | Slides (built-in)        | `references/slides.md`                  |
| Banners, covers, headers      | Banner (built-in)        | `references/banner-sizes-and-styles.md` |
| Social media images/photos    | Social Photos (built-in) | `references/social-photos-design.md`    |
| SVG icons, icon sets          | Icon (built-in)          | `references/icon-design.md`             |

## Where the scripts live

The scripts and CSV data ship **inside this skill's own directory** — there is no copy in your home
profile, and a `~/.claude/...` or `~/.cursor/...` path would either fail or run a different,
unversioned copy. Naming one tree literally is just as wrong: the same file is vendored in both, so
a baked `.claude/...` path is a lie in the Cursor copy and vice versa. Set two variables once per
session, from the repository root, for the tree your agent loaded this skill from:

```bash
SKILLS_DIR=.claude/skills          # Claude Code loads skills from .claude/skills/
SKILLS_DIR=.cursor/skills          # Cursor loads them from .cursor/skills/
SKILL_DIR="$SKILLS_DIR/design"     # this skill; use $SKILLS_DIR to reach a sibling skill
```

PowerShell: `$SKILLS_DIR = ".claude\skills"; $SKILL_DIR = "$SKILLS_DIR\design"`.

Every command below runs **from the repository root** through `$SKILL_DIR` (or `$SKILLS_DIR` for a
sibling skill such as `design-system`), so `--output-dir` and generated files land under the project
rather than inside the skill. The scripts resolve their own `data/` directory from their location,
so the working directory only decides where output lands.

> **Note:** On Windows use `python` in place of `python3` — the python.org installer does not create
> a `python3` launcher.

## Logo Design (Built-in)

55+ styles, 30 color palettes, 25 industry guides. Gemini Nano Banana models.

### Logo: Generate Design Brief

```bash
python3 "$SKILL_DIR/scripts/logo/search.py" "tech startup modern" --design-brief -p "BrandName"
```

### Logo: Search Styles/Colors/Industries

```bash
python3 "$SKILL_DIR/scripts/logo/search.py" "minimalist clean" --domain style
python3 "$SKILL_DIR/scripts/logo/search.py" "tech professional" --domain color
python3 "$SKILL_DIR/scripts/logo/search.py" "healthcare medical" --domain industry
```

### Logo: Generate with AI

**ALWAYS** generate output logo images with white background.

```bash
python3 "$SKILL_DIR/scripts/logo/generate.py" --brand "TechFlow" --style minimalist --industry tech
python3 "$SKILL_DIR/scripts/logo/generate.py" --prompt "coffee shop vintage badge" --style vintage
```

**IMPORTANT:** When scripts fail, try to fix them directly.

After generation, **ALWAYS** ask user about HTML preview via `AskUserQuestion`. If yes, invoke `/ui-ux-pro-max` for gallery.

## CIP Design (Built-in)

50+ deliverables, 20 styles, 20 industries. Gemini Nano Banana (Flash/Pro).

### CIP: Generate Brief

```bash
python3 "$SKILL_DIR/scripts/cip/search.py" "tech startup" --cip-brief -b "BrandName"
```

### CIP: Search Domains

```bash
python3 "$SKILL_DIR/scripts/cip/search.py" "business card letterhead" --domain deliverable
python3 "$SKILL_DIR/scripts/cip/search.py" "luxury premium elegant" --domain style
python3 "$SKILL_DIR/scripts/cip/search.py" "hospitality hotel" --domain industry
python3 "$SKILL_DIR/scripts/cip/search.py" "office reception" --domain mockup
```

### CIP: Generate Mockups

```bash
# With logo (RECOMMENDED)
python3 "$SKILL_DIR/scripts/cip/generate.py" --brand "TopGroup" --logo /path/to/logo.png --deliverable "business card" --industry "consulting"

# Full CIP set
python3 "$SKILL_DIR/scripts/cip/generate.py" --brand "TopGroup" --logo /path/to/logo.png --industry "consulting" --set

# Pro model (4K text)
python3 "$SKILL_DIR/scripts/cip/generate.py" --brand "TopGroup" --logo logo.png --deliverable "business card" --model pro

# Without logo
python3 "$SKILL_DIR/scripts/cip/generate.py" --brand "TechFlow" --deliverable "business card" --no-logo-prompt
```

Models: `flash` (default, `gemini-2.5-flash-image`), `pro` (`gemini-3-pro-image-preview`)

### CIP: Render HTML Presentation

```bash
python3 "$SKILL_DIR/scripts/cip/render-html.py" --brand "TopGroup" --industry "consulting" --images /path/to/cip-output
```

**Tip:** If no logo exists, use Logo Design section above first.

## Slides (Built-in)

Strategic HTML presentations with Chart.js, design tokens, copywriting formulas.

Load `references/slides-create.md` for the creation workflow.

### Slides: Knowledge Base

| Topic           | File                                        |
| --------------- | ------------------------------------------- |
| Creation Guide  | `references/slides-create.md`               |
| Layout Patterns | `references/slides-layout-patterns.md`      |
| HTML Template   | `references/slides-html-template.md`        |
| Copywriting     | `references/slides-copywriting-formulas.md` |
| Strategies      | `references/slides-strategies.md`           |

## Banner Design (Built-in)

22 art direction styles across social, ads, web, print. Uses `frontend-design`, `ai-artist`, `ai-multimodal`, `chrome-devtools` skills.

Load `references/banner-sizes-and-styles.md` for complete sizes and styles reference.

### Banner: Workflow

1. **Gather requirements** via `AskUserQuestion` — purpose, platform, content, brand, style, quantity
2. **Research** — Activate `ui-ux-pro-max`, browse Pinterest for references
3. **Design** — Create HTML/CSS banner with `frontend-design`, generate visuals with `ai-artist`/`ai-multimodal`
4. **Export** — Screenshot to PNG at exact dimensions via `chrome-devtools`
5. **Present** — Show all options side-by-side, iterate on feedback

### Banner: Quick Size Reference

| Platform   | Type          | Size (px)       |
| ---------- | ------------- | --------------- |
| Facebook   | Cover         | 820 x 312       |
| Twitter/X  | Header        | 1500 x 500      |
| LinkedIn   | Personal      | 1584 x 396      |
| YouTube    | Channel art   | 2560 x 1440     |
| Instagram  | Story         | 1080 x 1920     |
| Instagram  | Post          | 1080 x 1080     |
| Google Ads | Med Rectangle | 300 x 250       |
| Website    | Hero          | 1920 x 600-1080 |

### Banner: Top Art Styles

| Style           | Best For         |
| --------------- | ---------------- |
| Minimalist      | SaaS, tech       |
| Bold Typography | Announcements    |
| Gradient        | Modern brands    |
| Photo-Based     | Lifestyle, e-com |
| Geometric       | Tech, fintech    |
| Glassmorphism   | SaaS, apps       |
| Neon/Cyberpunk  | Gaming, events   |

### Banner: Design Rules

- Safe zones: critical content in central 70-80%
- One CTA per banner, bottom-right, min 44px height
- Max 2 fonts, min 16px body, ≥32px headline
- Text under 20% for ads (Meta penalizes)
- Print: 300 DPI, CMYK, 3-5mm bleed

## Icon Design (Built-in)

15 styles, 12 categories. Gemini 3.1 Pro Preview generates SVG text output.

### Icon: Generate Single Icon

```bash
python3 "$SKILL_DIR/scripts/icon/generate.py" --prompt "settings gear" --style outlined
python3 "$SKILL_DIR/scripts/icon/generate.py" --prompt "shopping cart" --style filled --color "#6366F1"
python3 "$SKILL_DIR/scripts/icon/generate.py" --name "dashboard" --category navigation --style duotone
```

### Icon: Generate Batch Variations

```bash
python3 "$SKILL_DIR/scripts/icon/generate.py" --prompt "cloud upload" --batch 4 --output-dir ./icons
```

### Icon: Multi-size Export

```bash
python3 "$SKILL_DIR/scripts/icon/generate.py" --prompt "user profile" --sizes "16,24,32,48" --output-dir ./icons
```

### Icon: Top Styles

| Style    | Best For                      |
| -------- | ----------------------------- |
| outlined | UI interfaces, web apps       |
| filled   | Mobile apps, nav bars         |
| duotone  | Marketing, landing pages      |
| rounded  | Friendly apps, health         |
| sharp    | Tech, fintech, enterprise     |
| flat     | Material design, Google-style |
| gradient | Modern brands, SaaS           |

**Model:** `gemini-3.1-pro-preview` — text-only output (SVG is XML text). No image generation API needed.

## Social Photos (Built-in)

Multi-platform social image design: HTML/CSS → screenshot export. Uses `ui-ux-pro-max`, `brand`, `design-system`, `chrome-devtools` skills.

Load `references/social-photos-design.md` for sizes, templates, best practices.

### Social Photos: Workflow

1. **Orchestrate** — `project-management` skill for TODO tasks; parallel subagents for independent work
2. **Analyze** — Parse prompt: subject, platforms, style, brand context, content elements
3. **Ideate** — 3-5 concepts, present via `AskUserQuestion`
4. **Design** — `/ckm:brand` → `/ckm:design-system` → randomly invoke `/ck:ui-ux-pro-max` OR `/ck:frontend-design`; HTML per idea × size
5. **Export** — `chrome-devtools` or Playwright screenshot at exact px (2x deviceScaleFactor)
6. **Verify** — Use Chrome MCP or `chrome-devtools` skill to visually inspect exported designs; fix layout/styling issues and re-export
7. **Report** — Summary to `plans/reports/` with design decisions
8. **Organize** — Invoke `assets-organizing` skill to sort output files and reports

### Social Photos: Key Sizes

| Platform    | Size (px) | Platform  | Size (px) |
| ----------- | --------- | --------- | --------- |
| IG Post     | 1080×1080 | FB Post   | 1200×630  |
| IG Story    | 1080×1920 | X Post    | 1200×675  |
| IG Carousel | 1080×1350 | LinkedIn  | 1200×627  |
| YT Thumb    | 1280×720  | Pinterest | 1000×1500 |

## Workflows

### Complete Brand Package

1. **Logo** → `scripts/logo/generate.py` → Generate logo variants
2. **CIP** → `scripts/cip/generate.py --logo ...` → Create deliverable mockups
3. **Presentation** → Load `references/slides-create.md` → Build pitch deck

### New Design System

1. **Brand** (brand skill) → Define colors, typography, voice
2. **Tokens** (design-system skill) → Create semantic token layers
3. **Implement** (ui-styling skill) → Configure Tailwind, shadcn/ui

## References

| Topic                 | File                                        |
| --------------------- | ------------------------------------------- |
| Design Routing        | `references/design-routing.md`              |
| Logo Design Guide     | `references/logo-design.md`                 |
| Logo Styles           | `references/logo-style-guide.md`            |
| Logo Colors           | `references/logo-color-psychology.md`       |
| Logo Prompts          | `references/logo-prompt-engineering.md`     |
| CIP Design Guide      | `references/cip-design.md`                  |
| CIP Deliverables      | `references/cip-deliverable-guide.md`       |
| CIP Styles            | `references/cip-style-guide.md`             |
| CIP Prompts           | `references/cip-prompt-engineering.md`      |
| Slides Create         | `references/slides-create.md`               |
| Slides Layouts        | `references/slides-layout-patterns.md`      |
| Slides Template       | `references/slides-html-template.md`        |
| Slides Copy           | `references/slides-copywriting-formulas.md` |
| Slides Strategy       | `references/slides-strategies.md`           |
| Banner Sizes & Styles | `references/banner-sizes-and-styles.md`     |
| Social Photos Guide   | `references/social-photos-design.md`        |
| Icon Design Guide     | `references/icon-design.md`                 |

## Scripts

| Script                       | Purpose                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| `scripts/logo/search.py`     | Search logo styles, colors, industries                        |
| `scripts/logo/generate.py`   | Generate logos with Gemini AI — **paid**, see "Cost"          |
| `scripts/logo/core.py`       | BM25 search engine for logo data                              |
| `scripts/cip/search.py`      | Search CIP deliverables, styles, industries                   |
| `scripts/cip/generate.py`    | Generate CIP mockups with Gemini — **paid**, see "Cost"       |
| `scripts/cip/render-html.py` | Render HTML presentation from CIP mockups                     |
| `scripts/cip/core.py`        | BM25 search engine for CIP data                               |
| `scripts/icon/generate.py`   | Generate SVG icons with Gemini 3.1 Pro — **paid**, see "Cost" |

## Prerequisites

**Python:** This skill uses Python scripts. Set `SKILL_DIR` as described in "Where the scripts live"
above, and on Windows use `python` in place of `python3` (e.g.
`python "$SKILL_DIR/scripts/logo/search.py"`).

Check if Python is installed:

```bash
python3 --version || python --version
```

## Setup

Only needed for the three billed commands listed in "Cost" at the top of this file — the
search, brief, and HTML-rendering commands need no key.

```bash
export GEMINI_API_KEY="your-key"  # https://aistudio.google.com/apikey — paid; see "Cost" above
pip install google-genai pillow
```

> **Note for Windows:** Use `python` instead of `pip` where needed (e.g., `python -m pip install ...`).

## Integration

**External sub-skills:** brand, design-system, ui-styling
**Related Skills:** frontend-design, ui-ux-pro-max, ai-multimodal, chrome-devtools
