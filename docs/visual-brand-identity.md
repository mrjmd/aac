# Attack A Crack — Visual Brand Identity Spec

**Created:** 2026-04-03
**Purpose:** Reference document for AI-powered content generation. Defines the
visual language, color system, typography, and image patterns that must be
reproduced by the marketing engine's hybrid image pipeline.

**Sources:** attackacrack.com (live site), Instagram @attackacrack, Facebook
Attack A Crack, aac-astro codebase (CSS, components, blog images, prompts).

---

## 1. Color Palette

| Role | Name | Hex | Usage |
|------|------|-----|-------|
| **Primary** | AAC Blue | `#1e6fb8` | Top bar, navbar, links, accents, logo background |
| **Accent** | AAC Yellow | `#f0c34b` | CTAs, underline highlights, border accents, social template callout boxes |
| **Dark** | AAC Dark | `#1a1a1a` | Body text, headings, borders, shadows |
| **White** | — | `#ffffff` | Backgrounds, text on dark/blue, card backgrounds |
| **Light Gray** | — | `#f5f5f5` | Page backgrounds, subtle section dividers |

**Key relationships:**
- Blue + Yellow is the dominant combination (logo, CTAs, social post headers)
- Yellow is always paired with dark text (`#1a1a1a`), never with white
- Blue is paired with white text
- Dark shadows use `rgba(26,26,26,1)` — solid, not transparent

---

## 2. Typography

| Font | Weight Range | Role | CSS Class |
|------|-------------|------|-----------|
| **Space Grotesk** | 300–700 | Display headings, logo text, social post headlines | `font-display` |
| **Inter** | 400–900 | Body text, UI, captions | `font-sans` |

**Heading style:**
- `font-black` (900 weight) for primary headings
- Uppercase with `tracking-tighter` or `tracking-widest` depending on context
- Short, punchy phrases: "WE SEAL CRACKS & SECURE YOUR HOME"
- Display size varies: massive for hero (5xl+), bold for social (2xl-3xl)

**Body style:**
- Inter 400 for paragraphs, 600-700 for emphasis
- Sentence case, standard tracking

**Files available:**
- `/public/fonts/space-grotesk-latin.woff2`
- `/public/fonts/inter-latin.woff2`

---

## 3. Logo

**Primary logo:** "ATTACK A CRACK" in white cracked/distressed concrete texture
with dual yellow lightning bolts crossing through. Small "-A-" between them.
Blue background (`#1e6fb8`).

**Characteristics:**
- Square aspect ratio (works as social profile picture, favicon)
- "CRACK" text has a cracked/broken concrete texture effect
- "ATTACK" text is clean, bold
- Lightning bolts are gold/yellow (`#f0c34b`)
- Reads well at small sizes (44x44px in navbar)

**Logo variants:**
- Blue background: `/public/images/logo.jpg` (primary)
- WebP: `/public/images/logo.webp`
- Responsive: `/public/images/logo-400w.webp`, `/public/images/logo-800w.webp`
- Dark/black background version (used on Instagram/Facebook profile)
- Reference copy: `/media/blog-refs/logo-blue-bg.jpeg`

**Logo text next to icon (navbar pattern):**
- "ATTACK A CRACK" in Space Grotesk, font-black, dark text
- "FOUNDATION REPAIR" below in AAC Blue, smaller, uppercase, wide tracking

---

## 4. Design Language — Neo-Brutalist

The website uses a bold, modern, neo-brutalist aesthetic:

**Signature elements:**
- **Hard shadows:** `shadow-[4px_4px_0px_0px_rgba(30,111,184,0.2)]` on logo,
  `shadow-[6px_6px_0px_0px_rgba(26,26,26,1)]` on CTAs — solid offset shadows,
  not diffuse blur
- **Thick borders:** `border-2 border-aac-dark` on buttons and cards
- **Rounded corners:** `rounded-xl` consistently (large radius)
- **Uppercase + tracking:** Navigation and CTAs use uppercase with wide letter-spacing
- **Hover animations:** `hover:translate-y-[-2px]` lift effect on buttons
- **High contrast:** Dark text on yellow, white text on blue, no subtle grays

**CTA button pattern:**
```
bg-aac-yellow text-aac-dark px-6 py-3.5 rounded-xl
text-[11px] font-black uppercase tracking-widest
border-2 border-aac-dark
shadow-[6px_6px_0px_0px_rgba(26,26,26,1)]
```

---

## 5. Social Media Post Templates (Observed Patterns)

From the Instagram grid and Facebook posts, the VA's current output follows
these consistent patterns:

### Template A: "Headline Bar + Callout Box" (Workhorse)

**Layout:** Three-zone vertical stack on photorealistic background.
- **Zone 1 (top):** White/light semi-transparent bar with bold black headline
  - All caps, heavy weight sans-serif
  - Example: "HEAVY RAIN TESTS YOUR FOUNDATION"
- **Zone 2 (middle):** Yellow-bordered (`#f0c34b`) rounded callout box, white fill
  - Contains explanatory subtext in dark bold sans-serif, sentence or title case
  - Example: "SOUTH SHORE STORMS CAN INCREASE BASEMENT WATER PRESSURE"
- **Zone 3 (bottom):** Large Attack A Crack logo, prominent
- **Background:** Photorealistic weather/nature scene (rain, snow, flooding)
- **Format:** Portrait (4:5) for Instagram

### Template B: "Illustration + Split Text" (Educational)

**Layout:** AI-generated illustration or cross-section with text zones.
- **Top third:** Large white bold headline text directly on image/scene
  - Example: "LIVING NEAR THE COAST IMPACTS FOUNDATION."
- **Middle:** AI illustration — cutaway/cross-section showing house, soil, foundation
  - Includes white outline diagrams on the illustration (house outline, soil layers)
- **Bottom third:** Gold/cream serif or sans-serif explanatory text
  - Example: "MOISTURE AND SHIFTING SOIL; CAN INCREASE PRESSURE ON BASEMENT WALLS."
- **No explicit template frame** — text sits directly on the illustration
- **Best for:** Explaining geological/structural concepts visually

### Template C: "Dark Header + Photo" (Bold Statement)

**Layout:** Dark top bar with gold text, real/AI photo below, logo at bottom.
- **Top bar:** Black/dark background, full width
  - Gold (`#f0c34b`) uppercase text, two lines typical
  - Line 1: Main statement (larger)
  - Line 2: Supporting statement (slightly smaller)
  - Example: "PREVENTION BEATS REPAIR" / "EARLY ACTION SAVES TIME AND STRESS"
  - Example: "GOOD DRAINAGE PROTECTS YOUR FOUNDATION"
- **Photo area:** Real or AI photo of foundation, repair work, or home exterior
  - Sometimes a before/after split
- **Bottom:** Logo centered or off-center
- **Best for:** Bold value propositions, seasonal warnings

### Template D: "Yellow Badge on Photo" (Eye-Catching)

**Layout:** Large yellow filled shape overlaying a photorealistic background.
- **Badge:** Yellow (`#f0c34b`) filled rectangle/banner shape, slightly rotated or organic
  - Dark text inside, bold sans-serif, ALL CAPS
  - Example: "WATER AROUND YOUR FOUNDATION MATTERS"
- **Background:** Real photo of water damage, snow melt near foundation
- **Bottom:** Large logo overlay
- **Best for:** Attention-grabbing single-message posts

### Template E: "AI Scene + Bottom Callout" (Story-Driven)

**Layout:** AI-generated scene with logo and text callout at bottom.
- **Top 70%:** Full AI-generated photorealistic scene
  - Example: Person inspecting wall with flashlight
  - Example: Worker using injection gun on crack
- **Bottom 30%:** White semi-transparent callout box
  - Logo on left, text on right
  - Text in italicized or mixed-case serif/sans, more narrative tone
  - Example: "Small Signs Matter / Early attention prevents bigger problems"
- **Best for:** Humanizing content, showing the work

### Template F: "Photo + Direct Text Overlay" (Clean/Simple)

**Layout:** Photorealistic scene with large text directly overlaid, no boxes or bars.
- White bold text centered on image
- Optional small yellow accent element (star, underline, sparkle)
- No explicit template frame or callout box
- Example: "COLD WEATHER CAN EXPOSE HIDDEN CRACKS" on snowy house photo
- Logo absent or very subtle
- **Best for:** Clean, magazine-style posts

### Template G: "Checklist Card" (Actionable)

**Layout:** Colored rounded card overlaying a structural photo background.
- **Card:** Blue (`#1e6fb8`) filled rounded rectangle, large, centered
  - White title text at top: "CHECKLIST"
  - Dotted underline separator
  - Checkbox items with white text, each with a checked box icon
  - Example items: "Wall or floor cracks", "Basement dampness", "Sticking doors"
- **Background:** Dimmed/blurred photo of basement or structure
- **Best for:** Educational checklists, seasonal inspection guides, listicles

### Template H: "Carousel / Multi-Slide" (Engagement)

**Layout:** Two or more slides forming a story.
- **Slide 1:** Photo with headline + logo (uses Template A, C, or D layout)
- **Slide 2:** Black/dark background with white centered text — the educational payoff
  - Smaller, more readable text explaining the concept
  - Example: "Freeze thaw cycles expand and contract the soil around your home"
- **Best for:** Any educational post — the first slide hooks, the second educates

### Template I: "Labeled Diagram" (Technical)

**Layout:** Dark header bar + AI-generated scene with annotation labels.
- **Top bar:** Dark with gold text headline
- **Image:** AI-generated outdoor/structural scene with text labels pointing to features
  - Labels: "GUTTER DOWNSPOUT", "DRAINAGE PIPE", "DRY WELL" with arrows/lines
- **Bottom:** Logo
- **Best for:** Technical education — drainage, repair methods, foundation anatomy

### Video Content (Not Automated — For Reference)

The account also posts significant video content which gets higher engagement:
- **Selfie-style reels** (Luc talking to camera) — personality-driven, funny
- **Sora AI-generated videos** — cinematic, used for brand storytelling
- **Real job footage** — drilling, injection, concrete work — most authentic
- **Engagement note:** Videos consistently get 3-20x more likes than image posts.
  The marketing engine focuses on image posts, but video should remain a manual
  content stream.

### Common Visual Elements Across All Templates:

| Element | Current State | Modernization Opportunity |
|---------|--------------|--------------------------|
| **Background** | Photorealistic — rain, snow, houses, foundations, coastal scenes | Keep — AI generation handles this well |
| **Headline font** | Generic bold sans-serif, ALL CAPS | Upgrade to **Space Grotesk** to match website |
| **Headline color** | Black on white bar, OR white on dark overlay | Keep both patterns |
| **Callout box** | Yellow (`#f0c34b`) border, rounded, white fill | Add **hard shadow** (`4px 4px 0 #1a1a1a`) to match website brutalist style |
| **Body text** | Uppercase bold, various sizes | Standardize to **Inter** bold |
| **Logo** | Large, various positions | Standardize: bottom-center for templates, bottom-right for photo-only |
| **Color accents** | Yellow borders, occasional blue | Add blue accent bar option to match website header |
| **Aspect ratio** | Mix of 1:1 and 4:5 | Standardize: **4:5 (1080x1350)** for IG, **1:1** for FB/LI, **4:3** for GBP |
| **Borders** | Thin, generic | Add **2px borders + hard shadow** to match website neo-brutalist style |
| **Corner radius** | Various | Standardize to **`rounded-xl`** (16px) to match website |

---

## 6. Blog Hero Images (AI-Generated Reference)

64 AI-generated blog hero images exist at `/public/images/blog/`.

**Style specifications (from BLOG-IMAGE-PROMPTS.md):**
- Photorealistic, high-resolution, professional photography look
- 16:9 landscape aspect ratio (1408x768px typical output)
- Natural or well-lit interior/exterior lighting
- No text overlays, watermarks, or logos (text is added by the template layer)
- IPTC metadata: `trainedAlgorithmicMedia`

**Subject matter categories:**
1. **Basement interiors:** Concrete walls, cracks, water intrusion, dehumidifiers
2. **Home exteriors:** New England colonials/ranches, foundations at grade, seasonal
3. **Repair processes:** Injection equipment, ports on walls, professionals at work
4. **Materials:** Concrete, fieldstone, CMU block, mortar, efflorescence
5. **Seasonal scenes:** Snow/ice dams, spring thaw, fall foliage, summer heat
6. **Cross-sections/diagrams:** Foundation types, drainage systems, soil pressure
7. **People scenes:** Homeowners inspecting, contractors greeting, realtors showing

**Quality notes:**
- Models used: Gemini Imagen 3/4, Vertex AI imagen-3.0-capability-001
- Reference images improve results significantly (real job photos, employee photos)
- "Redo" items commonly need: more realistic cracks, correct foundation types,
  branded uniform accuracy, removal of AI artifacts (weird lightning, wrong textures)

---

## 7. Photography Style Guide

**For AI background generation in social post templates:**

| Attribute | Guideline |
|-----------|-----------|
| **Style** | Photorealistic, editorial quality |
| **Lighting** | Natural light preferred. Interior: bright, well-lit. Exterior: golden hour or overcast |
| **Color temperature** | Neutral to warm. Avoid cold/clinical blue tones |
| **Setting** | New England — colonial/cape/ranch homes, snow, foliage, coastal towns |
| **Tone** | Professional but approachable. Not clinical or scary. Show the problem AND the solution |
| **People** | When shown: real-looking, diverse, in context (inspecting, pointing, working) |
| **Avoid** | Over-saturated colors, dystopian/scary disaster imagery, cartoon style, obvious AI artifacts, text in the generated image (text is added by template) |

**For template backgrounds specifically:**
- Can be more abstract/textural than blog heroes
- Rain, weather, concrete textures, aerial neighborhoods work well
- The template overlay means the image doesn't need to tell the whole story alone
- Depth of field (blurred background) can help text legibility

---

## 8. Implications for the Hybrid Image Pipeline

The three-layer sandwich should produce images matching the templates above,
**modernized to match the new website's neo-brutalist design language.**

### Modernization Principles

The current social posts use generic Canva-style templates — thin borders,
no shadows, arbitrary font choices. The new website has a bold, distinctive
visual identity (hard shadows, thick borders, Space Grotesk, yellow/blue/dark).
The automated templates should bring the social presence into alignment:

1. **Use Space Grotesk** for all headlines (not generic sans-serif)
2. **Add hard shadows** to callout boxes and cards (`4px 4px 0 #1a1a1a`)
3. **Use 2px borders** with `#1a1a1a` on template elements
4. **Use `rounded-xl` (16px)** corners consistently
5. **Maintain the yellow/blue/dark/white** palette strictly
6. **Logo should be crisp and prominent** — not overlaid with transparency

### Layer 1 — AI Background Generation

- Generate photorealistic New England scenes, foundation details, weather events
- Use the blog hero image prompt style as baseline, adapted for square/portrait crops
- Abstract textures and scenes work for template backgrounds (rain, concrete, snow)
- Cross-section illustrations for educational content (soil, drainage, foundation types)
- Models: Gemini Imagen (primary), with reference images when available

### Layer 2 — Brand Template Overlay

Each template (A through I) becomes a programmatic overlay that composites:
- Color bars/cards with brand colors
- Border + shadow elements matching website style
- Logo placement zone (standardized per template)
- Text zones with font/size/color specifications

**Template priority for MVP (build these first):**
1. **Template A** — Headline bar + callout box (most common, the workhorse)
2. **Template C** — Dark header + photo (bold statements)
3. **Template H** — Carousel slide 2 (dark bg + white text — pairs with any slide 1)
4. **Template D** — Yellow badge on photo (attention-grabbing)
5. **Template G** — Checklist card (actionable, educational)
6. **Template F** — Clean photo + direct text (simplest to implement)

**Later:**
7. Template B — Illustration + split text (needs strong AI illustration)
8. Template E — AI scene + bottom callout (needs consistent AI people)
9. Template I — Labeled diagram (needs annotation system)

### Layer 3 — Text Rendering

- **Headlines:** Space Grotesk, weight 900 (black), uppercase
- **Body text:** Inter, weight 700 (bold), uppercase or title case
- **Subtext/CTA:** Inter, weight 400-600, smaller, sentence case
- **Contact info:** "Call or text 617-668-1677" in Inter
- All text must be legible at Instagram grid thumbnail size (~110px square)
- Text shadow (`0 2px 4px rgba(0,0,0,0.5)`) when text is on photo backgrounds
- No text shadow when text is on solid color bars/cards

---

## 9. Platform-Specific Adaptations

| Platform | Aspect Ratio | Key Adaptation |
|----------|-------------|----------------|
| **Instagram Feed** | 1:1 (1080x1080) or 4:5 (1080x1350) | Logo must be visible in grid thumbnail. Text larger. |
| **Facebook** | 1:1 (1080x1080) or 16:9 (1200x630) | Can show more text. Link preview format for blog promos. |
| **LinkedIn** | 1.91:1 (1200x627) or 1:1 | More professional tone. No hashtags. Landscape preferred. |
| **GBP** | 4:3 (1200x900) | No phone number. "Text us a photo" or "Book a free quote" CTA. |

---

## 10. Cover Photo & Profile Assets

**Facebook cover photo:** Concrete foundation wall texture — gray, gritty,
shows the floor-wall joint. Moody, dark, textural. No text.

**Instagram/Facebook profile:** Logo on black circle background.

**Website favicon:** Small logo mark (just the icon, no text).
