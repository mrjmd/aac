# Spike 4.0 Findings — Image Generation Pipeline

**Date:** 2026-04-03
**Status:** Complete — approach validated, production build can proceed
**Spike code:** `tools/src/scratch/spike-templates.ts`, `tools/src/scratch/spike-imagen.ts`
**Output:** `tools/src/scratch/spike-output/`

---

## Executive Summary

The hybrid image pipeline (AI background + branded template + text overlay)
is viable. 3 out of 5 first-attempt generations produced Instagram-postable
results. The rendering infrastructure (Puppeteer + HTML/CSS templates) works
reliably at full resolution. Issues are solvable prompt engineering and template
refinement problems, not fundamental limitations.

**Decision: Proceed with the hybrid approach for Phase 4 content production.**

---

## What We Tested

### Spike A: Template Rendering (Puppeteer + HTML/CSS)

**Approach:** HTML/CSS templates rendered to PNG via Puppeteer headless Chrome.

**Result: Works.** Produces crisp 1080x1350 PNGs in under 1 second per image.
Full CSS support including Google Fonts (Space Grotesk, Inter), border-radius,
box-shadow, gradients, transparency, and data-URL image embedding.

**Templates tested:**
- Template A (Headline bar + callout box) — renders correctly
- Template C (Dark header + photo area) — renders correctly
- Template G (Checklist card on dark overlay) — renders correctly

**Key finding:** Puppeteer is the right rendering engine for this. It gives us
full CSS power (unlike Sharp/Canvas which require manual pixel-level layout)
and runs headless on Vercel serverless functions. Satori was considered but
has CSS limitations that would constrain template design.

### Spike B: AI Image Generation (Gemini Imagen 4.0)

**Approach:** Gemini Imagen 4.0 API (`imagen-4.0-generate-001`) via REST,
generating 3:4 aspect ratio background images.

**Result: Works, with caveats.** 3 of 5 prompts produced on-target images.
The model generates high-quality photorealistic content when prompts are
specific about the scene.

**Results per prompt:**

| Prompt | AI Quality | Notes |
|--------|-----------|-------|
| Heavy rain on NE home | **Miss** — generated woman with cat | Prompt too vague or model misinterpreted "rain" context |
| Foundation wall crack | **Partial** — good crack image but rendered prompt text into image | Need stronger "no text" instructions |
| Snow-covered NE cape | **Hit** — excellent winter house scene | Photorealistic, correct architecture style |
| Dimly lit basement | **Hit** — moody basement interior | Great atmosphere, correct setting |
| Spring thaw NE home | **Hit** — melting snow, golden hour, colonial home | Best result — could post as-is |

**Key findings:**
- Model: `imagen-4.0-generate-001` is the current endpoint (3.0 is deprecated)
- API: `v1beta` endpoint with `predict` method, same API key as Gemini text
- Rate limit: 8 seconds between requests is safe for paid tier
- Aspect ratio: `3:4` works for portrait Instagram images
- Prompt engineering matters enormously — specific scene descriptions with
  New England context produce much better results than generic prompts
- Must explicitly say "No text, no watermarks, no people" to avoid artifacts
- The "rendered prompt text into image" issue needs investigation — may need
  even stronger negative instructions or a different prompting pattern

### Spike C: Hybrid Composition

**Approach:** AI-generated PNG embedded as CSS `background-image` data URL,
template HTML/CSS overlaid on top, rendered via Puppeteer.

**Result: Works well when the AI background is good.**

**Successful composites:**
- `hybrid-a-spring.png` — Spring thaw photo + headline bar + callout box + logo = **postable**
- `hybrid-c-winter.png` — Winter house + dark header + gold text + logo = **postable**
- `hybrid-g-basement.png` — Basement interior + blue checklist card + logo = **postable**

### Spike D: Buffer API Validation

**Not yet tested.** Deferred — the image pipeline was the critical risk. Buffer
API validation is lower risk (already working for GBP via aac-astro scripts).

---

## Issues to Fix Before Production

### 1. Image Relevancy — AI Backgrounds Sometimes Miss Completely

**Problem:** The rain prompt generated a woman holding a cat — zero relevance
to foundation repair or weather. This is a consistency/reliability concern.
If we're generating a month of content in batch, we can't have 20-40% of
backgrounds be completely off-topic.

**Fix:**
- Build a curated prompt template library — each content type gets a tested
  prompt that's been validated 3-5 times for consistency
- Add a validation step: after generation, use Gemini text model to evaluate
  whether the image matches the intended content (e.g., "Does this image show
  a house in rain near a foundation? yes/no"). Auto-retry on failure.
- Consider: for some content types, use real project photos from the media
  library instead of AI generation (before/after posts, job showcases)
- Start with the prompts that worked in the blog image system — those have
  already been iterated on with feedback

### 2. Prompt Text Rendered Into Images

**Problem:** The foundation crack image had the actual prompt text rendered
into the generated image — model parameters, style keywords, the whole thing
baked right into the pixels. This is a known issue with some image generation
models where they interpret text instructions as desired text content.

**Fix:**
- Stronger negative instructions: "Absolutely no text, words, letters, labels,
  annotations, or writing of any kind in the image"
- If this persists, may need to add a post-processing step that detects text
  in the generated image (OCR check) and auto-retries
- The blog image system had similar issues early on — the feedback loop in
  BLOG-IMAGE-PROMPTS.md shows iterations that fixed this over time
- Consider: reference images help anchor the model on visual style rather than
  interpreting text literally

### 3. Text Size — Not Readable at Thumbnail

**Problem:** Text in the templates is too small to read when the image appears
in an Instagram grid thumbnail (~110px square). Headlines and callout text
need to be significantly larger.

**Fix:**
- Headline text: increase from 42px to 56-64px
- Callout body text: increase from 30px to 38-44px
- Checklist items: increase from 32px to 38-42px
- Reduce word count per element — shorter, punchier phrases
- Test all templates at 110x137px (Instagram grid thumbnail) to verify legibility
- Consider: some elements may need to be removed entirely at certain sizes
  (e.g., body text might not be readable, only headline + logo should be)

### 2. Logo Treatment

**Problem:** Using the actual logo JPG works but needs refinement:
- Logo needs consistent sizing across templates (currently varies 90-180px)
- Logo should have a consistent background treatment — the blue-background
  version works on dark/photo backgrounds but may need a dark-background
  version for light scenes
- Logo placement should be standardized: bottom-left for most templates

**Fix:**
- Standardize logo size: 140-160px square for Instagram posts
- Use the blue-background logo as default (reads well on most backgrounds)
- Add a subtle backdrop/shadow behind logo for readability on any background
- Always place logo with enough margin from edges (40px minimum)

### 3. Prompt Engineering — Inconsistent AI Backgrounds

**Problem:** 2 of 5 prompts missed:
- "Rain on foundation" → woman with cat (complete miss)
- "Foundation wall crack" → rendered prompt text into the image (partial miss)

**Fix:**
- Build a prompt template library with tested, reliable prompts per content type
- Always include: "No text, no watermarks, no labels, no annotations, no words"
- Always include: "Photorealistic, professional photography, editorial quality"
- Always include geographic context: "New England", "colonial home", "suburban"
- Test each prompt template 3-5 times to verify consistency before production use
- Implement a "regenerate" flow — if the image doesn't pass quality check,
  automatically retry with a modified prompt (different seed/variation)

### 4. Template Dark Overlay Needs Tuning

**Problem:** Some AI backgrounds are light enough that white text on them
is hard to read, even with the gradient overlay.

**Fix:**
- Add a configurable overlay intensity based on AI image brightness
- For Template A: the white headline bar and callout box handle this well
  (text is on solid backgrounds, not the photo)
- For Template C: the dark header bar handles headline. Photo area text
  needs a stronger overlay or a semi-transparent text backdrop
- For Template F (direct text overlay): will need the most careful handling

### 5. Carousel Second Slide

**Problem:** Many of the best-performing posts on the actual Instagram are
carousels (2 slides). We only tested single-image posts.

**Fix:**
- Build Template H (carousel slide 2): black background, white centered text
- This is the simplest template — no AI image needed, just text on dark bg
- Pair it with any slide-1 template (A, C, D, F) for carousel posts
- The caption/educational text that's currently in the callout box could move
  to slide 2 instead, letting slide 1 be more visually impactful

### 6. Card/Element Placement Blocking the Background

**Problem:** The checklist card (Template G) is vertically centered, which
puts it right over the most interesting part of the basement background image.
The whole point of paying for an AI background is to show it — the template
elements should frame the image, not obscure it.

**Fix:**
- Template G: move card toward the top or bottom, not dead center. Let the
  background breathe — the image should be visible above or below the card.
- General principle: template elements should occupy edges and corners, leaving
  the center/majority of the AI background visible
- Consider a "composition zone" system: each template defines which areas of
  the background are visible vs. covered, and the AI prompt can be tailored
  to put the interesting content in the visible zones

### 7. Platform-Specific Sizing

**Problem:** We only tested Instagram 4:5 (1080x1350). Need to verify
templates work at Facebook 1:1 and LinkedIn 1.91:1.

**Fix:**
- Templates need responsive layout logic — font sizes and element proportions
  should scale with the canvas dimensions
- LinkedIn landscape (1200x627) will require a different layout approach
  (side-by-side rather than stacked)
- GBP 4:3 (1200x900) may need its own layout variant
- Template A tested at all three sizes in Spike A — structure works but
  spacing/sizing needs per-platform tuning

---

## Architecture Decisions Confirmed

1. **Rendering engine: Puppeteer.** Full CSS support, runs headless, fast enough
   for batch generation. Satori considered but CSS limitations too restrictive.

2. **AI model: Gemini Imagen 4.0** (`imagen-4.0-generate-001`). Already using
   this for blog images. Quality is good when prompts are specific. Same API key
   and billing as Gemini text.

3. **Composition approach: HTML/CSS data-URL embedding.** AI image loaded as
   base64 data URL in CSS `background-image`. Template elements overlay on top.
   Single Puppeteer screenshot produces the final composite. No Sharp/Canvas
   composition needed — the browser handles all compositing.

4. **Logo: Use actual logo image file**, not Unicode/text approximation.
   Embedded via `<img>` tag with data URL.

5. **Fonts: Google Fonts via @import in HTML.** Space Grotesk for headlines,
   Inter for body. Puppeteer loads them via networkidle0 wait + fonts.ready.
   Alternative: self-host TTF files for offline/faster rendering.

---

## Performance Notes

- AI image generation: ~5-8 seconds per image (Imagen 4.0)
- Rate limit: 8 seconds between requests (safe margin)
- Template rendering: <1 second per image (Puppeteer)
- Full pipeline for 1 post: ~10-15 seconds (generate + compose)
- Full month (12 posts): ~3-4 minutes total
- Puppeteer startup: ~2 seconds (reuse browser instance across batch)

---

## Files Produced

### Raw AI backgrounds (no template):
- `ai-raw-rain-foundation.png` — miss (woman with cat)
- `ai-raw-foundation-wall-crack.png` — partial (has text artifacts)
- `ai-raw-winter-house.png` — good (snow-covered NE cape)
- `ai-raw-basement-interior.png` — good (moody basement)
- `ai-raw-spring-thaw.png` — great (melting snow, golden hour)

### Hybrid composites (AI bg + template + logo):
- `hybrid-a-rain.png` — unusable (bad AI background)
- `hybrid-a-spring.png` — **postable** (spring thaw + Template A)
- `hybrid-c-crack.png` — has text artifacts from AI image
- `hybrid-c-winter.png` — **postable** (winter house + Template C)
- `hybrid-g-basement.png` — **postable** (basement + Template G checklist)

### Template-only (placeholder backgrounds, from Spike A):
- `template-a-{instagram,facebook,linkedin}.png`
- `template-c-{instagram,facebook,linkedin}.png`
- `template-g-{instagram,facebook,linkedin}.png`

---

## Next Steps

1. Fix text sizing — make headlines readable at thumbnail scale
2. Integrate actual logo PNG with consistent placement
3. Build prompt template library with tested, reliable prompts
4. Build carousel slide 2 template (black bg + white text)
5. Add platform-specific sizing logic
6. Validate Buffer API for scheduling (Spike D, lower risk)
7. Proceed to Phase 4.1 prerequisites (BufferClient, GeminiClient expansion)
